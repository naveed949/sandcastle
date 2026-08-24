import type {
  WorkerExecutionEngine,
  WorkerExecutionFailurePhase,
  WorkerExecutionResult,
} from "./WorkerExecutionEngine.js";
import type { WorkerCommandEvidence } from "./WorkerRepositoryManager.js";
import type { ExecutionAttempt, WorkerStateStore } from "./WorkerStateStore.js";
import { normalizeRepository } from "./WorkerCoordinator.js";
import type { RepositoryWorkflowPlanRecord } from "./RepositoryWorkflowPlanner.js";

/** Terminal outcomes of one implementation stage attempt. */
export type RepositoryWorkflowImplementationStatus =
  | "verified"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

/**
 * What may follow a finished implementation attempt: the same claim resumes
 * after an interruption, a fresh claim retries a classified failure, or the
 * stage is complete.
 */
export type RepositoryWorkflowImplementationRecovery =
  | "resumable"
  | "retryable"
  | "terminal";

/** Classified reason codes retained with non-verified implementation records. */
export type RepositoryWorkflowImplementationReasonCode =
  | "stale_task_revision"
  | "base_drift"
  | "attempt_already_started"
  | "stage_timeout"
  | "stage_cancelled"
  | "execution_failed";

/** Raised when implementation inputs are missing or violate plan/claim binding. */
export class RepositoryWorkflowImplementerContextError extends Error {
  readonly code: "missing_context" | "invalid_context";

  constructor(
    code: RepositoryWorkflowImplementerContextError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RepositoryWorkflowImplementerContextError";
    this.code = code;
  }
}

/** Input for executing one accepted plan against its still-claimed task. */
export interface RepositoryWorkflowImplementationInput {
  /** The accepted planner record whose provenance binds execution. */
  readonly plan: RepositoryWorkflowPlanRecord;
  /** The active unstarted claim that produced the plan. */
  readonly attempt: ExecutionAttempt;
  /** Operator cancellation propagated to every subprocess. */
  readonly signal?: AbortSignal;
}

export interface RepositoryWorkflowImplementerOptions {
  /** Evidence-gated execution engine that owns isolation and verification. */
  readonly engine: WorkerExecutionEngine;
  /** Durable attempt lifecycle boundary used for crash-safe re-entry. */
  readonly store: WorkerStateStore;
  /** Maximum time spent executing one accepted plan. */
  readonly timeoutMs?: number;
}

/** Retained outcome of one implementation stage invocation. */
export interface RepositoryWorkflowImplementationRecord {
  readonly planId: string;
  readonly workflowIdentity: string;
  readonly repository: string;
  readonly taskId: string;
  readonly executionIdentity: string;
  readonly attemptId: string;
  readonly status: RepositoryWorkflowImplementationStatus;
  readonly recovery: RepositoryWorkflowImplementationRecovery;
  readonly reasonCode?: RepositoryWorkflowImplementationReasonCode;
  readonly message?: string;
  readonly failurePhase?: WorkerExecutionFailurePhase;
  /** Structured verification evidence with duration and bounded output. */
  readonly verification: readonly WorkerCommandEvidence[];
  /** Durable engine result, when execution was attempted. */
  readonly result?: WorkerExecutionResult;
  /** Terminal status recorded in the durable worker state. */
  readonly attemptStatus?: "verified" | "failed" | "interrupted";
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireContext = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new RepositoryWorkflowImplementerContextError(
      "missing_context",
      message,
    );
  }
};

const validateBinding = (
  input: RepositoryWorkflowImplementationInput,
): { readonly request: ExecutionAttempt["request"] } => {
  requireContext(
    isRecord(input.plan),
    "Implementation requires an accepted plan record.",
  );
  const plan = input.plan;
  requireContext(
    plan.version === 1 && plan.status === "accepted" && plan.plan !== undefined,
    `Plan ${plan?.id ?? "unknown"} is not accepted; implementation cannot proceed.`,
  );
  const attempt = input.attempt;
  requireContext(
    isRecord(attempt) && attempt.status === "active" && isRecord(attempt.claim),
    "Implementation requires an active claimed attempt.",
  );
  const request = attempt.request;
  requireContext(
    isRecord(request) && isRecord(request.task),
    "Implementation requires the claimed execution request.",
  );
  const input_ = plan.input;
  if (
    normalizeRepository(input_.repository) !==
      normalizeRepository(request.task.repository) ||
    input_.taskId !== request.taskId ||
    input_.attemptId !== attempt.attemptId ||
    input_.executionIdentity !== attempt.executionIdentity ||
    input_.executionIdentity !== request.executionIdentity ||
    input_.profileId !== request.profileId ||
    input_.profileDigest !== request.profileDigest
  ) {
    throw new RepositoryWorkflowImplementerContextError(
      "invalid_context",
      `Plan ${plan.id} does not bind execution ${request.taskId} to its claimed identity.`,
    );
  }
  return { request };
};

