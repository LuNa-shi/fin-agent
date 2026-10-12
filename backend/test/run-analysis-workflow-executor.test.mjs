import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../src/workflows/run-analysis/workflowSpec.js';
import { canonicalSha256, createArtifactRef, validateArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import * as coreWorkflowExecutor from '../src/core/workflow/WorkflowExecutor.js';
import { FileRunStore } from '../src/project-space/RunStore.js';
import * as runAnalysisWorkflowExecutor from '../src/workflows/run-analysis/workflowExecutor.js';
import {
  assertWorkflowConditionBindings,
  assertWorkflowHandlerBindings,
  assertWorkflowHydrationBindings,
  executeWorkflowSpec,
  stampWorkflowSpecIdentity,
} from '../src/workflows/run-analysis/workflowExecutor.js';
import {
  RUN_ANALYSIS_CONDITION_BINDINGS,
  RUN_ANALYSIS_HANDLER_BINDINGS,
  RUN_ANALYSIS_HYDRATION_BINDINGS,
  RUN_ANALYSIS_WORKFLOW,
} from '../src/workflows/run-analysis/runAnalysis.workflow.js';

const FIXED_AS_OF = '2026-07-16T00:00:00.000Z';
let fixtureSequence = 0;

function durableFixture(t, spec) {
  fixtureSequence += 1;
  const projectId = `executor_test_${fixtureSequence}`;
  const runId = `executor-run-${fixtureSequence}`;
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workflow-executor-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId, projectsDir });
  runStore.begin({
    runId,
    workflowSpec: {
      id: spec.id || `executor-test-${fixtureSequence}`,
      version: spec.version || '1.0.0',
      hash: canonicalSha256(spec),
    },
    inputDigest: canonicalSha256({ fixtureSequence, nodeIds: spec.nodes.map((node) => node.id) }),
    asOf: FIXED_AS_OF,
    nodeIds: spec.nodes.map((node) => node.id),
  });
  return { projectId, runId, runStore };
}

function hydrationBindings(spec, overrides = {}) {
  return Object.fromEntries(spec.nodes.map((node) => [
    node.handlerId,
    overrides[node.handlerId] || (async () => undefined),
  ]));
}

function artifactRefFor(projectId, nodeId) {
  return createArtifactRef({
    artifactId: `${projectId}:analysis/${nodeId}.json`,
    version: 1,
    path: `analysis/${nodeId}.json`,
    contentDigest: canonicalSha256({ projectId, nodeId, kind: 'output' }),
    schemaVersion: `${nodeId}.output.v1`,
    producer: nodeId,
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ projectId, nodeId, kind: 'input' }),
    createdAt: FIXED_AS_OF,
    asOf: FIXED_AS_OF,
  });
}

function completeDurableNode(projectId) {
  return ({ node, result }) => ({
    artifacts: node.artifactPolicy === 'pure-return' ? [] : [artifactRefFor(projectId, node.id)],
    output: result,
  });
}

test('legacy Run Analysis executor path is a thin Core compatibility facade', () => {
  assert.deepEqual(Object.keys(runAnalysisWorkflowExecutor), Object.keys(coreWorkflowExecutor));
  for (const name of Object.keys(coreWorkflowExecutor)) {
    assert.equal(runAnalysisWorkflowExecutor[name], coreWorkflowExecutor[name], name);
  }
});

test('production Run Analysis exports the canonical spec and exactly nine bounded handler bindings', () => {
  assert.equal(RUN_ANALYSIS_WORKFLOW, RUN_ANALYSIS_WORKFLOW_SPEC);
  assert.deepEqual(
    Object.keys(RUN_ANALYSIS_HANDLER_BINDINGS),
    RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.handlerId),
  );
  assert.equal(assertWorkflowHandlerBindings(RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_HANDLER_BINDINGS), true);
  assert.equal(assertWorkflowHydrationBindings(RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_HYDRATION_BINDINGS), true);
  for (const node of RUN_ANALYSIS_WORKFLOW_SPEC.nodes) {
    assert.equal(typeof RUN_ANALYSIS_HANDLER_BINDINGS[node.handlerId], 'function', node.handlerId);
    assert.equal(RUN_ANALYSIS_HANDLER_BINDINGS[node.handlerId].name, node.handlerId);
    assert.equal(typeof RUN_ANALYSIS_HYDRATION_BINDINGS[node.handlerId], 'function', `${node.handlerId} hydrator`);
    assert.notEqual(RUN_ANALYSIS_HYDRATION_BINDINGS[node.handlerId], RUN_ANALYSIS_HANDLER_BINDINGS[node.handlerId]);
  }
});

