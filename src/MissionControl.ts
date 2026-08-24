import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createGitHubTaskSource,
  type GitHubTaskDiscoveryInput,
  type GitHubTaskSource,
  type GitHubTaskSourceOptions,
} from "./GitHubTaskSource.js";
import {
  runWorkerDryRun,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  createDefaultWorkerRepositoryOperations,
  createWorkerRepositoryManager,
  type WorkerRepositoryManager,
  type WorkerRepositoryManagerOptions,
  type WorkerRepositoryOperations,
} from "./WorkerRepositoryManager.js";
import {
  createDefaultWorkerPublicationOperations,
  createWorkerPublisher,
  type WorkerPublicationInspectionOperations,
  type WorkerPublisher,
} from "./WorkerPublication.js";
import {
  createJsonlWorkerDiagnostics,
  createWorkerService,
  workerServicePaths,
  type WorkerDiagnostic,
  type WorkerControlRequest,
  type WorkerControlOutcomeCode,
  type WorkerRecoveryAction,
  type WorkerRecoveryDisposition,
  type WorkerServiceControl,
  type WorkerDiagnostics,
  type WorkerOperationalState,
  type WorkerService,
  type WorkerServiceMode,
  type WorkerServicePaths,
} from "./WorkerService.js";
import {
  createWorkerStateStore,
  type ExecutionAttempt,
  type WorkerState,
  type WorkerStateStore,
} from "./WorkerStateStore.js";
import {
  createWorkerExecutionEngine,
  type WorkerExecutionEngine,
} from "./WorkerExecutionEngine.js";
import {
  createMissionControlReadModel,
  type MissionControlAttemptSummary,
  type MissionControlAttemptView,
  type MissionControlEventRecord,
  type MissionControlEvidenceContent,
  type MissionControlQueue,
  type MissionControlReadModel,
  type MissionControlReadModelOptions,
  type MissionControlTaskInbox,
  type MissionControlTaskView,
} from "./MissionControlReadModel.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";
import type { RepositoryWorkflowControl } from "./RepositoryWorkflowControl.js";
export { createMissionControlReadModel } from "./MissionControlReadModel.js";
import {
  createMissionControlPolicyAdministration,
  MissionControlPolicyError,
  readMissionControlPolicyConfiguration,
  type MissionControlPolicyAdministration,
  type MissionControlPolicyApplyOutcomeCode,
  type MissionControlPolicyValidation,
  type MissionControlPolicyPreview,
} from "./MissionControlPolicy.js";

/** HTTP bind and listen settings for the Mission Control operator surface. */
export interface MissionControlServerOptions {
  /** Interface to bind; defaults to loopback for a private operator surface. */
  readonly bindAddress?: string;
  /** TCP port; defaults to 3000. Port 0 is useful for an integration test. */
  readonly port?: number;
}

/** Central composition settings for one production Mission Control host. */
export interface MissionControlConfiguration {
  /** Existing worker authorization, dependency, profile, and prompt policy. */
  readonly worker: WorkerConfiguration;
  /** Durable root shared by the worker state and retained evidence. */
  readonly workspaceRoot: string;
  /** Stable lease owner for the one worker process. */
  readonly owner: string;
  /** Delay between completed worker cycles. */
  readonly pollIntervalMs: number;
  /** Duration of a revision-bound task lease. */
  readonly leaseDurationMs: number;
  /** Optional upper bound for setup, agent, and verification execution. */
  readonly executionTimeoutMs?: number;
  /** Server-side GitHub adapter settings, including any server-only token. */
  readonly github?: GitHubTaskSourceOptions;
  /** Sandcastle agent and sandbox options used by the repository boundary. */
  readonly agentRunOptions?: WorkerRepositoryManagerOptions["agentRunOptions"];
  /** Minimal environment for centrally approved setup and verification commands. */
  readonly commandEnvironment?: Readonly<Record<string, string>>;
  /** Read-only discovery modes selected by the operator. */
  readonly discovery?: Omit<GitHubTaskDiscoveryInput, "configuration">;
  /** Operator HTTP settings. */
  readonly server?: MissionControlServerOptions;
  /** Optional server-owned policy file; defaults under the durable root. */
  readonly policyFilePath?: string;
  /** Optional append-only policy audit; defaults to operator/commands.jsonl. */
  readonly policyAuditFilePath?: string;
}

/** Injectable boundaries used by integration tests and alternate deployments. */
export interface MissionControlHostBoundaries {
  /** Optional multi-repository workflow control plane exposed to operators. */
  readonly repositoryWorkflows?: RepositoryWorkflowControl;
  /** Replace the default read-only GitHub adapter. */
  readonly source?: GitHubTaskSource;
  /** Replace repository preparation while retaining host composition. */
  readonly repositoryManager?: WorkerRepositoryManager;
  /** Replace execution while retaining host composition. */
  readonly execution?: WorkerExecutionEngine;
  /** Replace guarded publication while retaining host composition. */
  readonly publisher?: WorkerPublisher;
  /** Replace local Git operations used by the default repository manager. */
  readonly repositoryOperations?: WorkerRepositoryOperations;
  /** Replace GitHub/Git operations used by the default publisher. */
  readonly publicationOperations?: WorkerPublicationInspectionOperations;
  /** Observe diagnostics in addition to the durable JSONL sink. */
  readonly diagnostics?: WorkerDiagnostics;
}

/** Inputs for creating a composed Mission Control host. */
export interface MissionControlHostOptions {
  readonly configuration: MissionControlConfiguration;
  readonly boundaries?: MissionControlHostBoundaries;
}

/** Stable fields returned for the current active attempt. */
export interface MissionControlActiveAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly executionIdentity: string;
  readonly phase: "claimed" | "started";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A warning requiring operator attention during worker recovery. */
export interface MissionControlRecoveryWarning {
  readonly attemptId: string;
  readonly taskId: string;
  readonly reasonCode: string;
  readonly message: string;
  /** Recovery classification surfaced without granting new authority. */
  readonly disposition?: WorkerRecoveryDisposition;
  /** Fixed operator actions permitted for this classification. */
  readonly availableActions: readonly WorkerRecoveryAction[];
}

/** Current count of tasks in each diagnostic operational state. */
export type MissionControlOperationalStateCounts = Readonly<
  Record<WorkerOperationalState, number>
>;

/** Versioned, secret-free read model returned by the overview endpoint. */
export interface MissionControlOverview {
  readonly version: 1;
  readonly revision: number;
  readonly mode: WorkerServiceMode;
  readonly pauseRequested: boolean;
  readonly activeAttempt: MissionControlActiveAttempt | null;
  readonly lastCompletedCycle: string | null;
  readonly nextExpectedCycle: string | null;
  readonly recoveryWarnings: readonly MissionControlRecoveryWarning[];
  readonly operationalStateCounts: MissionControlOperationalStateCounts;
}

