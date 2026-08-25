import type { Db, TicketStatus } from "./db.js";
import type { EventBus } from "./bus.js";
import { ProcessRunner } from "./runner.js";
import {
  createPullRequest,
  fetchIssueState,
  parseIssueUrl,
  parseRepositorySlug,
} from "./github.js";
import { projectWorkspace } from "./workspace.js";
import { removeProjectContainers } from "./container-cleanup.js";
import path from "node:path";

export interface PipelineOptions {
  dataDir: string;
}

export interface PipelineDependencies {
  runner?: Pick<ProcessRunner, "runProject" | "cancel">;
  removeProjectContainers?: typeof removeProjectContainers;
}

export class Pipeline {
  private runner: Pick<ProcessRunner, "runProject" | "cancel">;
  private removeProjectContainers: typeof removeProjectContainers;

  constructor(
    private db: Db,
    private opts: PipelineOptions,
    private bus: EventBus,
    deps: PipelineDependencies = {},
  ) {
    this.runner = deps.runner ?? new ProcessRunner(db, bus);
    this.removeProjectContainers =
      deps.removeProjectContainers ?? removeProjectContainers;
  }

  /**
   * Runs the target repo's .sandcastle/run.ts to completion, then syncs ticket
   * state from GitHub and opens the final PR if all tickets are closed.
   * run.ts itself owns planning, implementation, review and merging.
   */
  async startProject(
    projectId: number,
    opts?: { force?: boolean },
  ): Promise<void> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (
      !opts?.force &&
      ["cancelled", "done", "pr_open"].includes(project.status)
    )
      return;

    const { owner, repo } = parseIssueUrl(project.prd_issue_url);
    const repoDir = projectWorkspace(this.opts.dataDir, projectId);

    const pending = this.db
      .listTickets(projectId)
      .filter((t) => t.status !== "done");
    for (const t of pending) {
      this.db.updateTicketStatus(t.id, "implementing" satisfies TicketStatus);
    }

    this.db.updateProjectStatus(projectId, "running");
    const runner = this.runner;
    let result;
    try {
      result = await runner.runProject({
        projectId,
        repoDir,
        logDir: path.join(repoDir, ".sandcastle", "logs"),
        issueRepository: parseRepositorySlug(project.repo_url),
      });
    } catch (err) {
      if (this.db.getProject(projectId)?.status === "cancelled") return;
      this.db.updateProjectStatus(
        projectId,
        "failed",
        `run.ts failed to start: ${(err as Error).message}`,
      );
      return;
    }

    // Cancellation is terminal. Do not sync tickets or overwrite the project
    // status after the killed run.ts process exits.
    if (this.db.getProject(projectId)?.status === "cancelled") return;

    // Sync ticket state from GitHub — the template's agents close issues.
    for (const t of pending) {
      try {
        const state = await fetchIssueState(owner, repo, t.gh_issue_number);
        this.db.updateTicketStatus(
          t.id,
          state === "closed" ? "done" : "failed",
        );
      } catch (err) {
        console.error(`Failed to fetch state of #${t.gh_issue_number}:`, err);
      }
    }

    if (result.exitCode !== 0) {
      this.db.updateProjectStatus(
        projectId,
        "failed",
        `.sandcastle/run.ts exited with code ${result.exitCode}`,
      );
      return;
    }

    const tickets = this.db.listTickets(projectId);
    const remaining = tickets.filter((t) => t.status !== "done");
    if (remaining.length > 0) {
      this.db.updateProjectStatus(
        projectId,
        "failed",
        `${remaining.length} ticket(s) still open: ${remaining.map((t) => "#" + t.gh_issue_number).join(", ")}`,
      );
      return;
    }

    this.db.updateProjectStatus(projectId, "pr_open");
    try {
      const prUrl = await createPullRequest({
        owner,
        repo,
        head: project.feature_branch,
        base: project.base_branch,
        title: `Implement PRD (${tickets.length} tickets)`,
        body: [
          `Implements the PRD: ${project.prd_issue_url}`,
          "",
          "## Closed issues",
          ...tickets.map((t) => `- #${t.gh_issue_number} ${t.title}`),
        ].join("\n"),
      });
      this.db.setProjectPrUrl(projectId, prUrl);
      this.db.updateProjectStatus(projectId, "done");
    } catch (err) {
      this.db.updateProjectStatus(
        projectId,
        "failed",
        `PR creation failed: ${(err as Error).message}`,
      );
    }
  }

  cancelProject(projectId: number): void {
    this.db.updateProjectStatus(projectId, "cancelled");
    // Kill the active pipeline run's process tree and remove its containers.
    const run = this.db
      .listRuns(projectId)
      .filter((r) => r.status === "running")
      .at(-1);
    if (run) {
      this.runner.cancel(run.id);
    }
    void this.removeProjectContainers(this.opts.dataDir, projectId);
  }

  resetForRetry(projectId: number): void {
    for (const t of this.db.listTickets(projectId)) {
      if (t.status === "failed") {
        this.db.resetTicketForRetry(t.id);
      }
    }
  }
}
