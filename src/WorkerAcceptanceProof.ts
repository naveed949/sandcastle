import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeRepository,
  runWorkerDryRun,
  workerTaskId,
  type EligibilityDecision,
  type ExecutionRequest,
  type NormalizedTask,
  type TaskReference,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type {
  WorkerExecutionEngine,
  WorkerExecutionResult,
} from "./WorkerExecutionEngine.js";
import type { GitHubTaskSource } from "./GitHubTaskSource.js";
import { claimWorkerTask } from "./WorkerClaimCoordinator.js";
import {
  workerBranchFor,
  workerRepositoryDirectory,
} from "./WorkerRepositoryManager.js";
import type {
  DraftPullRequest,
  WorkerPublicationResult,
  WorkerPublisher,
} from "./WorkerPublication.js";
import type {
  ExecutionAttempt,
  WorkerState,
  WorkerStateStore,
} from "./WorkerStateStore.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";

export type WorkerAcceptanceProofErrorCode =
  | "invalid_scenario"
  | "authorization_boundary"
  | "evidence_mismatch"
  | "isolation_failure";

/** Raised when observed acceptance evidence does not prove every required boundary. */
export class WorkerAcceptanceProofError extends Error {
  readonly code: WorkerAcceptanceProofErrorCode;

  constructor(message: string, code: WorkerAcceptanceProofErrorCode) {
    super(message);
    this.name = "WorkerAcceptanceProofError";
    this.code = code;
  }
}

/** Secret- and configuration-free observations derived from retained run artifacts. */
export interface WorkerIsolationObservation {
  /** Credential names visible to the agent; values must never be retained. */
  readonly observedCredentialNames: readonly string[];
  /** Whether central worker configuration was visible inside the agent boundary. */
  readonly observedWorkerConfiguration: boolean;
  /** Artifact paths found outside this run's repository namespace. */
  readonly unexpectedArtifactPaths: readonly string[];
}

/** Live outputs required to prove one task from snapshot through draft publication. */
export interface WorkerAcceptanceRunPaths {
  readonly stateFilePath: string;
  readonly repositoryDir: string;
  readonly worktreePath: string;
  readonly runLogPath: string;
}

interface CrossRepositoryAcceptanceRun {
  readonly paths: WorkerAcceptanceRunPaths;
  readonly attempt: ExecutionAttempt;
  readonly execution: WorkerExecutionResult;
  readonly publication: WorkerPublicationResult;
  readonly changedArtifactPaths: readonly string[];
  readonly unexpectedArtifactPaths: readonly string[];
}

interface EvaluatedAcceptanceScenario {
  readonly initialAuthorization: EligibilityDecision;
  readonly authorizedDecision: EligibilityDecision;
  readonly siblingDecision: EligibilityDecision;
  readonly requests: readonly [
    ExecutionRequest,
    ExecutionRequest,
    ExecutionRequest,
  ];
}

/** Inputs used to validate and retain the cross-repository acceptance proof. */
interface CrossRepositoryAcceptanceEvidenceInput {
  readonly proofPath: string;
  readonly workspaceRoot: string;
  readonly recordsRoot: string;
  readonly scenario: EvaluatedAcceptanceScenario;
  readonly runs: readonly [
    CrossRepositoryAcceptanceRun,
    CrossRepositoryAcceptanceRun,
    CrossRepositoryAcceptanceRun,
  ];
  /** Injectable timestamp for deterministic live harnesses and tests. */
  readonly createdAt?: string;
}

export interface RetainedAcceptanceRun {
  readonly repository: string;
  readonly taskId: string;
  readonly snapshot: NormalizedTask;
  readonly executionIdentity: string;
  readonly attemptId: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly paths: WorkerAcceptanceRunPaths;
  readonly recordPath: string;
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
  readonly verification: readonly {
    readonly command: string;
    readonly exitCode: number;
  }[];
  readonly evidence: readonly string[];
  readonly pullRequest: DraftPullRequest;
  readonly isolationObservation: WorkerIsolationObservation;
}

