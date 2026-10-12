import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-recovery-'));
process.env.FIN_DATA_DIR = dataDir;
process.env.DEMO_MODE = '0';
process.env.AUTO_RESUME = 'false';

const [
  config,
  ideas,
  inputSnapshot,
  workflow,
  workflowSpec,
  recovery,
  storageModule,
] = await Promise.all([
  import('../src/config.js'),
  import('../src/domains/ideas/index.js'),
  import('../src/workflows/idea-generation/runtime/inputSnapshot.js'),
  import('../src/workflows/idea-generation/runIdeaGeneration.js'),
  import('../src/workflows/idea-generation/workflowSpec.js'),
  import('../src/workflows/idea-generation/recovery.js'),
  import('../src/workflows/idea-generation/runtime/IdeaGenerationRunStorage.js'),
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

let fixtureSequence = 0;

function fixture(name) {
  fixtureSequence += 1;
  const root = path.join(
    dataDir,
    'focused-recovery',
    `${String(fixtureSequence).padStart(2, '0')}-${name}`,
  );
  const runsDir = path.join(root, 'idea-generation', 'runs');
  const snapshotStore = new ideas.FileIdeaRunInputSnapshotStore({ runsDir });
  const runStorage = new storageModule.IdeaGenerationRunStorage({
    runsDir,
    snapshotStore,
  });
  return { root, runsDir, snapshotStore, runStorage };
}

function servicesFor(runId, {
  asOf,
  demo = true,
  fixture: current,
  extra = {},
} = {}) {
  return {
    runId,
    asOf,
    snapshotStore: current.snapshotStore,
    runStorage: current.runStorage,
    ideaStore: ideas.IdeaStore,
    getPortfolio: () => [],
    getMandate: () => MANDATE,
    runtimeSettings: { ...config.runtime, DEMO_MODE: demo },
    ...extra,
  };
}

function createSnapshot(runId, {
  asOf,
  fixture: current,
  count = 1,
} = {}) {
  return inputSnapshot.openIdeaRunInputSnapshot(count, {
    services: servicesFor(runId, {
      asOf,
      fixture: current,
    }),
  });
}

const denyBackend = {
  async run() {
    throw new Error('deterministic recovery fixture invoked an Agent backend');
  },
};

const CURRENT_WORKFLOW_IDENTITY = Object.freeze({
  id: workflowSpec.IDEA_GENERATION_WORKFLOW_SPEC.id,
  version: workflowSpec.IDEA_GENERATION_WORKFLOW_SPEC.version,
  hash: workflowSpec.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
});

function failNodeCrashStorage(base, {
  nodeId,
  attempt,
} = {}) {
  return {
    runsDir: base.runsDir,
    snapshotStore: base.snapshotStore,
    list: () => base.list(),
    listSnapshots: () => base.listSnapshots(),
    singleFlight: (runId, execute) => base.singleFlight(runId, execute),
    services(runId, options) {
      const durable = base.services(runId, options);
      const runStore = new Proxy(durable.runStore, {
        get(target, property) {
          if (property === 'failNode') {
            return (targetRunId, targetNodeId, ...args) => {
              const record = target.load(targetRunId);
              if (
                targetNodeId === nodeId
                && record.nodes[targetNodeId].attempt === attempt
              ) {
                const error = new Error('simulated process termination');
                error.code = 'PROCESS_TERMINATED';
                throw error;
              }
              return target.failNode(targetRunId, targetNodeId, ...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { ...durable, runStore };
    },
  };
}

test('snapshot store lists only validated durable snapshots and rejects symlink entries', () => {
  const current = fixture('snapshot-list');
  createSnapshot('idea_run_snapshot_list_b', {
    asOf: '2026-07-23T10:01:00.000Z',
    fixture: current,
  });
  createSnapshot('idea_run_snapshot_list_a', {
    asOf: '2026-07-23T10:00:00.000Z',
    fixture: current,
  });
  const emptyRun = path.join(current.runsDir, 'idea_run_empty_directory');
  fs.mkdirSync(emptyRun, { recursive: true });
  fs.writeFileSync(path.join(current.runsDir, 'ignored-file'), 'not a run');

  assert.deepEqual(
    current.snapshotStore.list().map((snapshot) => snapshot.runId),
    ['idea_run_snapshot_list_a', 'idea_run_snapshot_list_b'],
  );

  const symlink = path.join(current.runsDir, 'idea_run_symlink');
  fs.symlinkSync(path.join(current.runsDir, 'idea_run_snapshot_list_a'), symlink);
  assert.throws(
    () => current.snapshotStore.list(),
    (error) => error?.code === 'IDEA_RUN_INPUT_SNAPSHOT_SYMLINK',
  );
});

test('recovery candidates contain snapshot-only and RUNNING runs, never terminal or succeeded runs', async () => {
  const current = fixture('candidate-filter');
  const currentSnapshot = createSnapshot('idea_run_candidate_snapshot_only', {
    asOf: '2026-07-23T11:00:00.000Z',
    fixture: current,
  });
  fs.mkdirSync(
    path.join(current.runsDir, 'idea_run_candidate_snapshot_only', '.runs'),
  );
  current.snapshotStore.create({
    runId: 'idea_run_candidate_legacy_v1',
    workflow: {
      id: 'idea-generation.v1',
      version: '1.0.0',
      hash: `sha256:${'1'.repeat(64)}`,
    },
    asOf: '2026-07-23T10:59:00.000Z',
    inputs: currentSnapshot.inputs,
    effectiveConfig: currentSnapshot.effectiveConfig,
  });

  await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: denyBackend,
    stopAfterNodeId: 'collect-market-context',
    services: servicesFor('idea_run_candidate_running', {
      asOf: '2026-07-23T11:01:00.000Z',
      fixture: current,
    }),
  });
  await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: denyBackend,
    services: servicesFor('idea_run_candidate_succeeded', {
      asOf: '2026-07-23T11:02:00.000Z',
      fixture: current,
    }),
  });
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      services: servicesFor('idea_run_candidate_failed', {
        asOf: '2026-07-23T11:03:00.000Z',
        demo: false,
        fixture: current,
        extra: {
          gatherMarketContext: async () => {
            throw new Error('deterministic source failure');
          },
        },
      }),
    }),
    /deterministic source failure/u,
  );

  assert.deepEqual(
    recovery.ideaGenerationRecoveryCandidates(current.runStorage)
      .map(({ runId, state }) => ({ runId, state })),
    [
      {
        runId: 'idea_run_candidate_snapshot_only',
        state: 'SNAPSHOT_ONLY',
      },
      {
        runId: 'idea_run_candidate_running',
        state: 'RUNNING',
      },
    ],
  );
});

test('FAILED, BLOCKED, and CANCELLED runs reject same-run invocation without durable state drift', async () => {
  const current = fixture('terminal-stability');
  const terminalRunIds = [];

  const failedRunId = 'idea_run_terminal_failed';
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      services: servicesFor(failedRunId, {
        asOf: '2026-07-23T12:00:00.000Z',
        demo: false,
        fixture: current,
        extra: {
          gatherMarketContext: async () => {
            throw new Error('terminal deterministic failure');
          },
        },
      }),
    }),
    /terminal deterministic failure/u,
  );
  terminalRunIds.push(failedRunId);

  for (const [suffix, terminalize] of [
    ['blocked', (runStore, runId) => runStore.blockRun(runId)],
    ['cancelled', (runStore, runId) => runStore.cancelRun(runId)],
  ]) {
    const runId = `idea_run_terminal_${suffix}`;
    await workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      stopAfterNodeId: 'collect-market-context',
      services: servicesFor(runId, {
        asOf: suffix === 'blocked'
          ? '2026-07-23T12:01:00.000Z'
          : '2026-07-23T12:02:00.000Z',
        fixture: current,
      }),
    });
    terminalize(current.runStorage.services(runId).runStore, runId);
    terminalRunIds.push(runId);
  }

  for (const runId of terminalRunIds) {
    const runStore = current.runStorage.services(runId).runStore;
    const before = runStore.load(runId);
    let sourceCalls = 0;
    await assert.rejects(
      workflow.resumeIdeaGenerationWorkflow(runId, {
        agentBackend: denyBackend,
        services: {
          snapshotStore: current.snapshotStore,
          runStorage: current.runStorage,
          ideaStore: ideas.IdeaStore,
          gatherMarketContext: async () => {
            sourceCalls += 1;
            throw new Error('terminal run executed a source');
          },
        },
      }),
      (error) => (
        error?.code === recovery.IDEA_RUN_NOT_RESUMABLE_CODE
        && error?.statusCode === 409
        && error?.runId === runId
        && error?.runStatus === before.status
      ),
    );
    assert.equal(sourceCalls, 0);
    assert.deepEqual(runStore.load(runId), before);
  }
});

