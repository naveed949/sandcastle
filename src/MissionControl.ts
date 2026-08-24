import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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
}

/** Injectable boundaries used by integration tests and alternate deployments. */
export interface MissionControlHostBoundaries {
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
  readonly paths: WorkerServicePaths;
  readonly source: GitHubTaskSource;
  readonly store: WorkerStateStore;
  readonly repositoryManager: WorkerRepositoryManager;
  readonly execution: WorkerExecutionEngine;
  readonly publisher: WorkerPublisher;
  readonly diagnostics: WorkerDiagnostics;
  readonly service: WorkerService;
  readonly control: WorkerServiceControl;
  readonly server: Server;
  listen(): Promise<MissionControlListeningAddress>;
  /** Listen and run the continuous worker until it is stopped. */
  start(): Promise<void>;
  /** Stop the worker and close the operator surface. */
  stop(): Promise<void>;
  /** Rebuild and return the disposable overview read model. */
  getOverview(): Promise<MissionControlOverview>;
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

const readDiagnostics = async (
  filePath: string,
): Promise<readonly WorkerDiagnostic[]> => {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const events: WorkerDiagnostic[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        !isRecord(value) ||
        typeof value.timestamp !== "string" ||
        !isOperationalState(value.state) ||
        typeof value.message !== "string"
      ) {
        continue;
      }
      events.push(value as unknown as WorkerDiagnostic);
    } catch {
      // A partial final JSONL line must not make the read-only overview unavailable.
    }
  }
  return events;
};

const stateForAttempt = (attempt: ExecutionAttempt): WorkerOperationalState => {
  if (attempt.status === "published") return "published";
  if (attempt.status === "verified") return "verified";
  if (attempt.status === "failed" || attempt.status === "interrupted") {
    return "blocked";
  }
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
    if (attempt.status === "active" && attempt.claim !== undefined) {
      if (attempt.claim.phase === "started") {
        warnings.push({
          attemptId: attempt.attemptId,
          taskId: attempt.request.taskId,
          reasonCode: "manual_intervention",
          message:
            "This attempt may have side effects and requires operator review.",
        });
      } else {
        const recovery = expired.get(attempt.attemptId);
        if (recovery !== undefined) {
          warnings.push({
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            reasonCode: recovery.disposition,
            message: "This expired claim is retained for worker recovery.",
          });
        }
      }
    }
    if (attempt.status === "interrupted") {
      warnings.push({
        attemptId: attempt.attemptId,
        taskId: attempt.request.taskId,
        reasonCode: "interrupted_attempt",
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
      #counts { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
      .count { display: flex; justify-content: space-between; gap: 1rem; }
      .controls { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 0.9rem; }
      .controls input { flex: 1 1 240px; min-width: 0; padding: 0.55rem 0.7rem; border: 1px solid #4b5563; border-radius: 0.45rem; background: #111827; color: inherit; }
      .controls button { padding: 0.55rem 0.8rem; border: 1px solid #60a5fa; border-radius: 0.45rem; background: #1d4ed8; color: #eff6ff; cursor: pointer; }
      .controls button:disabled { cursor: not-allowed; opacity: 0.45; }
      code { color: #bfdbfe; overflow-wrap: anywhere; }
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
        <section class="panel"><h2>Recovery warnings</h2><div id="warnings" class="muted">None</div></section>
        <section class="panel">
          <h2>Runtime controls</h2>
          <p class="muted">Every action is revision-checked and retained in the operator audit.</p>
          <div class="controls">
            <input id="reason" aria-label="Operator reason" placeholder="Operator reason" autocomplete="off">
            <button data-command="run-now">Run cycle now</button>
            <button data-command="pause">Pause polling</button>
            <button data-command="resume">Resume polling</button>
            <button id="cancel" data-command="cancel" disabled>Cancel active execution</button>
          </div>
          <p class="muted" id="control-status" aria-live="polite"></p>
        </section>
        <section class="panel"><h2>Operational state counts</h2><div id="counts" class="grid"></div></section>
      </div>
    </main>
    <script>
      const labels = { discovered: "Discovered", unauthorized: "Unauthorized", ineligible: "Ineligible", ready: "Ready", claimed: "Claimed", running: "Running", blocked: "Blocked", failed: "Failed", verified: "Verified", published: "Published" };
      const text = (id, value) => { document.getElementById(id).textContent = value; };
      const formatTime = (value) => value ? new Date(value).toLocaleString() : "—";
      let latestRevision = 0;
      let activeAttemptId = null;
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
          const warnings = document.getElementById("warnings");
          warnings.textContent = overview.recoveryWarnings.length === 0 ? "None" : overview.recoveryWarnings.map((warning) => warning.reasonCode + ": " + warning.message).join(" • ");
          const counts = document.getElementById("counts");
          counts.replaceChildren(...Object.entries(overview.operationalStateCounts).map(([state, count]) => {
            const item = document.createElement("div"); item.className = "panel count";
            const label = document.createElement("span"); label.textContent = labels[state] || state;
            const value = document.createElement("strong"); value.textContent = String(count);
            item.append(label, value); return item;
          }));
        } catch { text("updated", "Overview unavailable"); }
      }
      async function sendCommand(command) {
        const reasonInput = document.getElementById("reason");
        const reason = reasonInput.value.trim();
        if (!reason) { text("control-status", "Enter an operator reason first."); return; }
        const commandId = command + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const payload = { command, commandId, expectedRevision: latestRevision, reason };
        if (command === "cancel") payload.attemptId = activeAttemptId;
        try {
          const response = await fetch("/api/v1/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          const outcome = await response.json();
          if (typeof outcome.revision === "number") latestRevision = outcome.revision;
          text("control-status", outcome.code + ": " + outcome.message);
          void refresh();
        } catch { text("control-status", "Command unavailable."); }
      }
      document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("click", () => void sendCommand(button.dataset.command)));
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
    command !== "cancel"
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
  return {
    command,
    commandId: value.commandId,
    expectedRevision: value.expectedRevision,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
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
      configuration: configuration.worker,
      repositoryManager,
      store,
      recordsRoot: paths.recordsRoot,
    });
  const publisher =
    boundaries.publisher ??
    createWorkerPublisher({
      configuration: configuration.worker,
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
  const diagnostics: WorkerDiagnostics = {
    emit: async (event) => {
      await durableDiagnostics.emit(event);
      await boundaries.diagnostics?.emit(event);
    },
  };
  const service = createWorkerService({
    configuration: configuration.worker,
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
  });

  const serverOptions = configuration.server ?? {};
  const bindAddress = serverOptions.bindAddress ?? "127.0.0.1";
  const port = serverOptions.port ?? 3000;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mission-control.invalid");
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
    const [state, diagnosticsFromDisk] = await Promise.all([
      store.read(),
      readDiagnostics(paths.diagnosticsFilePath),
    ]);
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
      await closeServer(server);
      listening = undefined;
    }
  };

  const host: MissionControlHost = {
    paths,
    source,
    store,
    repositoryManager,
    execution,
    publisher,
    diagnostics,
    service,
    control: service.control,
    server,
    listen,
    start,
    stop,
    getOverview,
  };
  return host;
};
