import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createDefaultWorkerPublicationOperations,
  createGitHubTaskSource,
  createWorkerPublisher,
  createWorkerPocBoundaryAuditRecorder,
  createWorkerService,
  createWorkerStateStore,
  workerBranchFor,
  type RunWorkerRestartAcceptanceProofInput,
  type WorkerConfiguration,
  type WorkerRestartAcceptanceScenario,
  type WorkerGuardedActionRecorder,
} from "../src/index.js";

interface RestartPhaseScenario {
  readonly stateFilePath: string;
  readonly workspaceRoot: string;
}

interface LiveRestartScenario {
  readonly proofPath: string;
  readonly runId: string;
  readonly configuration: WorkerConfiguration;
  readonly owner: string;
  readonly boundaryAuditPath: string;
  readonly leaseDurationMs?: number;
  readonly interrupted: RestartPhaseScenario;
  readonly verifiedPublication: RestartPhaseScenario;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for live restart acceptance.`);
  }
  return value;
};

const phase = (
  scenario: LiveRestartScenario,
  input: RestartPhaseScenario,
  token: string,
  suffix: string,
  guardedActions: WorkerGuardedActionRecorder,
): WorkerRestartAcceptanceScenario => {
  const store = createWorkerStateStore({ filePath: input.stateFilePath });
  const operations = createDefaultWorkerPublicationOperations({ token });
  const source = createGitHubTaskSource({ token });
  const replacementService = createWorkerService({
    configuration: scenario.configuration,
    source,
    store,
    execution: {
      execute: async () => {
        throw new Error("Restart recovery must not dispatch execution.");
      },
    },
    publisher: createWorkerPublisher({
      configuration: scenario.configuration,
      workspaceRoot: input.workspaceRoot,
      store,
      operations,
      guardedActions,
    }),
    owner: scenario.owner,
    pollIntervalMs: 60_000,
    leaseDurationMs: scenario.leaseDurationMs ?? 5 * 60_000,
    lockFilePath: join(dirname(input.stateFilePath), `${suffix}.lock`),
  });
  return {
    store,
    replacementService,
    observe: async (state) => {
      if (state.attempts.length !== 1) {
        throw new Error(`${suffix} state must contain exactly one attempt.`);
      }
      const attempt = state.attempts[0]!;
      const branch = workerBranchFor(attempt.request);
      await operations.resolveLocalBranch({
        repositoryDir: join(
          input.workspaceRoot,
          "repositories",
          ...attempt.request.task.repository.toLowerCase().split("/"),
          "cache",
        ),
        branch,
      });
      const pullRequests = await operations.listPullRequests({
        repository: attempt.request.task.repository,
        branch,
        base: attempt.request.task.baseBranch,
      });
      return {
        branch,
        pullRequests,
      };
    },
  };
};

export default async function liveFixture(): Promise<RunWorkerRestartAcceptanceProofInput> {
  const scenario = JSON.parse(
    await readFile(
      requiredEnvironment("SANDCASTLE_RESTART_ACCEPTANCE_SCENARIO"),
      "utf8",
    ),
  ) as LiveRestartScenario;
  const token = requiredEnvironment("GITHUB_TOKEN");
  const integrityKey = requiredEnvironment("SANDCASTLE_POC_GATE_AUDIT_KEY");
  const guardedActions = createWorkerPocBoundaryAuditRecorder({
    path: scenario.boundaryAuditPath,
    runId: scenario.runId,
    integrityKey,
  });
  return {
    proofPath: scenario.proofPath,
    runId: scenario.runId,
    integrityKey,
    configuration: scenario.configuration,
    interrupted: phase(
      scenario,
      scenario.interrupted,
      token,
      "interrupted-replacement",
      guardedActions,
    ),
    verifiedPublication: phase(
      scenario,
      scenario.verifiedPublication,
      token,
      "verified-replacement",
      guardedActions,
    ),
  };
}
