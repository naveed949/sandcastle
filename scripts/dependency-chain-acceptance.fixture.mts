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
  type RunDependencyChainAcceptanceProofInput,
  type TaskReference,
  type WorkerConfiguration,
} from "../src/index.js";
import { docker } from "../src/sandboxes/docker.js";

interface LiveDependencyScenario {
  readonly proofPath: string;
  readonly workspaceRoot: string;
  readonly recordsRoot: string;
  readonly owner: string;
  readonly leaseDurationMs?: number;
  readonly model?: string;
  readonly transitionPollMs?: number;
  readonly transitionTimeoutMs?: number;
  readonly prd: TaskReference;
  readonly tasks: readonly [TaskReference, TaskReference, TaskReference];
  readonly configuration: WorkerConfiguration;
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

export default async function liveFixture(): Promise<RunDependencyChainAcceptanceProofInput> {
  const scenarioPath = requiredEnvironment(
    "SANDCASTLE_DEPENDENCY_ACCEPTANCE_SCENARIO",
  );
  const token = requiredEnvironment("GITHUB_TOKEN");
  const scenario = JSON.parse(
    await readFile(scenarioPath, "utf8"),
  ) as LiveDependencyScenario;
  const source = createGitHubTaskSource({ token });
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
          configuration: scenario.configuration,
          repositoryManager,
          store,
          recordsRoot: scenario.recordsRoot,
          guardedActions,
        }),
        publisher: createWorkerPublisher({
          configuration: scenario.configuration,
          workspaceRoot: scenario.workspaceRoot,
          store,
          operations: createDefaultWorkerPublicationOperations({ token }),
          guardedActions,
        }),
      };
    },
    afterStagePublished: async ({ stageIndex, task }) => {
      if (stageIndex === scenario.tasks.length - 1) return;
      const deadline =
        Date.now() + (scenario.transitionTimeoutMs ?? 15 * 60_000);
      while (Date.now() < deadline) {
        const refreshed = await source.read({
          configuration: scenario.configuration,
          task,
        });
        if (
          refreshed !== undefined &&
          (
            scenario.configuration.dependencyCompletionStates ?? [
              "closed",
              "completed",
            ]
          ).includes(refreshed.task.state as "closed" | "completed")
        ) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, scenario.transitionPollMs ?? 5_000),
        );
      }
      throw new Error(
        `Timed out waiting for an operator to complete ${task.repository}#${task.number}.`,
      );
    },
  };
}
