import { readFile } from "node:fs/promises";
import {
  claudeCode,
  createDefaultWorkerPublicationOperations,
  createGitHubTaskSource,
  createWorkerExecutionEngine,
  createWorkerPocBoundaryAuditRecorder,
  createWorkerPublisher,
  createWorkerRepositoryManager,
  createWorkerStateStore,
  workerStateFilePath,
  type RunCrossRepositoryAcceptanceProofInput,
  type TaskReference,
  type WorkerConfiguration,
} from "../src/index.js";
import { docker } from "../src/sandboxes/docker.js";

interface LiveScenario {
  readonly proofPath: string;
  readonly workspaceRoot: string;
  readonly recordsRoot: string;
  readonly account: string;
  readonly owner: string;
  readonly leaseDurationMs?: number;
  readonly model?: string;
  readonly approvedTasks: readonly [TaskReference, TaskReference];
  readonly thirdPartyTask: TaskReference;
  readonly thirdPartySibling: TaskReference;
  readonly initialConfiguration: WorkerConfiguration;
  readonly authorizedConfiguration: WorkerConfiguration;
  readonly boundaryAuditPath?: string;
  readonly boundaryAuditRunId?: string;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for live GitHub acceptance.`);
  }
  return value;
};

export default async function liveFixture(): Promise<RunCrossRepositoryAcceptanceProofInput> {
  const scenarioPath = requiredEnvironment(
    "SANDCASTLE_CROSS_REPO_ACCEPTANCE_SCENARIO",
  );
  const token = requiredEnvironment("GITHUB_TOKEN");
  const scenario = JSON.parse(
    await readFile(scenarioPath, "utf8"),
  ) as LiveScenario;
  const source = createGitHubTaskSource({
    account: scenario.account,
    token,
  });
  if (
    (scenario.boundaryAuditPath === undefined) !==
    (scenario.boundaryAuditRunId === undefined)
  ) {
    throw new Error(
      "boundaryAuditPath and boundaryAuditRunId must be provided together.",
    );
  }
  const boundaryAudit =
    scenario.boundaryAuditPath === undefined
      ? undefined
      : createWorkerPocBoundaryAuditRecorder({
          path: scenario.boundaryAuditPath,
          runId: scenario.boundaryAuditRunId!,
          integrityKey: requiredEnvironment("SANDCASTLE_POC_GATE_AUDIT_KEY"),
        });

  return {
    ...scenario,
    source,
    leaseDurationMs: scenario.leaseDurationMs ?? 5 * 60_000,
    boundaryAudit,
    runtimeFor: async (request, guardedActions) => {
      const stateFilePath = workerStateFilePath(
        scenario.workspaceRoot,
        request.task.repository,
      );
      const store = createWorkerStateStore({ filePath: stateFilePath });
      const repositoryManager = createWorkerRepositoryManager({
        workspaceRoot: scenario.workspaceRoot,
        agentRunOptions: {
          agent: claudeCode(scenario.model ?? "claude-opus-4-8"),
          sandbox: docker(),
        },
      });
      return {
        stateFilePath,
        store,
        execution: createWorkerExecutionEngine({
          configuration: scenario.authorizedConfiguration,
          repositoryManager,
          store,
          recordsRoot: scenario.recordsRoot,
          guardedActions,
        }),
        publisher: createWorkerPublisher({
          configuration: scenario.authorizedConfiguration,
          workspaceRoot: scenario.workspaceRoot,
          store,
          operations: createDefaultWorkerPublicationOperations({ token }),
          guardedActions,
        }),
      };
    },
  };
}
