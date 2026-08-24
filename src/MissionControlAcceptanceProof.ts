import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import { canonicalJson, canonicalJsonDigest } from "./CanonicalJson.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";
import type {
  MissionControlAttemptView,
  MissionControlEvidenceContent,
  MissionControlEventRecord,
  MissionControlQueue,
  MissionControlTaskInbox,
} from "./MissionControlReadModel.js";
import type { MissionControlOverview } from "./MissionControl.js";
import type {
  WorkerControlOutcome,
  WorkerServiceMode,
} from "./WorkerService.js";

/** Stable failure categories for the retained Mission Control deployment proof. */
export type MissionControlAcceptanceProofErrorCode =
  | "invalid_input"
  | "deployment"
  | "observability"
  | "controls"
  | "security"
  | "durability"
  | "idempotency";

/** Raised when a remote Mission Control run does not prove every required boundary. */
export class MissionControlAcceptanceProofError extends Error {
  readonly code: MissionControlAcceptanceProofErrorCode;

  constructor(message: string, code: MissionControlAcceptanceProofErrorCode) {
    super(message);
    this.name = "MissionControlAcceptanceProofError";
    this.code = code;
  }
}

/** One HTTP response captured by the remote acceptance probe. */
export interface MissionControlAcceptanceHttpObservation<T> {
  readonly status: number;
  readonly body: T;
}

/** The persistent artifacts that must move together across a host restart. */
export const MISSION_CONTROL_ACCEPTANCE_ARTIFACTS = [
  "task-snapshots",
  "execution-identities",
  "attempts",
  "leases",
  "command-audit",
  "diagnostics",
  "records",
  "logs",
  "worktrees",
  "publication-provenance",
] as const;

export type MissionControlAcceptanceArtifact =
  (typeof MISSION_CONTROL_ACCEPTANCE_ARTIFACTS)[number];

/** A command and its response to a byte-for-byte idempotency retry. */
export interface MissionControlAcceptanceCommandObservation {
  readonly commandId: string;
  readonly first: WorkerControlOutcome;
  readonly duplicate: WorkerControlOutcome;
}

/** The publication fields that must remain stable across a retry. */
export interface MissionControlAcceptancePublicationObservation {
  readonly url: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly branchSha: string;
}

/** Deployment operations observed on the remote development box. */
export interface MissionControlAcceptanceDeploymentObservation {
  readonly bindAddress: string;
  readonly defaultBindAddress: boolean;
  readonly privateAccess: "vpn" | "ssh-tunnel" | "trusted-reverse-proxy";
  readonly systemdUnitPath: string;
  readonly systemdUnit: string;
  readonly durableRoot: string;
  readonly durableArtifacts: readonly MissionControlAcceptanceArtifact[];
  readonly backup: {
    readonly serviceStopped: boolean;
    readonly completeRoot: boolean;
  };
  readonly rollback: {
    readonly previousReleaseRestored: boolean;
    readonly durableRootPreserved: boolean;
  };
  readonly shutdown: {
    readonly signals: readonly ("SIGINT" | "SIGTERM")[];
    readonly graceful: boolean;
  };
}

/** Durable fingerprints captured before and after replacing the host process. */
export interface MissionControlAcceptanceDurabilityObservation {
  readonly before: Readonly<Record<MissionControlAcceptanceArtifact, string>>;
  readonly after: Readonly<Record<MissionControlAcceptanceArtifact, string>>;
  readonly retainedArtifacts: readonly MissionControlAcceptanceArtifact[];
  readonly sameDurableRoot: boolean;
  readonly readModelRebuilt: boolean;
  readonly restartCount: number;
}

