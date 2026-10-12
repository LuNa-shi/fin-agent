import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'finagent-idea-w5-lineage-'),
);
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = '0';
process.env.AUTO_RESUME = 'false';

const [
  config,
  artifactContract,
  workflow,
  runStorageModule,
  persistHandler,
] = await Promise.all([
  import('../src/config.js'),
  import('../src/core/contracts/ArtifactRef.js'),
  import('../src/workflows/idea-generation/ideaGeneration.workflow.js'),
  import('../src/workflows/idea-generation/runtime/IdeaGenerationRunStorage.js'),
  import('../src/workflows/idea-generation/handlers/persistIdeas.js'),
]);
const {
  FileIdeaStore,
  IdeaStore,
  normalizeIdeaTitle,
} = await import('../src/domains/ideas/IdeaStore.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SNAPSHOT_A = `idea-run-input-snapshot:${'a'.repeat(64)}`;
const SNAPSHOT_B = `idea-run-input-snapshot:${'b'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'c'.repeat(64)}`;
const AS_OF = '2026-07-23T08:00:00.000Z';
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

function idea(id, title, overrides = {}) {
  return {
    id,
    title,
    sentence: title,
    theme: 'power infrastructure',
    heat: 70,
    rationale: 'Grid investment remains above consensus.',
    tickers: ['GEV'],
    droppedTickers: [],
    catalyst: 'Utility capital plans',
    edge: 'Order growth is underestimated.',
    titleZh: '',
    rationaleZh: '',
    catalystZh: '',
    edgeZh: '',
    sourceAgents: ['llm-idea-agent'],
    timeHorizon: 'next 2-4 quarters',
    status: 'new',
    ...overrides,
  };
}

function executionLineage({
  runId = 'idea_run_lineage_a',
  snapshotId = SNAPSHOT_A,
  generatorTraceRef = 'trace:generator:a',
  qualityTraceRef = null,
} = {}) {
  return {
    sourceIdeaRunId: runId,
    sourceRunInputSnapshotId: snapshotId,
    sourceRunAsOf: AS_OF,
    sourceEffectiveConfigDigest: CONFIG_DIGEST,
    sourceGeneratorTraceRef: generatorTraceRef,
    sourceQualityTraceRef: qualityTraceRef,
  };
}

function storeFixture(t, label) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `finagent-idea-${label}-`),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let timestamp = 1_000;
  const store = new FileIdeaStore({
    ideasDir: path.join(root, 'idea-generation', 'ideas'),
    legacyStore: { getIdeas: () => [] },
    index: null,
    now: () => timestamp++,
  });
  const index = {
    read() {
      const entries = store.getIdeas().map((record) => ({
        id: record.id,
        type: 'idea',
        status: record.status,
        title: record.title,
        contentRef: record.contentRef,
        contentDigest: record.contentDigest,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
      return {
        entries,
        indexDigest: artifactContract.canonicalSha256(entries),
      };
    },
  };
  return { root, store, index };
}

function persistenceContext({
  store,
  index,
  runId,
  snapshotId,
  ideas,
  rejected = [],
}) {
  return {
    runId,
    snapshot: {
      snapshotId,
      asOf: AS_OF,
      configDigest: CONFIG_DIGEST,
    },
    nodeResults: {
      'generate-candidates': {
        agent: { traceRef: `trace:generator:${runId}` },
      },
      'verify-candidates': { rejected },
      'review-quality': {
        ideas,
        agent: null,
      },
    },
    services: {
      ideaStore: store,
      globalContentIndex: index,
    },
  };
}

test('W5 execution lineage is creation-preserved, alias-validated, and update-immutable', (t) => {
  const { store } = storeFixture(t, 'lineage-authority');
  const lineage = {
    sourceRunId: 'idea_run_lineage_a',
    sourceSnapshotId: SNAPSHOT_A,
  };
  const fields = executionLineage();
  const [created] = store.addIdeas([
    {
      ...idea('idea_lineage', 'Immutable run lineage'),
      ...fields,
    },
  ], lineage);

  for (const [field, value] of Object.entries(fields)) {
    assert.equal(created[field], value);
  }
  assert.equal(created.sourceRunId, lineage.sourceRunId);
  assert.equal(created.sourceSnapshotId, lineage.sourceSnapshotId);

  const updated = store.updateIdea(created.id, {
    status: 'added',
    rationale: 'Mutable investment note.',
  });
  assert.equal(updated.status, 'added');
  assert.equal(updated.rationale, 'Mutable investment note.');
  for (const [field, value] of Object.entries(fields)) {
    assert.equal(updated[field], value);
  }

  for (const field of Object.keys(fields)) {
    assert.throws(
      () => store.updateIdea(created.id, { [field]: null }),
      (error) => error?.code === 'IMMUTABLE_IDEA_FIELD',
      `${field} must be immutable after creation`,
    );
  }

  assert.throws(
    () => store.addIdeas([{
      ...idea('idea_partial_lineage', 'Partial W5 lineage'),
      sourceIdeaRunId: lineage.sourceRunId,
    }], lineage),
    (error) => error?.code === 'INVALID_IDEA_LINEAGE',
  );
  assert.throws(
    () => store.addIdeas([{
      ...idea('idea_mismatched_lineage', 'Mismatched W5 lineage'),
      ...fields,
      sourceIdeaRunId: 'idea_run_forged',
    }], lineage),
    (error) => error?.code === 'INVALID_IDEA_LINEAGE',
  );

  const [historical] = store.addIdeas([
    idea('idea_w4_compatible', 'W4-compatible lineage'),
  ], {
    sourceRunId: 'idea_run_w4',
    sourceSnapshotId: SNAPSHOT_B,
  });
  assert.equal(historical.sourceRunId, 'idea_run_w4');
  assert.equal(historical.sourceSnapshotId, SNAPSHOT_B);
  for (const field of Object.keys(fields)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(historical, field),
      false,
      `historical ${field} absence must remain honest`,
    );
  }
});

test('mixed persistence batches commit unique Ideas and audit normalized-title losers', async (t) => {
  const { store, index } = storeFixture(t, 'mixed-persistence');
  const winnerLineage = executionLineage({
    runId: 'idea_run_winner',
    snapshotId: SNAPSHOT_A,
  });
  const [winner] = store.addIdeas([{
    ...idea('idea_winner', 'Grid-Equipment Opportunity!'),
    ...winnerLineage,
  }], {
    sourceRunId: winnerLineage.sourceIdeaRunId,
    sourceSnapshotId: winnerLineage.sourceRunInputSnapshotId,
  });
  const winnerDigest = winner.contentDigest;

  const context = persistenceContext({
    store,
    index,
    runId: 'idea_run_loser',
    snapshotId: SNAPSHOT_B,
    ideas: [
      idea('idea_loser', 'GRID equipment opportunity'),
      idea('idea_unique', 'Distinct transformer opportunity'),
    ],
  });
  const output = await persistHandler.execute(context);

  assert.deepEqual(
    output.committed.map((record) => record.id),
    ['idea_unique'],
  );
  assert.equal(output.persistenceRejections.length, 1);
  assert.deepEqual(output.persistenceRejections[0], {
    index: 0,
    stage: 'persist-ideas',
    reason: 'duplicate-existing-title',
    ideaId: 'idea_loser',
    title: 'GRID equipment opportunity',
    normalizedTitle: normalizeIdeaTitle('GRID equipment opportunity'),
    existingIdeaRef: {
      id: winner.id,
      contentRef: winner.contentRef,
      contentDigest: winner.contentDigest,
      sourceIdeaRunId: 'idea_run_winner',
      sourceRunInputSnapshotId: SNAPSHOT_A,
    },
  });
  assert.deepEqual(output.rejected, output.persistenceRejections);
  assert.equal(store.getIdea(winner.id).contentDigest, winnerDigest);
  assert.equal(store.getIdea(winner.id).sourceIdeaRunId, 'idea_run_winner');
  assert.equal(store.getIdea(winner.id).sourceRunInputSnapshotId, SNAPSHOT_A);
  assert.equal(store.getIdea('idea_loser'), null);
  assert.equal(store.getIdea('idea_unique').sourceIdeaRunId, 'idea_run_loser');
});

test('same stable Idea id replays exactly but divergent content still fails closed', async (t) => {
  const { store, index } = storeFixture(t, 'stable-id-conflict');
  const base = idea('idea_stable', 'Stable replay identity');
  const context = persistenceContext({
    store,
    index,
    runId: 'idea_run_stable',
    snapshotId: SNAPSHOT_A,
    ideas: [base],
  });

  const first = await persistHandler.execute(context);
  const replay = await persistHandler.execute(context);
  assert.deepEqual(
    replay.committed.map((record) => record.id),
    first.committed.map((record) => record.id),
  );

  await assert.rejects(
    persistHandler.execute(persistenceContext({
      store,
      index,
      runId: 'idea_run_stable',
      snapshotId: SNAPSHOT_A,
      ideas: [{ ...base, heat: 5 }],
    })),
    (error) => error?.code === 'IDEA_PERSISTENCE_CONFLICT',
  );
});

function marketContext() {
  return {
    top: ['Industrials'],
    bottom: [],
    headlines: ['Grid investment continues'],
    sectorTable: ['Industrials +1%'],
    research: [],
    saIdeas: [],
    sourcesUsed: ['deterministic-test'],
    domainsUsed: ['industrials'],
  };
}

function succeeded(request, output) {
  return {
    status: 'succeeded',
    output,
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 },
    stopReason: 'final',
    traceRef: `trace:${request.runId}`,
    valid: true,
    provider: 'deterministic-test-backend',
    live: false,
  };
}