export type {
  MissionControlAttemptSummary,
  MissionControlAttemptTimelineEntry,
  MissionControlAttemptView,
  MissionControlClaimView,
  MissionControlCommandEvidence,
  MissionControlEligibility,
  MissionControlEventRecord,
  MissionControlEvidenceContent,
  MissionControlEvidenceReference,
  MissionControlExecutionInspection,
  MissionControlQueue,
  MissionControlQueueEntry,
  MissionControlReadModel,
  MissionControlReadModelOptions,
  MissionControlTaskInbox,
  MissionControlTaskReference,
  MissionControlTaskView,
} from "./MissionControlReadModel.js";

/** Address returned after the HTTP server is ready. */
export interface MissionControlListeningAddress {
  readonly host: string;
  readonly port: number;
}

/** A typed failure raised before Mission Control constructs or serves anything. */
export class MissionControlConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Mission Control configuration: ${issues.join("; ")}`);
    this.name = "MissionControlConfigurationError";
    this.issues = [...issues];
  }
}

/** Composed production host and its overview plus guarded control surface. */
export interface MissionControlHost {
  readonly repositoryWorkflows?: RepositoryWorkflowControl;
  readonly paths: WorkerServicePaths;
  readonly source: GitHubTaskSource;
  readonly store: WorkerStateStore;
  readonly repositoryManager: WorkerRepositoryManager;
  readonly execution: WorkerExecutionEngine;
  readonly publisher: WorkerPublisher;
  readonly diagnostics: WorkerDiagnostics;
  readonly service: WorkerService;
  readonly control: WorkerServiceControl;
  readonly readModel: MissionControlReadModel;
  readonly policy: MissionControlPolicyAdministration;
  readonly policyFilePath: string;
  readonly policyAuditFilePath: string;
  readonly server: Server;
  listen(): Promise<MissionControlListeningAddress>;
  /** Listen and run the continuous worker until it is stopped. */
  start(): Promise<void>;
  /** Stop the worker and close the operator surface. */
  stop(): Promise<void>;
  /** Rebuild and return the disposable overview read model. */
  getOverview(): Promise<MissionControlOverview>;
  getTaskInbox(): Promise<MissionControlTaskInbox>;
  getTask(taskId: string): Promise<MissionControlTaskView | undefined>;
  getQueue(): Promise<MissionControlQueue>;
  getAttempts(): Promise<readonly MissionControlAttemptSummary[]>;
  getAttempt(attemptId: string): Promise<MissionControlAttemptView | undefined>;
  getEvidence(
    evidenceId: string,
  ): Promise<MissionControlEvidenceContent | undefined>;
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

const emptyOperationalStateCounts = (): Record<
  WorkerOperationalState,
  number
> =>
  Object.fromEntries(OPERATIONAL_STATES.map((state) => [state, 0])) as Record<
    WorkerOperationalState,
    number
  >;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOperationalState = (value: unknown): value is WorkerOperationalState =>
  typeof value === "string" &&
  (OPERATIONAL_STATES as readonly string[]).includes(value);

const isAuthorizationSource = (
  value: unknown,
): value is "repository" | "task" | "none" =>
  value === "repository" || value === "task" || value === "none";

const redactDurablePaths = (
  value: string,
  roots: readonly string[],
): string => {
  let result = value;
  for (const root of roots) {
    if (root !== "") result = result.replaceAll(root, "[durable-root]");
  }
  return result;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const validatePositiveFinite = (
  value: unknown,
  name: string,
  issues: string[],
): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`${name} must be a positive finite number`);
  }
};

/** Validate host settings and the existing central worker policy without I/O. */
export const validateMissionControlConfiguration = (
  configuration: MissionControlConfiguration,
): void => {
  // The coordinator is the authoritative policy validator. It performs no source,
  // filesystem, checkout, agent, publication, or HTTP work.
  runWorkerDryRun({ configuration: configuration.worker, tasks: [] });

  const issues: string[] = [];
  if (!isNonEmptyString(configuration.workspaceRoot)) {
    issues.push("workspaceRoot must be non-empty");
  }
  if (!isNonEmptyString(configuration.owner)) {
    issues.push("owner must be non-empty");
  }
  validatePositiveFinite(
    configuration.pollIntervalMs,
    "pollIntervalMs",
    issues,
  );
  validatePositiveFinite(
    configuration.leaseDurationMs,
    "leaseDurationMs",
    issues,
  );
  if (
    configuration.executionTimeoutMs !== undefined &&
    (typeof configuration.executionTimeoutMs !== "number" ||
      !Number.isFinite(configuration.executionTimeoutMs) ||
      configuration.executionTimeoutMs <= 0)
  ) {
    issues.push("executionTimeoutMs must be a positive finite number");
  }

  const server = configuration.server ?? {};
  const bindAddress = server.bindAddress ?? "127.0.0.1";
  if (!isNonEmptyString(bindAddress)) {
    issues.push("server.bindAddress must be non-empty");
  }
  const port = server.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    issues.push("server.port must be an integer between 0 and 65535");
  }

  if (issues.length > 0) throw new MissionControlConfigurationError(issues);
};

const parseDiagnostic = (
  value: unknown,
  durableRoots: readonly string[] = [],
): WorkerDiagnostic | undefined => {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "string" ||
    !isOperationalState(value.state) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return {
    timestamp: value.timestamp,
    state: value.state,
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.attemptId === "string"
      ? { attemptId: value.attemptId }
      : {}),
    ...(typeof value.executionIdentity === "string"
      ? { executionIdentity: value.executionIdentity }
      : {}),
    ...(isAuthorizationSource(value.authorizationSource)
      ? { authorizationSource: value.authorizationSource }
      : {}),
    ...(typeof value.eligible === "boolean"
      ? { eligible: value.eligible }
      : {}),
    ...(typeof value.sourceRevision === "string"
      ? { sourceRevision: value.sourceRevision }
      : {}),
    ...(typeof value.reasonCode === "string"
      ? { reasonCode: value.reasonCode }
      : {}),
    message: containsProtectedWorkerMaterial(value.message)
      ? "Protected worker material redacted."
      : redactDurablePaths(value.message, durableRoots),
  };
};

const readDiagnosticEvents = async (
  filePath: string,
  durableRoots: readonly string[] = [],
): Promise<readonly MissionControlEventRecord[]> => {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const events: MissionControlEventRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const event = parseDiagnostic(JSON.parse(line), durableRoots);
      if (event !== undefined) {
        events.push({ id: events.length + 1, event });
      }
    } catch {
      // A partial final JSONL line must not make the read-only overview unavailable.
    }
  }
  return events;
};

const stateForAttempt = (attempt: ExecutionAttempt): WorkerOperationalState => {
  if (attempt.status === "published") return "published";
  if (attempt.status === "verified") return "verified";
  if (attempt.status === "failed") return "failed";
  if (attempt.status === "interrupted") return "blocked";
  return attempt.claim?.phase === "started" ? "running" : "claimed";
};

const currentOperationalStateCounts = (
  state: WorkerState,
  diagnostics: readonly WorkerDiagnostic[],
): MissionControlOperationalStateCounts => {
  const latestByTask = new Map<string, WorkerOperationalState>();
  for (const event of diagnostics) {
    if (event.taskId !== undefined) latestByTask.set(event.taskId, event.state);
  }

  // State remains useful after a diagnostics rotation or a first boot with no
  // diagnostics file. It only fills identities that the diagnostic projection lacks.
  const attemptsByTask = new Map<string, ExecutionAttempt>();
  for (const attempt of state.attempts) {
    const existing = attemptsByTask.get(attempt.request.taskId);
    if (
      existing === undefined ||
      Date.parse(existing.updatedAt) <= Date.parse(attempt.updatedAt)
    ) {
      attemptsByTask.set(attempt.request.taskId, attempt);
    }
  }
  for (const [taskId, attempt] of attemptsByTask) {
    if (!latestByTask.has(taskId))
      latestByTask.set(taskId, stateForAttempt(attempt));
  }

  const counts = emptyOperationalStateCounts();
  for (const operationalState of latestByTask.values()) {
    counts[operationalState] += 1;
  }
  return counts;
};

const activeAttemptView = (
  attempts: readonly ExecutionAttempt[],
): MissionControlActiveAttempt | null => {
  const active = attempts
    .filter((attempt) => attempt.status === "active")
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];
  if (active === undefined || active.claim === undefined) return null;
  return {
    attemptId: active.attemptId,
    taskId: active.request.taskId,
    executionIdentity: active.executionIdentity,
    phase: active.claim.phase,
    createdAt: active.createdAt,
    updatedAt: active.updatedAt,
  };
};

const recoveryWarnings = async (
  state: WorkerState,
  store: WorkerStateStore,
): Promise<readonly MissionControlRecoveryWarning[]> => {
  const warnings: MissionControlRecoveryWarning[] = [];
  const expired = new Map(
    (await store.inspectExpiredLeases({ at: new Date().toISOString() })).map(
      (recovery) => [recovery.attemptId, recovery],
    ),
  );
  for (const attempt of state.attempts) {
    if (attempt.status === "active" && attempt.claim?.phase === "started") {
      warnings.push({
        attemptId: attempt.attemptId,
        taskId: attempt.request.taskId,
        reasonCode: "manual_intervention",
        disposition: "manual_intervention",
        availableActions: ["acknowledge"],
        message:
          "This attempt may have side effects and requires operator review.",
      });
      continue;
    }
    if (attempt.status === "active" && attempt.claim?.phase === "claimed") {
      const recovery = expired.get(attempt.attemptId);
      if (recovery !== undefined) {
        warnings.push({
          attemptId: attempt.attemptId,
          taskId: attempt.request.taskId,
          reasonCode: recovery.disposition,
          disposition: recovery.disposition,
          availableActions:
            recovery.disposition === "safe_retry" ? ["retry"] : [],
          message: "This expired claim is retained for worker recovery.",
        });
        continue;
      }
      warnings.push({
        attemptId: attempt.attemptId,
        taskId: attempt.request.taskId,
        reasonCode: "safe_resume",
        disposition: "safe_resume",
        availableActions: [],
        message:
          "This live unstarted claim is safe to resume; retry is not permitted.",
      });
      continue;
    }
    if (attempt.status === "interrupted") {
      warnings.push({
        attemptId: attempt.attemptId,
        taskId: attempt.request.taskId,
        reasonCode: "interrupted_attempt",
        availableActions: [],
        message: "This interrupted attempt remains retained for inspection.",
      });
    }
  }
  return warnings;
};

const overviewHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mission Control</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #111827; color: #e5e7eb; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; background: #111827; }
      main { width: min(1180px, 100%); margin: 0 auto; padding: 2rem; }
      header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
      h1, h2, p { margin: 0; }
      h1 { letter-spacing: -0.04em; }
      h2 { font-size: 1rem; margin-bottom: 0.9rem; color: #cbd5e1; }
      .muted { color: #94a3b8; }
      .panel { background: #1f2937; border: 1px solid #374151; border-radius: 0.9rem; padding: 1.2rem; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
      .metric strong { display: block; font-size: 1.35rem; margin-top: 0.35rem; overflow-wrap: anywhere; }
      .metric small { color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; }
      .stack { display: grid; gap: 1rem; margin-top: 1rem; }
      #warnings { color: #fbbf24; }
      .recovery-warning { display: grid; gap: 0.45rem; padding: 0.7rem 0; border-bottom: 1px solid #374151; }
      .recovery-warning:last-child { border-bottom: 0; }
      .recovery-warning strong { color: #fde68a; }
      .recovery-warning button { justify-self: start; padding: 0.45rem 0.7rem; border: 1px solid #f59e0b; border-radius: 0.4rem; background: #92400e; color: #fffbeb; cursor: pointer; }
      #counts { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
      .count { display: flex; justify-content: space-between; gap: 1rem; }
      .controls { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.9rem; }
      .controls input { flex: 1 1 240px; min-width: 0; padding: 0.55rem 0.7rem; border: 1px solid #4b5563; border-radius: 0.45rem; background: #111827; color: inherit; }
      .controls button { padding: 0.55rem 0.8rem; border: 1px solid #60a5fa; border-radius: 0.45rem; background: #1d4ed8; color: #eff6ff; cursor: pointer; }
      .controls button:disabled { cursor: not-allowed; opacity: 0.45; }
      code { color: #bfdbfe; overflow-wrap: anywhere; }
      .list { display: grid; gap: 0.65rem; }
      .list-item { border: 1px solid #374151; border-radius: 0.55rem; padding: 0.75rem; line-height: 1.45; overflow-wrap: anywhere; }
      .list-item strong { color: #f8fafc; }
      .list-item a { color: #93c5fd; }
      .state { color: #fcd34d; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.8rem; }
      .event-stream { max-height: 16rem; overflow: auto; }
      @media (max-width: 720px) {
        main { padding: 1rem; }
        header { display: block; }
        header .muted { margin-top: 0.5rem; }
        .grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 440px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Mission Control</h1>
        <p class="muted" id="updated" aria-live="polite">Loading overview…</p>
      </header>
      <section class="grid" aria-label="Worker summary">
        <div class="panel metric"><small>Mode</small><strong id="mode">—</strong></div>
        <div class="panel metric"><small>Active attempt</small><strong id="attempt">None</strong></div>
        <div class="panel metric"><small>Last completed cycle</small><strong id="last-cycle">—</strong></div>
        <div class="panel metric"><small>Next expected cycle</small><strong id="next-cycle">—</strong></div>
      </section>
      <div class="stack">
        <section class="panel"><h2>Recovery controls</h2><div id="warnings" class="muted">None</div></section>
        <section class="panel">
          <h2>Runtime controls</h2>
          <p class="muted">Every action is revision-checked and retained in the operator audit.</p>
          <div class="controls">
            <input id="operator" aria-label="Operator identity" placeholder="Operator identity (for acknowledgement)" autocomplete="off">
            <input id="reason" aria-label="Operator reason" placeholder="Operator reason" autocomplete="off">
            <button data-command="run-now">Run cycle now</button>
            <button data-command="pause">Pause polling</button>
            <button data-command="resume">Resume polling</button>
            <button id="cancel" data-command="cancel" disabled>Cancel active execution</button>
          </div>
          <p class="muted" id="control-status" aria-live="polite"></p>
        </section>
        <section class="panel"><h2>Operational state counts</h2><div id="counts" class="grid"></div></section>
        <section class="panel"><h2>Authorized repositories</h2><p class="muted">Select a repository to inspect workflow cycles, task stages, commits, and retained log references.</p><div id="repositories" class="list"></div><pre id="repository-detail" class="list-item muted">Select a repository.</pre></section>
        <section class="panel"><h2>Task inbox</h2><p class="muted">Repository-qualified snapshots and worker eligibility decisions.</p><div id="tasks" class="list"></div></section>
        <section class="panel"><h2>Deterministic ready queue</h2><p class="muted">Order is emitted by the worker and is not recalculated by this page.</p><div id="queue" class="list"></div></section>
        <section class="panel"><h2>Attempts</h2><p class="muted">Claim, lease, lifecycle, evidence, and publication inspection is available through the versioned API.</p><div id="attempts" class="list"></div></section>
        <section class="panel"><h2>Live operational events</h2><div id="events" class="list event-stream"></div></section>
      </div>
    </main>
    <script>
      const labels = { discovered: "Discovered", unauthorized: "Unauthorized", ineligible: "Ineligible", ready: "Ready", claimed: "Claimed", running: "Running", blocked: "Blocked", failed: "Failed", verified: "Verified", published: "Published" };
      const recoveryLabels = { safe_retry: "Safe retry", safe_resume: "Safe resume", manual_intervention: "Manual intervention", interrupted_attempt: "Interrupted attempt" };
      const text = (id, value) => { document.getElementById(id).textContent = value; };
      const formatTime = (value) => value ? new Date(value).toLocaleString() : "—";
      let latestRevision = 0;
      let activeAttemptId = null;
      const appendLine = (parent, value, className) => { const item = document.createElement("div"); item.className = className || "list-item"; item.textContent = value; parent.append(item); return item; };
      const repositoryUrl = (repository, action) => "/api/v1/repositories/" + repository.split("/").map(encodeURIComponent).join("/") + (action ? "/" + action : "");
      const renderRepositories = async () => {
        const response = await fetch("/api/v1/repositories", { cache: "no-store" });
        const list = document.getElementById("repositories"); list.replaceChildren();
        if (!response.ok) { appendLine(list, "Repository workflows are not configured.", "muted"); return; }
        const payload = await response.json();
        payload.repositories.forEach((repository) => {
          const item = document.createElement("div"); item.className = "list-item";
          const select = document.createElement("button"); select.dataset.repository = repository.repository; select.textContent = repository.repository;
          const status = document.createTextNode(" • " + repository.mode + " • " + repository.workflowId + " • cycle " + repository.nextCycle + " ");
          const action = document.createElement("button"); action.dataset.repositoryAction = repository.mode === "paused" ? "resume" : "pause"; action.dataset.repository = repository.repository; action.textContent = repository.mode === "paused" ? "Resume" : "Pause";
          item.append(select, status, action); list.append(item);
        });
        if (payload.repositories.length === 0) appendLine(list, "No authorized repositories.", "muted");
      };
      const inspectRepository = async (repository) => {
        const response = await fetch(repositoryUrl(repository), { cache: "no-store" });
        text("repository-detail", response.ok ? JSON.stringify(await response.json(), null, 2) : "Repository inspection unavailable.");
      };
      const renderInspection = async () => {
        try {
          const [tasksResponse, queueResponse, attemptsResponse] = await Promise.all([
            fetch("/api/v1/tasks", { cache: "no-store" }),
            fetch("/api/v1/queue", { cache: "no-store" }),
            fetch("/api/v1/attempts", { cache: "no-store" })
          ]);
          if (!tasksResponse.ok || !queueResponse.ok || !attemptsResponse.ok) throw new Error("inspection unavailable");
          const tasks = await tasksResponse.json();
          const queue = await queueResponse.json();
          const attempts = await attemptsResponse.json();
          const taskList = document.getElementById("tasks"); taskList.replaceChildren();
          tasks.tasks.forEach((task) => {
            const item = appendLine(taskList, "");
            const heading = document.createElement("strong"); heading.textContent = task.taskId + " — " + task.title; item.replaceChildren(heading);
            const details = document.createElement("div"); details.className = "muted";
            details.textContent = [task.state, "authorization=" + task.authorizationSource, "reason=" + task.eligibilityReasonCode, "source=" + task.sourceRevision, "base=" + task.baseBranch + "@" + task.baseCommit, "profile=" + (task.profileId || "—"), "prompt=" + (task.promptVersion || "—"), "dependencies=" + task.dependencies.length, "parent=" + (task.parentPrd ? task.parentPrd.taskId : "—"), "execution=" + (task.executionIdentity || "—")].join(" • "); item.append(details);
          });
          if (tasks.tasks.length === 0) appendLine(taskList, "No retained task snapshots.", "muted");
          const queueList = document.getElementById("queue"); queueList.replaceChildren();
          queue.queue.forEach((entry) => appendLine(queueList, entry.position + ". " + entry.taskId + " — " + entry.title + " • execution=" + entry.executionIdentity));
          if (queue.queue.length === 0) appendLine(queueList, "The worker has no ready tasks.", "muted");
          const attemptList = document.getElementById("attempts"); attemptList.replaceChildren();
          attempts.attempts.forEach((attempt) => {
            const item = document.createElement("div"); item.className = "list-item";
            const link = document.createElement("a"); link.href = "/api/v1/attempts/" + encodeURIComponent(attempt.attemptId); link.textContent = attempt.attemptId;
            item.append(link, document.createTextNode(" • " + attempt.status + " • " + attempt.taskId + " • execution=" + attempt.executionIdentity)); attemptList.append(item);
          });
          if (attempts.attempts.length === 0) appendLine(attemptList, "No retained attempts.", "muted");
        } catch { /* The overview remains useful while inspection is unavailable. */ }
      };
      async function refresh() {
        try {
          const response = await fetch("/api/v1/overview", { cache: "no-store" });
          if (!response.ok) throw new Error("overview unavailable");
          const overview = await response.json();
          latestRevision = overview.revision;
          activeAttemptId = overview.activeAttempt ? overview.activeAttempt.attemptId : null;
          document.getElementById("cancel").disabled = activeAttemptId === null;
          text("mode", overview.mode);
          text("attempt", overview.activeAttempt ? overview.activeAttempt.attemptId : "None");
          text("last-cycle", formatTime(overview.lastCompletedCycle));
          text("next-cycle", formatTime(overview.nextExpectedCycle));
          text("updated", "Updated " + new Date().toLocaleTimeString());
          renderRecoveryWarnings(overview.recoveryWarnings);
          const counts = document.getElementById("counts");
          counts.replaceChildren(...Object.entries(overview.operationalStateCounts).map(([state, count]) => {
            const item = document.createElement("div"); item.className = "panel count";
            const label = document.createElement("span"); label.textContent = labels[state] || state;
            const value = document.createElement("strong"); value.textContent = String(count);
            item.append(label, value); return item;
          }));
          void renderInspection();
          void renderRepositories();
        } catch { text("updated", "Overview unavailable"); }
      }
      function renderRecoveryWarnings(recoveryWarnings) {
        const warnings = document.getElementById("warnings");
        warnings.replaceChildren();
        if (recoveryWarnings.length === 0) { warnings.textContent = "None"; return; }
        recoveryWarnings.forEach((warning) => {
          const item = document.createElement("div"); item.className = "recovery-warning";
          const title = document.createElement("strong"); title.textContent = (recoveryLabels[warning.reasonCode] || warning.reasonCode) + " · " + warning.attemptId;
          const detail = document.createElement("span"); detail.textContent = warning.message;
          item.append(title, detail);
          (warning.availableActions || []).forEach((action) => {
            const button = document.createElement("button");
            button.dataset.command = action;
            button.dataset.attemptId = warning.attemptId;
            button.textContent = action === "retry" ? "Retry safely" : "Acknowledge manual intervention";
            item.append(button);
          });
          if (warning.reasonCode === "safe_resume") {
            const safeResume = document.createElement("span"); safeResume.textContent = "Safe resume is automatic at the next worker cycle."; item.append(safeResume);
          }
          warnings.append(item);
        });
      }
      async function sendCommand(command, targetAttemptId) {
        const operatorInput = document.getElementById("operator");
        const reasonInput = document.getElementById("reason");
        const operator = operatorInput.value.trim();
        const reason = reasonInput.value.trim();
        if (!reason) { text("control-status", "Enter an operator reason first."); return; }
        if (command === "acknowledge" && !operator) { text("control-status", "Enter an operator identity first."); return; }
        const commandId = command + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const payload = { command, commandId, expectedRevision: latestRevision, reason };
        if (operator) payload.operator = operator;
        if (targetAttemptId) payload.attemptId = targetAttemptId;
        else if (command === "cancel") payload.attemptId = activeAttemptId;
        try {
          const response = await fetch("/api/v1/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          const outcome = await response.json();
          if (typeof outcome.revision === "number") latestRevision = outcome.revision;
          text("control-status", outcome.code + ": " + outcome.message);
          void refresh();
        } catch { text("control-status", "Command unavailable."); }
      }
      document.addEventListener("click", (event) => {
        const target = event.target;
        const repositoryAction = target && target.closest ? target.closest("[data-repository-action]") : null;
        if (repositoryAction) {
          void fetch(repositoryUrl(repositoryAction.dataset.repository, repositoryAction.dataset.repositoryAction), { method: "POST" }).then(() => { void renderRepositories(); void inspectRepository(repositoryAction.dataset.repository); });
          return;
        }
        const repository = target && target.closest ? target.closest("[data-repository]") : null;
        if (repository) { void inspectRepository(repository.dataset.repository); return; }
        const button = target && target.closest ? target.closest("[data-command]") : null;
        if (button) void sendCommand(button.dataset.command, button.dataset.attemptId);
      });
      const eventSource = new EventSource("/api/v1/events");
      eventSource.addEventListener("worker", (message) => {
        try {
          const payload = JSON.parse(message.data);
          const eventList = document.getElementById("events");
          const item = document.createElement("div"); item.className = "list-item";
          item.textContent = "#" + payload.id + " • " + payload.event.state + " • " + (payload.event.taskId || "worker") + " • " + payload.event.message;
          eventList.prepend(item);
          while (eventList.children.length > 50) eventList.lastElementChild.remove();
      });
      void refresh();
      setInterval(() => void refresh(), 5000);
    </script>
  </body>
</html>`;