/** Credential-boundary observations supplied by the live probe. */
export interface MissionControlAcceptanceCredentialObservation {
  /** The GitHub credential was configured in the host process only. */
  readonly githubCredentialConfiguredServerSide: boolean;
  /** Browser-visible response and event bodies captured during the run. */
  readonly browserPayloads: readonly unknown[];
  /** Prompt text and sandbox environment captured by the fixture. */
  readonly promptText: string;
  readonly sandboxEnvironment: Readonly<Record<string, string>>;
  /** The retained command audit, after the host's redaction boundary. */
  readonly commandAudit: string;
  /** Values that must not cross any of the above boundaries. */
  readonly protectedMaterial: readonly string[];
}

/** All observations required to retain one remote Mission Control proof. */
export interface MissionControlAcceptanceEvidence {
  readonly deployment: MissionControlAcceptanceDeploymentObservation;
  readonly discovery: {
    readonly live: boolean;
    readonly sourceCalls: number;
    readonly observedTaskId: string;
  };
  readonly endpoints: {
    readonly html: MissionControlAcceptanceHttpObservation<string>;
    readonly status: MissionControlAcceptanceHttpObservation<MissionControlAcceptanceStatus>;
    readonly overview: MissionControlAcceptanceHttpObservation<MissionControlOverview>;
    readonly tasks: MissionControlAcceptanceHttpObservation<MissionControlTaskInbox>;
    readonly queue: MissionControlAcceptanceHttpObservation<MissionControlQueue>;
    readonly events: {
      readonly status: number;
      /** Events received before the client acknowledged `acknowledgedThrough`. */
      readonly initial: readonly MissionControlEventRecord[];
      /** Events received after reconnecting with Last-Event-ID. */
      readonly resumed: readonly MissionControlEventRecord[];
      readonly acknowledgedThrough: number;
    };
    readonly attempt: MissionControlAcceptanceHttpObservation<MissionControlAttemptView>;
    readonly evidence: MissionControlAcceptanceHttpObservation<MissionControlEvidenceContent>;
  };
  readonly controls: {
    readonly runNow: MissionControlAcceptanceCommandObservation;
    readonly pause: {
      readonly outcome: WorkerControlOutcome;
      readonly statusAfter: MissionControlAcceptanceHttpObservation<MissionControlAcceptanceStatus>;
    };
    readonly resume: {
      readonly outcome: WorkerControlOutcome;
      readonly statusAfter: MissionControlAcceptanceHttpObservation<MissionControlAcceptanceStatus>;
    };
    readonly cancellation: {
      readonly outcome: WorkerControlOutcome;
      readonly attemptAfter: MissionControlAcceptanceHttpObservation<MissionControlAttemptView>;
    };
    readonly safeRetry: {
      readonly expiredAttemptId: string;
      readonly outcome: WorkerControlOutcome;
      readonly attemptAfter: MissionControlAcceptanceHttpObservation<MissionControlAttemptView>;
    };
    readonly manualIntervention: {
      readonly attemptId: string;
      readonly before: MissionControlAttemptView;
      readonly retry: WorkerControlOutcome;
      readonly acknowledgement: WorkerControlOutcome;
      readonly after: MissionControlAttemptView;
    };
  };
  readonly publication: {
    readonly first: MissionControlAcceptancePublicationObservation;
    readonly retry: MissionControlAcceptancePublicationObservation;
  };
  readonly durability: MissionControlAcceptanceDurabilityObservation;
  readonly credentials: MissionControlAcceptanceCredentialObservation;
}

/** Status payload returned by the versioned Mission Control status endpoint. */
export interface MissionControlAcceptanceStatus {
  readonly version: 1;
  readonly mode: WorkerServiceMode;
  readonly revision: number;
  readonly pauseRequested: boolean;
  readonly activeAttemptId?: string;
  readonly lastCompletedCycle?: string;
  readonly nextExpectedCycle?: string;
}

