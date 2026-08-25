import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import type { EventBus } from "./bus.js";
import type { CheckResult } from "./preflight.js";
import type { Pipeline } from "./pipeline.js";
import {
  cloneRepo,
  ensureFeatureBranch,
  copySandcastleDir,
  ensureDockerImage,
  projectWorkspace,
  setupRepo,
} from "./workspace.js";
import { fetchPrdTickets } from "./github.js";
import { topologicalOrder } from "./planner.js";

export interface ApiDeps {
  db: Db;
  bus: EventBus;
  pipeline: Pipeline;
  dataDir: string;
  sandcastleTemplateDir: string;
  preflight: () => Promise<CheckResult[]>;
}

const pExecFile = promisify(execFile);

async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  await pExecFile("tar", ["-xzf", tarPath, "-C", destDir]);
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const { db, bus, pipeline, dataDir, sandcastleTemplateDir } = deps;

  app.get("/api/preflight", async (c) => c.json(await deps.preflight()));

  app.post("/api/projects", async (c) => {
    const body = await c.req.parseBody();
    const repoUrl = String(body.repo_url ?? "");
    const baseBranch = String(body.base_branch ?? "");
    const featureBranch = String(body.feature_branch ?? "");
    const prdIssueUrl = String(body.prd_issue_url ?? "");
    if (!repoUrl || !baseBranch || !featureBranch || !prdIssueUrl) {
      return c.json(
        {
          error:
            "repo_url, base_branch, feature_branch and prd_issue_url are required",
        },
        400,
      );
    }

    const project = db.createProject({
      repo_url: repoUrl,
      base_branch: baseBranch,
      feature_branch: featureBranch,
      prd_issue_url: prdIssueUrl,
    });

    // .sandcastle source: optional uploaded .tar.gz bundle, else the bundled
    // template directory (mission-control/sandcastle-template).
    let sandcastleSource = sandcastleTemplateDir;
    const sandcastleFile = body.sandcastle_dir;
    if (
      sandcastleFile &&
      typeof sandcastleFile !== "string" &&
      sandcastleFile.size > 0
    ) {
      const projectDir = path.join(dataDir, "uploads", String(project.id));
      const uploadDir = path.join(projectDir, ".sandcastle");
      fs.mkdirSync(uploadDir, { recursive: true });
      const bundlePath = path.join(projectDir, "sandcastle.tar.gz");
      fs.writeFileSync(
        bundlePath,
        Buffer.from(await sandcastleFile.arrayBuffer()),
      );
      await extractTarGz(bundlePath, projectDir);
      sandcastleSource = uploadDir;
    }

    // Provision + plan asynchronously; API returns immediately.
    void (async () => {
      await provisionAndPlan(deps, project.id, sandcastleSource);
    })().catch((err) => {
      console.error(`Project ${project.id} provisioning failed:`, err);
      db.updateProjectStatus(project.id, "failed", (err as Error).message);
    });
    return c.json(project, 201);
  });

  app.get("/api/projects", (c) => c.json(db.listProjects()));

  app.get("/api/projects/:id", (c) => {
    const project = db.getProject(Number(c.req.param("id")));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json({ ...project, tickets: db.listTickets(project.id) });
  });

  app.get("/api/projects/:id/runs", (c) => {
    const id = Number(c.req.param("id"));
    if (!db.getProject(id)) return c.json({ error: "not found" }, 404);
    return c.json(db.listRuns(id));
  });

  app.post("/api/projects/:id/cancel", (c) => {
    const id = Number(c.req.param("id"));
    pipeline.cancelProject(id);
    return c.json(db.getProject(id));
  });

  app.post("/api/projects/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    const project = db.getProject(id);
    if (!project) return c.json({ error: "not found" }, 404);
    // Re-provision if the workspace clone is missing (e.g. first clone failed).
    const repoDir = projectWorkspace(dataDir, id);
    if (!fs.existsSync(repoDir)) {
      const sandcastleSource = fs.existsSync(
        path.join(dataDir, "uploads", String(id), ".sandcastle"),
      )
        ? path.join(dataDir, "uploads", String(id), ".sandcastle")
        : sandcastleTemplateDir;
      db.updateProjectStatus(id, "provisioning");
      await provisionAndPlan(deps, id, sandcastleSource).catch((err) => {
        console.error(`Project ${id} reprovisioning failed:`, err);
        db.updateProjectStatus(id, "failed", (err as Error).message);
      });
      return c.json({ ok: true });
    }
    // Workspace exists but was never set up (e.g. failed before install/build).
    const logSetup = (pid: number) => (source: string, line: string) =>
      console.log(`[project ${pid} setup:${source}] ${line}`);
    if (
      !fs.existsSync(path.join(repoDir, "node_modules")) &&
      fs.existsSync(path.join(repoDir, "package.json"))
    ) {
      await setupRepo(repoDir, logSetup(id));
    }
    await ensureDockerImage(repoDir, logSetup(id)).catch((err) => {
      console.error(`Project ${id} image build failed:`, err);
    });
    pipeline.resetForRetry(id);
    void startPipeline(deps, id, true);
    return c.json({ ok: true });
  });

  app.get("/api/projects/:id/agents", (c) => {
    const id = Number(c.req.param("id"));
    const runs = db.listRuns(id);
    const latest = runs.at(-1);
    if (!latest) return c.json([]);
    return c.json({ run: latest, agents: db.listAgents(latest.id) });
  });

  app.get("/api/agents/:id/log", (c) => {
    const agent = db.sqlite
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(Number(c.req.param("id"))) as
      | { id: number; log_file: string | null; project_id?: never }
      | undefined;
    if (!agent) return c.json({ error: "not found" }, 404);
    const run = db.sqlite
      .prepare(
        `SELECT r.* FROM runs r JOIN agents a ON a.run_id = r.id WHERE a.id = ?`,
      )
      .get(Number(c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!agent.log_file)
      return c.json({ lines: [], status: "no log file yet" });
    const repoDir = projectWorkspace(
      deps.dataDir,
      (run as { project_id: number }).project_id,
    );
    const logPath = agent.log_file.startsWith("/")
      ? agent.log_file
      : path.join(repoDir, agent.log_file);
    if (!fs.existsSync(logPath))
      return c.json({ lines: [], status: "log file not created yet" });
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").slice(-500);
    return c.json({ lines, status: "ok" });
  });

  let aborted = false;
  app.get("/api/runs/:id/events", (c) => {
    const runId = Number(c.req.param("id"));
    // Replay from the DB on a short poll — single source of truth, no
    // double-delivery from a concurrent live subscription.
    return streamSSE(c, async (stream) => {
      let cursor = 0;
      try {
        while (!aborted && !stream.aborted) {
          const events = db.listStreamEvents(runId);
          for (const evt of events.slice(cursor)) {
            await stream.writeSSE({ data: evt.payload, event: evt.type });
          }
          if (events.length > cursor) cursor = events.length;
          await stream.sleep(700);
        }
      } catch {
        /* client disconnected */
      }
    });
  });

  return app;
}

