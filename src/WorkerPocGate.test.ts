import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  DryRunResult,
  ExecutionRequest,
  NormalizedTask,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  runWorkerDryRun,
  workerConfigurationDigest,
} from "./WorkerCoordinator.js";
import type {
  CrossRepositoryAcceptanceProof,
  DependencyChainAcceptanceProof,
} from "./WorkerAcceptanceProof.js";
import { workerBranchFor } from "./WorkerRepositoryManager.js";
import type { WorkerCycleResult } from "./WorkerService.js";
import type { ExecutionAttempt, WorkerState } from "./WorkerStateStore.js";
import {
  runWorkerPocGate,
  type RunWorkerPocGateInput,
  type WorkerPocBoundaryAudit,
  type WorkerRestartAcceptanceEvidence,
} from "./WorkerPocGate.js";
import { createWorkerPocBoundaryAuditRecorder } from "./WorkerPocGateAudit.js";
import { workerRestartEvidenceDigest } from "./WorkerRestartAcceptanceProof.js";

const boundaryAuditKey = "test-poc-gate-audit-integrity-key";

const configuration: WorkerConfiguration = {
  repositories: {
    "acme/app": { authorized: true, baseBranch: "main", profileId: "node" },
    "beta/service": {
      authorized: true,
      baseBranch: "main",
      profileId: "rust",
    },
    "outside/library": {
      authorized: false,
      baseBranch: "main",
      profileId: "node",
    },
  },
  authorizedTasks: [
    { repository: "outside/library", kind: "issue", number: 42 },
  ],
  taskDependencies: [
    {
      task: { repository: "acme/app", kind: "issue", number: 3 },
      blockedBy: [{ repository: "acme/app", kind: "issue", number: 2 }],
    },
    {
      task: { repository: "acme/app", kind: "issue", number: 4 },
      blockedBy: [{ repository: "acme/app", kind: "issue", number: 3 }],
    },
  ],
  dependencyCompletionStates: ["completed"],
  promptVersion: "worker-v1",
  promptTemplates: {
    "worker-v1": "Implement this immutable task:\n{{TASK_SNAPSHOT}}",
  },
  profiles: {
    node: { setupCommands: ["npm ci"], verificationCommands: ["npm test"] },
    rust: {
      setupCommands: ["cargo fetch"],
      verificationCommands: ["cargo test"],
    },
  },
};

const task = (
  repository: string,
  number: number,
  overrides: Partial<NormalizedTask> = {},
): NormalizedTask => ({
  repository,
  kind: "issue",
  number,
  author: "naveed949",
  title: `Implement ${repository}#${number}`,
  body: "Acceptance task.",
  labels: ["ready-for-agent"],
  sourceRevision: `${repository}-${number}-revision`,
  baseBranch: "main",
  baseCommit: repository === "beta/service" ? "b".repeat(40) : "a".repeat(40),
  state: "open",
  dependencies: [],
  children: [],
  ...overrides,
});

const approvedOne = task("acme/app", 8);
const approvedTwo = task("beta/service", 8);
const exactThirdParty = task("outside/library", 42);
const unauthorizedSibling = task("outside/library", 43);
const restartTask = task("acme/app", 9);
const discoveredTasks = [
  approvedOne,
  approvedTwo,
  exactThirdParty,
  unauthorizedSibling,
];

const requestFor = (selected: NormalizedTask): ExecutionRequest => {
  const result = runWorkerDryRun({ configuration, tasks: [selected] });
  const request = result.executionRequests[0];
  if (request === undefined) throw new Error("missing execution request");
  return request;
};

const attemptFor = (
  request: ExecutionRequest,
  status: ExecutionAttempt["status"],
): ExecutionAttempt => ({
  attemptId: `${request.executionIdentity}:attempt-1`,
  executionIdentity: request.executionIdentity,
  request,
  status,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:01:00.000Z",
  outcomes:
    status === "active"
      ? []
      : [
          {
            status,
            timestamp: "2026-08-24T00:01:00.000Z",
            evidence: ["records/result.json"],
          },
        ],
  claim: {
    taskId: request.taskId,
    sourceRevision: request.task.sourceRevision,
    owner: "dev-box-1",
    acquiredAt: "2026-08-24T00:00:00.000Z",
    leaseExpiresAt: "2026-08-24T00:05:00.000Z",
    refreshedSnapshots: [request.task],
    phase: "started",
  },
});

