import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  | "pausing"
  | "paused"
  | "stopping"
  | "unhealthy";

/** Recovery actions exposed by the guarded operator surface. */
export type WorkerRecoveryAction = "retry" | "acknowledge";

/** Classification that determines which recovery action, if any, is safe. */
export type WorkerRecoveryDisposition =
  | "safe_retry"
  | "safe_resume"
  | "manual_intervention";

/** Stable reason codes for recovery decisions and rejected actions. */
export type WorkerRecoveryReasonCode =
  | WorkerRecoveryDisposition
  | "recovery_action_required"
  | "recovery_target_required"
  | "recovery_target_not_found"
  | "recovery_target_not_claimed"
  | "recovery_not_expired"
  | "recovery_claim_refresh_failed"
  | "recovery_claim_conflict"
  | "recovery_operator_required"
  | "recovery_acknowledgement_not_allowed"
  | "recovery_already_applied"
  | "recovery_stale_revision"
  | "recovery_invalid_request";

/** The deliberately small set of operator mutations exposed by the worker. */
export type WorkerControlCommand =
  | "run-now"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "acknowledge"
  /** Generic recovery spelling; recoveryAction selects retry or acknowledge. */
  | "recover";

/** Stable machine-readable outcomes for guarded operator commands. */
export type WorkerControlOutcomeCode =
  | "accepted"
  | "already_applied"
  | "stale_revision"
  | "command_id_conflict"
  | "invalid_request"
  | "reason_required"
  | "target_required"
  | "target_mismatch"
  | "no_active_execution"
  | "service_unhealthy"
  | "command_failed"
  | "recovery_action_required"
  | "recovery_target_required"
  | "recovery_target_not_found"
  | "recovery_target_not_claimed"
  | "recovery_not_expired"
  | "recovery_manual_intervention"
  | "recovery_claim_refresh_failed"
  | "recovery_claim_conflict"
  | "recovery_operator_required"
  | "recovery_acknowledgement_not_allowed"
  | "recovery_already_applied"
  | "recovery_stale_revision"
  | "recovery_invalid_request";

/** Revision-checked input for one guarded operator command. */
export interface WorkerControlRequest {
  /** Caller-generated idempotency key retained in the operator audit. */
  readonly commandId: string;
  /** Worker revision observed by the caller before issuing the command. */
  readonly expectedRevision: number;
  /** One of the fixed worker control operations. */
  readonly command: WorkerControlCommand;
  /** Required explanation for every consequential runtime control. */
  readonly reason?: string;
  /** Required for cancellation so a stale operator cannot cancel another attempt. */
  readonly attemptId?: string;
  /** Human operator identity required for manual-intervention acknowledgement. */
  readonly operator?: string;
  /** Compatibility spelling for callers that use an operator identity field. */
  readonly operatorId?: string;
  /** Action selected when `command` is the generic `recover` command. */
  readonly recoveryAction?: WorkerRecoveryAction;
  /** Compatibility spelling for generic recovery callers. */
  readonly action?: WorkerRecoveryAction;
}

/** Shared input for the named methods on the narrow control surface. */
export type WorkerControlInput = Omit<WorkerControlRequest, "command">;

/** Result retained and returned for one guarded operator command. */
export interface WorkerControlOutcome {
  readonly version: 1;
  readonly commandId: string;
  readonly command: WorkerControlCommand;
  readonly code: WorkerControlOutcomeCode;
  /** Revision after this command, or the current revision on rejection. */
  readonly revision: number;
  readonly message: string;
  readonly attemptId?: string;
  readonly reasonCode?: WorkerRecoveryReasonCode;
}

/** One append-only operator command request or outcome record. */
export interface WorkerControlAuditRecord {
  readonly version: 1;
  readonly kind: "request" | "outcome";
  readonly timestamp: string;
  readonly commandId: string;
  readonly command: WorkerControlCommand;
  readonly expectedRevision: number;
  readonly revision: number;
  readonly reason?: string;
  readonly attemptId?: string;
  readonly operator?: string;
  readonly recoveryAction?: WorkerRecoveryAction;
  readonly reasonCode?: WorkerRecoveryReasonCode;
  readonly code?: WorkerControlOutcomeCode;
  readonly message?: string;
}

