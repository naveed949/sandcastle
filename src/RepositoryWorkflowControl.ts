import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RepositoryWorkflowCycleResult,
  RepositoryWorkflowDefinition,
  RepositoryWorkflowRuntime,
} from "./RepositoryWorkflowRuntime.js";

export type RepositoryWorkflowMode = "active" | "pausing" | "paused";

export interface AuthorizedRepositoryWorkflow {
  readonly repository: string;
  readonly featureBranch: string;
  readonly workflowId: string;
  readonly mode: RepositoryWorkflowMode;
  readonly nextCycle: number;
  readonly activeRunId?: string;
}

export interface RepositoryWorkflowRunRecord {
  readonly id: string;
  readonly repository: string;
  readonly workflowId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "running" | "completed" | "failed";
  readonly cycles: readonly RepositoryWorkflowCycleResult[];
  readonly error?: string;
}

export interface RepositoryWorkflowState {
  readonly version: 1;
  readonly revision: number;
  readonly repositories: readonly AuthorizedRepositoryWorkflow[];
  readonly runs: readonly RepositoryWorkflowRunRecord[];
}

export interface RepositoryWorkflowStore {
  read(): Promise<RepositoryWorkflowState>;
  update(
    mutator: (state: RepositoryWorkflowState) => RepositoryWorkflowState,
  ): Promise<RepositoryWorkflowState>;
}

export interface RepositoryWorkflowStoreOptions {
  readonly filePath: string;
}

const emptyState = (): RepositoryWorkflowState => ({
  version: 1,
  revision: 0,
  repositories: [],
  runs: [],
});

