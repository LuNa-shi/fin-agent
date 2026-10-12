import fs from 'node:fs';
import path from 'node:path';

import { PROJECTS_DIR } from '../config.js';
import { createEventEnvelope } from '../core/contracts/agentContracts.js';
import {
  canonicalSha256,
  canonicalStringify,
  createArtifactRef,
  deepFreeze,
  validateArtifactRef,
} from '../core/contracts/ArtifactRef.js';
import { isSafeModelId } from '../core/models/modelMetadata.js';
import { NODE_STATES } from '../core/workflow/NodeState.js';
import { atomicCreateFileSync, withFileLockSync } from '../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
  resolveDirectStorageDirectory,
} from '../lib/storageBoundary.js';

export const DURABLE_EVENT_SCHEMA_VERSION = '1.0.0';
export const EVENT_REPLAY_SCHEMA_VERSION = 'event-replay.v1';
export const EVENT_BUS_SCOPE = 'cross-process-single-writer';

export const DURABLE_EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'workflow.run.started',
  RUN_RESUMED: 'workflow.run.resumed',
  RUN_REMEDIATION_STARTED: 'workflow.run.remediation-started',
  RUN_SUCCEEDED: 'workflow.run.succeeded',
  RUN_FAILED: 'workflow.run.failed',
  RUN_BLOCKED: 'workflow.run.blocked',
  RUN_CANCELLED: 'workflow.run.cancelled',
  NODE_READY: 'workflow.node.ready',
  NODE_STARTED: 'workflow.node.started',
  NODE_SUCCEEDED: 'workflow.node.succeeded',
  NODE_FAILED: 'workflow.node.failed',
  NODE_INVALIDATED: 'workflow.node.invalidated',
  NODE_HUMAN_REVIEW_INVALIDATED: 'workflow.node.human-review-invalidated',
  ARTIFACT_COMMITTED: 'artifact.committed',
  HUMAN_REVIEW_TASK_CREATED: 'human-review.task.created',
  HUMAN_REVIEW_DECISION_RECORDED: 'human-review.decision.recorded',
  HUMAN_REVIEW_RESUME_STARTED: 'human-review.resume.started',
  HUMAN_REVIEW_TASK_TERMINATED: 'human-review.task.terminated',
  HUMAN_REVIEW_TASK_RESOLVED: 'human-review.task.resolved',
  AGENT_EXECUTION_STARTED: 'agent.execution.started',
  AGENT_EXECUTION_ACTIVITY: 'agent.execution.activity',
  AGENT_EXECUTION_COMPLETED: 'agent.execution.completed',
});

const EVENT_TYPE_SET = new Set(Object.values(DURABLE_EVENT_TYPES));
export const AGENT_EXECUTION_EVENT_TYPES = Object.freeze([
  DURABLE_EVENT_TYPES.AGENT_EXECUTION_STARTED,
  DURABLE_EVENT_TYPES.AGENT_EXECUTION_ACTIVITY,
  DURABLE_EVENT_TYPES.AGENT_EXECUTION_COMPLETED,
]);
const AGENT_EXECUTION_EVENT_TYPE_SET = new Set(AGENT_EXECUTION_EVENT_TYPES);
const RUN_STATUS_SET = new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const NODE_STATUS_SET = new Set(Object.values(NODE_STATES));
const AGENT_EXECUTION_STATUS_SET = new Set(['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']);
const AGENT_PROVIDER_SET = new Set(['deepseek', 'demo', 'gpt-gateway', 'openai-compatible']);
const AGENT_STOP_REASON_SET = new Set([
  'aborted',
  'cancelled',
  'completed',
  'cost-budget',
  'deadline',
  'error',
  'fatal',
  'final',
  'human-review',
  'length',
  'maxTurns',
  'model-length',
  'process-interrupted',
  'provider-unavailable',
  'runtime-budget',
  'schema-invalid',
  'stop',
  'token-budget',
  'tool-budget',
  'toolUse',
  'unknown',
]);
const AGENT_BUDGET_DIMENSION_SET = new Set([
  'cost-budget',
  'deadline',
  'maxTurns',
  'runtime-budget',
  'token-budget',
  'tool-budget',
  'turns',
  'wall-clock',
]);
const AGENT_ACTIVITY_TYPE_SET = new Set([
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.permission.denied',
  'agent.turn.completed',
  'agent.stopped',
  'budget.warning',
  'budget.exhausted',
]);
const AGENT_METRIC_FIELDS = new Set([
  'turns',
  'toolCalls',
  'toolAttempts',
  'toolDenied',
  'tokens',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'wallMs',
  'deadlineMs',
  'finalizeReserveMs',
  'toolCallSafetyLimit',
  'costKnown',
]);
const RUN_SCOPE_KIND_SET = new Set(['project', 'idea-universe', 'worldview-universe']);
const WORKSPACE_MODE_SET = new Set(['project', 'idea-run', 'none']);
const EVENT_FILE_RE = /^(\d{12})\.json$/u;

function fail(message, code = 'EVENT_BUS_ERROR') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertSafeIdentity(value, field) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    fail(`${field} is unsafe: ${value}`, 'UNSAFE_EVENT_IDENTITY');
  }
}

function assertRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`, 'INVALID_EVENT');
}

function assertNullableString(value, field) {
  if (value !== null && (typeof value !== 'string' || !value.trim())) {
    fail(`${field} must be a string or null`, 'INVALID_EVENT');
  }
}

function assertDigest(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail(`${field} must be a sha256 digest`, 'INVALID_EVENT_PAYLOAD');
  }
}

function assertInteger(value, field, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${field} must be an integer >= ${minimum}`, 'INVALID_EVENT_PAYLOAD');
  }
}

function assertPayloadObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('event payload must be an object', 'INVALID_EVENT_PAYLOAD');
  }
}

