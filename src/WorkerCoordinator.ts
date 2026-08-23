import { createHash } from "node:crypto";

/** The normalized kinds of GitHub task understood by the worker. */
export type TaskKind = "issue" | "prd";

/** The task states that affect deterministic eligibility. */
export type TaskState =
  | "open"
  | "blocked"
  | "closed"
  | "claimed"
  | "completed"
  | "stale";

/** The stable repository/task coordinates used throughout worker decisions. */
export interface TaskReference {
  /** The canonical GitHub repository name, such as `owner/repository`. */
  readonly repository: string;
  /** The source kind of the task. */
  readonly kind: TaskKind;
  /** The issue number within the repository. */
  readonly number: number;
}

/** A centrally controlled execution profile used to build an execution request. */
export interface ExecutionProfile {
  /** Commands that a future execution engine may run during repository setup. */
  readonly setupCommands: readonly string[];
  /** Commands that a future execution engine may run for verification. */
  readonly verificationCommands: readonly string[];
}

/** Central policy for one repository. */
export interface RepositoryPolicy {
  /** Whether every eligible task in this repository is authorized. */
  readonly authorized: boolean;
  /** The base branch against which the task snapshot must have been read. */
  readonly baseBranch: string;
  /** The key of the centrally configured execution profile to use. */
  readonly profileId: string;
}

/** Centrally controlled worker configuration. */
export interface WorkerConfiguration {
  /** Repository policies keyed by repository name. */
  readonly repositories: Readonly<Record<string, RepositoryPolicy>>;
  /** Exact task grants that may authorize work in a non-authorized repository. */
  readonly authorizedTasks: readonly TaskReference[];
  /** Version of the immutable prompt-template artifact selected for execution. */
  readonly promptVersion: string;
  /** Immutable prompt-template artifacts keyed by version. */
  readonly promptTemplates: Readonly<Record<string, string>>;
  /** Execution profiles keyed by the profile IDs referenced by repository policies. */
  readonly profiles: Readonly<Record<string, ExecutionProfile>>;
}

/** A task normalized by a task-source adapter before entering the coordinator. */
export interface NormalizedTask extends TaskReference {
  /** The task title retained in the immutable execution snapshot. */
  readonly title: string;
  /** The task body retained in the immutable execution snapshot. */
  readonly body: string;
  /** Labels retained from the source task for policy and prompt context. */
  readonly labels: readonly string[];
  /** The source revision that freezes the task contents for this attempt. */
  readonly sourceRevision: string;
  /** The base branch observed with the task. */
  readonly baseBranch: string;
  /** The base commit observed with the task. */
  readonly baseCommit: string;
  /** The normalized source state. */
  readonly state: TaskState;
  /** Machine-readable task dependencies. */
  readonly dependencies: readonly TaskReference[];
  /** Child tasks; a non-empty collection means this task is not a ready leaf. */
  readonly children: readonly TaskReference[];
  /** Optional parent PRD context retained for later prompt construction. */
  readonly parentPrd?: TaskReference;
}

/** Stable reason codes returned by the eligibility policy. */
export type EligibilityReasonCode =
  | "eligible"
  | "unauthorized_repository"
  | "closed"
  | "blocked"
  | "stale"
  | "claimed"
  | "completed"
  | "prd"
  | "non_leaf"
  | "unmet_dependency"
  | "missing_profile"
  | "invalid_base";

/** The authorization grant used for a task decision. */
export type AuthorizationSource = "repository" | "task" | "none";

/** One deterministic eligibility result for a normalized task. */
export interface EligibilityDecision {
  /** The immutable task snapshot evaluated by the policy. */
  readonly task: NormalizedTask;
  /** Stable task identity containing repository, kind, and number. */
  readonly taskId: string;
  /** Whether the task can be emitted as an execution request. */
  readonly eligible: boolean;
  /** The stable machine-readable outcome code. */
  readonly reasonCode: EligibilityReasonCode;
  /** A human-readable explanation corresponding to `reasonCode`. */
  readonly reason: string;
  /** The authorization grant, if any, that was observed. */
  readonly authorization: AuthorizationSource;
  /** The execution identity when the task is eligible. */
  readonly executionIdentity?: string;
}

