import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  MISSION_CONTROL_ACCEPTANCE_ARTIFACTS,
  missionControlAcceptanceProofDigest,
  runMissionControlAcceptanceProof,
  type MissionControlAcceptanceEvidence,
} from "./MissionControlAcceptanceProof.js";
import type {
  MissionControlAttemptView,
  MissionControlExecutionInspection,
  MissionControlTaskView,
} from "./MissionControlReadModel.js";

const taskId = "acme/app:issue:18";
const attemptId = "attempt:mission-control-18";
const publication = {
  url: "https://github.com/acme/app/pull/18",
  draft: true,
  headSha: "a".repeat(40),
  branchSha: "a".repeat(40),
};

const outcome = (
  commandId: string,
  command: "run-now" | "pause" | "resume" | "cancel" | "retry" | "acknowledge",
  revision: number,
  extras: Record<string, unknown> = {},
) => ({
  version: 1 as const,
  commandId,
  command,
  code: "accepted" as const,
  revision,
  message: "accepted",
  ...extras,
});

const event = (
  id: number,
  state:
    | "discovered"
    | "ready"
    | "claimed"
    | "running"
    | "verified"
    | "published",
) => ({
  id,
  event: {
    timestamp: `2026-08-24T10:00:${String(id).padStart(2, "0")}.000Z`,
    state,
    taskId,
    message: state,
  },
});