/** Narrow command seam exposed by a WorkerService and Mission Control host. */
export interface WorkerServiceControl {
  status(): WorkerServiceStatus;
  command(request: WorkerControlRequest): Promise<WorkerControlOutcome>;
  runNow(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  pause(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  resume(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  cancel(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  retry(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  acknowledge(request: WorkerControlInput): Promise<WorkerControlOutcome>;
  recover(request: WorkerControlInput): Promise<WorkerControlOutcome>;
}

/** Read-only lifecycle timing exposed to an operator surface. */
export interface WorkerServiceStatus {
  readonly mode: WorkerServiceMode;
  /** Monotonic revision used to reject commands from stale operator views. */
  readonly revision: number;
  /** Current execution target, when the agent boundary is active. */
  readonly activeAttemptId?: string;
  /** Whether polling has been requested to stop at the next safe boundary. */
  readonly pauseRequested: boolean;
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
  /** Append-only operator command request/outcome JSONL file. */
  readonly operatorAuditFilePath: string;
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
    operatorAuditFilePath: join(root, "operator", "commands.jsonl"),
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
  /** Execute only the fixed, revision-checked operator command set. */
  readonly control: WorkerServiceControl;
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
  /** Append-only operator command audit path. */
  readonly operatorAuditFilePath?: string;
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

/** Cancellation reason passed through the existing execution abort seam. */
export class WorkerServiceOperatorCancellationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Operator cancelled the active execution: ${reason}`);
    this.name = "WorkerServiceOperatorCancellationError";
    this.reason = reason;
  }
}

/** A guarded recovery rejection that must not make the worker unhealthy. */
export class WorkerRecoveryControlError extends Error {
  readonly code: Extract<
    WorkerControlOutcomeCode,
    | "recovery_action_required"
    | "recovery_target_required"
    | "recovery_target_not_found"
    | "recovery_target_not_claimed"
    | "recovery_not_expired"
    | "recovery_manual_intervention"
    | "recovery_claim_refresh_failed"
    | "recovery_claim_conflict"
    | "recovery_operator_required"
    | "recovery_acknowledgement_not_allowed"
    | "recovery_already_applied"
    | "recovery_stale_revision"
    | "recovery_invalid_request"
  >;
  readonly reasonCode: WorkerRecoveryReasonCode;

  constructor(
    code: WorkerRecoveryControlError["code"],
    reasonCode: WorkerRecoveryReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkerRecoveryControlError";
    this.code = code;
    this.reasonCode = reasonCode;
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

const CONTROL_COMMANDS: readonly WorkerControlCommand[] = [
  "run-now",
  "pause",
  "resume",
  "cancel",
  "retry",
  "acknowledge",
  "recover",
];

const CONTROL_OUTCOME_CODES: readonly WorkerControlOutcomeCode[] = [
  "accepted",
  "already_applied",
  "stale_revision",
  "command_id_conflict",
  "invalid_request",
  "reason_required",
  "target_required",
  "target_mismatch",
  "no_active_execution",
  "service_unhealthy",
  "command_failed",
  "recovery_action_required",
  "recovery_target_required",
  "recovery_target_not_found",
  "recovery_target_not_claimed",
  "recovery_not_expired",
  "recovery_manual_intervention",
  "recovery_claim_refresh_failed",
  "recovery_claim_conflict",
  "recovery_operator_required",
  "recovery_acknowledgement_not_allowed",
  "recovery_already_applied",
  "recovery_stale_revision",
  "recovery_invalid_request",
];

const RECOVERY_REASON_CODES: readonly WorkerRecoveryReasonCode[] = [
  "safe_retry",
  "safe_resume",
  "manual_intervention",
  "recovery_action_required",
  "recovery_target_required",
  "recovery_target_not_found",
  "recovery_target_not_claimed",
  "recovery_not_expired",
  "recovery_claim_refresh_failed",
  "recovery_claim_conflict",
  "recovery_operator_required",
  "recovery_acknowledgement_not_allowed",
  "recovery_already_applied",
  "recovery_stale_revision",
  "recovery_invalid_request",
];

const isWorkerControlCommand = (
  value: unknown,
): value is WorkerControlCommand =>
  typeof value === "string" &&
  (CONTROL_COMMANDS as readonly string[]).includes(value);

const isWorkerControlOutcomeCode = (
  value: unknown,
): value is WorkerControlOutcomeCode =>
  typeof value === "string" &&
  (CONTROL_OUTCOME_CODES as readonly string[]).includes(value);

const isWorkerRecoveryReasonCode = (
  value: unknown,
): value is WorkerRecoveryReasonCode =>
  typeof value === "string" &&
  (RECOVERY_REASON_CODES as readonly string[]).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redactedOperatorText = (value: string): string =>
  containsProtectedWorkerMaterial(value)
    ? "Protected worker material redacted."
    : value;

const recoveryActionFor = (
  request: WorkerControlRequest,
): WorkerRecoveryAction | undefined => {
  if (request.command === "retry") return "retry";
  if (request.command === "acknowledge") return "acknowledge";
  if (request.command !== "recover") return undefined;
  return request.recoveryAction ?? request.action;
};

const isRecoveryCommand = (request: WorkerControlRequest): boolean =>
  request.command === "retry" ||
  request.command === "acknowledge" ||
  request.command === "recover";

const operatorFor = (request: WorkerControlRequest): string | undefined => {
  const operator = request.operator ?? request.operatorId;
  return typeof operator === "string" ? operator : undefined;
};

interface LoadedControlAudit {
  readonly revision: number;
  readonly outcomes: ReadonlyMap<string, WorkerControlOutcome>;
}

const loadControlAudit = (filePath: string): LoadedControlAudit => {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { revision: 0, outcomes: new Map() };
    }
    throw error;
  }

  let revision = 0;
  const outcomes = new Map<string, WorkerControlOutcome>();
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.version !== 1) continue;
    if (
      typeof value.revision === "number" &&
      Number.isInteger(value.revision)
    ) {
      revision = Math.max(revision, value.revision);
    }
    if (
      value.kind !== "outcome" ||
      typeof value.commandId !== "string" ||
      !isWorkerControlCommand(value.command) ||
      !isWorkerControlOutcomeCode(value.code) ||
      typeof value.revision !== "number" ||
      !Number.isInteger(value.revision) ||
      typeof value.message !== "string"
    ) {
      continue;
    }
    outcomes.set(value.commandId, {
      version: 1,
      commandId: value.commandId,
      command: value.command,
      code: value.code,
      revision: value.revision,
      message: redactedOperatorText(value.message),
      ...(typeof value.attemptId === "string"
        ? { attemptId: value.attemptId }
        : {}),
      ...(isWorkerRecoveryReasonCode(value.reasonCode)
        ? { reasonCode: value.reasonCode }
        : {}),
    });
  }
  return { revision, outcomes };
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
  const lockDirectory = dirname(options.lockFilePath);
  const inferredWorkspaceRoot =
    basename(lockDirectory) === "state"
      ? dirname(lockDirectory)
      : lockDirectory;
  const operatorAuditFilePath =
    options.operatorAuditFilePath ??
    join(inferredWorkspaceRoot, "operator", "commands.jsonl");
  if (operatorAuditFilePath.trim() === "") {
    throw new Error("operatorAuditFilePath must be non-empty.");
  }
  const loadedAudit = loadControlAudit(operatorAuditFilePath);

  const now = (): string => new Date().toISOString();
  const diagnostics = options.diagnostics ?? { emit: async () => undefined };
  let cycleInFlight: Promise<WorkerCycleResult> | undefined;
  let loopInFlight: Promise<void> | undefined;
  let loopLock: Promise<() => Promise<void>> | undefined;
  let stopRequested = false;
  let pauseRequested = false;
  let pollController: AbortController | undefined;
  let executionController: AbortController | undefined;
  let activeAttemptId: string | undefined;
  let serviceMode: WorkerServiceMode = "stopped";
  let lastCompletedCycle: string | undefined;
  let nextExpectedCycle: string | undefined;
  let revision = loadedAudit.revision;
  const retainedOutcomes = new Map(loadedAudit.outcomes);
  let auditWriteInFlight = Promise.resolve();
  const serviceIsHealthy = (): boolean => serviceMode !== "unhealthy";

  const appendAudit = async (
    record: WorkerControlAuditRecord,
  ): Promise<void> => {
    const safeRecord: WorkerControlAuditRecord = {
      ...record,
      ...(record.reason === undefined
        ? {}
        : { reason: redactedOperatorText(record.reason) }),
      ...(record.operator === undefined
        ? {}
        : { operator: redactedOperatorText(record.operator) }),
      ...(record.message === undefined
        ? {}
        : { message: redactedOperatorText(record.message) }),
    };
    const write = auditWriteInFlight.then(async () => {
      await mkdir(dirname(operatorAuditFilePath), { recursive: true });
      await appendFile(
        operatorAuditFilePath,
        `${JSON.stringify(safeRecord)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    });
    auditWriteInFlight = write.catch(() => undefined);
    await write;
  };

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
    activeAttemptId = attempt.attemptId;
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
      if (activeAttemptId === attempt.attemptId) activeAttemptId = undefined;
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

  interface RecoveryInspection {
    readonly attempt: ExecutionAttempt;
    readonly disposition: WorkerRecoveryDisposition;
  }

  const inspectRecoveryTarget = async (
    attemptId: string,
  ): Promise<RecoveryInspection> => {
    const persisted = await options.store.read();
    const attempt = persisted.attempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attempt === undefined) {
      throw new WorkerRecoveryControlError(
        "recovery_target_not_found",
        "recovery_target_not_found",
        `Recovery target ${attemptId} was not found.`,
      );
    }
    if (attempt.status !== "active" || attempt.claim === undefined) {
      const retryAttempt = persisted.attempts.find(
        (candidate) => candidate.attemptId === `${attemptId}:retry`,
      );
      if (retryAttempt !== undefined) {
        throw new WorkerRecoveryControlError(
          "recovery_already_applied",
          "recovery_already_applied",
          `Recovery target ${attemptId} already has a retained retry attempt.`,
        );
      }
      throw new WorkerRecoveryControlError(
        "recovery_target_not_claimed",
        "recovery_target_not_claimed",
        `Recovery target ${attemptId} is not an active guarded claim.`,
      );
    }
    if (attempt.claim.phase === "started") {
      return { attempt, disposition: "manual_intervention" };
    }
    const expired = await options.store.inspectExpiredLeases({ at: now() });
    const recovery = expired.find(
      (candidate) => candidate.attemptId === attempt.attemptId,
    );
    return {
      attempt,
      disposition:
        recovery?.disposition === "safe_retry" ? "safe_retry" : "safe_resume",
    };
  };

  const performRecoveryRetry = async (
    attemptId: string,
  ): Promise<WorkerCycleResult> => {
    const events: WorkerDiagnostic[] = [];
    const emit = async (
      event: Omit<WorkerDiagnostic, "timestamp">,
    ): Promise<void> => {
      const diagnostic = { timestamp: now(), ...event };
      events.push(diagnostic);
      await diagnostics.emit(diagnostic);
    };
    const inspection = await inspectRecoveryTarget(attemptId);
    if (inspection.disposition !== "safe_retry") {
      if (inspection.disposition === "safe_resume") {
        throw new WorkerRecoveryControlError(
          "recovery_not_expired",
          "safe_resume",
          `Recovery target ${attemptId} has a live unstarted claim and is safe to resume, not retry.`,
        );
      }
      throw new WorkerRecoveryControlError(
        "recovery_manual_intervention",
        "manual_intervention",
        `Recovery target ${attemptId} may have side effects and requires manual intervention.`,
      );
    }
    if (stopRequested) {
      throw new WorkerRecoveryControlError(
        "recovery_claim_conflict",
        "recovery_claim_conflict",
        "The worker is shutting down and cannot retry a claim.",
      );
    }

    let retryAttempt: ExecutionAttempt;
    try {
      retryAttempt = await claimWorkerTask({
        source: options.source,
        store: options.store,
        configuration: options.configuration,
        request: inspection.attempt.request,
        owner: options.owner,
        leaseDurationMs: options.leaseDurationMs,
        claimedAt: now(),
        attemptId: `${inspection.attempt.attemptId}:retry`,
      });
    } catch (error) {
      if (error instanceof WorkerClaimError) {
        const stale = error.code === "stale_revision";
        throw new WorkerRecoveryControlError(
          stale ? "recovery_stale_revision" : "recovery_claim_refresh_failed",
          stale ? "recovery_stale_revision" : "recovery_claim_refresh_failed",
          `Safe retry claim refresh failed: ${error.message}`,
        );
      }
      throw new WorkerRecoveryControlError(
        "recovery_claim_conflict",
        "recovery_claim_conflict",
        `Safe retry could not acquire a new claim: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const attempted = await processClaimedAttempt(retryAttempt, emit, {
      reasonCode: "safe_retry",
      message: `Retrying expired unstarted claim ${inspection.attempt.attemptId} as ${retryAttempt.attemptId}.`,
    });
    return completeCycle({ events, attempted });
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

  const runUnlockedRecoveryCycle = (
    attemptId: string,
  ): Promise<WorkerCycleResult> => {
    cycleInFlight ??= performRecoveryRetry(attemptId)
      .catch((error) => {
        if (!(error instanceof WorkerRecoveryControlError)) {
          serviceMode = "unhealthy";
        }
        throw error;
      })
      .finally(() => {
        cycleInFlight = undefined;
      });
    return cycleInFlight;
  };

  const recoveryCycles = new Map<string, Promise<WorkerCycleResult>>();
  const runRecoveryCycle = (attemptId: string): Promise<WorkerCycleResult> => {
    const existing = recoveryCycles.get(attemptId);
    if (existing !== undefined) return existing;

    const recovery = (async () => {
      if (cycleInFlight !== undefined) await cycleInFlight;
      if (loopLock !== undefined) {
        return loopLock.then(() => runUnlockedRecoveryCycle(attemptId));
      }
      const release = await acquireServiceLock(options.lockFilePath);
      try {
        return await runUnlockedRecoveryCycle(attemptId);
      } finally {
        await release();
      }
    })();
    recoveryCycles.set(attemptId, recovery);
    void recovery.then(
      () => {
        if (recoveryCycles.get(attemptId) === recovery) {
          recoveryCycles.delete(attemptId);
        }
      },
      () => {
        if (recoveryCycles.get(attemptId) === recovery) {
          recoveryCycles.delete(attemptId);
        }
      },
    );
    return recovery;
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

  const start = (): Promise<void> => {
    if (loopInFlight !== undefined) return loopInFlight;
    if (pauseRequested) return Promise.resolve();
    stopRequested = false;
    serviceMode = "starting";
    const acquiredLock = acquireServiceLock(options.lockFilePath);
    loopLock = acquiredLock;
    loopInFlight = (async () => {
      try {
        const release = await acquiredLock;
        try {
          serviceMode = "running";
          while (!stopRequested && !pauseRequested) {
            await runUnlockedCycle();
            if (stopRequested || pauseRequested) break;
            const controller = new AbortController();
            pollController = controller;
            await waitForPoll(options.pollIntervalMs, controller.signal);
            if (pollController === controller) pollController = undefined;
          }
        } finally {
          await release();
          if (serviceIsHealthy()) {
            serviceMode = pauseRequested ? "paused" : "stopped";
          }
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
  };

  const stop = async (): Promise<void> => {
    stopRequested = true;
    pauseRequested = false;
    if (loopInFlight !== undefined) serviceMode = "stopping";
    pollController?.abort(new WorkerServiceShutdownError());
    executionController?.abort(new WorkerServiceShutdownError());
    await (loopInFlight ?? cycleInFlight ?? Promise.resolve());
    nextExpectedCycle = undefined;
    if (serviceMode === "stopping" || serviceMode === "paused") {
      serviceMode = "stopped";
    }
  };

  interface AcceptedControl {
    readonly code: "accepted";
    readonly message: string;
    readonly accepted: true;
    readonly action: Promise<void>;
    readonly attemptId?: string;
    readonly reasonCode?: WorkerRecoveryReasonCode;
  }

  interface RejectedControl {
    readonly code: Exclude<WorkerControlOutcomeCode, "accepted">;
    readonly message: string;
    readonly accepted: false;
    readonly attemptId?: string;
    readonly reasonCode?: WorkerRecoveryReasonCode;
  }

  type PreparedControl = AcceptedControl | RejectedControl;

  const rejectControl = (
    code: RejectedControl["code"],
    message: string,
    reasonCode?: WorkerRecoveryReasonCode,
  ): RejectedControl => ({
    code,
    message,
    accepted: false,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });

  const prepareControl = async (
    request: WorkerControlRequest,
  ): Promise<PreparedControl> => {
    if (isRecoveryCommand(request)) {
      const recoveryAction = recoveryActionFor(request);
      if (recoveryAction === undefined) {
        return rejectControl(
          "recovery_action_required",
          "A recovery action of retry or acknowledge is required.",
          "recovery_action_required",
        );
      }
      if (!serviceIsHealthy()) {
        return rejectControl(
          "service_unhealthy",
          "The worker is unhealthy and cannot perform recovery.",
          "recovery_claim_conflict",
        );
      }
      if (serviceMode === "stopping") {
        return rejectControl(
          "recovery_claim_conflict",
          "The worker is stopping and cannot perform recovery.",
          "recovery_claim_conflict",
        );
      }
      if (request.attemptId === undefined || request.attemptId.trim() === "") {
        return rejectControl(
          "recovery_target_required",
          "Recovery requires an active attempt ID.",
          "recovery_target_required",
        );
      }
      if (recoveryAction === "acknowledge") {
        const operator = operatorFor(request);
        if (operator === undefined || operator.trim() === "") {
          return rejectControl(
            "recovery_operator_required",
            "Manual-intervention acknowledgement requires an operator identity.",
            "recovery_operator_required",
          );
        }
      }

      let inspection: RecoveryInspection;
      try {
        inspection = await inspectRecoveryTarget(request.attemptId);
      } catch (error) {
        if (error instanceof WorkerRecoveryControlError) {
          return rejectControl(error.code, error.message, error.reasonCode);
        }
        return rejectControl(
          "recovery_claim_conflict",
          `Recovery state could not be inspected: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "recovery_claim_conflict",
        );
      }

      if (recoveryAction === "retry") {
        if (inspection.disposition === "safe_resume") {
          return rejectControl(
            "recovery_not_expired",
            `Recovery target ${request.attemptId} has a live unstarted claim and is safe to resume, not retry.`,
            "safe_resume",
          );
        }
        if (inspection.disposition === "manual_intervention") {
          return rejectControl(
            "recovery_manual_intervention",
            `Recovery target ${request.attemptId} may have side effects and requires manual intervention.`,
            "manual_intervention",
          );
        }
        return {
          code: "accepted",
          message: `Safe retry requested for expired claim ${request.attemptId}.`,
          accepted: true,
          action: runRecoveryCycle(request.attemptId).then(() => undefined),
          attemptId: request.attemptId,
          reasonCode: "safe_retry",
        };
      }

      if (inspection.disposition !== "manual_intervention") {
        return rejectControl(
          "recovery_acknowledgement_not_allowed",
          `Recovery target ${request.attemptId} is classified as ${inspection.disposition}; acknowledgement is only valid for manual intervention.`,
          inspection.disposition,
        );
      }
      return {
        code: "accepted",
        message: `Manual intervention acknowledged for ${request.attemptId}; retained evidence was not changed.`,
        accepted: true,
        action: Promise.resolve(),
        attemptId: request.attemptId,
        reasonCode: "manual_intervention",
      };
    }

    switch (request.command) {
      case "run-now": {
        if (!serviceIsHealthy()) {
          return rejectControl(
            "service_unhealthy",
            "The worker is unhealthy and cannot run a cycle.",
          );
        }
        if (serviceMode === "stopping") {
          return rejectControl(
            "command_failed",
            "The worker is stopping and cannot run a cycle.",
          );
        }
        let cycle: Promise<WorkerCycleResult>;
        try {
          // runCycle already coalesces concurrent calls and shares the service lock.
          cycle = runCycle();
        } catch (error) {
          return rejectControl(
            "command_failed",
            redactedOperatorText(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return {
          code: "accepted",
          message: "Worker cycle requested.",
          accepted: true,
          action: cycle.then(() => undefined),
        };
      }
      case "pause": {
        if (!serviceIsHealthy()) {
          return rejectControl(
            "service_unhealthy",
            "The worker is unhealthy and cannot be paused.",
          );
        }
        if (pauseRequested || serviceMode === "paused") {
          return rejectControl(
            "already_applied",
            "Worker polling is already paused.",
          );
        }
        if (serviceMode === "stopping") {
          return rejectControl(
            "command_failed",
            "The worker is stopping and cannot be paused.",
          );
        }
        pauseRequested = true;
        if (loopInFlight !== undefined) {
          // Only the poll wait is interrupted. An active agent invocation is
          // allowed to finish before the loop releases its service lock.
          serviceMode = "pausing";
          pollController?.abort();
        } else {
          serviceMode = "paused";
        }
        return {
          code: "accepted",
          message: "Polling will pause at the next safe boundary.",
          accepted: true,
          action: Promise.resolve(),
        };
      }
      case "resume": {
        if (!serviceIsHealthy()) {
          return rejectControl(
            "service_unhealthy",
            "The worker is unhealthy and cannot be resumed.",
          );
        }
        if (
          !pauseRequested &&
          (serviceMode === "running" || serviceMode === "starting")
        ) {
          return rejectControl(
            "already_applied",
            "Worker polling is already running.",
          );
        }
        if (serviceMode === "stopping") {
          return rejectControl(
            "command_failed",
            "The worker is stopping and cannot be resumed.",
          );
        }
        pauseRequested = false;
        if (loopInFlight !== undefined) {
          serviceMode = "running";
          const currentLoop = loopInFlight;
          void currentLoop
            .then(() => {
              // A resume racing with the pausing loop must restart only after
              // that loop has released the service lock; never overlap loops.
              if (
                !stopRequested &&
                !pauseRequested &&
                loopInFlight === undefined
              ) {
                const restarted = start();
                void restarted.catch(() => undefined);
              }
            })
            .catch(() => undefined);
          return {
            code: "accepted",
            message: "Worker polling resumed without starting another loop.",
            accepted: true,
            action: Promise.resolve(),
          };
        }
        const resumed = start();
        void resumed.catch(() => undefined);
        return {
          code: "accepted",
          message: "Worker polling resumed.",
          accepted: true,
          action: Promise.resolve(),
        };
      }
      case "cancel": {
        if (
          request.attemptId === undefined ||
          request.attemptId.trim() === ""
        ) {
          return rejectControl(
            "target_required",
            "Cancellation requires an active attempt ID.",
          );
        }
        if (
          activeAttemptId === undefined ||
          executionController === undefined
        ) {
          return rejectControl(
            "no_active_execution",
            "There is no active execution to cancel.",
          );
        }
        if (request.attemptId !== activeAttemptId) {
          return rejectControl(
            "target_mismatch",
            "The requested attempt is not the active execution.",
          );
        }
        executionController.abort(
          new WorkerServiceOperatorCancellationError(
            redactedOperatorText(
              request.reason ?? "operator requested cancellation",
            ),
          ),
        );
        return {
          code: "accepted",
          message: `Cancellation requested for attempt ${activeAttemptId}.`,
          accepted: true,
          action: Promise.resolve(),
          attemptId: activeAttemptId,
        };
      }
    }
    return rejectControl(
      "invalid_request",
      "The worker command is not supported.",
    );
  };

  type ControlReservation =
    | { readonly outcome: WorkerControlOutcome }
    | {
        readonly revision: number;
        readonly prepared: AcceptedControl;
      };
  let controlGate = Promise.resolve();
  const reserveControl = async (
    request: WorkerControlRequest,
  ): Promise<ControlReservation> => {
    let release!: () => void;
    const previous = controlGate;
    controlGate = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      if (request.expectedRevision !== revision) {
        return {
          outcome: {
            version: 1,
            commandId: request.commandId,
            command: request.command,
            code: "stale_revision",
            revision,
            message:
              "Expected worker revision is stale; no mutation was applied.",
            ...(request.attemptId === undefined
              ? {}
              : { attemptId: request.attemptId }),
            ...(isRecoveryCommand(request)
              ? { reasonCode: "recovery_stale_revision" as const }
              : {}),
          },
        };
      }
      if (typeof request.reason !== "string" || request.reason.trim() === "") {
        return {
          outcome: {
            version: 1,
            commandId: request.commandId,
            command: request.command,
            code: "reason_required",
            revision,
            message: "An operator reason is required for this command.",
            ...(isRecoveryCommand(request)
              ? { reasonCode: "recovery_invalid_request" as const }
              : {}),
          },
        };
      }
      const prepared = await prepareControl(request);
      if (!prepared.accepted) {
        return {
          outcome: {
            version: 1,
            commandId: request.commandId,
            command: request.command,
            code: prepared.code,
            revision,
            message: prepared.message,
            ...(prepared.attemptId === undefined
              ? {}
              : { attemptId: prepared.attemptId }),
            ...(prepared.reasonCode === undefined
              ? {}
              : { reasonCode: prepared.reasonCode }),
          },
        };
      }
      revision += 1;
      return { revision, prepared };
    } finally {
      release();
    }
  };

  const finishControl = async (
    request: WorkerControlRequest,
    outcome: WorkerControlOutcome,
  ): Promise<WorkerControlOutcome> => {
    await appendAudit({
      version: 1,
      kind: "outcome",
      timestamp: now(),
      commandId: request.commandId,
      command: request.command,
      expectedRevision: request.expectedRevision,
      revision: outcome.revision,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.attemptId === undefined
        ? {}
        : { attemptId: request.attemptId }),
      ...(operatorFor(request) === undefined
        ? {}
        : { operator: operatorFor(request) }),
      ...(recoveryActionFor(request) === undefined
        ? {}
        : { recoveryAction: recoveryActionFor(request) }),
      code: outcome.code,
      ...(outcome.reasonCode === undefined
        ? {}
        : { reasonCode: outcome.reasonCode }),
      message: outcome.message,
    });
    retainedOutcomes.set(request.commandId, outcome);
    return outcome;
  };

  const executeControl = async (
    request: WorkerControlRequest,
    requestedAtRevision: number,
  ): Promise<WorkerControlOutcome> => {
    if (
      request.commandId.trim() === "" ||
      request.commandId.length > 128 ||
      !Number.isInteger(request.expectedRevision) ||
      request.expectedRevision < 0
    ) {
      const outcome: WorkerControlOutcome = {
        version: 1,
        commandId: request.commandId,
        command: request.command,
        code: "invalid_request",
        revision,
        message: "Command ID and expected revision are invalid.",
        ...(isRecoveryCommand(request)
          ? { reasonCode: "recovery_invalid_request" as const }
          : {}),
      };
      return finishControl(request, outcome);
    }

    await appendAudit({
      version: 1,
      kind: "request",
      timestamp: now(),
      commandId: request.commandId,
      command: request.command,
      expectedRevision: request.expectedRevision,
      revision: requestedAtRevision,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.attemptId === undefined
        ? {}
        : { attemptId: request.attemptId }),
      ...(operatorFor(request) === undefined
        ? {}
        : { operator: operatorFor(request) }),
      ...(recoveryActionFor(request) === undefined
        ? {}
        : { recoveryAction: recoveryActionFor(request) }),
    });

    const reservation = await reserveControl(request);
    if ("outcome" in reservation) {
      return finishControl(request, reservation.outcome);
    }

    try {
      await reservation.prepared.action;
      return finishControl(request, {
        version: 1,
        commandId: request.commandId,
        command: request.command,
        code: reservation.prepared.code,
        revision: reservation.revision,
        message: reservation.prepared.message,
        ...(reservation.prepared.attemptId === undefined
          ? {}
          : { attemptId: reservation.prepared.attemptId }),
        ...(reservation.prepared.reasonCode === undefined
          ? {}
          : { reasonCode: reservation.prepared.reasonCode }),
      });
    } catch (error) {
      if (error instanceof WorkerRecoveryControlError) {
        return finishControl(request, {
          version: 1,
          commandId: request.commandId,
          command: request.command,
          code: error.code,
          revision: reservation.revision,
          message: error.message,
          ...(request.attemptId === undefined
            ? {}
            : { attemptId: request.attemptId }),
          reasonCode: error.reasonCode,
        });
      }
      const message = redactedOperatorText(
        error instanceof Error ? error.message : String(error),
      );
      return finishControl(request, {
        version: 1,
        commandId: request.commandId,
        command: request.command,
        code: "command_failed",
        revision: reservation.revision,
        message: `Worker command failed: ${message}`,
        ...(isRecoveryCommand(request)
          ? { reasonCode: "recovery_claim_conflict" as const }
          : {}),
      });
    }
  };

  const inFlightCommands = new Map<
    string,
    {
      readonly command: WorkerControlCommand;
      readonly outcome: Promise<WorkerControlOutcome>;
    }
  >();
  const command = (
    request: WorkerControlRequest,
  ): Promise<WorkerControlOutcome> => {
    const retained = retainedOutcomes.get(request.commandId);
    if (retained !== undefined) {
      if (retained.command === request.command)
        return Promise.resolve(retained);
      return Promise.resolve({
        ...retained,
        command: request.command,
        code: "command_id_conflict",
        message: "Command ID is already bound to a different command.",
        revision,
      });
    }
    const inFlight = inFlightCommands.get(request.commandId);
    if (inFlight !== undefined) {
      if (inFlight.command === request.command) return inFlight.outcome;
      return Promise.resolve({
        version: 1,
        commandId: request.commandId,
        command: request.command,
        code: "command_id_conflict" as const,
        revision,
        message: "Command ID is already bound to a different command.",
      });
    }
    const requestedAtRevision = revision;
    const outcome = executeControl(request, requestedAtRevision).finally(() => {
      const current = inFlightCommands.get(request.commandId);
      if (current?.outcome === outcome)
        inFlightCommands.delete(request.commandId);
    });
    inFlightCommands.set(request.commandId, {
      command: request.command,
      outcome,
    });
    return outcome;
  };

  const status = (): WorkerServiceStatus => ({
    mode: serviceMode,
    revision,
    pauseRequested,
    ...(activeAttemptId === undefined ? {} : { activeAttemptId }),
    ...(lastCompletedCycle === undefined ? {} : { lastCompletedCycle }),
    ...(nextExpectedCycle === undefined ? {} : { nextExpectedCycle }),
  });

  const control: WorkerServiceControl = {
    status,
    command,
    runNow: (request) => command({ ...request, command: "run-now" }),
    pause: (request) => command({ ...request, command: "pause" }),
    resume: (request) => command({ ...request, command: "resume" }),
    cancel: (request) => command({ ...request, command: "cancel" }),
    retry: (request) => command({ ...request, command: "retry" }),
    acknowledge: (request) => command({ ...request, command: "acknowledge" }),
    recover: (request) => command({ ...request, command: "recover" }),
  };

  return { runCycle, start, stop, status, control };
};
