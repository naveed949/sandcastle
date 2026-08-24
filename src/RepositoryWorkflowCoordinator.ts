import type {
  RepositoryWorkflowControl,
  RepositoryWorkflowRunRecord,
} from "./RepositoryWorkflowControl.js";

export type RepositoryWorkflowCoordinatorMode =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unhealthy";

/** Operator-visible lifecycle state for the repository workflow coordinator. */
export interface RepositoryWorkflowCoordinatorStatus {
  /** Current coordinator lifecycle mode. */
  readonly mode: RepositoryWorkflowCoordinatorMode;
  /** Repository whose workflow is currently executing, when one is active. */
  readonly activeRepository?: string;
  /** Completion time of the most recent polling cycle. */
  readonly lastCycleAt?: string;
  /** Most recent coordinator error. */
  readonly lastError?: string;
}

/** Host-owned scheduler for globally serialized repository workflows. */
export interface RepositoryWorkflowCoordinator {
  /** The operator control surface, with dispatch gated by coordinator state. */
  readonly control: RepositoryWorkflowControl;
  /** Run one globally serialized repository workflow cycle. */
  runCycle(): Promise<void>;
  /** Start polling. Resolves after the coordinator is ready to dispatch. */
  start(): Promise<void>;
  /** Stop polling, cancel the active workflow, and await its durable outcome. */
  stop(): Promise<void>;
  /** Return current lifecycle and active-dispatch health. */
  status(): RepositoryWorkflowCoordinatorStatus;
}

/** Dependencies and lifecycle settings for a repository workflow coordinator. */
export interface RepositoryWorkflowCoordinatorOptions {
  /** Durable repository workflow control plane used for dispatch. */
  readonly control: RepositoryWorkflowControl;
  /** Delay between completed polling cycles. */
  readonly pollIntervalMs?: number;
  /** Maximum time to wait for a cancelled workflow to persist its outcome. */
  readonly shutdownTimeoutMs?: number;
  /** Clock used for operator-visible cycle timestamps. */
  readonly now?: () => string;
  /** Error observer for repository-specific and coordinator-wide failures. */
  readonly onError?: (repository: string, error: unknown) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Own the repository-workflow polling loop inside the production host.
 *
 * The coordinator deliberately schedules one repository at a time. The
 * existing repository workflow runtime remains injectable, but it cannot be
 * reached through this control surface until the host has granted lifecycle
 * authority by starting the coordinator.
 */
export const createRepositoryWorkflowCoordinator = (
  options: RepositoryWorkflowCoordinatorOptions,
): RepositoryWorkflowCoordinator => {
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("pollIntervalMs must be a positive finite number.");
  }
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new Error("shutdownTimeoutMs must be a positive finite number.");
  }

  const now = options.now ?? (() => new Date().toISOString());
  let mode: RepositoryWorkflowCoordinatorMode = "stopped";
  let timer: NodeJS.Timeout | undefined;
  let cycleInFlight: Promise<void> | undefined;
  let startInFlight: Promise<void> | undefined;
  let stopInFlight: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let activeRepository: string | undefined;
  let lastCycleAt: string | undefined;
  let lastError: string | undefined;

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(milliseconds: number): void {
    if (mode !== "running" || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runCycle().catch(() => undefined);
    }, milliseconds);
    timer.unref();
  }

  function runCycle(): Promise<void> {
    if (cycleInFlight !== undefined) return cycleInFlight;
    if (mode !== "running") {
      return Promise.reject(
        new Error(`Repository workflow coordinator is ${mode}.`),
      );
    }

    const controller = new AbortController();
    activeController = controller;
    const cycle = (async () => {
      const repositories = (await options.control.list())
        .filter((repository) => repository.mode === "active")
        .sort((left, right) => left.repository.localeCompare(right.repository));
      if (controller.signal.aborted) return;
      const target = repositories[0];
      if (target === undefined) return;

      activeRepository = target.repository;
      try {
        await options.control.runNow(target.repository, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          lastError = errorMessage(error);
          options.onError?.(target.repository, error);
        }
      } finally {
        if (activeController === controller) activeController = undefined;
        if (activeRepository === target.repository)
          activeRepository = undefined;
      }
    })();

    cycleInFlight = cycle
      .finally(() => {
        lastCycleAt = now();
        cycleInFlight = undefined;
        schedule(pollIntervalMs);
      })
      .catch((error) => {
        lastError = errorMessage(error);
        options.onError?.("*", error);
        throw error;
      });
    return cycleInFlight;
  }

  const start = (): Promise<void> => {
    if (mode === "running") return Promise.resolve();
    if (startInFlight !== undefined) return startInFlight;
    if (mode === "stopping" && stopInFlight !== undefined) {
      return stopInFlight.then(() => start());
    }

    mode = "starting";
    lastError = undefined;
    startInFlight = Promise.resolve()
      .then(() => {
        if (mode !== "starting") return;
        mode = "running";
        // Let the host finish its deterministic startup sequence before the
        // first dispatch can begin.
        schedule(0);
      })
      .catch((error) => {
        mode = "unhealthy";
        lastError = errorMessage(error);
        throw error;
      })
      .finally(() => {
        startInFlight = undefined;
      });
    return startInFlight;
  };

  const stop = (): Promise<void> => {
    if (stopInFlight !== undefined) return stopInFlight;
    if (mode === "stopped") return Promise.resolve();

    mode = "stopping";
    clearTimer();
    activeController?.abort(
      new Error("Repository workflow coordinator stopped."),
    );
    const activeCycle = cycleInFlight;
    stopInFlight = (async () => {
      if (activeCycle !== undefined) {
        await withTimeout(
          activeCycle,
          shutdownTimeoutMs,
          "Repository workflow coordinator shutdown timed out.",
        );
      }
      mode = "stopped";
      activeController = undefined;
      activeRepository = undefined;
    })()
      .catch((error) => {
        mode = "unhealthy";
        lastError = errorMessage(error);
        throw error;
      })
      .finally(() => {
        stopInFlight = undefined;
      });
    return stopInFlight;
  };

  const status = (): RepositoryWorkflowCoordinatorStatus => ({
    mode,
    ...(activeRepository === undefined ? {} : { activeRepository }),
    ...(lastCycleAt === undefined ? {} : { lastCycleAt }),
    ...(lastError === undefined ? {} : { lastError }),
  });

  const requireRunning = (): void => {
    if (mode !== "running") {
      throw new Error(
        `Repository workflow dispatch is unavailable while coordinator is ${mode}.`,
      );
    }
  };

  const control: RepositoryWorkflowControl = {
    authorize: options.control.authorize,
    remove: options.control.remove,
    list: options.control.list,
    inspect: options.control.inspect,
    runNow: async (
      repository,
      signal,
    ): Promise<RepositoryWorkflowRunRecord> => {
      requireRunning();
      return options.control.runNow(repository, signal);
    },
    pause: options.control.pause,
    resume: options.control.resume,
  };

  return { control, runCycle, start, stop, status };
};