test('exhausted provider failure remains at attempt 2 across repeated same-run invocation', async () => {
  const current = fixture('terminal-provider-budget');
  const runId = 'idea_run_terminal_provider_budget';
  let backendCalls = 0;
  const unavailableBackend = {
    async run(request) {
      backendCalls += 1;
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
  const services = servicesFor(runId, {
    asOf: '2026-07-23T12:10:00.000Z',
    demo: false,
    fixture: current,
    extra: {
      gatherMarketContext: async () => ({
        top: [],
        bottom: [],
        headlines: [],
        sectorTable: [],
        research: [],
        saIdeas: [],
        sourcesUsed: [],
        domainsUsed: [],
      }),
      runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
    },
  });
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: unavailableBackend,
      services,
    }),
    /idea-generator failed: provider-unavailable/u,
  );
  const runStore = current.runStorage.services(runId).runStore;
  const terminal = runStore.load(runId);
  assert.equal(backendCalls, 2);
  assert.equal(terminal.nodes['generate-candidates'].attempt, 2);

  await assert.rejects(
    workflow.resumeIdeaGenerationWorkflow(runId, {
      agentBackend: unavailableBackend,
      services: {
        snapshotStore: current.snapshotStore,
        runStorage: current.runStorage,
        ideaStore: ideas.IdeaStore,
      },
    }),
    (error) => error?.code === recovery.IDEA_RUN_NOT_RESUMABLE_CODE,
  );
  assert.equal(backendCalls, 2);
  assert.deepEqual(runStore.load(runId), terminal);
});

