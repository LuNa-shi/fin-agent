import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { stampWorkflowSpecIdentity } from '../../../core/workflow/WorkflowExecutor.js';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { RUN_STATUSES } from '../../../project-space/RunStore.js';
import { getAgentDefinition } from '../../../agents/registry.js';
import { FRAMEWORK_VERSION } from '../../../config.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../workflowSpec.js';
import { remediationIdentityForNode } from '../human-review/checkpoint.js';
import { emit } from '../projection/events.js';
import { createArtifactRunId } from '../runtime/runIdentity.js';

const RUN_ANALYSIS_TRANSIENT_RETRY_COUNT = 4;
const DEFAULT_TRANSIENT_RETRY_BACKOFF_MS = Object.freeze([10_000, 30_000, 90_000, 180_000]);

function normalizeRunAsOf(value, label = 'Run Analysis asOf') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function runInputDigest(id, meta, options, checkpoint, asOf) {
  return canonicalSha256({
    workflowSpecHash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    projectId: id,
    projectCreatedAt: meta.createdAt,
    intensity: checkpoint?.intensityKey || options.intensity || meta.intensity || 'standard',
    industryTemplate: checkpoint?.industryTplId || options.industryTemplate || meta.industryTemplate || null,
    companyTemplate: checkpoint?.companyTplId || options.companyTemplate || meta.companyTemplate || null,
    asOf,
    frozenDataDigest: options.frozenDataByRound ? canonicalSha256(options.frozenDataByRound) : null,
  });
}

function assertRunWorkflowIdentity(record) {
  const identity = record.workflowSpec;
  if (
    identity.id !== RUN_ANALYSIS_WORKFLOW_SPEC.id
    || identity.version !== RUN_ANALYSIS_WORKFLOW_SPEC.version
    || identity.hash !== RUN_ANALYSIS_WORKFLOW_SPEC_HASH
  ) {
    throw new Error(`run workflow spec conflict: ${identity.id}@${identity.version} ${identity.hash}`);
  }
}

function runPolicyError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertRunCanResume(record, checkpoint) {
  if (record.status === RUN_STATUSES.BLOCKED) {
    throw runPolicyError(
      `run requires human review: ${record.runId}`,
      'RUN_REVIEW_REQUIRED',
    );
  }
  const incompleteMatchingCheckpoint = (
    checkpoint?.artifactRunId === record.runId
    && checkpoint.done === false
  );
  if (record.status === RUN_STATUSES.SUCCEEDED && !incompleteMatchingCheckpoint) {
    throw runPolicyError(
      `run is already complete: ${record.runId}`,
      'RUN_NOT_RESUMABLE',
    );
  }
}

function resolveWorkflowRun(id, options = {}) {
  const meta = ProjectFS.meta(id);
  if (!meta) throw new Error('project not found');
  const runStore = ProjectFS.runStore(id);
  const checkpoint = options.resume ? ProjectFS.checkpoint(id) : null;
  const requestedAsOf = options.asOf == null ? null : normalizeRunAsOf(options.asOf);
  if (checkpoint && !checkpoint.workflowSpec) {
    throw new Error('checkpoint workflow spec identity is missing; legacy Run Analysis checkpoint cannot resume');
  }
  if (checkpoint) stampWorkflowSpecIdentity(checkpoint, RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH);
  if (checkpoint?.artifactAsOf && requestedAsOf && normalizeRunAsOf(checkpoint.artifactAsOf, 'checkpoint artifactAsOf') !== requestedAsOf) {
    throw new Error(`checkpoint asOf conflict: expected ${checkpoint.artifactAsOf}, got ${requestedAsOf}`);
  }
  let record = null;
  if (options.resume) {
    // The most recently created durable run is authoritative. Searching farther
    // back can bypass a newer human-review terminal or reopen a superseded run.
    record = runStore.list().at(-1)
      || (checkpoint?.artifactRunId ? runStore.load(checkpoint.artifactRunId) : null);
  }
  if (record) {
    assertRunWorkflowIdentity(record);
    assertRunCanResume(record, checkpoint);
    record = runStore.prepareResume(record.runId);
  } else {
    const runId = checkpoint?.artifactRunId || createArtifactRunId(id);
    const asOf = checkpoint?.artifactAsOf
      ? normalizeRunAsOf(checkpoint.artifactAsOf, 'checkpoint artifactAsOf')
      : (requestedAsOf || new Date().toISOString());
    record = runStore.begin({
      runId,
      workflowSpec: {
        id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
        version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
        hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
      },
      inputDigest: runInputDigest(id, meta, options, checkpoint, asOf),
      asOf,
      nodeIds: RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.id),
      allowSupersede: options.resume !== true,
    });
  }
  return { runStore, record };
}

