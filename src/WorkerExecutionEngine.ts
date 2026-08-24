import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ExecutionRequest,
  WorkerConfiguration,
} from "./WorkerCoordinator.js";
import {
  digestPromptTemplate,
  normalizeRepository,
} from "./WorkerCoordinator.js";
import type {
  PreparedWorkerRepository,
  WorkerAgentResult,
  WorkerCommandEvidence,
  WorkerRepositoryManager,
} from "./WorkerRepositoryManager.js";
import type { CloseResult } from "./createSandbox.js";
import type { ExecutionAttempt, WorkerStateStore } from "./WorkerStateStore.js";
import type { WorkerGuardedActionRecorder } from "./WorkerGuardedActions.js";

export type {
  PreparedWorkerRepository,
  WorkerRepositoryManager,
} from "./WorkerRepositoryManager.js";

export type WorkerExecutionFailurePhase =
  | "preparation"
  | "setup"
  | "execution"
  | "verification"
  | "cleanup";

export interface WorkerExecutionResult {
  /** Durable attempt identity. */
  readonly attemptId: string;
  /** Repository-qualified task identity. */
  readonly taskId: string;
  /** Identity bound to immutable execution inputs. */
  readonly executionIdentity: string;
  /** Frozen base commit used to create the worktree. */
  readonly baseCommit: string;
  /** Centrally selected execution-profile identity. */
  readonly profileId: string;
  /** Digest of the immutable execution profile. */
  readonly profileDigest: string;
  /** Version of the immutable prompt-template artifact. */
  readonly promptVersion: string;
  /** Digest of the immutable prompt-template artifact. */
  readonly promptTemplateDigest: string;
  /** Normalized owner/repository identity. */
  readonly repository: string;
  /** Evidence-gated terminal result. */
  readonly status: "interrupted" | "failed" | "verified";
  /** Phase that failed, when the attempt was not verified. */
  readonly failurePhase?: WorkerExecutionFailurePhase;
  /** Human-readable failure detail. */
  readonly error?: string;
  /** Deterministic local source branch. */
  readonly branch?: string;
  /** Repository-qualified cache used for this attempt. */
  readonly repositoryDir?: string;
  /** Repository-qualified worktree used for this attempt. */
  readonly worktreePath?: string;
  /** Repository-authority credential names exposed to the agent boundary. */
  readonly repositoryCredentialNames?: readonly string[];
  /** Commits retained by Sandcastle. */
  readonly commits: readonly { readonly sha: string }[];
  /** Structured setup command evidence. */
  readonly setup: readonly WorkerCommandEvidence[];
  /** Structured independent verification evidence. */
  readonly verification: readonly WorkerCommandEvidence[];
  /** Structured Sandcastle agent result, when invocation began. */
  readonly agent?: WorkerAgentResult;
  /** Sandcastle worktree cleanup result. */
  readonly cleanup?: CloseResult;
  /** Cleanup exception detail, when cleanup itself threw. */
  readonly cleanupError?: string;
  /** Local execution never publishes; a later guarded publisher owns that boundary. */
  readonly published: false;
  readonly recordPath: string;
}

export interface WorkerExecutionEngineOptions {
  /** Current central authorization and execution policy. */
  readonly configuration: WorkerConfiguration;
  /** Repository preparation boundary. */
  readonly repositoryManager: WorkerRepositoryManager;
  /** Durable attempt lifecycle boundary. */
  readonly store: WorkerStateStore;
  /** Host root for repository-qualified structured execution records. */
  readonly recordsRoot: string;
  readonly guardedActions?: WorkerGuardedActionRecorder;
}

export interface WorkerExecutionEngine {
  /** Execute one active revision-bound claim through verification. */
  execute(
    attempt: ExecutionAttempt,
    options?: WorkerExecutionOptions,
  ): Promise<WorkerExecutionResult>;
}

