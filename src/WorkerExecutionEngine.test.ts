import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { createWorkerExecutionEngine } from "./WorkerExecutionEngine.js";
import {
  createWorkerRepositoryManager,
  type WorkerRepositoryOperations,
} from "./WorkerRepositoryManager.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const task: NormalizedTask = {
  repository: "Acme/App",
  kind: "issue",
  number: 6,
  title: "Execute one ticket",
  body: "Implement the retained local execution path.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue-revision-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
      baseBranch: "main",
      profileId: "node",
    },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
  },
};

const request = runWorkerDryRun({ configuration, tasks: [task] })
  .executionRequests[0]!;

const createHarness = async (options?: {
  setupExitCode?: number;
  verificationExitCode?: number;
  agentError?: Error;
  preservedWorktreePath?: string;
}) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-worker-engine-"));
  const store = createWorkerStateStore({
    filePath: join(root, "state", "worker.json"),
    now: () => "2026-08-23T12:00:00.000Z",
  });
  const attempt = await store.claimAttempt(request, {
    owner: "worker-1",
    leaseDurationMs: 60_000,
    claimedAt: "2026-08-23T12:00:00.000Z",
  });
  const commands: string[] = [];
  const close = vi.fn(async () => ({
    preservedWorktreePath: options?.preservedWorktreePath,
  }));
  const runAgent = vi.fn(async ({ prompt }: { readonly prompt: string }) => {
    if (options?.agentError !== undefined) throw options.agentError;
    return {
      commits: [{ sha: "d".repeat(40) }],
      branch: `sandcastle/worker/acme/app/issue-6/${request.executionIdentity.slice(0, 12)}`,
      stdout: "I completed the task successfully.",
      iterations: [],
      prompt,
    };
  });
  const operations: WorkerRepositoryOperations = {
    repositoryExists: vi.fn(async () => false),
    clone: vi.fn(async () => undefined),
    getCanonicalRemote: vi.fn(async () => "https://github.com/acme/app.git"),
    fetchBase: vi.fn(async () => undefined),
    resolveRemoteBase: vi.fn(async () => request.task.baseCommit),
    hasCommit: vi.fn(async () => true),
    createFrozenBaseRef: vi.fn(
      async () => `refs/sandcastle/bases/${request.executionIdentity}`,
    ),
    createWorktree: vi.fn(async ({ branch }) => ({
      branch,
      worktreePath: join(root, "repositories", "acme", "app", "worktree"),
      run: runAgent as never,
      close,
    })),
    runCommand: async ({ command, phase }) => {
      commands.push(command);
      const exitCode =
        phase === "verification"
          ? (options?.verificationExitCode ?? 0)
          : (options?.setupExitCode ?? 0);
      return { command, phase, exitCode, stdout: "ok", stderr: "" };
    },
  };
  const manager = createWorkerRepositoryManager({
    workspaceRoot: root,
    operations,
    agentRunOptions: {
      agent: {} as never,
      sandbox: { tag: "bind-mount" } as never,
    },
  });
  const engine = createWorkerExecutionEngine({
    configuration,
    repositoryManager: manager,
    store,
    recordsRoot: join(root, "records"),
  });
  return {
    root,
    store,
    attempt,
    manager,
    engine,
    commands,
    close,
    runAgent,
  };
};

describe("WorkerExecutionEngine", () => {
  it("runs setup, Sandcastle, and verification and retains a verified local result", async () => {
    const harness = await createHarness();

    const result = await harness.engine.execute(harness.attempt);

    expect(result.status).toBe("verified");
    expect(result.failurePhase).toBeUndefined();
    expect(result.commits).toEqual([{ sha: "d".repeat(40) }]);
    expect(result.published).toBe(false);
    expect(harness.commands).toEqual(["npm ci", "npm test"]);
    expect(harness.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('"repository": "acme/app"'),
      }),
    );
    expect(harness.runAgent.mock.calls[0]?.[0]).not.toHaveProperty("env");
    expect(harness.close).toHaveBeenCalledOnce();

    const state = await harness.store.read();
    expect(state.attempts[0]?.status).toBe("verified");
    expect(state.attempts[0]?.outcomes[0]?.evidence).toContain(
      result.recordPath,
    );
    const retained = JSON.parse(await readFile(result.recordPath, "utf8"));
    expect(retained).toMatchObject({
      taskId: request.taskId,
      executionIdentity: request.executionIdentity,
      profileDigest: request.profileDigest,
      promptTemplateDigest: request.promptTemplateDigest,
      status: "verified",
      published: false,
    });
  });

  it("treats failed verification as failure regardless of agent narration", async () => {
    const harness = await createHarness({ verificationExitCode: 1 });

    const result = await harness.engine.execute(harness.attempt);

    expect(result.status).toBe("failed");
    expect(result.failurePhase).toBe("verification");
    expect(result.agent?.stdout).toContain("successfully");
    expect(result.published).toBe(false);
    expect((await harness.store.read()).attempts[0]?.status).toBe("failed");
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("distinguishes setup failures and does not invoke the agent", async () => {
    const harness = await createHarness({ setupExitCode: 1 });

    const result = await harness.engine.execute(harness.attempt);

    expect(result.status).toBe("failed");
    expect(result.failurePhase).toBe("setup");
    expect(harness.runAgent).not.toHaveBeenCalled();
    expect(harness.commands).toEqual(["npm ci"]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("distinguishes agent execution failures and skips verification", async () => {
    const harness = await createHarness({
      agentError: new Error("agent stopped"),
    });

    const result = await harness.engine.execute(harness.attempt);

    expect(result.status).toBe("failed");
    expect(result.failurePhase).toBe("execution");
    expect(harness.commands).toEqual(["npm ci"]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("retains a preserved dirty worktree as cleanup failure evidence", async () => {
    const harness = await createHarness({
      preservedWorktreePath: "/worker/repositories/acme/app/dirty-worktree",
    });

    const result = await harness.engine.execute(harness.attempt);

    expect(result.status).toBe("failed");
    expect(result.failurePhase).toBe("cleanup");
    expect(result.cleanup?.preservedWorktreePath).toContain("acme/app");
    expect((await harness.store.read()).attempts[0]?.status).toBe("failed");
  });
});
