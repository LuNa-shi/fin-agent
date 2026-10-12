import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-api-w5-'));
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = '1';
process.env.AUTO_RESUME = 'false';

const [
  config,
  workflow,
  projection,
  ideaFacade,
] = await Promise.all([
  import('../src/config.js'),
  import('../src/workflows/idea-generation/runIdeaGeneration.js'),
  import('../src/workflows/idea-generation/runApiProjection.js'),
  import('../src/workflows/idea-generation/ideaSystem.js'),
]);

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const MANDATE = Object.freeze({
  style: 'balanced',
  minMarketCap: 1e9,
  maxLeverage: 4,
  minCandidates: 3,
  maxCandidates: 24,
  maxHoldings: 10,
  convexityBonus: 0.15,
  horizonPref: '6-12M',
  allowDataGap: false,
  maxProjectAgeDays: 45,
});

test('completed v2 demo is read back only from durable run state and formal artifacts', async () => {
  let backendCalls = 0;
  const runId = 'idea_run_durable_api_demo';
  const result = await workflow.runIdeaGenerationWorkflow(2, {
    agentBackend: {
      async run() {
        backendCalls += 1;
        throw new Error('explicit demo must not invoke an Agent backend');
      },
    },
    services: {
      runId,
      asOf: '2026-07-23T12:00:00.000Z',
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: true },
    },
  });

  assert.equal(backendCalls, 0);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.generated.length, 2);

  const trace = projection.ideaGenerationTrace(runId);
  assert.equal(trace.runId, runId);
  assert.equal(trace.status, 'SUCCEEDED');
  assert.equal(trace.live, false);
  assert.equal(trace.provider, 'demo');
  assert.equal(trace.nodes.length, 6);
  assert.equal(trace.artifacts.length, 6);
  assert.deepEqual(
    trace.ideas.map((idea) => idea.id),
    result.generated.map((idea) => idea.id),
  );

  const progress = projection.ideaGenerationProgress({ runId });
  assert.equal(progress.running, false);
  assert.equal(progress.steps.every((step) => step.status === 'done'), true);
  assert.equal(progress.generated.length, 2);

  const exactNode = projection.ideaGenerationTrace(runId, {
    nodeId: 'verify-candidates',
  });
  assert.deepEqual(exactNode.nodes.map((node) => node.nodeId), ['verify-candidates']);
  assert.equal(exactNode.nodeOutput.validIdeas.length, 2);
  assert.equal(exactNode.steps.length, 1);
  assert.equal(exactNode.steps[0].stage, 'screen');

  assert.equal(
    fs.existsSync(path.join(config.MEMORY_DIR, 'idea-traces.jsonl')),
    false,
    'durable reads do not create or depend on the legacy JSONL trace',
  );
});

test('IdeaSystem generation result used by the POST API excludes private executor outputs', async () => {
  let backendCalls = 0;
  const result = await ideaFacade.IdeaSystem.generate(2, {
    agentBackend: {
      async run() {
        backendCalls += 1;
        throw new Error('explicit demo must not invoke an Agent backend');
      },
    },
    services: {
      runId: 'idea_run_public_post_demo',
      asOf: '2026-07-23T12:05:00.000Z',
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: true },
    },
  });

  assert.equal(backendCalls, 0);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.generated.length, 2);
  assert.equal(Object.hasOwn(result, 'nodeExecutions'), false);
  assert.equal(JSON.stringify(result).includes('DEMO_MODE local idea generation'), false);
  assert.equal(
    JSON.stringify(result).includes('Generate deterministic demo ideas without external data access.'),
    false,
  );
});
