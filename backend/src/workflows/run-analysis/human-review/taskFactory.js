import {
  HUMAN_REVIEW_TASK_SCHEMA_VERSION,
  createHumanReviewTask,
  humanReviewTaskId,
} from '../../../core/contracts/HumanReview.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../../../core/workflow/NodeState.js';
import { ProjectSpace } from '../../../project-space/index.js';
import { RUN_STATUSES } from '../../../project-space/RunStore.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  topologicalNodeOrder,
} from '../workflowSpec.js';
import {
  RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS,
  runAnalysisHumanReviewPolicy,
} from './policy.js';

function taskError(message, code = 'HUMAN_REVIEW_TASK_ERROR', statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function latestRun(projectSpace, projectId, runId = null) {
  const store = projectSpace.runStore(projectId);
  return runId ? store.load(runId) : store.list().at(-1) || null;
}

function reviewDecisionRef(reviewRefs) {
  return reviewRefs.find((ref) => /^analysis\/reviews\/report_quality_r\d+\.json$/u.test(ref.path || ''))
    || reviewRefs[0]
    || null;
}

export function ensureRunAnalysisHumanReviewTask(projectId, {
  runId = null,
  decision = null,
  projectSpace = ProjectSpace,
} = {}) {
  const meta = projectSpace.meta(projectId);
  if (!meta) throw taskError(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
  const run = latestRun(projectSpace, projectId, runId);
  if (!run) throw taskError(`run not found for project: ${projectId}`, 'RUN_NOT_FOUND', 404);
  if (run.status !== RUN_STATUSES.BLOCKED || run.stopReason !== 'human-review') {
    throw taskError(`run is not blocked for human review: ${run.runId}`, 'RUN_NOT_REVIEW_BLOCKED');
  }
  if (!run.blockedStateDigest || !Number.isInteger(run.reviewBlockCount)) {
    throw taskError('blocked run lacks W7 review identity', 'HUMAN_REVIEW_BLOCK_IDENTITY_MISSING');
  }
  const issues = structuredClone(run.openIssues || []);
  if (!issues.length) throw taskError('blocked run has no open issues', 'HUMAN_REVIEW_ISSUES_MISSING');
  if (decision && canonicalSha256(decision.openIssues || []) !== canonicalSha256(issues)) {
    throw taskError('checkpoint decision conflicts with durable blocked issues', 'HUMAN_REVIEW_ISSUES_CONFLICT');
  }
  const reviewNode = run.nodes?.['review-report'];
  if (reviewNode?.status !== NODE_STATES.SUCCEEDED || !(reviewNode.artifactRefs || []).length) {
    throw taskError('blocked run lacks successful review ArtifactRefs', 'HUMAN_REVIEW_REVIEW_ARTIFACTS_MISSING');
  }
  const reviewArtifactRefs = reviewNode.artifactRefs.map((ref) => structuredClone(ref));
  const sourceDecisionRef = reviewDecisionRef(reviewArtifactRefs);
  const blockedNodeId = topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC)
    .find((nodeId) => run.nodes?.[nodeId]?.status === NODE_STATES.BLOCKED);
  if (!blockedNodeId) throw taskError('blocked run has no blocked node', 'HUMAN_REVIEW_BLOCKED_NODE_MISSING');
  const policy = runAnalysisHumanReviewPolicy();
  const createdAt = run.completedAt || run.updatedAt;
  const identity = {
    projectId,
    runId: run.runId,
    workflow: run.workflowSpec,
    reviewBlockCount: run.reviewBlockCount,
    blockedStateDigest: run.blockedStateDigest,
    issuesDigest: canonicalSha256(issues),
    reviewArtifactRefs,
    policyDigest: policy.digest,
  };
  const task = createHumanReviewTask({
    schemaVersion: HUMAN_REVIEW_TASK_SCHEMA_VERSION,
    taskId: humanReviewTaskId(identity),
    version: 1,
    status: 'open',
    projectId,
    runId: run.runId,
    workflow: structuredClone(run.workflowSpec),
    blockedNodeId,
    reviewNodeId: 'review-report',
    remediationCycle: run.remediationCycle || 0,
    reviewBlockCount: run.reviewBlockCount,
    blockedStateDigest: run.blockedStateDigest,
    issues,
    issuesDigest: canonicalSha256(issues),
    allowedActions: [...RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS],
    requestedActions: issues.map((issue) => ({
      issueId: issue.id,
      owner: issue.owner,
      requestedAction: issue.requestedAction,
    })),
    createdAt,
    updatedAt: createdAt,
    policy,
    reviewArtifactRefs,
    reviewDecisionArtifactRef: sourceDecisionRef,
    previousTaskRef: null,
    producingDecisionRef: null,
  });
  const store = projectSpace.humanReviewStore(projectId);
  const existing = store.get(task.taskId);
  let created;
  if (existing) {
    const originalRef = existing.decision?.taskRef || existing.taskArtifactRef;
    let original;
    try {
      original = createHumanReviewTask(
        JSON.parse(projectSpace.artifactStore(projectId).read(originalRef)),
      );
    } catch {
      throw taskError(
        'existing Human Review task lacks a valid original audit artifact',
        'HUMAN_REVIEW_TASK_AUDIT_CONFLICT',
      );
    }
    if (
      original.taskId !== task.taskId
      || original.version !== 1
      || original.contentDigest !== task.contentDigest
    ) {
      throw taskError(
        'existing Human Review task conflicts with the blocked run identity',
        'HUMAN_REVIEW_TASK_CONFLICT',
      );
    }
    created = existing;
  } else {
    created = store.createTask(task);
  }
  for (const prior of store.list()) {
    if (
      prior.taskId !== created.taskId
      && prior.runId === created.runId
      && prior.status === 'resuming'
      && prior.decision
    ) {
      store.markOutcome(prior.taskId, {
        status: 'superseded',
        resultingRunStatus: RUN_STATUSES.BLOCKED,
        completedAt: createdAt,
      });
    }
  }
  return created;
}
