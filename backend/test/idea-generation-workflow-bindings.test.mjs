import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentExecutionRuntime } from '../src/agents/AgentExecutionRuntime.js';
import { getEffectiveAgentDefinition } from '../src/agents/AgentRuntimeService.js';
import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import {
  assertWorkflowConditionBindings,
  assertWorkflowHandlerBindings,
  assertWorkflowHydrationBindings,
  executeWorkflowSpec,
} from '../src/core/workflow/WorkflowExecutor.js';
import { FileArtifactStore } from '../src/project-space/ArtifactStore.js';
import { FileRunStore } from '../src/project-space/RunStore.js';
import {
  IDEA_GENERATION_CONDITION_BINDINGS,
  IDEA_GENERATION_HANDLER_BINDINGS,
  IDEA_GENERATION_HYDRATION_BINDINGS,
} from '../src/workflows/idea-generation/bindings.js';
import {
  commitIdeaNodeOutput,
  hydrateIdeaNodeOutput,
  reconcileCommittedIdeaNodeOutputs,
} from '../src/workflows/idea-generation/completion/nodeArtifacts.js';
import { execute as verifyCandidates } from '../src/workflows/idea-generation/handlers/verifyCandidates.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from '../src/workflows/idea-generation/workflowSpec.js';

const FIXED_AS_OF = '2026-07-23T00:00:00.000Z';
let fixtureSequence = 0;

function capturedAgentConfig(agentId) {
  const definition = getEffectiveAgentDefinition(agentId);
  return {
    agentId,
    revision: definition.effectiveConfig.revision,
    digest: definition.effectiveConfig.digest,
  };
}

function inputSnapshot({
  runId,
  count = 2,
  demo = false,
  existingIdeas = [],
  positions = [],
} = {}) {
  const effectiveConfig = {
    agents: [
      capturedAgentConfig('idea-generator'),
      capturedAgentConfig('idea-quality-reviewer'),
    ],
  };
  return {
    schemaVersion: 'idea-run-input-snapshot.v2',
    runId,
    snapshotId: `idea-run-input-snapshot:${canonicalSha256({ runId }).slice('sha256:'.length)}`,
    workflow: {
      id: IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: IDEA_GENERATION_WORKFLOW_SPEC.version,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    },
    asOf: FIXED_AS_OF,
    inputs: {
      existingIdeas,
      positions,
      mandate: {},
      settings: {
        DEMO_MODE: demo,
        DEFAULT_PROVIDER: 'openai-compatible',
        MAIN_PROVIDER: 'openai-compatible',
        MAIN_MODEL: 'luna/medium',
        SMALL_PROVIDER: 'openai-compatible',
        SMALL_MODEL: 'luna/medium',
      },
      command: {
        count,
        poolTarget: Math.max(count + 2, count * 2),
        targetPerNode: 8,
      },
    },
    effectiveConfig,
    configDigest: canonicalSha256(effectiveConfig),
    contentDigest: canonicalSha256({ runId, count, demo, existingIdeas, positions }),
  };
}

function memoryIdeaPersistence() {
  const ideas = new Map();
  let addCalls = 0;
  const ideaStore = {
    getIdea(id) {
      const idea = ideas.get(id);
      return idea ? structuredClone(idea) : null;
    },
    getIdeas() {
      return [...ideas.values()].map((idea) => structuredClone(idea));
    },
    addIdeas(candidates, { sourceRunId, sourceSnapshotId } = {}) {
      addCalls += 1;
      return candidates.map((candidate) => {
        if (ideas.has(candidate.id)) return null;
        const content = {
          ...structuredClone(candidate),
          sourceRunId,
          sourceSnapshotId,
        };
        const created = {
          ...content,
          contentRef: `idea-generation/ideas/${candidate.id}/idea.json`,
          contentDigest: canonicalSha256(content),
          createdAt: FIXED_AS_OF,
          updatedAt: FIXED_AS_OF,
        };
        ideas.set(candidate.id, created);
        return structuredClone(created);
      }).filter(Boolean);
    },
  };
  const globalContentIndex = {
    read() {
      const entries = [...ideas.values()].map((idea) => ({
        id: idea.id,
        type: 'idea',
        status: idea.status,
        title: idea.title,
        contentRef: idea.contentRef,
        contentDigest: idea.contentDigest,
        createdAt: idea.createdAt,
        updatedAt: idea.updatedAt,
      }));
      return {
        entries,
        indexDigest: canonicalSha256(entries),
      };
    },
  };
  return {
    ideaStore,
    globalContentIndex,
    ideas,
    get addCalls() {
      return addCalls;
    },
  };
}