test('every canonical handler module exports its execute and hydrate boundary directly', async () => {
  const handlers = [
    ['initializeCheckpoint', 'hydrateInitializeCheckpoint'],
    ['planResearch', 'hydratePlanResearch'],
    ['selectCandidates', 'hydrateSelectCandidates'],
    ['runResearchRounds', 'hydrateResearchRounds'],
    ['composeReport', 'hydrateComposeReport'],
    ['reviewReport', 'hydrateReviewReport'],
    ['synthesizeConclusion', 'hydrateSynthesizeConclusion'],
    ['finalizeProject', 'hydrateFinalizeProject'],
  ];
  for (const [handlerId, hydratorId] of handlers) {
    const module = await import(`../src/workflows/run-analysis/handlers/${handlerId}.js`);
    assert.equal(module.execute, RUN_ANALYSIS_HANDLER_BINDINGS[handlerId], `${handlerId} execute`);
    assert.equal(module.hydrate, RUN_ANALYSIS_HYDRATION_BINDINGS[handlerId], `${handlerId} hydrate`);
    assert.equal(module.execute.name, handlerId);
    assert.equal(module.hydrate.name, hydratorId);
  }
});

test('every declared condition has exactly one safe runtime binding', () => {
  const declared = [...new Set(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.conditionId))];
  assert.deepEqual(Object.keys(RUN_ANALYSIS_CONDITION_BINDINGS), declared);
  assert.equal(assertWorkflowConditionBindings(RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_CONDITION_BINDINGS), true);
  for (const conditionId of declared) assert.equal(typeof RUN_ANALYSIS_CONDITION_BINDINGS[conditionId], 'function');
});

test('spec executor durably enforces dependencies and runs only the declared node parallel group concurrently', async (t) => {
  const calls = [];
  let releaseLeft;
  let releaseRight;
  const leftGate = new Promise((resolve) => { releaseLeft = resolve; });
  const rightGate = new Promise((resolve) => { releaseRight = resolve; });
  const spec = {
    id: 'executor-parallel.v1',
    version: '1.0.0',
    nodes: [
      { id: 'start', handlerId: 'start', conditionId: 'always', dependsOn: [] },
      { id: 'left', handlerId: 'left', conditionId: 'always', dependsOn: ['start'], parallelGroup: 'fork' },
      { id: 'right', handlerId: 'right', conditionId: 'always', dependsOn: ['start'], parallelGroup: 'fork' },
      { id: 'join', handlerId: 'join', conditionId: 'always', dependsOn: ['left', 'right'] },
    ],
    parallelGroups: [{ id: 'fork', scope: 'nodes', nodeIds: ['left', 'right'], joinBefore: 'join' }],
  };
  const handlers = {
    start: async () => { calls.push('start'); return 'started'; },
    left: async () => { calls.push('left:start'); await leftGate; calls.push('left:end'); return 'left'; },
    right: async () => { calls.push('right:start'); await rightGate; calls.push('right:end'); return 'right'; },
    join: async (context) => { calls.push('join'); return `${context.nodeResults.left}+${context.nodeResults.right}`; },
  };
  const { projectId, runId, runStore } = durableFixture(t, spec);

  const execution = executeWorkflowSpec({
    spec,
    handlers,
    hydrators: hydrationBindings(spec),
    conditions: { always: () => true },
    context: {},
    runStore,
    runId,
    onNodeComplete: completeDurableNode(projectId),
  });
  await waitForImmediate();
  assert.deepEqual(calls, ['start', 'left:start', 'right:start']);
  releaseRight();
  await waitForImmediate();
  assert.deepEqual(calls, ['start', 'left:start', 'right:start', 'right:end']);
  releaseLeft();
  const result = await execution;

  assert.deepEqual(calls, ['start', 'left:start', 'right:start', 'right:end', 'left:end', 'join']);
  assert.deepEqual(result.nodeResults, { start: 'started', left: 'left', right: 'right', join: 'left+right' });
  assert.equal(result.result, 'left+right');
  assert.ok(Object.values(runStore.load(runId).nodes).every((node) => node.status === NODE_STATES.SUCCEEDED));
});