test('SUCCEEDED runs hydrate and RUNNING runs resume through the same v2 composition', async () => {
  const current = fixture('resume-composition');
  const succeededRunId = 'idea_run_recovery_succeeded';
  const succeeded = await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: denyBackend,
    services: servicesFor(succeededRunId, {
      asOf: '2026-07-23T13:00:00.000Z',
      fixture: current,
    }),
  });
  const beforeReplay = current.runStorage.services(succeededRunId)
    .runStore.load(succeededRunId);
  const replayed = await workflow.resumeIdeaGenerationWorkflow(
    succeededRunId,
    {
      agentBackend: denyBackend,
      services: {
        snapshotStore: current.snapshotStore,
        runStorage: current.runStorage,
        ideaStore: ideas.IdeaStore,
        getPortfolio: () => {
          throw new Error('replay reread mutable Portfolio');
        },
        getMandate: () => {
          throw new Error('replay reread mutable Mandate');
        },
      },
    },
  );
  assert.equal(replayed.status, 'SUCCEEDED');
  assert.deepEqual(replayed.execution.executedNodeIds, []);
  assert.equal(
    replayed.execution.hydratedNodeIds.length,
    workflowSpec.IDEA_GENERATION_WORKFLOW_SPEC.nodes.length,
  );
  assert.deepEqual(
    replayed.generated.map((idea) => idea.id),
    succeeded.generated.map((idea) => idea.id),
  );
  assert.deepEqual(
    current.runStorage.services(succeededRunId).runStore.load(succeededRunId),
    beforeReplay,
  );

  const runningRunId = 'idea_run_recovery_running';
  const prefix = await workflow.runIdeaGenerationWorkflow(1, {
    agentBackend: denyBackend,
    stopAfterNodeId: 'build-diversification-constraints',
    services: servicesFor(runningRunId, {
      asOf: '2026-07-23T13:01:00.000Z',
      fixture: current,
    }),
  });
  assert.equal(prefix.status, 'RUNNING');
  const resumed = await workflow.resumeIdeaGenerationWorkflow(runningRunId, {
    agentBackend: denyBackend,
    services: {
      snapshotStore: current.snapshotStore,
      runStorage: current.runStorage,
      ideaStore: ideas.IdeaStore,
    },
  });
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.deepEqual(
    resumed.execution.hydratedNodeIds,
    ['collect-market-context', 'build-diversification-constraints'],
  );
  assert.deepEqual(
    resumed.execution.executedNodeIds,
    [
      'generate-candidates',
      'verify-candidates',
      'review-quality',
      'persist-ideas',
    ],
  );
});

