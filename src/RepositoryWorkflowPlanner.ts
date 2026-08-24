import type { StandardSchemaV1 } from "@standard-schema/spec";
import { canonicalJsonDigest } from "./CanonicalJson.js";
import {
  digestPromptTemplate,
  normalizeRepository,
  runWorkerDryRun,
  workerTaskId,
} from "./WorkerCoordinator.js";
import type {
  AuthorizationSource,
  EligibilityDecision,
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
import { claimWorkerTask } from "./WorkerClaimCoordinator.js";
import type {
  GitHubTaskDiscoveryInput,
  GitHubTaskSource,
} from "./GitHubTaskSource.js";
import type { ExecutionAttempt } from "./WorkerStateStore.js";
import type { WorkerStateStore } from "./WorkerStateStore.js";

/** The only terminal states a planner stage can record. */
export type RepositoryWorkflowPlanStatus =
  | "accepted"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Recovery policy for a planner outcome. Planning has no implementation side effect. */
export type RepositoryWorkflowPlanRecovery = "resumable" | "terminal";

/** Evidence about one authoritative dependency snapshot supplied to the planner. */
export interface RepositoryWorkflowDependencyEvidence {
  readonly taskId: string;
  readonly repository: string;
  readonly kind: "issue" | "prd";
  readonly number: number;
  readonly sourceRevision: string;
  readonly state: NormalizedTask["state"] | "unavailable";
  readonly satisfied: boolean;
}

/** One evidence reference retained with a structured plan. */
export interface RepositoryWorkflowPlanEvidence {
  readonly source: "system" | "planner";
  readonly kind: string;
  readonly reference: string;
  readonly summary: string;
}

/** The versioned content emitted by the planner agent. */
export interface RepositoryWorkflowPlannerOutput {
  readonly version: 1;
  readonly taskIntent: string;
  readonly proposedWork: readonly string[];
  readonly verificationStrategy: readonly string[];
  readonly risks: readonly string[];
  readonly evidence: readonly Omit<RepositoryWorkflowPlanEvidence, "source">[];
  readonly needsHumanClarification: boolean;
}

/** The accepted plan after server-owned repository context is attached. */
export interface RepositoryWorkflowPlan extends RepositoryWorkflowPlannerOutput {
  readonly repositoryContext: {
    readonly repository: string;
    readonly baseBranch: string;
    readonly baseRevision: string;
    readonly profileId: string;
    readonly profileDigest: string;
  };
}

/** Immutable planner input provenance retained for later stages and inspection. */
export interface RepositoryWorkflowPlanInput {
  readonly repository: string;
  readonly workflowIdentity: string;
  readonly runId?: string;
  readonly cycle: number;
  readonly workflowRevision: number;
  readonly queuePosition?: number;
  readonly mergePolicyDigest?: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionIdentity: string;
  readonly taskSourceRevision: string;
  readonly baseBranch: string;
  readonly baseRevision: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly promptVersion: string;
  readonly promptTemplateDigest: string;
  readonly authorization: AuthorizationSource;
  readonly eligibilityReasonCode: "eligible";
  readonly dependencyOrder: readonly string[];
  readonly dependencyEvidence: readonly RepositoryWorkflowDependencyEvidence[];
  /** Full immutable task snapshot retained outside the public projection. */
  readonly taskSnapshot: NormalizedTask;
  /** Full centrally selected profile retained outside the public projection. */
  readonly repositoryProfile: ExecutionProfile;
}

/** Retained result of one planner stage attempt. */
export interface RepositoryWorkflowPlanRecord {
  readonly id: string;
  readonly version: 1;
  readonly status: RepositoryWorkflowPlanStatus;
  readonly recovery: RepositoryWorkflowPlanRecovery;
  readonly repository: string;
  readonly workflowIdentity: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionIdentity: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly input: RepositoryWorkflowPlanInput;
  readonly plan?: RepositoryWorkflowPlan;
  readonly evidence: readonly RepositoryWorkflowPlanEvidence[];
  readonly agent?: {
    readonly logReference?: string;
    readonly sessionId?: string;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/** Safe Mission Control projection of one retained planner attempt. */
export interface RepositoryWorkflowPlanProjection {
  readonly id: string;
  readonly version: 1;
  readonly status: RepositoryWorkflowPlanStatus;
  readonly recovery: RepositoryWorkflowPlanRecovery;
  readonly repository: string;
  readonly workflowIdentity: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionIdentity: string;
  readonly cycle: number;
  readonly workflowRevision: number;
  readonly queuePosition?: number;
  readonly taskSourceRevision: string;
  readonly baseBranch: string;
  readonly baseRevision: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly promptVersion: string;
  readonly promptTemplateDigest: string;
  readonly authorization: AuthorizationSource;
  readonly eligibilityReasonCode: "eligible";
  readonly dependencyOrder: readonly string[];
  readonly dependencyEvidence: readonly RepositoryWorkflowDependencyEvidence[];
  readonly createdAt: string;
  readonly completedAt: string;
  readonly plan?: RepositoryWorkflowPlan;
  readonly evidence: readonly RepositoryWorkflowPlanEvidence[];
  readonly errorCode?: string;
}

/** Input passed to the injected planner agent boundary. */
export interface RepositoryWorkflowPlannerInvocation {
  readonly prompt: string;
  readonly signal: AbortSignal;
}

/** Output captured from a planner agent without granting it orchestration authority. */
export interface RepositoryWorkflowPlannerInvocationResult {
  readonly stdout: string;
  readonly logReference?: string;
  readonly sessionId?: string;
}

/** Injectable agent boundary used by deterministic planner tests and production adapters. */
export type RepositoryWorkflowPlannerInvoker = (
  input: RepositoryWorkflowPlannerInvocation,
) => Promise<RepositoryWorkflowPlannerInvocationResult>;

/** Durable plan persistence seam. */
export interface RepositoryWorkflowPlanStore {
  save(record: RepositoryWorkflowPlanRecord): Promise<void>;
  get(id: string): Promise<RepositoryWorkflowPlanRecord | undefined>;
  list(repository?: string): Promise<readonly RepositoryWorkflowPlanRecord[]>;
}

/** Options for adapting the repository workflow store to planner records. */
export interface RepositoryWorkflowPlanStoreOptions {
  readonly store: RepositoryWorkflowStore;
}

/** Create a plan store backed by the same transactional state as workflow claims. */
export const createRepositoryWorkflowPlanStore = (
  options: RepositoryWorkflowPlanStoreOptions,
): RepositoryWorkflowPlanStore => ({
  async save(record) {
    await options.store.update((state) => {
      const plans = [...(state.plans ?? [])];
      const existing = plans.find((candidate) => candidate.id === record.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new RepositoryWorkflowStoreError(
            `Planner record ${record.id} conflicts with persisted evidence.`,
            "conflict",
          );
        }
        return state;
      }
      plans.push(record);
      plans.sort((left, right) => left.id.localeCompare(right.id));
      return { ...state, plans };
    });
  },
  async get(id) {
    return (await options.store.read()).plans?.find(
      (record) => record.id === id,
    );
  },
  async list(repository) {
    return (
      (await options.store.read()).plans?.filter(
        (record) =>
          repository === undefined || record.repository === repository,
      ) ?? []
    );
  },
});

/** Context required to plan one already claimed eligible task. */
export interface RepositoryWorkflowPlanningInput {
  /** Repository identity held by the scheduler claim. */
  readonly repository: string;
  readonly repositoryWorkflow: {
    readonly workflowIdentity: string;
    readonly runId?: string;
    readonly cycle: number;
    readonly revision: number;
    readonly queuePosition?: number;
    readonly mergePolicyDigest?: string;
  };
  /** The worker claim must still be unstarted: planning cannot implement work. */
  readonly attempt: ExecutionAttempt;
  /** Immutable task snapshot supplied by the deterministic worker claim. */
  readonly taskSnapshot: NormalizedTask;
  /** Eligibility is observed from the deterministic worker policy, never inferred by the agent. */
  readonly eligibility: EligibilityDecision;
  /** Fresh blocker/PRD evidence; omitted only when the task has no relationships. */
  readonly dependencyEvidence?: readonly RepositoryWorkflowDependencyEvidence[];
  /** Versioned planner prompt artifact. */
  readonly promptVersion: string;
  readonly promptTemplate: string;
  readonly planId?: string;
  readonly signal?: AbortSignal;
}

/** Options for the single-task structured planner. */
export interface RepositoryWorkflowPlannerOptions {
  readonly invoke: RepositoryWorkflowPlannerInvoker;
  readonly planStore: RepositoryWorkflowPlanStore;
  readonly now?: () => string;
  readonly createId?: () => string;
  /** Maximum time spent waiting for the planner agent. */
  readonly timeoutMs?: number;
}

/** Public stage seam returned by the structured planner factory. */
export interface RepositoryWorkflowPlannerStage {
  plan(
    input: RepositoryWorkflowPlanningInput,
  ): Promise<RepositoryWorkflowPlanRecord>;
}

/** Inputs for selecting and claiming exactly one eligible task before planning. */
export interface PlanOneEligibleTaskOptions {
  readonly repository: string;
  readonly repositoryWorkflow: RepositoryWorkflowPlanningInput["repositoryWorkflow"];
  readonly configuration: WorkerConfiguration;
  readonly source: Pick<GitHubTaskSource, "discover" | "read">;
  readonly store: WorkerStateStore;
  readonly planner: RepositoryWorkflowPlannerStage;
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly discovery?: Omit<GitHubTaskDiscoveryInput, "configuration">;
  readonly promptVersion: string;
  readonly promptTemplate: string;
  readonly signal?: AbortSignal;
}

/** Result of one deterministic eligible-task selection and planner dispatch. */
export interface PlanOneEligibleTaskResult {
  readonly status: "planned" | "no_eligible_task";
  readonly decision?: EligibilityDecision;
  readonly attempt?: ExecutionAttempt;
  readonly record?: RepositoryWorkflowPlanRecord;
}

/** Raised when planner inputs are missing or would cross an authority boundary. */
export class RepositoryWorkflowPlannerContextError extends Error {
  readonly code:
    | "missing_context"
    | "invalid_context"
    | "ineligible_task"
    | "claim_not_available";

  constructor(
    code: RepositoryWorkflowPlannerContextError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RepositoryWorkflowPlannerContextError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const validTimestamp = (value: unknown, name: string): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      `${name} must be a valid timestamp.`,
    );
  }
  return value;
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      `Planner requires ${name}.`,
    );
  }
  return value.trim();
};

const requirePositiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      `${name} must be a positive integer.`,
    );
  }
  return value;
};

const profileDigestFor = (profile: unknown): string | undefined => {
  if (
    !isRecord(profile) ||
    Object.keys(profile).some(
      (key) => key !== "setupCommands" && key !== "verificationCommands",
    ) ||
    !Array.isArray(profile.setupCommands) ||
    !Array.isArray(profile.verificationCommands) ||
    !profile.setupCommands.every(
      (command) => typeof command === "string" && command.trim().length > 0,
    ) ||
    profile.verificationCommands.length === 0 ||
    !profile.verificationCommands.every(
      (command) => typeof command === "string" && command.trim().length > 0,
    )
  ) {
    return undefined;
  }
  return canonicalJsonDigest({
    setupCommands: profile.setupCommands,
    verificationCommands: profile.verificationCommands,
  });
};

const outputIssue = (message: string) => ({ message });

const stringArray = (
  value: unknown,
  minimum: number,
): readonly string[] | undefined => {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    return undefined;
  }
  return value.map((item) => (item as string).trim());
};

const plannerOutputSchema: StandardSchemaV1<
  unknown,
  RepositoryWorkflowPlannerOutput
> = {
  "~standard": {
    version: 1,
    vendor: "sandcastle",
    validate(value) {
      if (!isRecord(value)) {
        return { issues: [outputIssue("Planner output must be an object.")] };
      }
      const allowed = new Set([
        "version",
        "taskIntent",
        "proposedWork",
        "verificationStrategy",
        "risks",
        "evidence",
        "needsHumanClarification",
      ]);
      const unexpected = Object.keys(value).find((key) => !allowed.has(key));
      if (unexpected !== undefined) {
        return {
          issues: [
            outputIssue(
              `Planner output field ${unexpected} is not allowed to change workflow authority.`,
            ),
          ],
        };
      }
      if (value.version !== 1) {
        return { issues: [outputIssue("Planner output version must be 1.")] };
      }
      if (
        typeof value.taskIntent !== "string" ||
        value.taskIntent.trim() === ""
      ) {
        return { issues: [outputIssue("taskIntent must be non-empty.")] };
      }
      const proposedWork = stringArray(value.proposedWork, 1);
      if (proposedWork === undefined) {
        return {
          issues: [outputIssue("proposedWork must contain a non-empty item.")],
        };
      }
      const verificationStrategy = stringArray(value.verificationStrategy, 1);
      if (verificationStrategy === undefined) {
        return {
          issues: [
            outputIssue("verificationStrategy must contain a non-empty item."),
          ],
        };
      }
      const risks = stringArray(value.risks, 0);
      if (risks === undefined) {
        return { issues: [outputIssue("risks must be a string array.")] };
      }
      if (!Array.isArray(value.evidence)) {
        return { issues: [outputIssue("evidence must be an array.")] };
      }
      const evidence: Omit<RepositoryWorkflowPlanEvidence, "source">[] = [];
      for (const item of value.evidence) {
        if (
          !isRecord(item) ||
          typeof item.kind !== "string" ||
          item.kind.trim() === "" ||
          typeof item.reference !== "string" ||
          item.reference.trim() === "" ||
          typeof item.summary !== "string" ||
          item.summary.trim() === ""
        ) {
          return {
            issues: [
              outputIssue(
                "Each evidence item requires kind, reference, and summary.",
              ),
            ],
          };
        }
        evidence.push({
          kind: item.kind.trim(),
          reference: item.reference.trim(),
          summary: item.summary.trim(),
        });
      }
      if (typeof value.needsHumanClarification !== "boolean") {
        return {
          issues: [outputIssue("needsHumanClarification must be a boolean.")],
        };
      }
      return {
        value: {
          version: 1,
          taskIntent: value.taskIntent.trim(),
          proposedWork,
          verificationStrategy,
          risks,
          evidence,
          needsHumanClarification: value.needsHumanClarification,
        },
      };
    },
  },
};

