import { describe, expect, it, vi } from "vitest";
import { createRepositoryWorkflowSupervisor } from "./RepositoryWorkflowSupervisor.js";

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
});