const stateWith = (attempt: ExecutionAttempt): WorkerState => ({
  version: 1,
  taskSnapshots: [
    {
      taskId: attempt.request.taskId,
      task: attempt.request.task,
      discoveredAt: "2026-08-24T00:00:00.000Z",
    },
  ],
  executionRequests: [
    {
      executionIdentity: attempt.executionIdentity,
      request: attempt.request,
      selectedAt: "2026-08-24T00:00:00.000Z",
    },
  ],
  attempts: [attempt],
});

const cycle = (
  events: WorkerCycleResult["events"],
  attempted = false,
): WorkerCycleResult => ({ events, attempted });

const restartEvidence = (): WorkerRestartAcceptanceEvidence => {
  const request = requestFor(restartTask);
  const active = attemptFor(request, "active");
  const verified = attemptFor(request, "verified");
  const publishedBase = attemptFor(request, "published");
  const branch = workerBranchFor(request);
  const pullRequest = {
    number: 81,
    url: "https://github.com/acme/app/pull/81",
    draft: true as const,
    head: branch,
    headSha: "8".repeat(40),
    base: "main",
  };
  const published: ExecutionAttempt = {
    ...publishedBase,
    outcomes: [
      ...verified.outcomes,
      {
        status: "published",
        timestamp: "2026-08-24T00:02:01.000Z",
        evidence: ["records/result.json", pullRequest.url],
      },
    ],
  };
  const unsigned = {
    runId: "poc-gate-run-1",
    interrupted: {
      beforeRestart: stateWith(active),
      afterRestart: stateWith(active),
      recoveryCycle: cycle([
        {
          timestamp: "2026-08-24T00:01:00.000Z",
          state: "blocked",
          taskId: request.taskId,
          attemptId: active.attemptId,
          executionIdentity: request.executionIdentity,
          reasonCode: "manual_intervention",
          message: "Side effects may exist.",
        },
      ]),
      observedBranches: [branch, branch],
      observedPullRequests: [],
      beforeObservedPullRequests: [],
      afterObservedPullRequests: [],
    },
    verifiedPublication: {
      beforeRestart: stateWith(verified),
      afterRestart: stateWith(published),
      recoveryCycle: cycle(
        [
          {
            timestamp: "2026-08-24T00:02:00.000Z",
            state: "verified",
            taskId: request.taskId,
            attemptId: verified.attemptId,
            executionIdentity: request.executionIdentity,
            reasonCode: "resume_publication",
            message: "Resuming publication.",
          },
          {
            timestamp: "2026-08-24T00:02:01.000Z",
            state: "published",
            taskId: request.taskId,
            attemptId: verified.attemptId,
            executionIdentity: request.executionIdentity,
            message: "Published draft.",
          },
        ],
        true,
      ),
      observedBranches: [branch, branch],
      observedPullRequests: [pullRequest, pullRequest],
      beforeObservedPullRequests: [],
      afterObservedPullRequests: [pullRequest],
    },
    publication: {
      taskId: request.taskId,
      snapshot: request.task,
      executionIdentity: request.executionIdentity,
      attemptId: verified.attemptId,
      configurationDigest: workerConfigurationDigest(configuration),
      profileId: request.profileId,
      profileDigest: request.profileDigest,
      promptVersion: request.promptVersion,
      promptTemplateDigest: request.promptTemplateDigest,
      commits: [{ sha: "8".repeat(40) }],
      verification: [{ command: "npm test", exitCode: 0 }],
      evidence: ["records/result.json", pullRequest.url],
      pullRequest,
      executionRecordPath: "records/result.json",
    },
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      digest: workerRestartEvidenceDigest(unsigned, boundaryAuditKey),
    },
  };
};

const retainedRun = (
  selected: NormalizedTask,
  index: number,
): CrossRepositoryAcceptanceProof["runs"][number] => {
  const request = requestFor(selected);
  const branch = workerBranchFor(request);
  const repository = selected.repository.toLowerCase();
  return {
    repository,
    taskId: request.taskId,
    snapshot: selected,
    executionIdentity: request.executionIdentity,
    attemptId: `${request.executionIdentity}:attempt-1`,
    configurationDigest: workerConfigurationDigest(configuration),
    profileId: request.profileId,
    profileDigest: request.profileDigest,
    promptVersion: request.promptVersion,
    promptTemplateDigest: request.promptTemplateDigest,
    paths: {
      stateFilePath: `/srv/worker/${repository}/state.json`,
      repositoryDir: `/srv/worker/${repository}`,
      worktreePath: `/srv/worker/${repository}/worktree`,
      runLogPath: `/srv/worker/${repository}/run.log`,
    },
    recordPath: `/srv/worker/records/${request.executionIdentity}.json`,
    branch,
    commits: [{ sha: String(index).repeat(40) }],
    verification: [
      { command: request.profile.verificationCommands[0]!, exitCode: 0 },
    ],
    evidence: [
      `/srv/worker/records/${request.executionIdentity}.json`,
      `https://github.com/${repository}/pull/${index}`,
    ],
    pullRequest: {
      number: index,
      url: `https://github.com/${repository}/pull/${index}`,
      draft: true,
      head: branch,
      headSha: String(index).repeat(40),
      base: selected.baseBranch,
    },
    isolationObservation: {
      observedCredentialNames: [],
      observedWorkerConfiguration: false,
      unexpectedArtifactPaths: [],
    },
  };
};

