import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECTS_DIR } from '../config.js';
import { AGENT_WORKSPACE_MODES } from '../core/contracts/AgentExecutionScope.js';
import { canonicalSha256, createArtifactRef, deepFreeze, validateArtifactRef } from '../core/contracts/ArtifactRef.js';
import {
  NODE_STATES,
  assertNodeState,
  isFailureNodeState,
  transitionNodeState,
} from '../core/workflow/NodeState.js';
import { atomicWriteFileSync, withFileLockSync } from '../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
  resolveDirectStorageDirectory,
} from '../lib/storageBoundary.js';
import { DURABLE_EVENT_TYPES, FileEventBus, durableEventId } from './EventBus.js';

export const RUN_STORE_SCHEMA_VERSION = 'workflow-run.v1';
export const RUN_STORE_SCOPE = 'single-process';
export const RUN_STATUSES = Object.freeze({
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

const RUN_STATUS_SET = new Set(Object.values(RUN_STATUSES));
const RUN_SCOPE_KIND_SET = new Set(['project', 'idea-universe', 'worldview-universe']);
const WORKSPACE_MODE_SET = new Set(AGENT_WORKSPACE_MODES);

function fail(message, code = 'RUN_STORE_ERROR') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function atomicWriteJSON(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
}

function assertSafeIdentity(value, field) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    fail(`${field} is unsafe: ${value}`, 'UNSAFE_RUN_IDENTITY');
  }
}

function assertDigest(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail(`${field} must be a sha256 digest`, 'INVALID_RUN_RECORD');
  }
}

