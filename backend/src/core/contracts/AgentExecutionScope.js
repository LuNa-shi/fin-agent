import crypto from 'node:crypto';

export const AGENT_WORKSPACE_MODES = Object.freeze(['project', 'idea-run', 'none']);

const WORKSPACE_MODE_SET = new Set(AGENT_WORKSPACE_MODES);
const DIRECT_SCOPE_FIELDS = Object.freeze([
  'runId',
  'workflowId',
  'nodeId',
  'projectId',
  'asOf',
  'workspaceMode',
  'workspaceSnapshotId',
  'inputArtifactRefs',
  'priorReviewIssues',
  'idempotencyKey',
]);
const DIRECT_SCOPE_OPTIONAL_FIELDS = Object.freeze(['signal']);
const DIRECT_COMMAND_FIELDS = new Set([
  'commandId',
  ...DIRECT_SCOPE_FIELDS,
  ...DIRECT_SCOPE_OPTIONAL_FIELDS,
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  throw new TypeError(message);
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
}

function assertKnownFields(value, allowedFields, label) {
  const unknown = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (unknown.length) fail(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function requireOwn(value, field, label) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    fail(`${label}.${field} is required`);
  }
  return value[field];
}

function requireString(value, field, label) {
  const candidate = requireOwn(value, field, label);
  if (typeof candidate !== 'string' || !candidate.trim()) {
    fail(`${label}.${field} must be a non-empty string`);
  }
  return candidate;
}

function requireArray(value, field, label) {
  const candidate = requireOwn(value, field, label);
  if (!Array.isArray(candidate)) fail(`${label}.${field} must be an array`);
  return candidate;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function cloneSemanticValue(value, location, seen = new Map()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(`${location} must not contain circular values`);
    const clone = [];
    seen.set(value, clone);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        fail(`${location} must not contain sparse arrays`);
      }
      clone.push(cloneSemanticValue(value[index], `${location}[${index}]`, seen));
    }
    seen.delete(value);
    return clone;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) fail(`${location} must not contain circular values`);
    const clone = {};
    seen.set(value, clone);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneSemanticValue(child, `${location}.${key}`, seen),
        writable: true,
      });
    }
    seen.delete(value);
    return clone;
  }
  fail(`${location} must contain only finite JSON-compatible semantic values`);
}

function deepFreezeSemantic(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeSemantic(child);
  return Object.freeze(value);
}

function optionalOrDefault(options, field, defaultValue, label) {
  if (!Object.prototype.hasOwnProperty.call(options, field)) return defaultValue;
  const value = options[field];
  if (value === undefined || value === null || value === '') {
    fail(`${label}.${field} must not be empty when provided`);
  }
  return value;
}

export function createDirectExecutionScope(value) {
  const label = 'DirectExecutionScope';
  assertObject(value, label);
  assertKnownFields(
    value,
    new Set([...DIRECT_SCOPE_FIELDS, ...DIRECT_SCOPE_OPTIONAL_FIELDS]),
    label,
  );

  const runId = requireString(value, 'runId', label);
  const workflowId = requireString(value, 'workflowId', label);
  const nodeId = requireString(value, 'nodeId', label);
  const projectId = requireString(value, 'projectId', label);
  const asOf = requireString(value, 'asOf', label);
  const workspaceMode = requireString(value, 'workspaceMode', label);
  const workspaceSnapshotId = requireString(value, 'workspaceSnapshotId', label);
  const inputArtifactRefs = requireArray(value, 'inputArtifactRefs', label);
  const priorReviewIssues = requireArray(value, 'priorReviewIssues', label);
  const idempotencyKey = requireString(value, 'idempotencyKey', label);

  if (!isIsoTimestamp(asOf)) fail(`${label}.asOf must be an ISO timestamp`);
  if (!WORKSPACE_MODE_SET.has(workspaceMode)) {
    fail(`${label}.workspaceMode is invalid: ${workspaceMode}`);
  }

  const semanticScope = deepFreezeSemantic({
    runId,
    workflowId,
    nodeId,
    projectId,
    asOf,
    workspaceMode,
    workspaceSnapshotId,
    inputArtifactRefs: cloneSemanticValue(
      inputArtifactRefs,
      `${label}.inputArtifactRefs`,
    ),
    priorReviewIssues: cloneSemanticValue(
      priorReviewIssues,
      `${label}.priorReviewIssues`,
    ),
    idempotencyKey,
  });

  if (!Object.prototype.hasOwnProperty.call(value, 'signal')) return semanticScope;
  return Object.freeze({ ...semanticScope, signal: value.signal });
}

