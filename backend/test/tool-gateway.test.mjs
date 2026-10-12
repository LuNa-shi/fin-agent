import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-tool-gateway-'));
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = 'true';

const { getAgentDefinition } = await import('../src/agents/registry.js');
const { PiAgentBackend } = await import('../src/core/agent-backend/PiAgentBackend.js');
const { ToolGateway, ToolPermissionError } = await import('../src/core/tools/ToolGateway.js');
const { ProjectSpace } = await import('../src/project-space/index.js');
const { runTool } = await import('../src/tools/index.js');
const { ToolInputError, toolRegistry } = await import('../src/tools/toolCatalog.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function requestFor(agentId, overrides = {}) {
  const contract = getAgentDefinition(agentId);
  return {
    runId: `run-${agentId}`,
    workflowId: 'run-analysis.v1',
    nodeId: agentId,
    projectId: 'project-current',
    agentContractId: agentId,
    contractVersion: contract.version,
    asOf: '2026-07-15T00:00:00.000Z',
    input: {},
    inputArtifactRefs: [],
    workspaceSnapshotId: 'project-current:live',
    priorReviewIssues: [],
    idempotencyKey: `idem-${agentId}`,
    ...overrides,
  };
}

function withPolicy(contract, { contextPolicy, toolPolicy, runPolicy, completionPolicy } = {}) {
  return {
    ...contract,
    contextPolicy: { ...contract.contextPolicy, ...(contextPolicy || {}) },
    toolPolicy: { ...contract.toolPolicy, ...(toolPolicy || {}) },
    runPolicy: { ...contract.runPolicy, ...(runPolicy || {}) },
    completionPolicy: { ...contract.completionPolicy, ...(completionPolicy || {}) },
  };
}

function gatewayHarness(agentId, options = {}) {
  const contract = options.contract || getAgentDefinition(agentId);
  const request = options.request || requestFor(agentId);
  const calls = [];
  const audits = [];
  const executeTool = options.executeTool || (async (name, args) => {
    calls.push({ name, args });
    return { result: { ok: true, name, args } };
  });
  const gateway = new ToolGateway({
    request,
    contract,
    registry: toolRegistry,
    executeTool,
    beforeExecute: options.beforeExecute || null,
    audit: async (record) => { audits.push(record); },
  });
  return { gateway, calls, audits, contract, request };
}

async function expectPermission(promise, reason) {
  await assert.rejects(
    () => promise,
    (error) => error instanceof ToolPermissionError
      && error.code === 'TOOL_PERMISSION_DENIED'
      && error.reason === reason,
  );
}

test('report-composer report write passes, while analysis write is denied with sanitized audit identity', async () => {
  const allowed = gatewayHarness('report-composer');
  await allowed.gateway.execute('ws_write_file', { file: 'report/allowed.md', content: 'allowed report content' });
  assert.deepEqual(allowed.calls, [{
    name: 'ws_write_file',
    args: {
      currentProjectId: 'project-current',
      projectId: 'project-current',
      file: 'report/allowed.md',
      content: 'allowed report content',
    },
  }]);
  assert.deepEqual(allowed.audits, []);

  const denied = gatewayHarness('report-composer');
  await expectPermission(denied.gateway.execute('ws_write_file', {
    currentProjectId: 'project-current',
    projectId: 'project-current',
    file: 'analysis/forbidden.md',
    content: 'provider payload must not enter audit',
    apiKey: 'sk-secret-must-not-leak',
  }), 'write-scope-denied');
  assert.equal(denied.calls.length, 0);
  assert.equal(denied.audits.length, 1);
  assert.deepEqual({
    eventType: denied.audits[0].eventType,
    runId: denied.audits[0].runId,
    workflowId: denied.audits[0].workflowId,
    nodeId: denied.audits[0].nodeId,
    agent: denied.audits[0].agent,
    projectId: denied.audits[0].projectId,
    tool: denied.audits[0].tool,
    reason: denied.audits[0].reason,
  }, {
    eventType: 'tool.permission.denied',
    runId: 'run-report-composer',
    workflowId: 'run-analysis.v1',
    nodeId: 'report-composer',
    agent: 'report-composer',
    projectId: 'project-current',
    tool: 'ws_write_file',
    reason: 'write-scope-denied',
  });
  const auditText = JSON.stringify(denied.audits[0].sanitizedArgs);
  assert.doesNotMatch(auditText, /provider payload|sk-secret/u);
  assert.match(auditText, /REDACTED/u);
  assert.equal(Object.isFrozen(denied.audits[0]), true);
});