const crossRepositoryProof = (): CrossRepositoryAcceptanceProof => ({
  version: 1,
  kind: "cross-repository-authorization-and-isolation",
  createdAt: "2026-08-24T00:03:00.000Z",
  initialAuthorization: {
    task: exactThirdParty,
    taskId: "outside/library:issue:42",
    eligible: false,
    reasonCode: "unauthorized_repository",
    reason: "Not authorized.",
    authorization: "none",
  },
  authorizedDecision: {
    ...runWorkerDryRun({ configuration, tasks: [exactThirdParty] })
      .decisions[0]!,
  },
  siblingDecision: {
    task: unauthorizedSibling,
    taskId: "outside/library:issue:43",
    eligible: false,
    reasonCode: "unauthorized_repository",
    reason: "Not authorized.",
    authorization: "none",
  },
  runs: [
    retainedRun(approvedOne, 1),
    retainedRun(approvedTwo, 2),
    retainedRun(exactThirdParty, 3),
  ],
  isolation: {
    repositories: ["acme/app", "beta/service", "outside/library"],
    credentialsObserved: false,
    workerConfigurationObserved: false,
    unexpectedArtifactsObserved: false,
  },
});

const dependencyProof = (): DependencyChainAcceptanceProof => {
  const prd = task("acme/app", 1, {
    kind: "prd",
    title: "PRD: Ordered work",
    labels: ["prd"],
    children: [
      { repository: "acme/app", kind: "issue", number: 2 },
      { repository: "acme/app", kind: "issue", number: 3 },
      { repository: "acme/app", kind: "issue", number: 4 },
    ],
  });
  const leaves = ([2, 3, 4] as const).map((number, index) =>
    task("acme/app", number, {
      parentPrd: { repository: "acme/app", kind: "prd", number: 1 },
      dependencies:
        index === 0
          ? []
          : [{ repository: "acme/app", kind: "issue", number: number - 1 }],
    }),
  );
  const stages = leaves.map((_leaf, index) => {
    const observedLeaves = leaves.map((leaf, leafIndex) => {
      const state = leafIndex < index ? "completed" : "open";
      return {
        ...leaf,
        state,
        sourceRevision: `${leaf.sourceRevision}-${state}`,
      } satisfies NormalizedTask;
    });
    const observedSnapshots = [prd, ...observedLeaves];
    const evaluation = runWorkerDryRun({
      configuration,
      tasks: observedSnapshots,
    });
    const request = evaluation.executionRequests.find(
      (candidate) => candidate.task.number === index + 2,
    );
    if (request === undefined) throw new Error("missing dependency request");
    const leaf = request.task;
    const branch = workerBranchFor(request);
    const dependencySnapshots = leaf.dependencies.map((dependency) =>
      observedLeaves.find(
        (candidate) => candidate.number === dependency.number,
      ),
    );
    if (dependencySnapshots.some((snapshot) => snapshot === undefined)) {
      throw new Error("missing dependency snapshot");
    }
    return {
      taskId: request.taskId,
      snapshot: leaf,
      prdContext: prd,
      observedSnapshots,
      claimSnapshots: [prd, leaf, ...dependencySnapshots] as NormalizedTask[],
      blockedTaskIds: observedLeaves
        .slice(index + 1)
        .map((candidate) => `acme/app:issue:${candidate.number}`),
      executionIdentity: request.executionIdentity,
      attemptId: `${request.executionIdentity}:attempt-1`,
      configurationDigest: workerConfigurationDigest(configuration),
      profileId: request.profileId,
      profileDigest: request.profileDigest,
      promptVersion: request.promptVersion,
      promptTemplateDigest: request.promptTemplateDigest,
      executionRecordPath: `/srv/worker/records/${request.executionIdentity}.json`,
      evidence: [
        `/srv/worker/records/${request.executionIdentity}.json`,
        `https://github.com/acme/app/pull/${leaf.number}`,
      ],
      commits: [{ sha: String(leaf.number).repeat(40) }],
      verification: [{ command: "npm test", exitCode: 0 }],
      pullRequest: {
        number: leaf.number,
        url: `https://github.com/acme/app/pull/${leaf.number}`,
        draft: true as const,
        head: branch,
        headSha: String(leaf.number).repeat(40),
        base: "main",
      },
    };
  });
  return {
    version: 1,
    kind: "prd-dependency-chain",
    createdAt: "2026-08-24T00:04:00.000Z",
    prd,
    completionStates: ["completed"],
    stages: stages as unknown as DependencyChainAcceptanceProof["stages"],
  };
};

