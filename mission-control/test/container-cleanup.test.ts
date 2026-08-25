import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  removeProjectContainers,
  type ExecFile,
} from "../server/container-cleanup.js";

describe("removeProjectContainers", () => {
  it("force-removes only containers mounted from the selected project", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const dataDir = path.resolve("/tmp/mission-control-data");
    const projectWorkspace = path.join(dataDir, "workspaces", "7");
    const run: ExecFile = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "ps") {
        return { stdout: "sandcastle-target\nsandcastle-other\n" };
      }
      if (args[0] === "inspect" && args.at(-1) === "sandcastle-target") {
        return { stdout: `${projectWorkspace}/repo\n/var/run/docker.sock\n` };
      }
      if (args[0] === "inspect") {
        return {
          stdout: `${path.join(dataDir, "workspaces", "70", "repo")}\n`,
        };
      }
      return { stdout: "" };
    });

    await removeProjectContainers(dataDir, 7, run);

    expect(calls).toContainEqual({
      command: "docker",
      args: ["rm", "-f", "sandcastle-target"],
    });
    expect(calls).not.toContainEqual({
      command: "docker",
      args: ["rm", "-f", "sandcastle-other"],
    });
  });
});
