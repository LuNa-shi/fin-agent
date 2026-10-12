import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { FRAMEWORK_VERSION } from '../../../config.js';
import { RUN_ANALYSIS_WORKFLOW_SPEC } from '../workflowSpec.js';
import { emit } from '../projection/events.js';
import { applyHumanReviewEntryToCheckpoint } from '../human-review/checkpoint.js';
import { ensureRunAnalysisHumanReviewTask } from '../human-review/taskFactory.js';

export function applyCheckpointRemediation(cp, entry) {
  if (!cp || !entry || !Number.isInteger(entry.cycle) || entry.cycle < 1) return cp;
  if ((cp.remediationCycleApplied || 0) >= entry.cycle) return cp;
  const nodeIds = [...new Set(entry.nodeIds || [])];
  cp.activeRemediation = {
    cycle: entry.cycle,
    owners: [...new Set(entry.owners || [])],
    nodeIds,
    issues: structuredClone(entry.openIssues || []),
    priorNodeArtifactRefs: Object.fromEntries(Object.entries(entry.priorNodes || {}).map(([nodeId, node]) => [
      nodeId,
      structuredClone(node?.artifactRefs || []),
    ])),
    requestedAt: entry.invalidatedAt || new Date().toISOString(),
  };
  cp.remediationCycleApplied = entry.cycle;
  cp.nodeExecutions = cp.nodeExecutions || {};
  for (const nodeId of nodeIds) delete cp.nodeExecutions[nodeId];
  if (nodeIds.includes('compose-report')) cp.reportDone = false;
  if (nodeIds.includes('review-report')) cp.reportReview = null;
  if (nodeIds.includes('synthesize-conclusion')) cp.conclusion = null;
  if (nodeIds.includes('finalize-project')) cp.done = false;
  return cp;
}

export function reconcileCheckpointRemediation(cp, runRecord) {
  const history = Array.isArray(runRecord?.remediationHistory) ? runRecord.remediationHistory : [];
  for (const entry of history) applyCheckpointRemediation(cp, entry);
  const humanReviewHistory = Array.isArray(runRecord?.humanReviewHistory)
    ? runRecord.humanReviewHistory
    : [];
  for (const entry of humanReviewHistory) applyHumanReviewEntryToCheckpoint(cp, entry);
  return cp;
}

export function prepareCheckpointRemediation({ context, decision, plan, cycle }) {
  const run = context.runStore.load(context.runId);
  const entry = (run.remediationHistory || []).find((item) => item.cycle === cycle) || {
    cycle,
    owners: plan.owners,
    nodeIds: plan.nodeIds,
    openIssues: decision.openIssues || [],
    invalidatedAt: new Date().toISOString(),
  };
  applyCheckpointRemediation(context.cp, entry);
  context.saveCp?.();
  emit(context.id, 'final-report', {
    step: 3,
    agent: 'review-adjudicator',
    text: `报告评审触发第 ${cycle}/${RUN_ANALYSIS_WORKFLOW_SPEC.maxRemediationCycles} 轮选择性返工：owner=${plan.owners.join(',')}；仅失效 ${plan.nodeIds.join(' → ')}。`,
    data: { cycle, owners: plan.owners, nodeIds: plan.nodeIds, openIssues: decision.openIssues || [] },
    artifact: 'analysis/report_review_decision.json',
  });
}

export function blockCheckpointForHumanReview({ context, decision }) {
  context.cp.activeRemediation = null;
  context.cp.done = false;
  context.cp.openIssues = structuredClone(decision.openIssues || []);
  context.saveCp?.();
  const meta = ProjectFS.updateMeta(context.id, {
    status: 'review-required',
    lastError: null,
    openIssues: structuredClone(decision.openIssues || []),
    runtimeMetrics: context.runtimeMetrics.snapshot(),
    frameworkVersion: FRAMEWORK_VERSION,
  });
  emit(context.id, 'final-report', {
    step: 3,
    agent: 'review-adjudicator',
    text: `报告评审在 cycle=${decision.cycle ?? 0} 进入 human-review；仍有 ${decision.openIssues?.length || 0} 个 blocking issue，未发布结论。`,
    data: decision,
    artifact: 'analysis/report_review_decision.json',
  });
  const reviewTask = ensureRunAnalysisHumanReviewTask(context.id, {
    runId: context.runId,
    decision,
  });
  return {
    ...meta,
    reviewTask: {
      taskId: reviewTask.taskId,
      version: reviewTask.version,
      status: reviewTask.status,
    },
  };
}
