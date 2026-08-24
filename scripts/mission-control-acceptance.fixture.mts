import { readFile } from "node:fs/promises";
import {
  MISSION_CONTROL_ACCEPTANCE_ARTIFACTS,
  type MissionControlAcceptanceEvidence,
  type MissionControlAcceptanceStatus,
  type MissionControlAttemptView,
  type MissionControlEvidenceContent,
  type MissionControlEventRecord,
  type MissionControlOverview,
  type MissionControlQueue,
  type MissionControlTaskInbox,
  type WorkerControlOutcome,
  type RunMissionControlAcceptanceProofInput,
} from "../src/index.js";

interface MissionControlAcceptanceScenario {
  readonly baseUrl: string;
  readonly bindAddress: string;
  readonly proofPath: string;
  readonly observedTaskId: string;
  readonly sourceCalls: number;
  readonly initialEventCount: number;
  readonly resumedEventCount: number;
  readonly acknowledgedThrough: number;
  readonly systemdUnitPath: string;
  readonly durableRoot: string;
  readonly publishedAttemptId: string;
  readonly safeRetryAttemptId: string;
  readonly safeRetryAttemptAfterId: string;
  readonly manualInterventionAttemptId: string;
  readonly cancellationAttemptId?: string;
  readonly publication: MissionControlAcceptanceEvidence["publication"];
  readonly durability: MissionControlAcceptanceEvidence["durability"];
  readonly protectedMaterial: readonly string[];
  readonly promptText: string;
  readonly sandboxEnvironment: Readonly<Record<string, string>>;
  readonly commandAuditPath: string;
  readonly privateAccess: MissionControlAcceptanceEvidence["deployment"]["privateAccess"];
  readonly backup: MissionControlAcceptanceEvidence["deployment"]["backup"];
  readonly rollback: MissionControlAcceptanceEvidence["deployment"]["rollback"];
  readonly shutdown: MissionControlAcceptanceEvidence["deployment"]["shutdown"];
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for Mission Control acceptance.`);
  }
  return value;
};

const readJson = async <T,>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const urlFor = (baseUrl: string, path: string): string =>
  new URL(path, `${baseUrl.replace(/\/$/u, "")}/`).toString();

const getJson = async <T,>(
  baseUrl: string,
  path: string,
): Promise<{ readonly status: number; readonly body: T }> => {
  const response = await fetch(urlFor(baseUrl, path), {
    headers: { accept: "application/json" },
  });
  return { status: response.status, body: (await response.json()) as T };
};

const getHtml = async (
  baseUrl: string,
): Promise<{ readonly status: number; readonly body: string }> => {
  const response = await fetch(urlFor(baseUrl, "/"));
  return { status: response.status, body: await response.text() };
};

const postCommand = async (
  baseUrl: string,
  request: Readonly<Record<string, unknown>>,
): Promise<WorkerControlOutcome> => {
  const response = await fetch(urlFor(baseUrl, "/api/v1/commands"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  return (await response.json()) as WorkerControlOutcome;
};

const waitForMode = async (
  baseUrl: string,
  mode: MissionControlAcceptanceStatus["mode"],
): Promise<MissionControlAcceptanceStatus> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await getJson<MissionControlAcceptanceStatus>(
      baseUrl,
      "/api/v1/status",
    );
    if (result.body.mode === mode) return result.body;
    if (Date.now() >= deadline) {
      throw new Error(`Mission Control did not reach ${mode} before timeout.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const readEvents = async (
  baseUrl: string,
  lastEventId: number,
  expected: number,
): Promise<{
  readonly status: number;
  readonly events: readonly MissionControlEventRecord[];
}> => {
  if (!Number.isInteger(expected) || expected <= 0) {
    throw new Error("SSE event counts must be positive integers.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(urlFor(baseUrl, "/api/v1/events"), {
      headers: {
        "Last-Event-ID": String(lastEventId),
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    if (response.body === null)
      throw new Error("Mission Control returned no SSE body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: MissionControlEventRecord[] = [];
    let buffer = "";
    while (events.length < expected) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block
          .split(/\r?\n/u)
          .find((line) => line.startsWith("data:"));
        if (dataLine === undefined) continue;
        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as {
          readonly id: number;
          readonly event: MissionControlEventRecord["event"];
        };
        events.push({ id: payload.id, event: payload.event });
        if (events.length >= expected) break;
      }
    }
    await reader.cancel();
    return { status: response.status, events };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};

const status = async (
  baseUrl: string,
): Promise<MissionControlAcceptanceStatus> =>
  (await getJson<MissionControlAcceptanceStatus>(baseUrl, "/api/v1/status"))
    .body;

const commandWithCurrentRevision = async (
  baseUrl: string,
  command: string,
  commandId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<WorkerControlOutcome> =>
  postCommand(baseUrl, {
    command,
    commandId,
    expectedRevision: (await status(baseUrl)).revision,
    reason: `Mission Control remote acceptance: ${command}`,
    ...extra,
  });

export default async function liveFixture(): Promise<RunMissionControlAcceptanceProofInput> {
  const scenario = await readJson<MissionControlAcceptanceScenario>(
    requiredEnvironment("SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_SCENARIO"),
  );
  const integrityKey = requiredEnvironment(
    "SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_KEY",
  );
  const html = await getHtml(scenario.baseUrl);
  const statusResponse = await getJson<MissionControlAcceptanceStatus>(
    scenario.baseUrl,
    "/api/v1/status",
  );
  const overview = await getJson<MissionControlOverview>(
    scenario.baseUrl,
    "/api/v1/overview",
  );
  const tasks = await getJson<MissionControlTaskInbox>(
    scenario.baseUrl,
    "/api/v1/tasks",
  );
  const queue = await getJson<MissionControlQueue>(
    scenario.baseUrl,
    "/api/v1/queue",
  );
  const initialEvents = await readEvents(
    scenario.baseUrl,
    0,
    scenario.initialEventCount,
  );
  const resumedEvents = await readEvents(
    scenario.baseUrl,
    scenario.acknowledgedThrough,
    scenario.resumedEventCount,
  );

  const attemptResponse = await getJson<MissionControlAttemptView>(
    scenario.baseUrl,
    `/api/v1/attempts/${encodeURIComponent(scenario.publishedAttemptId)}`,
  );
  const recordEvidence = attemptResponse.body.evidence.find(
    (evidence) => evidence.kind === "record" && evidence.available,
  );
  if (recordEvidence === undefined) {
    throw new Error("The selected acceptance attempt has no retained record.");
  }
  const evidenceResponse = await getJson<MissionControlEvidenceContent>(
    scenario.baseUrl,
    `/api/v1/evidence/${encodeURIComponent(recordEvidence.id)}`,
  );

  const runNowRevision = statusResponse.body.revision;
  const runNowRequest = {
    command: "run-now",
    commandId: "mission-control-acceptance-run-now",
    expectedRevision: runNowRevision,
    reason: "Prove duplicate run-now requests are idempotent.",
  };
  const runNow = await postCommand(scenario.baseUrl, runNowRequest);
  const duplicateRunNow = await postCommand(scenario.baseUrl, runNowRequest);
  const pause = await commandWithCurrentRevision(
    scenario.baseUrl,
    "pause",
    "mission-control-acceptance-pause",
  );
  const pausedStatus = await waitForMode(scenario.baseUrl, "paused");
  const resume = await commandWithCurrentRevision(
    scenario.baseUrl,
    "resume",
    "mission-control-acceptance-resume",
  );
  const runningStatus = await waitForMode(scenario.baseUrl, "running");

  const cancellationAttemptId =
    scenario.cancellationAttemptId ?? overview.body.activeAttempt?.attemptId;
  if (cancellationAttemptId === undefined) {
    throw new Error(
      "The acceptance scenario must identify an active cancellation attempt.",
    );
  }
  const cancellation = await commandWithCurrentRevision(
    scenario.baseUrl,
    "cancel",
    "mission-control-acceptance-cancel",
    { attemptId: cancellationAttemptId },
  );
  const cancellationAttempt = await getJson<MissionControlAttemptView>(
    scenario.baseUrl,
    `/api/v1/attempts/${encodeURIComponent(cancellationAttemptId)}`,
  );

  const safeRetry = await commandWithCurrentRevision(
    scenario.baseUrl,
    "retry",
    "mission-control-acceptance-safe-retry",
    { attemptId: scenario.safeRetryAttemptId },
  );
  const safeRetryAttempt = await getJson<MissionControlAttemptView>(
    scenario.baseUrl,
    `/api/v1/attempts/${encodeURIComponent(scenario.safeRetryAttemptAfterId)}`,
  );

  const manualBefore = await getJson<MissionControlAttemptView>(
    scenario.baseUrl,
    `/api/v1/attempts/${encodeURIComponent(scenario.manualInterventionAttemptId)}`,
  );
  const manualRetry = await commandWithCurrentRevision(
    scenario.baseUrl,
    "retry",
    "mission-control-acceptance-manual-retry",
    { attemptId: scenario.manualInterventionAttemptId },
  );
  const acknowledgement = await commandWithCurrentRevision(
    scenario.baseUrl,
    "acknowledge",
    "mission-control-acceptance-manual-ack",
    {
      attemptId: scenario.manualInterventionAttemptId,
      operator: "mission-control-acceptance",
    },
  );
  const manualAfter = await getJson<MissionControlAttemptView>(
    scenario.baseUrl,
    `/api/v1/attempts/${encodeURIComponent(scenario.manualInterventionAttemptId)}`,
  );

  const systemdUnit = await readFile(scenario.systemdUnitPath, "utf8");
  const commandAudit = await readFile(scenario.commandAuditPath, "utf8");
  const browserPayloads = [
    html.body,
    statusResponse.body,
    overview.body,
    tasks.body,
    queue.body,
    ...initialEvents.events,
    ...resumedEvents.events,
    attemptResponse.body,
    evidenceResponse.body,
  ];

  const evidence: MissionControlAcceptanceEvidence = {
    deployment: {
      bindAddress: scenario.bindAddress,
      defaultBindAddress: true,
      privateAccess: scenario.privateAccess,
      systemdUnitPath: scenario.systemdUnitPath,
      systemdUnit,
      durableRoot: scenario.durableRoot,
      durableArtifacts: [...MISSION_CONTROL_ACCEPTANCE_ARTIFACTS],
      backup: scenario.backup,
      rollback: scenario.rollback,
      shutdown: scenario.shutdown,
    },
    discovery: {
      live: true,
      sourceCalls: scenario.sourceCalls,
      observedTaskId: scenario.observedTaskId,
    },
    endpoints: {
      html,
      status: statusResponse,
      overview,
      tasks,
      queue,
      events: {
        status: initialEvents.status,
        initial: initialEvents.events,
        resumed: resumedEvents.events,
        acknowledgedThrough: scenario.acknowledgedThrough,
      },
      attempt: attemptResponse,
      evidence: evidenceResponse,
    },
    controls: {
      runNow: {
        commandId: runNow.commandId,
        first: runNow,
        duplicate: duplicateRunNow,
      },
      pause: {
        outcome: pause,
        statusAfter: { status: 200, body: pausedStatus },
      },
      resume: {
        outcome: resume,
        statusAfter: { status: 200, body: runningStatus },
      },
      cancellation: {
        outcome: cancellation,
        attemptAfter: cancellationAttempt,
      },
      safeRetry: {
        expiredAttemptId: scenario.safeRetryAttemptId,
        outcome: safeRetry,
        attemptAfter: safeRetryAttempt,
      },
      manualIntervention: {
        attemptId: scenario.manualInterventionAttemptId,
        before: manualBefore.body,
        retry: manualRetry,
        acknowledgement,
        after: manualAfter.body,
      },
    },
    publication: scenario.publication,
    durability: scenario.durability,
    credentials: {
      githubCredentialConfiguredServerSide: true,
      browserPayloads,
      promptText: scenario.promptText,
      sandboxEnvironment: scenario.sandboxEnvironment,
      commandAudit,
      protectedMaterial: scenario.protectedMaterial,
    },
  };

  return { proofPath: scenario.proofPath, integrityKey, evidence };
}
