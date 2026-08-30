import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  normalizeRepository,
  runWorkerDryRun,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";
import type { WorkerExecutionResult } from "./WorkerExecutionEngine.js";
import {
  workerBranchFor,
  workerRepositoryDirectory,
} from "./WorkerRepositoryManager.js";
import type { ExecutionAttempt, WorkerStateStore } from "./WorkerStateStore.js";
import type { WorkerGuardedActionRecorder } from "./WorkerGuardedActions.js";

const execFile = promisify(execFileCallback);

export interface PublicationDestination {
  readonly repository: string;
  readonly canonicalRemote: string;
}

export interface PublishedBranch {
  readonly branch: string;
  readonly sha: string;
}

export interface DraftPullRequest {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  readonly head: string;
  readonly headSha: string;
  readonly base: string;
}

export interface WorkerPublicationOperations {
  getCanonicalRemote(repositoryDir: string): Promise<string>;
  resolveLocalBranch(input: {
    readonly repositoryDir: string;
    readonly branch: string;
  }): Promise<string>;
  inspectDestination(repository: string): Promise<PublicationDestination>;
  findRemoteBranch(input: {
    readonly repository: string;
    readonly branch: string;
  }): Promise<PublishedBranch | undefined>;
  pushBranch(input: {
    readonly repositoryDir: string;
    readonly canonicalRemote: string;
    readonly branch: string;
    readonly sha: string;
  }): Promise<void>;
  findPullRequest(input: {
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
  }): Promise<DraftPullRequest | undefined>;
  createDraftPullRequest(input: {
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<DraftPullRequest>;
}

/** Read-capable publication adapter used by live duplicate-observation proofs. */
export interface WorkerPublicationInspectionOperations extends WorkerPublicationOperations {
  listPullRequests(input: {
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
  }): Promise<readonly DraftPullRequest[]>;
}

export interface WorkerPublicationResult {
  readonly attemptId: string;
  readonly executionIdentity: string;
  readonly repository: string;
  readonly branch: string;
  readonly branchSha: string;
  readonly pullRequest: DraftPullRequest;
  readonly reusedBranch: boolean;
  readonly reusedPullRequest: boolean;
}

export interface WorkerPublisher {
  /** Publish or recover one retained, verified attempt as a draft pull request. */
  publish(attemptId: string): Promise<WorkerPublicationResult>;
}

export interface WorkerPublisherOptions {
  readonly configuration: WorkerConfiguration;
  /** Return the active policy after a staged Mission Control apply. */
  readonly configurationProvider?: () => WorkerConfiguration;
  readonly workspaceRoot: string;
  readonly store: WorkerStateStore;
  readonly operations: WorkerPublicationOperations;
  readonly guardedActions?: WorkerGuardedActionRecorder;
  readonly loadExecutionResult?: (
    recordPath: string,
  ) => Promise<WorkerExecutionResult>;
}

export type WorkerPublicationFetch = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<globalThis.Response>;

export interface DefaultWorkerPublicationOperationsOptions {
  /** GitHub token held by the publisher process and never passed to the agent. */
  readonly token: string;
  /** Injectable HTTP boundary for deterministic tests. */
  readonly fetch?: WorkerPublicationFetch;
}

export type WorkerPublicationErrorCode =
  | "not_verified"
  | "missing_evidence"
  | "evidence_mismatch"
  | "unauthorized"
  | "remote_mismatch"
  | "branch_mismatch"
  | "pull_request_mismatch"
  | "publication_failed";

export class WorkerPublicationError extends Error {
  readonly code: WorkerPublicationErrorCode;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: WorkerPublicationErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WorkerPublicationError";
    this.code = code;
    this.cause = cause;
  }
}

const canonicalRemoteFor = (repository: string): string =>
  `https://github.com/${normalizeRepository(repository)}.git`;

const githubApiUrl = (repository: string, suffix = ""): string =>
  `https://api.github.com/repos/${normalizeRepository(repository)}${suffix}`;

const normalizeCanonicalRemote = (remote: string): string | undefined => {
  try {
    const url = new URL(remote);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    const path = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    return `https://github.com/${path}.git`;
  } catch {
    return undefined;
  }
};

const isExecutionResult = (value: unknown): value is WorkerExecutionResult => {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<WorkerExecutionResult>;
  return (
    typeof result.attemptId === "string" &&
    typeof result.taskId === "string" &&
    typeof result.executionIdentity === "string" &&
    typeof result.baseCommit === "string" &&
    typeof result.repository === "string" &&
    result.status === "verified" &&
    result.published === false &&
    typeof result.recordPath === "string" &&
    Array.isArray(result.commits) &&
    Array.isArray(result.verification)
  );
};

const loadExecutionResult = async (
  recordPath: string,
): Promise<WorkerExecutionResult> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (cause) {
    throw new WorkerPublicationError(
      `Could not read retained execution evidence at ${recordPath}.`,
      "missing_evidence",
      cause,
    );
  }
  if (!isExecutionResult(value)) {
    throw new WorkerPublicationError(
      `Retained execution evidence at ${recordPath} is not a verified result.`,
      "missing_evidence",
    );
  }
  return value;
};

