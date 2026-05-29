/**
 * Session JSONL transfer primitives.
 *
 * The transfer functions are pure: they take a JSONL string and the source/
 * target cwds, and return the rewritten JSONL string. Call sites do their own
 * file I/O (reading the source, writing the destination). Per ADR 0012, the
 * cwd rewrite is specific to each agent's JSONL format, so each agent owns
 * its own transfer function.
 */

import { access, readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// Host session lookup
// ---------------------------------------------------------------------------

/**
 * Result of locating a session on the host by its unique id, independent of any
 * cwd-derived path encoding.
 */
export interface HostSessionLookup {
  /** Absolute path to the located session file, or `undefined` when no session
   *  with this id exists anywhere under the searched root. */
  readonly path: string | undefined;
  /** The host directory that was scanned — surfaced in not-found errors so the
   *  user knows where Sandcastle looked. */
  readonly searchedRoot: string;
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Claude Code session paths and transfer
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into the Claude Code `~/.claude/projects/<encoded>/` layout.
 * Replaces path separators with hyphens, matching Claude Code's convention.
 */
export const encodeProjectPath = (cwd: string): string => {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
};

/** Absolute host path to a Claude session JSONL file. */
export const claudeHostSessionPath = (
  cwd: string,
  id: string,
  projectsDir?: string,
): string => {
  const base =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  return join(base, encodeProjectPath(cwd), `${id}.jsonl`);
};

/** Sandbox-side path to a Claude session JSONL file (always POSIX separators). */
export const claudeSandboxSessionPath = (
  cwd: string,
  id: string,
  projectsDir: string,
): string => posix.join(projectsDir, encodeProjectPath(cwd), `${id}.jsonl`);

/**
 * Locate a Claude Code session JSONL on the host by its unique id, scanning each
 * `~/.claude/projects/<encoded-cwd>/` directory rather than reconstructing the
 * cwd encoding. The session id is globally unique, so the first match wins.
 */
export const findClaudeSessionOnHost = async (
  id: string,
  projectsDir?: string,
): Promise<HostSessionLookup> => {
  const root =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { path: undefined, searchedRoot: root };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${id}.jsonl`);
    if (await pathExists(candidate)) {
      return { path: candidate, searchedRoot: root };
    }
  }
  return { path: undefined, searchedRoot: root };
};

const rewriteSessionCwd = (
  content: string,
  fromCwd: string,
  toCwd: string,
): string => {
  if (content === "") return "";
  return content
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.cwd === "string" && entry.cwd === fromCwd) {
        entry.cwd = toCwd;
      }
      if (
        entry.type === "session_meta" &&
        typeof entry.payload === "object" &&
        entry.payload !== null &&
        typeof (entry.payload as { cwd?: unknown }).cwd === "string" &&
        (entry.payload as { cwd: string }).cwd === fromCwd
      ) {
        (entry.payload as { cwd: string }).cwd = toCwd;
      }
      return JSON.stringify(entry);
    })
    .join("\n");
};

/**
 * Rewrite a Claude Code session JSONL string, replacing `cwd` fields that
 * match `fromCwd` with `toCwd`. Pure function — no file I/O.
 */
export const transferClaudeSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string => rewriteSessionCwd(jsonl, fromCwd, toCwd);

// ---------------------------------------------------------------------------
// Codex session paths and transfer
// ---------------------------------------------------------------------------

const isCodexSessionFilename = (filename: string, id: string): boolean =>
  filename.startsWith("rollout-") && filename.endsWith(`-${id}.jsonl`);

const findCodexSessionPath = async (
  rootDir: string,
  id: string,
): Promise<string | undefined> => {
  const visit = async (dir: string): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isFile() && isCodexSessionFilename(entry.name, id)) {
        return child;
      }
      if (entry.isDirectory()) {
        const found = await visit(child);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(rootDir);
};

/**
 * Locate a Codex session rollout file on the host by its id, reusing the
 * date-nested scan.
 */
export const findCodexSessionOnHost = async (
  id: string,
  sessionsDir?: string,
): Promise<HostSessionLookup> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path = await findCodexSessionPath(root, id);
  return { path, searchedRoot: root };
};

/** Codex host session lookup that also returns the relative date-nested path. */
export interface CodexSessionLocation {
  readonly path: string;
  readonly relativePath: string;
}

export const locateCodexHostSession = async (
  id: string,
  sessionsDir?: string,
): Promise<CodexSessionLocation> => {
  const root =
    sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const path = await findCodexSessionPath(root, id);
  if (!path) throw new Error(`session ${id} not found in ${root}`);
  return { path, relativePath: relative(root, path) };
};

export const locateCodexSandboxSession = async (
  id: string,
  handle: Pick<BindMountSandboxHandle, "exec">,
  sessionsDir: string,
): Promise<CodexSessionLocation> => {
  const result = await handle.exec(
    `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`rollout-*-${id}.jsonl`)} -print -quit`,
  );
  const path = result.stdout.trim().split("\n")[0];
  if (result.exitCode !== 0 || !path) {
    throw new Error(`session ${id} not found in ${sessionsDir}`);
  }
  return { path, relativePath: posix.relative(sessionsDir, path) };
};

/**
 * Rewrite a Codex session JSONL string, replacing `cwd` fields (both top-level
 * and `session_meta.payload.cwd`) that match `fromCwd` with `toCwd`. Pure
 * function — no file I/O.
 */
export const transferCodexSession = (
  jsonl: string,
  fromCwd: string,
  toCwd: string,
): string => rewriteSessionCwd(jsonl, fromCwd, toCwd);
