import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { defineAgent } from '../src/agents/defineAgent.js';
import {
  AgentDefinitionRegistry,
  getAgentDefinition,
  listAgentDefinitions,
  RUN_ANALYSIS_AGENT_IDS,
} from '../src/agents/registry.js';
import { runDefinedAgent } from '../src/agents/runDefinedAgent.js';
import { beginDirectAgentCommand } from '../src/core/contracts/AgentExecutionScope.js';
import { analysisPlanAgent } from '../src/agents/definitions/run-analysis/analysis-plan.agent.js';
import {
  DATA_ORCHESTRATOR_TOOL_ALLOWLIST,
  dataOrchestratorAgent,
} from '../src/agents/definitions/run-analysis/data-orchestrator.agent.js';
import { industryAnalystAgent } from '../src/agents/definitions/run-analysis/industry-analyst.agent.js';
import { companyAnalystAgent } from '../src/agents/definitions/run-analysis/company-analyst.agent.js';
import { conclusionSynthesizerAgent } from '../src/agents/definitions/run-analysis/conclusion-synthesizer.agent.js';
import { scanScoreAgent } from '../src/agents/definitions/run-analysis/scan-score.agent.js';
import { evidenceReviewerAgent } from '../src/agents/definitions/run-analysis/evidence-reviewer.agent.js';
import { logicReviewerAgent } from '../src/agents/definitions/run-analysis/logic-reviewer.agent.js';
import { reportComposerAgent } from '../src/agents/definitions/run-analysis/report-composer.agent.js';
import { requirementReviewerAgent } from '../src/agents/definitions/run-analysis/requirement-reviewer.agent.js';

const validSpec = (overrides = {}) => ({
  id: 'unit-agent',
  version: '1.0.0',
  domain: 'unit',
  purpose: 'Exercise the generic declarative Agent boundary.',
  visibility: { catalog: 'internal', workflows: ['unit.v1'] },
  executionMode: 'tool-loop',
  prompt: (input = {}) => ({ system: 'unit system', user: String(input.user || 'unit user') }),
  inputSchema: 'unit-agent.input.v1',
  outputSchema: 'unit-agent.output.v1',
  contextPolicy: {
    mounts: ['/project'], artifactSelectors: [], maxInlineTokens: 1000,
    allowPriorReview: false, allowCrossProjectRead: false,
  },
  toolPolicy: {
    allow: ['fmp_quote'], deny: [], externalRetrieval: 'targeted', writeScopes: [],
  },
  modelPolicy: {
    tier: 'fast', preferredProviders: ['deepseek'], reasoningLevel: 'low',
  },
  runPolicy: {
    maxTurns: 2, deadlineMs: 1000, tokenBudget: 1000, toolCallBudget: 1,
    retry: { maxAttempts: 1, retryOn: [] },
  },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: false },
  artifactAuthority: 'return',
  outputPaths: [],
  ...overrides,
});

test('defineAgent requires every catalog, contract, policy, and artifact field', () => {
  const required = [
    'id', 'version', 'domain', 'purpose', 'visibility', 'executionMode', 'prompt',
    'inputSchema', 'outputSchema', 'contextPolicy', 'toolPolicy', 'modelPolicy',
    'runPolicy', 'completionPolicy', 'artifactAuthority', 'outputPaths',
  ];
  for (const field of required) {
    const spec = validSpec();
    delete spec[field];
    assert.throws(() => defineAgent(spec), new RegExp(`AgentDefinition\\.${field} is required`, 'u'), field);
  }
});

test('defineAgent deep-freezes definitions and preserves the AgentContract shape', () => {
  const definition = defineAgent(validSpec());

  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.visibility), true);
  assert.equal(Object.isFrozen(definition.visibility.workflows), true);
  assert.equal(Object.isFrozen(definition.contextPolicy.artifactSelectors), true);
  assert.equal(Object.isFrozen(definition.toolPolicy.allow), true);
  assert.equal(Object.isFrozen(definition.modelPolicy.preferredProviders), true);
  assert.equal(Object.isFrozen(definition.runPolicy.retry), true);
  assert.equal(Object.isFrozen(definition.completionPolicy.hardChecks), true);
  assert.equal(Object.isFrozen(definition.outputPaths), true);
  assert.equal(definition.executionMode, 'tool-loop');
  assert.deepEqual(definition.prompt({ user: 'hello' }), { system: 'unit system', user: 'hello' });
});

test('defineAgent validates visibility and resolves every allowed tool fail-closed', () => {
  assert.throws(
    () => defineAgent(validSpec({ visibility: { catalog: 'internal' } })),
    /AgentDefinition\.visibility\.workflows must be an array/u,
  );
  assert.throws(
    () => defineAgent(validSpec({ toolPolicy: { ...validSpec().toolPolicy, allow: ['not_a_registered_tool'] } })),
    /unknown tool in unit-agent Tool Use: not_a_registered_tool/u,
  );
});

