import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "./CanonicalJson.js";
import {
  createRepositoryWorkflowPlanStore,
  createRepositoryWorkflowPlanner,
  planOneEligibleTask,
} from "./RepositoryWorkflowPlanner.js";
import type { RepositoryWorkflowImplementationRecord } from "./RepositoryWorkflowImplementer.js";
import {
  createRepositoryWorkflowReviewer,
  createRepositoryWorkflowReviewStore,
  expandRepositoryWorkflowReviewerPrompt,
  RepositoryWorkflowReviewerContextError,
  reviewAndRemediate,
} from "./RepositoryWorkflowReview.js";
import type { RepositoryWorkflowReviewRecord } from "./RepositoryWorkflowReview.js";
import {
  createRepositoryWorkflowControl,
  createRepositoryWorkflowStore,
} from "./RepositoryWorkflowControl.js";
import { runWorkerDryRun } from "./WorkerCoordinator.js";
import type {
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { ExecutionAttempt } from "./WorkerStateStore.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const directories: string[] = [];

const task: NormalizedTask = {
  repository: "acme/one",
  kind: "issue",
  number: 25,
  title: "Review one verified task",
  body: "Review the retained work.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue:25:rev-1",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/one": {
      authorized: true,
      baseBranch: "main",
      profileId: "node-v1",
    },
  },
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
};

const approvedVerdict = {
  version: 1,
  verdict: "approved",
  findings: [],
  requiredActions: [],
};

const changesRequestedVerdict = () => ({
  version: 1,
  verdict: "changes_requested",
  findings: [
    {
      severity: "blocking",
      location: "src/index.ts:1",
      finding: "Missing null guard.",
      rationale: "The change can throw on empty input.",
    },
  ],
  requiredActions: ["Add the missing null guard."],
});

interface World {
  readonly root: string;
  readonly store: ReturnType<typeof createWorkerStateStore>;
  readonly plan: Awaited<
    ReturnType<ReturnType<typeof createRepositoryWorkflowPlanner>["plan"]>
  >;
  readonly verifiedAttempt: ExecutionAttempt;
  readonly implementation: RepositoryWorkflowImplementationRecord;
  readonly implementationDiff: string;
}

const createWorld = async (): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), "repository-reviewer-"));
  directories.push(root);
  const store = createWorkerStateStore({
    filePath: join(root, "worker.json"),
  });
  const workflowStore = createRepositoryWorkflowStore({
    filePath: join(root, "workflows.json"),
  });
  const dryRun = runWorkerDryRun({ configuration, tasks: [task] });
  const decision = dryRun.decisions[0]!;
  const request = dryRun.executionRequests[0]!;
  const attempt = await store.claimAttempt(request, {
    owner: "reviewer-test",
    leaseDurationMs: 60_000,
    refreshedSnapshots: [task],
  });
  const planner = createRepositoryWorkflowPlanner({
    invoke: async () => ({
      stdout: `<plan>${JSON.stringify({
        version: 1,
        taskIntent: "Implement the reviewed work.",
        proposedWork: ["Change one file."],
        verificationStrategy: ["Run npm test."],
        risks: [],
        evidence: [],
      })}</plan>`,
    }),
    planStore: createRepositoryWorkflowPlanStore({ store: workflowStore }),
    createId: () => "plan-1",
  });
  const plan = await planner.plan({
    repository: "acme/one",
    repositoryWorkflow: {
      workflowIdentity: "acme/one:workflow-v1",
      cycle: 1,
      revision: 1,
    },
    attempt,
    taskSnapshot: request.task,
    eligibility: decision,
    promptVersion: "planner-v1",
    promptTemplate: "<plan>\nSnapshot {{TASK_SNAPSHOT}}",
  });
  if (plan.plan === undefined) throw new Error("planning failed");
  // Mirror the real implementation stage: durably verify the claimed attempt.
  const verifiedAttempt: ExecutionAttempt = await store.transitionAttempt(
    attempt.attemptId,
    { status: "verified", evidence: ["implementation-record"] },
  );
  const implementation: RepositoryWorkflowImplementationRecord = {
    planId: plan.id,
    workflowIdentity: plan.workflowIdentity,
    repository: "acme/one",
    taskId: request.taskId,
    executionIdentity: request.executionIdentity,
    attemptId: attempt.attemptId,
    status: "verified",
    recovery: "terminal",
    verification: [
      {
        command: "npm test",
        phase: "verification",
        exitCode: 0,
        stdout: "all tests passed",
        stderr: "",
        durationMs: 12,
      },
    ],
    attemptStatus: "verified",
  };
  return {
    root,
    store,
    plan,
    verifiedAttempt,
    implementation,
    implementationDiff: [
      `--- a/src/index.ts`,
      `+++ b/src/index.ts`,
      `@@ -1,1 +1,2 @@`,
      ` export {}`,
      `+export const changed = true;`,
    ].join("\n"),
  };
};