test('interrupted deterministic node at maxAttempts=1 fails durably without attempt 2', async () => {
  const current = fixture('deterministic-budget');
  const runId = 'idea_run_deterministic_budget';
  const crashStorage = failNodeCrashStorage(current.runStorage, {
    nodeId: 'collect-market-context',
    attempt: 1,
  });
  await assert.rejects(
    workflow.runIdeaGenerationWorkflow(1, {
      agentBackend: denyBackend,
      services: {
        ...servicesFor(runId, {
          asOf: '2026-07-23T13:10:00.000Z',
          demo: false,
          fixture: current,
          extra: {
            gatherMarketContext: async () => {
              throw new Error('source process terminated');
            },
          },
        }),
        runStorage: crashStorage,
      },
    }),
    (error) => error?.code === 'PROCESS_TERMINATED',
  );
  const runStore = current.runStorage.services(runId).runStore;
  const interrupted = runStore.load(runId);
  assert.equal(interrupted.status, 'RUNNING');
  assert.equal(
    interrupted.nodes['collect-market-context'].status,
    'RUNNING',
  );
  assert.equal(interrupted.nodes['collect-market-context'].attempt, 1);

  let sourceCalls = 0;
  await assert.rejects(
    workflow.resumeIdeaGenerationWorkflow(runId, {
      agentBackend: denyBackend,
      services: {
        snapshotStore: current.snapshotStore,
        runStorage: current.runStorage,
        ideaStore: ideas.IdeaStore,
        gatherMarketContext: async () => {
          sourceCalls += 1;
          return {};
        },
      },
    }),
    (error) => (
      error?.code === recovery.IDEA_RUN_NOT_RESUMABLE_CODE
      && error?.runStatus === 'FAILED'
      && error?.stopReason === 'process-interrupted-retry-budget-exhausted'
    ),
  );
  const failed = runStore.load(runId);
  assert.equal(sourceCalls, 0);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.nodes['collect-market-context'].attempt, 1);
  assert.equal(failed.resumeCount, interrupted.resumeCount);
  assert.equal(
    failed.nodes['collect-market-context'].stopReason,
    'process-interrupted-retry-budget-exhausted',
  );
});

test('interrupted Agent node at its declared maxAttempts fails without attempt 3', async () => {
  const current = fixture('agent-budget');
  const runId = 'idea_run_agent_budget';
  const crashStorage = failNodeCrashStorage(current.runStorage, {
    nodeId: 'generate-candidates',
    attempt: 2,
  });
  let backendCalls = 0;
  const unavailableBackend = {
    async run(request) {
      backendCalls += 1;
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
      agentBackend: unavailableBackend,
      services: {
        ...servicesFor(runId, {
          asOf: '2026-07-23T13:11:00.000Z',
          demo: false,
          fixture: current,
          extra: {
            gatherMarketContext: async () => ({
              top: [],
              bottom: [],
              headlines: [],
              sectorTable: [],
              research: [],
              saIdeas: [],
              sourcesUsed: [],
              domainsUsed: [],
            }),
            runSourceDiscoveryNodes: async () => ({ runs: [], ideas: [] }),
          },
        }),
        runStorage: crashStorage,
      },
    }),
    (error) => error?.code === 'PROCESS_TERMINATED',
  );
  assert.equal(backendCalls, 2);
  const runStore = current.runStorage.services(runId).runStore;
  const interrupted = runStore.load(runId);
  assert.equal(interrupted.status, 'RUNNING');
  assert.equal(interrupted.nodes['generate-candidates'].status, 'RUNNING');
  assert.equal(interrupted.nodes['generate-candidates'].attempt, 2);

  await assert.rejects(
    workflow.resumeIdeaGenerationWorkflow(runId, {
      agentBackend: unavailableBackend,
      services: {
        snapshotStore: current.snapshotStore,
        runStorage: current.runStorage,
        ideaStore: ideas.IdeaStore,
      },
    }),
    (error) => (
      error?.code === recovery.IDEA_RUN_NOT_RESUMABLE_CODE
      && error?.stopReason === 'process-interrupted-retry-budget-exhausted'
    ),
  );
  const failed = runStore.load(runId);
  assert.equal(backendCalls, 2);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.nodes['generate-candidates'].attempt, 2);
  assert.equal(failed.resumeCount, interrupted.resumeCount);
});

