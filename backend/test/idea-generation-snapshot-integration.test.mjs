import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-generation-w4-'));
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = '0';

const [
  config,
  executionScope,
  ideasDomain,
  globalState,
  workflow,
  runStorageModule,
  runProjection,
  inputSnapshot,
] = await Promise.all([
  import('../src/config.js'),
  import('../src/core/contracts/AgentExecutionScope.js'),
  import('../src/domains/ideas/index.js'),
  import('../src/core/persistence/globalState.js'),
  import('../src/workflows/idea-generation/ideaGeneration.workflow.js'),
  import('../src/workflows/idea-generation/runtime/IdeaGenerationRunStorage.js'),
  import('../src/workflows/idea-generation/runApiProjection.js'),
  import('../src/workflows/idea-generation/runtime/inputSnapshot.js'),
]);
const { globalContentIndex } = await import('../src/core/persistence/GlobalContentIndex.js');

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

function candidate(title, ticker, heat = 70) {
  return {
    title,
    sentence: title,
    theme: 'power infrastructure',
    heat,
    rationale: `${title} rationale`,
    tickers: [ticker],
    catalyst: 'Capital spending',
    edge: 'Consensus underestimates demand',
    sourceAgents: ['deterministic-test-source'],
    timeHorizon: 'next 2-4 quarters',
    status: 'new',
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
    traceRef: request.runId,
    valid: true,
    provider: 'deterministic-test-backend',
    live: false,
  };
}

test('Idea Generation snapshot supports direct 100-idea daily gates', () => {
  const snapshot = inputSnapshot.openIdeaRunInputSnapshot(100, {
    services: {
      runId: 'idea_run_daily_100_gate_snapshot',
      asOf: '2026-08-01T00:00:00.000Z',
      ideaStore: { getIdeas: () => [] },
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: false },
    },
  });

  assert.equal(snapshot.inputs.command.count, 100);
  assert.equal(snapshot.inputs.command.poolTarget, 100);
});

