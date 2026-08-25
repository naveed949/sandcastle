import { describe, expect, it, beforeEach } from "vitest";
import { Db } from "../server/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mc-")), "test.db");
});

describe("Db", () => {
  it("creates and lists projects", () => {
    const db = new Db(dbPath);
    const p = db.createProject({
      repo_url: "https://github.com/o/r",
      base_branch: "main",
      feature_branch: "feat/x",
      prd_issue_url: "https://github.com/o/r/issues/1",
    });
    expect(p.status).toBe("provisioning");
    expect(db.listProjects()).toHaveLength(1);
    db.updateProjectStatus(p.id, "running");
    expect(db.getProject(p.id)!.status).toBe("running");
  });

  it("replaces tickets with json blockers", () => {
    const db = new Db(dbPath);
    const p = db.createProject({
      repo_url: "u",
      base_branch: "main",
      feature_branch: "f",
      prd_issue_url: "i",
    });
    db.replaceTickets(p.id, [
      {
        gh_issue_number: 2,
        title: "B",
        body: "b",
        blockers: JSON.stringify([1]),
      },
      { gh_issue_number: 1, title: "A", body: "a", blockers: "[]" },
    ]);
    const tickets = db.listTickets(p.id);
    expect(tickets).toHaveLength(2);
    const t1 = tickets.find((t) => t.gh_issue_number === 1)!;
    const t2 = tickets.find((t) => t.gh_issue_number === 2)!;
    expect(JSON.parse(t1.blockers)).toEqual([]);
    expect(JSON.parse(t2.blockers)).toEqual([1]);

    db.replaceTickets(p.id, [
      { gh_issue_number: 9, title: "C", body: "c", blockers: "[]" },
    ]);
    expect(db.listTickets(p.id)).toHaveLength(1);
  });

  it("tracks runs and stream events", () => {
    const db = new Db(dbPath);
    const p = db.createProject({
      repo_url: "u",
      base_branch: "m",
      feature_branch: "f",
      prd_issue_url: "i",
    });
    db.replaceTickets(p.id, [
      { gh_issue_number: 1, title: "A", body: "a", blockers: "[]" },
    ]);
    const run = db.createRun(p.id, "pipeline");
    db.addStreamEvent(run.id, "stdout", { line: "hello" });
    db.finishRun(run.id, "passed");
    expect(db.getRun(run.id)!.status).toBe("passed");
    expect(db.listStreamEvents(run.id)[0].payload).toContain("hello");
    expect(db.listRuns(p.id)).toHaveLength(1);
  });

  it("retry resets status and attempts", () => {
    const db = new Db(dbPath);
    const p = db.createProject({
      repo_url: "u",
      base_branch: "m",
      feature_branch: "f",
      prd_issue_url: "i",
    });
    db.replaceTickets(p.id, [
      { gh_issue_number: 1, title: "A", body: "a", blockers: "[]" },
    ]);
    const ticket = db.listTickets(p.id)[0];
    db.incrementTicketAttempts(ticket.id);
    db.updateTicketStatus(ticket.id, "failed");
    db.resetTicketForRetry(ticket.id);
    const reset = db.getTicket(ticket.id)!;
    expect(reset.status).toBe("ready");
    expect(reset.attempts).toBe(0);
  });
});