/** JSON persistence for the repository registry and workflow history. */
export const createRepositoryWorkflowStore = (
  options: RepositoryWorkflowStoreOptions,
): RepositoryWorkflowStore => {
  let pending = Promise.resolve();
  const read = async (): Promise<RepositoryWorkflowState> => {
    try {
      return JSON.parse(
        await readFile(options.filePath, "utf8"),
      ) as RepositoryWorkflowState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw error;
    }
  };
  return {
    read,
    update(mutator) {
      const operation = pending.then(async () => {
        const current = await read();
        const proposed = mutator(current);
        const next = {
          ...proposed,
          version: 1 as const,
          revision: current.revision + 1,
        };
        await mkdir(dirname(options.filePath), { recursive: true });
        const temporary = `${options.filePath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(temporary, options.filePath);
        return next;
      });
      pending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
};

export interface AuthorizeRepositoryWorkflowInput {
  readonly repository: string;
  readonly featureBranch: string;
  readonly workflowId: string;
}

export interface RepositoryWorkflowInspection extends AuthorizedRepositoryWorkflow {
  readonly runs: readonly RepositoryWorkflowRunRecord[];
}

export interface RepositoryWorkflowControl {
  authorize(input: AuthorizeRepositoryWorkflowInput): Promise<void>;
  remove(repository: string): Promise<void>;
  list(): Promise<readonly AuthorizedRepositoryWorkflow[]>;
  inspect(
    repository: string,
  ): Promise<RepositoryWorkflowInspection | undefined>;
  runNow(repository: string): Promise<RepositoryWorkflowRunRecord>;
  pause(repository: string): Promise<void>;
  resume(repository: string): Promise<void>;
}

export interface RepositoryWorkflowControlOptions {
  readonly store: RepositoryWorkflowStore;
  readonly runtime: RepositoryWorkflowRuntime;
  readonly workflows: Readonly<Record<string, RepositoryWorkflowDefinition>>;
  readonly now?: () => string;
  readonly createId?: () => string;
}

const normalizeRepository = (repository: string): string => {
  const normalized = repository.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized))
    throw new Error("repository must be owner/name.");
  return normalized;
};

/** Operator control plane for independent repository workflows. */
export const createRepositoryWorkflowControl = (
  options: RepositoryWorkflowControlOptions,
): RepositoryWorkflowControl => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const requireRepository = async (repository: string) => {
    const normalized = normalizeRepository(repository);
    const found = (await options.store.read()).repositories.find(
      (item) => item.repository === normalized,
    );
    if (!found) throw new Error(`Repository ${normalized} is not authorized.`);
    return found;
  };
  const setMode = async (repository: string, mode: RepositoryWorkflowMode) => {
    const normalized = normalizeRepository(repository);
    let found = false;
    await options.store.update((state) => ({
      ...state,
      repositories: state.repositories.map((item) => {
        if (item.repository !== normalized) return item;
        found = true;
        return { ...item, mode };
      }),
    }));
    if (!found) throw new Error(`Repository ${normalized} is not authorized.`);
  };
  return {
    async authorize(input) {
      const repository = normalizeRepository(input.repository);
      if (!options.workflows[input.workflowId])
        throw new Error(`Unknown workflow ${input.workflowId}.`);
      await options.store.update((state) => ({
        ...state,
        repositories: [
          ...state.repositories.filter(
            (item) => item.repository !== repository,
          ),
          {
            repository,
            featureBranch: input.featureBranch,
            workflowId: input.workflowId,
            mode: "active" as const,
            nextCycle: 1,
          },
        ].sort((a, b) => a.repository.localeCompare(b.repository)),
      }));
    },
    async remove(repository) {
      const normalized = normalizeRepository(repository);
      await options.store.update((state) => ({
        ...state,
        repositories: state.repositories.filter(
          (item) => item.repository !== normalized,
        ),
      }));
    },
    async list() {
      return (await options.store.read()).repositories;
    },
    async inspect(repository) {
      const normalized = normalizeRepository(repository);
      const state = await options.store.read();
      const configured = state.repositories.find(
        (item) => item.repository === normalized,
      );
      if (!configured) return undefined;
      return {
        ...configured,
        runs: state.runs.filter((run) => run.repository === normalized),
      };
    },
    async runNow(repository) {
      const configured = await requireRepository(repository);
      if (configured.mode !== "active")
        throw new Error(
          `Repository ${configured.repository} is ${configured.mode}.`,
        );
      const workflow = options.workflows[configured.workflowId]!;
      if (configured.nextCycle > workflow.maxCycles) {
        throw new Error(
          `Repository ${configured.repository} reached its ${workflow.maxCycles}-cycle limit.`,
        );
      }
      if (configured.activeRunId)
        throw new Error(
          `Repository ${configured.repository} already has an active workflow.`,
        );
      const id = createId();
      const startedAt = now();
      await options.store.update((state) => ({
        ...state,
        repositories: state.repositories.map((item) =>
          item.repository === configured.repository
            ? { ...item, activeRunId: id }
            : item,
        ),
        runs: [
          ...state.runs,
          {
            id,
            repository: configured.repository,
            workflowId: workflow.id,
            startedAt,
            status: "running",
            cycles: [],
          },
        ],
      }));
      try {
        const cycle = await options.runtime.runCycle({
          repository: configured.repository,
          featureBranch: configured.featureBranch,
          workflow,
          cycle: configured.nextCycle,
        });
        let completed!: RepositoryWorkflowRunRecord;
        await options.store.update((state) => ({
          ...state,
          repositories: state.repositories.map((item) =>
            item.repository === configured.repository
              ? {
                  ...item,
                  activeRunId: undefined,
                  nextCycle: item.nextCycle + 1,
                  mode:
                    item.mode === "pausing" ||
                    item.nextCycle + 1 > workflow.maxCycles
                      ? "paused"
                      : item.mode,
                }
              : item,
          ),
          runs: state.runs.map((run) => {
            if (run.id !== id) return run;
            completed = {
              ...run,
              status: "completed",
              completedAt: now(),
              cycles: [...run.cycles, cycle],
            };
            return completed;
          }),
        }));
        return completed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let failed!: RepositoryWorkflowRunRecord;
        await options.store.update((state) => ({
          ...state,
          repositories: state.repositories.map((item) =>
            item.repository === configured.repository
              ? {
                  ...item,
                  activeRunId: undefined,
                  mode: item.mode === "pausing" ? "paused" : item.mode,
                }
              : item,
          ),
          runs: state.runs.map((run) => {
            if (run.id !== id) return run;
            failed = {
              ...run,
              status: "failed",
              completedAt: now(),
              error: message,
            };
            return failed;
          }),
        }));
        throw error;
      }
    },
    async pause(repository) {
      const configured = await requireRepository(repository);
      await setMode(repository, configured.activeRunId ? "pausing" : "paused");
    },
    async resume(repository) {
      await requireRepository(repository);
      await setMode(repository, "active");
    },
  };
};