/** Live runtime boundaries used to execute and inspect one acceptance task. */
export interface CrossRepositoryAcceptanceRuntime {
  readonly stateFilePath: string;
  readonly store: WorkerStateStore;
  readonly execution: WorkerExecutionEngine;
  readonly publisher: WorkerPublisher;
}

/** Inputs for the sequential live GitHub acceptance harness. */
export interface RunCrossRepositoryAcceptanceProofInput {
  readonly proofPath: string;
  readonly workspaceRoot: string;
  readonly recordsRoot: string;
  readonly source: GitHubTaskSource;
  readonly initialConfiguration: WorkerConfiguration;
  readonly authorizedConfiguration: WorkerConfiguration;
  readonly approvedTasks: readonly [TaskReference, TaskReference];
  readonly thirdPartyTask: TaskReference;
  readonly thirdPartySibling: TaskReference;
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly runtimeFor: (
    request: ExecutionRequest,
  ) => Promise<CrossRepositoryAcceptanceRuntime>;
  readonly createdAt?: string;
}

/** Credential-free, immutable evidence retained after a successful live proof. */
export interface CrossRepositoryAcceptanceProof {
  readonly version: 1;
  readonly kind: "cross-repository-authorization-and-isolation";
  readonly createdAt: string;
  readonly initialAuthorization: EligibilityDecision;
  readonly authorizedDecision: EligibilityDecision;
  readonly siblingDecision: EligibilityDecision;
  readonly runs: readonly RetainedAcceptanceRun[];
  readonly isolation: {
    readonly repositories: readonly string[];
    readonly credentialsObserved: false;
    readonly workerConfigurationObserved: false;
    readonly unexpectedArtifactsObserved: false;
  };
}

const fail = (message: string, code: WorkerAcceptanceProofErrorCode): never => {
  throw new WorkerAcceptanceProofError(message, code);
};

const decisionFor = (
  decisions: readonly EligibilityDecision[],
  task: NormalizedTask,
): EligibilityDecision => {
  const taskId = workerTaskId(task);
  const decision = decisions.find((candidate) => candidate.taskId === taskId);
  if (decision === undefined) {
    return fail(
      `Acceptance decision for ${taskId} is missing.`,
      "invalid_scenario",
    );
  }
  return decision;
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isWithin = (parent: string, candidate: string): boolean => {
  const path = relative(resolve(parent), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

const isWithinOrSame = (parent: string, candidate: string): boolean =>
  resolve(parent) === resolve(candidate) || isWithin(parent, candidate);

const repositoryParts = (repository: string): readonly [string, string] => {
  const [owner, name, ...rest] = normalizeRepository(repository).split("/");
  if (owner === undefined || name === undefined || rest.length > 0) {
    return fail(
      `Acceptance repository ${repository} is invalid.`,
      "invalid_scenario",
    );
  }
  return [owner, name];
};

/** Return the repository-qualified durable state path used by acceptance runs. */
export const workerStateFilePath = (
  workspaceRoot: string,
  repository: string,
): string => {
  const [owner, name] = repositoryParts(repository);
  return join(
    workspaceRoot,
    "repositories",
    owner,
    name,
    "state",
    "worker.json",
  );
};

const recordsNamespace = (recordsRoot: string, repository: string): string => {
  const [owner, name] = repositoryParts(repository);
  return join(recordsRoot, "repositories", owner, name);
};

const allDistinct = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const allPathsDistinct = (values: readonly string[]): boolean =>
  new Set(values.map((value) => resolve(value))).size === values.length;

const evidenceFor = (attempt: ExecutionAttempt): readonly string[] =>
  attempt.outcomes.flatMap((outcome) => outcome.evidence);

interface ArtifactFingerprint {
  readonly kind: "file" | "symlink";
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly digest?: string;
  readonly linkTarget?: string;
}

const isInspectableArtifact = (path: string, size: number): boolean =>
  size <= 256 * 1024 &&
  !path.includes(`${join(".git", "objects")}${sep}`) &&
  !path.includes(`${sep}node_modules${sep}`);

const sameFingerprint = (
  left: ArtifactFingerprint | undefined,
  right: ArtifactFingerprint | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.kind === right.kind &&
  left.size === right.size &&
  left.modifiedAtMs === right.modifiedAtMs &&
  left.digest === right.digest &&
  left.linkTarget === right.linkTarget;

const snapshotFiles = async (
  roots: readonly string[],
): Promise<ReadonlyMap<string, ArtifactFingerprint>> => {
  const files = new Map<string, ArtifactFingerprint>();
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          const metadata = await stat(path);
          const digest = isInspectableArtifact(path, metadata.size)
            ? createHash("sha256")
                .update(await readFile(path))
                .digest("hex")
            : undefined;
          files.set(resolve(path), {
            kind: "file",
            size: metadata.size,
            modifiedAtMs: metadata.mtimeMs,
            ...(digest === undefined ? {} : { digest }),
          });
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(path);
          files.set(resolve(path), {
            kind: "symlink",
            size: Buffer.byteLength(target),
            modifiedAtMs: 0,
            digest: createHash("sha256").update(target).digest("hex"),
            linkTarget: resolve(dirname(path), target),
          });
        }
      }),
    );
  };
  await Promise.all(roots.map(visit));
  return files;
};

