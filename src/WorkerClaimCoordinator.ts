import {
  runWorkerDryRun,
  type ExecutionRequest,
  type NormalizedTask,
  type TaskReference,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type {
  ClaimAttemptOptions,
  ExecutionAttempt,
  WorkerStateStore,
} from "./WorkerStateStore.js";

/** Source seam used to freshly re-read a task immediately before claiming. */
export interface ClaimTaskReadResult {
  /** Fresh snapshot of the candidate being claimed. */
  readonly task: NormalizedTask;
  /** Fresh blocker and PRD snapshots required to re-evaluate eligibility. */
  readonly relatedTasks: readonly NormalizedTask[];
}

/** Source seam used to freshly re-read a task immediately before claiming. */
export interface ClaimTaskSource {
  read(input: {
    readonly configuration: WorkerConfiguration;
    readonly task: TaskReference;
    /** PRD references already bound to the immutable execution request. */
    readonly prdReferences?: readonly TaskReference[];
  }): Promise<ClaimTaskReadResult | undefined>;
}

/** Inputs for a guarded, revision-bound task claim. */
export interface ClaimWorkerTaskInput extends ClaimAttemptOptions {
  readonly source: ClaimTaskSource;
  readonly store: WorkerStateStore;
  readonly configuration: WorkerConfiguration;
  readonly request: ExecutionRequest;
}

/** Stable claim failures that callers must handle before execution begins. */
export type WorkerClaimErrorCode =
  | "task_unavailable"
  | "stale_revision"
  | "ineligible"
  | "identity_mismatch";

/** A guarded claim failure; no attempt has been persisted when this is thrown. */
export class WorkerClaimError extends Error {
  readonly code: WorkerClaimErrorCode;

  constructor(message: string, code: WorkerClaimErrorCode) {
    super(message);
    this.name = "WorkerClaimError";
    this.code = code;
  }
}

/** Re-read, re-authorize, and atomically lease one task before execution. */
export const claimWorkerTask = async ({
  source,
  store,
  configuration,
  request,
  owner,
  leaseDurationMs,
  claimedAt,
  attemptId,
}: ClaimWorkerTaskInput): Promise<ExecutionAttempt> => {
  const freshRead = await source.read({
    configuration,
    task: request.task,
    ...(request.context.parentPrd === undefined
      ? {}
      : { prdReferences: [request.context.parentPrd] }),
  });
  if (freshRead === undefined) {
    throw new WorkerClaimError(
      `Task ${request.taskId} was unavailable at claim time.`,
      "task_unavailable",
    );
  }
  const freshTask = freshRead.task;
  if (freshTask.sourceRevision !== request.task.sourceRevision) {
    throw new WorkerClaimError(
      `Task ${request.taskId} changed from source revision ${request.task.sourceRevision} to ${freshTask.sourceRevision}.`,
      "stale_revision",
    );
  }

  const refreshed = runWorkerDryRun({
    configuration,
    tasks: [freshTask, ...freshRead.relatedTasks],
  });
  const decision = refreshed.decisions.find(
    (candidate) => candidate.taskId === request.taskId,
  );
  const freshRequest = refreshed.executionRequests.find(
    (candidate) => candidate.taskId === request.taskId,
  );
  if (
    decision === undefined ||
    !decision.eligible ||
    freshRequest === undefined
  ) {
    throw new WorkerClaimError(
      `Task ${request.taskId} is no longer eligible${decision === undefined ? "" : `: ${decision.reasonCode}`}.`,
      "ineligible",
    );
  }
  if (freshRequest.executionIdentity !== request.executionIdentity) {
    throw new WorkerClaimError(
      `Task ${request.taskId} no longer matches execution identity ${request.executionIdentity}.`,
      "identity_mismatch",
    );
  }

  return store.claimAttempt(freshRequest, {
    owner,
    leaseDurationMs,
    refreshedSnapshots: [freshTask, ...freshRead.relatedTasks],
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(attemptId === undefined ? {} : { attemptId }),
  });
};
