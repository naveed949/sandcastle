import type {
  AuthorizedRepositoryWorkflow,
  RepositoryWorkflowControl,
} from "./RepositoryWorkflowControl.js";

export interface RepositoryWorkflowSupervisorControl {
  list(): Promise<
    readonly Pick<AuthorizedRepositoryWorkflow, "repository" | "mode">[]
  >;
  runNow(repository: string): Promise<unknown>;
}

export interface RepositoryWorkflowSupervisor {
  runCycle(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface RepositoryWorkflowSupervisorOptions {
  readonly control:
    | RepositoryWorkflowSupervisorControl
    | RepositoryWorkflowControl;
  readonly pollIntervalMs?: number;
  readonly onError?: (repository: string, error: unknown) => void;
}

/** Poll all authorized repositories while preserving independent pause state. */
export const createRepositoryWorkflowSupervisor = (
  options: RepositoryWorkflowSupervisorOptions,
): RepositoryWorkflowSupervisor => {
  let timer: NodeJS.Timeout | undefined;
  let cycling = false;
  const runCycle = async (): Promise<void> => {
    if (cycling) return;
    cycling = true;
    try {
      const repositories = await options.control.list();
      await Promise.all(
        repositories
          .filter((repository) => repository.mode === "active")
          .map(async ({ repository }) => {
            try {
              await options.control.runNow(repository);
            } catch (error) {
              options.onError?.(repository, error);
            }
          }),
      );
    } finally {
      cycling = false;
    }
  };
  return {
    runCycle,
    start() {
      if (timer) return;
      void runCycle();
      timer = setInterval(
        () => void runCycle(),
        options.pollIntervalMs ?? 60_000,
      );
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};