test('spec executor rejects missing/extra handlers and unmet parallel-group dependencies', async (t) => {
  const spec = {
    id: 'executor-invalid-parallel.v1',
    version: '1.0.0',
    nodes: [
      { id: 'a', handlerId: 'a', conditionId: 'always', dependsOn: [] },
      { id: 'b', handlerId: 'b', conditionId: 'always', dependsOn: ['a'], parallelGroup: 'bad' },
      { id: 'c', handlerId: 'c', conditionId: 'always', dependsOn: ['b'], parallelGroup: 'bad' },
    ],
    parallelGroups: [{ id: 'bad', scope: 'nodes', nodeIds: ['b', 'c'] }],
  };
  assert.throws(() => assertWorkflowHandlerBindings(spec, { a() {}, b() {} }), /missing workflow handler binding: c/i);
  assert.throws(() => assertWorkflowHandlerBindings(spec, { a() {}, b() {}, c() {}, extra() {} }), /unknown workflow handler binding: extra/i);
  const { projectId, runId, runStore } = durableFixture(t, spec);
  await assert.rejects(
    executeWorkflowSpec({
      spec,
      handlers: { async a() {}, async b() {}, async c() {} },
      hydrators: hydrationBindings(spec),
      conditions: { always: () => true },
      context: {},
      runStore,
      runId,
      onNodeComplete: completeDurableNode(projectId),
    }),
    /parallel group bad has unmet dependency b for c/i,
  );
  assert.equal(runStore.load(runId).nodes.a.status, NODE_STATES.SUCCEEDED);
  assert.equal(runStore.load(runId).nodes.b.status, NODE_STATES.PENDING);
  assert.equal(runStore.load(runId).nodes.c.status, NODE_STATES.PENDING);
});

test('condition bindings control expensive work while skipped nodes hydrate from durable state', async (t) => {
  const spec = {
    id: 'executor-condition.v1',
    version: '1.0.0',
    nodes: [
      { id: 'restore', handlerId: 'restore', conditionId: 'always', dependsOn: [] },
      { id: 'expensive', handlerId: 'expensive', conditionId: 'needs-expensive-work', dependsOn: ['restore'] },
      { id: 'consume', handlerId: 'consume', conditionId: 'always', dependsOn: ['expensive'] },
    ],
    parallelGroups: [],
  };
  const handlers = {
    async restore(context) { context.checkpoint = { cached: 'resumed-value' }; },
    async expensive(context, _node, { shouldRun }) {
      if (shouldRun) {
        context.expensiveCalls += 1;
        context.checkpoint.cached = 'fresh-value';
      }
      context.hydrated = context.checkpoint.cached;
    },
    async consume(context) { return context.hydrated; },
  };
  const always = () => true;

  const skippedFixture = durableFixture(t, spec);
  const skippedContext = {
    expensiveCalls: 0,
    cp: {
      nodeExecutions: {
        expensive: { artifactRefs: [artifactRefFor(skippedFixture.projectId, 'expensive')] },
      },
    },
  };
  const skipped = await executeWorkflowSpec({
    spec,
    handlers,
    hydrators: hydrationBindings(spec, {
      expensive: async (context) => {
        context.hydrated = context.checkpoint.cached;
        return context.hydrated;
      },
    }),
    conditions: { always, 'needs-expensive-work': () => false },
    context: skippedContext,
    runStore: skippedFixture.runStore,
    runId: skippedFixture.runId,
    onNodeComplete: completeDurableNode(skippedFixture.projectId),
  });
  assert.equal(skipped.result, 'resumed-value');
  assert.equal(skipped.nodeResults.expensive, 'resumed-value');
  assert.equal(skippedContext.expensiveCalls, 0);
  assert.equal(skippedFixture.runStore.load(skippedFixture.runId).nodes.expensive.imported, true);

  const executedFixture = durableFixture(t, spec);
  const executedContext = { expensiveCalls: 0 };
  const executed = await executeWorkflowSpec({
    spec,
    handlers,
    hydrators: hydrationBindings(spec),
    conditions: { always, 'needs-expensive-work': () => true },
    context: executedContext,
    runStore: executedFixture.runStore,
    runId: executedFixture.runId,
    onNodeComplete: completeDurableNode(executedFixture.projectId),
  });
  assert.equal(executed.result, 'fresh-value');
  assert.equal(executedContext.expensiveCalls, 1);
  assert.equal(executedFixture.runStore.load(executedFixture.runId).nodes.expensive.imported, false);
});