const createInput = async (): Promise<RunWorkerPocGateInput> => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-poc-gate-"));
  const retainedCrossRepositoryProof = crossRepositoryProof();
  const retainedDependencyChainProof = dependencyProof();
  const retainedRestartEvidence = restartEvidence();
  const publications = [
    ...retainedCrossRepositoryProof.runs.map((run) => ({
      taskId: run.taskId,
      executionIdentity: run.executionIdentity,
      recordPath: run.recordPath,
      pullRequestUrl: run.pullRequest.url,
    })),
    ...retainedDependencyChainProof.stages.map((stage) => ({
      taskId: stage.taskId,
      executionIdentity: stage.executionIdentity,
      recordPath: stage.executionRecordPath,
      pullRequestUrl: stage.pullRequest.url,
    })),
    {
      taskId: retainedRestartEvidence.publication.taskId,
      executionIdentity: retainedRestartEvidence.publication.executionIdentity,
      recordPath: retainedRestartEvidence.publication.executionRecordPath,
      pullRequestUrl: retainedRestartEvidence.publication.pullRequest.url,
    },
  ];
  const boundaryAuditPath = join(root, "boundary-audit.json");
  const boundaryAudit = createWorkerPocBoundaryAuditRecorder({
    path: boundaryAuditPath,
    runId: "poc-gate-run-1",
    startedAt: "2026-08-24T00:00:00.000Z",
    integrityKey: boundaryAuditKey,
  });
  for (const [index, publication] of publications.entries()) {
    await boundaryAudit.record({
      action: "claim",
      executionIdentity: publication.executionIdentity,
      evidence: [`claim:${publication.taskId}`],
      timestamp: `2026-08-24T00:0${index}:00.000Z`,
    });
    await boundaryAudit.record({
      action: "verification",
      executionIdentity: publication.executionIdentity,
      evidence: [publication.recordPath],
      timestamp: `2026-08-24T00:0${index}:01.000Z`,
    });
    await boundaryAudit.record({
      action: "publication",
      executionIdentity: publication.executionIdentity,
      evidence: [publication.pullRequestUrl],
      timestamp: `2026-08-24T00:0${index}:02.000Z`,
    });
  }
  return {
    proofPath: join(root, "proof.json"),
    reportPath: join(root, "report.md"),
    configuration,
    account: "naveed949",
    discover: vi.fn(async () => discoveredTasks),
    unauthorizedTask: {
      repository: "outside/library",
      kind: "issue",
      number: 43,
    },
    unauthorizedInboxState: {
      version: 1,
      taskSnapshots: [
        {
          taskId: "outside/library:issue:43",
          task: unauthorizedSibling,
          discoveredAt: "2026-08-24T00:00:00.000Z",
        },
      ],
      executionRequests: [],
      attempts: [],
    },
    crossRepositoryProof: retainedCrossRepositoryProof,
    dependencyChainProof: retainedDependencyChainProof,
    restartEvidence: retainedRestartEvidence,
    boundaryAuditPath,
    boundaryAuditKey,
    createdAt: "2026-08-24T00:05:00.000Z",
  };
};

