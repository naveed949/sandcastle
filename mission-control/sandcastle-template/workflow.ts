import type { RepositoryWorkflowDefinition } from "../src/RepositoryWorkflowRuntime.js";

/** Repository-owned workflow declaration consumed by standalone and managed execution. */
export const repositoryWorkflow: RepositoryWorkflowDefinition = {
  id: "parallel-planner-review-v1",
  maxCycles: 10,
  maxParallel: 4,
  planner: {
    model: "gpt-5.6-terra",
    effort: "medium",
    prompt: "./.sandcastle/plan-prompt.md",
  },
  implementer: {
    model: "gpt-5.6-luna",
    effort: "max",
    prompt: "./.sandcastle/implement-prompt.md",
  },
  reviewer: {
    model: "gpt-5.6-sol",
    effort: "medium",
    prompt: "./.sandcastle/review-prompt.md",
  },
  integrator: {
    model: "gpt-5.6-terra",
    effort: "medium",
    prompt: "./.sandcastle/merge-prompt.md",
  },
};
