import {
  runWorkerDryRun,
  type DryRunResult,
  type NormalizedTask,
  type TaskKind,
  type TaskReference,
  type TaskState,
  type WorkerConfiguration,
} from "./WorkerCoordinator.js";

/** The only request shape used by the GitHub task source. */
export interface GitHubRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
}

/** The response surface required by the read-only GitHub adapter. */
export interface GitHubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  json(): Promise<unknown>;
}

/** Injectable HTTP transport used by the deterministic GitHub tests. */
export type GitHubFetch = (
  url: string,
  init: GitHubRequestInit,
) => Promise<GitHubResponse>;

/** Labels that map GitHub issues to non-open worker states. */
export type GitHubTaskStateLabels = Partial<
  Record<Exclude<TaskState, "open" | "closed">, string>
>;

/** Configuration for a read-only GitHub task source. */
export interface GitHubTaskSourceOptions {
  /** GitHub login used by account-wide authored-issue discovery. */
  readonly account?: string;
  /** Optional token used only for GET requests to the GitHub API. */
  readonly token?: string;
  /** API origin, primarily useful for a test server. */
  readonly apiBaseUrl?: string;
  /** Injectable GET-only transport. */
  readonly fetch?: GitHubFetch;
  /** Explicit PRD references controlled by the worker operator. */
  readonly prdReferences?: readonly TaskReference[];
  /** Label treated as a PRD marker when no explicit reference is present. */
  readonly prdLabel?: string;
  /** Centrally chosen labels for non-open task states. */
  readonly stateLabels?: GitHubTaskStateLabels;
  /** Additional non-secret headers for the GitHub API. */
  readonly requestHeaders?: Readonly<Record<string, string>>;
}

/** Inputs controlling which read-only GitHub discovery modes run. */
export interface GitHubTaskDiscoveryInput {
  /** Central authorization and execution policy passed to the dry-run seam. */
  readonly configuration: WorkerConfiguration;
  /** Explicit issue references to fetch; defaults to configured exact grants. */
  readonly exactTasks?: readonly TaskReference[];
  /** Discover all issues listed by configured repositories. */
  readonly includeConfiguredRepositories?: boolean;
  /** Discover accessible issues authored by the configured account. */
  readonly includeAccountWide?: boolean;
  /** Additional operator-controlled PRD references for this discovery. */
  readonly prdReferences?: readonly TaskReference[];
}

/** Read-only task-source seam consumed by the worker dry-run coordinator. */
export interface GitHubTaskSource {
  discover(input: GitHubTaskDiscoveryInput): Promise<readonly NormalizedTask[]>;
}

/** Convenience input that connects a GitHub source to the dry-run coordinator. */
export interface GitHubWorkerDryRunInput extends GitHubTaskDiscoveryInput {
  readonly source: GitHubTaskSource;
}

/** A typed error for malformed or failed read-only GitHub responses. */
export class GitHubTaskSourceError extends Error {
  readonly url?: string;
  readonly status?: number;

  constructor(
    message: string,
    details: { readonly url?: string; readonly status?: number } = {},
  ) {
    super(message);
    this.name = "GitHubTaskSourceError";
    this.url = details.url;
    this.status = details.status;
  }
}

type JsonRecord = Record<string, unknown>;

interface Candidate {
  readonly repository: string;
  readonly number: number;
  readonly kindHint: TaskKind;
}

