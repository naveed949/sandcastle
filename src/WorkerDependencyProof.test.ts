import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionRequest,
  NormalizedTask,
  TaskReference,
  TaskState,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";
import type { GitHubTaskSource } from "./GitHubTaskSource.js";
import {
  runDependencyChainAcceptanceProof,
  workerStateFilePath,
  type CrossRepositoryAcceptanceRuntime,
} from "./WorkerAcceptanceProof.js";
import { workerBranchFor } from "./WorkerRepositoryManager.js";
import type { WorkerPublicationResult } from "./WorkerPublication.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const reference = (number: number, kind: "issue" | "prd" = "issue") =>
  ({ repository: "acme/app", kind, number }) satisfies TaskReference;

const prd: NormalizedTask = {
  ...reference(1, "prd"),
  title: "PRD: Dependency chain",
  body: "Implement three concrete leaves in order.",
  labels: ["prd"],
  sourceRevision: "prd-revision-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [reference(2), reference(3), reference(4)],
};

const chain = ([2, 3, 4] as const).map(
  (number, index): NormalizedTask => ({
    ...reference(number),
    title: `Implement chain step ${index + 1}`,
    body: `Concrete task ${number}.`,
    labels: ["ready-for-agent"],
    sourceRevision: `issue-revision-${number}`,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    state: "open",
    dependencies: index === 0 ? [] : [reference(number - 1)],
    children: [],
    parentPrd: reference(1, "prd"),
  }),
) as unknown as readonly [NormalizedTask, NormalizedTask, NormalizedTask];

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
  },
  authorizedTasks: [],
  taskDependencies: [
    { task: reference(3), blockedBy: [reference(2)] },
    { task: reference(4), blockedBy: [reference(3)] },
  ],
  dependencyCompletionStates: ["completed"],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
  profiles: {
    node: { setupCommands: [], verificationCommands: ["npm test"] },
  },
};

const source = (states: Map<number, TaskState>): GitHubTaskSource => {
  const snapshots = () => [
    prd,
    ...chain.map((task) => {
      const state = states.get(task.number)!;
      return {
        ...task,
        state,
        sourceRevision: `${task.sourceRevision}-${state}`,
      };
    }),
  ];
  return {
    discover: vi.fn(async () => snapshots()),
    read: vi.fn(async ({ task: requested }) => {
      const tasks = snapshots();
      const task = tasks.find(
        (candidate) =>
          candidate.repository === requested.repository &&
          candidate.kind === requested.kind &&
          candidate.number === requested.number,
      );
      if (task === undefined) return undefined;
      const relatedIds = new Set([
        ...task.dependencies.map((dependency) => dependency.number),
        ...(task.parentPrd === undefined ? [] : [task.parentPrd.number]),
      ]);
      return {
        task,
        relatedTasks: tasks.filter(
          (candidate) =>
            relatedIds.has(candidate.number) &&
            candidate.number !== task.number,
        ),
      };
    }),
  };
};

