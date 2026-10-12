import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runDefinedAgent } from '../src/agents/runDefinedAgent.js';
import { createDefaultAgentBackend } from '../src/agents/defaultAgentBackend.js';
import { withAgentExecutionObserver } from '../src/core/agent-backend/AgentExecutionObserver.js';
import {
  AgentResultIdempotencyStore,
  IDEMPOTENCY_CACHE_INVALID_CODE,
  IDEMPOTENCY_CONFLICT_CODE,
  IdempotentAgentBackend,
  agentResultIdempotencyScope,
  agentResultLogicalFingerprint,
} from '../src/core/agent-backend/index.js';
import { beginDirectAgentCommand } from '../src/core/contracts/AgentExecutionScope.js';
import {
  withIdeaGenerationAgentExecutionTrace,
} from '../src/workflows/idea-generation/runIdeaGeneration.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-agent-idempotency-'));

const request = (overrides = {}) => ({
  runId: overrides.runId || 'run-1',
  workflowId: 'unit-workflow.v1',
  nodeId: 'unit-node',
  projectId: 'project-1',
  agentContractId: 'analysis-plan',
  contractVersion: '1.0.0',
  asOf: overrides.asOf || '2026-07-15T00:00:00.000Z',
  input: { theme: 'AI infrastructure' },
  inputArtifactRefs: [{ path: 'data/report.md', digest: 'a' }],
  workspaceSnapshotId: 'snapshot-1',
  priorReviewIssues: [{ id: 'issue-1', severity: 'low' }],
  idempotencyKey: 'explicit-key-1',
  idempotencyKeyMode: 'explicit',
  ...overrides,
});

const succeeded = (label = 'ok') => ({
  status: 'succeeded',
  output: { label },
  artifacts: ['analysis/plan.json'],
  evidenceRefs: [],
  openQuestions: [],
  dataRequests: [],
  metrics: { turns: 1, toolCalls: 0 },
  stopReason: 'final',
  traceRef: `trace-${label}`,
  trace: { snapshot: label },
});

const nonSuccess = (status) => ({
  status,
  artifacts: [],
  evidenceRefs: [],
  openQuestions: [],
  dataRequests: [],
  metrics: { turns: 1, toolCalls: 0 },
  stopReason: status === 'failed' ? 'error' : 'deadline',
  traceRef: `trace-${status}`,
  errors: status === 'failed' ? ['failed'] : [],
});

function countingBackend(results, calls = []) {
  return {
    run: async (value) => {
      calls.push(value);
      const next = results.length > 1 ? results.shift() : results[0];
      return typeof next === 'function' ? next(value) : next;
    },
    routeFor: (agentId) => `route:${agentId}`,
    cancel: async (runId, nodeId) => `${runId}:${nodeId}`,
  };
}