const reviewerPrompt = [
  "<review>",
  "Task {{TASK_SNAPSHOT}}",
  "Plan {{ACCEPTED_PLAN}}",
  "Diff {{IMPLEMENTATION_DIFF}}",
  "Evidence {{VERIFICATION_EVIDENCE}}",
  "Policy {{REPOSITORY_POLICY}}",
].join("\n");

const stdoutWith = (payload: unknown): string =>
  `<review>${JSON.stringify(payload)}</review>`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createRepositoryWorkflowReviewer", () => {
  it("completes an advisory approval with reviewer provenance and persists it", async () => {
    const world = await createWorld();
    const workflowStore = createRepositoryWorkflowStore({
      filePath: join(world.root, "workflows.json"),
    });
    const reviewStore = createRepositoryWorkflowReviewStore({
      store: workflowStore,
    });
    let nextId = 0;
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async ({ prompt }) => {
        expect(prompt).toContain('"repository": "acme/one"');
        expect(prompt).toContain("export const changed = true;");
        expect(prompt).toContain('"command": "npm test"');
        return { stdout: stdoutWith(approvedVerdict) };
      },
      reviewStore,
      createId: () => `review-${++nextId}`,
      now: () => "2026-08-25T00:00:01.000Z",
    });

    const record = await reviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    });

    expect(record.status).toBe("completed");
    expect(record.recovery).toBe("terminal");
    expect(record.verdict).toEqual(approvedVerdict);
    expect(record.remediationIteration).toBe(0);
    expect(record.promptTemplateDigest).toBeTruthy();
    expect(record.implementationDiffDigest).toBe(
      canonicalJsonDigest(world.implementationDiff),
    );
    expect((await reviewStore.list()).map((item) => item.id)).toEqual([
      "review-1",
    ]);
    const control = createRepositoryWorkflowControl({
      store: workflowStore,
      runtime: { runCycle: vi.fn() },
      workflows: {},
    });
    const projection = await control.getProjection!();
    expect(projection.reviews).toMatchObject([
      { id: "review-1", status: "completed", evidenceCount: 3 },
    ]);
  }, 20_000);

  it("rejects an approved verdict that carries a blocking finding", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({
        stdout: stdoutWith({
          ...approvedVerdict,
          findings: [
            {
              severity: "blocking",
              location: "src/index.ts:1",
              finding: "Broken.",
              rationale: "Because.",
            },
          ],
        }),
      }),
      createId: () => "review-gate",
    });

    const record = await reviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    });

    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("invalid_structured_output");
    expect(record.verdict).toBeUndefined();
  }, 20_000);

  it("fails explicitly on malformed verdicts without approving", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: '<review>{"version":1}</review>' }),
      createId: () => "review-malformed",
    });

    const record = await reviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    });

    expect(record.status).toBe("failed");
    expect(record.recovery).toBe("resumable");
    expect(record.error?.code).toBe("invalid_structured_output");
  }, 20_000);

  it("classifies cancellation and timeout as resumable without approving", async () => {
    const world = await createWorld();
    let receivedSignal!: AbortSignal;
    const pendingReviewer = createRepositoryWorkflowReviewer({
      invoke: async ({ signal }) => {
        receivedSignal = signal;
        return await new Promise<never>(() => undefined);
      },
      createId: () => "review-cancel",
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = pendingReviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    controller.abort(new Error("operator stopped"));

    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.recovery).toBe("resumable");
    expect(cancelled.verdict).toBeUndefined();

    const timeoutReviewer = createRepositoryWorkflowReviewer({
      invoke: async () => await new Promise<never>(() => undefined),
      createId: () => "review-timeout",
      timeoutMs: 5,
    });
    const timedOut = await timeoutReviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    });
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.verdict).toBeUndefined();
  }, 20_000);

  it("classifies an invocation failure as terminal without approving", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => {
        throw new Error("reviewer agent crashed");
      },
      createId: () => "review-failure",
    });

    const record = await reviewer.review({
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    });

    expect(record.status).toBe("failed");
    expect(record.recovery).toBe("terminal");
    expect(record.error?.code).toBe("reviewer_invocation_failed");
  }, 20_000);

  it("fails fast when inputs are unverified, missing the diff, or omit the tag", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: "" }),
      createId: () => "review-context",
    });
    const base = {
      plan: world.plan,
      implementationAttempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      promptVersion: "reviewer-v1",
      promptTemplate: reviewerPrompt,
    };

    const activeAttempt = {
      ...world.verifiedAttempt,
      status: "active" as const,
    };
    await expect(
      reviewer.review({ ...base, implementationAttempt: activeAttempt }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowReviewerContextError(
        "invalid_context",
        "Reviewer requires a verified attempt matching the frozen task snapshot.",
      ),
    );

    await expect(
      reviewer.review({ ...base, implementationDiff: "   " }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowReviewerContextError(
        "missing_context",
        "Reviewer requires the implementation diff.",
      ),
    );

    await expect(
      reviewer.review({
        ...base,
        promptTemplate: "Diff {{IMPLEMENTATION_DIFF}}",
      }),
    ).rejects.toMatchObject(
      new RepositoryWorkflowReviewerContextError(
        "invalid_context",
        "Reviewer prompt template must instruct the <review> structured output tag.",
      ),
    );
    expect(expandRepositoryWorkflowReviewerPrompt(base)).toContain(
      "export const changed = true;",
    );
  }, 20_000);
});