const verifiedEvidencePath = (attempt: ExecutionAttempt): string | undefined =>
  attempt.outcomes
    .find((outcome) => outcome.status === "verified")
    ?.evidence.find((reference) => reference.endsWith(".json"));

const verificationSummary = (result: WorkerExecutionResult): string =>
  result.verification
    .map(
      (evidence) =>
        `- \`${evidence.command}\`: ${evidence.exitCode === 0 ? "passed" : `failed (${evidence.exitCode})`}`,
    )
    .join("\n");

const pullRequestBody = (
  attempt: ExecutionAttempt,
  result: WorkerExecutionResult,
): string => {
  const task = attempt.request.task;
  const commits = result.commits
    .map((commit) => `- \`${commit.sha}\``)
    .join("\n");
  return [
    "## Sandcastle execution",
    "",
    `Source task: https://github.com/${normalizeRepository(task.repository)}/issues/${task.number}`,
    `Execution identity: \`${attempt.executionIdentity}\``,
    `Base commit: \`${task.baseCommit}\``,
    "",
    "### Resulting commits",
    "",
    commits,
    "",
    "### Verification",
    "",
    verificationSummary(result),
    "",
    "This pull request was published as a draft. Readiness, merge, and source-issue closure require separate authority.",
  ].join("\n");
};

const assertRetainedEvidence = (
  attempt: ExecutionAttempt,
  recordPath: string,
  result: WorkerExecutionResult,
): void => {
  const request = attempt.request;
  const expectedBranch = workerBranchFor(request);
  const commitsAreValid =
    result.commits.length > 0 &&
    result.commits.every((commit) => /^[0-9a-f]{40}$/i.test(commit.sha));
  const verificationMatches =
    request.profile.verificationCommands.length > 0 &&
    result.verification.length ===
      request.profile.verificationCommands.length &&
    result.verification.every(
      (evidence, index) =>
        evidence.phase === "verification" &&
        evidence.command === request.profile.verificationCommands[index] &&
        evidence.exitCode === 0,
    );
  if (
    result.recordPath !== recordPath ||
    result.attemptId !== attempt.attemptId ||
    result.taskId !== request.taskId ||
    result.executionIdentity !== request.executionIdentity ||
    normalizeRepository(result.repository) !==
      normalizeRepository(request.task.repository) ||
    result.baseCommit.toLowerCase() !== request.task.baseCommit.toLowerCase() ||
    result.profileId !== request.profileId ||
    result.profileDigest !== request.profileDigest ||
    result.promptVersion !== request.promptVersion ||
    result.promptTemplateDigest !== request.promptTemplateDigest ||
    result.branch !== expectedBranch ||
    !commitsAreValid ||
    !verificationMatches
  ) {
    throw new WorkerPublicationError(
      `Retained execution evidence for ${attempt.attemptId} does not match its immutable request.`,
      "evidence_mismatch",
    );
  }
};

const parsePullRequest = (value: unknown): DraftPullRequest => {
  if (typeof value !== "object" || value === null) {
    throw new WorkerPublicationError(
      "GitHub returned an invalid pull request.",
      "publication_failed",
    );
  }
  const pullRequest = value as {
    number?: unknown;
    html_url?: unknown;
    draft?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    base?: { ref?: unknown };
  };
  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.html_url !== "string" ||
    typeof pullRequest.draft !== "boolean" ||
    typeof pullRequest.head?.ref !== "string" ||
    typeof pullRequest.head?.sha !== "string" ||
    typeof pullRequest.base?.ref !== "string"
  ) {
    throw new WorkerPublicationError(
      "GitHub returned an incomplete pull request.",
      "publication_failed",
    );
  }
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    draft: pullRequest.draft,
    head: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    base: pullRequest.base.ref,
  };
};

