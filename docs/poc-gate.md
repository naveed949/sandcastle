# Final repo-agnostic worker POC gate

The final gate consumes evidence produced by the deployed single-worker
service. It does not turn a unit-test pass into deployment evidence and it does
not accept operator narration in place of retained artifacts.

## Required artifacts

Keep these files on the same durable volume as the worker state, records,
repository caches, worktrees, and diagnostics:

- the cross-repository proof produced by
  `runCrossRepositoryAcceptanceProof()`;
- the three-stage proof produced by `runDependencyChainAcceptanceProof()`;
- restart evidence containing the state before and after both restart
  dispositions, the returned cycle diagnostics, and independently observed
  branch and draft-pull-request metadata;
- a versioned, time-scoped privileged-action audit. It must contain exactly one
  ordered worker `claim` → `verification` → `publication` sequence for every
  retained draft, with the execution record and pull-request URL as evidence.
  Any agent privileged action, direct `github-command`, merge, or task closure
  fails the gate;
- the final JSON proof and Markdown report paths.

The cross-repository and dependency fixtures must share one
`boundaryAuditPath` and `boundaryAuditRunId`. They create the audit through
`createWorkerPocBoundaryAuditRecorder()`; do not hand-author this JSON. The
recorder fixes the actor to `worker`, appends only claim, verification, and
publication events, HMAC-chains them with the process-only
`SANDCASTLE_POC_GATE_AUDIT_KEY`, and rejects reuse of a path for another run.

The gate calls the configured GitHub issue tracker twice. Do not reuse cached
task arrays in the live fixture. Both cycles must return equivalent ordered
decisions and execution identities, and the nominated unauthorized task must
remain a visible `unauthorized_repository` decision with no execution request.
Its task snapshot must also exist in `unauthorizedInboxStatePath`, with no
execution request or attempt for that repository-qualified task identity.

## Restart evidence

Capture two restart boundaries against the same immutable execution request:

1. Stop or interrupt after the claim is marked `started`. On restart the
   service must emit `blocked` / `manual_intervention`, retain the same attempt,
   reuse the deterministic branch observation, and create no pull request.
2. Stop after verification but before publication. On restart the service must
   emit `verified` / `resume_publication` and then `published`, retain the same
   attempt, reuse the deterministic branch, and observe only one draft pull
   request URL and head SHA.

Do not edit the state JSON to construct either disposition. Capture it with
`runWorkerRestartAcceptanceProof()`. That runner reads durable state before and
after fresh replacement-service cycles, queries the local branch and GitHub
pull-request boundaries, and HMAC-signs the manifest with the same run ID and
process-only key as the boundary audit. It also retains the resumed draft's
full execution provenance as the seventh publication checked by the gate.
Stage the interrupted and verified attempts through the normal guarded worker
boundaries using that same recorder; the restart fixture owns recovery only.

Set `SANDCASTLE_RESTART_ACCEPTANCE_FIXTURE` to
`scripts/restart-acceptance.fixture.mts` and
`SANDCASTLE_RESTART_ACCEPTANCE_SCENARIO` to JSON containing `proofPath`,
`runId`, `boundaryAuditPath`, `configuration`, `owner`, and the
`stateFilePath`/`workspaceRoot` pairs for `interrupted` and
`verifiedPublication`. Run
`npm run test:acceptance:restart` before the consolidated gate.

The dependency fixture never changes task completion itself. After each draft
it waits for a human/operator to apply an allowed completion state through the
issue tracker, then freshly re-reads the task before advancing.

## Scenario fixture

Set `SANDCASTLE_POC_GATE_SCENARIO` to JSON containing:

- `proofPath` and `reportPath`;
- `account`, `configuration`, and `unauthorizedTask`;
- `unauthorizedInboxStatePath`, captured after the unauthorized discovery and
  before any later exact-task authorization;
- optional `exactTasks` and `prdReferences` used by both discovery cycles;
- `crossRepositoryProofPath`, `dependencyChainProofPath`,
  `restartEvidencePath`, and `boundaryAuditPath`.

Keep `GITHUB_TOKEN` and `SANDCASTLE_POC_GATE_AUDIT_KEY` in the fixture process.
Never serialize either secret into the scenario, worker configuration, restart
evidence, boundary audit, or report.
The gate reads and SHA-256 hashes the audit artifact and retains its path,
digest, run ID, time range, and event count in the final proof.

```bash
GITHUB_TOKEN=... \
SANDCASTLE_POC_GATE_AUDIT_KEY=... \
SANDCASTLE_POC_GATE_FIXTURE=$PWD/scripts/poc-gate.fixture.mts \
SANDCASTLE_POC_GATE_SCENARIO=/srv/sandcastle-worker/acceptance/scenario.json \
  npm run test:acceptance:poc-gate
```

The command passes only after all seven consolidated checks succeed. The JSON
is the automation artifact; the Markdown report is the operator-facing summary.

For a release decision, use `npm run test:acceptance:all`. It runs typechecking
and the deterministic suite, then fails before any live gate starts when a
cross-repository, dependency-chain, restart, consolidated-gate, or Mission
Control fixture is absent. This prevents opt-in test skips from being mistaken
for deployed POC evidence.

## POC limits and expansion gates

The report always identifies the current limits: one dispatcher and active
execution, polling-only discovery, manual handling of started attempts with
possible side effects, GitHub-only issue-tracker evidence, and human review of
every draft.

Before enabling concurrency, prove atomic parallel claim contention, fairness,
isolation, and restart behavior. Before webhooks, prove authenticated delivery,
deduplication, replay, ordering, and reconciliation with polling. Before
auto-remediation, prove bounded retries, independent re-verification, immutable
attempt history, and unchanged authorization. Before another issue tracker,
pass an issue-tracker contract suite for identity, revisions, relationships,
authorization, and guarded writes.
