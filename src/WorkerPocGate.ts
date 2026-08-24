import {
  runWorkerDryRun,
  workerConfigurationDigest,
  workerTaskId,
  type DryRunResult,
  type ExecutionRequest,
  type NormalizedTask,
  type TaskReference,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type {
  CrossRepositoryAcceptanceProof,
  DependencyChainAcceptanceProof,
  RetainedExecutionProvenance,
} from "./WorkerAcceptanceProof.js";
import { workerBranchFor } from "./WorkerRepositoryManager.js";
import type { DraftPullRequest } from "./WorkerPublication.js";
import type { WorkerCycleResult } from "./WorkerService.js";
import type { ExecutionAttempt, WorkerState } from "./WorkerStateStore.js";
import { sameCanonicalJson } from "./CanonicalJson.js";
import { readWorkerPocBoundaryAudit } from "./WorkerPocGateAudit.js";
import {
  retainWorkerPocGateArtifacts,
  workerPocFutureEvidence,
  workerPocLimitations,
} from "./WorkerPocGateReport.js";
import { workerRestartEvidenceDigest } from "./WorkerRestartAcceptanceProof.js";

export type WorkerPocGateErrorCode =
  | "invalid_input"
  | "discovery_determinism"
  | "authorization_boundary"
  | "restart_recovery"
  | "cross_repository_proof"
  | "dependency_order"
  | "evidence_mismatch"
  | "boundary_bypass";

/** Raised when retained evidence cannot satisfy the complete POC gate. */
export class WorkerPocGateError extends Error {
  readonly code: WorkerPocGateErrorCode;

  constructor(message: string, code: WorkerPocGateErrorCode) {
    super(message);
    this.name = "WorkerPocGateError";
    this.code = code;
  }
}

/** State and external observations captured across one service restart. */
export interface WorkerRestartScenarioEvidence {
  readonly beforeRestart: WorkerState;
  readonly afterRestart: WorkerState;
  readonly recoveryCycle: WorkerCycleResult;
  readonly observedBranches: readonly string[];
  readonly observedPullRequests: readonly DraftPullRequest[];
  readonly beforeObservedPullRequests: readonly DraftPullRequest[];
  readonly afterObservedPullRequests: readonly DraftPullRequest[];
}

/** Both fail-closed and idempotent-publication restart boundaries. */
export interface WorkerRestartAcceptanceEvidence {
  readonly runId: string;
  /** A started attempt is retained for manual inspection without redispatch. */
  readonly interrupted: WorkerRestartScenarioEvidence;
  /** A verified attempt resumes one idempotent draft publication. */
  readonly verifiedPublication: WorkerRestartScenarioEvidence;
  readonly publication: RetainedRestartPublication;
  readonly integrity: {
    readonly algorithm: "hmac-sha256";
    readonly digest: string;
  };
}

export interface RetainedRestartPublication extends RetainedExecutionProvenance {
  readonly executionRecordPath: string;
}

export type WorkerPrivilegedAction =
  | "claim"
  | "verification"
  | "publication"
  | "merge"
  | "closure";

export type WorkerPocBoundaryAction = WorkerPrivilegedAction | "github-command";

/** One time-scoped action retained by the deployed worker audit boundary. */
export interface WorkerPocBoundaryAuditEvent {
  readonly timestamp: string;
  readonly actor: "worker" | "agent" | "operator";
  readonly action: WorkerPocBoundaryAction;
  readonly executionIdentity?: string;
  readonly evidence: readonly string[];
}

/** Retained action log for exactly one deployed gate run. */
export interface WorkerPocBoundaryAudit {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly events: readonly WorkerPocBoundaryAuditEvent[];
  readonly integrity: {
    readonly algorithm: "hmac-sha256";
    readonly eventDigests: readonly string[];
    readonly rootDigest: string;
  };
}

/** One draft publication with every immutable input and outcome reference. */
export interface WorkerPocPublicationProvenance {
  readonly taskId: string;
  readonly executionIdentity: string;
  readonly attemptId: string;
  readonly taskRevision: string;
  readonly baseCommit: string;
  /** Digest of the complete central configuration used by the gate. */
  readonly configurationDigest: string;
  readonly executionProfileDigest: string;
  readonly promptVersion: string;
  readonly promptTemplateDigest: string;
  readonly commits: readonly { readonly sha: string }[];
  readonly verification: readonly {
    readonly command: string;
    readonly exitCode: number;
  }[];
  readonly evidence: readonly string[];
  readonly executionRecordPath: string;
  readonly pullRequestUrl: string;
  readonly draft: true;
}

export interface WorkerPocLimitation {
  readonly id:
    | "single-worker"
    | "polling-only"
    | "manual-recovery"
    | "github-only"
    | "human-review";
  readonly description: string;
}

export interface WorkerPocFutureEvidence {
  readonly capability:
    | "concurrency"
    | "webhooks"
    | "auto-remediation"
    | "issue-tracker-support";
  readonly requiredEvidence: readonly string[];
}

export interface WorkerPocGateProof {
  readonly version: 1;
  readonly kind: "repo-agnostic-worker-poc-gate";
  readonly status: "passed";
  readonly createdAt: string;
  readonly checks: {
    readonly deterministicDiscovery: true;
    readonly unauthorizedInboxIsolation: true;
    readonly restartWithoutDuplicates: true;
    readonly crossRepositoryIsolation: true;
    readonly dependencyFrontierOrdering: true;
    readonly publicationProvenance: true;
    readonly guardedBoundaries: true;
  };
  readonly discovery: {
    readonly first: DryRunResult["machineReadable"];
    readonly second: DryRunResult["machineReadable"];
    readonly unauthorizedTaskId: string;
  };
  readonly boundaryAudit: {
    readonly path: string;
    readonly digest: string;
    readonly runId: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly eventCount: number;
  };
  readonly restart: {
    readonly interruptedAttemptId: string;
    readonly publicationAttemptId: string;
    readonly branch: string;
    readonly pullRequestUrl: string;
    readonly executionIdentity: string;
    readonly attemptId: string;
  };
  readonly crossRepositoryProof: CrossRepositoryAcceptanceProof;
  readonly dependencyChainProof: DependencyChainAcceptanceProof;
  readonly publications: readonly WorkerPocPublicationProvenance[];
  readonly limitations: readonly WorkerPocLimitation[];
  readonly futureEvidence: readonly WorkerPocFutureEvidence[];
}

/** Inputs collected by the deployed acceptance fixture. */
export interface RunWorkerPocGateInput {
  readonly proofPath: string;
  readonly reportPath: string;
  readonly configuration: WorkerConfiguration;
  readonly account: string;
  /** Fresh discovery boundary. It is called twice by the gate. */
  readonly discover: () => Promise<readonly NormalizedTask[]>;
  readonly unauthorizedTask: TaskReference;
  /** State captured after inbox discovery and before any later authorization. */
  readonly unauthorizedInboxState: WorkerState;
  readonly crossRepositoryProof: CrossRepositoryAcceptanceProof;
  readonly dependencyChainProof: DependencyChainAcceptanceProof;
  readonly restartEvidence: WorkerRestartAcceptanceEvidence;
  /** JSON audit artifact retained by the deployed wrapper. */
  readonly boundaryAuditPath: string;
  /** Process-only integrity key shared by the guarded boundaries and gate. */
  readonly boundaryAuditKey: string;
  readonly createdAt?: string;
}

const fail = (message: string, code: WorkerPocGateErrorCode): never => {
  throw new WorkerPocGateError(message, code);
};

const sameJson = (left: unknown, right: unknown): boolean =>
  sameCanonicalJson(left, right);

const onlyAttempt = (state: WorkerState, label: string): ExecutionAttempt => {
  if (state.attempts.length !== 1) {
    return fail(
      `${label} must retain exactly one execution attempt.`,
      "restart_recovery",
    );
  }
  return state.attempts[0]!;
};

const assertSameAttempt = (
  before: ExecutionAttempt,
  after: ExecutionAttempt,
): void => {
  if (
    before.attemptId !== after.attemptId ||
    before.executionIdentity !== after.executionIdentity ||
    !sameJson(before.request, after.request) ||
    !sameJson(before.claim, after.claim)
  ) {
    fail(
      "Restart recovery created or rebound an execution attempt.",
      "restart_recovery",
    );
  }
};

const assertOneBranch = (
  scenario: WorkerRestartScenarioEvidence,
  attempt: ExecutionAttempt,
): string => {
  const expected = workerBranchFor(attempt.request);
  if (
    scenario.observedBranches.length < 2 ||
    scenario.observedBranches.some((branch) => branch !== expected)
  ) {
    return fail(
      "Restart recovery did not reuse the deterministic task branch.",
      "restart_recovery",
    );
  }
  return expected;
};

const validateRestartEvidence = (
  evidence: WorkerRestartAcceptanceEvidence,
  integrityKey: string,
): WorkerPocGateProof["restart"] => {
  const unsigned = {
    runId: evidence.runId,
    interrupted: evidence.interrupted,
    verifiedPublication: evidence.verifiedPublication,
    publication: evidence.publication,
  };
  if (
    evidence.runId.trim() === "" ||
    evidence.integrity.algorithm !== "hmac-sha256" ||
    evidence.integrity.digest !==
      workerRestartEvidenceDigest(unsigned, integrityKey)
  ) {
    fail(
      "Restart evidence is not authenticated for this deployed gate run.",
      "restart_recovery",
    );
  }
  const interruptedBefore = onlyAttempt(
    evidence.interrupted.beforeRestart,
    "Interrupted pre-restart state",
  );
  const interruptedAfter = onlyAttempt(
    evidence.interrupted.afterRestart,
    "Interrupted post-restart state",
  );
  assertSameAttempt(interruptedBefore, interruptedAfter);
  const interruptedBranch = assertOneBranch(
    evidence.interrupted,
    interruptedBefore,
  );
  const manualIntervention = evidence.interrupted.recoveryCycle.events.some(
    (event) =>
      event.state === "blocked" &&
      event.reasonCode === "manual_intervention" &&
      event.attemptId === interruptedBefore.attemptId,
  );
  if (
    interruptedBefore.status !== "active" ||
    interruptedBefore.claim?.phase !== "started" ||
    interruptedAfter.status !== "active" ||
    evidence.interrupted.recoveryCycle.attempted ||
    !manualIntervention ||
    evidence.interrupted.observedPullRequests.length !== 0 ||
    evidence.interrupted.beforeObservedPullRequests.length !== 0 ||
    evidence.interrupted.afterObservedPullRequests.length !== 0
  ) {
    fail(
      "A started attempt was not preserved for fail-closed manual recovery.",
      "restart_recovery",
    );
  }

  const verifiedBefore = onlyAttempt(
    evidence.verifiedPublication.beforeRestart,
    "Verified pre-restart state",
  );
  const publishedAfter = onlyAttempt(
    evidence.verifiedPublication.afterRestart,
    "Published post-restart state",
  );
  assertSameAttempt(verifiedBefore, publishedAfter);
  if (
    interruptedBefore.executionIdentity !== verifiedBefore.executionIdentity ||
    !sameJson(interruptedBefore.request, verifiedBefore.request)
  ) {
    fail(
      "Restart dispositions do not exercise the same immutable execution request.",
      "restart_recovery",
    );
  }
  const publicationBranch = assertOneBranch(
    evidence.verifiedPublication,
    verifiedBefore,
  );
  const resumed = evidence.verifiedPublication.recoveryCycle.events.some(
    (event) =>
      event.state === "verified" &&
      event.reasonCode === "resume_publication" &&
      event.attemptId === verifiedBefore.attemptId,
  );
  const published = evidence.verifiedPublication.recoveryCycle.events.some(
    (event) =>
      event.state === "published" &&
      event.attemptId === verifiedBefore.attemptId,
  );
  const pullRequests = evidence.verifiedPublication.observedPullRequests;
  const pullRequest =
    pullRequests[0] ??
    fail(
      "Verified restart recovery did not retain a draft pull request.",
      "restart_recovery",
    );
  const publishedOutcome = publishedAfter.outcomes.find(
    (outcome) => outcome.status === "published",
  );
  if (
    verifiedBefore.status !== "verified" ||
    publishedAfter.status !== "published" ||
    !evidence.verifiedPublication.recoveryCycle.attempted ||
    !resumed ||
    !published ||
    publishedOutcome === undefined ||
    evidence.verifiedPublication.beforeObservedPullRequests.length !== 0 ||
    evidence.verifiedPublication.afterObservedPullRequests.length !== 1 ||
    !publishedOutcome.evidence.includes(pullRequest.url) ||
    publicationBranch !== interruptedBranch ||
    !pullRequest.draft ||
    pullRequest.head !== publicationBranch ||
    pullRequests.some(
      (candidate) =>
        candidate.url !== pullRequest.url ||
        candidate.head !== pullRequest.head ||
        candidate.headSha !== pullRequest.headSha ||
        !candidate.draft,
    )
  ) {
    fail(
      "Verified restart recovery did not reuse one branch and draft pull request.",
      "restart_recovery",
    );
  }
  return {
    interruptedAttemptId: interruptedBefore.attemptId,
    publicationAttemptId: verifiedBefore.attemptId,
    branch: publicationBranch,
    pullRequestUrl: pullRequest.url,
    executionIdentity: verifiedBefore.executionIdentity,
    attemptId: verifiedBefore.attemptId,
  };
};

const requestFor = (
  configuration: WorkerConfiguration,
  tasks: readonly NormalizedTask[],
  taskId: string,
  code: WorkerPocGateErrorCode,
): {
  readonly evaluation: DryRunResult;
  readonly request: ExecutionRequest;
} => {
  const evaluation = runWorkerDryRun({ configuration, tasks });
  const request = evaluation.executionRequests.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (request === undefined) {
    return fail(`Retained evidence cannot reproduce ${taskId}.`, code);
  }
  return { evaluation, request };
};

const assertRequestBinding = (
  retained: {
    readonly taskId: string;
    readonly executionIdentity: string;
    readonly profileId: string;
    readonly profileDigest: string;
    readonly promptVersion: string;
    readonly promptTemplateDigest: string;
    readonly pullRequest: DraftPullRequest;
    readonly verification: readonly {
      readonly command: string;
      readonly exitCode: number;
    }[];
  },
  request: ExecutionRequest,
): void => {
  if (
    retained.taskId !== request.taskId ||
    retained.executionIdentity !== request.executionIdentity ||
    retained.profileId !== request.profileId ||
    retained.profileDigest !== request.profileDigest ||
    retained.promptVersion !== request.promptVersion ||
    retained.promptTemplateDigest !== request.promptTemplateDigest ||
    retained.pullRequest.head !== workerBranchFor(request) ||
    retained.pullRequest.base !== request.task.baseBranch ||
    retained.verification.length !==
      request.profile.verificationCommands.length ||
    retained.verification.some(
      (result, index) =>
        result.command !== request.profile.verificationCommands[index] ||
        result.exitCode !== 0,
    )
  ) {
    fail(
      `Retained publication ${retained.taskId} is not bound to the reproduced execution request.`,
      "evidence_mismatch",
    );
  }
};

const assertCrossRepositoryProof = (
  proof: CrossRepositoryAcceptanceProof,
  configuration: WorkerConfiguration,
): readonly ExecutionRequest[] => {
  const runs = proof.runs;
  const repositories = runs.map((run) => run.repository.toLowerCase());
  const firstTwo = runs.slice(0, 2);
  if (
    proof.version !== 1 ||
    proof.kind !== "cross-repository-authorization-and-isolation" ||
    runs.length !== 3 ||
    new Set(repositories).size !== 3 ||
    firstTwo.length !== 2 ||
    firstTwo[0]!.snapshot.number !== firstTwo[1]!.snapshot.number ||
    proof.initialAuthorization.eligible ||
    proof.initialAuthorization.reasonCode !== "unauthorized_repository" ||
    proof.initialAuthorization.taskId !== proof.authorizedDecision.taskId ||
    !proof.authorizedDecision.eligible ||
    proof.authorizedDecision.authorization !== "task" ||
    proof.siblingDecision.eligible ||
    proof.siblingDecision.reasonCode !== "unauthorized_repository" ||
    proof.siblingDecision.task.repository.toLowerCase() !==
      proof.authorizedDecision.task.repository.toLowerCase() ||
    proof.siblingDecision.taskId === proof.authorizedDecision.taskId ||
    proof.isolation.credentialsObserved ||
    proof.isolation.workerConfigurationObserved ||
    proof.isolation.unexpectedArtifactsObserved ||
    runs.some(
      (run) =>
        !run.pullRequest.draft ||
        run.isolationObservation.observedCredentialNames.length > 0 ||
        run.isolationObservation.observedWorkerConfiguration ||
        run.isolationObservation.unexpectedArtifactPaths.length > 0,
    ) ||
    new Set(runs.map((run) => run.taskId)).size !== runs.length ||
    new Set(runs.map((run) => run.executionIdentity)).size !== runs.length ||
    new Set(runs.map((run) => run.attemptId)).size !== runs.length ||
    new Set(runs.map((run) => run.branch)).size !== runs.length ||
    new Set(runs.map((run) => run.pullRequest.url)).size !== runs.length
  ) {
    fail(
      "The retained cross-repository proof is incomplete or inconsistent.",
      "cross_repository_proof",
    );
  }
  return runs.map((run) => {
    const { evaluation, request } = requestFor(
      configuration,
      [run.snapshot],
      run.taskId,
      "cross_repository_proof",
    );
    if (
      evaluation.executionRequests.length !== 1 ||
      !sameJson(request.task, run.snapshot)
    ) {
      fail(
        `Cross-repository run ${run.taskId} is not independently reproducible.`,
        "cross_repository_proof",
      );
    }
    assertRequestBinding(run, request);
    return request;
  });
};

const assertDependencyProof = (
  proof: DependencyChainAcceptanceProof,
  configuration: WorkerConfiguration,
): readonly ExecutionRequest[] => {
  const stageTaskIds = proof.stages.map((stage) => stage.taskId);
  if (
    proof.version !== 1 ||
    proof.kind !== "prd-dependency-chain" ||
    proof.stages.length !== 3 ||
    proof.prd.kind !== "prd" ||
    new Set(stageTaskIds).size !== 3 ||
    !sameJson(proof.prd.children.map(workerTaskId), stageTaskIds)
  ) {
    fail(
      "The retained PRD proof does not show one freshly eligible frontier per stage.",
      "dependency_order",
    );
  }
  return proof.stages.map((stage, index) => {
    const previousTaskId =
      index === 0 ? undefined : proof.stages[index - 1]!.taskId;
    const dependencyIds = stage.snapshot.dependencies.map(workerTaskId);
    const futureTaskIds = proof.stages
      .slice(index + 1)
      .map((candidate) => candidate.taskId);
    const { evaluation, request } = requestFor(
      configuration,
      stage.observedSnapshots,
      stage.taskId,
      "dependency_order",
    );
    const claimSnapshotIds = new Set(stage.claimSnapshots.map(workerTaskId));
    const futureDecisions = futureTaskIds.map((taskId) =>
      evaluation.decisions.find((decision) => decision.taskId === taskId),
    );
    if (
      stage.snapshot.kind !== "issue" ||
      workerTaskId(stage.prdContext) !== workerTaskId(proof.prd) ||
      !sameJson(stage.prdContext.children.map(workerTaskId), stageTaskIds) ||
      !sameJson(request.task, stage.snapshot) ||
      request.context.parentPrd === undefined ||
      !sameJson(request.context.parentPrd, stage.prdContext) ||
      evaluation.executionRequests.length !== 1 ||
      !sameJson(stage.blockedTaskIds, futureTaskIds) ||
      futureDecisions.some(
        (decision) =>
          decision === undefined ||
          decision.eligible ||
          decision.reasonCode !== "unmet_dependency",
      ) ||
      (previousTaskId === undefined
        ? dependencyIds.length !== 0
        : !sameJson(dependencyIds, [previousTaskId])) ||
      !claimSnapshotIds.has(stage.taskId) ||
      !claimSnapshotIds.has(workerTaskId(proof.prd)) ||
      dependencyIds.some((taskId) => !claimSnapshotIds.has(taskId)) ||
      !stage.pullRequest.draft ||
      stage.commits.length === 0 ||
      stage.pullRequest.headSha.toLowerCase() !==
        stage.commits.at(-1)?.sha.toLowerCase()
    ) {
      fail(
        `Dependency stage ${stage.taskId} is not the sole freshly eligible frontier.`,
        "dependency_order",
      );
    }
    assertRequestBinding(stage, request);
    return request;
  });
};

const isSha = (value: string, length: number): boolean =>
  new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);

