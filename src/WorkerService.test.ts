import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import { runWorkerDryRun } from "./WorkerCoordinator.js";
import {
  createWorkerService,
  createJsonlWorkerDiagnostics,
  workerServicePaths,
  WorkerExecutionTimeoutError,
  WorkerServiceOperatorCancellationError,
  WorkerServiceLockError,
  type WorkerDiagnostic,
} from "./WorkerService.js";
import { createWorkerStateStore } from "./WorkerStateStore.js";

const task: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 10,
  title: "Operate continuously",
  body: "Run the worker as a restartable service.",
  labels: ["ready-for-agent"],
  sourceRevision: "issue-revision-10",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
      baseBranch: "main",
      profileId: "node",
    },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
  profiles: {
    node: { setupCommands: [], verificationCommands: ["npm test"] },
  },
};

describe("WorkerService", () => {
  it("derives persistent service paths and appends structured diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const paths = workerServicePaths(directory);
      const diagnostics = createJsonlWorkerDiagnostics(
        paths.diagnosticsFilePath,
      );
      const event: WorkerDiagnostic = {
        timestamp: "2026-08-24T01:00:00.000Z",
        state: "blocked",
        taskId: "acme/app:issue:10",
        reasonCode: "manual_intervention",
        message: "Inspect retained evidence.",
      };

      await diagnostics.emit(event);
      await diagnostics.emit({
        ...event,
        state: "failed",
        message: "GITHUB_TOKEN=do-not-retain",
      });

      expect(paths).toEqual({
        workspaceRoot: directory,
        stateFilePath: join(directory, "state", "worker.json"),
        recordsRoot: join(directory, "records"),
        repositoriesRoot: join(directory, "repositories"),
        diagnosticsFilePath: join(directory, "diagnostics", "worker.jsonl"),
        operatorAuditFilePath: join(directory, "operator", "commands.jsonl"),
        serviceLockFilePath: join(directory, "state", "service.lock"),
      });
      expect(
        (await readFile(paths.diagnosticsFilePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        event,
        {
          ...event,
          state: "failed",
          message: "Protected worker material redacted.",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on invalid central configuration before discovery", async () => {
    const source = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => ({ task, relatedTasks: [] })),
    };

    expect(() =>
      createWorkerService({
        configuration: {
          ...configuration,
          repositories: {
            "acme/app": {
              authorized: true,
              baseBranch: "main",
              profileId: "missing",
            },
          },
        },
        source,
        store: {} as never,
        execution: {} as never,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: "/tmp/sandcastle-invalid-service.lock",
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      }),
    ).toThrow(/missing profile/i);
    expect(source.discover).not.toHaveBeenCalled();
  });

  it("replays a retained control outcome and revision after service recreation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const makeService = () =>
        createWorkerService({
          configuration,
          source: { discover: vi.fn(async () => []), read: vi.fn() },
          store: createWorkerStateStore({
            filePath: join(directory, "state.json"),
          }),
          execution: {} as never,
          publisher: {} as never,
          owner: "worker-1",
          lockFilePath: join(directory, "state", "service.lock"),
          operatorAuditFilePath: join(directory, "operator", "commands.jsonl"),
          pollIntervalMs: 1_000,
          leaseDurationMs: 60_000,
        });

      const first = makeService();
      const outcome = await first.control.command({
        command: "pause",
        commandId: "persisted-pause",
        expectedRevision: 0,
        reason: "restart verification",
      });
      await first.stop();

      const second = makeService();
      expect(second.status().revision).toBe(1);
      await expect(
        second.control.command({
          command: "pause",
          commandId: "persisted-pause",
          expectedRevision: 999,
        }),
      ).resolves.toEqual(outcome);
      await second.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("claims, executes, verifies, and publishes at most one ready task per cycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state", "worker.json"),
      });
      const source = {
        discover: vi.fn(async () => [task, { ...task, number: 11 }]),
        read: vi.fn(async ({ task: reference }) => ({
          task: { ...task, number: reference.number },
          relatedTasks: [],
        })),
      };
      const emitted: WorkerDiagnostic[] = [];
      const execution = {
        execute: vi.fn(async (attempt) => {
          await store.markAttemptStarted(attempt.attemptId);
          await store.transitionAttempt(attempt.attemptId, {
            status: "verified",
            evidence: [join(directory, "records", "result.json")],
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "verified" as const,
            branch: "sandcastle/worker/acme/app/issue-10/test",
            repositoryCredentialNames: [],
            commits: [{ sha: "b".repeat(40) }],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "records", "result.json"),
          };
        }),
      };
      const publisher = {
        publish: vi.fn(async (attemptId: string) => {
          await store.transitionAttempt(attemptId, {
            status: "published",
            evidence: ["https://github.com/acme/app/pull/1"],
          });
          return {
            attemptId,
            executionIdentity: "execution",
            repository: "acme/app",
            branch: "branch",
            branchSha: "b".repeat(40),
            pullRequest: {
              number: 1,
              url: "https://github.com/acme/app/pull/1",
              draft: true,
              head: "branch",
              headSha: "b".repeat(40),
              base: "main",
            },
            reusedBranch: false,
            reusedPullRequest: false,
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
        diagnostics: {
          emit: async (event) => {
            emitted.push(event);
          },
        },
      });

      const result = await service.runCycle();

      expect(result.attempted).toBe(true);
      expect(emitted.map((event) => event.state)).toEqual([
        "discovered",
        "ready",
        "discovered",
        "ready",
        "claimed",
        "running",
        "verified",
        "published",
      ]);
      expect(execution.execute).toHaveBeenCalledOnce();
      expect(publisher.publish).toHaveBeenCalledOnce();
      expect((await store.read()).attempts[0]?.status).toBe("published");

      const second = await service.runCycle();
      expect(second.attempted).toBe(true);
      expect(execution.execute).toHaveBeenCalledTimes(2);
      expect(
        (await store.read()).attempts.map((attempt) => attempt.status),
      ).toEqual(["published", "published"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces overlapping polling cycles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let releaseDiscovery!: () => void;
      const discoveryBlocked = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const source = {
        discover: vi.fn(async () => {
          await discoveryBlocked;
          return [];
        }),
        read: vi.fn(),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution: {} as never,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const first = service.runCycle();
      const second = service.runCycle();
      releaseDiscovery();

      await expect(Promise.all([first, second])).resolves.toEqual([
        { events: [], attempted: false },
        { events: [], attempted: false },
      ]);
      expect(source.discover).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces guarded run-now commands onto the existing cycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let releaseDiscovery!: () => void;
      const discoveryBlocked = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const source = {
        discover: vi.fn(async () => {
          await discoveryBlocked;
          return [];
        }),
        read: vi.fn(),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution: {} as never,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const first = service.control.command({
        command: "run-now",
        commandId: "cycle-1",
        expectedRevision: 0,
        reason: "operator requested an immediate cycle",
      });
      await vi.waitFor(() => expect(source.discover).toHaveBeenCalledOnce());

      const second = service.control.command({
        command: "run-now",
        commandId: "cycle-2",
        expectedRevision: service.status().revision,
        reason: "operator repeated the immediate cycle request",
      });
      releaseDiscovery();

      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { code: "accepted" },
        { code: "accepted" },
      ]);
      expect(source.discover).toHaveBeenCalledOnce();
      expect(service.status().revision).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pauses at a cycle boundary and resumes the same polling service", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const source = {
        discover: vi.fn(async () => []),
        read: vi.fn(),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution: {} as never,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 60_000,
        leaseDurationMs: 60_000,
      });
      const running = service.start();
      await vi.waitFor(() => expect(source.discover).toHaveBeenCalledOnce());

      await expect(
        service.control.command({
          command: "pause",
          commandId: "pause-1",
          expectedRevision: 0,
          reason: "maintenance window",
        }),
      ).resolves.toMatchObject({ code: "accepted", revision: 1 });
      await vi.waitFor(() => expect(service.status().mode).toBe("paused"));
      expect(source.discover).toHaveBeenCalledOnce();

      await expect(
        service.control.command({
          command: "resume",
          commandId: "resume-1",
          expectedRevision: 1,
          reason: "maintenance completed",
        }),
      ).resolves.toMatchObject({ code: "accepted", revision: 2 });
      await vi.waitFor(() => expect(source.discover).toHaveBeenCalledTimes(2));
      expect(service.status().mode).toBe("running");

      await service.stop();
      await running;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels the active execution through its abort signal and retains the outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let observedSignal!: AbortSignal;
      let observedAttemptId!: string;
      const execution = {
        execute: vi.fn(async (attempt, options) => {
          observedAttemptId = attempt.attemptId;
          observedSignal = options?.signal as AbortSignal;
          await store.markAttemptStarted(attempt.attemptId);
          await new Promise<void>((resolve) => {
            if (observedSignal.aborted) {
              resolve();
              return;
            }
            observedSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          await store.transitionAttempt(attempt.attemptId, {
            status: "interrupted",
            evidence: ["operator://cancelled"],
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "interrupted" as const,
            failurePhase: "execution" as const,
            error: "operator cancelled execution",
            repositoryCredentialNames: [],
            commits: [],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "record.json"),
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source: {
          discover: async () => [task],
          read: async () => ({ task, relatedTasks: [] }),
        },
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        operatorAuditFilePath: join(directory, "operator", "commands.jsonl"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const cycle = service.runCycle();
      await vi.waitFor(() => expect(execution.execute).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(service.status().activeAttemptId).toBe(observedAttemptId),
      );

      await expect(
        service.control.command({
          command: "cancel",
          commandId: "cancel-1",
          expectedRevision: 0,
          attemptId: observedAttemptId,
          reason: "GITHUB_TOKEN=do-not-retain",
        }),
      ).resolves.toMatchObject({
        code: "accepted",
        revision: 1,
        attemptId: observedAttemptId,
      });
      expect(observedSignal.reason).toBeInstanceOf(
        WorkerServiceOperatorCancellationError,
      );
      await cycle;

      expect((await store.read()).attempts[0]?.status).toBe("interrupted");
      const audit = await readFile(
        join(directory, "operator", "commands.jsonl"),
        "utf8",
      );
      expect(audit).not.toContain("GITHUB_TOKEN=do-not-retain");
      expect(audit).toContain("Protected worker material redacted.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent service process through the persistent lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const firstSource = {
        discover: vi.fn(async () => []),
        read: vi.fn(),
      };
      const secondSource = { discover: vi.fn(async () => []), read: vi.fn() };
      const common = {
        configuration,
        lockFilePath: join(directory, "service.lock"),
        execution: {} as never,
        publisher: {} as never,
        owner: "worker-1",
        pollIntervalMs: 60_000,
        leaseDurationMs: 60_000,
      } as const;
      const first = createWorkerService({
        ...common,
        source: firstSource,
        store: createWorkerStateStore({
          filePath: join(directory, "state.json"),
        }),
      });
      const second = createWorkerService({
        ...common,
        source: secondSource,
        store: createWorkerStateStore({
          filePath: join(directory, "state.json"),
        }),
      });

      const running = first.start();
      await vi.waitFor(() => expect(firstSource.discover).toHaveBeenCalled());
      await expect(second.runCycle()).rejects.toBeInstanceOf(
        WorkerServiceLockError,
      );
      expect(secondSource.discover).not.toHaveBeenCalled();
      await first.stop();
      await running;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes a retained claim that has not started without rediscovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const request = runWorkerDryRun({ configuration, tasks: [task] })
        .executionRequests[0]!;
      const retained = await store.claimAttempt(request, {
        owner: "worker-1",
        leaseDurationMs: 60_000,
        claimedAt: new Date().toISOString(),
      });
      const source = {
        discover: vi.fn(async () => []),
        read: vi.fn(async () => ({ task, relatedTasks: [] })),
      };
      const execution = {
        execute: vi.fn(async (attempt) => {
          await store.markAttemptStarted(attempt.attemptId);
          await store.transitionAttempt(attempt.attemptId, {
            status: "failed",
            evidence: ["operator://resume-test"],
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "failed" as const,
            failurePhase: "execution" as const,
            error: "resume test stopped",
            repositoryCredentialNames: [],
            commits: [],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "record.json"),
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const result = await service.runCycle();

      expect(result.events.map((event) => event.state)).toEqual([
        "claimed",
        "running",
        "failed",
      ]);
      expect(execution.execute).toHaveBeenCalledWith(
        retained,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(source.discover).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires manual intervention for a retained attempt whose side effects may exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const request = runWorkerDryRun({ configuration, tasks: [task] })
        .executionRequests[0]!;
      const retained = await store.claimAttempt(request, {
        owner: "worker-1",
        leaseDurationMs: 60_000,
        claimedAt: "2000-01-01T00:00:00.000Z",
      });
      await store.markAttemptStarted(retained.attemptId);
      const source = {
        discover: vi.fn(async () => []),
        read: vi.fn(),
      };
      const execution = { execute: vi.fn() };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const result = await service.runCycle();

      expect(result).toMatchObject({ attempted: false });
      expect(result.events).toEqual([
        expect.objectContaining({
          state: "blocked",
          attemptId: retained.attemptId,
          reasonCode: "manual_intervention",
        }),
      ]);
      expect(source.discover).not.toHaveBeenCalled();
      expect(execution.execute).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes publication for a retained verified attempt before discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const request = runWorkerDryRun({ configuration, tasks: [task] })
        .executionRequests[0]!;
      const attempt = await store.claimAttempt(request, {
        owner: "worker-1",
        leaseDurationMs: 60_000,
      });
      await store.markAttemptStarted(attempt.attemptId);
      await store.transitionAttempt(attempt.attemptId, {
        status: "verified",
        evidence: [join(directory, "record.json")],
      });
      const source = {
        discover: vi.fn(async () => []),
        read: vi.fn(),
      };
      const publisher = {
        publish: vi.fn(async (attemptId: string) => {
          await store.transitionAttempt(attemptId, { status: "published" });
          return {
            attemptId,
            executionIdentity: request.executionIdentity,
            repository: "acme/app",
            branch: "branch",
            branchSha: "b".repeat(40),
            pullRequest: {
              number: 1,
              url: "https://github.com/acme/app/pull/1",
              draft: true,
              head: "branch",
              headSha: "b".repeat(40),
              base: "main",
            },
            reusedBranch: true,
            reusedPullRequest: true,
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution: {} as never,
        publisher,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const result = await service.runCycle();

      expect(result.events.map((event) => event.state)).toEqual([
        "verified",
        "published",
      ]);
      expect(publisher.publish).toHaveBeenCalledWith(attempt.attemptId);
      expect(source.discover).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries an expired unstarted lease with a new retained attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const request = runWorkerDryRun({ configuration, tasks: [task] })
        .executionRequests[0]!;
      const expired = await store.claimAttempt(request, {
        owner: "worker-1",
        leaseDurationMs: 1_000,
        claimedAt: "2000-01-01T00:00:00.000Z",
      });
      const source = {
        discover: vi.fn(async () => []),
        read: vi.fn(async () => ({ task, relatedTasks: [] })),
      };
      const execution = {
        execute: vi.fn(async (attempt) => {
          await store.markAttemptStarted(attempt.attemptId);
          await store.transitionAttempt(attempt.attemptId, {
            status: "failed",
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "failed" as const,
            failurePhase: "execution" as const,
            error: "retry test stopped",
            repositoryCredentialNames: [],
            commits: [],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "record.json"),
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const result = await service.runCycle();

      const attempts = (await store.read()).attempts;
      expect(attempts).toHaveLength(2);
      expect(
        attempts.find((attempt) => attempt.attemptId === expired.attemptId)
          ?.status,
      ).toBe("interrupted");
      expect(execution.execute.mock.calls[0]?.[0].attemptId).toBe(
        `${expired.attemptId}:retry`,
      );
      expect(result.events[0]).toMatchObject({
        state: "claimed",
        reasonCode: "safe_retry",
      });
      expect(source.discover).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops new polling and delegates graceful-shutdown cancellation to execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      const source = {
        discover: vi.fn(async () => [task]),
        read: vi.fn(async () => ({ task, relatedTasks: [] })),
      };
      let observedSignal: AbortSignal | undefined;
      const execution = {
        execute: vi.fn(async (attempt, executionOptions) => {
          observedSignal = executionOptions?.signal;
          await store.markAttemptStarted(attempt.attemptId);
          if (!observedSignal?.aborted) {
            await new Promise<void>((resolve) => {
              observedSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          await store.transitionAttempt(attempt.attemptId, {
            status: "interrupted",
            evidence: ["shutdown://signal"],
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "interrupted" as const,
            failurePhase: "execution" as const,
            error: "worker shutting down",
            repositoryCredentialNames: [],
            commits: [],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "record.json"),
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const running = service.start();
      await vi.waitFor(() => expect(execution.execute).toHaveBeenCalledOnce());
      await service.stop();
      await running;

      expect(observedSignal?.aborted).toBe(true);
      expect(source.discover).toHaveBeenCalledOnce();
      expect((await store.read()).attempts[0]?.status).toBe("interrupted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not claim or dispatch when shutdown starts during discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let releaseDiscovery!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const source = {
        discover: vi.fn(async () => {
          await blocked;
          return [task];
        }),
        read: vi.fn(async () => ({ task, relatedTasks: [] })),
      };
      const execution = { execute: vi.fn() };
      const service = createWorkerService({
        configuration,
        source,
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
      });

      const running = service.start();
      await vi.waitFor(() => expect(source.discover).toHaveBeenCalledOnce());
      const stopping = service.stop();
      releaseDiscovery();
      await stopping;
      await running;

      expect(source.read).not.toHaveBeenCalled();
      expect(execution.execute).not.toHaveBeenCalled();
      expect((await store.read()).attempts).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not dispatch when shutdown starts during a running diagnostic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let releaseDiagnostic!: () => void;
      let runningObserved!: () => void;
      const blockedDiagnostic = new Promise<void>((resolve) => {
        releaseDiagnostic = resolve;
      });
      const observedRunning = new Promise<void>((resolve) => {
        runningObserved = resolve;
      });
      const execution = { execute: vi.fn() };
      const service = createWorkerService({
        configuration,
        source: {
          discover: async () => [task],
          read: async () => ({ task, relatedTasks: [] }),
        },
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
        diagnostics: {
          emit: async (event) => {
            if (event.state === "running") {
              runningObserved();
              await blockedDiagnostic;
            }
          },
        },
      });

      const running = service.start();
      await observedRunning;
      const stopping = service.stop();
      releaseDiagnostic();
      await stopping;
      await running;

      expect(execution.execute).not.toHaveBeenCalled();
      expect((await store.read()).attempts[0]).toMatchObject({
        status: "active",
        claim: { phase: "claimed" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels an execution that exceeds the configured service timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-service-"));
    try {
      const store = createWorkerStateStore({
        filePath: join(directory, "state.json"),
      });
      let abortReason: unknown;
      const execution = {
        execute: vi.fn(async (attempt, executionOptions) => {
          await store.markAttemptStarted(attempt.attemptId);
          const signal = executionOptions?.signal;
          if (signal?.aborted) {
            abortReason = signal.reason;
          } else {
            await new Promise<void>((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  abortReason = signal.reason;
                  resolve();
                },
                { once: true },
              );
            });
          }
          await store.transitionAttempt(attempt.attemptId, {
            status: "interrupted",
          });
          return {
            attemptId: attempt.attemptId,
            taskId: attempt.request.taskId,
            executionIdentity: attempt.executionIdentity,
            baseCommit: attempt.request.task.baseCommit,
            profileId: attempt.request.profileId,
            profileDigest: attempt.request.profileDigest,
            promptVersion: attempt.request.promptVersion,
            promptTemplateDigest: attempt.request.promptTemplateDigest,
            repository: attempt.request.task.repository,
            status: "interrupted" as const,
            failurePhase: "execution" as const,
            error: "execution timed out",
            repositoryCredentialNames: [],
            commits: [],
            setup: [],
            verification: [],
            published: false as const,
            recordPath: join(directory, "record.json"),
          };
        }),
      };
      const service = createWorkerService({
        configuration,
        source: {
          discover: async () => [task],
          read: async () => ({ task, relatedTasks: [] }),
        },
        store,
        execution,
        publisher: {} as never,
        owner: "worker-1",
        lockFilePath: join(directory, "service.lock"),
        pollIntervalMs: 1_000,
        leaseDurationMs: 60_000,
        executionTimeoutMs: 5,
      });

      const result = await service.runCycle();

      expect(abortReason).toBeInstanceOf(WorkerExecutionTimeoutError);
      expect(result.events.at(-1)).toMatchObject({ state: "failed" });
      expect((await store.read()).attempts[0]?.status).toBe("interrupted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