const normalizeDependencyEvidence = (
  task: NormalizedTask,
  attempt: ExecutionAttempt,
  supplied: readonly RepositoryWorkflowDependencyEvidence[] | undefined,
): readonly RepositoryWorkflowDependencyEvidence[] => {
  const references = [
    ...task.dependencies,
    ...(task.parentPrd === undefined ? [] : [task.parentPrd]),
  ];
  const uniqueReferences = [
    ...new Map(
      references.map((reference) => [workerTaskId(reference), reference]),
    ).values(),
  ];
  const snapshots = new Map(
    (attempt.claim?.refreshedSnapshots ?? []).map((snapshot) => [
      workerTaskId(snapshot),
      snapshot,
    ]),
  );

  const evidenceFor = (
    reference: NormalizedTask["dependencies"][number],
  ): RepositoryWorkflowDependencyEvidence => {
    const id = workerTaskId(reference);
    const snapshot = snapshots.get(id);
    if (snapshot === undefined) {
      throw new RepositoryWorkflowPlannerContextError(
        "missing_context",
        `Planner is missing claim-time dependency evidence for ${id}.`,
      );
    }
    return {
      taskId: id,
      repository: reference.repository,
      kind: reference.kind,
      number: reference.number,
      sourceRevision: snapshot.sourceRevision,
      state: snapshot.state,
      satisfied: snapshot.state === "closed" || snapshot.state === "completed",
    };
  };

  if (supplied !== undefined) {
    if (supplied.length !== uniqueReferences.length) {
      throw new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner dependency evidence must contain exactly the authoritative dependencies.",
      );
    }
    const suppliedById = new Map<
      string,
      RepositoryWorkflowDependencyEvidence
    >();
    for (const item of supplied) {
      if (
        !isRecord(item) ||
        typeof item.taskId !== "string" ||
        typeof item.repository !== "string" ||
        typeof item.kind !== "string" ||
        typeof item.number !== "number" ||
        typeof item.sourceRevision !== "string" ||
        (typeof item.state !== "string" && item.state !== "unavailable") ||
        typeof item.satisfied !== "boolean"
      ) {
        throw new RepositoryWorkflowPlannerContextError(
          "invalid_context",
          "Planner dependency evidence has an invalid shape.",
        );
      }
      if (suppliedById.has(item.taskId)) {
        throw new RepositoryWorkflowPlannerContextError(
          "invalid_context",
          `Planner dependency evidence repeats ${item.taskId}.`,
        );
      }
      suppliedById.set(
        item.taskId,
        item as RepositoryWorkflowDependencyEvidence,
      );
    }
    if (suppliedById.size !== uniqueReferences.length) {
      throw new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner dependency evidence contains an unexpected dependency.",
      );
    }
    return uniqueReferences.map((reference) => {
      const expected = evidenceFor(reference);
      const suppliedEvidence = suppliedById.get(expected.taskId);
      if (
        suppliedEvidence === undefined ||
        normalizeRepository(suppliedEvidence.repository) !==
          normalizeRepository(expected.repository) ||
        suppliedEvidence.kind !== expected.kind ||
        suppliedEvidence.number !== expected.number ||
        suppliedEvidence.sourceRevision !== expected.sourceRevision ||
        suppliedEvidence.state !== expected.state ||
        suppliedEvidence.satisfied !== expected.satisfied
      ) {
        throw new RepositoryWorkflowPlannerContextError(
          "invalid_context",
          `Dependency evidence for ${expected.taskId} does not match the claim-time snapshot.`,
        );
      }
      // Return the claim-derived value so the caller cannot alter retained
      // dependency provenance even when its supplied copy happens to match.
      return expected;
    });
  }

  return uniqueReferences.map(evidenceFor);
};