test('reviewer write is denied and explicit deny overrides allow', async () => {
  const reviewer = gatewayHarness('logic-reviewer');
  await expectPermission(
    reviewer.gateway.execute('ws_write_file', { file: 'report/forbidden.md', content: 'malicious rewrite' }),
    'tool-not-allowed',
  );
  assert.equal(reviewer.calls.length, 0);

  const base = getAgentDefinition('company-analyst');
  const denyContract = withPolicy(base, {
    toolPolicy: { allow: ['fmp_quote'], deny: ['fmp_quote'], externalRetrieval: 'full', writeScopes: [] },
  });
  const denied = gatewayHarness('company-analyst', { contract: denyContract });
  await expectPermission(denied.gateway.execute('fmp_quote', { symbol: 'NVDA' }), 'tool-explicitly-denied');
  assert.equal(denied.calls.length, 0);
});

test('external retrieval none denies, while targeted and full permit allowlisted external tools', async () => {
  const report = getAgentDefinition('report-composer');
  const noneContract = withPolicy(report, {
    toolPolicy: { allow: ['fmp_quote'], deny: [], externalRetrieval: 'none', writeScopes: [] },
  });
  const none = gatewayHarness('report-composer', { contract: noneContract });
  await expectPermission(none.gateway.execute('fmp_quote', { symbol: 'NVDA' }), 'external-retrieval-denied');
  assert.equal(none.calls.length, 0);

  const targeted = gatewayHarness('company-analyst');
  const full = gatewayHarness('data-orchestrator');
  await targeted.gateway.execute('fmp_quote', { symbol: 'NVDA' });
  await full.gateway.execute('fmp_quote', { symbol: 'NVDA' });
  assert.equal(targeted.calls.length, 1);
  assert.equal(full.calls.length, 1);

  const invalidPolicy = gatewayHarness('company-analyst', {
    contract: withPolicy(getAgentDefinition('company-analyst'), {
      toolPolicy: { externalRetrieval: 'invalid-policy' },
    }),
  });
  await expectPermission(invalidPolicy.gateway.execute('fmp_quote', { symbol: 'NVDA' }), 'external-retrieval-denied');
  assert.equal(invalidPolicy.calls.length, 0);
});

test('gateway reuses catalog coercion and rejects invalid input before the raw executor seam', async () => {
  const typed = gatewayHarness('data-orchestrator');
  await typed.gateway.execute('fmp_transcript', { symbol: 'AAPL', quarter: '2', year: '2020' });
  assert.deepEqual(typed.calls, [{
    name: 'fmp_transcript',
    args: { symbol: 'AAPL', quarter: 2, year: 2020 },
  }]);

  const invalid = gatewayHarness('data-orchestrator');
  await assert.rejects(
    () => invalid.gateway.execute('fmp_quote', { symbol: 'NVDA', unexpected: true }),
    (error) => error instanceof ToolInputError && error.code === 'TOOL_INPUT_INVALID',
  );
  await assert.rejects(
    () => invalid.gateway.execute('ws_write_file', []),
    (error) => error instanceof ToolInputError && error.code === 'TOOL_INPUT_INVALID',
  );
  assert.equal(invalid.calls.length, 0);
});

test('gateway runs a last-moment execution guard before consuming budget or invoking a write tool', async () => {
  const blocked = Object.assign(new Error('Human Review opened'), {
    code: 'HUMAN_REVIEW_MUTATION_BLOCKED',
  });
  const checks = [];
  const guarded = gatewayHarness('report-composer', {
    beforeExecute(input) {
      checks.push(input);
      throw blocked;
    },
  });

  await assert.rejects(
    guarded.gateway.execute('ws_write_file', {
      file: 'report/guarded.md',
      content: 'must not be written',
    }),
    (error) => error === blocked,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].request.workflowId, 'run-analysis.v1');
  assert.equal(checks[0].args.projectId, 'project-current');
  assert.equal(guarded.calls.length, 0);
  assert.equal(guarded.gateway.usage().toolAttempts, 0);
  assert.equal(guarded.gateway.usage().toolCalls, 0);
});