function durableFixture(t, { count = 2, demo = false } = {}) {
  fixtureSequence += 1;
  const storageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `finagent-idea-bindings-${fixtureSequence}-`),
  );
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const projectId = `idea-universe:test-${fixtureSequence}`;
  const runId = `idea_run_bindings_${fixtureSequence}`;
  const snapshot = inputSnapshot({ runId, count, demo });
  const runStore = new FileRunStore({
    projectId,
    storageDir,
    now: () => FIXED_AS_OF,
  });
  const artifactStore = new FileArtifactStore({
    projectId,
    storageDir,
  });
  runStore.begin({
    runId,
    workflowSpec: {
      id: IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: IDEA_GENERATION_WORKFLOW_SPEC.version,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    },
    inputDigest: canonicalSha256({ runId, snapshotId: snapshot.snapshotId }),
    asOf: snapshot.asOf,
    nodeIds: IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.id),
    scope: { kind: 'idea-universe', id: projectId },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: snapshot.snapshotId,
  });
  const persistence = memoryIdeaPersistence();
  const context = {
    spec: IDEA_GENERATION_WORKFLOW_SPEC,
    specHash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    runId,
    snapshot,
    runStore,
    artifactStore,
    services: {
      ideaStore: persistence.ideaStore,
      globalContentIndex: persistence.globalContentIndex,
      getEffectiveAgentDefinition,
    },
  };
  return {
    artifactStore,
    context,
    persistence,
    projectId,
    runId,
    runStore,
    snapshot,
  };
}

function generatedIdea(id, title, overrides = {}) {
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

test('canonical Idea Generation bindings cover exactly six execute/hydrate boundaries', async () => {
  const handlerIds = IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.handlerId);
  assert.deepEqual(Object.keys(IDEA_GENERATION_HANDLER_BINDINGS), handlerIds);
  assert.deepEqual(Object.keys(IDEA_GENERATION_HYDRATION_BINDINGS), handlerIds);
  assert.deepEqual(Object.keys(IDEA_GENERATION_CONDITION_BINDINGS), ['always']);
  assert.equal(
    assertWorkflowHandlerBindings(
      IDEA_GENERATION_WORKFLOW_SPEC,
      IDEA_GENERATION_HANDLER_BINDINGS,
    ),
    true,
  );
  assert.equal(
    assertWorkflowHydrationBindings(
      IDEA_GENERATION_WORKFLOW_SPEC,
      IDEA_GENERATION_HYDRATION_BINDINGS,
    ),
    true,
  );
  assert.equal(
    assertWorkflowConditionBindings(
      IDEA_GENERATION_WORKFLOW_SPEC,
      IDEA_GENERATION_CONDITION_BINDINGS,
    ),
    true,
  );
  assert.equal(
    IDEA_GENERATION_CONDITION_BINDINGS.always(),
    true,
  );

  for (const handlerId of handlerIds) {
    const module = await import(
      `../src/workflows/idea-generation/handlers/${handlerId}.js`
    );
    assert.equal(module.execute, IDEA_GENERATION_HANDLER_BINDINGS[handlerId]);
    assert.equal(module.hydrate, IDEA_GENERATION_HYDRATION_BINDINGS[handlerId]);
    assert.notEqual(module.execute, module.hydrate);
  }
});

