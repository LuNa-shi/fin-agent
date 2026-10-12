import { AsyncLocalStorage } from 'node:async_hooks';

import { AGENT_WORKSPACE_MODES } from '../contracts/AgentExecutionScope.js';
import { workflowSpecHash } from './WorkflowSpec.js';

const storage = new AsyncLocalStorage();

const TOP_LEVEL_KEYS = Object.freeze(['workflow', 'run', 'node', 'inputs', 'services', 'signal']);
const WORKFLOW_KEYS = Object.freeze(['id', 'version', 'hash']);
const RUN_KEYS = Object.freeze(['runId', 'projectId', 'scope', 'workspaceMode', 'asOf']);
const LEGACY_PROJECT_RUN_KEYS = Object.freeze(['runId', 'projectId', 'asOf']);
const RUN_SCOPE_KEYS = Object.freeze(['kind', 'id']);
const NODE_KEYS = Object.freeze(['nodeId', 'attempt']);
const INPUT_KEYS = Object.freeze(['artifactRefs', 'priorReviewIssues', 'workspaceSnapshotId']);
const SERVICE_KEYS = Object.freeze(['agentRuntime', 'agentBackend']);
const WORKFLOW_HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const RUN_SCOPE_KIND_SET = new Set(['project', 'idea-universe', 'worldview-universe']);
const WORKSPACE_MODE_SET = new Set(AGENT_WORKSPACE_MODES);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
}

function assertExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError(`${field} must contain exactly: ${expected.join(', ')}`);
  }
}

function assertRunKeys(value, field) {
  const actual = Object.keys(value).sort();
  const extended = [...RUN_KEYS].sort();
  const legacy = [...LEGACY_PROJECT_RUN_KEYS].sort();
  const matches = (expected) => (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
  if (!matches(extended) && !matches(legacy)) {
    throw new TypeError(
      `${field} must contain exactly: ${RUN_KEYS.join(', ')}`
      + ` (or legacy Project fields: ${LEGACY_PROJECT_RUN_KEYS.join(', ')})`,
    );
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertCanonicalIso(value, field) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
}

function cloneSemanticValue(value, path = '$', ancestors = new Map()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains an unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular value first seen at ${ancestors.get(value)}`);
  }
  ancestors.set(value, path);
  let clone;
  if (Array.isArray(value)) {
    clone = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError(`${path} must not contain sparse arrays`);
      }
      clone.push(cloneSemanticValue(value[index], `${path}[${index}]`, ancestors));
    }
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${path} must contain only plain objects`);
    clone = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneSemanticValue(value[key], `${path}.${key}`, ancestors),
        writable: true,
      });
    }
  }
  ancestors.delete(value);
  return clone;
}

function deepFreezeSemanticValue(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeSemanticValue(child);
  return Object.freeze(value);
}

function immutableSemanticArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return deepFreezeSemanticValue(cloneSemanticValue(value, field));
}

function workflowIdentityConflict(expected, actual) {
  const expectedLabel = `${expected.id}@${expected.version} ${expected.hash}`;
  const actualLabel = actual && typeof actual === 'object'
    ? `${actual.id}@${actual.version} ${actual.hash}`
    : String(actual);
  const error = new Error(`workflow node context spec mismatch: expected ${expectedLabel}, got ${actualLabel}`);
  error.code = 'WORKFLOW_SPEC_IDENTITY_CONFLICT';
  return error;
}

function normalizeRunScope(scope, projectId, workspaceMode, field) {
  assertPlainObject(scope, `${field}.scope`);
  assertExactKeys(scope, RUN_SCOPE_KEYS, `${field}.scope`);
  assertNonEmptyString(scope.kind, `${field}.scope.kind`);
  assertNonEmptyString(scope.id, `${field}.scope.id`);
  if (!RUN_SCOPE_KIND_SET.has(scope.kind)) {
    throw new TypeError(`${field}.scope.kind is invalid: ${scope.kind}`);
  }
  if (scope.id !== projectId) {
    throw new TypeError(`${field}.scope.id must match projectId`);
  }
  if (!WORKSPACE_MODE_SET.has(workspaceMode)) {
    throw new TypeError(`${field}.workspaceMode is invalid: ${workspaceMode}`);
  }
  if (
    (scope.kind === 'project' && workspaceMode !== 'project')
    || (scope.kind === 'idea-universe' && workspaceMode !== 'idea-run')
    || (scope.kind === 'worldview-universe' && workspaceMode !== 'none')
  ) {
    throw new TypeError(`${field}.workspaceMode ${workspaceMode} is invalid for ${scope.kind}`);
  }
  return Object.freeze({ kind: scope.kind, id: scope.id });
}