test('AgentDefinitionRegistry rejects duplicates and preserves explicit order', () => {
  const alpha = defineAgent(validSpec({ id: 'alpha-agent' }));
  const beta = defineAgent(validSpec({ id: 'beta-agent' }));
  const registry = new AgentDefinitionRegistry([alpha, beta]);

  assert.deepEqual(registry.ids(), ['alpha-agent', 'beta-agent']);
  assert.equal(registry.get('alpha-agent'), alpha);
  assert.deepEqual(registry.list(), [alpha, beta]);
  assert.throws(() => registry.register(alpha), /duplicate Agent definition: alpha-agent/u);
  assert.throws(
    () => registry.register(Object.freeze({ id: 'forged-agent' })),
    /Agent definition must be created with defineAgent: forged-agent/u,
  );
  assert.throws(() => registry.get('missing-agent'), /unknown Agent definition: missing-agent/u);
});

test('default Agent Registry explicitly exposes every current Run Analysis definition', async () => {
  const definitions = listAgentDefinitions();
  assert.deepEqual(definitions.slice(0, RUN_ANALYSIS_AGENT_IDS.length).map((item) => item.id), [...RUN_ANALYSIS_AGENT_IDS]);
  for (const id of RUN_ANALYSIS_AGENT_IDS) {
    const definition = getAgentDefinition(id);
    assert.equal(definition.domain, 'run-analysis');
    const expectedWorkflows = ['report-optimization.v1'];
    assert.deepEqual(definition.visibility, { catalog: 'internal', workflows: expectedWorkflows });
  }

  const source = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');
  assert.match(source, /^import .* from ['"].+['"];$/mu);
  assert.doesNotMatch(source, /readdir|glob|walkSync|import\s*\(/u);
});

test('nonzero tool-call limits are anomaly safety fuses rather than normal completion caps', () => {
  for (const definition of listAgentDefinitions()) {
    const limit = definition.runPolicy.toolCallBudget;
    assert.ok(limit === 0 || (limit >= 64 && limit <= 256), `${definition.id} has a normal-path tool cap: ${limit}`);
    if (definition.inRunAnalysis && limit > 0) {
      assert.ok(definition.runPolicy.maxTurns >= 24, `${definition.id} has a normal-path turn cap: ${definition.runPolicy.maxTurns}`);
    }
  }
});

test('active Agent definitions are Pi-only and select one OpenAI-compatible provider', () => {
  for (const definition of listAgentDefinitions()) {
    assert.deepEqual(definition.modelPolicy.preferredProviders, ['openai-compatible'], `${definition.id} must default to the OpenAI-compatible provider`);
    assert.equal(Object.prototype.hasOwnProperty.call(definition, 'legacyName'), false, `${definition.id} retains legacyName`);
    assert.equal(Object.prototype.hasOwnProperty.call(definition, 'runtimeName'), false, `${definition.id} retains runtimeName`);
    assert.equal(Object.prototype.hasOwnProperty.call(definition, 'legacyOutputSchema'), false, `${definition.id} retains legacyOutputSchema`);
  }
});

test('planning and reasoning roles each own one explicit definition file', async () => {
  const splitDefinitions = [
    ['analysis-plan', analysisPlanAgent, 'analysis-plan.agent.js'],
    ['scan-score', scanScoreAgent, 'scan-score.agent.js'],
  ];
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');

  for (const [id, definition, filename] of splitDefinitions) {
    assert.equal(definition.id, id);
    assert.equal(getAgentDefinition(id), definition);
    assert.equal(RUN_ANALYSIS_AGENT_IDS.includes(id), true);
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));

    const definitionSource = await readFile(new URL(`../src/agents/definitions/run-analysis/${filename}`, import.meta.url), 'utf8');
    assert.match(definitionSource, /defineAgent\s*\(/u);
    assert.match(definitionSource, /system\s*:/u);
    assert.match(definitionSource, /toolPolicy\s*:/u);
    assert.match(definitionSource, /outputSchema\s*:/u);
    assert.match(definitionSource, /visibility\s*:/u);
  }

});

test('core research roles own explicit definitions in the canonical Run Analysis set', async () => {
  const splitDefinitions = [
    ['data-orchestrator', dataOrchestratorAgent, 'data-orchestrator.agent.js'],
    ['industry-analyst', industryAnalystAgent, 'industry-analyst.agent.js'],
    ['company-analyst', companyAnalystAgent, 'company-analyst.agent.js'],
  ];
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');

  for (const [id, definition, filename] of splitDefinitions) {
    assert.equal(definition.id, id);
    assert.equal(getAgentDefinition(id), definition);
    assert.equal(RUN_ANALYSIS_AGENT_IDS.includes(id), true, `${id} is absent from Run Analysis`);
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));

    const definitionSource = await readFile(new URL(`../src/agents/definitions/run-analysis/${filename}`, import.meta.url), 'utf8');
    assert.match(definitionSource, /defineAgent\s*\(/u);
    assert.match(definitionSource, /system\s*:/u);
    assert.match(definitionSource, /toolPolicy\s*:/u);
    assert.match(definitionSource, /outputSchema\s*:/u);
    assert.match(definitionSource, /visibility\s*:/u);
  }

  assert.deepEqual(dataOrchestratorAgent.toolPolicy.allow, [...DATA_ORCHESTRATOR_TOOL_ALLOWLIST]);
  assert.equal(industryAnalystAgent.outputSchema, 'industryAnalysis.v1');
  assert.equal(companyAnalystAgent.outputSchema, 'companyAnalysis.v1');
});

test('review, report, and conclusion roles each own one explicit definition file', async () => {
  const splitDefinitions = [
    ['report-composer', reportComposerAgent, 'report-composer.agent.js'],
    ['evidence-reviewer', evidenceReviewerAgent, 'evidence-reviewer.agent.js'],
    ['requirement-reviewer', requirementReviewerAgent, 'requirement-reviewer.agent.js'],
    ['logic-reviewer', logicReviewerAgent, 'logic-reviewer.agent.js'],
    ['conclusion-synthesizer', conclusionSynthesizerAgent, 'conclusion-synthesizer.agent.js'],
  ];
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');

  for (const [id, definition, filename] of splitDefinitions) {
    assert.equal(definition.id, id);
    assert.equal(getAgentDefinition(id), definition);
    assert.equal(RUN_ANALYSIS_AGENT_IDS.includes(id), true);
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));

    const definitionSource = await readFile(new URL(`../src/agents/definitions/run-analysis/${filename}`, import.meta.url), 'utf8');
    assert.match(definitionSource, /defineAgent\s*\(/u);
    assert.match(definitionSource, /system\s*:/u);
    assert.match(definitionSource, /toolPolicy\s*:/u);
    assert.match(definitionSource, /outputSchema\s*:/u);
    assert.match(definitionSource, /visibility\s*:/u);
  }

});

