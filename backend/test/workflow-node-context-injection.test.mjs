import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeWorkflowSpec } from '../src/core/workflow/WorkflowExecutor.js';
import { currentWorkflowNodeContext } from '../src/core/workflow/WorkflowRunContext.js';
import { workflowSpecHash } from '../src/core/workflow/WorkflowSpec.js';
import { FileRunStore } from '../src/project-space/RunStore.js';

const digest = (character) => `sha256:${character.repeat(64)}`;

function workflowNode(id, { parallelGroup = null } = {}) {
  return {
    id,
    handlerId: id,
    dependsOn: [],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'pure-return',
    ...(parallelGroup ? { parallelGroup } : {}),
  };
}

function workflowSpec(id, nodes, parallelGroups = []) {
  return {
    schemaVersion: 'workflow-spec.v1',
    id,
    version: '1.0.0',
    nodes,
    parallelGroups,
  };
}

function beginRun(t, spec, {
  projectId = 'project-context-test',
  runId = 'run-context-test',
  workflowIdentity = null,
} = {}) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-node-context-injection-'));
  fs.mkdirSync(path.join(projectsDir, projectId), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId, projectsDir });
  runStore.begin({
    runId,
    workflowSpec: workflowIdentity || {
      id: spec.id,
      version: spec.version,
      hash: workflowSpecHash(spec),
    },
    inputDigest: digest('a'),
    asOf: '2026-07-23T04:05:06.000Z',
    nodeIds: spec.nodes.map((node) => node.id),
  });
  return { runStore, runId };
}

function singleNodeBindings(nodeId, handler) {
  return {
    handlers: { [nodeId]: handler },
    hydrators: { [nodeId]: async () => ({ hydrated: true }) },
    conditions: { always: () => true },
  };
}

test('executor fails closed before node mutation when durable WorkflowSpec identity does not match', async (t) => {
  const node = workflowNode('only');
  const spec = workflowSpec('identity-mismatch.v1', [node]);
  const { runStore, runId } = beginRun(t, spec, {
    workflowIdentity: {
      id: spec.id,
      version: spec.version,
      hash: digest('f'),
    },
  });
  let handlerCalls = 0;

  await assert.rejects(
    executeWorkflowSpec({
      spec,
      ...singleNodeBindings(node.id, async () => {
        handlerCalls += 1;
        return { ok: true };
      }),
      context: {},
      runStore,
      runId,
    }),
    (error) => error?.code === 'WORKFLOW_SPEC_IDENTITY_CONFLICT',
  );
  assert.equal(handlerCalls, 0);
  assert.equal(runStore.load(runId).nodes[node.id].status, 'PENDING');
  assert.equal(currentWorkflowNodeContext(), null);
});

test('executor rejects a durable identity mismatch before hydrating a succeeded node', async (t) => {
  const node = workflowNode('hydrated');
  const spec = workflowSpec('hydration-identity-mismatch.v1', [node]);
  const { runStore, runId } = beginRun(t, spec, {
    workflowIdentity: {
      id: spec.id,
      version: spec.version,
      hash: digest('e'),
    },
  });
  runStore.markReady(runId, node.id);
  runStore.startNode(runId, node.id, digest('b'));
  runStore.succeedNode(runId, node.id, {
    artifactRefs: [],
    output: { persisted: true },
    pureReturn: true,
  });
  let hydrationCalls = 0;

  await assert.rejects(
    executeWorkflowSpec({
      spec,
      handlers: { [node.id]: async () => ({ executed: true }) },
      hydrators: {
        [node.id]: async () => {
          hydrationCalls += 1;
          return { persisted: true };
        },
      },
      conditions: { always: () => true },
      context: {},
      runStore,
      runId,
    }),
    (error) => error?.code === 'WORKFLOW_SPEC_IDENTITY_CONFLICT',
  );
  assert.equal(hydrationCalls, 0);
  assert.equal(runStore.load(runId).nodes[node.id].status, 'SUCCEEDED');
});

test('executor validates the prior-review provider before starting a node', async (t) => {
  const node = workflowNode('only');
  const spec = workflowSpec('invalid-prior-review-provider.v1', [node]);
  const { runStore, runId } = beginRun(t, spec);

  await assert.rejects(
    executeWorkflowSpec({
      spec,
      ...singleNodeBindings(node.id, async () => ({ ok: true })),
      context: {},
      runStore,
      runId,
      priorReviewIssuesForNode: [],
    }),
    /priorReviewIssuesForNode must be a function/u,
  );
  assert.equal(runStore.load(runId).nodes[node.id].attempt, 0);
});