const changedFiles = (
  before: ReadonlyMap<string, ArtifactFingerprint>,
  after: ReadonlyMap<string, ArtifactFingerprint>,
): readonly string[] => {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => !sameFingerprint(before.get(path), after.get(path)))
    .sort();
};

const changedFilesOutside = (
  before: ReadonlyMap<string, ArtifactFingerprint>,
  after: ReadonlyMap<string, ArtifactFingerprint>,
  allowedRoots: readonly string[],
): readonly string[] =>
  changedFiles(before, after).filter(
    (path) => !allowedRoots.some((root) => isWithinOrSame(root, path)),
  );

const assertAttemptEvidence = (
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): void => {
  const verified = run.attempt.outcomes.find(
    (outcome) => outcome.status === "verified",
  );
  const published = run.attempt.outcomes.find(
    (outcome) => outcome.status === "published",
  );
  if (
    run.attempt.status !== "published" ||
    run.attempt.executionIdentity !== request.executionIdentity ||
    !sameJson(run.attempt.request, request) ||
    verified === undefined ||
    !verified.evidence.includes(run.execution.recordPath) ||
    published === undefined ||
    !published.evidence.includes(run.execution.recordPath) ||
    !published.evidence.includes(run.publication.pullRequest.url)
  ) {
    fail(
      `Attempt evidence for ${request.taskId} is not immutable.`,
      "evidence_mismatch",
    );
  }
};

const assertExecutionEvidence = (
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): void => {
  const execution = run.execution;
  const repository = normalizeRepository(request.task.repository);
  if (
    execution.status !== "verified" ||
    execution.published !== false ||
    execution.attemptId !== run.attempt.attemptId ||
    execution.taskId !== request.taskId ||
    execution.executionIdentity !== request.executionIdentity ||
    normalizeRepository(execution.repository) !== repository ||
    execution.profileId !== request.profileId ||
    execution.profileDigest !== request.profileDigest ||
    execution.promptVersion !== request.promptVersion ||
    execution.promptTemplateDigest !== request.promptTemplateDigest ||
    execution.branch !== workerBranchFor(request) ||
    execution.repositoryDir !== run.paths.repositoryDir ||
    execution.worktreePath !== run.paths.worktreePath ||
    execution.repositoryCredentialNames === undefined ||
    execution.repositoryCredentialNames.length > 0 ||
    execution.agent?.logFilePath !== run.paths.runLogPath ||
    execution.verification.length !==
      request.profile.verificationCommands.length ||
    execution.verification.some(
      (result, index) =>
        result.command !== request.profile.verificationCommands[index] ||
        result.phase !== "verification" ||
        result.exitCode !== 0,
    )
  ) {
    fail(
      `Execution evidence for ${request.taskId} is inconsistent.`,
      "evidence_mismatch",
    );
  }
};

