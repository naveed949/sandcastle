import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RepositoryWorkflowCycleResult,
  RepositoryWorkflowDefinition,
  RepositoryWorkflowIssue,
  RepositoryWorkflowRuntime,
} from "./RepositoryWorkflowRuntime.js";

export type RepositoryWorkflowMode = "active" | "pausing" | "paused";

/** The recovery class retained for an interrupted repository workflow run. */
export type RepositoryWorkflowRecoveryDisposition =
  | "resumable"
  | "retryable"
  | "terminal"
  | "manual_intervention";

/** The lifecycle state of a durable repository workflow run. */
export type RepositoryWorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "manual_intervention";

/** A lease acquired before a repository workflow is dispatched. */
export interface RepositoryWorkflowClaim {
  readonly owner: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  /** No repository side effect may exist before `started`; `started` is recoverable only by policy. */
  readonly phase: "claimed" | "started";
}

/** The stable failure information used by queue backoff and Mission Control. */
export interface RepositoryWorkflowFailure {
  readonly code: string;
  readonly classification: "retryable" | "terminal" | "manual_intervention";
  readonly occurredAt: string;
}

export interface AuthorizedRepositoryWorkflow {
  readonly repository: string;
  readonly featureBranch: string;
  /** Workflow definition/version selected for this authorized repository. */
  readonly workflowId: string;
  /** Repository-qualified workflow identity; old state files may omit it. */
  readonly workflowIdentity?: string;
  readonly mode: RepositoryWorkflowMode;
  readonly nextCycle: number;
  readonly activeRunId?: string;
  /** Number of consecutive retryable failures. */
  readonly failureCount?: number;
  /** The earliest time at which a retryable failure may be scheduled. */
  readonly nextEligibleAt?: string;
  readonly lastCycleAt?: string;
  readonly lastSuccessfulCycleAt?: string;
  /** Stable sequence used for fair, deterministic global scheduling. */
  readonly lastScheduledSequence?: number;
  readonly lastFailure?: RepositoryWorkflowFailure;
  /** Safe, non-secret explanation for a paused or blocked workflow. */
  readonly blockingReason?: string;
}

export interface RepositoryWorkflowRunRecord {
  readonly id: string;
  readonly repository: string;
  readonly workflowId: string;
  readonly workflowIdentity?: string;
  /** Cycle selected by the transactional claim. */
  readonly cycle?: number;
  /** Store revision produced by the claim transaction. */
  readonly revision?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: RepositoryWorkflowRunStatus;
  readonly cycles: readonly RepositoryWorkflowCycleResult[];
  readonly owner?: string;
  readonly claim?: RepositoryWorkflowClaim;
  readonly recovery?: RepositoryWorkflowRecoveryDisposition;
  readonly failure?: RepositoryWorkflowFailure;
  readonly error?: string;
}

export interface RepositoryWorkflowState {
  readonly version: 1;
  /** Monotonic revision of the durable workflow state. */
  readonly revision: number;
  /** Monotonic scheduling sequence used as the fairness tie breaker. */
  readonly scheduleSequence?: number;
  readonly repositories: readonly AuthorizedRepositoryWorkflow[];
  readonly runs: readonly RepositoryWorkflowRunRecord[];
}

export interface RepositoryWorkflowStoreUpdateOptions {
  /** Reject the mutation unless this is the current persisted revision. */
  readonly expectedRevision?: number;
}

export interface RepositoryWorkflowStore {
  read(): Promise<RepositoryWorkflowState>;
  /** Apply and persist one mutation under a cross-process compare-and-set lock. */
  update(
    mutator: (state: RepositoryWorkflowState) => RepositoryWorkflowState,
    options?: RepositoryWorkflowStoreUpdateOptions,
  ): Promise<RepositoryWorkflowState>;
  /** Explicit compare-and-set spelling for callers that need the transaction boundary. */
  compareAndSet(
    expectedRevision: number,
    mutator: (state: RepositoryWorkflowState) => RepositoryWorkflowState,
  ): Promise<RepositoryWorkflowState>;
}

export interface RepositoryWorkflowStoreOptions {
  readonly filePath: string;
}

/** Raised when a workflow state transaction cannot be applied safely. */
export class RepositoryWorkflowStoreError extends Error {
  readonly code:
    | "invalid_state"
    | "stale_revision"
    | "conflict"
    | "not_found"
    | "lock_timeout";
  readonly expectedRevision?: number;
  readonly actualRevision?: number;

  constructor(
    message: string,
    code: RepositoryWorkflowStoreError["code"] = "invalid_state",
    details: {
      readonly expectedRevision?: number;
      readonly actualRevision?: number;
    } = {},
  ) {
    super(message);
    this.name = "RepositoryWorkflowStoreError";
    this.code = code;
    this.expectedRevision = details.expectedRevision;
    this.actualRevision = details.actualRevision;
  }
}

export interface AuthorizeRepositoryWorkflowInput extends RepositoryWorkflowStoreUpdateOptions {
  readonly repository: string;
  readonly featureBranch: string;
  readonly workflowId: string;
}

export interface RepositoryWorkflowMutationOptions extends RepositoryWorkflowStoreUpdateOptions {}

export interface RepositoryWorkflowRunOptions extends RepositoryWorkflowStoreUpdateOptions {
  readonly owner?: string;
  readonly leaseDurationMs?: number;
}

export interface RepositoryWorkflowInspection extends AuthorizedRepositoryWorkflow {
  /** Revision used to construct this inspection. */
  readonly revision?: number;
  readonly runs: readonly RepositoryWorkflowRunRecord[];
}

export interface RepositoryWorkflowQueueEntry {
  readonly position: number;
  readonly repository: string;
  readonly workflowId: string;
  readonly workflowIdentity: string;
  readonly cycle: number;
  readonly state:
    | "ready"
    | "claimed"
    | "backoff"
    | "paused"
    | "manual_intervention"
    | "terminal";
  readonly nextEligibleAt?: string;
  readonly lastScheduledSequence?: number;
}

