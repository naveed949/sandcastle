/** Agent configuration frozen into a repository workflow definition. */
export interface RepositoryWorkflowAgent {
  readonly model: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  readonly prompt: string;
}

/** Declarative orchestration policy shared by standalone and managed runs. */
export interface RepositoryWorkflowDefinition {
  readonly id: string;
  readonly maxCycles: number;
  readonly maxParallel: number;
  readonly planner: RepositoryWorkflowAgent;
  readonly implementer: RepositoryWorkflowAgent;
  readonly reviewer: RepositoryWorkflowAgent;
  readonly integrator: RepositoryWorkflowAgent;
}

export interface RepositoryWorkflowIssue {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
}

export interface RepositoryWorkflowCycleInput {
  readonly repository: string;
  readonly featureBranch: string;
  readonly workflow: RepositoryWorkflowDefinition;
  readonly cycle: number;
  readonly signal?: AbortSignal;
}

export interface RepositoryWorkflowAgentResult {
  readonly commits: readonly string[];
  readonly logReference?: string;
  readonly sessionId?: string;
}

export interface RepositoryWorkflowPlanner {
  plan(input: RepositoryWorkflowCycleInput): Promise<{
    readonly issues: readonly RepositoryWorkflowIssue[];
    readonly logReference?: string;
    readonly sessionId?: string;
  }>;
}

export interface RepositoryWorkflowTaskRunner {
  implement(
    input: RepositoryWorkflowCycleInput & {
      readonly issue: RepositoryWorkflowIssue;
    },
  ): Promise<RepositoryWorkflowAgentResult>;
  review(
    input: RepositoryWorkflowCycleInput & {
      readonly issue: RepositoryWorkflowIssue;
      readonly implementation: RepositoryWorkflowAgentResult;
    },
  ): Promise<RepositoryWorkflowAgentResult>;
}

export interface RepositoryWorkflowIntegrator {
  integrate(
    input: RepositoryWorkflowCycleInput & {
      readonly branches: readonly string[];
      readonly issues: readonly RepositoryWorkflowIssue[];
    },
  ): Promise<{ readonly commit: string; readonly logReference?: string }>;
}

export interface RepositoryWorkflowIssueTracker {
  closeIssues(input: {
    readonly repository: string;
    readonly issueNumbers: readonly number[];
    readonly integrationCommit: string;
  }): Promise<void>;
}

export interface RepositoryWorkflowTaskResult {
  readonly issue: RepositoryWorkflowIssue;
  readonly status: "reviewed" | "no_changes" | "failed";
  readonly implementation?: RepositoryWorkflowAgentResult;
  readonly review?: RepositoryWorkflowAgentResult;
  readonly error?: string;
}

export interface RepositoryWorkflowCycleResult {
  readonly repository: string;
  readonly cycle: number;
  readonly status: "idle" | "integrated" | "no_changes";
  readonly tasks: readonly RepositoryWorkflowTaskResult[];
  readonly planner?: {
    readonly logReference?: string;
    readonly sessionId?: string;
  };
  readonly integrationCommit?: string;
  readonly integrationLogReference?: string;
}

export interface RepositoryWorkflowRuntime {
  runCycle(
    input: RepositoryWorkflowCycleInput,
  ): Promise<RepositoryWorkflowCycleResult>;
}

export interface RepositoryWorkflowRuntimeOptions {
  readonly planner: RepositoryWorkflowPlanner;
  readonly taskRunner: RepositoryWorkflowTaskRunner;
  readonly integrator: RepositoryWorkflowIntegrator;
  readonly issueTracker: RepositoryWorkflowIssueTracker;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const mapConcurrent = async <T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<readonly R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), values.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await work(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

/** Create the composite workflow used above the existing single-task worker. */
export const createRepositoryWorkflowRuntime = (
  options: RepositoryWorkflowRuntimeOptions,
): RepositoryWorkflowRuntime => ({
  async runCycle(input) {
    if (input.workflow.maxParallel < 1) {
      throw new Error("workflow maxParallel must be at least 1.");
    }
    const plan = await options.planner.plan(input);
    const issues = plan.issues;
    if (issues.length === 0) {
      return {
        repository: input.repository,
        cycle: input.cycle,
        status: "idle",
        tasks: [],
        planner: { logReference: plan.logReference, sessionId: plan.sessionId },
      };
    }

    const tasks = await mapConcurrent(
      issues,
      input.workflow.maxParallel,
      async (issue) => {
        try {
          const implementation = await options.taskRunner.implement({
            ...input,
            issue,
          });
          if (implementation.commits.length === 0) {
            return { issue, status: "no_changes" as const, implementation };
          }
          const review = await options.taskRunner.review({
            ...input,
            issue,
            implementation,
          });
          return { issue, status: "reviewed" as const, implementation, review };
        } catch (error) {
          return {
            issue,
            status: "failed" as const,
            error: errorMessage(error),
          };
        }
      },
    );
    const completed = tasks.filter((task) => task.status === "reviewed");
    if (completed.length === 0) {
      return {
        repository: input.repository,
        cycle: input.cycle,
        status: "no_changes",
        tasks,
        planner: { logReference: plan.logReference, sessionId: plan.sessionId },
      };
    }

    const integration = await options.integrator.integrate({
      ...input,
      branches: completed.map((task) => task.issue.branch),
      issues: completed.map((task) => task.issue),
    });
    await options.issueTracker.closeIssues({
      repository: input.repository,
      issueNumbers: completed.map((task) => task.issue.number),
      integrationCommit: integration.commit,
    });
    return {
      repository: input.repository,
      cycle: input.cycle,
      status: "integrated",
      tasks,
      planner: { logReference: plan.logReference, sessionId: plan.sessionId },
      integrationCommit: integration.commit,
      integrationLogReference: integration.logReference,
    };
  },
});