test('explicit idempotency replays the prior succeeded AgentRunResult without backend calls', async () => {
  const dataDir = tempDir();
  const calls = [];
  const backend = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('first'), succeeded('second')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });

  const first = await backend.run(request({ runId: 'run-a', asOf: '2026-07-15T01:00:00.000Z' }));
  const replay = await backend.run(request({ runId: 'run-b', asOf: '2026-07-15T02:00:00.000Z' }));

  assert.equal(calls.length, 1);
  assert.deepEqual(replay, first);
  assert.equal(replay.output.label, 'first');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('explicit idempotency survives a new wrapper and store instance', async () => {
  const dataDir = tempDir();
  const calls = [];
  const firstBackend = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('durable')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  await firstBackend.run(request());

  const restarted = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('should-not-run')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  const replay = await restarted.run(request({ runId: 'restart-run', asOf: '2026-07-15T03:00:00.000Z' }));

  assert.equal(calls.length, 1);
  assert.equal(replay.output.label, 'durable');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a physical success is not cached when its durable Agent trace cannot be persisted', async () => {
  const dataDir = tempDir();
  const calls = [];
  const store = new AgentResultIdempotencyStore({ dataDir });
  const idempotent = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('must-remain-physical')], calls),
    store,
  });
  let identity = 0;
  const observed = withAgentExecutionObserver(idempotent, {
    workflowRunId: 'workflow-run-trace-persistence',
    observer: async (entry) => {
      if (entry.kind === 'completed') {
        throw new Error('simulated durable EventBus completion failure');
      }
    },
    idFactory: () => `agent_run_00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
  });
  const value = request({ idempotencyKey: 'trace-persistence-before-cache' });

  for (let execution = 0; execution < 2; execution += 1) {
    await assert.rejects(
      () => observed.run(value),
      (error) => error?.code === 'AGENT_EXECUTION_TRACE_PERSISTENCE_FAILED',
    );
  }

  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(store.pathForScope(agentResultIdempotencyScope(value))), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Pi model routing runtime objects are projected to a durable safe trace', async () => {
  const dataDir = tempDir();
  const calls = [];
  const store = new AgentResultIdempotencyStore({ dataDir });
  const liveResult = {
    ...succeeded('pi-live'),
    output: { label: 'pi-live', recommendation: 'hold' },
    metrics: { turns: 2, toolCalls: 0, inputTokens: 120, outputTokens: 80 },
    events: [{ type: 'agent.stop', payload: { reason: 'final' } }],
    trace: {
      runId: 'pi-live-run',
      toolCalls: [],
      stopReason: 'final',
      modelRoute: {
        provider: 'openai-compatible',
        modelId: 'vendor/custom-model',
        reasoningLevel: 'medium',
        attemptedProviders: Object.freeze(['openai-compatible']),
        fallbackFrom: null,
        model: {
          id: 'vendor/custom-model',
          provider: 'openai-compatible',
          baseUrl: 'https://private.example.invalid/v1',
        },
        streamFn: () => {},
      },
      budget: { turns: 2, toolCalls: 0 },
      startedAt: 123,
    },
  };
  const backend = new IdempotentAgentBackend({
    backend: countingBackend([liveResult], calls),
    store,
  });
  const req = request({ idempotencyKey: 'pi-live-route' });
  const first = await backend.run(req);
  const restarted = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('must-not-run')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  const replay = await restarted.run(request({ idempotencyKey: 'pi-live-route', runId: 'pi-live-replay' }));
  const cacheText = fs.readFileSync(store.pathForScope(agentResultIdempotencyScope(req)), 'utf8');

  assert.equal(calls.length, 1);
  assert.deepEqual(replay, first);
  assert.deepEqual(replay.output, liveResult.output);
  assert.deepEqual(replay.metrics, liveResult.metrics);
  assert.deepEqual(replay.events, liveResult.events);
  assert.deepEqual(replay.trace, {
    runId: 'pi-live-run',
    toolCalls: [],
    stopReason: 'final',
    modelRoute: {
      provider: 'openai-compatible',
      modelId: 'vendor/custom-model',
      reasoningLevel: 'medium',
      attemptedProviders: ['openai-compatible'],
      fallbackFrom: null,
    },
    budget: { turns: 2, toolCalls: 0 },
    startedAt: 123,
  });
  assert.equal(cacheText.includes('baseUrl'), false);
  assert.equal(cacheText.includes('private.example.invalid'), false);
  assert.equal(cacheText.includes('streamFn'), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('same key with different logical input fails closed before backend invocation', async () => {
  const dataDir = tempDir();
  const calls = [];
  const backend = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('stored'), succeeded('conflict')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  await backend.run(request());
  await assert.rejects(
    () => backend.run(request({ input: { theme: 'different' } })),
    (error) => error?.code === IDEMPOTENCY_CONFLICT_CODE,
  );
  assert.equal(calls.length, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('partial and failed results are never cached', async () => {
  for (const status of ['partial', 'failed']) {
    const dataDir = tempDir();
    const calls = [];
    const backend = new IdempotentAgentBackend({
      backend: countingBackend([nonSuccess(status), succeeded(status)], calls),
      store: new AgentResultIdempotencyStore({ dataDir }),
    });
    assert.equal((await backend.run(request({ idempotencyKey: `key-${status}` }))).status, status);
    assert.equal((await backend.run(request({ idempotencyKey: `key-${status}` }))).status, 'succeeded');
    assert.equal(calls.length, 2);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('same-process concurrent identical calls coalesce to one backend execution', async () => {
  const dataDir = tempDir();
  const calls = [];
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const backend = new IdempotentAgentBackend({
    backend: {
      run: async (value) => {
        calls.push(value);
        await blocker;
        return succeeded('coalesced');
      },
    },
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  const a = backend.run(request());
  const b = backend.run(request({ runId: 'run-concurrent-2', asOf: '2026-07-15T04:00:00.000Z' }));
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Idea Agent tracing records only the physical execution across coalesced and cached calls', async () => {
  const dataDir = tempDir();
  const calls = [];
  const traces = [];
  let release;
  let markStarted;
  const blocker = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const idempotent = new IdempotentAgentBackend({
    backend: {
      run: async (value, runtime) => {
        calls.push({ value, demo: runtime.demo });
        markStarted();
        await blocker;
        return succeeded('idea-physical');
      },
    },
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  const observed = withIdeaGenerationAgentExecutionTrace(idempotent, {
    demo: false,
    workflowRunId: 'idea-run-provenance',
    observer: async (entry) => { traces.push(entry); },
  });
  const first = observed.run(request({ runId: 'idea-run-a' }));
  await started;
  const coalesced = observed.run(request({
    runId: 'idea-run-b',
    asOf: '2026-07-15T04:00:00.000Z',
  }));
  release();
  const [physicalResult, coalescedResult] = await Promise.all([first, coalesced]);
  const cachedResult = await observed.run(request({
    runId: 'idea-run-c',
    asOf: '2026-07-15T05:00:00.000Z',
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].demo, false);
  assert.deepEqual(coalescedResult, physicalResult);
  assert.deepEqual(cachedResult, physicalResult);
  assert.equal(traces.filter((entry) => entry.kind === 'started').length, 1);
  assert.equal(traces.filter((entry) => entry.kind === 'completed').length, 1);
  assert.equal(new Set(traces.map((entry) => entry.agentRunId)).size, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('tampered cache entry fails closed before backend invocation', async () => {
  const dataDir = tempDir();
  const calls = [];
  const store = new AgentResultIdempotencyStore({ dataDir });
  const backend = new IdempotentAgentBackend({ backend: countingBackend([succeeded('clean')], calls), store });
  const req = request();
  await backend.run(req);
  const file = store.pathForScope(agentResultIdempotencyScope(req));
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  entry.result.output.label = 'tampered';
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));

  await assert.rejects(
    () => backend.run(req),
    (error) => error?.code === IDEMPOTENCY_CACHE_INVALID_CODE,
  );
  assert.equal(calls.length, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('corrupt cache entry fails closed before backend invocation', async () => {
  const dataDir = tempDir();
  const calls = [];
  const store = new AgentResultIdempotencyStore({ dataDir });
  const req = request();
  fs.mkdirSync(path.dirname(store.pathForScope(agentResultIdempotencyScope(req))), { recursive: true });
  fs.writeFileSync(store.pathForScope(agentResultIdempotencyScope(req)), '{not-json');
  const backend = new IdempotentAgentBackend({ backend: countingBackend([succeeded('miss')], calls), store });

  await assert.rejects(
    () => backend.run(req),
    (error) => error?.code === IDEMPOTENCY_CACHE_INVALID_CODE,
  );
  assert.equal(calls.length, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cache paths remain inside the store for hostile scope values', () => {
  const dataDir = tempDir();
  const store = new AgentResultIdempotencyStore({ dataDir });
  const file = path.resolve(store.pathForScope(agentResultIdempotencyScope(request({
    projectId: '..',
    agentContractId: '../outside',
    contractVersion: '../../1.0.0',
  }))));
  const root = `${path.resolve(store.rootDir)}${path.sep}`;

  assert.equal(file.startsWith(root), true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('generated lower-backend requests bypass durable idempotency cache', async () => {
  const dataDir = tempDir();
  const calls = [];
  const backend = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('one'), succeeded('two')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });

  const first = await backend.run(request({
    idempotencyKey: 'generated-1',
    idempotencyKeyMode: 'generated',
  }));
  const second = await backend.run(request({
    idempotencyKey: 'generated-1',
    idempotencyKeyMode: 'generated',
  }));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKeyMode, 'generated');
  assert.equal(first.output.label, 'one');
  assert.equal(second.output.label, 'two');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('runDefinedAgent explicit keys enter the success cache and skip backend on hit', async () => {
  const dataDir = tempDir();
  const calls = [];
  const backend = new IdempotentAgentBackend({
    backend: countingBackend([succeeded('explicit'), succeeded('miss')], calls),
    store: new AgentResultIdempotencyStore({ dataDir }),
  });
  const scope = beginDirectAgentCommand({
    commandId: 'defined-explicit',
    workflowId: 'agent-result-idempotency.v1',
    nodeId: 'run-analysis-plan',
    projectId: 'project-1',
    asOf: '2026-07-15T00:00:00.000Z',
    workspaceMode: 'project',
    workspaceSnapshotId: 'snapshot-1',
  });
  const first = await runDefinedAgent('analysis-plan', { theme: 'AI infrastructure' }, {
    backend,
    scope,
  });
  const replay = await runDefinedAgent('analysis-plan', { theme: 'AI infrastructure' }, {
    backend,
    scope,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKeyMode, 'explicit');
  assert.deepEqual(replay, first);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('runDefinedAgent rejects an explicitly supplied empty idempotency key', async () => {
  const calls = [];
  await assert.rejects(
    () => runDefinedAgent('analysis-plan', { theme: 'AI infrastructure' }, {
      backend: countingBackend([succeeded('must-not-run')], calls),
      scope: {
        runId: 'run-empty-key',
        workflowId: 'agent-result-idempotency.v1',
        nodeId: 'run-analysis-plan',
        projectId: 'project-1',
        asOf: '2026-07-15T00:00:00.000Z',
        workspaceMode: 'project',
        workspaceSnapshotId: 'snapshot-1',
        inputArtifactRefs: [],
        priorReviewIssues: [],
        idempotencyKey: '',
      },
    }),
    /DirectExecutionScope\.idempotencyKey must be a non-empty string/u,
  );
  assert.equal(calls.length, 0);
});

test('the production backend factory exposes routing, cancel, and single wrapper delegation', async () => {
  const dataDir = tempDir();
  const idempotencyStore = new AgentResultIdempotencyStore({ dataDir });
  const make = (name, calls) => ({
    run: async (value) => { calls.push(`${name}:${value.agentContractId}`); return succeeded(name); },
    cancel: async () => name === 'pi',
  });

  const defaultCalls = [];
  const defaultBackend = createDefaultAgentBackend({
    piBackend: make('pi', defaultCalls),
    idempotencyStore,
    concurrent: false,
  });
  assert.equal(await defaultBackend.cancel('run', 'node'), true);
  await defaultBackend.run(request({ agentContractId: 'report-editor', nodeId: 'report-editor', idempotencyKey: 'default-factory' }));
  await defaultBackend.run(request({ agentContractId: 'report-editor', nodeId: 'report-editor', idempotencyKey: 'default-factory' }));
  assert.deepEqual(defaultCalls, ['pi:report-editor']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('logical fingerprint ignores runId and automatic asOf but includes durable inputs', () => {
  const base = request({ runId: 'run-a', asOf: '2026-07-15T00:00:00.000Z' });
  const replay = request({ runId: 'run-b', asOf: '2026-07-16T00:00:00.000Z' });
  const changed = request({ runId: 'run-c', asOf: '2026-07-16T00:00:00.000Z', workspaceSnapshotId: 'snapshot-2' });

  assert.equal(agentResultLogicalFingerprint(base), agentResultLogicalFingerprint(replay));
  assert.notEqual(agentResultLogicalFingerprint(base), agentResultLogicalFingerprint(changed));
});
