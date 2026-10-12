// Generic agent contract values shared by all domains and backend implementations.
const SEMVER = /^\d+\.\d+\.\d+$/;
const STATUS = new Set(['succeeded', 'partial', 'failed']);
const EXECUTION_MODES = new Set(['tool-loop', 'json', 'text']);
const IDEMPOTENCY_KEY_MODES = new Set(['explicit', 'generated']);

function fail(message) {
  throw new TypeError(message);
}

function requireOwn(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined || value[field] === null || value[field] === '') {
      fail(`${label}.${field} is required`);
    }
  }
}

function requireArray(value, field, label) {
  if (!Array.isArray(value[field])) fail(`${label}.${field} must be an array`);
}

function deepFreeze(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function defineAgentContract(spec) {
  requireOwn(spec, [
    'id', 'version', 'purpose', 'executionMode', 'inputSchema', 'outputSchema',
    'contextPolicy', 'toolPolicy', 'modelPolicy', 'runPolicy', 'completionPolicy', 'prompt',
  ], 'AgentContract');
  if (!SEMVER.test(spec.version)) fail('AgentContract.version must be a semantic version (x.y.z)');
  if (!EXECUTION_MODES.has(spec.executionMode)) fail(`AgentContract.executionMode is invalid: ${spec.executionMode}`);
  if (typeof spec.prompt !== 'function') fail('AgentContract.prompt must be a function');

  requireOwn(spec.contextPolicy, ['mounts', 'artifactSelectors', 'maxInlineTokens', 'allowPriorReview', 'allowCrossProjectRead'], 'AgentContract.contextPolicy');
  requireArray(spec.contextPolicy, 'mounts', 'AgentContract.contextPolicy');
  requireArray(spec.contextPolicy, 'artifactSelectors', 'AgentContract.contextPolicy');
  requireOwn(spec.toolPolicy, ['allow', 'externalRetrieval', 'writeScopes'], 'AgentContract.toolPolicy');
  requireArray(spec.toolPolicy, 'allow', 'AgentContract.toolPolicy');
  requireArray(spec.toolPolicy, 'writeScopes', 'AgentContract.toolPolicy');
  requireOwn(spec.modelPolicy, ['tier', 'preferredProviders', 'reasoningLevel'], 'AgentContract.modelPolicy');
  requireArray(spec.modelPolicy, 'preferredProviders', 'AgentContract.modelPolicy');
  requireOwn(spec.runPolicy, ['maxTurns', 'deadlineMs', 'tokenBudget', 'toolCallBudget', 'retry'], 'AgentContract.runPolicy');
  requireOwn(spec.completionPolicy, ['requiredArtifacts', 'hardChecks', 'gracefulFinalize'], 'AgentContract.completionPolicy');

  return deepFreeze({
    ...spec,
    contextPolicy: { ...spec.contextPolicy, mounts: [...spec.contextPolicy.mounts], artifactSelectors: [...spec.contextPolicy.artifactSelectors] },
    toolPolicy: { ...spec.toolPolicy, allow: [...spec.toolPolicy.allow], deny: [...(spec.toolPolicy.deny || [])], writeScopes: [...spec.toolPolicy.writeScopes] },
    modelPolicy: { ...spec.modelPolicy, preferredProviders: [...spec.modelPolicy.preferredProviders] },
    runPolicy: { ...spec.runPolicy, retry: { ...spec.runPolicy.retry, retryOn: [...(spec.runPolicy.retry?.retryOn || [])] } },
    completionPolicy: { ...spec.completionPolicy, requiredArtifacts: [...spec.completionPolicy.requiredArtifacts], hardChecks: [...spec.completionPolicy.hardChecks] },
  });
}

export function createAgentRunRequest(value) {
  requireOwn(value, [
    'runId', 'workflowId', 'nodeId', 'projectId', 'agentContractId', 'contractVersion', 'asOf',
    'input', 'inputArtifactRefs', 'workspaceSnapshotId', 'idempotencyKey',
  ], 'AgentRunRequest');
  if (!SEMVER.test(value.contractVersion)) fail('AgentRunRequest.contractVersion must be a semantic version');
  requireArray(value, 'inputArtifactRefs', 'AgentRunRequest');
  if (value.priorReviewIssues !== undefined) requireArray(value, 'priorReviewIssues', 'AgentRunRequest');
  if (value.idempotencyKeyMode !== undefined && !IDEMPOTENCY_KEY_MODES.has(value.idempotencyKeyMode)) {
    fail(`AgentRunRequest.idempotencyKeyMode is invalid: ${value.idempotencyKeyMode}`);
  }
  if (value.effectiveConfigRevision !== undefined && (typeof value.effectiveConfigRevision !== 'string' || !value.effectiveConfigRevision)) {
    fail('AgentRunRequest.effectiveConfigRevision must be a non-empty string');
  }
  if (value.effectiveConfigDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(value.effectiveConfigDigest)) {
    fail('AgentRunRequest.effectiveConfigDigest must be a sha256 digest');
  }
  if (Number.isNaN(Date.parse(value.asOf))) fail('AgentRunRequest.asOf must be an ISO timestamp');
  return deepFreeze({
    ...value,
    idempotencyKeyMode: value.idempotencyKeyMode || 'explicit',
    inputArtifactRefs: [...value.inputArtifactRefs],
    priorReviewIssues: [...(value.priorReviewIssues || [])],
  });
}

export function createAgentRunResult(value) {
  requireOwn(value, ['status', 'artifacts', 'evidenceRefs', 'openQuestions', 'dataRequests', 'metrics', 'stopReason', 'traceRef'], 'AgentRunResult');
  if (!STATUS.has(value.status)) fail(`AgentRunResult.status is invalid: ${value.status}`);
  for (const field of ['artifacts', 'evidenceRefs', 'openQuestions', 'dataRequests']) requireArray(value, field, 'AgentRunResult');
  return Object.freeze({
    ...value,
    artifacts: Object.freeze([...value.artifacts]),
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    openQuestions: Object.freeze([...value.openQuestions]),
    dataRequests: Object.freeze([...value.dataRequests]),
    metrics: Object.freeze({ ...value.metrics }),
  });
}

export function createEventEnvelope(value) {
  requireOwn(value, [
    'eventId', 'eventType', 'schemaVersion', 'timestamp', 'sequence', 'correlationId', 'projectId', 'runId', 'payload',
  ], 'EventEnvelope');
  if (!Object.prototype.hasOwnProperty.call(value, 'causationId') || value.causationId === undefined) {
    fail('EventEnvelope.causationId is required');
  }
  if (value.causationId !== null && (typeof value.causationId !== 'string' || !value.causationId)) {
    fail('EventEnvelope.causationId must be a string or null');
  }
  if (!SEMVER.test(value.schemaVersion)) fail('EventEnvelope.schemaVersion must be a semantic version');
  if (!Number.isInteger(value.sequence) || value.sequence < 0) fail('EventEnvelope.sequence must be a non-negative integer');
  if (Number.isNaN(Date.parse(value.timestamp))) fail('EventEnvelope.timestamp must be an ISO timestamp');
  return deepFreeze({ ...value });
}

export const AGENT_RUN_STATUSES = Object.freeze([...STATUS]);
export const AGENT_EXECUTION_MODES = Object.freeze([...EXECUTION_MODES]);
export const AGENT_IDEMPOTENCY_KEY_MODES = Object.freeze([...IDEMPOTENCY_KEY_MODES]);
