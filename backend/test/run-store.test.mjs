import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import {
  FileRunStore,
  RUN_STATUSES,
  RUN_STORE_SCOPE,
} from '../src/project-space/RunStore.js';

const digest = (char) => `sha256:${char.repeat(64)}`;
const ref = createArtifactRef({
  artifactId: 'proj_test:analysis/plan.json',
  version: 1,
  path: 'analysis/plan.json',
  contentDigest: digest('a'),
  schemaVersion: 'analysis-plan.output.v1',
  producer: 'analysis-plan',
  contractVersion: '1.0.0',
  inputDigest: digest('b'),
  createdAt: '2026-07-16T00:00:00.000Z',
  asOf: '2026-07-16T00:00:00.000Z',
});

function fixture(t) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-run-store-'));
  fs.mkdirSync(path.join(projectsDir, 'proj_test'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  let tick = 0;
  const store = new FileRunStore({
    projectId: 'proj_test',
    projectsDir,
    now: () => new Date(Date.UTC(2026, 6, 16, 0, 0, tick++)).toISOString(),
  });
  const run = store.begin({
    runId: 'artifact-run-proj_test-1',
    workflowSpec: { id: 'run-analysis.v1', version: '1.0.0', hash: digest('c') },
    inputDigest: digest('d'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['initialize-checkpoint', 'plan-research'],
  });
  return { store, run, projectsDir };
}

test('RunStore persists node identity, attempts, digests, stop reasons, and ArtifactRefs', (t) => {
  const { store, run } = fixture(t);
  assert.equal(run.storeScope, RUN_STORE_SCOPE);
  assert.equal(run.status, RUN_STATUSES.RUNNING);
  assert.equal(run.nodes['plan-research'].status, NODE_STATES.PENDING);
  assert.equal(Object.hasOwn(run, 'scope'), false);
  assert.equal(Object.hasOwn(run, 'workspaceMode'), false);
  assert.equal(Object.hasOwn(run, 'workspaceSnapshotId'), false);

  store.markReady(run.runId, 'initialize-checkpoint');
  store.startNode(run.runId, 'initialize-checkpoint', digest('e'));
  store.succeedNode(run.runId, 'initialize-checkpoint', { pureReturn: true, output: { initialized: true } });
  store.markReady(run.runId, 'plan-research');
  store.startNode(run.runId, 'plan-research', digest('f'));
  const completed = store.succeedNode(run.runId, 'plan-research', { artifactRefs: [ref], output: { logic: 'supply' } });

  assert.equal(completed.nodes['plan-research'].attempt, 1);
  assert.equal(completed.nodes['plan-research'].inputDigest, digest('f'));
  assert.match(completed.nodes['plan-research'].outputDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(completed.nodes['plan-research'].stopReason, 'final');
  assert.deepEqual(completed.nodes['plan-research'].artifactRefs, [ref]);
  assert.equal(store.completeRun(run.runId).status, RUN_STATUSES.SUCCEEDED);
  assert.equal(store.resumable(), null);
});

test('RunStore reconciles process termination and increments only the interrupted node attempt', (t) => {
  const { store, run } = fixture(t);
  store.markReady(run.runId, 'initialize-checkpoint');
  store.startNode(run.runId, 'initialize-checkpoint', digest('e'));
  store.succeedNode(run.runId, 'initialize-checkpoint', { pureReturn: true, output: {} });
  store.markReady(run.runId, 'plan-research');
  store.startNode(run.runId, 'plan-research', digest('f'));

  const resumed = store.prepareResume(run.runId);
  assert.equal(resumed.nodes['initialize-checkpoint'].status, NODE_STATES.SUCCEEDED);
  assert.equal(resumed.nodes['initialize-checkpoint'].attempt, 1);
  assert.equal(resumed.nodes['plan-research'].status, NODE_STATES.READY);
  assert.equal(resumed.nodes['plan-research'].attempt, 1);
  assert.equal(resumed.nodes['plan-research'].stopReason, 'process-interrupted');

  const restarted = store.startNode(run.runId, 'plan-research', digest('f'));
  assert.equal(restarted.nodes['plan-research'].attempt, 2);
  assert.throws(() => store.startNode(run.runId, 'plan-research', digest('0')), /node is not ready|input changed/u);
});

test('RunStore records classified failures and only explicit resume reopens terminal node states', (t) => {
  const { store, run } = fixture(t);
  store.markReady(run.runId, 'initialize-checkpoint');
  store.startNode(run.runId, 'initialize-checkpoint', digest('e'));
  store.failNode(run.runId, 'initialize-checkpoint', {
    state: NODE_STATES.FAILED_PERMISSION,
    category: 'permission',
    reason: 'TOOL_PERMISSION_DENIED',
  }, Object.assign(new Error('denied'), { code: 'TOOL_PERMISSION_DENIED' }));

  const failed = store.load(run.runId);
  assert.equal(failed.status, RUN_STATUSES.FAILED);
  assert.equal(failed.completedAt, failed.nodes['initialize-checkpoint'].completedAt);
  assert.equal(failed.nodes['initialize-checkpoint'].status, NODE_STATES.FAILED_PERMISSION);
  assert.equal(failed.nodes['initialize-checkpoint'].lastFailure.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(store.prepareResume(run.runId).nodes['initialize-checkpoint'].status, NODE_STATES.READY);
});

test('RunStore fails closed on input conflicts and success without formal artifacts', (t) => {
  const { store, run } = fixture(t);
  assert.throws(() => store.begin({
    runId: run.runId,
    workflowSpec: run.workflowSpec,
    inputDigest: digest('0'),
    asOf: run.asOf,
    nodeIds: Object.keys(run.nodes),
  }), /different input/u);
  store.markReady(run.runId, 'plan-research');
  store.startNode(run.runId, 'plan-research', digest('f'));
  assert.throws(() => store.succeedNode(run.runId, 'plan-research', { output: {} }), /requires ArtifactRefs/u);
});

test('RunStore persists non-Project scope in one validated direct storage directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-scoped-run-store-'));
  const storageDir = path.join(root, 'idea-generation', 'runs', 'idea-run-1');
  fs.mkdirSync(storageDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scopeId = 'idea-universe:local-user';
  const snapshotId = 'idea-run-input-snapshot:'.concat('1'.repeat(64));
  const store = new FileRunStore({
    projectId: scopeId,
    storageDir,
    now: () => '2026-07-23T00:00:00.000Z',
  });

  const run = store.begin({
    runId: 'idea-run-1',
    workflowSpec: { id: 'idea-generation.v2', version: '2.0.0', hash: digest('1') },
    inputDigest: digest('2'),
    asOf: '2026-07-23T00:00:00.000Z',
    nodeIds: ['collect-market-context'],
    scope: { kind: 'idea-universe', id: scopeId },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: snapshotId,
  });

  assert.deepEqual(run.scope, { kind: 'idea-universe', id: scopeId });
  assert.equal(run.workspaceMode, 'idea-run');
  assert.equal(run.workspaceSnapshotId, snapshotId);
  assert.equal(fs.existsSync(path.join(storageDir, '.runs')), true);
  assert.equal(fs.existsSync(path.join(storageDir, '.events', 'outbox')), true);
  assert.equal(fs.existsSync(path.join(root, 'projects')), false);
  const replay = store.eventBus.replay({ runId: run.runId }).runs[run.runId];
  assert.deepEqual(replay.scope, run.scope);
  assert.equal(replay.workspaceMode, 'idea-run');
  assert.equal(replay.workspaceSnapshotId, snapshotId);

  assert.throws(() => store.begin({
    runId: run.runId,
    workflowSpec: run.workflowSpec,
    inputDigest: run.inputDigest,
    asOf: run.asOf,
    nodeIds: Object.keys(run.nodes),
    scope: { kind: 'idea-universe', id: scopeId },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: `${snapshotId}:changed`,
  }), (error) => error?.code === 'RUN_SCOPE_CONFLICT');
  assert.throws(() => store.begin({
    runId: run.runId,
    workflowSpec: run.workflowSpec,
    inputDigest: run.inputDigest,
    asOf: run.asOf,
    nodeIds: Object.keys(run.nodes),
  }), (error) => error?.code === 'RUN_SCOPE_CONFLICT');
});

test('RunStore direct storage rejects missing and symlinked roots without outside writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-scoped-run-security-'));
  const missing = path.join(root, 'missing');
  const storageDir = path.join(root, 'run');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => new FileRunStore({ projectId: 'idea-universe:local-user', storageDir: missing }),
    /does not exist/u,
  );
  fs.symlinkSync(outside, path.join(storageDir, '.runs'));
  const store = new FileRunStore({
    projectId: 'idea-universe:local-user',
    storageDir,
  });
  assert.throws(() => store.begin({
    runId: 'idea-run-symlink',
    workflowSpec: { id: 'idea-generation.v2', version: '2.0.0', hash: digest('3') },
    inputDigest: digest('4'),
    asOf: '2026-07-23T00:00:00.000Z',
    nodeIds: ['collect-market-context'],
    scope: { kind: 'idea-universe', id: 'idea-universe:local-user' },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: 'idea-run-input-snapshot:symlink',
  }), /must not be a symlink/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});
