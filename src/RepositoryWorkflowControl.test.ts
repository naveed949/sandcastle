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
});
