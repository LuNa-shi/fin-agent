import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import {
  ideaGenerationAgentTimeline,
  ideaGenerationProgress,
  ideaGenerationTrace,
  ideaGenerationTraces,
  ideaGenerationWorkflowProjection,
} from '../src/workflows/idea-generation/runApiProjection.js';
import {
  publicIdeaGenerationResult,
} from '../src/workflows/idea-generation/publicProjection.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from '../src/workflows/idea-generation/workflowSpec.js';

const AS_OF = '2026-07-23T08:00:00.000Z';
const SNAPSHOT_ID = `idea-run-input-snapshot:${'b'.repeat(64)}`;
const NODE_IDS = IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.id);
const AGENT_RUN_ID = 'agent_run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRIVATE_SENTINELS = Object.freeze([
  'Fixture system prompt',
  'Fixture user prompt',
  'RAW_TOOL_RESULT_SENTINEL',
  'RAW_TOOL_ARGUMENT_SENTINEL',
  'RAW_AGENT_MESSAGE_SENTINEL',
]);
const FORBIDDEN_PUBLIC_FIELDS = new Set([
  'prompt',
  'systemPrompt',
  'userPrompt',
  'messages',
  'toolArguments',
  'toolResult',
  'nodeExecutions',
]);

function assertPublicProjection(value) {
  const visit = (child) => {
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (!child || typeof child !== 'object') return;
    for (const [field, nested] of Object.entries(child)) {
      assert.equal(
        FORBIDDEN_PUBLIC_FIELDS.has(field),
        false,
        `public projection exposed forbidden field: ${field}`,
      );
      visit(nested);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `public projection exposed private sentinel: ${sentinel}`,
    );
  }
}

function agentExecutionEvents(runId) {
  return [
    {
      eventId: `${runId}-agent-start`,
      eventType: 'agent.execution.started',
      sequence: 1,
      timestamp: '2026-07-23T08:00:01.000Z',
      correlationId: runId,
      causationId: null,
      runId,
      nodeId: 'generate-candidates',
      payload: {
        agentRunId: AGENT_RUN_ID,
        agentId: 'idea-generator',
        contractVersion: '1.0.1',
        workflowAttempt: 1,
        agentEventSequence: 1,
        status: 'RUNNING',
        activitySummary: 'Agent execution started.',
      },
    },
    {
      eventId: `${runId}-agent-turn`,
      eventType: 'agent.execution.activity',
      sequence: 2,
      timestamp: '2026-07-23T08:00:02.000Z',
      correlationId: runId,
      causationId: `${runId}-agent-start`,
      runId,
      nodeId: 'generate-candidates',
      payload: {
        agentRunId: AGENT_RUN_ID,
        agentId: 'idea-generator',
        contractVersion: '1.0.1',
        workflowAttempt: 1,
        agentEventSequence: 2,
        status: 'RUNNING',
        activityType: 'agent.turn.completed',
        activitySummary: 'Agent turn completed with stop reason stop.',
        stopReason: 'stop',
      },
    },
    {
      eventId: `${runId}-agent-complete`,
      eventType: 'agent.execution.completed',
      sequence: 3,
      timestamp: '2026-07-23T08:00:03.000Z',
      correlationId: runId,
      causationId: `${runId}-agent-turn`,
      runId,
      nodeId: 'generate-candidates',
      payload: {
        agentRunId: AGENT_RUN_ID,
        agentId: 'idea-generator',
        contractVersion: '1.0.1',
        workflowAttempt: 1,
        agentEventSequence: 3,
        status: 'SUCCEEDED',
        stopReason: 'final',
        activitySummary: 'Agent execution completed successfully.',
        provenance: 'physical',
        metrics: { turns: 1, toolCalls: 0, tokens: 100, wallMs: 2000 },
        provider: 'gpt-gateway',
        model: 'luna',
      },
    },
  ];
}