function requirePayloadFields(payload, fields, eventType) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === undefined) {
      fail(`${eventType} payload requires ${field}`, 'INVALID_EVENT_PAYLOAD');
    }
  }
}

function requireExactPayloadFields(payload, required, optional, eventType) {
  requirePayloadFields(payload, required, eventType);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(payload).filter((field) => !allowed.has(field));
  if (unknown.length) {
    fail(`${eventType} payload contains unsupported fields: ${unknown.join(', ')}`, 'INVALID_EVENT_PAYLOAD');
  }
}

function assertAgentExecutionIdentity(payload) {
  assertSafeIdentity(payload.agentRunId, 'agentRunId');
  if (!payload.agentRunId.startsWith('agent_run_') || payload.agentRunId.length > 96) {
    fail('agentRunId must be an opaque agent_run_ identity', 'INVALID_EVENT_PAYLOAD');
  }
  assertSafeIdentity(payload.agentId, 'agentId');
  if (payload.agentId.length > 128) {
    fail('agentId is too long', 'INVALID_EVENT_PAYLOAD');
  }
  if (
    typeof payload.contractVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(payload.contractVersion)
  ) {
    fail('contractVersion must be semantic version metadata', 'INVALID_EVENT_PAYLOAD');
  }
  assertInteger(payload.workflowAttempt, 'workflowAttempt', { minimum: 1 });
  assertInteger(payload.agentEventSequence, 'agentEventSequence');
  if (!AGENT_EXECUTION_STATUS_SET.has(payload.status)) {
    fail('Agent execution status is invalid', 'INVALID_EVENT_PAYLOAD');
  }
}

function assertSafeAgentReason(value, field, allowed = AGENT_STOP_REASON_SET) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail(`${field} is not safe lifecycle metadata`, 'INVALID_EVENT_PAYLOAD');
  }
}

function validateAgentMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    fail('Agent execution metrics must be an object', 'INVALID_EVENT_PAYLOAD');
  }
  for (const [field, value] of Object.entries(metrics)) {
    if (!AGENT_METRIC_FIELDS.has(field)) {
      fail(`Agent execution metrics contains unsupported field: ${field}`, 'INVALID_EVENT_PAYLOAD');
    }
    if (field === 'costKnown') {
      if (typeof value !== 'boolean') fail('costKnown must be boolean', 'INVALID_EVENT_PAYLOAD');
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`${field} must be a non-negative finite number`, 'INVALID_EVENT_PAYLOAD');
    }
  }
}

function expectedAgentActivitySummary(payload) {
  if (payload.activityType.startsWith('tool.')) {
    const verb = payload.activityType === 'tool.started'
      ? 'selected'
      : payload.activityType === 'tool.completed' ? 'completed' : 'failed';
    return `Tool ${payload.tool.name} ${verb}.`;
  }
  if (payload.activityType === 'agent.turn.completed') {
    return payload.stopReason
      ? `Agent turn completed with stop reason ${payload.stopReason}.`
      : 'Agent turn completed.';
  }
  if (payload.activityType === 'agent.stopped') {
    return `Agent stopped with reason ${payload.stopReason}.`;
  }
  if (payload.activityType === 'budget.warning') {
    return `Agent runtime budget warning for ${payload.stopReason}.`;
  }
  return `Agent runtime budget exhausted for ${payload.stopReason}.`;
}

function expectedAgentCompletionSummary(payload) {
  if (payload.status === 'SUCCEEDED') return 'Agent execution completed successfully.';
  if (payload.status === 'PARTIAL') {
    return `Agent execution completed partially with stop reason ${payload.stopReason}.`;
  }
  return `Agent execution failed with stop reason ${payload.stopReason}.`;
}

