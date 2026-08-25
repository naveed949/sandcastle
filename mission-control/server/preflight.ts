import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const pExecFile = promisify(execFile);

export interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

async function tryExec(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await pExecFile(cmd, args, { timeout: 15_000 });
    return { ok: true, output: stdout.trim().split("\n")[0] };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      ok: false,
      output: (e.stderr ?? e.message ?? "failed").trim().split("\n")[0],
    };
  }
}

export async function runPreflight(opts: {
  sandcastleTemplateDir: string;
}): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const git = await tryExec("git", ["--version"]);
  checks.push({ name: "git", ok: git.ok, required: true, detail: git.output });

  const ghVersion = await tryExec("gh", ["--version"]);
  checks.push({
    name: "gh cli",
    ok: ghVersion.ok,
    required: true,
    detail: ghVersion.output,
  });

  if (ghVersion.ok) {
    const ghAuth = await tryExec("gh", ["auth", "status"]);
    checks.push({
      name: "gh auth",
      ok: ghAuth.ok,
      required: true,
      detail: ghAuth.ok ? "authenticated" : ghAuth.output,
    });
  }

  const dockerInfo = await tryExec("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  checks.push({
    name: "docker daemon",
    ok: dockerInfo.ok,
    required: true,
    detail: dockerInfo.ok ? `server ${dockerInfo.output}` : dockerInfo.output,
  });

  if (dockerInfo.ok) {
    // The template's run.ts uses docker()'s default image naming:
    // sandcastle:<clone-dir-name> — our clones are named "repo".
    const images = await tryExec("docker", [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "sandcastle",
    ]);
    const names = images.ok
      ? images.output.split("\n").filter((l) => l.startsWith("sandcastle:"))
      : [];
    checks.push({
      name: "sandcastle images",
      ok: names.length > 0,
      required: false,
      detail:
        names.length > 0
          ? `found ${names.join(", ")}`
          : "no sandcastle:* images found — build one with `npx @ai-hero/sandcastle docker build-image` inside a target repo clone",
    });
  }

  const tsx = await tryExec("npx", ["tsx", "--version"]);
  checks.push({
    name: "tsx (npx)",
    ok: tsx.ok,
    required: true,
    detail: tsx.output,
  });

  const envPath = path.join(opts.sandcastleTemplateDir, ".env");
  if (!fs.existsSync(envPath)) {
    checks.push({
      name: "template .env",
      ok: false,
      required: false,
      detail: `${envPath} missing — agents will fail without API keys`,
    });
  } else {
    const contents = fs.readFileSync(envPath, "utf8");
    const hasKey =
      /ANTHROPIC_API_KEY=(?!\s*$).+/.test(contents) &&
      !contents.includes("<your");
    checks.push({
      name: "template .env",
      ok: hasKey,
      required: false,
      detail: hasKey
        ? "API key present"
        : "ANTHROPIC_API_KEY looks empty or placeholder",
    });
  }

  return checks;
}

export function formatPreflight(checks: CheckResult[]): string {
  return checks
    .map(
      (c) =>
        `${c.ok ? "✓" : c.required ? "✗" : "!"} ${c.name}: ${c.detail}${!c.ok && !c.required ? " (warning)" : ""}`,
    )
    .join("\n");
}
