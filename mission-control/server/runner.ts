import { spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import type { EventBus } from "./bus.js";
import { makeSpinnerCollapsingEmitter } from "./workspace.js";
import { trackAgent } from "./agents.js";

export interface ProcessRunResult {
  exitCode: number | null;
}

export function resolveIssueRepository(
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.ISSUE_REPOSITORY?.trim() || fallback;
}

/**
 * Executes the target repo's .sandcastle/run.ts (the template's own
 * orchestration script) as a child process, streaming its output line-by-line
 * to the event bus and database.
 */
export class ProcessRunner {
  private aborted = new Set<number>();
  private active = new Map<number, ReturnType<typeof spawn>>();

  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  /** Kills the run's process tree (run.ts and its npx/tsx children). */
  cancel(runId: number): boolean {
    const child = this.active.get(runId);
    const pid = child?.pid;
    if (!pid) return false;
    this.aborted.add(runId);
    try {
      // Negative pid kills the whole detached process group.
      process.kill(-pid, "SIGTERM");
      const forceKillTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000);
      forceKillTimer.unref();
    } catch {
      /* already gone */
    }
    return true;
  }

  async runProject(opts: {
    projectId: number;
    repoDir: string;
    logDir: string;
    issueRepository: string;
  }): Promise<ProcessRunResult> {
    const runRow = this.db.createRun(
      opts.projectId,
      "pipeline",
      path.join(opts.logDir),
    );
    const runId = runRow.id;
    const nativeEntrypoint = path.join(opts.repoDir, ".sandcastle", "run.mts");
    const stagedEntrypoint = path.join(
      opts.repoDir,
      ".sandcastle",
      `.mission-control-run-${runId}.mts`,
    );
    const entrypoint = existsSync(nativeEntrypoint)
      ? nativeEntrypoint
      : stagedEntrypoint;
    const shouldRemoveEntrypoint = entrypoint === stagedEntrypoint;
    if (shouldRemoveEntrypoint) {
      copyFileSync(
        path.join(opts.repoDir, ".sandcastle", "run.ts"),
        stagedEntrypoint,
      );
    }

    return new Promise((resolve, reject) => {
      const issueRepository = resolveIssueRepository(opts.issueRepository);
      const child = spawn("npx", ["tsx", entrypoint], {
        cwd: opts.repoDir,
        env: { ...process.env, ISSUE_REPOSITORY: issueRepository },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group so cancel can kill the tree
      });
      this.active.set(runId, child);
      const cleanup = () => {
        this.active.delete(runId);
        if (shouldRemoveEntrypoint) rmSync(stagedEntrypoint, { force: true });
      };

      const emit = makeSpinnerCollapsingEmitter((source, line) => {
        console.log(`[project ${opts.projectId} ${source}] ${line}`);
        this.db.addStreamEvent(runId, source, { line });
        this.bus.publish(runId, {
          type: source,
          payload: { line },
          timestamp: new Date().toISOString(),
        });
        trackAgent(this.db, runId, line);
      });

      child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));

      child.on("error", (err) => {
        cleanup();
        this.db.finishRun(runId, "failed");
        reject(err);
      });

      child.on("exit", (code, signal) => {
        cleanup();
        const wasAborted = this.aborted.delete(runId);
        const finalStatus = wasAborted
          ? "failed"
          : code === 0
            ? "done"
            : "failed";
        for (const agent of this.db.listAgents(runId)) {
          if (agent.status === "running")
            this.db.setAgentStatus(agent.id, finalStatus);
        }
        if (wasAborted) {
          this.db.finishRun(runId, "cancelled");
          resolve({ exitCode: null });
          return;
        }
        this.db.finishRun(runId, code === 0 ? "passed" : "failed");
        resolve({ exitCode: code });
      });

      // Store pid for potential cancellation.
      this.db.addStreamEvent(runId, "meta", { pid: child.pid });
    });
  }
}
