# Mission Control remote deployment acceptance

The Mission Control acceptance proof is the retained release artifact for one
single-worker development box. It exercises the running HTTP and SSE surface;
a deterministic unit-test pass is not a substitute for this proof.

## Required evidence

Keep the proof on the same `workspaceRoot` volume as the worker state:

```text
/srv/sandcastle-worker/acceptance/mission-control.json
```

The proof is HMAC-bound to `SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_KEY` and
retains only safe identifiers, digests, command outcome codes, publication
metadata, and fixed limitations. The fixture must supply:

- the live host URL and its default loopback bind address;
- the documented systemd unit, complete stopped-root backup, release rollback,
  and graceful `SIGINT`/`SIGTERM` observations;
- live discovery, task inbox, worker-ordered queue, attempt timeline, opaque
  evidence read, and resumable SSE observations;
- duplicate `run-now`, pause, resume, cancellation, safe-retry, and
  manual-intervention acknowledgement outcomes;
- one verified draft publication and a retry observation with the same URL,
  branch SHA, and head SHA;
- one published attempt ID plus separate expired-claim and
  manual-intervention attempt IDs for the guarded-control sequence;
- before/after fingerprints for task snapshots, execution identities, attempts,
  leases, command audit, diagnostics, records, logs, worktrees, and publication
  provenance;
- protected markers, prompt text, sandbox environment, browser payloads, and
  command audit text for the credential-boundary scan.

The proof rejects missing queue or event observations, stale or changing
duplicate-command outcomes, publication changes, manual-intervention retries,
credential markers in browser-visible material, incomplete durable roots, and
non-loopback default binding.

## Run the live probe

Use a dedicated acceptance task set and a maintenance window. The probe issues
real guarded commands against the running worker, including a cycle request and
active-execution cancellation; it must not be pointed at an unattended
production workload.

The committed fixture reads scenario metadata, fetches the host endpoints,
reconnects `/api/v1/events` with `Last-Event-ID`, issues commands using the
current worker revision, reads the retained attempt and evidence, and delegates
final validation and atomic proof retention to
`runMissionControlAcceptanceProof()`.

```bash
export SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_FIXTURE=$PWD/scripts/mission-control-acceptance.fixture.mts
export SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_SCENARIO=/srv/sandcastle-worker/acceptance/mission-control-scenario.json
export SANDCASTLE_MISSION_CONTROL_ACCEPTANCE_KEY='operator-held-run-key'
npm run test:acceptance:mission-control
```

Keep the HMAC key, GitHub token, agent credentials, and any protected marker
values in the fixture process or root-owned environment file. Do not serialize
them into the scenario, worker configuration, task snapshots, prompts,
sandbox environment, command audit, or proof.

The release gate runs typechecking and the deterministic suite before the
lower-level cross-repository, dependency-chain, restart, consolidated worker
POC, and Mission Control gates. It removes the live-fixture variables while
running the deterministic suite so opt-in live tests are not run twice:

```bash
npm run test:acceptance:all
```

## Retained limitations

Every passed proof reports the current POC limits: one dispatcher and one
active execution, polling-only discovery, manual handling of started attempts
with possible side effects, and human review of every draft. The proof does not
authorize merge, issue closure, release, deployment, or public internet
exposure.