test('executor injects durable identity, prior review, explicit services, and signal without context-option spoofing', async (t) => {
  const node = workflowNode('inspect');
  const spec = workflowSpec('injection.v1', [node]);
  const { runStore, runId } = beginRun(t, spec, {
    projectId: 'project-durable',
    runId: 'run-durable',
  });
  const spoofBackend = { name: 'spoof' };
  const agentRuntime = { name: 'explicit-runtime' };
  const agentBackend = { name: 'explicit-backend' };
  const signal = new AbortController().signal;
  const priorReviewIssues = [{ id: 'review-1', details: { blocking: true } }];
  const callbackCalls = [];
  let received;

  await executeWorkflowSpec({
    spec,
    ...singleNodeBindings(node.id, async () => {
      received = currentWorkflowNodeContext();
      return { ok: true };
    }),
    context: {
      runId: 'spoof-run',
      projectId: 'spoof-project',
      asOf: '2040-01-01T00:00:00.000Z',
      agentBackend: spoofBackend,
      options: {
        agentBackend: spoofBackend,
        workspaceSnapshotId: 'spoof-snapshot',
        priorReviewIssues: [{ id: 'spoof-review' }],
      },
    },
    runStore,
    runId,
    workspaceSnapshotForNode: () => 'snapshot-explicit',
    priorReviewIssuesForNode: (details) => {
      callbackCalls.push(details);
      return priorReviewIssues;
    },
    agentRuntime,
    agentBackend,
    signal,
  });

  assert.deepEqual(received.workflow, {
    id: spec.id,
    version: spec.version,
    hash: workflowSpecHash(spec),
  });
  assert.deepEqual(received.run, {
    runId: 'run-durable',
    projectId: 'project-durable',
    scope: {
      kind: 'project',
      id: 'project-durable',
    },
    workspaceMode: 'project',
    asOf: '2026-07-23T04:05:06.000Z',
  });
  assert.deepEqual(received.node, { nodeId: node.id, attempt: 1 });
  assert.deepEqual(received.inputs, {
    artifactRefs: [],
    priorReviewIssues,
    workspaceSnapshotId: 'snapshot-explicit',
  });
  assert.equal(received.services.agentRuntime, agentRuntime);
  assert.equal(received.services.agentBackend, agentBackend);
  assert.notEqual(received.services.agentBackend, spoofBackend);
  assert.equal(received.signal, signal);
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].run.runId, 'run-durable');
  assert.equal(callbackCalls[0].record.attempt, 1);
  assert.deepEqual(callbackCalls[0].dependencyArtifactRefs, []);
  assert.equal(currentWorkflowNodeContext(), null);
});

test('retry preserves logical node context identity while exposing the durable attempt', async (t) => {
  const node = workflowNode('retry');
  const spec = workflowSpec('retry-context.v1', [node]);
  const { runStore, runId } = beginRun(t, spec);
  const agentRuntime = { name: 'runtime' };
  const agentBackend = { name: 'backend' };
  const signal = new AbortController().signal;
  const seen = [];
  const priorReviewAttempts = [];

  await executeWorkflowSpec({
    spec,
    ...singleNodeBindings(node.id, async () => {
      const context = currentWorkflowNodeContext();
      seen.push(context);
      if (context.node.attempt === 1) {
        throw Object.assign(new Error('temporary timeout'), { code: 'ETIMEDOUT' });
      }
      return { ok: true };
    }),
    context: {},
    runStore,
    runId,
    workspaceSnapshotForNode: () => 'snapshot-retry',
    priorReviewIssuesForNode: ({ record }) => {
      priorReviewAttempts.push(record.attempt);
      return [{ id: 'stable-review' }];
    },
    retryPolicyForNode: () => ({ maxAttempts: 2, retryOn: ['transient'] }),
    agentRuntime,
    agentBackend,
    signal,
  });

  assert.deepEqual(seen.map((context) => context.node.attempt), [1, 2]);
  assert.deepEqual(priorReviewAttempts, [1, 2]);
  assert.deepEqual(seen[0].workflow, seen[1].workflow);
  assert.deepEqual(seen[0].run, seen[1].run);
  assert.equal(seen[0].node.nodeId, seen[1].node.nodeId);
  assert.deepEqual(seen[0].inputs, seen[1].inputs);
  assert.equal(seen[0].services.agentRuntime, seen[1].services.agentRuntime);
  assert.equal(seen[0].services.agentBackend, seen[1].services.agentBackend);
  assert.equal(seen[0].signal, seen[1].signal);
  assert.equal(runStore.load(runId).nodes[node.id].attempt, 2);
  assert.equal(currentWorkflowNodeContext(), null);
});

test('parallel workflow nodes receive isolated AsyncLocalStorage contexts', async (t) => {
  const left = workflowNode('left', { parallelGroup: 'pair' });
  const right = workflowNode('right', { parallelGroup: 'pair' });
  const spec = workflowSpec('parallel-context.v1', [left, right], [{
    id: 'pair',
    scope: 'nodes',
    nodeIds: [left.id, right.id],
  }]);
  const { runStore, runId } = beginRun(t, spec);
  const seen = {};
  let started = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const handler = (nodeId) => async () => {
    seen[nodeId] = currentWorkflowNodeContext();
    started += 1;
    if (started === 2) release();
    await barrier;
    assert.equal(currentWorkflowNodeContext().node.nodeId, nodeId);
    assert.equal(currentWorkflowNodeContext().inputs.workspaceSnapshotId, `snapshot-${nodeId}`);
    return { nodeId };
  };

  await executeWorkflowSpec({
    spec,
    handlers: {
      left: handler('left'),
      right: handler('right'),
    },
    hydrators: {
      left: async () => ({ nodeId: 'left' }),
      right: async () => ({ nodeId: 'right' }),
    },
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
    workspaceSnapshotForNode: ({ node }) => `snapshot-${node.id}`,
    priorReviewIssuesForNode: ({ node }) => [{ id: `review-${node.id}` }],
  });

  assert.equal(seen.left.node.nodeId, 'left');
  assert.equal(seen.right.node.nodeId, 'right');
  assert.deepEqual(seen.left.inputs.priorReviewIssues, [{ id: 'review-left' }]);
  assert.deepEqual(seen.right.inputs.priorReviewIssues, [{ id: 'review-right' }]);
  assert.notEqual(seen.left, seen.right);
  assert.equal(currentWorkflowNodeContext(), null);
});
