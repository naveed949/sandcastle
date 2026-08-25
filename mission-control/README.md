# Mission Control

A self-hosted background service + web UI that turns a PRD (GitHub issue with
sub-issue tickets) into a fully implemented feature branch and an open PR, by
driving `@ai-hero/sandcastle` runs on cloned target repos.

## How it works

1. Submit a project: repo URL, base branch, feature branch name, PRD issue URL.
   A `.sandcastle` bundle (.tar.gz) is optional — the bundled
   `mission-control/sandcastle-template` (copied from the sandcastle repo's own
   `.sandcastle`) is used when no upload is provided.
2. Mission Control clones the repo, creates/checks out the feature branch, and
   copies `.sandcastle/` in.
3. It fetches the PRD's sub-issues via `gh` GraphQL and orders them by native
   blocked-by edges (falling back to parsing the "Blocked by" body section).
4. It stages the repo's `.sandcastle/run.ts` as a run-scoped `.mts` entrypoint
   and executes it with `tsx`, preserving ESM semantics even when the submitted
   repository is CommonJS. The template owns planning, implementation, review
   and merging. MC streams its stdout/stderr live to the UI.
5. When run.ts exits, MC syncs ticket state from GitHub (the template's agents
   close issues). If all sub-issues are closed it opens one PR (feature → base)
   for you to merge; otherwise the project is marked failed for retry.

## Prerequisites (on the dev box)

- git, Docker, Node ≥ 22
- `gh` authenticated (`gh auth login`) with push access to target repos
- A built sandcastle image (e.g. `sandcastle:local`) — set via
  `MISSION_CONTROL_IMAGE`

## Running

```bash
cd mission-control
npm install
npm run build
npm start   # http://localhost:3111
```

### Startup preflight

On start MC validates the box and refuses to launch if any **required** check
fails: `git`, `gh` (installed _and_ authenticated), Docker daemon, `tsx` via
npx. It warns (but starts) if no `sandcastle:*` Docker image exists or the
template `.env` lacks an API key. Results are printed at startup and available
at `GET /api/preflight`.

### Environment

| Variable                              | Default                 | Purpose                                                      |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `MISSION_CONTROL_DATA_DIR`            | `./.mission-control`    | SQLite DB, uploads, workspace clones                         |
| `MISSION_CONTROL_PORT`                | `3111`                  | HTTP port                                                    |
| `MISSION_CONTROL_SANDCASTLE_TEMPLATE` | `./sandcastle-template` | `.sandcastle` dir copied into clones when no bundle uploaded |
| `ISSUE_REPOSITORY`                    | submitted `repo_url`    | Override issue authority as `owner/repo` for every agent     |

Agent/model/image settings live in each repo's `.sandcastle/run.ts`, Dockerfile
and `.env`. Mission Control normalizes the repository submitted in the UI to
`owner/repo`, passes it as `ISSUE_REPOSITORY`, and the bundled template exposes
it to every sandbox as `GH_REPO`. A process-level `ISSUE_REPOSITORY` overrides
the UI-derived default.

## API

- `POST /api/projects` — multipart form: `repo_url`, `base_branch`,
  `feature_branch`, `prd_issue_url`, optional `sandcastle_dir` (.tar.gz file)
- `GET /api/projects`, `GET /api/projects/:id`
- `POST /api/projects/:id/cancel` — kills the active `run.ts` process tree and
  force-removes Sandcastle containers mounted from that project's workspace
- `GET /api/projects/:id/runs`
- `POST /api/projects/:id/retry`
- `GET /api/runs/:id/events` — SSE stream of agent events (replayed from DB)

## Tests

```bash
npm test
```
