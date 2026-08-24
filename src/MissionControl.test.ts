import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWorkerDryRun,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  createMissionControlHost,
  type MissionControlConfiguration,
} from "./MissionControl.js";
import type {
  RepositoryWorkflowCoordinator,
  RepositoryWorkflowCoordinatorMode,
} from "./RepositoryWorkflowCoordinator.js";
import type {
  RepositoryWorkflowControl,
  RepositoryWorkflowProjection,
} from "./RepositoryWorkflowControl.js";
import { WorkerServiceLockError } from "./WorkerService.js";

const task: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 13,
  title: "Keep this task out of the overview payload",
  body: "GITHUB_TOKEN=TOP_SECRET",
  labels: [],
  sourceRevision: "issue-13",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const workerConfiguration = {
  repositories: {},
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement {{TASK_SNAPSHOT}}" },
  profiles: {},
};

const inspectionWorkerConfiguration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
      baseBranch: "main",
      profileId: "node",
    },
  },
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement {{TASK_SNAPSHOT}}" },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
  },
};

const inspectionParent: NormalizedTask = {
  repository: "acme/app",
  kind: "prd",
  number: 12,
  title: "Mission Control PRD",
  body: "Parent context",
  author: "maintainer",
  labels: ["prd"],
  sourceRevision: "prd-revision-1",
  baseBranch: "main",
  baseCommit: "b".repeat(40),
  state: "open",
  dependencies: [],
  children: [{ repository: "acme/app", kind: "issue", number: 21 }],
};

const inspectionReadyTask: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 21,
  title: "Inspect the running task",
  body: "This task body is retained server-side.",
  author: "maintainer",
  labels: ["ready-for-agent"],
  sourceRevision: "issue-revision-21",
  baseBranch: "main",
  baseCommit: "c".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
  parentPrd: { repository: "acme/app", kind: "prd", number: 12 },
};

const inspectionQueuedTask: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 22,
  title: "Remain in the deterministic queue",
  body: "Queue task body",
  author: "maintainer",
  labels: ["ready-for-agent"],
  sourceRevision: "issue-revision-22",
  baseBranch: "main",
  baseCommit: "d".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
};

const temporaryDirectories: string[] = [];

const createConfiguration = (
  workspaceRoot: string,
): MissionControlConfiguration => ({
  worker: workerConfiguration,
  workspaceRoot,
  owner: "mission-control-test",
  pollIntervalMs: 60_000,
  leaseDurationMs: 60_000,
  github: { token: "TOP_SECRET" },
  server: { port: 0 },
});

const createHost = async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sandcastle-mission-control-"),
  );
  temporaryDirectories.push(directory);
  const source = {
    discover: vi.fn(async () => [task]),
    read: vi.fn(async () => undefined),
  };
  const host = createMissionControlHost({
    configuration: createConfiguration(directory),
    boundaries: {
      source,
      repositoryManager: { prepare: vi.fn() },
      execution: { execute: vi.fn() },
      publisher: { publish: vi.fn() },
    },
  });
  const address = await host.listen();
  return { address, host, source };
};