function openPreparedWorkflowRun(id, options = {}) {
  const meta = ProjectFS.meta(id);
  if (!meta) throw new Error('project not found');
  const runStore = ProjectFS.runStore(id);
  const record = runStore.load(options.preparedRunId);
  if (!record) throw new Error(`prepared run not found: ${options.preparedRunId}`);
  assertRunWorkflowIdentity(record);
  if (record.status !== 'RUNNING') {
    throw new Error(`prepared run is not running: ${record.runId} (${record.status})`);
  }
  const latest = runStore.list().at(-1);
  if (!latest || latest.runId !== record.runId) {
    throw runPolicyError(
      `prepared run is not the latest durable run: ${record.runId}`,
      'PREPARED_RUN_SUPERSEDED',
    );
  }
  const storedCheckpoint = options.resume ? ProjectFS.checkpoint(id) : null;
  // A fresh run can be reserved before initialize-checkpoint replaces a stale
  // checkpoint from an older run. Only bind checkpoint inputs when the identity
  // matches this prepared run.
  const checkpoint = storedCheckpoint?.artifactRunId === record.runId
    ? storedCheckpoint
    : null;
  const requestedAsOf = options.asOf == null ? record.asOf : normalizeRunAsOf(options.asOf);
  if (requestedAsOf !== normalizeRunAsOf(record.asOf, 'prepared run asOf')) {
    throw runPolicyError(
      `prepared run asOf conflict: expected ${record.asOf}, got ${requestedAsOf}`,
      'PREPARED_RUN_INPUT_CONFLICT',
    );
  }
  const expectedDigest = runInputDigest(id, meta, options, checkpoint, record.asOf);
  if (expectedDigest !== record.inputDigest) {
    throw runPolicyError(
      `prepared run input conflict: ${record.runId}`,
      'PREPARED_RUN_INPUT_CONFLICT',
    );
  }
  return { runStore, record };
}

function updateProjectRunStatus(id, status) {
  ProjectFS.updateMeta(id, {
    status,
    lastError: null,
    frameworkVersion: FRAMEWORK_VERSION,
  });
}

export function reserveWorkflowRun(id, options = {}) {
  const opened = resolveWorkflowRun(id, options);
  updateProjectRunStatus(id, 'queued');
  return opened;
}

export function openWorkflowRun(id, options = {}) {
  const opened = options.preparedRunId
    ? openPreparedWorkflowRun(id, options)
    : resolveWorkflowRun(id, options);
  updateProjectRunStatus(id, 'analyzing');
  const { runStore, record } = opened;
  return { runStore, record };
}

export function retryPolicyForWorkflowNode(node) {
  const policies = (node.agentContractIds || [])
    .map((contractId) => getAgentDefinition(contractId).runPolicy.retry)
    .filter(Boolean);
  if (!policies.length) return { maxAttempts: 1, retryOn: [] };
  const declaredMaxAttempts = Math.min(...policies.map((policy) => policy.maxAttempts));
  const retryOn = policies.slice(1).reduce(
    (allowed, policy) => allowed.filter((reason) => policy.retryOn.includes(reason)),
    [...policies[0].retryOn],
  );
  const transientRetryBudget = retryOn.some((reason) => ['transient', 'provider-unavailable'].includes(reason))
    ? RUN_ANALYSIS_TRANSIENT_RETRY_COUNT + 1
    : 1;
  const maxAttempts = Math.max(declaredMaxAttempts, transientRetryBudget);
  return { maxAttempts, retryOn };
}

function retryBackoffSchedule(env = process.env) {
  const raw = String(env.RUN_ANALYSIS_TRANSIENT_RETRY_BACKOFF_MS || '').trim();
  if (!raw) return DEFAULT_TRANSIENT_RETRY_BACKOFF_MS;
  const values = raw.split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.min(value, 5 * 60_000));
  return values.length ? values : DEFAULT_TRANSIENT_RETRY_BACKOFF_MS;
}

export function workflowNodeRetryDelayMs(attempt, { env = process.env } = {}) {
  if (!Number.isInteger(attempt) || attempt <= 0) return 0;
  const schedule = retryBackoffSchedule(env);
  return schedule[Math.min(attempt - 1, schedule.length - 1)] || 0;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function workflowNodeInputDigest({ context, node, dependencyArtifactRefs, run }) {
  const remediation = remediationIdentityForNode(context.cp, node.id);
  return canonicalSha256({
    workflowSpecHash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    runInputDigest: run.inputDigest,
    runId: run.runId,
    nodeId: node.id,
    remediation,
    dependencyArtifactRefs: dependencyArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      version: ref.version,
      contentDigest: ref.contentDigest,
    })),
  });
}

export function workflowWorkspaceSnapshot({ context, node, dependencyArtifactRefs, run }) {
  return ProjectFS.workspace(context.id).createSnapshot({
    runId: run.runId,
    nodeId: node.id,
    asOf: run.asOf,
    artifactRefs: dependencyArtifactRefs,
  }).snapshotId;
}

export async function emitWorkflowNodeRetry({ context, node, attempt, classification, error }) {
  const delayMs = workflowNodeRetryDelayMs(attempt);
  const delayText = delayMs > 0 ? `，等待 ${Math.round(delayMs / 1000)}s` : '';
  emit(context.id, 'retry', {
    stage: 'system',
    nodeId: node.id,
    attempt,
    stopReason: classification.reason,
    delayMs,
    text: `节点「${node.id}」发生可重试故障${delayText}，准备第 ${attempt + 1} 次 attempt（${String(error?.message || error).slice(0, 80)}）。`,
  });
  await sleep(delayMs);
}