export function assertWorkflowRunSpecIdentity(spec, run) {
  assertPlainObject(spec, 'WorkflowSpec');
  assertNonEmptyString(spec.id, 'WorkflowSpec.id');
  assertNonEmptyString(spec.version, 'WorkflowSpec.version');
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) {
    throw new TypeError('WorkflowSpec.nodes must be a non-empty array');
  }
  assertPlainObject(run, 'durable workflow run');
  assertPlainObject(run.workflowSpec, 'durable workflow run.workflowSpec');

  const canonicalIdentity = Object.freeze({
    id: spec.id,
    version: spec.version,
    hash: workflowSpecHash(spec),
  });
  if (
    run.workflowSpec.id !== canonicalIdentity.id
    || run.workflowSpec.version !== canonicalIdentity.version
    || run.workflowSpec.hash !== canonicalIdentity.hash
  ) {
    throw workflowIdentityConflict(canonicalIdentity, run.workflowSpec);
  }
  return canonicalIdentity;
}

function normalizeWorkflowNodeExecutionContext(context) {
  assertPlainObject(context, 'workflow node context');
  assertExactKeys(context, TOP_LEVEL_KEYS, 'workflow node context');
  assertPlainObject(context.workflow, 'workflow node context.workflow');
  assertExactKeys(context.workflow, WORKFLOW_KEYS, 'workflow node context.workflow');
  assertPlainObject(context.run, 'workflow node context.run');
  assertRunKeys(context.run, 'workflow node context.run');
  assertPlainObject(context.node, 'workflow node context.node');
  assertExactKeys(context.node, NODE_KEYS, 'workflow node context.node');
  assertPlainObject(context.inputs, 'workflow node context.inputs');
  assertExactKeys(context.inputs, INPUT_KEYS, 'workflow node context.inputs');
  assertPlainObject(context.services, 'workflow node context.services');
  assertExactKeys(context.services, SERVICE_KEYS, 'workflow node context.services');

  assertNonEmptyString(context.workflow.id, 'workflow node context.workflow.id');
  assertNonEmptyString(context.workflow.version, 'workflow node context.workflow.version');
  if (typeof context.workflow.hash !== 'string' || !WORKFLOW_HASH_RE.test(context.workflow.hash)) {
    throw new TypeError('workflow node context.workflow.hash must be a sha256 digest');
  }
  assertNonEmptyString(context.run.runId, 'workflow node context.run.runId');
  assertNonEmptyString(context.run.projectId, 'workflow node context.run.projectId');
  const workspaceMode = context.run.workspaceMode === undefined
    ? 'project'
    : context.run.workspaceMode;
  const scope = normalizeRunScope(
    context.run.scope === undefined
      ? { kind: 'project', id: context.run.projectId }
      : context.run.scope,
    context.run.projectId,
    workspaceMode,
    'workflow node context.run',
  );
  assertCanonicalIso(context.run.asOf, 'workflow node context.run.asOf');
  assertNonEmptyString(context.node.nodeId, 'workflow node context.node.nodeId');
  if (!Number.isInteger(context.node.attempt) || context.node.attempt <= 0) {
    throw new TypeError('workflow node context.node.attempt must be a positive integer');
  }
  assertNonEmptyString(
    context.inputs.workspaceSnapshotId,
    'workflow node context.inputs.workspaceSnapshotId',
  );

  const normalized = {
    workflow: Object.freeze({ ...context.workflow }),
    run: Object.freeze({ ...context.run, scope, workspaceMode }),
    node: Object.freeze({ ...context.node }),
    inputs: Object.freeze({
      artifactRefs: immutableSemanticArray(
        context.inputs.artifactRefs,
        'workflow node context.inputs.artifactRefs',
      ),
      priorReviewIssues: immutableSemanticArray(
        context.inputs.priorReviewIssues,
        'workflow node context.inputs.priorReviewIssues',
      ),
      workspaceSnapshotId: context.inputs.workspaceSnapshotId,
    }),
    services: Object.freeze({
      agentRuntime: context.services.agentRuntime,
      agentBackend: context.services.agentBackend,
    }),
    signal: context.signal,
  };
  return Object.freeze(normalized);
}

