# Mission Control — Plan

> **Implementation note (updated):** MC no longer reimplements the
> implement/review/merge loop with library calls. It executes each repo's own
> `.sandcastle/run.ts` as a child process and wraps it with provisioning,
> ticket tracking, GitHub state sync, PR creation, and live log streaming.
> See README.md for current behavior.

A self-hosted background service + web UI that turns a **PRD** (GitHub issue with
sub-issue tickets) into a fully implemented feature branch and an open PR, by
driving `@ai-hero/sandcastle` runs on a cloned target repo.

## What it does (happy path)

1. User submits a **Project**: git URL, base branch, feature branch name,
   PRD issue URL, `.sandcastle` directory (upload).
2. Mission Control clones the repo into its workspace dir, creates/checks out
   the feature branch if missing.
3. Copies the provided `.sandcastle` directory into the clone.
4. Fetches the PRD issue's **sub-issues** via `gh` GraphQL; resolves
   dependency order from native blocked-by edges, falling back to parsing
   "Blocked by" in issue bodies.
5. For each ready ticket (all blockers done), in dependency order:
   - Runs sandcastle `run()` with a prompt built from ticket content (+ PRD context).
   - Runs a reviewer-agent pass inside the same sandbox; review feedback feeds
     bounded fix iterations.
   - On pass: merges commits directly into the feature branch, closes the
     GitHub issue with a comment referencing the merge commit SHA.
   - On failure: retry N times (configurable), then mark failed and halt the
     project pipeline pending user retry/cancel.
6. When all tickets are closed: opens one PR (feature → base) summarizing the
   PRD and listing closed issues. Marks project done. User merges manually.

## Architecture

```
mission-control/
├── server/            # Hono backend (long-running node process)
│   ├── db.ts          # SQLite (better-sqlite3) — projects, tickets, runs, logs
│   ├── github.ts      # gh CLI wrapper: sub-issues, blocked-by edges, close+comment, create PR
│   ├── workspace.ts   # clone / branch setup / .sandcastle copy / cleanup
│   ├── planner.ts     # topological sort of tickets (edges → frontier)
│   ├── pipeline.ts    # per-project orchestrator: state machine over tickets
│   ├── runner.ts      # sandcastle run() + reviewer pass wiring (onAgentStreamEvent → SSE bus + log file)
│   └── api.ts         # REST + SSE endpoints, no auth (v1)
├── web/               # Vite + React frontend
│   ├── ProjectList    # all projects, status badges
│   ├── ProjectDetail  # DAG/ticket list w/ per-ticket state, live agent output (SSE), log replay
│   ├── NewProject     # submission form (URL, branches, PRD URL, .sandcastle upload)
└── PLAN.md
```

Runs as a single process (`node mission-control/server`), serves both API and
built frontend static files. Global concurrency limiter (default 2–3 parallel
sandcastle runs across all projects).

## Data model (SQLite)

- **project**: id, repo_url, base_branch, feature_branch, prd_issue_url,
  status (`provisioning | planning | running | pr_open | done | failed | cancelled`),
  created_at.
- **ticket**: id, project_id, gh_issue_number, title, body, blockers (json),
  status (`blocked | ready | implementing | reviewing | merging | done | failed`),
  attempts, merge_commit_sha.
- **run**: id, ticket_id, kind (`implement | review`), iteration count,
  log_file_path, status, started/finished_at.
- **stream_event**: id, run_id, type, payload, timestamp (for replay).

## Pipeline state machine (per project)

`provisioning` → `planning` → `running` ⇄ (per-ticket loop) → `pr_open` → done
(failed | cancelled from any state).

Ticket frontier = tickets whose blockers are all `done`. Within the frontier,
tickets run sequentially per project (v1; parallelize later since sandcastle
worktrees make it safe).

## Sandcastle integration

Per implement run:

```ts
await run({
  agent: claudeCode(model),
  sandbox: docker({ imageName: ... }),
  cwd: <clone path>,
  branchStrategy: { type: "merge-to-head" }, // temp branch → feature branch merge handled by pipeline? see open Qs
  promptFile: ".sandcastle/prompt.md",
  promptArgs: { ISSUE_NUMBER, TICKET_BODY, PRD_CONTEXT },
  maxIterations: N,
  logging: { type: "file", path: ..., onAgentStreamEvent: evt => bus.publish(runId, evt) },
});
```

Reviewer pass uses `createSandbox()` reuse pattern (implement then review on
the same branch/container) or a second `run()` against the accumulated diff;
review verdict parsed via `Output.object()` structured output
(`{ verdict: "pass" | "fix", feedback?: string }`). Bounded: ≤ R review-fix rounds.

Merge into feature branch: after a passing run, collect commits and fast-forward/
regular-merge into the checked-out feature branch (sandcastle's merge-to-host
already handles this for merge-to-head strategy).

## Prerequisites (documented)

- Remote dev box: git, Docker, Node ≥ 22, `gh` authenticated with push access
  to target repos, tsx.
- Provided `.sandcastle` must contain working `.env` (API keys) and Dockerfile.

## UI actions (v1)

- Submit project; cancel project; retry failed ticket.
- Live SSE stream of current run's agent events; replay historical logs.
- View ticket DAG/status, PR link when opened.

## Build order (tracer bullets)

1. **Skeleton**: Hono server + SQLite schema + Vite app shell; submit-project
   form persists a project row.
2. **Provisioning**: workspace.ts — clone, branch create/checkout, copy
   `.sandcastle`; project moves provisioning→ready (verify manually).
3. **Planning**: github.ts sub-issue fetch + blocked-by resolution +
   topological sort; render ticket DAG in UI.
4. **First implementation run**: wire sandcastle `run()` for one unblocked
   ticket; show live SSE stream in UI.
5. **Review loop + merge + issue close**: reviewer structured-output pass,
   bounded fix rounds, merge to feature branch, `gh issue close --comment`.
6. **Full pipeline**: frontier loop across tickets, retries, failure halt.
7. **PR creation**: final `gh pr create` with PRD summary + closed issues;
   project → done.
8. **Hardening**: concurrency limiter, cancellation, log replay page, README.

## Open questions deferred

- Exact branch strategy for landing ticket work onto the feature branch
  (branch-per-ticket merged by pipeline vs merge-to-head) — decide during
  build order step 4 with a prototype.
- Parallelizing frontier tickets within a project (post-v1).