function nodeOutputs(runId) {
  const validIdeas = [
    {
      id: `idea_${'1'.repeat(64)}`,
      title: 'Ranked grid opportunity',
      theme: 'grid',
      heat: 90,
      tickers: ['GEV'],
      qualityScore: 95,
      qualityRank: 1,
      qualitySelected: true,
    },
    {
      id: `idea_${'2'.repeat(64)}`,
      title: 'Unselected but valid grid opportunity',
      theme: 'grid',
      heat: 60,
      tickers: ['ETN'],
      qualityScore: null,
      qualityRank: null,
      qualitySelected: false,
    },
  ];
  return {
    'collect-market-context': {
      market: {
        domainsUsed: ['industrials'],
        saIdeas: [{ title: 'source material' }],
        headlines: [{ title: 'RAW_TOOL_RESULT_SENTINEL' }],
      },
      sourceRuns: [
        { sourceId: 'news-idea-agent', status: 'succeeded' },
        { sourceId: 'research-idea-agent', status: 'succeeded' },
      ],
      sourceCandidates: [{ title: 'generation material', theme: 'grid' }],
      sourceCalls: [{
        arguments: { query: 'RAW_TOOL_ARGUMENT_SENTINEL' },
        result: 'RAW_TOOL_RESULT_SENTINEL',
      }],
    },
    'build-diversification-constraints': {
      existingTitles: ['Existing title'],
      heldThemes: ['software'],
      heavyThemes: ['software(3)'],
    },
    'generate-candidates': {
      rawCandidates: validIdeas.map(({ id: _id, ...idea }) => idea),
      agent: {
        provider: 'deterministic-test',
        model: 'fixture',
        live: false,
        traceRef: `trace:${runId}:generator`,
      },
      prompt: {
        system: 'Fixture system prompt',
        user: 'Fixture user prompt',
      },
      messages: [{ content: 'RAW_AGENT_MESSAGE_SENTINEL' }],
    },
    'verify-candidates': {
      validIdeas,
      rejected: [{ index: 2, reason: 'missing-title' }],
      tickerVerification: {
        requested: ['GEV', 'ETN', 'BAD'],
        valid: ['GEV', 'ETN'],
        invalid: ['BAD'],
      },
    },
    'review-quality': {
      ideas: validIdeas,
      annotations: validIdeas.map((idea) => ({
        ideaId: idea.id,
        selected: idea.qualitySelected,
        score: idea.qualityScore,
        rank: idea.qualityRank,
      })),
      agent: {
        provider: 'deterministic-review',
        live: false,
        traceRef: `trace:${runId}:reviewer`,
      },
      review: {
        messages: [{ content: 'RAW_AGENT_MESSAGE_SENTINEL' }],
        toolResult: 'RAW_TOOL_RESULT_SENTINEL',
      },
    },
    'persist-ideas': {
      committed: validIdeas.map((idea) => ({
        ...idea,
        sourceIdeaRunId: runId,
        sourceRunInputSnapshotId: SNAPSHOT_ID,
      })),
      ideaRefs: validIdeas.map((idea) => ({
        id: idea.id,
        contentRef: `idea-generation/ideas/${idea.id}`,
        contentDigest: `sha256:${idea.id.at(-1).repeat(64)}`,
      })),
      rejected: [{ index: 2, reason: 'missing-title' }],
    },
  };
}

function artifactRef(runId, nodeId, output, index) {
  return {
    contract: 'artifact-ref.v1',
    artifactId: `${runId}:${nodeId}`,
    version: 1,
    path: `outputs/${nodeId}.json`,
    contentDigest: canonicalSha256({ runId, nodeId, output }),
    schemaVersion: `${nodeId}.output.v1`,
    producer: `idea-generation.v2/${nodeId}`,
    contractVersion: '1.0.0',
    inputDigest: `sha256:${String(index + 1).repeat(64)}`,
    createdAt: AS_OF,
    asOf: AS_OF,
  };
}