/** An immutable, side-effect-free request for a future execution engine. */
export interface ExecutionRequest {
  /** The immutable task snapshot to pass to a future execution engine. */
  readonly task: NormalizedTask;
  /** Stable task identity containing repository, kind, and number. */
  readonly taskId: string;
  /** SHA-256 identity bound to task revision, base, profile, and prompt version. */
  readonly executionIdentity: string;
  /** The centrally selected profile key. */
  readonly profileId: string;
  /** The digest of the selected execution profile. */
  readonly profileDigest: string;
  /** The prompt-template version bound to this request. */
  readonly promptVersion: string;
  /** Digest of the immutable prompt-template artifact. */
  readonly promptTemplateDigest: string;
  /** Immutable prompt template containing the `{{TASK_SNAPSHOT}}` marker. */
  readonly promptTemplate: string;
  /** The immutable profile snapshot selected for this request. */
  readonly profile: ExecutionProfile;
}

/** Mutations that are intentionally absent from a dry-run result. */
export type DryRunMutation =
  | "checkout"
  | "agent-invocation"
  | "github-mutation"
  | "push"
  | "pull-request";

/** Machine-readable dry-run projection. */
export interface DryRunMachineOutput {
  /** Version of the machine-readable projection. */
  readonly version: 1;
  /** The projection mode. */
  readonly mode: "dry-run";
  /** Always true because this coordinator does not perform mutations. */
  readonly readOnly: true;
  /** Mutations performed while producing the projection; always empty. */
  readonly mutations: readonly DryRunMutation[];
  /** Ordered eligibility decisions. */
  readonly decisions: readonly EligibilityDecision[];
  /** Ordered requests for eligible tasks. */
  readonly executionRequests: readonly ExecutionRequest[];
}

/** The complete human- and machine-readable dry-run result. */
export interface DryRunResult {
  /** Ordered decisions for every supplied task. */
  readonly decisions: readonly EligibilityDecision[];
  /** Requests emitted for eligible tasks only. */
  readonly executionRequests: readonly ExecutionRequest[];
  /** Stable text suitable for an operator or log. */
  readonly humanReadable: string;
  /** The JSON-serializable projection of the same decisions and requests. */
  readonly machineReadable: DryRunMachineOutput;
}

/** Input to the public worker dry-run seam. */
export interface WorkerDryRunInput {
  /** Centrally controlled authorization and execution configuration. */
  readonly configuration: WorkerConfiguration;
  /** Normalized tasks supplied by a task-source test double or adapter. */
  readonly tasks: readonly NormalizedTask[];
}

/** Raised when central worker configuration is invalid. */
export class WorkerConfigurationError extends Error {
  /** Individual configuration validation failures. */
  readonly issues: readonly string[];

  /** Create a typed configuration validation error. */
  constructor(issues: readonly string[]) {
    super(`Invalid worker configuration: ${issues.join("; ")}`);
    this.name = "WorkerConfigurationError";
    this.issues = [...issues];
  }
}

/** Raised when a task does not satisfy the normalized task contract. */
export class NormalizedTaskError extends Error {
  /** The zero-based position of the invalid task, when known. */
  readonly index: number;

  /** Create a typed normalized-task validation error. */
  constructor(index: number, message: string) {
    super(`Invalid normalized task at index ${index}: ${message}`);
    this.name = "NormalizedTaskError";
    this.index = index;
  }
}

type ValidatedConfiguration = {
  readonly repositories: ReadonlyMap<string, RepositoryPolicy>;
  readonly authorizedTasks: ReadonlySet<string>;
  readonly profiles: Readonly<Record<string, ExecutionProfile>>;
  readonly promptVersion: string;
  readonly promptTemplate: string;
  readonly promptTemplateDigest: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTaskKind = (value: unknown): value is TaskKind =>
  value === "issue" || value === "prd";

const isTaskState = (value: unknown): value is TaskState =>
  value === "open" ||
  value === "blocked" ||
  value === "closed" ||
  value === "claimed" ||
  value === "completed" ||
  value === "stale";

/** Normalize a GitHub owner/repository identity for worker policy and storage. */
export const normalizeRepository = (repository: string): string =>
  repository.trim().toLowerCase();

const isRepositoryName = (repository: string): boolean =>
  /^[^/\s]+\/[^/\s]+$/.test(repository);

const taskIdFor = (task: TaskReference): string =>
  `${normalizeRepository(task.repository)}:${task.kind}:${task.number}`;

const displayTask = (task: TaskReference): string =>
  `${normalizeRepository(task.repository)}#${task.number} (${task.kind})`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Cannot hash an unsupported value");
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalize(value)).digest("hex");

