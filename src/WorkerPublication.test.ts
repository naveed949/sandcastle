import { describe, expect, it, vi } from "vitest";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";
import { workerBranchFor } from "./WorkerRepositoryManager.js";
import {
  createWorkerPublisher,
  WorkerPublicationError,
  type DraftPullRequest,
  type WorkerPublicationOperations,
} from "./WorkerPublication.js";
import type {
  ExecutionAttempt,
  WorkerState,
  WorkerStateStore,
} from "./WorkerStateStore.js";

const task: NormalizedTask = {
  repository: "Acme/App",
  kind: "issue",
  number: 7,
  title: "Publish verified work",
  body: "Open a draft pull request.",
  labels: [],
  sourceRevision: "revision-7",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test", "npm run typecheck"],
    },
  },
};

const request = runWorkerDryRun({
  configuration,
  tasks: [task],
}).executionRequests[0]!;
const branch = workerBranchFor(request);
const headSha = "d".repeat(40);
const recordPath = "/records/acme/app/execution.json";

const executionResult: WorkerExecutionResult = {
  attemptId: `attempt:${request.executionIdentity}`,
  taskId: request.taskId,
  executionIdentity: request.executionIdentity,
  baseCommit: task.baseCommit,
  profileId: request.profileId,
  profileDigest: request.profileDigest,
  promptVersion: request.promptVersion,
  promptTemplateDigest: request.promptTemplateDigest,
  repository: "acme/app",
  status: "verified",
  branch,
  commits: [{ sha: headSha }],
  setup: [
    {
      command: "npm ci",
      phase: "setup",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  ],
  verification: [
    {
      command: "npm test",
      phase: "verification",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    },
    {
      command: "npm run typecheck",
      phase: "verification",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    },
  ],
  published: false,
  recordPath,
};

const attempt = (
  status: "active" | "verified" | "published",
): ExecutionAttempt => ({
  attemptId: executionResult.attemptId,
  executionIdentity: request.executionIdentity,
  request,
  status,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:01:00.000Z",
  outcomes:
    status === "active"
      ? []
      : [
          {
            status: "verified",
            timestamp: "2026-08-23T00:01:00.000Z",
            evidence: [recordPath],
          },
          ...(status === "published"
            ? [
                {
                  status: "published" as const,
                  timestamp: "2026-08-23T00:02:00.000Z",
                  evidence: [recordPath, "https://github.com/acme/app/pull/17"],
                },
              ]
            : []),
        ],
});

const createStore = (initial: ExecutionAttempt) => {
  let current = initial;
  const state = (): WorkerState => ({
    version: 1,
    taskSnapshots: [],
    executionRequests: [],
    attempts: [current],
  });
  const transitionAttempt = vi.fn(async (_attemptId, transition) => {
    current = {
      ...current,
      status: transition.status,
      outcomes: [
        ...current.outcomes,
        {
          status: transition.status,
          timestamp: "2026-08-23T00:03:00.000Z",
          evidence: transition.evidence ?? [],
        },
      ],
    };
    return current;
  });
  const store = {
    read: vi.fn(async () => state()),
    transitionAttempt,
  } as unknown as WorkerStateStore;
  return { store, transitionAttempt };
};

const draftPullRequest: DraftPullRequest = {
  number: 17,
  url: "https://github.com/acme/app/pull/17",
  draft: true,
  head: branch,
  headSha,
  base: "main",
};

const createOperations = (): WorkerPublicationOperations => {
  let remoteBranch:
    | { readonly branch: string; readonly sha: string }
    | undefined;
  return {
    getCanonicalRemote: vi.fn(async () => "https://github.com/acme/app.git"),
    resolveLocalBranch: vi.fn(async () => headSha),
    inspectDestination: vi.fn(async () => ({
      repository: "acme/app",
      canonicalRemote: "https://github.com/acme/app.git",
    })),
    findRemoteBranch: vi.fn(async () => remoteBranch),
    pushBranch: vi.fn(async (input) => {
      remoteBranch = { branch: input.branch, sha: input.sha };
    }),
    findPullRequest: vi.fn(async () => undefined),
    createDraftPullRequest: vi.fn(async () => draftPullRequest),
  };
};

const publisher = (
  initialAttempt: ExecutionAttempt,
  operations = createOperations(),
) => {
  const storeHarness = createStore(initialAttempt);
  return {
    ...storeHarness,
    operations,
    publisher: createWorkerPublisher({
      configuration,
      workspaceRoot: "/worker",
      store: storeHarness.store,
      operations,
      loadExecutionResult: vi.fn(async () => executionResult),
    }),
  };
};

describe("WorkerPublisher", () => {
  it("publishes only retained verified evidence as a draft and records the boundary", async () => {
    const harness = publisher(attempt("verified"));

    const result = await harness.publisher.publish(executionResult.attemptId);

    expect(result).toMatchObject({
      repository: "acme/app",
      branch,
      branchSha: headSha,
      reusedBranch: false,
      reusedPullRequest: false,
      pullRequest: draftPullRequest,
    });
    expect(harness.operations.pushBranch).toHaveBeenCalledWith({
      repositoryDir: "/worker/repositories/acme/app/cache",
      canonicalRemote: "https://github.com/acme/app.git",
      branch,
      sha: headSha,
    });
    expect(harness.operations.createDraftPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "acme/app",
        branch,
        base: "main",
        title: task.title,
        body: expect.stringMatching(
          new RegExp(
            `issues/7[\\s\\S]*${request.executionIdentity}[\\s\\S]*${task.baseCommit}[\\s\\S]*${headSha}[\\s\\S]*npm test.*passed`,
          ),
        ),
      }),
    );
    expect(harness.transitionAttempt).toHaveBeenCalledWith(
      executionResult.attemptId,
      {
        status: "published",
        evidence: [recordPath, draftPullRequest.url],
      },
    );
  });

  it("rejects unverified attempts before any publication operation", async () => {
    const harness = publisher(attempt("active"));

    await expect(
      harness.publisher.publish(executionResult.attemptId),
    ).rejects.toMatchObject({ code: "not_verified" });
    for (const operation of Object.values(harness.operations)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("rejects retained evidence that omits a required verification command", async () => {
    const operations = createOperations();
    const storeHarness = createStore(attempt("verified"));
    const incompleteResult = {
      ...executionResult,
      verification: executionResult.verification.slice(0, 1),
    };
    const guardedPublisher = createWorkerPublisher({
      configuration,
      workspaceRoot: "/worker",
      store: storeHarness.store,
      operations,
      loadExecutionResult: vi.fn(async () => incompleteResult),
    });

    await expect(
      guardedPublisher.publish(executionResult.attemptId),
    ).rejects.toMatchObject({ code: "evidence_mismatch" });
    for (const operation of Object.values(operations)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the local remote or GitHub destination was retargeted", async () => {
    const operations = createOperations();
    vi.mocked(operations.inspectDestination).mockResolvedValue({
      repository: "attacker/app",
      canonicalRemote: "https://github.com/attacker/app.git",
    });
    const harness = publisher(attempt("verified"), operations);

    await expect(
      harness.publisher.publish(executionResult.attemptId),
    ).rejects.toMatchObject({ code: "remote_mismatch" });
    expect(operations.pushBranch).not.toHaveBeenCalled();
    expect(operations.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("reuses the exact remote branch and matching draft pull request", async () => {
    const operations = createOperations();
    vi.mocked(operations.findRemoteBranch).mockResolvedValue({
      branch,
      sha: headSha,
    });
    vi.mocked(operations.findPullRequest).mockResolvedValue(draftPullRequest);
    const harness = publisher(attempt("published"), operations);

    const result = await harness.publisher.publish(executionResult.attemptId);

    expect(result.reusedBranch).toBe(true);
    expect(result.reusedPullRequest).toBe(true);
    expect(operations.pushBranch).not.toHaveBeenCalled();
    expect(operations.createDraftPullRequest).not.toHaveBeenCalled();
    expect(harness.transitionAttempt).not.toHaveBeenCalled();
  });

  it("recovers after a push succeeds but pull-request creation fails", async () => {
    const operations = createOperations();
    vi.mocked(operations.findRemoteBranch)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ branch, sha: headSha });
    vi.mocked(operations.createDraftPullRequest)
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce(draftPullRequest);
    const harness = publisher(attempt("verified"), operations);

    await expect(
      harness.publisher.publish(executionResult.attemptId),
    ).rejects.toThrow("GitHub unavailable");
    const recovered = await harness.publisher.publish(
      executionResult.attemptId,
    );

    expect(recovered.reusedBranch).toBe(true);
    expect(operations.pushBranch).toHaveBeenCalledTimes(1);
    expect(operations.createDraftPullRequest).toHaveBeenCalledTimes(2);
    expect(harness.transitionAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a branch or reuse a non-draft pull request", async () => {
    const branchOperations = createOperations();
    vi.mocked(branchOperations.findRemoteBranch).mockResolvedValue({
      branch,
      sha: "e".repeat(40),
    });
    await expect(
      publisher(attempt("verified"), branchOperations).publisher.publish(
        executionResult.attemptId,
      ),
    ).rejects.toMatchObject({ code: "branch_mismatch" });
    expect(branchOperations.pushBranch).not.toHaveBeenCalled();

    const pullRequestOperations = createOperations();
    vi.mocked(pullRequestOperations.findRemoteBranch).mockResolvedValue({
      branch,
      sha: headSha,
    });
    vi.mocked(pullRequestOperations.findPullRequest).mockResolvedValue({
      ...draftPullRequest,
      draft: false,
    });
    await expect(
      publisher(attempt("verified"), pullRequestOperations).publisher.publish(
        executionResult.attemptId,
      ),
    ).rejects.toBeInstanceOf(WorkerPublicationError);
    expect(pullRequestOperations.createDraftPullRequest).not.toHaveBeenCalled();
  });
});
