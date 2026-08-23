import { describe, expect, it } from "vitest";
import {
  runWorkerDryRun,
  WorkerConfigurationError,
  type NormalizedTask,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": {
      authorized: true,
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
  authorizedTasks: [],
  promptVersion: "worker-v1",
  promptTemplates: { "worker-v1": "Implement:\n{{TASK_SNAPSHOT}}" },
};

const task: NormalizedTask = {
  repository: "acme/app",
  kind: "issue",
  number: 7,
  title: "Fix the widget",
  body: "The widget is broken.",
  labels: [],
  sourceRevision: "issue-revision-1",
  baseBranch: "main",
  baseCommit: "base-commit-1",
  state: "open",
  dependencies: [],
  children: [],
};

describe("runWorkerDryRun", () => {
  it("returns an execution request for an authorized ready task", () => {
    const result = runWorkerDryRun({
      configuration,
      tasks: [task],
    });

    expect(result.decisions).toEqual([
      expect.objectContaining({
        taskId: "acme/app:issue:7",
        eligible: true,
        reasonCode: "eligible",
        authorization: "repository",
      }),
    ]);
    expect(result.executionRequests).toHaveLength(1);
    expect(result.executionRequests[0]).toMatchObject({
      taskId: "acme/app:issue:7",
      profileId: "node",
      promptVersion: "worker-v1",
    });
    expect(result.executionRequests[0]?.executionIdentity).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(result.machineReadable).toMatchObject({
      mode: "dry-run",
      readOnly: true,
      mutations: [],
    });
    expect(result.humanReadable).toContain("acme/app#7");
  });

  it("changes execution identity when any bound input changes", () => {
    const identityFor = (
      nextConfiguration: WorkerConfiguration = configuration,
      nextTask: NormalizedTask = task,
    ) =>
      runWorkerDryRun({
        configuration: nextConfiguration,
        tasks: [nextTask],
      }).executionRequests[0]?.executionIdentity;

    const baseline = identityFor();
    const changedTaskRevision = identityFor(configuration, {
      ...task,
      sourceRevision: "issue-revision-2",
    });
    const changedBaseCommit = identityFor(configuration, {
      ...task,
      baseCommit: "base-commit-2",
    });
    const changedProfile = identityFor({
      ...configuration,
      profiles: {
        node: {
          ...configuration.profiles.node!,
          verificationCommands: ["npm run verify"],
        },
      },
    });
    const changedPrompt = identityFor({
      ...configuration,
      promptVersion: "worker-v2",
      promptTemplates: { "worker-v2": "Implement v2:\n{{TASK_SNAPSHOT}}" },
    });
    const changedPromptArtifact = identityFor({
      ...configuration,
      promptTemplates: {
        "worker-v1": "Implement with stricter checks:\n{{TASK_SNAPSHOT}}",
      },
    });

    expect(baseline).toBeDefined();
    expect(
      new Set([
        changedTaskRevision,
        changedBaseCommit,
        changedProfile,
        changedPrompt,
        changedPromptArtifact,
      ]),
    ).toHaveProperty("size", 5);
    expect(changedTaskRevision).not.toBe(baseline);
    expect(changedBaseCommit).not.toBe(baseline);
    expect(changedProfile).not.toBe(baseline);
    expect(changedPrompt).not.toBe(baseline);
    expect(changedPromptArtifact).not.toBe(baseline);
  });

  it("returns stable authorization and eligibility reason codes", () => {
    const policy: WorkerConfiguration = {
      repositories: {
        "acme/app": {
          authorized: true,
          baseBranch: "main",
          profileId: "node",
        },
        "thirdparty/app": {
          authorized: false,
          baseBranch: "main",
          profileId: "node",
        },
        "a/app": {
          authorized: true,
          baseBranch: "main",
          profileId: "node",
        },
        "b/app": {
          authorized: true,
          baseBranch: "main",
          profileId: "node",
        },
      },
      profiles: configuration.profiles,
      authorizedTasks: [
        { repository: "thirdparty/app", kind: "issue", number: 7 },
        { repository: "unconfigured/app", kind: "issue", number: 18 },
      ],
      promptVersion: "worker-v1",
      promptTemplates: configuration.promptTemplates,
    };

    const tasks: NormalizedTask[] = [
      task,
      { ...task, state: "closed", number: 10 },
      { ...task, state: "blocked", number: 11 },
      { ...task, state: "stale", number: 12 },
      { ...task, state: "claimed", number: 13 },
      { ...task, state: "completed", number: 14 },
      { ...task, kind: "prd", number: 15 },
      {
        ...task,
        number: 16,
        children: [{ repository: "acme/app", kind: "issue", number: 17 }],
      },
      {
        ...task,
        number: 17,
        dependencies: [{ repository: "acme/app", kind: "issue", number: 999 }],
      },
      {
        ...task,
        repository: "unconfigured/app",
        number: 18,
      },
      { ...task, baseBranch: "develop", number: 19 },
      {
        ...task,
        repository: "thirdparty/app",
        number: 7,
      },
      {
        ...task,
        repository: "thirdparty/app",
        number: 8,
      },
      { ...task, repository: "b/app", number: 7 },
      { ...task, repository: "a/app", number: 7 },
    ];

    const result = runWorkerDryRun({ configuration: policy, tasks });
    const reasons = new Map(
      result.decisions.map((decision) => [
        decision.taskId,
        decision.reasonCode,
      ]),
    );

    expect(reasons.get("acme/app:issue:10")).toBe("closed");
    expect(reasons.get("acme/app:issue:11")).toBe("blocked");
    expect(reasons.get("acme/app:issue:12")).toBe("stale");
    expect(reasons.get("acme/app:issue:13")).toBe("claimed");
    expect(reasons.get("acme/app:issue:14")).toBe("completed");
    expect(reasons.get("acme/app:prd:15")).toBe("prd");
    expect(reasons.get("acme/app:issue:16")).toBe("non_leaf");
    expect(reasons.get("acme/app:issue:17")).toBe("unmet_dependency");
    expect(reasons.get("unconfigured/app:issue:18")).toBe("missing_profile");
    expect(reasons.get("acme/app:issue:19")).toBe("invalid_base");
    expect(reasons.get("thirdparty/app:issue:7")).toBe("eligible");
    expect(reasons.get("thirdparty/app:issue:8")).toBe(
      "unauthorized_repository",
    );
    expect(reasons.get("a/app:issue:7")).toBe("eligible");
    expect(reasons.get("b/app:issue:7")).toBe("eligible");
    expect(result.executionRequests.map((request) => request.taskId)).toEqual([
      "a/app:issue:7",
      "acme/app:issue:7",
      "b/app:issue:7",
      "thirdparty/app:issue:7",
    ]);
    const issueSevenIds = result.executionRequests
      .map((request) => request.taskId)
      .filter((taskId) => taskId.endsWith(":issue:7"));
    expect(new Set(issueSevenIds)).toHaveLength(4);
  });

  it("rejects invalid central configuration before evaluating tasks", () => {
    expect(() =>
      runWorkerDryRun({
        configuration: {
          ...configuration,
          promptVersion: " ",
        },
        tasks: [task],
      }),
    ).toThrowError(WorkerConfigurationError);
    expect(() =>
      runWorkerDryRun({
        configuration: {
          ...configuration,
          promptTemplates: { "worker-v1": "missing snapshot marker" },
        },
        tasks: [task],
      }),
    ).toThrowError(WorkerConfigurationError);
    expect(() =>
      runWorkerDryRun({
        configuration: {
          ...configuration,
          repositories: {
            "acme/app": {
              ...configuration.repositories["acme/app"]!,
              profileId: "missing",
            },
          },
        },
        tasks: [task],
      }),
    ).toThrowError(WorkerConfigurationError);
  });

  it("reports dry run as read-only with no runtime mutations", () => {
    const result = runWorkerDryRun({ configuration, tasks: [task] });

    expect(result.machineReadable.readOnly).toBe(true);
    expect(result.machineReadable.mutations).toEqual([]);
    expect(result.machineReadable.executionRequests).toEqual(
      result.executionRequests,
    );
    expect(result.machineReadable.mutations).not.toContain("checkout");
    expect(result.machineReadable.mutations).not.toContain("agent-invocation");
    expect(result.machineReadable.mutations).not.toContain("github-mutation");
    expect(result.machineReadable.mutations).not.toContain("push");
    expect(result.machineReadable.mutations).not.toContain("pull-request");
  });

  it("keeps ordering and serialized output equivalent across repeated runs", () => {
    const secondTask: NormalizedTask = {
      ...task,
      repository: "b/app",
    };
    const repeatedConfiguration: WorkerConfiguration = {
      ...configuration,
      repositories: {
        ...configuration.repositories,
        "b/app": {
          authorized: true,
          baseBranch: "main",
          profileId: "node",
        },
      },
    };

    const first = runWorkerDryRun({
      configuration: repeatedConfiguration,
      tasks: [secondTask, task],
    });
    const second = runWorkerDryRun({
      configuration: repeatedConfiguration,
      tasks: [task, secondTask],
    });

    expect(first.machineReadable).toEqual(second.machineReadable);
    expect(JSON.stringify(first.machineReadable)).toBe(
      JSON.stringify(second.machineReadable),
    );
  });

  it("does not freeze caller inputs while freezing emitted snapshots", () => {
    const setupCommands = ["npm ci"];
    const verificationCommands = ["npm test"];
    const mutableConfiguration: WorkerConfiguration = {
      ...configuration,
      profiles: {
        node: { setupCommands, verificationCommands },
      },
    };

    const result = runWorkerDryRun({
      configuration: mutableConfiguration,
      tasks: [task],
    });
    const request = result.executionRequests[0]!;

    setupCommands.push("npm run lint");
    expect(setupCommands).toEqual(["npm ci", "npm run lint"]);
    expect(request.profile.setupCommands).toEqual(["npm ci"]);
  });
});