test('node artifacts commit, hydrate, and reconcile the post-commit crash window', (t) => {
  const {
    artifactStore,
    context,
    runId,
    runStore,
  } = durableFixture(t);
  context.nodeExecutions = {};
  const [firstNode, secondNode] = IDEA_GENERATION_WORKFLOW_SPEC.nodes;

  runStore.startNode(
    runId,
    firstNode.id,
    canonicalSha256({ runId, nodeId: firstNode.id }),
  );
  const firstOutput = { market: { hasData: false }, sourceCandidates: [] };
  const firstCompletion = commitIdeaNodeOutput({
    context,
    node: firstNode,
    result: firstOutput,
  });
  runStore.succeedNode(runId, firstNode.id, {
    artifactRefs: firstCompletion.artifacts,
    output: firstCompletion.output,
  });
  context.nodeExecutions[firstNode.id] = {
    artifactRefs: firstCompletion.artifacts,
  };
  assert.deepEqual(
    hydrateIdeaNodeOutput(context, firstNode, {
      record: runStore.load(runId).nodes[firstNode.id],
    }),
    firstOutput,
  );

  runStore.startNode(
    runId,
    secondNode.id,
    canonicalSha256({ runId, nodeId: secondNode.id }),
  );
  const secondOutput = {
    existingTitles: [],
    heldThemes: [],
    heavyThemes: [],
    concentration: { sorted: [], total: 1 },
  };
  const eventBus = artifactStore.eventBus;
  let failArtifactPublish = true;
  artifactStore.eventBus = {
    get: (...args) => eventBus.get(...args),
    latest: (...args) => eventBus.latest(...args),
    publish: (...args) => {
      if (failArtifactPublish) {
        failArtifactPublish = false;
        throw Object.assign(
          new Error('simulated crash after manifest commit'),
          { code: 'PROCESS_TERMINATED' },
        );
      }
      return eventBus.publish(...args);
    },
  };
  assert.throws(
    () => commitIdeaNodeOutput({
      context,
      node: secondNode,
      result: secondOutput,
    }),
    (error) => error?.code === 'PROCESS_TERMINATED',
  );
  assert.equal(
    runStore.load(runId).nodes[secondNode.id].status,
    NODE_STATES.RUNNING,
    'artifact commit precedes the RunStore success transition',
  );
  assert.equal(
    eventBus.replay({ runId }).artifactLineage
      .some((entry) => entry.nodeId === secondNode.id),
    false,
    'the simulated crash leaves the manifest commit without its outbox event',
  );

  const reconciled = reconcileCommittedIdeaNodeOutputs(context);
  assert.equal(reconciled.nodes[secondNode.id].status, NODE_STATES.SUCCEEDED);
  assert.equal(reconciled.nodes[secondNode.id].imported, true);
  assert.deepEqual(
    hydrateIdeaNodeOutput(context, secondNode, {
      record: reconciled.nodes[secondNode.id],
    }),
    secondOutput,
  );
  const lineage = artifactStore.lineageForRun(runId)
    .find((entry) => entry.nodeId === secondNode.id);
  assert.deepEqual(lineage.inputArtifactRefs, firstCompletion.artifacts);
  const reconciledEventLineage = eventBus.replay({ runId }).artifactLineage
    .find((entry) => entry.nodeId === secondNode.id);
  assert.deepEqual(reconciledEventLineage.ref, lineage.ref);
  assert.deepEqual(
    reconciledEventLineage.inputArtifactRefs,
    firstCompletion.artifacts,
  );

  const repeated = commitIdeaNodeOutput({
    context,
    node: secondNode,
    result: secondOutput,
  });
  assert.deepEqual(repeated.artifacts, [lineage.ref]);
  assert.equal(
    artifactStore.history(`${runId}:${secondNode.id}`).length,
    1,
    'completion commit remains idempotent across reconciliation',
  );
});

