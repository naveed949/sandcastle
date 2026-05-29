import { describe, expect, it } from "vitest";
import {
  type SessionStore,
  encodeProjectPath,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  hostSessionStore,
  sandboxSessionStore,
  transferClaudeSession,
  codexHostSessionStore,
  transferCodexSession,
} from "./SessionStore.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory SessionStore for testing transferClaudeSession without filesystem. */
const createMemoryStore = (
  cwd: string,
  initial?: Record<string, string>,
): SessionStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    cwd,
    data,
    sessionFilePath: (id: string): string => `${cwd}/sessions/${id}.jsonl`,
    exists: async (id: string): Promise<boolean> => data.has(id),
    readSession: async (id: string): Promise<string> => {
      const content = data.get(id);
      if (content === undefined)
        throw new Error(`session ${id} not found in memory store`);
      return content;
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      data.set(id, content);
    },
  };
};

// ---------------------------------------------------------------------------
// encodeProjectPath
// ---------------------------------------------------------------------------

describe("encodeProjectPath", () => {
  it("encodes absolute path by replacing path separators with hyphens", () => {
    expect(encodeProjectPath("/home/user/repos/my-project")).toBe(
      "-home-user-repos-my-project",
    );
  });

  it("encodes root path", () => {
    expect(encodeProjectPath("/")).toBe("-");
  });

  it("encodes path without leading slash", () => {
    expect(encodeProjectPath("home/user")).toBe("home-user");
  });

  it("strips trailing slash before encoding", () => {
    expect(encodeProjectPath("/home/user/")).toBe("-home-user");
  });

  // Windows-style paths
  it("encodes Windows path with backslashes and drive letter", () => {
    expect(encodeProjectPath("D:\\projektit\\super-app")).toBe(
      "D-projektit-super-app",
    );
  });

  it("strips trailing backslash before encoding", () => {
    expect(encodeProjectPath("C:\\Users\\rootti\\repos\\foo\\")).toBe(
      "C-Users-rootti-repos-foo",
    );
  });

  it("encodes Windows drive root", () => {
    expect(encodeProjectPath("C:\\")).toBe("C-");
  });

  it("encodes drive letter without trailing separator", () => {
    expect(encodeProjectPath("C:")).toBe("C");
  });

  it("strips multiple trailing backslashes", () => {
    expect(encodeProjectPath("D:\\projekts\\app\\\\")).toBe("D-projekts-app");
  });
});

// ---------------------------------------------------------------------------
// transferClaudeSession — cwd rewriting
// ---------------------------------------------------------------------------