function validateAgentExecutionPayload(eventType, payload) {
  const base = [
    'agentRunId',
    'agentId',
    'contractVersion',
    'workflowAttempt',
    'agentEventSequence',
    'status',
    'activitySummary',
  ];
  if (eventType === DURABLE_EVENT_TYPES.AGENT_EXECUTION_STARTED) {
    requireExactPayloadFields(payload, base, [], eventType);
    assertAgentExecutionIdentity(payload);
    if (payload.status !== 'RUNNING' || payload.activitySummary !== 'Agent execution started.') {
      fail(`${eventType} lifecycle metadata is invalid`, 'INVALID_EVENT_PAYLOAD');
    }
    return;
  }
  if (eventType === DURABLE_EVENT_TYPES.AGENT_EXECUTION_ACTIVITY) {
    requireExactPayloadFields(
      payload,
      [...base, 'activityType'],
      ['tool', 'stopReason'],
      eventType,
    );
    assertAgentExecutionIdentity(payload);
    if (payload.status !== 'RUNNING' || !AGENT_ACTIVITY_TYPE_SET.has(payload.activityType)) {
      fail(`${eventType} lifecycle metadata is invalid`, 'INVALID_EVENT_PAYLOAD');
    }
    if (payload.activityType.startsWith('tool.')) {
      if (!payload.tool || typeof payload.tool !== 'object' || Array.isArray(payload.tool)) {
        fail(`${eventType} tool metadata is required`, 'INVALID_EVENT_PAYLOAD');
      }
      requireExactPayloadFields(
        payload.tool,
        ['name', 'status', 'sequence'],
        ['durationMs'],
        `${eventType}.tool`,
      );
      assertSafeIdentity(payload.tool.name, 'tool.name');
      if (payload.tool.name.length > 128) {
        fail('tool.name is too long', 'INVALID_EVENT_PAYLOAD');
      }
      if (!['RUNNING', 'SUCCEEDED', 'FAILED'].includes(payload.tool.status)) {
        fail('tool.status is invalid', 'INVALID_EVENT_PAYLOAD');
      }
      assertInteger(payload.tool.sequence, 'tool.sequence');
      if (payload.tool.durationMs !== undefined) {
        assertInteger(payload.tool.durationMs, 'tool.durationMs');
      }
      if (payload.stopReason !== undefined) {
        fail('tool activity must not contain stopReason', 'INVALID_EVENT_PAYLOAD');
      }
    } else {
      if (payload.tool !== undefined) {
        fail('non-tool activity must not contain tool metadata', 'INVALID_EVENT_PAYLOAD');
      }
      if (payload.stopReason !== undefined) {
        assertSafeAgentReason(
          payload.stopReason,
          'stopReason',
          payload.activityType.startsWith('budget.')
            ? AGENT_BUDGET_DIMENSION_SET
            : AGENT_STOP_REASON_SET,
        );
      }
      if (
        ['agent.stopped', 'budget.warning', 'budget.exhausted'].includes(payload.activityType)
        && payload.stopReason === undefined
      ) {
        fail(`${payload.activityType} requires stopReason`, 'INVALID_EVENT_PAYLOAD');
      }
    }
    if (payload.activitySummary !== expectedAgentActivitySummary(payload)) {
      fail(`${eventType} activitySummary is not derived lifecycle metadata`, 'INVALID_EVENT_PAYLOAD');
    }
    return;
  }
  requireExactPayloadFields(
    payload,
    [...base, 'stopReason', 'provenance', 'metrics'],
    ['provider', 'model'],
    eventType,
  );
  assertAgentExecutionIdentity(payload);
  if (payload.status === 'RUNNING' || payload.provenance !== 'physical') {
    fail(`${eventType} completion metadata is invalid`, 'INVALID_EVENT_PAYLOAD');
  }
  assertSafeAgentReason(payload.stopReason, 'stopReason');
  validateAgentMetrics(payload.metrics);
  if (payload.provider !== undefined) {
    assertSafeIdentity(payload.provider, 'provider');
    if (payload.provider.length > 128) {
      fail('provider is too long', 'INVALID_EVENT_PAYLOAD');
    }
  }
  if (payload.model !== undefined && !isSafeModelId(payload.model)) {
    fail('model is unsafe', 'INVALID_EVENT_PAYLOAD');
  }
  if (payload.provider !== undefined && !AGENT_PROVIDER_SET.has(payload.provider)) {
    fail('provider is not approved public route metadata', 'INVALID_EVENT_PAYLOAD');
  }
  if (payload.model !== undefined && payload.provider === undefined) {
    fail('model is not approved public route metadata', 'INVALID_EVENT_PAYLOAD');
  }
  if (payload.activitySummary !== expectedAgentCompletionSummary(payload)) {
    fail(`${eventType} activitySummary is not derived lifecycle metadata`, 'INVALID_EVENT_PAYLOAD');
  }
}

function validateArtifactRefs(refs, field) {
  if (!Array.isArray(refs) || refs.some((ref) => !validateArtifactRef(ref).valid)) {
    fail(`${field} must contain valid ArtifactRefs`, 'INVALID_EVENT_PAYLOAD');
  }
}

function validateOptionalRunScope(payload, eventType, projectId) {
  const fields = ['scope', 'workspaceMode', 'workspaceSnapshotId'];
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  if (!present.length) return;
  requirePayloadFields(payload, fields, eventType);
  if (!payload.scope || typeof payload.scope !== 'object' || Array.isArray(payload.scope)) {
    fail(`${eventType} scope is invalid`, 'INVALID_EVENT_PAYLOAD');
  }
  const scopeFields = Object.keys(payload.scope).sort();
  if (scopeFields.length !== 2 || scopeFields[0] !== 'id' || scopeFields[1] !== 'kind') {
    fail(`${eventType} scope must contain exactly kind and id`, 'INVALID_EVENT_PAYLOAD');
  }
  assertRequiredString(payload.scope.kind, 'scope.kind');
  assertRequiredString(payload.scope.id, 'scope.id');
  if (projectId !== null && payload.scope.id !== projectId) {
    fail(`${eventType} scope.id must match projectId`, 'INVALID_EVENT_PAYLOAD');
  }
  if (!RUN_SCOPE_KIND_SET.has(payload.scope.kind)) {
    fail(`${eventType} scope.kind is invalid`, 'INVALID_EVENT_PAYLOAD');
  }
  if (!WORKSPACE_MODE_SET.has(payload.workspaceMode)) {
    fail(`${eventType} workspaceMode is invalid`, 'INVALID_EVENT_PAYLOAD');
  }
  if (
    (payload.scope.kind === 'project' && payload.workspaceMode !== 'project')
    || (payload.scope.kind === 'idea-universe' && payload.workspaceMode !== 'idea-run')
    || (payload.scope.kind === 'worldview-universe' && payload.workspaceMode !== 'none')
  ) {
    fail(`${eventType} workspaceMode is invalid for ${payload.scope.kind}`, 'INVALID_EVENT_PAYLOAD');
  }
  assertRequiredString(payload.workspaceSnapshotId, 'workspaceSnapshotId');
}