export function createWorkflowNodeExecutionContext({
  spec,
  run,
  node,
  record,
  artifactRefs = [],
  priorReviewIssues = [],
  workspaceSnapshotId,
  agentRuntime = null,
  agentBackend = null,
  signal = null,
} = {}) {
  const canonicalIdentity = assertWorkflowRunSpecIdentity(spec, run);
  assertPlainObject(node, 'canonical workflow node');
  assertNonEmptyString(node.id, 'canonical workflow node.id');
  assertPlainObject(record, 'durable workflow node record');
  assertPlainObject(run.nodes, 'durable workflow run.nodes');

  const matchingNodes = spec.nodes.filter((candidate) => candidate?.id === node.id);
  if (matchingNodes.length !== 1) {
    throw new Error(`canonical workflow node is not uniquely declared: ${node.id}`);
  }
  const canonicalNode = matchingNodes[0];

  assertNonEmptyString(run.runId, 'durable workflow run.runId');
  assertNonEmptyString(run.projectId, 'durable workflow run.projectId');
  assertCanonicalIso(run.asOf, 'durable workflow run.asOf');
  const scope = run.scope === undefined
    ? { kind: 'project', id: run.projectId }
    : run.scope;
  const workspaceMode = run.workspaceMode === undefined ? 'project' : run.workspaceMode;
  normalizeRunScope(scope, run.projectId, workspaceMode, 'durable workflow run');
  if (
    run.workspaceSnapshotId !== undefined
    && run.workspaceSnapshotId !== workspaceSnapshotId
  ) {
    const error = new Error(
      `workflow node context snapshot mismatch: expected ${run.workspaceSnapshotId}, got ${workspaceSnapshotId}`,
    );
    error.code = 'WORKFLOW_SNAPSHOT_IDENTITY_CONFLICT';
    throw error;
  }
  const durableRecord = run.nodes[canonicalNode.id];
  assertPlainObject(durableRecord, `durable workflow run.nodes.${canonicalNode.id}`);
  assertNonEmptyString(durableRecord.nodeId, 'durable workflow node record.nodeId');
  if (
    record.nodeId !== durableRecord.nodeId
    || record.attempt !== durableRecord.attempt
    || durableRecord.nodeId !== canonicalNode.id
  ) {
    throw new Error(
      `durable workflow node record mismatch: expected ${canonicalNode.id}@${durableRecord.attempt}, got ${record.nodeId}@${record.attempt}`,
    );
  }
  if (!Number.isInteger(durableRecord.attempt) || durableRecord.attempt <= 0) {
    throw new TypeError('durable workflow node record.attempt must be a positive integer');
  }
  assertNonEmptyString(workspaceSnapshotId, 'workspaceSnapshotId');
  if (!Array.isArray(artifactRefs)) throw new TypeError('artifactRefs must be an array');
  if (!Array.isArray(priorReviewIssues)) throw new TypeError('priorReviewIssues must be an array');

  return normalizeWorkflowNodeExecutionContext({
    workflow: canonicalIdentity,
    run: {
      runId: run.runId,
      projectId: run.projectId,
      scope,
      workspaceMode,
      asOf: run.asOf,
    },
    node: {
      nodeId: canonicalNode.id,
      attempt: durableRecord.attempt,
    },
    inputs: {
      artifactRefs,
      priorReviewIssues,
      workspaceSnapshotId,
    },
    services: {
      agentRuntime,
      agentBackend,
    },
    signal,
  });
}

export function validateWorkflowNodeExecutionContext(context) {
  normalizeWorkflowNodeExecutionContext(context);
  return true;
}

export function runWithWorkflowNodeContext(context, fn) {
  if (typeof fn !== 'function') throw new TypeError('workflow node callback is required');
  return storage.run(normalizeWorkflowNodeExecutionContext(context), fn);
}

export function currentWorkflowNodeContext() {
  return storage.getStore() || null;
}
