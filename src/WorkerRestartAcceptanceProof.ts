import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import type {
  RetainedRestartPublication,
  WorkerRestartAcceptanceEvidence,
  WorkerRestartScenarioEvidence,
} from "./WorkerPocGate.js";
import type { DraftPullRequest } from "./WorkerPublication.js";
import type { WorkerService } from "./WorkerService.js";
import type { WorkerState, WorkerStateStore } from "./WorkerStateStore.js";
import { canonicalJson } from "./CanonicalJson.js";
import {
  workerConfigurationDigest,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";

export interface WorkerRestartObservation {
  readonly branch: string | undefined;
  readonly pullRequests: readonly DraftPullRequest[];
}

export interface WorkerRestartAcceptanceScenario {
  /** Durable store left by the stopped worker process. */
  readonly store: WorkerStateStore;
  /** Fresh replacement service instance using the same durable state. */
  readonly replacementService: WorkerService;
  /** Live local-branch and issue-tracker observation boundary. */
  readonly observe: (state: WorkerState) => Promise<WorkerRestartObservation>;
}

export interface RunWorkerRestartAcceptanceProofInput {
  readonly proofPath: string;
  readonly runId: string;
  readonly integrityKey: string;
  readonly configuration: WorkerConfiguration;
  readonly interrupted: WorkerRestartAcceptanceScenario;
  readonly verifiedPublication: WorkerRestartAcceptanceScenario;
}

const loadExecutionResult = async (
  path: string,
): Promise<WorkerExecutionResult> =>
  JSON.parse(await readFile(path, "utf8")) as WorkerExecutionResult;

type UnsignedWorkerRestartAcceptanceEvidence = Omit<
  WorkerRestartAcceptanceEvidence,
  "integrity"
>;

/** Authenticate one restart manifest under the deployed gate run key. */
export const workerRestartEvidenceDigest = (
  evidence: UnsignedWorkerRestartAcceptanceEvidence,
  integrityKey: string,
): string =>
  createHmac("sha256", integrityKey)
    .update(canonicalJson(evidence))
    .digest("hex");

const captureScenario = async (
  scenario: WorkerRestartAcceptanceScenario,
): Promise<WorkerRestartScenarioEvidence> => {
  const beforeRestart = await scenario.store.read();
  const beforeObservation = await scenario.observe(beforeRestart);
  const recoveryCycle = await scenario.replacementService.runCycle();
  const afterRestart = await scenario.store.read();
  const afterObservation = await scenario.observe(afterRestart);
  const observedPullRequests = [
    ...beforeObservation.pullRequests,
    ...afterObservation.pullRequests,
  ].filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.url === candidate.url) === index,
  );
  return {
    beforeRestart,
    afterRestart,
    recoveryCycle,
    observedBranches: [
      beforeObservation.branch,
      afterObservation.branch,
    ].filter((branch): branch is string => branch !== undefined),
    observedPullRequests,
    beforeObservedPullRequests: beforeObservation.pullRequests,
    afterObservedPullRequests: afterObservation.pullRequests,
  };
};

const retainedPublicationFrom = async (
  scenario: WorkerRestartScenarioEvidence,
  configuration: WorkerConfiguration,
): Promise<RetainedRestartPublication> => {
  const before = scenario.beforeRestart.attempts[0];
  const after = scenario.afterRestart.attempts[0];
  const pullRequest = scenario.afterObservedPullRequests[0];
  const evidence = [
    ...(after?.outcomes.flatMap((outcome) => outcome.evidence ?? []) ?? []),
  ];
  const executionRecordPath =
    before?.outcomes
      .flatMap((outcome) => outcome.evidence ?? [])
      .find((item) => item.endsWith(".json")) ?? evidence[0];
  if (
    before === undefined ||
    after === undefined ||
    pullRequest === undefined ||
    executionRecordPath === undefined
  ) {
    throw new Error("Verified restart publication evidence is incomplete.");
  }
  const execution = await loadExecutionResult(executionRecordPath);
  if (
    execution.status !== "verified" ||
    execution.attemptId !== before.attemptId ||
    execution.executionIdentity !== before.executionIdentity ||
    execution.commits.length === 0 ||
    execution.verification.some((result) => result.exitCode !== 0) ||
    pullRequest.headSha.toLowerCase() !==
      execution.commits.at(-1)?.sha.toLowerCase()
  ) {
    throw new Error("Restart publication is not bound to verified execution.");
  }
  return {
    taskId: before.request.taskId,
    snapshot: before.request.task,
    executionIdentity: before.executionIdentity,
    attemptId: before.attemptId,
    configurationDigest: workerConfigurationDigest(configuration),
    profileId: before.request.profileId,
    profileDigest: before.request.profileDigest,
    promptVersion: before.request.promptVersion,
    promptTemplateDigest: before.request.promptTemplateDigest,
    commits: execution.commits,
    verification: execution.verification.map(({ command, exitCode }) => ({
      command,
      exitCode,
    })),
    evidence: [...new Set([...evidence, executionRecordPath, pullRequest.url])],
    pullRequest,
    executionRecordPath,
  };
};

/** Capture restart evidence from durable state, a replacement service, and live observations. */
export const runWorkerRestartAcceptanceProof = async (
  input: RunWorkerRestartAcceptanceProofInput,
): Promise<WorkerRestartAcceptanceEvidence> => {
  if (
    input.proofPath.trim() === "" ||
    input.runId.trim() === "" ||
    input.integrityKey.length < 16
  ) {
    throw new Error("proofPath, runId, and integrityKey must be valid.");
  }
  const interrupted = await captureScenario(input.interrupted);
  const verifiedPublication = await captureScenario(input.verifiedPublication);
  const unsigned: UnsignedWorkerRestartAcceptanceEvidence = {
    runId: input.runId,
    interrupted,
    verifiedPublication,
    publication: await retainedPublicationFrom(
      verifiedPublication,
      input.configuration,
    ),
  };
  const proof: WorkerRestartAcceptanceEvidence = {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      digest: workerRestartEvidenceDigest(unsigned, input.integrityKey),
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