/** Machine-readable check list retained in the final deployment artifact. */
export interface MissionControlAcceptanceChecks {
  readonly systemdUnit: true;
  readonly privateByDefault: true;
  readonly privateAccessDocumented: true;
  readonly serverSideCredentials: true;
  readonly durableRoot: true;
  readonly restartRetention: true;
  readonly liveDiscovery: true;
  readonly queueInspection: true;
  readonly executionEvents: true;
  readonly verificationEvidence: true;
  readonly draftPublication: true;
  readonly pauseResume: true;
  readonly cancellation: true;
  readonly safeRetry: true;
  readonly manualInterventionProtection: true;
  readonly commandIdempotency: true;
  readonly publicationIdempotency: true;
  readonly controlledShutdown: true;
}

/** Operator-facing limitations retained with every passed deployment proof. */
export interface MissionControlAcceptanceLimitation {
  readonly id:
    | "single-worker"
    | "polling-only"
    | "manual-recovery"
    | "human-review";
  readonly description: string;
}

export const missionControlAcceptanceLimitations: readonly MissionControlAcceptanceLimitation[] =
  [
    {
      id: "single-worker",
      description:
        "The deployment supports one dispatcher and one active execution.",
    },
    {
      id: "polling-only",
      description:
        "Discovery is polling-based; authenticated webhook delivery is not part of this proof.",
    },
    {
      id: "manual-recovery",
      description:
        "Started attempts with possible side effects remain blocked for operator review.",
    },
    {
      id: "human-review",
      description:
        "Publication remains draft-only; merge, closure, release, and deployment require humans.",
    },
  ];

/** The retained proof is HMAC-bound to the acceptance run key. */
export interface MissionControlAcceptanceProof {
  readonly version: 1;
  readonly kind: "mission-control-remote-deployment-acceptance";
  readonly status: "passed";
  readonly createdAt: string;
  readonly checks: MissionControlAcceptanceChecks;
  readonly deployment: {
    readonly bindAddress: string;
    readonly privateAccess: MissionControlAcceptanceDeploymentObservation["privateAccess"];
    readonly systemdUnitPath: string;
    readonly systemdUnitDigest: string;
    readonly durableRoot: string;
    readonly durableArtifacts: readonly MissionControlAcceptanceArtifact[];
    readonly backup: true;
    readonly rollback: true;
    readonly shutdownSignals: readonly ("SIGINT" | "SIGTERM")[];
  };
  readonly lifecycle: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly evidenceId: string;
    readonly eventIds: readonly number[];
    readonly publicationUrl: string;
  };
  readonly controls: {
    readonly runNowCommandId: string;
    readonly pauseCode: WorkerControlOutcome["code"];
    readonly resumeCode: WorkerControlOutcome["code"];
    readonly cancellationCode: WorkerControlOutcome["code"];
    readonly safeRetryCode: WorkerControlOutcome["code"];
    readonly safeRetryAttemptId: string;
    readonly manualInterventionAttemptId: string;
    readonly manualInterventionRetryCode: WorkerControlOutcome["code"];
    readonly acknowledgementCode: WorkerControlOutcome["code"];
  };
  readonly durability: {
    readonly retainedArtifacts: readonly MissionControlAcceptanceArtifact[];
    readonly beforeDigest: string;
    readonly afterDigest: string;
    readonly restartCount: number;
  };
  readonly limitations: readonly MissionControlAcceptanceLimitation[];
  readonly integrity: {
    readonly algorithm: "hmac-sha256";
    readonly digest: string;
  };
}

export interface RunMissionControlAcceptanceProofInput {
  readonly proofPath: string;
  readonly integrityKey: string;
  readonly evidence:
    | MissionControlAcceptanceEvidence
    | (() => Promise<MissionControlAcceptanceEvidence>);
  readonly createdAt?: string;
}

type UnsignedMissionControlAcceptanceProof = Omit<
  MissionControlAcceptanceProof,
  "integrity"
>;

const fail = (
  message: string,
  code: MissionControlAcceptanceProofErrorCode,
): never => {
  throw new MissionControlAcceptanceProofError(message, code);
};

