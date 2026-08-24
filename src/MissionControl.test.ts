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
