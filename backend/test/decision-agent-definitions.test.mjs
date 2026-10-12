import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getAgentDefinition } from '../src/agents/registry.js';
import { dealLadderRankingAgent } from '../src/agents/definitions/decision/deal-ladder-ranking.agent.js';
import { ideaRankingAgent } from '../src/agents/definitions/decision/idea-ranking.agent.js';
import { beginDirectAgentCommand } from '../src/core/contracts/AgentExecutionScope.js';
import { getAgentSchema } from '../src/core/validation/agentSchemaRegistry.js';
import { rankByLadder } from '../src/domains/decision/dealLadder.js';

test('Decision model roles own explicit registered definitions', async () => {
  const definitions = [
    ['idea-ranking', ideaRankingAgent, 'idea-ranking.agent.js'],
    ['deal-ladder-ranking', dealLadderRankingAgent, 'deal-ladder-ranking.agent.js'],
  ];
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');

  for (const [id, definition, filename] of definitions) {
    assert.equal(definition.id, id);
    assert.equal(definition.domain, 'decision');
    assert.equal(definition.executionMode, 'json');
    assert.equal(getAgentDefinition(id), definition);
    assert.deepEqual(definition.toolPolicy.allow, []);
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));

    const source = await readFile(new URL(`../src/agents/definitions/decision/${filename}`, import.meta.url), 'utf8');
    assert.match(source, /defineAgent\s*\(/u);
    assert.match(source, /system\s*:/u);
    assert.match(source, /toolPolicy\s*:/u);
    assert.match(source, /outputSchema\s*:/u);
    assert.match(source, /visibility\s*:/u);
  }
});

test('Decision call sites use runDefinedAgent and no longer own prompts or schemas', async () => {
  const [decisionSource, ladderSource] = await Promise.all([
    readFile(new URL('../src/domains/decision/decisionSystem.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/domains/decision/dealLadder.js', import.meta.url), 'utf8'),
  ]);

  assert.match(decisionSource, /runDefinedAgent\s*\(\s*['"]idea-ranking['"]/u);
  assert.match(decisionSource, /beginDirectAgentCommand\s*\(/u);
  assert.doesNotMatch(decisionSource, /chatJSON|const sys\s*=|system\s*:/u);
  assert.match(ladderSource, /runDefinedAgent\s*\(\s*['"]deal-ladder-ranking['"]/u);
  assert.match(ladderSource, /beginDirectAgentCommand\s*\(/u);
  assert.match(ladderSource, /callId:\s*`\$\{phase\}:pass-/u);
  assert.doesNotMatch(ladderSource, /getDefaultAgentBackend/u);
  assert.doesNotMatch(ladderSource, /chatJSON|SCHEMAS|const sys\s*=|system\s*:/u);
});

test('Deal Ladder shares one direct command scope and derives distinct parallel call identities', async () => {
  const calls = [];
  const backend = {
    async run(request, runtime) {
      calls.push({ request, runtime });
      const ranking = String(request.input.candidateLines)
        .split('\n')
        .map((line, index) => ({
          ticker: line.match(/^\d+\.\s+([A-Z0-9.-]+)/u)?.[1],
          rank: index + 1,
          note: 'deterministic',
        }))
        .filter((item) => item.ticker);
      return {
        status: 'succeeded',
        output: { ranking },
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: {},
        stopReason: 'final',
        traceRef: request.runId,
      };
    },
  };
  const scope = beginDirectAgentCommand({
    commandId: 'ladder-command-1',
    workflowId: 'deal-ladder.v1',
    nodeId: 'rank-candidates',
    projectId: 'global',
    asOf: '2026-07-23T06:00:00.000Z',
    workspaceMode: 'none',
  });
  const candidates = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((ticker) => ({
    ticker,
    name: ticker,
    confidence: 0.7,
    recommendationScore: 70,
    thesis: `${ticker} thesis`,
  }));

  await rankByLadder(candidates, {
    topN: 3,
    backend,
    executionScope: scope,
  });

  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(({ request }) => request.idempotencyKey)).size, 3);
  for (const { request, runtime } of calls) {
    assert.equal(request.workflowId, scope.workflowId);
    assert.equal(request.nodeId, scope.nodeId);
    assert.equal(request.asOf, scope.asOf);
    assert.equal(request.workspaceSnapshotId, scope.workspaceSnapshotId);
    assert.equal(request.idempotencyKeyMode, 'explicit');
    assert.equal(runtime.artifactCommitOwner, 'agent');
    assert.equal(runtime.workspaceMode, 'none');
  }
});

test('Pi-first Decision roles resolve their declared output schemas', () => {
  for (const definition of [ideaRankingAgent, dealLadderRankingAgent]) {
    assert.ok(getAgentSchema(definition.outputSchema), `${definition.id} output schema must resolve`);
    assert.ok(definition.completionPolicy.hardChecks.includes('output-schema'));
    assert.deepEqual(definition.modelPolicy.preferredProviders, ['openai-compatible']);
    assert.equal(Object.keys(definition).some((field) => field.startsWith('legacy') || field === 'runtimeName'), false);
  }
});