const writeJson = (
  response: import("node:http").ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
};

const writeHtml = (
  response: import("node:http").ServerResponse,
  value: string,
): void => {
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(value));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(value);
};

const writeSseEvent = (
  response: import("node:http").ServerResponse,
  record: MissionControlEventRecord,
): void => {
  response.write(
    `id: ${record.id}\nevent: worker\ndata: ${JSON.stringify({
      version: 1,
      id: record.id,
      event: record.event,
    })}\n\n`,
  );
};

const parseLastEventId = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/u.test(value.trim())) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const decodePathValue = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === "" ? undefined : decoded;
  } catch {
    return undefined;
  }
};

const readJsonBody = (
  request: import("node:http").IncomingMessage,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > 64 * 1024) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("request_body_too_large"));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });

const parseControlRequest = (
  value: unknown,
): WorkerControlRequest | undefined => {
  if (!isRecord(value)) return undefined;
  const command = value.command;
  if (
    command !== "run-now" &&
    command !== "pause" &&
    command !== "resume" &&
    command !== "cancel" &&
    command !== "retry" &&
    command !== "acknowledge" &&
    command !== "recover"
  ) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.commandId) ||
    typeof value.expectedRevision !== "number" ||
    !Number.isInteger(value.expectedRevision) ||
    value.expectedRevision < 0
  ) {
    return undefined;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return undefined;
  }
  if (value.attemptId !== undefined && typeof value.attemptId !== "string") {
    return undefined;
  }
  if (value.operator !== undefined && typeof value.operator !== "string") {
    return undefined;
  }
  if (value.operatorId !== undefined && typeof value.operatorId !== "string") {
    return undefined;
  }
  const recoveryAction = value.recoveryAction ?? value.action;
  if (
    recoveryAction !== undefined &&
    recoveryAction !== "retry" &&
    recoveryAction !== "acknowledge"
  ) {
    return undefined;
  }
  return {
    command,
    commandId: value.commandId,
    expectedRevision: value.expectedRevision,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
    ...(value.operator === undefined ? {} : { operator: value.operator }),
    ...(value.operatorId === undefined ? {} : { operatorId: value.operatorId }),
    ...(recoveryAction === undefined ? {} : { recoveryAction }),
  };
};

