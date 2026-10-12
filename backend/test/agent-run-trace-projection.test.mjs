import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withAgentExecutionObserver } from '../src/core/agent-backend/AgentExecutionObserver.js';
import {
  agentExecutionTimeline,
  createDurableAgentExecutionObserver,
  listAgentExecutionSummaries,
} from '../src/project-space/agentRunTraceProjection.js';
import {
  DURABLE_EVENT_TYPES,
  FileEventBus,
} from '../src/project-space/EventBus.js';
import { FileRunStore } from '../src/project-space/RunStore.js';

const WORKFLOW_RUN_ID = 'run-agent-trace';
const PROJECT_ID = 'project-agent-trace';
const NODE_ID = 'run-research-rounds';
const AGENT_ID = 'company-analyst';
const AS_OF = '2026-07-24T00:00:00.000Z';
const WORKFLOW = {
  id: 'run-analysis.v1',
  version: '1.2.0',
  hash: `sha256:${'a'.repeat(64)}`,
};

function normalizedEvent(sequence, eventType, payload = {}) {
  return {
    eventId: `pi-private-${sequence}`,
    eventType,
    schemaVersion: '1.0.0',
    timestamp: new Date(Date.parse(AS_OF) + sequence * 100).toISOString(),
    sequence,
    correlationId: 'private-correlation',
    causationId: null,
    projectId: PROJECT_ID,
    runId: 'private-logical-agent-run-id',
    nodeId: NODE_ID,
    agentId: AGENT_ID,
    payload,
    messages: [{ role: 'assistant', thinking: 'SECRET_CHAIN_OF_THOUGHT' }],
  };
}

function request() {
  return {
    runId: 'private-logical-agent-run-id',
    workflowId: WORKFLOW.id,
    nodeId: NODE_ID,
    projectId: PROJECT_ID,
    agentContractId: AGENT_ID,
    contractVersion: '1.0.0',
  };
}