test('Idea Generation captures one snapshot before sources and binds both Agent requests', async () => {
  const calls = [];
  const observedPortfolios = [];
  const mutablePortfolio = [{
    id: 'pos_1',
    ticker: 'PWR',
    theme: 'power infrastructure',
    reason: 'Grid capex',
    weight: 0.1,
    addedAt: 1,
  }];
  const backend = {
    async run(request, runtimeOptions) {
      calls.push({ request, runtime: { ...runtimeOptions } });
      if (request.agentContractId === 'idea-generator') {
        return succeeded(request, {
          ideas: [
            candidate('Generated grid equipment opportunity', 'GEV', 88),
            candidate('Generated electrical component opportunity', 'ETN', 80),
          ],
        });
      }
      return succeeded(request, {
        selected: [{ index: 0, score: 91, reason: 'Strongest differentiated catalyst.' }],
      });
    },
  };
  const runId = 'idea_run_snapshot_integration';
  const asOf = '2026-07-23T08:00:00.000Z';

  const result = await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: backend,
    services: {
      runId,
      asOf,
      ideaStore: ideasDomain.IdeaStore,
      getPortfolio: () => mutablePortfolio,
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: false },
      wait: async () => {},
      gatherMarketContext: async () => {
        mutablePortfolio[0].theme = 'mutated after capture';
        return marketContext();
      },
      runSourceDiscoveryNodes: async ({ portfolio }) => {
        observedPortfolios.push(structuredClone(portfolio));
        return {
          runs: [{ agent: 'portfolio-idea-agent', ideas: [candidate('Captured portfolio extension', 'PWR', 75)] }],
          ideas: [candidate('Captured portfolio extension', 'PWR', 75)],
        };
      },
      verifyCandidateTickers: async (tickers) => new Set(tickers),
    },
  });

  assert.equal(result.runId, runId);
  assert.equal(result.asOf, asOf);
  assert.match(result.snapshotId, /^idea-run-input-snapshot:[a-f0-9]{64}$/u);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.request.agentContractId),
    ['idea-generator', 'idea-quality-reviewer'],
  );
  assert.deepEqual(
    Object.keys(calls[0].request.input),
    [
      'poolTarget',
      'market',
      'sourceCandidates',
      'heldThemes',
      'heavyThemes',
      'existingTitles',
    ],
  );
  assert.deepEqual(
    calls[0].request.input.sourceCandidates.map((idea) => idea.title),
    ['Captured portfolio extension'],
  );
  assert.equal(calls[0].runtime.temperature, 0.9);
  assert.equal(calls[0].runtime.kind, 'idea');
  assert.equal(calls[1].runtime.temperature, 0.3);
  assert.equal(calls[1].runtime.kind, 'idea-screen');
  for (const call of calls) {
    assert.equal(call.request.workflowId, workflow.IDEA_GENERATION_WORKFLOW.id);
    assert.equal(call.request.projectId, 'idea-universe:local-user');
    assert.equal(call.request.asOf, asOf);
    assert.equal(call.request.workspaceSnapshotId, result.snapshotId);
    assert.equal(call.runtime.workspaceMode, 'idea-run');
  }
  assert.equal(observedPortfolios[0][0].theme, 'power infrastructure');

  const snapshot = ideasDomain.ideaRunInputSnapshotStore.resolve(runId, result.snapshotId);
  assert.equal(snapshot.workflow.hash, workflow.IDEA_GENERATION_WORKFLOW_HASH);
  assert.equal(snapshot.inputs.positions[0].theme, 'power infrastructure');
  assert.equal(snapshot.inputs.command.count, 1);
  assert.equal(snapshot.effectiveConfig.agents.length, 2);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /Grid investment continues|Captured portfolio extension|Generated grid equipment/u,
  );

  assert.equal(result.generated.length, 2);
  assert.deepEqual(
    result.generated.map((idea) => idea.qualitySelected),
    [true, false],
    'quality selection annotates but does not filter valid generated Ideas',
  );
  assert.equal(
    result.generated.some((idea) => idea.title === 'Captured portfolio extension'),
    false,
    'deterministic source material remains generator input rather than a published Idea',
  );
  assert.ok(result.generated.every((idea) => (
    idea.sourceRunId === runId
    && idea.sourceSnapshotId === result.snapshotId
    && idea.sourceIdeaRunId === runId
    && idea.sourceRunInputSnapshotId === result.snapshotId
    && idea.sourceRunAsOf === asOf
  )));
  const indexEntry = globalContentIndex.read().entries.find(
    (entry) => entry.type === 'idea' && entry.id === result.generated[0].id,
  );
  assert.equal(indexEntry.contentRef, `idea-generation/ideas/${result.generated[0].id}`);
  const runDir = path.join(config.IDEA_RUNS_DIR, runId);
  assert.deepEqual(
    fs.readdirSync(runDir).sort(),
    ['.artifacts', '.events', '.runs', 'input-snapshot.json', 'retention.json'],
  );
  assert.equal(
    fs.existsSync(path.join(config.PROJECTS_DIR, 'idea-universe:local-user')),
    false,
    'durable Idea scope must never be materialized as a fake Project',
  );
  assert.deepEqual(fs.readdirSync(config.GLOBAL_DIR).sort(), ['index.json']);
});

test('supplied Idea command scope replays durable output without rereading mutable state or successful nodes', async () => {
  const first = ideasDomain.ideaRunInputSnapshotStore.load('idea_run_snapshot_integration');
  globalState.Store.setPortfolio([{
    id: 'pos_changed',
    ticker: 'CHANGED',
    theme: 'changed mutable state',
  }]);
  const calls = [];
  const observed = [];
  const backend = {
    async run(request) {
      calls.push(request);
      if (request.agentContractId === 'idea-generator') {
        return succeeded(request, { ideas: [candidate('Replay generated opportunity', 'PWR', 85)] });
      }
      return succeeded(request, {
        selected: [{ index: 0, score: 90, reason: 'Replay selection.' }],
      });
    },
  };
  const scope = executionScope.beginDirectAgentCommand({
    commandId: first.runId,
    runId: first.runId,
    idempotencyKey: `idea-generation:${first.runId}`,
    workflowId: workflow.IDEA_GENERATION_WORKFLOW.id,
    nodeId: 'generate-ideas',
    projectId: 'idea-universe:local-user',
    asOf: first.asOf,
    workspaceMode: 'idea-run',
    workspaceSnapshotId: first.snapshotId,
  });

  const replay = await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: backend,
    executionScope: scope,
    services: {
      ideaStore: ideasDomain.IdeaStore,
      getPortfolio: () => { throw new Error('mutable Portfolio must not be reread'); },
      getMandate: () => { throw new Error('mutable Mandate must not be reread'); },
      agentCatalog: { listAgents: () => { throw new Error('config must not be recaptured'); } },
      wait: async () => {},
      gatherMarketContext: async () => marketContext(),
      runSourceDiscoveryNodes: async ({ portfolio }) => {
        observed.push(structuredClone(portfolio));
        return {
          runs: [{ agent: 'portfolio-idea-agent', ideas: [candidate('Replay source opportunity', 'PWR', 72)] }],
          ideas: [candidate('Replay source opportunity', 'PWR', 72)],
        };
      },
      verifyCandidateTickers: async (tickers) => new Set(tickers),
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(observed.length, 0);
  assert.deepEqual(
    replay.execution.executedNodeIds,
    [],
  );
  assert.deepEqual(
    replay.execution.hydratedNodeIds,
    workflow.IDEA_GENERATION_WORKFLOW.nodes.map((node) => node.id),
  );
  assert.deepEqual(
    ideasDomain.ideaRunInputSnapshotStore.load(first.runId),
    first,
  );

  const mismatched = executionScope.beginDirectAgentCommand({
    commandId: first.runId,
    runId: first.runId,
    idempotencyKey: `idea-generation:${first.runId}`,
    workflowId: workflow.IDEA_GENERATION_WORKFLOW.id,
    nodeId: 'generate-ideas',
    projectId: 'idea-universe:local-user',
    asOf: '2026-07-23T08:00:01.000Z',
    workspaceMode: 'idea-run',
    workspaceSnapshotId: first.snapshotId,
  });
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: backend,
      executionScope: mismatched,
      services: {
        ideaStore: ideasDomain.IdeaStore,
        gatherMarketContext: async () => {
          throw new Error('source execution must not begin for a mismatched scope');
        },
      },
    }),
    (error) => error?.code === 'IDEA_RUN_SNAPSHOT_BINDING_MISMATCH',
  );
});