const requireCondition = (
  condition: boolean,
  message: string,
  code: MissionControlAcceptanceProofErrorCode,
): void => {
  if (!condition) fail(message, code);
};

const nonEmpty = (value: string): boolean => value.trim() !== "";

const successfulCommand = (outcome: WorkerControlOutcome): boolean =>
  outcome.code === "accepted" || outcome.code === "already_applied";

const endpointOk = <T>(
  endpoint: MissionControlAcceptanceHttpObservation<T>,
  name: string,
): void => {
  requireCondition(
    endpoint.status === 200,
    `${name} did not return HTTP 200.`,
    "observability",
  );
};

const assertOrderedUnique = (
  events: readonly MissionControlEventRecord[],
  name: string,
): void => {
  requireCondition(
    events.length > 0,
    `${name} contained no events.`,
    "observability",
  );
  for (let index = 1; index < events.length; index += 1) {
    requireCondition(
      events[index]!.id > events[index - 1]!.id,
      `${name} event IDs are not strictly increasing.`,
      "observability",
    );
  }
  requireCondition(
    new Set(events.map((event) => event.id)).size === events.length,
    `${name} contains duplicate event IDs.`,
    "observability",
  );
};

const assertCommandIdempotency = (
  observation: MissionControlAcceptanceCommandObservation,
  name: string,
): void => {
  requireCondition(
    nonEmpty(observation.commandId),
    `${name} has no command ID.`,
    "idempotency",
  );
  requireCondition(
    observation.first.commandId === observation.commandId &&
      observation.duplicate.commandId === observation.commandId,
    `${name} responses are not bound to the requested command ID.`,
    "idempotency",
  );
  requireCondition(
    successfulCommand(observation.first),
    `${name} was not accepted by the guarded command surface.`,
    "controls",
  );
  requireCondition(
    canonicalJson(observation.first) === canonicalJson(observation.duplicate),
    `${name} changed outcome when retried with the same idempotency key.`,
    "idempotency",
  );
};

const assertAttemptLifecycle = (
  endpoint: MissionControlAcceptanceHttpObservation<MissionControlAttemptView>,
  observedTaskId: string,
): string => {
  endpointOk(endpoint, "attempt inspection");
  const attempt = endpoint.body;
  requireCondition(
    attempt.taskId === observedTaskId,
    "Attempt inspection is not correlated to the discovered task.",
    "observability",
  );
  requireCondition(
    nonEmpty(attempt.attemptId) && nonEmpty(attempt.executionIdentity),
    "Attempt inspection is missing durable identity.",
    "observability",
  );
  requireCondition(
    attempt.status === "published",
    "Attempt inspection did not retain the published lifecycle outcome.",
    "observability",
  );
  const states = new Set(attempt.timeline.map((entry) => entry.state));
  for (const state of ["claimed", "running", "verified"] as const) {
    requireCondition(
      states.has(state),
      `Attempt timeline is missing ${state} evidence.`,
      "observability",
    );
  }
  requireCondition(
    attempt.execution !== undefined &&
      attempt.execution.commits.length > 0 &&
      attempt.execution.verification.length > 0 &&
      attempt.execution.verification.every((result) => result.exitCode === 0),
    "Attempt inspection is missing successful verification evidence.",
    "observability",
  );
  requireCondition(
    attempt.evidence.some(
      (evidence) => evidence.kind === "record" && evidence.available,
    ),
    "Attempt inspection has no retained execution record evidence.",
    "observability",
  );
  requireCondition(
    attempt.evidence.some(
      (evidence) =>
        evidence.kind === "pull_request" && evidence.available && evidence.url,
    ),
    "Attempt inspection has no retained pull-request evidence.",
    "observability",
  );
  return attempt.attemptId;
};