/** Compute the canonical digest that binds a prompt-template artifact to execution. */
export const digestPromptTemplate = (template: string): string =>
  sha256(template);

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
};

const normalizeReference = (
  reference: TaskReference,
  context: string,
  taskIndex: number,
): TaskReference => {
  if (
    !isRecord(reference) ||
    typeof reference.repository !== "string" ||
    !isRepositoryName(normalizeRepository(reference.repository)) ||
    !isTaskKind(reference.kind) ||
    typeof reference.number !== "number" ||
    !Number.isInteger(reference.number) ||
    reference.number < 1
  ) {
    throw new NormalizedTaskError(
      taskIndex,
      `${context} must be a valid task reference`,
    );
  }

  return {
    repository: normalizeRepository(reference.repository),
    kind: reference.kind,
    number: reference.number,
  };
};

const normalizeTask = (task: NormalizedTask, index: number): NormalizedTask => {
  if (!isRecord(task))
    throw new NormalizedTaskError(index, "task must be an object");
  if (
    typeof task.repository !== "string" ||
    !isRepositoryName(normalizeRepository(task.repository))
  ) {
    throw new NormalizedTaskError(index, "repository must be owner/name");
  }
  if (!isTaskKind(task.kind)) {
    throw new NormalizedTaskError(index, "kind must be issue or prd");
  }
  if (!Number.isInteger(task.number) || task.number < 1) {
    throw new NormalizedTaskError(index, "number must be a positive integer");
  }
  if (typeof task.title !== "string" || typeof task.body !== "string") {
    throw new NormalizedTaskError(index, "title and body must be strings");
  }
  if (
    !Array.isArray(task.labels) ||
    !task.labels.every((label) => typeof label === "string")
  ) {
    throw new NormalizedTaskError(index, "labels must be string[]");
  }
  if (typeof task.sourceRevision !== "string") {
    throw new NormalizedTaskError(index, "sourceRevision must be a string");
  }
  if (!task.sourceRevision.trim()) {
    throw new NormalizedTaskError(
      index,
      "sourceRevision must be a non-empty string",
    );
  }
  if (
    typeof task.baseBranch !== "string" ||
    typeof task.baseCommit !== "string"
  ) {
    throw new NormalizedTaskError(
      index,
      "baseBranch and baseCommit must be strings",
    );
  }
  if (!isTaskState(task.state)) {
    throw new NormalizedTaskError(index, "state is not recognized");
  }
  if (!Array.isArray(task.dependencies) || !Array.isArray(task.children)) {
    throw new NormalizedTaskError(
      index,
      "dependencies and children must be arrays",
    );
  }

  return deepFreeze({
    repository: normalizeRepository(task.repository),
    kind: task.kind,
    number: task.number,
    title: task.title,
    body: task.body,
    labels: task.labels.map((label) => label.trim()),
    sourceRevision: task.sourceRevision.trim(),
    baseBranch: task.baseBranch.trim(),
    baseCommit: task.baseCommit.trim(),
    state: task.state,
    dependencies: task.dependencies.map((reference, dependencyIndex) =>
      normalizeReference(reference, `dependencies[${dependencyIndex}]`, index),
    ),
    children: task.children.map((reference, childIndex) =>
      normalizeReference(reference, `children[${childIndex}]`, index),
    ),
    ...(task.parentPrd === undefined
      ? {}
      : { parentPrd: normalizeReference(task.parentPrd, "parentPrd", index) }),
  });
};

