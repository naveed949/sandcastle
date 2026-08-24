import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonDigest } from "./CanonicalJson.js";
import {
  digestPromptTemplate,
  runWorkerDryRun,
  workerTaskId,
  type AuthorizationSource,
  type EligibilityDecision,
  type ExecutionRequest,
  type NormalizedTask,
  type TaskReference,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";
import type {
  WorkerDiagnostic,
  WorkerOperationalState,
  WorkerServicePaths,
  WorkerServiceStatus,
} from "./WorkerService.js";
import type {
  AttemptOutcomeRecord,
  ExecutionAttempt,
  WorkerState,
  WorkerStateStore,
} from "./WorkerStateStore.js";

/** One event in the durable diagnostic journal, assigned by Mission Control. */
export interface MissionControlEventRecord {
  readonly id: number;
  readonly event: WorkerDiagnostic;
}

/** A repository-qualified task coordinate suitable for links and joins. */
export interface MissionControlTaskReference {
  readonly taskId: string;
  readonly repository: string;
  readonly kind: TaskReference["kind"];
  readonly number: number;
  readonly title?: string;
  readonly sourceRevision?: string;
  readonly sourceState?: NormalizedTask["state"];
}

/** The eligibility explanation retained for one task projection. */
export interface MissionControlEligibility {
  readonly eligible: boolean;
  readonly reasonCode: string;
  readonly reason: string;
}

/** A secret-free task inbox item rebuilt from worker state and diagnostics. */
export interface MissionControlTaskView {
  readonly version: 1;
  readonly taskId: string;
  readonly repository: string;
  readonly kind: TaskReference["kind"];
  readonly number: number;
  readonly title: string;
  readonly author?: string;
  readonly labels: readonly string[];
  /** Operational state is the state an operator sees in the inbox. */
  readonly state: WorkerOperationalState;
  readonly operationalState: WorkerOperationalState;
  /** Source state is the immutable issue-tracker state in the task snapshot. */
  readonly sourceState: NormalizedTask["state"];
  readonly authorizationSource: AuthorizationSource;
  readonly authorization: { readonly source: AuthorizationSource };
  readonly eligibility: MissionControlEligibility;
  readonly eligibilityReasonCode: string;
  readonly eligibilityReason: string;
  readonly sourceRevision: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly dependencies: readonly MissionControlTaskReference[];
  readonly parentPrd?: MissionControlTaskReference;
  readonly parentPrdContext?: MissionControlTaskReference;
  readonly profileId?: string;
  readonly profileDigest?: string;
  readonly profile?: { readonly id: string; readonly digest?: string };
  readonly promptVersion?: string;
  readonly promptTemplateDigest?: string;
  readonly prompt?: {
    readonly version: string;
    readonly digest?: string;
  };
  readonly executionIdentity?: string;
  readonly attemptIds: readonly string[];
  readonly lastEventId?: number;
  readonly lastEventAt?: string;
  readonly lastEventState?: WorkerOperationalState;
}

/** The task inbox returned by the versioned operator API. */
export interface MissionControlTaskInbox {
  readonly version: 1;
  readonly revision: number;
  readonly tasks: readonly MissionControlTaskView[];
}

/** One item in the deterministic queue emitted by the worker. */
export interface MissionControlQueueEntry {
  readonly position: number;
  readonly taskId: string;
  readonly repository: string;
  readonly kind: TaskReference["kind"];
  readonly number: number;
  readonly executionIdentity: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly state: "ready";
}

/** The queue projection; ordering is carried over from worker diagnostics. */
export interface MissionControlQueue {
  readonly version: 1;
  readonly revision: number;
  readonly source: "worker";
  readonly queue: readonly MissionControlQueueEntry[];
  readonly entries: readonly MissionControlQueueEntry[];
}

/** Safe lease metadata associated with an inspected attempt. */
export interface MissionControlClaimView {
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly owner: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly phase: "claimed" | "started";
  readonly refreshedTaskIds: readonly string[];
}

/** A constrained evidence reference; no raw path is returned. */
export interface MissionControlEvidenceReference {
  readonly id: string;
  readonly kind: "record" | "log" | "pull_request" | "reference";
  readonly available: boolean;
  readonly outcomeStatus: AttemptOutcomeRecord["status"];
  readonly timestamp: string;
  readonly url?: string;
  readonly reasonCode?: "not_retained" | "path_escape" | "unsupported";
}

/** One safe, ordered lifecycle event in an attempt timeline. */
export interface MissionControlAttemptTimelineEntry {
  readonly eventId: number | null;
  readonly timestamp: string;
  readonly state: WorkerOperationalState;
  readonly reasonCode?: string;
  readonly message: string;
}

/** Structured command evidence without access to arbitrary retained paths. */
export interface MissionControlCommandEvidence {
  readonly command: string;
  readonly phase: "setup" | "verification";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Safe projection of one retained execution record. */
export interface MissionControlExecutionInspection {
  readonly attemptId?: string;
  readonly taskId?: string;
  readonly executionIdentity?: string;
  readonly status: "interrupted" | "failed" | "verified";
  readonly failurePhase?: string;
  readonly error?: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly promptVersion: string;
  readonly promptTemplateDigest: string;
  readonly branch?: string;
  readonly commits: readonly { readonly sha: string }[];
  readonly setup: readonly MissionControlCommandEvidence[];
  readonly verification: readonly MissionControlCommandEvidence[];
  readonly agent?: {
    readonly iterations?: number;
    readonly completionSignal?: boolean;
    readonly branch?: string;
    readonly commits: readonly { readonly sha: string }[];
  };
  readonly cleanup?: { readonly preservedWorktree: boolean };
}

/** Full attempt inspection assembled from state, diagnostics, and records. */
export interface MissionControlAttemptView {
  readonly version: 1;
  readonly attemptId: string;
  readonly taskId: string;
  readonly executionIdentity: string;
  readonly status: ExecutionAttempt["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly task: MissionControlTaskView;
  readonly request: {
    readonly taskId: string;
    readonly executionIdentity: string;
    readonly sourceRevision: string;
    readonly baseBranch: string;
    readonly baseCommit: string;
    readonly profileId: string;
    readonly profileDigest: string;
    readonly profile: { readonly id: string; readonly digest: string };
    readonly promptVersion: string;
    readonly promptTemplateDigest: string;
    readonly prompt: { readonly version: string; readonly digest: string };
    readonly parentPrd?: MissionControlTaskReference;
    readonly parentPrdContext?: MissionControlTaskReference;
  };
  readonly claim?: MissionControlClaimView;
  readonly outcomes: readonly {
    readonly status: AttemptOutcomeRecord["status"];
    readonly timestamp: string;
    readonly evidence: readonly MissionControlEvidenceReference[];
  }[];
  readonly evidence: readonly MissionControlEvidenceReference[];
  readonly timeline: readonly MissionControlAttemptTimelineEntry[];
  readonly execution?: MissionControlExecutionInspection;
  readonly publication?: {
    readonly pullRequestUrls: readonly string[];
  };
  readonly recovery?: {
    readonly expired: boolean;
    readonly disposition: "safe_retry" | "manual_intervention";
  };
}

/** The summary returned by the attempt collection endpoint. */
export type MissionControlAttemptSummary = Pick<
  MissionControlAttemptView,
  | "version"
  | "attemptId"
  | "taskId"
  | "executionIdentity"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

/** JSON-safe retained evidence content. */
export interface MissionControlEvidenceContent {
  readonly version: 1;
  readonly id: string;
  readonly kind: MissionControlEvidenceReference["kind"];
  readonly record?: MissionControlExecutionInspection;
  readonly text?: string;
  readonly url?: string;
}

/** A disposable, read-only Mission Control projection. */
export interface MissionControlReadModel {
  getTaskInbox(): Promise<MissionControlTaskInbox>;
  getTask(taskId: string): Promise<MissionControlTaskView | undefined>;
  getQueue(): Promise<MissionControlQueue>;
  getAttempts(): Promise<readonly MissionControlAttemptSummary[]>;
  getAttempt(attemptId: string): Promise<MissionControlAttemptView | undefined>;
  getEvidence(
    evidenceId: string,
  ): Promise<MissionControlEvidenceContent | undefined>;
}

export interface MissionControlReadModelOptions {
  readonly configuration: WorkerConfiguration;
  readonly paths: WorkerServicePaths;
  readonly store: WorkerStateStore;
  readonly status: () => WorkerServiceStatus;
  readonly getEvents: () => Promise<readonly MissionControlEventRecord[]>;
}

interface Projection {
  readonly state: WorkerState;
  readonly events: readonly MissionControlEventRecord[];
  readonly tasks: readonly MissionControlTaskView[];
  readonly tasksById: ReadonlyMap<string, MissionControlTaskView>;
}

interface EvidenceTarget {
  readonly reference: MissionControlEvidenceReference;
  readonly raw: string;
  readonly root?: "records" | "repositories";
}

const OPERATIONAL_STATES: readonly WorkerOperationalState[] = [
  "discovered",
  "unauthorized",
  "ineligible",
  "ready",
  "claimed",
  "running",
  "blocked",
  "failed",
  "verified",
  "published",
];

const isOperationalState = (value: unknown): value is WorkerOperationalState =>
  typeof value === "string" &&
  (OPERATIONAL_STATES as readonly string[]).includes(value);

const safeText = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") return fallback;
  if (containsProtectedWorkerMaterial(value))
    return "[redacted protected material]";
  return value;
};

const redactDurablePaths = (
  value: string,
  paths: WorkerServicePaths,
): string => {
  let result = value;
  for (const root of [
    paths.recordsRoot,
    paths.repositoriesRoot,
    paths.workspaceRoot,
  ]) {
    if (root !== "") result = result.replaceAll(root, "[durable-root]");
  }
  return result;
};

const safeShortText = (
  value: unknown,
  fallback = "",
  paths?: WorkerServicePaths,
): string => {
  const safe = safeText(value, fallback);
  return (paths === undefined ? safe : redactDurablePaths(safe, paths)).slice(
    0,
    4_096,
  );
};

const taskIdFor = (task: TaskReference): string => workerTaskId(task);

const taskReference = (
  reference: TaskReference,
  snapshot?: NormalizedTask,
): MissionControlTaskReference => ({
  taskId: taskIdFor(reference),
  repository: reference.repository,
  kind: reference.kind,
  number: reference.number,
  ...(snapshot === undefined
    ? {}
    : {
        title: safeText(snapshot.title),
        sourceRevision: snapshot.sourceRevision,
        sourceState: snapshot.state,
      }),
});

const latestSnapshots = (state: WorkerState): readonly NormalizedTask[] => {
  const byId = new Map<
    string,
    { readonly task: NormalizedTask; readonly at: string }
  >();
  for (const snapshot of state.taskSnapshots) {
    const id = snapshot.taskId;
    const current = byId.get(id);
    if (
      current === undefined ||
      Date.parse(snapshot.discoveredAt) >= Date.parse(current.at)
    ) {
      byId.set(id, { task: snapshot.task, at: snapshot.discoveredAt });
    }
  }
  for (const attempt of state.attempts) {
    const id = attempt.request.taskId;
    if (!byId.has(id)) {
      byId.set(id, { task: attempt.request.task, at: attempt.createdAt });
    }
    for (const task of attempt.claim?.refreshedSnapshots ?? []) {
      const relatedId = taskIdFor(task);
      if (!byId.has(relatedId)) {
        byId.set(relatedId, { task, at: attempt.createdAt });
      }
    }
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value.task);
};

const latestAttemptByTask = (
  attempts: readonly ExecutionAttempt[],
): ReadonlyMap<string, ExecutionAttempt> => {
  const result = new Map<string, ExecutionAttempt>();
  for (const attempt of attempts) {
    const taskId = attempt.request.taskId;
    const current = result.get(taskId);
    if (
      current === undefined ||
      Date.parse(current.updatedAt) <= Date.parse(attempt.updatedAt)
    ) {
      result.set(taskId, attempt);
    }
  }
  return result;
};

const latestTaskEvents = (
  events: readonly MissionControlEventRecord[],
): ReadonlyMap<string, MissionControlEventRecord> => {
  const result = new Map<string, MissionControlEventRecord>();
  for (const event of events) {
    if (event.event.taskId !== undefined) {
      result.set(event.event.taskId, event);
    }
  }
  return result;
};

const latestDecisionEvents = (
  events: readonly MissionControlEventRecord[],
): ReadonlyMap<string, MissionControlEventRecord> => {
  const result = new Map<string, MissionControlEventRecord>();
  for (const event of events) {
    if (
      event.event.taskId !== undefined &&
      (event.event.authorizationSource !== undefined ||
        event.event.eligible !== undefined)
    ) {
      result.set(event.event.taskId, event);
    }
  }
  return result;
};

const requestMap = (
  state: WorkerState,
): ReadonlyMap<string, ExecutionRequest> => {
  const result = new Map<string, ExecutionRequest>();
  for (const record of state.executionRequests) {
    result.set(record.executionIdentity, record.request);
  }
  for (const attempt of state.attempts) {
    result.set(attempt.executionIdentity, attempt.request);
  }
  return result;
};

const fallbackAuthorization = (
  configuration: WorkerConfiguration,
  task: NormalizedTask,
): AuthorizationSource => {
  const repository = configuration.repositories[task.repository];
  if (repository?.authorized === true) return "repository";
  const id = taskIdFor(task);
  return configuration.authorizedTasks.some(
    (candidate) => taskIdFor(candidate) === id,
  )
    ? "task"
    : "none";
};

const fallbackState = (
  attempt: ExecutionAttempt | undefined,
  decision: EligibilityDecision | undefined,
): WorkerOperationalState => {
  if (attempt?.status === "published") return "published";
  if (attempt?.status === "verified") return "verified";
  if (attempt?.status === "failed") return "failed";
  if (attempt?.status === "interrupted") return "blocked";
  if (attempt?.status === "active") {
    return attempt.claim?.phase === "started" ? "running" : "claimed";
  }
  if (decision?.eligible === true) return "ready";
  if (decision?.reasonCode === "unauthorized_repository") return "unauthorized";
  if (
    decision?.reasonCode === "blocked" ||
    decision?.reasonCode === "unmet_dependency"
  ) {
    return "blocked";
  }
  return decision === undefined ? "discovered" : "ineligible";
};

const decisionResult = (
  configuration: WorkerConfiguration,
  tasks: readonly NormalizedTask[],
): {
  readonly decisions: ReadonlyMap<string, EligibilityDecision>;
  readonly requests: ReadonlyMap<string, ExecutionRequest>;
} => {
  try {
    const result = runWorkerDryRun({ configuration, tasks });
    return {
      decisions: new Map(
        result.decisions.map((decision) => [decision.taskId, decision]),
      ),
      requests: new Map(
        result.executionRequests.map((request) => [
          request.executionIdentity,
          request,
        ]),
      ),
    };
  } catch {
    // A partially written or old read model must remain inspectable. Worker state
    // and diagnostic data still provide a safe, less detailed projection.
    return { decisions: new Map(), requests: new Map() };
  }
};

const requestFor = (
  task: NormalizedTask,
  decision: EligibilityDecision | undefined,
  attempt: ExecutionAttempt | undefined,
  requests: ReadonlyMap<string, ExecutionRequest>,
): ExecutionRequest | undefined => {
  if (attempt !== undefined) return attempt.request;
  if (decision?.executionIdentity !== undefined) {
    return requests.get(decision.executionIdentity);
  }
  return [...requests.values()].find(
    (request) => request.taskId === taskIdFor(task),
  );
};

const profileValues = (
  configuration: WorkerConfiguration,
  task: NormalizedTask,
  request: ExecutionRequest | undefined,
): {
  readonly profileId?: string;
  readonly profileDigest?: string;
  readonly promptVersion?: string;
  readonly promptTemplateDigest?: string;
} => {
  if (request !== undefined) {
    return {
      profileId: request.profileId,
      profileDigest: request.profileDigest,
      promptVersion: request.promptVersion,
      promptTemplateDigest: request.promptTemplateDigest,
    };
  }
  const policy = configuration.repositories[task.repository];
  const profileId = policy?.profileId;
  const profile =
    profileId === undefined ? undefined : configuration.profiles[profileId];
  return {
    ...(profileId === undefined ? {} : { profileId }),
    ...(profile === undefined
      ? {}
      : { profileDigest: canonicalJsonDigest(profile) }),
    promptVersion: configuration.promptVersion,
    promptTemplateDigest: digestPromptTemplate(
      configuration.promptTemplates[configuration.promptVersion] ?? "",
    ),
  };
};

const eligibilityFor = (
  decision: EligibilityDecision | undefined,
  request: ExecutionRequest | undefined,
  decisionEvent: MissionControlEventRecord | undefined,
): MissionControlEligibility => {
  if (decisionEvent !== undefined) {
    return {
      eligible:
        decisionEvent.event.eligible ??
        decision?.eligible ??
        request !== undefined,
      reasonCode:
        decisionEvent.event.reasonCode ??
        decision?.reasonCode ??
        (request === undefined ? "not_reconstructed" : "eligible"),
      reason: safeShortText(
        decisionEvent.event.message,
        decision?.reason ?? "Task decision retained by the worker.",
      ),
    };
  }

  if (decision !== undefined) {
    return {
      eligible: decision.eligible,
      reasonCode: decision.reasonCode,
      reason: safeShortText(decision.reason),
    };
  }

  if (request !== undefined) {
    return {
      eligible: true,
      reasonCode: "eligible",
      reason: "Task is authorized and ready.",
    };
  }

  return {
    eligible: false,
    reasonCode: "not_reconstructed",
    reason: "The worker decision is not retained in the available diagnostics.",
  };
};

const projectTask = (
  configuration: WorkerConfiguration,
  task: NormalizedTask,
  attempt: ExecutionAttempt | undefined,
  decision: EligibilityDecision | undefined,
  request: ExecutionRequest | undefined,
  event: MissionControlEventRecord | undefined,
  decisionEvent: MissionControlEventRecord | undefined,
  snapshotsById: ReadonlyMap<string, NormalizedTask>,
  attemptIdsByTask: ReadonlyMap<string, readonly string[]>,
): MissionControlTaskView => {
  const id = taskIdFor(task);
  const profile = profileValues(configuration, task, request);
  const authorizationSource =
    decisionEvent?.event.authorizationSource ??
    decision?.authorization ??
    fallbackAuthorization(configuration, task);
  const eligibility = eligibilityFor(decision, request, decisionEvent);
  const dependencies = task.dependencies.map((dependency) =>
    taskReference(dependency, snapshotsById.get(taskIdFor(dependency))),
  );
  const parentPrd =
    task.parentPrd === undefined
      ? undefined
      : taskReference(
          task.parentPrd,
          snapshotsById.get(taskIdFor(task.parentPrd)),
        );
  const state =
    event !== undefined && isOperationalState(event.event.state)
      ? event.event.state
      : fallbackState(attempt, decision);
  return {
    version: 1,
    taskId: id,
    repository: task.repository,
    kind: task.kind,
    number: task.number,
    title: safeText(task.title),
    ...(task.author === undefined ? {} : { author: safeText(task.author) }),
    labels: task.labels.map((label) => safeText(label)),
    state,
    operationalState: state,
    sourceState: task.state,
    authorizationSource,
    authorization: { source: authorizationSource },
    eligibility,
    eligibilityReasonCode: eligibility.reasonCode,
    eligibilityReason: eligibility.reason,
    sourceRevision: task.sourceRevision,
    baseBranch: task.baseBranch,
    baseCommit: task.baseCommit,
    dependencies,
    ...(parentPrd === undefined ? {} : { parentPrd }),
    ...(parentPrd === undefined ? {} : { parentPrdContext: parentPrd }),
    ...profile,
    ...(profile.profileId === undefined
      ? {}
      : {
          profile: {
            id: profile.profileId,
            ...(profile.profileDigest === undefined
              ? {}
              : { digest: profile.profileDigest }),
          },
        }),
    ...(profile.promptVersion === undefined
      ? {}
      : {
          prompt: {
            version: profile.promptVersion,
            ...(profile.promptTemplateDigest === undefined
              ? {}
              : { digest: profile.promptTemplateDigest }),
          },
        }),
    ...(decisionEvent?.event.executionIdentity === undefined &&
    decision?.executionIdentity === undefined &&
    request === undefined
      ? {}
      : {
          executionIdentity:
            decisionEvent?.event.executionIdentity ??
            decision?.executionIdentity ??
            request?.executionIdentity,
        }),
    attemptIds: [...(attemptIdsByTask.get(id) ?? [])],
    ...(event === undefined
      ? {}
      : {
          lastEventId: event.id,
          lastEventAt: event.event.timestamp,
          lastEventState: event.event.state,
        }),
  };
};

const within = (candidate: string, root: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const hasTraversalSegment = (value: string): boolean =>
  value.split(/[\\/]/u).some((segment) => segment === "..");

const evidenceIdFor = (
  taskId: string,
  attemptId: string,
  executionIdentity: string,
  outcomeIndex: number,
  evidenceIndex: number,
  raw: string,
): string =>
  `evidence-${createHash("sha256")
    .update(
      `${taskId}\u0000${attemptId}\u0000${executionIdentity}\u0000${outcomeIndex}\u0000${evidenceIndex}\u0000${raw}`,
    )
    .digest("hex")
    .slice(0, 24)}`;

const githubPullRequestUrl = (
  raw: string,
  repository: string,
): string | undefined => {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !new RegExp(`^/${repository}/pull/[1-9][0-9]*$`, "u").test(url.pathname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

const classifyFile = async (
  raw: string,
  rootPath: string,
  root: "records" | "repositories",
): Promise<
  Pick<MissionControlEvidenceReference, "available" | "reasonCode"> & {
    readonly root?: EvidenceTarget["root"];
  }
> => {
  if (!isAbsolute(raw)) {
    return {
      available: false,
      reasonCode: hasTraversalSegment(raw) ? "path_escape" : "unsupported",
    };
  }
  if (hasTraversalSegment(raw)) {
    return { available: false, reasonCode: "path_escape" };
  }
  const absoluteRoot = resolve(rootPath);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(absoluteRoot);
    realFile = await realpath(raw);
  } catch {
    return { available: false, reasonCode: "not_retained" };
  }
  if (!within(realFile, realRoot)) {
    return { available: false, reasonCode: "path_escape" };
  }
  try {
    const fileStat = await stat(realFile);
    if (!fileStat.isFile())
      return { available: false, reasonCode: "unsupported" };
  } catch {
    return { available: false, reasonCode: "not_retained" };
  }
  return { available: true, root };
};

const evidenceTarget = async (
  raw: string,
  taskId: string,
  attempt: ExecutionAttempt,
  outcomeIndex: number,
  evidenceIndex: number,
  paths: WorkerServicePaths,
  outcome: AttemptOutcomeRecord,
): Promise<EvidenceTarget> => {
  const id = evidenceIdFor(
    taskId,
    attempt.attemptId,
    attempt.executionIdentity,
    outcomeIndex,
    evidenceIndex,
    raw,
  );
  const pullRequestUrl = githubPullRequestUrl(
    raw,
    attempt.request.task.repository,
  );
  if (pullRequestUrl !== undefined) {
    return {
      raw,
      reference: {
        id,
        kind: "pull_request",
        available: true,
        outcomeStatus: outcome.status,
        timestamp: outcome.timestamp,
        url: pullRequestUrl,
      },
    };
  }
  const record = await classifyFile(raw, paths.recordsRoot, "records");
  if (record.available || record.reasonCode === "path_escape") {
    return {
      raw,
      root: record.root,
      reference: {
        id,
        kind: "record",
        available: record.available,
        outcomeStatus: outcome.status,
        timestamp: outcome.timestamp,
        ...(record.reasonCode === undefined
          ? {}
          : { reasonCode: record.reasonCode }),
      },
    };
  }
  const log = await classifyFile(raw, paths.repositoriesRoot, "repositories");
  if (log.available || log.reasonCode === "path_escape") {
    return {
      raw,
      root: log.root,
      reference: {
        id,
        kind: "log",
        available: log.available,
        outcomeStatus: outcome.status,
        timestamp: outcome.timestamp,
        ...(log.reasonCode === undefined ? {} : { reasonCode: log.reasonCode }),
      },
    };
  }
  if (containsProtectedWorkerMaterial(raw)) {
    return {
      raw,
      reference: {
        id,
        kind: "reference",
        available: false,
        outcomeStatus: outcome.status,
        timestamp: outcome.timestamp,
        reasonCode: "unsupported",
      },
    };
  }
  return {
    raw,
    reference: {
      id,
      kind: "reference",
      available: true,
      outcomeStatus: outcome.status,
      timestamp: outcome.timestamp,
    },
  };
};

const commandEvidence = (
  value: unknown,
  paths: WorkerServicePaths,
): readonly MissionControlCommandEvidence[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.phase !== "setup" && candidate.phase !== "verification") ||
      typeof candidate.command !== "string" ||
      typeof candidate.exitCode !== "number"
    ) {
      return [];
    }
    return [
      {
        command: safeShortText(candidate.command, "", paths),
        phase: candidate.phase,
        exitCode: candidate.exitCode,
        stdout: safeShortText(candidate.stdout, "", paths),
        stderr: safeShortText(candidate.stderr, "", paths),
      },
    ];
  });
};

