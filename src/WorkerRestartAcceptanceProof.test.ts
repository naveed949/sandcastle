import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";
import type { DraftPullRequest } from "./WorkerPublication.js";
import type { WorkerService } from "./WorkerService.js";
import type {
  ExecutionAttempt,
  WorkerState,
  WorkerStateStore,
} from "./WorkerStateStore.js";
import {
  runWorkerRestartAcceptanceProof,
  workerRestartEvidenceDigest,
  type WorkerRestartAcceptanceScenario,
} from "./WorkerRestartAcceptanceProof.js";

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
  },
  profiles: {
    node: { setupCommands: [], verificationCommands: ["npm test"] },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
};
const task: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 1,
  title: "Restart proof",
  body: "Capture recovery.",
  labels: ["ready-for-agent"],
  sourceRevision: "revision-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};
const request = runWorkerDryRun({ configuration, tasks: [task] })
  .executionRequests[0]!;
const attempt = (
  status: ExecutionAttempt["status"],
  recordPath: string,
  pullRequestUrl?: string,
): ExecutionAttempt => ({
  attemptId: `${request.executionIdentity}:attempt-1`,
  executionIdentity: request.executionIdentity,
  request,
  status,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:02:00.000Z",
  claim: {
    taskId: request.taskId,
    sourceRevision: task.sourceRevision,
    owner: "worker-1",
    acquiredAt: "2026-08-24T00:00:00.000Z",
    leaseExpiresAt: "2026-08-24T00:05:00.000Z",
    phase: "started",
    refreshedSnapshots: [task],
  },
  outcomes:
    status === "active"
      ? []
      : [
          {
            status: "verified",
            timestamp: "2026-08-24T00:01:00.000Z",
            evidence: [recordPath],
          },
          ...(pullRequestUrl === undefined
            ? []
            : [
                {
                  status: "published" as const,
                  timestamp: "2026-08-24T00:02:00.000Z",
                  evidence: [recordPath, pullRequestUrl],
                },
              ]),
        ],
});
const state = (value: ExecutionAttempt): WorkerState => ({
  version: 1,
  taskSnapshots: [],
  executionRequests: [],
  attempts: [value],
});

const scenario = (
  before: WorkerState,
  after: WorkerState,
  beforePullRequests: readonly DraftPullRequest[],
  afterPullRequests: readonly DraftPullRequest[],
): WorkerRestartAcceptanceScenario => ({
  store: {
    read: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
  } as unknown as WorkerStateStore,
  replacementService: {
    runCycle: vi.fn(async () => ({ attempted: false, events: [] })),
  } as unknown as WorkerService,
  observe: vi
    .fn()
    .mockResolvedValueOnce({
      branch: "sandcastle/restart",
      pullRequests: beforePullRequests,
    })
    .mockResolvedValueOnce({
      branch: "sandcastle/restart",
      pullRequests: afterPullRequests,
    }),
});

describe("runWorkerRestartAcceptanceProof", () => {
  it("captures live replacement observations and authenticates provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-restart-proof-"));
    const proofPath = join(root, "restart.json");
    const recordPath = join(root, "execution.json");
    const pullRequest: DraftPullRequest = {
      number: 1,
      url: "https://github.com/acme/app/pull/1",
      draft: true,
      head: "sandcastle/restart",
      headSha: "b".repeat(40),
      base: "main",
    };
    const execution: WorkerExecutionResult = {
      attemptId: `${request.executionIdentity}:attempt-1`,
      taskId: request.taskId,
      executionIdentity: request.executionIdentity,
      baseCommit: task.baseCommit,
      profileId: request.profileId,
      profileDigest: request.profileDigest,
      promptVersion: request.promptVersion,
      promptTemplateDigest: request.promptTemplateDigest,
      repository: task.repository,
      status: "verified",
      commits: [{ sha: "b".repeat(40) }],
      setup: [],
      verification: [
        {
          command: "npm test",
          phase: "verification",
          exitCode: 0,
          stdout: "passed",
          stderr: "",
        },
      ],
      published: false,
      recordPath,
    };
    await writeFile(recordPath, JSON.stringify(execution), "utf8");
    const integrityKey = "test-restart-integrity-key";
    const proof = await runWorkerRestartAcceptanceProof({
      proofPath,
      runId: "gate-run-1",
      integrityKey,
      configuration,
      interrupted: scenario(
        state(attempt("active", recordPath)),
        state(attempt("active", recordPath)),
        [],
        [],
      ),
      verifiedPublication: scenario(
        state(attempt("verified", recordPath)),
        state(attempt("published", recordPath, pullRequest.url)),
        [],
        [pullRequest],
      ),
    });

    expect(proof.publication.executionRecordPath).toBe(recordPath);
    expect(proof.verifiedPublication.afterObservedPullRequests).toEqual([
      pullRequest,
    ]);
    expect(proof.integrity.digest).toBe(
      workerRestartEvidenceDigest(
        {
          runId: proof.runId,
          interrupted: proof.interrupted,
          verifiedPublication: proof.verifiedPublication,
          publication: proof.publication,
        },
        integrityKey,
      ),
    );
    expect(JSON.parse(await readFile(proofPath, "utf8"))).toEqual(proof);
  });
});