test('verification publishes only generator output, never deterministic source material', async () => {
  const sourceMaterial = {
    title: 'Source material must remain context only',
    theme: 'source theme',
    heat: 99,
    tickers: ['SRC'],
  };
  const generated = {
    title: 'Generated grid equipment opportunity',
    theme: 'power infrastructure',
    heat: 72,
    rationale: 'Grid capex is underestimated.',
    tickers: ['GEV'],
    catalyst: 'Utility capital plans',
    edge: 'Consensus is behind the order cycle.',
  };
  let requestedTickers = null;
  const output = await verifyCandidates({
    spec: IDEA_GENERATION_WORKFLOW_SPEC,
    specHash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    runId: 'idea_run_source_boundary',
    snapshot: inputSnapshot({
      runId: 'idea_run_source_boundary',
      demo: false,
    }),
    nodeResults: {
      'collect-market-context': {
        sourceCandidates: [sourceMaterial],
      },
      'build-diversification-constraints': {
        existingTitles: [],
      },
      'generate-candidates': {
        rawCandidates: [generated],
      },
    },
    services: {
      async verifyCandidateTickers(tickers) {
        requestedTickers = [...tickers];
        return new Set(['GEV', 'SRC']);
      },
    },
  });

  assert.deepEqual(requestedTickers, ['GEV']);
  assert.deepEqual(
    output.validIdeas.map((idea) => idea.title),
    [generated.title],
  );
  assert.equal(
    output.validIdeas.some((idea) => idea.title === sourceMaterial.title),
    false,
  );
});

test('review annotations never cull valid generated Ideas before persistence', async (t) => {
  const fixture = durableFixture(t, { count: 2, demo: false });
  const validIdeas = [
    generatedIdea('idea_high', 'High-scored generated idea'),
    generatedIdea('idea_unselected', 'Unselected generated idea', {
      theme: 'payments',
      tickers: ['V'],
    }),
    generatedIdea('idea_low_rank', 'Low-ranked generated idea', {
      theme: 'industrial automation',
      tickers: ['ROK'],
    }),
  ];
  let backendCalls = 0;
  const backend = {
    async run(request) {
      backendCalls += 1;
      assert.equal(request.agentContractId, 'idea-quality-reviewer');
      assert.equal(request.input.pool.length, validIdeas.length);
      return {
        status: 'succeeded',
        valid: true,
        output: {
          selected: [
            { index: 0, score: 96, reason: 'Strongest catalyst.' },
            { index: 2, score: 12, reason: 'Lower-ranked but still selected.' },
          ],
        },
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: { turns: 1, toolCalls: 0 },
        stopReason: 'final',
        traceRef: 'trace:quality-review',
        provider: 'test',
        model: 'deterministic-test',
        live: false,
      };
    },
  };
  const handlers = {
    ...IDEA_GENERATION_HANDLER_BINDINGS,
    async collectMarketContext() {
      return {
        market: {},
        sourceRuns: [],
        sourceCandidates: [{
          title: 'Source-only context',
          theme: 'source',
          tickers: ['SRC'],
        }],
      };
    },
    async buildDiversificationConstraints() {
      return {
        existingTitles: [],
        heldThemes: [],
        heavyThemes: [],
        concentration: { sorted: [], total: 1 },
      };
    },
    async generateCandidates() {
      return {
        rawCandidates: [],
        agent: { traceRef: 'trace:generator' },
      };
    },
    async verifyCandidates() {
      return { validIdeas, rejected: [], tickerVerification: {} };
    },
  };

  const execution = await executeWorkflowSpec({
    spec: IDEA_GENERATION_WORKFLOW_SPEC,
    handlers,
    hydrators: IDEA_GENERATION_HYDRATION_BINDINGS,
    conditions: IDEA_GENERATION_CONDITION_BINDINGS,
    context: fixture.context,
    runStore: fixture.runStore,
    runId: fixture.runId,
    onNodeComplete: commitIdeaNodeOutput,
    agentRuntime: agentExecutionRuntime,
    agentBackend: backend,
  });

  assert.equal(backendCalls, 1);
  const reviewed = execution.nodeResults['review-quality'];
  assert.deepEqual(
    reviewed.ideas.map((idea) => idea.id),
    validIdeas.map((idea) => idea.id),
  );
  assert.deepEqual(
    reviewed.annotations.map((item) => ({
      ideaId: item.ideaId,
      selected: item.selected,
      score: item.score,
      rank: item.rank,
    })),
    [
      { ideaId: 'idea_high', selected: true, score: 96, rank: 1 },
      { ideaId: 'idea_unselected', selected: false, score: null, rank: null },
      { ideaId: 'idea_low_rank', selected: true, score: 12, rank: 2 },
    ],
  );
  assert.deepEqual(
    execution.result.committed.map((idea) => idea.id),
    validIdeas.map((idea) => idea.id),
  );
  assert.equal(fixture.persistence.ideas.size, validIdeas.length);
});

