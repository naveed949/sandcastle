import type { StandardSchemaV1 } from "@standard-schema/spec";
import { canonicalJsonDigest, sameCanonicalJson } from "./CanonicalJson.js";
import {
  digestPromptTemplate,
  normalizeRepository,
} from "./WorkerCoordinator.js";
import type {
  AuthorizationSource,
  ExecutionProfile,
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { extractStructuredOutput } from "./extractStructuredOutput.js";
import { Output } from "./Output.js";
import {
  RepositoryWorkflowStoreError,
  type RepositoryWorkflowStore,
} from "./RepositoryWorkflowControl.js";
import type { RepositoryWorkflowPlanRecord } from "./RepositoryWorkflowPlanner.js";
import type { RepositoryWorkflowImplementationRecord } from "./RepositoryWorkflowImplementer.js";
import {
  claimWorkerTask,
  WorkerClaimError,
  type ClaimTaskSource,
} from "./WorkerClaimCoordinator.js";
import type { ExecutionAttempt } from "./WorkerStateStore.js";
import type { WorkerStateStore } from "./WorkerStateStore.js";
import type { WorkerCommandEvidence } from "./WorkerRepositoryManager.js";

/** Terminal outcomes of one reviewer stage invocation. */
export type RepositoryWorkflowReviewStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * What may follow a review: the workflow may advance (approved), the same
 * claim resumes after an interruption, or remediation is exhausted and an
 * operator must intervene.
 */
export type RepositoryWorkflowReviewRecovery =
  | "terminal"
  | "resumable"
  | "manual_intervention";

/** One actionable finding produced by the reviewer. */
export interface RepositoryWorkflowReviewFinding {
  readonly severity: "blocking" | "advisory";
  readonly location: string;
  readonly finding: string;
  readonly rationale: string;
}

/** The versioned verdict content emitted by the reviewer agent. */
export interface RepositoryWorkflowReviewerOutput {
  readonly version: 1;
  readonly verdict: "approved" | "changes_requested";
  readonly findings: readonly RepositoryWorkflowReviewFinding[];
  readonly requiredActions: readonly string[];
}

export interface RepositoryWorkflowReviewAgent {
  readonly logReference?: string;
  readonly sessionId?: string;
}

export interface RepositoryWorkflowReviewError {
  readonly code: string;
  readonly message: string;
}

/** Retained result of one reviewer stage invocation. */
export interface RepositoryWorkflowReviewRecord {
  readonly id: string;
  readonly version: 1;
  readonly status: RepositoryWorkflowReviewStatus;
  readonly recovery: RepositoryWorkflowReviewRecovery;
  readonly repository: string;
  readonly workflowIdentity: string;
  readonly taskId: string;
  /** The accepted plan whose implementation is under review. */
  readonly planId: string;
  /** The verified implementation attempt this review examines. */
  readonly implementationAttemptId: string;
  readonly executionIdentity: string;
  /** Zero-based pass over the same execution identity; increments per remediation. */
  readonly remediationIteration: number;
  /** The immediately preceding review in the same remediation chain. */
  readonly priorReviewId?: string;
  readonly promptVersion: string;
  readonly promptTemplateDigest: string;
  /** Digest of the reviewed implementation diff, proving what was reviewed. */
  readonly implementationDiffDigest: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly remediationDeadlineAt?: string;
  readonly verdict?: RepositoryWorkflowReviewerOutput;
  readonly evidence: readonly string[];
  readonly agent?: RepositoryWorkflowReviewAgent;
  readonly error?: RepositoryWorkflowReviewError;
}

/** Safe Mission Control projection of one retained review record. */
export interface RepositoryWorkflowReviewProjection extends Omit<
  RepositoryWorkflowReviewRecord,
  "evidence" | "error" | "agent"
> {
  readonly evidenceCount: number;
  readonly errorCode?: string;
}

/** Input passed to the injected reviewer agent boundary. */
export interface RepositoryWorkflowReviewerInvocation {
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface RepositoryWorkflowReviewerInvocationResult {
  readonly stdout: string;
  readonly logReference?: string;
  readonly sessionId?: string;
}

/** Injectable read-only reviewer boundary; the agent never receives a repository handle. */
export type RepositoryWorkflowReviewerInvoker = (
  input: RepositoryWorkflowReviewerInvocation,
) => Promise<RepositoryWorkflowReviewerInvocationResult>;

/** Durable review persistence seam backed by the transactional workflow state. */
export interface RepositoryWorkflowReviewStore {
  save(record: RepositoryWorkflowReviewRecord): Promise<void>;
  get(id: string): Promise<RepositoryWorkflowReviewRecord | undefined>;
  list(repository?: string): Promise<readonly RepositoryWorkflowReviewRecord[]>;
}

/** Options for adapting the repository workflow store to review records. */
export interface RepositoryWorkflowReviewStoreOptions {
  readonly store: RepositoryWorkflowStore;
}

/** Create a review store backed by the same transactional state as plans. */
export const createRepositoryWorkflowReviewStore = (
  options: RepositoryWorkflowReviewStoreOptions,
): RepositoryWorkflowReviewStore => ({
  async save(record) {
    await options.store.update((state) => {
      const reviews = [...(state.reviews ?? [])];
      const existing = reviews.find((candidate) => candidate.id === record.id);
      if (existing !== undefined) {
        if (!sameCanonicalJson(existing, record)) {
          throw new RepositoryWorkflowStoreError(
            `Review record ${record.id} conflicts with persisted evidence.`,
            "conflict",
          );
        }
        return state;
      }
      reviews.push(record);
      reviews.sort((left, right) => left.id.localeCompare(right.id));
      return { ...state, reviews };
    });
  },
  async get(id) {
    return (await options.store.read()).reviews?.find(
      (record) => record.id === id,
    );
  },
  async list(repository) {
    return (
      (await options.store.read()).reviews?.filter(
        (record) =>
          repository === undefined || record.repository === repository,
      ) ?? []
    );
  },
});

/** Input for reviewing one verified implementation attempt. */
export interface RepositoryWorkflowReviewInput {
  /** The accepted plan whose implementation is under review. */
  readonly plan: RepositoryWorkflowPlanRecord;
  /** The verified implementation attempt being reviewed. */
  readonly implementationAttempt: ExecutionAttempt;
  /** The retained implementation-stage outcome for the attempt. */
  readonly implementation: RepositoryWorkflowImplementationRecord;
  /** The full diff of the implementation work; the reviewer sees text only. */
  readonly implementationDiff: string;
  /** Versioned reviewer prompt artifact. */
  readonly promptVersion: string;
  readonly promptTemplate: string;
  readonly reviewId?: string;
  readonly remediationIteration?: number;
  readonly priorReviewId?: string;
  /** Wall-clock budget deadline for the enclosing remediation loop, when present. */
  readonly remediationDeadlineAt?: string;
  readonly signal?: AbortSignal;
}

export interface RepositoryWorkflowReviewerOptions {
  readonly invoke: RepositoryWorkflowReviewerInvoker;
  readonly reviewStore?: RepositoryWorkflowReviewStore;
  readonly now?: () => string;
  readonly createId?: () => string;
  /** Maximum time spent waiting for the reviewer agent. */
  readonly timeoutMs?: number;
}

export interface RepositoryWorkflowReviewerStage {
  review(
    input: RepositoryWorkflowReviewInput,
  ): Promise<RepositoryWorkflowReviewRecord>;
}

/** Raised when reviewer inputs are missing or violate stage binding. */
export class RepositoryWorkflowReviewerContextError extends Error {
  readonly code: "missing_context" | "invalid_context";

  constructor(
    code: RepositoryWorkflowReviewerContextError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RepositoryWorkflowReviewerContextError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const outputIssue = (message: string) => ({ message });

const reviewerOutputSchema: StandardSchemaV1<
  unknown,
  RepositoryWorkflowReviewerOutput
> = {
  "~standard": {
    version: 1,
    vendor: "sandcastle",
    validate(value) {
      if (!isRecord(value)) {
        return { issues: [outputIssue("Reviewer output must be an object.")] };
      }
      const allowed = new Set([
        "version",
        "verdict",
        "findings",
        "requiredActions",
      ]);
      const unexpected = Object.keys(value).find((key) => !allowed.has(key));
      if (unexpected !== undefined) {
        return {
          issues: [
            outputIssue(`Reviewer output field ${unexpected} is not allowed.`),
          ],
        };
      }
      if (value.version !== 1) {
        return { issues: [outputIssue("Reviewer output version must be 1.")] };
      }
      if (
        value.verdict !== "approved" &&
        value.verdict !== "changes_requested"
      ) {
        return {
          issues: [
            outputIssue('verdict must be "approved" or "changes_requested".'),
          ],
        };
      }
      if (!Array.isArray(value.findings)) {
        return { issues: [outputIssue("findings must be an array.")] };
      }
      const findings: RepositoryWorkflowReviewFinding[] = [];
      for (const item of value.findings) {
        if (
          !isRecord(item) ||
          (item.severity !== "blocking" && item.severity !== "advisory") ||
          typeof item.location !== "string" ||
          item.location.trim() === "" ||
          typeof item.finding !== "string" ||
          item.finding.trim() === "" ||
          typeof item.rationale !== "string" ||
          item.rationale.trim() === ""
        ) {
          return {
            issues: [
              outputIssue(
                "Each finding requires severity, location, finding, and rationale.",
              ),
            ],
          };
        }
        findings.push({
          severity: item.severity,
          location: item.location.trim(),
          finding: item.finding.trim(),
          rationale: item.rationale.trim(),
        });
      }
      // Deterministic approval gate: an approved verdict may not carry an
      // unresolved blocking finding; the model cannot override the gate.
      if (
        value.verdict === "approved" &&
        findings.some((finding) => finding.severity === "blocking")
      ) {
        return {
          issues: [
            outputIssue(
              "An approved verdict may not contain blocking findings.",
            ),
          ],
        };
      }
      if (!Array.isArray(value.requiredActions)) {
        return { issues: [outputIssue("requiredActions must be an array.")] };
      }
      const requiredActions: string[] = [];
      for (const action of value.requiredActions) {
        if (typeof action !== "string" || action.trim() === "") {
          return {
            issues: [outputIssue("requiredActions entries must be non-empty.")],
          };
        }
        requiredActions.push(action.trim());
      }
      if (
        value.verdict === "changes_requested" &&
        requiredActions.length === 0
      ) {
        return {
          issues: [
            outputIssue(
              "changes_requested requires at least one required action.",
            ),
          ],
        };
      }
      return {
        value: {
          version: 1,
          verdict: value.verdict,
          findings,
          requiredActions,
        },
      };
    },
  },
};

const validTimestamp = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "invalid_context",
      `${name} must be a valid timestamp.`,
    );
  }
  return value;
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      `Reviewer requires ${name}.`,
    );
  }
  return value.trim();
};