export interface RepositoryWorkflowProjectionTask {
  readonly taskId: string;
  readonly repository: string;
  readonly kind: "issue";
  readonly number: number;
  readonly title: string;
  readonly stage: string;
}

/** Initial safe projection supplied to Mission Control from durable workflow state. */
export interface RepositoryWorkflowProjectionEntry {
  readonly repository: string;
  readonly workflowId: string;
  readonly workflowIdentity: string;
  readonly revision: number;
  readonly stage:
    | "ready"
    | "claimed"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "manual_intervention"
    | "paused"
    | "backoff"
    | "terminal";
  readonly runId?: string;
  readonly task?: RepositoryWorkflowProjectionTask;
  readonly owner?: string;
  readonly claimedAt?: string;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly blockingReason?: string;
  readonly recovery?: RepositoryWorkflowRecoveryDisposition;
}

export interface RepositoryWorkflowRecovery {
  readonly repository: string;
  readonly workflowIdentity: string;
  readonly runId: string;
  readonly disposition: RepositoryWorkflowRecoveryDisposition;
  readonly reasonCode: string;
  readonly recoveredAt: string;
}

export interface RepositoryWorkflowProjection {
  readonly version: 1;
  readonly revision: number;
  readonly generatedAt: string;
  readonly repositories: readonly RepositoryWorkflowProjectionEntry[];
  /** Ready entries only, ordered by the authoritative scheduler. */
  readonly queue: readonly RepositoryWorkflowQueueEntry[];
  readonly entries: readonly RepositoryWorkflowQueueEntry[];
}

export interface RepositoryWorkflowControl {
  authorize(input: AuthorizeRepositoryWorkflowInput): Promise<void>;
  remove(
    repository: string,
    options?: RepositoryWorkflowMutationOptions,
  ): Promise<void>;
  list(): Promise<readonly AuthorizedRepositoryWorkflow[]>;
  inspect(
    repository: string,
  ): Promise<RepositoryWorkflowInspection | undefined>;
  runNow(
    repository: string,
    signal?: AbortSignal,
    options?: RepositoryWorkflowRunOptions,
  ): Promise<RepositoryWorkflowRunRecord>;
  pause(
    repository: string,
    options?: RepositoryWorkflowMutationOptions,
  ): Promise<void>;
  resume(
    repository: string,
    options?: RepositoryWorkflowMutationOptions,
  ): Promise<void>;
  /** Reconcile expired durable claims after startup or an operator request. */
  readonly recover?: (options?: {
    readonly at?: string;
    readonly expectedRevision?: number;
  }) => Promise<readonly RepositoryWorkflowRecovery[]>;
  /** Return the authoritative queue and initial Mission Control projection. */
  readonly getProjection?: () => Promise<RepositoryWorkflowProjection>;
}

export interface RepositoryWorkflowControlOptions {
  readonly store: RepositoryWorkflowStore;
  readonly runtime: RepositoryWorkflowRuntime;
  readonly workflows: Readonly<Record<string, RepositoryWorkflowDefinition>>;
  readonly now?: () => string;
  readonly createId?: () => string;
  /** Stable process identity persisted in active claims. */
  readonly owner?: string;
  /** Lease duration for a repository workflow claim. */
  readonly leaseDurationMs?: number;
  /** First retry delay for classified transient failures. */
  readonly retryBaseDelayMs?: number;
  /** Maximum retry delay for classified transient failures. */
  readonly retryMaxDelayMs?: number;
  /** Classify runtime failures into queue recovery policy. */
  readonly classifyError?: (
    error: unknown,
  ) => "retryable" | "terminal" | "manual_intervention";
}

const emptyState = (): RepositoryWorkflowState => ({
  version: 1,
  revision: 0,
  scheduleSequence: 0,
  repositories: [],
  runs: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const repositoryWorkflowIdentity = (
  repository: string,
  workflowId: string,
): string => `${repository}:${workflowId}`;

const normalizeRepository = (repository: string): string => {
  const normalized = repository.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized))
    throw new Error("repository must be owner/name.");
  return normalized;
};

const normalizeWorkflowIdentity = (
  repository: string,
  workflowId: string,
  identity: string | undefined,
): string =>
  identity?.trim() || repositoryWorkflowIdentity(repository, workflowId);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string => {
  if (isRecord(error) && typeof error.code === "string") {
    const code = error.code.trim();
    if (/^[a-z0-9_.-]+$/u.test(code)) return code;
  }
  return "runtime_failure";
};

const throwIfWorkflowCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Repository workflow was cancelled.");
};

const ensureTimestamp = (timestamp: string, context: string): string => {
  if (timestamp.trim() === "" || Number.isNaN(Date.parse(timestamp))) {
    throw new RepositoryWorkflowStoreError(
      `${context} must be a valid timestamp.`,
    );
  }
  return timestamp;
};

const isExpired = (claim: RepositoryWorkflowClaim, at: string): boolean =>
  Date.parse(claim.leaseExpiresAt) <= Date.parse(at);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeFailure = (
  value: unknown,
): RepositoryWorkflowFailure | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.code !== "string" ||
    (value.classification !== "retryable" &&
      value.classification !== "terminal" &&
      value.classification !== "manual_intervention") ||
    typeof value.occurredAt !== "string"
  ) {
    return undefined;
  }
  return {
    code: value.code,
    classification: value.classification,
    occurredAt: value.occurredAt,
  };
};

const normalizeClaim = (
  value: unknown,
): RepositoryWorkflowClaim | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.owner !== "string" ||
    typeof value.acquiredAt !== "string" ||
    typeof value.leaseExpiresAt !== "string" ||
    (value.phase !== "claimed" && value.phase !== "started") ||
    Number.isNaN(Date.parse(value.acquiredAt)) ||
    Number.isNaN(Date.parse(value.leaseExpiresAt))
  ) {
    return undefined;
  }
  return {
    owner: value.owner,
    acquiredAt: value.acquiredAt,
    leaseExpiresAt: value.leaseExpiresAt,
    phase: value.phase,
  };
};

