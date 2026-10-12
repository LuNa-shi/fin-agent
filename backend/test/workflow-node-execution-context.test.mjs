import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkflowNodeExecutionContext,
  currentWorkflowNodeContext,
  runWithWorkflowNodeContext,
  validateWorkflowNodeExecutionContext,
} from '../src/core/workflow/WorkflowRunContext.js';
import { workflowSpecHash } from '../src/core/workflow/WorkflowSpec.js';

function fixture(overrides = {}) {
  const node = {
    id: 'collect-evidence',
    handlerId: 'collectEvidence',
    dependsOn: [],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
  };
  const spec = {
    schemaVersion: 'workflow-spec.v1',
    id: 'node-context-test.v1',
    version: '1.2.3',
    nodes: [node],
    parallelGroups: [],
  };
  const record = {
    nodeId: node.id,
    attempt: 2,
    status: 'RUNNING',
  };
  const run = {
    runId: 'run-durable-1',
    projectId: 'project-durable-1',
    asOf: '2026-07-23T01:02:03.000Z',
    workflowSpec: {
      id: spec.id,
      version: spec.version,
      hash: workflowSpecHash(spec),
    },
    nodes: { [node.id]: record },
  };
  return {
    spec,
    run,
    node,
    record,
    artifactRefs: [{ artifactId: 'source-1', metadata: { page: 4 } }],
    priorReviewIssues: [{ id: 'issue-1', details: { blocking: true } }],
    workspaceSnapshotId: 'snapshot-durable-1',
    ...overrides,
  };
}

test('creates a complete NodeExecutionContext from canonical spec and durable state', () => {
  const input = fixture();
  const context = createWorkflowNodeExecutionContext(input);

  assert.deepEqual(context, {
    workflow: {
      id: input.spec.id,
      version: input.spec.version,
      hash: workflowSpecHash(input.spec),
    },
    run: {
      runId: input.run.runId,
      projectId: input.run.projectId,
      scope: {
        kind: 'project',
        id: input.run.projectId,
      },
      workspaceMode: 'project',
      asOf: input.run.asOf,
    },
    node: {
      nodeId: input.node.id,
      attempt: input.record.attempt,
    },
    inputs: {
      artifactRefs: input.artifactRefs,
      priorReviewIssues: input.priorReviewIssues,
      workspaceSnapshotId: input.workspaceSnapshotId,
    },
    services: {
      agentRuntime: null,
      agentBackend: null,
    },
    signal: null,
  });
  assert.equal(validateWorkflowNodeExecutionContext(context), true);
  assert.throws(
    () => runWithWorkflowNodeContext({
      runId: input.run.runId,
      workflowId: input.spec.id,
      nodeId: input.node.id,
    }, () => {}),
    /must contain exactly/u,
  );
});

test('fails closed on durable WorkflowSpec id, version, or hash mismatch', () => {
  for (const [field, value] of [
    ['id', 'different-workflow.v1'],
    ['version', '9.9.9'],
    ['hash', `sha256:${'f'.repeat(64)}`],
  ]) {
    const input = fixture();
    input.run.workflowSpec[field] = value;
    assert.throws(
      () => createWorkflowNodeExecutionContext(input),
      (error) => (
        error?.code === 'WORKFLOW_SPEC_IDENTITY_CONFLICT'
        && /workflow node context spec mismatch/u.test(error.message)
      ),
      field,
    );
  }
});

test('durable and canonical identities cannot be replaced by caller-shaped fields', () => {
  const input = fixture({
    runId: 'caller-run',
    projectId: 'caller-project',
    asOf: '2040-01-01T00:00:00.000Z',
    nodeId: 'caller-node',
    attempt: 99,
  });
  input.run.nodeId = 'caller-node-on-run';
  input.run.attempt = 99;
  input.node.nodeId = 'caller-node-on-node';
  input.node.attempt = 99;
  input.record.runId = 'caller-run-on-record';
  input.run.workflowSpec.hash = workflowSpecHash(input.spec);
  const context = createWorkflowNodeExecutionContext(input);

  assert.deepEqual(context.run, {
    runId: 'run-durable-1',
    projectId: 'project-durable-1',
    scope: {
      kind: 'project',
      id: 'project-durable-1',
    },
    workspaceMode: 'project',
    asOf: '2026-07-23T01:02:03.000Z',
  });
  assert.deepEqual(context.node, {
    nodeId: 'collect-evidence',
    attempt: 2,
  });
  assert.equal(Object.hasOwn(context, 'runId'), false);
  assert.equal(Object.hasOwn(context, 'attempt'), false);

  const forgedRecord = fixture();
  forgedRecord.record = { ...forgedRecord.record, attempt: 99 };
  assert.throws(
    () => createWorkflowNodeExecutionContext(forgedRecord),
    /durable workflow node record mismatch/u,
  );
});