describe("transferClaudeSession", () => {
  it("rewrites cwd fields in JSONL entries from source cwd to target cwd", async () => {
    const jsonl = [
      JSON.stringify({ type: "system", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "message", content: "hello" }),
      JSON.stringify({
        type: "tool_call",
        cwd: "/sandbox/worktree",
        name: "Read",
      }),
    ].join("\n");

    const source = createMemoryStore("/sandbox/worktree", { sess123: jsonl });
    const target = createMemoryStore("/home/user/repos/project");

    await transferClaudeSession(source, target, "sess123");

    const written = target.data.get("sess123")!;
    const lines = written.split("\n");

    expect(JSON.parse(lines[0]!)).toEqual({
      type: "system",
      cwd: "/home/user/repos/project",
    });
    // Line without cwd should be unchanged
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "message",
      content: "hello",
    });
    expect(JSON.parse(lines[2]!)).toEqual({
      type: "tool_call",
      cwd: "/home/user/repos/project",
      name: "Read",
    });
  });

  it("preserves session ID key through transfer", async () => {
    const jsonl = JSON.stringify({ type: "init", cwd: "/a" });
    const source = createMemoryStore("/a", { "my-session-id": jsonl });
    const target = createMemoryStore("/b");

    await transferClaudeSession(source, target, "my-session-id");

    expect(target.data.has("my-session-id")).toBe(true);
    expect(target.data.has("sess123")).toBe(false);
  });

  it("round-trips bytes through transfer for entries without cwd", async () => {
    const jsonl = [
      JSON.stringify({ type: "message", content: "hello world" }),
      JSON.stringify({
        type: "tool_result",
        output: "result with special chars: \t\n",
      }),
    ].join("\n");

    const source = createMemoryStore("/src", { s1: jsonl });
    const target = createMemoryStore("/dst");

    await transferClaudeSession(source, target, "s1");

    expect(target.data.get("s1")).toBe(jsonl);
  });

  it("handles empty JSONL", async () => {
    const source = createMemoryStore("/a", { s1: "" });
    const target = createMemoryStore("/b");

    await transferClaudeSession(source, target, "s1");

    expect(target.data.get("s1")).toBe("");
  });

  it("only rewrites cwd fields that match source cwd exactly", async () => {
    const jsonl = [
      JSON.stringify({ type: "a", cwd: "/sandbox/worktree" }),
      JSON.stringify({ type: "b", cwd: "/other/path" }),
    ].join("\n");

    const source = createMemoryStore("/sandbox/worktree", { s1: jsonl });
    const target = createMemoryStore("/host/repo");

    await transferClaudeSession(source, target, "s1");

    const lines = target.data.get("s1")!.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe("/host/repo");
    // Non-matching cwd should remain unchanged
    expect(JSON.parse(lines[1]!).cwd).toBe("/other/path");
  });

  it("throws when session ID does not exist in source", async () => {
    const source = createMemoryStore("/a");
    const target = createMemoryStore("/b");

    await expect(
      transferClaudeSession(source, target, "missing"),
    ).rejects.toThrow("session missing not found");
  });
});

// ---------------------------------------------------------------------------
// hostSessionStore — path encoding and filesystem
// ---------------------------------------------------------------------------