function runFixture({
  runId,
  createdAt,
  status = 'SUCCEEDED',
  succeededNodes = NODE_IDS,
} = {}) {
  const outputs = nodeOutputs(runId);
  const artifacts = new Map();
  const nodes = Object.fromEntries(NODE_IDS.map((nodeId, index) => {
    const succeeded = succeededNodes.includes(nodeId);
    const ref = artifactRef(runId, nodeId, outputs[nodeId], index);
    if (succeeded) {
      artifacts.set(ref.artifactId, JSON.stringify({
        schemaVersion: 'idea-generation-node-output.v1',
        workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
        runId,
        nodeId,
        snapshotId: SNAPSHOT_ID,
        asOf: AS_OF,
        output: outputs[nodeId],
      }));
    }
    return [nodeId, {
      nodeId,
      status: succeeded ? 'SUCCEEDED' : (nodeId === 'generate-candidates' ? 'RUNNING' : 'PENDING'),
      attempt: succeeded || nodeId === 'generate-candidates' ? 1 : 0,
      inputDigest: succeeded || nodeId === 'generate-candidates' ? ref.inputDigest : null,
      outputDigest: succeeded ? canonicalSha256(outputs[nodeId]) : null,
      stopReason: succeeded ? 'final' : null,
      artifactRefs: succeeded ? [ref] : [],
      startedAt: succeeded || nodeId === 'generate-candidates' ? createdAt : null,
      completedAt: succeeded ? createdAt : null,
      lastFailure: null,
      imported: false,
    }];
  }));
  const completedAt = status === 'RUNNING' ? null : new Date(Date.parse(createdAt) + 4_000).toISOString();
  const record = {
    projectId: 'idea-universe:local-user',
    runId,
    workflowSpec: {
      id: IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: IDEA_GENERATION_WORKFLOW_SPEC.version,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    },
    inputDigest: `sha256:${'a'.repeat(64)}`,
    asOf: AS_OF,
    status,
    stopReason: status === 'RUNNING' ? null : 'final',
    resumeCount: 0,
    remediationCycle: 0,
    createdAt,
    updatedAt: completedAt || createdAt,
    completedAt,
    scope: { kind: 'idea-universe', id: 'idea-universe:local-user' },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: SNAPSHOT_ID,
    nodes,
  };
  const services = {
    snapshot: {
      runId,
      snapshotId: SNAPSHOT_ID,
      asOf: AS_OF,
      configDigest: `sha256:${'c'.repeat(64)}`,
      inputs: { command: { count: 1 } },
    },
    scope: record.scope,
    eventBus: {
      list: () => agentExecutionEvents(runId),
      replay: () => ({ runs: {}, events: agentExecutionEvents(runId) }),
    },
    artifactStore: {
      read(ref) {
        const text = artifacts.get(ref.artifactId);
        if (!text) throw new Error(`fixture artifact missing: ${ref.artifactId}`);
        return text;
      },
    },
  };
  return { record, services, artifacts };
}

function storageFixture(fixtures) {
  const byRunId = new Map(fixtures.map((fixture) => [fixture.record.runId, fixture]));
  return {
    list: () => fixtures.map((fixture) => fixture.record),
    services(runId) {
      const fixture = byRunId.get(runId);
      if (!fixture) throw new Error(`fixture run missing: ${runId}`);
      return fixture.services;
    },
  };
}

test('durable trace preserves legacy fields while publishing every valid ranked or unselected Idea', () => {
  const complete = runFixture({
    runId: 'idea_run_complete',
    createdAt: '2026-07-23T08:00:00.000Z',
  });
  const storage = storageFixture([complete]);
  const trace = ideaGenerationTrace('idea_run_complete', {}, { storage });

  assert.equal(trace.schemaVersion, 'idea-generation-trace.v3');
  assert.equal(trace.id, 'idea_run_complete');
  assert.equal(trace.traceId, trace.runId);
  assert.equal(trace.snapshotId, SNAPSHOT_ID);
  assert.equal(trace.provider, 'deterministic-test');
  assert.equal(trace.live, false);
  assert.equal(trace.durationMs, 4_000);
  assert.equal(Object.hasOwn(trace, 'systemPrompt'), false);
  assert.equal(Object.hasOwn(trace, 'userPrompt'), false);
  assert.equal(JSON.stringify(trace).includes('Fixture system prompt'), false);
  assert.equal(JSON.stringify(trace).includes('Fixture user prompt'), false);
  assert.deepEqual(trace.sourceAgents, ['news-idea-agent', 'research-idea-agent']);
  assert.equal(trace.steps.length, 6);
  assert.match(
    trace.steps.find((step) => step.stage === 'screen').text,
    /仅评分和排序，不过滤发布/u,
  );
  assert.deepEqual(
    trace.ideas.map((idea) => [idea.title, idea.qualitySelected]),
    [
      ['Ranked grid opportunity', true],
      ['Unselected but valid grid opportunity', false],
    ],
  );
  assert.equal(trace.nodes.length, 6);
  assert.equal(trace.artifacts.length, 6);
  assert.equal(trace.agentRuns.length, 1);
  assert.equal(trace.agentRuns[0].agentRunId, AGENT_RUN_ID);
  assert.equal(trace.agentRuns[0].status, 'SUCCEEDED');
  assert.equal(Object.hasOwn(trace, 'agentExecutions'), false);
  assertPublicProjection(trace);
});

