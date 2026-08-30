import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryWorkflowRuntime,
  type RepositoryWorkflowDefinition,
} from "./RepositoryWorkflowRuntime.js";

const workflow: RepositoryWorkflowDefinition = {
  id: "parallel-planner-review-v1",
  maxCycles: 10,
  maxParallel: 2,
  planner: { model: "gpt-5.6-terra", effort: "medium", prompt: "plan" },
  implementer: { model: "gpt-5.6-luna", effort: "max", prompt: "implement" },
  reviewer: { model: "gpt-5.6-sol", effort: "medium", prompt: "review" },
  integrator: { model: "gpt-5.6-terra", effort: "medium", prompt: "merge" },
};

describe("createRepositoryWorkflowRuntime", () => {
  it("runs the planner, parallel implement/review tasks, then one serialized integration", async () => {
    let activeImplementers = 0;
    let peakImplementers = 0;
    const integrate = vi.fn(async () => ({ commit: "merge-commit" }));
    const closeIssues = vi.fn(async () => undefined);
    const runtime = createRepositoryWorkflowRuntime({
      planner: {
        plan: vi.fn(async () => ({
          issues: [
            { number: 11, title: "First", branch: "issue-11" },
            { number: 12, title: "Second", branch: "issue-12" },
            { number: 13, title: "No commit", branch: "issue-13" },
          ],
          logReference: "planner.log",
        })),
      },
      taskRunner: {
        implement: vi.fn(async ({ issue }) => {
          activeImplementers++;
          peakImplementers = Math.max(peakImplementers, activeImplementers);
          await Promise.resolve();
          activeImplementers--;
          return {
            commits: issue.number === 13 ? [] : [`commit-${issue.number}`],
          };
        }),
        review: vi.fn(async ({ issue }) => ({
          commits: [`review-${issue.number}`],
        })),
      },
      integrator: { integrate },
      issueTracker: { closeIssues },
    });

    const result = await runtime.runCycle({
      repository: "acme/app",
      featureBranch: "feat/batch",
      workflow,
      cycle: 1,
    });

    expect(peakImplementers).toBe(2);
    expect(
      result.tasks.map((task) => [task.issue.number, task.status]),
    ).toEqual([
      [11, "reviewed"],
      [12, "reviewed"],
      [13, "no_changes"],
    ]);
    expect(integrate).toHaveBeenCalledOnce();
    expect(integrate).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "acme/app",
        featureBranch: "feat/batch",
        branches: ["issue-11", "issue-12"],
      }),
    );
    expect(closeIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumbers: [11, 12],
        integrationCommit: "merge-commit",
      }),
    );
    expect(result.status).toBe("integrated");
  });
});
