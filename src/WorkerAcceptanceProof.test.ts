import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionRequest,
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";
import type { GitHubTaskSource } from "./GitHubTaskSource.js";
import {
  runCrossRepositoryAcceptanceProof,
  workerStateFilePath,
  type CrossRepositoryAcceptanceRuntime,
} from "./WorkerAcceptanceProof.js";
import {
  workerBranchFor,
  workerRepositoryDirectory,
} from "./WorkerRepositoryManager.js";
import type { WorkerPublicationResult } from "./WorkerPublication.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const task = (repository: string, number: number): NormalizedTask => ({
  repository,
  kind: "issue",
  number,
  author: "naveed949",
  title: `Implement ${repository}#${number}`,
  body: "Retained live acceptance task.",
  labels: ["ready-for-agent"],
  sourceRevision: `${repository}-revision-${number}`,
  baseBranch: "main",
  baseCommit: repository.startsWith("acme/")
    ? "a".repeat(40)
    : repository.startsWith("beta/")
      ? "b".repeat(40)
      : "c".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
});

const firstApprovedTask = task("acme/app", 8);
const secondApprovedTask = task("beta/service", 8);
const thirdPartyTask = task("outside/library", 42);
const thirdPartySibling = task("outside/library", 43);
const scenarioTasks = [
  firstApprovedTask,
  secondApprovedTask,
  thirdPartyTask,
  thirdPartySibling,
];

const initialConfiguration: WorkerConfiguration = {
  repositories: {
    "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
    "beta/service": {
      authorized: true,
      baseBranch: "main",
      profileId: "rust",
    },
    "outside/library": {
      authorized: false,
      baseBranch: "main",
      profileId: "node",
    },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: {
    "worker-v1": "Implement this immutable task:\n{{TASK_SNAPSHOT}}",
  },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
    rust: {
      setupCommands: ["cargo fetch"],
      verificationCommands: ["cargo test"],
    },
  },
};

const authorizedConfiguration: WorkerConfiguration = {
  ...initialConfiguration,
  authorizedTasks: [
    { repository: "outside/library", kind: "issue", number: 42 },
  ],
};

const source = (): GitHubTaskSource => ({
  account: "naveed949",
  discover: vi.fn(async ({ includeConfiguredRepositories }) =>
    includeConfiguredRepositories === false
      ? [thirdPartyTask, thirdPartySibling]
      : scenarioTasks,
  ),
  read: vi.fn(async ({ task: reference }) =>
    scenarioTasks.find(
      (candidate) =>
        candidate.repository === reference.repository &&
        candidate.kind === reference.kind &&
        candidate.number === reference.number,
    ),
  ),
});

const runtimeFactory =
  (
    workspaceRoot: string,
    recordsRoot: string,
    options: {
      readonly leakCredential?: boolean;
      readonly leakForeignArtifact?: boolean;
    } = {},
  ) =>
  async (
    request: ExecutionRequest,
  ): Promise<CrossRepositoryAcceptanceRuntime> => {
    const repository = request.task.repository.toLowerCase();
    const repositoryDir = workerRepositoryDirectory(workspaceRoot, repository);
    const stateFilePath = workerStateFilePath(workspaceRoot, repository);
    const store = createWorkerStateStore({
      filePath: stateFilePath,
      now: () => "2026-08-23T12:00:00.000Z",
    });
    const branch = workerBranchFor(request);
    const index =
      repository === "acme/app" ? 1 : repository === "beta/service" ? 2 : 3;
    const headSha = String(index).repeat(40);
    const runLogPath = join(
      repositoryDir,
      ".sandcastle",
      "logs",
      `${request.executionIdentity}.log`,
    );
    const recordPath = join(
      recordsRoot,
      "repositories",
      ...repository.split("/"),
      "executions",
      request.executionIdentity,
      "result.json",
    );
    const pullRequestUrl = `https://github.com/${repository}/pull/${index}`;
    const worktreePath = join(
      repositoryDir,
      ".sandcastle",
      "worktrees",
      "live",
    );

    return {
      stateFilePath,
      store,
      execution: {
        execute: async (attempt) => {
          await store.markAttemptStarted(attempt.attemptId);
          await mkdir(dirname(runLogPath), { recursive: true });
          await writeFile(
            runLogPath,
            options.leakCredential
              ? '{"GITHUB_TOKEN":"leaked"}\n'
              : "live run log\n",
            "utf8",
          );
          if (options.leakForeignArtifact && repository === "acme/app") {
            const foreignPath = join(
              workspaceRoot,
              "repositories",
              "beta",
              "service",
              "cache",
              "foreign.txt",
            );
            await mkdir(dirname(foreignPath), { recursive: true });
            await writeFile(foreignPath, "cross-repository leak\n", "utf8");
          }
          await mkdir(dirname(recordPath), { recursive: true });
          await mkdir(repositoryDir, { recursive: true });
          await mkdir(join(repositoryDir, ".git"), { recursive: true });
          await mkdir(worktreePath, { recursive: true });
          const result: WorkerExecutionResult = {
            attemptId: attempt.attemptId,
            taskId: request.taskId,
            executionIdentity: request.executionIdentity,
            baseCommit: request.task.baseCommit,
            profileId: request.profileId,
            profileDigest: request.profileDigest,
            promptVersion: request.promptVersion,
            promptTemplateDigest: request.promptTemplateDigest,
            repository,
            status: "verified",
            branch,
            repositoryDir,
            worktreePath,
            repositoryCredentialNames: [],
            commits: [{ sha: headSha }],
            setup: [],
            verification: request.profile.verificationCommands.map(
              (command) => ({
                command,
                phase: "verification",
                exitCode: 0,
                stdout: "passed",
                stderr: "",
              }),
            ),
            agent: {
              iterations: [],
              stdout: "completed",
              commits: [{ sha: headSha }],
              branch,
              logFilePath: runLogPath,
            },
            published: false,
            recordPath,
          };
          await writeFile(
            recordPath,
            `${JSON.stringify(result, null, 2)}\n`,
            "utf8",
          );
          await store.transitionAttempt(attempt.attemptId, {
            status: "verified",
            evidence: [recordPath, runLogPath],
          });
          return result;
        },
      },
      publisher: {
        publish: async (attemptId) => {
          const publication: WorkerPublicationResult = {
            attemptId,
            executionIdentity: request.executionIdentity,
            repository,
            branch,
            branchSha: headSha,
            pullRequest: {
              number: index,
              url: pullRequestUrl,
              draft: true,
              head: branch,
              headSha,
              base: request.task.baseBranch,
            },
            reusedBranch: false,
            reusedPullRequest: false,
          };
          await store.transitionAttempt(attemptId, {
            status: "published",
            evidence: [recordPath, pullRequestUrl],
          });
          return publication;
        },
      },
    };
  };