/** Per-attempt controls delegated to Sandcastle execution. */
export interface WorkerExecutionOptions {
  /** Abort the active agent invocation while preserving recovery evidence. */
  readonly signal?: AbortSignal;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const safeSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "attempt";
const attemptFilename = (attemptId: string): string =>
  `${safeSegment(attemptId)}-${createHash("sha256").update(attemptId).digest("hex").slice(0, 12)}.json`;

const recordPathFor = (
  recordsRoot: string,
  request: ExecutionRequest,
  attemptId: string,
): string => {
  const [owner, repository] = normalizeRepository(
    request.task.repository,
  ).split("/");
  return join(
    recordsRoot,
    "repositories",
    owner ?? "unknown",
    repository ?? "unknown",
    "executions",
    request.executionIdentity,
    attemptFilename(attemptId),
  );
};

const retainResult = async (result: WorkerExecutionResult): Promise<void> => {
  await mkdir(dirname(result.recordPath), { recursive: true });
  const temporary = `${result.recordPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, result.recordPath);
};

const runCommands = async (
  prepared: PreparedWorkerRepository,
  commands: readonly string[],
  phase: "setup" | "verification",
  signal?: AbortSignal,
): Promise<readonly WorkerCommandEvidence[]> => {
  const evidence: WorkerCommandEvidence[] = [];
  for (const command of commands) {
    let result: WorkerCommandEvidence;
    try {
      result = await prepared.runCommand(command, phase, { signal });
    } catch (cause) {
      result = {
        command,
        phase,
        exitCode: 1,
        stdout: "",
        stderr: errorMessage(cause),
      };
    }
    evidence.push(result);
    if (result.exitCode !== 0) break;
  }
  return evidence;
};

const failedCommand = (
  evidence: readonly WorkerCommandEvidence[],
): WorkerCommandEvidence | undefined =>
  evidence.find((result) => result.exitCode !== 0);

/** Create an evidence-gated local execution engine with no publication authority. */
export const createWorkerExecutionEngine = (
  options: WorkerExecutionEngineOptions,
): WorkerExecutionEngine => {
  if (options.recordsRoot.trim() === "") {
    throw new Error("recordsRoot must be non-empty.");
  }
  return {
    execute: async (attempt, executionOptions = {}) => {
      if (
        attempt.status !== "active" ||
        attempt.claim === undefined ||
        attempt.executionIdentity !== attempt.request.executionIdentity
      ) {
        throw new Error(
          `Execution attempt ${attempt.attemptId} is not an active revision-bound claim.`,
        );
      }

      // Once this transition is durable, a failed or expired lease is no longer a safe blind retry.
      const startedAttempt = await options.store.markAttemptStarted(
        attempt.attemptId,
      );
      const request = startedAttempt.request;
      const recordPath = recordPathFor(
        options.recordsRoot,
        request,
        startedAttempt.attemptId,
      );
      const setup: WorkerCommandEvidence[] = [];
      const verification: WorkerCommandEvidence[] = [];
      let prepared: PreparedWorkerRepository | undefined;
      let agent: WorkerAgentResult | undefined;
      let status: "interrupted" | "failed" | "verified" = "failed";
      let failurePhase: WorkerExecutionFailurePhase | undefined;
      let error: string | undefined;
      let cleanupError: string | undefined;
      let cleanup: CloseResult | undefined;

      try {
        try {
          prepared = await options.repositoryManager.prepare({
            configuration: options.configuration,
            request,
            relatedTasks: startedAttempt.claim?.refreshedSnapshots,
          });
        } catch (cause) {
          failurePhase = "preparation";
          error = errorMessage(cause);
        }

        if (prepared !== undefined) {
          const setupEvidence = await runCommands(
            prepared,
            request.profile.setupCommands,
            "setup",
            executionOptions.signal,
          );
          setup.push(...setupEvidence);
          const setupFailure = failedCommand(setupEvidence);
          if (setupFailure !== undefined) {
            if (executionOptions.signal?.aborted) status = "interrupted";
            failurePhase = "setup";
            error = `Setup command failed with exit code ${setupFailure.exitCode}: ${setupFailure.command}`;
          }
        }

        if (prepared !== undefined && failurePhase === undefined) {
          if (
            digestPromptTemplate(request.promptTemplate) !==
            request.promptTemplateDigest
          ) {
            failurePhase = "execution";
            error = `Prompt template ${request.promptVersion} does not match its immutable digest.`;
          } else {
            const prompt = request.promptTemplate.replaceAll(
              "{{TASK_SNAPSHOT}}",
              JSON.stringify(
                { task: request.task, context: request.context },
                null,
                2,
              ),
            );
            try {
              // Only the versioned prompt crosses this boundary. The API intentionally has
              // no orchestration-env or credential field.
              agent = await prepared.runAgent({
                prompt,
                ...(executionOptions.signal === undefined
                  ? {}
                  : { signal: executionOptions.signal }),
              });
            } catch (cause) {
              if (executionOptions.signal?.aborted) status = "interrupted";
              failurePhase = "execution";
              error = errorMessage(cause);
            }
          }
        }

        if (prepared !== undefined && failurePhase === undefined) {
          if (
            agent === undefined ||
            agent.commits.length === 0 ||
            !agent.commits.every((commit) => /^[0-9a-f]{40}$/i.test(commit.sha))
          ) {
            failurePhase = "execution";
            error = "Agent execution did not retain a valid resulting commit.";
          }
        }

        if (prepared !== undefined && failurePhase === undefined) {
          const verificationEvidence = await runCommands(
            prepared,
            request.profile.verificationCommands,
            "verification",
            executionOptions.signal,
          );
          verification.push(...verificationEvidence);
          const verificationFailure = failedCommand(verificationEvidence);
          if (verificationFailure !== undefined) {
            if (executionOptions.signal?.aborted) status = "interrupted";
            failurePhase = "verification";
            error = `Verification command failed with exit code ${verificationFailure.exitCode}: ${verificationFailure.command}`;
          } else {
            status = "verified";
          }
        }
      } catch (cause) {
        if (executionOptions.signal?.aborted) status = "interrupted";
        failurePhase ??= prepared === undefined ? "preparation" : "execution";
        error ??= errorMessage(cause);
      } finally {
        if (prepared !== undefined) {
          try {
            cleanup = await prepared.close();
            if (
              cleanup.preservedWorktreePath !== undefined &&
              status !== "interrupted"
            ) {
              status = "failed";
              failurePhase = "cleanup";
              error = `Worktree contains uncommitted changes and was preserved at ${cleanup.preservedWorktreePath}.`;
            }
          } catch (cause) {
            cleanupError = errorMessage(cause);
            if (status === "verified") {
              status = "failed";
              failurePhase = "cleanup";
              error = cleanupError;
            }
          }
        }
      }

      const result: WorkerExecutionResult = {
        attemptId: startedAttempt.attemptId,
        taskId: request.taskId,
        executionIdentity: request.executionIdentity,
        baseCommit: request.task.baseCommit,
        profileId: request.profileId,
        profileDigest: request.profileDigest,
        promptVersion: request.promptVersion,
        promptTemplateDigest: request.promptTemplateDigest,
        repository: normalizeRepository(request.task.repository),
        status,
        ...(failurePhase === undefined ? {} : { failurePhase }),
        ...(error === undefined ? {} : { error }),
        ...(prepared === undefined ? {} : { branch: prepared.branch }),
        ...(prepared === undefined
          ? {}
          : {
              repositoryDir: prepared.repositoryDir,
              worktreePath: prepared.worktreePath,
            }),
        repositoryCredentialNames: prepared?.repositoryCredentialNames ?? [],
        commits: agent?.commits ?? [],
        setup,
        verification,
        ...(agent === undefined ? {} : { agent }),
        ...(cleanup === undefined ? {} : { cleanup }),
        ...(cleanupError === undefined ? {} : { cleanupError }),
        published: false,
        recordPath,
      };

      await retainResult(result);
      const evidence = [recordPath];
      if (agent?.logFilePath !== undefined) evidence.push(agent.logFilePath);
      await options.store.transitionAttempt(startedAttempt.attemptId, {
        status,
        evidence,
      });
      if (status === "verified") {
        await options.guardedActions?.record({
          action: "verification",
          executionIdentity: request.executionIdentity,
          evidence: [recordPath],
        });
      }
      return result;
    },
  };
};