test('cross-project-disabled reads permit explicit current files/list but deny other projects and library enumeration', async () => {
  const currentRead = gatewayHarness('logic-reviewer');
  await currentRead.gateway.execute('ws_read_file', { projectId: 'project-current', file: 'report/report.md' });
  await currentRead.gateway.execute('ws_list_files', { projectId: 'project-current' });
  assert.equal(currentRead.calls.length, 2);

  const otherRead = gatewayHarness('logic-reviewer');
  await expectPermission(
    otherRead.gateway.execute('ws_read_file', { projectId: 'project-other', file: 'report/report.md' }),
    'cross-project-read-denied',
  );
  const enumeration = gatewayHarness('logic-reviewer');
  await expectPermission(
    enumeration.gateway.execute('ws_search_library', { currentProjectId: 'project-current', query: 'AI' }),
    'cross-project-read-denied',
  );
  const reviewer = getAgentDefinition('logic-reviewer');
  const projectSearch = gatewayHarness('logic-reviewer', {
    contract: withPolicy(reviewer, {
      toolPolicy: { allow: [...reviewer.toolPolicy.allow, 'project_search'] },
    }),
  });
  await expectPermission(
    projectSearch.gateway.execute('project_search', { currentProjectId: 'project-current', query: 'AI' }),
    'cross-project-read-denied',
  );

  const crossAllowed = gatewayHarness('data-orchestrator');
  await crossAllowed.gateway.execute('ws_read_file', { projectId: 'project-other', file: 'report/report.md' });
  await crossAllowed.gateway.execute('ws_search_library', { currentProjectId: 'project-current', query: 'AI' });
  assert.equal(crossAllowed.calls.length, 2);

  const malformedCrossPolicy = gatewayHarness('data-orchestrator', {
    contract: withPolicy(getAgentDefinition('data-orchestrator'), {
      contextPolicy: { allowCrossProjectRead: 'false' },
    }),
  });
  await expectPermission(
    malformedCrossPolicy.gateway.execute('ws_read_file', { projectId: 'project-other', file: 'report/report.md' }),
    'cross-project-read-denied',
  );
});

test('project tools require the project mount and current-project identity', async () => {
  const reviewer = getAgentDefinition('logic-reviewer');
  const noMount = gatewayHarness('logic-reviewer', {
    contract: withPolicy(reviewer, { contextPolicy: { mounts: [] } }),
  });
  await expectPermission(
    noMount.gateway.execute('ws_read_file', { projectId: 'project-current', file: 'report/report.md' }),
    'project-mount-required',
  );

  const report = gatewayHarness('report-composer');
  await expectPermission(report.gateway.execute('ws_write_file', {
    currentProjectId: 'project-other',
    projectId: 'project-other',
    file: 'report/report.md',
    content: 'wrong project',
  }), 'project-identity-mismatch');
  assert.equal(report.calls.length, 0);
});

test('unsafe relative paths fail closed before write-scope matching', async () => {
  for (const file of ['/report/absolute.md', 'report/../analysis/escape.md', 'report\\windows.md']) {
    const harness = gatewayHarness('report-composer');
    await expectPermission(
      harness.gateway.execute('ws_write_file', { file, content: 'x' }),
      'unsafe-tool-path',
    );
    assert.equal(harness.calls.length, 0);
  }
});

test('Industry and Company migration scopes reject cross-owner and report writes', async () => {
  const industry = gatewayHarness('industry-analyst');
  await industry.gateway.execute('ws_write_file', { file: 'analysis/industry.json', content: '{}' });
  await expectPermission(
    industry.gateway.execute('ws_write_file', { file: 'analysis/company.json', content: '{}' }),
    'write-scope-denied',
  );
  await expectPermission(
    industry.gateway.execute('ws_write_file', { file: 'report/report.md', content: 'forbidden' }),
    'write-scope-denied',
  );
  assert.equal(industry.calls.length, 1);

  const company = gatewayHarness('company-analyst');
  await company.gateway.execute('ws_write_file', { file: 'analysis/company.json', content: '{}' });
  await expectPermission(
    company.gateway.execute('ws_write_file', { file: 'analysis/industry.json', content: '{}' }),
    'write-scope-denied',
  );
  await expectPermission(
    company.gateway.execute('ws_write_file', { file: 'report/report.md', content: 'forbidden' }),
    'write-scope-denied',
  );
  assert.equal(company.calls.length, 1);
});

test('tool-call budget reserves before execution and emits an auditable exhaustion denial', async () => {
  const company = getAgentDefinition('company-analyst');
  const harness = gatewayHarness('company-analyst', {
    contract: withPolicy(company, { runPolicy: { toolCallBudget: 1 } }),
  });
  await harness.gateway.execute('fmp_quote', { symbol: 'NVDA' });
  await expectPermission(harness.gateway.execute('fmp_quote', { symbol: 'AMD' }), 'tool-call-budget-exhausted');
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.audits.at(-1).reason, 'tool-call-budget-exhausted');
  assert.equal(harness.gateway.usage().toolCalls, 1);

  const invalidBudget = gatewayHarness('company-analyst', {
    contract: withPolicy(company, { runPolicy: { toolCallBudget: 'not-a-number' } }),
  });
  await expectPermission(invalidBudget.gateway.execute('fmp_quote', { symbol: 'NVDA' }), 'tool-call-budget-exhausted');
  assert.equal(invalidBudget.calls.length, 0, 'invalid budgets fail closed instead of becoming unlimited');
});