export function beginDirectAgentCommand(options) {
  const label = 'DirectAgentCommand';
  assertObject(options, label);
  assertKnownFields(options, DIRECT_COMMAND_FIELDS, label);

  const workflowId = requireString(options, 'workflowId', label);
  const nodeId = requireString(options, 'nodeId', label);
  const workspaceMode = requireString(options, 'workspaceMode', label);
  if (!WORKSPACE_MODE_SET.has(workspaceMode)) {
    fail(`${label}.workspaceMode is invalid: ${workspaceMode}`);
  }

  const commandId = Object.prototype.hasOwnProperty.call(options, 'commandId')
    ? requireString(options, 'commandId', label)
    : crypto.randomUUID();
  if (
    workspaceMode === 'project'
    && !Object.prototype.hasOwnProperty.call(options, 'projectId')
  ) {
    fail(`${label}.projectId is required for project workspace mode`);
  }
  const projectId = optionalOrDefault(options, 'projectId', 'global', label);
  const asOf = optionalOrDefault(options, 'asOf', new Date().toISOString(), label);
  const runId = optionalOrDefault(
    options,
    'runId',
    `direct:${workflowId}:${commandId}`,
    label,
  );
  const idempotencyKey = optionalOrDefault(
    options,
    'idempotencyKey',
    `direct-command:${commandId}`,
    label,
  );

  let workspaceSnapshotId;
  if (Object.prototype.hasOwnProperty.call(options, 'workspaceSnapshotId')) {
    workspaceSnapshotId = optionalOrDefault(
      options,
      'workspaceSnapshotId',
      null,
      label,
    );
  } else if (workspaceMode === 'project') {
    workspaceSnapshotId = `${projectId}:live`;
  } else if (workspaceMode === 'none') {
    workspaceSnapshotId = `none:${runId}`;
  } else {
    fail(`${label}.workspaceSnapshotId is required for idea-run workspace mode`);
  }

  const scope = {
    runId,
    workflowId,
    nodeId,
    projectId,
    asOf,
    workspaceMode,
    workspaceSnapshotId,
    inputArtifactRefs: Object.prototype.hasOwnProperty.call(options, 'inputArtifactRefs')
      ? options.inputArtifactRefs
      : [],
    priorReviewIssues: Object.prototype.hasOwnProperty.call(options, 'priorReviewIssues')
      ? options.priorReviewIssues
      : [],
    idempotencyKey,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'signal')) scope.signal = options.signal;
  return createDirectExecutionScope(scope);
}

export function assertDirectExecutionScopeBinding(value, expected = {}) {
  const scope = createDirectExecutionScope(value);
  const label = 'DirectExecutionScope binding';
  assertObject(expected, label);
  const allowed = new Set(['workflowId', 'nodeId', 'projectId', 'workspaceMode']);
  assertKnownFields(expected, allowed, label);
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(expected, field)) continue;
    const required = expected[field];
    if (typeof required !== 'string' || !required.trim()) {
      fail(`${label}.${field} must be a non-empty string`);
    }
    if (scope[field] !== required) {
      fail(`${label}.${field} mismatch: expected ${required}, got ${scope[field]}`);
    }
  }
  return scope;
}
