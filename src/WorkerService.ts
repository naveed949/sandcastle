import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  runWorkerDryRun,
  type EligibilityDecision,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { claimWorkerTask, WorkerClaimError } from "./WorkerClaimCoordinator.js";
import type { WorkerExecutionEngine } from "./WorkerExecutionEngine.js";
import type {
  GitHubTaskDiscoveryInput,
  GitHubTaskSource,
} from "./GitHubTaskSource.js";
import type { WorkerPublisher } from "./WorkerPublication.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";
import type { ExecutionAttempt, WorkerStateStore } from "./WorkerStateStore.js";

/** Operator-visible lifecycle states emitted by the continuous worker. */
export type WorkerOperationalState =
  | "discovered"
  | "unauthorized"
  | "ineligible"
  | "ready"
  | "claimed"
  | "running"
  | "blocked"
  | "failed"
  | "verified"
  | "published";

/** Lifecycle mode of the continuous worker service itself. */
export type WorkerServiceMode =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unhealthy";

/** Read-only lifecycle timing exposed to an operator surface. */
export interface WorkerServiceStatus {
  readonly mode: WorkerServiceMode;
  readonly lastCompletedCycle?: string;
  readonly nextExpectedCycle?: string;
}

/** One structured, secret-free operational event. */
export interface WorkerDiagnostic {
  /** ISO timestamp at which the transition was observed. */
  readonly timestamp: string;
  /** Stable operator-facing lifecycle state. */
  readonly state: WorkerOperationalState;
  /** Repository-qualified task identity, when the event concerns a task. */
  readonly taskId?: string;
  /** Durable attempt identity, when an attempt exists. */
  readonly attemptId?: string;
  /** Immutable execution identity, when execution inputs were selected. */
  readonly executionIdentity?: string;
  /** Stable eligibility, recovery, or failure category. */
  readonly reasonCode?: string;
  /** Human-readable explanation without retained protected material. */
  readonly message: string;
}

/** Sink for persistent or externally forwarded worker diagnostics. */
export interface WorkerDiagnostics {
  /** Retain or forward one structured operational event. */
  emit(event: WorkerDiagnostic): Promise<void>;
}

/** Persistent locations shared by one remote worker installation. */
export interface WorkerServicePaths {
  /** Durable root shared by state, records, caches, logs, and worktrees. */
  readonly workspaceRoot: string;
  /** Durable JSON state file. */
  readonly stateFilePath: string;
  /** Durable structured execution-evidence root. */
  readonly recordsRoot: string;
  /** Durable repository caches containing logs and recovery worktrees. */
  readonly repositoriesRoot: string;
  /** Append-only operational JSONL file. */
  readonly diagnosticsFilePath: string;
  /** Stable path identity for the kernel-owned cross-process service lock. */
  readonly serviceLockFilePath: string;
}

/** Derive the persistent state, evidence and diagnostics paths for a worker. */
export const workerServicePaths = (
  workspaceRoot: string,
): WorkerServicePaths => {
  if (workspaceRoot.trim() === "") {
    throw new Error("workspaceRoot must be non-empty.");
  }
  const root = resolve(workspaceRoot);
  return {
    workspaceRoot: root,
    stateFilePath: join(root, "state", "worker.json"),
    recordsRoot: join(root, "records"),
    repositoriesRoot: join(root, "repositories"),
    diagnosticsFilePath: join(root, "diagnostics", "worker.jsonl"),
    serviceLockFilePath: join(root, "state", "service.lock"),
  };
};