/** Expand the reviewer template only from frozen, server-owned context. */
export const expandRepositoryWorkflowReviewerPrompt = (
  input: RepositoryWorkflowReviewInput,
): string => {
  validateReviewInput(input);
  const task = input.plan.input.taskSnapshot;
  const replacements: Record<string, string> = {
    TASK_SNAPSHOT: JSON.stringify(task, null, 2),
    ACCEPTED_PLAN: JSON.stringify(input.plan.plan, null, 2),
    IMPLEMENTATION_DIFF: input.implementationDiff,
    VERIFICATION_EVIDENCE: JSON.stringify(
      verificationEvidenceFor(input),
      null,
      2,
    ),
    REPOSITORY_POLICY: JSON.stringify(
      input.implementationAttempt.request.profile,
      null,
      2,
    ),
  };
  return input.promptTemplate.replace(
    /\{\{(TASK_SNAPSHOT|ACCEPTED_PLAN|IMPLEMENTATION_DIFF|VERIFICATION_EVIDENCE|REPOSITORY_POLICY)\}\}/g,
    (_match, marker: string) =>
      replacements[marker as keyof typeof replacements]!,
  );
};

const verificationEvidenceFor = (
  input: RepositoryWorkflowReviewInput,
): readonly WorkerCommandEvidence[] =>
  input.implementation.result?.verification ??
  input.implementation.verification;