const validateConfiguration = (
  configuration: WorkerConfiguration,
): ValidatedConfiguration => {
  const issues: string[] = [];
  const repositories = new Map<string, RepositoryPolicy>();

  if (!isRecord(configuration)) {
    throw new WorkerConfigurationError(["configuration must be an object"]);
  }

  if (
    typeof configuration.promptVersion !== "string" ||
    !configuration.promptVersion.trim()
  ) {
    issues.push("promptVersion must be a non-empty string");
  }

  const promptTemplates: Record<string, string> = {};
  if (!isRecord(configuration.promptTemplates)) {
    issues.push("promptTemplates must be an object");
  } else {
    for (const [version, template] of Object.entries(
      configuration.promptTemplates,
    )) {
      if (version.trim() === "" || typeof template !== "string") {
        issues.push("prompt template versions must map to strings");
        continue;
      }
      if (!template.includes("{{TASK_SNAPSHOT}}")) {
        issues.push(
          `prompt template ${version} must include {{TASK_SNAPSHOT}}`,
        );
      }
      promptTemplates[version.trim()] = template;
    }
  }
  const selectedPromptVersion =
    typeof configuration.promptVersion === "string"
      ? configuration.promptVersion.trim()
      : "";
  const promptTemplate = promptTemplates[selectedPromptVersion];
  if (selectedPromptVersion !== "" && promptTemplate === undefined) {
    issues.push(
      `promptVersion ${selectedPromptVersion} references a missing template`,
    );
  }

  if (!isRecord(configuration.repositories)) {
    issues.push("repositories must be an object");
  } else {
    for (const [configuredRepository, rawPolicy] of Object.entries(
      configuration.repositories,
    )) {
      const repository = normalizeRepository(configuredRepository);
      if (!isRepositoryName(repository)) {
        issues.push(`repository ${configuredRepository} must be owner/name`);
        continue;
      }
      if (repositories.has(repository)) {
        issues.push(`repository ${configuredRepository} is duplicated`);
        continue;
      }
      if (!isRecord(rawPolicy)) {
        issues.push(
          `repository ${configuredRepository} policy must be an object`,
        );
        continue;
      }
      if (typeof rawPolicy.authorized !== "boolean") {
        issues.push(
          `repository ${configuredRepository} authorized must be boolean`,
        );
      }
      if (
        typeof rawPolicy.baseBranch !== "string" ||
        !rawPolicy.baseBranch.trim()
      ) {
        issues.push(
          `repository ${configuredRepository} baseBranch must be non-empty`,
        );
      }
      if (
        typeof rawPolicy.profileId !== "string" ||
        !rawPolicy.profileId.trim()
      ) {
        issues.push(
          `repository ${configuredRepository} profileId must be non-empty`,
        );
      }
      repositories.set(repository, {
        authorized:
          typeof rawPolicy.authorized === "boolean"
            ? rawPolicy.authorized
            : false,
        baseBranch:
          typeof rawPolicy.baseBranch === "string"
            ? rawPolicy.baseBranch.trim()
            : "",
        profileId:
          typeof rawPolicy.profileId === "string"
            ? rawPolicy.profileId.trim()
            : "",
      });
    }
  }

  const profiles: Record<string, ExecutionProfile> = {};
  if (!isRecord(configuration.profiles)) {
    issues.push("profiles must be an object");
  } else {
    for (const [profileId, rawProfile] of Object.entries(
      configuration.profiles,
    )) {
      const normalizedProfileId = profileId.trim();
      if (!normalizedProfileId) {
        issues.push("profile IDs must be non-empty");
        continue;
      }
      if (Object.hasOwn(profiles, normalizedProfileId)) {
        issues.push(`profile ${profileId} is duplicated`);
        continue;
      }
      if (!isRecord(rawProfile)) {
        issues.push(`profile ${profileId} must be an object`);
        continue;
      }
      if (
        !Array.isArray(rawProfile.setupCommands) ||
        !rawProfile.setupCommands.every(
          (command) => typeof command === "string",
        )
      ) {
        issues.push(
          `profile ${normalizedProfileId} setupCommands must be string[]`,
        );
      }
      if (
        !Array.isArray(rawProfile.verificationCommands) ||
        !rawProfile.verificationCommands.every(
          (command) => typeof command === "string",
        )
      ) {
        issues.push(
          `profile ${normalizedProfileId} verificationCommands must be string[]`,
        );
      }
      const setupCommands = rawProfile.setupCommands;
      const verificationCommands = rawProfile.verificationCommands;
      if (
        Array.isArray(setupCommands) &&
        setupCommands.every((command) => typeof command === "string") &&
        Array.isArray(verificationCommands) &&
        verificationCommands.every((command) => typeof command === "string")
      ) {
        profiles[normalizedProfileId] = {
          setupCommands: [...setupCommands],
          verificationCommands: [...verificationCommands],
        };
      }
    }
  }

  for (const [repository, policy] of repositories) {
    if (!Object.hasOwn(profiles, policy.profileId)) {
      issues.push(
        `repository ${repository} references missing profile ${policy.profileId}`,
      );
    }
  }

  const authorizedTasks = new Set<string>();
  if (!Array.isArray(configuration.authorizedTasks)) {
    issues.push("authorizedTasks must be an array");
  } else {
    for (const [index, task] of configuration.authorizedTasks.entries()) {
      if (!isRecord(task)) {
        issues.push(`authorizedTasks[${index}] must be an object`);
        continue;
      }
      const repository = task.repository;
      const kind = task.kind;
      const number = task.number;
      if (
        typeof repository !== "string" ||
        !isRepositoryName(normalizeRepository(repository)) ||
        !isTaskKind(kind) ||
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < 1
      ) {
        issues.push(`authorizedTasks[${index}] is not a valid task reference`);
        continue;
      }
      const id = taskIdFor({ repository, kind, number });
      if (authorizedTasks.has(id)) {
        issues.push(`authorizedTasks[${index}] duplicates ${id}`);
      }
      authorizedTasks.add(id);
    }
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    repositories,
    authorizedTasks,
    profiles: deepFreeze(profiles),
    promptVersion: selectedPromptVersion,
    promptTemplate: promptTemplate ?? "",
    promptTemplateDigest: digestPromptTemplate(promptTemplate ?? ""),
  };
};