test('deterministic demo owns a real snapshot and persists run lineage without an Agent call', async () => {
  const result = await workflow.runIdeaGenerationWorkflow(2, {
    agentBackend: {
      async run() {
        throw new Error('DEMO_MODE must not execute an Agent backend');
      },
    },
    services: {
      runId: 'idea_run_demo_snapshot',
      asOf: '2026-07-23T09:00:00.000Z',
      ideaStore: ideasDomain.IdeaStore,
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: true },
    },
  });

  assert.equal(result.provider, 'demo');
  assert.equal(result.live, false);
  assert.equal(result.runId, 'idea_run_demo_snapshot');
  assert.equal(result.generated.length, 2);
  assert.ok(result.generated.every((idea) => (
    idea.sourceRunId === result.runId
    && idea.sourceSnapshotId === result.snapshotId
    && idea.sourceIdeaRunId === result.runId
    && idea.sourceRunInputSnapshotId === result.snapshotId
  )));
  assert.equal(
    ideasDomain.ideaRunInputSnapshotStore.resolve(result.runId, result.snapshotId)
      .inputs.settings.DEMO_MODE,
    true,
  );

  const source = fs.readFileSync(
    new URL('../src/workflows/idea-generation/ideaGeneration.workflow.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /global:live/u);
});

test('each durable interruption boundary resumes by hydrating its succeeded prefix exactly once', async () => {
  const nodeIds = workflow.IDEA_GENERATION_WORKFLOW.nodes.map((node) => node.id);
  let sequence = 0;

  for (const stopAfterNodeId of nodeIds) {
    sequence += 1;
    const runId = `idea_run_resume_boundary_${sequence}`;
    let backendCalls = 0;
    const denyBackend = {
      async run() {
        backendCalls += 1;
        throw new Error('DEMO_MODE must not execute an Agent backend');
      },
    };
    const baseServices = {
      runId,
      asOf: `2026-07-23T10:${String(sequence).padStart(2, '0')}:00.000Z`,
      ideaStore: ideasDomain.IdeaStore,
      getPortfolio: () => [],
      getMandate: () => MANDATE,
      runtimeSettings: { ...config.runtime, DEMO_MODE: true },
    };
    const first = await workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      stopAfterNodeId,
      services: {
        ...baseServices,
        runStorage: new runStorageModule.IdeaGenerationRunStorage(),
      },
    });
    const boundary = nodeIds.indexOf(stopAfterNodeId) + 1;
    assert.equal(first.status, 'RUNNING');
    assert.deepEqual(first.execution.executedNodeIds, nodeIds.slice(0, boundary));
    assert.deepEqual(first.execution.hydratedNodeIds, []);

    const resumed = await workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      services: {
        ...baseServices,
        getPortfolio: () => {
          throw new Error('resume must not reread mutable Portfolio');
        },
        getMandate: () => {
          throw new Error('resume must not reread mutable Mandate');
        },
        runStorage: new runStorageModule.IdeaGenerationRunStorage(),
      },
    });
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(resumed.execution.hydratedNodeIds, nodeIds.slice(0, boundary));
    assert.deepEqual(resumed.execution.executedNodeIds, nodeIds.slice(boundary));
    assert.equal(resumed.generated.length, 1);

    const replayed = await workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      services: {
        ...baseServices,
        getPortfolio: () => {
          throw new Error('replay must not reread mutable Portfolio');
        },
        getMandate: () => {
          throw new Error('replay must not reread mutable Mandate');
        },
        runStorage: new runStorageModule.IdeaGenerationRunStorage(),
      },
    });
    assert.equal(replayed.status, 'SUCCEEDED');
    assert.deepEqual(replayed.execution.hydratedNodeIds, nodeIds);
    assert.deepEqual(replayed.execution.executedNodeIds, []);
    assert.deepEqual(
      replayed.generated.map((idea) => idea.id),
      resumed.generated.map((idea) => idea.id),
    );
    assert.equal(backendCalls, 0);
  }
});