const runtimeFor =
  (
    workspaceRoot: string,
    recordsRoot: string,
    states: Map<number, TaskState>,
  ) =>
  async (
    request: ExecutionRequest,
  ): Promise<CrossRepositoryAcceptanceRuntime> => {
    const stateFilePath = workerStateFilePath(
      workspaceRoot,
      request.task.repository,
    );
    const store = createWorkerStateStore({
      filePath: stateFilePath,
      now: () => "2026-08-24T00:00:00.000Z",
    });
    const branch = workerBranchFor(request);
    const sha = String(request.task.number).repeat(40);
    const recordPath = join(recordsRoot, `${request.executionIdentity}.json`);
    const runLogPath = join(
      workspaceRoot,
      "logs",
      `${request.task.number}.log`,
    );

    return {
      stateFilePath,
      store,
      execution: {
        execute: async (attempt) => {
          await store.markAttemptStarted(attempt.attemptId);
          await mkdir(dirname(recordPath), { recursive: true });
          await mkdir(dirname(runLogPath), { recursive: true });
          await writeFile(runLogPath, "complete\n", "utf8");
          const result: WorkerExecutionResult = {
            attemptId: attempt.attemptId,
            taskId: request.taskId,
            executionIdentity: request.executionIdentity,
            baseCommit: request.task.baseCommit,
            profileId: request.profileId,
            profileDigest: request.profileDigest,
            promptVersion: request.promptVersion,
            promptTemplateDigest: request.promptTemplateDigest,
            repository: request.task.repository,
            status: "verified",
            branch,
            repositoryCredentialNames: [],
            commits: [{ sha }],
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
            agent: {
              iterations: [],
              stdout: "complete",
              commits: [{ sha }],
              branch,
              logFilePath: runLogPath,
            },
            published: false,
            recordPath,
          };
          await writeFile(recordPath, `${JSON.stringify(result)}\n`, "utf8");
          await store.transitionAttempt(attempt.attemptId, {
            status: "verified",
            evidence: [recordPath, runLogPath],
          });
          return result;
        },
      },
      publisher: {
        publish: async (attemptId) => {
          const pullRequestUrl = `https://github.com/acme/app/pull/${request.task.number}`;
          const publication: WorkerPublicationResult = {
            attemptId,
            executionIdentity: request.executionIdentity,
            repository: request.task.repository,
            branch,
            branchSha: sha,
            pullRequest: {
              number: request.task.number,
              url: pullRequestUrl,
              draft: true,
              head: branch,
              headSha: sha,
              base: "main",
            },
            reusedBranch: false,
            reusedPullRequest: false,
          };
          await store.transitionAttempt(attemptId, {
            status: "published",
            evidence: [recordPath, pullRequestUrl],
          });
          states.set(request.task.number, "completed");
          return publication;
        },
      },
    };
  };

describe("runDependencyChainAcceptanceProof", () => {
  it("retains fresh dependency-order evidence for three PRD leaves", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "sandcastle-dependency-proof-"),
    );
    const recordsRoot = join(workspaceRoot, "records");
    const proofPath = join(workspaceRoot, "proof.json");
    const states = new Map<number, TaskState>([
      [2, "open"],
      [3, "open"],
      [4, "open"],
    ]);
    const taskSource = source(states);

    const proof = await runDependencyChainAcceptanceProof({
      proofPath,
      source: taskSource,
      configuration,
      prd: reference(1, "prd"),
      tasks: [reference(2), reference(3), reference(4)],
      owner: "acceptance-worker",
      leaseDurationMs: 60_000,
      runtimeFor: runtimeFor(workspaceRoot, recordsRoot, states),
      createdAt: "2026-08-24T00:00:00.000Z",
    });

    expect(proof.prd.body).toBe("Implement three concrete leaves in order.");
    expect(proof.stages.map((stage) => stage.taskId)).toEqual([
      "acme/app:issue:2",
      "acme/app:issue:3",
      "acme/app:issue:4",
    ]);
    expect(proof.stages.map((stage) => stage.blockedTaskIds)).toEqual([
      ["acme/app:issue:3", "acme/app:issue:4"],
      ["acme/app:issue:4"],
      [],
    ]);
    expect(
      proof.stages.every(
        (stage) =>
          stage.pullRequest.draft &&
          stage.commits.length === 1 &&
          stage.verification.every((result) => result.exitCode === 0) &&
          stage.prdContext.sourceRevision === "prd-revision-1" &&
          stage.claimSnapshots.some(
            (snapshot) => snapshot.kind === "prd" && snapshot.number === 1,
          ),
      ),
    ).toBe(true);
    expect(JSON.parse(await readFile(proofPath, "utf8"))).toEqual(proof);
    expect(taskSource.discover).toHaveBeenCalledTimes(3);
    expect(taskSource.read).toHaveBeenCalledTimes(3);
  });
});