test('progress prefers a running run and exact run/node filters expose one durable node output', () => {
  const terminal = runFixture({
    runId: 'idea_run_terminal',
    createdAt: '2026-07-23T09:00:00.000Z',
  });
  const running = runFixture({
    runId: 'idea_run_running',
    createdAt: '2026-07-23T08:00:00.000Z',
    status: 'RUNNING',
    succeededNodes: ['collect-market-context', 'build-diversification-constraints'],
  });
  const storage = storageFixture([running, terminal]);

  const latestProgress = ideaGenerationProgress({}, { storage });
  assert.equal(latestProgress.runId, 'idea_run_running');
  assert.equal(latestProgress.running, true);
  assert.equal(latestProgress.steps.find((step) => step.stage === 'reason').status, 'running');

  const exact = ideaGenerationProgress({
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    runId: 'idea_run_terminal',
    nodeId: 'review-quality',
  }, { storage });
  assert.equal(exact.runId, 'idea_run_terminal');
  assert.equal(exact.running, false);
  assert.equal(exact.nodeId, 'review-quality');
  assert.equal(exact.nodes.length, 1);
  assert.equal(exact.nodes[0].nodeId, 'review-quality');
  assert.deepEqual(exact.steps.map((step) => step.stage), ['screen']);
  assert.equal(exact.nodeOutput.annotations.length, 2);

  const generator = ideaGenerationTrace('idea_run_terminal', {
    nodeId: 'generate-candidates',
  }, { storage });
  assert.equal(Object.hasOwn(generator.nodeOutput, 'prompt'), false);
  assertPublicProjection(generator);

  for (const nodeId of NODE_IDS) {
    assertPublicProjection(ideaGenerationTrace('idea_run_terminal', {
      nodeId,
    }, { storage }));
  }
});

test('public generation response keeps business compatibility fields and omits executor/private payloads', () => {
  const result = publicIdeaGenerationResult({
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    runId: 'idea_run_public_post',
    snapshotId: SNAPSHOT_ID,
    asOf: AS_OF,
    status: 'SUCCEEDED',
    stopReason: 'final',
    provider: 'gpt-gateway',
    live: true,
    traceId: 'idea_run_public_post',
    ideas: [{
      id: `idea_${'3'.repeat(64)}`,
      title: 'Public Idea',
      theme: 'grid',
      tickers: ['GEV'],
      messages: [{ content: 'RAW_AGENT_MESSAGE_SENTINEL' }],
      toolResult: 'RAW_TOOL_RESULT_SENTINEL',
    }],
    generated: [{
      id: `idea_${'3'.repeat(64)}`,
      title: 'Public Idea',
      theme: 'grid',
      tickers: ['GEV'],
      prompt: {
        system: 'Fixture system prompt',
        user: 'Fixture user prompt',
      },
    }],
    rejected: [{ index: 1, reason: 'missing-title', toolArguments: 'RAW_TOOL_ARGUMENT_SENTINEL' }],
    nodeExecutions: {
      'generate-candidates': {
        output: {
          prompt: {
            system: 'Fixture system prompt',
            user: 'Fixture user prompt',
          },
        },
      },
    },
    execution: {
      executedNodeIds: ['generate-candidates'],
      hydratedNodeIds: [],
      stoppedAt: null,
      messages: [{ content: 'RAW_AGENT_MESSAGE_SENTINEL' }],
    },
  });

  assert.deepEqual(result.generated[0], {
    id: `idea_${'3'.repeat(64)}`,
    title: 'Public Idea',
    theme: 'grid',
    tickers: ['GEV'],
  });
  assert.deepEqual(result.execution, {
    executedNodeIds: ['generate-candidates'],
    hydratedNodeIds: [],
    stoppedAt: null,
  });
  assertPublicProjection(result);
});

test('Idea Agent execution timeline matches Project pagination semantics', () => {
  const complete = runFixture({
    runId: 'idea_run_agent_timeline',
    createdAt: '2026-07-23T08:00:00.000Z',
  });
  const storage = storageFixture([complete]);
  const first = ideaGenerationAgentTimeline(
    complete.record.runId,
    AGENT_RUN_ID,
    { storage, limit: 2 },
  );
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].agentId, 'idea-generator');
  const second = ideaGenerationAgentTimeline(
    complete.record.runId,
    AGENT_RUN_ID,
    {
      storage,
      afterSequence: first.nextAfterSequence,
      limit: 2,
    },
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].status, 'SUCCEEDED');
  assert.equal(second.hasMore, false);
  assert.throws(
    () => ideaGenerationAgentTimeline(
      complete.record.runId,
      'agent_run_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      { storage },
    ),
    (error) => error.code === 'AGENT_RUN_NOT_FOUND' && error.statusCode === 404,
  );
});

test('durable trace listing is newest-first, bounded, and supports an exact run filter', () => {
  const older = runFixture({
    runId: 'idea_run_older',
    createdAt: '2026-07-23T07:00:00.000Z',
  });
  const newer = runFixture({
    runId: 'idea_run_newer',
    createdAt: '2026-07-23T10:00:00.000Z',
  });
  const storage = storageFixture([older, newer]);

  assert.deepEqual(
    ideaGenerationTraces(1, {}, { storage }).map((trace) => trace.runId),
    ['idea_run_newer'],
  );
  assert.deepEqual(
    ideaGenerationTraces(40, { runId: 'idea_run_older' }, { storage })
      .map((trace) => trace.runId),
    ['idea_run_older'],
  );
});