const executionInspection = (
  value: unknown,
  paths: WorkerServicePaths,
): MissionControlExecutionInspection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status !== "interrupted" &&
    candidate.status !== "failed" &&
    candidate.status !== "verified"
  ) {
    return undefined;
  }
  const commits = Array.isArray(candidate.commits)
    ? candidate.commits.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const sha = (item as Record<string, unknown>).sha;
        return typeof sha === "string" ? [{ sha }] : [];
      })
    : [];
  const agentValue = candidate.agent;
  const agent =
    typeof agentValue === "object" && agentValue !== null
      ? (agentValue as Record<string, unknown>)
      : undefined;
  const cleanupValue = candidate.cleanup;
  const cleanup =
    typeof cleanupValue === "object" && cleanupValue !== null
      ? {
          preservedWorktree:
            typeof (cleanupValue as Record<string, unknown>)
              .preservedWorktreePath === "string",
        }
      : undefined;
  return {
    ...(typeof candidate.attemptId === "string"
      ? { attemptId: safeText(candidate.attemptId) }
      : {}),
    ...(typeof candidate.taskId === "string"
      ? { taskId: safeText(candidate.taskId) }
      : {}),
    ...(typeof candidate.executionIdentity === "string"
      ? { executionIdentity: safeText(candidate.executionIdentity) }
      : {}),
    status: candidate.status,
    ...(typeof candidate.failurePhase === "string"
      ? { failurePhase: safeText(candidate.failurePhase) }
      : {}),
    ...(typeof candidate.error === "string"
      ? { error: safeShortText(candidate.error, "", paths) }
      : {}),
    repository: safeText(candidate.repository),
    baseCommit: safeText(candidate.baseCommit),
    profileId: safeText(candidate.profileId),
    profileDigest: safeText(candidate.profileDigest),
    promptVersion: safeText(candidate.promptVersion),
    promptTemplateDigest: safeText(candidate.promptTemplateDigest),
    ...(typeof candidate.branch === "string"
      ? { branch: safeText(candidate.branch) }
      : {}),
    commits,
    setup: commandEvidence(candidate.setup, paths),
    verification: commandEvidence(candidate.verification, paths),
    ...(agent === undefined
      ? {}
      : {
          agent: {
            ...(typeof agent.iterations === "number"
              ? { iterations: agent.iterations }
              : {}),
            ...(typeof agent.completionSignal === "boolean"
              ? { completionSignal: agent.completionSignal }
              : {}),
            ...(typeof agent.branch === "string"
              ? { branch: safeText(agent.branch) }
              : {}),
            commits: Array.isArray(agent.commits)
              ? agent.commits.flatMap((item) => {
                  if (typeof item !== "object" || item === null) return [];
                  const sha = (item as Record<string, unknown>).sha;
                  return typeof sha === "string" ? [{ sha }] : [];
                })
              : [],
          },
        }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
};

const sanitizedText = (value: string, paths: WorkerServicePaths): string =>
  safeShortText(value, "", paths);

const readExecutionRecord = async (
  target: EvidenceTarget,
  paths: WorkerServicePaths,
): Promise<MissionControlExecutionInspection | undefined> => {
  if (target.reference.kind !== "record" || !target.reference.available)
    return undefined;
  try {
    const retained = await classifyFile(
      target.raw,
      paths.recordsRoot,
      "records",
    );
    if (!retained.available) return undefined;
    const fileStat = await stat(target.raw);
    if (fileStat.size > 4 * 1024 * 1024) return undefined;
    const parsed: unknown = JSON.parse(await readFile(target.raw, "utf8"));
    return executionInspection(parsed, paths);
  } catch {
    return undefined;
  }
};

const projectAttempt = async (
  projection: Projection,
  attempt: ExecutionAttempt,
  options: MissionControlReadModelOptions,
): Promise<MissionControlAttemptView> => {
  const taskId = attempt.request.taskId;
  const task =
    projection.tasksById.get(taskId) ??
    projectTask(
      options.configuration,
      attempt.request.task,
      attempt,
      undefined,
      attempt.request,
      undefined,
      undefined,
      new Map([[taskId, attempt.request.task]]),
      new Map([[taskId, [attempt.attemptId]]]),
    );
  const parentPrd =
    attempt.request.context.parentPrd === undefined
      ? undefined
      : taskReference(
          attempt.request.context.parentPrd,
          latestSnapshots(projection.state).find(
            (candidate) =>
              taskIdFor(candidate) ===
              taskIdFor(attempt.request.context.parentPrd!),
          ),
        );
  const evidenceTargets: EvidenceTarget[] = [];
  const outcomes: MissionControlAttemptView["outcomes"][number][] = [];
  for (const [outcomeIndex, outcome] of attempt.outcomes.entries()) {
    const references: MissionControlEvidenceReference[] = [];
    for (const [evidenceIndex, raw] of outcome.evidence.entries()) {
      const target = await evidenceTarget(
        raw,
        taskId,
        attempt,
        outcomeIndex,
        evidenceIndex,
        options.paths,
        outcome,
      );
      evidenceTargets.push(target);
      references.push(target.reference);
    }
    outcomes.push({
      status: outcome.status,
      timestamp: outcome.timestamp,
      evidence: references,
    });
  }
  const uniqueEvidence = evidenceTargets.map((target) => target.reference);
  const recordTarget = evidenceTargets.find(
    (target) =>
      target.reference.kind === "record" && target.reference.available,
  );
  const execution =
    recordTarget === undefined
      ? undefined
      : await readExecutionRecord(recordTarget, options.paths);
  const eventTimeline: MissionControlAttemptTimelineEntry[] = projection.events
    .filter((event) => event.event.attemptId === attempt.attemptId)
    .map((event) => ({
      eventId: event.id,
      timestamp: event.event.timestamp,
      state: event.event.state,
      ...(event.event.reasonCode === undefined
        ? {}
        : { reasonCode: safeText(event.event.reasonCode) }),
      message: safeShortText(event.event.message, "", options.paths),
    }));
  const timeline = [...eventTimeline];
  if (
    attempt.claim !== undefined &&
    !timeline.some((entry) => entry.state === "claimed")
  ) {
    timeline.push({
      eventId: null,
      timestamp: attempt.claim.acquiredAt,
      state: "claimed",
      message: "Attempt claim retained by the worker.",
    });
  }
  for (const outcome of attempt.outcomes) {
    if (!timeline.some((entry) => entry.state === outcome.status)) {
      const state: WorkerOperationalState =
        outcome.status === "interrupted" ? "blocked" : outcome.status;
      timeline.push({
        eventId: null,
        timestamp: outcome.timestamp,
        state,
        message: `Attempt reached ${outcome.status}.`,
      });
    }
  }
  timeline.sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      (left.eventId ?? Number.MAX_SAFE_INTEGER) -
        (right.eventId ?? Number.MAX_SAFE_INTEGER),
  );
  const pullRequestUrls = uniqueEvidence.flatMap((evidence) =>
    evidence.kind === "pull_request" && evidence.url !== undefined
      ? [evidence.url]
      : [],
  );
  const request = attempt.request;
  const expired =
    attempt.status === "active" &&
    attempt.claim !== undefined &&
    Date.parse(attempt.claim.leaseExpiresAt) <= Date.now();
  return {
    version: 1,
    attemptId: attempt.attemptId,
    taskId,
    executionIdentity: attempt.executionIdentity,
    status: attempt.status,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    task,
    request: {
      taskId: request.taskId,
      executionIdentity: request.executionIdentity,
      sourceRevision: request.task.sourceRevision,
      baseBranch: request.task.baseBranch,
      baseCommit: request.task.baseCommit,
      profileId: request.profileId,
      profileDigest: request.profileDigest,
      profile: { id: request.profileId, digest: request.profileDigest },
      promptVersion: request.promptVersion,
      promptTemplateDigest: request.promptTemplateDigest,
      prompt: {
        version: request.promptVersion,
        digest: request.promptTemplateDigest,
      },
      ...(parentPrd === undefined ? {} : { parentPrd }),
      ...(parentPrd === undefined ? {} : { parentPrdContext: parentPrd }),
    },
    ...(attempt.claim === undefined
      ? {}
      : {
          claim: {
            taskId: attempt.claim.taskId,
            sourceRevision: attempt.claim.sourceRevision,
            owner: safeText(attempt.claim.owner),
            acquiredAt: attempt.claim.acquiredAt,
            leaseExpiresAt: attempt.claim.leaseExpiresAt,
            phase: attempt.claim.phase,
            refreshedTaskIds: (attempt.claim.refreshedSnapshots ?? []).map(
              taskIdFor,
            ),
          },
        }),
    outcomes,
    evidence: uniqueEvidence,
    timeline,
    ...(execution === undefined ? {} : { execution }),
    ...(pullRequestUrls.length === 0
      ? {}
      : { publication: { pullRequestUrls } }),
    ...(attempt.claim === undefined
      ? {}
      : {
          recovery: {
            expired,
            disposition:
              attempt.claim.phase === "claimed"
                ? ("safe_retry" as const)
                : ("manual_intervention" as const),
          },
        }),
  };
};