const validateInput = (
  input: RepositoryWorkflowPlanningInput,
): {
  readonly task: NormalizedTask;
  readonly request: ExecutionAttempt["request"];
  readonly dependencyEvidence: readonly RepositoryWorkflowDependencyEvidence[];
} => {
  if (!isRecord(input)) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner input is required.",
    );
  }
  if (!isRecord(input.repositoryWorkflow)) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires the repository workflow context.",
    );
  }
  const task = input.taskSnapshot;
  const attempt = input.attempt;
  if (task === undefined) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires an immutable task snapshot.",
    );
  }
  if (!isRecord(task)) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner task snapshot must be an object.",
    );
  }
  if (!isRecord(attempt)) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires the claimed execution attempt.",
    );
  }
  const request = attempt?.request;
  if (request === undefined) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires the claimed execution request.",
    );
  }
  if (!isRecord(request) || !isRecord(request.task)) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner claimed execution request is malformed.",
    );
  }
  if (!isRecord(input.eligibility)) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires the deterministic eligibility decision.",
    );
  }
  if (
    attempt.status !== "active" ||
    attempt.claim === undefined ||
    attempt.claim.phase !== "claimed"
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "claim_not_available",
      "Planner requires an active unstarted task claim.",
    );
  }
  const claim = attempt.claim;
  requireString(task.repository, "task repository");
  requireString(task.sourceRevision, "task source revision");
  requireString(task.baseBranch, "task base branch");
  requireString(task.baseCommit, "task base revision");
  requireString(request.taskId, "claimed task identity");
  requireString(request.executionIdentity, "claimed execution identity");
  requireString(request.profileId, "repository profile ID");
  requireString(request.profileDigest, "repository profile digest");
  if (!isRecord(request.profile)) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires the repository execution profile.",
    );
  }
  const profileDigest = profileDigestFor(request.profile);
  if (profileDigest === undefined) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner repository execution profile is malformed.",
    );
  }
  if (profileDigest !== request.profileDigest) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner repository profile does not match the claimed profile digest.",
    );
  }
  const repository = requireString(input.repository, "claimed repository");
  const workflowIdentity = requireString(
    input.repositoryWorkflow.workflowIdentity,
    "repository workflow identity",
  );
  if (
    task.repository !== repository ||
    !workflowIdentity.startsWith(`${repository}:`)
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner repository context does not match the claimed task.",
    );
  }
  if (
    !input.eligibility?.eligible ||
    input.eligibility.reasonCode !== "eligible"
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "ineligible_task",
      "Planner can run only after deterministic eligibility succeeds.",
    );
  }
  if (input.eligibility.taskId !== request.taskId) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Eligibility does not describe the claimed task.",
    );
  }
  if (JSON.stringify(input.eligibility.task) !== JSON.stringify(task)) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Eligibility does not describe the claimed task snapshot.",
    );
  }
  if (
    attempt.executionIdentity !== request.executionIdentity ||
    input.eligibility.executionIdentity !== request.executionIdentity
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner execution identity does not match the claimed task.",
    );
  }
  if (
    JSON.stringify(request.task) !== JSON.stringify(task) ||
    workerTaskId(task) !== request.taskId ||
    task.sourceRevision !== request.task.sourceRevision ||
    task.baseCommit !== request.task.baseCommit ||
    claim.taskId !== request.taskId ||
    claim.sourceRevision !== request.task.sourceRevision
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner task context does not match the claimed execution request.",
    );
  }
  if (claim.refreshedSnapshots === undefined) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires claim-time task snapshot evidence.",
    );
  }
  if (!Array.isArray(claim.refreshedSnapshots)) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner claim-time snapshots must be an array.",
    );
  }
  const claimSnapshotIds = new Set<string>();
  for (const snapshot of claim.refreshedSnapshots) {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.repository !== "string" ||
      (snapshot.kind !== "issue" && snapshot.kind !== "prd") ||
      typeof snapshot.number !== "number" ||
      !Number.isInteger(snapshot.number) ||
      snapshot.number < 1 ||
      typeof snapshot.sourceRevision !== "string" ||
      snapshot.sourceRevision.trim() === "" ||
      (snapshot.state !== "open" &&
        snapshot.state !== "blocked" &&
        snapshot.state !== "closed" &&
        snapshot.state !== "claimed" &&
        snapshot.state !== "completed" &&
        snapshot.state !== "stale")
    ) {
      throw new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner claim-time snapshots are malformed.",
      );
    }
    const snapshotId = workerTaskId(snapshot as unknown as NormalizedTask);
    if (claimSnapshotIds.has(snapshotId)) {
      throw new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        `Planner claim-time snapshots repeat ${snapshotId}.`,
      );
    }
    claimSnapshotIds.add(snapshotId);
  }
  const claimedSnapshot = claim.refreshedSnapshots?.find(
    (snapshot) => workerTaskId(snapshot) === request.taskId,
  );
  if (
    claim.refreshedSnapshots !== undefined &&
    (claimedSnapshot === undefined ||
      JSON.stringify(claimedSnapshot) !== JSON.stringify(task))
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner task snapshot does not match the claim-time refresh.",
    );
  }
  const authoritativeSnapshotIds = new Set([
    workerTaskId(task),
    ...task.dependencies.map(workerTaskId),
    ...(task.parentPrd === undefined ? [] : [workerTaskId(task.parentPrd)]),
  ]);
  for (const snapshotId of claimSnapshotIds) {
    if (!authoritativeSnapshotIds.has(snapshotId)) {
      throw new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner claim-time snapshots contain an unrelated task.",
      );
    }
  }
  requirePositiveInteger(input.repositoryWorkflow.cycle, "workflow cycle");
  requirePositiveInteger(
    input.repositoryWorkflow.revision,
    "workflow revision",
  );
  requireString(input.promptVersion, "prompt version");
  requireString(input.promptTemplate, "planner prompt template");
  validTimestamp(attempt.createdAt, "attempt createdAt");
  validTimestamp(attempt.updatedAt, "attempt updatedAt");
  return {
    task,
    request,
    dependencyEvidence: normalizeDependencyEvidence(
      task,
      attempt,
      input.dependencyEvidence,
    ),
  };
};