test('exact filters fail closed for missing workflows, runs, nodes, and path/query conflicts', () => {
  const storage = storageFixture([runFixture({
    runId: 'idea_run_known',
    createdAt: '2026-07-23T08:00:00.000Z',
  })]);

  assert.throws(
    () => ideaGenerationTraces(40, { workflowId: 'idea-generation.v1' }, { storage }),
    (error) => error.code === 'IDEA_WORKFLOW_NOT_FOUND' && error.statusCode === 404,
  );
  assert.throws(
    () => ideaGenerationTrace('idea_run_missing', {}, { storage }),
    (error) => error.code === 'IDEA_RUN_NOT_FOUND' && error.statusCode === 404,
  );
  assert.throws(
    () => ideaGenerationProgress({ nodeId: 'unknown-node' }, { storage }),
    (error) => error.code === 'IDEA_NODE_NOT_FOUND' && error.statusCode === 404,
  );
  assert.throws(
    () => ideaGenerationTrace('idea_run_known', { runId: 'idea_run_other' }, { storage }),
    (error) => error.code === 'IDEA_RUN_FILTER_CONFLICT' && error.statusCode === 400,
  );
});

test('node artifact identity and output digests are verified before projection', () => {
  const fixture = runFixture({
    runId: 'idea_run_corrupt',
    createdAt: '2026-07-23T08:00:00.000Z',
  });
  const ref = fixture.record.nodes['review-quality'].artifactRefs[0];
  const envelope = JSON.parse(fixture.artifacts.get(ref.artifactId));
  envelope.output.annotations = [];
  fixture.artifacts.set(ref.artifactId, JSON.stringify(envelope));
  const storage = storageFixture([fixture]);

  assert.throws(
    () => ideaGenerationTrace(
      fixture.record.runId,
      { nodeId: 'review-quality' },
      { storage },
    ),
    (error) => error.code === 'IDEA_NODE_OUTPUT_DIGEST_MISMATCH',
  );
});

test('Idea Generation workflow metadata exposes the canonical six-node graph', () => {
  const projection = ideaGenerationWorkflowProjection();
  assert.equal(projection.schemaVersion, 'workflow-graph.v1');
  assert.equal(projection.workflow.id, 'idea-generation.v2');
  assert.equal(projection.workflow.hash, IDEA_GENERATION_WORKFLOW_SPEC_HASH);
  assert.deepEqual(projection.topologicalOrder, NODE_IDS);
  assert.equal(projection.nodes.length, 6);
  assert.ok(projection.edges.some((edge) => (
    edge.from === 'review-quality' && edge.to === 'persist-ideas'
  )));
  assert.deepEqual(
    projection.nodes.find((node) => node.id === 'review-quality').agentIds,
    ['idea-quality-reviewer'],
  );
});

test('IdeaSystem/server/API/UI wire durable filters without legacy liveRun or JSONL reads', async () => {
  const [systemSource, projectionSource, serverSource, apiSource, viewSource] = await Promise.all([
    readFile(new URL('../src/workflows/idea-generation/ideaSystem.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/runApiProjection.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/views/IdeaView.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(systemSource, /from ['"]\.\/runApiProjection\.js['"]/u);
  assert.doesNotMatch(systemSource, /liveRun|idea-traces\.jsonl|appendTrace|loadTraces/u);
  assert.doesNotMatch(projectionSource, /liveRun|idea-traces\.jsonl|appendFileSync/u);
  assert.match(serverSource, /\/api\/workflows\/idea-generation/u);
  for (const field of ['workflowId', 'runId', 'nodeId']) {
    assert.match(serverSource, new RegExp(`req\\.query\\?\\.${field}`, 'u'));
  }
  assert.match(apiSource, /ideaWorkflowSpec/u);
  assert.match(apiSource, /ideaProgress: \(filters = \{\}\)/u);
  assert.match(apiSource, /encodeURIComponent\(id\)/u);
  assert.match(viewSource, /标的校验与质量评分/u);
  assert.match(viewSource, /provider === 'demo'/u);
  assert.match(viewSource, /trace\.status/u);
  assert.match(viewSource, /trace\.stopReason/u);
  assert.doesNotMatch(viewSource, /t\.live \? '真实' : '演示'/u);
  assert.doesNotMatch(viewSource, /质检筛选去重/u);
});
