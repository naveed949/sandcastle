import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("createWorkerStateStore", () => {
  it("reconstructs task snapshots and execution requests after a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const result = runWorkerDryRun({ configuration, tasks: [task] });
      const firstStore = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:00:00.000Z",
      });

      await firstStore.recordDiscovery(result);

      const restartedStore = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:01:00.000Z",
      });
      const recovered = await restartedStore.read();

      expect(recovered.taskSnapshots).toHaveLength(1);
      expect(recovered.taskSnapshots[0]).toMatchObject({
        taskId: "acme/app:issue:7",
        discoveredAt: "2026-08-23T20:00:00.000Z",
        task,
      });
      expect(recovered.executionRequests).toHaveLength(1);
      expect(recovered.executionRequests[0]?.request).toEqual(
        result.executionRequests[0],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not duplicate an unchanged discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const result = runWorkerDryRun({ configuration, tasks: [task] });
      const store = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:00:00.000Z",
      });

      const first = await store.recordDiscovery(result);
      const second = await store.recordDiscovery(result, {
        discoveredAt: "2026-08-23T20:01:00.000Z",
      });

      expect(second).toEqual(first);
      expect(second.taskSnapshots).toHaveLength(1);
      expect(second.executionRequests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a new snapshot when the observed base commit changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const firstResult = runWorkerDryRun({ configuration, tasks: [task] });
      const secondResult = runWorkerDryRun({
        configuration,
        tasks: [{ ...task, baseCommit: "base-commit-2" }],
      });
      const store = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:00:00.000Z",
      });

      await store.recordDiscovery(firstResult);
      const state = await store.recordDiscovery(secondResult, {
        discoveredAt: "2026-08-23T20:01:00.000Z",
      });

      expect(state.taskSnapshots).toHaveLength(2);
      expect(state.executionRequests).toHaveLength(2);
      expect(
        new Set(state.taskSnapshots.map((item) => item.task.baseCommit)).size,
      ).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates one durable active attempt for an execution identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const result = runWorkerDryRun({ configuration, tasks: [task] });
      const request = result.executionRequests[0]!;
      const store = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:02:00.000Z",
      });
      const concurrentStore = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:02:00.000Z",
      });
      await store.recordDiscovery(result);

      const [first, second] = await Promise.all([
        store.createAttempt(request),
        concurrentStore.createAttempt(request),
      ]);

      expect(second).toEqual(first);
      expect(first).toMatchObject({
        executionIdentity: request.executionIdentity,
        status: "active",
        createdAt: "2026-08-23T20:02:00.000Z",
      });

      const restartedStore = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:03:00.000Z",
      });
      const recovered = await restartedStore.read();
      expect(recovered.attempts).toEqual([first]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains timestamped evidence for verified and published outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const result = runWorkerDryRun({ configuration, tasks: [task] });
      const request = result.executionRequests[0]!;
      const store = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:02:00.000Z",
      });
      const attempt = await store.createAttempt(request);

      const verified = await store.transitionAttempt(attempt.attemptId, {
        status: "verified",
        timestamp: "2026-08-23T20:04:00.000Z",
        evidence: ["ci://run/42"],
      });
      const published = await store.transitionAttempt(attempt.attemptId, {
        status: "published",
        timestamp: "2026-08-23T20:05:00.000Z",
        evidence: ["github://pull/17"],
      });

      expect(verified).toMatchObject({
        status: "verified",
        updatedAt: "2026-08-23T20:04:00.000Z",
        outcomes: [
          {
            status: "verified",
            timestamp: "2026-08-23T20:04:00.000Z",
            evidence: ["ci://run/42"],
          },
        ],
      });
      expect(published.outcomes).toEqual([
        {
          status: "verified",
          timestamp: "2026-08-23T20:04:00.000Z",
          evidence: ["ci://run/42"],
        },
        {
          status: "published",
          timestamp: "2026-08-23T20:05:00.000Z",
          evidence: ["github://pull/17"],
        },
      ]);
      expect((await store.read()).attempts[0]).toEqual(published);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects impossible lifecycle transitions and preserves interrupted or failed evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-worker-state-"));
    const filePath = join(directory, "state.json");

    try {
      const result = runWorkerDryRun({
        configuration,
        tasks: [task, { ...task, number: 8 }],
      });
      const store = createWorkerStateStore({
        filePath,
        now: () => "2026-08-23T20:02:00.000Z",
      });
      const first = await store.createAttempt(result.executionRequests[0]!);
      const second = await store.createAttempt(result.executionRequests[1]!);

      await expect(
        store.transitionAttempt(first.attemptId, {
          status: "published",
          timestamp: "2026-08-23T20:03:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(
        store.createAttempt(result.executionRequests[0]!, {
          attemptId: "attempt:duplicate-7",
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      const failed = await store.transitionAttempt(first.attemptId, {
        status: "failed",
        timestamp: "2026-08-23T20:04:00.000Z",
        evidence: ["log://attempt/7"],
      });
      const retry = await store.createAttempt(result.executionRequests[0]!, {
        attemptId: "attempt:retry-7",
      });
      const repeatedRetry = await store.createAttempt(
        result.executionRequests[0]!,
        { attemptId: "attempt:retry-7" },
      );
      const interrupted = await store.transitionAttempt(second.attemptId, {
        status: "interrupted",
        timestamp: "2026-08-23T20:05:00.000Z",
        evidence: ["signal://SIGTERM"],
      });

      expect(failed.outcomes).toEqual([
        {
          status: "failed",
          timestamp: "2026-08-23T20:04:00.000Z",
          evidence: ["log://attempt/7"],
        },
      ]);
      expect(retry).toMatchObject({
        attemptId: "attempt:retry-7",
        executionIdentity: result.executionRequests[0]!.executionIdentity,
        status: "active",
      });
      expect(repeatedRetry).toEqual(retry);
      expect(interrupted.outcomes).toEqual([
        {
          status: "interrupted",
          timestamp: "2026-08-23T20:05:00.000Z",
          evidence: ["signal://SIGTERM"],
        },
      ]);
      await expect(
        store.transitionAttempt(first.attemptId, {
          status: "verified",
          timestamp: "2026-08-23T20:06:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
