import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../server/bus.js";
import type { Db, ProjectRow, ProjectStatus, RunRow } from "../server/db.js";
import { Pipeline } from "../server/pipeline.js";

describe("Pipeline cancellation", () => {
  it("keeps cancellation terminal while stopping the run and cleaning containers", async () => {
    let status: ProjectStatus = "running";
    const project: ProjectRow = {
      id: 7,
      repo_url: "https://github.com/acme/repo",
      base_branch: "main",
      feature_branch: "feature/cancel-me",
      prd_issue_url: "https://github.com/acme/repo/issues/1",
      status,
      pr_url: null,
      error: null,
      created_at: "2026-08-25T00:00:00Z",
    };
    const run: RunRow = {
      id: 41,
      project_id: 7,
      kind: "pipeline",
      status: "running",
      log_file_path: null,
      started_at: "2026-08-25T00:00:00Z",
      finished_at: null,
    };
    const db = {
      getProject: () => ({ ...project, status }),
      listTickets: () => [],
      listRuns: () => [run],
      updateProjectStatus: (_id: number, next: ProjectStatus) => {
        status = next;
      },
    } as unknown as Db;

    let finishRun!: () => void;
    const runProject = vi.fn(
      () =>
        new Promise<{ exitCode: null }>((resolve) => {
          finishRun = () => resolve({ exitCode: null });
        }),
    );
    const cancel = vi.fn(() => {
      finishRun();
      return true;
    });
    const removeProjectContainers = vi.fn(async () => undefined);
    const pipeline = new Pipeline(db, { dataDir: "/data" }, new EventBus(), {
      runner: { runProject, cancel },
      removeProjectContainers,
    });

    const completion = pipeline.startProject(7);
    expect(runProject).toHaveBeenCalledWith({
      projectId: 7,
      repoDir: "/data/workspaces/7/repo",
      logDir: "/data/workspaces/7/repo/.sandcastle/logs",
      issueRepository: "acme/repo",
    });
    pipeline.cancelProject(7);
    await completion;

    expect(cancel).toHaveBeenCalledWith(41);
    expect(removeProjectContainers).toHaveBeenCalledWith("/data", 7);
    expect(status).toBe("cancelled");
  });
});
