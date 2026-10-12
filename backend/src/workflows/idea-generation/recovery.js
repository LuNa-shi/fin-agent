import { NODE_STATES } from '../../core/workflow/NodeState.js';
import { RUN_STATUSES } from '../../project-space/RunStore.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from './workflowSpec.js';

export const IDEA_RUN_NOT_RESUMABLE_CODE = 'IDEA_RUN_NOT_RESUMABLE';

const INVOCABLE_STATUSES = new Set([
  RUN_STATUSES.RUNNING,
  RUN_STATUSES.SUCCEEDED,
]);
const TERMINAL_STATUSES = new Set([
  RUN_STATUSES.FAILED,
  RUN_STATUSES.BLOCKED,
  RUN_STATUSES.CANCELLED,
]);

export class IdeaRunNotResumableError extends Error {
  constructor(record) {
    super(
      `Idea Generation run ${record.runId} is not resumable from ${record.status}`
      + (record.stopReason ? ` (${record.stopReason})` : ''),
    );
    this.name = 'IdeaRunNotResumableError';
    this.code = IDEA_RUN_NOT_RESUMABLE_CODE;
    this.statusCode = 409;
    this.runId = record.runId;
    this.runStatus = record.status;
    this.stopReason = record.stopReason || null;
  }
}

export function assertIdeaGenerationRunInvocable(record) {
  if (record === null || record === undefined) return null;
  if (INVOCABLE_STATUSES.has(record.status)) return record;
  if (TERMINAL_STATUSES.has(record.status)) {
    throw new IdeaRunNotResumableError(record);
  }
  const error = new Error(
    `Idea Generation run ${record.runId || '(unknown)'} has unsupported status: ${record.status}`,
  );
  error.code = 'IDEA_RUN_STATUS_INVALID';
  throw error;
}

export function exhaustedInterruptedIdeaGenerationNode({
  record,
  nodes,
  retryPolicyForNode,
} = {}) {
  if (record?.status !== RUN_STATUSES.RUNNING) return null;
  if (!Array.isArray(nodes) || typeof retryPolicyForNode !== 'function') {
    throw new TypeError('Idea Generation recovery node policy is required');
  }
  const running = Object.values(record.nodes || {})
    .filter((node) => node.status === NODE_STATES.RUNNING);
  if (running.length > 1) {
    const error = new Error(
      `Idea Generation run ${record.runId} has multiple RUNNING nodes`,
    );
    error.code = 'IDEA_RUN_STATE_INVALID';
    throw error;
  }
  if (running.length === 0) return null;
  const nodeRecord = running[0];
  const node = nodes.find((candidate) => candidate.id === nodeRecord.nodeId);
  if (!node) {
    const error = new Error(
      `Idea Generation run ${record.runId} has an unknown RUNNING node: ${nodeRecord.nodeId}`,
    );
    error.code = 'IDEA_RUN_STATE_INVALID';
    throw error;
  }
  const policy = retryPolicyForNode(node);
  const maxAttempts = Number.isInteger(policy?.maxAttempts)
    ? policy.maxAttempts
    : 1;
  return nodeRecord.attempt >= maxAttempts
    ? { node, nodeRecord, maxAttempts }
    : null;
}

function assertRecoveryStorage(storage) {
  if (
    !storage
    || typeof storage.list !== 'function'
    || typeof storage.listSnapshots !== 'function'
  ) {
    throw new TypeError(
      'Idea Generation recovery storage must expose list() and listSnapshots()',
    );
  }
  return storage;
}

function isCurrentIdeaGenerationSnapshot(snapshot) {
  return (
    snapshot?.workflow?.id === IDEA_GENERATION_WORKFLOW_SPEC.id
    && snapshot.workflow.version === IDEA_GENERATION_WORKFLOW_SPEC.version
    && snapshot.workflow.hash === IDEA_GENERATION_WORKFLOW_SPEC_HASH
  );
}

export function ideaGenerationRecoveryCandidates(storage) {
  const candidateStorage = assertRecoveryStorage(storage);
  const records = new Map(
    candidateStorage.list().map((record) => [record.runId, record]),
  );
  return candidateStorage.listSnapshots()
    .flatMap((snapshot) => {
      if (!isCurrentIdeaGenerationSnapshot(snapshot)) return [];
      const record = records.get(snapshot.runId) || null;
      if (record && record.status !== RUN_STATUSES.RUNNING) return [];
      return [{
        runId: snapshot.runId,
        snapshotId: snapshot.snapshotId,
        asOf: snapshot.asOf,
        count: snapshot.inputs.command.count,
        state: record ? RUN_STATUSES.RUNNING : 'SNAPSHOT_ONLY',
      }];
    })
    .sort((left, right) => (
      Date.parse(left.asOf) - Date.parse(right.asOf)
      || left.runId.localeCompare(right.runId)
    ));
}

export async function recoverIdeaGenerationCandidates({
  storage,
  resume,
} = {}) {
  if (typeof resume !== 'function') {
    throw new TypeError('Idea Generation recovery resume callback is required');
  }
  const candidates = ideaGenerationRecoveryCandidates(storage);
  const outcomes = [];
  for (const candidate of candidates) {
    try {
      const result = await resume(candidate);
      outcomes.push({
        runId: candidate.runId,
        priorState: candidate.state,
        status: result?.status || RUN_STATUSES.SUCCEEDED,
        ok: true,
      });
    } catch (error) {
      outcomes.push({
        runId: candidate.runId,
        priorState: candidate.state,
        status: 'FAILED',
        ok: false,
        code: error?.code || 'IDEA_RUN_RECOVERY_FAILED',
      });
    }
  }
  return {
    candidateCount: candidates.length,
    recoveredCount: outcomes.filter((outcome) => outcome.ok).length,
    failedCount: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}