const assertCredentialIsolation = (
  credentials: MissionControlAcceptanceCredentialObservation,
): void => {
  requireCondition(
    credentials.githubCredentialConfiguredServerSide === true,
    "The GitHub credential was not proven to be server-side only.",
    "security",
  );
  requireCondition(
    credentials.protectedMaterial.length > 0 &&
      credentials.protectedMaterial.every(nonEmpty),
    "The acceptance fixture did not identify protected material to scan.",
    "security",
  );
  const payload = JSON.stringify({
    browserPayloads: credentials.browserPayloads,
    promptText: credentials.promptText,
    sandboxEnvironment: credentials.sandboxEnvironment,
    commandAudit: credentials.commandAudit,
  });
  requireCondition(
    payload !== undefined,
    "Protected-boundary observations are not JSON-safe.",
    "security",
  );
  requireCondition(
    !credentials.protectedMaterial.some((secret) => payload.includes(secret)),
    "Protected material crossed into a browser, prompt, sandbox, or audit observation.",
    "security",
  );
  requireCondition(
    !containsProtectedWorkerMaterial(payload),
    "Protected worker material was detected in a public acceptance observation.",
    "security",
  );
};

const assertDurability = (
  durability: MissionControlAcceptanceDurabilityObservation,
  deployment: MissionControlAcceptanceDeploymentObservation,
): void => {
  requireCondition(
    durability.sameDurableRoot === true &&
      durability.readModelRebuilt === true &&
      Number.isInteger(durability.restartCount) &&
      durability.restartCount > 0,
    "The deployment proof did not observe a rebuild from the same durable root.",
    "durability",
  );
  for (const artifact of MISSION_CONTROL_ACCEPTANCE_ARTIFACTS) {
    requireCondition(
      deployment.durableArtifacts.includes(artifact) &&
        durability.retainedArtifacts.includes(artifact),
      `Durable artifact ${artifact} was not retained.`,
      "durability",
    );
    requireCondition(
      nonEmpty(durability.before[artifact]) &&
        durability.before[artifact] === durability.after[artifact],
      `Durable artifact ${artifact} changed across restart.`,
      "durability",
    );
  }
};

const assertSystemdDeployment = (
  deployment: MissionControlAcceptanceDeploymentObservation,
): void => {
  requireCondition(
    deployment.defaultBindAddress === true &&
      (deployment.bindAddress === "127.0.0.1" ||
        deployment.bindAddress === "::1"),
    "Mission Control is not proven to bind privately by default.",
    "deployment",
  );
  requireCondition(
    ["vpn", "ssh-tunnel", "trusted-reverse-proxy"].includes(
      deployment.privateAccess,
    ),
    "The documented private Mission Control access path is missing.",
    "deployment",
  );
  requireCondition(
    nonEmpty(deployment.durableRoot),
    "The durable worker root is missing.",
    "deployment",
  );
  requireCondition(
    nonEmpty(deployment.systemdUnitPath),
    "The systemd unit path is missing.",
    "deployment",
  );
  const unit = deployment.systemdUnit;
  for (const marker of [
    "[Service]",
    "User=",
    "WorkingDirectory=",
    "EnvironmentFile=",
    "ExecStart=",
    "Restart=on-failure",
    "TimeoutStopSec=",
    "UMask=0077",
  ]) {
    requireCondition(
      unit.includes(marker),
      `The documented systemd unit is missing ${marker}.`,
      "deployment",
    );
  }
  requireCondition(
    deployment.backup.serviceStopped === true &&
      deployment.backup.completeRoot === true,
    "The backup observation did not cover the complete stopped durable root.",
    "deployment",
  );
  requireCondition(
    deployment.rollback.previousReleaseRestored === true &&
      deployment.rollback.durableRootPreserved === true,
    "The rollback observation did not preserve the durable root.",
    "deployment",
  );
  requireCondition(
    deployment.shutdown.graceful === true &&
      deployment.shutdown.signals.includes("SIGINT") &&
      deployment.shutdown.signals.includes("SIGTERM"),
    "The deployment did not prove graceful SIGINT and SIGTERM shutdown.",
    "deployment",
  );
};