const createInput = async (
  options: {
    readonly leakCredential?: boolean;
    readonly leakForeignArtifact?: boolean;
  } = {},
) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "sandcastle-live-acceptance-"),
  );
  const recordsRoot = join(workspaceRoot, "records");
  return {
    proofPath: join(workspaceRoot, "acceptance", "proof.json"),
    workspaceRoot,
    recordsRoot,
    source: source(),
    initialConfiguration,
    authorizedConfiguration,
    approvedTasks: [firstApprovedTask, secondApprovedTask] as const,
    thirdPartyTask,
    thirdPartySibling,
    owner: "acceptance-worker",
    leaseDurationMs: 60_000,
    runtimeFor: runtimeFactory(workspaceRoot, recordsRoot, options),
    createdAt: "2026-08-23T12:00:00.000Z",
  };
};

describe("runCrossRepositoryAcceptanceProof", () => {
  it("executes and reads back the live authorization and isolation proof", async () => {
    const input = await createInput();

    const proof = await runCrossRepositoryAcceptanceProof(input);
    const retained = JSON.parse(await readFile(input.proofPath, "utf8"));

    expect(proof.initialAuthorization).toMatchObject({
      taskId: "outside/library:issue:42",
      eligible: false,
      reasonCode: "unauthorized_repository",
    });
    expect(proof.authorizedDecision).toMatchObject({
      taskId: "outside/library:issue:42",
      eligible: true,
      authorization: "task",
    });
    expect(proof.siblingDecision).toMatchObject({
      taskId: "outside/library:issue:43",
      eligible: false,
    });
    expect(proof.runs.map((run) => run.taskId)).toEqual([
      "acme/app:issue:8",
      "beta/service:issue:8",
      "outside/library:issue:42",
    ]);
    expect(new Set(proof.runs.map((run) => run.executionIdentity)).size).toBe(
      3,
    );
    expect(new Set(proof.runs.map((run) => run.attemptId)).size).toBe(3);
    expect(new Set(proof.runs.map((run) => run.branch)).size).toBe(3);
    expect(retained).toEqual(proof);
    expect(input.source.discover).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        includeConfiguredRepositories: false,
        includeAccountWide: true,
      }),
    );
  });

  it("rejects repository-wide authorization of the third-party sibling", async () => {
    const input = await createInput();

    await expect(
      runCrossRepositoryAcceptanceProof({
        ...input,
        authorizedConfiguration: {
          ...authorizedConfiguration,
          repositories: {
            ...authorizedConfiguration.repositories,
            "outside/library": {
              ...authorizedConfiguration.repositories["outside/library"]!,
              authorized: true,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "authorization_boundary" });
  });

  it("rejects credential material read back from an agent artifact", async () => {
    const input = await createInput({ leakCredential: true });

    await expect(
      runCrossRepositoryAcceptanceProof(input),
    ).rejects.toMatchObject({ code: "isolation_failure" });
  });

  it("rejects a run that changes another repository's artifacts", async () => {
    const input = await createInput({ leakForeignArtifact: true });

    await expect(
      runCrossRepositoryAcceptanceProof(input),
    ).rejects.toMatchObject({ code: "isolation_failure" });
  });
});