const validateReviewInput = (
  input: RepositoryWorkflowReviewInput,
): {
  readonly request: ExecutionAttempt["request"];
  readonly task: NormalizedTask;
  readonly policy: ExecutionProfile;
} => {
  if (!isRecord(input)) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer input is required.",
    );
  }
  const plan = input.plan;
  if (
    !isRecord(plan) ||
    plan.status !== "accepted" ||
    plan.plan === undefined ||
    !isRecord(plan.input)
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer requires an accepted plan record.",
    );
  }
  const attempt = input.implementationAttempt;
  if (!isRecord(attempt) || !isRecord(attempt.request)) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer requires the verified implementation attempt.",
    );
  }
  const request = attempt.request;
  if (
    attempt.status !== "verified" ||
    !sameCanonicalJson(request.task, plan.input.taskSnapshot)
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "invalid_context",
      "Reviewer requires a verified attempt matching the frozen task snapshot.",
    );
  }
  if (
    normalizeRepository(plan.input.repository) !==
      normalizeRepository(request.task.repository) ||
    plan.input.taskId !== request.taskId ||
    // Remediation attempts share the plan's execution identity but carry
    // their own attempt ids; only the implementation record must name them.
    plan.input.executionIdentity !== request.executionIdentity ||
    input.implementation.attemptId !== attempt.attemptId ||
    input.implementation.planId !== plan.id ||
    input.implementation.executionIdentity !== request.executionIdentity
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "invalid_context",
      "Reviewer inputs do not describe the same implementation attempt.",
    );
  }
  if (
    !Array.isArray(verificationEvidenceFor(input)) ||
    verificationEvidenceFor(input).length === 0
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer requires retained verification evidence.",
    );
  }
  if (
    typeof input.implementationDiff !== "string" ||
    input.implementationDiff.trim() === ""
  ) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer requires the implementation diff.",
    );
  }
  if (!isRecord(request.profile)) {
    throw new RepositoryWorkflowReviewerContextError(
      "missing_context",
      "Reviewer requires the repository policy profile.",
    );
  }
  requireString(input.promptVersion, "prompt version");
  requireString(input.promptTemplate, "reviewer prompt template");
  if (!input.promptTemplate.includes("<review>")) {
    throw new RepositoryWorkflowReviewerContextError(
      "invalid_context",
      "Reviewer prompt template must instruct the <review> structured output tag.",
    );
  }
  return {
    request,
    task: plan.input.taskSnapshot,
    policy: request.profile as ExecutionProfile,
  };
};