describe("reviewAndRemediate", () => {
  const fakeVerifiedImplementation = (
    attemptId: string,
    base: RepositoryWorkflowImplementationRecord,
  ): RepositoryWorkflowImplementationRecord => ({
    ...base,
    attemptId,
    status: "verified",
    recovery: "terminal",
    attemptStatus: "verified",
  });

  // Mimic the real implementation stage: durable transition to verified.
  const fakeImplementer = (world: World) => ({
    implement: vi.fn(
      async ({ attempt }: { readonly attempt: ExecutionAttempt }) => {
        const verified = await world.store.transitionAttempt(
          attempt.attemptId,
          { status: "verified", evidence: ["fake-implementation-record"] },
        );
        return fakeVerifiedImplementation(
          verified.attemptId,
          world.implementation,
        );
      },
    ),
  });

  it("approves on the first pass without remediating", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: stdoutWith(approvedVerdict) }),
      createId: (() => {
        let next = 0;
        return () => `review-${++next}`;
      })(),
    });
    const implementer = { implement: vi.fn() };

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source: { read: vi.fn() },
      store: world.store,
      reviewer,
      implementer: implementer as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: reviewerPrompt,
    });

    expect(result.status).toBe("approved");
    expect(result.reviews).toHaveLength(1);
    expect(result.finalReview?.verdict?.verdict).toBe("approved");
    expect(result.implementationAttemptIds).toHaveLength(1);
    expect(implementer.implement).not.toHaveBeenCalled();
  }, 20_000);

  it("remediates once through a fresh claim, then approves with linked evidence", async () => {
    const world = await createWorld();
    let reviewCall = 0;
    const scriptedReviewer = createRepositoryWorkflowReviewer({
      invoke: vi.fn(async () => {
        reviewCall += 1;
        return {
          stdout: stdoutWith(
            reviewCall === 1 ? changesRequestedVerdict() : approvedVerdict,
          ),
        };
      }),
      createId: (() => {
        let next = 100;
        return () => `review-${++next}`;
      })(),
    });
    const implementer = fakeImplementer(world);
    const source = {
      read: vi.fn(async () => ({ task, relatedTasks: [] })),
    };

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source,
      store: world.store,
      reviewer: scriptedReviewer,
      implementer: implementer as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: "<review> remediation pass {{TASK_SNAPSHOT}}",
      maxRemediationIterations: 2,
    });

    expect(result.status).toBe("approved");
    expect(result.reviews.map((review) => review.id)).toEqual([
      "review-101",
      "review-102",
    ]);
    expect(result.reviews[0]?.verdict?.verdict).toBe("changes_requested");
    expect(result.reviews[1]?.remediationIteration).toBe(1);
    expect(result.reviews[1]?.priorReviewId).toBe("review-101");
    expect(result.implementationAttemptIds).toHaveLength(2);
    expect(implementer.implement).toHaveBeenCalledOnce();
    expect(
      implementer.implement.mock.calls[0]?.[0]?.attempt.attemptId,
    ).not.toBe(world.verifiedAttempt.attemptId);
    const attempts = (await world.store.read()).attempts;
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("enters manual intervention when findings repeat until exhaustion", async () => {
    const world = await createWorld();
    let count = 0;
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => {
        count += 1;
        return { stdout: stdoutWith(changesRequestedVerdict()) };
      },
      createId: (() => {
        let next = 0;
        return () => `review-${++next}`;
      })(),
    });
    const implementer = fakeImplementer(world);

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source: { read: async () => ({ task, relatedTasks: [] }) },
      store: world.store,
      reviewer,
      implementer: implementer as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: reviewerPrompt,
      maxRemediationIterations: 2,
    });

    expect(result.status).toBe("manual_intervention");
    expect(result.reasonCode).toBe("remediation_exhausted");
    expect(result.reviews).toHaveLength(3);
    expect(implementer.implement).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("returns failed on a malformed verdict without remediating", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: '<review>{"version":1}</review>' }),
      createId: () => "review-bad",
    });
    const implementer = { implement: vi.fn() };

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source: { read: vi.fn() },
      store: world.store,
      reviewer,
      implementer: implementer as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: reviewerPrompt,
    });

    expect(result.status).toBe("failed");
    expect(result.finalReview?.error?.code).toBe("invalid_structured_output");
    expect(implementer.implement).not.toHaveBeenCalled();
  }, 20_000);

  it("propagates operator cancellation without approving", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: stdoutWith(approvedVerdict) }),
      createId: () => "review-cancelled",
    });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source: { read: vi.fn() },
      store: world.store,
      reviewer,
      implementer: { implement: vi.fn() } as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: reviewerPrompt,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.reviews).toHaveLength(0);
  }, 20_000);

  it("classifies a remediation claim failure without losing the review chain", async () => {
    const world = await createWorld();
    const reviewer = createRepositoryWorkflowReviewer({
      invoke: async () => ({ stdout: stdoutWith(changesRequestedVerdict()) }),
      createId: () => "review-claim-failure",
    });
    const implementer = { implement: vi.fn() };

    const result = await reviewAndRemediate({
      plan: world.plan,
      attempt: world.verifiedAttempt,
      implementation: world.implementation,
      implementationDiff: world.implementationDiff,
      configuration,
      source: { read: async () => undefined },
      store: world.store,
      reviewer,
      implementer: implementer as never,
      owner: "reviewer-test",
      leaseDurationMs: 60_000,
      reviewerPromptVersion: "reviewer-v1",
      reviewerPromptTemplate: reviewerPrompt,
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("remediation_claim_failed");
    expect(implementer.implement).not.toHaveBeenCalled();
  }, 20_000);
});