test('explicit afterDate, beforeDate, and year beyond request asOf are denied without wall-clock blanket checks', async () => {
  const dataContract = getAgentDefinition('data-orchestrator');
  const futureArgs = [
    ['pplx_search', { query: 'future', afterDate: '7/16/2026' }],
    ['pplx_search', { query: 'future', beforeDate: '2026-07-16' }],
    ['fmp_transcript', { symbol: 'AAPL', quarter: 1, year: 2027 }],
  ];
  for (const [tool, args] of futureArgs) {
    const harness = gatewayHarness('data-orchestrator');
    await expectPermission(harness.gateway.execute(tool, args), 'temporal-argument-after-as-of');
    assert.equal(harness.calls.length, 0);
  }

  const fractionalYear = gatewayHarness('data-orchestrator');
  await expectPermission(
    fractionalYear.gateway.execute('fmp_transcript', { symbol: 'AAPL', quarter: 1, year: 2027.5 }),
    'temporal-argument-invalid',
  );
  assert.equal(fractionalYear.calls.length, 0);

  const historicalRequest = requestFor('data-orchestrator', { asOf: '2020-06-15T12:00:00.000Z' });
  const historical = gatewayHarness('data-orchestrator', { request: historicalRequest, contract: dataContract });
  await historical.gateway.execute('fmp_transcript', { symbol: 'AAPL', quarter: 1 });
  await historical.gateway.execute('fmp_transcript', { symbol: 'AAPL', quarter: 1, year: 2020 });
  assert.equal(historical.calls.length, 2, 'omitted defaults and same-year history are not denied from wall-clock time');
});

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

class ToolCallingPiAgent {
  constructor(options, { toolName, args }) {
    this.options = options;
    this.toolName = toolName;
    this.args = args;
    this.listeners = [];
    this.state = { messages: [], tools: [...(options.initialState.tools || [])] };
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {};
  }

  async emit(event) {
    for (const listener of this.listeners) await listener(event, new AbortController().signal);
  }

  async prompt() {
    await this.emit({ type: 'agent_start' });
    const tool = this.state.tools.find((candidate) => candidate.name === this.toolName);
    await this.emit({ type: 'tool_execution_start', toolCallId: 'pi-call-1', toolName: this.toolName, args: this.args });
    let result;
    let isError = false;
    try {
      result = await tool.execute('pi-call-1', this.args, new AbortController().signal);
    } catch (error) {
      isError = true;
      result = { content: [{ type: 'text', text: error.message }], details: { code: error.code, reason: error.reason } };
    }
    await this.emit({ type: 'tool_execution_end', toolCallId: 'pi-call-1', toolName: this.toolName, result, isError });
    const message = assistant('# Report\n\nDone.');
    this.state.messages.push(message);
    await this.emit({ type: 'turn_end', message, toolResults: [result] });
    await this.emit({ type: 'agent_end', messages: [message] });
  }

  abort() {}
}

const modelRouter = {
  resolve: () => ({
    model: { id: 'fake-model', provider: 'fake', api: 'fake', cost: { input: 0, output: 0 } },
    provider: 'fake',
    modelId: 'fake-model',
    reasoningLevel: 'standard',
    attemptedProviders: ['fake'],
    fallbackFrom: null,
    streamFn: () => {},
  }),
};

test('the real Pi tool-loop path applies gateway policy for allowed report writes', async () => {
  const project = ProjectSpace.create({ title: 'Gateway positive', theme: 'policy', tickers: ['AAPL'] });
  const audits = [];
  const request = requestFor('report-composer', { projectId: project.id, workspaceSnapshotId: `${project.id}:live` });
  let piAgent;
  const pi = new PiAgentBackend({
    contractResolver: getAgentDefinition,
    modelRouter,
    executeTool: runTool,
    onAudit: (record) => audits.push(record),
    agentFactory: (options) => (piAgent = new ToolCallingPiAgent(options, {
      toolName: 'ws_write_file',
      args: { file: 'report/report.md', content: 'pi allowed' },
    })),
  });

  const piResult = await pi.run({ ...request, runId: 'run-report-composer-pi', idempotencyKey: 'idem-report-pi' });

  assert.equal(piResult.status, 'succeeded');
  assert.equal(ProjectSpace.fileContent(project.id, 'report/report.md'), 'pi allowed');
  assert.ok(piAgent.state.tools.some((tool) => tool.name === 'ws_write_file'));
  assert.deepEqual(audits, []);
  ProjectSpace.delete(project.id);
});

