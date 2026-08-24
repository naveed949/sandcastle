import { spawnSync } from "node:child_process";

const requiredEnvironment = [
  "SANDCASTLE_CROSS_REPO_ACCEPTANCE_FIXTURE",
  "SANDCASTLE_DEPENDENCY_ACCEPTANCE_FIXTURE",
  "SANDCASTLE_RESTART_ACCEPTANCE_FIXTURE",
  "SANDCASTLE_POC_GATE_FIXTURE",
  "SANDCASTLE_POC_GATE_SCENARIO",
];

const missing = requiredEnvironment.filter(
  (name) => (process.env[name]?.trim() ?? "") === "",
);
if (missing.length > 0) {
  console.error(
    `Worker acceptance gate requires deployed fixtures; missing: ${missing.join(", ")}`,
  );
  process.exit(1);
}

for (const script of [
  "test:acceptance:cross-repository",
  "test:acceptance:dependency-chain",
  "test:acceptance:restart",
  "test:acceptance:poc-gate",
]) {
  const result = spawnSync("npm", ["run", script], {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