const publicationFrom = (
  retained: RetainedExecutionProvenance,
  executionRecordPath: string,
  request: ExecutionRequest,
): WorkerPocPublicationProvenance => ({
  taskId: retained.taskId,
  executionIdentity: retained.executionIdentity,
  attemptId: retained.attemptId,
  taskRevision: retained.snapshot.sourceRevision,
  baseCommit: retained.snapshot.baseCommit,
  configurationDigest: retained.configurationDigest,
  executionProfileDigest: request.profileDigest,
  promptVersion: retained.promptVersion,
  promptTemplateDigest: retained.promptTemplateDigest,
  commits: retained.commits,
  verification: retained.verification,
  evidence: retained.evidence,
  executionRecordPath,
  pullRequestUrl: retained.pullRequest.url,
  draft: true,
});

const assertPublicationProvenance = (
  publications: readonly WorkerPocPublicationProvenance[],
  configurationDigest: string,
): void => {
  if (
    publications.length !== 7 ||
    new Set(publications.map((publication) => publication.pullRequestUrl))
      .size !== publications.length ||
    publications.some(
      (publication) =>
        publication.attemptId.trim() === "" ||
        publication.taskRevision.trim() === "" ||
        !isSha(publication.baseCommit, 40) ||
        !isSha(publication.configurationDigest, 64) ||
        publication.configurationDigest !== configurationDigest ||
        !isSha(publication.executionProfileDigest, 64) ||
        publication.promptVersion.trim() === "" ||
        !isSha(publication.promptTemplateDigest, 64) ||
        publication.commits.length === 0 ||
        publication.commits.some((commit) => !isSha(commit.sha, 40)) ||
        publication.verification.length === 0 ||
        publication.verification.some((result) => result.exitCode !== 0) ||
        !publication.evidence.includes(publication.pullRequestUrl) ||
        !publication.evidence.includes(publication.executionRecordPath) ||
        publication.evidence.length < 2 ||
        !publication.draft,
    )
  ) {
    fail(
      "A draft publication is missing immutable inputs, commits, verification, or retained evidence.",
      "evidence_mismatch",
    );
  }
};