/** Create an append-only JSONL diagnostic sink suitable for restart inspection. */
export const createJsonlWorkerDiagnostics = (
  filePath: string,
): WorkerDiagnostics => {
  if (filePath.trim() === "") {
    throw new Error("diagnostics filePath must be non-empty.");
  }
  return {
    emit: async (event) => {
      await mkdir(dirname(filePath), { recursive: true });
      const safeEvent = containsProtectedWorkerMaterial(event.message)
        ? { ...event, message: "Protected worker material redacted." }
        : event;
      await appendFile(filePath, `${JSON.stringify(safeEvent)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
};

/** One completed, non-overlapping polling cycle. */
export interface WorkerCycleResult {
  /** Ordered operational events emitted during the cycle. */
  readonly events: readonly WorkerDiagnostic[];
  /** Whether execution or recovered publication was attempted. */
  readonly attempted: boolean;
}

/** Restartable single-worker service boundary. */
export interface WorkerService {
  /** Run one exclusive discovery/recovery and optional execution cycle. */
  runCycle(): Promise<WorkerCycleResult>;
  /** Poll continuously until stopped; repeated calls share the active loop. */
  start(): Promise<void>;
  /** Stop polling and cancel an active execution through Sandcastle. */
  stop(): Promise<void>;
  /** Return the service lifecycle mode and cycle timing without mutating state. */
  status(): WorkerServiceStatus;
}

/** Central configuration and injected boundaries for one remote worker. */
export interface WorkerServiceOptions {
  /** Central authorization, repository-profile, and prompt policy. */
  readonly configuration: WorkerConfiguration;
  /** Read-only GitHub discovery and claim-refresh boundary. */
  readonly source: GitHubTaskSource;
  /** Durable state boundary shared with execution and publication. */
  readonly store: WorkerStateStore;
  /** Local isolated execution boundary. */
  readonly execution: WorkerExecutionEngine;
  /** Verification-gated draft publication boundary. */
  readonly publisher: WorkerPublisher;
  /** Stable lease owner for this remote worker. */
  readonly owner: string;
  /** Delay between completed non-overlapping polling cycles. */
  readonly pollIntervalMs: number;
  /** Duration of revision-bound task leases. */
  readonly leaseDurationMs: number;
  /** Overall setup, agent, and verification cancellation timeout. */
  readonly executionTimeoutMs?: number;
  /** Stable path identity shared by every service process for this worker. */
  readonly lockFilePath: string;
  /** Centrally controlled GitHub discovery modes. */
  readonly discovery?: Omit<GitHubTaskDiscoveryInput, "configuration">;
  /** Persistent or externally forwarded diagnostic sink. */
  readonly diagnostics?: WorkerDiagnostics;
}

/** Raised when another live service process owns the persistent worker lock. */
export class WorkerServiceLockError extends Error {
  constructor(lockFilePath: string) {
    super(`Worker service lock ${lockFilePath} is owned by another process.`);
    this.name = "WorkerServiceLockError";
  }
}

/** Cancellation reason used when an operator stops the service. */
export class WorkerServiceShutdownError extends Error {
  constructor() {
    super("Worker service is shutting down.");
    this.name = "WorkerServiceShutdownError";
  }
}

/** Cancellation reason used when an execution exceeds its service limit. */
export class WorkerExecutionTimeoutError extends Error {
  /** Configured timeout that elapsed. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Worker execution exceeded ${timeoutMs}ms.`);
    this.name = "WorkerExecutionTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const waitForPoll = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const operationalStateFor = (
  decision: EligibilityDecision,
  retainedAttempt: ExecutionAttempt | undefined,
): WorkerOperationalState => {
  if (retainedAttempt?.status === "published") return "published";
  if (retainedAttempt?.status === "verified") return "verified";
  if (
    retainedAttempt?.status === "failed" ||
    retainedAttempt?.status === "interrupted"
  ) {
    return "blocked";
  }
  if (decision.eligible) return "ready";
  if (decision.reasonCode === "unauthorized_repository") {
    return "unauthorized";
  }
  if (
    decision.reasonCode === "blocked" ||
    decision.reasonCode === "unmet_dependency"
  ) {
    return "blocked";
  }
  return "ineligible";
};

const acquireServiceLock = async (
  lockFilePath: string,
): Promise<() => Promise<void>> => {
  await mkdir(dirname(lockFilePath), { recursive: true });
  const processCode =
    'process.stdout.write("acquired\\n"); process.stdin.resume();';
  const lock = spawn(
    "flock",
    ["--nonblock", resolve(lockFilePath), process.execPath, "-e", processCode],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let errorOutput = "";
  lock.stderr.setEncoding("utf8");
  lock.stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    lock.once("error", reject);
    lock.once("exit", resolveExit);
  });
  await new Promise<void>((resolveAcquired, reject) => {
    lock.stdout.setEncoding("utf8");
    lock.stdout.once("data", (chunk: string) => {
      if (chunk.includes("acquired")) resolveAcquired();
      else
        reject(new Error("Worker service lock returned an invalid response."));
    });
    void exited.then((code) => {
      if (code === 1) reject(new WorkerServiceLockError(lockFilePath));
      else if (code !== null && code !== 0) {
        reject(
          new Error(
            `Worker service lock failed with exit code ${code}: ${errorOutput.trim()}`,
          ),
        );
      }
    }, reject);
  });
  return async () => {
    lock.stdin.end();
    const code = await exited;
    if (code !== 0) {
      throw new Error(`Worker service lock exited with code ${String(code)}.`);
    }
  };
};

/** Create a fail-closed continuous worker around the existing orchestration seams. */
export const createWorkerService = (
  options: WorkerServiceOptions,
): WorkerService => {
  // Validate central authorization, repository profiles and prompt artifacts before
  // discovery can perform even a read-only provider call.
  runWorkerDryRun({ configuration: options.configuration, tasks: [] });

  if (options.owner.trim() === "") throw new Error("owner must be non-empty.");
  if (options.lockFilePath.trim() === "") {
    throw new Error("lockFilePath must be non-empty.");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("pollIntervalMs must be a positive finite number.");
  }
  if (
    !Number.isFinite(options.leaseDurationMs) ||
    options.leaseDurationMs <= 0
  ) {
    throw new Error("leaseDurationMs must be a positive finite number.");
  }
  if (
    options.executionTimeoutMs !== undefined &&
    (!Number.isFinite(options.executionTimeoutMs) ||
      options.executionTimeoutMs <= 0)
  ) {
    throw new Error("executionTimeoutMs must be a positive finite number.");
  }

  const now = (): string => new Date().toISOString();
  const diagnostics = options.diagnostics ?? { emit: async () => undefined };
  let cycleInFlight: Promise<WorkerCycleResult> | undefined;
  let loopInFlight: Promise<void> | undefined;
  let loopLock: Promise<() => Promise<void>> | undefined;
  let stopRequested = false;
  let pollController: AbortController | undefined;
  let executionController: AbortController | undefined;
  let serviceMode: WorkerServiceMode = "stopped";
  let lastCompletedCycle: string | undefined;
  let nextExpectedCycle: string | undefined;
  const serviceIsHealthy = (): boolean => serviceMode !== "unhealthy";

  const completeCycle = (result: WorkerCycleResult): WorkerCycleResult => {
    const completedAt = now();
    lastCompletedCycle = completedAt;
    nextExpectedCycle = undefined;
    if (serviceMode === "running" || serviceMode === "starting") {
      nextExpectedCycle = new Date(
        Date.parse(completedAt) + options.pollIntervalMs,
      ).toISOString();
    }
    return result;
  };

  const execute = async (attempt: ExecutionAttempt) => {
    const controller = new AbortController();
    executionController = controller;
    const timeout =
      options.executionTimeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new WorkerExecutionTimeoutError(options.executionTimeoutMs!),
              ),
            options.executionTimeoutMs,
          );
    try {
      return await options.execution.execute(attempt, {
        signal: controller.signal,
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (executionController === controller) executionController = undefined;
    }
  };

  type EmitDiagnostic = (
    event: Omit<WorkerDiagnostic, "timestamp">,
  ) => Promise<void>;

  const processClaimedAttempt = async (
    attempt: ExecutionAttempt,
    emit: EmitDiagnostic,
    claim: { readonly reasonCode?: string; readonly message: string },
  ): Promise<boolean> => {
    const taskId = attempt.request.taskId;
    const context = {
      taskId,
      attemptId: attempt.attemptId,
      executionIdentity: attempt.executionIdentity,
    };
    await emit({ state: "claimed", ...context, ...claim });
    if (stopRequested) {
      await emit({
        state: "blocked",
        ...context,
        reasonCode: "shutdown_pending",
        message: `Preserved claim ${attempt.attemptId} without dispatch during shutdown.`,
      });
      return false;
    }

    await emit({
      state: "running",
      ...context,
      message: `Running ${taskId}.`,
    });
    if (stopRequested) {
      await emit({
        state: "blocked",
        ...context,
        reasonCode: "shutdown_pending",
        message: `Preserved claim ${attempt.attemptId} without dispatch during shutdown.`,
      });
      return false;
    }
    const result = await execute(attempt);
    if (result.status !== "verified") {
      await emit({
        state: "failed",
        ...context,
        reasonCode: result.failurePhase,
        message: result.error ?? `Execution failed for ${taskId}.`,
      });
      return true;
    }

    await emit({
      state: "verified",
      ...context,
      message: `Verified ${taskId}.`,
    });
    const publication = await options.publisher.publish(attempt.attemptId);
    await emit({
      state: "published",
      ...context,
      message: `Published ${taskId} as draft ${publication.pullRequest.url}.`,
    });
    return true;
  };

  const performCycle = async (): Promise<WorkerCycleResult> => {
    const events: WorkerDiagnostic[] = [];
    const emit = async (
      event: Omit<WorkerDiagnostic, "timestamp">,
    ): Promise<void> => {
      const diagnostic = { timestamp: now(), ...event };
      events.push(diagnostic);
      await diagnostics.emit(diagnostic);
    };

    const persisted = await options.store.read();
    const verifiedAttempt = persisted.attempts.find(
      (attempt) => attempt.status === "verified",
    );
    if (verifiedAttempt !== undefined) {
      await emit({
        state: "verified",
        taskId: verifiedAttempt.request.taskId,
        attemptId: verifiedAttempt.attemptId,
        executionIdentity: verifiedAttempt.executionIdentity,
        reasonCode: "resume_publication",
        message: `Resuming publication for verified attempt ${verifiedAttempt.attemptId}.`,
      });
      const publication = await options.publisher.publish(
        verifiedAttempt.attemptId,
      );
      await emit({
        state: "published",
        taskId: verifiedAttempt.request.taskId,
        attemptId: verifiedAttempt.attemptId,
        executionIdentity: verifiedAttempt.executionIdentity,
        message: `Published ${verifiedAttempt.request.taskId} as draft ${publication.pullRequest.url}.`,
      });
      return completeCycle({ events, attempted: true });
    }
    const activeAttempt = persisted.attempts.find(
      (attempt) => attempt.status === "active",
    );
    if (activeAttempt?.claim?.phase === "started") {
      await emit({
        state: "blocked",
        taskId: activeAttempt.request.taskId,
        attemptId: activeAttempt.attemptId,
        executionIdentity: activeAttempt.executionIdentity,
        reasonCode: "manual_intervention",
        message: `Attempt ${activeAttempt.attemptId} may have side effects; inspect its retained worktree and evidence before retrying.`,
      });
      return completeCycle({ events, attempted: false });
    }
    if (activeAttempt?.claim?.phase === "claimed") {
      const recovery = (
        await options.store.inspectExpiredLeases({ at: now() })
      ).find((candidate) => candidate.attemptId === activeAttempt.attemptId);
      const executableAttempt =
        recovery?.disposition === "safe_retry"
          ? await claimWorkerTask({
              source: options.source,
              store: options.store,
              configuration: options.configuration,
              request: activeAttempt.request,
              owner: options.owner,
              leaseDurationMs: options.leaseDurationMs,
              claimedAt: now(),
              attemptId: `${activeAttempt.attemptId}:retry`,
            })
          : activeAttempt;
      const attempted = await processClaimedAttempt(executableAttempt, emit, {
        reasonCode:
          recovery?.disposition === "safe_retry" ? "safe_retry" : "safe_resume",
        message:
          recovery?.disposition === "safe_retry"
            ? `Retrying expired unstarted claim ${activeAttempt.attemptId} as ${executableAttempt.attemptId}.`
            : `Resuming retained claim ${activeAttempt.attemptId}.`,
      });
      return completeCycle({ events, attempted });
    }

    const tasks = await options.source.discover({
      ...options.discovery,
      configuration: options.configuration,
    });
    const dryRun = runWorkerDryRun({
      configuration: options.configuration,
      tasks,
    });
    await options.store.recordDiscovery(dryRun, { discoveredAt: now() });

    for (const decision of dryRun.decisions) {
      await emit({
        state: "discovered",
        taskId: decision.taskId,
        message: `Discovered ${decision.taskId}.`,
      });
      const retainedAttempt =
        decision.executionIdentity === undefined
          ? undefined
          : persisted.attempts.find(
              (attempt) =>
                attempt.executionIdentity === decision.executionIdentity,
            );
      const state = operationalStateFor(decision, retainedAttempt);
      await emit({
        state,
        taskId: decision.taskId,
        reasonCode: decision.reasonCode,
        message: decision.reason,
      });
    }

    const request = dryRun.executionRequests.find(
      (candidate) =>
        !persisted.attempts.some(
          (attempt) =>
            attempt.executionIdentity === candidate.executionIdentity,
        ),
    );
    if (request === undefined)
      return completeCycle({ events, attempted: false });
    if (stopRequested) return completeCycle({ events, attempted: false });

    let attempt;
    try {
      attempt = await claimWorkerTask({
        source: options.source,
        store: options.store,
        configuration: options.configuration,
        request,
        owner: options.owner,
        leaseDurationMs: options.leaseDurationMs,
        claimedAt: now(),
      });
    } catch (error) {
      if (error instanceof WorkerClaimError) {
        await emit({
          state: "ineligible",
          taskId: request.taskId,
          executionIdentity: request.executionIdentity,
          reasonCode: error.code,
          message: error.message,
        });
        return completeCycle({ events, attempted: false });
      }
      throw error;
    }

    const attempted = await processClaimedAttempt(attempt, emit, {
      message: `Claimed ${request.taskId}.`,
    });
    return completeCycle({ events, attempted });
  };

  const runUnlockedCycle = (): Promise<WorkerCycleResult> => {
    cycleInFlight ??= performCycle()
      .catch((error) => {
        serviceMode = "unhealthy";
        throw error;
      })
      .finally(() => {
        cycleInFlight = undefined;
      });
    return cycleInFlight;
  };

  const runCycle = (): Promise<WorkerCycleResult> => {
    if (loopLock !== undefined) {
      return loopLock.then(() => runUnlockedCycle());
    }
    cycleInFlight ??= (async () => {
      const release = await acquireServiceLock(options.lockFilePath);
      try {
        return await performCycle();
      } finally {
        await release();
      }
    })()
      .catch((error) => {
        serviceMode = "unhealthy";
        throw error;
      })
      .finally(() => {
        cycleInFlight = undefined;
      });
    return cycleInFlight;
  };

  return {
    runCycle,
    start: () => {
      if (loopInFlight !== undefined) return loopInFlight;
      stopRequested = false;
      serviceMode = "starting";
      const acquiredLock = acquireServiceLock(options.lockFilePath);
      loopLock = acquiredLock;
      loopInFlight = (async () => {
        try {
          const release = await acquiredLock;
          try {
            serviceMode = "running";
            while (!stopRequested) {
              await runUnlockedCycle();
              if (stopRequested) break;
              const controller = new AbortController();
              pollController = controller;
              await waitForPoll(options.pollIntervalMs, controller.signal);
              if (pollController === controller) pollController = undefined;
            }
          } finally {
            await release();
            if (serviceIsHealthy()) serviceMode = "stopped";
          }
        } catch (error) {
          serviceMode = "unhealthy";
          throw error;
        }
      })().finally(() => {
        loopInFlight = undefined;
        if (loopLock === acquiredLock) loopLock = undefined;
        pollController = undefined;
      });
      return loopInFlight;
    },
    stop: async () => {
      stopRequested = true;
      if (loopInFlight !== undefined) serviceMode = "stopping";
      pollController?.abort(new WorkerServiceShutdownError());
      executionController?.abort(new WorkerServiceShutdownError());
      await (loopInFlight ?? cycleInFlight ?? Promise.resolve());
      nextExpectedCycle = undefined;
      if (serviceMode === "stopping") serviceMode = "stopped";
    },
    status: () => ({
      mode: serviceMode,
      ...(lastCompletedCycle === undefined ? {} : { lastCompletedCycle }),
      ...(nextExpectedCycle === undefined ? {} : { nextExpectedCycle }),
    }),
  };
};
