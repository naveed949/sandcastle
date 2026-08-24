import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepositoryWorkflowPlanner,
  planOneEligibleTask,
} from "./RepositoryWorkflowPlanner.js";
import type { RepositoryWorkflowPlanRecord } from "./RepositoryWorkflowPlanner.js";
import {
  createRepositoryWorkflowImplementer,
  RepositoryWorkflowImplementerContextError,
} from "./RepositoryWorkflowImplementer.js";
import { createWorkerExecutionEngine } from "./WorkerExecutionEngine.js";
import {
  createWorkerRepositoryManager,
  type WorkerRepositoryOperations,
} from "./WorkerRepositoryManager.js";
import type { ExecutionAttempt } from "./WorkerStateStore.js";
import type {
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const directories: string[] = [];

interface PlannedTask {
  readonly plan: RepositoryWorkflowPlanRecord;
  readonly attempt: ExecutionAttempt;
}

const taskFor = (repository: string): NormalizedTask => ({
  repository,
  kind: "issue",
  number: 23,
  title: "Implement one planned task",
  body: "Execute the accepted plan.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue:23:rev-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
});

const configurationWith = (
  repositories: readonly string[],
): WorkerConfiguration => ({
  repositories: Object.fromEntries(
    repositories.map((repository) => [
      repository,
      { authorized: true, baseBranch: "main", profileId: "node-v1" },
    ]),
  ),
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: {
    "worker-v1":
      "Implement:\n{{TASK_SNAPSHOT}}\nAccepted plan:\n{{ACCEPTED_PLAN}}",
  },
  profiles: {
    "node-v1": {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
  },
});

interface HarnessOptions {
  readonly repositories?: readonly string[];
  readonly verificationExitCode?: number;
  readonly setupExitCode?: number;
  readonly preservedWorktreePath?: string;
  readonly agentError?: Error;
  readonly waitForAbort?: boolean;
  readonly commits?: readonly { readonly sha: string }[];
  readonly remoteBaseCommit?: string;
  readonly commandStdout?: string;
}

const createHarness = async (options: HarnessOptions = {}) => {
  const repositories = options.repositories ?? ["acme/one"];
  const root = await mkdtemp(join(tmpdir(), "repository-implementer-"));
  directories.push(root);
  const store = createWorkerStateStore({
    filePath: join(root, "state", "worker.json"),
  });
  const configuration = configurationWith(repositories);
  const tasks = repositories.map(taskFor);
  const source = {
    discover: async () => tasks,
    read: async (input: { readonly task: unknown }) => ({
      task: input.task as NormalizedTask,
      relatedTasks: [],
    }),
  };
  let nextId = 0;
  const planner = createRepositoryWorkflowPlanner({
    invoke: async () => ({
      stdout: `<plan>${JSON.stringify({
        version: 1,
        taskIntent: "Execute the planned work.",
        proposedWork: ["Implement the change."],
        verificationStrategy: ["Run npm test."],
        risks: [],
        evidence: [],
      })}</plan>`,
    }),
    planStore: {
      async save() {},
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    },
    createId: () => `plan-${++nextId}`,
  });

  const planned: Record<string, PlannedTask> = {};
  for (const repository of repositories) {
    const outcome = await planOneEligibleTask({
      repository,
      repositoryWorkflow: {
        workflowIdentity: `${repository}:workflow-v1`,
        cycle: 1,
        revision: 1,
      },
      configuration,
      source,
      store,
      planner,
      owner: "implementer",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate:
        "<plan>\nRepository {{REPOSITORY}}\nSnapshot {{TASK_SNAPSHOT}}",
    });
    if (
      outcome.status !== "planned" ||
      outcome.record === undefined ||
      outcome.attempt === undefined
    ) {
      throw new Error(`Planning failed for ${repository}.`);
    }
    planned[repository] = { plan: outcome.record, attempt: outcome.attempt };
  }

  const runAgent = vi.fn(
    async ({
      prompt,
      signal,
    }: {
      readonly prompt: string;
      readonly signal?: AbortSignal;
    }) => {
      if (options.agentError !== undefined) throw options.agentError;
      if (options.waitForAbort) {
        if (signal === undefined) throw new Error("missing abort signal");
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return {
        commits: options.commits ?? [{ sha: "d".repeat(40) }],
        branch: "sandcastle/worker/branch",
        stdout: "Implemented successfully.",
        iterations: [],
        prompt,
      };
    },
  );
  const commands: string[] = [];
  const close = vi.fn(async () => ({
    preservedWorktreePath: options.preservedWorktreePath,
  }));
  const operations: WorkerRepositoryOperations = {
    repositoryExists: async () => false,
    clone: async () => undefined,
    getCanonicalRemote: async (repositoryDir: string) =>
      repositoryDir.includes("acme/two")
        ? "https://github.com/acme/two.git"
        : "https://github.com/acme/one.git",
    fetchBase: async () => undefined,
    resolveRemoteBase: async () => options.remoteBaseCommit ?? "a".repeat(40),
    hasCommit: async () => true,
    createFrozenBaseRef: async ({ executionIdentity }) =>
      `refs/sandcastle/bases/${executionIdentity}`,
    createWorktree: async ({ branch, repositoryDir }) => ({
      branch,
      worktreePath: join(repositoryDir, "..", "worktree"),
      repositoryCredentialNames: [],
      run: runAgent as never,
      createSandbox: vi.fn(
        async () =>
          ({
            run: runAgent,
            close: vi.fn(async () => ({})),
            exec: async (command: string) => {
              commands.push(command);
              const phase = command === "npm test" ? "verification" : "setup";
              return {
                exitCode:
                  phase === "verification"
                    ? (options.verificationExitCode ?? 0)
                    : (options.setupExitCode ?? 0),
                stdout: options.commandStdout ?? "ok",
                stderr: "",
              };
            },
          }) as never,
      ),
      close,
    }),
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
  const implementer = createRepositoryWorkflowImplementer({
    engine,
    store,
    timeoutMs: options.waitForAbort ? 5_000 : 30_000,
  });

  return {
    root,
    store,
    engine,
    implementer,
    commands,
    close,
    runAgent,
    operations,
    first: planned[repositories[0]!]!,
    planned,
    configuration,
    source,
  };
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createRepositoryWorkflowImplementer", () => {
  it("executes an accepted plan with repository-scoped isolation and retains verification evidence", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;

    const result = await harness.implementer.implement({
      plan: record,
      attempt,
    });

    expect(result.status).toBe("verified");
    expect(result.recovery).toBe("terminal");
    expect(result.attemptStatus).toBe("verified");
    expect(result.reasonCode).toBeUndefined();
    expect(result.result?.branch).toContain("acme/one");
    expect(result.result?.branch).toContain("issue-23");
    expect(result.verification).toHaveLength(1);
    const verificationEvidence = result.verification[0]!;
    expect(verificationEvidence.command).toBe("npm test");
    expect(verificationEvidence.exitCode).toBe(0);
    expect(verificationEvidence.durationMs).toBeGreaterThanOrEqual(0);
    expect(verificationEvidence.truncated).toBeFalsy();
    const invocation = harness.runAgent.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(invocation.prompt).toContain(
      '"taskIntent": "Execute the planned work."',
    );
    expect(invocation.prompt).toContain('"repository": "acme/one"');
    const retained = JSON.parse(
      await readFile(result.result!.recordPath, "utf8"),
    );
    expect(retained).toMatchObject({ status: "verified" });
    expect((await harness.store.read()).attempts[0]?.status).toBe("verified");
  }, 20_000);

  it("bounds retained command output and reports truncation", async () => {
    const harness = await createHarness({
      commandStdout: "x".repeat(12_000),
    });

    const result = await harness.implementer.implement(harness.first);

    expect(result.status).toBe("verified");
    const evidence = result.verification[0]!;
    expect(evidence.truncated).toBe(true);
    expect(evidence.stdout.length).toBeLessThan(12_000);
    expect(evidence.stdout).toContain("[truncated]");
  }, 20_000);

  it("fails without advancing when required verification fails", async () => {
    const harness = await createHarness({ verificationExitCode: 1 });

    const result = await harness.implementer.implement(harness.first);

    expect(result.status).toBe("failed");
    expect(result.recovery).toBe("retryable");
    expect(result.failurePhase).toBe("verification");
    expect(result.attemptStatus).toBe("failed");
    expect((await harness.store.read()).attempts[0]?.status).toBe("failed");
  }, 20_000);

  it("propagates operator cancellation to subprocesses and classifies a resumable result", async () => {
    const harness = await createHarness({ waitForAbort: true });
    const controller = new AbortController();
    const pending = harness.implementer.implement({
      ...harness.first,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.runAgent).toHaveBeenCalledOnce());
    controller.abort(new Error("operator stopped"));

    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.recovery).toBe("resumable");
    expect(result.reasonCode).toBe("stage_cancelled");
    const invocationSignal = harness.runAgent.mock.calls[0]?.[0]
      ?.signal as AbortSignal;
    expect(invocationSignal?.aborted).toBe(true);
    expect((await harness.store.read()).attempts[0]?.status).toBe(
      "interrupted",
    );
  }, 20_000);

  it("classifies a stage timeout as resumable and aborts subprocesses", async () => {
    const harness = await createHarness({ waitForAbort: true });
    const timeoutImplementer = createRepositoryWorkflowImplementer({
      engine: harness.engine,
      store: harness.store,
      timeoutMs: 20,
    });

    const result = await timeoutImplementer.implement(harness.first);

    expect(result.status).toBe("timed_out");
    expect(result.recovery).toBe("resumable");
    expect(result.reasonCode).toBe("stage_timeout");
    const invocationSignal = harness.runAgent.mock.calls[0]?.[0]
      ?.signal as AbortSignal;
    expect(invocationSignal?.aborted).toBe(true);
    expect((await harness.store.read()).attempts[0]?.status).toBe(
      "interrupted",
    );
  }, 20_000);

  it("fails closed on stale task revisions without executing", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;
    const driftedPlan = {
      ...record,
      input: { ...record.input, taskSourceRevision: "issue:23:rev-0" },
    };

    const result = await harness.implementer.implement({
      plan: driftedPlan,
      attempt,
    });

    expect(result.status).toBe("failed");
    expect(result.recovery).toBe("retryable");
    expect(result.reasonCode).toBe("stale_task_revision");
    expect(harness.runAgent).not.toHaveBeenCalled();
    expect((await harness.store.read()).attempts[0]?.status).toBe("active");
  }, 20_000);

  it("fails closed on captured-base drift and remote base movement", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;
    const driftedPlan = {
      ...record,
      input: { ...record.input, baseRevision: "b".repeat(40) },
    };

    const capturedDrift = await harness.implementer.implement({
      plan: driftedPlan,
      attempt,
    });
    expect(capturedDrift.status).toBe("failed");
    expect(capturedDrift.recovery).toBe("retryable");
    expect(capturedDrift.reasonCode).toBe("base_drift");

    const movedBaseHarness = await createHarness({
      remoteBaseCommit: "c".repeat(40),
    });
    const remoteDrift = await movedBaseHarness.implementer.implement(
      movedBaseHarness.first,
    );
    expect(remoteDrift.status).toBe("failed");
    expect(remoteDrift.recovery).toBe("retryable");
    expect(remoteDrift.failurePhase).toBe("preparation");
    expect(movedBaseHarness.runAgent).not.toHaveBeenCalled();
  }, 30_000);

  it("retains preserved dirty worktrees as cleanup failures", async () => {
    const harness = await createHarness({
      preservedWorktreePath: "/worker/repositories/acme/one/preserved",
    });

    const result = await harness.implementer.implement(harness.first);

    expect(result.status).toBe("failed");
    expect(result.failurePhase).toBe("cleanup");
    expect(result.recovery).toBe("retryable");
  }, 20_000);

  it("isolates overlapping issue numbers by repository identity", async () => {
    const harness = await createHarness({
      repositories: ["acme/one", "acme/two"],
    });

    const results = await Promise.all([
      harness.implementer.implement(harness.planned["acme/one"]!),
      harness.implementer.implement(harness.planned["acme/two"]!),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "verified",
      "verified",
    ]);
    const branches = results.map((result) => result.result!.branch!);
    expect(new Set(branches).size).toBe(2);
    expect(branches[0]).toContain("acme/one");
    expect(branches[1]).toContain("acme/two");
    const worktrees = results.map((result) => result.result!.worktreePath!);
    expect(new Set(worktrees).size).toBe(2);
    const attempts = (await harness.store.read()).attempts;
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "verified",
      "verified",
    ]);
  }, 20_000);

  it("never re-executes an attempt whose side effects may already exist", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;
    await harness.store.markAttemptStarted(attempt.attemptId);

    const result = await harness.implementer.implement({
      plan: record,
      attempt,
    });

    expect(result.status).toBe("interrupted");
    expect(result.recovery).toBe("resumable");
    expect(result.reasonCode).toBe("attempt_already_started");
    expect(harness.runAgent).not.toHaveBeenCalled();
    expect(harness.commands).toEqual([]);
  }, 20_000);

  it("fails fast before side effects when the prompt template omits the accepted plan", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;
    const unboundAttempt = {
      ...attempt,
      request: {
        ...attempt.request,
        promptTemplate: "Implement:\n{{TASK_SNAPSHOT}}",
      },
    };

    await expect(
      harness.implementer.implement({ plan: record, attempt: unboundAttempt }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowImplementerContextError(
        "missing_context",
        "Implementer prompt template must reference the {{ACCEPTED_PLAN}} marker.",
      ),
    );
    expect(harness.runAgent).not.toHaveBeenCalled();
    expect(harness.commands).toEqual([]);
  }, 20_000);

  it("rejects plans that are not accepted or do not bind the claimed attempt", async () => {
    const harness = await createHarness();
    const { attempt, plan: record } = harness.first;

    const failedRecord = {
      ...record,
      status: "failed" as const,
      plan: undefined,
    };
    await expect(
      harness.implementer.implement({ plan: failedRecord, attempt }),
    ).rejects.toBeInstanceOf(RepositoryWorkflowImplementerContextError);

    const foreignAttempt = {
      ...attempt,
      attemptId: "foreign-attempt",
    };
    await expect(
      harness.implementer.implement({ plan: record, attempt: foreignAttempt }),
    ).rejects.toMatchObject({
      name: "RepositoryWorkflowImplementerContextError",
      code: "invalid_context",
      message: expect.stringContaining("does not bind execution"),
    });
    expect(harness.runAgent).not.toHaveBeenCalled();
  }, 20_000);
});
