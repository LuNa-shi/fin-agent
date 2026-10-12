import test from 'node:test';
import assert from 'node:assert/strict';

import { defineAgentContract, createAgentRunRequest } from '../src/core/contracts/agentContracts.js';
import { PiAgentBackend } from '../src/core/agent-backend/PiAgentBackend.js';
import { ContextManager, ContextPermissionError } from '../src/core/context/ContextManager.js';

const assistant = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'fake',
  provider: 'fake',
  model: 'fake-model',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: 'stop',
  timestamp: 1,
});

function contractFor(contextPolicy = {}) {
  return defineAgentContract({
    id: 'context-test-agent',
    version: '1.0.0',
    purpose: 'Exercise explicit context policy.',
    executionMode: 'json',
    inputSchema: 'context-test.input.v1',
    outputSchema: 'context-test.output.v1',
    contextPolicy: {
      mounts: ['/project'],
      artifactSelectors: ['data/**', 'analysis/reviews/**'],
      maxInlineTokens: 100,
      allowPriorReview: true,
      allowCrossProjectRead: false,
      ...contextPolicy,
    },
    toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
    modelPolicy: { tier: 'main', preferredProviders: ['fake'], reasoningLevel: 'standard' },
    runPolicy: { maxTurns: 2, deadlineMs: 1000, tokenBudget: 100, toolCallBudget: 0, retry: { maxAttempts: 1, retryOn: [] } },
    completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: false },
    prompt: () => ({ system: 'unchanged-system', user: 'unchanged-user' }),
  });
}

function requestFor(overrides = {}) {
  return createAgentRunRequest({
    runId: 'run-context',
    workflowId: 'workflow-context.v1',
    nodeId: 'context-node',
    projectId: 'project-current',
    agentContractId: 'context-test-agent',
    contractVersion: '1.0.0',
    asOf: '2026-07-15T00:00:00.000Z',
    input: { untouched: true },
    inputArtifactRefs: [],
    workspaceSnapshotId: 'project-current:live',
    priorReviewIssues: [],
    idempotencyKey: 'context-idempotency',
    ...overrides,
  });
}

class FinalPiAgent {
  constructor(options) {
    this.options = options;
    this.listeners = [];
    this.prompts = [];
    this.state = { messages: [], tools: [...(options.initialState.tools || [])] };
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {};
  }

  async emit(event) {
    for (const listener of this.listeners) await listener(event, new AbortController().signal);
  }

  async prompt(value) {
    this.prompts.push(value);
    const message = assistant('# context accepted');
    await this.emit({ type: 'agent_start' });
    this.state.messages.push(message);
    await this.emit({ type: 'turn_end', message, toolResults: [] });
    await this.emit({ type: 'agent_end', messages: [message] });
  }

  abort() {}
}

const router = (onResolve = () => {}) => ({
  resolve() {
    onResolve();
    return {
      model: { id: 'fake-model', provider: 'fake', api: 'fake', cost: { input: 0, output: 0 } },
      provider: 'fake',
      modelId: 'fake-model',
      reasoningLevel: 'standard',
      attemptedProviders: ['fake'],
      fallbackFrom: null,
      streamFn: () => {},
    };
  },
});

test('ContextManager accepts selected current-project refs and prior review without mutating input', () => {
  const manager = new ContextManager();
  const contract = contractFor();
  const first = requestFor({
    input: { hugeDomainInput: 'x'.repeat(100_000), nested: { keep: true } },
    inputArtifactRefs: [
      'data/current.json',
      { projectId: 'project-current', path: '/project/data/inline.json', content: { z: '中文', a: 'alpha' } },
    ],
    priorReviewIssues: [{ id: 'review-1', severity: 'warning', message: 'check this bridge' }],
  });
  const second = requestFor({
    inputArtifactRefs: [
      'data/current.json',
      { projectId: 'project-current', path: '/project/data/inline.json', content: { a: 'alpha', z: '中文' } },
    ],
    priorReviewIssues: [{ message: 'check this bridge', severity: 'warning', id: 'review-1' }],
  });
  const before = JSON.stringify(first);

  const firstSummary = manager.preflight(first, contract);
  const secondSummary = manager.preflight(second, contract);

  assert.deepEqual(firstSummary, {
    artifactCount: 2,
    priorReviewCount: 1,
    inlineTokens: firstSummary.inlineTokens,
  });
  assert.ok(firstSummary.inlineTokens > 0);
  assert.equal(firstSummary.inlineTokens, secondSummary.inlineTokens, 'key order must not affect inline-token estimates');
  assert.equal(JSON.stringify(first), before);
  assert.equal(first.input.hugeDomainInput.length, 100_000, 'full domain input is not part of the inline context budget');
});

