import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { defineAgentContract } from '../src/core/contracts/agentContracts.js';
import { PiAgentBackend } from '../src/core/agent-backend/PiAgentBackend.js';
import { createPiTools } from '../src/core/agent-backend/PiToolAdapter.js';
import { RunPolicyController } from '../src/core/agent-backend/RunPolicyController.js';
import { OutputGate } from '../src/core/validation/OutputGate.js';
import { agentPromptCacheSessionId } from '../src/core/models/agentPromptCache.js';
import { createOpenAICompatibleProvider } from '../src/core/models/openAICompatibleProvider.js';
import { getResearchSchema } from '../src/domains/research/contracts/schemaRegistry.js';


async function listenHttp(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function closeHttp(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

const usage = (totalTokens = 30, cost = 0.03) => ({
  input: Math.max(0, totalTokens - 10), output: Math.min(10, totalTokens), cacheRead: 0, cacheWrite: 0,
  totalTokens, cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistant = (text, {
  stopReason = 'stop', totalTokens = 30, cost = 0.03, errorMessage = null,
} = {}) => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'fake', provider: 'fake', model: 'fake-model',
  usage: usage(totalTokens, cost), stopReason, timestamp: Date.now(),
  ...(errorMessage ? { errorMessage } : {}),
});

const contract = (overrides = {}) => defineAgentContract({
  id: 'report-composer', version: '1.0.0', purpose: 'Compose report', executionMode: 'tool-loop',
  inputSchema: 'report.input.v1', outputSchema: 'report.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: [], maxInlineTokens: 12000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: ['read-a', 'read-b'], deny: [], externalRetrieval: 'none', writeScopes: ['report/**'] },
  modelPolicy: { tier: 'main', preferredProviders: ['deepseek'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 4, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 4, retry: { maxAttempts: 1, retryOn: [] } },
  completionPolicy: { requiredArtifacts: ['report/report.md'], hardChecks: ['non-empty-report'], gracefulFinalize: true },
  prompt: () => ({ system: 'system', user: 'compose' }),
  ...overrides,
});

const requestFor = (agentContractId = 'report-composer') => ({
  runId: `run-${agentContractId}`, workflowId: 'report-optimization.v1', nodeId: agentContractId,
  projectId: 'project-1', agentContractId, contractVersion: '1.0.0', asOf: '2026-07-14T00:00:00.000Z',
  input: {}, inputArtifactRefs: [], workspaceSnapshotId: 'snapshot-1', idempotencyKey: `idem-${agentContractId}`,
});

function providerStream(message, partialEvents = []) {
  const stream = createAssistantMessageEventStream();
  void Promise.resolve().then(() => {
    partialEvents.forEach((event) => stream.push(event));
    stream.push(message.stopReason === 'error'
      ? { type: 'error', reason: 'error', error: message }
      : { type: 'done', reason: message.stopReason, message });
  });
  return stream;
}

function routerWithStream(streamFn, route = {}) {
  return {
    resolve: () => ({
      ...router.resolve(),
      ...route,
      streamFn,
    }),
  };
}

const router = {
  resolve: () => ({
    model: { id: 'fake-model', provider: 'fake', api: 'fake', cost: { input: 0, output: 0 } },
    provider: 'fake', modelId: 'fake-model', reasoningLevel: 'standard', attemptedProviders: ['fake'], fallbackFrom: null,
    streamFn: () => {},
  }),
};

class ScriptedAgent {
  constructor(options, scripts) {
    this.options = options;
    this.scripts = scripts;
    this.listeners = [];
    this.prompts = [];
    this.aborted = false;
    this.state = { messages: [], tools: [...(options.initialState.tools || [])] };
  }
  subscribe(listener) { this.listeners.push(listener); return () => {}; }
  async emit(event) { for (const listener of this.listeners) await listener(event, new AbortController().signal); }
  async prompt(prompt) {
    this.prompts.push(prompt);
    const script = this.scripts.shift();
    await this.emit({ type: 'agent_start' });
    for (const event of script.events || []) {
      if (this.aborted) break;
      await this.emit(event);
    }
    if (script.message) this.state.messages.push(script.message);
    await this.emit({ type: 'agent_end', messages: script.message ? [script.message] : [] });
  }
  abort() { this.aborted = true; }
}

class StreamDrivenAgent {
  constructor(options) {
    this.options = options;
    this.listeners = [];
    this.prompts = [];
    this.aborted = false;
    this.state = {
      ...options.initialState,
      messages: [...(options.initialState.messages || [])],
      tools: [...(options.initialState.tools || [])],
    };
  }
  subscribe(listener) { this.listeners.push(listener); return () => {}; }
  async emit(event) { for (const listener of this.listeners) await listener(event, new AbortController().signal); }
  async prompt(prompt) {
    this.prompts.push(prompt);
    await this.emit({ type: 'agent_start' });
    const response = await this.options.streamFn(
      this.options.initialState.model,
      { messages: this.state.messages },
      { sessionId: this.options.sessionId },
    ).result();
    this.state.messages.push(response);
    await this.emit({ type: 'turn_end', message: response, toolResults: [] });
    await this.emit({ type: 'agent_end', messages: [...this.state.messages] });
  }
  abort() { this.aborted = true; }
}

class MultiTurnStreamDrivenAgent extends StreamDrivenAgent {
  async prompt(prompt) {
    this.prompts.push(prompt);
    await this.emit({ type: 'agent_start' });
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await this.options.streamFn(
        this.options.initialState.model,
        { messages: this.state.messages },
        { sessionId: this.options.sessionId },
      ).result();
      this.state.messages.push(response);
    }
    const finalMessage = this.state.messages.at(-1);
    await this.emit({ type: 'turn_end', message: finalMessage, toolResults: [] });
    await this.emit({ type: 'agent_end', messages: [...this.state.messages] });
  }
}

class BlockingAgent {
  constructor(options) {
    this.options = options;
    this.listeners = [];
    this.prompts = [];
    this.aborted = false;
    this.state = { messages: [], tools: [...(options.initialState.tools || [])] };
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
  }
  subscribe(listener) { this.listeners.push(listener); return () => {}; }
  async emit(event) { for (const listener of this.listeners) await listener(event, new AbortController().signal); }
  async prompt(prompt) {
    this.prompts.push(prompt);
    await this.emit({ type: 'agent_start' });
    this.resolveStarted();
    await new Promise((resolve) => {
      this.resolvePrompt = resolve;
      this.fallback = setTimeout(async () => {
        const message = assistant('# fallback');
        this.state.messages.push(message);
        await this.emit({ type: 'turn_end', message, toolResults: [] });
        await this.emit({ type: 'agent_end', messages: [message] });
        resolve();
      }, 60);
    });
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    clearTimeout(this.fallback);
    void (async () => {
      const message = assistant('', { stopReason: 'aborted', totalTokens: 0, cost: 0 });
      this.state.messages.push(message);
      await this.emit({ type: 'turn_end', message, toolResults: [] });
      await this.emit({ type: 'agent_end', messages: [message] });
      this.resolvePrompt?.();
    })();
  }
}

class NonCooperativeAgent {
  constructor(options) {
    this.options = options;
    this.listeners = [];
    this.prompts = [];
    this.aborted = false;
    this.state = { messages: [], tools: [...(options.initialState.tools || [])] };
  }
  subscribe(listener) { this.listeners.push(listener); return () => {}; }
  async prompt(prompt) {
    this.prompts.push(prompt);
    await new Promise(() => {});
  }
  abort() { this.aborted = true; }
}

class RepairBlockingAgent extends ScriptedAgent {
  constructor(options) {
    super(options, []);
  }
  async prompt(prompt) {
    this.prompts.push(prompt);
    if (this.prompts.length === 1) {
      const message = assistant('{"bad":true}');
      this.state.messages.push(message);
      await this.emit({ type: 'agent_start' });
      await this.emit({ type: 'turn_end', message, toolResults: [] });
      await this.emit({ type: 'agent_end', messages: [message] });
      return;
    }
    await new Promise(() => {});
  }
}

test('PiAgentBackend normalizes Pi event chronology and tool trace back to source-call order', async () => {
  const final = assistant('# Report\n\nEvidence.');
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
    }), modelRouter: router,
    toolAdapter: () => [], outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{ events: [
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read-a', args: { file: 'a' } },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'read-b', args: { file: 'b' } },
      { type: 'tool_execution_end', toolCallId: 'b', toolName: 'read-b', result: { content: [{ type: 'text', text: 'B' }] }, isError: false },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'read-a', result: { content: [{ type: 'text', text: 'A' }] }, isError: false },
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }])),
  });

  const result = await backend.run(requestFor(), {
    workspaceMode: 'project',
    workflowAttempt: 2,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.stopReason, 'final');
  assert.equal(result.valid, true);
  assert.equal(agent.options.toolExecution, 'parallel');
  assert.equal(agent.options.sessionId, undefined);
  assert.deepEqual(result.events.map((event) => event.eventType), [
    'agent.started', 'tool.started', 'tool.started', 'tool.completed', 'tool.completed', 'agent.turn.completed', 'agent.stopped',
  ]);
  assert.deepEqual(result.trace.toolCalls.map((call) => call.tool), ['read-a', 'read-b']);
  assert.deepEqual(result.trace.toolCalls.map((call) => call.result), ['A', 'B']);
  assert.equal(result.trace.workspaceMode, 'project');
  assert.equal(result.trace.workflowAttempt, 2);
  assert.equal(result.metrics.turns, 1);
  assert.equal(result.metrics.tokens, 30);
  assert.equal(result.metrics.costUsd, 0.03);
});

test('PiAgentBackend assigns one opaque prompt cache identity to an OpenAI-compatible Agent run', async () => {
  const final = assistant('# Report\n\nEvidence.');
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
    }),
    modelRouter: {
      resolve: () => ({
        ...router.resolve(),
        model: { id: 'fake-model', provider: 'openai-compatible', api: 'fake', cost: { input: 0, output: 0 } },
        provider: 'openai-compatible',
        modelId: 'fake-model',
        attemptedProviders: ['openai-compatible'],
      }),
    },
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{ events: [
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }])),
  });
  const request = {
    ...requestFor(),
    idempotencyKey: 'project-1:report-composer:private-logical-input',
    effectiveConfigDigest: `sha256:${'a'.repeat(64)}`,
  };

  const result = await backend.run(request);

  assert.equal(result.status, 'succeeded');
  assert.equal(agent.options.sessionId, agentPromptCacheSessionId(request));
  assert.match(agent.options.sessionId, /^finagent-pc-v1-[a-f0-9]{48}$/u);
  assert.equal(agent.options.sessionId.includes('project-1'), false);
  assert.equal(agent.options.sessionId.includes('private-logical-input'), false);
});

test('OpenAI-compatible prompt cache identity survives physical model retries and schema repair', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error',
    totalTokens: 0,
    cost: 0,
    errorMessage: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
  });
  const invalid = assistant('');
  const final = assistant('# Report\n\nRecovered with one stable prompt cache identity.');
  const observedSessionIds = [];
  let providerCalls = 0;
  const backend = new PiAgentBackend({
    usageRecorder: null,
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
      toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
      runPolicy: { maxTurns: 4, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: routerWithStream((_model, _context, options) => {
      observedSessionIds.push(options.sessionId);
      providerCalls += 1;
      if (providerCalls === 1) return providerStream(providerFailure);
      if (providerCalls === 2) return providerStream(invalid);
      return providerStream(final);
    }, {
      provider: 'openai-compatible',
      modelId: 'proxy-model',
      model: { id: 'proxy-model', provider: 'openai-compatible', api: 'fake', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    }),
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new StreamDrivenAgent(options),
  });
  const request = {
    ...requestFor(),
    idempotencyKey: 'project-1:report-composer:stable-cache-integration',
    effectiveConfigDigest: `sha256:${'b'.repeat(64)}`,
  };
  const expected = agentPromptCacheSessionId(request);

  const result = await backend.run(request, { modelApiRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.stopReason, 'final');
  assert.equal(providerCalls, 3, 'one provider retry plus one schema-repair turn');
  assert.deepEqual(observedSessionIds, [expected, expected, expected]);
  assert.equal(result.events.filter((event) => event.eventType === 'model.retrying').length, 1);
  assert.equal(result.metrics.turns, 3);
});

test('PiAgentBackend pairs every physical stream start and completion within one multi-turn prompt', async () => {
  const physicalAudit = [];
  let providerCalls = 0;
  const backend = new PiAgentBackend({
    usageRecorder: null,
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: false },
      toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
      runPolicy: { maxTurns: 4, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: routerWithStream(() => {
      providerCalls += 1;
      return providerStream(assistant(providerCalls === 3 ? '# Report\n\nFinal.' : `Intermediate turn ${providerCalls}.`));
    }),
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new MultiTurnStreamDrivenAgent(options),
  });

  const result = await backend.run(requestFor(), {
    kind: 'canonical-worldview',
    modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    onModelApiAttempt: (event) => physicalAudit.push(event),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(providerCalls, 3);
  assert.equal(result.metrics.modelApiAttempts, 3);
  assert.deepEqual(
    physicalAudit.map(({ phase, attempt, status }) => ({ phase, attempt, status })),
    [
      { phase: 'started', attempt: 1, status: undefined },
      { phase: 'completed', attempt: 1, status: 'succeeded' },
      { phase: 'started', attempt: 2, status: undefined },
      { phase: 'completed', attempt: 2, status: 'succeeded' },
      { phase: 'started', attempt: 3, status: undefined },
      { phase: 'completed', attempt: 3, status: 'succeeded' },
    ],
  );
});


test('PiAgentBackend preserves provider error details for workflow failure classification', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error',
    totalTokens: 0,
    cost: 0,
    errorMessage: '503: {"error":{"message":"service unavailable"}}',
  });
  const auditedModelAttempts = [];
  const backend = new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: false },
    }),
    modelRouter: router,
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: providerFailure, toolResults: [] }], message: providerFailure },
      { events: [{ type: 'turn_end', message: providerFailure, toolResults: [] }], message: providerFailure },
    ]),
  });

  const result = await backend.run(requestFor(), {
    modelApiRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    onModelApiAttempt: async (event) => auditedModelAttempts.push(event),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'error');
  assert.equal(result.metrics.tokens, 0);
  assert.equal(result.metrics.modelApiAttempts, 2);
  assert.deepEqual(auditedModelAttempts.map(({ phase, attempt, status, code }) => ({ phase, attempt, status, code })), [
    { phase: 'started', attempt: 1, status: undefined, code: undefined },
    { phase: 'completed', attempt: 1, status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT' },
    { phase: 'started', attempt: 2, status: undefined, code: undefined },
    { phase: 'completed', attempt: 2, status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT' },
  ]);
  assert.equal(result.error?.name, 'PiModelError');
  assert.equal(result.error?.code, 'MODEL_PROVIDER_TRANSIENT');
  assert.equal(result.error?.statusCode, 503);
  assert.equal(result.error?.message, '503: {"error":{"message":"service unavailable"}}');
  assert.deepEqual(result.errors, ['503: {"error":{"message":"service unavailable"}}']);
});

 test('PiAgentBackend classifies permanent provider HTTP failures without model API retry', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error', totalTokens: 0, cost: 0,
    errorMessage: '401: {"error":{"message":"unauthorized"}}',
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract({ completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: false } }),
    modelRouter: router,
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: providerFailure, toolResults: [] }], message: providerFailure },
    ])),
  });
  const result = await backend.run(requestFor(), {
    modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.metrics.modelApiAttempts, 1);
  assert.equal(agent.prompts.length, 1);
  assert.equal(result.error?.code, 'MODEL_PROVIDER_PERMANENT');
  assert.equal(result.error?.statusCode, 401);
  assert.equal(result.events.filter((event) => event.eventType === 'model.retrying').length, 0);
});

test('PiAgentBackend enforces retry policy for bare HTTP statuses emitted by the real OpenAI-compatible provider', async (t) => {
  let responseStatus = 503;
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: responseStatus >= 500 ? 'service unavailable' : 'unauthorized' } }));
  });
  await listenHttp(server);
  t.after(() => closeHttp(server));
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    modelId: 'gpt-5.6-sol',
    reasoningLevel: 'high',
    apiKey: () => 'test-key',
  });
  const [model] = provider.getModels();
  const makeBackend = () => new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: false },
      runPolicy: { maxTurns: 8, deadlineMs: 10_000, tokenBudget: 10_000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: routerWithStream(
      (sourceModel, context, options) => provider.stream(sourceModel, context, { ...options, apiKey: 'test-key' }),
      { provider: 'openai-compatible', modelId: model.id, model, reasoningLevel: 'high' },
    ),
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new StreamDrivenAgent(options),
  });

  for (const status of [408, 429, 500, 502, 503, 504]) {
    responseStatus = status;
    requests = 0;
    const physicalAudit = [];
    const result = await makeBackend().run(requestFor(), {
      modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
      onModelApiAttempt: (event) => physicalAudit.push(event),
    });
    assert.equal(result.status, 'failed', status);
    assert.equal(result.error?.code, 'MODEL_PROVIDER_TRANSIENT', status);
    assert.equal(result.error?.statusCode, status, status);
    assert.equal(result.metrics.modelApiAttempts, 5, status);
    assert.equal(requests, 5, status);
    assert.deepEqual(
      physicalAudit.filter((event) => event.phase === 'started').map((event) => event.attempt),
      [1, 2, 3, 4, 5],
      status,
    );
  }

  for (const status of [400, 401, 403, 404, 409, 413, 418, 422, 501, 505]) {
    responseStatus = status;
    requests = 0;
    const physicalAudit = [];
    const result = await makeBackend().run(requestFor(), {
      modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
      onModelApiAttempt: (event) => physicalAudit.push(event),
    });
    assert.equal(result.status, 'failed', status);
    assert.equal(result.error?.code, 'MODEL_PROVIDER_PERMANENT', status);
    assert.equal(result.error?.statusCode, status, status);
    assert.equal(result.metrics.modelApiAttempts, 1, status);
    assert.equal(requests, 1, status);
    assert.deepEqual(
      physicalAudit.filter((event) => event.phase === 'started').map((event) => event.attempt),
      [1],
      status,
    );
  }
});

test('PiAgentBackend retries transient model stream errors before failing an Agent run', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error',
    totalTokens: 0,
    cost: 0,
    errorMessage: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
  });
  const final = assistant('# Report\n\nRecovered.');
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: false },
      toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
      runPolicy: { maxTurns: 4, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: router,
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: providerFailure, toolResults: [] }], message: providerFailure },
      { events: [{ type: 'turn_end', message: final, toolResults: [] }], message: final },
    ])),
  });

  const result = await backend.run(requestFor(), {
    modelApiRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.stopReason, 'final');
  assert.equal(agent.prompts.length, 2);
  assert.equal(result.metrics.turns, 2);
  assert.equal(result.metrics.tokens, 30);
  assert.deepEqual(
    result.events.filter((event) => event.eventType === 'model.retrying').map((event) => event.payload),
    [{
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 2,
      delayMs: 0,
      reason: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
      code: 'MODEL_TRANSPORT_TRANSIENT',
    }],
  );
});

test('PiAgentBackend does not transport-retry after tool calls have executed', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error',
    totalTokens: 0,
    cost: 0,
    errorMessage: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: false },
    }),
    modelRouter: router,
    toolRegistry: { 'read-a': { effect: { type: 'read' } } },
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{
      events: [
        { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read-a', args: { file: 'data/input.json' } },
        { type: 'tool_execution_end', toolCallId: 'read', toolName: 'read-a', result: { content: [{ type: 'text', text: 'input' }] }, isError: false },
        { type: 'turn_end', message: providerFailure, toolResults: [] },
      ],
      message: providerFailure,
    }])),
  });

  const result = await backend.run(requestFor(), {
    modelApiRetry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MODEL_TRANSPORT_TRANSIENT');
  assert.equal(agent.prompts.length, 1);
  assert.equal(result.trace.toolCalls.length, 1);
  assert.equal(result.events.filter((event) => event.eventType === 'model.retrying').length, 0);
});

test('PiAgentBackend uses remaining model API attempts after read-only Worldview tools without starting a new whole-Agent attempt', async () => {
  const providerFailure = assistant('', {
    stopReason: 'error',
    totalTokens: 0,
    cost: 0,
    errorMessage: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
  });
  const final = assistant('# Worldview result\n\nRecovered in the same complete Agent attempt.');
  let agent;
  const worldviewTools = [
    'worldview_enumerate_overviews',
    'worldview_read_report_version',
  ];
  const backend = new PiAgentBackend({
    usageRecorder: null,
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: false },
      toolPolicy: { allow: worldviewTools, deny: [], externalRetrieval: 'none', writeScopes: [] },
      runPolicy: { maxTurns: 8, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 5, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: router,
    toolRegistry: Object.fromEntries(worldviewTools.map((name) => [name, {
      provider: 'worldview',
      effect: { type: 'read' },
    }])),
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      {
        events: [
          { type: 'tool_execution_start', toolCallId: 'overview-1', toolName: 'worldview_enumerate_overviews', args: { scopeId: 'scope-1' } },
          { type: 'tool_execution_end', toolCallId: 'overview-1', toolName: 'worldview_enumerate_overviews', result: { content: [{ type: 'text', text: 'overview' }] }, isError: false },
          { type: 'turn_end', message: providerFailure, toolResults: [] },
        ],
        message: providerFailure,
      },
      {
        events: [
          { type: 'tool_execution_start', toolCallId: 'report-2', toolName: 'worldview_read_report_version', args: { scopeId: 'scope-1', reportVersionId: 'report-1' } },
          { type: 'tool_execution_end', toolCallId: 'report-2', toolName: 'worldview_read_report_version', result: { content: [{ type: 'text', text: 'report' }] }, isError: false },
          { type: 'turn_end', message: final, toolResults: [] },
        ],
        message: final,
      },
    ])),
  });

  const result = await backend.run(requestFor(), {
    kind: 'canonical-worldview',
    workflowAttempt: 1,
    modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(agent.prompts.length, 2);
  assert.equal(result.metrics.modelApiAttempts, 2);
  assert.equal(result.metrics.modelApiMaxAttempts, 5);
  assert.equal(result.trace.workflowAttempt, 1);
  assert.deepEqual(result.trace.toolCalls.map((call) => call.tool), worldviewTools);
  assert.deepEqual(
    result.events.filter((event) => event.eventType === 'model.retrying').map((event) => event.payload),
    [{
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 5,
      delayMs: 0,
      reason: 'stream error: stream ID 1; INTERNAL_ERROR; received from peer',
      code: 'MODEL_TRANSPORT_TRANSIENT',
      toolCallCount: 1,
      retriedAfterReadOnlyWorldviewTools: true,
    }],
  );
  assert.deepEqual(
    result.events
      .filter((event) => event.eventType === 'model.api.attempt.completed')
      .map((event) => event.payload),
    [
      {
        attempt: 1,
        maxAttempts: 5,
        status: 'failed',
        code: 'MODEL_TRANSPORT_TRANSIENT',
        toolCallCount: 1,
        readOnlyWorldviewToolCalls: true,
        willRetry: true,
      },
      {
        attempt: 2,
        maxAttempts: 5,
        status: 'succeeded',
        code: null,
        toolCallCount: 1,
        readOnlyWorldviewToolCalls: true,
        willRetry: false,
      },
    ],
  );
});

test('PiAgentBackend applies a pinned effective prompt and narrowed tool policy without changing the checked-in contract', async () => {
  const final = assistant('# Report\n\nEvidence.');
  const checkedIn = contract({
    completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
  });
  const digest = `sha256:${'f'.repeat(64)}`;
  const revision = 'definition@1.0.0;overlay@1;skills@quote:1';
  let agent;
  let exposedTools;
  const backend = new PiAgentBackend({
    contractResolver: () => checkedIn,
    modelRouter: router,
    toolAdapter: ({ toolNames }) => { exposedTools = toolNames; return []; },
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{ events: [
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }])),
  });
  const effective = {
    ...checkedIn,
    prompt: () => ({ system: 'runtime system with assigned skill', user: 'compose' }),
    toolPolicy: { ...checkedIn.toolPolicy, allow: ['read-a'] },
    effectiveConfig: { digest, revision },
    assignedSkills: [{ id: 'quote', version: 1 }],
  };
  const result = await backend.run({
    ...requestFor(),
    effectiveConfigDigest: digest,
    effectiveConfigRevision: revision,
  }, { contractOverride: effective });

  assert.equal(result.status, 'succeeded');
  assert.equal(agent.options.initialState.systemPrompt, 'runtime system with assigned skill');
  assert.deepEqual(exposedTools, ['read-a']);
  assert.deepEqual(checkedIn.toolPolicy.allow, ['read-a', 'read-b']);
});

test('PiAgentBackend reports only write-tool files as Agent artifacts', async () => {
  const final = assistant('# Report\n\nEvidence.');
  const artifactContract = contract({
    toolPolicy: { allow: ['read-a', 'write-a'], deny: [], externalRetrieval: 'none', writeScopes: ['report/**'] },
    artifactAuthority: 'return+artifact',
    outputPaths: ['report/report.md'],
  });
  const toolRegistry = {
    'read-a': { effect: { type: 'read' } },
    'write-a': { effect: { type: 'write' } },
  };
  const backend = new PiAgentBackend({
    contractResolver: () => artifactContract,
    modelRouter: router,
    toolRegistry,
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, [{ events: [
      { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read-a', args: { file: 'data/input.json' } },
      { type: 'tool_execution_end', toolCallId: 'read', toolName: 'read-a', result: { content: [{ type: 'text', text: 'input' }], details: { file: 'data/input.json' } }, isError: false },
      { type: 'tool_execution_start', toolCallId: 'write', toolName: 'write-a', args: { file: 'report/report.md' } },
      { type: 'tool_execution_end', toolCallId: 'write', toolName: 'write-a', result: { content: [{ type: 'text', text: 'written' }], details: { file: 'report/report.md' } }, isError: false },
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }]),
  });

  const result = await backend.run(requestFor());

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.artifacts, [{ path: 'report/report.md', tool: 'write-a' }]);
  assert.deepEqual(result.trace.toolCalls.map((call) => ({ tool: call.tool, artifactPath: call.artifactPath })), [
    { tool: 'read-a', artifactPath: 'data/input.json' },
    { tool: 'write-a', artifactPath: 'report/report.md' },
  ]);
});

test('PiAgentBackend exposes only the per-run Tool Use subset', async () => {
  let exposed;
  const narrowedContract = contract({
    completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
  });
  const backend = new PiAgentBackend({
    contractResolver: () => narrowedContract,
    modelRouter: router,
    toolAdapter: ({ toolNames }) => { exposed = toolNames; return []; },
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, [{ events: [], message: assistant('# Report') }]),
  });
  const result = await backend.run(requestFor(), { toolAllow: ['read-b'], live: false });
  assert.deepEqual(exposed, ['read-b']);
  assert.equal(result.status, 'succeeded');
  await assert.rejects(
    () => backend.run(requestFor(), { toolAllow: ['not-declared'], live: false }),
    /cannot expand contract Tool Use/u,
  );
});

test('PiToolAdapter enforces project injection and marks write tools sequential', async () => {
  const calls = [];
  const registry = {
    read: { desc: 'read', params: [{ name: 'projectId' }, { name: 'file' }] },
    persist: {
      desc: 'persist',
      params: [{ name: 'currentProjectId' }, { name: 'projectId' }, { name: 'file' }, { name: 'content' }],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          currentProjectId: { type: 'string', minLength: 1 },
          projectId: { type: 'string', minLength: 1 },
          file: { type: 'string' },
          content: { type: 'string', default: '' },
        },
      },
      effect: {
        type: 'write',
        retrieval: { external: false },
        project: { scope: 'current', identityParams: ['currentProjectId', 'projectId'] },
        path: { param: 'file' },
      },
    },
  };
  const tools = createPiTools({
    toolNames: ['read', 'persist'], toolRegistry: registry, projectId: 'project-1',
    executeTool: async (name, args) => { calls.push({ name, args }); return { result: { ok: true, name } }; },
  });
  assert.equal(tools[0].executionMode, 'parallel');
  assert.equal(tools[1].executionMode, 'sequential');
  assert.deepEqual(tools[1].parameters, registry.persist.inputSchema);
  const result = await tools[1].execute('call-1', { currentProjectId: 'other', projectId: 'other', file: 'report/report.md', content: 'x' });
  assert.deepEqual(calls[0].args, { currentProjectId: 'project-1', projectId: 'project-1', file: 'report/report.md', content: 'x' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.details.ok, true);

  const [unboundPersist] = createPiTools({
    toolNames: ['persist'], toolRegistry: registry,
    executeTool: async () => ({ result: { ok: true } }),
  });
  await assert.rejects(
    () => unboundPersist.execute('call-2', { file: 'report/report.md' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.path === 'currentProjectId' && issue.code === 'required'),
  );

});

test('PiToolAdapter rejects invalid catalog args with ToolInputError shape', async () => {
  const registry = {
    quote: {
      desc: 'quote',
      params: [{ name: 'symbol' }],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { symbol: { type: 'string', default: 'NVDA' } },
      },
      effect: { type: 'read', retrieval: { external: true }, project: { scope: 'none' }, path: { param: null } },
    },
  };
  const [tool] = createPiTools({
    toolNames: ['quote'], toolRegistry: registry,
    executeTool: async () => ({ result: { ok: true } }),
  });

  await assert.rejects(
    () => tool.execute('call-1', { extra: 'nope' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.toolName === 'quote'
      && error.issues.some((issue) => issue.path === 'extra' && issue.code === 'unknown'),
  );
});

test('RunPolicyController reports soft warning and canonical hard budget reasons', () => {
  let now = 1000;
  const policy = new RunPolicyController({
    maxTurns: 2, softTurnLimit: 1, deadlineMs: 50, tokenBudget: 10, toolCallBudget: 1, maxCostUsd: 1,
  }, { now: () => now });
  assert.deepEqual(policy.observeTurn(assistant('one', { stopReason: 'toolUse', totalTokens: 5, cost: 0.1 })), { warning: 'turns' });
  assert.deepEqual(policy.reserveTool(), { allowed: true });
  assert.deepEqual(policy.reserveTool(), { allowed: false, stopReason: 'tool-budget' });
  assert.equal(policy.observeTurn(assistant('two', { stopReason: 'toolUse', totalTokens: 6, cost: 0.1 })).stopReason, 'token-budget');
  const turnPolicy = new RunPolicyController({ maxTurns: 1, deadlineMs: 50, tokenBudget: 100, toolCallBudget: 0 }, { now: () => now });
  assert.deepEqual(turnPolicy.observeTurn(assistant('final', { totalTokens: 5 })), {});
  assert.equal(turnPolicy.continuationDecision().stopReason, 'maxTurns');
  assert.equal(new RunPolicyController({ maxTurns: 1 }, { now: () => now })
    .observeTurn(assistant('continue', { stopReason: 'toolUse', totalTokens: 5 })).stopReason, 'maxTurns');
  const tokenPolicy = new RunPolicyController({ maxTurns: 5, deadlineMs: 50, tokenBudget: 4, toolCallBudget: 5 }, { now: () => now });
  assert.equal(tokenPolicy.observeTurn(assistant('one', { totalTokens: 5 })).stopReason, 'token-budget');
  const unknownCostPolicy = new RunPolicyController({
    maxTurns: 5, deadlineMs: 50, tokenBudget: 100, toolCallBudget: 5, maxCostUsd: 0, costKnown: false,
  }, { now: () => now });
  assert.deepEqual(unknownCostPolicy.observeTurn(assistant('one', { totalTokens: 5, cost: 10 })), {});
  assert.equal(unknownCostPolicy.report().costUsd, null);
  assert.equal(unknownCostPolicy.report().costKnown, false);
  now = 1100;
  assert.equal(policy.checkDeadline(), 'deadline');
  assert.deepEqual({
    toolCalls: policy.report().toolCalls,
    toolAttempts: policy.report().toolAttempts,
    toolDenied: policy.report().toolDenied,
    deadlineMs: policy.report().deadlineMs,
    toolCallSafetyLimit: policy.report().toolCallSafetyLimit,
  }, {
    toolCalls: 1,
    toolAttempts: 2,
    toolDenied: 1,
    deadlineMs: 50,
    toolCallSafetyLimit: 1,
  });
});

test('PiAgentBackend performs at most one tool-free OutputGate repair', async () => {
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  });
  const valid = {
    schemaVersion: '1.0.0', asOf: '2026-07-14T00:00:00.000Z', producer: 'logic-reviewer', contractVersion: '1.0.0',
    inputDigest: 'sha256:1', createdAt: '2026-07-14T00:00:01.000Z', evidenceRefs: [], reviewerType: 'logic', score: 1, issues: [], verdict: 'pass',
  };
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: assistant('{"bad":true}'), toolResults: [] }], message: assistant('{"bad":true}') },
      { events: [{ type: 'turn_end', message: assistant(JSON.stringify(valid)), toolResults: [] }], message: assistant(JSON.stringify(valid)) },
    ])),
  });
  const result = await backend.run(requestFor('logic-reviewer'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.valid, true);
  assert.deepEqual(result.output, valid);
  assert.equal(agent.prompts.length, 2);
  assert.deepEqual(agent.state.tools, []);
  assert.equal(result.events.filter((event) => event.eventType === 'agent.started').length, 1);
  assert.equal(result.events.filter((event) => event.eventType === 'agent.stopped').length, 1);
});

test('PiAgentBackend repairs an adapter projection failure within gracefulFinalize', async () => {
  const valid = {
    schemaVersion: '1.0.0', asOf: '2026-07-14T00:00:00.000Z', producer: 'logic-reviewer', contractVersion: '1.0.0',
    inputDigest: 'sha256:1', createdAt: '2026-07-14T00:00:01.000Z', evidenceRefs: [], reviewerType: 'logic', score: 1, issues: [], verdict: 'pass',
  };
  let adapterCalls = 0;
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
    outputAdapter: (output) => {
      adapterCalls += 1;
      if (adapterCalls === 1) {
        const error = new TypeError('do not expose this raw adapter exception');
        error.errors = ['$.units[0].unitId must equal scope.projectId\nwith unsafe detail'];
        throw error;
      }
      return output;
    },
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: assistant('{"bad":true}'), toolResults: [] }], message: assistant('{"bad":true}') },
      { events: [{ type: 'turn_end', message: assistant(JSON.stringify(valid)), toolResults: [] }], message: assistant(JSON.stringify(valid)) },
    ])),
  });

  const result = await backend.run(requestFor('logic-reviewer'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.valid, true);
  assert.deepEqual(result.output, valid);
  assert.equal(agent.prompts.length, 2);
  assert.match(agent.prompts[1], /unitId must equal scope\.projectId/iu);
  assert.match(agent.prompts[1], /with unsafe detail/iu);
  assert.doesNotMatch(agent.prompts[1], /do not expose this raw adapter exception/iu);
  assert.equal(adapterCalls, 3, 'initial adaptation, repaired adaptation, and contract revalidation');
});

test('PiAgentBackend adds strict bare-path guidance for scorecard closure adapter failures', async () => {
  let adapterCalls = 0;
  const scorecardContract = contract({
    id: 'data-scoreboard-evaluator',
    purpose: 'Evaluate data scorecard',
    outputSchema: 'scorecard-evaluation.v1',
    outputPaths: [],
    completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: true },
    outputAdapter: (output) => {
      adapterCalls += 1;
      if (adapterCalls === 1) {
        const error = new TypeError('scorecard projection rejected');
        error.errors = [
          'project-1.D-COV-01.decisiveEvidence[0] is outside the immutable closure',
          'rawSourceChecks[0].evidenceRefs[0] is outside the immutable closure',
        ];
        throw error;
      }
      return output;
    },
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => scorecardContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: assistant('{"bad":true}'), toolResults: [] }], message: assistant('{"bad":true}') },
      { events: [{ type: 'turn_end', message: assistant('{"repaired":true}'), toolResults: [] }], message: assistant('{"repaired":true}') },
    ])),
  });

  const result = await backend.run(requestFor('data-scoreboard-evaluator'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.valid, true);
  assert.equal(agent.prompts.length, 2);
  assert.match(agent.prompts[1], /rewrite every offending decisiveEvidence\/evidenceRefs item to a single bare allowed path/iu);
  assert.match(agent.prompts[1], /copied exactly from the supplied immutable closure/iu);
  assert.match(agent.prompts[1], /no colon, line range, section text, anchor, query, prose, URI, or appended location/iu);
  assert.match(agent.prompts[1], /preserve the strict closure check; do not coerce or omit invalid references/iu);
  assert.equal(adapterCalls, 3, 'initial adaptation, repaired adaptation, and contract revalidation');
});

test('PiAgentBackend keeps an unrepaired adapter projection fail-closed', async () => {
  const invalid = '{"bad":true}';
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
    outputAdapter: () => {
      const error = new TypeError('raw adapter exception must stay out of the repair prompt');
      error.errors = ['$.units[0].unitId must equal scope.projectId'];
      throw error;
    },
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [
      { events: [{ type: 'turn_end', message: assistant(invalid), toolResults: [] }], message: assistant(invalid) },
      { events: [{ type: 'turn_end', message: assistant(invalid), toolResults: [] }], message: assistant(invalid) },
    ])),
  });

  const result = await backend.run(requestFor('logic-reviewer'));
  assert.equal(result.status, 'partial');
  assert.equal(result.valid, false);
  assert.equal(result.stopReason, 'schema-invalid');
  assert.equal(agent.prompts.length, 2);
  assert.match(result.errors.join('\n'), /unitId must equal scope\.projectId/iu);
  assert.doesNotMatch(agent.prompts[1], /raw adapter exception/iu);
});

test('PiAgentBackend honors an explicit runtime.maxTurns safety fuse', async () => {
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  });
  const valid = {
    schemaVersion: '1.0.0', asOf: '2026-07-14T00:00:00.000Z', producer: 'logic-reviewer', contractVersion: '1.0.0',
    inputDigest: 'sha256:1', createdAt: '2026-07-14T00:00:01.000Z', evidenceRefs: [], reviewerType: 'logic', score: 1, issues: [], verdict: 'pass',
  };
  const createBackend = () => {
    let agent;
    const backend = new PiAgentBackend({
      contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
      outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
      agentFactory: (options) => (agent = new ScriptedAgent(options, [
        { events: [{ type: 'turn_end', message: assistant('{"bad":true}'), toolResults: [] }], message: assistant('{"bad":true}') },
        { events: [{ type: 'turn_end', message: assistant(JSON.stringify(valid)), toolResults: [] }], message: assistant(JSON.stringify(valid)) },
      ])),
    });
    return { backend, getAgent: () => agent };
  };

  const explicitOverride = createBackend();
  const honored = await explicitOverride.backend.run(requestFor('logic-reviewer'), { maxTurns: 1 });
  assert.equal(honored.status, 'partial');
  assert.equal(honored.stopReason, 'maxTurns');
  assert.equal(explicitOverride.getAgent().prompts.length, 1);
});

test('PiAgentBackend does not let a model-length schema repair exceed maxTurns', async () => {
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    runPolicy: { maxTurns: 1, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  });
  let agent;
  const truncated = assistant('{"bad":true}', { stopReason: 'length' });
  const backend = new PiAgentBackend({
    contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{
      events: [{ type: 'turn_end', message: truncated, toolResults: [] }],
      message: truncated,
    }])),
  });

  const result = await backend.run(requestFor('logic-reviewer'));
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'maxTurns');
  assert.equal(agent.prompts.length, 1);
});

test('PiAgentBackend cannot succeed when a required artifact is not reported', async () => {
  const final = assistant('# Report\n\nEvidence.');
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router,
    toolAdapter: () => [], outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, [{ events: [
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }]),
  });

  const result = await backend.run(requestFor());
  assert.equal(result.status, 'partial');
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /required artifact.*report\/report\.md/i);
});

test('PiAgentBackend reports workflow-delegated required artifacts without a false partial result', async () => {
  const final = assistant('# Report\n\nEvidence.');
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router,
    toolAdapter: () => [], outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, [{ events: [
      { type: 'turn_end', message: final, toolResults: [] },
    ], message: final }]),
  });

  const result = await backend.run(requestFor(), { artifactCommitOwner: 'workflow' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.valid, true);
  assert.equal(result.artifactCommitOwner, 'workflow');
  assert.deepEqual(result.delegatedRequiredArtifacts, ['report/report.md']);
  assert.deepEqual(result.artifacts, []);
});

test('PiAgentBackend explicit cancel aborts the active run without finalize or repair', async () => {
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new BlockingAgent(options)),
  });
  const running = backend.run(requestFor(), { deadlineMs: 1000 });
  await agent.started;
  assert.equal(await backend.cancel('run-report-composer', 'report-composer'), true);
  const result = await running;
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(agent.aborted, true);
  assert.equal(agent.prompts.length, 1);
});

test('PiAgentBackend honors an already-aborted signal without starting the model', async () => {
  let agent;
  const abortController = new AbortController();
  abortController.abort();
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new ScriptedAgent(options, [{ events: [], message: assistant('# should not run') }])),
  });
  const result = await backend.run(requestFor(), { signal: abortController.signal });
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(agent.prompts.length, 0);
});

test('PiAgentBackend deadline abort has a distinct stop reason', async () => {
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new BlockingAgent(options)),
  });
  const result = await backend.run(requestFor(), { deadlineMs: 5 });
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'deadline');
  assert.equal(agent.aborted, true);
  assert.equal(agent.prompts.length, 1, 'deadline must not start an OutputGate repair call');
});

test('PiAgentBackend hard deadline returns even when the Agent ignores abort', async () => {
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => contract(), modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new NonCooperativeAgent(options)),
  });
  const started = Date.now();
  const result = await backend.run(requestFor(), { deadlineMs: 10 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'deadline');
  assert.equal(agent.aborted, true);
  assert.equal(agent.prompts.length, 1);
  assert.ok(elapsed < 100, `hard deadline returned after ${elapsed}ms`);
});

test('PiAgentBackend schema repair shares the original hard deadline', async () => {
  const reviewContract = contract({
    id: 'logic-reviewer', purpose: 'Review logic', outputSchema: 'reviewResult.v1',
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  });
  let agent;
  const backend = new PiAgentBackend({
    contractResolver: () => reviewContract, modelRouter: router, toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => (agent = new RepairBlockingAgent(options)),
  });
  const started = Date.now();
  const result = await backend.run(requestFor('logic-reviewer'), { deadlineMs: 15 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'deadline');
  assert.equal(agent.prompts.length, 2, 'one bounded repair is allowed before the hard wall');
  assert.ok(elapsed < 100, `repair escaped the original hard deadline: ${elapsed}ms`);
});


test('PiAgentBackend retries thrown transient provider failures up to the frozen five-attempt policy and audits physical attempts', async () => {
  const final = assistant('# Report\n\nRecovered on the fifth physical model attempt.');
  let promptCalls = 0;
  const backend = new PiAgentBackend({
    usageRecorder: null,
    contractResolver: () => contract({
      completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: false },
      toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
      runPolicy: { maxTurns: 8, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    }),
    modelRouter: router,
    toolAdapter: () => [],
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => ({
      options,
      listeners: [],
      state: { messages: [], tools: [] },
      subscribe(listener) { this.listeners.push(listener); return () => {}; },
      async prompt() {
        promptCalls += 1;
        if (promptCalls < 5) {
          const error = new Error('fetch failed: ECONNRESET while reading provider response');
          error.code = 'ECONNRESET';
          throw error;
        }
        this.state.messages.push(final);
        for (const listener of this.listeners) {
          await listener({ type: 'turn_end', message: final, toolResults: [] }, new AbortController().signal);
        }
      },
      abort() {},
    }),
  });

  const result = await backend.run(requestFor(), {
    modelApiRetry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(promptCalls, 5);
  assert.equal(result.metrics.modelApiAttempts, 5);
  assert.equal(result.metrics.modelApiMaxAttempts, 5);
  assert.equal(result.events.filter((event) => event.eventType === 'model.retrying').length, 4);
});
