import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryWorkflowCoordinator,
  type RepositoryWorkflowCoordinator,
} from "./RepositoryWorkflowCoordinator.js";
import type { RepositoryWorkflowControl } from "./RepositoryWorkflowControl.js";

const controlFor = (overrides: Partial<RepositoryWorkflowControl> = {}) =>
  ({
    authorize: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      {
        repository: "acme/one",
        featureBranch: "feat/one",
        workflowId: "workflow-v1",
        mode: "active" as const,
        nextCycle: 1,
      },
      {
        repository: "acme/two",
        featureBranch: "feat/two",
        workflowId: "workflow-v1",
        mode: "active" as const,
        nextCycle: 1,
      },
    ]),
    inspect: vi.fn(async () => undefined),
    runNow: vi.fn(async () => ({
      id: "run-1",
      repository: "acme/one",
      workflowId: "workflow-v1",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:00:01.000Z",
      status: "completed" as const,
      cycles: [],
    })),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    ...overrides,
  }) satisfies RepositoryWorkflowControl;

const startAndWaitForDispatch = async (
  coordinator: RepositoryWorkflowCoordinator,
  runNow: ReturnType<typeof vi.fn>,
): Promise<void> => {
  await coordinator.start();
  await vi.waitFor(() => expect(runNow).toHaveBeenCalled());
};

describe("createRepositoryWorkflowCoordinator", () => {
  it("reconciles durable claims before dispatch and applies bounded failure backoff", async () => {
    const recover = vi.fn(async () => []);
    const runNow = vi.fn(async () => {
      throw new Error("temporary discovery failure");
    });
    const raw = controlFor({ recover, runNow });
    const coordinator = createRepositoryWorkflowCoordinator({
      control: raw,
      pollIntervalMs: 10,
      failureBackoffBaseMs: 25,
      failureBackoffMaxMs: 100,
      now: () => "2026-08-24T00:00:00.000Z",
    });

    await coordinator.start();
    await vi.waitFor(() => expect(runNow).toHaveBeenCalled());
    await coordinator.stop();
    expect(recover).toHaveBeenCalledOnce();
    const status = coordinator.status();
    expect(status.lastFailureReason).toBe("dispatch_failed");
    expect(Date.parse(status.nextPollAt!)).toBeGreaterThanOrEqual(
      Date.parse("2026-08-24T00:00:00.025Z"),
    );
    expect(Date.parse(status.nextPollAt!)).toBeLessThanOrEqual(
      Date.parse("2026-08-24T00:00:00.100Z"),
    );
  });

  it("gates dispatch on lifecycle authority and serializes one repository globally", async () => {
    let finish!: () => void;
    let rejectOnAbort!: (error: unknown) => void;
    const activeRun = new Promise<void>((resolve, reject) => {
      finish = resolve;
      rejectOnAbort = reject;
    });
    const runNow = vi.fn(async (_repository: string, signal?: AbortSignal) => {
      signal?.addEventListener(
        "abort",
        () => rejectOnAbort(signal.reason ?? new Error("cancelled")),
        { once: true },
      );
      await activeRun;
      return {
        id: "run-1",
        repository: "acme/one",
        workflowId: "workflow-v1",
        startedAt: "2026-08-24T00:00:00.000Z",
        completedAt: "2026-08-24T00:00:01.000Z",
        status: "completed" as const,
        cycles: [],
      };
    });
    const raw = controlFor({ runNow });
    const coordinator = createRepositoryWorkflowCoordinator({
      control: raw,
      pollIntervalMs: 60_000,
      shutdownTimeoutMs: 100,
    });

    await expect(coordinator.control.runNow("acme/one")).rejects.toThrow(
      "unavailable",
    );
    await startAndWaitForDispatch(coordinator, runNow);
    expect(runNow).toHaveBeenCalledWith("acme/one", expect.any(AbortSignal));
    expect(runNow).toHaveBeenCalledOnce();
    expect(coordinator.status()).toMatchObject({
      mode: "running",
      activeRepository: "acme/one",
    });

    await coordinator.stop();
    expect(coordinator.status().mode).toBe("stopped");
    expect(runNow.mock.calls[0]?.[1]?.aborted).toBe(true);
    finish();
  });

  it("forwards a host shutdown signal and retains a stopped state after cleanup", async () => {
    const runNow = vi.fn(async () => ({
      id: "run-1",
      repository: "acme/one",
      workflowId: "workflow-v1",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:00:01.000Z",
      status: "completed" as const,
      cycles: [],
    }));
    const coordinator = createRepositoryWorkflowCoordinator({
      control: controlFor({ runNow }),
      pollIntervalMs: 60_000,
    });

    await coordinator.start();
    await vi.waitFor(() => expect(runNow).toHaveBeenCalledOnce());
    await coordinator.stop();

    expect(coordinator.status()).toMatchObject({ mode: "stopped" });
  });
});