const assertPublicationEvidence = (
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): void => {
  const publication = run.publication;
  const branch = workerBranchFor(request);
  const headCommit = run.execution.commits.at(-1)?.sha.toLowerCase();
  if (
    publication.attemptId !== run.attempt.attemptId ||
    publication.executionIdentity !== request.executionIdentity ||
    normalizeRepository(publication.repository) !==
      normalizeRepository(request.task.repository) ||
    publication.branch !== branch ||
    publication.pullRequest.draft !== true ||
    publication.pullRequest.head !== branch ||
    publication.pullRequest.base !== request.task.baseBranch ||
    publication.pullRequest.headSha.toLowerCase() !==
      publication.branchSha.toLowerCase() ||
    headCommit === undefined ||
    publication.branchSha.toLowerCase() !== headCommit
  ) {
    fail(
      `Draft publication for ${request.taskId} is not traceable.`,
      "evidence_mismatch",
    );
  }
};

const assertQualifiedPaths = (
  input: CrossRepositoryAcceptanceEvidenceInput,
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): void => {
  const repository = normalizeRepository(request.task.repository);
  if (
    resolve(run.paths.repositoryDir) !==
      resolve(workerRepositoryDirectory(input.workspaceRoot, repository)) ||
    resolve(run.paths.stateFilePath) !==
      resolve(workerStateFilePath(input.workspaceRoot, repository)) ||
    !isWithin(run.paths.repositoryDir, run.paths.worktreePath) ||
    !isWithin(run.paths.repositoryDir, run.paths.runLogPath) ||
    !isWithin(
      join(
        recordsNamespace(input.recordsRoot, repository),
        "executions",
        request.executionIdentity,
      ),
      run.execution.recordPath,
    )
  ) {
    fail(
      `Paths for ${request.taskId} escape its repository namespace.`,
      "isolation_failure",
    );
  }
};

const readBackRun = async (
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): Promise<WorkerIsolationObservation> => {
  let retainedExecutionText: string;
  let retainedStateText: string;
  let runLogText: string;
  try {
    [retainedExecutionText, retainedStateText, runLogText] = await Promise.all([
      readFile(run.execution.recordPath, "utf8"),
      readFile(run.paths.stateFilePath, "utf8"),
      readFile(run.paths.runLogPath, "utf8"),
    ]);
    const [repositoryStat, gitDirectoryStat, worktreeStat, runLogStat] =
      await Promise.all([
        stat(run.paths.repositoryDir),
        stat(join(run.paths.repositoryDir, ".git")),
        stat(run.paths.worktreePath),
        stat(run.paths.runLogPath),
      ]);
    if (
      !repositoryStat.isDirectory() ||
      !gitDirectoryStat.isDirectory() ||
      !worktreeStat.isDirectory() ||
      !runLogStat.isFile()
    ) {
      throw new Error("wrong artifact type");
    }
  } catch {
    return fail(
      `Live cache, worktree, run log, state, or execution record for ${request.taskId} is missing.`,
      "evidence_mismatch",
    );
  }

  const retainedExecution = JSON.parse(retainedExecutionText) as unknown;
  const retainedState = JSON.parse(retainedStateText) as WorkerState;
  if (!sameJson(retainedExecution, run.execution)) {
    fail(
      `Execution record for ${request.taskId} changed after the run.`,
      "evidence_mismatch",
    );
  }
  const retainedAttempt = retainedState.attempts.find(
    (candidate) => candidate.attemptId === run.attempt.attemptId,
  );
  const repositories = [
    ...retainedState.taskSnapshots.map((snapshot) => snapshot.task.repository),
    ...retainedState.executionRequests.map(
      (record) => record.request.task.repository,
    ),
    ...retainedState.attempts.map((attempt) => attempt.request.task.repository),
  ].map(normalizeRepository);
  if (
    !sameJson(retainedAttempt, run.attempt) ||
    repositories.some(
      (repository) =>
        repository !== normalizeRepository(request.task.repository),
    )
  ) {
    fail(
      `Durable state for ${request.taskId} crossed a repository boundary.`,
      "isolation_failure",
    );
  }

  if (run.unexpectedArtifactPaths.length > 0) {
    fail(
      `Run ${request.taskId} changed artifacts outside its repository namespace.`,
      "isolation_failure",
    );
  }

  const inspectableChanges: string[] = [];
  const criticalArtifacts = [
    join(run.paths.repositoryDir, ".git", "config"),
    join(run.paths.repositoryDir, ".sandcastle", ".env"),
    join(run.paths.worktreePath, ".sandcastle", ".env"),
  ];
  for (const path of new Set([
    ...run.changedArtifactPaths,
    ...criticalArtifacts,
  ])) {
    try {
      const metadata = await stat(path);
      if (metadata.isFile() && isInspectableArtifact(path, metadata.size)) {
        inspectableChanges.push(await readFile(path, "utf8"));
      }
    } catch {
      // Deleted files are already represented by the path-diff isolation check.
    }
  }
  const serializedArtifacts = `${retainedExecutionText}\n${retainedStateText}\n${runLogText}\n${inspectableChanges.join("\n")}`;
  if (containsProtectedWorkerMaterial(serializedArtifacts)) {
    fail(
      `Credential or central configuration material leaked for ${request.taskId}.`,
      "isolation_failure",
    );
  }
  return {
    observedCredentialNames: [],
    observedWorkerConfiguration: false,
    unexpectedArtifactPaths: run.unexpectedArtifactPaths,
  };
};

