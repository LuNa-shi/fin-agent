import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'finagent-idea-w5-demo-'),
);
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = '1';
process.env.AUTO_RESUME = 'false';

const [
  config,
  agentRuntime,
  artifactContract,
  workflow,
  buildConstraints,
  generateCandidates,
  candidateSelection,
] = await Promise.all([
  import('../src/config.js'),
  import('../src/agents/AgentRuntimeService.js'),
  import('../src/core/contracts/ArtifactRef.js'),
  import('../src/workflows/idea-generation/ideaGeneration.workflow.js'),
  import('../src/workflows/idea-generation/handlers/buildDiversificationConstraints.js'),
  import('../src/workflows/idea-generation/handlers/generateCandidates.js'),
  import('../src/workflows/idea-generation/nodes/candidateSelection.js'),
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

function capturedAgentConfig(agentId) {
  const definition = agentRuntime.getEffectiveAgentDefinition(agentId);
  return {
    agentId,
    revision: definition.effectiveConfig.revision,
    digest: definition.effectiveConfig.digest,
  };
}

function demoSnapshot(existingIdeas) {
  const effectiveConfig = {
    agents: [
      capturedAgentConfig('idea-generator'),
      capturedAgentConfig('idea-quality-reviewer'),
    ],
  };
  return {
    runId: 'idea_run_demo_horizon',
    snapshotId: `idea-run-input-snapshot:${'d'.repeat(64)}`,
    asOf: '2026-07-23T09:00:00.000Z',
    inputs: {
      existingIdeas,
      positions: [],
      mandate: MANDATE,
      settings: {
        ...config.runtime,
        DEMO_MODE: true,
      },
      command: {
        count: 1,
        poolTarget: 8,
        targetPerNode: 8,
      },
    },
    effectiveConfig,
    configDigest: artifactContract.canonicalSha256(effectiveConfig),
  };
}

test('explicit demo preserves the characterized v1 Idea payload through v2', async () => {
  let backendCalls = 0;
  const result = await workflow.runIdeaGenerationWorkflow(2, {
    agentBackend: {
      async run() {
        backendCalls += 1;
        throw new Error('explicit demo must not invoke an Agent backend');
      },
    },
    services: {
      runId: 'idea_run_demo_v1_payload',
      asOf: '2026-07-23T10:00:00.000Z',
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: true },
    },
  });

  assert.equal(backendCalls, 0);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.provider, 'demo');
  assert.equal(result.live, false);
  assert.deepEqual(
    result.generated.map((idea) => idea.heat),
    [75, 72],
  );
  assert.deepEqual(
    result.generated.map((idea) => idea.qualityScore),
    [50, 50],
  );
  assert.ok(result.generated.every((idea) => (
    idea.qualityRank === null
    && idea.qualitySelected === null
    && idea.qualitySource === 'deterministic-demo'
    && idea.qualityWarnings.includes('quality-review-not-required')
  )));
  assert.deepEqual(
    result.generated.map((idea) => idea.sourceAgents),
    [
      ['demo-idea-agent', 'backfill-idea-agent'],
      ['demo-idea-agent', 'backfill-idea-agent'],
    ],
  );
});

test('explicit demo retains the v1 80-title horizon', async () => {
  const firstDemoTitle = candidateSelection.backfillDemoIdeas([], 1, [])[0].title;
  const existingIdeas = Array.from({ length: 100 }, (_, index) => ({
    id: `idea_existing_${index}`,
    title: `Existing compatibility title ${index}`,
    theme: 'compatibility',
    tickers: [],
    status: 'new',
  }));
  existingIdeas[79] = {
    ...existingIdeas[79],
    title: firstDemoTitle,
  };
  const snapshot = demoSnapshot(existingIdeas);
  const context = {
    snapshot,
    nodeResults: {
      'collect-market-context': {
        market: {},
        sourceCandidates: [],
      },
    },
    services: {
      getEffectiveAgentDefinition: agentRuntime.getEffectiveAgentDefinition,
    },
  };

  const constraints = await buildConstraints.execute(context);
  assert.equal(constraints.existingTitles.length, 80);
  assert.equal(constraints.existingTitles[79], firstDemoTitle);

  const generated = await generateCandidates.execute({
    ...context,
    nodeResults: {
      ...context.nodeResults,
      'build-diversification-constraints': constraints,
    },
  });
  assert.equal(generated.rawCandidates.length, 1);
  assert.notEqual(generated.rawCandidates[0].title, firstDemoTitle);
  assert.deepEqual(
    generated.rawCandidates[0].sourceAgents,
    ['demo-idea-agent', 'backfill-idea-agent'],
  );
});

test('Follow-up-N prefixes keep later demo cycles distinct after title truncation', () => {
  const firstCycle = candidateSelection.backfillDemoIdeas([], 8, []);
  const followUp = candidateSelection.backfillDemoIdeas(
    [],
    1,
    firstCycle.map((idea) => idea.title),
  )[0];

  assert.match(followUp.title, /^Follow-up 2:/u);
  assert.equal(
    firstCycle.some((idea) => (
      candidateSelection.normalizeIdeaTitle(idea.title)
      === candidateSelection.normalizeIdeaTitle(followUp.title)
    )),
    false,
  );
});
