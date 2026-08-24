import { access } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  codex,
  createMissionControlHost,
  createRepositoryWorkflowControl,
  createRepositoryWorkflowCoordinator,
  createRepositoryWorkflowRuntime,
  createRepositoryWorkflowStore,
  createSandbox,
  run,
} from "../src/index.js";
import { docker } from "../src/sandboxes/docker.js";
import { repositoryWorkflow } from "../.sandcastle/workflow.js";

const execFileAsync = promisify(execFile);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const repositories = required("SANDCASTLE_REPOSITORIES")
  .split(",")
  .map((repository) => repository.trim().toLowerCase())
  .filter(Boolean);

const repositoryPaths = JSON.parse(
  required("SANDCASTLE_REPOSITORY_PATHS"),
) as Record<string, string>;
for (const repository of repositories) {
  if (!repositoryPaths[repository])
    throw new Error(`SANDCASTLE_REPOSITORY_PATHS must contain ${repository}.`);
  repositoryPaths[repository] = resolve(repositoryPaths[repository]);
  await access(repositoryPaths[repository]);
}

if (new Set(repositories).size !== repositories.length) {
  throw new Error("SANDCASTLE_REPOSITORIES contains duplicates.");
}

const account = process.env.SANDCASTLE_GITHUB_ACCOUNT?.trim();
const githubToken = required("GITHUB_TOKEN");
const workspaceRoot = resolve(
  process.env.SANDCASTLE_MISSION_CONTROL_ROOT?.trim() ||
    ".sandcastle/mission-control",
);
const codexAuthPath = resolve(
  process.env.SANDCASTLE_CODEX_AUTH_PATH?.trim() ||
    `${homedir()}/.codex/auth.json`,
);

await access(codexAuthPath).catch(() => {
  throw new Error(
    `Codex authentication was not found at ${codexAuthPath}. Set SANDCASTLE_CODEX_AUTH_PATH to an existing auth.json file.`,
  );
});

const profileId = "agnostic-node";
const promptVersion = "agnostic-work-v1";
const shutdownTimeoutMs = positiveInteger(
  "SANDCASTLE_SHUTDOWN_TIMEOUT_MS",
  120_000,
);
const sandboxFor = (repository: string) =>
  docker({
    env: { GH_REPO: repository },
    mounts: [
      {
        hostPath: codexAuthPath,
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
    ],
  });

const runtime = createRepositoryWorkflowRuntime({
  planner: {
    async plan(input) {
      const result = await run({
        cwd: repositoryPaths[input.repository],
        sandbox: sandboxFor(input.repository),
        name: `Planner ${input.repository}`,
        agent: codex(input.workflow.planner.model, {
          effort: input.workflow.planner.effort,
        }),
        promptFile: resolve(
          repositoryPaths[input.repository]!,
          input.workflow.planner.prompt,
        ),
        signal: input.signal,
      });
      const match = result.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
      if (!match)
        throw new Error(
          `Planner for ${input.repository} did not produce a <plan> tag.`,
        );
      return {
        issues: (
          JSON.parse(match[1]!) as {
            issues: { number: number; title: string; branch: string }[];
          }
        ).issues,
        logReference: result.logFilePath,
        sessionId: result.iterations.at(-1)?.sessionId,
      };
    },
  },
  taskRunner: {
    async implement(input) {
      await using sandbox = await createSandbox({
        cwd: repositoryPaths[input.repository],
        sandbox: sandboxFor(input.repository),
        branch: input.issue.branch,
        baseBranch: input.featureBranch,
        copyToWorktree: ["node_modules"],
        hooks: {
          sandbox: {
            onSandboxReady: [{ command: "npm install && npm run build" }],
          },
        },
      });
      const implementation = await sandbox.run({
        name: `Implementer #${input.issue.number}`,
        agent: codex(input.workflow.implementer.model, {
          effort: input.workflow.implementer.effort,
        }),
        promptFile: resolve(
          repositoryPaths[input.repository]!,
          input.workflow.implementer.prompt,
        ),
        promptArgs: {
          ISSUE_NUMBER: String(input.issue.number),
          ISSUE_TITLE: input.issue.title,
          BRANCH: input.issue.branch,
        },
        signal: input.signal,
      });
      return {
        commits: implementation.commits.map(({ sha }) => sha),
        logReference: implementation.logFilePath,
        sessionId: implementation.iterations.at(-1)?.sessionId,
      };
    },
    async review(input) {
      await using sandbox = await createSandbox({
        cwd: repositoryPaths[input.repository],
        sandbox: sandboxFor(input.repository),
        branch: input.issue.branch,
      });
      const review = await sandbox.run({
        name: `Reviewer #${input.issue.number}`,
        agent: codex(input.workflow.reviewer.model, {
          effort: input.workflow.reviewer.effort,
        }),
        promptFile: resolve(
          repositoryPaths[input.repository]!,
          input.workflow.reviewer.prompt,
        ),
        promptArgs: {
          ISSUE_NUMBER: String(input.issue.number),
          ISSUE_TITLE: input.issue.title,
          BRANCH: input.issue.branch,
        },
        signal: input.signal,
      });
      return {
        commits: review.commits.map(({ sha }) => sha),
        logReference: review.logFilePath,
        sessionId: review.iterations.at(-1)?.sessionId,
      };
    },
  },
  integrator: {
    async integrate(input) {
      const result = await run({
        cwd: repositoryPaths[input.repository],
        sandbox: sandboxFor(input.repository),
        name: `Integrator ${input.repository}`,
        maxIterations: 10,
        agent: codex(input.workflow.integrator.model, {
          effort: input.workflow.integrator.effort,
        }),
        promptFile: resolve(
          repositoryPaths[input.repository]!,
          input.workflow.integrator.prompt,
        ),
        promptArgs: {
          BRANCHES: input.branches.map((branch) => `- ${branch}`).join("\n"),
          ISSUES: input.issues
            .map((issue) => `- #${issue.number}: ${issue.title}`)
            .join("\n"),
        },
        signal: input.signal,
      });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryPaths[input.repository],
      });
      return { commit: stdout.trim(), logReference: result.logFilePath };
    },
  },
  issueTracker: {
    async closeIssues({ repository, issueNumbers }) {
      for (const issue of issueNumbers) {
        const { stdout } = await execFileAsync(
          "gh",
          [
            "issue",
            "view",
            String(issue),
            "--repo",
            repository,
            "--json",
            "state",
            "--jq",
            ".state",
          ],
          { env: { ...process.env, GH_TOKEN: githubToken } },
        );
        if (stdout.trim().toUpperCase() === "OPEN") {
          await execFileAsync(
            "gh",
            [
              "issue",
              "close",
              String(issue),
              "--repo",
              repository,
              "--reason",
              "completed",
            ],
            { env: { ...process.env, GH_TOKEN: githubToken } },
          );
        }
      }
    },
  },
});
const repositoryWorkflowControl = createRepositoryWorkflowControl({
  store: createRepositoryWorkflowStore({
    filePath: resolve(workspaceRoot, "state", "repository-workflows.json"),
  }),
  runtime,
  workflows: { [repositoryWorkflow.id]: repositoryWorkflow },
});
const configuredRepositories = new Set(
  (await repositoryWorkflowControl.list()).map(({ repository }) => repository),
);
for (const repository of repositories) {
  if (!configuredRepositories.has(repository)) {
    await repositoryWorkflowControl.authorize({
      repository,
      featureBranch:
        process.env.SANDCASTLE_FEATURE_BRANCH?.trim() || "feat/repo-agnostic",
      workflowId: repositoryWorkflow.id,
    });
  }
}
const workflowCoordinator = createRepositoryWorkflowCoordinator({
  control: repositoryWorkflowControl,
  pollIntervalMs: positiveInteger("SANDCASTLE_POLL_INTERVAL_MS", 60_000),
  shutdownTimeoutMs,
  onError: (repository, error) => console.error(`[${repository}]`, error),
});