const controlOutcomeStatusCode = (code: WorkerControlOutcomeCode): number => {
  switch (code) {
    case "accepted":
    case "already_applied":
      return 200;
    case "command_failed":
    case "service_unhealthy":
      return 503;
    default:
      return 409;
  }
};

const policyOutcomeStatusCode = (
  code: MissionControlPolicyApplyOutcomeCode,
): number => {
  switch (code) {
    case "accepted":
    case "already_applied":
      return 200;
    case "command_failed":
      return 503;
    case "invalid_request":
    case "invalid_policy":
      return 422;
    default:
      return 409;
  }
};

const closeServer = (server: Server): Promise<void> => {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

/** Compose the existing worker into a systemd-friendly host and read-only overview. */
export const createMissionControlHost = (
  options: MissionControlHostOptions,
): MissionControlHost => {
  validateMissionControlConfiguration(options.configuration);
  const configuration = options.configuration;
  const boundaries = options.boundaries ?? {};
  const compositionIssues: string[] = [];
  if (
    boundaries.repositoryManager === undefined &&
    configuration.agentRunOptions === undefined
  ) {
    compositionIssues.push(
      "agentRunOptions are required when repositoryManager is not supplied",
    );
  }
  if (
    boundaries.publisher === undefined &&
    boundaries.publicationOperations === undefined &&
    !isNonEmptyString(configuration.github?.token)
  ) {
    compositionIssues.push(
      "github.token is required when publisher and publicationOperations are not supplied",
    );
  }
  if (compositionIssues.length > 0) {
    throw new MissionControlConfigurationError(compositionIssues);
  }

  const paths = workerServicePaths(configuration.workspaceRoot);
  const policyFilePath =
    configuration.policyFilePath ??
    join(paths.workspaceRoot, "policy", "worker.json");
  const policyAuditFilePath =
    configuration.policyAuditFilePath ?? paths.operatorAuditFilePath;
  let activeWorkerConfiguration: WorkerConfiguration;
  try {
    activeWorkerConfiguration = readMissionControlPolicyConfiguration(
      policyFilePath,
      configuration.worker,
    );
  } catch (error) {
    throw new MissionControlConfigurationError([
      error instanceof MissionControlPolicyError
        ? error.message
        : "The server-owned policy configuration could not be loaded.",
    ]);
  }
  const source =
    boundaries.source ?? createGitHubTaskSource(configuration.github ?? {});
  const store = createWorkerStateStore({ filePath: paths.stateFilePath });
  const repositoryManager =
    boundaries.repositoryManager ??
    createWorkerRepositoryManager({
      workspaceRoot: paths.workspaceRoot,
      agentRunOptions: configuration.agentRunOptions!,
      operations:
        boundaries.repositoryOperations ??
        createDefaultWorkerRepositoryOperations({
          commandEnvironment: configuration.commandEnvironment,
        }),
      commandEnvironment: configuration.commandEnvironment,
    });
  const execution =
    boundaries.execution ??
    createWorkerExecutionEngine({
      configuration: activeWorkerConfiguration,
      configurationProvider: () => activeWorkerConfiguration,
      repositoryManager,
      store,
      recordsRoot: paths.recordsRoot,
    });
  const publisher =
    boundaries.publisher ??
    createWorkerPublisher({
      configuration: activeWorkerConfiguration,
      configurationProvider: () => activeWorkerConfiguration,
      workspaceRoot: paths.workspaceRoot,
      store,
      operations:
        boundaries.publicationOperations ??
        createDefaultWorkerPublicationOperations({
          token: configuration.github?.token ?? "",
        }),
    });
  const durableDiagnostics = createJsonlWorkerDiagnostics(
    paths.diagnosticsFilePath,
  );
  const durableRoots = [
    paths.workspaceRoot,
    paths.recordsRoot,
    paths.repositoriesRoot,
  ];
  let eventJournal: MissionControlEventRecord[] | undefined;
  let eventJournalLoad: Promise<MissionControlEventRecord[]> | undefined;
  let eventAppendInFlight = Promise.resolve();
  const eventSubscribers = new Set<{
    readonly response: import("node:http").ServerResponse;
    lastSentId: number;
  }>();
  const ensureEventJournal = async (): Promise<MissionControlEventRecord[]> => {
    if (eventJournal !== undefined) return eventJournal;
    eventJournalLoad ??= readDiagnosticEvents(
      paths.diagnosticsFilePath,
      durableRoots,
    ).then((records) => {
      eventJournal = [...records];
      return eventJournal;
    });
    return eventJournalLoad;
  };
  const emitDiagnostic = async (event: WorkerDiagnostic): Promise<void> => {
    const safeEvent: WorkerDiagnostic = {
      ...event,
      message: containsProtectedWorkerMaterial(event.message)
        ? "Protected worker material redacted."
        : redactDurablePaths(event.message, durableRoots),
    };
    const write = eventAppendInFlight.then(async () => {
      const journal = await ensureEventJournal();
      await durableDiagnostics.emit(safeEvent);
      await boundaries.diagnostics?.emit(safeEvent);
      const record: MissionControlEventRecord = {
        id: journal.length + 1,
        event: safeEvent,
      };
      journal.push(record);
      for (const subscriber of eventSubscribers) {
        if (record.id <= subscriber.lastSentId) continue;
        try {
          writeSseEvent(subscriber.response, record);
          subscriber.lastSentId = record.id;
        } catch {
          eventSubscribers.delete(subscriber);
        }
      }
    });
    eventAppendInFlight = write.catch(() => undefined);
    await write;
  };
  const getEvents = async (): Promise<readonly MissionControlEventRecord[]> => {
    await eventAppendInFlight;
    return ensureEventJournal();
  };
  const diagnostics: WorkerDiagnostics = { emit: emitDiagnostic };
  const service = createWorkerService({
    configuration: activeWorkerConfiguration,
    configurationProvider: () => activeWorkerConfiguration,
    onConfigurationApplied: (nextConfiguration) => {
      activeWorkerConfiguration = nextConfiguration;
    },
    source,
    store,
    execution,
    publisher,
    owner: configuration.owner,
    pollIntervalMs: configuration.pollIntervalMs,
    leaseDurationMs: configuration.leaseDurationMs,
    executionTimeoutMs: configuration.executionTimeoutMs,
    lockFilePath: paths.serviceLockFilePath,
    discovery: configuration.discovery,
    diagnostics,
    operatorAuditFilePath: paths.operatorAuditFilePath,
    additionalOperatorAuditFilePaths:
      policyAuditFilePath === paths.operatorAuditFilePath
        ? undefined
        : [policyAuditFilePath],
  });

  const policy = createMissionControlPolicyAdministration({
    configuration: () => activeWorkerConfiguration,
    policyFilePath,
    auditFilePath: policyAuditFilePath,
    getWorkerRevision: () => service.status().revision,
    readTasks: async () => {
      const state = await store.read();
      const latest = new Map<
        string,
        {
          readonly discoveredAt: string;
          readonly task: (typeof state.taskSnapshots)[number]["task"];
        }
      >();
      for (const snapshot of state.taskSnapshots) {
        const existing = latest.get(snapshot.taskId);
        if (
          existing === undefined ||
          snapshot.discoveredAt >= existing.discoveredAt
        ) {
          latest.set(snapshot.taskId, snapshot);
        }
      }
      return [...latest.values()].map((snapshot) => snapshot.task);
    },
    updateWorkerConfiguration: (request) =>
      service.updateConfiguration(request),
  });
  const readModel = createMissionControlReadModel({
    configuration: configuration.worker,
    paths,
    store,
    status: service.status,
    getEvents,
  });

  const serverOptions = configuration.server ?? {};
  const bindAddress = serverOptions.bindAddress ?? "127.0.0.1";
  const port = serverOptions.port ?? 3000;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mission-control.invalid");
      if (url.pathname === "/api/v1/repositories") {
        const repositoryWorkflows = boundaries.repositoryWorkflows;
        if (!repositoryWorkflows) {
          writeJson(response, 404, {
            version: 1,
            error: "repository_workflows_not_configured",
          });
          return;
        }
        if (request.method === "GET") {
          writeJson(response, 200, {
            version: 1,
            repositories: await repositoryWorkflows.list(),
          });
          return;
        }
        if (request.method === "POST") {
          try {
            const body = (await readJsonBody(request)) as Record<
              string,
              unknown
            >;
            if (
              !isNonEmptyString(body.repository) ||
              !isNonEmptyString(body.featureBranch) ||
              !isNonEmptyString(body.workflowId)
            ) {
              writeJson(response, 422, {
                version: 1,
                error: "invalid_repository_workflow",
              });
              return;
            }
            await repositoryWorkflows.authorize({
              repository: body.repository,
              featureBranch: body.featureBranch,
              workflowId: body.workflowId,
            });
            writeJson(
              response,
              201,
              await repositoryWorkflows.inspect(body.repository),
            );
          } catch (error) {
            writeJson(response, 422, {
              version: 1,
              error: "repository_workflow_rejected",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
      }
      const repositoryWorkflowMatch = url.pathname.match(
        /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)(?:\/(pause|resume|run))?$/u,
      );
      if (repositoryWorkflowMatch) {
        const repositoryWorkflows = boundaries.repositoryWorkflows;
        const owner = decodePathValue(repositoryWorkflowMatch[1]!);
        const name = decodePathValue(repositoryWorkflowMatch[2]!);
        const action = repositoryWorkflowMatch[3];
        if (!repositoryWorkflows || !owner || !name) {
          writeJson(response, 404, {
            version: 1,
            error: "repository_workflow_not_found",
          });
          return;
        }
        const repository = `${owner}/${name}`;
        try {
          if (request.method === "GET" && !action) {
            const inspection = await repositoryWorkflows.inspect(repository);
            writeJson(
              response,
              inspection ? 200 : 404,
              inspection ?? { version: 1, error: "repository_not_found" },
            );
            return;
          }
          if (request.method === "DELETE" && !action) {
            await repositoryWorkflows.remove(repository);
            response.statusCode = 204;
            response.end();
            return;
          }
          if (request.method === "POST" && action) {
            if (action === "pause") await repositoryWorkflows.pause(repository);
            else if (action === "resume")
              await repositoryWorkflows.resume(repository);
            else await repositoryWorkflows.runNow(repository);
            writeJson(
              response,
              200,
              await repositoryWorkflows.inspect(repository),
            );
            return;
          }
        } catch (error) {
          writeJson(response, 409, {
            version: 1,
            error: "repository_workflow_rejected",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/policy") {
        try {
          writeJson(response, 200, await host.policy.inspect());
        } catch {
          writeJson(response, 503, {
            version: 1,
            code: "policy_unavailable",
            message: "The current policy is unavailable.",
          });
        }
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/policy/validate"
      ) {
        try {
          const validation: MissionControlPolicyValidation =
            host.policy.validate(await readJsonBody(request));
          writeJson(response, validation.valid ? 200 : 422, validation);
        } catch {
          writeJson(response, 422, {
            version: 1,
            valid: false,
            code: "invalid_policy",
            issues: ["Policy configuration could not be parsed."],
          });
        }
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/policy/preview"
      ) {
        try {
          const preview: MissionControlPolicyPreview =
            await host.policy.preview(await readJsonBody(request));
          writeJson(response, 200, preview);
        } catch (error) {
          if (error instanceof MissionControlPolicyError) {
            writeJson(response, 422, {
              version: 1,
              valid: false,
              code: error.code,
              issues: error.issues.length > 0 ? error.issues : [error.message],
            });
          } else {
            writeJson(response, 503, {
              version: 1,
              code: "policy_preview_unavailable",
              message: "Policy preview is unavailable.",
            });
          }
        }
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/v1/policy/apply"
      ) {
        try {
          const outcome = await host.policy.apply(await readJsonBody(request));
          writeJson(response, policyOutcomeStatusCode(outcome.code), outcome);
        } catch {
          writeJson(response, 422, {
            version: 1,
            code: "invalid_request",
            message: "Policy apply request must be valid JSON.",
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/overview") {
        try {
          writeJson(response, 200, await host.getOverview());
        } catch {
          writeJson(response, 503, {
            version: 1,
            error: "overview_unavailable",
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/status") {
        writeJson(response, 200, { version: 1, ...service.status() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
        try {
          writeJson(response, 200, await readModel.getTaskInbox());
        } catch {
          writeJson(response, 503, {
            version: 1,
            error: "task_inbox_unavailable",
          });
        }
        return;
      }
      const scopedEvidenceMatch = url.pathname.match(
        /^\/api\/v1\/tasks\/([^/]+)\/attempts\/([^/]+)\/evidence\/([^/]+)$/u,
      );
      if (request.method === "GET" && scopedEvidenceMatch !== null) {
        const taskId = decodePathValue(scopedEvidenceMatch[1]!);
        const attemptId = decodePathValue(scopedEvidenceMatch[2]!);
        const evidenceId = decodePathValue(scopedEvidenceMatch[3]!);
        if (
          taskId === undefined ||
          attemptId === undefined ||
          evidenceId === undefined
        ) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_evidence_scope",
            message: "Task, attempt, and evidence identifiers are required.",
          });
          return;
        }
        const attempt = await readModel.getAttempt(attemptId);
        if (
          attempt === undefined ||
          attempt.taskId !== taskId ||
          !attempt.evidence.some((evidence) => evidence.id === evidenceId)
        ) {
          writeJson(response, 404, { version: 1, error: "evidence_not_found" });
          return;
        }
        const evidence = await readModel.getEvidence(evidenceId);
        if (evidence === undefined) {
          writeJson(response, 404, {
            version: 1,
            error: "evidence_not_retained",
          });
        } else {
          writeJson(response, 200, evidence);
        }
        return;
      }
      const expandedTaskMatch = url.pathname.match(
        /^\/api\/v1\/tasks\/([^/]+)\/([^/]+)\/(issue|prd)\/([1-9][0-9]*)$/u,
      );
      if (request.method === "GET" && expandedTaskMatch !== null) {
        const repositoryOwner = decodePathValue(expandedTaskMatch[1]!);
        const repositoryName = decodePathValue(expandedTaskMatch[2]!);
        const kind = expandedTaskMatch[3];
        const number = Number(expandedTaskMatch[4]);
        if (
          repositoryOwner === undefined ||
          repositoryName === undefined ||
          (kind !== "issue" && kind !== "prd") ||
          !Number.isSafeInteger(number)
        ) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_task_id",
            message: "A repository-qualified task ID is required.",
          });
          return;
        }
        const task = await readModel.getTask(
          `${repositoryOwner}/${repositoryName}:${kind}:${number}`.toLowerCase(),
        );
        if (task === undefined) {
          writeJson(response, 404, { version: 1, error: "task_not_found" });
        } else {
          writeJson(response, 200, task);
        }
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/v1/tasks/")
      ) {
        const taskId = decodePathValue(
          url.pathname.slice("/api/v1/tasks/".length),
        );
        if (taskId === undefined) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_task_id",
            message: "A repository-qualified task ID is required.",
          });
          return;
        }
        const task = await readModel.getTask(taskId);
        if (task === undefined) {
          writeJson(response, 404, { version: 1, error: "task_not_found" });
        } else {
          writeJson(response, 200, task);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/queue") {
        try {
          writeJson(response, 200, await readModel.getQueue());
        } catch {
          writeJson(response, 503, {
            version: 1,
            error: "queue_unavailable",
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/attempts") {
        try {
          writeJson(response, 200, {
            version: 1,
            revision: service.status().revision,
            attempts: await readModel.getAttempts(),
          });
        } catch {
          writeJson(response, 503, {
            version: 1,
            error: "attempts_unavailable",
          });
        }
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/v1/attempts/")
      ) {
        const attemptId = decodePathValue(
          url.pathname.slice("/api/v1/attempts/".length),
        );
        if (attemptId === undefined) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_attempt_id",
            message: "An attempt ID is required.",
          });
          return;
        }
        const attempt = await readModel.getAttempt(attemptId);
        if (attempt === undefined) {
          writeJson(response, 404, { version: 1, error: "attempt_not_found" });
        } else {
          writeJson(response, 200, attempt);
        }
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/api/v1/events" ||
          url.pathname === "/api/v1/events/stream")
      ) {
        try {
          const records = await getEvents();
          const lastEventHeader = request.headers["last-event-id"];
          const subscriber = {
            response,
            lastSentId: parseLastEventId(
              Array.isArray(lastEventHeader)
                ? lastEventHeader[0]
                : lastEventHeader,
            ),
          };
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-cache, no-store");
          response.setHeader("Connection", "keep-alive");
          response.setHeader(
            "Content-Type",
            "text/event-stream; charset=utf-8",
          );
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.flushHeaders();
          eventSubscribers.add(subscriber);
          for (const record of records) {
            if (record.id <= subscriber.lastSentId) continue;
            writeSseEvent(response, record);
            subscriber.lastSentId = record.id;
          }
          request.on("close", () => eventSubscribers.delete(subscriber));
        } catch {
          if (!response.headersSent) {
            writeJson(response, 503, {
              version: 1,
              error: "events_unavailable",
            });
          }
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/evidence") {
        // No route accepts a filesystem path. Evidence is only addressable by
        // an opaque identifier returned from an inspected retained attempt.
        writeJson(response, 400, {
          version: 1,
          code: "evidence_path_not_allowed",
          message: "Evidence must be addressed by a retained evidence ID.",
        });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/api/v1/evidence/")
      ) {
        const evidenceId = decodePathValue(
          url.pathname.slice("/api/v1/evidence/".length),
        );
        if (evidenceId === undefined) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_evidence_id",
            message: "A retained evidence ID is required.",
          });
          return;
        }
        const evidence = await readModel.getEvidence(evidenceId);
        if (evidence === undefined) {
          writeJson(response, 404, { version: 1, error: "evidence_not_found" });
        } else {
          writeJson(response, 200, evidence);
        }
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/api/v1/commands" ||
          url.pathname === "/api/v1/control")
      ) {
        try {
          const controlRequest = parseControlRequest(
            await readJsonBody(request),
          );
          if (controlRequest === undefined) {
            writeJson(response, 400, {
              version: 1,
              code: "invalid_request",
              message: "A valid guarded worker command is required.",
            });
            return;
          }
          const outcome = await service.control.command(controlRequest);
          writeJson(response, controlOutcomeStatusCode(outcome.code), outcome);
        } catch (error) {
          writeJson(response, 400, {
            version: 1,
            code: "invalid_request",
            message:
              error instanceof Error &&
              error.message === "request_body_too_large"
                ? "Request body is too large."
                : "Request body must be valid JSON.",
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        writeHtml(response, overviewHtml);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        response.setHeader("Allow", "GET");
        writeJson(response, request.method === "GET" ? 404 : 405, {
          version: 1,
          error: request.method === "GET" ? "not_found" : "read_only",
        });
        return;
      }
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("Not found\n");
    })().catch(() => {
      if (!response.headersSent)
        writeJson(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });

  let listening: Promise<MissionControlListeningAddress> | undefined;
  let running: Promise<void> | undefined;
  let stopRequested = false;

  const getOverview = async (): Promise<MissionControlOverview> => {
    const [state, eventRecords] = await Promise.all([
      store.read(),
      getEvents(),
    ]);
    const diagnosticsFromDisk = eventRecords.map((record) => record.event);
    const serviceStatus = service.status();
    const lastDiagnostic = diagnosticsFromDisk.at(-1);
    const warnings = await recoveryWarnings(state, store);
    return {
      version: 1,
      revision: serviceStatus.revision,
      mode: serviceStatus.mode,
      pauseRequested: serviceStatus.pauseRequested,
      activeAttempt: activeAttemptView(state.attempts),
      lastCompletedCycle:
        serviceStatus.lastCompletedCycle ?? lastDiagnostic?.timestamp ?? null,
      nextExpectedCycle: serviceStatus.nextExpectedCycle ?? null,
      recoveryWarnings: warnings,
      operationalStateCounts: currentOperationalStateCounts(
        state,
        diagnosticsFromDisk,
      ),
    };
  };

  const listen = (): Promise<MissionControlListeningAddress> => {
    if (listening !== undefined) return listening;
    listening = new Promise<MissionControlListeningAddress>(
      (resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Mission Control did not receive a TCP address."));
            return;
          }
          const info = address as AddressInfo;
          resolve({ host: info.address, port: info.port });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, bindAddress);
      },
    ).catch((error) => {
      listening = undefined;
      throw error;
    });
    return listening;
  };

  const start = (): Promise<void> => {
    if (running !== undefined) return running;
    stopRequested = false;
    running = (async () => {
      await listen();
      if (stopRequested) {
        await closeServer(server);
        listening = undefined;
        return;
      }
      try {
        await service.start();
      } catch (error) {
        await closeServer(server);
        throw error;
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const stop = async (): Promise<void> => {
    stopRequested = true;
    try {
      await service.stop();
    } finally {
      for (const subscriber of eventSubscribers) {
        subscriber.response.end();
      }
      eventSubscribers.clear();
      await closeServer(server);
      listening = undefined;
    }
  };

  const host: MissionControlHost = {
    repositoryWorkflows: boundaries.repositoryWorkflows,
    paths,
    source,
    store,
    repositoryManager,
    execution,
    publisher,
    diagnostics,
    service,
    control: service.control,
    readModel,
    policy,
    policyFilePath,
    policyAuditFilePath,
    server,
    listen,
    start,
    stop,
    getOverview,
    getTaskInbox: readModel.getTaskInbox,
    getTask: readModel.getTask,
    getQueue: readModel.getQueue,
    getAttempts: readModel.getAttempts,
    getAttempt: readModel.getAttempt,
    getEvidence: readModel.getEvidence,
  };
  return host;
};