const assertOverviewAndInspection = (
  evidence: MissionControlAcceptanceEvidence,
): {
  readonly taskId: string;
  readonly attemptId: string;
  readonly evidenceId: string;
  readonly publicationUrl: string;
} => {
  endpointOk(evidence.endpoints.html, "Mission Control HTML");
  requireCondition(
    evidence.endpoints.html.body.includes("Mission Control"),
    "The deployed host did not serve Mission Control HTML.",
    "observability",
  );
  endpointOk(evidence.endpoints.status, "status");
  endpointOk(evidence.endpoints.overview, "overview");
  endpointOk(evidence.endpoints.tasks, "task inbox");
  endpointOk(evidence.endpoints.queue, "queue");
  endpointOk(evidence.endpoints.evidence, "evidence");
  requireCondition(
    evidence.endpoints.overview.body.version === 1 &&
      evidence.endpoints.status.body.version === 1,
    "The deployed host returned an unsupported Mission Control version.",
    "observability",
  );
  requireCondition(
    evidence.discovery.live &&
      Number.isInteger(evidence.discovery.sourceCalls) &&
      evidence.discovery.sourceCalls > 0 &&
      nonEmpty(evidence.discovery.observedTaskId),
    "The acceptance run did not perform live discovery.",
    "observability",
  );
  const task =
    evidence.endpoints.tasks.body.tasks.find(
      (candidate) => candidate.taskId === evidence.discovery.observedTaskId,
    ) ??
    fail("The discovered task is absent from the task inbox.", "observability");
  requireCondition(
    nonEmpty(task.sourceRevision) &&
      nonEmpty(task.eligibility.reasonCode) &&
      task.authorizationSource !== undefined,
    "The task inbox did not retain authorization and eligibility evidence.",
    "observability",
  );
  requireCondition(
    evidence.endpoints.queue.body.source === "worker" &&
      evidence.endpoints.queue.body.queue.length > 0 &&
      evidence.endpoints.queue.body.queue.every(
        (entry, index) => entry.position === index + 1,
      ),
    "The acceptance run did not retain the worker ordered ready queue.",
    "observability",
  );
  assertOrderedUnique(
    evidence.endpoints.events.initial,
    "Initial event stream",
  );
  assertOrderedUnique(
    evidence.endpoints.events.resumed,
    "Resumed event stream",
  );
  requireCondition(
    evidence.endpoints.events.status === 200 &&
      evidence.endpoints.events.initial.at(-1)!.id ===
        evidence.endpoints.events.acknowledgedThrough &&
      evidence.endpoints.events.resumed[0]!.id >
        evidence.endpoints.events.acknowledgedThrough,
    "SSE reconnection replayed an acknowledged event or has no resumable cursor.",
    "observability",
  );
  const attemptId = assertAttemptLifecycle(
    evidence.endpoints.attempt,
    evidence.discovery.observedTaskId,
  );
  const attempt = evidence.endpoints.attempt.body;
  const recordEvidence =
    attempt.evidence.find(
      (candidate) => candidate.kind === "record" && candidate.available,
    ) ??
    fail(
      "The execution record reference disappeared from the attempt.",
      "observability",
    );
  requireCondition(
    evidence.endpoints.evidence.body.id === recordEvidence.id &&
      evidence.endpoints.evidence.body.kind === "record" &&
      evidence.endpoints.evidence.body.record !== undefined,
    "The retained verification evidence cannot be read through its opaque ID.",
    "observability",
  );
  const publication = attempt.evidence.find(
    (candidate) =>
      candidate.kind === "pull_request" && candidate.available && candidate.url,
  );
  const publicationUrl =
    publication?.url ??
    fail("The attempt has no draft publication URL.", "observability");
  return {
    taskId: evidence.discovery.observedTaskId,
    attemptId,
    evidenceId: recordEvidence.id,
    publicationUrl,
  };
};