function result(status, stopReason) {
  return {
    status,
    stopReason,
    provider: 'openai-compatible',
    model: 'vendor/custom-model',
    output: { private: 'SECRET_PRIVATE_OUTPUT' },
    text: 'SECRET_PROVIDER_MESSAGE',
    metrics: {
      turns: 1,
      toolCalls: 1,
      tokens: 120,
      wallMs: 500,
      secretMetric: 'SECRET_METRIC',
    },
    trace: {
      startedAt: AS_OF,
      toolCalls: [{
        tool: 'ws_read_file',
        args: { authorization: 'SECRET_AUTHORIZATION' },
        result: 'SECRET_RAW_TOOL_RESULT',
      }],
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('durable Agent execution trace preserves physical identity, lifecycle, replay truth, pagination, and redaction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-trace-'));
  const storageDir = path.join(root, 'run');
  fs.mkdirSync(storageDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const eventBus = new FileEventBus({
    projectId: PROJECT_ID,
    storageDir,
    now: () => AS_OF,
  });
  const runStore = new FileRunStore({
    projectId: PROJECT_ID,
    storageDir,
    eventBus,
    now: () => AS_OF,
  });
  runStore.begin({
    runId: WORKFLOW_RUN_ID,
    workflowSpec: WORKFLOW,
    inputDigest: `sha256:${'b'.repeat(64)}`,
    asOf: AS_OF,
    nodeIds: [NODE_ID],
  });
  runStore.markReady(WORKFLOW_RUN_ID, NODE_ID);
  runStore.startNode(
    WORKFLOW_RUN_ID,
    NODE_ID,
    `sha256:${'c'.repeat(64)}`,
  );
  const truthBeforeAgentEvents = eventBus.replay({ runId: WORKFLOW_RUN_ID }).runs[WORKFLOW_RUN_ID];

  const firstStarted = deferred();
  const releaseFirst = deferred();
  let physicalCall = 0;
  const backend = {
    async run(_request, runtime) {
      physicalCall += 1;
      await runtime.onEvent(normalizedEvent(1, 'agent.started', {
        contractVersion: '1.0.0',
        prompt: 'SECRET_SYSTEM_PROMPT',
      }));
      if (physicalCall === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await runtime.onEvent(normalizedEvent(2, 'tool.started', {
        toolCallId: `signed-call-${physicalCall}`,
        tool: 'ws_read_file',
        args: {
          apiKey: 'SECRET_API_KEY',
          signedUrl: 'https://private.example.test/file?signature=SECRET_SIGNATURE',
        },
      }));
      await runtime.onEvent(normalizedEvent(3, 'tool.completed', {
        toolCallId: `signed-call-${physicalCall}`,
        tool: 'ws_read_file',
        ok: true,
        result: 'SECRET_RAW_TOOL_RESULT',
        rawToolResult: { token: 'SECRET_RESULT_TOKEN' },
      }));
      await runtime.onEvent(normalizedEvent(4, 'agent.turn.completed', {
        stopReason: 'SECRET_STOP_REASON',
        messages: ['SECRET_PROVIDER_MESSAGE'],
        thinking: 'SECRET_HIDDEN_THINKING',
        toolResults: ['SECRET_TOOL_RESULT'],
      }));
      return physicalCall === 1
        ? result('failed', 'deadline')
        : result('succeeded', 'final');
    },
  };
  const ids = [
    'agent_run_11111111-1111-4111-8111-111111111111',
    'agent_run_22222222-2222-4222-8222-222222222222',
  ];
  const observed = withAgentExecutionObserver(backend, {
    workflowRunId: WORKFLOW_RUN_ID,
    observer: createDurableAgentExecutionObserver({
      eventBus,
      workflowRunId: WORKFLOW_RUN_ID,
    }),
    idFactory: () => ids.shift(),
    now: () => Date.parse(AS_OF) + physicalCall * 1000,
  });

  const firstRun = observed.run(request(), { workflowAttempt: 1 });
  await firstStarted.promise;
  let summaries = listAgentExecutionSummaries({
    events: eventBus.list({ runId: WORKFLOW_RUN_ID }),
    workflowRunId: WORKFLOW_RUN_ID,
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, 'RUNNING');

  releaseFirst.resolve();
  assert.equal((await firstRun).stopReason, 'deadline');
  assert.equal((await observed.run(request(), { workflowAttempt: 2 })).status, 'succeeded');

  const events = eventBus.list({ runId: WORKFLOW_RUN_ID });
  summaries = listAgentExecutionSummaries({
    events,
    workflowRunId: WORKFLOW_RUN_ID,
  });
  assert.equal(summaries.length, 2);
  assert.equal(new Set(summaries.map((item) => item.agentRunId)).size, 2);
  assert.deepEqual(
    summaries.map((item) => [item.agentId, item.workflowAttempt, item.status, item.stopReason]),
    [
      [AGENT_ID, 1, 'FAILED', 'deadline'],
      [AGENT_ID, 2, 'SUCCEEDED', 'final'],
    ],
  );
  assert.equal(summaries[1].provider, 'openai-compatible');
  assert.equal(summaries[1].model, 'vendor/custom-model');

  const truthAfterAgentEvents = eventBus.replay({ runId: WORKFLOW_RUN_ID }).runs[WORKFLOW_RUN_ID];
  assert.equal(truthAfterAgentEvents.status, truthBeforeAgentEvents.status);
  assert.deepEqual(truthAfterAgentEvents.nodes, truthBeforeAgentEvents.nodes);
  assert.deepEqual(truthAfterAgentEvents.lifecycle, truthBeforeAgentEvents.lifecycle);

  const firstPage = agentExecutionTimeline({
    events,
    workflowRunId: WORKFLOW_RUN_ID,
    agentRunId: summaries[0].agentRunId,
    limit: 2,
  });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasMore, true);
  const secondPage = agentExecutionTimeline({
    events,
    workflowRunId: WORKFLOW_RUN_ID,
    agentRunId: summaries[0].agentRunId,
    afterSequence: firstPage.nextAfterSequence,
    limit: 100,
  });
  assert.ok(secondPage.items.length >= 2);
  assert.equal(secondPage.items.every((item) => item.sequence > firstPage.nextAfterSequence), true);
  assert.equal(secondPage.hasMore, false);

  const serialized = JSON.stringify({ events, summaries, firstPage, secondPage });
  for (const forbidden of [
    'SECRET_CHAIN_OF_THOUGHT',
    'SECRET_SYSTEM_PROMPT',
    'SECRET_API_KEY',
    'SECRET_SIGNATURE',
    'SECRET_RAW_TOOL_RESULT',
    'SECRET_RESULT_TOKEN',
    'SECRET_PROVIDER_MESSAGE',
    'SECRET_HIDDEN_THINKING',
    'SECRET_TOOL_RESULT',
    'SECRET_STOP_REASON',
    'SECRET_PRIVATE_OUTPUT',
    'SECRET_AUTHORIZATION',
    'SECRET_METRIC',
    'signed-call',
    'private-logical-agent-run-id',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  for (const forbiddenKey of [
    'messages',
    'thinking',
    'args',
    'result',
    'rawToolResult',
    'prompt',
    'signedUrl',
  ]) {
    assert.equal(serialized.includes(`"${forbiddenKey}"`), false, forbiddenKey);
  }
});

test('Agent execution EventBus payloads reject extra private fields and timeline identities fail closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-contract-'));
  const storageDir = path.join(root, 'run');
  fs.mkdirSync(storageDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventBus = new FileEventBus({ projectId: PROJECT_ID, storageDir });

  assert.throws(
    () => eventBus.publish({
      eventId: 'evt_malicious_agent_activity',
      eventType: DURABLE_EVENT_TYPES.AGENT_EXECUTION_ACTIVITY,
      correlationId: WORKFLOW_RUN_ID,
      causationId: null,
      runId: WORKFLOW_RUN_ID,
      nodeId: NODE_ID,
      payload: {
        agentRunId: 'agent_run_33333333-3333-4333-8333-333333333333',
        agentId: AGENT_ID,
        contractVersion: '1.0.0',
        workflowAttempt: 1,
        agentEventSequence: 1,
        status: 'RUNNING',
        activityType: 'agent.turn.completed',
        activitySummary: 'Agent turn completed.',
        messages: ['private'],
      },
    }),
    (error) => error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => eventBus.publish({
      eventId: 'evt_malicious_agent_completion',
      eventType: DURABLE_EVENT_TYPES.AGENT_EXECUTION_COMPLETED,
      correlationId: WORKFLOW_RUN_ID,
      causationId: null,
      runId: WORKFLOW_RUN_ID,
      nodeId: NODE_ID,
      payload: {
        agentRunId: 'agent_run_33333333-3333-4333-8333-333333333334',
        agentId: AGENT_ID,
        contractVersion: '1.0.0',
        workflowAttempt: 1,
        agentEventSequence: 2,
        status: 'FAILED',
        stopReason: 'error',
        activitySummary: 'Agent execution failed with stop reason error.',
        provenance: 'physical',
        metrics: {},
        provider: 'SECRET_API_KEY',
        model: 'SECRET_MODEL_TOKEN',
      },
    }),
    (error) => error.code === 'INVALID_EVENT_PAYLOAD',
  );
  assert.throws(
    () => agentExecutionTimeline({
      events: [],
      workflowRunId: WORKFLOW_RUN_ID,
      agentRunId: '../private',
    }),
    (error) => error.code === 'UNSAFE_AGENT_RUN_ID' && error.statusCode === 400,
  );
  assert.throws(
    () => agentExecutionTimeline({
      events: [],
      workflowRunId: WORKFLOW_RUN_ID,
      agentRunId: 'agent_run_44444444-4444-4444-8444-444444444444',
    }),
    (error) => error.code === 'AGENT_RUN_NOT_FOUND' && error.statusCode === 404,
  );
  for (const pagination of [
    { afterSequence: -1 },
    { limit: 0 },
    { limit: 101 },
    { limit: 'not-a-number' },
  ]) {
    assert.throws(
      () => agentExecutionTimeline({
        events: [{
          eventType: DURABLE_EVENT_TYPES.AGENT_EXECUTION_STARTED,
          sequence: 1,
          runId: WORKFLOW_RUN_ID,
          payload: {
            agentRunId: 'agent_run_55555555-5555-4555-8555-555555555555',
          },
        }],
        workflowRunId: WORKFLOW_RUN_ID,
        agentRunId: 'agent_run_55555555-5555-4555-8555-555555555555',
        ...pagination,
      }),
      (error) => (
        error.code === 'INVALID_AGENT_TIMELINE_PAGINATION'
        && error.statusCode === 400
      ),
    );
  }
});

test('durable Agent execution observation batches high-volume activity writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-batch-'));
  const storageDir = path.join(root, 'run');
  fs.mkdirSync(storageDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventBus = new FileEventBus({ projectId: PROJECT_ID, storageDir });
  const publishBatchSizes = [];
  const publishMany = eventBus.publishMany.bind(eventBus);
  eventBus.publishMany = (inputs) => {
    publishBatchSizes.push(inputs.length);
    return publishMany(inputs);
  };
  const observe = createDurableAgentExecutionObserver({
    eventBus,
    workflowRunId: WORKFLOW_RUN_ID,
    flushIntervalMs: 60_000,
    maxBatchSize: 32,
  });
  const agentRunId = 'agent_run_66666666-6666-4666-8666-666666666666';
  const base = {
    workflowRunId: WORKFLOW_RUN_ID,
    agentRunId,
    nodeId: NODE_ID,
    agentId: AGENT_ID,
    contractVersion: '1.0.0',
    workflowAttempt: 1,
  };

  await observe({
    ...base,
    kind: 'started',
    timestamp: AS_OF,
    agentEventSequence: 0,
    status: 'RUNNING',
    activitySummary: 'Agent execution started.',
  });
  for (let sequence = 1; sequence <= 256; sequence += 1) {
    await observe({
      ...base,
      kind: 'activity',
      timestamp: new Date(Date.parse(AS_OF) + sequence).toISOString(),
      agentEventSequence: sequence,
      status: 'RUNNING',
      activityType: 'agent.turn.completed',
      activitySummary: 'Agent turn completed.',
    });
  }
  await observe({
    ...base,
    kind: 'completed',
    timestamp: new Date(Date.parse(AS_OF) + 257).toISOString(),
    agentEventSequence: 257,
    status: 'SUCCEEDED',
    stopReason: 'final',
    activitySummary: 'Agent execution completed successfully.',
    provenance: 'physical',
    metrics: { turns: 256 },
    provider: 'gpt-gateway',
    model: 'luna',
  });

  const events = eventBus.list({ runId: WORKFLOW_RUN_ID });
  const summaries = listAgentExecutionSummaries({
    events,
    workflowRunId: WORKFLOW_RUN_ID,
  });
  assert.equal(events.length, 258);
  assert.equal(summaries[0].activityCount, 256);
  assert.equal(publishBatchSizes.length, 10);
  assert.equal(publishBatchSizes.filter((size) => size === 32).length, 8);
  assert.ok(
    publishBatchSizes.length < events.length / 20,
    `expected bounded batched writes, saw ${publishBatchSizes.length} writes for ${events.length} events`,
  );
});

test('both canonical workflow roots and both server surfaces wire the durable observer contract', () => {
  const ideaRoot = fs.readFileSync(
    new URL('../src/workflows/idea-generation/runIdeaGeneration.js', import.meta.url),
    'utf8',
  );
  const analysisRoot = fs.readFileSync(
    new URL('../src/workflows/run-analysis/runAnalysis.js', import.meta.url),
    'utf8',
  );
  const analysisObserver = fs.readFileSync(
    new URL('../src/workflows/run-analysis/runtime/agentBackend.js', import.meta.url),
    'utf8',
  );
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  for (const root of [ideaRoot, analysisObserver]) {
    assert.match(root, /withAgentExecutionObserver\s*\(/u);
    assert.match(root, /createDurableAgentExecutionObserver\s*\(/u);
  }
  assert.match(analysisRoot, /observeRunAnalysisAgentBackend\s*\(/u);
  assert.match(
    server,
    /\/api\/ideas\/runs\/:runId\/agents\/:agentRunId\/timeline/u,
  );
  assert.match(
    server,
    /\/api\/projects\/:id\/runs\/:runId\/agents\/:agentRunId\/timeline/u,
  );
});
