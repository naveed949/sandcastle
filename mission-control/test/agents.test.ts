import { describe, expect, it, beforeEach } from "vitest";
import { Db } from "../server/db.js";
import { trackAgent } from "../server/agents.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db: Db;
let runId: number;

beforeEach(() => {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mc-agents-")),
    "t.db",
  );
  db = new Db(dbPath);
  const p = db.createProject({
    repo_url: "u",
    base_branch: "m",
    feature_branch: "f",
    prd_issue_url: "i",
  });
  runId = db.createRun(p.id, "pipeline").id;
});

describe("trackAgent", () => {
  it("creates agent cards from start lines and attaches log files", () => {
    trackAgent(db, runId, "[Planner] Started on branch tmp/prd-v1");
    trackAgent(db, runId, "tail -f .sandcastle/logs/tmp-prd-v1-planner.log");
    trackAgent(
      db,
      runId,
      "[Implementer #26] Started on branch sandcastle/issue-26",
    );
    trackAgent(db, runId, "tail -f .sandcastle/logs/impl.log");

    const agents = db.listAgents(runId);
    expect(agents.map((a) => a.name)).toEqual(["Planner", "Implementer #26"]);
    expect(agents[0].log_file).toContain("tmp-prd-v1-planner.log");
    expect(agents[1].log_file).toContain("impl.log");
    // Phase change: Planner finished when Implementer started.
    expect(agents[0].status).toBe("done");
    expect(agents[1].status).toBe("running");
  });

  it("keeps same-phase agents running in parallel", () => {
    trackAgent(db, runId, "[Implementer #26] Started on branch b26");
    trackAgent(db, runId, "[Implementer #27] Started on branch b27");
    const agents = db.listAgents(runId);
    expect(agents.map((a) => a.status)).toEqual(["running", "running"]);
  });

  it("marks all done on merge/all-done markers", () => {
    trackAgent(db, runId, "[Merger] Started on branch main");
    trackAgent(db, runId, "Branches merged.");
    expect(db.listAgents(runId).every((a) => a.status === "done")).toBe(true);
  });
});
