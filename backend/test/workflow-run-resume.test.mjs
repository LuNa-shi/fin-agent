import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import { currentWorkflowNodeContext } from '../src/core/workflow/WorkflowRunContext.js';
import { workflowSpecHash } from '../src/core/workflow/WorkflowSpec.js';
import { FileRunStore } from '../src/project-space/RunStore.js';
import { executeWorkflowSpec } from '../src/workflows/run-analysis/workflowExecutor.js';
import { RUN_ANALYSIS_WORKFLOW_SPEC } from '../src/workflows/run-analysis/workflowSpec.js';

const digest = (char) => `sha256:${char.repeat(64)}`;
const alwaysConditions = Object.fromEntries(
  [...new Set(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.conditionId))].map((conditionId) => [conditionId, () => true]),
);

function artifactRef(nodeId, index = 0) {
  const hex = ((RUN_ANALYSIS_WORKFLOW_SPEC.nodes.findIndex((node) => node.id === nodeId) + index + 1) % 16).toString(16);
  return createArtifactRef({
    artifactId: `proj_test:analysis/${nodeId}-${index}.json`,
    version: 1,
    path: `analysis/${nodeId}-${index}.json`,
    contentDigest: digest(hex),
    schemaVersion: `${nodeId}.output.v1`,
    producer: nodeId,
    contractVersion: '1.0.0',
    inputDigest: digest('e'),
    createdAt: '2026-07-16T00:00:00.000Z',
    asOf: '2026-07-16T00:00:00.000Z',
  });
}

function fixture(t, suffix) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), `finagent-workflow-resume-${suffix}-`));
  fs.mkdirSync(path.join(projectsDir, 'proj_test'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId: 'proj_test', projectsDir });
  const runId = `artifact-run-proj_test-${suffix}`;
  runStore.begin({
    runId,
    workflowSpec: {
      id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
      hash: workflowSpecHash(RUN_ANALYSIS_WORKFLOW_SPEC),
    },
    inputDigest: digest('d'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.id),
  });
  return { runStore, runId };
}

function bindings({ target, calls, fail = true }) {
  const handlers = {};
  const hydrators = {};
  for (const node of RUN_ANALYSIS_WORKFLOW_SPEC.nodes) {
    handlers[node.handlerId] = async () => {
      calls.executed[node.id] = (calls.executed[node.id] || 0) + 1;
      if (fail && node.id === target) {
        const error = new Error(`terminated at ${target}`);
        error.code = 'PROCESS_TERMINATED';
        throw error;
      }
      return { nodeId: node.id, executed: true };
    };
    hydrators[node.handlerId] = async () => {
      calls.hydrated[node.id] = (calls.hydrated[node.id] || 0) + 1;
      return { nodeId: node.id, hydrated: true };
    };
  }
  return { handlers, hydrators };
}

const completion = ({ node, result }) => ({
  artifacts: node.artifactPolicy === 'pure-return' ? [] : [artifactRef(node.id)],
  output: result,
});

test('each canonical node resumes without executing any previously succeeded handler', async (t) => {
  for (const target of RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.id)) {
    await t.test(target, async (st) => {
      const { runStore, runId } = fixture(st, target);
      const firstCalls = { executed: {}, hydrated: {} };
      await assert.rejects(
        executeWorkflowSpec({
          spec: RUN_ANALYSIS_WORKFLOW_SPEC,
          ...bindings({ target, calls: firstCalls, fail: true }),
          conditions: alwaysConditions,
          context: {},
          runStore,
          runId,
          retryPolicyForNode: () => ({ maxAttempts: 1, retryOn: ['transient'] }),
          onNodeComplete: completion,
        }),
        new RegExp(`terminated at ${target}`, 'u'),
      );
      const interrupted = runStore.load(runId);
      const succeededBeforeResume = Object.values(interrupted.nodes)
        .filter((node) => node.status === NODE_STATES.SUCCEEDED)
        .map((node) => node.nodeId);

      runStore.prepareResume(runId);
      const resumedCalls = { executed: {}, hydrated: {} };
      await executeWorkflowSpec({
        spec: RUN_ANALYSIS_WORKFLOW_SPEC,
        ...bindings({ target, calls: resumedCalls, fail: false }),
        conditions: alwaysConditions,
        context: {},
        runStore,
        runId,
        retryPolicyForNode: () => ({ maxAttempts: 1, retryOn: ['transient'] }),
        onNodeComplete: completion,
      });

      const completed = runStore.load(runId);
      for (const nodeId of succeededBeforeResume) {
        assert.equal(resumedCalls.executed[nodeId] || 0, 0, `${target}: ${nodeId} executed again`);
        assert.equal(completed.nodes[nodeId].attempt, 1, `${target}: ${nodeId} attempt changed`);
      }
      assert.equal(completed.nodes[target].attempt, 2, `${target}: interrupted node attempt did not increment`);
      assert.ok(Object.values(completed.nodes).every((node) => node.status === NODE_STATES.SUCCEEDED));
    });
  }
});

