import { describe, expect, it } from "vitest";
import {
  createGitHubTaskSource,
  runGitHubWorkerDryRun,
  type GitHubFetch,
} from "./GitHubTaskSource.js";
import type { WorkerConfiguration } from "./WorkerCoordinator.js";

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
      baseBranch: "main",
      profileId: "node",
    },
    "thirdparty/lib": {
      authorized: false,
      baseBranch: "main",
      profileId: "node",
    },
  },
  profiles: {
    node: {
      setupCommands: ["npm ci"],
      verificationCommands: ["npm test"],
    },
  },
  authorizedTasks: [{ repository: "thirdparty/lib", kind: "issue", number: 9 }],
  promptVersion: "worker-v1",
};

const issue = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Fix the widget",
  body: "The widget is broken.",
  state: "open",
  labels: [{ name: "ready-for-agent" }],
  repository_url: "https://api.github.com/repos/acme/app",
  updated_at: "2026-08-23T12:00:00Z",
  node_id: "I_kwDOacme7",
  parent_issue_url: "https://api.github.com/repos/acme/app/issues/1",
  user: { login: "naveed949" },
  ...overrides,
});

const repository = (name: string, defaultBranch = "main") => ({
  full_name: name,
  default_branch: defaultBranch,
});

const commit = (sha: string) => ({ sha });

const responseKey = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const fakeGitHub = (responses: Readonly<Record<string, unknown>>) => {
  const calls: string[] = [];
  const fetch: GitHubFetch = async (url, init) => {
    expect(init.method).toBe("GET");
    calls.push(`${init.method} ${responseKey(url)}`);
    const key = responseKey(url);
    if (!Object.hasOwn(responses, key)) {
      throw new Error(`Unexpected GitHub request: ${key}`);
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => responses[key],
    };
  };
  return { calls, fetch };
};

const responses = (): Record<string, unknown> => ({
  "/repos/acme/app": repository("acme/app"),
  "/repos/acme/app/commits/main": commit("acme-base"),
  "/repos/acme/app/issues?state=all&per_page=100&page=1": [issue()],
  "/repos/acme/app/issues/7": issue(),
  "/repos/acme/app/issues/7/dependencies/blocked_by": [
    {
      number: 2,
      repository_url: "https://api.github.com/repos/acme/app",
    },
  ],
  "/repos/acme/app/issues/7/sub_issues": [
    {
      number: 8,
      repository_url: "https://api.github.com/repos/acme/app",
    },
  ],
  "/repos/acme/app/issues/12": issue({
    number: 12,
    title: "Blocked work",
    labels: [{ name: "blocked" }],
    parent_issue_url: null,
    updated_at: "2026-08-23T12:04:00Z",
    node_id: "I_kwDOacme12",
  }),
  "/repos/acme/app/issues/12/dependencies/blocked_by": [],
  "/repos/acme/app/issues/12/sub_issues": [],
  "/repos/acme/app/issues/13": issue({
    number: 13,
    title: "PRD: Plan the next release",
    labels: [],
    parent_issue_url: null,
    updated_at: "2026-08-23T12:05:00Z",
    node_id: "I_kwDOacme13",
  }),
  "/repos/acme/app/issues/13/dependencies/blocked_by": [],
  "/repos/acme/app/issues/13/sub_issues": [],
  "/repos/thirdparty/lib": repository("thirdparty/lib"),
  "/repos/thirdparty/lib/commits/main": commit("thirdparty-base"),
  "/repos/thirdparty/lib/issues/9": issue({
    number: 9,
    title: "Fix the library",
    body: "The library is broken.",
    repository_url: "https://api.github.com/repos/thirdparty/lib",
    parent_issue_url: null,
    updated_at: "2026-08-23T12:01:00Z",
    node_id: "I_kwDOthirdparty9",
  }),
  "/repos/thirdparty/lib/issues/9/dependencies/blocked_by": [],
  "/repos/thirdparty/lib/issues/9/sub_issues": [],
  "/repos/thirdparty/lib/issues/11": issue({
    number: 11,
    title: "Sibling work",
    body: "A sibling task.",
    repository_url: "https://api.github.com/repos/thirdparty/lib",
    parent_issue_url: null,
    updated_at: "2026-08-23T12:02:00Z",
    node_id: "I_kwDOthirdparty11",
  }),
  "/repos/thirdparty/lib/issues/11/dependencies/blocked_by": [],
  "/repos/thirdparty/lib/issues/11/sub_issues": [],
  "/repos/other/project": repository("other/project"),
  "/repos/other/project/commits/main": commit("other-base"),
  "/repos/other/project/issues/10": issue({
    number: 10,
    title: "Other project work",
    body: "Work in another repository.",
    repository_url: "https://api.github.com/repos/other/project",
    parent_issue_url: null,
    updated_at: "2026-08-23T12:03:00Z",
    node_id: "I_kwDOother10",
  }),
  "/repos/other/project/issues/10/dependencies/blocked_by": [],
  "/repos/other/project/issues/10/sub_issues": [],
  "/search/issues?q=author%3Anaveed949+is%3Aissue&per_page=100&page=1": {
    items: [
      issue(),
      issue({
        number: 9,
        repository_url: "https://api.github.com/repos/thirdparty/lib",
      }),
      issue({
        number: 11,
        repository_url: "https://api.github.com/repos/thirdparty/lib",
      }),
      issue({
        number: 10,
        repository_url: "https://api.github.com/repos/other/project",
      }),
    ],
  },
});