describe("runWorkerPocGate", () => {
  it("retains one consolidated machine-readable proof and operator report", async () => {
    const input = await createInput();

    const proof = await runWorkerPocGate(input);

    expect(proof.status).toBe("passed");
    expect(proof.checks).toMatchObject({
      deterministicDiscovery: true,
      unauthorizedInboxIsolation: true,
      restartWithoutDuplicates: true,
      crossRepositoryIsolation: true,
      dependencyFrontierOrdering: true,
      publicationProvenance: true,
      guardedBoundaries: true,
    });
    expect(proof.publications).toHaveLength(7);
    expect(
      proof.publications.every(
        (publication) =>
          publication.draft &&
          publication.taskRevision.length > 0 &&
          publication.baseCommit.length === 40 &&
          publication.configurationDigest.length === 64 &&
          publication.promptVersion === "worker-v1" &&
          publication.commits.length > 0 &&
          publication.verification.every((result) => result.exitCode === 0),
      ),
    ).toBe(true);
    expect(proof.limitations.map((limitation) => limitation.id)).toEqual([
      "single-worker",
      "polling-only",
      "manual-recovery",
      "github-only",
      "human-review",
    ]);
    expect(proof.futureEvidence.map((item) => item.capability)).toEqual([
      "concurrency",
      "webhooks",
      "auto-remediation",
      "issue-tracker-support",
    ]);
    expect(JSON.parse(await readFile(input.proofPath, "utf8"))).toEqual(proof);
    const report = await readFile(input.reportPath, "utf8");
    expect(report).toContain("# Repo-agnostic worker POC gate: PASSED");
    expect(report).toContain("## POC limitations");
    expect(report).toContain("## Evidence required for expansion");
    expect(input.discover).toHaveBeenCalledTimes(2);
  });

  it("fails closed when restart evidence contains a duplicate attempt", async () => {
    const input = await createInput();
    const interrupted = input.restartEvidence.interrupted;
    const duplicate = {
      ...interrupted.afterRestart.attempts[0]!,
      attemptId: "duplicate-attempt",
    };
    const unsigned = {
      runId: input.restartEvidence.runId,
      interrupted: {
        ...interrupted,
        afterRestart: {
          ...interrupted.afterRestart,
          attempts: [...interrupted.afterRestart.attempts, duplicate],
        },
      },
      verifiedPublication: input.restartEvidence.verifiedPublication,
      publication: input.restartEvidence.publication,
    };

    await expect(
      runWorkerPocGate({
        ...input,
        restartEvidence: {
          ...unsigned,
          integrity: {
            algorithm: "hmac-sha256",
            digest: workerRestartEvidenceDigest(unsigned, boundaryAuditKey),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "restart_recovery" });
  });

  it("fails closed when a repeated discovery cycle changes a bound revision", async () => {
    const input = await createInput();
    const discover = vi
      .fn<RunWorkerPocGateInput["discover"]>()
      .mockResolvedValueOnce(discoveredTasks)
      .mockResolvedValueOnce([
        ...discoveredTasks.slice(0, 3),
        { ...unauthorizedSibling, sourceRevision: "changed-revision" },
      ]);

    await expect(
      runWorkerPocGate({ ...input, discover }),
    ).rejects.toMatchObject({ code: "discovery_determinism" });
  });

  it("fails closed when a publication lacks retained verification provenance", async () => {
    const input = await createInput();
    const firstRun = input.crossRepositoryProof.runs[0]!;

    await expect(
      runWorkerPocGate({
        ...input,
        crossRepositoryProof: {
          ...input.crossRepositoryProof,
          runs: [
            { ...firstRun, verification: [] },
            input.crossRepositoryProof.runs[1]!,
            input.crossRepositoryProof.runs[2]!,
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "evidence_mismatch" });
  });

  it("fails closed when the unauthorized inbox task is not account-authored", async () => {
    const input = await createInput();
    const foreignTask = { ...unauthorizedSibling, author: "someone-else" };

    await expect(
      runWorkerPocGate({
        ...input,
        discover: vi.fn(async () => [
          ...discoveredTasks.slice(0, 3),
          foreignTask,
        ]),
        unauthorizedInboxState: {
          ...input.unauthorizedInboxState,
          taskSnapshots: [
            {
              taskId: "outside/library:issue:43",
              task: foreignTask,
              discoveredAt: "2026-08-24T00:00:00.000Z",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "authorization_boundary" });
  });

  it("fails closed when blocker counts are present without the dependency edge", async () => {
    const input = await createInput();
    const secondStage = input.dependencyChainProof.stages[1];

    await expect(
      runWorkerPocGate({
        ...input,
        dependencyChainProof: {
          ...input.dependencyChainProof,
          stages: [
            input.dependencyChainProof.stages[0],
            {
              ...secondStage,
              snapshot: { ...secondStage.snapshot, dependencies: [] },
            },
            input.dependencyChainProof.stages[2],
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_order" });
  });

  it("fails closed when the audit observes an agent publication bypass", async () => {
    const input = await createInput();
    const audit = JSON.parse(
      await readFile(input.boundaryAuditPath, "utf8"),
    ) as WorkerPocBoundaryAudit;
    await writeFile(
      input.boundaryAuditPath,
      `${JSON.stringify({
        ...audit,
        events: [
          ...audit.events,
          {
            timestamp: "2026-08-24T00:05:30.000Z",
            actor: "agent",
            action: "publication",
            evidence: ["agent narration"],
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(runWorkerPocGate(input)).rejects.toMatchObject({
      code: "boundary_bypass",
    });
  });
});