const assertGuardedControls = (
  controls: MissionControlAcceptanceEvidence["controls"],
): void => {
  assertCommandIdempotency(controls.runNow, "run-now");
  requireCondition(
    successfulCommand(controls.pause.outcome) &&
      controls.pause.statusAfter.status === 200 &&
      controls.pause.statusAfter.body.mode === "paused",
    "Pause did not reach the paused safe boundary.",
    "controls",
  );
  requireCondition(
    successfulCommand(controls.resume.outcome) &&
      controls.resume.statusAfter.status === 200 &&
      controls.resume.statusAfter.body.mode === "running",
    "Resume did not restart the worker polling loop.",
    "controls",
  );
  requireCondition(
    successfulCommand(controls.cancellation.outcome) &&
      controls.cancellation.outcome.attemptId ===
        controls.cancellation.attemptAfter.body.attemptId &&
      controls.cancellation.attemptAfter.status === 200 &&
      ["interrupted", "failed"].includes(
        controls.cancellation.attemptAfter.body.status,
      ) &&
      controls.cancellation.attemptAfter.body.evidence.length > 0,
    "Cancellation did not retain a classified attempt and evidence.",
    "controls",
  );
  requireCondition(
    nonEmpty(controls.safeRetry.expiredAttemptId) &&
      successfulCommand(controls.safeRetry.outcome) &&
      controls.safeRetry.outcome.attemptId ===
        controls.safeRetry.expiredAttemptId &&
      controls.safeRetry.outcome.reasonCode === "safe_retry" &&
      controls.safeRetry.attemptAfter.status === 200 &&
      controls.safeRetry.attemptAfter.body.attemptId !==
        controls.safeRetry.expiredAttemptId,
    "Safe retry was not limited to an expired claim with a fresh attempt.",
    "controls",
  );

  const manual = controls.manualIntervention;
  requireCondition(
    nonEmpty(manual.attemptId) &&
      manual.before.attemptId === manual.attemptId &&
      manual.before.status === "active" &&
      manual.before.claim?.phase === "started" &&
      manual.retry.code === "recovery_manual_intervention" &&
      manual.retry.reasonCode === "manual_intervention" &&
      manual.acknowledgement.code === "accepted" &&
      manual.acknowledgement.reasonCode === "manual_intervention" &&
      canonicalJson(manual.before) === canonicalJson(manual.after),
    "Manual-intervention protection was bypassed or acknowledgement changed evidence.",
    "controls",
  );
};

const assertPublicationIdempotency = (
  publication: MissionControlAcceptanceEvidence["publication"],
): void => {
  requireCondition(
    publication.first.draft &&
      publication.retry.draft &&
      nonEmpty(publication.first.url) &&
      publication.first.url === publication.retry.url &&
      publication.first.headSha === publication.retry.headSha &&
      publication.first.branchSha === publication.retry.branchSha &&
      publication.first.headSha === publication.first.branchSha,
    "Publication retry did not reuse one verified draft publication.",
    "idempotency",
  );
};

/** Authenticate the retained proof manifest under the acceptance run key. */
export const missionControlAcceptanceProofDigest = (
  proof: UnsignedMissionControlAcceptanceProof,
  integrityKey: string,
): string =>
  createHmac("sha256", integrityKey).update(canonicalJson(proof)).digest("hex");

/**
 * Validate and atomically retain one remote Mission Control acceptance proof.
 * The input is intentionally made of probe observations: the output contains
 * only safe identifiers, digests, outcome codes, and fixed limitations.
 */
