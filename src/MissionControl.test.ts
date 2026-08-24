import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerDryRun, type NormalizedTask } from "./WorkerCoordinator.js";
import {
  createMissionControlHost,
  type MissionControlConfiguration,
} from "./MissionControl.js";
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
});
