import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type ProjectStatus =
  | "provisioning"
  | "installing"
  | "planning"
  | "running"
  | "pr_open"
  | "done"
  | "failed"
  | "cancelled";

export type TicketStatus =
  | "blocked"
  | "ready"
  | "implementing"
  | "reviewing"
  | "merging"
  | "done"
  | "failed";

export interface ProjectRow {
  id: number;
  repo_url: string;
  base_branch: string;
  feature_branch: string;
  prd_issue_url: string;
  status: ProjectStatus;
  pr_url: string | null;
  error: string | null;
  created_at: string;
}

export interface TicketRow {
  id: number;
  project_id: number;
  gh_issue_number: number;
  title: string;
  body: string;
  blockers: string; // JSON array of gh issue numbers
  status: TicketStatus;
  attempts: number;
  merge_commit_sha: string | null;
}

export interface RunRow {
  id: number;
  project_id: number;
  kind: "setup" | "pipeline";
  status: "running" | "passed" | "failed" | "cancelled";
  log_file_path: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface StreamEventRow {
  id: number;
  run_id: number;
  type: string;
  payload: string;
  timestamp: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  feature_branch TEXT NOT NULL,
  prd_issue_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  pr_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  gh_issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  blockers TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'blocked',
  attempts INTEGER NOT NULL DEFAULT 0,
  merge_commit_sha TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  log_file_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  branch TEXT,
  log_file TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface NewProject {
  repo_url: string;
  base_branch: string;
  feature_branch: string;
  prd_issue_url: string;
}

export class Db {
  readonly sqlite: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.migrate();
    this.sqlite.exec(SCHEMA);
  }

  /** Drop-and-recreate dev-stage schema when columns changed (no data preservation). */
  private migrate(): void {
    const runsCols = this.sqlite.prepare(`PRAGMA table_info(runs)`).all() as {
      name: string;
    }[];
    const hasRuns = runsCols.length > 0;
    if (hasRuns && !runsCols.some((c) => c.name === "project_id")) {
      // Pre-refactor schema: runs keyed by ticket_id.
      this.sqlite.exec(`DROP TABLE IF EXISTS stream_events; DROP TABLE runs;`);
    }
  }

  createProject(p: NewProject): ProjectRow {
    const info = this.sqlite
      .prepare(
        `INSERT INTO projects (repo_url, base_branch, feature_branch, prd_issue_url)
         VALUES (?, ?, ?, ?)`,
      )
      .run(p.repo_url, p.base_branch, p.feature_branch, p.prd_issue_url);
    return this.getProject(Number(info.lastInsertRowid))!;
  }

  getProject(id: number): ProjectRow | undefined {
    return this.sqlite
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;
  }

  listProjects(): ProjectRow[] {
    return this.sqlite
      .prepare(`SELECT * FROM projects ORDER BY id DESC`)
      .all() as ProjectRow[];
  }

  updateProjectStatus(id: number, status: ProjectStatus, error?: string): void {
    this.sqlite
      .prepare(`UPDATE projects SET status = ?, error = ? WHERE id = ?`)
      .run(status, error ?? null, id);
  }

  setProjectPrUrl(id: number, prUrl: string): void {
    this.sqlite
      .prepare(`UPDATE projects SET pr_url = ? WHERE id = ?`)
      .run(prUrl, id);
  }

  replaceTickets(
    projectId: number,
    tickets: Omit<
      TicketRow,
      "id" | "project_id" | "status" | "attempts" | "merge_commit_sha"
    >[],
  ): void {
    const insert = this.sqlite.prepare(
      `INSERT INTO tickets (project_id, gh_issue_number, title, body, blockers, status)
       VALUES (?, ?, ?, ?, ?, 'blocked')`,
    );
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(`DELETE FROM tickets WHERE project_id = ?`)
        .run(projectId);
      for (const t of tickets) {
        const blockers =
          typeof t.blockers === "string"
            ? t.blockers
            : JSON.stringify(t.blockers);
        insert.run(projectId, t.gh_issue_number, t.title, t.body, blockers);
      }
    });
    tx();
  }

  listTickets(projectId: number): TicketRow[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM tickets WHERE project_id = ? ORDER BY gh_issue_number`,
      )
      .all(projectId) as TicketRow[];
  }

  getTicket(id: number): TicketRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as
      | TicketRow
      | undefined;
  }

  updateTicketStatus(id: number, status: TicketStatus): void {
    this.sqlite
      .prepare(`UPDATE tickets SET status = ? WHERE id = ?`)
      .run(status, id);
  }

  incrementTicketAttempts(id: number): void {
    this.sqlite
      .prepare(`UPDATE tickets SET attempts = attempts + 1 WHERE id = ?`)
      .run(id);
  }

  setTicketMergeCommit(id: number, sha: string): void {
    this.sqlite
      .prepare(`UPDATE tickets SET merge_commit_sha = ? WHERE id = ?`)
      .run(sha, id);
  }

  resetTicketForRetry(id: number): void {
    this.sqlite
      .prepare(`UPDATE tickets SET status = 'ready', attempts = 0 WHERE id = ?`)
      .run(id);
  }

  createRun(
    projectId: number,
    kind: RunRow["kind"],
    logFilePath?: string,
  ): RunRow {
    const info = this.sqlite
      .prepare(
        `INSERT INTO runs (project_id, kind, log_file_path) VALUES (?, ?, ?)`,
      )
      .run(projectId, kind, logFilePath ?? null);
    return this.getRun(Number(info.lastInsertRowid))!;
  }

  getRun(id: number): RunRow | undefined {
    return this.sqlite.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
  }

  finishRun(id: number, status: RunRow["status"]): void {
    this.sqlite
      .prepare(
        `UPDATE runs SET status = ?, finished_at = datetime('now') WHERE id = ?`,
      )
      .run(status, id);
  }

  listRuns(projectId: number): RunRow[] {
    return this.sqlite
      .prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY id`)
      .all(projectId) as RunRow[];
  }

  addStreamEvent(runId: number, type: string, payload: unknown): void {
    this.sqlite
      .prepare(
        `INSERT INTO stream_events (run_id, type, payload) VALUES (?, ?, ?)`,
      )
      .run(runId, type, JSON.stringify(payload));
  }

  listStreamEvents(runId: number): StreamEventRow[] {
    return this.sqlite
      .prepare(`SELECT * FROM stream_events WHERE run_id = ? ORDER BY id`)
      .all(runId) as StreamEventRow[];
  }

  addAgent(runId: number, name: string, branch?: string): number {
    const info = this.sqlite
      .prepare(`INSERT INTO agents (run_id, name, branch) VALUES (?, ?, ?)`)
      .run(runId, name, branch ?? null);
    return Number(info.lastInsertRowid);
  }

  setAgentLogFile(id: number, logFile: string): void {
    this.sqlite
      .prepare(`UPDATE agents SET log_file = ? WHERE id = ?`)
      .run(logFile, id);
  }

  setAgentStatus(id: number, status: "running" | "done" | "failed"): void {
    this.sqlite
      .prepare(`UPDATE agents SET status = ? WHERE id = ?`)
      .run(status, id);
  }

  listAgents(runId: number): AgentRow[] {
    return this.sqlite
      .prepare(`SELECT * FROM agents WHERE run_id = ? ORDER BY id`)
      .all(runId) as AgentRow[];
  }

  latestAgent(runId: number): AgentRow | undefined {
    return this.sqlite
      .prepare(`SELECT * FROM agents WHERE run_id = ? ORDER BY id DESC LIMIT 1`)
      .get(runId) as AgentRow | undefined;
  }
}

export interface AgentRow {
  id: number;
  run_id: number;
  name: string;
  branch: string | null;
  log_file: string | null;
  status: "running" | "done" | "failed";
  started_at: string;
}
