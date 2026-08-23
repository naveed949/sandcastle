import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  claudeCode,
  createDefaultWorkerPublicationOperations,
  createGitHubTaskSource,
  createWorkerExecutionEngine,
  createWorkerPublisher,
  createWorkerRepositoryManager,
  createWorkerStateStore,
  workerStateFilePath,
  type RunDependencyChainAcceptanceProofInput,
  type TaskReference,
  type WorkerConfiguration,
} from "../src/index.js";
import { docker } from "../src/sandboxes/docker.js";

const execFileAsync = promisify(execFile);

interface LiveDependencyScenario {
  readonly proofPath: string;
  readonly workspaceRoot: string;
  readonly recordsRoot: string;
  readonly owner: string;
  readonly leaseDurationMs?: number;
  readonly model?: string;
  readonly completionLabel?: string;
  readonly prd: TaskReference;
  readonly tasks: readonly [TaskReference, TaskReference, TaskReference];
  readonly configuration: WorkerConfiguration;
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

  return {
    ...scenario,
    source,
    leaseDurationMs: scenario.leaseDurationMs ?? 5 * 60_000,
    runtimeFor: async (request) => {
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
        }),
        publisher: createWorkerPublisher({
          configuration: scenario.configuration,
          workspaceRoot: scenario.workspaceRoot,
          store,
          operations: createDefaultWorkerPublicationOperations({ token }),
        }),
      };
    },
    afterStagePublished: async ({ task }) => {
      const label = scenario.completionLabel ?? "completed";
      await execFileAsync(
        "gh",
        [
          "issue",
          "edit",
          `https://github.com/${task.repository}/issues/${task.number}`,
          "--add-label",
          label,
        ],
        { env: { ...process.env, GH_TOKEN: token } },
      );
    },
  };
}
