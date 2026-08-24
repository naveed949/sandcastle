import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncFromFs } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, canonicalJsonDigest } from "./CanonicalJson.js";
import { containsProtectedWorkerMaterial } from "./WorkerIsolationPolicy.js";
import {
  runWorkerDryRun,
  workerTaskId,
  WorkerConfigurationError,
  normalizeRepository,
  type ConfiguredTaskDependencies,
  type DependencyCompletionState,
  type NormalizedTask,
  type TaskReference,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";

/** A safe repository policy projection for the operator surface. */
export interface MissionControlRepositoryPolicyView {
  readonly repository: string;
  readonly authorized: boolean;
  readonly baseBranch: string;
  readonly profileId: string;
}

/** A safe execution-profile projection for the operator surface. */
export interface MissionControlExecutionProfileView {
  readonly profileId: string;
  readonly profileDigest: string;
  readonly setupCommands: readonly string[];
  readonly verificationCommands: readonly string[];
}

/** A prompt artifact projection that exposes identity, never its contents. */
export interface MissionControlPromptArtifactView {
  readonly version: string;
  readonly digest: string;
  readonly hasTaskSnapshotMarker: boolean;
}

/** Server-owned policy state safe to return to a browser. */
export interface MissionControlPolicySnapshot {
  readonly repositories: readonly MissionControlRepositoryPolicyView[];
  readonly authorizedTasks: readonly TaskReference[];
  readonly taskDependencies: readonly ConfiguredTaskDependencies[];
  readonly dependencyCompletionStates: readonly DependencyCompletionState[];
  readonly promptVersion: string;
  readonly promptArtifacts: readonly MissionControlPromptArtifactView[];
  readonly executionProfiles: readonly MissionControlExecutionProfileView[];
  /** Alias retained for callers that use the WorkerConfiguration terminology. */
  readonly profiles: readonly MissionControlExecutionProfileView[];
}

/** Versioned current-policy read model. */
export interface MissionControlPolicyInspection extends MissionControlPolicySnapshot {
  readonly version: 1;
  readonly workerRevision: number;
  readonly configurationDigest: string;
  readonly policy: MissionControlPolicySnapshot;
}

/** Result of validating one proposed central policy. */
export type MissionControlPolicyValidation =
  | {
      readonly repositories: readonly MissionControlRepositoryPolicyView[];
      readonly authorizedTasks: readonly TaskReference[];
      readonly taskDependencies: readonly ConfiguredTaskDependencies[];
      readonly dependencyCompletionStates: readonly DependencyCompletionState[];
      readonly promptVersion: string;
      readonly promptArtifacts: readonly MissionControlPromptArtifactView[];
      readonly executionProfiles: readonly MissionControlExecutionProfileView[];
      readonly profiles: readonly MissionControlExecutionProfileView[];
      readonly version: 1;
      readonly valid: true;
      readonly configurationDigest: string;
      readonly policy: MissionControlPolicySnapshot;
    }
  | {
      readonly version: 1;
      readonly valid: false;
      readonly code: "invalid_policy";
      readonly issues: readonly string[];
    };

/** One redacted semantic policy change. */
export interface MissionControlPolicyDiffEntry {
  readonly path: string;
  readonly kind: "added" | "removed" | "changed";
  readonly before?: unknown;
  readonly after?: unknown;
}

/** A task decision without task body, prompt, or other protected content. */
export interface MissionControlPolicyDryRunDecision {
  readonly taskId: string;
  readonly eligible: boolean;
  readonly reasonCode: string;
  readonly authorization: "repository" | "task" | "none";
  readonly executionIdentity?: string;
}

/** Deterministic impact of a policy against the retained task snapshots. */
export interface MissionControlPolicyDryRunSummary {
  readonly candidateCount: number;
  readonly eligibleCount: number;
  readonly executionRequestCount: number;
  readonly decisions: readonly MissionControlPolicyDryRunDecision[];
}

/** Before/after dry-run impact included in a preview. */
export interface MissionControlPolicyDryRunImpact {
  readonly current: MissionControlPolicyDryRunSummary;
  readonly proposed: MissionControlPolicyDryRunSummary;
  readonly changedTasks: readonly string[];
  readonly newlyEligibleTasks: readonly string[];
  readonly noLongerEligibleTasks: readonly string[];
}

/** A preview identity that must be presented to apply a policy change. */
export interface MissionControlPolicyPreview {
  readonly version: 1;
  readonly previewId: string;
  readonly workerRevision: number;
  readonly currentConfigurationDigest: string;
  readonly proposedConfigurationDigest: string;
  readonly diff: readonly MissionControlPolicyDiffEntry[];
  readonly dryRunImpact: MissionControlPolicyDryRunImpact;
}

/** Guarded policy-apply request accepted by the operator API. */
export interface MissionControlPolicyApplyRequest {
  readonly previewId: string;
  readonly commandId: string;
  readonly expectedWorkerRevision: number;
  readonly reason: string;
  readonly configuration: unknown;
}

/** Stable outcomes for staged policy application. */
export type MissionControlPolicyApplyOutcomeCode =
  | "accepted"
  | "already_applied"
  | "stale_revision"
  | "stale_preview"
  | "unpreviewed"
  | "command_id_conflict"
  | "invalid_request"
  | "invalid_policy"
  | "command_failed";

/** Result retained for one policy command ID. */
export interface MissionControlPolicyApplyOutcome {
  readonly version: 1;
  readonly commandId: string;
  readonly code: MissionControlPolicyApplyOutcomeCode;
  readonly revision: number;
  readonly message: string;
  readonly previewId?: string;
  readonly configurationDigest?: string;
  readonly auditReference?: string;
}

/** Typed policy-administration error for direct callers and HTTP adapters. */
export class MissionControlPolicyError extends Error {
  readonly code: "invalid_policy" | "invalid_request" | "policy_storage";
  readonly issues: readonly string[];

  constructor(
    code: MissionControlPolicyError["code"],
    message: string,
    issues: readonly string[] = [],
  ) {
    super(message);
    this.name = "MissionControlPolicyError";
    this.code = code;
    this.issues = issues.map((issue) => safeText(issue));
  }
}

/** Callback used to update the active worker only after durable policy write. */
export interface MissionControlWorkerConfigurationUpdateRequest {
  readonly expectedRevision: number;
  readonly configuration: WorkerConfiguration;
  readonly persist: () => Promise<void>;
}

/** Narrow result returned by the WorkerService configuration seam. */
export interface MissionControlWorkerConfigurationUpdateResult {
  readonly code: "accepted" | "stale_revision" | "command_failed";
  readonly revision: number;
  readonly message: string;
}

/** Injectable boundaries for policy administration and deterministic tests. */
export interface MissionControlPolicyAdministrationOptions {
  /** Current active central configuration, kept server-side. */
  readonly configuration: WorkerConfiguration | (() => WorkerConfiguration);
  /** Atomic JSON configuration path outside repository contents. */
  readonly policyFilePath: string;
  /** Append-only policy preview/apply audit path. */
  readonly auditFilePath: string;
  /** Current WorkerService command revision. */
  readonly getWorkerRevision: () => number;
  /** Retained discovery snapshots used for preview impact. */
  readonly readTasks?: () => Promise<readonly NormalizedTask[]>;
  /** Worker-owned revision gate and active-configuration update. */
  readonly updateWorkerConfiguration?: (
    request: MissionControlWorkerConfigurationUpdateRequest,
  ) => Promise<MissionControlWorkerConfigurationUpdateResult>;
  /** Injectable clock for deterministic audit records. */
  readonly now?: () => string;
}

interface PolicyPreviewMetadata {
  readonly previewId: string;
  readonly workerRevision: number;
  readonly currentConfigurationDigest: string;
  readonly proposedConfigurationDigest: string;
  readonly diffDigest: string;
  readonly taskSetDigest: string;
}

interface PolicyAuditRecord {
  readonly version: 1;
  readonly kind: "policy-preview" | "policy-request" | "policy-outcome";
  readonly timestamp: string;
  readonly revision: number;
  readonly previewId?: string;
  readonly commandId?: string;
  readonly expectedWorkerRevision?: number;
  readonly proposedConfigurationDigest?: string;
  readonly currentConfigurationDigest?: string;
  readonly diffDigest?: string;
  readonly taskSetDigest?: string;
  readonly reason?: string;
  readonly code?: MissionControlPolicyApplyOutcomeCode;
  readonly message?: string;
  readonly auditReference?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
};

const safeText = (value: string): string =>
  containsProtectedWorkerMaterial(value)
    ? "Protected worker material redacted."
    : value;

const reference = (value: TaskReference): TaskReference => ({
  repository: normalizeRepository(value.repository),
  kind: value.kind,
  number: value.number,
});

const compareTaskReferences = (left: TaskReference, right: TaskReference) =>
  workerTaskId(left).localeCompare(workerTaskId(right));

/** Normalize a validated configuration into deterministic semantic order. */
export const normalizeMissionControlPolicy = (
  value: unknown,
): WorkerConfiguration => {
  if (!isRecord(value)) {
    throw new MissionControlPolicyError(
      "invalid_policy",
      "Policy configuration must be an object.",
      ["configuration must be an object"],
    );
  }

  try {
    runWorkerDryRun({
      configuration: value as unknown as WorkerConfiguration,
      tasks: [],
    });
  } catch (error) {
    if (error instanceof WorkerConfigurationError) {
      throw new MissionControlPolicyError(
        "invalid_policy",
        "Policy configuration failed central worker validation.",
        error.issues,
      );
    }
    throw error;
  }

  const configuration = value as unknown as WorkerConfiguration;
  const repositories = Object.fromEntries(
    Object.entries(configuration.repositories)
      .map(([repositoryName, policy]) => [
        normalizeRepository(repositoryName),
        {
          authorized: policy.authorized,
          baseBranch: policy.baseBranch.trim(),
          profileId: policy.profileId.trim(),
        },
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
  const authorizedTasks = [...configuration.authorizedTasks]
    .map(reference)
    .sort(compareTaskReferences);
  const taskDependencies = (configuration.taskDependencies ?? [])
    .map((edge) => ({
      task: reference(edge.task),
      blockedBy: [...edge.blockedBy].map(reference).sort(compareTaskReferences),
    }))
    .sort((left, right) => compareTaskReferences(left.task, right.task));
  const dependencyCompletionStates: DependencyCompletionState[] = [
    ...new Set<DependencyCompletionState>(
      configuration.dependencyCompletionStates ?? ["closed", "completed"],
    ),
  ].sort();
  const promptTemplates = Object.fromEntries(
    Object.entries(configuration.promptTemplates)
      .map(([version, template]) => [version.trim(), template])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
  const profiles = Object.fromEntries(
    Object.entries(configuration.profiles)
      .map(([profileId, profile]) => [
        profileId.trim(),
        {
          setupCommands: [...profile.setupCommands],
          verificationCommands: [...profile.verificationCommands],
        },
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );

  return deepFreeze({
    repositories,
    authorizedTasks,
    taskDependencies,
    dependencyCompletionStates,
    promptVersion: configuration.promptVersion.trim(),
    promptTemplates,
    profiles,
  });
};

/** Read the server-owned policy file, or return the validated bootstrap policy. */
export const readMissionControlPolicyConfiguration = (
  policyFilePath: string,
  bootstrapConfiguration: WorkerConfiguration,
): WorkerConfiguration => {
  const bootstrap = normalizeMissionControlPolicy(bootstrapConfiguration);
  let content: string;
  try {
    content = readFileSyncFromFs(policyFilePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return bootstrap;
    throw new MissionControlPolicyError(
      "policy_storage",
      "The server-owned policy file could not be read.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new MissionControlPolicyError(
      "policy_storage",
      "The server-owned policy file is not valid JSON.",
    );
  }
  const configuration =
    isRecord(value) && value.version === 1 && isRecord(value.configuration)
      ? value.configuration
      : value;
  return normalizeMissionControlPolicy(configuration);
};

let temporaryPolicyFileCounter = 0;

/** Atomically write one validated server-owned policy configuration. */
export const writeMissionControlPolicyConfiguration = async (
  policyFilePath: string,
  configuration: WorkerConfiguration,
): Promise<void> => {
  const normalized = normalizeMissionControlPolicy(configuration);
  await mkdir(dirname(policyFilePath), { recursive: true });
  temporaryPolicyFileCounter += 1;
  const temporaryPath = `${policyFilePath}.${process.pid}.${temporaryPolicyFileCounter}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          version: 1,
          configuration: normalized,
          configurationDigest: canonicalJsonDigest(normalized),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, policyFilePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const policySnapshot = (
  configuration: WorkerConfiguration,
): MissionControlPolicySnapshot => {
  const repositories = Object.entries(configuration.repositories)
    .map(([repository, policy]) => ({
      repository: safeText(normalizeRepository(repository)),
      authorized: policy.authorized,
      baseBranch: safeText(policy.baseBranch),
      profileId: safeText(policy.profileId),
    }))
    .sort((left, right) => left.repository.localeCompare(right.repository));
  const authorizedTasks = [...configuration.authorizedTasks]
    .map(reference)
    .sort(compareTaskReferences);
  const taskDependencies = [...(configuration.taskDependencies ?? [])]
    .map((edge) => ({
      task: reference(edge.task),
      blockedBy: [...edge.blockedBy].map(reference).sort(compareTaskReferences),
    }))
    .sort((left, right) => compareTaskReferences(left.task, right.task));
  const promptArtifacts = Object.entries(configuration.promptTemplates)
    .map(([version, template]) => ({
      version: safeText(version),
      digest: canonicalJsonDigest(template),
      hasTaskSnapshotMarker: template.includes("{{TASK_SNAPSHOT}}"),
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const executionProfiles = Object.entries(configuration.profiles)
    .map(([profileId, profile]) => ({
      profileId: safeText(profileId),
      profileDigest: canonicalJsonDigest(profile),
      setupCommands: profile.setupCommands.map(safeText),
      verificationCommands: profile.verificationCommands.map(safeText),
    }))
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
  return deepFreeze({
    repositories,
    authorizedTasks,
    taskDependencies,
    dependencyCompletionStates: [
      ...(configuration.dependencyCompletionStates ?? ["closed", "completed"]),
    ],
    promptVersion: safeText(configuration.promptVersion),
    promptArtifacts,
    executionProfiles,
    profiles: executionProfiles,
  });
};

const semanticPolicy = (
  configuration: WorkerConfiguration,
): Record<string, unknown> => {
  const snapshot = policySnapshot(configuration);
  return {
    repositories: Object.fromEntries(
      snapshot.repositories.map((policy) => [policy.repository, policy]),
    ),
    authorizedTasks: Object.fromEntries(
      snapshot.authorizedTasks.map((task) => [
        workerTaskId(task),
        workerTaskId(task),
      ]),
    ),
    taskDependencies: Object.fromEntries(
      snapshot.taskDependencies.map((edge) => [
        workerTaskId(edge.task),
        canonicalJson(edge),
      ]),
    ),
    dependencyCompletionStates: snapshot.dependencyCompletionStates,
    promptVersion: snapshot.promptVersion,
    promptArtifacts: Object.fromEntries(
      snapshot.promptArtifacts.map((artifact) => [artifact.version, artifact]),
    ),
    profiles: Object.fromEntries(
      snapshot.executionProfiles.map((profile) => [profile.profileId, profile]),
    ),
  };
};

const flattenSemantic = (
  value: unknown,
  prefix: string,
  output: Map<string, unknown>,
): void => {
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (entries.length === 0) {
      output.set(prefix, {});
      return;
    }
    for (const [key, nested] of entries) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (prefix === "authorizedTasks" || prefix === "taskDependencies") {
        output.set(path, nested);
      } else {
        flattenSemantic(nested, path, output);
      }
    }
    return;
  }
  output.set(prefix, value);
};

const semanticDiff = (
  current: WorkerConfiguration,
  proposed: WorkerConfiguration,
): readonly MissionControlPolicyDiffEntry[] => {
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  flattenSemantic(semanticPolicy(current), "", before);
  flattenSemantic(semanticPolicy(proposed), "", after);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  const changes: MissionControlPolicyDiffEntry[] = [];
  for (const path of paths) {
    const oldValue = before.get(path);
    const newValue = after.get(path);
    const hasOld = before.has(path);
    const hasNew = after.has(path);
    if (
      hasOld &&
      hasNew &&
      canonicalJson(oldValue) === canonicalJson(newValue)
    ) {
      continue;
    }
    if (!hasOld) {
      changes.push({ path, kind: "added", after: newValue });
      continue;
    }
    if (!hasNew) {
      changes.push({ path, kind: "removed", before: oldValue });
      continue;
    }
    changes.push({ path, kind: "changed", before: oldValue, after: newValue });
  }
  return changes;
};

const dryRunSummary = (
  configuration: WorkerConfiguration,
  tasks: readonly NormalizedTask[],
): MissionControlPolicyDryRunSummary => {
  const result = runWorkerDryRun({ configuration, tasks });
  return {
    candidateCount: result.decisions.length,
    eligibleCount: result.executionRequests.length,
    executionRequestCount: result.executionRequests.length,
    decisions: result.decisions.map((decision) => ({
      taskId: decision.taskId,
      eligible: decision.eligible,
      reasonCode: decision.reasonCode,
      authorization: decision.authorization,
      ...(decision.executionIdentity === undefined
        ? {}
        : { executionIdentity: decision.executionIdentity }),
    })),
  };
};

const dryRunImpact = (
  current: WorkerConfiguration,
  proposed: WorkerConfiguration,
  tasks: readonly NormalizedTask[],
): MissionControlPolicyDryRunImpact => {
  const currentSummary = dryRunSummary(current, tasks);
  const proposedSummary = dryRunSummary(proposed, tasks);
  const currentByTask = new Map(
    currentSummary.decisions.map((decision) => [decision.taskId, decision]),
  );
  const proposedByTask = new Map(
    proposedSummary.decisions.map((decision) => [decision.taskId, decision]),
  );
  const changedTasks = [
    ...new Set([...currentByTask.keys(), ...proposedByTask.keys()]),
  ]
    .filter(
      (taskId) =>
        canonicalJson(currentByTask.get(taskId)) !==
        canonicalJson(proposedByTask.get(taskId)),
    )
    .sort((left, right) => left.localeCompare(right));
  const newlyEligibleTasks = changedTasks.filter(
    (taskId) =>
      proposedByTask.get(taskId)?.eligible === true &&
      currentByTask.get(taskId)?.eligible !== true,
  );
  const noLongerEligibleTasks = changedTasks.filter(
    (taskId) =>
      currentByTask.get(taskId)?.eligible === true &&
      proposedByTask.get(taskId)?.eligible !== true,
  );
  return {
    current: currentSummary,
    proposed: proposedSummary,
    changedTasks,
    newlyEligibleTasks,
    noLongerEligibleTasks,
  };
};

const parsePolicyInput = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  for (const key of ["configuration", "policy", "proposedConfiguration"]) {
    if (isRecord(value[key])) return value[key];
  }
  return value;
};

const safeRevision = (value: number): number =>
  Number.isInteger(value) && value >= 0 ? value : 0;

const invalidOutcome = (
  commandId: string,
  revision: number,
  code: "invalid_request" | "invalid_policy",
  message: string,
  previewId?: string,
): MissionControlPolicyApplyOutcome => ({
  version: 1,
  commandId,
  code,
  revision,
  message,
  ...(previewId === undefined ? {} : { previewId }),
});

const parseApplyRequest = (
  value: unknown,
): MissionControlPolicyApplyRequest | undefined => {
  if (!isRecord(value)) return undefined;
  const expectedWorkerRevision =
    value.expectedWorkerRevision ?? value.expectedRevision;
  const configuration =
    value.configuration ?? value.policy ?? value.proposedConfiguration;
  if (
    typeof value.previewId !== "string" ||
    value.previewId.trim() === "" ||
    typeof value.commandId !== "string" ||
    value.commandId.trim() === "" ||
    value.commandId.length > 128 ||
    typeof expectedWorkerRevision !== "number" ||
    !Number.isInteger(expectedWorkerRevision) ||
    expectedWorkerRevision < 0 ||
    typeof value.reason !== "string" ||
    value.reason.trim() === "" ||
    configuration === undefined
  ) {
    return undefined;
  }
  return {
    previewId: value.previewId,
    commandId: value.commandId,
    expectedWorkerRevision,
    reason: value.reason,
    configuration,
  };
};

const validAuditString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isPolicyOutcomeCode = (
  value: unknown,
): value is MissionControlPolicyApplyOutcomeCode =>
  value === "accepted" ||
  value === "already_applied" ||
  value === "stale_revision" ||
  value === "stale_preview" ||
  value === "unpreviewed" ||
  value === "command_id_conflict" ||
  value === "invalid_request" ||
  value === "invalid_policy" ||
  value === "command_failed";

const readAudit = (
  auditFilePath: string,
): {
  readonly previews: readonly PolicyPreviewMetadata[];
  readonly outcomes: readonly MissionControlPolicyApplyOutcome[];
} => {
  let content: string;
  try {
    content = readFileSyncFromFs(auditFilePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { previews: [], outcomes: [] };
    }
    throw new MissionControlPolicyError(
      "policy_storage",
      "The policy audit could not be read.",
    );
  }
  const previews: PolicyPreviewMetadata[] = [];
  const outcomes: MissionControlPolicyApplyOutcome[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.version !== 1) continue;
    if (
      value.kind === "policy-preview" &&
      validAuditString(value.previewId) &&
      typeof value.revision === "number" &&
      typeof value.currentConfigurationDigest === "string" &&
      typeof value.proposedConfigurationDigest === "string" &&
      typeof value.diffDigest === "string" &&
      typeof value.taskSetDigest === "string"
    ) {
      previews.push({
        previewId: value.previewId,
        workerRevision: value.revision,
        currentConfigurationDigest: value.currentConfigurationDigest,
        proposedConfigurationDigest: value.proposedConfigurationDigest,
        diffDigest: value.diffDigest,
        taskSetDigest: value.taskSetDigest,
      });
    }
    if (
      value.kind === "policy-outcome" &&
      validAuditString(value.commandId) &&
      isPolicyOutcomeCode(value.code) &&
      typeof value.revision === "number" &&
      typeof value.message === "string"
    ) {
      outcomes.push({
        version: 1,
        commandId: value.commandId,
        code: value.code,
        revision: value.revision,
        message: value.message,
        ...(validAuditString(value.previewId)
          ? { previewId: value.previewId }
          : {}),
        ...(typeof value.proposedConfigurationDigest === "string"
          ? { configurationDigest: value.proposedConfigurationDigest }
          : {}),
        ...(typeof value.auditReference === "string"
          ? { auditReference: value.auditReference }
          : {}),
      });
    }
  }
  return { previews, outcomes };
};

/** Create server-owned staged policy administration around the worker policy. */
export const createMissionControlPolicyAdministration = (
  options: MissionControlPolicyAdministrationOptions,
): MissionControlPolicyAdministration => {
  if (options.policyFilePath.trim() === "") {
    throw new MissionControlPolicyError(
      "policy_storage",
      "policyFilePath must be non-empty.",
    );
  }
  if (options.auditFilePath.trim() === "") {
    throw new MissionControlPolicyError(
      "policy_storage",
      "auditFilePath must be non-empty.",
    );
  }

  let fallbackConfiguration =
    typeof options.configuration === "function"
      ? undefined
      : normalizeMissionControlPolicy(options.configuration);
  const getConfiguration =
    typeof options.configuration === "function"
      ? options.configuration
      : () => fallbackConfiguration!;
  const now = options.now ?? (() => new Date().toISOString());
  const retainedPreviews = new Map<string, PolicyPreviewMetadata>();
  const retainedOutcomes = new Map<string, MissionControlPolicyApplyOutcome>();
  const loaded = readAudit(options.auditFilePath);
  for (const preview of loaded.previews) {
    retainedPreviews.set(preview.previewId, preview);
  }
  for (const outcome of loaded.outcomes) {
    retainedOutcomes.set(outcome.commandId, outcome);
  }
  let auditWriteInFlight = Promise.resolve();
  const appendAudit = async (record: PolicyAuditRecord): Promise<void> => {
    const write = auditWriteInFlight.then(async () => {
      await mkdir(dirname(options.auditFilePath), { recursive: true });
      await appendFile(options.auditFilePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    auditWriteInFlight = write.catch(() => undefined);
    await write;
  };

  const currentConfiguration = (): WorkerConfiguration => {
    const value = getConfiguration();
    return normalizeMissionControlPolicy(value);
  };

  const updateFallbackConfiguration = async (
    request: MissionControlWorkerConfigurationUpdateRequest,
    currentRevision: number,
  ): Promise<MissionControlWorkerConfigurationUpdateResult> => {
    if (fallbackConfiguration === undefined) {
      return {
        code: "command_failed",
        revision: currentRevision,
        message: "No worker configuration update seam is available.",
      };
    }
    if (request.expectedRevision !== currentRevision) {
      return {
        code: "stale_revision",
        revision: currentRevision,
        message: "Expected worker revision is stale; no policy was applied.",
      };
    }
    await request.persist();
    fallbackConfiguration = request.configuration;
    return {
      code: "accepted",
      revision: currentRevision + 1,
      message: "Policy applied atomically.",
    };
  };

  const readTasks = async (): Promise<readonly NormalizedTask[]> => {
    const tasks = (await options.readTasks?.()) ?? [];
    const latest = new Map<string, NormalizedTask>();
    for (const task of tasks) latest.set(workerTaskId(task), task);
    return [...latest.values()].sort((left, right) =>
      workerTaskId(left).localeCompare(workerTaskId(right)),
    );
  };

  const inspect = async (): Promise<MissionControlPolicyInspection> => {
    const configuration = currentConfiguration();
    const policy = policySnapshot(configuration);
    return {
      version: 1,
      workerRevision: safeRevision(options.getWorkerRevision()),
      configurationDigest: canonicalJsonDigest(configuration),
      policy,
      ...policy,
    };
  };

  const validate = (value: unknown): MissionControlPolicyValidation => {
    try {
      const configuration = normalizeMissionControlPolicy(
        parsePolicyInput(value),
      );
      const policy = policySnapshot(configuration);
      return {
        version: 1,
        valid: true,
        configurationDigest: canonicalJsonDigest(configuration),
        policy,
        ...policy,
      };
    } catch (error) {
      if (error instanceof MissionControlPolicyError) {
        return {
          version: 1,
          valid: false,
          code: "invalid_policy",
          issues: error.issues.length > 0 ? error.issues : [error.message],
        };
      }
      throw error;
    }
  };

  const preview = async (
    value: unknown,
  ): Promise<MissionControlPolicyPreview> => {
    const proposed = normalizeMissionControlPolicy(parsePolicyInput(value));
    const current = currentConfiguration();
    const tasks = await readTasks();
    const diff = semanticDiff(current, proposed);
    const impact = dryRunImpact(current, proposed, tasks);
    const currentConfigurationDigest = canonicalJsonDigest(current);
    const proposedConfigurationDigest = canonicalJsonDigest(proposed);
    const diffDigest = canonicalJsonDigest(diff);
    const taskSetDigest = canonicalJsonDigest(tasks);
    const workerRevision = safeRevision(options.getWorkerRevision());
    const previewId = canonicalJsonDigest({
      version: 1,
      workerRevision,
      currentConfigurationDigest,
      proposedConfigurationDigest,
      diffDigest,
      impactDigest: canonicalJsonDigest(impact),
      taskSetDigest,
    });
    const metadata: PolicyPreviewMetadata = {
      previewId,
      workerRevision,
      currentConfigurationDigest,
      proposedConfigurationDigest,
      diffDigest,
      taskSetDigest,
    };
    const existing = retainedPreviews.get(previewId);
    if (existing === undefined) {
      retainedPreviews.set(previewId, metadata);
      await appendAudit({
        version: 1,
        kind: "policy-preview",
        timestamp: now(),
        revision: workerRevision,
        previewId,
        currentConfigurationDigest,
        proposedConfigurationDigest,
        diffDigest,
        taskSetDigest,
      });
    }
    return deepFreeze({
      version: 1,
      previewId,
      workerRevision,
      currentConfigurationDigest,
      proposedConfigurationDigest,
      diff,
      dryRunImpact: impact,
    });
  };

  const finish = async (
    request: MissionControlPolicyApplyRequest,
    outcome: MissionControlPolicyApplyOutcome,
  ): Promise<MissionControlPolicyApplyOutcome> => {
    const safeOutcome = {
      ...outcome,
      message: safeText(outcome.message),
    };
    await appendAudit({
      version: 1,
      kind: "policy-outcome",
      timestamp: now(),
      revision: safeOutcome.revision,
      commandId: request.commandId,
      previewId: request.previewId,
      proposedConfigurationDigest: safeOutcome.configurationDigest,
      code: safeOutcome.code,
      message: safeOutcome.message,
      ...(safeOutcome.auditReference === undefined
        ? {}
        : { auditReference: safeOutcome.auditReference }),
    });
    retainedOutcomes.set(request.commandId, safeOutcome);
    return safeOutcome;
  };

  const applyUnlocked = async (
    value: unknown,
  ): Promise<MissionControlPolicyApplyOutcome> => {
    const parsed = parseApplyRequest(value);
    const currentRevision = safeRevision(options.getWorkerRevision());
    if (parsed === undefined) {
      const commandId =
        isRecord(value) && typeof value.commandId === "string"
          ? value.commandId
          : "";
      return invalidOutcome(
        commandId,
        currentRevision,
        "invalid_request",
        "A preview ID, command ID, expected worker revision, reason, and policy configuration are required.",
      );
    }

    let proposed: WorkerConfiguration;
    try {
      proposed = normalizeMissionControlPolicy(parsed.configuration);
    } catch (error) {
      return finish(
        parsed,
        invalidOutcome(
          parsed.commandId,
          currentRevision,
          "invalid_policy",
          error instanceof MissionControlPolicyError
            ? error.issues.join("; ")
            : "Policy configuration failed central worker validation.",
          parsed.previewId,
        ),
      );
    }
    const proposedConfigurationDigest = canonicalJsonDigest(proposed);
    const retained = retainedOutcomes.get(parsed.commandId);
    if (retained !== undefined) {
      if (
        retained.previewId === parsed.previewId &&
        retained.configurationDigest === proposedConfigurationDigest
      ) {
        return retained;
      }
      return {
        version: 1,
        commandId: parsed.commandId,
        code: "command_id_conflict",
        revision: currentRevision,
        message: "Command ID is already bound to a different policy apply.",
      };
    }

    await appendAudit({
      version: 1,
      kind: "policy-request",
      timestamp: now(),
      revision: currentRevision,
      commandId: parsed.commandId,
      previewId: parsed.previewId,
      expectedWorkerRevision: parsed.expectedWorkerRevision,
      proposedConfigurationDigest,
      reason: safeText(parsed.reason),
    });

    const request = parsed;
    const current = currentConfiguration();
    const currentConfigurationDigest = canonicalJsonDigest(current);
    if (parsed.expectedWorkerRevision !== currentRevision) {
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "stale_revision",
        revision: currentRevision,
        message: "Expected worker revision is stale; no policy was applied.",
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
      });
    }
    const retainedPreview = retainedPreviews.get(parsed.previewId);
    if (retainedPreview === undefined) {
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "unpreviewed",
        revision: currentRevision,
        message: "Policy apply requires a retained preview identity.",
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
      });
    }
    const tasks = await readTasks();
    if (
      retainedPreview.workerRevision !== currentRevision ||
      retainedPreview.currentConfigurationDigest !==
        currentConfigurationDigest ||
      retainedPreview.proposedConfigurationDigest !==
        proposedConfigurationDigest ||
      retainedPreview.taskSetDigest !== canonicalJsonDigest(tasks)
    ) {
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "stale_preview",
        revision: currentRevision,
        message:
          "The policy preview is stale; preview the current policy again.",
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
      });
    }

    const auditReference = `operator://policy/${parsed.commandId}`;
    if (proposedConfigurationDigest === currentConfigurationDigest) {
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "already_applied",
        revision: currentRevision,
        message: "The proposed policy is already active.",
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
        auditReference,
      });
    }

    const persist = (): Promise<void> =>
      writeMissionControlPolicyConfiguration(options.policyFilePath, proposed);
    try {
      const updateRequest = {
        expectedRevision: parsed.expectedWorkerRevision,
        configuration: proposed,
        persist,
      };
      const update = options.updateWorkerConfiguration
        ? await options.updateWorkerConfiguration(updateRequest)
        : await updateFallbackConfiguration(updateRequest, currentRevision);
      if (update.code !== "accepted") {
        return finish(request, {
          version: 1,
          commandId: parsed.commandId,
          code: update.code,
          revision: update.revision,
          message: update.message,
          previewId: parsed.previewId,
          configurationDigest: proposedConfigurationDigest,
        });
      }
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "accepted",
        revision: update.revision,
        message: "Policy applied atomically after guarded validation.",
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
        auditReference,
      });
    } catch (error) {
      return finish(request, {
        version: 1,
        commandId: parsed.commandId,
        code: "command_failed",
        revision: safeRevision(options.getWorkerRevision()),
        message: `Policy apply failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        previewId: parsed.previewId,
        configurationDigest: proposedConfigurationDigest,
      });
    }
  };

  // Serialize policy commands so two network retries with the same command ID
  // cannot both pass the preview check before the first outcome is retained.
  let applyGate = Promise.resolve();
  const apply = async (
    value: unknown,
  ): Promise<MissionControlPolicyApplyOutcome> => {
    let release!: () => void;
    const previous = applyGate;
    applyGate = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await applyUnlocked(value);
    } finally {
      release();
    }
  };

  return {
    inspect,
    validate,
    preview,
    apply,
  };
};

/** Public policy administration seam used by Mission Control and tests. */
export interface MissionControlPolicyAdministration {
  inspect(): Promise<MissionControlPolicyInspection>;
  validate(value: unknown): MissionControlPolicyValidation;
  preview(value: unknown): Promise<MissionControlPolicyPreview>;
  apply(value: unknown): Promise<MissionControlPolicyApplyOutcome>;
}