describe("GitHubTaskSource", () => {
  it("normalizes configured, exact, and account-wide discovery through one model", async () => {
    const fake = fakeGitHub(responses());
    const source = createGitHubTaskSource({
      account: "naveed949",
      fetch: fake.fetch,
      prdReferences: [{ repository: "acme/app", kind: "prd", number: 1 }],
    });

    const tasks = await source.discover({ configuration });
    const byId = new Map(
      tasks.map((task) => [
        `${task.repository}:${task.kind}:${task.number}`,
        task,
      ]),
    );

    expect(
      tasks.map((task) => `${task.repository}:${task.kind}:${task.number}`),
    ).toEqual([
      "acme/app:issue:7",
      "other/project:issue:10",
      "thirdparty/lib:issue:11",
      "thirdparty/lib:issue:9",
    ]);
    expect(byId.get("acme/app:issue:7")).toMatchObject({
      labels: ["ready-for-agent"],
      sourceRevision: "2026-08-23T12:00:00Z",
      baseBranch: "main",
      baseCommit: "acme-base",
      dependencies: [{ repository: "acme/app", kind: "issue", number: 2 }],
      children: [{ repository: "acme/app", kind: "issue", number: 8 }],
      parentPrd: { repository: "acme/app", kind: "prd", number: 1 },
    });
    expect(fake.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(fake.calls).toContain(
      "GET /search/issues?q=author%3Anaveed949+is%3Aissue&per_page=100&page=1",
    );
  });

  it("keeps account-wide discoveries unauthorized and exact authorization narrow", async () => {
    const fake = fakeGitHub(responses());
    const source = createGitHubTaskSource({
      account: "naveed949",
      fetch: fake.fetch,
    });

    const result = await runGitHubWorkerDryRun({ source, configuration });
    const reasons = new Map(
      result.decisions.map((decision) => [
        decision.taskId,
        decision.reasonCode,
      ]),
    );

    expect(reasons.get("thirdparty/lib:issue:9")).toBe("eligible");
    expect(reasons.get("thirdparty/lib:issue:11")).toBe(
      "unauthorized_repository",
    );
    expect(reasons.get("other/project:issue:10")).toBe(
      "unauthorized_repository",
    );
    expect(result.machineReadable.readOnly).toBe(true);
    expect(result.machineReadable.mutations).toEqual([]);
  });

  it("produces equivalent normalized snapshots for repeated read-only discovery", async () => {
    const firstFake = fakeGitHub(responses());
    const secondFake = fakeGitHub(responses());
    const firstSource = createGitHubTaskSource({
      account: "naveed949",
      fetch: firstFake.fetch,
    });
    const secondSource = createGitHubTaskSource({
      account: "naveed949",
      fetch: secondFake.fetch,
    });

    const first = await firstSource.discover({ configuration });
    const second = await secondSource.discover({ configuration });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("maps deterministic blocked and PRD states before dry-run eligibility", async () => {
    const fake = fakeGitHub(responses());
    const source = createGitHubTaskSource({ fetch: fake.fetch });
    const result = await runGitHubWorkerDryRun({
      source,
      configuration,
      exactTasks: [
        { repository: "acme/app", kind: "issue", number: 12 },
        { repository: "acme/app", kind: "issue", number: 13 },
      ],
      includeConfiguredRepositories: false,
      includeAccountWide: false,
    });

    expect(result.decisions).toEqual([
      expect.objectContaining({
        taskId: "acme/app:issue:12",
        reasonCode: "blocked",
      }),
      expect.objectContaining({
        taskId: "acme/app:prd:13",
        reasonCode: "prd",
      }),
    ]);
  });
});
