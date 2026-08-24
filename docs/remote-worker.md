# Remote worker operations

This guide runs one Sandcastle worker on one remote development box. The POC
intentionally supports one polling loop and one active execution. A kernel-owned
`flock(2)` lock rejects a second live instance that uses the same state directory
and is released automatically on process or box exit. Install the Linux
`util-linux` package so the `flock` command is available.

## Persistent layout

Choose a durable volume such as `/srv/sandcastle-worker` and derive every path
with `workerServicePaths()`:

```text
/srv/sandcastle-worker/
  state/worker.json
  state/service.lock
  policy/worker.json
  diagnostics/worker.jsonl
  operator/commands.jsonl
  records/
  repositories/<owner>/<repository>/
```

The repository directories contain caches, Sandcastle logs, deterministic
branches, and worktrees preserved for recovery. The state file, diagnostics,
records, repository caches, and worktrees must all live on the durable volume;
do not place any of them under `/tmp` or an ephemeral deployment directory.
`serviceLockFilePath` is a stable lock identity derived from this root. The empty
lock file may remain after exit, but the kernel lock never does; do not infer
service liveness from the file alone.

Restrict the root to the service account (`chmod 0700`) and back up the entire
root as one consistency unit while the service is stopped. A state-only backup
is insufficient because attempt evidence references records, logs, caches, and
worktrees in the same root.

## Credentials

Use a dedicated service account and a fine-grained GitHub token limited to the
approved repositories. Grant read access to metadata and issues for discovery,
and only the contents/pull-request permissions needed to push branches and
create draft pull requests. Third-party exact-task work still needs destination
repository permission; task authorship is never authorization.

Store the token in a root-owned service environment file, for example
`/etc/sandcastle-worker.env` with mode `0600`. Pass it only to the read-only
GitHub source and the guarded publisher. Do not put tokens in worker
configuration, prompt templates, repository `.sandcastle/.env` files, command
profiles, service arguments, or the agent/sandbox environment.

## Startup and shutdown

Use `createMissionControlHost()` as the operator-owned production entry point.
It validates the existing worker policy and host settings before constructing
the task source, state store, repository manager, execution engine, publisher,
diagnostics, and `WorkerService`. It derives one `WorkerServicePaths` value from
`workspaceRoot`, uses its `recordsRoot` for execution evidence, and uses its
`serviceLockFilePath` for the same kernel-owned single-instance lock as the
standalone service.

Keep GitHub credentials in the server-side `github.token` setting. Do not put
that token in `WorkerConfiguration`, `agentRunOptions`, command profiles, or
the browser-visible overview. The host binds to `127.0.0.1` by default; set
`server.bindAddress` explicitly only for an operator-controlled private ingress.

The host serves a responsive overview at `GET /api/v1/overview` and a compact
status response at `GET /api/v1/status`. Both expose the worker's current mode,
monotonic command revision, and pause state; the overview also includes the
active attempt, cycle timing, recovery warnings, and counts for the diagnostic
operational states. It rebuilds counts from the durable worker state and
append-only diagnostics, so it is disposable and cannot become a second source
of scheduling authority.

Mission Control also exposes the disposable inspection projection through
`GET /api/v1/tasks`, `GET /api/v1/queue`, `GET /api/v1/attempts`, and
`GET /api/v1/attempts/:attemptId`. Task views retain repository-qualified
identity, source and base revisions, authorization and eligibility decisions,
dependencies, parent PRD references, execution identity, and profile/prompt
digests. Attempt views correlate claims and leases with diagnostics, lifecycle
outcomes, retained execution records, verification summaries, commits, and
draft pull-request evidence. The queue order is copied from worker diagnostics;
the browser never computes a competing priority.

`GET /api/v1/events` is a Server-Sent Events stream. Events have monotonically
ordered numeric IDs and reconnect using `Last-Event-ID`, so acknowledged events
are not duplicated. Evidence is returned only through opaque identifiers from
an attempt view or the scoped route
`/api/v1/tasks/:taskId/attempts/:attemptId/evidence/:evidenceId`. The host
checks configured durable roots and real paths before reading a record or log;
absolute paths, traversal, missing files, symbolic-link escapes, task bodies,
prompt templates, credentials, and arbitrary repository browsing are not
available through the operator API.

