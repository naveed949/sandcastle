import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createWorktree,
  type WorktreeRunOptions,
  type WorktreeRunResult,
} from "./createWorktree.js";
import type { CloseResult, Sandbox } from "./createSandbox.js";
import type {
  BindMountSandboxProvider,
  IsolatedSandboxProvider,
} from "./SandboxProvider.js";
import {
  normalizeRepository,
  runWorkerDryRun,
  type ExecutionRequest,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  isRepositoryCredentialName,
  repositoryCredentialNamesInEnvironmentFile,
} from "./WorkerIsolationPolicy.js";

const execFile = promisify(execFileCallback);

export type WorkerCommandPhase = "setup" | "verification";

export interface WorkerCommandEvidence {
  /** Centrally approved command that was executed. */
  readonly command: string;
  /** Execution phase that owned the command. */
  readonly phase: WorkerCommandPhase;
  /** Process exit code; zero indicates success. */
  readonly exitCode: number;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
}

export interface WorkerAgentInvocation {
  /** Fully rendered immutable prompt passed to Sandcastle. */
  readonly prompt: string;
  /** Cancellation delegated to the existing Sandcastle run boundary. */
  readonly signal?: AbortSignal;
}

export type WorkerAgentResult = Pick<
  WorktreeRunResult,
  | "iterations"
  | "stdout"
  | "commits"
  | "branch"
  | "completionSignal"
  | "logFilePath"
>;

export interface PreparedWorkerRepository {
  /** Normalized owner/repository identity. */
  readonly repository: string;
  /** Repository-qualified storage namespace. */
  readonly namespace: string;
  /** Host cache containing the verified clone. */
  readonly repositoryDir: string;
  /** Host worktree prepared for this execution identity. */
  readonly worktreePath: string;
  /** Deterministic source branch used by the agent. */
  readonly branch: string;
  /** Canonical remote URL verified before worktree creation. */
  readonly canonicalRemote: string;
  /** Centrally configured base branch. */
  readonly baseBranch: string;
  /** Frozen base commit verified against the remote branch. */
  readonly baseCommit: string;
  /** Repository-authority credential names observed in agent-visible options. */
  readonly repositoryCredentialNames: readonly string[];
  /** Run one centrally approved setup or verification command. */
  runCommand(
    command: string,
    phase: WorkerCommandPhase,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkerCommandEvidence>;
  /** Invoke Sandcastle in the prepared worktree. */
  runAgent(invocation: WorkerAgentInvocation): Promise<WorkerAgentResult>;
  /** Close the worktree and report whether dirty state was preserved. */
  close(): Promise<CloseResult>;
}

export interface PrepareWorkerRepositoryInput {
  /** Current central authorization and execution policy. */
  readonly configuration: WorkerConfiguration;
  /** Immutable execution request selected and claimed earlier. */
  readonly request: ExecutionRequest;
  /** Fresh claim-time snapshots needed to authorize PRD and dependency context. */
  readonly relatedTasks?: readonly NormalizedTask[];
}

export interface WorkerRepositoryManager {
  /** Authorize, validate, and prepare one isolated repository worktree. */
  prepare(
    input: PrepareWorkerRepositoryInput,
  ): Promise<PreparedWorkerRepository>;
}

interface WorkerWorktreeHandle {
  readonly branch: string;
  readonly worktreePath: string;
  run(options: WorktreeRunOptions): Promise<WorktreeRunResult>;
  createSandbox(options: {
    readonly sandbox: BindMountSandboxProvider | IsolatedSandboxProvider;
    readonly env?: Record<string, string>;
  }): Promise<Sandbox>;
  close(): Promise<unknown>;
}

export interface WorkerRepositoryOperations {
  /** Check whether a qualified repository cache already exists. */
  repositoryExists(repositoryDir: string): Promise<boolean>;
  /** Clone the canonical remote into its qualified cache. */
  clone(input: {
    readonly canonicalRemote: string;
    readonly repositoryDir: string;
  }): Promise<void>;
  /** Read the origin URL from an existing cache. */
  getCanonicalRemote(repositoryDir: string): Promise<string>;
  /** Fetch the configured base branch without checking it out. */
  fetchBase(input: {
    readonly repositoryDir: string;
    readonly baseBranch: string;
  }): Promise<void>;
  /** Resolve the fetched remote base branch to a commit. */
  resolveRemoteBase(input: {
    readonly repositoryDir: string;
    readonly baseBranch: string;
  }): Promise<string>;
  /** Check that a frozen commit exists as a commit object. */
  hasCommit(input: {
    readonly repositoryDir: string;
    readonly commit: string;
  }): Promise<boolean>;
  /** Create an execution-qualified ref pinned to the frozen base. */
  createFrozenBaseRef(input: {
    readonly repositoryDir: string;
    readonly executionIdentity: string;
    readonly commit: string;
  }): Promise<string>;
  /** Create or reuse the deterministic Sandcastle worktree. */
  createWorktree(input: {
    readonly repositoryDir: string;
    readonly branch: string;
    readonly baseRef: string;
  }): Promise<WorkerWorktreeHandle>;
}

export type WorkerRepositoryErrorCode =
  | "unauthorized"
  | "request_mismatch"
  | "remote_mismatch"
  | "base_mismatch"
  | "missing_commit"
  | "repository_operation_failed";

export class WorkerRepositoryError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: WorkerRepositoryErrorCode;
  /** Original repository-operation failure, when present. */
  readonly cause?: unknown;