const host = createMissionControlHost({
  configuration: {
    worker: {
      repositories: Object.fromEntries(
        repositories.map((repository) => [
          repository,
          {
            authorized: true,
            baseBranch: process.env.SANDCASTLE_BASE_BRANCH?.trim() || "main",
            profileId,
          },
        ]),
      ),
      authorizedTasks: [],
      dependencyCompletionStates: ["closed", "completed"],
      promptVersion,
      promptTemplates: {
        [promptVersion]: [
          "Implement the following immutable GitHub task snapshot.",
          "Stay within the task scope, follow the repository instructions, add tests for changed behavior, and commit the verified result.",
          "{{TASK_SNAPSHOT}}",
        ].join("\n\n"),
      },
      profiles: {
        [profileId]: {
          setupCommands: ["npm ci"],
          verificationCommands: ["npm test", "npm run typecheck"],
        },
      },
    },
    workspaceRoot,
    owner:
      process.env.SANDCASTLE_WORKER_OWNER?.trim() ||
      `mission-control-${hostname()}`,
    pollIntervalMs: positiveInteger("SANDCASTLE_POLL_INTERVAL_MS", 60_000),
    leaseDurationMs: positiveInteger(
      "SANDCASTLE_LEASE_DURATION_MS",
      30 * 60_000,
    ),
    executionTimeoutMs: positiveInteger(
      "SANDCASTLE_EXECUTION_TIMEOUT_MS",
      2 * 60 * 60_000,
    ),
    shutdownTimeoutMs,
    github: { token: githubToken, account },
    agentRunOptions: {
      agent: codex(
        process.env.SANDCASTLE_CODEX_MODEL?.trim() || "gpt-5.6-terra",
      ),
      sandbox: docker({
        mounts: [
          {
            hostPath: codexAuthPath,
            sandboxPath: "/home/agent/.codex/auth.json",
            readonly: true,
          },
        ],
      }),
    },
    discovery: {
      includeConfiguredRepositories: true,
      includeAccountWide: account !== undefined && account.length > 0,
    },
    server: {
      bindAddress: process.env.SANDCASTLE_BIND_ADDRESS?.trim() || "127.0.0.1",
      port: positiveInteger("SANDCASTLE_PORT", 3000),
    },
  },
  boundaries: {
    repositoryWorkflows: workflowCoordinator.control,
    workflowCoordinator,
  },
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(
  `Starting the Mission Control orchestration authority for ${repositories.join(", ")} with durable state at ${workspaceRoot}`,
);
await host.start();
