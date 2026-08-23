import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DryRunResult,
  ExecutionRequest,
  NormalizedTask,
} from "./WorkerCoordinator.js";

/** One immutable task snapshot retained by the worker state store. */
export interface TaskSnapshotRecord {
  /** Stable repository/task identity for this snapshot. */
  readonly taskId: string;
  /** The normalized task observed during discovery. */
  readonly task: NormalizedTask;
  /** The first discovery timestamp for this immutable snapshot. */
  readonly discoveredAt: string;
}

/** One immutable execution request selected during discovery. */
export interface ExecutionRequestRecord {
  /** Stable execution identity bound to the request inputs. */
  readonly executionIdentity: string;
  /** The request selected by the worker coordinator. */
  readonly request: ExecutionRequest;
  /** The first timestamp at which this request was selected. */
  readonly selectedAt: string;
}

/** The durable lifecycle states of one execution attempt. */
export type AttemptStatus =
  | "active"
  | "interrupted"
  | "failed"
  | "verified"
  | "published";

/** One terminal outcome retained in an attempt's lifecycle history. */
export interface AttemptOutcomeRecord {
  /** The lifecycle state reached by this transition. */
  readonly status: Exclude<AttemptStatus, "active">;
  /** The timestamp at which the outcome was recorded. */
  readonly timestamp: string;
  /** Evidence references supplied with the outcome. */
  readonly evidence: readonly string[];
}

/** A durable execution attempt bound to one immutable execution request. */
export interface ExecutionAttempt {
  /** Stable attempt identity derived from the immutable execution identity. */
  readonly attemptId: string;
  /** Immutable execution identity guarded by this attempt. */
  readonly executionIdentity: string;
  /** The immutable request selected before execution began. */
  readonly request: ExecutionRequest;
  /** Current lifecycle state. */
  readonly status: AttemptStatus;
  /** Timestamp at which the active attempt was created. */
  readonly createdAt: string;
  /** Timestamp of the latest lifecycle change. */
  readonly updatedAt: string;
  /** Terminal outcomes recorded in transition order. */
  readonly outcomes: readonly AttemptOutcomeRecord[];
}

/** A requested lifecycle transition for an execution attempt. */
export interface AttemptTransition {
  /** The terminal lifecycle state to record. */
  readonly status: Exclude<AttemptStatus, "active">;
  /** Evidence references supporting the outcome. */
  readonly evidence?: readonly string[];
  /** Optional caller-supplied timestamp; otherwise the store clock is used. */
  readonly timestamp?: string;
}

/** Durable worker state format. */
export interface WorkerState {
  /** Persisted state format version. */
  readonly version: 1;
  /** Immutable task snapshots observed by discovery. */
  readonly taskSnapshots: readonly TaskSnapshotRecord[];
  /** Immutable execution requests selected by authorization. */
  readonly executionRequests: readonly ExecutionRequestRecord[];
  /** Durable execution attempts. */
  readonly attempts: readonly ExecutionAttempt[];
}

/** Configuration for the file-backed worker state store. */
export interface WorkerStateStoreOptions {
  /** JSON file used as the durable state boundary. */
  readonly filePath: string;
  /** Injectable clock for deterministic callers and tests. */
  readonly now?: () => string;
}

/** Public state boundary for durable worker discovery and execution state. */
export interface WorkerStateStore {
  /** Reconstruct the complete state currently persisted at the boundary. */
  read(): Promise<WorkerState>;
  /** Persist discovered task snapshots and selected execution requests idempotently. */
  recordDiscovery(
    result: DryRunResult,
    options?: { readonly discoveredAt?: string },
  ): Promise<WorkerState>;
  /** Persist an active attempt before an execution engine starts work. */
  createAttempt(request: ExecutionRequest): Promise<ExecutionAttempt>;
  /** Record one valid terminal lifecycle transition and its evidence. */
  transitionAttempt(
    attemptId: string,
    transition: AttemptTransition,
  ): Promise<ExecutionAttempt>;
}

/** Raised when persisted worker state cannot be read or reconciled safely. */
export class WorkerStateStoreError extends Error {
  /** Stable category for callers that need to handle a state failure. */
  readonly code:
    | "invalid_state"
    | "conflict"
    | "not_found"
    | "invalid_transition";

  constructor(
    message: string,
    code:
      | "invalid_state"
      | "conflict"
      | "not_found"
      | "invalid_transition" = "invalid_state",
  ) {
    super(message);
    this.name = "WorkerStateStoreError";
    this.code = code;
  }
}