describe("hostSessionStore", () => {
  let tempDir: string;

  const setup = async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sandcastle-session-test-"));
    return tempDir;
  };

  const teardown = async () => {
    await rm(tempDir, { recursive: true, force: true });
  };

  it("writes session to encoded project path", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/home/user/project", dir);
      await store.writeSession(
        "sess-1",
        JSON.stringify({ type: "init", cwd: "/home/user/project" }),
      );

      const encoded = encodeProjectPath("/home/user/project");
      const filePath = join(dir, encoded, "sess-1.jsonl");
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("init");
    } finally {
      await teardown();
    }
  });

  it("reads back a written session", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      const jsonl = JSON.stringify({ type: "system", cwd: "/my/repo" });

      await store.writeSession("s1", jsonl);
      const result = await store.readSession("s1");

      expect(result).toBe(jsonl);
    } finally {
      await teardown();
    }
  });

  it("throws on read of non-existent session", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      await expect(store.readSession("nope")).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  it("uses cwd as the store cwd", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      expect(store.cwd).toBe("/my/repo");
    } finally {
      await teardown();
    }
  });

  it("reports whether a session exists", async () => {
    const dir = await setup();
    try {
      const store = hostSessionStore("/my/repo", dir);
      expect(await store.exists("s1")).toBe(false);
      await store.writeSession("s1", "{}");
      expect(await store.exists("s1")).toBe(true);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// findClaudeSessionOnHost — locate by id across encoded project dirs
// ---------------------------------------------------------------------------

describe("findClaudeSessionOnHost", () => {
  it("finds a session by id regardless of which encoded project dir holds it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-claude-"));
    try {
      const id = "session-xyz";
      // A directory name that no host-repo-dir encoding would reconstruct
      // (mimics a realpath'd worktree path with `.`→`-` applied by the agent).
      const projectDir = join(
        dir,
        "-private-tmp-myrepo--sandcastle-worktrees-feature",
      );
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${id}.jsonl`), "{}");

      const result = await findClaudeSessionOnHost(id, dir);

      expect(result.path).toBe(join(projectDir, `${id}.jsonl`));
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-claude-"));
    try {
      const result = await findClaudeSessionOnHost("nope", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path when the projects dir does not exist", async () => {
    const result = await findClaudeSessionOnHost(
      "nope",
      join(tmpdir(), "sandcastle-does-not-exist-xyz"),
    );
    expect(result.path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCodexSessionOnHost — locate rollout file by id
// ---------------------------------------------------------------------------

describe("findCodexSessionOnHost", () => {
  it("finds a date-nested rollout file by id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-codex-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const sessionPath = join(
        dir,
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, "{}");

      const result = await findCodexSessionOnHost(id, dir);

      expect(result.path).toBe(sessionPath);
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined path and names the searched root when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-find-codex-"));
    try {
      const result = await findCodexSessionOnHost("missing", dir);
      expect(result.path).toBeUndefined();
      expect(result.searchedRoot).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// codexHostSessionStore — date-nested rollout files
// ---------------------------------------------------------------------------

describe("codexHostSessionStore", () => {
  it("locates sessions by rollout filename suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-codex-store-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const sessionPath = join(
        dir,
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      await mkdir(join(sessionPath, ".."), { recursive: true });
      await writeFile(sessionPath, JSON.stringify({ type: "session_meta" }));

      const store = codexHostSessionStore("/repo", dir);

      expect(await store.exists(id)).toBe(true);
      expect(await store.readSession(id)).toContain("session_meta");
      expect(store.sessionFilePath(id)).toBe(sessionPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("transfers sessions while preserving relative date path and rewriting session_meta cwd", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "sandcastle-codex-src-"));
    const targetDir = await mkdtemp(join(tmpdir(), "sandcastle-codex-dst-"));
    try {
      const id = "9ba1c695-2222-4444-8888-e7e847bf34dd";
      const relativePath = join(
        "2026",
        "05",
        "26",
        `rollout-2026-05-26T08-00-00-${id}.jsonl`,
      );
      const sourcePath = join(sourceDir, relativePath);
      await mkdir(join(sourcePath, ".."), { recursive: true });
      await writeFile(
        sourcePath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id, cwd: "/sandbox/repo" },
          }),
          JSON.stringify({ type: "turn_context", cwd: "/sandbox/repo" }),
        ].join("\n"),
      );

      const source = codexHostSessionStore("/sandbox/repo", sourceDir);
      const target = codexHostSessionStore("/host/repo", targetDir);

      await transferCodexSession(source, target, id);

      const targetPath = join(targetDir, relativePath);
      const lines = (await readFile(targetPath, "utf-8")).split("\n");
      expect(JSON.parse(lines[0]!).payload.cwd).toBe("/host/repo");
      expect(JSON.parse(lines[1]!).cwd).toBe("/host/repo");
      expect(target.sessionFilePath(id)).toBe(targetPath);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sandboxSessionStore — uses bind-mount handle
// ---------------------------------------------------------------------------

describe("sandboxSessionStore", () => {
  it("uses copyFileOut for readSession", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-sbx-store-"));
    try {
      const jsonl = JSON.stringify({ type: "init", cwd: "/workspace" });

      // Write a file to the "sandbox" location to simulate copyFileOut reading it
      const sandboxCwd = "/workspace";
      const encoded = encodeProjectPath(sandboxCwd);
      const sandboxProjectDir = join(tempDir, ".claude", "projects", encoded);
      await mkdir(sandboxProjectDir, { recursive: true });
      await writeFile(join(sandboxProjectDir, "s1.jsonl"), jsonl);

      const copyFileOutCalls: Array<{ from: string; to: string }> = [];

      const handle: Pick<
        BindMountSandboxHandle,
        "copyFileIn" | "copyFileOut" | "exec"
      > = {
        copyFileIn: async () => {},
        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          copyFileOutCalls.push({ from: sandboxPath, to: hostPath });
          // Simulate actual copy for the read to work
          const content = await readFile(sandboxPath, "utf-8");
          await mkdir(join(hostPath, ".."), { recursive: true });
          await writeFile(hostPath, content);
        },
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      };

      const store = sandboxSessionStore(
        sandboxCwd,
        handle as BindMountSandboxHandle,
        join(tempDir, ".claude", "projects"),
      );

      const result = await store.readSession("s1");

      expect(copyFileOutCalls.length).toBe(1);
      expect(copyFileOutCalls[0]!.from).toContain("s1.jsonl");
      expect(result).toBe(jsonl);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses copyFileIn for writeSession", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sandcastle-sbx-store-"));
    try {
      const jsonl = JSON.stringify({ type: "init" });

      const copyFileInCalls: Array<{ from: string; to: string }> = [];

      const handle: Pick<
        BindMountSandboxHandle,
        "copyFileIn" | "copyFileOut" | "exec"
      > = {
        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          copyFileInCalls.push({ from: hostPath, to: sandboxPath });
        },
        copyFileOut: async () => {},
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      };

      const sandboxCwd = "/workspace";
      const store = sandboxSessionStore(
        sandboxCwd,
        handle as BindMountSandboxHandle,
        join(tempDir, ".claude", "projects"),
      );

      await store.writeSession("s2", jsonl);

      expect(copyFileInCalls.length).toBe(1);
      expect(copyFileInCalls[0]!.to).toContain("s2.jsonl");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stages host-side temp files outside the sandbox projectsDir", async () => {
    // projectsDir is a sandbox-only path that does not exist on the host.
    // copyFileOut receives (sandboxPath, hostTmpPath); the hostTmpPath must be
    // writable on the host — i.e. not under the sandbox-only projectsDir.
    const sandboxOnlyProjectsDir = "/nonexistent-on-host/.claude/projects";
    const sessionContent = JSON.stringify({ type: "init" });

    const handle: Pick<
      BindMountSandboxHandle,
      "copyFileIn" | "copyFileOut" | "exec"
    > = {
      copyFileIn: async (hostPath: string) => {
        // Must be able to read from the host tmp path.
        await readFile(hostPath, "utf-8");
      },
      copyFileOut: async (_sandboxPath: string, hostPath: string) => {
        // Must be able to write to the host tmp path.
        await writeFile(hostPath, sessionContent);
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    const store = sandboxSessionStore(
      "/workspace",
      handle as BindMountSandboxHandle,
      sandboxOnlyProjectsDir,
    );

    await expect(store.readSession("s1")).resolves.toBe(sessionContent);
    await expect(store.writeSession("s2", "x")).resolves.toBeUndefined();
  });

  it("mkdirs the sandbox project directory before copyFileIn on writeSession", async () => {
    // Regression: docker/podman `cp` require the destination's parent directory
    // to exist. Fresh sandboxes don't have ~/.claude/projects/<encoded>/ yet,
    // so writeSession must create it before copying the file in.
    const calls: string[] = [];

    const handle: Pick<
      BindMountSandboxHandle,
      "copyFileIn" | "copyFileOut" | "exec"
    > = {
      copyFileIn: async () => {
        calls.push("copyFileIn");
      },
      copyFileOut: async () => {},
      exec: async (command: string) => {
        calls.push(`exec:${command}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const store = sandboxSessionStore(
      "/home/agent/workspace",
      handle as BindMountSandboxHandle,
      "/home/agent/.claude/projects",
    );

    await store.writeSession("s1", "{}");

    expect(calls.length).toBe(2);
    expect(calls[0]).toMatch(/^exec:mkdir -p /);
    expect(calls[0]).toContain(
      "/home/agent/.claude/projects/-home-agent-workspace",
    );
    expect(calls[1]).toBe("copyFileIn");
  });

  it("exposes cwd", () => {
    const handle = {
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as BindMountSandboxHandle;

    const store = sandboxSessionStore(
      "/sandbox/work",
      handle,
      "/tmp/.claude/projects",
    );
    expect(store.cwd).toBe("/sandbox/work");
  });
});