test('artifact-commit crash reconciliation hydrates the node instead of executing it again', async (t) => {
  const spec = {
    id: 'crash-window.v1',
    version: '1.0.0',
    nodes: [
      { id: 'initialize', handlerId: 'initialize', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' },
      { id: 'produce', handlerId: 'produce', conditionId: 'always', dependsOn: ['initialize'] },
    ],
    parallelGroups: [],
  };
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-crash-window-'));
  fs.mkdirSync(path.join(projectsDir, 'proj_test'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId: 'proj_test', projectsDir });
  const runId = 'artifact-run-proj_test-crash-window';
  runStore.begin({
    runId,
    workflowSpec: { id: spec.id, version: spec.version, hash: workflowSpecHash(spec) },
    inputDigest: digest('b'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: spec.nodes.map((node) => node.id),
  });
  let executions = 0;
  await assert.rejects(executeWorkflowSpec({
    spec,
    handlers: {
      async initialize() { return {}; },
      async produce() { executions += 1; return { produced: true }; },
    },
    hydrators: {
      async initialize() { return {}; },
      async produce() { return { produced: true }; },
    },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
    retryPolicyForNode: () => ({ maxAttempts: 1, retryOn: ['transient'] }),
    onNodeComplete: ({ node }) => {
      if (node.id === 'initialize') return [];
      const error = new Error('process died after artifact commit');
      error.code = 'PROCESS_TERMINATED';
      throw error;
    },
  }), /process died after artifact commit/u);

  runStore.reconcileSucceededNode(runId, 'produce', {
    artifactRefs: [artifactRef('plan-research')],
    output: { produced: true },
  });
  runStore.prepareResume(runId);
  await executeWorkflowSpec({
    spec,
    handlers: {
      async initialize() { executions += 100; },
      async produce() { executions += 1; },
    },
    hydrators: {
      async initialize() { return {}; },
      async produce() { return { produced: true }; },
    },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
  });
  assert.equal(executions, 1);
});

test('executor is the single bounded owner of transient node retries', async (t) => {
  const spec = {
    id: 'retry-owner.v1',
    version: '1.0.0',
    nodes: [{ id: 'only', handlerId: 'only', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' }],
    parallelGroups: [],
  };
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-retry-owner-'));
  fs.mkdirSync(path.join(projectsDir, 'proj_test'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId: 'proj_test', projectsDir });
  const runId = 'artifact-run-proj_test-retry-owner';
  runStore.begin({
    runId,
    workflowSpec: { id: spec.id, version: spec.version, hash: workflowSpecHash(spec) },
    inputDigest: digest('b'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['only'],
  });
  let calls = 0;
  const retries = [];
  await executeWorkflowSpec({
    spec,
    handlers: {
      async only() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('temporary timeout'), { code: 'ETIMEDOUT' });
        return { ok: true };
      },
    },
    hydrators: { async only() { return { ok: true }; } },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
    retryPolicyForNode: () => ({ maxAttempts: 2, retryOn: ['transient'] }),
    onNodeRetry: ({ attempt, classification }) => retries.push({ attempt, category: classification.category }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(retries, [{ attempt: 1, category: 'transient' }]);
  assert.equal(runStore.load(runId).nodes.only.attempt, 2);
  assert.equal(runStore.load(runId).nodes.only.status, NODE_STATES.SUCCEEDED);
});

test('executor binds a deterministic Workspace snapshot into every durable node attempt', async (t) => {
  const spec = {
    id: 'workspace-snapshot.v1',
    version: '1.0.0',
    nodes: [{ id: 'only', handlerId: 'only', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' }],
    parallelGroups: [],
  };
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workspace-context-'));
  fs.mkdirSync(path.join(projectsDir, 'proj_test'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId: 'proj_test', projectsDir });
  const runId = 'artifact-run-proj_test-workspace';
  runStore.begin({
    runId,
    workflowSpec: { id: spec.id, version: spec.version, hash: workflowSpecHash(spec) },
    inputDigest: digest('b'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['only'],
  });
  let received;
  await executeWorkflowSpec({
    spec,
    handlers: {
      async only() {
        received = currentWorkflowNodeContext();
        return { ok: true };
      },
    },
    hydrators: { async only() { return { ok: true }; } },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
    workspaceSnapshotForNode: () => 'workspace-snapshot:'.concat('c'.repeat(64)),
  });
  assert.equal(
    received.inputs.workspaceSnapshotId,
    'workspace-snapshot:'.concat('c'.repeat(64)),
  );
});

test('executor binds a durable Idea snapshot and rejects callback spoofing before node mutation', async (t) => {
  const spec = {
    id: 'idea-snapshot.v2',
    version: '2.0.0',
    nodes: [{ id: 'only', handlerId: 'only', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' }],
    parallelGroups: [],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-workflow-context-'));
  const storageDir = path.join(root, 'idea-run-1');
  fs.mkdirSync(storageDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scopeId = 'idea-universe:local-user';
  const snapshotId = 'idea-run-input-snapshot:'.concat('d'.repeat(64));
  const runStore = new FileRunStore({
    projectId: scopeId,
    storageDir,
  });
  const runId = 'idea-run-1';
  runStore.begin({
    runId,
    workflowSpec: { id: spec.id, version: spec.version, hash: workflowSpecHash(spec) },
    inputDigest: digest('f'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['only'],
    scope: { kind: 'idea-universe', id: scopeId },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: snapshotId,
  });

  const execution = {
    spec,
    handlers: {
      async only() {
        const context = currentWorkflowNodeContext();
        assert.deepEqual(context.run.scope, {
          kind: 'idea-universe',
          id: scopeId,
        });
        assert.equal(context.run.workspaceMode, 'idea-run');
        assert.equal(context.inputs.workspaceSnapshotId, snapshotId);
        return { ok: true };
      },
    },
    hydrators: { async only() { return { ok: true }; } },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
  };

  await assert.rejects(
    executeWorkflowSpec({
      ...execution,
      workspaceSnapshotForNode: () => `${snapshotId}:spoofed`,
    }),
    (error) => error?.code === 'WORKFLOW_SNAPSHOT_IDENTITY_CONFLICT',
  );
  assert.equal(runStore.load(runId).nodes.only.status, NODE_STATES.PENDING);
  assert.equal(runStore.load(runId).nodes.only.attempt, 0);

  await executeWorkflowSpec(execution);
  assert.equal(runStore.load(runId).nodes.only.status, NODE_STATES.SUCCEEDED);
});