const classifyDrift = (
  input: RepositoryWorkflowImplementationInput,
  request: ExecutionAttempt["request"],
):
  | {
      readonly status: "failed";
      readonly recovery: "retryable";
      readonly reasonCode: "stale_task_revision" | "base_drift";
      readonly message: string;
    }
  | undefined => {
  if (request.task.sourceRevision !== input.plan.input.taskSourceRevision) {
    return {
      status: "failed",
      recovery: "retryable",
      reasonCode: "stale_task_revision",
      message: `Task ${request.taskId} moved from frozen revision ${input.plan.input.taskSourceRevision} to ${request.task.sourceRevision}; a fresh planning cycle is required.`,
    };
  }
  if (request.task.baseCommit !== input.plan.input.baseRevision) {
    return {
      status: "failed",
      recovery: "retryable",
      reasonCode: "base_drift",
      message: `Task ${request.taskId} base moved from captured commit ${input.plan.input.baseRevision} to ${request.task.baseCommit}; re-planning is required.`,
    };
  }
  return undefined;
};

/** Create an implementation stage that executes exactly one accepted plan. */
export const createRepositoryWorkflowImplementer = (
  options: RepositoryWorkflowImplementerOptions,
): {
  implement(
    input: RepositoryWorkflowImplementationInput,
  ): Promise<RepositoryWorkflowImplementationRecord>;
} => {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("implementer timeoutMs must be a positive finite number.");
  }

  return {
    async implement(
      input: RepositoryWorkflowImplementationInput,
    ): Promise<RepositoryWorkflowImplementationRecord> {
      const { plan, attempt } = input;
      const { request } = validateBinding(input);
      const identity = {
        planId: plan.id,
        workflowIdentity: plan.workflowIdentity,
        repository: normalizeRepository(request.task.repository),
        taskId: request.taskId,
        executionIdentity: request.executionIdentity,
        attemptId: attempt.attemptId,
      };

      // Reconcile with durable state: a crashed run may have marked the
      // attempt started after this process observed it as merely claimed.
      const durableAttempt = (await options.store.read()).attempts.find(
        (candidate) => candidate.attemptId === attempt.attemptId,
      );
      if (
        durableAttempt === undefined ||
        durableAttempt.claim === undefined ||
        durableAttempt.status !== "active" ||
        durableAttempt.request.taskId !== request.taskId
      ) {
        throw new RepositoryWorkflowImplementerContextError(
          "missing_context",
          `Attempt ${attempt.attemptId} is no longer an active durable claim.`,
        );
      }

      // A started claim means side effects may already exist from a crashed
      // run. Re-executing would duplicate work; lease recovery owns resume.
      if (durableAttempt.claim!.phase === "started") {
        return {
          ...identity,
          status: "interrupted",
          recovery: "resumable",
          reasonCode: "attempt_already_started",
          message: `Attempt ${attempt.attemptId} was already started by another process; recover through lease expiry before retrying.`,
          verification: [],
        };
      }

      const drift = classifyDrift(input, request);
      if (drift !== undefined) {
        return {
          ...identity,
          status: drift.status,
          recovery: drift.recovery,
          reasonCode: drift.reasonCode,
          message: drift.message,
          verification: [],
        };
      }

      requireContext(
        typeof request.promptTemplate === "string" &&
          request.promptTemplate.includes("{{ACCEPTED_PLAN}}"),
        "Implementer prompt template must reference the {{ACCEPTED_PLAN}} marker.",
      );

      // Stage-owned controls: operator cancellation and the stage deadline
      // both reach the agent and command subprocesses through one signal.
      const controller = new AbortController();
      let timedOut = false;
      let cancelled = false;
      const forwardCancel = () => {
        cancelled = true;
        controller.abort(input.signal?.reason);
      };
      if (input.signal?.aborted) {
        forwardCancel();
      } else {
        input.signal?.addEventListener("abort", forwardCancel, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Implementation exceeded ${timeoutMs}ms.`));
      }, timeoutMs);
      try {
        const result = await options.engine.execute(durableAttempt, {
          signal: controller.signal,
          acceptedPlan: plan.plan,
        });
        const verified = result.status === "verified";
        let status: RepositoryWorkflowImplementationStatus;
        let recovery: RepositoryWorkflowImplementationRecovery;
        let reasonCode: RepositoryWorkflowImplementationReasonCode | undefined;
        let message: string | undefined;
        if (verified) {
          status = "verified";
          recovery = "terminal";
        } else if (timedOut || cancelled) {
          status = timedOut ? "timed_out" : "cancelled";
          recovery = "resumable";
          reasonCode = timedOut ? "stage_timeout" : "stage_cancelled";
          message = timedOut
            ? `Implementation of ${request.taskId} exceeded ${timeoutMs}ms and will resume through lease recovery.`
            : `Implementation of ${request.taskId} was cancelled by the operator.`;
        } else {
          status = result.status === "interrupted" ? "interrupted" : "failed";
          recovery =
            result.status === "interrupted" ? "resumable" : "retryable";
          reasonCode = "execution_failed";
          message = result.error;
        }
        return {
          ...identity,
          status,
          recovery,
          ...(reasonCode === undefined ? {} : { reasonCode }),
          ...(message === undefined ? {} : { message }),
          ...(result.failurePhase === undefined
            ? {}
            : { failurePhase: result.failurePhase }),
          verification: result.verification,
          result,
          attemptStatus: verified
            ? ("verified" as const)
            : (result.status as "failed" | "interrupted"),
        };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", forwardCancel);
      }
    },
  };
};
