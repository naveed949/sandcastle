import type {
  RepositoryWorkflowPlanProjection,
  RepositoryWorkflowPlanRecord,
} from "./RepositoryWorkflowPlanner.js";

/** Convert a retained plan into the safe Mission Control workflow projection. */
export const projectRepositoryWorkflowPlan = (
  record: RepositoryWorkflowPlanRecord,
): RepositoryWorkflowPlanProjection => ({
  id: record.id,
  version: 1,
  status: record.status,
  recovery: record.recovery,
  repository: record.repository,
  workflowIdentity: record.workflowIdentity,
  taskId: record.taskId,
  attemptId: record.attemptId,
  executionIdentity: record.executionIdentity,
  cycle: record.input.cycle,
  workflowRevision: record.input.workflowRevision,
  ...(record.input.queuePosition === undefined
    ? {}
    : { queuePosition: record.input.queuePosition }),
  taskSourceRevision: record.input.taskSourceRevision,
  baseBranch: record.input.baseBranch,
  baseRevision: record.input.baseRevision,
  profileId: record.input.profileId,
  profileDigest: record.input.profileDigest,
  promptVersion: record.input.promptVersion,
  promptTemplateDigest: record.input.promptTemplateDigest,
  authorization: record.input.authorization,
  eligibilityReasonCode: record.input.eligibilityReasonCode,
  dependencyOrder: record.input.dependencyOrder,
  dependencyEvidence: record.input.dependencyEvidence,
  createdAt: record.createdAt,
  completedAt: record.completedAt,
  ...(record.plan === undefined ? {} : { plan: record.plan }),
  evidence: record.evidence,
  ...(record.error === undefined ? {} : { errorCode: record.error.code }),
});