test('ContextManager treats string refs as current-project paths and enforces cross-project ownership', () => {
  const manager = new ContextManager();
  const contract = contractFor();

  assert.doesNotThrow(() => manager.preflight(requestFor({ inputArtifactRefs: ['data/current.json'] }), contract));
  assert.doesNotThrow(() => manager.preflight(requestFor({
    inputArtifactRefs: [{ projectId: 'project-current', path: 'data/current.json', content: 'inline' }],
  }), contract));
  assert.throws(
    () => manager.preflight(requestFor({ inputArtifactRefs: [{ projectId: 'project-other', path: 'data/other.json' }] }), contract),
    (error) => error instanceof ContextPermissionError
      && error.code === 'CONTEXT_PERMISSION_DENIED'
      && error.reason === 'cross-project-read-denied',
  );

  const crossProjectContract = contractFor({ allowCrossProjectRead: true });
  assert.doesNotThrow(() => manager.preflight(requestFor({
    inputArtifactRefs: [{ projectId: 'project-other', path: 'data/other.json' }],
  }), crossProjectContract));
  assert.throws(
    () => manager.preflight(
      requestFor({ inputArtifactRefs: [{ projectId: 'project-other', path: 'data/other.json' }] }),
      contractFor({ allowCrossProjectRead: 'false' }),
    ),
    (error) => error instanceof ContextPermissionError && error.reason === 'cross-project-read-denied',
    'only the boolean true may authorize cross-project context',
  );
});

test('ContextManager fails closed on selector, mount, unsafe path, prior-review, and inline budget violations', () => {
  const manager = new ContextManager();
  const contract = contractFor();
  const denial = (request, targetContract, reason) => assert.throws(
    () => manager.preflight(request, targetContract),
    (error) => error instanceof ContextPermissionError
      && error.code === 'CONTEXT_PERMISSION_DENIED'
      && error.reason === reason,
  );

  denial(requestFor({ inputArtifactRefs: ['report/report.md'] }), contract, 'artifact-selector-mismatch');
  denial(requestFor({ inputArtifactRefs: ['/library/data/current.json'] }), contract, 'mount-not-allowed');
  denial(requestFor({ inputArtifactRefs: ['data/../secret.txt'] }), contract, 'unsafe-context-path');
  denial(
    requestFor({ inputArtifactRefs: [{ projectId: '', path: 'data/current.json' }] }),
    contract,
    'invalid-context-reference',
  );
  denial(requestFor({ priorReviewIssues: [{ id: 'not-allowed' }] }), contractFor({ allowPriorReview: false }), 'prior-review-not-allowed');
  denial(requestFor({ priorReviewIssues: [{ id: 'still-not-allowed' }] }), contractFor({ allowPriorReview: 'false' }), 'prior-review-not-allowed');
  denial(requestFor({ priorReviewIssues: [[]] }), contract, 'invalid-context-reference');
  denial(
    requestFor({ inputArtifactRefs: [{ path: 'data/inline.txt', content: 'this inline payload is intentionally too large' }] }),
    contractFor({ maxInlineTokens: 1 }),
    'inline-token-budget-exceeded',
  );

  const noInline = manager.preflight(
    requestFor({ input: { huge: 'x'.repeat(100_000) }, inputArtifactRefs: ['data/current.json'] }),
    contractFor({ maxInlineTokens: 0 }),
  );
  assert.equal(noInline.inlineTokens, 0);
  assert.throws(
    () => requestFor({ priorReviewIssues: 'not-an-array' }),
    /AgentRunRequest\.priorReviewIssues must be an array/u,
  );
});

test('ContextManager preflight denies Pi runs before any model seam', async () => {
  const manager = new ContextManager();
  const contract = contractFor();
  const denied = requestFor({ inputArtifactRefs: [{ projectId: 'project-other', path: 'data/other.json' }] });
  let piResolveCalls = 0;
  let piFactoryCalls = 0;
  const pi = new PiAgentBackend({
    contractResolver: () => contract,
    contextManager: manager,
    modelRouter: router(() => { piResolveCalls += 1; }),
    toolAdapter: () => [],
    agentFactory: (options) => { piFactoryCalls += 1; return new FinalPiAgent(options); },
  });

  await assert.rejects(
    () => pi.run(denied),
    (error) => error instanceof ContextPermissionError && error.reason === 'cross-project-read-denied',
  );
  assert.equal(piResolveCalls, 0);
  assert.equal(piFactoryCalls, 0);
});

test('valid selected context and prior review reach Pi with prompt text unchanged', async () => {
  const manager = new ContextManager();
  const contract = contractFor();
  const accepted = requestFor({
    inputArtifactRefs: [{ projectId: 'project-current', path: 'data/current.json', content: 'selected context' }],
    priorReviewIssues: [{ id: 'prior-1', message: 'retain this issue' }],
  });
  let piAgent;
  const pi = new PiAgentBackend({
    contractResolver: () => contract,
    contextManager: manager,
    modelRouter: router(),
    toolAdapter: () => [],
    agentFactory: (options) => (piAgent = new FinalPiAgent(options)),
  });

  const piResult = await pi.run(accepted);
  assert.equal(piResult.status, 'succeeded');
  assert.equal(piAgent.options.initialState.systemPrompt, 'unchanged-system');
  assert.deepEqual(piAgent.prompts, ['unchanged-user']);
});