/** Run and retain the final, fail-closed repository-worker POC gate. */
export const runWorkerPocGate = async (
  input: RunWorkerPocGateInput,
): Promise<WorkerPocGateProof> => {
  const account = input.account.trim().toLowerCase();
  if (account === "") fail("account must be non-empty.", "invalid_input");
  const firstTasks = await input.discover();
  const first = runWorkerDryRun({
    configuration: input.configuration,
    tasks: firstTasks,
  });
  const secondTasks = await input.discover();
  const second = runWorkerDryRun({
    configuration: input.configuration,
    tasks: secondTasks,
  });
  if (!sameJson(first.machineReadable, second.machineReadable)) {
    fail(
      "Repeated unchanged discovery did not produce equivalent ordered decisions and identities.",
      "discovery_determinism",
    );
  }

  const unauthorizedTaskId = workerTaskId(input.unauthorizedTask);
  const unauthorizedDecision = first.decisions.find(
    (decision) => decision.taskId === unauthorizedTaskId,
  );
  const retainedInboxSnapshot = input.unauthorizedInboxState.taskSnapshots.find(
    (record) => record.taskId === unauthorizedTaskId,
  );
  if (
    unauthorizedDecision === undefined ||
    unauthorizedDecision.task.author?.trim().toLowerCase() !== account ||
    unauthorizedDecision.eligible ||
    unauthorizedDecision.reasonCode !== "unauthorized_repository" ||
    retainedInboxSnapshot === undefined ||
    !sameJson(retainedInboxSnapshot.task, unauthorizedDecision.task) ||
    input.unauthorizedInboxState.executionRequests.some(
      (record) => record.request.taskId === unauthorizedTaskId,
    ) ||
    input.unauthorizedInboxState.attempts.some(
      (attempt) => attempt.request.taskId === unauthorizedTaskId,
    ) ||
    first.executionRequests.some(
      (request) => request.taskId === unauthorizedTaskId,
    )
  ) {
    fail(
      `${unauthorizedTaskId} was not retained as a non-executable inbox decision.`,
      "authorization_boundary",
    );
  }

  const restart = validateRestartEvidence(
    input.restartEvidence,
    input.boundaryAuditKey,
  );
  const crossRequests = assertCrossRepositoryProof(
    input.crossRepositoryProof,
    input.configuration,
  );
  const dependencyRequests = assertDependencyProof(
    input.dependencyChainProof,
    input.configuration,
  );
  const { request: restartRequest } = requestFor(
    input.configuration,
    [input.restartEvidence.publication.snapshot],
    input.restartEvidence.publication.taskId,
    "restart_recovery",
  );
  assertRequestBinding(input.restartEvidence.publication, restartRequest);
  const configurationDigest = workerConfigurationDigest(input.configuration);
  const publications = [
    ...input.crossRepositoryProof.runs.map((run, index) =>
      publicationFrom(run, run.recordPath, crossRequests[index]!),
    ),
    ...input.dependencyChainProof.stages.map((stage, index) =>
      publicationFrom(
        stage,
        stage.executionRecordPath,
        dependencyRequests[index]!,
      ),
    ),
    publicationFrom(
      input.restartEvidence.publication,
      input.restartEvidence.publication.executionRecordPath,
      restartRequest,
    ),
  ];
  assertPublicationProvenance(publications, configurationDigest);
  const boundaryAudit = await readWorkerPocBoundaryAudit(
    input.boundaryAuditPath,
    input.boundaryAuditKey,
    publications,
    fail,
  );
  const restartPublication = publications.at(-1);
  if (
    restartPublication === undefined ||
    restartPublication.executionIdentity !== restart.executionIdentity ||
    restartPublication.attemptId !== restart.attemptId ||
    restartPublication.pullRequestUrl !== restart.pullRequestUrl ||
    boundaryAudit.runId !== input.restartEvidence.runId
  ) {
    fail(
      "Restart recovery is not bound to a retained publication in this gate run.",
      "restart_recovery",
    );
  }

  const proof: WorkerPocGateProof = {
    version: 1,
    kind: "repo-agnostic-worker-poc-gate",
    status: "passed",
    createdAt: input.createdAt ?? new Date().toISOString(),
    checks: {
      deterministicDiscovery: true,
      unauthorizedInboxIsolation: true,
      restartWithoutDuplicates: true,
      crossRepositoryIsolation: true,
      dependencyFrontierOrdering: true,
      publicationProvenance: true,
      guardedBoundaries: true,
    },
    discovery: {
      first: first.machineReadable,
      second: second.machineReadable,
      unauthorizedTaskId,
    },
    boundaryAudit,
    restart,
    crossRepositoryProof: input.crossRepositoryProof,
    dependencyChainProof: input.dependencyChainProof,
    publications,
    limitations: workerPocLimitations,
    futureEvidence: workerPocFutureEvidence,
  };
  await retainWorkerPocGateArtifacts(
    input.proofPath,
    input.reportPath,
    proof,
    fail,
  );
  return proof;
};
