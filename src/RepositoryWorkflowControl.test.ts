import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepositoryWorkflowControl,
  createRepositoryWorkflowStore,
} from "./RepositoryWorkflowControl.js";
import type { RepositoryWorkflowDefinition } from "./RepositoryWorkflowRuntime.js";

const directories: string[] = [];
const workflow: RepositoryWorkflowDefinition = {
  id: "repo-work-v1",
  maxCycles: 10,
  maxParallel: 4,
  planner: { model: "planner", prompt: "plan" },
  implementer: { model: "implementer", prompt: "implement" },
  reviewer: { model: "reviewer", prompt: "review" },
  integrator: { model: "integrator", prompt: "integrate" },
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("createRepositoryWorkflowControl", () => {
  it("uses compare-and-set revisions across store instances and qualifies workflow identity by repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repository-workflow-cas-"));
    directories.push(directory);
    const filePath = join(directory, "workflows.json");
    const firstStore = createRepositoryWorkflowStore({ filePath });
    const secondStore = createRepositoryWorkflowStore({ filePath });

    await firstStore.update((state) => state, { expectedRevision: 0 });
    await expect(
      secondStore.update((state) => state, { expectedRevision: 0 }),
    ).rejects.toMatchObject({
      code: "stale_revision",
      expectedRevision: 0,
      actualRevision: 1,
    });

    const control = createRepositoryWorkflowControl({
      store: firstStore,
      runtime: { runCycle: vi.fn() },
      workflows: { "repo-work-v1": workflow },
    });
    await control.authorize({
      repository: "acme/one",
      featureBranch: "feat/one",
      workflowId: "repo-work-v1",
    });
    await control.authorize({
      repository: "acme/two",
      featureBranch: "feat/two",
      workflowId: "repo-work-v1",
    });

    const projection = await control.getProjection!();
    expect(projection.revision).toBeGreaterThan(1);
    expect(
      projection.repositories.map((item) => item.workflowIdentity),
    ).toEqual(["acme/one:repo-work-v1", "acme/two:repo-work-v1"]);
    expect(projection.repositories[0]?.workflowIdentity).not.toBe(
      projection.repositories[1]?.workflowIdentity,
    );
  });

  it("recovers an expired unstarted claim as retryable after a restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-workflow-recovery-"),
    );
    directories.push(directory);
    const filePath = join(directory, "workflows.json");
    const store = createRepositoryWorkflowStore({ filePath });
    await store.update(
      (state) => ({
        ...state,
        repositories: [
          {
            repository: "acme/app",
            featureBranch: "feat/batch",
            workflowId: workflow.id,
            workflowIdentity: "acme/app:repo-work-v1",
            mode: "active" as const,
            nextCycle: 1,
            activeRunId: "run-crashed",
          },
        ],
        runs: [
          {
            id: "run-crashed",
            repository: "acme/app",
            workflowId: workflow.id,
            workflowIdentity: "acme/app:repo-work-v1",
            cycle: 1,
            startedAt: "2026-08-24T00:00:00.000Z",
            status: "running" as const,
            cycles: [],
            owner: "old-process",
            claim: {
              owner: "old-process",
              acquiredAt: "2026-08-24T00:00:00.000Z",
              leaseExpiresAt: "2026-08-24T00:00:01.000Z",
              phase: "claimed" as const,
            },
          },
        ],
      }),
      { expectedRevision: 0 },
    );

    const control = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({ filePath }),
      runtime: { runCycle: vi.fn() },
      workflows: { [workflow.id]: workflow },
      now: () => "2026-08-24T00:01:00.000Z",
      owner: "new-process",
      leaseDurationMs: 60_000,
    });

    await expect(control.recover!()).resolves.toEqual([
      expect.objectContaining({
        repository: "acme/app",
        runId: "run-crashed",
        disposition: "retryable",
      }),
    ]);
    const inspection = await control.inspect("acme/app");
    expect(inspection?.activeRunId).toBeUndefined();
    expect(inspection?.blockingReason).toBeUndefined();
    expect(inspection?.runs[0]).toMatchObject({
      status: "interrupted",
      recovery: "retryable",
    });
  });

  it("does not consume a cycle budget for an idle poll and exposes a stable ready queue", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-workflow-queue-"),
    );
    directories.push(directory);
    const runCycle = vi.fn(async ({ repository, cycle }) => ({
      repository,
      cycle,
      status: "idle" as const,
      tasks: [],
    }));
    const control = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
      runtime: { runCycle },
      workflows: { [workflow.id]: workflow },
      now: () => "2026-08-24T00:00:00.000Z",
      owner: "scheduler",
      leaseDurationMs: 60_000,
      createId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })(),
    });
    await control.authorize({
      repository: "Acme/Two",
      featureBranch: "feat/two",
      workflowId: workflow.id,
    });
    await control.authorize({
      repository: "acme/one",
      featureBranch: "feat/one",
      workflowId: workflow.id,
    });

    const before = await control.getProjection!();
    expect(before.queue.map((item) => item.repository)).toEqual([
      "acme/one",
      "acme/two",
    ]);
    await control.runNow("acme/one");
    expect((await control.inspect("acme/one"))?.nextCycle).toBe(1);
    const after = await control.getProjection!();
    expect(after.queue.map((item) => item.repository)).toEqual([
      "acme/two",
      "acme/one",
    ]);
  });

  it("manages authorized repositories and exposes per-repository workflow details", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-workflow-control-"),
    );
    directories.push(directory);
    const runCycle = vi.fn(async () => ({
      repository: "acme/app",
      cycle: 1,
      status: "integrated" as const,
      tasks: [
        {
          issue: { number: 7, title: "Fix", branch: "issue-7" },
          status: "reviewed" as const,
        },
      ],
      integrationCommit: "abc123",
    }));
    const control = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
      runtime: { runCycle },
      workflows: { "repo-work-v1": workflow },
    });

    await control.authorize({
      repository: "acme/app",
      featureBranch: "feat/batch",
      workflowId: "repo-work-v1",
    });
    await control.runNow("acme/app");
    await control.pause("acme/app");

    expect(await control.list()).toEqual([
      expect.objectContaining({
        repository: "acme/app",
        mode: "paused",
        workflowId: "repo-work-v1",
      }),
    ]);
    expect(await control.inspect("acme/app")).toMatchObject({
      repository: "acme/app",
      runs: [
        { cycles: [{ status: "integrated", integrationCommit: "abc123" }] },
      ],
    });
    await control.resume("acme/app");
    expect((await control.inspect("acme/app"))?.mode).toBe("active");
  });

  it("reconstructs an active run after restart and refuses duplicate dispatch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-workflow-restart-"),
    );
    directories.push(directory);
    const filePath = join(directory, "workflows.json");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      runCycle: vi.fn(async () => {
        await pending;
        return {
          repository: "acme/app",
          cycle: 1,
          status: "idle" as const,
          tasks: [],
        };
      }),
    };
    const first = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({ filePath }),
      runtime,
      workflows: { "repo-work-v1": workflow },
    });
    await first.authorize({
      repository: "acme/app",
      featureBranch: "feat/batch",
      workflowId: "repo-work-v1",
    });
    const active = first.runNow("acme/app");
    await vi.waitFor(async () =>
      expect((await first.inspect("acme/app"))?.activeRunId).toBeTruthy(),
    );

    const restarted = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({ filePath }),
      runtime,
      workflows: { "repo-work-v1": workflow },
    });
    await expect(restarted.runNow("acme/app")).rejects.toThrow(
      "already has an active workflow",
    );
    expect(runtime.runCycle).toHaveBeenCalledOnce();
    release();
    await active;
  });

  it("uses the durable update boundary to allow only one concurrent dispatcher", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "repository-workflow-concurrent-"),
    );
    directories.push(directory);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const control = createRepositoryWorkflowControl({
      store: createRepositoryWorkflowStore({
        filePath: join(directory, "workflows.json"),
      }),
      runtime: {
        runCycle: vi.fn(async () => {
          await pending;
          return {
            repository: "acme/app",
            cycle: 1,
            status: "idle" as const,
            tasks: [],
          };
        }),
      },
      workflows: { "repo-work-v1": workflow },
      createId: (() => {
        let next = 0;
        return () => `run-${++next}`;
      })(),
    });
    await control.authorize({
      repository: "acme/app",
      featureBranch: "feat/batch",
      workflowId: "repo-work-v1",
    });

    const first = control.runNow("acme/app");
    const second = control.runNow("acme/app");
    await expect(second).rejects.toThrow("already has an active workflow");
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    const state = await control.inspect("acme/app");
    expect(state?.activeRunId).toBeUndefined();
  });
});