const normalizeState = (value: unknown): RepositoryWorkflowState => {
  if (!isRecord(value) || value.version !== 1) {
    throw new RepositoryWorkflowStoreError(
      "Repository workflow state does not match version 1.",
    );
  }
  if (!Array.isArray(value.repositories) || !Array.isArray(value.runs)) {
    throw new RepositoryWorkflowStoreError(
      "Repository workflow state must contain repositories and runs arrays.",
    );
  }
  const revision = value.revision ?? 0;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    throw new RepositoryWorkflowStoreError(
      "Repository workflow state revision must be a non-negative integer.",
    );
  }
  const repositories: AuthorizedRepositoryWorkflow[] = [];
  const repositoryKeys = new Set<string>();
  for (const candidate of value.repositories) {
    if (!isRecord(candidate)) {
      throw new RepositoryWorkflowStoreError(
        "Repository workflow state contains an invalid repository.",
      );
    }
    const repository = normalizeRepository(String(candidate.repository ?? ""));
    const workflowId = String(candidate.workflowId ?? "").trim();
    const featureBranch = String(candidate.featureBranch ?? "").trim();
    if (workflowId === "" || featureBranch === "") {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow ${repository} is missing workflow or branch configuration.`,
      );
    }
    if (repositoryKeys.has(repository)) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow state contains duplicate repository ${repository}.`,
        "conflict",
      );
    }
    repositoryKeys.add(repository);
    const mode = candidate.mode;
    if (mode !== "active" && mode !== "pausing" && mode !== "paused") {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow ${repository} has an invalid mode.`,
      );
    }
    const nextCycle = candidate.nextCycle ?? 1;
    if (
      typeof nextCycle !== "number" ||
      !Number.isInteger(nextCycle) ||
      nextCycle < 1
    ) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow ${repository} has an invalid cycle.`,
      );
    }
    const failureCount = candidate.failureCount ?? 0;
    if (
      typeof failureCount !== "number" ||
      !Number.isInteger(failureCount) ||
      failureCount < 0
    ) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow ${repository} has an invalid failure count.`,
      );
    }
    const lastFailure = normalizeFailure(candidate.lastFailure);
    repositories.push({
      repository,
      featureBranch,
      workflowId,
      workflowIdentity: normalizeWorkflowIdentity(
        repository,
        workflowId,
        typeof candidate.workflowIdentity === "string"
          ? candidate.workflowIdentity
          : undefined,
      ),
      mode,
      nextCycle,
      ...(typeof candidate.activeRunId === "string"
        ? { activeRunId: candidate.activeRunId }
        : {}),
      failureCount,
      ...(typeof candidate.nextEligibleAt === "string"
        ? { nextEligibleAt: candidate.nextEligibleAt }
        : {}),
      ...(typeof candidate.lastCycleAt === "string"
        ? { lastCycleAt: candidate.lastCycleAt }
        : {}),
      ...(typeof candidate.lastSuccessfulCycleAt === "string"
        ? { lastSuccessfulCycleAt: candidate.lastSuccessfulCycleAt }
        : {}),
      ...(typeof candidate.lastScheduledSequence === "number"
        ? { lastScheduledSequence: candidate.lastScheduledSequence }
        : {}),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      ...(typeof candidate.blockingReason === "string"
        ? { blockingReason: candidate.blockingReason }
        : {}),
    });
  }

  const runs: RepositoryWorkflowRunRecord[] = [];
  const runKeys = new Set<string>();
  for (const candidate of value.runs) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      throw new RepositoryWorkflowStoreError(
        "Repository workflow state contains an invalid run.",
      );
    }
    if (runKeys.has(candidate.id)) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow state contains duplicate run ${candidate.id}.`,
        "conflict",
      );
    }
    runKeys.add(candidate.id);
    const repository = normalizeRepository(String(candidate.repository ?? ""));
    const workflowId = String(candidate.workflowId ?? "").trim();
    const startedAt = String(candidate.startedAt ?? "");
    if (
      workflowId === "" ||
      Number.isNaN(Date.parse(startedAt)) ||
      !Array.isArray(candidate.cycles)
    ) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow run ${candidate.id} is invalid.`,
      );
    }
    const status = candidate.status;
    if (
      status !== "running" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "interrupted" &&
      status !== "manual_intervention"
    ) {
      throw new RepositoryWorkflowStoreError(
        `Repository workflow run ${candidate.id} has an invalid status.`,
      );
    }
    const claim = normalizeClaim(candidate.claim);
    const failure = normalizeFailure(candidate.failure);
    runs.push({
      id: candidate.id,
      repository,
      workflowId,
      workflowIdentity: normalizeWorkflowIdentity(
        repository,
        workflowId,
        typeof candidate.workflowIdentity === "string"
          ? candidate.workflowIdentity
          : undefined,
      ),
      ...(typeof candidate.cycle === "number"
        ? { cycle: candidate.cycle }
        : { cycle: 1 }),
      ...(typeof candidate.revision === "number"
        ? { revision: candidate.revision }
        : {}),
      startedAt,
      ...(typeof candidate.completedAt === "string"
        ? { completedAt: candidate.completedAt }
        : {}),
      status,
      cycles: cloneJson(
        candidate.cycles,
      ) as readonly RepositoryWorkflowCycleResult[],
      ...(typeof candidate.owner === "string"
        ? { owner: candidate.owner }
        : {}),
      ...(claim === undefined ? {} : { claim }),
      ...(candidate.recovery === "resumable" ||
      candidate.recovery === "retryable" ||
      candidate.recovery === "terminal" ||
      candidate.recovery === "manual_intervention"
        ? { recovery: candidate.recovery }
        : {}),
      ...(failure === undefined ? {} : { failure }),
      ...(typeof candidate.error === "string"
        ? { error: candidate.error }
        : {}),
    });
  }
  const scheduleSequence = value.scheduleSequence ?? 0;
  if (
    typeof scheduleSequence !== "number" ||
    !Number.isInteger(scheduleSequence) ||
    scheduleSequence < 0
  ) {
    throw new RepositoryWorkflowStoreError(
      "Repository workflow schedule sequence must be a non-negative integer.",
    );
  }
  return {
    version: 1,
    revision,
    scheduleSequence,
    repositories: repositories.sort((left, right) =>
      left.repository.localeCompare(right.repository),
    ),
    runs: runs.sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const readState = async (
  filePath: string,
): Promise<RepositoryWorkflowState> => {
  try {
    return normalizeState(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyState();
    if (error instanceof RepositoryWorkflowStoreError) throw error;
    throw new RepositoryWorkflowStoreError(
      `Repository workflow state at ${filePath} could not be read: ${errorMessage(error)}`,
    );
  }
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const acquireStoreLock = async (
  filePath: string,
): Promise<() => Promise<void>> => {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      return async () => rm(lockPath, { force: true });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const owner = (await readFile(lockPath, "utf8")).trim();
        const ownerPid = Number(owner);
        let ownerAlive = false;
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0);
            ownerAlive = true;
          } catch (processError) {
            ownerAlive =
              isRecord(processError) && processError.code === "EPERM";
          }
        }
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (!ownerAlive && (owner !== "" || age > 1_000)) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (!isRecord(statError) || statError.code !== "ENOENT")
          throw statError;
      }
      await wait(Math.min(50, 5 + attempt));
    }
  }
  throw new RepositoryWorkflowStoreError(
    `Repository workflow state at ${filePath} is locked by another process.`,
    "lock_timeout",
  );
};

let temporaryFileCounter = 0;

const writeState = async (
  filePath: string,
  state: RepositoryWorkflowState,
): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  temporaryFileCounter += 1;
  const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

/** JSON persistence with a cross-process lock and compare-and-set revisions. */
export const createRepositoryWorkflowStore = (
  options: RepositoryWorkflowStoreOptions,
): RepositoryWorkflowStore => {
  if (options.filePath.trim() === "") {
    throw new RepositoryWorkflowStoreError("filePath must be non-empty.");
  }
  let pending = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const update = (
    mutator: (state: RepositoryWorkflowState) => RepositoryWorkflowState,
    updateOptions: RepositoryWorkflowStoreUpdateOptions = {},
  ): Promise<RepositoryWorkflowState> =>
    serialized(async () => {
      const release = await acquireStoreLock(options.filePath);
      try {
        const current = await readState(options.filePath);
        const expectedRevision = updateOptions.expectedRevision;
        if (
          expectedRevision !== undefined &&
          (!Number.isInteger(expectedRevision) || expectedRevision < 0)
        ) {
          throw new RepositoryWorkflowStoreError(
            "expectedRevision must be a non-negative integer.",
          );
        }
        if (
          expectedRevision !== undefined &&
          expectedRevision !== current.revision
        ) {
          throw new RepositoryWorkflowStoreError(
            `Expected repository workflow revision ${expectedRevision}, current revision is ${current.revision}.`,
            "stale_revision",
            { expectedRevision, actualRevision: current.revision },
          );
        }
        const proposed = mutator(current);
        const next = normalizeState({
          ...proposed,
          version: 1,
          revision: current.revision + 1,
        });
        await writeState(options.filePath, next);
        return next;
      } finally {
        await release();
      }
    });
  return {
    read: () => serialized(() => readState(options.filePath)),
    update,
    compareAndSet: (expectedRevision, mutator) =>
      update(mutator, { expectedRevision }),
  };
};

const workflowTaskId = (
  repository: string,
  issue: RepositoryWorkflowIssue,
): string => `${repository}:issue:${issue.number}`;

const stageForRun = (
  run: RepositoryWorkflowRunRecord | undefined,
): RepositoryWorkflowProjectionEntry["stage"] => {
  if (run === undefined) return "ready";
  if (run.status === "running")
    return run.claim?.phase === "claimed" ? "claimed" : "running";
  if (run.status === "interrupted") return "interrupted";
  if (run.status === "manual_intervention") return "manual_intervention";
  if (run.status === "failed") return "failed";
  const lastCycle = run.cycles.at(-1);
  if (lastCycle?.status === "idle") return "idle";
  return "completed";
};

const taskProjectionFor = (
  repository: string,
  run: RepositoryWorkflowRunRecord | undefined,
): RepositoryWorkflowProjectionTask | undefined => {
  const task = run?.cycles.at(-1)?.tasks.at(-1);
  if (task === undefined) return undefined;
  let stage: string;
  switch (task.status) {
    case "reviewed":
      stage = "reviewing";
      break;
    case "no_changes":
      stage = "completed";
      break;
    case "failed":
      stage = "failed";
      break;
  }
  return {
    taskId: workflowTaskId(repository, task.issue),
    repository,
    kind: "issue",
    number: task.issue.number,
    title: task.issue.title,
    stage,
  };
};

const classifyFailure = (
  error: unknown,
  signal: AbortSignal | undefined,
  classifier: RepositoryWorkflowControlOptions["classifyError"],
): "retryable" | "terminal" | "manual_intervention" => {
  if (signal?.aborted) return "manual_intervention";
  if (classifier !== undefined) return classifier(error);
  const code = errorCode(error);
  if (code === "terminal") return "terminal";
  if (code === "manual_intervention") return "manual_intervention";
  return "retryable";
};

const queueEntriesFor = (
  state: RepositoryWorkflowState,
  workflows: Readonly<Record<string, RepositoryWorkflowDefinition>>,
  at: string,
): readonly RepositoryWorkflowQueueEntry[] => {
  const queueStateFor = (
    repository: AuthorizedRepositoryWorkflow,
  ): RepositoryWorkflowQueueEntry["state"] => {
    if (repository.mode !== "active") {
      return repository.blockingReason === undefined
        ? "paused"
        : "manual_intervention";
    }
    if (repository.activeRunId !== undefined) return "claimed";
    if (repository.lastFailure?.classification === "terminal") {
      return "terminal";
    }
    if (
      repository.nextEligibleAt !== undefined &&
      Date.parse(repository.nextEligibleAt) > Date.parse(at)
    ) {
      return "backoff";
    }
    const workflow = workflows[repository.workflowId];
    if (workflow !== undefined && repository.nextCycle > workflow.maxCycles) {
      return "paused";
    }
    return "ready";
  };

  const entries = state.repositories.map((repository) => {
    const identity =
      repository.workflowIdentity ??
      repositoryWorkflowIdentity(repository.repository, repository.workflowId);
    return {
      position: 0,
      repository: repository.repository,
      workflowId: repository.workflowId,
      workflowIdentity: identity,
      cycle: repository.nextCycle,
      state: queueStateFor(repository),
      ...(repository.nextEligibleAt === undefined
        ? {}
        : { nextEligibleAt: repository.nextEligibleAt }),
      ...(repository.lastScheduledSequence === undefined
        ? {}
        : { lastScheduledSequence: repository.lastScheduledSequence }),
    };
  });
  const compare = (
    left: RepositoryWorkflowQueueEntry,
    right: RepositoryWorkflowQueueEntry,
  ): number =>
    (left.lastScheduledSequence ?? 0) - (right.lastScheduledSequence ?? 0) ||
    left.repository.localeCompare(right.repository) ||
    left.cycle - right.cycle ||
    left.workflowIdentity.localeCompare(right.workflowIdentity);
  return entries
    .filter((entry) => entry.state === "ready")
    .sort(compare)
    .map((entry, index) => ({ ...entry, position: index + 1 }));
};

const projectionStageFor = (
  repository: AuthorizedRepositoryWorkflow,
  run: RepositoryWorkflowRunRecord | undefined,
  at: string,
): RepositoryWorkflowProjectionEntry["stage"] => {
  if (repository.mode !== "active" && run?.status !== "running") {
    return repository.blockingReason === undefined
      ? "paused"
      : "manual_intervention";
  }
  if (
    repository.nextEligibleAt !== undefined &&
    Date.parse(repository.nextEligibleAt) > Date.parse(at)
  ) {
    return "backoff";
  }
  return stageForRun(run);
};

const runStatusForFailure = (
  classification: RepositoryWorkflowFailure["classification"],
  aborted: boolean,
): RepositoryWorkflowRunStatus => {
  if (aborted) return "interrupted";
  if (classification === "manual_intervention") {
    return "manual_intervention";
  }
  return "failed";
};

/** Operator control plane for durable, globally schedulable repository workflows. */
export const createRepositoryWorkflowControl = (
  options: RepositoryWorkflowControlOptions,
): RepositoryWorkflowControl => {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const owner = options.owner?.trim() || "repository-workflow-coordinator";
  const leaseDurationMs = options.leaseDurationMs ?? 30 * 60_000;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 60_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be a positive finite number.");
  }
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs <= 0) {
    throw new Error("retryBaseDelayMs must be a positive finite number.");
  }
  if (!Number.isFinite(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error(
      "retryMaxDelayMs must be finite and at least retryBaseDelayMs.",
    );
  }

  const requireWorkflow = (
    workflowId: string,
  ): RepositoryWorkflowDefinition => {
    const workflow = options.workflows[workflowId];
    if (workflow === undefined) {
      throw new Error(`Unknown workflow ${workflowId}.`);
    }
    if (!Number.isInteger(workflow.maxCycles) || workflow.maxCycles < 1) {
      throw new Error(`Workflow ${workflowId} must have a positive maxCycles.`);
    }
    return workflow;
  };

  const requireRepository = async (
    repository: string,
  ): Promise<AuthorizedRepositoryWorkflow> => {
    const normalized = normalizeRepository(repository);
    const found = (await options.store.read()).repositories.find(
      (item) => item.repository === normalized,
    );
    if (!found) throw new Error(`Repository ${normalized} is not authorized.`);
    return found;
  };

  const recover = async (
    recoveryOptions: {
      readonly at?: string;
      readonly expectedRevision?: number;
    } = {},
  ): Promise<readonly RepositoryWorkflowRecovery[]> => {
    const recovered: RepositoryWorkflowRecovery[] = [];
    const at = ensureTimestamp(
      recoveryOptions.at ?? now(),
      "recovery timestamp",
    );
    const current = await options.store.read();
    const candidates = current.repositories.filter((repository) => {
      if (repository.activeRunId === undefined) return false;
      const run = current.runs.find(
        (item) => item.id === repository.activeRunId,
      );
      return (
        run === undefined ||
        run.status !== "running" ||
        run.claim === undefined ||
        isExpired(run.claim, at)
      );
    });
    if (candidates.length === 0) return recovered;
    await options.store.update(
      (state) => {
        let repositories = [...state.repositories];
        let runs = [...state.runs];
        for (const candidate of candidates) {
          const index = repositories.findIndex(
            (item) => item.repository === candidate.repository,
          );
          if (index === -1) continue;
          const currentRepository = repositories[index]!;
          if (
            currentRepository.activeRunId === undefined ||
            currentRepository.activeRunId !== candidate.activeRunId
          )
            continue;
          const runIndex = runs.findIndex(
            (item) => item.id === currentRepository.activeRunId,
          );
          const run = runIndex === -1 ? undefined : runs[runIndex];
          const workflowIdentity =
            currentRepository.workflowIdentity ??
            repositoryWorkflowIdentity(
              currentRepository.repository,
              currentRepository.workflowId,
            );
          if (run === undefined) {
            repositories[index] = {
              ...currentRepository,
              activeRunId: undefined,
              mode: "paused",
              blockingReason: "active_run_missing",
            };
            recovered.push({
              repository: currentRepository.repository,
              workflowIdentity,
              runId: currentRepository.activeRunId,
              disposition: "manual_intervention",
              reasonCode: "active_run_missing",
              recoveredAt: at,
            });
            continue;
          }
          if (run.status !== "running") {
            repositories[index] = {
              ...currentRepository,
              activeRunId: undefined,
            };
            continue;
          }
          if (run.claim !== undefined && !isExpired(run.claim, at)) continue;
          const disposition: RepositoryWorkflowRecoveryDisposition =
            run.claim?.phase === "claimed"
              ? "retryable"
              : "manual_intervention";
          const reasonCode =
            run.claim?.phase === "claimed"
              ? "lease_expired_before_dispatch"
              : "lease_expired_after_dispatch";
          const failure: RepositoryWorkflowFailure = {
            code: reasonCode,
            classification:
              disposition === "manual_intervention"
                ? "manual_intervention"
                : "retryable",
            occurredAt: at,
          };
          const nextRun: RepositoryWorkflowRunRecord = {
            ...run,
            status:
              disposition === "manual_intervention"
                ? "manual_intervention"
                : "interrupted",
            completedAt: at,
            recovery: disposition,
            failure,
            error: reasonCode,
          };
          runs[runIndex] = nextRun;
          repositories[index] = {
            ...currentRepository,
            activeRunId: undefined,
            ...(disposition === "manual_intervention"
              ? {
                  mode: "paused" as const,
                  blockingReason: reasonCode,
                  lastFailure: failure,
                }
              : {
                  nextEligibleAt: at,
                  lastFailure: failure,
                }),
          };
          recovered.push({
            repository: currentRepository.repository,
            workflowIdentity,
            runId: run.id,
            disposition,
            reasonCode,
            recoveredAt: at,
          });
        }
        return { ...state, repositories, runs };
      },
      { expectedRevision: recoveryOptions.expectedRevision },
    );
    return recovered;
  };

  const getProjection = async (): Promise<RepositoryWorkflowProjection> => {
    const state = await options.store.read();
    const generatedAt = ensureTimestamp(now(), "projection timestamp");
    const queue = queueEntriesFor(state, options.workflows, generatedAt);
    const repositories = state.repositories.map((repository) => {
      const run =
        repository.activeRunId === undefined
          ? [...state.runs]
              .filter(
                (candidate) => candidate.repository === repository.repository,
              )
              .sort((left, right) =>
                (right.completedAt ?? right.startedAt).localeCompare(
                  left.completedAt ?? left.startedAt,
                ),
              )[0]
          : state.runs.find(
              (candidate) => candidate.id === repository.activeRunId,
            );
      const stage = projectionStageFor(repository, run, generatedAt);
      const task = taskProjectionFor(repository.repository, run);
      return {
        repository: repository.repository,
        workflowId: repository.workflowId,
        workflowIdentity:
          repository.workflowIdentity ??
          repositoryWorkflowIdentity(
            repository.repository,
            repository.workflowId,
          ),
        revision: state.revision,
        stage,
        ...(run?.id === undefined ? {} : { runId: run.id }),
        ...(task === undefined ? {} : { task }),
        ...(run?.owner === undefined ? {} : { owner: run.owner }),
        ...(run?.claim?.acquiredAt === undefined
          ? {}
          : { claimedAt: run.claim.acquiredAt }),
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run?.completedAt === undefined
          ? {}
          : { updatedAt: run.completedAt }),
        ...(repository.blockingReason === undefined
          ? {}
          : { blockingReason: repository.blockingReason }),
        ...(run?.recovery === undefined ? {} : { recovery: run.recovery }),
      } satisfies RepositoryWorkflowProjectionEntry;
    });
    return {
      version: 1,
      revision: state.revision,
      generatedAt,
      repositories,
      queue,
      entries: queue,
    };
  };

  return {
    async authorize(input) {
      const repository = normalizeRepository(input.repository);
      const featureBranch = input.featureBranch.trim();
      if (featureBranch === "")
        throw new Error("featureBranch must be non-empty.");
      const workflow = requireWorkflow(input.workflowId);
      await options.store.update(
        (state) => {
          const existing = state.repositories.find(
            (item) => item.repository === repository,
          );
          if (existing?.activeRunId !== undefined) {
            throw new RepositoryWorkflowStoreError(
              `Repository ${repository} has an active workflow and cannot be reconfigured.`,
              "conflict",
            );
          }
          const next: AuthorizedRepositoryWorkflow = {
            repository,
            featureBranch,
            workflowId: workflow.id,
            workflowIdentity: repositoryWorkflowIdentity(
              repository,
              workflow.id,
            ),
            mode: "active",
            nextCycle: 1,
            failureCount: 0,
          };
          return {
            ...state,
            repositories: [
              ...state.repositories.filter(
                (item) => item.repository !== repository,
              ),
              next,
            ].sort((left, right) =>
              left.repository.localeCompare(right.repository),
            ),
          };
        },
        { expectedRevision: input.expectedRevision },
      );
    },
    async remove(repository, mutationOptions = {}) {
      const normalized = normalizeRepository(repository);
      await options.store.update((state) => {
        const found = state.repositories.find(
          (item) => item.repository === normalized,
        );
        if (found === undefined) {
          throw new RepositoryWorkflowStoreError(
            `Repository ${normalized} is not authorized.`,
            "not_found",
          );
        }
        if (found.activeRunId !== undefined) {
          throw new RepositoryWorkflowStoreError(
            `Repository ${normalized} has an active workflow.`,
            "conflict",
          );
        }
        return {
          ...state,
          repositories: state.repositories.filter(
            (item) => item.repository !== normalized,
          ),
        };
      }, mutationOptions);
    },
    async list() {
      return (await options.store.read()).repositories;
    },
    async inspect(repository) {
      const normalized = normalizeRepository(repository);
      const state = await options.store.read();
      const configured = state.repositories.find(
        (item) => item.repository === normalized,
      );
      if (!configured) return undefined;
      return {
        ...configured,
        revision: state.revision,
        runs: state.runs.filter((run) => run.repository === normalized),
      };
    },
    async runNow(repository, signal, runOptions = {}) {
      const configured = await requireRepository(repository);
      const workflow = requireWorkflow(configured.workflowId);
      throwIfWorkflowCancelled(signal);
      const runOwner = runOptions.owner?.trim() || owner;
      if (runOwner === "") throw new Error("owner must be non-empty.");
      const runLeaseDuration = runOptions.leaseDurationMs ?? leaseDurationMs;
      if (!Number.isFinite(runLeaseDuration) || runLeaseDuration <= 0) {
        throw new Error("leaseDurationMs must be a positive finite number.");
      }
      const id = createId();
      const claimedAt = ensureTimestamp(now(), "claim timestamp");
      const leaseExpiresAt = new Date(
        Date.parse(claimedAt) + runLeaseDuration,
      ).toISOString();
      let claimed!: RepositoryWorkflowRunRecord;
      let blockedByManualRecovery = false;
      await options.store.update(
        (state) => {
          const index = state.repositories.findIndex(
            (item) => item.repository === configured.repository,
          );
          if (index === -1) {
            throw new RepositoryWorkflowStoreError(
              `Repository ${configured.repository} is not authorized.`,
              "not_found",
            );
          }
          let current = state.repositories[index]!;
          if (
            current.workflowId !== configured.workflowId ||
            current.featureBranch !== configured.featureBranch
          ) {
            throw new RepositoryWorkflowStoreError(
              `Repository ${current.repository} configuration changed before dispatch.`,
              "stale_revision",
            );
          }
          if (current.mode !== "active") {
            throw new RepositoryWorkflowStoreError(
              `Repository ${current.repository} is ${current.mode}.`,
              "conflict",
            );
          }
          if (current.nextCycle > workflow.maxCycles) {
            throw new RepositoryWorkflowStoreError(
              `Repository ${current.repository} reached its ${workflow.maxCycles}-cycle limit.`,
              "conflict",
            );
          }
          if (
            current.nextEligibleAt !== undefined &&
            Date.parse(current.nextEligibleAt) > Date.parse(claimedAt)
          ) {
            throw new RepositoryWorkflowStoreError(
              `Repository ${current.repository} is in retry backoff until ${current.nextEligibleAt}.`,
              "conflict",
            );
          }
          let repositories = [...state.repositories];
          let runs = [...state.runs];
          if (current.activeRunId !== undefined) {
            const activeIndex = runs.findIndex(
              (run) => run.id === current.activeRunId,
            );
            const active = activeIndex === -1 ? undefined : runs[activeIndex];
            if (
              active !== undefined &&
              active.status === "running" &&
              active.claim !== undefined &&
              !isExpired(active.claim, claimedAt)
            ) {
              throw new RepositoryWorkflowStoreError(
                `Repository ${repository} already has an active workflow.`,
                "conflict",
              );
            }
            if (
              active !== undefined &&
              active.status === "running" &&
              active.claim?.phase === "started"
            ) {
              const failure: RepositoryWorkflowFailure = {
                code: "lease_expired_after_dispatch",
                classification: "manual_intervention",
                occurredAt: claimedAt,
              };
              runs[activeIndex!] = {
                ...active,
                status: "manual_intervention",
                completedAt: claimedAt,
                recovery: "manual_intervention",
                failure,
                error: failure.code,
              };
              current = {
                ...current,
                activeRunId: undefined,
                mode: "paused",
                blockingReason: failure.code,
                lastFailure: failure,
              };
              repositories[index] = current;
              blockedByManualRecovery = true;
            } else if (
              active !== undefined &&
              active.status === "running" &&
              active.claim?.phase === "claimed"
            ) {
              const failure: RepositoryWorkflowFailure = {
                code: "lease_expired_before_dispatch",
                classification: "retryable",
                occurredAt: claimedAt,
              };
              runs[activeIndex!] = {
                ...active,
                status: "interrupted",
                completedAt: claimedAt,
                recovery: "retryable",
                failure,
                error: failure.code,
              };
              current = {
                ...current,
                activeRunId: undefined,
                nextEligibleAt: claimedAt,
                lastFailure: failure,
              };
              repositories[index] = current;
            } else {
              const failure: RepositoryWorkflowFailure = {
                code: "active_run_missing",
                classification: "manual_intervention",
                occurredAt: claimedAt,
              };
              current = {
                ...current,
                activeRunId: undefined,
                mode: "paused",
                blockingReason: failure.code,
                lastFailure: failure,
              };
              repositories[index] = current;
              blockedByManualRecovery = true;
            }
          }
          if (blockedByManualRecovery) {
            return { ...state, repositories, runs };
          }
          const sequence = (state.scheduleSequence ?? 0) + 1;
          const claim: RepositoryWorkflowClaim = {
            owner: runOwner,
            acquiredAt: claimedAt,
            leaseExpiresAt,
            phase: "claimed",
          };
          claimed = {
            id,
            repository: current.repository,
            workflowId: workflow.id,
            workflowIdentity:
              current.workflowIdentity ??
              repositoryWorkflowIdentity(current.repository, workflow.id),
            cycle: current.nextCycle,
            revision: state.revision + 1,
            startedAt: claimedAt,
            status: "running",
            cycles: [],
            owner: runOwner,
            claim,
          };
          repositories[index] = {
            ...current,
            activeRunId: id,
            lastScheduledSequence: sequence,
            failureCount: current.failureCount ?? 0,
            nextEligibleAt: undefined,
            lastFailure: undefined,
            blockingReason: undefined,
          };
          return {
            ...state,
            scheduleSequence: sequence,
            repositories,
            runs: [...runs, claimed],
          };
        },
        { expectedRevision: runOptions.expectedRevision },
      );
      if (blockedByManualRecovery) {
        throw new RepositoryWorkflowStoreError(
          `Repository ${configured.repository} requires manual intervention after an expired claim.`,
          "conflict",
        );
      }

      try {
        throwIfWorkflowCancelled(signal);
        await options.store.update((state) => {
          const index = state.runs.findIndex((run) => run.id === id);
          const current = index === -1 ? undefined : state.runs[index];
          if (
            current === undefined ||
            current.status !== "running" ||
            current.claim === undefined
          ) {
            throw new RepositoryWorkflowStoreError(
              `Repository workflow run ${id} is no longer active.`,
              "conflict",
            );
          }
          const started: RepositoryWorkflowRunRecord = {
            ...current,
            claim: { ...current.claim, phase: "started" },
          };
          const runs = [...state.runs];
          runs[index] = started;
          return { ...state, runs };
        });
        throwIfWorkflowCancelled(signal);
        const cycle = await options.runtime.runCycle({
          repository: claimed.repository,
          featureBranch: configured.featureBranch,
          workflow,
          cycle: claimed.cycle ?? configured.nextCycle,
          signal,
        });
        let completed!: RepositoryWorkflowRunRecord;
        const completedAt = ensureTimestamp(now(), "completion timestamp");
        await options.store.update((state) => {
          const repositoryIndex = state.repositories.findIndex(
            (item) => item.repository === claimed.repository,
          );
          const runIndex = state.runs.findIndex((run) => run.id === id);
          const currentRepository =
            repositoryIndex === -1
              ? undefined
              : state.repositories[repositoryIndex];
          const currentRun = runIndex === -1 ? undefined : state.runs[runIndex];
          if (
            currentRepository === undefined ||
            currentRun === undefined ||
            currentRepository.activeRunId !== id ||
            currentRun.status !== "running"
          ) {
            throw new RepositoryWorkflowStoreError(
              `Repository workflow run ${id} is no longer active.`,
              "conflict",
            );
          }
          const consumesCycle = cycle.status !== "idle";
          const nextCycle =
            currentRepository.nextCycle + (consumesCycle ? 1 : 0);
          const nextMode =
            currentRepository.mode === "pausing" ||
            nextCycle > workflow.maxCycles
              ? "paused"
              : currentRepository.mode;
          completed = {
            ...currentRun,
            status: "completed",
            completedAt,
            cycles: [...currentRun.cycles, cycle],
          };
          const repositories = [...state.repositories];
          repositories[repositoryIndex] = {
            ...currentRepository,
            activeRunId: undefined,
            nextCycle,
            mode: nextMode,
            failureCount: 0,
            nextEligibleAt: undefined,
            lastFailure: undefined,
            blockingReason: undefined,
            lastCycleAt: completedAt,
            ...(consumesCycle ? { lastSuccessfulCycleAt: completedAt } : {}),
          };
          const runs = [...state.runs];
          runs[runIndex] = completed;
          return { ...state, repositories, runs };
        });
        return completed;
      } catch (error) {
        const message = errorMessage(error);
        const completedAt = ensureTimestamp(now(), "failure timestamp");
        const classification = classifyFailure(
          error,
          signal,
          options.classifyError,
        );
        let failed!: RepositoryWorkflowRunRecord;
        try {
          await options.store.update((state) => {
            const repositoryIndex = state.repositories.findIndex(
              (item) => item.repository === claimed.repository,
            );
            const runIndex = state.runs.findIndex((run) => run.id === id);
            const currentRepository =
              repositoryIndex === -1
                ? undefined
                : state.repositories[repositoryIndex];
            const currentRun =
              runIndex === -1 ? undefined : state.runs[runIndex];
            if (
              currentRepository === undefined ||
              currentRun === undefined ||
              currentRepository.activeRunId !== id
            ) {
              throw new RepositoryWorkflowStoreError(
                `Repository workflow run ${id} is no longer active.`,
                "conflict",
              );
            }
            const code = errorCode(error);
            const failure: RepositoryWorkflowFailure = {
              code,
              classification,
              occurredAt: completedAt,
            };
            const aborted = signal?.aborted === true;
            const recovery: RepositoryWorkflowRecoveryDisposition = aborted
              ? "resumable"
              : classification;
            failed = {
              ...currentRun,
              status: runStatusForFailure(classification, aborted),
              completedAt,
              recovery,
              failure,
              error: message,
            };
            const failureCount = (currentRepository.failureCount ?? 0) + 1;
            const delay = Math.min(
              retryMaxDelayMs,
              retryBaseDelayMs * 2 ** Math.max(0, failureCount - 1),
            );
            const retryAt = new Date(
              Date.parse(completedAt) + delay,
            ).toISOString();
            const repositories = [...state.repositories];
            repositories[repositoryIndex] = {
              ...currentRepository,
              activeRunId: undefined,
              failureCount,
              lastFailure: failure,
              ...(classification === "retryable" && !aborted
                ? { nextEligibleAt: retryAt }
                : {}),
              ...(classification === "terminal" ||
              classification === "manual_intervention" ||
              aborted
                ? {
                    mode: "paused" as const,
                    blockingReason: aborted ? "workflow_interrupted" : code,
                  }
                : {}),
            };
            const runs = [...state.runs];
            runs[runIndex] = failed;
            return { ...state, repositories, runs };
          });
        } catch (persistError) {
          if (persistError instanceof RepositoryWorkflowStoreError)
            throw persistError;
          throw error;
        }
        throw error;
      }
    },
    async pause(repository, mutationOptions = {}) {
      const configured = await requireRepository(repository);
      const normalized = configured.repository;
      await options.store.update((state) => {
        const current = state.repositories.find(
          (item) => item.repository === normalized,
        );
        if (current === undefined) {
          throw new RepositoryWorkflowStoreError(
            `Repository ${normalized} is not authorized.`,
            "not_found",
          );
        }
        return {
          ...state,
          repositories: state.repositories.map((item) =>
            item.repository === normalized
              ? {
                  ...item,
                  mode: item.activeRunId === undefined ? "paused" : "pausing",
                }
              : item,
          ),
        };
      }, mutationOptions);
    },
    async resume(repository, mutationOptions = {}) {
      const configured = await requireRepository(repository);
      const normalized = configured.repository;
      await options.store.update((state) => {
        if (
          !state.repositories.some((item) => item.repository === normalized)
        ) {
          throw new RepositoryWorkflowStoreError(
            `Repository ${normalized} is not authorized.`,
            "not_found",
          );
        }
        return {
          ...state,
          repositories: state.repositories.map((item) =>
            item.repository === normalized
              ? { ...item, mode: "active", blockingReason: undefined }
              : item,
          ),
        };
      }, mutationOptions);
    },
    recover,
    getProjection,
  };
};