test('DEMO_MODE completes all six nodes without invoking an injected deny backend', async (t) => {
  const fixture = durableFixture(t, { count: 2, demo: true });
  let backendCalls = 0;
  const denyBackend = {
    async run() {
      backendCalls += 1;
      throw new Error('DEMO_MODE attempted an Agent backend call');
    },
  };

  const first = await executeWorkflowSpec({
    spec: IDEA_GENERATION_WORKFLOW_SPEC,
    handlers: IDEA_GENERATION_HANDLER_BINDINGS,
    hydrators: IDEA_GENERATION_HYDRATION_BINDINGS,
    conditions: IDEA_GENERATION_CONDITION_BINDINGS,
    context: fixture.context,
    runStore: fixture.runStore,
    runId: fixture.runId,
    onNodeComplete: commitIdeaNodeOutput,
    agentRuntime: agentExecutionRuntime,
    agentBackend: denyBackend,
  });

  assert.equal(backendCalls, 0);
  assert.equal(first.result.committed.length, 2);
  assert.ok(
    Object.values(fixture.runStore.load(fixture.runId).nodes)
      .every((node) => node.status === NODE_STATES.SUCCEEDED),
  );
  assert.equal(fixture.artifactStore.list().length, 6);
  const lineageByNode = new Map(
    fixture.artifactStore.lineageForRun(fixture.runId)
      .map((entry) => [entry.nodeId, entry]),
  );
  for (const node of IDEA_GENERATION_WORKFLOW_SPEC.nodes) {
    assert.deepEqual(
      lineageByNode.get(node.id).inputArtifactRefs.map((ref) => ref.artifactId),
      (node.dependsOn || []).map((dependencyId) => (
        lineageByNode.get(dependencyId).ref.artifactId
      )),
    );
  }
  assert.equal(fixture.persistence.addCalls, 2);

  const resumed = await executeWorkflowSpec({
    spec: IDEA_GENERATION_WORKFLOW_SPEC,
    handlers: IDEA_GENERATION_HANDLER_BINDINGS,
    hydrators: IDEA_GENERATION_HYDRATION_BINDINGS,
    conditions: IDEA_GENERATION_CONDITION_BINDINGS,
    context: fixture.context,
    runStore: fixture.runStore,
    runId: fixture.runId,
    onNodeComplete: commitIdeaNodeOutput,
    agentRuntime: agentExecutionRuntime,
    agentBackend: denyBackend,
  });
  assert.equal(backendCalls, 0);
  assert.deepEqual(
    resumed.result.committed.map((idea) => idea.id),
    first.result.committed.map((idea) => idea.id),
  );
  assert.equal(fixture.artifactStore.list().length, 6);
  assert.equal(
    fixture.persistence.addCalls,
    2,
    'hydration does not execute persistence again',
  );
});