class ReviewerCancellationError extends Error {
  readonly code = "reviewer_cancelled";

  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : "Review was cancelled.");
    this.name = "ReviewerCancellationError";
  }
}

class ReviewerTimeoutError extends Error {
  readonly code = "reviewer_timeout";

  constructor(timeoutMs: number) {
    super(`Review exceeded ${timeoutMs}ms.`);
    this.name = "ReviewerTimeoutError";
  }
}

const invokeWithControls = async (
  invoke: RepositoryWorkflowReviewerInvoker,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RepositoryWorkflowReviewerInvocationResult> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  let controlError:
    | ReviewerCancellationError
    | ReviewerTimeoutError
    | undefined;
  const abortWith = (
    error: ReviewerCancellationError | ReviewerTimeoutError,
    reason: unknown = error,
  ): ReviewerCancellationError | ReviewerTimeoutError => {
    if (controlError === undefined) {
      controlError = error;
      controller.abort(reason);
    }
    return controlError;
  };
  const cancellation = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(abortWith(new ReviewerCancellationError(signal.reason)));
      return;
    }
    if (signal !== undefined) {
      const onAbort = () => {
        reject(
          abortWith(
            new ReviewerCancellationError(signal.reason),
            signal.reason,
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
  if (signal?.aborted) {
    throw new ReviewerCancellationError(signal.reason);
  }
  const invocation = invoke({ prompt, signal: controller.signal }).then(
    (result) => {
      if (controlError !== undefined) throw controlError;
      return result;
    },
    (error) => {
      if (controlError !== undefined) throw controlError;
      throw error;
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(abortWith(new ReviewerTimeoutError(timeoutMs)));
    }, timeoutMs);
  });
  try {
    return await Promise.race([invocation, cancellation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
    void invocation.catch(() => undefined);
  }
};

const toReviewError = (
  error: unknown,
): {
  readonly code: string;
  readonly message: string;
  readonly recovery: "resumable" | "terminal";
  readonly status: "failed" | "cancelled" | "timed_out";
} => {
  if (error instanceof ReviewerCancellationError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "cancelled",
    };
  }
  if (error instanceof ReviewerTimeoutError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "timed_out",
    };
  }
  // A malformed verdict is resumable via session feedback; any other
  // reviewer failure is terminal for this invocation.
  if (error instanceof Error && error.name === "StructuredOutputError") {
    return {
      code: "invalid_structured_output",
      message: error.message,
      recovery: "resumable",
      status: "failed",
    };
  }
  if (isRecord(error) && typeof error.code === "string") {
    return {
      code: error.code,
      message: errorMessage(error),
      recovery: "terminal",
      status: "failed",
    };
  }
  return {
    code: "reviewer_invocation_failed",
    message: errorMessage(error),
    recovery: "terminal",
    status: "failed",
  };
};

/** Create a reviewer that produces one advisory verdict with no write authority. */
export const createRepositoryWorkflowReviewer = (
  options: RepositoryWorkflowReviewerOptions,
): RepositoryWorkflowReviewerStage => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("reviewer timeoutMs must be a positive finite number.");
  }

  return {
    async review(
      input: RepositoryWorkflowReviewInput,
    ): Promise<RepositoryWorkflowReviewRecord> {
      const { request } = validateReviewInput(input);
      const reviewId = requireString(input.reviewId ?? createId(), "review ID");
      const createdAt = validTimestamp(now(), "review timestamp");
      const provenance = {
        id: reviewId,
        version: 1 as const,
        repository: normalizeRepository(request.task.repository),
        workflowIdentity: input.plan.workflowIdentity,
        taskId: request.taskId,
        planId: input.plan.id,
        implementationAttemptId: input.implementationAttempt.attemptId,
        executionIdentity: request.executionIdentity,
        remediationIteration: input.remediationIteration ?? 0,
        ...(input.priorReviewId === undefined
          ? {}
          : { priorReviewId: input.priorReviewId }),
        promptVersion: input.promptVersion,
        promptTemplateDigest: digestPromptTemplate(input.promptTemplate),
        implementationDiffDigest: canonicalJsonDigest(input.implementationDiff),
        createdAt,
        completedAt: createdAt,
      };

      try {
        const prompt = expandRepositoryWorkflowReviewerPrompt(input);
        const invocation = await invokeWithControls(
          options.invoke,
          prompt,
          input.signal,
          timeoutMs,
        );
        const verdict =
          await extractStructuredOutput<RepositoryWorkflowReviewerOutput>(
            invocation.stdout,
            Output.object({ tag: "review", schema: reviewerOutputSchema }),
            {
              commits: [],
              branch: request.task.baseBranch,
              sessionId: invocation.sessionId,
            },
          );
        // Deterministic gate re-check after extraction.
        if (
          verdict.verdict === "approved" &&
          verdict.findings.some((finding) => finding.severity === "blocking")
        ) {
          throw new RepositoryWorkflowReviewerContextError(
            "invalid_context",
            "An approved verdict may not contain blocking findings.",
          );
        }
        const record: RepositoryWorkflowReviewRecord = {
          ...provenance,
          status: "completed",
          recovery: "terminal",
          completedAt: validTimestamp(now(), "review completion timestamp"),
          verdict,
          evidence: [
            `implementation:${input.implementation.result?.recordPath ?? input.implementation.attemptId}`,
            `diff:${provenance.implementationDiffDigest.slice(0, 16)}`,
            ...verificationEvidenceFor(input).map(
              (step) => `verification:${step.phase}:${step.command}`,
            ),
          ],
          ...(invocation.logReference === undefined &&
          invocation.sessionId === undefined
            ? {}
            : {
                agent: {
                  ...(invocation.logReference === undefined
                    ? {}
                    : { logReference: invocation.logReference }),
                  ...(invocation.sessionId === undefined
                    ? {}
                    : { sessionId: invocation.sessionId }),
                },
              }),
        };
        await options.reviewStore?.save(record);
        return record;
      } catch (error) {
        const failure = toReviewError(error);
        const record: RepositoryWorkflowReviewRecord = {
          ...provenance,
          status: failure.status,
          recovery: failure.recovery,
          evidence: [],
          error: { code: failure.code, message: failure.message },
        };
        await options.reviewStore?.save(record);
        return record;
      }
    },
  };
};