/** Create the credentialed Git/GitHub adapter kept outside the agent sandbox. */
export const createDefaultWorkerPublicationOperations = (
  options: DefaultWorkerPublicationOperationsOptions,
): WorkerPublicationInspectionOperations => {
  const token = options.token.trim();
  if (token === "") {
    throw new WorkerPublicationError(
      "A non-empty GitHub token is required for publication.",
      "publication_failed",
    );
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const gitAuthorization = Buffer.from(`x-access-token:${token}`).toString(
    "base64",
  );
  const request = async (
    url: string,
    init: globalThis.RequestInit = {},
    allowedStatuses: readonly number[] = [],
  ): Promise<globalThis.Response> => {
    const response = await fetchImplementation(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new WorkerPublicationError(
        `GitHub request ${init.method ?? "GET"} ${url} failed with ${response.status}.`,
        "publication_failed",
      );
    }
    return response;
  };
  const git = async (
    repositoryDir: string,
    args: readonly string[],
    authenticated = false,
  ): Promise<string> => {
    const { stdout } = await execFile("git", [...args], {
      cwd: repositoryDir,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        ...(authenticated
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${gitAuthorization}`,
            }
          : {}),
      },
    });
    return stdout.trim();
  };
  const listPullRequests = async (input: {
    readonly repository: string;
    readonly branch: string;
    readonly base: string;
  }): Promise<readonly DraftPullRequest[]> => {
    const [owner] = normalizeRepository(input.repository).split("/");
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${input.branch}`,
      base: input.base,
    });
    const response = await request(
      githubApiUrl(input.repository, `/pulls?${query.toString()}`),
    );
    const value = (await response.json()) as unknown;
    if (!Array.isArray(value)) {
      throw new WorkerPublicationError(
        "GitHub returned an invalid pull request list.",
        "publication_failed",
      );
    }
    return value.map(parsePullRequest);
  };

  return {
    getCanonicalRemote: (repositoryDir) =>
      git(repositoryDir, ["remote", "get-url", "origin"]),
    resolveLocalBranch: ({ repositoryDir, branch }) =>
      git(repositoryDir, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}^{commit}`,
      ]),
    inspectDestination: async (repository) => {
      const response = await request(githubApiUrl(repository));
      const value = (await response.json()) as {
        full_name?: unknown;
        clone_url?: unknown;
      };
      if (
        typeof value.full_name !== "string" ||
        typeof value.clone_url !== "string"
      ) {
        throw new WorkerPublicationError(
          `GitHub returned an invalid destination for ${repository}.`,
          "publication_failed",
        );
      }
      return {
        repository: value.full_name,
        canonicalRemote: value.clone_url,
      };
    },
    findRemoteBranch: async ({ repository, branch }) => {
      const response = await request(
        githubApiUrl(repository, `/branches/${encodeURIComponent(branch)}`),
        {},
        [404],
      );
      if (response.status === 404) return undefined;
      const value = (await response.json()) as { commit?: { sha?: unknown } };
      if (typeof value.commit?.sha !== "string") {
        throw new WorkerPublicationError(
          `GitHub returned an invalid branch for ${branch}.`,
          "publication_failed",
        );
      }
      return { branch, sha: value.commit.sha };
    },
    pushBranch: async ({ repositoryDir, canonicalRemote, branch, sha }) => {
      await git(
        repositoryDir,
        [
          "push",
          "--porcelain",
          `--force-with-lease=refs/heads/${branch}:`,
          canonicalRemote,
          `${sha}:refs/heads/${branch}`,
        ],
        true,
      );
    },
    listPullRequests,
    findPullRequest: async (input) => (await listPullRequests(input))[0],
    createDraftPullRequest: async (input) => {
      const response = await request(githubApiUrl(input.repository, "/pulls"), {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.branch,
          base: input.base,
          draft: true,
        }),
      });
      return parsePullRequest(await response.json());
    },
  };
};

/** Create the guarded boundary that alone may push and open draft pull requests. */
export const createWorkerPublisher = (
  options: WorkerPublisherOptions,
): WorkerPublisher => {
  if (options.workspaceRoot.trim() === "") {
    throw new WorkerPublicationError(
      "workspaceRoot must be non-empty.",
      "publication_failed",
    );
  }
  const resultLoader = options.loadExecutionResult ?? loadExecutionResult;

  return {
    publish: async (attemptId) => {
      const state = await options.store.read();
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === attemptId,
      );
      if (
        attempt === undefined ||
        (attempt.status !== "verified" && attempt.status !== "published") ||
        !attempt.outcomes.some((outcome) => outcome.status === "verified")
      ) {
        throw new WorkerPublicationError(
          `Execution attempt ${attemptId} is not verified.`,
          "not_verified",
        );
      }

      const recordPath = verifiedEvidencePath(attempt);
      if (recordPath === undefined) {
        throw new WorkerPublicationError(
          `Execution attempt ${attemptId} has no retained verification record.`,
          "missing_evidence",
        );
      }
      const result = await resultLoader(recordPath);
      assertRetainedEvidence(attempt, recordPath, result);

      const authorized = runWorkerDryRun({
        configuration:
          options.configurationProvider?.() ?? options.configuration,
        tasks: [
          ...(attempt.claim?.refreshedSnapshots ?? []),
          ...(attempt.request.context.parentPrd === undefined
            ? []
            : [attempt.request.context.parentPrd]),
          attempt.request.task,
        ].filter(
          (task, index, tasks) =>
            tasks.findIndex(
              (candidate) =>
                normalizeRepository(candidate.repository) ===
                  normalizeRepository(task.repository) &&
                candidate.kind === task.kind &&
                candidate.number === task.number,
            ) === index,
        ),
      }).executionRequests.find(
        (candidate) => candidate.taskId === attempt.request.taskId,
      );
      if (
        authorized === undefined ||
        authorized.executionIdentity !== attempt.executionIdentity
      ) {
        throw new WorkerPublicationError(
          `Execution attempt ${attemptId} is no longer authorized for publication.`,
          "unauthorized",
        );
      }

      const repository = normalizeRepository(attempt.request.task.repository);
      const canonicalRemote = canonicalRemoteFor(repository);
      const repositoryDir = workerRepositoryDirectory(
        options.workspaceRoot,
        repository,
      );
      const branch = workerBranchFor(attempt.request);
      const branchSha = (
        await options.operations.resolveLocalBranch({ repositoryDir, branch })
      ).toLowerCase();
      const resultingHead = result.commits.at(-1)!.sha.toLowerCase();
      if (branchSha !== resultingHead) {
        throw new WorkerPublicationError(
          `Local branch ${branch} is at ${branchSha}, not verified commit ${resultingHead}.`,
          "branch_mismatch",
        );
      }

      // Keep both checks adjacent to the push decision so a stale or retargeted
      // cache cannot redirect publication to a different repository.
      const observedRemote =
        await options.operations.getCanonicalRemote(repositoryDir);
      const destination =
        await options.operations.inspectDestination(repository);
      if (
        normalizeCanonicalRemote(observedRemote) !== canonicalRemote ||
        normalizeRepository(destination.repository) !== repository ||
        normalizeCanonicalRemote(destination.canonicalRemote) !==
          canonicalRemote
      ) {
        throw new WorkerPublicationError(
          `Publication destination for ${repository} does not match ${canonicalRemote}.`,
          "remote_mismatch",
        );
      }

      const existingBranch = await options.operations.findRemoteBranch({
        repository,
        branch,
      });
      let reusedBranch = existingBranch !== undefined;
      if (
        existingBranch !== undefined &&
        existingBranch.sha.toLowerCase() !== branchSha
      ) {
        throw new WorkerPublicationError(
          `Remote branch ${branch} exists at a different commit.`,
          "branch_mismatch",
        );
      }
      if (existingBranch === undefined) {
        await options.operations.pushBranch({
          repositoryDir,
          canonicalRemote,
          branch,
          sha: branchSha,
        });
        reusedBranch = false;
      }

      const publishedBranch = await options.operations.findRemoteBranch({
        repository,
        branch,
      });
      if (
        publishedBranch === undefined ||
        publishedBranch.sha.toLowerCase() !== branchSha
      ) {
        throw new WorkerPublicationError(
          `Remote branch ${branch} does not contain the verified commit after publication.`,
          "branch_mismatch",
        );
      }

      const base = attempt.request.task.baseBranch;
      let pullRequest = await options.operations.findPullRequest({
        repository,
        branch,
        base,
      });
      const reusedPullRequest = pullRequest !== undefined;
      if (pullRequest !== undefined && !pullRequest.draft) {
        throw new WorkerPublicationError(
          `Matching pull request #${pullRequest.number} is no longer a draft.`,
          "pull_request_mismatch",
        );
      }
      if (pullRequest === undefined) {
        pullRequest = await options.operations.createDraftPullRequest({
          repository,
          branch,
          base,
          title: attempt.request.task.title,
          body: pullRequestBody(attempt, result),
        });
      }
      if (
        !pullRequest.draft ||
        pullRequest.head !== branch ||
        pullRequest.headSha.toLowerCase() !== branchSha ||
        pullRequest.base !== base
      ) {
        throw new WorkerPublicationError(
          "GitHub did not return the requested draft pull request.",
          "pull_request_mismatch",
        );
      }

      if (attempt.status === "verified") {
        await options.store.transitionAttempt(attempt.attemptId, {
          status: "published",
          evidence: [recordPath, pullRequest.url],
        });
      }
      await options.guardedActions?.record({
        action: "publication",
        executionIdentity: attempt.executionIdentity,
        evidence: [pullRequest.url],
      });
      return {
        attemptId: attempt.attemptId,
        executionIdentity: attempt.executionIdentity,
        repository,
        branch,
        branchSha,
        pullRequest,
        reusedBranch,
        reusedPullRequest,
      };
    },
  };
};
