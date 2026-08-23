import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimWorkerTask } from "./WorkerClaimCoordinator.js";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
      baseBranch: "main",
      profileId: "node",
    },
  },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
};

const task: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 7,
  title: "Fix the widget",
  body: "The widget is broken.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue-revision-1",
  baseBranch: "main",
  baseCommit: "base-commit-1",
  state: "open",
  dependencies: [],
  children: [],
};

const requestFor = (value: NormalizedTask = task) =>
  runWorkerDryRun({ configuration, tasks: [value] }).executionRequests[0]!;

describe("claimWorkerTask", () => {
  it("re-reads the task and rejects a stale revision without creating an attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-claim-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let reads = 0;
      const source = {
        read: async () => {
          reads += 1;
          return { ...task, sourceRevision: "issue-revision-2" };
        },
      };

      await expect(
        claimWorkerTask({
          source,
          store,
          configuration,
          request: requestFor(),
          owner: "worker-a",
          leaseDurationMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "stale_revision" });

      expect(reads).toBe(1);
      expect((await store.read()).attempts).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds the task revision and owner, then re-enters idempotently after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-claim-"));
    const filePath = join(directory, "state.json");
    try {
      const source = { read: async () => task };
      const firstStore = createWorkerStateStore({ filePath });
      const input = {
        source,
        store: firstStore,
        configuration,
        request: requestFor(),
        owner: "worker-a",
        leaseDurationMs: 60_000,
        claimedAt: "2026-08-23T20:00:00.000Z",
      } as const;
      const first = await claimWorkerTask(input);

      const restartedStore = createWorkerStateStore({ filePath });
      const repeated = await claimWorkerTask({
        ...input,
        store: restartedStore,
        claimedAt: "2026-08-23T20:00:30.000Z",
      });

      expect(repeated).toEqual(first);
      expect(first).toMatchObject({
        executionIdentity: input.request.executionIdentity,
        claim: {
          taskId: "acme/app:issue:7",
          sourceRevision: "issue-revision-1",
          owner: "worker-a",
          acquiredAt: "2026-08-23T20:00:00.000Z",
          leaseExpiresAt: "2026-08-23T20:01:00.000Z",
          phase: "claimed",
        },
      });
      expect((await restartedStore.read()).attempts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when concurrent owners claim the same task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-claim-"));
    const filePath = join(directory, "state.json");
    try {
      const request = requestFor();
      const firstStore = createWorkerStateStore({ filePath });
      const secondStore = createWorkerStateStore({ filePath });
      const results = await Promise.allSettled([
        firstStore.claimAttempt(request, {
          attemptId: "attempt-a",
          owner: "worker-a",
          leaseDurationMs: 60_000,
          claimedAt: "2026-08-23T20:00:00.000Z",
        }),
        secondStore.claimAttempt(request, {
          attemptId: "attempt-b",
          owner: "worker-b",
          leaseDurationMs: 60_000,
          claimedAt: "2026-08-23T20:00:00.000Z",
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejection = results.find((result) => result.status === "rejected");
      expect(rejection).toMatchObject({
        status: "rejected",
        reason: { code: "conflict" },
      });
      expect((await firstStore.read()).attempts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies expiry and only auto-recovers claims with no started side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-claim-"));
    const filePath = join(directory, "state.json");
    try {
      const store = createWorkerStateStore({ filePath });
      const request = requestFor();
      await store.claimAttempt(request, {
        attemptId: "attempt-safe",
        owner: "worker-a",
        leaseDurationMs: 1_000,
        claimedAt: "2026-08-23T20:00:00.000Z",
      });

      expect(
        await store.inspectExpiredLeases({
          at: "2026-08-23T20:00:02.000Z",
        }),
      ).toEqual([
        expect.objectContaining({
          attemptId: "attempt-safe",
          disposition: "safe_retry",
        }),
      ]);

      const retry = await store.claimAttempt(request, {
        attemptId: "attempt-retry",
        owner: "worker-b",
        leaseDurationMs: 1_000,
        claimedAt: "2026-08-23T20:00:02.000Z",
      });
      expect(retry.status).toBe("active");
      expect((await store.read()).attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptId: "attempt-safe",
            status: "interrupted",
          }),
        ]),
      );

      await store.markAttemptStarted("attempt-retry");
      expect(
        await store.inspectExpiredLeases({
          at: "2026-08-23T20:00:04.000Z",
        }),
      ).toEqual([
        expect.objectContaining({
          attemptId: "attempt-retry",
          disposition: "manual_intervention",
        }),
      ]);
      await expect(
        store.claimAttempt(request, {
          attemptId: "attempt-forbidden",
          owner: "worker-c",
          leaseDurationMs: 1_000,
          claimedAt: "2026-08-23T20:00:04.000Z",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