const DEFAULT_API_BASE_URL = "https://api.github.com/";
const DEFAULT_PRD_LABEL = "prd";
const DEFAULT_STATE_LABELS: GitHubTaskStateLabels = {
  blocked: "blocked",
  claimed: "claimed",
  completed: "completed",
  stale: "stale",
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeRepository = (repository: string): string =>
  repository.trim().toLowerCase();

const isRepositoryName = (repository: string): boolean =>
  /^[^/\s]+\/[^/\s]+$/.test(repository);

const taskCoordinate = (repository: string, number: number): string =>
  `${normalizeRepository(repository)}#${number}`;

const taskId = (reference: TaskReference): string =>
  `${normalizeRepository(reference.repository)}:${reference.kind}:${reference.number}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const repositoryPath = (repository: string): string =>
  repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

const parseRepositoryUrl = (value: unknown): string | undefined => {
  const raw = nonEmptyString(value);
  if (raw === undefined) return undefined;

  if (isRepositoryName(normalizeRepository(raw))) {
    return normalizeRepository(raw);
  }

  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const reposIndex = parts.indexOf("repos");
    const candidate =
      reposIndex >= 0
        ? parts.slice(reposIndex + 1, reposIndex + 3).join("/")
        : parts.slice(0, 2).join("/");
    const normalized = normalizeRepository(candidate);
    return isRepositoryName(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const repositoryFromPayload = (
  payload: JsonRecord,
  fallback?: string,
): string | undefined => {
  const repository = payload.repository;
  const fromObject = isRecord(repository)
    ? parseRepositoryUrl(repository.full_name)
    : undefined;
  return (
    fromObject ??
    parseRepositoryUrl(payload.repository_url) ??
    parseRepositoryUrl(payload.url) ??
    parseRepositoryUrl(payload.html_url) ??
    (fallback === undefined ? undefined : normalizeRepository(fallback))
  );
};

const numberFromPayload = (payload: JsonRecord): number | undefined =>
  typeof payload.number === "number" &&
  Number.isInteger(payload.number) &&
  payload.number > 0
    ? payload.number
    : undefined;

const referenceFromPayload = (
  payload: unknown,
  fallbackRepository?: string,
  kind: TaskKind = "issue",
): TaskReference | undefined => {
  if (!isRecord(payload)) return undefined;
  const repository = repositoryFromPayload(payload, fallbackRepository);
  const number = numberFromPayload(payload);
  if (repository === undefined || number === undefined) return undefined;
  return { repository, kind, number };
};

const referenceFromIssueUrl = (
  value: unknown,
  kind: TaskKind,
): TaskReference | undefined => {
  const raw = nonEmptyString(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const reposIndex = parts.indexOf("repos");
    const repositoryStart = reposIndex >= 0 ? reposIndex + 1 : 0;
    const repository = parts
      .slice(repositoryStart, repositoryStart + 2)
      .join("/");
    const issuesIndex = parts.indexOf("issues", repositoryStart + 2);
    const number = Number(parts[issuesIndex + 1]);
    if (
      !isRepositoryName(normalizeRepository(repository)) ||
      !Number.isInteger(number) ||
      number < 1
    ) {
      return undefined;
    }
    return {
      repository: normalizeRepository(repository),
      kind,
      number,
    };
  } catch {
    return undefined;
  }
};

const isPullRequest = (payload: JsonRecord): boolean =>
  isRecord(payload.pull_request) ||
  (typeof payload.html_url === "string" && payload.html_url.includes("/pull/"));

const labelsFromPayload = (payload: JsonRecord): readonly string[] => {
  if (!Array.isArray(payload.labels)) return [];
  const labels = payload.labels.flatMap((label): string[] => {
    if (typeof label === "string") return [label.trim()].filter(Boolean);
    if (isRecord(label)) {
      const name = nonEmptyString(label.name);
      return name === undefined ? [] : [name];
    }
    return [];
  });
  return [...new Set(labels)].sort(compareStrings);
};

const stateFromPayload = (
  payload: JsonRecord,
  labels: readonly string[],
  stateLabels: GitHubTaskStateLabels,
): TaskState => {
  if (payload.state === "closed") return "closed";
  if (
    payload.state === "blocked" ||
    payload.state === "claimed" ||
    payload.state === "completed" ||
    payload.state === "stale"
  ) {
    return payload.state;
  }
  const normalizedLabels = new Set(labels.map((label) => label.toLowerCase()));
  for (const [state, label] of Object.entries(stateLabels)) {
    if (
      label !== undefined &&
      normalizedLabels.has(label.trim().toLowerCase())
    ) {
      return state as Exclude<TaskState, "open" | "closed">;
    }
  }
  return "open";
};

const defaultFetch: GitHubFetch = async (url, init) => {
  const response = await globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: () => response.json() as Promise<unknown>,
  };
};

const apiUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  try {
    return new URL(path.replace(/^\//, ""), normalizedBase).toString();
  } catch (error) {
    throw new GitHubTaskSourceError("GitHub API base URL is invalid", {
      url: baseUrl,
    });
  }
};

const validateRepository = (repository: string): string => {
  const normalized = normalizeRepository(repository);
  if (!isRepositoryName(normalized)) {
    throw new GitHubTaskSourceError(`Invalid GitHub repository ${repository}.`);
  }
  return normalized;
};

const validateReference = (reference: TaskReference): TaskReference => {
  if (
    !isRecord(reference) ||
    typeof reference.repository !== "string" ||
    typeof reference.kind !== "string" ||
    !["issue", "prd"].includes(reference.kind) ||
    typeof reference.number !== "number" ||
    !Number.isInteger(reference.number) ||
    reference.number < 1
  ) {
    throw new GitHubTaskSourceError("Invalid explicit GitHub task reference.");
  }
  return {
    repository: validateRepository(reference.repository),
    kind: reference.kind as TaskKind,
    number: reference.number,
  };
};

const recordsFromArray = (
  value: unknown,
  url: string,
): readonly JsonRecord[] => {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GitHubTaskSourceError("GitHub returned an unexpected array.", {
      url,
    });
  }
  return value;
};

const recordsFromSearch = (
  value: unknown,
  url: string,
): readonly JsonRecord[] => {
  if (!isRecord(value)) {
    throw new GitHubTaskSourceError(
      "GitHub returned an unexpected search response.",
      {
        url,
      },
    );
  }
  return recordsFromArray(value.items, url);
};

/** Create a task source that uses only read-only GitHub REST endpoints. */
export const createGitHubTaskSource = (
  options: GitHubTaskSourceOptions = {},
): GitHubTaskSource => {
  const fetchJson = options.fetch ?? defaultFetch;
  const baseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const stateLabels = { ...DEFAULT_STATE_LABELS, ...options.stateLabels };
  const prdLabel = (options.prdLabel ?? DEFAULT_PRD_LABEL).trim().toLowerCase();

  const request = async (
    path: string,
    optionalStatuses: readonly number[] = [],
  ): Promise<unknown | undefined> => {
    const url = apiUrl(baseUrl, path);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.requestHeaders,
    };
    const token = options.token?.trim();
    if (token !== undefined && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    let response: GitHubResponse;
    try {
      response = await fetchJson(url, { method: "GET", headers });
    } catch (error) {
      throw new GitHubTaskSourceError(
        `GitHub GET request failed: ${error instanceof Error ? error.message : String(error)}`,
        { url },
      );
    }
    if (optionalStatuses.includes(response.status)) return undefined;
    if (!response.ok) {
      throw new GitHubTaskSourceError(
        `GitHub GET request returned ${response.status}${response.statusText === undefined ? "" : ` ${response.statusText}`}.`,
        { url, status: response.status },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new GitHubTaskSourceError(
        `GitHub response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { url, status: response.status },
      );
    }
  };

  const repositoryInfoCache = new Map<
    string,
    Promise<{ readonly defaultBranch: string }>
  >();
  const commitCache = new Map<string, Promise<string>>();

  const repositoryInfo = (
    repository: string,
  ): Promise<{ readonly defaultBranch: string }> => {
    const normalizedRepository = validateRepository(repository);
    const cached = repositoryInfoCache.get(normalizedRepository);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const path = `/repos/${repositoryPath(normalizedRepository)}`;
      const url = apiUrl(baseUrl, path);
      const payload = await request(path);
      if (!isRecord(payload)) {
        throw new GitHubTaskSourceError(
          "GitHub repository response was invalid.",
          {
            url,
          },
        );
      }
      const defaultBranch = nonEmptyString(payload.default_branch);
      if (defaultBranch === undefined) {
        throw new GitHubTaskSourceError(
          "GitHub repository response did not include a default branch.",
          { url },
        );
      }
      return { defaultBranch };
    })();
    repositoryInfoCache.set(normalizedRepository, pending);
    return pending;
  };

  const baseCommit = (repository: string, branch: string): Promise<string> => {
    const normalizedRepository = validateRepository(repository);
    const normalizedBranch = branch.trim();
    const cacheKey = `${normalizedRepository}:${normalizedBranch}`;
    const cached = commitCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const path = `/repos/${repositoryPath(normalizedRepository)}/commits/${encodeURIComponent(normalizedBranch)}`;
    const pending = (async () => {
      const url = apiUrl(baseUrl, path);
      const payload = await request(path);
      if (!isRecord(payload)) {
        throw new GitHubTaskSourceError("GitHub commit response was invalid.", {
          url,
        });
      }
      const sha = nonEmptyString(payload.sha);
      if (sha === undefined) {
        throw new GitHubTaskSourceError(
          "GitHub commit response did not include a SHA.",
          { url },
        );
      }
      return sha;
    })();
    commitCache.set(cacheKey, pending);
    return pending;
  };

  const relationshipReferences = async (
    repository: string,
    number: number,
    relationship: "dependencies/blocked_by" | "sub_issues",
  ): Promise<readonly TaskReference[]> => {
    const path = `/repos/${repositoryPath(repository)}/issues/${number}/${relationship}`;
    const payload = await request(path, [404]);
    if (payload === undefined) return [];
    const records = recordsFromArray(payload, apiUrl(baseUrl, path));
    return records.flatMap((record) => {
      const reference = referenceFromPayload(record, repository);
      return reference === undefined ? [] : [reference];
    });
  };

  const addCandidate = (
    candidates: Map<string, Candidate>,
    reference: TaskReference,
  ): void => {
    const normalized = validateReference(reference);
    const key = taskCoordinate(normalized.repository, normalized.number);
    const existing = candidates.get(key);
    if (existing === undefined || normalized.kind === "prd") {
      candidates.set(key, {
        repository: normalized.repository,
        number: normalized.number,
        kindHint: normalized.kind,
      });
    }
  };

  const addPayloadCandidate = (
    candidates: Map<string, Candidate>,
    payload: JsonRecord,
    fallbackRepository?: string,
  ): void => {
    if (isPullRequest(payload)) return;
    const reference = referenceFromPayload(payload, fallbackRepository);
    if (reference !== undefined) addCandidate(candidates, reference);
  };

  const discoverRepositoryIssues = async (
    candidates: Map<string, Candidate>,
    repository: string,
  ): Promise<void> => {
    const normalizedRepository = validateRepository(repository);
    for (let page = 1; ; page += 1) {
      const path = `/repos/${repositoryPath(normalizedRepository)}/issues?state=all&per_page=100&page=${page}`;
      const payload = await request(path);
      const records = recordsFromArray(payload, apiUrl(baseUrl, path));
      for (const record of records) {
        addPayloadCandidate(candidates, record, normalizedRepository);
      }
      if (records.length < 100) return;
    }
  };

  const discoverAccountIssues = async (
    candidates: Map<string, Candidate>,
    account: string,
  ): Promise<void> => {
    const normalizedAccount = account.trim();
    if (!/^[A-Za-z0-9-]+$/.test(normalizedAccount)) {
      throw new GitHubTaskSourceError("GitHub account must be a login.");
    }
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        q: `author:${normalizedAccount} is:issue`,
        per_page: "100",
        page: String(page),
      });
      const path = `/search/issues?${query.toString()}`;
      const payload = await request(path);
      const records = recordsFromSearch(payload, apiUrl(baseUrl, path));
      for (const record of records) addPayloadCandidate(candidates, record);
      if (records.length < 100) return;
    }
  };

  const discover = async ({
    configuration,
    exactTasks = configuration.authorizedTasks,
    includeConfiguredRepositories = true,
    includeAccountWide = true,
    prdReferences = [],
  }: GitHubTaskDiscoveryInput): Promise<readonly NormalizedTask[]> => {
    const candidates = new Map<string, Candidate>();
    const configuredRepositories = isRecord(configuration.repositories)
      ? Object.entries(configuration.repositories)
          .filter(
            ([, policy]) => isRecord(policy) && policy.authorized === true,
          )
          .map(([repository]) => validateRepository(repository))
          .sort(compareStrings)
      : [];

    if (includeConfiguredRepositories) {
      for (const repository of configuredRepositories) {
        await discoverRepositoryIssues(candidates, repository);
      }
    }

    for (const reference of exactTasks) addCandidate(candidates, reference);

    if (includeAccountWide) {
      const account = options.account?.trim();
      if (account === undefined || account.length === 0) {
        throw new GitHubTaskSourceError(
          "Account-wide discovery requires a configured GitHub account.",
        );
      }
      await discoverAccountIssues(candidates, account);
    }

    const prdKeys = new Set<string>([
      ...(options.prdReferences ?? []).map((reference) => {
        const normalized = validateReference(reference);
        return taskCoordinate(normalized.repository, normalized.number);
      }),
      ...prdReferences.map((reference) => {
        const normalized = validateReference(reference);
        return taskCoordinate(normalized.repository, normalized.number);
      }),
    ]);
    const tasks: NormalizedTask[] = [];
    const sortedCandidates = [...candidates.values()].sort((left, right) =>
      compareStrings(
        taskCoordinate(left.repository, left.number),
        taskCoordinate(right.repository, right.number),
      ),
    );

    for (const candidate of sortedCandidates) {
      const repository = validateRepository(candidate.repository);
      const issuePath = `/repos/${repositoryPath(repository)}/issues/${candidate.number}`;
      const issueUrl = apiUrl(baseUrl, issuePath);
      const payload = await request(issuePath);
      if (!isRecord(payload)) {
        throw new GitHubTaskSourceError("GitHub issue response was invalid.", {
          url: issueUrl,
        });
      }
      if (isPullRequest(payload)) continue;
      const number = numberFromPayload(payload);
      if (number !== candidate.number) {
        throw new GitHubTaskSourceError(
          "GitHub issue response did not match the requested number.",
          { url: issueUrl },
        );
      }

      const labels = labelsFromPayload(payload);
      const prd =
        candidate.kindHint === "prd" ||
        prdKeys.has(taskCoordinate(repository, number)) ||
        labels.some((label) => label.toLowerCase() === prdLabel) ||
        (nonEmptyString(payload.title)?.toLowerCase().startsWith("prd:") ??
          false);
      const kind: TaskKind = prd ? "prd" : "issue";
      const parentPrd = referenceFromIssueUrl(payload.parent_issue_url, "prd");
      const dependencies = await relationshipReferences(
        repository,
        number,
        "dependencies/blocked_by",
      );
      const children = await relationshipReferences(
        repository,
        number,
        "sub_issues",
      );
      const info = await repositoryInfo(repository);
      const policy = isRecord(configuration.repositories)
        ? configuration.repositories[repository]
        : undefined;
      const configuredBaseBranch =
        isRecord(policy) && typeof policy.baseBranch === "string"
          ? nonEmptyString(policy.baseBranch)
          : undefined;
      const baseBranch = configuredBaseBranch ?? info.defaultBranch;
      const baseCommitValue = await baseCommit(repository, baseBranch);
      const sourceRevision =
        nonEmptyString(payload.updated_at) ?? nonEmptyString(payload.node_id);
      if (sourceRevision === undefined) {
        throw new GitHubTaskSourceError(
          "GitHub issue response did not include a source revision.",
          { url: issueUrl },
        );
      }
      const title = nonEmptyString(payload.title);
      if (title === undefined || typeof payload.body !== "string") {
        throw new GitHubTaskSourceError(
          "GitHub issue response did not include title and body.",
          { url: issueUrl },
        );
      }

      tasks.push({
        repository,
        kind,
        number,
        title,
        body: payload.body,
        labels,
        sourceRevision,
        baseBranch,
        baseCommit: baseCommitValue,
        state: stateFromPayload(payload, labels, stateLabels),
        dependencies,
        children,
        ...(parentPrd === undefined ? {} : { parentPrd }),
      });
    }

    return tasks.sort((left, right) =>
      compareStrings(taskId(left), taskId(right)),
    );
  };

  return { discover };
};

/** Discover GitHub tasks and immediately evaluate them through the pure coordinator. */
export const runGitHubWorkerDryRun = async ({
  source,
  ...input
}: GitHubWorkerDryRunInput): Promise<DryRunResult> =>
  runWorkerDryRun({
    configuration: input.configuration,
    tasks: await source.discover(input),
  });