const completedDependencyIds = (
  tasks: readonly NormalizedTask[],
): ReadonlySet<string> =>
  new Set(
    tasks
      .filter((task) => task.state === "completed" || task.state === "closed")
      .map(taskIdFor),
  );

const reasonForState = (
  state: Exclude<TaskState, "open">,
): Exclude<
  EligibilityReasonCode,
  | "eligible"
  | "unauthorized_repository"
  | "prd"
  | "non_leaf"
  | "unmet_dependency"
  | "missing_profile"
  | "invalid_base"
> => state;

const decision = (
  task: NormalizedTask,
  authorization: AuthorizationSource,
  reasonCode: EligibilityReasonCode,
  reason: string,
  executionIdentity?: string,
): EligibilityDecision =>
  deepFreeze({
    task,
    taskId: taskIdFor(task),
    eligible: reasonCode === "eligible",
    reasonCode,
    reason,
    authorization,
    ...(executionIdentity === undefined ? {} : { executionIdentity }),
  });

const formatHumanReadable = (
  decisions: readonly EligibilityDecision[],
  executionRequests: readonly ExecutionRequest[],
): string => {
  const lines = [
    `Dry run: ${decisions.length} candidate(s), ${executionRequests.length} eligible.`,
    ...decisions.map((item) => {
      const status = item.eligible ? "ELIGIBLE" : "REJECTED";
      const identity =
        item.executionIdentity === undefined
          ? ""
          : ` execution=${item.executionIdentity}`;
      return `${status} ${displayTask(item.task)} reason=${item.reasonCode}${identity}`;
    }),
  ];
  return lines.join("\n");
};

/**
 * Evaluate normalized tasks against central policy without checking out a
 * repository, invoking an agent, mutating GitHub, pushing, or creating a PR.
 *
 * The returned requests are immutable and suitable for a later execution
 * engine. Repeated calls with equivalent inputs produce equivalent ordering
 * and identities.
 */