test('same-run single-flight prevents duplicate source and Agent execution', async () => {
  const runId = 'idea_run_single_flight';
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  let sourceCalls = 0;
  let backendCalls = 0;
  const backend = {
    async run(request) {
      backendCalls += 1;
      return succeeded(request, {
        ideas: [candidate('Single-flight generated opportunity', 'GEV', 84)],
      });
    },
  };
  const services = {
    runId,
    asOf: '2026-07-23T11:00:00.000Z',
    runStorage,
    ideaStore: ideasDomain.IdeaStore,
    getPortfolio: () => [],
    getMandate: () => MANDATE,
    runtimeSettings: { ...config.runtime, DEMO_MODE: false },
    gatherMarketContext: async () => {
      sourceCalls += 1;
      return marketContext();
    },
    runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
    verifyCandidateTickers: async (tickers) => new Set(tickers),
  };

  const [left, right] = await Promise.all([
    workflow.runIdeaGenerationWorkflow(1, { agentBackend: backend, services }),
    workflow.runIdeaGenerationWorkflow(1, { agentBackend: backend, services }),
  ]);

  assert.equal(sourceCalls, 1);
  assert.equal(backendCalls, 1);
  assert.deepEqual(
    left.generated.map((idea) => idea.id),
    right.generated.map((idea) => idea.id),
  );
  assert.equal(runStorage.list().filter((record) => record.runId === runId).length, 1);
});

test('resumed non-demo runs keep the captured route when global demo mode changes', async () => {
  const runId = 'idea_run_captured_non_demo';
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  const calls = [];
  const backend = {
    async run(request, runtimeOptions) {
      calls.push({ request, runtimeOptions });
      return succeeded(request, {
        ideas: [candidate('Captured non-demo route opportunity', 'GEV', 84)],
      });
    },
  };
  const services = {
    runId,
    asOf: '2026-07-23T11:30:00.000Z',
    runStorage,
    ideaStore: ideasDomain.IdeaStore,
    getPortfolio: () => [],
    getMandate: () => MANDATE,
    runtimeSettings: { ...config.runtime, DEMO_MODE: false },
    gatherMarketContext: async () => marketContext(),
    runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
    verifyCandidateTickers: async (tickers) => new Set(tickers),
  };

  const prefix = await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: backend,
    services,
    stopAfterNodeId: 'build-diversification-constraints',
  });
  assert.deepEqual(prefix.execution.executedNodeIds, [
    'collect-market-context',
    'build-diversification-constraints',
  ]);
  assert.equal(calls.length, 0);

  const originalDemoMode = config.runtime.DEMO_MODE;
  config.runtime.DEMO_MODE = true;
  try {
    const resumed = await workflow.resumeIdeaGenerationWorkflow(runId, {
      agentBackend: backend,
      services,
    });
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal(resumed.provider, 'deterministic-test-backend');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.agentContractId, 'idea-generator');
    assert.equal(calls[0].runtimeOptions.demo, false);
  } finally {
    config.runtime.DEMO_MODE = originalDemoMode;
  }
});