const validateRun = async (
  input: CrossRepositoryAcceptanceEvidenceInput,
  request: ExecutionRequest,
  run: CrossRepositoryAcceptanceRun,
): Promise<RetainedAcceptanceRun> => {
  assertAttemptEvidence(request, run);
  assertExecutionEvidence(request, run);
  assertPublicationEvidence(request, run);
  assertQualifiedPaths(input, request, run);
  const isolationObservation = await readBackRun(request, run);
  return {
    repository: normalizeRepository(request.task.repository),
    taskId: request.taskId,
    snapshot: request.task,
    executionIdentity: request.executionIdentity,
    attemptId: run.attempt.attemptId,
    profileId: request.profileId,
    profileDigest: request.profileDigest,
    paths: run.paths,
    recordPath: run.execution.recordPath,
    branch: workerBranchFor(request),
    commits: run.execution.commits,
    verification: run.execution.verification.map(({ command, exitCode }) => ({
      command,
      exitCode,
    })),
    evidence: [...new Set(evidenceFor(run.attempt))],
    pullRequest: run.publication.pullRequest,
    isolationObservation,
  };
};

const evaluateAcceptanceScenario = (input: {
  readonly initialConfiguration: WorkerConfiguration;
  readonly authorizedConfiguration: WorkerConfiguration;
  readonly approvedTasks: readonly [NormalizedTask, NormalizedTask];
  readonly thirdPartyTask: NormalizedTask;
  readonly thirdPartySibling: NormalizedTask;
}): EvaluatedAcceptanceScenario => {
  const [firstApproved, secondApproved] = input.approvedTasks;
  if (
    normalizeRepository(firstApproved.repository) ===
      normalizeRepository(secondApproved.repository) ||
    firstApproved.number !== secondApproved.number ||
    firstApproved.kind !== secondApproved.kind
  ) {
    fail(
      "The acceptance proof requires equal task numbers in two different approved repositories.",
      "invalid_scenario",
    );
  }
  if (
    normalizeRepository(input.thirdPartyTask.repository) !==
      normalizeRepository(input.thirdPartySibling.repository) ||
    workerTaskId(input.thirdPartyTask) === workerTaskId(input.thirdPartySibling)
  ) {
    fail(
      "The third-party acceptance tasks must be distinct siblings in one repository.",
      "invalid_scenario",
    );
  }

  const tasks = [
    firstApproved,
    secondApproved,
    input.thirdPartyTask,
    input.thirdPartySibling,
  ];
  const initial = runWorkerDryRun({
    configuration: input.initialConfiguration,
    tasks,
  });
  const authorized = runWorkerDryRun({
    configuration: input.authorizedConfiguration,
    tasks,
  });
  const initialAuthorization = decisionFor(
    initial.decisions,
    input.thirdPartyTask,
  );
  const authorizedDecision = decisionFor(
    authorized.decisions,
    input.thirdPartyTask,
  );
  const siblingDecision = decisionFor(
    authorized.decisions,
    input.thirdPartySibling,
  );
  if (
    initialAuthorization.eligible ||
    initialAuthorization.reasonCode !== "unauthorized_repository" ||
    initialAuthorization.authorization !== "none" ||
    !authorizedDecision.eligible ||
    authorizedDecision.authorization !== "task" ||
    siblingDecision.eligible ||
    siblingDecision.reasonCode !== "unauthorized_repository" ||
    siblingDecision.authorization !== "none"
  ) {
    fail(
      "The evidence does not prove initial rejection, exact-task authorization, and continued sibling rejection.",
      "authorization_boundary",
    );
  }

  const initialApproved = input.approvedTasks.map((task) =>
    decisionFor(initial.decisions, task),
  );
  const authorizedApproved = input.approvedTasks.map((task) =>
    decisionFor(authorized.decisions, task),
  );
  if (
    [...initialApproved, ...authorizedApproved].some(
      (decision) =>
        !decision.eligible || decision.authorization !== "repository",
    )
  ) {
    fail(
      "Both approved repository tasks must remain eligible.",
      "authorization_boundary",
    );
  }

  const requestedIds = new Set([
    workerTaskId(firstApproved),
    workerTaskId(secondApproved),
    workerTaskId(input.thirdPartyTask),
  ]);
  const requests = authorized.executionRequests.filter((request) =>
    requestedIds.has(request.taskId),
  );
  if (requests.length !== 3 || authorized.executionRequests.length !== 3) {
    fail(
      "The authorized scenario must emit exactly the two approved tasks and one exact third-party task.",
      "authorization_boundary",
    );
  }
  const firstRequest = requests.find(
    (request) => request.taskId === workerTaskId(firstApproved),
  );
  const secondRequest = requests.find(
    (request) => request.taskId === workerTaskId(secondApproved),
  );
  if (
    firstRequest === undefined ||
    secondRequest === undefined ||
    firstRequest.profileId === secondRequest.profileId ||
    firstRequest.profileDigest === secondRequest.profileDigest
  ) {
    fail(
      "Approved repositories must use independent execution profiles.",
      "isolation_failure",
    );
  }
  return {
    initialAuthorization,
    authorizedDecision,
    siblingDecision,
    requests: requests as unknown as EvaluatedAcceptanceScenario["requests"],
  };
};