test('runDefinedAgent creates the canonical Pi request and isolates runtime overrides', async () => {
  let received;
  const backend = {
    run: async (request, runtime) => {
      received = { request, runtime };
      return { status: 'succeeded', output: { logic: 'ok' } };
    },
  };

  const scope = beginDirectAgentCommand({
    commandId: 'agent-definition-request',
    workflowId: 'agent-definition-test.v1',
    nodeId: 'plan',
    projectId: 'project-1',
    asOf: '2026-07-14T00:00:00.000Z',
    workspaceMode: 'project',
  });
  const result = await runDefinedAgent('analysis-plan', { theme: 'AI infrastructure' }, {
    backend,
    scope,
    temperature: 0.2,
  });

  assert.equal(result.output.logic, 'ok');
  assert.equal(received.request.agentContractId, 'analysis-plan');
  assert.equal(received.request.contractVersion, '1.0.0');
  assert.equal(received.request.workflowId, 'agent-definition-test.v1');
  assert.equal(received.request.projectId, 'project-1');
  assert.equal(received.request.nodeId, 'plan');
  assert.equal(received.request.workspaceSnapshotId, 'project-1:live');
  assert.match(received.request.effectiveConfigRevision, /^definition@1\.0\.0;overlay@0;skills@none$/u);
  assert.match(received.request.effectiveConfigDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(received.runtime.temperature, 0.2);
  assert.equal(received.runtime.contractOverride.id, 'analysis-plan');
  assert.equal(received.runtime.contractOverride.effectiveConfig.digest, received.request.effectiveConfigDigest);
  assert.equal(Object.prototype.hasOwnProperty.call(received.runtime, 'backend'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(received.runtime, 'runId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(received.runtime, 'idempotencyKey'), false);
});

test('runDefinedAgent preserves failed-result throwing semantics', async () => {
  const error = new Error('unit failure');
  const backend = { run: async () => ({ status: 'failed', stopReason: 'error', error }) };
  const scope = beginDirectAgentCommand({
    commandId: 'agent-definition-failure',
    workflowId: 'agent-definition-test.v1',
    nodeId: 'plan',
    projectId: 'project-1',
    asOf: '2026-07-14T00:00:00.000Z',
    workspaceMode: 'project',
  });
  await assert.rejects(() => runDefinedAgent('analysis-plan', {}, { backend, scope }), error);
  const result = await runDefinedAgent('analysis-plan', {}, {
    backend,
    scope,
    throwOnFailure: false,
  });
  assert.equal(result.status, 'failed');
});

test('runDefinedAgent remains a logic-free compatibility delegate to AgentExecutionRuntime', async () => {
  const source = await readFile(new URL('../src/agents/runDefinedAgent.js', import.meta.url), 'utf8');
  assert.match(source, /agentExecutionRuntime\.run\s*\(/u);
  assert.doesNotMatch(source, /createAgentRunRequest|getDefaultAgentBackend|currentWorkflowNodeContext/u);
});