test('the real Pi tool-loop path denies report-composer analysis writes with audits and no files', async () => {
  const project = ProjectSpace.create({ title: 'Gateway negative', theme: 'policy', tickers: ['AAPL'] });
  const audits = [];
  let rawCalls = 0;
  const countedRaw = async (name, args) => {
    rawCalls += 1;
    return runTool(name, args);
  };
  const request = requestFor('report-composer', { projectId: project.id, workspaceSnapshotId: `${project.id}:live` });
  const pi = new PiAgentBackend({
    contractResolver: getAgentDefinition,
    modelRouter,
    executeTool: countedRaw,
    onAudit: (record) => audits.push(record),
    agentFactory: (options) => new ToolCallingPiAgent(options, {
      toolName: 'ws_write_file',
      args: { file: 'analysis/pi-forbidden.md', content: 'PI_SECRET_PAYLOAD' },
    }),
  });

  const piResult = await pi.run({ ...request, runId: 'run-report-composer-pi-denied', idempotencyKey: 'idem-report-pi-denied' });

  assert.equal(piResult.status, 'partial', 'Pi cannot succeed without the required report artifact');
  assert.equal(rawCalls, 0);
  assert.equal(ProjectSpace.fileContent(project.id, 'analysis/pi-forbidden.md'), null);
  assert.deepEqual(audits.map((record) => record.reason), ['write-scope-denied']);
  assert.ok(piResult.events.some((event) => event.eventType === 'tool.permission.denied'));
  assert.doesNotMatch(
    JSON.stringify({ projectEvents: ProjectSpace.events(project.id), piTrace: piResult.trace, piEvents: piResult.events }),
    /PI_SECRET_PAYLOAD/u,
  );
  ProjectSpace.delete(project.id);
});

test('the real Pi path applies catalog coercion before raw tool execution', async () => {
  const base = getAgentDefinition('report-composer');
  const typedContract = withPolicy(base, {
    toolPolicy: { allow: ['fmp_transcript'], deny: [], externalRetrieval: 'full', writeScopes: [] },
  });
  const request = requestFor('report-composer');
  const rawCalls = [];
  const executeTool = async (name, args) => {
    rawCalls.push({ name, args });
    return { result: { ok: true } };
  };
  const pi = new PiAgentBackend({
    contractResolver: () => typedContract,
    modelRouter,
    executeTool,
    agentFactory: (options) => new ToolCallingPiAgent(options, {
      toolName: 'fmp_transcript',
      args: { symbol: 'AAPL', quarter: '2.5', year: '2020' },
    }),
  });

  await pi.run({ ...request, runId: 'run-typed-pi', idempotencyKey: 'idem-typed-pi' });

  assert.deepEqual(rawCalls, [
    { name: 'fmp_transcript', args: { symbol: 'AAPL', quarter: 2.5, year: 2020 } },
  ]);
});

test('backend budget exhaustion produces canonical partial stops and audit events', async () => {
  const project = ProjectSpace.create({ title: 'Gateway budget', theme: 'policy', tickers: ['AAPL'] });
  const base = getAgentDefinition('report-composer');
  const limitedContract = withPolicy(base, { runPolicy: { toolCallBudget: 0 } });
  const request = requestFor('report-composer', { projectId: project.id, workspaceSnapshotId: `${project.id}:live` });
  let rawCalls = 0;
  const executeTool = async () => { rawCalls += 1; return { result: { ok: true } }; };
  const pi = new PiAgentBackend({
    contractResolver: () => limitedContract,
    modelRouter,
    executeTool,
    agentFactory: (options) => new ToolCallingPiAgent(options, {
      toolName: 'ws_write_file',
      args: { file: 'report/pi-budget.md', content: 'blocked' },
    }),
  });

  const piResult = await pi.run({ ...request, runId: 'run-budget-pi', idempotencyKey: 'idem-budget-pi' });

  assert.equal(rawCalls, 0);
  assert.equal(piResult.status, 'partial');
  assert.equal(piResult.stopReason, 'tool-budget');
  assert.ok(piResult.events.some((event) => event.eventType === 'tool.permission.denied'));
  assert.ok(piResult.events.some((event) => event.eventType === 'budget.exhausted'));
  ProjectSpace.delete(project.id);
});
