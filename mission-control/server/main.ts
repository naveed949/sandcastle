import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "./db.js";
import { EventBus } from "./bus.js";
import { Pipeline } from "./pipeline.js";
import { createApi } from "./api.js";
import { runPreflight, formatPreflight } from "./preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataDir =
  process.env.MISSION_CONTROL_DATA_DIR ??
  path.join(process.cwd(), ".mission-control");
const port = Number(process.env.MISSION_CONTROL_PORT ?? 3111);

const db = new Db(path.join(dataDir, "mission-control.db"));

// Recover runs/projects orphaned by a restart: their child processes are gone.
for (const project of db.listProjects()) {
  for (const run of db.listRuns(project.id)) {
    if (run.status === "running") db.finishRun(run.id, "failed");
  }
  if (
    ["provisioning", "installing", "planning", "running"].includes(
      project.status,
    )
  ) {
    db.updateProjectStatus(
      project.id,
      "failed",
      "Interrupted by Mission Control restart — retry to resume",
    );
    console.log(
      `Project ${project.id} was interrupted by restart — marked failed for retry.`,
    );
  }
}

const bus = new EventBus();
const pipeline = new Pipeline(db, { dataDir }, bus);

const sandcastleTemplateDir =
  process.env.MISSION_CONTROL_SANDCASTLE_TEMPLATE ??
  path.join(__dirname, "..", "..", "sandcastle-template");

// Preflight at startup: hard-fail on missing essentials (git/gh/docker/tsx).
const checks = await runPreflight({ sandcastleTemplateDir });
console.log("Preflight:\n" + formatPreflight(checks));
const failedRequired = checks.filter((c) => c.required && !c.ok);
if (failedRequired.length > 0) {
  console.error(
    `\nRefusing to start — required checks failed: ${failedRequired.map((c) => c.name).join(", ")}`,
  );
  process.exit(1);
}

const app = createApi({
  db,
  bus,
  pipeline,
  dataDir,
  sandcastleTemplateDir,
  preflight: () => runPreflight({ sandcastleTemplateDir }),
});

// Serve static frontend.
const webDir = path.join(__dirname, "..", "..", "web");
app.get("/", (c) => {
  const index = path.join(webDir, "index.html");
  if (existsSync(index)) {
    return c.html(readFileSync(index, "utf8"));
  }
  return c.text("Mission Control API. UI not built — see mission-control/web.");
});
app.get("/app.js", (c) =>
  c.body(readFileSync(path.join(webDir, "app.js"), "utf8"), 200, {
    "Content-Type": "text/javascript",
  }),
);
app.get("/style.css", (c) =>
  c.body(readFileSync(path.join(webDir, "style.css"), "utf8"), 200, {
    "Content-Type": "text/css",
  }),
);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Mission Control listening on http://localhost:${port}`);
  console.log(`Data dir: ${dataDir}`);
});