test('startup recovery executes snapshot-only runs serially through production composition', async () => {
  const current = fixture('serial-production-recovery');
  for (const [runId, asOf] of [
    ['idea_run_serial_recovery_a', '2026-07-23T14:00:00.000Z'],
    ['idea_run_serial_recovery_b', '2026-07-23T14:01:00.000Z'],
  ]) {
    createSnapshot(runId, { asOf, fixture: current });
  }

  const summary = await workflow.recoverInterruptedIdeaGenerationRuns({
    runStorage: current.runStorage,
    options: {
      agentBackend: denyBackend,
      services: { ideaStore: ideas.IdeaStore },
    },
  });
  assert.deepEqual(
    summary.outcomes.map(({ runId, priorState, status, ok }) => ({
      runId,
      priorState,
      status,
      ok,
    })),
    [
      {
        runId: 'idea_run_serial_recovery_a',
        priorState: 'SNAPSHOT_ONLY',
        status: 'SUCCEEDED',
        ok: true,
      },
      {
        runId: 'idea_run_serial_recovery_b',
        priorState: 'SNAPSHOT_ONLY',
        status: 'SUCCEEDED',
        ok: true,
      },
    ],
  );
  assert.equal(summary.recoveredCount, 2);
  assert.equal(summary.failedCount, 0);
});

test('recovery coordinator awaits each candidate before starting the next', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const snapshots = [
    {
      runId: 'idea_run_serial_a',
      snapshotId: 'snapshot-a',
      asOf: '2026-07-23T15:00:00.000Z',
      workflow: CURRENT_WORKFLOW_IDENTITY,
      inputs: { command: { count: 1 } },
    },
    {
      runId: 'idea_run_serial_b',
      snapshotId: 'snapshot-b',
      asOf: '2026-07-23T15:01:00.000Z',
      workflow: CURRENT_WORKFLOW_IDENTITY,
      inputs: { command: { count: 1 } },
    },
  ];
  await recovery.recoverIdeaGenerationCandidates({
    storage: {
      list: () => [],
      listSnapshots: () => snapshots,
    },
    resume: async ({ runId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${runId}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(`end:${runId}`);
      active -= 1;
      return { status: 'SUCCEEDED' };
    },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:idea_run_serial_a',
    'end:idea_run_serial_a',
    'start:idea_run_serial_b',
    'end:idea_run_serial_b',
  ]);
});

test('recovery outcomes retain only failure code and status, never error messages', async () => {
  const summary = await recovery.recoverIdeaGenerationCandidates({
    storage: {
      list: () => [],
      listSnapshots: () => [{
        runId: 'idea_run_redacted_failure',
        snapshotId: 'snapshot-redacted',
        asOf: '2026-07-23T15:10:00.000Z',
        workflow: CURRENT_WORKFLOW_IDENTITY,
        inputs: { command: { count: 1 } },
      }],
    },
    resume: async () => {
      const error = new Error('secret provider payload must not persist');
      error.code = 'DETERMINISTIC_RECOVERY_FAILURE';
      throw error;
    },
  });
  assert.deepEqual(summary.outcomes, [{
    runId: 'idea_run_redacted_failure',
    priorState: 'SNAPSHOT_ONLY',
    status: 'FAILED',
    ok: false,
    code: 'DETERMINISTIC_RECOVERY_FAILURE',
  }]);
  assert.doesNotMatch(JSON.stringify(summary), /secret provider payload/u);
});

test('server wires explicit and AUTO_RESUME production recovery entry points', () => {
  const source = fs.readFileSync(
    new URL('../src/server.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /app\.post\('\/api\/ideas\/runs\/:runId\/resume'[\s\S]*IdeaSystem\.resume/u,
  );
  assert.match(
    source,
    /AUTO_RESUME[\s\S]*IdeaSystem\.recoverInterrupted\(\)/u,
  );
});