const postCommand = async (
  address: { readonly host: string; readonly port: number },
  request: Record<string, unknown>,
) =>
  fetch(`http://${address.host}:${address.port}/api/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

const readSseEvents = async (
  address: { readonly host: string; readonly port: number },
  lastEventId: number,
  expected: number,
): Promise<readonly Record<string, unknown>[]> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: address.host,
        port: address.port,
        path: "/api/v1/events",
        headers: { "Last-Event-ID": String(lastEventId) },
      },
      (response) => {
        let buffer = "";
        const events: Record<string, unknown>[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split(/\r?\n/)
              .find((line) => line.startsWith("data:"));
            if (data === undefined) continue;
            events.push(JSON.parse(data.slice("data:".length).trim()));
            if (events.length >= expected) {
              request.destroy();
              resolve(events);
              return;
            }
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") reject(error);
    });
    request.end();
  });

const createInspectionHost = async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sandcastle-mission-control-inspection-"),
  );
  temporaryDirectories.push(directory);
  const configuration: MissionControlConfiguration = {
    ...createConfiguration(directory),
    worker: inspectionWorkerConfiguration,
  };
  const source = {
    discover: vi.fn(async () => [
      inspectionParent,
      inspectionReadyTask,
      inspectionQueuedTask,
    ]),
    read: vi.fn(async () => undefined),
  };
  const host = createMissionControlHost({
    configuration,
    boundaries: {
      source,
      repositoryManager: { prepare: vi.fn() },
      execution: { execute: vi.fn() },
      publisher: { publish: vi.fn() },
    },
  });
  const result = runWorkerDryRun({
    configuration: inspectionWorkerConfiguration,
    tasks: [inspectionParent, inspectionReadyTask, inspectionQueuedTask],
  });
  await host.store.recordDiscovery(result, {
    discoveredAt: "2026-08-24T10:00:00.000Z",
  });
  for (const decision of result.decisions) {
    await host.diagnostics.emit({
      timestamp: "2026-08-24T10:00:01.000Z",
      state: "discovered",
      taskId: decision.taskId,
      message: `Discovered ${decision.taskId}.`,
    });
    await host.diagnostics.emit({
      timestamp: "2026-08-24T10:00:02.000Z",
      state:
        decision.reasonCode === "eligible"
          ? "ready"
          : decision.reasonCode === "prd"
            ? "ineligible"
            : "unauthorized",
      taskId: decision.taskId,
      reasonCode: decision.reasonCode,
      message: decision.reason,
    });
  }
  const readyRequest = result.executionRequests.find(
    (request) => request.taskId === "acme/app:issue:21",
  )!;
  const attempt = await host.store.claimAttempt(readyRequest, {
    owner: "mission-control-test",
    leaseDurationMs: 60_000,
    claimedAt: "2026-08-24T10:00:03.000Z",
    refreshedSnapshots: [inspectionReadyTask, inspectionParent],
    attemptId: "attempt:inspection-21",
  });
  await host.store.markAttemptStarted(attempt.attemptId);
  await host.diagnostics.emit({
    timestamp: "2026-08-24T10:00:04.000Z",
    state: "claimed",
    taskId: readyRequest.taskId,
    attemptId: attempt.attemptId,
    executionIdentity: readyRequest.executionIdentity,
    message: "Claimed inspection task.",
  });
  await host.diagnostics.emit({
    timestamp: "2026-08-24T10:00:05.000Z",
    state: "running",
    taskId: readyRequest.taskId,
    attemptId: attempt.attemptId,
    executionIdentity: readyRequest.executionIdentity,
    message: "Running inspection task.",
  });
  const recordPath = join(
    host.paths.recordsRoot,
    "repositories",
    "acme",
    "app",
    "executions",
    readyRequest.executionIdentity,
    "attempt-record.json",
  );
  await mkdir(join(recordPath, ".."), { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      attemptId: attempt.attemptId,
      taskId: readyRequest.taskId,
      executionIdentity: readyRequest.executionIdentity,
      repository: "acme/app",
      status: "failed",
      failurePhase: "verification",
      error: `verification failed at ${host.paths.workspaceRoot}/repositories/acme/app`,
      baseCommit: inspectionReadyTask.baseCommit,
      profileId: "node",
      profileDigest: readyRequest.profileDigest,
      promptVersion: "worker-v1",
      promptTemplateDigest: readyRequest.promptTemplateDigest,
      branch: "sandcastle/acme-app-issue-21",
      repositoryDir: "/should-not-be-exposed/repository",
      worktreePath: "/should-not-be-exposed/worktree",
      commits: [{ sha: "e".repeat(40) }],
      setup: [
        {
          command: "npm ci",
          phase: "setup",
          exitCode: 0,
          stdout: "setup ok",
          stderr: "",
        },
      ],
      verification: [
        {
          command: "npm test",
          phase: "verification",
          exitCode: 1,
          stdout: "GITHUB_TOKEN=TOP_SECRET",
          stderr: `failed at ${host.paths.repositoriesRoot}/logs/worker.log`,
        },
      ],
      published: false,
      recordPath,
    }),
    "utf8",
  );
  await host.store.transitionAttempt(attempt.attemptId, {
    status: "failed",
    timestamp: "2026-08-24T10:00:06.000Z",
    evidence: [
      recordPath,
      "https://github.com/acme/app/pull/21",
      "worker://verification/failed",
      "https://operator:password@github.com/acme/app/pull/22",
    ],
  });
  await host.diagnostics.emit({
    timestamp: "2026-08-24T10:00:06.000Z",
    state: "failed",
    taskId: readyRequest.taskId,
    attemptId: attempt.attemptId,
    executionIdentity: readyRequest.executionIdentity,
    reasonCode: "verification",
    message: `Verification failed for inspection task at ${host.paths.recordsRoot}.`,
  });
  const address = await host.listen();
  return { address, host, recordPath, result };
};

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("Mission Control host", () => {
  it("serves a responsive read-only overview through the public HTTP interface", async () => {
    const { address, host, source } = await createHost();
    try {
      expect(address.host).toBe("127.0.0.1");
      await host.service.runCycle();

      const overviewResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/overview`,
      );
      expect(overviewResponse.status).toBe(200);
      const overview = (await overviewResponse.json()) as Record<
        string,
        unknown
      >;

      expect(overview).toMatchObject({
        version: 1,
        mode: "stopped",
        activeAttempt: null,
        recoveryWarnings: [],
        operationalStateCounts: {
          unauthorized: 1,
          ready: 0,
        },
      });
      expect(overview.lastCompletedCycle).toEqual(expect.any(String));
      expect(JSON.stringify(overview)).not.toContain("TOP_SECRET");
      expect(source.discover).toHaveBeenCalledOnce();

      const page = await fetch(`http://${address.host}:${address.port}/`);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Mission Control");
      expect(html).toContain("/api/v1/overview");
      expect(html).toContain("/api/v1/commands");
      expect(html).toMatch(/@media[^{]*\{/);
    } finally {
      await host.stop();
    }
  });

  it("projects safe retry, safe resume, and manual intervention distinctly", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-"),
    );
    temporaryDirectories.push(directory);
    const worker = {
      ...workerConfiguration,
      repositories: {
        "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
      },
      profiles: { node: { setupCommands: [], verificationCommands: ["true"] } },
    };
    const configuration = {
      ...createConfiguration(directory),
      worker,
    } satisfies MissionControlConfiguration;
    const host = createMissionControlHost({
      configuration,
      boundaries: {
        source: { discover: vi.fn(async () => []), read: vi.fn() },
        repositoryManager: { prepare: vi.fn() },
        execution: { execute: vi.fn() },
        publisher: { publish: vi.fn() },
      },
    });
    const safeRetryTask = { ...task, number: 16 };
    const safeResumeTask = { ...task, number: 17 };
    const manualTask = { ...task, number: 18 };
    try {
      const requests = runWorkerDryRun({
        configuration: worker,
        tasks: [safeRetryTask, safeResumeTask, manualTask],
      }).executionRequests;
      const safeRetry = await host.store.claimAttempt(requests[0]!, {
        owner: "mission-control-test",
        leaseDurationMs: 1_000,
        claimedAt: "2000-01-01T00:00:00.000Z",
      });
      await host.store.claimAttempt(requests[1]!, {
        owner: "mission-control-test",
        leaseDurationMs: 60 * 60_000,
        claimedAt: new Date().toISOString(),
      });
      const manual = await host.store.claimAttempt(requests[2]!, {
        owner: "mission-control-test",
        leaseDurationMs: 1_000,
        claimedAt: "2000-01-01T00:00:00.000Z",
      });
      await host.store.markAttemptStarted(manual.attemptId);

      const overview = await host.getOverview();

      expect(overview.recoveryWarnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptId: safeRetry.attemptId,
            reasonCode: "safe_retry",
            availableActions: ["retry"],
          }),
          expect.objectContaining({
            reasonCode: "safe_resume",
            availableActions: [],
          }),
          expect.objectContaining({
            attemptId: manual.attemptId,
            reasonCode: "manual_intervention",
            availableActions: ["acknowledge"],
          }),
        ]),
      );

      const page = await fetch(
        `http://${(await host.listen()).host}:${(await host.listen()).port}/`,
      );
      const html = await page.text();
      expect(html).toContain("Safe retry");
      expect(html).toContain("Safe resume");
      expect(html).toContain("Manual intervention");
      expect(html).toContain("Retry safely");
      expect(html).toContain("Acknowledge manual intervention");
    } finally {
      await host.stop();
    }
  });

  it("accepts manual acknowledgement through the guarded HTTP command surface", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-"),
    );
    temporaryDirectories.push(directory);
    const worker = {
      ...workerConfiguration,
      repositories: {
        "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
      },
      profiles: { node: { setupCommands: [], verificationCommands: ["true"] } },
    };
    const host = createMissionControlHost({
      configuration: { ...createConfiguration(directory), worker },
      boundaries: {
        source: { discover: vi.fn(async () => []), read: vi.fn() },
        repositoryManager: { prepare: vi.fn() },
        execution: { execute: vi.fn() },
        publisher: { publish: vi.fn() },
      },
    });
    try {
      const request = runWorkerDryRun({
        configuration: worker,
        tasks: [{ ...task, number: 19 }],
      }).executionRequests[0]!;
      const retained = await host.store.claimAttempt(request, {
        owner: "mission-control-test",
        leaseDurationMs: 1_000,
        claimedAt: "2000-01-01T00:00:00.000Z",
      });
      await host.store.markAttemptStarted(retained.attemptId);
      const before = await readFile(host.paths.stateFilePath, "utf8");
      const address = await host.listen();

      const response = await postCommand(address, {
        command: "acknowledge",
        commandId: "http-manual-ack",
        expectedRevision: 0,
        attemptId: retained.attemptId,
        operator: "alice",
        reason: "reviewed retained evidence",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        command: "acknowledge",
        code: "accepted",
        reasonCode: "manual_intervention",
      });
      expect(await readFile(host.paths.stateFilePath, "utf8")).toBe(before);

      const duplicate = await postCommand(address, {
        command: "acknowledge",
        commandId: "http-manual-ack",
        expectedRevision: 99,
      });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({
        commandId: "http-manual-ack",
        code: "accepted",
      });
    } finally {
      await host.stop();
    }
  });

  it("keeps the worker single-instance lock when Mission Control starts", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-"),
    );
    temporaryDirectories.push(directory);
    const configuration = createConfiguration(directory);
    const makeHost = (source: {
      discover: () => Promise<readonly NormalizedTask[]>;
      read: () => Promise<undefined>;
    }) =>
      createMissionControlHost({
        configuration,
        boundaries: {
          source,
          repositoryManager: { prepare: vi.fn() },
          execution: { execute: vi.fn() },
          publisher: { publish: vi.fn() },
        },
      });
    const firstSource = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => undefined),
    };
    const secondSource = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => undefined),
    };
    const first = makeHost(firstSource);
    const second = makeHost(secondSource);
    const firstRunning = first.start();
    try {
      await vi.waitFor(() => expect(firstSource.discover).toHaveBeenCalled());
      await expect(second.start()).rejects.toBeInstanceOf(
        WorkerServiceLockError,
      );
      expect(secondSource.discover).not.toHaveBeenCalled();
    } finally {
      await first.stop();
      await firstRunning;
      await second.stop();
    }
  });

  it("owns workflow startup after the worker lock and reports all production components", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-authority-"),
    );
    temporaryDirectories.push(directory);
    let coordinatorMode: RepositoryWorkflowCoordinatorMode = "stopped";
    const control = {
      authorize: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => undefined),
      runNow: vi.fn(async () => {
        throw new Error("not expected");
      }),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
    } satisfies RepositoryWorkflowControl;
    const coordinator = {
      control,
      start: vi.fn(async () => {
        coordinatorMode = "running";
      }),
      stop: vi.fn(async () => {
        coordinatorMode = "stopped";
      }),
      status: () => ({ mode: coordinatorMode }),
      runCycle: vi.fn(async () => undefined),
    } satisfies RepositoryWorkflowCoordinator;
    const source = {
      discover: vi.fn(async () => []),
      read: vi.fn(async () => undefined),
    };
    const host = createMissionControlHost({
      configuration: createConfiguration(directory),
      boundaries: {
        source,
        workflowCoordinator: coordinator,
        repositoryManager: { prepare: vi.fn() },
        execution: { execute: vi.fn() },
        publisher: { publish: vi.fn() },
      },
    });

    const running = host.start();
    await vi.waitFor(() => expect(coordinator.start).toHaveBeenCalledOnce());
    const address = await host.listen();
    const statusResponse = await fetch(
      `http://${address.host}:${address.port}/api/v1/status`,
    );
    expect(await statusResponse.json()).toMatchObject({
      orchestration: {
        authority: "mission-control-host",
        mode: "running",
        lock: "owned",
        components: {
          worker: { mode: "running" },
          workflowCoordinator: { mode: "running" },
          missionControl: { mode: "listening" },
          eventStream: { mode: "ready" },
        },
      },
    });
    expect(source.discover).toHaveBeenCalled();

    await host.stop();
    await running;
    expect(coordinator.stop).toHaveBeenCalledOnce();
    expect(host.service.status().mode).toBe("stopped");
  });

  it("serves the authoritative repository workflow projection and embeds it in overview", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-workflows-"),
    );
    temporaryDirectories.push(directory);
    const projection = {
      version: 1,
      revision: 7,
      generatedAt: "2026-08-24T12:00:00.000Z",
      repositories: [
        {
          repository: "acme/app",
          workflowId: "repo-work-v1",
          workflowIdentity: "acme/app:repo-work-v1",
          revision: 7,
          stage: "running" as const,
          runId: "run-22",
          task: {
            taskId: "acme/app:issue:22",
            repository: "acme/app",
            kind: "issue" as const,
            number: 22,
            title: "Schedule repository workflows transactionally",
            stage: "implementing",
          },
          owner: "scheduler",
          claimedAt: "2026-08-24T11:59:00.000Z",
          startedAt: "2026-08-24T11:59:01.000Z",
          updatedAt: "2026-08-24T11:59:02.000Z",
        },
      ],
      queue: [],
      entries: [],
    } satisfies RepositoryWorkflowProjection;
    const control = {
      authorize: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => undefined),
      runNow: vi.fn(async () => {
        throw new Error("not expected");
      }),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      getProjection: vi.fn(async () => projection),
    } satisfies RepositoryWorkflowControl;
    const host = createMissionControlHost({
      configuration: createConfiguration(directory),
      boundaries: {
        repositoryWorkflows: control,
        source: { discover: vi.fn(async () => []), read: vi.fn() },
        repositoryManager: { prepare: vi.fn() },
        execution: { execute: vi.fn() },
        publisher: { publish: vi.fn() },
      },
    });
    try {
      expect((await host.getOverview()).repositoryWorkflows).toEqual(
        projection,
      );
      const address = await host.listen();
      const response = await fetch(
        `http://${address.host}:${address.port}/api/v1/workflows`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(projection);
    } finally {
      await host.stop();
    }
  });

  it("allows only one host-owned dispatcher through restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-restart-authority-"),
    );
    temporaryDirectories.push(directory);
    const makeCoordinator = () => {
      let mode: RepositoryWorkflowCoordinatorMode = "stopped";
      const control = {
        authorize: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        inspect: vi.fn(async () => undefined),
        runNow: vi.fn(async () => {
          throw new Error("not expected");
        }),
        pause: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
      } satisfies RepositoryWorkflowControl;
      return {
        control,
        start: vi.fn(async () => {
          mode = "running";
        }),
        stop: vi.fn(async () => {
          mode = "stopped";
        }),
        status: () => ({ mode }),
        runCycle: vi.fn(async () => undefined),
      } satisfies RepositoryWorkflowCoordinator;
    };
    const makeHost = (coordinator: RepositoryWorkflowCoordinator) =>
      createMissionControlHost({
        configuration: createConfiguration(directory),
        boundaries: {
          workflowCoordinator: coordinator,
          source: {
            discover: vi.fn(async () => []),
            read: vi.fn(async () => undefined),
          },
          repositoryManager: { prepare: vi.fn() },
          execution: { execute: vi.fn() },
          publisher: { publish: vi.fn() },
        },
      });

    const firstCoordinator = makeCoordinator();
    const first = makeHost(firstCoordinator);
    const firstRun = first.start();
    await vi.waitFor(() =>
      expect(firstCoordinator.start).toHaveBeenCalledOnce(),
    );

    const competingCoordinator = makeCoordinator();
    const competing = makeHost(competingCoordinator);
    await expect(competing.start()).rejects.toBeInstanceOf(
      WorkerServiceLockError,
    );
    expect(competingCoordinator.start).not.toHaveBeenCalled();

    await first.stop();
    await firstRun;
    await competing.stop();

    const restartedCoordinator = makeCoordinator();
    const restarted = makeHost(restartedCoordinator);
    const restartedRun = restarted.start();
    try {
      await vi.waitFor(() =>
        expect(restartedCoordinator.start).toHaveBeenCalledOnce(),
      );
    } finally {
      await restarted.stop();
      await restartedRun;
    }
  });

  it("rejects invalid central configuration before creating an HTTP-ready host", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-"),
    );
    temporaryDirectories.push(directory);
    const source = {
      discover: vi.fn(async () => [task]),
      read: vi.fn(async () => undefined),
    };

    expect(() =>
      createMissionControlHost({
        configuration: {
          ...createConfiguration(directory),
          worker: {
            ...workerConfiguration,
            repositories: {
              "acme/app": {
                authorized: true,
                baseBranch: "main",
                profileId: "missing",
              },
            },
          },
        },
        boundaries: { source },
      }),
    ).toThrow(/missing profile/i);
    expect(source.discover).not.toHaveBeenCalled();
  });

  it("guards runtime commands with a revision, idempotency key, and append-only audit", async () => {
    const { address, host, source } = await createHost();
    try {
      const statusResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/status`,
      );
      expect(statusResponse.status).toBe(200);
      const initialStatus = (await statusResponse.json()) as {
        revision: number;
        mode: string;
      };
      expect(initialStatus).toMatchObject({ revision: 0, mode: "stopped" });

      const pauseRequest = {
        command: "pause",
        commandId: "pause-for-maintenance",
        expectedRevision: initialStatus.revision,
        reason: "maintenance window",
      };
      const pauseResponse = await postCommand(address, pauseRequest);
      expect(pauseResponse.status).toBe(200);
      const pauseOutcome = await pauseResponse.json();
      expect(pauseOutcome).toMatchObject({
        version: 1,
        command: "pause",
        commandId: pauseRequest.commandId,
        code: "accepted",
        revision: 1,
      });

      const duplicateResponse = await postCommand(address, {
        ...pauseRequest,
        expectedRevision: 999,
        reason: undefined,
      });
      expect(duplicateResponse.status).toBe(200);
      expect(await duplicateResponse.json()).toEqual(pauseOutcome);

      const staleResponse = await postCommand(address, {
        command: "resume",
        commandId: "stale-resume",
        expectedRevision: 0,
        reason: "resume after maintenance",
      });
      expect(staleResponse.status).toBe(409);
      expect(await staleResponse.json()).toMatchObject({
        code: "stale_revision",
        revision: 1,
      });
      expect(source.discover).not.toHaveBeenCalled();

      const audit = (await readFile(host.paths.operatorAuditFilePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(audit.map((record) => record.kind)).toEqual([
        "request",
        "outcome",
        "request",
        "outcome",
      ]);
      expect(JSON.stringify(audit)).not.toContain("TOP_SECRET");
    } finally {
      await host.stop();
    }
  });

  it("projects repository-qualified tasks, the worker queue, and an attempt timeline", async () => {
    const { address, host, recordPath } = await createInspectionHost();
    try {
      const inboxResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/tasks`,
      );
      expect(inboxResponse.status).toBe(200);
      const inbox = (await inboxResponse.json()) as {
        tasks: readonly Record<string, unknown>[];
      };
      const ready = inbox.tasks.find(
        (candidate) => candidate.taskId === "acme/app:issue:21",
      );
      expect(ready).toMatchObject({
        taskId: "acme/app:issue:21",
        repository: "acme/app",
        kind: "issue",
        number: 21,
        state: "failed",
        sourceState: "open",
        authorizationSource: "repository",
        eligibilityReasonCode: "eligible",
        sourceRevision: "issue-revision-21",
        baseBranch: "main",
        baseCommit: "c".repeat(40),
        profileId: "node",
        promptVersion: "worker-v1",
        executionIdentity: expect.any(String),
        parentPrd: {
          repository: "acme/app",
          kind: "prd",
          number: 12,
        },
        dependencies: [],
        attemptIds: ["attempt:inspection-21"],
      });
      expect(JSON.stringify(ready)).not.toContain("This task body");

      const queueResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/queue`,
      );
      expect(queueResponse.status).toBe(200);
      const queue = (await queueResponse.json()) as {
        source: string;
        queue: readonly Record<string, unknown>[];
      };
      expect(queue.source).toBe("worker");
      expect(queue.queue).toMatchObject([
        {
          position: 1,
          taskId: "acme/app:issue:22",
          executionIdentity: expect.any(String),
        },
      ]);

      const attemptResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/attempts/${encodeURIComponent("attempt:inspection-21")}`,
      );
      expect(attemptResponse.status).toBe(200);
      const attempt = (await attemptResponse.json()) as Record<string, any>;
      expect(attempt).toMatchObject({
        attemptId: "attempt:inspection-21",
        taskId: "acme/app:issue:21",
        executionIdentity: expect.any(String),
        status: "failed",
        claim: {
          owner: "mission-control-test",
          sourceRevision: "issue-revision-21",
          phase: "started",
        },
        task: {
          taskId: "acme/app:issue:21",
          parentPrd: { number: 12 },
        },
        timeline: [
          expect.objectContaining({ state: "claimed" }),
          expect.objectContaining({ state: "running" }),
          expect.objectContaining({ state: "failed" }),
        ],
      });
      expect(attempt.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "record", available: true }),
          expect.objectContaining({
            kind: "pull_request",
            url: "https://github.com/acme/app/pull/21",
          }),
          expect.objectContaining({
            kind: "reference",
            available: false,
            reasonCode: "unsupported",
          }),
        ]),
      );
      expect(JSON.stringify(attempt)).not.toContain(host.paths.recordsRoot);
      expect(JSON.stringify(attempt)).not.toContain("/should-not-be-exposed");

      const recordEvidence = attempt.evidence.find(
        (evidence: Record<string, unknown>) => evidence.kind === "record",
      );
      const evidenceResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/evidence/${encodeURIComponent(recordEvidence.id as string)}`,
      );
      expect(evidenceResponse.status).toBe(200);
      const evidence = await evidenceResponse.json();
      expect(evidence).toMatchObject({
        version: 1,
        kind: "record",
        record: {
          attemptId: "attempt:inspection-21",
          status: "failed",
          verification: [{ command: "npm test", exitCode: 1 }],
        },
      });
      expect(JSON.stringify(evidence)).not.toContain("TOP_SECRET");
      expect(JSON.stringify(evidence)).not.toContain(host.paths.recordsRoot);
      expect(JSON.stringify(evidence)).not.toContain("password");
      const scopedEvidenceResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/tasks/${encodeURIComponent("acme/app:issue:21")}/attempts/${encodeURIComponent("attempt:inspection-21")}/evidence/${encodeURIComponent(recordEvidence.id as string)}`,
      );
      expect(scopedEvidenceResponse.status).toBe(200);

      const outsidePath = join(host.paths.workspaceRoot, "outside-record.json");
      await writeFile(outsidePath, "outside durable records", "utf8");
      await rm(recordPath, { force: true });
      await symlink(outsidePath, recordPath);
      const escapedAttemptResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/attempts/${encodeURIComponent("attempt:inspection-21")}`,
      );
      const escapedAttempt = (await escapedAttemptResponse.json()) as {
        evidence: readonly Record<string, unknown>[];
      };
      expect(escapedAttempt.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "record",
            available: false,
            reasonCode: "path_escape",
          }),
        ]),
      );
      expect(JSON.stringify(escapedAttempt)).not.toContain(outsidePath);

      const arbitraryPathResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/evidence?path=${encodeURIComponent("/etc/passwd")}`,
      );
      expect(arbitraryPathResponse.status).toBe(400);
    } finally {
      await host.stop();
    }
  });

  it("replays ordered operational events after Last-Event-ID without duplicating acknowledged events", async () => {
    const { address, host } = await createInspectionHost();
    try {
      const events = await readSseEvents(address, 2, 3);
      expect(events.map((event) => event.id)).toEqual([3, 4, 5]);
      expect(events.map((event) => event.event)).toEqual([
        expect.objectContaining({ state: "discovered" }),
        expect.objectContaining({ state: "ready" }),
        expect.objectContaining({ state: "discovered" }),
      ]);
    } finally {
      await host.stop();
    }
  });

  it("stages policy validation, exact-task preview, and revision-checked atomic apply", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-policy-"),
    );
    temporaryDirectories.push(directory);
    const policyTask = {
      ...task,
      number: 17,
      body: "GITHUB_TOKEN=POLICY_TASK_SECRET",
    };
    const siblingTask = {
      ...task,
      number: 18,
      body: "Sibling task must remain unauthorized.",
    };
    const policyConfiguration = {
      repositories: {
        "acme/app": {
          authorized: false,
          baseBranch: "main",
          profileId: "node",
        },
      },
      authorizedTasks: [],
      promptVersion: "worker-v1",
      promptTemplates: {
        "worker-v1": "GITHUB_TOKEN=PROMPT_SECRET\nImplement {{TASK_SNAPSHOT}}",
      },
      profiles: {
        node: {
          setupCommands: ["echo GITHUB_TOKEN=PROFILE_SECRET"],
          verificationCommands: ["npm test"],
        },
      },
    };
    const source = {
      discover: vi.fn(async () => [policyTask, siblingTask]),
      read: vi.fn(async () => undefined),
    };
    const host = createMissionControlHost({
      configuration: {
        ...createConfiguration(directory),
        worker: policyConfiguration,
      },
      boundaries: {
        source,
        repositoryManager: { prepare: vi.fn() },
        execution: { execute: vi.fn() },
        publisher: { publish: vi.fn() },
      },
    });
    const address = await host.listen();
    await host.store.recordDiscovery(
      runWorkerDryRun({
        configuration: policyConfiguration,
        tasks: [policyTask, siblingTask],
      }),
    );
    const proposedConfiguration = {
      ...policyConfiguration,
      authorizedTasks: [
        { repository: "acme/app", kind: "issue" as const, number: 17 },
      ],
    };
    try {
      const inspectionResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy`,
      );
      expect(inspectionResponse.status).toBe(200);
      const inspection = await inspectionResponse.json();
      expect(inspection).toMatchObject({
        version: 1,
        workerRevision: 0,
        policy: {
          repositories: [
            expect.objectContaining({
              repository: "acme/app",
              authorized: false,
              profileId: "node",
            }),
          ],
          authorizedTasks: [],
          executionProfiles: [expect.objectContaining({ profileId: "node" })],
        },
      });
      expect(JSON.stringify(inspection)).not.toContain("SECRET");

      const invalidValidationResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/validate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            configuration: {
              ...policyConfiguration,
              promptTemplates: { "worker-v1": "missing marker" },
            },
          }),
        },
      );
      expect(invalidValidationResponse.status).toBe(422);
      expect(await invalidValidationResponse.json()).toMatchObject({
        version: 1,
        valid: false,
        code: "invalid_policy",
      });
      expect((await host.policy.inspect()).policy.authorizedTasks).toEqual([]);

      const previewResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configuration: proposedConfiguration }),
        },
      );
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as {
        previewId: string;
      } & Record<string, unknown>;
      expect(preview).toMatchObject({
        version: 1,
        workerRevision: 0,
        diff: expect.arrayContaining([
          expect.objectContaining({
            path: "authorizedTasks.acme/app:issue:17",
            kind: "added",
          }),
        ]),
        dryRunImpact: {
          proposed: {
            decisions: expect.arrayContaining([
              expect.objectContaining({
                taskId: "acme/app:issue:17",
                authorization: "task",
                eligible: true,
              }),
              expect.objectContaining({
                taskId: "acme/app:issue:18",
                authorization: "none",
                eligible: false,
              }),
            ]),
          },
        },
      });
      expect(JSON.stringify(preview)).not.toContain("SECRET");

      const unpreviewedResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previewId: "not-a-real-preview",
            commandId: "policy-unpreviewed",
            expectedWorkerRevision: 0,
            reason: "try without a retained preview",
            configuration: proposedConfiguration,
          }),
        },
      );
      expect(unpreviewedResponse.status).toBe(409);
      expect(
        ((await unpreviewedResponse.json()) as { code: string }).code,
      ).toBe("unpreviewed");

      const pauseResponse = await postCommand(address, {
        command: "pause",
        commandId: "policy-stale-pause",
        expectedRevision: 0,
        reason: "make the policy preview stale",
      });
      expect(pauseResponse.status).toBe(200);
      const staleResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previewId: preview.previewId,
            commandId: "policy-stale-apply",
            expectedWorkerRevision: 0,
            reason: "stale policy tab",
            configuration: proposedConfiguration,
          }),
        },
      );
      expect(staleResponse.status).toBe(409);
      expect(((await staleResponse.json()) as { code: string }).code).toBe(
        "stale_revision",
      );

      const currentPreviewResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configuration: proposedConfiguration }),
        },
      );
      const currentPreview = (await currentPreviewResponse.json()) as {
        previewId: string;
      };
      const applyResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previewId: currentPreview.previewId,
            commandId: "policy-apply-17",
            expectedWorkerRevision: 1,
            reason: "authorize only the exact requested task",
            configuration: proposedConfiguration,
          }),
        },
      );
      expect(applyResponse.status).toBe(200);
      const applied = await applyResponse.json();
      expect(applied).toMatchObject({
        code: "accepted",
        commandId: "policy-apply-17",
        revision: 2,
        auditReference: expect.stringContaining("policy"),
      });

      const duplicateResponse = await fetch(
        `http://${address.host}:${address.port}/api/v1/policy/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            previewId: currentPreview.previewId,
            commandId: "policy-apply-17",
            expectedWorkerRevision: 999,
            reason: "retry over the network",
            configuration: proposedConfiguration,
          }),
        },
      );
      expect(duplicateResponse.status).toBe(200);
      expect(await duplicateResponse.json()).toEqual(applied);

      const after = await host.policy.inspect();
      expect(after.policy.authorizedTasks).toEqual([
        { repository: "acme/app", kind: "issue", number: 17 },
      ]);
      const policyFile = await readFile(host.policyFilePath, "utf8");
      expect(policyFile).toContain('"number": 17');
      const audit = await readFile(host.policyAuditFilePath, "utf8");
      expect(audit).toContain('"kind":"policy-outcome"');
      expect(audit).not.toContain("SECRET");
    } finally {
      await host.stop();
    }
  });
  it("retains the applied policy and worker revision across host recreation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-mission-control-policy-restart-"),
    );
    temporaryDirectories.push(directory);
    const nextPolicy = {
      ...workerConfiguration,
      repositories: {
        "acme/app": {
          authorized: false,
          baseBranch: "main",
          profileId: "node",
        },
      },
      profiles: {
        node: {
          setupCommands: [],
          verificationCommands: ["npm test"],
        },
      },
    };
    const makeHost = () =>
      createMissionControlHost({
        configuration: createConfiguration(directory),
        boundaries: {
          source: {
            discover: vi.fn(async () => []),
            read: vi.fn(async () => undefined),
          },
          repositoryManager: { prepare: vi.fn() },
          execution: { execute: vi.fn() },
          publisher: { publish: vi.fn() },
        },
      });
    const first = makeHost();
    try {
      const preview = await first.policy.preview(nextPolicy);
      const outcome = await first.policy.apply({
        previewId: preview.previewId,
        commandId: "policy-restart-1",
        expectedWorkerRevision: 0,
        reason: "retain policy across a controlled restart",
        configuration: nextPolicy,
      });
      expect(outcome).toMatchObject({ code: "accepted", revision: 1 });
      await first.stop();

      const second = makeHost();
      try {
        expect(await second.policy.inspect()).toMatchObject({
          workerRevision: 1,
          policy: {
            repositories: [
              expect.objectContaining({
                repository: "acme/app",
                authorized: false,
              }),
            ],
          },
        });
        await expect(
          second.policy.apply({
            previewId: preview.previewId,
            commandId: "policy-restart-1",
            expectedWorkerRevision: 999,
            reason: "retry retained policy command",
            configuration: nextPolicy,
          }),
        ).resolves.toEqual(outcome);
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  });
});
