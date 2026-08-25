import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../server/bus.js";
import type { Db, RunRow } from "../server/db.js";
import { ProcessRunner, resolveIssueRepository } from "../server/runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for process state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("ProcessRunner cancellation", () => {
  it("prefers an explicit ISSUE_REPOSITORY over the UI-derived fallback", () => {
    expect(
      resolveIssueRepository("ui/repository", {
        ISSUE_REPOSITORY: " env/repository ",
      }),
    ).toBe("env/repository");
    expect(resolveIssueRepository("ui/repository", {})).toBe("ui/repository");
  });

  it("kills the run.ts process group and records the run as cancelled", async () => {
    const repoDir = await mkdtemp(
      path.join(tmpdir(), "mission-control-runner-"),
    );
    tempDirs.push(repoDir);
    await symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(repoDir, "node_modules"),
    );
    await mkdir(path.join(repoDir, ".sandcastle"));
    await writeFile(
      path.join(repoDir, ".sandcastle", "run.ts"),
      [
        'import "@ai-hero/sandcastle";',
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "await Promise.resolve();",
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'writeFileSync("issue-repository.txt", process.env.ISSUE_REPOSITORY ?? "");',
        'writeFileSync("descendant.pid", String(child.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const statuses: RunRow["status"][] = [];
    const db = {
      createRun: () => ({ id: 41 }),
      addStreamEvent: () => undefined,
      listAgents: () => [],
      finishRun: (_id: number, status: RunRow["status"]) =>
        statuses.push(status),
    } as unknown as Db;
    const runner = new ProcessRunner(db, new EventBus());
    const resultPromise = runner.runProject({
      projectId: 7,
      repoDir,
      logDir: repoDir,
      issueRepository: "acme/repo",
    });

    let descendantPid = 0;
    await waitFor(async () => {
      try {
        descendantPid = Number(
          await readFile(path.join(repoDir, "descendant.pid"), "utf8"),
        );
        return descendantPid > 0;
      } catch {
        return false;
      }
    });

    expect(
      await readFile(path.join(repoDir, "issue-repository.txt"), "utf8"),
    ).toBe("acme/repo");

    expect(runner.cancel(41)).toBe(true);
    await expect(resultPromise).resolves.toEqual({ exitCode: null });
    await waitFor(() => {
      try {
        process.kill(descendantPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(statuses).toEqual(["cancelled"]);
    await expect(
      readFile(
        path.join(repoDir, ".sandcastle", ".mission-control-run-41.mts"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);
});
