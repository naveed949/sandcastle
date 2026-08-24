import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  createWorkerRepositoryManager,
  WorkerRepositoryError,
  type WorkerRepositoryOperations,
} from "./WorkerRepositoryManager.js";

const task: NormalizedTask = {
  repository: "Acme/App",
  kind: "issue",
  number: 6,
  title: "Execute one ticket",
  body: "Body",
  labels: [],
  sourceRevision: "revision-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const configuration = (authorized: boolean): WorkerConfiguration => ({
  repositories: {
    "acme/app": { authorized, baseBranch: "main", profileId: "node" },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
  profiles: { node: { setupCommands: [], verificationCommands: ["npm test"] } },
});

const request = runWorkerDryRun({
  configuration: configuration(true),
  tasks: [task],
}).executionRequests[0]!;

const identityPrefix = request.executionIdentity.slice(0, 12);
const agentRunOptions = {
  agent: {} as never,
  sandbox: { tag: "bind-mount" } as never,
};

const createOperations = () => {
  const close = vi.fn(async () => undefined);
  const run = vi.fn();
  const sandboxClose = vi.fn(async () => ({}));
  const exec = vi.fn(async (command: string) => ({
    exitCode: 0,
    stdout: command,
    stderr: "",
  }));
  const operations: WorkerRepositoryOperations = {
    repositoryExists: vi.fn(async () => false),
    clone: vi.fn(async () => undefined),
    getCanonicalRemote: vi.fn(async () => "https://github.com/acme/app.git"),
    fetchBase: vi.fn(async () => undefined),
    resolveRemoteBase: vi.fn(async () => "a".repeat(40)),
    hasCommit: vi.fn(async () => true),
    createFrozenBaseRef: vi.fn(
      async () => `refs/sandcastle/bases/${request.executionIdentity}`,
    ),
    createWorktree: vi.fn(async (input) => ({
      branch: input.branch,
      worktreePath: "/worker/repositories/acme/app/worktrees/attempt",
      run,
      createSandbox: vi.fn(
        async () => ({ run, exec, close: sandboxClose }) as never,
      ),
      close,
    })),
  };
  return { operations, close, run, exec, sandboxClose };
};