/** Expand the planner template only from server-owned immutable context. */
export const expandRepositoryWorkflowPlannerPrompt = (
  input: RepositoryWorkflowPlanningInput,
): string => {
  const { task, request, dependencyEvidence } = validateInput(input);
  const replacements: Record<string, string> = {
    REPOSITORY: task.repository,
    TASK_ID: request.taskId,
    TASK_SNAPSHOT: JSON.stringify(task, null, 2),
    REPOSITORY_PROFILE: JSON.stringify(request.profile, null, 2),
    BASE_REVISION: JSON.stringify(
      { branch: task.baseBranch, commit: task.baseCommit },
      null,
      2,
    ),
    DEPENDENCY_EVIDENCE: JSON.stringify(dependencyEvidence, null, 2),
  };
  return input.promptTemplate.replace(
    /\{\{(REPOSITORY|TASK_ID|TASK_SNAPSHOT|REPOSITORY_PROFILE|BASE_REVISION|DEPENDENCY_EVIDENCE)\}\}/g,
    (_match, marker: string) =>
      replacements[marker as keyof typeof replacements]!,
  );
};

const systemEvidenceFor = (
  input: RepositoryWorkflowPlanInput,
): readonly RepositoryWorkflowPlanEvidence[] => [
  {
    source: "system",
    kind: "task",
    reference: input.taskId,
    summary: `Immutable task snapshot at ${input.taskSourceRevision}.`,
  },
  {
    source: "system",
    kind: "base",
    reference: input.baseRevision,
    summary: `Frozen ${input.baseBranch} base revision.`,
  },
  {
    source: "system",
    kind: "profile",
    reference: input.profileDigest,
    summary: `Centrally selected execution profile ${input.profileId}.`,
  },
  ...input.dependencyEvidence.map((dependency) => ({
    source: "system" as const,
    kind: "dependency",
    reference: dependency.taskId,
    summary: `${dependency.state} at ${dependency.sourceRevision}; satisfied=${String(dependency.satisfied)}.`,
  })),
];