export const runWorkerDryRun = ({
  configuration,
  tasks,
}: WorkerDryRunInput): DryRunResult => {
  const validated = validateConfiguration(configuration);
  const normalizedTasks = tasks.map(normalizeTask);
  const seenTaskIds = new Set<string>();
  for (const task of normalizedTasks) {
    const id = taskIdFor(task);
    if (seenTaskIds.has(id)) {
      throw new NormalizedTaskError(
        normalizedTasks.indexOf(task),
        `duplicate task identity ${id}`,
      );
    }
    seenTaskIds.add(id);
  }

  const orderedTasks = [...normalizedTasks].sort((left, right) =>
    compareStrings(taskIdFor(left), taskIdFor(right)),
  );
  const completeDependencies = completedDependencyIds(orderedTasks);
  const decisions: EligibilityDecision[] = [];
  const executionRequests: ExecutionRequest[] = [];

  for (const task of orderedTasks) {
    const id = taskIdFor(task);
    const repositoryPolicy = validated.repositories.get(
      normalizeRepository(task.repository),
    );
    const taskAuthorized = validated.authorizedTasks.has(id);
    const authorization: AuthorizationSource =
      repositoryPolicy?.authorized === true
        ? "repository"
        : taskAuthorized
          ? "task"
          : "none";

    if (authorization === "none") {
      decisions.push(
        decision(
          task,
          authorization,
          "unauthorized_repository",
          "The repository or exact task is not centrally authorized.",
        ),
      );
      continue;
    }

    if (task.state !== "open") {
      const reasonCode = reasonForState(task.state);
      decisions.push(
        decision(
          task,
          authorization,
          reasonCode,
          `Task state is ${task.state}.`,
        ),
      );
      continue;
    }

    if (task.kind === "prd") {
      decisions.push(
        decision(
          task,
          authorization,
          "prd",
          "PRDs provide context and are not executable tasks.",
        ),
      );
      continue;
    }

    if (task.children.length > 0) {
      decisions.push(
        decision(
          task,
          authorization,
          "non_leaf",
          "Only ready leaf tasks are executable.",
        ),
      );
      continue;
    }

    const unmetDependency = task.dependencies.find(
      (dependency) => !completeDependencies.has(taskIdFor(dependency)),
    );
    if (unmetDependency !== undefined) {
      decisions.push(
        decision(
          task,
          authorization,
          "unmet_dependency",
          `Dependency ${displayTask(unmetDependency)} is not complete.`,
        ),
      );
      continue;
    }

    if (repositoryPolicy === undefined) {
      decisions.push(
        decision(
          task,
          authorization,
          "missing_profile",
          "The exact task has no repository policy or execution profile.",
        ),
      );
      continue;
    }

    const profile = validated.profiles[repositoryPolicy.profileId];
    if (profile === undefined) {
      decisions.push(
        decision(
          task,
          authorization,
          "missing_profile",
          `Execution profile ${repositoryPolicy.profileId} is not configured.`,
        ),
      );
      continue;
    }

    if (
      !task.baseCommit.trim() ||
      task.baseBranch.trim() !== repositoryPolicy.baseBranch.trim()
    ) {
      decisions.push(
        decision(
          task,
          authorization,
          "invalid_base",
          "The task base branch or base commit does not match central policy.",
        ),
      );
      continue;
    }

    const profileSnapshot = deepFreeze({
      setupCommands: [...profile.setupCommands],
      verificationCommands: [...profile.verificationCommands],
    });
    const profileDigest = sha256(profileSnapshot);
    const executionIdentity = sha256({
      taskId: id,
      taskRevision: task.sourceRevision,
      baseCommit: task.baseCommit,
      profileDigest,
      promptVersion: validated.promptVersion,
      promptTemplateDigest: validated.promptTemplateDigest,
    });
    const request = deepFreeze({
      task,
      taskId: id,
      executionIdentity,
      profileId: repositoryPolicy.profileId,
      profileDigest,
      promptVersion: validated.promptVersion,
      promptTemplateDigest: validated.promptTemplateDigest,
      promptTemplate: validated.promptTemplate,
      profile: profileSnapshot,
    });

    decisions.push(
      decision(
        task,
        authorization,
        "eligible",
        "Task is authorized and ready.",
        executionIdentity,
      ),
    );
    executionRequests.push(request);
  }

  const frozenDecisions = deepFreeze(decisions);
  const frozenRequests = deepFreeze(executionRequests);
  const machineReadable = deepFreeze({
    version: 1 as const,
    mode: "dry-run" as const,
    readOnly: true as const,
    mutations: [] as readonly DryRunMutation[],
    decisions: frozenDecisions,
    executionRequests: frozenRequests,
  });

  return deepFreeze({
    decisions: frozenDecisions,
    executionRequests: frozenRequests,
    humanReadable: formatHumanReadable(frozenDecisions, frozenRequests),
    machineReadable,
  });
};