/** Implementation stage seam consumed by the remediation loop. */
export interface RepositoryWorkflowRemediator {
  implement(
    input: import("./RepositoryWorkflowImplementer.js").RepositoryWorkflowImplementationInput,
  ): Promise<RepositoryWorkflowImplementationRecord>;
}

/** Final outcome of one bounded review-and-remediation run. */
export type RepositoryWorkflowReviewOutcome =
  | "approved"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "manual_intervention";

export interface ReviewAndRemediateResult {
  readonly status: RepositoryWorkflowReviewOutcome;
  /** Append-only chain of review records, in invocation order. */
  readonly reviews: readonly RepositoryWorkflowReviewRecord[];
  /** Every implementation attempt traversed, including the original. */
  readonly implementationAttemptIds: readonly string[];
  readonly finalReview?: RepositoryWorkflowReviewRecord;
  readonly reasonCode?:
    | "remediation_exhausted"
    | "remediation_deadline_exceeded"
    | "remediation_claim_failed"
    | "implementation_failed"
    | "review_failed";
  readonly message?: string;
}

export interface ReviewAndRemediateOptions {
  /** The accepted plan whose verified implementation is under review. */
  readonly plan: RepositoryWorkflowPlanRecord;
  /** The verified implementation attempt produced by the implementation stage. */
  readonly attempt: ExecutionAttempt;
  /** The retained implementation-stage outcome for the original attempt. */
  readonly implementation: RepositoryWorkflowImplementationRecord;
  /** Full diff of the original implementation work; reviewer sees text only. */
  readonly implementationDiff: string;
  /** Central policy used to re-claim and re-implement during remediation. */
  readonly configuration: WorkerConfiguration;
  /** Fresh task read seam used to re-claim remediation attempts. */
  readonly source: ClaimTaskSource;
  readonly store: WorkerStateStore;
  readonly reviewer: RepositoryWorkflowReviewerStage;
  readonly implementer: RepositoryWorkflowRemediator;
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly reviewerPromptVersion: string;
  readonly reviewerPromptTemplate: string;
  /** Maximum number of re-implementation passes; default 3. */
  readonly maxRemediationIterations?: number;
  /** Wall-clock budget across the whole loop; exhausted budgets require an operator. */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Review one verified implementation and run a bounded remediation loop:
 * changes requested trigger exactly one fresh claim plus implementation per
 * iteration; exhaustion of iterations or the time budget enters manual
 * intervention instead of approving.
 */
export const reviewAndRemediate = async (
  options: ReviewAndRemediateOptions,
): Promise<ReviewAndRemediateResult> => {
  const maxRemediations = options.maxRemediationIterations ?? 3;
  if (!Number.isInteger(maxRemediations) || maxRemediations < 0) {
    throw new Error("maxRemediationIterations must be a non-negative integer.");
  }
  const deadlineAt =
    options.deadlineMs === undefined
      ? undefined
      : new Date(Date.now() + options.deadlineMs).toISOString();

  const reviews: RepositoryWorkflowReviewRecord[] = [];
  const implementationAttemptIds = [options.attempt.attemptId];
  let currentAttempt = options.attempt;
  let currentImplementation = options.implementation;
  let currentDiff = options.implementationDiff;
  let priorReviewId: string | undefined;
  let iteration = 0;

  for (;;) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        reviews,
        implementationAttemptIds,
        ...(priorReviewId === undefined ? {} : { finalReview: reviews.at(-1) }),
        reasonCode: undefined,
        message: "Review and remediation was cancelled by the operator.",
      };
    }
    const review = await options.reviewer.review({
      plan: options.plan,
      implementationAttempt: currentAttempt,
      implementation: currentImplementation,
      implementationDiff: currentDiff,
      promptVersion: options.reviewerPromptVersion,
      promptTemplate: options.reviewerPromptTemplate,
      remediationIteration: iteration,
      ...(priorReviewId === undefined ? {} : { priorReviewId }),
      ...(deadlineAt === undefined
        ? {}
        : { remediationDeadlineAt: deadlineAt }),
      signal: options.signal,
    });
    reviews.push(review);

    if (
      review.status === "completed" &&
      review.verdict?.verdict === "approved"
    ) {
      return {
        status: "approved",
        reviews,
        implementationAttemptIds,
        finalReview: review,
      };
    }
    if (review.status !== "completed") {
      // Cancelled, timed out, or malformed reviews never approve work.
      return {
        status:
          review.status === "cancelled"
            ? "cancelled"
            : review.status === "timed_out"
              ? "timed_out"
              : "failed",
        reviews,
        implementationAttemptIds,
        finalReview: review,
        reasonCode: "review_failed",
        message: review.error?.message,
      };
    }

    // Changes requested: decide whether another bounded remediation may run.
    if (iteration >= maxRemediations) {
      return {
        status: "manual_intervention",
        reviews,
        implementationAttemptIds,
        finalReview: review,
        reasonCode: "remediation_exhausted",
        message: `Remediation exhausted after ${iteration} iteration(s); operator review required.`,
      };
    }
    if (deadlineAt !== undefined && Date.now() >= Date.parse(deadlineAt)) {
      return {
        status: "manual_intervention",
        reviews,
        implementationAttemptIds,
        finalReview: review,
        reasonCode: "remediation_deadline_exceeded",
        message: `Remediation exceeded its ${options.deadlineMs}ms budget; operator review required.`,
      };
    }

    let remediationAttempt: ExecutionAttempt;
    try {
      // Explicit retry identity: one stable attempt id per remediation
      // iteration keeps the append-only attempt history unambiguous.
      remediationAttempt = await claimWorkerTask({
        source: options.source,
        store: options.store,
        configuration: options.configuration,
        request: currentAttempt.request,
        owner: options.owner,
        leaseDurationMs: options.leaseDurationMs,
        attemptId: `${currentAttempt.request.executionIdentity}-remediation-${iteration + 1}`,
      });
    } catch (error) {
      return {
        status:
          error instanceof WorkerClaimError ? "failed" : "manual_intervention",
        reviews,
        implementationAttemptIds,
        finalReview: review,
        reasonCode: "remediation_claim_failed",
        message: errorMessage(error),
      };
    }
    implementationAttemptIds.push(remediationAttempt.attemptId);
    const remediated = await options.implementer.implement({
      plan: options.plan,
      attempt: remediationAttempt,
      signal: options.signal,
    });
    if (remediated.status !== "verified") {
      return {
        status:
          remediated.status === "cancelled"
            ? "cancelled"
            : remediated.status === "timed_out"
              ? "timed_out"
              : "failed",
        reviews,
        implementationAttemptIds,
        ...(priorReviewId === undefined ? {} : { finalReview: reviews.at(-1) }),
        reasonCode: "implementation_failed",
        message: remediated.message,
      };
    }

    // Review the durably verified attempt state, not the claimed snapshot.
    const persisted = (await options.store.read()).attempts.find(
      (candidate) => candidate.attemptId === remediationAttempt.attemptId,
    );
    if (
      persisted === undefined ||
      persisted.status !== "verified" ||
      !sameCanonicalJson(persisted.request.task, currentAttempt.request.task)
    ) {
      return {
        status: "failed",
        reviews,
        implementationAttemptIds,
        ...(priorReviewId === undefined ? {} : { finalReview: reviews.at(-1) }),
        reasonCode: "implementation_failed",
        message: `Remediation attempt ${remediationAttempt.attemptId} did not reach a consistent verified state.`,
      };
    }
    currentAttempt = persisted;
    currentImplementation = remediated;
    iteration += 1;
    priorReviewId = review.id;
  }
};