function assertIso(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`, 'INVALID_RUN_RECORD');
  }
}

function normalizeRunScope({
  scope,
  workspaceMode,
  workspaceSnapshotId,
  projectId,
  optional = false,
} = {}) {
  const values = [scope, workspaceMode, workspaceSnapshotId];
  const present = values.filter((value) => value !== undefined).length;
  if (optional && present === 0) return null;
  if (present !== values.length) {
    fail(
      'scope, workspaceMode, and workspaceSnapshotId must be provided together',
      'INVALID_RUN_SCOPE',
    );
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    fail('scope must be an object', 'INVALID_RUN_SCOPE');
  }
  const fields = Object.keys(scope).sort();
  if (fields.length !== 2 || fields[0] !== 'id' || fields[1] !== 'kind') {
    fail('scope must contain exactly kind and id', 'INVALID_RUN_SCOPE');
  }
  if (!RUN_SCOPE_KIND_SET.has(scope.kind)) {
    fail(`unsupported run scope kind: ${scope.kind}`, 'INVALID_RUN_SCOPE');
  }
  assertSafeIdentity(scope.id, 'scope.id');
  if (scope.id !== projectId) {
    fail('scope.id must match the compatibility projectId', 'INVALID_RUN_SCOPE');
  }
  if (!WORKSPACE_MODE_SET.has(workspaceMode)) {
    fail(`unsupported workspaceMode: ${workspaceMode}`, 'INVALID_RUN_SCOPE');
  }
  if (
    (scope.kind === 'project' && workspaceMode !== 'project')
    || (scope.kind === 'idea-universe' && workspaceMode !== 'idea-run')
    || (scope.kind === 'worldview-universe' && workspaceMode !== 'none')
  ) {
    fail(`workspaceMode ${workspaceMode} is invalid for ${scope.kind}`, 'INVALID_RUN_SCOPE');
  }
  if (typeof workspaceSnapshotId !== 'string' || !workspaceSnapshotId.trim()) {
    fail('workspaceSnapshotId is required', 'INVALID_RUN_SCOPE');
  }
  return {
    scope: { kind: scope.kind, id: scope.id },
    workspaceMode,
    workspaceSnapshotId,
  };
}

function nodeRecord(nodeId) {
  return {
    nodeId,
    status: NODE_STATES.PENDING,
    attempt: 0,
    inputDigest: null,
    outputDigest: null,
    stopReason: null,
    artifactRefs: [],
    startedAt: null,
    completedAt: null,
    lastFailure: null,
    imported: false,
  };
}

function snapshot(value) {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : JSON.parse(serialized);
  } catch {
    return String(value);
  }
}

function validateNodeRecord(value, expectedNodeId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.nodeId !== expectedNodeId) {
    fail(`invalid node record: ${expectedNodeId}`, 'INVALID_RUN_RECORD');
  }
  assertNodeState(value.status);
  if (!Number.isInteger(value.attempt) || value.attempt < 0) fail(`invalid attempt for ${expectedNodeId}`, 'INVALID_RUN_RECORD');
  assertDigest(value.inputDigest, `${expectedNodeId}.inputDigest`, { nullable: true });
  assertDigest(value.outputDigest, `${expectedNodeId}.outputDigest`, { nullable: true });
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.some((ref) => !validateArtifactRef(ref).valid)) {
    fail(`invalid artifact refs for ${expectedNodeId}`, 'INVALID_RUN_RECORD');
  }
  assertIso(value.startedAt, `${expectedNodeId}.startedAt`, { nullable: true });
  assertIso(value.completedAt, `${expectedNodeId}.completedAt`, { nullable: true });
  if (typeof value.imported !== 'boolean') fail(`invalid imported flag for ${expectedNodeId}`, 'INVALID_RUN_RECORD');
}

function validateRunRecord(record, projectId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('run record must be an object', 'INVALID_RUN_RECORD');
  if (record.schemaVersion !== RUN_STORE_SCHEMA_VERSION || record.storeScope !== RUN_STORE_SCOPE || record.projectId !== projectId) {
    fail('run record identity is invalid', 'INVALID_RUN_RECORD');
  }
  assertSafeIdentity(record.runId, 'runId');
  if (!RUN_STATUS_SET.has(record.status)) fail(`invalid run status: ${record.status}`, 'INVALID_RUN_RECORD');
  if (!record.workflowSpec || typeof record.workflowSpec !== 'object') fail('workflowSpec is required', 'INVALID_RUN_RECORD');
  for (const field of ['id', 'version', 'hash']) {
    if (typeof record.workflowSpec[field] !== 'string' || !record.workflowSpec[field]) fail(`workflowSpec.${field} is required`, 'INVALID_RUN_RECORD');
  }
  assertDigest(record.inputDigest, 'inputDigest');
  assertIso(record.asOf, 'asOf');
  assertIso(record.createdAt, 'createdAt');
  assertIso(record.updatedAt, 'updatedAt');
  assertIso(record.completedAt, 'completedAt', { nullable: true });
  normalizeRunScope({
    scope: record.scope,
    workspaceMode: record.workspaceMode,
    workspaceSnapshotId: record.workspaceSnapshotId,
    projectId,
    optional: true,
  });
  if (record.resumeCount !== undefined && (!Number.isInteger(record.resumeCount) || record.resumeCount < 0)) {
    fail('resumeCount must be a non-negative integer', 'INVALID_RUN_RECORD');
  }
  if (record.remediationCycle !== undefined && (!Number.isInteger(record.remediationCycle) || record.remediationCycle < 0)) {
    fail('remediationCycle must be a non-negative integer', 'INVALID_RUN_RECORD');
  }
  if (record.remediationHistory !== undefined && !Array.isArray(record.remediationHistory)) {
    fail('remediationHistory must be an array', 'INVALID_RUN_RECORD');
  }
  if (record.openIssues !== undefined && !Array.isArray(record.openIssues)) {
    fail('openIssues must be an array', 'INVALID_RUN_RECORD');
  }
  if (record.reviewBlockCount !== undefined && (!Number.isInteger(record.reviewBlockCount) || record.reviewBlockCount < 0)) {
    fail('reviewBlockCount must be a non-negative integer', 'INVALID_RUN_RECORD');
  }
  if (record.blockedStateDigest !== undefined && record.blockedStateDigest !== null) {
    assertDigest(record.blockedStateDigest, 'blockedStateDigest');
  }
  if (record.humanReviewAttempt !== undefined && (!Number.isInteger(record.humanReviewAttempt) || record.humanReviewAttempt < 0)) {
    fail('humanReviewAttempt must be a non-negative integer', 'INVALID_RUN_RECORD');
  }
  if (record.humanReviewHistory !== undefined && !Array.isArray(record.humanReviewHistory)) {
    fail('humanReviewHistory must be an array', 'INVALID_RUN_RECORD');
  }
  if (!record.nodes || typeof record.nodes !== 'object' || Array.isArray(record.nodes)) fail('nodes are required', 'INVALID_RUN_RECORD');
  for (const [nodeId, node] of Object.entries(record.nodes)) validateNodeRecord(node, nodeId);
  return record;
}

export class FileRunStore {
  static scope = RUN_STORE_SCOPE;

  constructor({
    projectId,
    projectsDir = PROJECTS_DIR,
    storageDir = null,
    now = () => new Date().toISOString(),
    eventBus = null,
  } = {}) {
    assertSafeIdentity(projectId, 'projectId');
    if (typeof now !== 'function') throw new TypeError('RunStore now must be a function');
    this.projectId = projectId;
    this.projectsDir = path.resolve(projectsDir);
    this.directStorageDir = storageDir !== null;
    this.storageDir = this.directStorageDir
      ? resolveDirectStorageDirectory(storageDir, 'RunStore storageDir')
      : path.join(this.projectsDir, projectId);
    this.projectDir = this.storageDir;
    this.rootDir = path.join(this.storageDir, '.runs');
    this.lockRoot = path.join(this.rootDir, '.locks');
    this.now = now;
    this.eventBus = eventBus || new FileEventBus({
      projectId,
      projectsDir: this.projectsDir,
      ...(this.directStorageDir ? { storageDir: this.storageDir } : {}),
      now,
    });
  }

  begin({
    runId,
    workflowSpec,
    inputDigest,
    asOf,
    nodeIds,
    allowSupersede = false,
    scope = undefined,
    workspaceMode = undefined,
    workspaceSnapshotId = undefined,
  } = {}) {
    assertSafeIdentity(runId, 'runId');
    assertDigest(inputDigest, 'inputDigest');
    assertIso(asOf, 'asOf');
    if (!workflowSpec || typeof workflowSpec !== 'object') throw new TypeError('workflowSpec is required');
    if (!Array.isArray(nodeIds) || !nodeIds.length) throw new TypeError('nodeIds must be a non-empty array');
    if (new Set(nodeIds).size !== nodeIds.length) throw new TypeError('nodeIds must be unique');
    nodeIds.forEach((nodeId) => assertSafeIdentity(nodeId, 'nodeId'));
    const scopedIdentity = normalizeRunScope({
      scope,
      workspaceMode,
      workspaceSnapshotId,
      projectId: this.projectId,
      optional: true,
    });

    const existing = this.load(runId);
    if (existing) {
      if (existing.inputDigest !== inputDigest) fail('run id was reused with different input', 'RUN_INPUT_DIGEST_CONFLICT');
      if (
        Boolean(existing.scope) !== Boolean(scopedIdentity)
        || (
          scopedIdentity
          && (
            existing.scope?.kind !== scopedIdentity.scope.kind
            || existing.scope?.id !== scopedIdentity.scope.id
            || existing.workspaceMode !== scopedIdentity.workspaceMode
            || existing.workspaceSnapshotId !== scopedIdentity.workspaceSnapshotId
          )
        )
      ) {
        fail('run id was reused with a different scope', 'RUN_SCOPE_CONFLICT');
      }
      this.#publishRunStarted(existing);
      return existing;
    }
    const active = this.resumable();
    if (active && active.runId !== runId) {
      if (!allowSupersede) fail(`unfinished run already exists: ${active.runId}`, 'RUN_ALREADY_ACTIVE');
      this.cancelRun(active.runId, 'superseded');
    }

    const timestamp = this.now();
    const record = {
      schemaVersion: RUN_STORE_SCHEMA_VERSION,
      storeScope: RUN_STORE_SCOPE,
      projectId: this.projectId,
      runId,
      workflowSpec: snapshot(workflowSpec),
      inputDigest,
      asOf,
      status: RUN_STATUSES.RUNNING,
      stopReason: null,
      resumeCount: 0,
      remediationCycle: 0,
      remediationHistory: [],
      openIssues: [],
      reviewBlockCount: 0,
      blockedStateDigest: null,
      humanReviewAttempt: 0,
      humanReviewHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      nodes: Object.fromEntries(nodeIds.map((nodeId) => [nodeId, nodeRecord(nodeId)])),
      ...(scopedIdentity || {}),
    };
    this.#write(record);
    const created = this.load(runId);
    this.#publishRunStarted(created);
    return created;
  }

  load(runId) {
    assertSafeIdentity(runId, 'runId');
    if (!this.#ensureStorageTree({ create: false })) return null;
    const file = this.#file(runId);
    if (!assertOwnedStorageFile(file, `RunStore record ${runId}`)) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`run record is unreadable: ${runId}`, 'INVALID_RUN_RECORD'); }
    validateRunRecord(record, this.projectId);
    return deepFreeze(record);
  }

  list() {
    if (!this.#ensureStorageTree({ create: false })) return [];
    return fs.readdirSync(this.rootDir)
      .filter((name) => /^run-[a-f0-9]{64}\.json$/u.test(name))
      .map((name) => {
        let value;
        const file = path.join(this.rootDir, name);
        assertOwnedStorageFile(file, `RunStore record ${name}`, { allowMissing: false });
        try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`run record is unreadable: ${name}`, 'INVALID_RUN_RECORD'); }
        validateRunRecord(value, this.projectId);
        return value;
      })
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((record) => deepFreeze(record));
  }

  resumable() {
    return [...this.list()].reverse().find((record) => ![
      RUN_STATUSES.SUCCEEDED,
      RUN_STATUSES.BLOCKED,
    ].includes(record.status)) || null;
  }

  prepareResume(runId) {
    const before = this.load(runId);
    if (!before) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    const resumed = this.#mutate(runId, (record) => {
      const now = this.now();
      const nodes = { ...record.nodes };
      for (const [nodeId, current] of Object.entries(nodes)) {
        let node = { ...current };
        if (node.status === NODE_STATES.RUNNING) {
          node = transitionNodeState(node, NODE_STATES.FAILED_TRANSIENT, {
            stopReason: 'process-interrupted',
            completedAt: now,
            lastFailure: { category: 'transient', reason: 'process-interrupted', at: now },
          });
        }
        if (isFailureNodeState(node.status) || node.status === NODE_STATES.BLOCKED || node.status === NODE_STATES.CANCELLED) {
          node = transitionNodeState(node, NODE_STATES.READY, { completedAt: null });
        }
        nodes[nodeId] = node;
      }
      return {
        ...record,
        status: RUN_STATUSES.RUNNING,
        stopReason: null,
        openIssues: [],
        resumeCount: (record.resumeCount || 0) + 1,
        completedAt: null,
        nodes,
      };
    });
    const reopenedNodeIds = Object.entries(before.nodes)
      .filter(([, node]) => isFailureNodeState(node.status) || [
        NODE_STATES.RUNNING,
        NODE_STATES.BLOCKED,
        NODE_STATES.CANCELLED,
      ].includes(node.status))
      .map(([nodeId]) => nodeId);
    const interruptedNodeIds = Object.entries(before.nodes)
      .filter(([, node]) => node.status === NODE_STATES.RUNNING)
      .map(([nodeId]) => nodeId);
    const resumeEvent = this.#publishRunResumed(resumed, {
      reason: 'process-resume',
      identity: { resumeCount: resumed.resumeCount },
      causationId: this.#latestCause(runId),
      extraPayload: { interruptedNodeIds, reopenedNodeIds },
    });
    for (const nodeId of reopenedNodeIds) {
      const prior = before.nodes[nodeId];
      let causationId = resumeEvent.eventId;
      if (prior.status === NODE_STATES.RUNNING) {
        const failure = {
          category: 'transient',
          reason: 'process-interrupted',
          code: null,
          message: 'process-interrupted',
          at: resumed.nodes[nodeId].lastFailure?.at || resumed.updatedAt,
        };
        const failedEvent = this.#publishNodeFailed(resumed, nodeId, {
          status: NODE_STATES.FAILED_TRANSIENT,
          attempt: prior.attempt,
          stopReason: 'process-interrupted',
          failure,
          causationId: this.#latestCause(runId, nodeId),
        });
        causationId = failedEvent.eventId;
      }
      this.#publishNodeReady(resumed, nodeId, causationId);
    }
    return resumed;
  }

  markReady(runId, nodeId) {
    const ready = this.#mutateNode(runId, nodeId, (node) => (
      node.status === NODE_STATES.READY ? node : transitionNodeState(node, NODE_STATES.READY, { completedAt: null })
    ));
    this.#publishNodeReady(ready, nodeId, this.#latestCause(runId, nodeId) || this.#latestCause(runId));
    return ready;
  }

  startNode(runId, nodeId, inputDigest) {
    assertDigest(inputDigest, 'node inputDigest');
    const existing = this.load(runId);
    const existingNode = existing?.nodes[nodeId];
    if (existingNode?.status === NODE_STATES.RUNNING && existingNode.inputDigest === inputDigest) {
      this.#publishNodeStarted(existing, nodeId, this.#latestCause(runId, nodeId));
      return existing;
    }
    const started = this.#mutateNode(runId, nodeId, (current) => {
      let node = current;
      if (node.status === NODE_STATES.PENDING) node = transitionNodeState(node, NODE_STATES.READY);
      if (node.status !== NODE_STATES.READY) fail(`node is not ready: ${nodeId} (${node.status})`, 'NODE_NOT_READY');
      if (node.inputDigest && node.inputDigest !== inputDigest) fail(`node input changed across attempts: ${nodeId}`, 'NODE_INPUT_DIGEST_CONFLICT');
      return transitionNodeState(node, NODE_STATES.RUNNING, {
        attempt: node.attempt + 1,
        inputDigest: node.inputDigest || inputDigest,
        stopReason: null,
        startedAt: this.now(),
        completedAt: null,
      });
    });
    this.#publishNodeStarted(started, nodeId, this.#latestCause(runId, nodeId));
    return started;
  }

  succeedNode(runId, nodeId, { artifactRefs = [], output, pureReturn = false, imported = false } = {}) {
    const refs = artifactRefs.map((ref) => createArtifactRef(ref));
    if (!pureReturn && refs.length === 0) fail(`succeeded node requires ArtifactRefs: ${nodeId}`, 'NODE_ARTIFACTS_REQUIRED');
    const outputDigest = canonicalSha256(snapshot(output));
    const existing = this.load(runId);
    const existingNode = existing?.nodes[nodeId];
    if (existingNode?.status === NODE_STATES.SUCCEEDED) {
      if (existingNode.outputDigest !== outputDigest || canonicalSha256(existingNode.artifactRefs) !== canonicalSha256(refs)) {
        fail(`node success conflicts with durable result: ${nodeId}`, 'NODE_SUCCESS_CONFLICT');
      }
      this.#publishNodeSucceeded(existing, nodeId);
      return existing;
    }
    const succeeded = this.#mutateNode(runId, nodeId, (node) => {
      if (node.status !== NODE_STATES.RUNNING) fail(`node is not running: ${nodeId}`, 'NODE_NOT_RUNNING');
      return transitionNodeState(node, NODE_STATES.SUCCEEDED, {
        artifactRefs: refs,
        outputDigest,
        stopReason: 'final',
        completedAt: this.now(),
        lastFailure: node.lastFailure,
        imported,
      });
    });
    this.#publishNodeSucceeded(succeeded, nodeId);
    return succeeded;
  }

  reconcileSucceededNode(runId, nodeId, { artifactRefs = [], output, pureReturn = false, attempt = 1 } = {}) {
    const refs = artifactRefs.map((ref) => createArtifactRef(ref));
    if (!pureReturn && refs.length === 0) fail(`reconciled node requires ArtifactRefs: ${nodeId}`, 'NODE_ARTIFACTS_REQUIRED');
    const reconciled = this.#mutateNode(runId, nodeId, (node) => {
      if (node.status === NODE_STATES.SUCCEEDED) return node;
      const now = this.now();
      return {
        ...node,
        status: NODE_STATES.SUCCEEDED,
        attempt: Math.max(node.attempt, attempt),
        inputDigest: node.inputDigest || canonicalSha256({ runId, nodeId, imported: true }),
        outputDigest: canonicalSha256(snapshot(output)),
        stopReason: 'final',
        artifactRefs: refs,
        startedAt: node.startedAt || now,
        completedAt: now,
        imported: true,
      };
    });
    this.#publishNodeSucceeded(reconciled, nodeId);
    return reconciled;
  }

  failNode(runId, nodeId, classification, error) {
    if (!classification?.state) throw new TypeError('failure classification is required');
    const failed = this.#mutateNode(runId, nodeId, (node) => {
      const now = this.now();
      const failed = transitionNodeState(node, classification.state, {
        stopReason: classification.reason,
        completedAt: now,
        lastFailure: {
          category: classification.category,
          reason: classification.reason,
          code: error?.code || null,
          message: String(error?.message || error || '').slice(0, 500),
          at: now,
        },
      });
      return failed;
    }, (record) => ({
      ...record,
      status: classification.state === NODE_STATES.CANCELLED ? RUN_STATUSES.CANCELLED : RUN_STATUSES.FAILED,
      stopReason: classification.reason,
      completedAt: record.nodes[nodeId].completedAt,
    }));
    const nodeEvent = this.#publishNodeFailed(failed, nodeId, {
      status: failed.nodes[nodeId].status,
      attempt: failed.nodes[nodeId].attempt,
      stopReason: failed.nodes[nodeId].stopReason,
      failure: failed.nodes[nodeId].lastFailure,
      causationId: this.#latestCause(runId, nodeId),
    });
    this.#publishRunTerminal(
      failed,
      classification.state === NODE_STATES.CANCELLED
        ? DURABLE_EVENT_TYPES.RUN_CANCELLED
        : DURABLE_EVENT_TYPES.RUN_FAILED,
      { nodeId, attempt: failed.nodes[nodeId].attempt, status: classification.state },
      nodeEvent.eventId,
    );
    return failed;
  }

  retryNode(runId, nodeId) {
    const retried = this.#mutateNode(runId, nodeId, (node) => transitionNodeState(node, NODE_STATES.READY, { completedAt: null }), (record) => ({
      ...record,
      status: RUN_STATUSES.RUNNING,
      stopReason: null,
      resumeCount: (record.resumeCount || 0) + 1,
      completedAt: null,
    }));
    const resumed = this.#publishRunResumed(retried, {
      reason: 'retry',
      identity: { nodeId, nextAttempt: retried.nodes[nodeId].attempt + 1 },
      causationId: this.#latestCause(runId, nodeId),
      extraPayload: { nodeId },
    });
    this.#publishNodeReady(retried, nodeId, resumed.eventId);
    return retried;
  }

  invalidateNodes(runId, nodeIds, {
    reason = 'review-remediation', cycle, owners = [], openIssues = [],
  } = {}) {
    if (!Array.isArray(nodeIds) || !nodeIds.length) throw new TypeError('nodeIds must be a non-empty array');
    if (new Set(nodeIds).size !== nodeIds.length) throw new TypeError('nodeIds must be unique');
    nodeIds.forEach((nodeId) => assertSafeIdentity(nodeId, 'nodeId'));
    if (!Number.isInteger(cycle) || cycle < 1) throw new TypeError('remediation cycle must be a positive integer');
    if (!Array.isArray(owners) || !owners.length || owners.some((owner) => typeof owner !== 'string' || !owner)) {
      throw new TypeError('remediation owners must be a non-empty string array');
    }
    if (!Array.isArray(openIssues)) throw new TypeError('openIssues must be an array');
    const issueSnapshot = snapshot(openIssues);
    const existing = this.load(runId);
    if (!existing) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    for (const nodeId of nodeIds) {
      const current = existing.nodes[nodeId];
      if (!current) fail(`unknown run node: ${nodeId}`, 'UNKNOWN_RUN_NODE');
      if (current.status === NODE_STATES.RUNNING) fail(`cannot invalidate running node: ${nodeId}`, 'NODE_RUNNING');
    }
    const invalidated = this.#mutate(runId, (record) => {
      const now = this.now();
      const nodes = { ...record.nodes };
      const priorNodes = {};
      for (const nodeId of nodeIds) {
        const current = nodes[nodeId];
        priorNodes[nodeId] = snapshot(current);
        nodes[nodeId] = {
          ...current,
          status: NODE_STATES.PENDING,
          inputDigest: null,
          outputDigest: null,
          stopReason: null,
          artifactRefs: [],
          startedAt: null,
          completedAt: null,
          lastFailure: null,
          imported: false,
        };
      }
      const entry = {
        cycle,
        reason,
        owners: [...owners],
        nodeIds: [...nodeIds],
        openIssues: issueSnapshot,
        priorNodes,
        invalidatedAt: now,
      };
      const history = [...(record.remediationHistory || []).filter((item) => item.cycle !== cycle), entry]
        .sort((a, b) => a.cycle - b.cycle);
      return {
        ...record,
        nodes,
        status: RUN_STATUSES.RUNNING,
        stopReason: null,
        remediationCycle: cycle,
        remediationHistory: history,
        openIssues: issueSnapshot,
        completedAt: null,
      };
    });
    const remediationEvent = this.#publishRunRemediationStarted(invalidated, {
      cycle, owners, nodeIds, openIssues: issueSnapshot,
    });
    let causationId = remediationEvent.eventId;
    for (const nodeId of nodeIds) {
      const event = this.#publishNodeInvalidated(invalidated, nodeId, {
        reason, cycle, owners, openIssueIds: issueSnapshot.map((issue) => issue?.id).filter(Boolean), causationId,
      });
      causationId = event.eventId;
    }
    return invalidated;
  }

  blockRun(runId, { reason = 'human-review', openIssues = [] } = {}) {
    if (!Array.isArray(openIssues)) throw new TypeError('openIssues must be an array');
    const issueSnapshot = snapshot(openIssues);
    const before = this.load(runId);
    if (!before) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    if (
      before.status === RUN_STATUSES.BLOCKED
      && before.stopReason === reason
      && canonicalSha256(before.openIssues || []) === canonicalSha256(issueSnapshot)
    ) {
      this.#publishRunTerminal(before, DURABLE_EVENT_TYPES.RUN_BLOCKED, {
        reason,
        reviewBlockCount: before.reviewBlockCount || 1,
        blockedStateDigest: before.blockedStateDigest,
        openIssueIds: issueSnapshot.map((issue) => issue?.id).filter(Boolean),
      }, this.#latestCause(runId));
      return before;
    }
    const blocked = this.#mutate(runId, (record) => {
      const now = this.now();
      const nodes = Object.fromEntries(Object.entries(record.nodes).map(([nodeId, current]) => {
        if ([NODE_STATES.PENDING, NODE_STATES.READY].includes(current.status)) {
          return [nodeId, {
            ...current,
            status: NODE_STATES.BLOCKED,
            stopReason: reason,
            completedAt: now,
            lastFailure: { category: 'business', reason, code: null, message: reason, at: now },
          }];
        }
        return [nodeId, current];
      }));
      const reviewBlockCount = (record.reviewBlockCount || 0) + 1;
      const blockedStateDigest = canonicalSha256({
        runId: record.runId,
        workflowSpec: record.workflowSpec,
        remediationCycle: record.remediationCycle || 0,
        reviewBlockCount,
        openIssues: issueSnapshot,
        nodes: Object.fromEntries(Object.entries(nodes).map(([nodeId, node]) => [nodeId, {
          status: node.status,
          attempt: node.attempt,
          inputDigest: node.inputDigest,
          outputDigest: node.outputDigest,
          artifactRefs: node.artifactRefs,
        }])),
      });
      return {
        ...record,
        nodes,
        status: RUN_STATUSES.BLOCKED,
        stopReason: reason,
        openIssues: issueSnapshot,
        reviewBlockCount,
        blockedStateDigest,
        completedAt: now,
      };
    });
    let causationId = this.#latestCause(runId);
    for (const [nodeId, current] of Object.entries(before.nodes)) {
      if (![NODE_STATES.PENDING, NODE_STATES.READY].includes(current.status)) continue;
      const event = this.#publishNodeFailed(blocked, nodeId, {
        status: NODE_STATES.BLOCKED,
        attempt: current.attempt,
        stopReason: reason,
        failure: blocked.nodes[nodeId].lastFailure,
        causationId: this.#latestCause(runId, nodeId) || causationId,
      });
      causationId = event.eventId;
    }
    this.#publishRunTerminal(blocked, DURABLE_EVENT_TYPES.RUN_BLOCKED, {
      reason,
      reviewBlockCount: blocked.reviewBlockCount,
      blockedStateDigest: blocked.blockedStateDigest,
      openIssueIds: issueSnapshot.map((issue) => issue?.id).filter(Boolean),
    }, causationId);
    return blocked;
  }

  resumeFromHumanReview(runId, {
    expectedBlockedStateDigest,
    taskId,
    taskVersion,
    decisionId,
    decisionRef,
    decisionDigest,
    selectedAction,
    downgradeInstruction = null,
    humanReviewAttempt,
    reviewRound,
    owners = [],
    rerunNodeIds = [],
    reopenNodeIds = [],
    openIssues = [],
    reason = 'human-review-resume',
  } = {}) {
    assertDigest(expectedBlockedStateDigest, 'expectedBlockedStateDigest');
    assertSafeIdentity(taskId, 'taskId');
    if (!Number.isInteger(taskVersion) || taskVersion < 1) throw new TypeError('taskVersion must be a positive integer');
    assertSafeIdentity(decisionId, 'decisionId');
    if (!validateArtifactRef(decisionRef).valid) throw new TypeError('decisionRef must be a valid ArtifactRef');
    assertDigest(decisionDigest, 'decisionDigest');
    assertSafeIdentity(selectedAction, 'selectedAction');
    if (
      downgradeInstruction !== null
      && (
        typeof downgradeInstruction !== 'object'
        || Array.isArray(downgradeInstruction)
      )
    ) throw new TypeError('downgradeInstruction must be null or an object');
    if (!Number.isInteger(humanReviewAttempt) || humanReviewAttempt < 1) {
      throw new TypeError('humanReviewAttempt must be a positive integer');
    }
    if (!Number.isInteger(reviewRound) || reviewRound < 1) throw new TypeError('reviewRound must be a positive integer');
    if (!Array.isArray(owners) || owners.length === 0 || owners.some((owner) => typeof owner !== 'string' || !owner)) {
      throw new TypeError('owners must be a non-empty string array');
    }
    if (!Array.isArray(rerunNodeIds) || rerunNodeIds.length === 0) {
      throw new TypeError('rerunNodeIds must be a non-empty array');
    }
    if (!Array.isArray(reopenNodeIds)) throw new TypeError('reopenNodeIds must be an array');
    const selectedNodeIds = [...rerunNodeIds, ...reopenNodeIds];
    if (new Set(selectedNodeIds).size !== selectedNodeIds.length) {
      throw new TypeError('rerunNodeIds and reopenNodeIds must be unique and disjoint');
    }
    selectedNodeIds.forEach((nodeId) => assertSafeIdentity(nodeId, 'nodeId'));
    if (!Array.isArray(openIssues)) throw new TypeError('openIssues must be an array');
    const issueSnapshot = snapshot(openIssues);
    const fingerprint = canonicalSha256({
      expectedBlockedStateDigest,
      taskId,
      taskVersion,
      decisionId,
      decisionRef,
      decisionDigest,
      selectedAction,
      downgradeInstruction,
      humanReviewAttempt,
      reviewRound,
      owners,
      rerunNodeIds,
      reopenNodeIds,
      openIssues: issueSnapshot,
      reason,
    });

    const existing = this.load(runId);
    if (!existing) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    const priorEntry = (existing.humanReviewHistory || [])
      .find((entry) => entry.decisionId === decisionId);
    if (priorEntry) {
      if (priorEntry.kind !== 'resume' || priorEntry.fingerprint !== fingerprint) {
        fail('human review transition conflicts with durable history', 'HUMAN_REVIEW_TRANSITION_CONFLICT');
      }
      this.#publishHumanReviewResume(existing, priorEntry);
      return existing;
    }

    const resumed = this.#mutate(runId, (record) => {
      if (record.status !== RUN_STATUSES.BLOCKED || record.stopReason !== 'human-review') {
        fail(`run is not blocked for human review: ${runId}`, 'RUN_NOT_REVIEW_BLOCKED');
      }
      if (record.blockedStateDigest !== expectedBlockedStateDigest) {
        fail('blocked run state changed before reviewed resume', 'HUMAN_REVIEW_BLOCKED_STATE_STALE');
      }
      if ((record.humanReviewAttempt || 0) + 1 !== humanReviewAttempt) {
        fail('human review attempt is stale', 'HUMAN_REVIEW_ATTEMPT_STALE');
      }
      const nodes = { ...record.nodes };
      const priorNodes = {};
      for (const nodeId of rerunNodeIds) {
        const current = nodes[nodeId];
        if (!current) fail(`unknown run node: ${nodeId}`, 'UNKNOWN_RUN_NODE');
        if (current.status === NODE_STATES.RUNNING) fail(`cannot invalidate running node: ${nodeId}`, 'NODE_RUNNING');
        priorNodes[nodeId] = snapshot(current);
        nodes[nodeId] = {
          ...current,
          status: NODE_STATES.PENDING,
          inputDigest: null,
          outputDigest: null,
          stopReason: null,
          artifactRefs: [],
          startedAt: null,
          completedAt: null,
          lastFailure: null,
          imported: false,
        };
      }
      for (const nodeId of reopenNodeIds) {
        const current = nodes[nodeId];
        if (!current) fail(`unknown run node: ${nodeId}`, 'UNKNOWN_RUN_NODE');
        if (current.status !== NODE_STATES.BLOCKED || current.artifactRefs.length > 0) {
          fail(`node is not an empty blocked downstream node: ${nodeId}`, 'NODE_NOT_REVIEW_BLOCKED');
        }
        priorNodes[nodeId] = snapshot(current);
        nodes[nodeId] = {
          ...current,
          status: NODE_STATES.PENDING,
          inputDigest: null,
          outputDigest: null,
          stopReason: null,
          artifactRefs: [],
          startedAt: null,
          completedAt: null,
          lastFailure: null,
          imported: false,
        };
      }
      const entry = {
        kind: 'resume',
        fingerprint,
        taskId,
        taskVersion,
        decisionId,
        decisionRef: createArtifactRef(decisionRef),
        decisionDigest,
        selectedAction,
        downgradeInstruction: snapshot(downgradeInstruction),
        humanReviewAttempt,
        reviewRound,
        reason,
        owners: [...owners],
        rerunNodeIds: [...rerunNodeIds],
        reopenNodeIds: [...reopenNodeIds],
        openIssues: issueSnapshot,
        priorNodes,
        automaticRemediationCycle: record.remediationCycle || 0,
        blockedStateDigest: record.blockedStateDigest,
        resumedAt: this.now(),
      };
      return {
        ...record,
        nodes,
        status: RUN_STATUSES.RUNNING,
        stopReason: null,
        openIssues: issueSnapshot,
        blockedStateDigest: null,
        resumeCount: (record.resumeCount || 0) + 1,
        humanReviewAttempt,
        humanReviewHistory: [...(record.humanReviewHistory || []), entry],
        completedAt: null,
      };
    });
    const entry = resumed.humanReviewHistory.find((candidate) => candidate.decisionId === decisionId);
    this.#publishHumanReviewResume(resumed, entry);
    return resumed;
  }

  terminateFromHumanReview(runId, {
    expectedBlockedStateDigest,
    taskId,
    taskVersion,
    decisionId,
    decisionRef,
    decisionDigest,
    selectedAction = 'terminate',
    reason = 'human-review-terminated',
  } = {}) {
    assertDigest(expectedBlockedStateDigest, 'expectedBlockedStateDigest');
    assertSafeIdentity(taskId, 'taskId');
    if (!Number.isInteger(taskVersion) || taskVersion < 1) throw new TypeError('taskVersion must be a positive integer');
    assertSafeIdentity(decisionId, 'decisionId');
    if (!validateArtifactRef(decisionRef).valid) throw new TypeError('decisionRef must be a valid ArtifactRef');
    assertDigest(decisionDigest, 'decisionDigest');
    if (selectedAction !== 'terminate') throw new TypeError('selectedAction must be terminate');
    const fingerprint = canonicalSha256({
      expectedBlockedStateDigest,
      taskId,
      taskVersion,
      decisionId,
      decisionRef,
      decisionDigest,
      selectedAction,
      reason,
    });
    const before = this.load(runId);
    if (!before) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    const priorEntry = (before.humanReviewHistory || []).find((entry) => entry.decisionId === decisionId);
    if (priorEntry) {
      if (priorEntry.kind !== 'terminate' || priorEntry.fingerprint !== fingerprint) {
        fail('human review termination conflicts with durable history', 'HUMAN_REVIEW_TRANSITION_CONFLICT');
      }
      this.#publishHumanReviewTermination(before, priorEntry);
      return before;
    }
    const terminated = this.#mutate(runId, (record) => {
      if (record.status !== RUN_STATUSES.BLOCKED || record.stopReason !== 'human-review') {
        fail(`run is not blocked for human review: ${runId}`, 'RUN_NOT_REVIEW_BLOCKED');
      }
      if (record.blockedStateDigest !== expectedBlockedStateDigest) {
        fail('blocked run state changed before termination', 'HUMAN_REVIEW_BLOCKED_STATE_STALE');
      }
      const now = this.now();
      const nodes = { ...record.nodes };
      const terminatedNodeIds = [];
      for (const [nodeId, current] of Object.entries(nodes)) {
        if (current.status !== NODE_STATES.BLOCKED) continue;
        terminatedNodeIds.push(nodeId);
        nodes[nodeId] = transitionNodeState(current, NODE_STATES.CANCELLED, {
          stopReason: reason,
          completedAt: now,
          lastFailure: {
            category: 'cancelled',
            reason,
            code: null,
            message: reason,
            at: now,
          },
        });
      }
      const entry = {
        kind: 'terminate',
        fingerprint,
        taskId,
        taskVersion,
        decisionId,
        decisionRef: createArtifactRef(decisionRef),
        decisionDigest,
        selectedAction,
        reason,
        blockedStateDigest: record.blockedStateDigest,
        automaticRemediationCycle: record.remediationCycle || 0,
        terminatedNodeIds,
        terminatedAt: now,
      };
      return {
        ...record,
        nodes,
        status: RUN_STATUSES.CANCELLED,
        stopReason: reason,
        blockedStateDigest: null,
        humanReviewHistory: [...(record.humanReviewHistory || []), entry],
        completedAt: now,
      };
    });
    const entry = terminated.humanReviewHistory.find((candidate) => candidate.decisionId === decisionId);
    this.#publishHumanReviewTermination(terminated, entry);
    return terminated;
  }

  completeRun(runId) {
    const existing = this.load(runId);
    if (existing?.status === RUN_STATUSES.SUCCEEDED) {
      this.#publishRunTerminal(existing, DURABLE_EVENT_TYPES.RUN_SUCCEEDED, { completedAt: existing.completedAt }, this.#latestCause(runId));
      return existing;
    }
    const completed = this.#mutate(runId, (record) => {
      const incomplete = Object.values(record.nodes).filter((node) => node.status !== NODE_STATES.SUCCEEDED);
      if (incomplete.length) fail(`run has incomplete nodes: ${incomplete.map((node) => node.nodeId).join(', ')}`, 'RUN_INCOMPLETE');
      const now = this.now();
      return { ...record, status: RUN_STATUSES.SUCCEEDED, stopReason: 'final', openIssues: [], completedAt: now };
    });
    this.#publishRunTerminal(completed, DURABLE_EVENT_TYPES.RUN_SUCCEEDED, { completedAt: completed.completedAt }, this.#latestCause(runId));
    return completed;
  }

  cancelRun(runId, reason = 'cancelled') {
    const before = this.load(runId);
    if (!before) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
    const cancelled = this.#mutate(runId, (record) => {
      const now = this.now();
      const nodes = Object.fromEntries(Object.entries(record.nodes).map(([nodeId, current]) => {
        if ([NODE_STATES.PENDING, NODE_STATES.READY, NODE_STATES.RUNNING].includes(current.status)) {
          return [nodeId, { ...current, status: NODE_STATES.CANCELLED, stopReason: reason, completedAt: now }];
        }
        return [nodeId, current];
      }));
      return { ...record, nodes, status: RUN_STATUSES.CANCELLED, stopReason: reason, completedAt: now };
    });
    let causationId = this.#latestCause(runId);
    for (const [nodeId, node] of Object.entries(before.nodes)) {
      if (![NODE_STATES.PENDING, NODE_STATES.READY, NODE_STATES.RUNNING].includes(node.status)) continue;
      const nodeEvent = this.#publishNodeFailed(cancelled, nodeId, {
        status: NODE_STATES.CANCELLED,
        attempt: node.attempt,
        stopReason: reason,
        failure: { category: 'cancelled', reason, code: null, message: reason, at: cancelled.completedAt },
        causationId: this.#latestCause(runId, nodeId) || causationId,
      });
      causationId = nodeEvent.eventId;
    }
    this.#publishRunTerminal(cancelled, DURABLE_EVENT_TYPES.RUN_CANCELLED, { reason }, causationId);
    return cancelled;
  }

  #publishRunStarted(record) {
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.RUN_STARTED,
      identity: { projectId: this.projectId, runId: record.runId },
      runId: record.runId,
      nodeId: null,
      causationId: null,
      payload: {
        status: RUN_STATUSES.RUNNING,
        workflowSpec: record.workflowSpec,
        inputDigest: record.inputDigest,
        asOf: record.asOf,
        ...(record.scope ? {
          scope: record.scope,
          workspaceMode: record.workspaceMode,
          workspaceSnapshotId: record.workspaceSnapshotId,
        } : {}),
      },
    });
  }

  #publishRunResumed(record, { reason, identity, causationId, extraPayload = {} }) {
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.RUN_RESUMED,
      identity: { runId: record.runId, ...identity },
      runId: record.runId,
      nodeId: null,
      causationId,
      payload: {
        status: RUN_STATUSES.RUNNING,
        reason,
        resumeCount: record.resumeCount || 1,
        ...extraPayload,
      },
    });
  }

  #publishRunRemediationStarted(record, { cycle, owners, nodeIds, openIssues }) {
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.RUN_REMEDIATION_STARTED,
      identity: { runId: record.runId, cycle },
      runId: record.runId,
      nodeId: null,
      causationId: this.#latestCause(record.runId),
      payload: {
        status: RUN_STATUSES.RUNNING,
        cycle,
        owners: [...owners],
        nodeIds: [...nodeIds],
        openIssues: snapshot(openIssues),
      },
    });
  }

  #publishRunTerminal(record, eventType, identity, causationId) {
    return this.#publishEvent({
      eventType,
      identity: {
        runId: record.runId,
        ...(eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED ? {
          reviewBlockCount: record.reviewBlockCount || identity.reviewBlockCount || 1,
          blockedStateDigest: record.blockedStateDigest || identity.blockedStateDigest,
        } : {}),
        ...identity,
      },
      runId: record.runId,
      nodeId: null,
      causationId,
      payload: {
        status: record.status,
        stopReason: record.stopReason,
        ...(eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED ? {
          openIssues: snapshot(record.openIssues || []),
          reviewBlockCount: record.reviewBlockCount || 1,
          blockedStateDigest: record.blockedStateDigest,
        } : {}),
      },
    });
  }

  #publishHumanReviewResume(record, entry) {
    const resumeEvent = this.#publishRunResumed(record, {
      reason: entry.reason,
      identity: {
        humanReviewAttempt: entry.humanReviewAttempt,
        decisionId: entry.decisionId,
      },
      causationId: this.#latestCause(record.runId),
      extraPayload: {
        taskId: entry.taskId,
        decisionId: entry.decisionId,
        humanReviewAttempt: entry.humanReviewAttempt,
        reviewRound: entry.reviewRound,
        decisionDigest: entry.decisionDigest,
        selectedAction: entry.selectedAction,
        owners: [...entry.owners],
        rerunNodeIds: [...entry.rerunNodeIds],
        reopenNodeIds: [...entry.reopenNodeIds],
      },
    });
    let causationId = resumeEvent.eventId;
    for (const [mode, nodeIds] of [
      ['rerun', entry.rerunNodeIds],
      ['reopen', entry.reopenNodeIds],
    ]) {
      for (const nodeId of nodeIds) {
        const node = record.nodes[nodeId];
        const eventId = durableEventId(DURABLE_EVENT_TYPES.NODE_HUMAN_REVIEW_INVALIDATED, {
          runId: record.runId,
          nodeId,
          humanReviewAttempt: entry.humanReviewAttempt,
          decisionId: entry.decisionId,
          mode,
        });
        const existing = this.eventBus.get(eventId);
        const event = existing || this.eventBus.publish({
          eventId,
          eventType: DURABLE_EVENT_TYPES.NODE_HUMAN_REVIEW_INVALIDATED,
          correlationId: record.runId,
          causationId,
          runId: record.runId,
          nodeId,
          payload: {
            status: NODE_STATES.PENDING,
            attempt: node.attempt,
            reason: entry.reason,
            humanReviewAttempt: entry.humanReviewAttempt,
            taskId: entry.taskId,
            decisionId: entry.decisionId,
            mode,
            owners: [...entry.owners],
            openIssueIds: entry.openIssues.map((issue) => issue?.id).filter(Boolean),
          },
        });
        causationId = event.eventId;
      }
    }
    return record;
  }

  #publishHumanReviewTermination(record, entry) {
    let causationId = this.#latestCause(record.runId);
    for (const nodeId of entry.terminatedNodeIds) {
      const node = record.nodes[nodeId];
      const event = this.#publishNodeFailed(record, nodeId, {
        status: NODE_STATES.CANCELLED,
        attempt: node.attempt,
        stopReason: entry.reason,
        failure: node.lastFailure,
        causationId,
      });
      causationId = event.eventId;
    }
    this.#publishRunTerminal(record, DURABLE_EVENT_TYPES.RUN_CANCELLED, {
      reason: entry.reason,
      taskId: entry.taskId,
      decisionId: entry.decisionId,
    }, causationId);
    return record;
  }

  #publishNodeReady(record, nodeId, causationId) {
    const node = record.nodes[nodeId];
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.NODE_READY,
      identity: { runId: record.runId, nodeId, nextAttempt: node.attempt + 1 },
      runId: record.runId,
      nodeId,
      causationId,
      payload: { status: NODE_STATES.READY, attempt: node.attempt, nextAttempt: node.attempt + 1 },
    });
  }

  #publishNodeStarted(record, nodeId, causationId) {
    const node = record.nodes[nodeId];
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.NODE_STARTED,
      identity: { runId: record.runId, nodeId, attempt: node.attempt },
      runId: record.runId,
      nodeId,
      causationId,
      payload: { status: NODE_STATES.RUNNING, attempt: node.attempt, inputDigest: node.inputDigest },
    });
  }

  #publishNodeSucceeded(record, nodeId) {
    const node = record.nodes[nodeId];
    const artifactCause = this.eventBus.latest({
      runId: record.runId,
      nodeId,
      eventTypes: [DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED],
    });
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.NODE_SUCCEEDED,
      identity: { runId: record.runId, nodeId, attempt: node.attempt, outputDigest: node.outputDigest },
      runId: record.runId,
      nodeId,
      causationId: artifactCause?.eventId || this.#latestCause(record.runId, nodeId),
      payload: {
        status: NODE_STATES.SUCCEEDED,
        attempt: node.attempt,
        outputDigest: node.outputDigest,
        artifactRefs: node.artifactRefs,
        stopReason: node.stopReason,
        imported: node.imported,
      },
    });
  }

  #publishNodeFailed(record, nodeId, { status, attempt, stopReason, failure, causationId }) {
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.NODE_FAILED,
      identity: { runId: record.runId, nodeId, attempt, status, stopReason },
      runId: record.runId,
      nodeId,
      causationId,
      payload: { status, attempt, stopReason, failure: failure || null },
    });
  }

  #publishNodeInvalidated(record, nodeId, { reason, cycle, owners, openIssueIds, causationId }) {
    const node = record.nodes[nodeId];
    return this.#publishEvent({
      eventType: DURABLE_EVENT_TYPES.NODE_INVALIDATED,
      identity: { runId: record.runId, nodeId, cycle, attempt: node.attempt },
      runId: record.runId,
      nodeId,
      causationId,
      payload: {
        status: NODE_STATES.PENDING,
        attempt: node.attempt,
        reason,
        cycle,
        owners: [...owners],
        openIssueIds: [...openIssueIds],
      },
    });
  }

  #publishEvent({ eventType, identity, runId, nodeId, causationId, payload }) {
    const eventId = durableEventId(eventType, identity);
    const existing = this.eventBus.get(eventId);
    // The outbox is authoritative when rebuilding a deleted/legacy RunStore from
    // an existing checkpoint and manifest. Reuse its durable transition instead
    // of attempting to rewrite historical payload details such as imported=true.
    if (existing) return existing;
    return this.eventBus.publish({
      eventId,
      eventType,
      correlationId: runId,
      causationId: causationId ?? null,
      runId,
      nodeId,
      payload,
    });
  }

  #latestCause(runId, nodeId = undefined) {
    return this.eventBus.latest({ runId, nodeId })?.eventId || null;
  }

  #mutateNode(runId, nodeId, mutateNode, mutateRun = (record) => record) {
    assertSafeIdentity(nodeId, 'nodeId');
    return this.#mutate(runId, (record) => {
      const current = record.nodes[nodeId];
      if (!current) fail(`unknown run node: ${nodeId}`, 'UNKNOWN_RUN_NODE');
      const node = mutateNode({ ...current });
      return mutateRun({ ...record, nodes: { ...record.nodes, [nodeId]: node } });
    });
  }

  #mutate(runId, mutate) {
    this.#ensureStorageTree({ create: true });
    const lockPath = this.#lockPath(runId);
    assertStorageLockBoundary(lockPath, `RunStore lock ${runId}`);
    return withFileLockSync(lockPath, () => {
      const current = this.load(runId);
      if (!current) fail(`run not found: ${runId}`, 'RUN_NOT_FOUND');
      const next = mutate(structuredClone(current));
      next.updatedAt = this.now();
      this.#write(next);
      return this.load(runId);
    });
  }

  #write(record) {
    validateRunRecord(record, this.projectId);
    this.#ensureStorageTree({ create: true });
    atomicWriteJSON(this.#file(record.runId), record);
  }

  #ensureStorageTree({ create }) {
    if (this.directStorageDir) {
      resolveDirectStorageDirectory(this.storageDir, 'RunStore storageDir');
    } else if (!ensureOwnedStorageDirectory(this.storageDir, 'RunStore storage directory', {
      create,
      recursive: true,
    })) {
      return false;
    }
    if (!ensureOwnedStorageDirectory(this.rootDir, 'RunStore hidden root', { create })) return false;
    if (create) return ensureOwnedStorageDirectory(this.lockRoot, 'RunStore lock root', { create: true });
    ensureOwnedStorageDirectory(this.lockRoot, 'RunStore lock root', { create: false });
    return true;
  }

  #lockPath(runId) {
    const digest = crypto.createHash('sha256').update(runId).digest('hex');
    return path.join(this.lockRoot, `run-${digest}.lock`);
  }

  #file(runId) {
    const digest = crypto.createHash('sha256').update(runId).digest('hex');
    return path.join(this.rootDir, `run-${digest}.json`);
  }
}
