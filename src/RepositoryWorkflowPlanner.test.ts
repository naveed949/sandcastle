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
  planOneEligibleTask,
  RepositoryWorkflowPlannerContextError,
  type RepositoryWorkflowPlanningInput,
} from "./RepositoryWorkflowPlanner.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

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
          needsHumanClarification: false,
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
        needsHumanClarification: false,
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
          needsHumanClarification: false,
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
          needsHumanClarification: false,
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
      promptTemplate: "Repository {{REPOSITORY}} Task {{TASK_SNAPSHOT}}",
    });

    expect(result.status).toBe("planned");
    expect(result.record?.input.taskId).toBe("acme/one:issue:23");
    expect(result.attempt?.claim?.phase).toBe("claimed");
    expect((await workerStore.read()).attempts[0]?.status).toBe("active");
    expect(source.read).toHaveBeenCalledOnce();
  });
});