test('nodeExecutions expose immutable durable ArtifactRefs returned by completion and hydration', async (t) => {
  const spec = {
    id: 'executor-artifact-refs.v1',
    version: '1.0.0',
    nodes: [
      { id: 'initialize-checkpoint', handlerId: 'initializeCheckpoint', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' },
      { id: 'produce', handlerId: 'produce', conditionId: 'always', dependsOn: ['initialize-checkpoint'] },
      { id: 'resume', handlerId: 'resume', conditionId: 'skip', dependsOn: ['produce'] },
    ],
    parallelGroups: [],
  };
  const refsByNode = {
    produce: [createArtifactRef({
      artifactId: 'project:analysis/plan.json',
      version: 1,
      path: 'analysis/plan.json',
      contentDigest: 'sha256:'.concat('a'.repeat(64)),
      schemaVersion: 'analysis-plan.output.v1',
      producer: 'analysis-plan',
      contractVersion: '1.0.0',
      inputDigest: 'sha256:'.concat('b'.repeat(64)),
      createdAt: '2026-07-15T00:00:00.000Z',
      asOf: '2026-07-15T00:00:00.000Z',
    })],
    resume: [createArtifactRef({
      artifactId: 'project:analysis/scan.json',
      version: 1,
      path: 'analysis/scan.json',
      contentDigest: 'sha256:'.concat('c'.repeat(64)),
      schemaVersion: 'scan-score.output.v1',
      producer: 'scan-score',
      contractVersion: '1.0.0',
      inputDigest: 'sha256:'.concat('d'.repeat(64)),
      createdAt: '2026-07-15T00:00:00.000Z',
      asOf: '2026-07-15T00:00:00.000Z',
    })],
  };
  const { runId, runStore } = durableFixture(t, spec);

  const execution = await executeWorkflowSpec({
    spec,
    handlers: {
      async initializeCheckpoint() { return { initialized: true }; },
      async produce() { return { ok: true }; },
      async resume() { return { hydrated: true }; },
    },
    hydrators: {
      async initializeCheckpoint() { return { initialized: true }; },
      async produce() { return { ok: true, committed: true }; },
      async resume() { return { hydrated: true }; },
    },
    conditions: { always: () => true, skip: () => false },
    context: {
      cp: {
        nodeExecutions: {
          resume: { artifactRefs: refsByNode.resume },
        },
      },
    },
    runStore,
    runId,
    onNodeComplete: ({ node, result }) => node.id === 'produce'
      ? { artifacts: refsByNode.produce, output: { ...result, committed: true } }
      : { artifacts: [], output: result },
  });

  assert.deepEqual(Object.keys(execution.nodeExecutions), ['initialize-checkpoint', 'produce', 'resume']);
  assert.equal(execution.nodeExecutions['initialize-checkpoint'].status, 'succeeded');
  assert.deepEqual(execution.nodeExecutions['initialize-checkpoint'].output, { initialized: true });
  assert.deepEqual(execution.nodeExecutions['initialize-checkpoint'].artifactRefs, []);
  assert.equal(execution.nodeExecutions['initialize-checkpoint'].artifactPolicy, 'pure-return');
  assert.equal(execution.nodeExecutions['initialize-checkpoint'].attempt, 1);
  assert.match(execution.nodeExecutions['initialize-checkpoint'].inputDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(execution.nodeExecutions['initialize-checkpoint'].stopReason, 'final');
  assert.equal(execution.nodeExecutions.produce.status, 'succeeded');
  assert.deepEqual(execution.nodeResults.produce, { ok: true, committed: true });
  assert.deepEqual(execution.nodeExecutions.produce.output, { ok: true, committed: true });
  assert.equal(validateArtifactRef(execution.nodeExecutions.produce.artifactRefs[0]).valid, true);
  assert.equal(execution.nodeExecutions.resume.status, 'succeeded');
  assert.deepEqual(execution.nodeResults.resume, { hydrated: true });
  assert.equal(validateArtifactRef(execution.nodeExecutions.resume.artifactRefs[0]).valid, true);
  assert.equal(runStore.load(runId).nodes.resume.imported, true);
  assert.throws(() => { execution.nodeExecutions.produce.artifactRefs[0].path = 'tampered'; }, /read only|not extensible/u);
  assert.throws(() => { execution.nodeExecutions.produce.artifactRefs.push({}); }, /read only|not extensible/u);
});

test('completion and hydration hooks validate durable nodes before downstream execution', async (t) => {
  const spec = {
    id: 'executor-hooks.v1',
    version: '1.0.0',
    nodes: [
      { id: 'restore', handlerId: 'restore', conditionId: 'always', dependsOn: [] },
      { id: 'resumed', handlerId: 'resumed', conditionId: 'skip', dependsOn: ['restore'] },
      { id: 'downstream', handlerId: 'downstream', conditionId: 'always', dependsOn: ['resumed'] },
    ],
    parallelGroups: [],
  };
  const calls = [];
  const { projectId, runId, runStore } = durableFixture(t, spec);

  await assert.rejects(
    executeWorkflowSpec({
      spec,
      handlers: {
        async restore() { calls.push('restore'); },
        async resumed() { calls.push('resumed'); },
        async downstream() { calls.push('downstream'); },
      },
      hydrators: hydrationBindings(spec, {
        resumed: async () => { calls.push('hydrate:resumed'); },
      }),
      conditions: { always: () => true, skip: () => false },
      context: {
        cp: {
          nodeExecutions: {
            resumed: { artifactRefs: [artifactRefFor(projectId, 'resumed')] },
          },
        },
      },
      runStore,
      runId,
      onNodeComplete: ({ node, shouldRun, result }) => {
        calls.push(`validate:${node.id}:${shouldRun}`);
        return completeDurableNode(projectId)({ node, result });
      },
      onNodeHydrate: ({ node }) => {
        calls.push(`validate:${node.id}:false`);
        if (node.id === 'resumed') throw new Error('required artifact missing');
      },
    }),
    /required artifact missing/,
  );
  assert.deepEqual(calls, [
    'restore',
    'validate:restore:true',
    'hydrate:resumed',
    'validate:resumed:false',
  ]);
  const run = runStore.load(runId);
  assert.equal(run.nodes.restore.status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes.resumed.status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes.resumed.imported, true);
  assert.equal(run.nodes.downstream.status, NODE_STATES.PENDING);
});

test('executor fails closed without durable RunStore identity and hydration bindings', async (t) => {
  const spec = {
    id: 'executor-durable-required.v1',
    version: '1.0.0',
    nodes: [{ id: 'only', handlerId: 'only', conditionId: 'always', dependsOn: [], artifactPolicy: 'pure-return' }],
    parallelGroups: [],
  };
  const handlers = { async only() { return 'done'; } };
  const hydrators = { async only() { return 'hydrated'; } };
  const conditions = { always: () => true };
  const { runId, runStore } = durableFixture(t, spec);

  await assert.rejects(
    executeWorkflowSpec({ spec, handlers, hydrators, conditions, context: {} }),
    /durable RunStore is required/u,
  );
  await assert.rejects(
    executeWorkflowSpec({ spec, handlers, hydrators, conditions, context: {}, runStore }),
    /runId is required with RunStore/u,
  );
  await assert.rejects(
    executeWorkflowSpec({ spec, handlers, conditions, context: {}, runStore, runId }),
    /workflow hydration bindings are required/u,
  );
});

test('missing and extra condition bindings fail closed', async (t) => {
  const spec = {
    id: 'executor-condition-bindings.v1',
    version: '1.0.0',
    nodes: [{ id: 'only', handlerId: 'only', conditionId: 'required-condition', dependsOn: [] }],
    parallelGroups: [],
  };
  assert.throws(() => assertWorkflowConditionBindings(spec, {}), /missing workflow condition binding: required-condition/i);
  assert.throws(
    () => assertWorkflowConditionBindings(spec, { 'required-condition': () => true, extra: () => true }),
    /unknown workflow condition binding: extra/i,
  );
  await assert.rejects(
    executeWorkflowSpec({ spec, handlers: { async only() {} }, conditions: {}, context: {} }),
    /missing workflow condition binding: required-condition/i,
  );
  const { runId, runStore } = durableFixture(t, spec);
  await assert.rejects(
    executeWorkflowSpec({
      spec,
      handlers: { async only() {} },
      hydrators: { async only() {} },
      conditions: { 'required-condition': () => 'yes' },
      context: {},
      runStore,
      runId,
    }),
    /workflow condition required-condition must return a boolean/i,
  );
});

test('checkpoint identity accepts and stamps historical checkpoints but rejects conflicts', () => {
  const identity = {
    id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
    version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
    hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  };
  const historical = { v: 2, round: 1, done: false };
  const stamped = stampWorkflowSpecIdentity(historical, RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH);
  assert.deepEqual(stamped, { ...historical, workflowSpec: identity });
  assert.equal(historical.workflowSpec, undefined);
  assert.deepEqual(stampWorkflowSpecIdentity(stamped, RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH), stamped);

  for (const workflowSpec of [
    { ...identity, id: 'other-workflow' },
    { ...identity, version: '9.9.9' },
    { ...identity, hash: 'sha256:conflict' },
  ]) {
    assert.throws(
      () => stampWorkflowSpecIdentity({ ...historical, workflowSpec }, RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH),
      /checkpoint workflow spec conflict/i,
    );
  }
});