const completeEvidence = (
  directory: string,
): MissionControlAcceptanceEvidence => {
  const task = {
    version: 1,
    taskId,
    repository: "acme/app",
    kind: "issue",
    number: 18,
    title: "Mission Control acceptance",
    labels: ["ready-for-agent"],
    state: "ready",
    operationalState: "published",
    sourceState: "open",
    authorizationSource: "repository",
    authorization: { source: "repository" },
    eligibility: { eligible: true, reasonCode: "eligible", reason: "ready" },
    eligibilityReasonCode: "eligible",
    eligibilityReason: "ready",
    sourceRevision: "issue-revision-18",
    baseBranch: "main",
    baseCommit: "b".repeat(40),
    dependencies: [],
    profileId: "node",
    profileDigest: "profile-digest",
    promptVersion: "worker-v1",
    promptTemplateDigest: "prompt-digest",
    executionIdentity: "execution:mission-control-18",
    attemptIds: [attemptId],
  } as unknown as MissionControlTaskView;
  const attempt = {
    version: 1,
    attemptId,
    taskId,
    executionIdentity: "execution:mission-control-18",
    status: "published",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:01:00.000Z",
    task,
    claim: {
      taskId,
      sourceRevision: "issue-revision-18",
      owner: "acceptance-worker",
      acquiredAt: "2026-08-24T10:00:01.000Z",
      leaseExpiresAt: "2026-08-24T10:30:01.000Z",
      phase: "started",
      refreshedTaskIds: [taskId],
    },
    outcomes: [],
    evidence: [
      {
        id: "record-18",
        kind: "record",
        available: true,
        outcomeStatus: "verified",
        timestamp: "2026-08-24T10:00:59.000Z",
      },
      {
        id: "pr-18",
        kind: "pull_request",
        available: true,
        outcomeStatus: "published",
        timestamp: "2026-08-24T10:01:00.000Z",
        url: publication.url,
      },
    ],
    timeline: [
      {
        eventId: 3,
        timestamp: "2026-08-24T10:00:02.000Z",
        state: "claimed",
        message: "claimed",
      },
      {
        eventId: 4,
        timestamp: "2026-08-24T10:00:03.000Z",
        state: "running",
        message: "running",
      },
      {
        eventId: 5,
        timestamp: "2026-08-24T10:00:59.000Z",
        state: "verified",
        message: "verified",
      },
      {
        eventId: 6,
        timestamp: "2026-08-24T10:01:00.000Z",
        state: "published",
        message: "published",
      },
    ],
    execution: {
      repository: "acme/app",
      baseCommit: "b".repeat(40),
      profileId: "node",
      profileDigest: "profile-digest",
      promptVersion: "worker-v1",
      promptTemplateDigest: "prompt-digest",
      commits: [{ sha: publication.headSha }],
      setup: [],
      verification: [
        {
          command: "npm test",
          phase: "verification",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
      ],
    },
    publication: { pullRequestUrls: [publication.url] },
  } as unknown as MissionControlAttemptView;
  const manualAttempt = {
    ...attempt,
    attemptId: "attempt:manual-intervention",
    status: "active",
    claim: { ...attempt.claim, phase: "started" },
  } as unknown as MissionControlAttemptView;
  const status = (mode: "paused" | "running", revision: number) => ({
    status: 200,
    body: {
      version: 1 as const,
      mode,
      revision,
      pauseRequested: mode === "paused",
    },
  });

  return {
    deployment: {
      bindAddress: "127.0.0.1",
      defaultBindAddress: true,
      privateAccess: "ssh-tunnel",
      systemdUnitPath: "/etc/systemd/system/sandcastle-worker.service",
      systemdUnit: `[Service]\nUser=sandcastle\nWorkingDirectory=/opt/sandcastle-worker\nEnvironmentFile=/etc/sandcastle-worker.env\nExecStart=/usr/bin/node /opt/sandcastle-worker/worker.mjs\nRestart=on-failure\nTimeoutStopSec=120\nUMask=0077`,
      durableRoot: directory,
      durableArtifacts: [...MISSION_CONTROL_ACCEPTANCE_ARTIFACTS],
      backup: { serviceStopped: true, completeRoot: true },
      rollback: { previousReleaseRestored: true, durableRootPreserved: true },
      shutdown: { signals: ["SIGINT", "SIGTERM"], graceful: true },
    },
    discovery: { live: true, sourceCalls: 2, observedTaskId: taskId },
    endpoints: {
      html: { status: 200, body: "<title>Mission Control</title>" },
      status: {
        status: 200,
        body: {
          version: 1,
          mode: "running",
          revision: 3,
          pauseRequested: false,
        },
      },
      overview: {
        status: 200,
        body: {
          version: 1,
          revision: 3,
          mode: "running",
          pauseRequested: false,
          activeAttempt: null,
          lastCompletedCycle: "2026-08-24T10:01:00.000Z",
          nextExpectedCycle: "2026-08-24T10:02:00.000Z",
          recoveryWarnings: [],
          operationalStateCounts: {
            discovered: 0,
            unauthorized: 0,
            ineligible: 0,
            ready: 1,
            claimed: 0,
            running: 0,
            blocked: 0,
            failed: 0,
            verified: 0,
            published: 1,
          },
          orchestration: {
            authority: "mission-control-host",
            mode: "running",
            lock: "owned",
            components: {
              worker: { mode: "running" },
              workflowCoordinator: { mode: "not_configured" },
              missionControl: { mode: "listening" },
              eventStream: { mode: "ready" },
            },
          },
        },
      },
      tasks: { status: 200, body: { version: 1, revision: 3, tasks: [task] } },
      queue: {
        status: 200,
        body: {
          version: 1,
          revision: 3,
          source: "worker",
          queue: [
            {
              position: 1,
              taskId: "acme/app:issue:19",
              repository: "acme/app",
              kind: "issue",
              number: 19,
              executionIdentity: "execution:19",
              sourceRevision: "issue-revision-19",
              title: "Next task",
              state: "ready",
            },
          ],
          entries: [],
        },
      },
      events: {
        status: 200,
        initial: [event(1, "discovered"), event(2, "ready")],
        resumed: [
          event(3, "claimed"),
          event(4, "running"),
          event(5, "verified"),
          event(6, "published"),
        ],
        acknowledgedThrough: 2,
      },
      attempt: { status: 200, body: attempt },
      evidence: {
        status: 200,
        body: {
          version: 1,
          id: "record-18",
          kind: "record",
          record: {
            ...attempt.execution,
            status: "verified",
            recordPath: "/redacted",
          } as unknown as MissionControlExecutionInspection,
        },
      },
    },
    controls: {
      runNow: {
        commandId: "run-now-1",
        first: outcome("run-now-1", "run-now", 1),
        duplicate: outcome("run-now-1", "run-now", 1),
      },
      pause: {
        outcome: outcome("pause-1", "pause", 2),
        statusAfter: status("paused", 2),
      },
      resume: {
        outcome: outcome("resume-1", "resume", 3),
        statusAfter: status("running", 3),
      },
      cancellation: {
        outcome: outcome("cancel-1", "cancel", 4, {
          attemptId: "attempt:cancelled",
        }),
        attemptAfter: {
          status: 200,
          body: {
            ...attempt,
            attemptId: "attempt:cancelled",
            status: "interrupted",
            evidence: attempt.evidence.slice(0, 1),
          } as unknown as MissionControlAttemptView,
        },
      },
      safeRetry: {
        expiredAttemptId: "attempt:expired",
        outcome: outcome("retry-1", "retry", 5, {
          attemptId: "attempt:expired",
          reasonCode: "safe_retry",
        }),
        attemptAfter: {
          status: 200,
          body: {
            ...attempt,
            attemptId: "attempt:expired:retry",
            status: "active",
          } as unknown as MissionControlAttemptView,
        },
      },
      manualIntervention: {
        attemptId: manualAttempt.attemptId,
        before: manualAttempt,
        retry: {
          ...outcome("manual-retry", "retry", 5, {
            attemptId: manualAttempt.attemptId,
            code: "recovery_manual_intervention",
            reasonCode: "manual_intervention",
          }),
          code: "recovery_manual_intervention",
          message: "manual intervention",
        },
        acknowledgement: outcome("manual-ack", "acknowledge", 6, {
          attemptId: manualAttempt.attemptId,
          reasonCode: "manual_intervention",
        }),
        after: manualAttempt,
      },
    },
    publication: { first: publication, retry: publication },
    durability: {
      before: Object.fromEntries(
        MISSION_CONTROL_ACCEPTANCE_ARTIFACTS.map((artifact) => [
          artifact,
          `digest-${artifact}`,
        ]),
      ) as MissionControlAcceptanceEvidence["durability"]["before"],
      after: Object.fromEntries(
        MISSION_CONTROL_ACCEPTANCE_ARTIFACTS.map((artifact) => [
          artifact,
          `digest-${artifact}`,
        ]),
      ) as MissionControlAcceptanceEvidence["durability"]["after"],
      retainedArtifacts: [...MISSION_CONTROL_ACCEPTANCE_ARTIFACTS],
      sameDurableRoot: true,
      readModelRebuilt: true,
      restartCount: 1,
    },
    credentials: {
      githubCredentialConfiguredServerSide: true,
      browserPayloads: [task, attempt, "redacted"],
      promptText: "Implement the task",
      sandboxEnvironment: { PATH: "/usr/bin" },
      commandAudit: '{"message":"Protected worker material redacted."}',
      protectedMaterial: [
        "GITHUB_TOKEN=super-secret",
        "AGENT_SECRET=super-secret",
      ],
    },
  };
};

describe("runMissionControlAcceptanceProof", () => {
  it("fails closed when the retained run has no queue observation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-acceptance-"),
    );

    await expect(
      runMissionControlAcceptanceProof({
        proofPath: join(directory, "proof.json"),
        integrityKey: "mission-control-test-key",
        evidence: {} as MissionControlAcceptanceEvidence,
      }),
    ).rejects.toMatchObject({
      name: "MissionControlAcceptanceProofError",
      code: "observability",
    });
  });

  it("retains a safe, authenticated proof after every deployment boundary passes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-acceptance-"),
    );
    try {
      const proof = await runMissionControlAcceptanceProof({
        proofPath: join(directory, "proof.json"),
        integrityKey: "mission-control-test-key",
        createdAt: "2026-08-24T10:02:00.000Z",
        evidence: completeEvidence(directory),
      });

      expect(proof.status).toBe("passed");
      expect(proof.checks).toEqual(
        expect.objectContaining({
          liveDiscovery: true,
          queueInspection: true,
          pauseResume: true,
          manualInterventionProtection: true,
          publicationIdempotency: true,
        }),
      );
      const { integrity: _integrity, ...unsigned } = proof;
      expect(proof.integrity.digest).toBe(
        missionControlAcceptanceProofDigest(
          unsigned,
          "mission-control-test-key",
        ),
      );
      const retained = await readFile(join(directory, "proof.json"), "utf8");
      expect(retained).toContain('"status": "passed"');
      expect(retained).not.toContain("super-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a command retry whose retained outcome changes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-acceptance-"),
    );
    try {
      const original = completeEvidence(directory);
      const evidence: MissionControlAcceptanceEvidence = {
        ...original,
        controls: {
          ...original.controls,
          runNow: {
            ...original.controls.runNow,
            duplicate: outcome("run-now-1", "run-now", 99),
          },
        },
      };
      await expect(
        runMissionControlAcceptanceProof({
          proofPath: join(directory, "proof.json"),
          integrityKey: "mission-control-test-key",
          evidence,
        }),
      ).rejects.toMatchObject({ code: "idempotency" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