function validateTypedPayload(eventType, payload, projectId = null) {
  assertPayloadObject(payload);
  if (AGENT_EXECUTION_EVENT_TYPE_SET.has(eventType)) {
    validateAgentExecutionPayload(eventType, payload);
    return;
  }
  switch (eventType) {
    case DURABLE_EVENT_TYPES.RUN_STARTED:
      requirePayloadFields(payload, ['status', 'workflowSpec', 'inputDigest', 'asOf'], eventType);
      if (payload.status !== 'RUNNING') fail(`${eventType} status must be RUNNING`, 'INVALID_EVENT_PAYLOAD');
      if (!payload.workflowSpec || typeof payload.workflowSpec !== 'object' || Array.isArray(payload.workflowSpec)) {
        fail(`${eventType} workflowSpec is invalid`, 'INVALID_EVENT_PAYLOAD');
      }
      for (const field of ['id', 'version', 'hash']) assertRequiredString(payload.workflowSpec[field], `workflowSpec.${field}`);
      assertDigest(payload.inputDigest, 'inputDigest');
      if (!Number.isFinite(Date.parse(payload.asOf))) fail(`${eventType} asOf is invalid`, 'INVALID_EVENT_PAYLOAD');
      validateOptionalRunScope(payload, eventType, projectId);
      break;
    case DURABLE_EVENT_TYPES.RUN_RESUMED:
      requirePayloadFields(payload, ['status', 'reason', 'resumeCount'], eventType);
      if (payload.status !== 'RUNNING') fail(`${eventType} status must be RUNNING`, 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.reason, 'reason');
      assertInteger(payload.resumeCount, 'resumeCount', { minimum: 1 });
      break;
    case DURABLE_EVENT_TYPES.RUN_REMEDIATION_STARTED:
      requirePayloadFields(payload, ['status', 'cycle', 'owners', 'nodeIds', 'openIssues'], eventType);
      if (payload.status !== 'RUNNING') fail(`${eventType} status must be RUNNING`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.cycle, 'cycle', { minimum: 1 });
      if (!Array.isArray(payload.owners) || payload.owners.some((owner) => typeof owner !== 'string' || !owner)) {
        fail('owners must be a non-empty string array', 'INVALID_EVENT_PAYLOAD');
      }
      if (!Array.isArray(payload.nodeIds) || payload.nodeIds.some((nodeId) => typeof nodeId !== 'string' || !nodeId)) {
        fail('nodeIds must be a string array', 'INVALID_EVENT_PAYLOAD');
      }
      if (!Array.isArray(payload.openIssues)) fail('openIssues must be an array', 'INVALID_EVENT_PAYLOAD');
      break;
    case DURABLE_EVENT_TYPES.RUN_SUCCEEDED:
    case DURABLE_EVENT_TYPES.RUN_FAILED:
    case DURABLE_EVENT_TYPES.RUN_BLOCKED:
    case DURABLE_EVENT_TYPES.RUN_CANCELLED:
      requirePayloadFields(payload, ['status', 'stopReason'], eventType);
      if (!RUN_STATUS_SET.has(payload.status)) fail(`${eventType} status is invalid`, 'INVALID_EVENT_PAYLOAD');
      assertNullableString(payload.stopReason, 'stopReason');
      if (eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED && !Array.isArray(payload.openIssues)) {
        fail('openIssues must be an array', 'INVALID_EVENT_PAYLOAD');
      }
      if (eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED && payload.reviewBlockCount !== undefined) {
        assertInteger(payload.reviewBlockCount, 'reviewBlockCount', { minimum: 1 });
      }
      if (eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED && payload.blockedStateDigest !== undefined) {
        assertDigest(payload.blockedStateDigest, 'blockedStateDigest');
      }
      break;
    case DURABLE_EVENT_TYPES.NODE_READY:
      requirePayloadFields(payload, ['status', 'attempt', 'nextAttempt'], eventType);
      if (payload.status !== NODE_STATES.READY) fail(`${eventType} status must be READY`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt');
      assertInteger(payload.nextAttempt, 'nextAttempt', { minimum: 1 });
      break;
    case DURABLE_EVENT_TYPES.NODE_STARTED:
      requirePayloadFields(payload, ['status', 'attempt', 'inputDigest'], eventType);
      if (payload.status !== NODE_STATES.RUNNING) fail(`${eventType} status must be RUNNING`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt', { minimum: 1 });
      assertDigest(payload.inputDigest, 'inputDigest');
      break;
    case DURABLE_EVENT_TYPES.NODE_SUCCEEDED:
      requirePayloadFields(payload, [
        'status', 'attempt', 'outputDigest', 'artifactRefs', 'stopReason', 'imported',
      ], eventType);
      if (payload.status !== NODE_STATES.SUCCEEDED) fail(`${eventType} status must be SUCCEEDED`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt', { minimum: 1 });
      assertDigest(payload.outputDigest, 'outputDigest');
      validateArtifactRefs(payload.artifactRefs, 'artifactRefs');
      assertNullableString(payload.stopReason, 'stopReason');
      if (typeof payload.imported !== 'boolean') fail('imported must be boolean', 'INVALID_EVENT_PAYLOAD');
      break;
    case DURABLE_EVENT_TYPES.NODE_FAILED:
      requirePayloadFields(payload, ['status', 'attempt', 'stopReason', 'failure'], eventType);
      if (!NODE_STATUS_SET.has(payload.status) || ![
        NODE_STATES.FAILED_TRANSIENT,
        NODE_STATES.FAILED_SCHEMA,
        NODE_STATES.FAILED_PERMISSION,
        NODE_STATES.FAILED_BUSINESS,
        NODE_STATES.BLOCKED,
        NODE_STATES.CANCELLED,
      ].includes(payload.status)) fail(`${eventType} status is invalid`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt');
      assertNullableString(payload.stopReason, 'stopReason');
      if (payload.failure !== null && (typeof payload.failure !== 'object' || Array.isArray(payload.failure))) {
        fail('failure must be an object or null', 'INVALID_EVENT_PAYLOAD');
      }
      break;
    case DURABLE_EVENT_TYPES.NODE_INVALIDATED:
      requirePayloadFields(payload, ['status', 'attempt', 'reason', 'cycle', 'owners', 'openIssueIds'], eventType);
      if (payload.status !== NODE_STATES.PENDING) fail(`${eventType} status must be PENDING`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt');
      assertRequiredString(payload.reason, 'reason');
      assertInteger(payload.cycle, 'cycle', { minimum: 1 });
      if (!Array.isArray(payload.owners) || payload.owners.some((owner) => typeof owner !== 'string' || !owner)) {
        fail('owners must be a non-empty string array', 'INVALID_EVENT_PAYLOAD');
      }
      if (!Array.isArray(payload.openIssueIds) || payload.openIssueIds.some((id) => typeof id !== 'string' || !id)) {
        fail('openIssueIds must be a string array', 'INVALID_EVENT_PAYLOAD');
      }
      break;
    case DURABLE_EVENT_TYPES.NODE_HUMAN_REVIEW_INVALIDATED:
      requirePayloadFields(payload, [
        'status',
        'attempt',
        'reason',
        'humanReviewAttempt',
        'taskId',
        'decisionId',
        'mode',
        'owners',
        'openIssueIds',
      ], eventType);
      if (payload.status !== NODE_STATES.PENDING) fail(`${eventType} status must be PENDING`, 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.attempt, 'attempt');
      assertRequiredString(payload.reason, 'reason');
      assertInteger(payload.humanReviewAttempt, 'humanReviewAttempt', { minimum: 1 });
      assertRequiredString(payload.taskId, 'taskId');
      assertRequiredString(payload.decisionId, 'decisionId');
      if (!['rerun', 'reopen'].includes(payload.mode)) fail('mode must be rerun or reopen', 'INVALID_EVENT_PAYLOAD');
      if (!Array.isArray(payload.owners) || payload.owners.some((owner) => typeof owner !== 'string' || !owner)) {
        fail('owners must be a string array', 'INVALID_EVENT_PAYLOAD');
      }
      if (!Array.isArray(payload.openIssueIds) || payload.openIssueIds.some((id) => typeof id !== 'string' || !id)) {
        fail('openIssueIds must be a string array', 'INVALID_EVENT_PAYLOAD');
      }
      break;
    case DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED:
      requirePayloadFields(payload, ['artifactRef', 'inputArtifactRefs', 'idempotencyKey', 'inputDigest'], eventType);
      if (!validateArtifactRef(payload.artifactRef).valid) fail('artifactRef is invalid', 'INVALID_EVENT_PAYLOAD');
      validateArtifactRefs(payload.inputArtifactRefs, 'inputArtifactRefs');
      assertRequiredString(payload.idempotencyKey, 'idempotencyKey');
      assertDigest(payload.inputDigest, 'inputDigest');
      break;
    case DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_CREATED:
      requirePayloadFields(payload, [
        'status',
        'taskId',
        'taskVersion',
        'taskRef',
        'issuesDigest',
        'blockedStateDigest',
        'reviewBlockCount',
        'policyDigest',
      ], eventType);
      if (payload.status !== 'open') fail(`${eventType} status must be open`, 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.taskId, 'taskId');
      assertInteger(payload.taskVersion, 'taskVersion', { minimum: 1 });
      if (!validateArtifactRef(payload.taskRef).valid) fail('taskRef is invalid', 'INVALID_EVENT_PAYLOAD');
      assertDigest(payload.issuesDigest, 'issuesDigest');
      assertDigest(payload.blockedStateDigest, 'blockedStateDigest');
      assertInteger(payload.reviewBlockCount, 'reviewBlockCount', { minimum: 1 });
      assertDigest(payload.policyDigest, 'policyDigest');
      break;
    case DURABLE_EVENT_TYPES.HUMAN_REVIEW_DECISION_RECORDED:
      requirePayloadFields(payload, [
        'status',
        'taskId',
        'taskVersion',
        'decisionId',
        'decisionRef',
        'requestDigest',
        'decisionDigest',
        'reviewerId',
        'selectedAction',
        'policyAllowed',
      ], eventType);
      if (payload.status !== 'decided') fail(`${eventType} status must be decided`, 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.taskId, 'taskId');
      assertInteger(payload.taskVersion, 'taskVersion', { minimum: 1 });
      assertRequiredString(payload.decisionId, 'decisionId');
      if (!validateArtifactRef(payload.decisionRef).valid) fail('decisionRef is invalid', 'INVALID_EVENT_PAYLOAD');
      assertDigest(payload.requestDigest, 'requestDigest');
      assertDigest(payload.decisionDigest, 'decisionDigest');
      assertRequiredString(payload.reviewerId, 'reviewerId');
      assertRequiredString(payload.selectedAction, 'selectedAction');
      if (typeof payload.policyAllowed !== 'boolean') fail('policyAllowed must be boolean', 'INVALID_EVENT_PAYLOAD');
      break;
    case DURABLE_EVENT_TYPES.HUMAN_REVIEW_RESUME_STARTED:
      requirePayloadFields(payload, [
        'status',
        'taskId',
        'decisionId',
        'decisionRef',
        'humanReviewAttempt',
        'reviewRound',
        'owners',
        'rerunNodeIds',
        'reopenNodeIds',
      ], eventType);
      if (payload.status !== 'resuming') fail(`${eventType} status must be resuming`, 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.taskId, 'taskId');
      assertRequiredString(payload.decisionId, 'decisionId');
      if (!validateArtifactRef(payload.decisionRef).valid) fail('decisionRef is invalid', 'INVALID_EVENT_PAYLOAD');
      assertInteger(payload.humanReviewAttempt, 'humanReviewAttempt', { minimum: 1 });
      assertInteger(payload.reviewRound, 'reviewRound', { minimum: 1 });
      for (const field of ['owners', 'rerunNodeIds', 'reopenNodeIds']) {
        if (!Array.isArray(payload[field]) || payload[field].some((value) => typeof value !== 'string' || !value)) {
          fail(`${field} must be a string array`, 'INVALID_EVENT_PAYLOAD');
        }
      }
      break;
    case DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_TERMINATED:
    case DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_RESOLVED:
      requirePayloadFields(payload, [
        'status',
        'taskId',
        'decisionId',
        'decisionRef',
        'resultingRunStatus',
      ], eventType);
      if (
        eventType === DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_TERMINATED
        && payload.status !== 'terminated'
      ) fail(`${eventType} status must be terminated`, 'INVALID_EVENT_PAYLOAD');
      if (
        eventType === DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_RESOLVED
        && !['resolved', 'resume-failed', 'superseded'].includes(payload.status)
      ) fail(`${eventType} status is invalid`, 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.taskId, 'taskId');
      assertRequiredString(payload.decisionId, 'decisionId');
      if (!validateArtifactRef(payload.decisionRef).valid) fail('decisionRef is invalid', 'INVALID_EVENT_PAYLOAD');
      assertRequiredString(payload.resultingRunStatus, 'resultingRunStatus');
      break;
    default:
      fail(`unsupported durable event type: ${eventType}`, 'UNKNOWN_EVENT_TYPE');
  }
}

function stableEventValue(event) {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    correlationId: event.correlationId,
    causationId: event.causationId,
    projectId: event.projectId,
    runId: event.runId,
    nodeId: event.nodeId,
    payload: event.payload,
  };
}

function emptyRunProjection(projectId, runId) {
  return {
    projectId,
    runId,
    status: null,
    stopReason: null,
    workflowSpec: null,
    inputDigest: null,
    asOf: null,
    remediationCycle: 0,
    openIssues: [],
    nodes: {},
    artifactLineage: [],
    humanReviews: {
      tasks: {},
      decisions: {},
      resumes: [],
    },
    lifecycle: [],
  };
}

function emptyNodeProjection(nodeId) {
  return {
    nodeId,
    status: NODE_STATES.PENDING,
    attempt: 0,
    inputDigest: null,
    outputDigest: null,
    stopReason: null,
    artifactRefs: [],
    lastFailure: null,
    imported: false,
    lifecycle: [],
  };
}

export function durableEventId(eventType, identity) {
  if (!EVENT_TYPE_SET.has(eventType)) fail(`unsupported durable event type: ${eventType}`, 'UNKNOWN_EVENT_TYPE');
  return `evt_${canonicalSha256({ eventType, identity }).slice('sha256:'.length)}`;
}

export function isAgentExecutionEventType(eventType) {
  return AGENT_EXECUTION_EVENT_TYPE_SET.has(eventType);
}

export class FileEventBus {
  static scope = EVENT_BUS_SCOPE;

  constructor({
    projectId,
    projectsDir = PROJECTS_DIR,
    storageDir = null,
    now = () => new Date().toISOString(),
  } = {}) {
    assertSafeIdentity(projectId, 'projectId');
    if (typeof now !== 'function') throw new TypeError('EventBus now must be a function');
    this.projectId = projectId;
    this.projectsDir = path.resolve(projectsDir);
    this.directStorageDir = storageDir !== null;
    this.storageDir = this.directStorageDir
      ? resolveDirectStorageDirectory(storageDir, 'EventBus storageDir')
      : path.join(this.projectsDir, projectId);
    this.projectDir = this.storageDir;
    this.rootDir = path.join(this.storageDir, '.events');
    this.outboxDir = path.join(this.rootDir, 'outbox');
    this.outboxLockPath = path.join(this.rootDir, '.locks', 'outbox.lock');
    this.now = now;
  }

  publish(input) {
    return this.publishMany([input])[0];
  }

  publishMany(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      if (Array.isArray(inputs)) return [];
      fail('events must be an array', 'INVALID_EVENT');
    }
    this.#ensureStorageTree({ createOutbox: true });
    return withFileLockSync(this.outboxLockPath, () => {
      const events = this.#loadEvents();
      const byId = new Map(events.map((event) => [event.eventId, event]));
      const published = [];
      let sequence = events.length;

      for (const input of inputs) {
        assertRequiredString(input?.eventId, 'eventId');
        assertRequiredString(input?.eventType, 'eventType');
        assertRequiredString(input?.correlationId, 'correlationId');
        assertRequiredString(input?.runId, 'runId');
        if (!Object.prototype.hasOwnProperty.call(input, 'causationId')) {
          fail('causationId is required', 'INVALID_EVENT');
        }
        if (!Object.prototype.hasOwnProperty.call(input, 'nodeId')) fail('nodeId is required', 'INVALID_EVENT');
        assertNullableString(input.causationId, 'causationId');
        assertNullableString(input.nodeId, 'nodeId');
        if (!EVENT_TYPE_SET.has(input.eventType)) fail(`unsupported durable event type: ${input.eventType}`, 'UNKNOWN_EVENT_TYPE');
        validateTypedPayload(input.eventType, input.payload, this.projectId);

        const candidate = {
          eventId: input.eventId,
          eventType: input.eventType,
          schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
          correlationId: input.correlationId,
          causationId: input.causationId,
          projectId: this.projectId,
          runId: input.runId,
          nodeId: input.nodeId,
          payload: input.payload,
        };
        const existing = byId.get(input.eventId);
        if (existing) {
          if (canonicalStringify(stableEventValue(existing)) !== canonicalStringify(candidate)) {
            fail(`event idempotency conflict: ${input.eventId}`, 'EVENT_IDEMPOTENCY_CONFLICT');
          }
          published.push(existing);
          continue;
        }
        if (input.causationId !== null && !byId.has(input.causationId)) {
          fail(`event causation is missing: ${input.causationId}`, 'EVENT_CAUSATION_MISSING');
        }

        const timestamp = input.timestamp === undefined ? this.now() : input.timestamp;
        const event = createEventEnvelope({
          ...candidate,
          timestamp: typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString(),
          sequence: ++sequence,
        });
        const file = path.join(this.outboxDir, `${String(sequence).padStart(12, '0')}.json`);
        try {
          atomicCreateFileSync(file, `${canonicalStringify(event)}\n`);
        } catch (error) {
          if (error?.code === 'EEXIST') fail(`event sequence already exists: ${sequence}`, 'EVENT_SEQUENCE_CONFLICT');
          throw error;
        }
        byId.set(event.eventId, event);
        events.push(event);
        published.push(event);
      }
      return published;
    });
  }

  list({ runId = null } = {}) {
    if (runId !== null) assertSafeIdentity(runId, 'runId');
    const events = this.#readEvents();
    return deepFreeze(runId === null ? events : events.filter((event) => event.runId === runId));
  }

  get(eventId) {
    assertRequiredString(eventId, 'eventId');
    return this.#readEvents().find((event) => event.eventId === eventId) || null;
  }

  latest({ runId, nodeId = undefined, eventTypes = undefined } = {}) {
    assertSafeIdentity(runId, 'runId');
    if (nodeId !== undefined) assertNullableString(nodeId, 'nodeId');
    if (eventTypes !== undefined && (!Array.isArray(eventTypes) || eventTypes.some((type) => !EVENT_TYPE_SET.has(type)))) {
      fail('eventTypes contains an unsupported type', 'UNKNOWN_EVENT_TYPE');
    }
    const allowedTypes = eventTypes ? new Set(eventTypes) : null;
    return [...this.#readEvents()].reverse().find((event) => (
      event.runId === runId
      && (nodeId === undefined || event.nodeId === nodeId)
      && (!allowedTypes || allowedTypes.has(event.eventType))
    )) || null;
  }

  replay({ runId = null } = {}) {
    const events = this.list({ runId });
    const runs = {};
    const artifactLineage = [];

    for (const event of events) {
      // Agent execution events are deliberately observational. They are durable
      // audit data, but replay must never let them create or mutate run/node truth.
      if (isAgentExecutionEventType(event.eventType)) continue;
      const run = runs[event.runId] || emptyRunProjection(this.projectId, event.runId);
      runs[event.runId] = run;
      run.lifecycle.push({ eventId: event.eventId, eventType: event.eventType, sequence: event.sequence });

      if (event.eventType === DURABLE_EVENT_TYPES.RUN_STARTED) {
        run.status = event.payload.status;
        run.stopReason = null;
        run.workflowSpec = structuredClone(event.payload.workflowSpec);
        run.inputDigest = event.payload.inputDigest;
        run.asOf = event.payload.asOf;
        if (event.payload.scope) {
          run.scope = structuredClone(event.payload.scope);
          run.workspaceMode = event.payload.workspaceMode;
          run.workspaceSnapshotId = event.payload.workspaceSnapshotId;
        }
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.RUN_RESUMED) {
        run.status = event.payload.status;
        run.stopReason = null;
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.RUN_REMEDIATION_STARTED) {
        run.status = event.payload.status;
        run.stopReason = null;
        run.remediationCycle = event.payload.cycle;
        run.openIssues = structuredClone(event.payload.openIssues);
        continue;
      }
      if ([
        DURABLE_EVENT_TYPES.RUN_SUCCEEDED,
        DURABLE_EVENT_TYPES.RUN_FAILED,
        DURABLE_EVENT_TYPES.RUN_BLOCKED,
        DURABLE_EVENT_TYPES.RUN_CANCELLED,
      ].includes(event.eventType)) {
        run.status = event.payload.status;
        run.stopReason = event.payload.stopReason;
        if (event.eventType === DURABLE_EVENT_TYPES.RUN_SUCCEEDED) {
          run.openIssues = [];
        }
        if (event.eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED) {
          run.openIssues = structuredClone(event.payload.openIssues);
          if (Number.isInteger(event.payload.reviewBlockCount)) {
            run.reviewBlockCount = event.payload.reviewBlockCount;
          }
          if (typeof event.payload.blockedStateDigest === 'string') {
            run.blockedStateDigest = event.payload.blockedStateDigest;
          }
        }
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED) {
        const lineage = {
          eventId: event.eventId,
          sequence: event.sequence,
          projectId: event.projectId,
          runId: event.runId,
          nodeId: event.nodeId,
          ref: createArtifactRef(event.payload.artifactRef),
          inputArtifactRefs: event.payload.inputArtifactRefs.map((ref) => createArtifactRef(ref)),
        };
        artifactLineage.push(lineage);
        run.artifactLineage.push(lineage);
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_CREATED) {
        run.humanReviews.tasks[event.payload.taskId] = {
          taskId: event.payload.taskId,
          taskVersion: event.payload.taskVersion,
          status: event.payload.status,
          taskRef: createArtifactRef(event.payload.taskRef),
          issuesDigest: event.payload.issuesDigest,
          blockedStateDigest: event.payload.blockedStateDigest,
          reviewBlockCount: event.payload.reviewBlockCount,
          policyDigest: event.payload.policyDigest,
          eventId: event.eventId,
        };
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.HUMAN_REVIEW_DECISION_RECORDED) {
        run.humanReviews.decisions[event.payload.decisionId] = {
          decisionId: event.payload.decisionId,
          taskId: event.payload.taskId,
          taskVersion: event.payload.taskVersion,
          status: event.payload.status,
          decisionRef: createArtifactRef(event.payload.decisionRef),
          requestDigest: event.payload.requestDigest,
          decisionDigest: event.payload.decisionDigest,
          reviewerId: event.payload.reviewerId,
          selectedAction: event.payload.selectedAction,
          policyAllowed: event.payload.policyAllowed,
          eventId: event.eventId,
        };
        const task = run.humanReviews.tasks[event.payload.taskId];
        if (task) {
          task.status = event.payload.status;
          task.decisionId = event.payload.decisionId;
          task.decisionRef = createArtifactRef(event.payload.decisionRef);
        }
        continue;
      }
      if (event.eventType === DURABLE_EVENT_TYPES.HUMAN_REVIEW_RESUME_STARTED) {
        run.humanReviews.resumes.push({
          ...structuredClone(event.payload),
          decisionRef: createArtifactRef(event.payload.decisionRef),
          eventId: event.eventId,
        });
        const task = run.humanReviews.tasks[event.payload.taskId];
        if (task) task.status = event.payload.status;
        continue;
      }
      if ([
        DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_TERMINATED,
        DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_RESOLVED,
      ].includes(event.eventType)) {
        const task = run.humanReviews.tasks[event.payload.taskId];
        if (task) {
          task.status = event.payload.status;
          task.resultingRunStatus = event.payload.resultingRunStatus;
        }
        continue;
      }

      const node = run.nodes[event.nodeId] || emptyNodeProjection(event.nodeId);
      run.nodes[event.nodeId] = node;
      node.lifecycle.push({ eventId: event.eventId, eventType: event.eventType, sequence: event.sequence });
      node.status = event.payload.status;
      node.attempt = event.payload.attempt;
      if ([
        DURABLE_EVENT_TYPES.NODE_INVALIDATED,
        DURABLE_EVENT_TYPES.NODE_HUMAN_REVIEW_INVALIDATED,
      ].includes(event.eventType)) {
        node.inputDigest = null;
        node.outputDigest = null;
        node.stopReason = null;
        node.artifactRefs = [];
        node.lastFailure = null;
        node.imported = false;
      } else if (event.eventType === DURABLE_EVENT_TYPES.NODE_READY) {
        run.status = 'RUNNING';
        run.stopReason = null;
      } else if (event.eventType === DURABLE_EVENT_TYPES.NODE_STARTED) {
        node.inputDigest = event.payload.inputDigest;
      } else if (event.eventType === DURABLE_EVENT_TYPES.NODE_SUCCEEDED) {
        node.outputDigest = event.payload.outputDigest;
        node.artifactRefs = event.payload.artifactRefs.map((ref) => createArtifactRef(ref));
        node.stopReason = event.payload.stopReason;
        node.imported = event.payload.imported;
      } else if (event.eventType === DURABLE_EVENT_TYPES.NODE_FAILED) {
        node.stopReason = event.payload.stopReason;
        node.lastFailure = event.payload.failure === null ? null : structuredClone(event.payload.failure);
      }
    }

    return deepFreeze({
      schemaVersion: EVENT_REPLAY_SCHEMA_VERSION,
      projectId: this.projectId,
      events,
      runs,
      artifactLineage,
    });
  }

  #readEvents() {
    this.#ensureStorageTree({ createOutbox: false });
    return withFileLockSync(this.outboxLockPath, () => this.#loadEvents());
  }

  #ensureStorageTree({ createOutbox }) {
    if (this.directStorageDir) {
      resolveDirectStorageDirectory(this.storageDir, 'EventBus storageDir');
    } else {
      ensureOwnedStorageDirectory(this.storageDir, 'EventBus storage directory', {
        create: true,
        recursive: true,
      });
    }
    ensureOwnedStorageDirectory(this.rootDir, 'EventBus hidden root', { create: true });
    ensureOwnedStorageDirectory(path.dirname(this.outboxLockPath), 'EventBus lock root', { create: true });
    ensureOwnedStorageDirectory(this.outboxDir, 'EventBus outbox', { create: createOutbox });
    assertStorageLockBoundary(this.outboxLockPath, 'EventBus outbox lock');
  }

  #loadEvents() {
    if (!fs.existsSync(this.outboxDir)) return [];
    const names = fs.readdirSync(this.outboxDir).sort();
    const events = [];
    const eventIds = new Set();
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      const match = EVENT_FILE_RE.exec(name);
      if (!match) fail(`unexpected outbox entry: ${name}`, 'CORRUPT_EVENT_OUTBOX');
      const expectedSequence = index + 1;
      if (Number(match[1]) !== expectedSequence) fail(`event sequence gap at ${expectedSequence}`, 'EVENT_SEQUENCE_GAP');
      const file = path.join(this.outboxDir, name);
      assertOwnedStorageFile(file, `EventBus outbox event ${name}`, { allowMissing: false });
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        fail(`event is unreadable: ${name}`, 'CORRUPT_EVENT_OUTBOX');
      }
      let event;
      try {
        event = createEventEnvelope(parsed);
        validateTypedPayload(event.eventType, event.payload, this.projectId);
      } catch (error) {
        if (error?.code?.startsWith('EVENT_') || error?.code === 'INVALID_EVENT_PAYLOAD') throw error;
        fail(`event is invalid: ${name}`, 'CORRUPT_EVENT_OUTBOX');
      }
      if (
        event.sequence !== expectedSequence
        || event.projectId !== this.projectId
        || !Object.prototype.hasOwnProperty.call(event, 'nodeId')
        || (event.nodeId !== null && typeof event.nodeId !== 'string')
        || !EVENT_TYPE_SET.has(event.eventType)
      ) fail(`event identity is invalid: ${name}`, 'CORRUPT_EVENT_OUTBOX');
      if (eventIds.has(event.eventId)) fail(`duplicate event id: ${event.eventId}`, 'DUPLICATE_EVENT_ID');
      if (event.causationId !== null && !eventIds.has(event.causationId)) {
        fail(`event causation is invalid: ${event.eventId}`, 'EVENT_CAUSATION_MISSING');
      }
      eventIds.add(event.eventId);
      events.push(event);
    }
    return events;
  }
}