test('durable Idea scope and snapshot identity are frozen and fail closed on mismatch', () => {
  const input = fixture();
  input.run.projectId = 'idea-universe:local-user';
  input.run.scope = {
    kind: 'idea-universe',
    id: 'idea-universe:local-user',
  };
  input.run.workspaceMode = 'idea-run';
  input.run.workspaceSnapshotId = input.workspaceSnapshotId;

  const context = createWorkflowNodeExecutionContext(input);
  assert.deepEqual(context.run, {
    runId: input.run.runId,
    projectId: 'idea-universe:local-user',
    scope: {
      kind: 'idea-universe',
      id: 'idea-universe:local-user',
    },
    workspaceMode: 'idea-run',
    asOf: input.run.asOf,
  });
  assert.equal(Object.isFrozen(context.run.scope), true);
  assert.throws(() => {
    context.run.scope.id = 'idea-universe:other';
  }, TypeError);

  assert.throws(
    () => createWorkflowNodeExecutionContext({
      ...input,
      workspaceSnapshotId: 'idea-run-input-snapshot:other',
    }),
    (error) => error?.code === 'WORKFLOW_SNAPSHOT_IDENTITY_CONFLICT',
  );

  const mismatchedScope = fixture();
  mismatchedScope.run.scope = {
    kind: 'idea-universe',
    id: 'idea-universe:local-user',
  };
  mismatchedScope.run.workspaceMode = 'idea-run';
  assert.throws(
    () => createWorkflowNodeExecutionContext(mismatchedScope),
    /scope.id must match projectId/u,
  );
});

test('semantic context data is deeply cloned and frozen', () => {
  const input = fixture();
  const context = createWorkflowNodeExecutionContext(input);

  input.artifactRefs[0].metadata.page = 99;
  input.priorReviewIssues[0].details.blocking = false;
  input.artifactRefs.push({ artifactId: 'late-mutation' });
  assert.equal(context.inputs.artifactRefs[0].metadata.page, 4);
  assert.equal(context.inputs.priorReviewIssues[0].details.blocking, true);
  assert.equal(context.inputs.artifactRefs.length, 1);

  for (const value of [
    context,
    context.workflow,
    context.run,
    context.node,
    context.inputs,
    context.inputs.artifactRefs,
    context.inputs.artifactRefs[0],
    context.inputs.artifactRefs[0].metadata,
    context.inputs.priorReviewIssues,
    context.inputs.priorReviewIssues[0].details,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => {
    context.inputs.artifactRefs[0].metadata.page = 100;
  }, TypeError);

  const unsupported = fixture({
    priorReviewIssues: [{ value: undefined }],
  });
  assert.throws(
    () => createWorkflowNodeExecutionContext(unsupported),
    /unsupported undefined value/u,
  );
});

test('services wrapper is frozen without freezing service instances and signal is preserved', () => {
  class Runtime {
    constructor() {
      this.calls = 0;
    }
  }
  const agentRuntime = new Runtime();
  const agentBackend = { calls: 0, async run() {} };
  const signal = new AbortController().signal;
  const context = createWorkflowNodeExecutionContext(fixture({
    agentRuntime,
    agentBackend,
    signal,
  }));

  assert.equal(Object.isFrozen(context.services), true);
  assert.equal(context.services.agentRuntime, agentRuntime);
  assert.equal(context.services.agentBackend, agentBackend);
  assert.equal(Object.isFrozen(agentRuntime), false);
  assert.equal(Object.isFrozen(agentBackend), false);
  assert.equal(context.signal, signal);
  assert.equal(Object.isFrozen(signal), false);

  agentRuntime.calls += 1;
  agentBackend.calls += 1;
  assert.equal(context.services.agentRuntime.calls, 1);
  assert.equal(context.services.agentBackend.calls, 1);
});

test('parallel AsyncLocalStorage scopes remain isolated and leave no residue', async () => {
  const left = createWorkflowNodeExecutionContext(fixture());
  const rightInput = fixture();
  rightInput.run.runId = 'run-durable-2';
  rightInput.run.projectId = 'project-durable-2';
  rightInput.record.attempt = 3;
  rightInput.workspaceSnapshotId = 'snapshot-durable-2';
  const right = createWorkflowNodeExecutionContext(rightInput);
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });

  assert.equal(currentWorkflowNodeContext(), null);
  const leftRun = runWithWorkflowNodeContext(left, async () => {
    assert.equal(currentWorkflowNodeContext().run.runId, 'run-durable-1');
    await barrier;
    assert.equal(currentWorkflowNodeContext().run.runId, 'run-durable-1');
    return currentWorkflowNodeContext();
  });
  const rightRun = runWithWorkflowNodeContext(right, async () => {
    assert.equal(currentWorkflowNodeContext().run.runId, 'run-durable-2');
    await Promise.resolve();
    assert.equal(currentWorkflowNodeContext().node.attempt, 3);
    release();
    return currentWorkflowNodeContext();
  });

  const [leftResult, rightResult] = await Promise.all([leftRun, rightRun]);
  assert.equal(leftResult.run.projectId, 'project-durable-1');
  assert.equal(rightResult.run.projectId, 'project-durable-2');
  assert.equal(currentWorkflowNodeContext(), null);
});