  /** Create a typed repository preparation error. */
  constructor(
    message: string,
    code: WorkerRepositoryErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WorkerRepositoryError";
    this.code = code;
    this.cause = cause;
  }
}

export interface WorkerRepositoryManagerOptions {
  /** Host root under which all repository-qualified state is stored. */
  readonly workspaceRoot: string;
  /** External Git and command boundary; defaults to local Git operations. */
  readonly operations?: WorkerRepositoryOperations;
  /** Sandcastle options are centrally supplied and intentionally cannot inject prompt args or env. */
  readonly agentRunOptions: Omit<
    WorktreeRunOptions,
    | "prompt"
    | "promptFile"
    | "promptArgs"
    | "env"
    | "logging"
    | "name"
    | "sandbox"
  > & {
    readonly sandbox: BindMountSandboxProvider | IsolatedSandboxProvider;
  };
  /** Minimal environment used by approved setup and verification commands. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
}

const repositoryParts = (repository: string): readonly [string, string] => {
  const parts = normalizeRepository(repository).split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[a-z0-9_.-]+$/.test(part ?? ""))
  ) {
    throw new WorkerRepositoryError(
      `Invalid repository identity ${repository}.`,
      "request_mismatch",
    );
  }
  return [parts[0]!, parts[1]!];
};

const canonicalRemoteFor = (repository: string): string =>
  `https://github.com/${normalizeRepository(repository)}.git`;

/** Return the repository-qualified cache used by execution and publication. */
export const workerRepositoryDirectory = (
  workspaceRoot: string,
  repository: string,
): string => {
  const [owner, name] = repositoryParts(repository);
  return join(workspaceRoot, "repositories", owner, name, "cache");
};

/** Return the deterministic branch owned by one immutable execution. */
export const workerBranchFor = (request: ExecutionRequest): string => {
  const [owner, name] = repositoryParts(request.task.repository);
  return `sandcastle/worker/${owner}/${name}/${request.task.kind}-${request.task.number}/${request.executionIdentity.slice(0, 12)}`;
};

const normalizeCanonicalRemote = (remote: string): string | undefined => {
  try {
    const url = new URL(remote);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    const path = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    return `https://github.com/${path}.git`;
  } catch {
    return undefined;
  }
};

const git = async (
  repositoryDir: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFile("git", [...args], {
    cwd: repositoryDir,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
};

/** Create the local Git and approved-command adapter used by the repository manager. */
export const createDefaultWorkerRepositoryOperations = (
  _options: {
    readonly commandEnvironment?: Readonly<Record<string, string>>;
  } = {},
): WorkerRepositoryOperations => ({
  repositoryExists: async (repositoryDir) => {
    try {
      return (await stat(join(repositoryDir, ".git"))).isDirectory();
    } catch {
      return false;
    }
  },
  clone: async ({ canonicalRemote, repositoryDir }) => {
    await mkdir(dirname(repositoryDir), { recursive: true });
    await execFile(
      "git",
      ["clone", "--no-checkout", canonicalRemote, repositoryDir],
      {
        env: { ...process.env, LC_ALL: "C" },
      },
    );
  },
  getCanonicalRemote: (repositoryDir) =>
    git(repositoryDir, ["remote", "get-url", "origin"]),
  fetchBase: async ({ repositoryDir, baseBranch }) => {
    await git(repositoryDir, [
      "fetch",
      "--prune",
      "origin",
      `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ]);
  },
  resolveRemoteBase: ({ repositoryDir, baseBranch }) =>
    git(repositoryDir, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${baseBranch}^{commit}`,
    ]),
  hasCommit: async ({ repositoryDir, commit }) => {
    try {
      await git(repositoryDir, ["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  },
  createFrozenBaseRef: async ({ repositoryDir, executionIdentity, commit }) => {
    const ref = `refs/sandcastle/bases/${executionIdentity}`;
    await git(repositoryDir, ["update-ref", ref, commit]);
    return ref;
  },
  createWorktree: async ({ repositoryDir, branch, baseRef }) =>
    createWorktree({
      cwd: repositoryDir,
      branchStrategy: { type: "branch", branch, baseBranch: baseRef },
    }),
});

const authorizationTasks = (
  request: ExecutionRequest,
  relatedTasks: readonly NormalizedTask[],
): readonly NormalizedTask[] => {
  const tasks = new Map<string, NormalizedTask>();
  for (const task of [
    ...relatedTasks,
    ...(request.context.parentPrd === undefined
      ? []
      : [request.context.parentPrd]),
    request.task,
  ]) {
    tasks.set(
      `${normalizeRepository(task.repository)}:${task.kind}:${task.number}`,
      task,
    );
  }
  return [...tasks.values()];
};

const runSandboxCommand = async (
  sandbox: Sandbox,
  command: string,
  phase: WorkerCommandPhase,
  signal?: AbortSignal,
): Promise<WorkerCommandEvidence> => {
  signal?.throwIfAborted();
  const execution = sandbox.exec(command);
  const result =
    signal === undefined
      ? await execution
      : await new Promise<Awaited<typeof execution>>((resolve, reject) => {
          let settled = false;
          const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            action();
          };
          const onAbort = (): void => {
            void sandbox
              .close()
              .finally(() => settle(() => reject(signal.reason)));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          execution.then(
            (value) => settle(() => resolve(value)),
            (error) => settle(() => reject(error)),
          );
          if (signal.aborted) onAbort();
        });
  return {
    command,
    phase,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/** Create a repository manager that authorizes before performing repository operations. */
export const createWorkerRepositoryManager = (
  options: WorkerRepositoryManagerOptions,
): WorkerRepositoryManager => {
  if (options.workspaceRoot.trim() === "") {
    throw new WorkerRepositoryError(
      "workspaceRoot must be non-empty.",
      "repository_operation_failed",
    );
  }
  if (
    (options.agentRunOptions.sandbox as { readonly tag: string }).tag === "none"
  ) {
    throw new WorkerRepositoryError(
      "Worker execution requires an isolated or bind-mount sandbox provider.",
      "repository_operation_failed",
    );
  }
  const agentOptions = options.agentRunOptions as WorktreeRunOptions;
  const repositoryCredentialNames = [
    ...Object.keys(agentOptions.agent.env ?? {}),
    ...Object.keys(agentOptions.env ?? {}),
    ...Object.keys(agentOptions.sandbox.env ?? {}),
    ...Object.keys(options.commandEnvironment ?? {}),
  ].filter(isRepositoryCredentialName);
  if (repositoryCredentialNames.length > 0) {
    throw new WorkerRepositoryError(
      `Worker agent options expose repository credentials: ${repositoryCredentialNames.join(", ")}.`,
      "repository_operation_failed",
    );
  }
  if (agentOptions.hooks !== undefined) {
    throw new WorkerRepositoryError(
      "Worker execution profiles cannot supply lifecycle hooks; use approved setup commands instead.",
      "repository_operation_failed",
    );
  }
  const operations =
    options.operations ??
    createDefaultWorkerRepositoryOperations({
      commandEnvironment: options.commandEnvironment,
    });

  return {
    prepare: async ({ configuration, request, relatedTasks = [] }) => {
      // This policy check is deliberately the first action in the method. No filesystem,
      // clone, fetch, worktree, or command operation may precede it.
      const dryRun = runWorkerDryRun({
        configuration,
        tasks: authorizationTasks(request, relatedTasks),
      });
      const authorizedRequest = dryRun.executionRequests.find(
        (candidate) => candidate.taskId === request.taskId,
      );
      if (authorizedRequest === undefined) {
        throw new WorkerRepositoryError(
          `Task ${request.taskId} is not authorized for execution.`,
          "unauthorized",
        );
      }
      if (authorizedRequest.executionIdentity !== request.executionIdentity) {
        throw new WorkerRepositoryError(
          `Execution request ${request.executionIdentity} no longer matches central policy.`,
          "request_mismatch",
        );
      }

      const repository = normalizeRepository(request.task.repository);
      const [owner, name] = repositoryParts(repository);
      const namespace = `${owner}/${name}`;
      const repositoryDir = workerRepositoryDirectory(
        options.workspaceRoot,
        repository,
      );
      const canonicalRemote = canonicalRemoteFor(repository);
      const branch = workerBranchFor(request);

      try {
        if (!(await operations.repositoryExists(repositoryDir))) {
          await operations.clone({ canonicalRemote, repositoryDir });
        }
        const observedRemote =
          await operations.getCanonicalRemote(repositoryDir);
        if (normalizeCanonicalRemote(observedRemote) !== canonicalRemote) {
          throw new WorkerRepositoryError(
            `Repository ${repository} remote ${observedRemote} does not match ${canonicalRemote}.`,
            "remote_mismatch",
          );
        }
        await operations.fetchBase({
          repositoryDir,
          baseBranch: request.task.baseBranch,
        });
        const observedBase = await operations.resolveRemoteBase({
          repositoryDir,
          baseBranch: request.task.baseBranch,
        });
        if (
          observedBase.toLowerCase() !== request.task.baseCommit.toLowerCase()
        ) {
          throw new WorkerRepositoryError(
            `Repository ${repository} base ${request.task.baseBranch} moved from frozen commit ${request.task.baseCommit} to ${observedBase}.`,
            "base_mismatch",
          );
        }
        if (
          !(await operations.hasCommit({
            repositoryDir,
            commit: request.task.baseCommit,
          }))
        ) {
          throw new WorkerRepositoryError(
            `Frozen base commit ${request.task.baseCommit} is not present in ${repository}.`,
            "missing_commit",
          );
        }
        const baseRef = await operations.createFrozenBaseRef({
          repositoryDir,
          executionIdentity: request.executionIdentity,
          commit: request.task.baseCommit,
        });
        const worktree = await operations.createWorktree({
          repositoryDir,
          branch,
          baseRef,
        });

        let sandboxPromise: Promise<Sandbox> | undefined;
        const assertSafeRepositoryEnvironment = async (): Promise<void> => {
          for (const environmentPath of [
            join(repositoryDir, ".sandcastle", ".env"),
            join(worktree.worktreePath, ".sandcastle", ".env"),
          ]) {
            try {
              const environmentFile = await readFile(environmentPath, "utf8");
              const names =
                repositoryCredentialNamesInEnvironmentFile(environmentFile);
              if (names.length > 0) {
                throw new WorkerRepositoryError(
                  `Worker repository environment exposes credentials: ${names.join(", ")}.`,
                  "repository_operation_failed",
                );
              }
            } catch (error) {
              if (error instanceof WorkerRepositoryError) throw error;
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
            }
          }
        };
        const getSandbox = async (): Promise<Sandbox> => {
          if (sandboxPromise === undefined) {
            sandboxPromise = (async () => {
              await assertSafeRepositoryEnvironment();
              return worktree.createSandbox({
                sandbox: options.agentRunOptions.sandbox,
                env: {
                  CI: "1",
                  ...options.commandEnvironment,
                  ...agentOptions.env,
                  ...agentOptions.agent.env,
                },
              });
            })();
          }
          return sandboxPromise;
        };

        return {
          repository,
          namespace,
          repositoryDir,
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
          canonicalRemote,
          baseBranch: request.task.baseBranch,
          baseCommit: request.task.baseCommit,
          repositoryCredentialNames,
          runCommand: async (command, phase, commandOptions = {}) =>
            runSandboxCommand(
              await getSandbox(),
              command,
              phase,
              commandOptions.signal,
            ),
          runAgent: async ({ prompt, signal }) => {
            const result = await (
              await getSandbox()
            ).run({
              ...options.agentRunOptions,
              prompt,
              ...(signal === undefined ? {} : { signal }),
              name: `worker:${request.taskId}`,
              logging: {
                type: "file",
                path: join(
                  repositoryDir,
                  ".sandcastle",
                  "logs",
                  `${request.executionIdentity}.log`,
                ),
              },
            });
            return { ...result, branch: worktree.branch };
          },
          close: async () => {
            let sandboxCloseError: unknown;
            try {
              if (sandboxPromise !== undefined) {
                await (await sandboxPromise).close();
              }
            } catch (error) {
              sandboxCloseError = error;
            }
            const result = (await worktree.close()) as CloseResult;
            if (sandboxCloseError !== undefined) throw sandboxCloseError;
            return result;
          },
        } satisfies PreparedWorkerRepository;
      } catch (error) {
        if (error instanceof WorkerRepositoryError) throw error;
        throw new WorkerRepositoryError(
          `Could not prepare repository ${repository}: ${error instanceof Error ? error.message : String(error)}`,
          "repository_operation_failed",
          error,
        );
      }
    },
  };
};