class PlannerCancellationError extends Error {
  readonly code = "planner_cancelled";

  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : "Planner was cancelled.");
    this.name = "PlannerCancellationError";
  }
}

class PlannerTimeoutError extends Error {
  readonly code = "planner_timeout";

  constructor(timeoutMs: number) {
    super(`Planner exceeded ${timeoutMs}ms.`);
    this.name = "PlannerTimeoutError";
  }
}

const invokeWithControls = async (
  invoke: RepositoryWorkflowPlannerInvoker,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RepositoryWorkflowPlannerInvocationResult> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  let controlError: PlannerCancellationError | PlannerTimeoutError | undefined;
  const abortWith = (
    error: PlannerCancellationError | PlannerTimeoutError,
    reason: unknown = error,
  ): PlannerCancellationError | PlannerTimeoutError => {
    if (controlError === undefined) {
      controlError = error;
      controller.abort(reason);
    }
    return controlError;
  };
  const cancellation = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(abortWith(new PlannerCancellationError(signal.reason)));
      return;
    }
    if (signal !== undefined) {
      const onAbort = () => {
        reject(
          abortWith(new PlannerCancellationError(signal.reason), signal.reason),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
  if (signal?.aborted) {
    throw new PlannerCancellationError(signal.reason);
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
      reject(abortWith(new PlannerTimeoutError(timeoutMs)));
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

const toPlannerError = (
  error: unknown,
): {
  readonly code: string;
  readonly message: string;
  readonly recovery: RepositoryWorkflowPlanRecovery;
  readonly status: RepositoryWorkflowPlanStatus;
} => {
  if (error instanceof PlannerCancellationError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "cancelled",
    };
  }
  if (error instanceof PlannerTimeoutError) {
    return {
      code: error.code,
      message: error.message,
      recovery: "resumable",
      status: "timed_out",
    };
  }
  if (isRecord(error) && typeof error.code === "string") {
    return {
      code: error.code,
      message: errorMessage(error),
      recovery: "resumable",
      status: "failed",
    };
  }
  return {
    code: "planner_invocation_failed",
    message: errorMessage(error),
    recovery: "resumable",
    status: "failed",
  };
};

const plannerErrorRecord = (
  error: unknown,
): {
  readonly code: string;
  readonly message: string;
  readonly recovery: RepositoryWorkflowPlanRecovery;
  readonly status: RepositoryWorkflowPlanStatus;
} => {
  const result = toPlannerError(error);
  if (error instanceof Error && error.name === "StructuredOutputError") {
    return {
      code: "invalid_structured_output",
      message: result.message,
      recovery: "resumable",
      status: "failed",
    };
  }
  return result;
};

/** Create a planner that handles exactly one claimed eligible task and no later stage. */
export const createRepositoryWorkflowPlanner = (
  options: RepositoryWorkflowPlannerOptions,
): RepositoryWorkflowPlannerStage => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("planner timeoutMs must be a positive finite number.");
  }

  return {
    async plan(
      input: RepositoryWorkflowPlanningInput,
    ): Promise<RepositoryWorkflowPlanRecord> {
      const { task, request, dependencyEvidence } = validateInput(input);
      const planId = requireString(input.planId ?? createId(), "plan ID");
      const provenance: RepositoryWorkflowPlanInput = {
        repository: task.repository,
        workflowIdentity: input.repositoryWorkflow.workflowIdentity,
        ...(input.repositoryWorkflow.runId === undefined
          ? {}
          : { runId: input.repositoryWorkflow.runId }),
        cycle: input.repositoryWorkflow.cycle,
        workflowRevision: input.repositoryWorkflow.revision,
        ...(input.repositoryWorkflow.queuePosition === undefined
          ? {}
          : { queuePosition: input.repositoryWorkflow.queuePosition }),
        ...(input.repositoryWorkflow.mergePolicyDigest === undefined
          ? {}
          : { mergePolicyDigest: input.repositoryWorkflow.mergePolicyDigest }),
        taskId: request.taskId,
        attemptId: input.attempt.attemptId,
        executionIdentity: request.executionIdentity,
        taskSourceRevision: task.sourceRevision,
        baseBranch: task.baseBranch,
        baseRevision: task.baseCommit,
        profileId: request.profileId,
        profileDigest: request.profileDigest,
        promptVersion: input.promptVersion,
        promptTemplateDigest: digestPromptTemplate(input.promptTemplate),
        authorization: input.eligibility.authorization,
        eligibilityReasonCode: "eligible",
        dependencyOrder: dependencyEvidence.map(
          (dependency) => dependency.taskId,
        ),
        dependencyEvidence,
        taskSnapshot: task,
        repositoryProfile: request.profile,
      };
      const existing = await options.planStore.get(planId);
      if (existing !== undefined) {
        if (JSON.stringify(existing.input) !== JSON.stringify(provenance)) {
          throw new RepositoryWorkflowStoreError(
            `Planner record ${planId} conflicts with persisted evidence.`,
            "conflict",
          );
        }
        return existing;
      }
      const createdAt = validTimestamp(now(), "planner timestamp");
      const evidence = systemEvidenceFor(provenance);
      const baseRecord = {
        id: planId,
        version: 1 as const,
        repository: task.repository,
        workflowIdentity: provenance.workflowIdentity,
        taskId: request.taskId,
        attemptId: input.attempt.attemptId,
        executionIdentity: request.executionIdentity,
        createdAt,
        completedAt: createdAt,
        input: provenance,
        evidence,
      };

      try {
        const prompt = expandRepositoryWorkflowPlannerPrompt(input);
        const invocation = await invokeWithControls(
          options.invoke,
          prompt,
          input.signal,
          timeoutMs,
        );
        const output =
          await extractStructuredOutput<RepositoryWorkflowPlannerOutput>(
            invocation.stdout,
            Output.object({ tag: "plan", schema: plannerOutputSchema }),
            {
              commits: [],
              branch: task.baseBranch,
              sessionId: invocation.sessionId,
            },
          );
        const record: RepositoryWorkflowPlanRecord = {
          ...baseRecord,
          status: "accepted",
          recovery: "terminal",
          completedAt: validTimestamp(now(), "planner completion timestamp"),
          plan: {
            ...output,
            repositoryContext: {
              repository: task.repository,
              baseBranch: task.baseBranch,
              baseRevision: task.baseCommit,
              profileId: request.profileId,
              profileDigest: request.profileDigest,
            },
          },
          evidence: [
            ...evidence,
            ...output.evidence.map((item) => ({
              ...item,
              source: "planner" as const,
            })),
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
        await options.planStore.save(record);
        return record;
      } catch (error) {
        const failure = plannerErrorRecord(error);
        const record: RepositoryWorkflowPlanRecord = {
          ...baseRecord,
          status: failure.status,
          recovery: failure.recovery,
          error: { code: failure.code, message: failure.message },
        };
        await options.planStore.save(record);
        return record;
      }
    },
  };
};

/** Discover, refresh, claim, and plan one eligible task without invoking implementation. */
export const planOneEligibleTask = async (
  options: PlanOneEligibleTaskOptions,
): Promise<PlanOneEligibleTaskResult> => {
  const repository = normalizeRepository(
    requireString(options.repository, "claimed repository"),
  );
  requireString(options.owner, "planner owner");
  if (
    !Number.isFinite(options.leaseDurationMs) ||
    options.leaseDurationMs <= 0
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner leaseDurationMs must be a positive finite number.",
    );
  }
  const discovered = await options.source.discover({
    ...options.discovery,
    configuration: options.configuration,
  });
  const dryRun = runWorkerDryRun({
    configuration: options.configuration,
    tasks: discovered,
  });
  const decision = dryRun.decisions.find(
    (candidate) =>
      candidate.task.repository === repository && candidate.eligible,
  );
  const request =
    decision === undefined
      ? undefined
      : dryRun.executionRequests.find(
          (candidate) => candidate.taskId === decision.taskId,
        );
  if (decision === undefined || request === undefined) {
    return {
      status: "no_eligible_task",
      ...(dryRun.decisions.find(
        (candidate) => candidate.task.repository === repository,
      ) === undefined
        ? {}
        : {
            decision: dryRun.decisions.find(
              (candidate) => candidate.task.repository === repository,
            ),
          }),
    };
  }
  const attempt = await claimWorkerTask({
    source: options.source,
    store: options.store,
    configuration: options.configuration,
    request,
    owner: options.owner,
    leaseDurationMs: options.leaseDurationMs,
  });
  const claimSnapshots = attempt.claim?.refreshedSnapshots;
  if (claimSnapshots === undefined) {
    throw new RepositoryWorkflowPlannerContextError(
      "missing_context",
      "Planner requires claim-time task snapshot evidence.",
    );
  }
  const claimRefresh = runWorkerDryRun({
    configuration: options.configuration,
    tasks: claimSnapshots,
  });
  const claimDecision = claimRefresh.decisions.find(
    (candidate) => candidate.taskId === attempt.request.taskId,
  );
  const claimRequest = claimRefresh.executionRequests.find(
    (candidate) => candidate.taskId === attempt.request.taskId,
  );
  if (
    claimDecision === undefined ||
    !claimDecision.eligible ||
    claimRequest === undefined ||
    claimRequest.executionIdentity !== attempt.request.executionIdentity
  ) {
    throw new RepositoryWorkflowPlannerContextError(
      "invalid_context",
      "Planner claim-time eligibility does not match the claimed execution request.",
    );
  }
  const record = await options.planner.plan({
    repository,
    repositoryWorkflow: options.repositoryWorkflow,
    attempt,
    taskSnapshot: claimRequest.task,
    eligibility: claimDecision,
    promptVersion: options.promptVersion,
    promptTemplate: options.promptTemplate,
    signal: options.signal,
  });
  return { status: "planned", decision: claimDecision, attempt, record };
};

/** Convert a retained plan into the safe Mission Control workflow projection. */
export const projectRepositoryWorkflowPlan = (
  record: RepositoryWorkflowPlanRecord,
): RepositoryWorkflowPlanProjection => ({
  id: record.id,
  version: 1,
  status: record.status,
  recovery: record.recovery,
  repository: record.repository,
  workflowIdentity: record.workflowIdentity,
  taskId: record.taskId,
  attemptId: record.attemptId,
  executionIdentity: record.executionIdentity,
  cycle: record.input.cycle,
  workflowRevision: record.input.workflowRevision,
  ...(record.input.queuePosition === undefined
    ? {}
    : { queuePosition: record.input.queuePosition }),
  taskSourceRevision: record.input.taskSourceRevision,
  baseBranch: record.input.baseBranch,
  baseRevision: record.input.baseRevision,
  profileId: record.input.profileId,
  profileDigest: record.input.profileDigest,
  promptVersion: record.input.promptVersion,
  promptTemplateDigest: record.input.promptTemplateDigest,
  authorization: record.input.authorization,
  eligibilityReasonCode: record.input.eligibilityReasonCode,
  dependencyOrder: record.input.dependencyOrder,
  dependencyEvidence: record.input.dependencyEvidence,
  createdAt: record.createdAt,
  completedAt: record.completedAt,
  ...(record.plan === undefined ? {} : { plan: record.plan }),
  evidence: record.evidence,
  ...(record.error === undefined ? {} : { errorCode: record.error.code }),
});