const emptyState = (): WorkerState => ({
  version: 1,
  taskSnapshots: [],
  executionRequests: [],
  attempts: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAttemptStatus = (value: unknown): value is AttemptStatus =>
  value === "active" ||
  value === "interrupted" ||
  value === "failed" ||
  value === "verified" ||
  value === "published";

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
};

const freezeState = (state: WorkerState): WorkerState => deepFreeze(state);

const parseState = (content: string, filePath: string): WorkerState => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new WorkerStateStoreError(
      `Worker state at ${filePath} is not valid JSON: ${String(error)}`,
    );
  }

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.taskSnapshots) ||
    !Array.isArray(value.executionRequests) ||
    !Array.isArray(value.attempts)
  ) {
    throw new WorkerStateStoreError(
      `Worker state at ${filePath} does not match version 1.`,
    );
  }

  const state = value as unknown as WorkerState;
  const taskKeys = new Set<string>();
  for (const snapshot of state.taskSnapshots) {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.taskId !== "string" ||
      !isRecord(snapshot.task) ||
      typeof snapshot.task.sourceRevision !== "string"
    ) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains an invalid task snapshot.`,
      );
    }
    const key = snapshotKey(snapshot as TaskSnapshotRecord);
    if (taskKeys.has(key)) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains duplicate task snapshot ${snapshot.taskId}.`,
      );
    }
    taskKeys.add(key);
  }

  const requestIdentities = new Set<string>();
  for (const record of state.executionRequests) {
    if (
      !isRecord(record) ||
      typeof record.executionIdentity !== "string" ||
      !isRecord(record.request)
    ) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains an invalid execution request.`,
      );
    }
    if (requestIdentities.has(record.executionIdentity)) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains duplicate execution request ${record.executionIdentity}.`,
      );
    }
    requestIdentities.add(record.executionIdentity);
  }

  const attemptIdentities = new Set<string>();
  for (const attempt of state.attempts) {
    if (
      !isRecord(attempt) ||
      typeof attempt.attemptId !== "string" ||
      typeof attempt.executionIdentity !== "string" ||
      !isAttemptStatus(attempt.status) ||
      !Array.isArray(attempt.outcomes)
    ) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains an invalid execution attempt.`,
      );
    }
    if (attemptIdentities.has(attempt.executionIdentity)) {
      throw new WorkerStateStoreError(
        `Worker state at ${filePath} contains duplicate active-attempt identity ${attempt.executionIdentity}.`,
      );
    }
    attemptIdentities.add(attempt.executionIdentity);
  }

  return freezeState(state);
};

const readState = async (filePath: string): Promise<WorkerState> => {
  try {
    return parseState(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return freezeState(emptyState());
    }
    throw error;
  }
};

let temporaryFileCounter = 0;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const acquireStateLock = async (
  filePath: string,
): Promise<() => Promise<void>> => {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isRecord(statError) || statError.code !== "ENOENT") {
          throw statError;
        }
      }
      await wait(Math.min(50, 5 + attempt));
    }
  }
  throw new WorkerStateStoreError(
    `Worker state at ${filePath} is locked by another process.`,
  );
};

const withStateLock = async <T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const release = await acquireStateLock(filePath);
  try {
    return await operation();
  } finally {
    await release();
  }
};

const writeState = async (
  filePath: string,
  state: WorkerState,
): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  temporaryFileCounter += 1;
  const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const snapshotKey = (record: TaskSnapshotRecord): string =>
  `${record.taskId}\u0000${record.task.sourceRevision}`;

const requestKey = (record: ExecutionRequestRecord): string =>
  record.executionIdentity;

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const ensureTimestamp = (timestamp: string, context: string): string => {
  if (timestamp.trim() === "" || Number.isNaN(Date.parse(timestamp))) {
    throw new WorkerStateStoreError(`${context} must be a valid timestamp.`);
  }
  return timestamp;
};

const canTransition = (
  current: AttemptStatus,
  next: Exclude<AttemptStatus, "active">,
): boolean => {
  if (current === "active") return next !== "published";
  return current === "verified" && next === "published";
};

const addTaskSnapshot = (
  taskSnapshots: TaskSnapshotRecord[],
  snapshot: TaskSnapshotRecord,
): void => {
  const existing = taskSnapshots.find(
    (candidate) => snapshotKey(candidate) === snapshotKey(snapshot),
  );
  if (existing !== undefined) {
    if (!sameJson(existing.task, snapshot.task)) {
      throw new WorkerStateStoreError(
        `Task snapshot ${snapshot.taskId} at revision ${snapshot.task.sourceRevision} conflicts with persisted state.`,
        "conflict",
      );
    }
    return;
  }
  taskSnapshots.push(snapshot);
};

const addExecutionRequest = (
  executionRequests: ExecutionRequestRecord[],
  record: ExecutionRequestRecord,
): void => {
  const existing = executionRequests.find(
    (candidate) => requestKey(candidate) === requestKey(record),
  );
  if (existing !== undefined) {
    if (!sameJson(existing.request, record.request)) {
      throw new WorkerStateStoreError(
        `Execution request ${record.executionIdentity} conflicts with persisted state.`,
        "conflict",
      );
    }
    return;
  }
  executionRequests.push(record);
};

/** Create a durable JSON-backed state boundary for worker coordination. */
export const createWorkerStateStore = (
  options: WorkerStateStoreOptions,
): WorkerStateStore => {
  if (options.filePath.trim() === "") {
    throw new WorkerStateStoreError("filePath must be a non-empty string");
  }
  const now = options.now ?? (() => new Date().toISOString());
  let queue = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(
      () => withStateLock(options.filePath, operation),
      () => withStateLock(options.filePath, operation),
    );
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    read: () => serialized(() => readState(options.filePath)),

    recordDiscovery: (result, recordOptions = {}) =>
      serialized(async () => {
        const state = await readState(options.filePath);
        const discoveredAt = ensureTimestamp(
          recordOptions.discoveredAt ?? now(),
          "discovery timestamp",
        );
        const taskSnapshots = [...state.taskSnapshots];
        const executionRequests = [...state.executionRequests];

        for (const decision of result.decisions) {
          const snapshot: TaskSnapshotRecord = {
            taskId: decision.taskId,
            task: cloneJson(decision.task),
            discoveredAt,
          };
          addTaskSnapshot(taskSnapshots, snapshot);
        }

        for (const request of result.executionRequests) {
          const record: ExecutionRequestRecord = {
            executionIdentity: request.executionIdentity,
            request: cloneJson(request),
            selectedAt: discoveredAt,
          };
          addExecutionRequest(executionRequests, record);
        }

        taskSnapshots.sort((left, right) =>
          snapshotKey(left).localeCompare(snapshotKey(right)),
        );
        executionRequests.sort((left, right) =>
          requestKey(left).localeCompare(requestKey(right)),
        );

        const next = freezeState({
          version: 1,
          taskSnapshots,
          executionRequests,
          attempts: [...state.attempts],
        });
        await writeState(options.filePath, next);
        return next;
      }),

    createAttempt: (request) =>
      serialized(async () => {
        const state = await readState(options.filePath);
        const existing = state.attempts.find(
          (attempt) => attempt.executionIdentity === request.executionIdentity,
        );
        if (existing !== undefined) {
          if (!sameJson(existing.request, request)) {
            throw new WorkerStateStoreError(
              `Execution attempt ${request.executionIdentity} conflicts with persisted state.`,
              "conflict",
            );
          }
          return existing;
        }

        const createdAt = ensureTimestamp(now(), "attempt creation timestamp");
        const taskSnapshots = [...state.taskSnapshots];
        const executionRequests = [...state.executionRequests];
        addTaskSnapshot(taskSnapshots, {
          taskId: request.taskId,
          task: cloneJson(request.task),
          discoveredAt: createdAt,
        });
        addExecutionRequest(executionRequests, {
          executionIdentity: request.executionIdentity,
          request: cloneJson(request),
          selectedAt: createdAt,
        });
        taskSnapshots.sort((left, right) =>
          snapshotKey(left).localeCompare(snapshotKey(right)),
        );
        executionRequests.sort((left, right) =>
          requestKey(left).localeCompare(requestKey(right)),
        );

        const attempt = deepFreeze({
          attemptId: `attempt:${request.executionIdentity}`,
          executionIdentity: request.executionIdentity,
          request: cloneJson(request),
          status: "active" as const,
          createdAt,
          updatedAt: createdAt,
          outcomes: [] as readonly AttemptOutcomeRecord[],
        });
        const next = freezeState({
          version: 1,
          taskSnapshots,
          executionRequests,
          attempts: [...state.attempts, attempt],
        });
        await writeState(options.filePath, next);
        return attempt;
      }),

    transitionAttempt: (attemptId, transition) =>
      serialized(async () => {
        const state = await readState(options.filePath);
        const attemptIndex = state.attempts.findIndex(
          (attempt) => attempt.attemptId === attemptId,
        );
        if (attemptIndex === -1) {
          throw new WorkerStateStoreError(
            `Execution attempt ${attemptId} was not found.`,
            "not_found",
          );
        }
        const current = state.attempts[attemptIndex]!;
        if (!canTransition(current.status, transition.status)) {
          throw new WorkerStateStoreError(
            `Execution attempt ${attemptId} cannot transition from ${current.status} to ${transition.status}.`,
            "invalid_transition",
          );
        }

        const timestamp = ensureTimestamp(
          transition.timestamp ?? now(),
          "transition timestamp",
        );
        const currentTime = Date.parse(current.updatedAt);
        if (Date.parse(timestamp) < currentTime) {
          throw new WorkerStateStoreError(
            `Execution attempt ${attemptId} cannot move backward in time.`,
            "invalid_transition",
          );
        }
        const evidence = [...(transition.evidence ?? [])].map((reference) => {
          if (typeof reference !== "string" || reference.trim() === "") {
            throw new WorkerStateStoreError(
              "Attempt evidence references must be non-empty strings.",
            );
          }
          return reference.trim();
        });
        const updated = deepFreeze({
          ...current,
          status: transition.status,
          updatedAt: timestamp,
          outcomes: [
            ...current.outcomes,
            {
              status: transition.status,
              timestamp,
              evidence,
            },
          ],
        });
        const attempts = [...state.attempts];
        attempts[attemptIndex] = updated;
        const next = freezeState({
          version: 1,
          taskSnapshots: [...state.taskSnapshots],
          executionRequests: [...state.executionRequests],
          attempts,
        });
        await writeState(options.filePath, next);
        return updated;
      }),
  };
};