test('distinct Idea runs execute concurrently without sharing durable identity or node state', async () => {
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  const calls = [];
  const backend = {
    async run(request) {
      calls.push(request);
      const suffix = request.runId.includes('concurrent_a') ? 'A' : 'B';
      return succeeded(request, {
        ideas: [candidate(`Concurrent generated opportunity ${suffix}`, 'GEV', 82)],
      });
    },
  };
  const servicesFor = (runId, minute) => ({
    runId,
    asOf: `2026-07-23T12:${minute}:00.000Z`,
    runStorage,
    ideaStore: ideasDomain.IdeaStore,
    getPortfolio: () => [],
    getMandate: () => MANDATE,
    runtimeSettings: { ...config.runtime, DEMO_MODE: false },
    gatherMarketContext: async () => marketContext(),
    runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
    verifyCandidateTickers: async (tickers) => new Set(tickers),
  });

  const [left, right] = await Promise.all([
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: backend,
      services: servicesFor('idea_run_concurrent_a', '01'),
    }),
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: backend,
      services: servicesFor('idea_run_concurrent_b', '02'),
    }),
  ]);

  assert.equal(calls.length, 2);
  assert.notEqual(left.runId, right.runId);
  assert.notEqual(left.snapshotId, right.snapshotId);
  assert.notEqual(left.generated[0].id, right.generated[0].id);
  assert.deepEqual(
    runStorage.list()
      .filter((record) => record.runId.startsWith('idea_run_concurrent_'))
      .map((record) => record.runId)
      .sort(),
    ['idea_run_concurrent_a', 'idea_run_concurrent_b'],
  );
});

test('durable source failure remains queryable with exact failed node and stop reason', async () => {
  const runId = 'idea_run_failed_source';
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: {
        async run() {
          throw new Error('Agent backend must not run after source failure');
        },
      },
      services: {
        runId,
        asOf: '2026-07-23T13:00:00.000Z',
        runStorage,
        ideaStore: ideasDomain.IdeaStore,
        getPortfolio: () => [],
        getMandate: () => MANDATE,
        runtimeSettings: { ...config.runtime, DEMO_MODE: false },
        gatherMarketContext: async () => {
          throw new Error('deterministic source fixture failed');
        },
      },
    }),
    /deterministic source fixture failed/u,
  );

  const record = runStorage.list().find((candidateRecord) => (
    candidateRecord.runId === runId
  ));
  assert.equal(record.status, 'FAILED');
  assert.equal(
    record.nodes['collect-market-context'].status,
    'FAILED_BUSINESS',
  );
  assert.equal(
    record.nodes['collect-market-context'].stopReason,
    'business-error',
  );
  const progress = runProjection.ideaGenerationProgress(
    { workflowId: workflow.IDEA_GENERATION_WORKFLOW.id, runId },
    { storage: runStorage },
  );
  assert.equal(progress.status, 'FAILED');
  assert.equal(progress.running, false);
  assert.equal(progress.steps[0].status, 'failed');
  assert.equal(progress.nodes[0].lastFailure.reason, 'business-error');
});

test('generator provider failure uses the declared retry policy and ends in durable failure', async () => {
  const runId = 'idea_run_failed_generator';
  const runStorage = new runStorageModule.IdeaGenerationRunStorage();
  const calls = [];
  const backend = {
    async run(request, runtimeOptions) {
      calls.push({ request, runtimeOptions });
      return {
        status: 'failed',
        output: null,
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: { turns: 0, toolCalls: 0 },
        stopReason: 'provider-unavailable',
        traceRef: request.runId,
        valid: false,
        provider: 'deterministic-unavailable-provider',
        live: false,
      };
    },
  };

  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: backend,
      services: {
        runId,
        asOf: '2026-07-23T14:00:00.000Z',
        runStorage,
        ideaStore: ideasDomain.IdeaStore,
        getPortfolio: () => [],
        getMandate: () => MANDATE,
        runtimeSettings: { ...config.runtime, DEMO_MODE: false },
        gatherMarketContext: async () => marketContext(),
        runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
      },
    }),
    /idea-generator failed: provider-unavailable/u,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.runId, calls[1].request.runId);
  assert.equal(calls[0].request.idempotencyKey, calls[1].request.idempotencyKey);
  assert.deepEqual(
    calls.map((call) => call.runtimeOptions.workflowAttempt),
    [1, 2],
  );
  const record = runStorage.list().find((candidateRecord) => (
    candidateRecord.runId === runId
  ));
  assert.equal(record.status, 'FAILED');
  assert.equal(record.nodes['generate-candidates'].status, 'FAILED_TRANSIENT');
  assert.equal(record.nodes['generate-candidates'].attempt, 2);
});