export const runMissionControlAcceptanceProof = async (
  input: RunMissionControlAcceptanceProofInput,
): Promise<MissionControlAcceptanceProof> => {
  requireCondition(
    nonEmpty(input.proofPath),
    "proofPath must be non-empty.",
    "invalid_input",
  );
  requireCondition(
    input.integrityKey.length >= 16,
    "integrityKey must contain at least 16 characters.",
    "invalid_input",
  );
  const evidence =
    typeof input.evidence === "function"
      ? await input.evidence()
      : input.evidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    evidence.endpoints === undefined ||
    evidence.endpoints.queue === undefined
  ) {
    fail("The acceptance run is missing queue observations.", "observability");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  requireCondition(
    Number.isFinite(Date.parse(createdAt)),
    "createdAt must be an ISO timestamp.",
    "invalid_input",
  );

  assertSystemdDeployment(evidence.deployment);
  assertCredentialIsolation(evidence.credentials);
  assertDurability(evidence.durability, evidence.deployment);
  const lifecycle = assertOverviewAndInspection(evidence);
  assertGuardedControls(evidence.controls);
  assertPublicationIdempotency(evidence.publication);

  const manual = evidence.controls.manualIntervention;

  const checks: MissionControlAcceptanceChecks = {
    systemdUnit: true,
    privateByDefault: true,
    privateAccessDocumented: true,
    serverSideCredentials: true,
    durableRoot: true,
    restartRetention: true,
    liveDiscovery: true,
    queueInspection: true,
    executionEvents: true,
    verificationEvidence: true,
    draftPublication: true,
    pauseResume: true,
    cancellation: true,
    safeRetry: true,
    manualInterventionProtection: true,
    commandIdempotency: true,
    publicationIdempotency: true,
    controlledShutdown: true,
  };
  const unsigned: UnsignedMissionControlAcceptanceProof = {
    version: 1,
    kind: "mission-control-remote-deployment-acceptance",
    status: "passed",
    createdAt,
    checks,
    deployment: {
      bindAddress: evidence.deployment.bindAddress,
      privateAccess: evidence.deployment.privateAccess,
      systemdUnitPath: evidence.deployment.systemdUnitPath,
      systemdUnitDigest: canonicalJsonDigest(evidence.deployment.systemdUnit),
      durableRoot: evidence.deployment.durableRoot,
      durableArtifacts: [...MISSION_CONTROL_ACCEPTANCE_ARTIFACTS],
      backup: true,
      rollback: true,
      shutdownSignals: [...evidence.deployment.shutdown.signals],
    },
    lifecycle: {
      ...lifecycle,
      eventIds: [
        ...evidence.endpoints.events.initial,
        ...evidence.endpoints.events.resumed,
      ].map((event) => event.id),
    },
    controls: {
      runNowCommandId: evidence.controls.runNow.commandId,
      pauseCode: evidence.controls.pause.outcome.code,
      resumeCode: evidence.controls.resume.outcome.code,
      cancellationCode: evidence.controls.cancellation.outcome.code,
      safeRetryCode: evidence.controls.safeRetry.outcome.code,
      safeRetryAttemptId:
        evidence.controls.safeRetry.attemptAfter.body.attemptId,
      manualInterventionAttemptId: manual.attemptId,
      manualInterventionRetryCode: manual.retry.code,
      acknowledgementCode: manual.acknowledgement.code,
    },
    durability: {
      retainedArtifacts: [...MISSION_CONTROL_ACCEPTANCE_ARTIFACTS],
      beforeDigest: canonicalJsonDigest(evidence.durability.before),
      afterDigest: canonicalJsonDigest(evidence.durability.after),
      restartCount: evidence.durability.restartCount,
    },
    limitations: missionControlAcceptanceLimitations,
  };
  const proof: MissionControlAcceptanceProof = {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      digest: missionControlAcceptanceProofDigest(unsigned, input.integrityKey),
    },
  };
  await mkdir(dirname(input.proofPath), { recursive: true });
  const temporary = `${input.proofPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, input.proofPath);
  return proof;
};
