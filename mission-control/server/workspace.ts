import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const pExecFile = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pExecFile("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function workspaceRoot(baseDir: string): string {
  return path.join(baseDir, "workspaces");
}

export function projectWorkspace(baseDir: string, projectId: number): string {
  return path.join(workspaceRoot(baseDir), String(projectId), "repo");
}

export function normalizeRepoUrl(repoUrl: string): string {
  // Accept GitHub "owner/repo" shorthand and bare host paths.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoUrl)) {
    return `https://github.com/${repoUrl}.git`;
  }
  return repoUrl;
}

export async function cloneRepo(
  repoUrl: string,
  destDir: string,
  baseBranch: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  // gh repo clone accepts "owner/repo" shorthand and reuses gh's credentials —
  // no separate git credential setup needed for private repos.
  await pExecFile(
    "gh",
    [
      "repo",
      "clone",
      normalizeRepoUrl(repoUrl),
      destDir,
      "--",
      "--branch",
      baseBranch,
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
}

export async function ensureFeatureBranch(
  repoDir: string,
  branchName: string,
): Promise<void> {
  const exists = await git(repoDir, "rev-parse", "--verify", branchName).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await git(repoDir, "branch", branchName);
  }
  await git(repoDir, "checkout", branchName);
}

export async function copySandcastleDir(
  sourceDir: string,
  repoDir: string,
): Promise<void> {
  const dest = path.join(repoDir, ".sandcastle");
  fs.cpSync(sourceDir, dest, { recursive: true });
  const envExample = path.join(dest, ".env.example");
  const envFile = path.join(dest, ".env");
  if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
  }
}

export async function headSha(repoDir: string): Promise<string> {
  return git(repoDir, "rev-parse", "HEAD");
}

function detectPackageManager(repoDir: string): string {
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) return "yarn";
  if (
    fs.existsSync(path.join(repoDir, "bun.lockb")) ||
    fs.existsSync(path.join(repoDir, "bun.lock"))
  )
    return "bun";
  return "npm";
}

/**
 * Installs dependencies and builds the cloned repo so that
 * `.sandcastle/run.ts` can resolve host imports (e.g. a self-referencing
 * `@ai-hero/sandcastle` needs dist/ to exist). Skipped when there is no
 * package.json.
 */
export async function setupRepo(
  repoDir: string,
  onOutput?: (source: string, line: string) => void,
): Promise<void> {
  if (!fs.existsSync(path.join(repoDir, "package.json"))) return;
  const pm =
    process.env.MISSION_CONTROL_PACKAGE_MANAGER ??
    detectPackageManager(repoDir);
  await runStreamed(pm, ["install"], repoDir, onOutput);

  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoDir, "package.json"), "utf8"),
  );
  const buildScript =
    process.env.MISSION_CONTROL_BUILD_SCRIPT ?? pkg.scripts?.build;
  if (buildScript) {
    await runStreamed(pm, ["run", "build"], repoDir, onOutput);
  }
}

/**
 * Builds the sandbox image expected by sandcastle's default naming
 * (`sandcastle:<clone-dir-basename>`) when it doesn't exist yet.
 * Runs docker build directly (not via the sandcastle CLI) so build
 * progress streams through instead of being hidden behind a spinner.
 */
export async function ensureDockerImage(
  repoDir: string,
  onOutput?: (source: string, line: string) => void,
): Promise<void> {
  const dockerfile = path.join(repoDir, ".sandcastle", "Dockerfile");
  if (!fs.existsSync(dockerfile)) return;
  const imageName = `sandcastle:${path.basename(repoDir)}`;
  const exists = await new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["image", "inspect", imageName], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  if (exists) {
    onOutput?.(
      "meta",
      `Docker image ${imageName} already exists, skipping build.`,
    );
    return;
  }
  onOutput?.("meta", `Building Docker image ${imageName} (streamed)…`);
  await runStreamed(
    "docker",
    [
      "build",
      "-t",
      imageName,
      "--build-arg",
      `AGENT_UID=${process.getuid?.() ?? 1000}`,
      "--build-arg",
      `AGENT_GID=${process.getgid?.() ?? 1000}`,
      "-f",
      dockerfile,
      path.join(repoDir, ".sandcastle"),
    ],
    repoDir,
    onOutput,
    true, // raw lines: docker build progress is meaningful, don't collapse
  );
  onOutput?.("meta", `Built ${imageName}.`);
}

async function runStreamed(
  cmd: string,
  args: string[],
  cwd: string,
  onOutput?: (source: string, line: string) => void,
  raw = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const emit = raw
      ? (source: string, chunk: Buffer): void => {
          for (const line of chunk.toString().split("\n")) {
            if (line.trim()) onOutput?.(source, line);
          }
        }
      : makeSpinnerCollapsingEmitter(onOutput);
    child.stdout.on("data", (c: Buffer) => emit("stdout", c));
    child.stderr.on("data", (c: Buffer) => emit("stderr", c));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/**
 * Piped output turns animated CLI spinners (clack frames like ◐◓◑◒) into one
 * line per animation frame. Collapse consecutive frames of the same message
 * into a single line.
 */
export function makeSpinnerCollapsingEmitter(
  onOutput?: (source: string, line: string) => void,
): (source: string, chunk: Buffer) => void {
  let last = "";
  return (source, chunk) => {
    for (const rawLine of chunk.toString().split("\n")) {
      const line = rawLine.replace(/^[◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, "").trim();
      if (!line || line === last) continue;
      last = line;
      onOutput?.(source, line);
    }
  };
}

export async function cleanupWorkspace(
  baseDir: string,
  projectId: number,
): Promise<void> {
  const dir = path.dirname(projectWorkspace(baseDir, projectId));
  fs.rmSync(dir, { recursive: true, force: true });
}