async function provisionAndPlan(
  deps: ApiDeps,
  projectId: number,
  sandcastleSource: string,
): Promise<void> {
  const { db, bus } = deps;
  const project = db.getProject(projectId)!;

  // Setup run: captures clone/install/image-build/planning output for the UI.
  const setupRun = db.createRun(projectId, "setup");
  const emit = (source: string, line: string): void => {
    console.log(`[project ${projectId} setup:${source}] ${line}`);
    db.addStreamEvent(setupRun.id, source, { line });
    bus.publish(setupRun.id, {
      type: source,
      payload: { line },
      timestamp: new Date().toISOString(),
    });
  };
  try {
    db.updateProjectStatus(projectId, "provisioning");
    emit("meta", `Cloning ${project.repo_url} (base: ${project.base_branch})…`);
    const repoDir = projectWorkspace(deps.dataDir, projectId);
    await cloneRepo(project.repo_url, repoDir, project.base_branch);
    emit("meta", `Ensuring feature branch ${project.feature_branch}…`);
    await ensureFeatureBranch(repoDir, project.feature_branch);
    emit(
      "meta",
      sandcastleSource === deps.sandcastleTemplateDir
        ? "Copying bundled .sandcastle template…"
        : "Copying uploaded .sandcastle bundle…",
    );
    copySandcastleDir(sandcastleSource, repoDir);

    db.updateProjectStatus(projectId, "installing");
    emit("meta", "Installing dependencies and building repo…");
    await setupRepo(repoDir, emit);
    emit("meta", "Checking sandbox Docker image…");
    await ensureDockerImage(repoDir, emit);

    db.updateProjectStatus(projectId, "planning");
    emit("meta", `Fetching PRD sub-issues from ${project.prd_issue_url}…`);
    const tickets = await fetchPrdTickets(project.prd_issue_url);
    const ordered = topologicalOrder(
      tickets.map((t) => ({
        ghIssueNumber: t.number,
        title: t.title,
        blockers: t.blockers,
      })),
    );
    db.replaceTickets(
      projectId,
      tickets
        .filter((t) => ordered.some((o) => o.ghIssueNumber === t.number))
        .map((t) => ({
          gh_issue_number: t.number,
          title: t.title,
          body: t.body,
          blockers: JSON.stringify(t.blockers),
        })),
    );
    emit("meta", `Planned ${ordered.length} ticket(s) in dependency order.`);
    db.finishRun(setupRun.id, "passed");
  } catch (err) {
    db.finishRun(setupRun.id, "failed");
    throw err;
  }

  await startPipeline(deps, projectId);
}

async function startPipeline(
  deps: ApiDeps,
  projectId: number,
  force = false,
): Promise<void> {
  try {
    await deps.pipeline.startProject(projectId, { force });
  } catch (err) {
    console.error(err);
    deps.db.updateProjectStatus(projectId, "failed", (err as Error).message);
  }
}