test('concurrent normalized-equivalent runs converge on one immutable winner', async () => {
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  let sourceArrivals = 0;
  let releaseSources;
  const sourceBarrier = new Promise((resolve) => {
    releaseSources = resolve;
  });
  const gatherMarketContext = async () => {
    sourceArrivals += 1;
    if (sourceArrivals === 2) releaseSources();
    await sourceBarrier;
    return marketContext();
  };
  const backend = {
    async run(request) {
      const title = request.runId.endsWith('_a')
        ? 'Concurrent Grid-Equipment Opportunity!'
        : 'CONCURRENT grid equipment opportunity';
      return succeeded(request, {
        ideas: [idea(undefined, title)],
      });
    },
  };
  const servicesFor = (runId, minute) => ({
    runId,
    asOf: `2026-07-23T12:${minute}:00.000Z`,
    runStorage,
    ideaStore: IdeaStore,
    getPortfolio: () => [],
    getMandate: () => MANDATE,
    runtimeSettings: { ...config.runtime, DEMO_MODE: false },
    gatherMarketContext,
    runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
    verifyCandidateTickers: async (tickers) => new Set(tickers),
  });

  const calls = [
    {
      runId: 'idea_run_normalized_race_a',
      services: servicesFor('idea_run_normalized_race_a', '01'),
    },
    {
      runId: 'idea_run_normalized_race_b',
      services: servicesFor('idea_run_normalized_race_b', '02'),
    },
  ];
  const results = await Promise.all(calls.map(({ services }) => (
    workflow.runIdeaGenerationWorkflow(1, { agentBackend: backend, services })
  )));

  assert.equal(sourceArrivals, 2);
  assert.deepEqual(results.map((result) => result.status), ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal(
    results.reduce((total, result) => total + result.generated.length, 0),
    1,
  );
  const winnerResult = results.find((result) => result.generated.length === 1);
  const loserResult = results.find((result) => result.generated.length === 0);
  const [winnerIdea] = winnerResult.generated;
  const persistenceRejection = loserResult.rejected.find((item) => (
    item.stage === 'persist-ideas'
  ));

  assert.equal(persistenceRejection.reason, 'duplicate-existing-title');
  assert.equal(persistenceRejection.existingIdeaRef.id, winnerIdea.id);
  assert.equal(winnerIdea.sourceIdeaRunId, winnerResult.runId);
  assert.equal(
    winnerIdea.sourceRunInputSnapshotId,
    winnerResult.snapshotId,
  );
  assert.notEqual(winnerIdea.sourceIdeaRunId, loserResult.runId);
  assert.equal(
    IdeaStore.getIdeas().filter((record) => (
      normalizeIdeaTitle(record.title)
      === normalizeIdeaTitle(winnerIdea.title)
    )).length,
    1,
  );

  for (const { runId, services } of calls) {
    const replay = await workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: {
        async run() {
          throw new Error('replay must not invoke an Agent backend');
        },
      },
      services: {
        ...services,
        runStorage: new runStorageModule.IdeaGenerationRunStorage(),
        getPortfolio: () => {
          throw new Error('replay must not reread Portfolio');
        },
        getMandate: () => {
          throw new Error('replay must not reread Mandate');
        },
        gatherMarketContext: async () => {
          throw new Error('replay must not repeat sources');
        },
      },
    });
    assert.equal(replay.runId, runId);
    assert.deepEqual(replay.execution.executedNodeIds, []);
    assert.equal(replay.status, 'SUCCEEDED');
  }
});
