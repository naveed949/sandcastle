import { readFile } from "node:fs/promises";
import {
  createGitHubTaskSource,
  type CrossRepositoryAcceptanceProof,
  type DependencyChainAcceptanceProof,
  type RunWorkerPocGateInput,
  type TaskReference,
  type WorkerConfiguration,
  type WorkerRestartAcceptanceEvidence,
  type WorkerState,
} from "../src/index.js";

interface LivePocGateScenario {
  readonly proofPath: string;
  readonly reportPath: string;
  readonly account: string;
  readonly configuration: WorkerConfiguration;
  readonly unauthorizedTask: TaskReference;
  readonly unauthorizedInboxStatePath: string;
  readonly exactTasks?: readonly TaskReference[];
  readonly prdReferences?: readonly TaskReference[];
  readonly crossRepositoryProofPath: string;
  readonly dependencyChainProofPath: string;
  readonly restartEvidencePath: string;
  readonly boundaryAuditPath: string;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the live POC gate.`);
  }
  return value;
};

const readJson = async <T,>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

export default async function liveFixture(): Promise<RunWorkerPocGateInput> {
  const scenario = await readJson<LivePocGateScenario>(
    requiredEnvironment("SANDCASTLE_POC_GATE_SCENARIO"),
  );
  const token = requiredEnvironment("GITHUB_TOKEN");
  const source = createGitHubTaskSource({
    account: scenario.account,
    token,
  });
  const [
    crossRepositoryProof,
    dependencyChainProof,
    restartEvidence,
    unauthorizedInboxState,
  ] = await Promise.all([
    readJson<CrossRepositoryAcceptanceProof>(scenario.crossRepositoryProofPath),
    readJson<DependencyChainAcceptanceProof>(scenario.dependencyChainProofPath),
    readJson<WorkerRestartAcceptanceEvidence>(scenario.restartEvidencePath),
    readJson<WorkerState>(scenario.unauthorizedInboxStatePath),
  ]);

  return {
    proofPath: scenario.proofPath,
    reportPath: scenario.reportPath,
    configuration: scenario.configuration,
    account: scenario.account,
    discover: () =>
      source.discover({
        configuration: scenario.configuration,
        exactTasks: scenario.exactTasks,
        prdReferences: scenario.prdReferences,
        includeConfiguredRepositories: true,
        includeAccountWide: true,
      }),
    unauthorizedTask: scenario.unauthorizedTask,
    unauthorizedInboxState,
    crossRepositoryProof,
    dependencyChainProof,
    restartEvidence,
    boundaryAuditPath: scenario.boundaryAuditPath,
    boundaryAuditKey: requiredEnvironment("SANDCASTLE_POC_GATE_AUDIT_KEY"),
  };
}