The guarded command endpoint is `POST /api/v1/commands` (the compatibility path
`/api/v1/control` has the same fixed allowlist). Its JSON body must contain
`commandId`, `expectedRevision`, `command` (`run-now`, `pause`, `resume`,
`cancel`, `retry`, `acknowledge`, or `recover` with `recoveryAction`), and a
non-empty operator `reason`;
cancellation and recovery additionally require `attemptId`. Manual-intervention
acknowledgement also requires an operator identity. Requests are
revision-checked and idempotent. A stale
revision returns `stale_revision` without changing worker state, while a
repeated command ID returns the retained outcome without repeating its side
effect. Pause only takes effect after the current polling cycle reaches a safe
boundary and never aborts an active agent invocation. Resume reuses the
existing service lock and polling loop. Cancellation delegates to the
execution abort signal, so the normal attempt evidence and interrupted outcome
are retained. `retry` is accepted only for an expired, unstarted claim with the
worker's `safe_retry` disposition; it refreshes the task through the normal
claim boundary before creating a new attempt. Live unstarted claims are
`safe_resume` and started claims are `manual_intervention`, so neither can be
retried by this command. Acknowledgement records the operator, reason, command
identity, expected revision, and timestamp in the append-only audit, without
editing attempts, outcomes, evidence, leases, branches, records, or task state.
Recovery rejections expose stable reason codes. Requests and outcomes are
retained in append-only, secret-redacted `operator/commands.jsonl`; the audit
is not a generic state-transition or shell-command interface.

Staged policy administration uses `GET /api/v1/policy` for the safe current
projection, followed by `POST /api/v1/policy/validate` and
`POST /api/v1/policy/preview`. The preview contains a deterministic semantic
diff and redacted dry-run impact; it does not return task bodies, comments,
prompt contents, or credentials. `POST /api/v1/policy/apply` requires the
preview ID, command ID, expected worker revision, proposed policy, and an
operator reason. The default `policy/worker.json` is written atomically, and
preview/request/outcome records are appended to the operator audit. Invalid,
stale, and unpreviewed changes fail closed. Exact-task grants remain scoped to
their repository, kind, and number; discovered task content never becomes
authorization policy.

For a standalone worker without the HTTP surface, compose the lower-level
boundaries directly as shown below. Use the same `workspaceRoot` for
`workerServicePaths()` and `createWorkerRepositoryManager()`, and use the
derived `recordsRoot` for `createWorkerExecutionEngine()`.

Handle both `SIGINT` and `SIGTERM` by calling `service.stop()`. Shutdown stops
new dispatch, interrupts the poll wait, and delegates active cancellation to
Sandcastle. Await `start()` so the process remains alive until shutdown is
complete.

Example systemd unit:

```ini
[Unit]
Description=Sandcastle repository worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sandcastle
Group=sandcastle
WorkingDirectory=/opt/sandcastle-worker
EnvironmentFile=/etc/sandcastle-worker.env
ExecStart=/usr/bin/node /opt/sandcastle-worker/worker.mjs
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

Start with `systemctl enable --now sandcastle-worker`. Stop with
`systemctl stop sandcastle-worker`; do not use `kill -9` during normal
operation because it bypasses controlled cancellation.

## Upgrade and backup

1. Stop the service and confirm the process exited.
2. Back up `/srv/sandcastle-worker` as one unit.
3. Install the pinned application and dependency versions in a new release
   directory.
4. Run typechecking and the worker's deterministic tests.
5. Atomically update the `/opt/sandcastle-worker` release link.
6. Start the service and inspect the first diagnostics events.

Rollback by stopping the service, restoring the previous release link, and
starting it again. Restore durable data only when data corruption is confirmed;
retained recovery classifications should normally be handled in place.

## Failure inspection

Inspect recent state transitions with:

```bash
tail -n 100 /srv/sandcastle-worker/diagnostics/worker.jsonl
jq '.attempts[] | {attemptId, status, claim, outcomes}' \
  /srv/sandcastle-worker/state/worker.json
```

For `manual_intervention`, inspect the attempt's outcome evidence, structured
record, Sandcastle run log, deterministic branch, and preserved worktree before
deciding whether to acknowledge the review, create a deliberately new retry
outside the generic recovery command, or abandon the attempt. Never delete or
edit the state file to bypass a claim.

An `unauthorized` or `ineligible` event is a policy decision, not a transient
execution failure. Fix central authorization, repository profiles, dependency
state, or the frozen base mismatch, then let a later poll re-evaluate it.
`failed` events should be traced through the retained record's preparation,
setup, execution, verification, or cleanup phase. `verified` without
`published` is safely resumed through the idempotent publisher after restart.
