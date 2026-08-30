import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "./CanonicalJson.js";
import {
  createRepositoryWorkflowControl,
  createRepositoryWorkflowStore,
  RepositoryWorkflowStoreError,
} from "./RepositoryWorkflowControl.js";
import {
  createRepositoryWorkflowPlanStore,
  createRepositoryWorkflowPlanner,
  expandRepositoryWorkflowPlannerPrompt,
  planOneEligibleTask,
  RepositoryWorkflowPlannerContextError,
  type RepositoryWorkflowPlanningInput,
} from "./RepositoryWorkflowPlanner.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";
import { projectRepositoryWorkflowPlan } from "./RepositoryWorkflowPlanProjection.js";

const directories: string[] = [];

const task = {
  repository: "acme/one",
  kind: "issue" as const,
  number: 23,
  title: "Plan one task",
  body: "Create a retained plan.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue:23:rev-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open" as const,
  dependencies: [],
  children: [],
};

const input = (): RepositoryWorkflowPlanningInput => ({
  repository: "acme/one",
  repositoryWorkflow: {
    workflowIdentity: "acme/one:workflow-v1",
    runId: "run-1",
    cycle: 1,
    revision: 7,
    queuePosition: 1,
    mergePolicyDigest: "merge-policy-v1",
  },
  taskSnapshot: task,
  attempt: {
    attemptId: "attempt-1",
    executionIdentity: "execution-1",
    request: {
      task,
      context: {},
      taskId: "acme/one:issue:23",
      executionIdentity: "execution-1",
      profileId: "node-v1",
      profileDigest: canonicalJsonDigest({
        setupCommands: [],
        verificationCommands: ["npm test"],
      }),
      promptVersion: "worker-v1",
      promptTemplateDigest: "prompt-v1",
      promptTemplate: "{{TASK_SNAPSHOT}}",
      profile: {
        setupCommands: [],
        verificationCommands: ["npm test"],
      },
    },
    status: "active",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    outcomes: [],
    claim: {
      taskId: "acme/one:issue:23",
      sourceRevision: task.sourceRevision,
      owner: "planner",
      acquiredAt: "2026-08-24T00:00:00.000Z",
      leaseExpiresAt: "2026-08-24T01:00:00.000Z",
      phase: "claimed",
      refreshedSnapshots: [task],
    },
  },
  eligibility: {
    task,
    taskId: "acme/one:issue:23",
    eligible: true,
    reasonCode: "eligible",
    reason: "Task is authorized and ready.",
    authorization: "repository",
    executionIdentity: "execution-1",
  },
  dependencyEvidence: [],
  promptVersion: "planner-v1",
  promptTemplate: [
    "<plan>",
    "Repository: {{REPOSITORY}}",
    "Task: {{TASK_SNAPSHOT}}",
    "Profile: {{REPOSITORY_PROFILE}}",
    "Base: {{BASE_REVISION}}",
    "Dependencies: {{DEPENDENCY_EVIDENCE}}",
  ].join("\n"),
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createRepositoryWorkflowPlanner", () => {
  it("accepts one eligible task, retains its structured plan and provenance, and expands all authority context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repository-planner-"));
    directories.push(directory);
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(directory, "workflows.json"),
    });
    const planStore = createRepositoryWorkflowPlanStore({
      store: workflowStore,
    });
    const invoke = vi.fn(async ({ prompt }: { readonly prompt: string }) => {
      expect(prompt).toContain('"repository": "acme/one"');
      expect(prompt).toContain('"title": "Plan one task"');
      expect(prompt).toContain(
        '"verificationCommands": [\n    "npm test"\n  ]',
      );
      return {
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: "Make the task plan durable.",
          proposedWork: ["Add the planner stage."],
          verificationStrategy: ["Run the configured test command."],
          risks: ["The task may need review."],
          evidence: [
            {
              kind: "task",
              reference: "acme/one:issue:23",
              summary: "The claimed task snapshot.",
            },
          ],
        })}</plan>`,
        logReference: "record://planner/1",
        sessionId: "session-1",
      };
    });
    const planner = createRepositoryWorkflowPlanner({
      invoke,
      planStore,
      now: () => "2026-08-24T00:00:01.000Z",
    });

    const record = await planner.plan(input());

    expect(record.status).toBe("accepted");
    expect(record.plan).toMatchObject({
      version: 1,
      taskIntent: "Make the task plan durable.",
    });
    expect(record.input).toMatchObject({
      repository: "acme/one",
      workflowIdentity: "acme/one:workflow-v1",
      taskId: "acme/one:issue:23",
      attemptId: "attempt-1",
      taskSourceRevision: task.sourceRevision,
      baseRevision: task.baseCommit,
      profileId: "node-v1",
      authorization: "repository",
      eligibilityReasonCode: "eligible",
      mergePolicyDigest: "merge-policy-v1",
    });
    expect((await planStore.list()).map((item) => item.id)).toEqual([
      record.id,
    ]);
    const control = createRepositoryWorkflowControl({
      store: workflowStore,
      runtime: { runCycle: vi.fn() },
      workflows: {
        "workflow-v1": {
          id: "workflow-v1",
          maxCycles: 1,
          maxParallel: 1,
          planner: { model: "planner", prompt: "plan" },
          implementer: { model: "implementer", prompt: "implement" },
          reviewer: { model: "reviewer", prompt: "review" },
          integrator: { model: "integrator", prompt: "integrate" },
        },
      },
    });
    const projection = await control.getProjection!();
    expect(projection.plans).toMatchObject([
      {
        taskId: "acme/one:issue:23",
        status: "accepted",
        plan: { taskIntent: "Make the task plan durable." },
      },
    ]);
    expect(JSON.stringify(projection.plans)).not.toContain(task.body);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves placeholder-looking text inside the immutable task snapshot", () => {
    const base = input();
    const markedTask = {
      ...task,
      body: "Keep the {{DEPENDENCY_EVIDENCE}} marker as task content.",
    };
    const expanded = expandRepositoryWorkflowPlannerPrompt({
      ...base,
      taskSnapshot: markedTask,
      attempt: {
        ...base.attempt,
        request: { ...base.attempt.request, task: markedTask },
        claim: { ...base.attempt.claim!, refreshedSnapshots: [markedTask] },
      },
      eligibility: { ...base.eligibility, task: markedTask },
    });

    expect(expanded).toContain(
      '"body": "Keep the {{DEPENDENCY_EVIDENCE}} marker as task content."',
    );
  });

  it("rejects reuse of a plan ID with different immutable input", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-plan-conflict-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({
      stdout: `<plan>${JSON.stringify({
        version: 1,
        taskIntent: "Retain the original plan.",
        proposedWork: ["Keep immutable plan identity."],
        verificationStrategy: ["Inspect the retained record."],
        risks: [],
        evidence: [],
      })}</plan>`,
    }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });

    await planner.plan({ ...input(), planId: "plan-1" });

    await expect(
      planner.plan({
        ...input(),
        planId: "plan-1",
        promptVersion: "planner-v2",
      }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowStoreError(
        "Planner record plan-1 conflicts with persisted evidence.",
        "conflict",
      ),
    );
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("records cancellation as resumable and never advances beyond the claimed task", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-cancel-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const controller = new AbortController();
    let receivedSignal!: AbortSignal;
    const invoke = vi.fn(
      async ({ signal }: { readonly signal: AbortSignal }) => {
        receivedSignal = signal;
        return await new Promise<never>(() => undefined);
      },
    );
    const planner = createRepositoryWorkflowPlanner({
      invoke,
      planStore,
      timeoutMs: 10_000,
    });

    const pending = planner.plan({ ...input(), signal: controller.signal });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    controller.abort(new Error("operator stopped planning"));

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      recovery: "resumable",
      error: { code: "planner_cancelled" },
    });
    expect(receivedSignal.aborted).toBe(true);
    expect((await planStore.list()).length).toBe(1);
  });

  it("classifies a planner timeout as resumable", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-timeout-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    let receivedSignal!: AbortSignal;
    const planner = createRepositoryWorkflowPlanner({
      invoke: async ({ signal }) => {
        receivedSignal = signal;
        return await new Promise<never>(() => undefined);
      },
      planStore,
      timeoutMs: 5,
    });

    await expect(planner.plan(input())).resolves.toMatchObject({
      status: "timed_out",
      recovery: "resumable",
      error: { code: "planner_timeout" },
    });
    expect(receivedSignal.aborted).toBe(true);
  });

  it("preserves timeout classification when the invoker rejects on abort", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-timeout-abort-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const planner = createRepositoryWorkflowPlanner({
      invoke: ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("agent observed abort")),
            { once: true },
          );
        }),
      planStore,
      timeoutMs: 5,
    });

    await expect(planner.plan(input())).resolves.toMatchObject({
      status: "timed_out",
      recovery: "resumable",
      error: { code: "planner_timeout" },
    });
  });

  it("fails the stage explicitly when the structured plan is malformed", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-invalid-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const planner = createRepositoryWorkflowPlanner({
      invoke: async () => ({ stdout: '<plan>{"version":1}</plan>' }),
      planStore,
    });

    const record = await planner.plan(input());

    expect(record).toMatchObject({
      status: "failed",
      recovery: "resumable",
      error: { code: "invalid_structured_output" },
    });
    expect(record.plan).toBeUndefined();
  });

  it("projects failed and timed-out planner records without plans", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-failed-projection-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const malformedPlanner = createRepositoryWorkflowPlanner({
      invoke: async () => ({ stdout: '<plan>{"version":1}</plan>' }),
      planStore,
      createId: () => "plan-failed",
    });
    const timeoutPlanner = createRepositoryWorkflowPlanner({
      invoke: async () => await new Promise<never>(() => undefined),
      planStore,
      timeoutMs: 5,
      createId: () => "plan-timed-out",
    });

    const failed = await malformedPlanner.plan(input());
    const timedOut = await timeoutPlanner.plan(input());

    expect(projectRepositoryWorkflowPlan(failed)).toMatchObject({
      id: "plan-failed",
      status: "failed",
      recovery: "resumable",
      errorCode: "invalid_structured_output",
      taskId: "acme/one:issue:23",
      repository: "acme/one",
    });
    expect(projectRepositoryWorkflowPlan(failed).plan).toBeUndefined();
    expect(projectRepositoryWorkflowPlan(timedOut)).toMatchObject({
      id: "plan-timed-out",
      status: "timed_out",
      recovery: "resumable",
      errorCode: "planner_timeout",
    });
    expect(projectRepositoryWorkflowPlan(timedOut).plan).toBeUndefined();
  });

  it("fails prompt expansion before invocation when required task context is missing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-context-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const incomplete = {
      ...input(),
      taskSnapshot: undefined,
    } as unknown as RepositoryWorkflowPlanningInput;

    await expect(planner.plan(incomplete)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "missing_context",
        "Planner requires an immutable task snapshot.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("requires claim-time task snapshot evidence before invoking the planner", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-claim-context-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const base = input();
    const incomplete = {
      ...base,
      attempt: {
        ...base.attempt,
        claim: { ...base.attempt.claim!, refreshedSnapshots: undefined },
      },
    };

    await expect(planner.plan(incomplete)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "missing_context",
        "Planner requires claim-time task snapshot evidence.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("rejects unrelated claim-time snapshots before invoking the planner", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-unrelated-claim-context-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const unrelated = {
      ...task,
      number: 99,
      title: "An unrelated task",
      sourceRevision: "issue:99:rev-1",
    };

    await expect(
      planner.plan({
        ...input(),
        attempt: {
          ...input().attempt,
          claim: {
            ...input().attempt.claim!,
            refreshedSnapshots: [task, unrelated],
          },
        },
      }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner claim-time snapshots contain an unrelated task.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("fails prompt expansion before invocation when the repository profile is missing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-profile-context-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const incomplete = {
      ...input(),
      attempt: {
        ...input().attempt,
        request: { ...input().attempt.request, profile: undefined },
      },
    } as unknown as RepositoryWorkflowPlanningInput;

    await expect(planner.plan(incomplete)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "missing_context",
        "Planner requires the repository execution profile.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("rejects a repository profile that does not match its claimed digest", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-profile-provenance-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const base = input();
    const forgedProfileInput = {
      ...base,
      attempt: {
        ...base.attempt,
        request: {
          ...base.attempt.request,
          profile: {
            setupCommands: ["make setup"],
            verificationCommands: ["npm test"],
          },
        },
      },
    };

    await expect(planner.plan(forgedProfileInput)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner repository profile does not match the claimed profile digest.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("rejects dependency evidence that conflicts with the claim-time snapshot", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-dependency-evidence-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const dependency = {
      ...task,
      number: 7,
      title: "Completed dependency",
      sourceRevision: "issue:7:rev-1",
      state: "closed" as const,
      dependencies: [],
      children: [],
    };
    const dependentTask = {
      ...task,
      dependencies: [
        { repository: "acme/one", kind: "issue" as const, number: 7 },
      ],
    };
    const base = input();
    const dependentInput: RepositoryWorkflowPlanningInput = {
      ...base,
      taskSnapshot: dependentTask,
      attempt: {
        ...base.attempt,
        request: { ...base.attempt.request, task: dependentTask },
        claim: {
          ...base.attempt.claim!,
          refreshedSnapshots: [dependentTask, dependency],
        },
      },
      eligibility: { ...base.eligibility, task: dependentTask },
      dependencyEvidence: [
        {
          taskId: "acme/one:issue:7",
          repository: "acme/one",
          kind: "issue",
          number: 7,
          sourceRevision: "forged-revision",
          state: "open",
          satisfied: true,
        },
      ],
    };

    await expect(planner.plan(dependentInput)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Dependency evidence for acme/one:issue:7 does not match the claim-time snapshot.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("rejects eligibility provenance that does not match the claimed snapshot", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-eligibility-provenance-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({
      stdout: '<plan>{"version":1}</plan>',
    }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const mismatchedEligibility = {
      ...input().eligibility,
      task: { ...task, title: "A different snapshot" },
    };

    await expect(
      planner.plan({
        ...input(),
        eligibility: mismatchedEligibility,
      }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Eligibility does not describe the claimed task snapshot.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("keeps equal issue numbers isolated by repository", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-repositories-"),
    );
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    let nextId = 0;
    const planner = createRepositoryWorkflowPlanner({
      invoke: async ({ prompt }) => ({
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: `Plan ${prompt.includes("acme/two") ? "two" : "one"}.`,
          proposedWork: ["Keep repository identity in every record."],
          verificationStrategy: ["Inspect the scoped plan projection."],
          risks: [],
          evidence: [],
        })}</plan>`,
      }),
      planStore,
      createId: () => `plan-${++nextId}`,
    });
    const first = input();
    const secondTask = { ...task, repository: "acme/two" };
    const second = {
      ...first,
      repository: "acme/two",
      repositoryWorkflow: {
        ...first.repositoryWorkflow,
        workflowIdentity: "acme/two:workflow-v1",
      },
      taskSnapshot: secondTask,
      attempt: {
        ...first.attempt,
        attemptId: "attempt-2",
        executionIdentity: "execution-2",
        request: {
          ...first.attempt.request,
          task: secondTask,
          taskId: "acme/two:issue:23",
          executionIdentity: "execution-2",
        },
        claim: {
          ...first.attempt.claim!,
          taskId: "acme/two:issue:23",
          refreshedSnapshots: [secondTask],
        },
      },
      eligibility: {
        ...first.eligibility,
        task: secondTask,
        taskId: "acme/two:issue:23",
        executionIdentity: "execution-2",
      },
    } satisfies RepositoryWorkflowPlanningInput;

    const records = await Promise.all([
      planner.plan(first),
      planner.plan(second),
    ]);

    expect(records.map((record) => record.repository).sort()).toEqual([
      "acme/one",
      "acme/two",
    ]);
    expect(records.map((record) => record.taskId).sort()).toEqual([
      "acme/one:issue:23",
      "acme/two:issue:23",
    ]);
    expect((await planStore.list()).map((record) => record.id)).toEqual([
      "plan-1",
      "plan-2",
    ]);
  });

  it("fails prompt expansion before invocation when the prompt template omits the structured output tag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repository-planner-tag-"));
    directories.push(directory);
    const planStore = createRepositoryWorkflowPlanStore({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
    });
    const invoke = vi.fn(async () => ({ stdout: "" }));
    const planner = createRepositoryWorkflowPlanner({ invoke, planStore });
    const base = input();
    const untagged = {
      ...base,
      promptTemplate: base.promptTemplate.replace("<plan>\n", ""),
    };

    await expect(planner.plan(untagged)).rejects.toMatchObject(
      new RepositoryWorkflowPlannerContextError(
        "invalid_context",
        "Planner prompt template must instruct the <plan> structured output tag.",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(await planStore.list()).toEqual([]);
  });

  it("plans two different repositories end to end without cross-repository evidence", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-e2e-two-repos-"),
    );
    directories.push(directory);
    const workerStore = createWorkerStateStore({
      filePath: join(directory, "worker.json"),
    });
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(directory, "workflows.json"),
    });
    const planStore = createRepositoryWorkflowPlanStore({
      store: workflowStore,
    });
    const oneTask = { ...task, number: 41, sourceRevision: "issue:41:rev-1" };
    const twoTask = {
      ...task,
      repository: "acme/two",
      number: 23,
      title: "Same number, other repo",
    };
    const configuration = {
      repositories: {
        "acme/one": {
          authorized: true,
          baseBranch: "main",
          profileId: "node-v1",
        },
        "acme/two": {
          authorized: true,
          baseBranch: "main",
          profileId: "node-v1",
        },
      },
      authorizedTasks: [],
      promptVersion: "worker-v1",
      promptTemplates: { "worker-v1": "{{TASK_SNAPSHOT}}" },
      profiles: {
        "node-v1": {
          setupCommands: [],
          verificationCommands: ["npm test"],
        },
      },
    } as const;
    const readCalls: string[] = [];
    const source = {
      discover: vi.fn(async () => [oneTask, twoTask]),
      read: vi.fn(async ({ task: reference }: { readonly task: unknown }) => {
        const referenceTask = reference as typeof oneTask;
        readCalls.push(referenceTask.repository);
        const found =
          referenceTask.repository === "acme/one" ? oneTask : twoTask;
        return { task: found, relatedTasks: [] };
      }),
    };
    let nextId = 0;
    const planner = createRepositoryWorkflowPlanner({
      invoke: async () => ({
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: "Plan exactly one claimed task.",
          proposedWork: ["Retain repository-scoped provenance."],
          verificationStrategy: ["Inspect retained records."],
          risks: [],
          evidence: [],
        })}</plan>`,
      }),
      planStore,
      createId: () => `plan-${++nextId}`,
    });

    const first = await planOneEligibleTask({
      repository: "acme/one",
      repositoryWorkflow: {
        workflowIdentity: "acme/one:workflow-v1",
        cycle: 1,
        revision: 1,
      },
      configuration,
      source,
      store: workerStore,
      planner,
      owner: "planner",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate: "<plan> Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });
    const second = await planOneEligibleTask({
      repository: "acme/two",
      repositoryWorkflow: {
        workflowIdentity: "acme/two:workflow-v1",
        cycle: 1,
        revision: 2,
      },
      configuration,
      source,
      store: workerStore,
      planner,
      owner: "planner",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate: "<plan> Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });

    expect(first.status).toBe("planned");
    expect(second.status).toBe("planned");
    expect(first.record?.input.taskId).toBe("acme/one:issue:41");
    expect(second.record?.input.taskId).toBe("acme/two:issue:23");
    expect(first.record?.plan?.repositoryContext.repository).toBe("acme/one");
    expect(second.record?.plan?.repositoryContext.repository).toBe("acme/two");
    const records = await planStore.list();
    expect(records.map((record) => record.id)).toEqual(["plan-1", "plan-2"]);
    const projection = await createRepositoryWorkflowControl({
      store: workflowStore,
      runtime: { runCycle: vi.fn() },
      workflows: {},
    }).getProjection!();
    expect(projection.plans?.map((plan) => plan.repository)).toEqual([
      "acme/one",
      "acme/two",
    ]);
  });

  it("selects and refresh-claims one eligible task before invoking the planner", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-claim-"),
    );
    directories.push(directory);
    const workerStore = createWorkerStateStore({
      filePath: join(directory, "worker.json"),
    });
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(directory, "workflows.json"),
    });
    const planStore = createRepositoryWorkflowPlanStore({
      store: workflowStore,
    });
    const configuration = {
      repositories: {
        "acme/one": {
          authorized: true,
          baseBranch: "main",
          profileId: "node-v1",
        },
      },
      authorizedTasks: [],
      promptVersion: "worker-v1",
      promptTemplates: { "worker-v1": "{{TASK_SNAPSHOT}}" },
      profiles: {
        "node-v1": {
          setupCommands: [],
          verificationCommands: ["npm test"],
        },
      },
    } as const;
    const source = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => ({ task, relatedTasks: [] })),
    };
    const planner = createRepositoryWorkflowPlanner({
      invoke: async () => ({
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: "Plan the claimed task.",
          proposedWork: ["Retain the plan."],
          verificationStrategy: ["Run npm test."],
          risks: [],
          evidence: [],
        })}</plan>`,
      }),
      planStore,
    });

    const result = await planOneEligibleTask({
      repository: "acme/one",
      repositoryWorkflow: {
        workflowIdentity: "acme/one:workflow-v1",
        cycle: 1,
        revision: 1,
      },
      configuration,
      source,
      store: workerStore,
      planner,
      owner: "planner",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate: "<plan> Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });

    expect(result.status).toBe("planned");
    expect(result.record?.input.taskId).toBe("acme/one:issue:23");
    expect(result.attempt?.claim?.phase).toBe("claimed");
    expect((await workerStore.read()).attempts[0]?.status).toBe("active");
    expect(source.read).toHaveBeenCalledOnce();
  });

  it("retains authorization from the claim-time eligibility refresh", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-claim-authorization-"),
    );
    directories.push(directory);
    const workerStore = createWorkerStateStore({
      filePath: join(directory, "worker.json"),
    });
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(directory, "workflows.json"),
    });
    const planStore = createRepositoryWorkflowPlanStore({
      store: workflowStore,
    });
    const configuration = {
      repositories: {
        "acme/one": {
          authorized: true,
          baseBranch: "main",
          profileId: "node-v1",
        },
      },
      authorizedTasks: [
        { repository: "acme/one", kind: "issue" as const, number: 23 },
      ],
      promptVersion: "worker-v1",
      promptTemplates: { "worker-v1": "{{TASK_SNAPSHOT}}" },
      profiles: {
        "node-v1": {
          setupCommands: [],
          verificationCommands: ["npm test"],
        },
      },
    };
    const source = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => {
        configuration.repositories["acme/one"].authorized = false;
        return { task, relatedTasks: [] };
      }),
    };
    const planner = createRepositoryWorkflowPlanner({
      invoke: async () => ({
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: "Plan the freshly authorized task.",
          proposedWork: ["Retain claim-time authorization."],
          verificationStrategy: ["Inspect the retained provenance."],
          risks: [],
          evidence: [],
        })}</plan>`,
      }),
      planStore,
    });

    const result = await planOneEligibleTask({
      repository: "acme/one",
      repositoryWorkflow: {
        workflowIdentity: "acme/one:workflow-v1",
        cycle: 1,
        revision: 1,
      },
      configuration,
      source,
      store: workerStore,
      planner,
      owner: "planner",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate: "<plan> Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });

    expect(result.decision?.authorization).toBe("task");
    expect(result.record?.input.authorization).toBe("task");
  });

  it("retains centrally configured dependency provenance during planning", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-planner-configured-dependency-"),
    );
    directories.push(directory);
    const workerStore = createWorkerStateStore({
      filePath: join(directory, "worker.json"),
    });
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(directory, "workflows.json"),
    });
    const planStore = createRepositoryWorkflowPlanStore({
      store: workflowStore,
    });
    const blocker = {
      ...task,
      number: 7,
      title: "Completed dependency",
      sourceRevision: "issue:7:rev-1",
      state: "completed" as const,
    };
    const configuration = {
      repositories: {
        "acme/one": {
          authorized: true,
          baseBranch: "main",
          profileId: "node-v1",
        },
      },
      authorizedTasks: [],
      taskDependencies: [
        {
          task: { repository: "acme/one", kind: "issue" as const, number: 23 },
          blockedBy: [
            { repository: "acme/one", kind: "issue" as const, number: 7 },
          ],
        },
      ],
      promptVersion: "worker-v1",
      promptTemplates: { "worker-v1": "{{TASK_SNAPSHOT}}" },
      profiles: {
        "node-v1": {
          setupCommands: [],
          verificationCommands: ["npm test"],
        },
      },
    };
    const source = {
      discover: vi.fn(async () => [task, blocker]),
      read: vi.fn(async () => ({ task, relatedTasks: [blocker] })),
    };
    const planner = createRepositoryWorkflowPlanner({
      invoke: async () => ({
        stdout: `<plan>${JSON.stringify({
          version: 1,
          taskIntent: "Plan a task with a centrally configured dependency.",
          proposedWork: ["Retain the authoritative blocker."],
          verificationStrategy: ["Inspect dependency evidence."],
          risks: [],
          evidence: [],
        })}</plan>`,
      }),
      planStore,
    });

    const result = await planOneEligibleTask({
      repository: "acme/one",
      repositoryWorkflow: {
        workflowIdentity: "acme/one:workflow-v1",
        cycle: 1,
        revision: 1,
      },
      configuration,
      source,
      store: workerStore,
      planner,
      owner: "planner",
      leaseDurationMs: 60_000,
      promptVersion: "planner-v1",
      promptTemplate: "<plan> Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });

    expect(result.status).toBe("planned");
    expect(result.record?.input.dependencyEvidence).toEqual([
      {
        taskId: "acme/one:issue:7",
        repository: "acme/one",
        kind: "issue",
        number: 7,
        sourceRevision: "issue:7:rev-1",
        state: "completed",
        satisfied: true,
      },
    ]);
    expect(
      result.attempt?.claim?.refreshedSnapshots?.[0]?.dependencies,
    ).toEqual([{ repository: "acme/one", kind: "issue", number: 7 }]);
  });
});
