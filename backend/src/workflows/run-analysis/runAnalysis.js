import { agentExecutionRuntime } from '../../agents/AgentExecutionRuntime.js';
import { executeWorkflowWithRemediation } from '../../core/workflow/WorkflowExecutor.js';
import { ProjectSpace as ProjectFS } from '../../project-space/index.js';
import { RUN_ANALYSIS_WORKFLOW_SPEC } from './workflowSpec.js';
import {
  RUN_ANALYSIS_CONDITION_BINDINGS,
  RUN_ANALYSIS_HANDLER_BINDINGS,
  RUN_ANALYSIS_HYDRATION_BINDINGS,
} from './bindings.js';
import {
  assertWorkflowNodeCompletion,
  validateWorkflowNodeHydration,
} from './completion/workflowCompletion.js';
import {
  blockCheckpointForHumanReview,
  prepareCheckpointRemediation,
} from './policies/remediation.js';
import {
  emitWorkflowNodeRetry,
  openWorkflowRun,
  retryPolicyForWorkflowNode,
  workflowNodeInputDigest,
  workflowWorkspaceSnapshot,
} from './policies/runPolicy.js';
import { observeRunAnalysisAgentBackend } from './runtime/agentBackend.js';
import { createRunAnalysisRuntimeMetrics } from './runtime/metrics.js';
const PRIOR_REVIEW_NODE_IDS = new Set(['compose-report', 'review-report']);

export function priorReviewIssuesForNode({ context, node }) {
  if (!PRIOR_REVIEW_NODE_IDS.has(node.id)) return [];
  return context.cp?.activeRemediation?.issues || [];
}
// 运行完整项目分析（两阶段，支持断点续跑）。options.resume=true 时从 checkpoint 继续。
// The canonical WorkflowSpec owns ordering/dependencies/parallelism; handlers own
// only their bounded business step and share the current workflow context.
export async function runAnalysisWorkflow(id, options = {}) {
  const {
    agentBackend: requestedAgentBackend,
    humanReviewEnabled = false,
    preparedRunId = null,
    signal = null,
    ...workflowOptions
  } = options;
  const resolvedAgentBackend = Object.prototype.hasOwnProperty.call(options, 'agentBackend')
    ? agentExecutionRuntime.resolveBackend(requestedAgentBackend)
    : agentExecutionRuntime.resolveBackend();
  const resumeCheckpoint = workflowOptions.resume ? ProjectFS.checkpoint(id) : null;
  const initialMetrics = resumeCheckpoint ? (resumeCheckpoint.runtimeMetrics || {}) : null;
  const runtimeMetrics = createRunAnalysisRuntimeMetrics(initialMetrics);
  const { runStore, record } = openWorkflowRun(id, {
    ...workflowOptions,
    ...(preparedRunId ? { preparedRunId } : {}),
  });
  const agentBackend = observeRunAnalysisAgentBackend({
    backend: resolvedAgentBackend,
    projectId: id,
    workflowRunId: record.runId,
    recordMetrics: runtimeMetrics.record,
  });
  const context = {
    id,
    options: workflowOptions,
    runtimeMetrics,
    runStore,
    runId: record.runId,
    runRecord: record,
  };
  const execution = await executeWorkflowWithRemediation({
    spec: RUN_ANALYSIS_WORKFLOW_SPEC,
    handlers: RUN_ANALYSIS_HANDLER_BINDINGS,
    hydrators: RUN_ANALYSIS_HYDRATION_BINDINGS,
    conditions: RUN_ANALYSIS_CONDITION_BINDINGS,
    context,
    runStore,
    runId: record.runId,
    reviewNodeId: 'review-report',
    getReviewDecision: ({ context: current }) => current.cp?.reportReview?.decision || null,
    onRemediation: prepareCheckpointRemediation,
    ...(humanReviewEnabled ? { onHumanReview: blockCheckpointForHumanReview } : {}),
    retryPolicyForNode: retryPolicyForWorkflowNode,
    nodeInputDigest: workflowNodeInputDigest,
    workspaceSnapshotForNode: workflowWorkspaceSnapshot,
    onNodeComplete: assertWorkflowNodeCompletion,
    onNodeHydrate: validateWorkflowNodeHydration,
    onNodeRetry: emitWorkflowNodeRetry,
    priorReviewIssuesForNode,
    agentRuntime: agentExecutionRuntime,
    agentBackend,
    signal,
  });
  if (execution.blocked) return execution.result;
  if (execution.humanReviewBypassed) {
    context.cp.humanReviewBypassed = {
      at: new Date().toISOString(),
      route: execution.reviewDecision?.route || null,
      cycle: execution.reviewDecision?.cycle ?? null,
      openIssueCount: execution.reviewDecision?.openIssues?.length || 0,
    };
  }
  context.cp.activeRemediation = null;
  context.cp.openIssues = [];
  context.saveCp?.();
  runStore.completeRun(record.runId);
  ProjectFS.updateMeta(id, { openIssues: [] });
  return execution.result;
}