describe("WorkerRepositoryManager", () => {
  it("rejects a no-sandbox provider before repository preparation", () => {
    const { operations } = createOperations();

    expect(() =>
      createWorkerRepositoryManager({
        workspaceRoot: "/worker",
        operations,
        agentRunOptions: {
          agent: {} as never,
          sandbox: { tag: "none" } as never,
        },
      }),
    ).toThrowError(WorkerRepositoryError);
  });

  it("rejects repository credentials in agent-visible environment", () => {
    const { operations } = createOperations();

    expect(() =>
      createWorkerRepositoryManager({
        workspaceRoot: "/worker",
        operations,
        agentRunOptions: {
          agent: { env: { GITHUB_TOKEN: "secret" } } as never,
          sandbox: { tag: "bind-mount" } as never,
        },
      }),
    ).toThrowError(/expose repository credentials: GITHUB_TOKEN/);
  });

  it("rejects repository credentials supplied by the sandbox provider", () => {
    const { operations } = createOperations();

    expect(() =>
      createWorkerRepositoryManager({
        workspaceRoot: "/worker",
        operations,
        agentRunOptions: {
          agent: { env: {} } as never,
          sandbox: {
            tag: "bind-mount",
            env: { GIT_ASKPASS: "/credential-helper" },
          } as never,
        },
      }),
    ).toThrowError(/expose repository credentials: GIT_ASKPASS/);
  });

  it("rejects credentials from the cache environment consumed by the run", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "worker-repository-"));
    const environmentPath = join(
      workspaceRoot,
      "repositories",
      "acme",
      "app",
      "cache",
      ".sandcastle",
      ".env",
    );
    await mkdir(dirname(environmentPath), { recursive: true });
    await writeFile(environmentPath, "GITHUB_TOKEN=secret\n", "utf8");
    const { operations, run } = createOperations();
    const manager = createWorkerRepositoryManager({
      workspaceRoot,
      operations,
      agentRunOptions: {
        agent: { env: {} } as never,
        sandbox: { tag: "bind-mount", env: {} } as never,
      },
    });
    const prepared = await manager.prepare({
      configuration: configuration(true),
      request,
    });

    await expect(
      prepared.runAgent({ prompt: "immutable prompt" }),
    ).rejects.toMatchObject({ code: "repository_operation_failed" });
    expect(run).not.toHaveBeenCalled();
  });

  it("performs no repository operation when the task is unauthorized", async () => {
    const { operations } = createOperations();
    const manager = createWorkerRepositoryManager({
      workspaceRoot: "/worker",
      operations,
      agentRunOptions,
    });

    await expect(
      manager.prepare({ configuration: configuration(false), request }),
    ).rejects.toMatchObject({ code: "unauthorized" });

    for (const operation of Object.values(operations)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("verifies remote and frozen base before creating a repository-qualified worktree", async () => {
    const { operations, run, exec } = createOperations();
    const manager = createWorkerRepositoryManager({
      workspaceRoot: "/worker",
      operations,
      agentRunOptions,
    });

    const prepared = await manager.prepare({
      configuration: configuration(true),
      request,
    });

    expect(operations.clone).toHaveBeenCalledWith({
      canonicalRemote: "https://github.com/acme/app.git",
      repositoryDir: "/worker/repositories/acme/app/cache",
    });
    expect(operations.fetchBase).toHaveBeenCalledWith({
      repositoryDir: "/worker/repositories/acme/app/cache",
      baseBranch: "main",
    });
    expect(operations.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryDir: "/worker/repositories/acme/app/cache",
        baseRef: `refs/sandcastle/bases/${request.executionIdentity}`,
        branch: `sandcastle/worker/acme/app/issue-6/${identityPrefix}`,
      }),
    );
    expect(prepared.namespace).toBe("acme/app");
    expect(prepared.worktreePath).toContain("/repositories/acme/app/");

    await prepared.runAgent({ prompt: "immutable prompt" });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "immutable prompt",
        name: "worker:acme/app:issue:6",
        logging: {
          type: "file",
          path: `/worker/repositories/acme/app/cache/.sandcastle/logs/${request.executionIdentity}.log`,
        },
      }),
    );
    await prepared.runCommand("npm test", "verification");
    expect(exec).toHaveBeenCalledWith("npm test");
    expect(operations.createWorktree).toHaveBeenCalledOnce();
  });

  it("preserves refreshed PRD context through repository authorization", async () => {
    const parentPrd = {
      ...task,
      kind: "prd",
      number: 1,
      title: "PRD: worker",
    } satisfies NormalizedTask;
    const child = {
      ...task,
      parentPrd: { repository: "acme/app", kind: "prd", number: 1 },
      dependencies: [{ repository: "acme/app", kind: "issue", number: 2 }],
    } satisfies NormalizedTask;
    const blocker = {
      ...task,
      number: 2,
      state: "completed",
    } satisfies NormalizedTask;
    const childRequest = runWorkerDryRun({
      configuration: configuration(true),
      tasks: [child, parentPrd, blocker],
    }).executionRequests[0]!;
    const { operations } = createOperations();
    const manager = createWorkerRepositoryManager({
      workspaceRoot: "/worker",
      operations,
      agentRunOptions,
    });

    await expect(
      manager.prepare({
        configuration: configuration(true),
        request: childRequest,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      manager.prepare({
        configuration: configuration(true),
        request: childRequest,
        relatedTasks: [parentPrd, blocker],
      }),
    ).resolves.toMatchObject({ repository: "acme/app" });
  });

  it("fails closed when the canonical remote or current base revision differs", async () => {
    const remoteHarness = createOperations();
    vi.mocked(remoteHarness.operations.getCanonicalRemote).mockResolvedValue(
      "https://github.com/attacker/app.git",
    );
    const remoteManager = createWorkerRepositoryManager({
      workspaceRoot: "/worker",
      operations: remoteHarness.operations,
      agentRunOptions,
    });
    await expect(
      remoteManager.prepare({ configuration: configuration(true), request }),
    ).rejects.toBeInstanceOf(WorkerRepositoryError);
    expect(remoteHarness.operations.fetchBase).not.toHaveBeenCalled();

    const baseHarness = createOperations();
    vi.mocked(baseHarness.operations.resolveRemoteBase).mockResolvedValue(
      "e".repeat(40),
    );
    const baseManager = createWorkerRepositoryManager({
      workspaceRoot: "/worker",
      operations: baseHarness.operations,
      agentRunOptions,
    });
    await expect(
      baseManager.prepare({ configuration: configuration(true), request }),
    ).rejects.toMatchObject({ code: "base_mismatch" });
    expect(baseHarness.operations.createWorktree).not.toHaveBeenCalled();
  });
});