const readFileEvidence = async (
  target: EvidenceTarget,
  paths: WorkerServicePaths,
): Promise<MissionControlEvidenceContent | undefined> => {
  if (!target.reference.available) return undefined;
  if (target.reference.kind === "pull_request") {
    return {
      version: 1,
      id: target.reference.id,
      kind: target.reference.kind,
      ...(target.reference.url === undefined
        ? {}
        : { url: target.reference.url }),
    };
  }
  if (target.reference.kind === "record") {
    const record = await readExecutionRecord(target, paths);
    return record === undefined
      ? undefined
      : { version: 1, id: target.reference.id, kind: "record", record };
  }
  if (target.reference.kind === "log") {
    try {
      const retained = await classifyFile(
        target.raw,
        paths.repositoriesRoot,
        "repositories",
      );
      if (!retained.available) return undefined;
      const fileStat = await stat(target.raw);
      if (fileStat.size > 4 * 1024 * 1024) return undefined;
      return {
        version: 1,
        id: target.reference.id,
        kind: "log",
        text: sanitizedText(await readFile(target.raw, "utf8"), paths),
      };
    } catch {
      return undefined;
    }
  }
  return {
    version: 1,
    id: target.reference.id,
    kind: "reference",
  };
};

/** Create a read-only projection over authoritative worker state and evidence. */
export const createMissionControlReadModel = (
  options: MissionControlReadModelOptions,
): MissionControlReadModel => {
  const build = async (): Promise<Projection> => {
    const [state, events] = await Promise.all([
      options.store.read(),
      options.getEvents(),
    ]);
    const tasks = latestSnapshots(state);
    const snapshotsById = new Map(tasks.map((task) => [taskIdFor(task), task]));
    const attemptsByTask = latestAttemptByTask(state.attempts);
    const attemptIdsByTask = new Map<string, string[]>();
    for (const attempt of state.attempts) {
      const ids = attemptIdsByTask.get(attempt.request.taskId) ?? [];
      ids.push(attempt.attemptId);
      attemptIdsByTask.set(attempt.request.taskId, ids);
    }
    for (const ids of attemptIdsByTask.values()) ids.sort();
    const evaluated = decisionResult(options.configuration, tasks);
    const retainedRequests = requestMap(state);
    const requests = new Map(retainedRequests);
    for (const [identity, request] of evaluated.requests)
      requests.set(identity, request);
    const eventsByTask = latestTaskEvents(events);
    const decisionEventsByTask = latestDecisionEvents(events);
    const taskViews = tasks.map((task) => {
      const id = taskIdFor(task);
      const decision = evaluated.decisions.get(id);
      const attempt = attemptsByTask.get(id);
      const request = requestFor(task, decision, attempt, requests);
      return projectTask(
        options.configuration,
        task,
        attempt,
        decision,
        request,
        eventsByTask.get(id),
        decisionEventsByTask.get(id),
        snapshotsById,
        attemptIdsByTask,
      );
    });
    return {
      state,
      events,
      tasks: taskViews,
      tasksById: new Map(taskViews.map((task) => [task.taskId, task])),
    };
  };

  const getTaskInbox = async (): Promise<MissionControlTaskInbox> => {
    const projection = await build();
    return {
      version: 1,
      revision: options.status().revision,
      tasks: projection.tasks,
    };
  };

  const getTask = async (
    taskId: string,
  ): Promise<MissionControlTaskView | undefined> =>
    (await build()).tasksById.get(taskId);

  const getQueue = async (): Promise<MissionControlQueue> => {
    const projection = await build();
    const readyTasks = projection.tasks.filter(
      (task) => task.state === "ready" && task.executionIdentity !== undefined,
    );
    const latestReadyEvent = new Map<string, number>();
    for (const event of projection.events) {
      if (event.event.state === "ready" && event.event.taskId !== undefined) {
        latestReadyEvent.set(event.event.taskId, event.id);
      }
    }
    const retainedOrder = new Map<string, number>();
    for (const [
      index,
      record,
    ] of projection.state.executionRequests.entries()) {
      const taskId = record.request.taskId;
      if (!retainedOrder.has(taskId)) retainedOrder.set(taskId, index);
    }
    const ordered = [...readyTasks].sort((left, right) => {
      const leftOrder =
        latestReadyEvent.get(left.taskId) ??
        retainedOrder.get(left.taskId) ??
        Number.MAX_SAFE_INTEGER;
      const rightOrder =
        latestReadyEvent.get(right.taskId) ??
        retainedOrder.get(right.taskId) ??
        Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
    const entries = ordered.map((task, index) => ({
      position: index + 1,
      taskId: task.taskId,
      repository: task.repository,
      kind: task.kind,
      number: task.number,
      executionIdentity: task.executionIdentity!,
      sourceRevision: task.sourceRevision,
      title: task.title,
      state: "ready" as const,
    }));
    return {
      version: 1,
      revision: options.status().revision,
      source: "worker",
      queue: entries,
      entries,
    };
  };

  const getAttempts = async (): Promise<
    readonly MissionControlAttemptSummary[]
  > => {
    const projection = await build();
    return projection.state.attempts.map((attempt) => ({
      version: 1,
      attemptId: attempt.attemptId,
      taskId: attempt.request.taskId,
      executionIdentity: attempt.executionIdentity,
      status: attempt.status,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    }));
  };

  const getAttempt = async (
    attemptId: string,
  ): Promise<MissionControlAttemptView | undefined> => {
    const projection = await build();
    const attempt = projection.state.attempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    return attempt === undefined
      ? undefined
      : projectAttempt(projection, attempt, options);
  };

  const getEvidence = async (
    evidenceId: string,
  ): Promise<MissionControlEvidenceContent | undefined> => {
    const projection = await build();
    for (const attempt of projection.state.attempts) {
      const attemptView = await projectAttempt(projection, attempt, options);
      const evidenceIndex = attemptView.evidence.findIndex(
        (evidence) => evidence.id === evidenceId,
      );
      if (evidenceIndex < 0) continue;
      const targetOutcome = attempt.outcomes.flatMap((outcome, outcomeIndex) =>
        outcome.evidence.map((reference, referenceIndex) => ({
          reference,
          outcomeIndex,
          referenceIndex,
        })),
      )[evidenceIndex];
      if (targetOutcome === undefined) return undefined;
      const outcome = attempt.outcomes[targetOutcome.outcomeIndex]!;
      return readFileEvidence(
        await evidenceTarget(
          outcome.evidence[targetOutcome.referenceIndex]!,
          attempt.request.taskId,
          attempt,
          targetOutcome.outcomeIndex,
          targetOutcome.referenceIndex,
          options.paths,
          outcome,
        ),
        options.paths,
      );
    }
    return undefined;
  };

  return {
    getTaskInbox,
    getTask,
    getQueue,
    getAttempts,
    getAttempt,
    getEvidence,
  };
};
