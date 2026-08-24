import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepositoryWorkflowSupervisor } from "./RepositoryWorkflowSupervisor.js";
import { acquireWorkerServiceLock } from "./WorkerService.js";

describe("createRepositoryWorkflowSupervisor", () => {
  it("monitors every active authorized repository and skips paused repositories", async () => {
    const runNow = vi.fn(async () => ({ status: "completed" }));
    const control = {
      list: vi.fn(async () => [
        { repository: "acme/one", mode: "active" as const },
        { repository: "acme/two", mode: "paused" as const },
      ]),
      runNow,
    };
    const supervisor = createRepositoryWorkflowSupervisor({ control });

    await supervisor.runCycle();

    expect(runNow).toHaveBeenCalledOnce();
    expect(runNow).toHaveBeenCalledWith("acme/one");
  });

  it("does not dispatch while the production service lock is held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repository-supervisor-"));
    const lockPath = join(directory, "service.lock");
    const release = await acquireWorkerServiceLock(lockPath);
    const runNow = vi.fn(async () => ({ status: "completed" }));
    const onError = vi.fn();
    const supervisor = createRepositoryWorkflowSupervisor({
      lockFilePath: lockPath,
      control: {
        list: vi.fn(async () => [
          { repository: "acme/one", mode: "active" as const },
        ]),
        runNow,
      },
      onError,
    });

    supervisor.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    supervisor.stop();
    expect(runNow).not.toHaveBeenCalled();

    await release();
    await rm(directory, { recursive: true, force: true });
  });
});