const retainProof = async (
  proofPath: string,
  proof: CrossRepositoryAcceptanceProof,
): Promise<void> => {
  if (proofPath.trim() === "") {
    fail("proofPath must be non-empty.", "invalid_scenario");
  }
  await mkdir(dirname(proofPath), { recursive: true });
  const temporary = `${proofPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, proofPath);
};

/** Validate and atomically retain a live cross-repository authorization proof. */
const retainCrossRepositoryAcceptanceProof = async (
  input: CrossRepositoryAcceptanceEvidenceInput,
): Promise<CrossRepositoryAcceptanceProof> => {
  if (input.workspaceRoot.trim() === "" || input.recordsRoot.trim() === "") {
    fail(
      "workspaceRoot and recordsRoot must be non-empty.",
      "invalid_scenario",
    );
  }

  const runsByTaskId = new Map(
    input.runs.map((run) => [run.attempt.request.taskId, run] as const),
  );
  if (runsByTaskId.size !== input.runs.length) {
    fail("Acceptance runs contain a duplicate task.", "evidence_mismatch");
  }
  const runs = await Promise.all(
    input.scenario.requests.map((request) => {
      const run = runsByTaskId.get(request.taskId);
      if (run === undefined) {
        return fail(
          `Acceptance run for ${request.taskId} is missing.`,
          "evidence_mismatch",
        );
      }
      return validateRun(input, request, run);
    }),
  );

  const pathCollections = [
    runs.map((run) => run.paths.stateFilePath),
    runs.map((run) => run.paths.repositoryDir),
    runs.map((run) => run.paths.worktreePath),
    runs.map((run) => run.paths.runLogPath),
    runs.map((run) => run.recordPath),
  ];
  if (
    !allDistinct(runs.map((run) => run.taskId)) ||
    !allDistinct(runs.map((run) => run.executionIdentity)) ||
    !allDistinct(runs.map((run) => run.attemptId)) ||
    !allDistinct(runs.map((run) => run.branch)) ||
    !allDistinct(runs.map((run) => run.pullRequest.url)) ||
    pathCollections.some((paths) => !allPathsDistinct(paths))
  ) {
    fail(
      "Acceptance tasks collided in identity, attempt, branch, publication, or repository-qualified state.",
      "isolation_failure",
    );
  }

  const proof: CrossRepositoryAcceptanceProof = {
    version: 1,
    kind: "cross-repository-authorization-and-isolation",
    createdAt: input.createdAt ?? new Date().toISOString(),
    initialAuthorization: input.scenario.initialAuthorization,
    authorizedDecision: input.scenario.authorizedDecision,
    siblingDecision: input.scenario.siblingDecision,
    runs,
    isolation: {
      repositories: runs.map((run) => run.repository),
      credentialsObserved: false,
      workerConfigurationObserved: false,
      unexpectedArtifactsObserved: false,
    },
  };
  await retainProof(input.proofPath, proof);
  return proof;
};

const taskFrom = (
  tasks: readonly NormalizedTask[],
  reference: TaskReference,
): NormalizedTask => {
  const taskId = workerTaskId(reference);
  const task = tasks.find((candidate) => workerTaskId(candidate) === taskId);
  if (task === undefined) {
    return fail(
      `Live GitHub discovery did not return ${taskId}.`,
      "invalid_scenario",
    );
  }
  return task;
};

/**
 * Execute the live cross-repository scenario sequentially and retain its
 * read-back authorization, filesystem, state, execution, and publication proof.
 */
export const runCrossRepositoryAcceptanceProof = async (
  input: RunCrossRepositoryAcceptanceProofInput,
): Promise<CrossRepositoryAcceptanceProof> => {
  const account = input.source.account?.trim() ?? "";
  if (account === "") {
    fail(
      "Live acceptance requires a GitHub issue tracker with account-wide discovery.",
      "invalid_scenario",
    );
  }

  // This account-only read happens before a runtime is requested, so the
  // retained unauthorized decision cannot be preceded by checkout or execution.
  const authoredDiscoveries = await input.source.discover({
    configuration: input.initialConfiguration,
    exactTasks: [],
    includeConfiguredRepositories: false,
    includeAccountWide: true,
  });
  const authoredThirdPartyTask = taskFrom(
    authoredDiscoveries,
    input.thirdPartyTask,
  );
  if (authoredThirdPartyTask.author?.toLowerCase() !== account.toLowerCase()) {
    fail(
      `${workerTaskId(input.thirdPartyTask)} was not authored by configured account ${account}.`,
      "authorization_boundary",
    );
  }

  const discovered = await input.source.discover({
    configuration: input.initialConfiguration,
    exactTasks: [input.thirdPartySibling],
    includeConfiguredRepositories: true,
    includeAccountWide: true,
  });
  const approvedTasks = input.approvedTasks.map((reference) =>
    taskFrom(discovered, reference),
  ) as unknown as readonly [NormalizedTask, NormalizedTask];
  const thirdPartyTask = taskFrom(discovered, input.thirdPartyTask);
  const thirdPartySibling = taskFrom(discovered, input.thirdPartySibling);
  const scenario = evaluateAcceptanceScenario({
    initialConfiguration: input.initialConfiguration,
    authorizedConfiguration: input.authorizedConfiguration,
    approvedTasks,
    thirdPartyTask,
    thirdPartySibling,
  });

  const runs: CrossRepositoryAcceptanceRun[] = [];
  for (const request of scenario.requests) {
    const artifactRoots = [input.workspaceRoot, input.recordsRoot];
    const artifactsBefore = await snapshotFiles(artifactRoots);
    const runtime = await input.runtimeFor(request);
    if (
      resolve(runtime.stateFilePath) !==
      resolve(workerStateFilePath(input.workspaceRoot, request.task.repository))
    ) {
      fail(
        `Runtime state for ${request.taskId} is not repository-qualified.`,
        "isolation_failure",
      );
    }
    const repositoryDiscovery = runWorkerDryRun({
      configuration: input.authorizedConfiguration,
      tasks: [request.task],
    });
    await runtime.store.recordDiscovery(repositoryDiscovery, {
      discoveredAt: input.createdAt,
    });
    const claimed = await claimWorkerTask({
      source: input.source,
      store: runtime.store,
      configuration: input.authorizedConfiguration,
      request,
      owner: input.owner,
      leaseDurationMs: input.leaseDurationMs,
      claimedAt: input.createdAt,
    });
    const execution = await runtime.execution.execute(claimed);
    if (execution.status !== "verified") {
      fail(
        `Live execution ${execution.attemptId} was not verified.`,
        "evidence_mismatch",
      );
    }
    const publication = await runtime.publisher.publish(claimed.attemptId);
    const state = await runtime.store.read();
    const attempt = state.attempts.find(
      (candidate) => candidate.attemptId === claimed.attemptId,
    );
    if (attempt === undefined || attempt.status !== "published") {
      fail(
        `Live attempt ${claimed.attemptId} was not retained as published.`,
        "evidence_mismatch",
      );
    }
    if (
      execution.repositoryDir === undefined ||
      execution.worktreePath === undefined ||
      execution.agent?.logFilePath === undefined
    ) {
      fail(
        `Live execution ${claimed.attemptId} did not retain its cache, worktree, and run log paths.`,
        "evidence_mismatch",
      );
    }
    const repositoryDir = execution.repositoryDir!;
    const worktreePath = execution.worktreePath!;
    const runLogPath = execution.agent!.logFilePath!;
    const repository = normalizeRepository(request.task.repository);
    const artifactsAfter = await snapshotFiles(artifactRoots);
    const repositoryRoot = join(
      input.workspaceRoot,
      "repositories",
      ...repository.split("/"),
    );
    const unsafeSymlinks = [...artifactsAfter.entries()]
      .filter(([, fingerprint]) => fingerprint.kind === "symlink")
      .filter(([path]) => isWithinOrSame(repositoryRoot, path))
      .filter(([, fingerprint]) =>
        fingerprint.linkTarget === undefined
          ? true
          : !isWithinOrSame(repositoryRoot, fingerprint.linkTarget),
      )
      .map(([path]) => path);
    const unexpectedArtifactPaths = changedFilesOutside(
      artifactsBefore,
      artifactsAfter,
      [repositoryRoot, recordsNamespace(input.recordsRoot, repository)],
    );
    runs.push({
      paths: {
        stateFilePath: runtime.stateFilePath,
        repositoryDir,
        worktreePath,
        runLogPath,
      },
      attempt: attempt!,
      execution,
      publication,
      changedArtifactPaths: changedFiles(artifactsBefore, artifactsAfter),
      unexpectedArtifactPaths: [
        ...new Set([...unexpectedArtifactPaths, ...unsafeSymlinks]),
      ],
    });
  }

  return retainCrossRepositoryAcceptanceProof({
    proofPath: input.proofPath,
    workspaceRoot: input.workspaceRoot,
    recordsRoot: input.recordsRoot,
    scenario,
    runs: runs as unknown as readonly [
      CrossRepositoryAcceptanceRun,
      CrossRepositoryAcceptanceRun,
      CrossRepositoryAcceptanceRun,
    ],
    createdAt: input.createdAt,
  });
};
