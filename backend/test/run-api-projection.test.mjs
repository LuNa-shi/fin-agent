import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProjectAgentExecutionTimeline,
  getProjectRunDetail,
  listProjectRuns,
  projectRunTrace,
  runAnalysisWorkflowProjection,
  safeCompatibilityEventProjection,
  safeDurableEventProjection,
} from '../src/project-space/runApiProjection.js';
import { RUN_ANALYSIS_WORKFLOW_SPEC_HASH } from '../src/workflows/run-analysis/workflowSpec.js';

const artifactRef = {
  contract: 'artifact-ref.v1',
  artifactId: 'analysis.plan',
  version: 1,
  path: 'analysis/plan.json',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  schemaVersion: 'analysis-plan.output.v1',
  producer: 'analysis-plan',
  contractVersion: '1.0.0',
  inputDigest: `sha256:${'b'.repeat(64)}`,
  createdAt: '2026-07-20T00:00:03.000Z',
  asOf: '2026-07-20T00:00:00.000Z',
};
const agentRunId = 'agent_run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function durableEvents() {
  return [
    {
      eventId: 'evt-start',
      eventType: 'workflow.run.started',
      sequence: 1,
      timestamp: '2026-07-20T00:00:00.000Z',
      correlationId: 'run-1',
      causationId: null,
      runId: 'run-1',
      nodeId: null,
      messages: [{ role: 'assistant', content: 'SECRET_CHAIN' }],
      payload: {
        status: 'RUNNING',
        workflowSpec: { id: 'run-analysis.v2', version: '2.0.0', hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH },
        inputDigest: `sha256:${'c'.repeat(64)}`,
        rawToolResult: 'SECRET_RAW_RESULT',
      },
    },
    {
      eventId: 'evt-node-start',
      eventType: 'workflow.node.started',
      sequence: 2,
      timestamp: '2026-07-20T00:00:01.000Z',
      correlationId: 'run-1',
      causationId: 'evt-start',
      runId: 'run-1',
      nodeId: 'plan-research',
      payload: {
        status: 'RUNNING',
        attempt: 1,
        inputDigest: `sha256:${'d'.repeat(64)}`,
        args: { apiKey: 'SECRET_KEY' },
      },
    },
    {
      eventId: 'evt-agent-start',
      eventType: 'agent.execution.started',
      sequence: 3,
      timestamp: '2026-07-20T00:00:01.500Z',
      correlationId: 'run-1',
      causationId: 'evt-node-start',
      runId: 'run-1',
      nodeId: 'plan-research',
      payload: {
        agentRunId,
        agentId: 'analysis-plan',
        contractVersion: '1.0.0',
        workflowAttempt: 1,
        agentEventSequence: 1,
        status: 'RUNNING',
        activitySummary: 'Agent execution started.',
      },
    },
    {
      eventId: 'evt-agent-tool',
      eventType: 'agent.execution.activity',
      sequence: 4,
      timestamp: '2026-07-20T00:00:02.000Z',
      correlationId: 'run-1',
      causationId: 'evt-agent-start',
      runId: 'run-1',
      nodeId: 'plan-research',
      payload: {
        agentRunId,
        agentId: 'analysis-plan',
        contractVersion: '1.0.0',
        workflowAttempt: 1,
        agentEventSequence: 2,
        status: 'RUNNING',
        activityType: 'tool.completed',
        activitySummary: 'Tool ws_read_file completed.',
        tool: {
          name: 'ws_read_file',
          status: 'SUCCEEDED',
          sequence: 2,
          durationMs: 500,
        },
      },
    },
    {
      eventId: 'evt-agent-complete',
      eventType: 'agent.execution.completed',
      sequence: 5,
      timestamp: '2026-07-20T00:00:02.500Z',
      correlationId: 'run-1',
      causationId: 'evt-agent-tool',
      runId: 'run-1',
      nodeId: 'plan-research',
      payload: {
        agentRunId,
        agentId: 'analysis-plan',
        contractVersion: '1.0.0',
        workflowAttempt: 1,
        agentEventSequence: 3,
        status: 'SUCCEEDED',
        stopReason: 'final',
        activitySummary: 'Agent execution completed successfully.',
        provenance: 'physical',
        metrics: { turns: 1, toolCalls: 1, tokens: 120, wallMs: 1000 },
        provider: 'gpt-gateway',
        model: 'luna',
      },
    },
    {
      eventId: 'evt-node-done',
      eventType: 'workflow.node.succeeded',
      sequence: 6,
      timestamp: '2026-07-20T00:00:03.000Z',
      correlationId: 'run-1',
      causationId: 'evt-node-start',
      runId: 'run-1',
      nodeId: 'plan-research',
      payload: {
        status: 'SUCCEEDED',
        attempt: 1,
        outputDigest: `sha256:${'e'.repeat(64)}`,
        artifactRefs: [artifactRef],
        stopReason: 'final',
        imported: false,
        result: 'SECRET_RESULT_BODY',
      },
    },
    {
      eventId: 'evt-done',
      eventType: 'workflow.run.succeeded',
      sequence: 7,
      timestamp: '2026-07-20T00:00:04.000Z',
      correlationId: 'run-1',
      causationId: 'evt-node-done',
      runId: 'run-1',
      nodeId: null,
      payload: { status: 'SUCCEEDED', stopReason: 'final' },
    },
  ];
}

function runRecord() {
  return {
    projectId: 'proj-1',
    runId: 'run-1',
    status: 'SUCCEEDED',
    stopReason: 'final',
    workflowSpec: { id: 'run-analysis.v2', version: '2.0.0', hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH },
    asOf: '2026-07-20T00:00:00.000Z',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:04.000Z',
    completedAt: '2026-07-20T00:00:04.000Z',
    resumeCount: 0,
    remediationCycle: 0,
    nodes: {
      'plan-research': {
        nodeId: 'plan-research',
        status: 'SUCCEEDED',
        attempt: 1,
        stopReason: 'final',
        artifactRefs: [artifactRef],
        startedAt: '2026-07-20T00:00:01.000Z',
        completedAt: '2026-07-20T00:00:03.000Z',
        lastFailure: { category: 'transient', reason: 'retry', code: 'X', message: 'SECRET_FAILURE', at: '2026-07-20T00:00:00.500Z' },
        imported: false,
      },
    },
  };
}

function replayRun() {
  return {
    projectId: 'proj-1',
    runId: 'run-1',
    status: 'SUCCEEDED',
    stopReason: 'final',
    nodes: runRecord().nodes,
    artifactLineage: [{
      eventId: 'evt-artifact',
      sequence: 2,
      projectId: 'proj-1',
      runId: 'run-1',
      nodeId: 'plan-research',
      ref: artifactRef,
      inputArtifactRefs: [],
      content: 'SECRET_ARTIFACT_BODY',
    }],
  };
}

function projectSpaceFixture() {
  const record = runRecord();
  const events = durableEvents();
  const replay = { runs: { 'run-1': replayRun() }, events };
  const compatibility = [{
    ts: Date.parse('2026-07-20T00:00:02.000Z'),
    type: 'tool.completed',
    stage: 'plan',
    agent: 'analysis-plan',
    tool: 'fmp_quote',
    ok: true,
    text: 'SECRET_COMPAT_TEXT',
    args: { token: 'SECRET_TOKEN' },
    result: 'SECRET_TOOL_BODY',
    messages: ['SECRET_REASONING'],
  }];
  return {
    meta: (id) => id === 'proj-1' ? { id } : null,
    runStore: () => ({ list: () => [record], resumable: () => null }),
    replayEvents: () => replay,
    events: () => compatibility,
  };
}

test('safe event projections expose metadata while excluding messages, arguments, and raw results', () => {
  const durable = safeDurableEventProjection(durableEvents()[0]);
  const compatibility = safeCompatibilityEventProjection(projectSpaceFixture().events()[0]);
  const signedUri = safeDurableEventProjection({
    eventType: 'artifact.committed',
    payload: { artifactRef: { uri: 'https://user:password@example.com/file?token=SECRET_URI#private' } },
  });
  const reviewAudit = safeDurableEventProjection({
    eventId: 'evt-review',
    eventType: 'human-review.decision.recorded',
    sequence: 5,
    timestamp: '2026-07-20T00:00:05.000Z',
    runId: 'run-1',
    nodeId: null,
    payload: {
      status: 'decided',
      taskId: 'hrt_safe',
      taskVersion: 1,
      decisionId: 'hrd_safe',
      reviewerId: 'local-user',
      selectedAction: 'report-only-revision',
      requestDigest: `sha256:${'1'.repeat(64)}`,
      decisionDigest: `sha256:${'2'.repeat(64)}`,
      humanReviewAttempt: 1,
      reviewRound: 4,
      rerunNodeIds: ['compose-report', 'review-report'],
      reopenNodeIds: ['synthesize-conclusion', 'finalize-project'],
      decisionRef: artifactRef,
      openIssues: [{ message: 'SECRET_REVIEW_ISSUE' }],
      comment: 'SECRET_REVIEW_COMMENT',
      endpoint: 'https://private.example.test?token=SECRET_REVIEW_TOKEN',
    },
  });
  const serialized = JSON.stringify({
    durable,
    compatibility,
    signedUri,
    reviewAudit,
  });

  assert.equal(durable.status, 'RUNNING');
  assert.equal(compatibility.tool, 'fmp_quote');
  assert.equal(compatibility.status, 'SUCCEEDED');
  assert.equal(signedUri.artifactRef.uri, 'https://example.com/file');
  assert.equal(reviewAudit.taskId, 'hrt_safe');
  assert.equal(reviewAudit.decisionId, 'hrd_safe');
  assert.equal(reviewAudit.reviewerId, 'local-user');
  assert.equal(reviewAudit.reviewRound, 4);
  assert.deepEqual(reviewAudit.rerunNodeIds, ['compose-report', 'review-report']);
  for (const secret of [
    'SECRET_CHAIN',
    'SECRET_RAW_RESULT',
    'SECRET_COMPAT_TEXT',
    'SECRET_TOKEN',
    'SECRET_TOOL_BODY',
    'SECRET_REASONING',
    'SECRET_URI',
    'SECRET_REVIEW_ISSUE',
    'SECRET_REVIEW_COMMENT',
    'SECRET_REVIEW_TOKEN',
    'password',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('run detail combines RunStore state, durable replay, agent bindings, tools, and lineage safely', () => {
  const projectSpace = projectSpaceFixture();
  const detail = getProjectRunDetail('proj-1', 'run-1', { projectSpace });
  const listed = listProjectRuns('proj-1', { projectSpace });
  const serialized = JSON.stringify(detail);

  assert.equal(detail.schemaVersion, 'run-trace.v2');
  assert.equal(detail.status, 'SUCCEEDED');
  assert.equal(detail.stopReason, 'final');
  assert.equal(detail.attempts, 1);
  assert.deepEqual(detail.nodes[0].agentIds, ['analysis-plan']);
  assert.equal(detail.nodes[0].startedAt, '2026-07-20T00:00:01.000Z');
  assert.equal(detail.toolEvents[0].tool, 'fmp_quote');
  assert.equal(detail.agentRuns.length, 1);
  assert.equal(detail.agentRuns[0].agentRunId, agentRunId);
  assert.equal(detail.agentRuns[0].status, 'SUCCEEDED');
  assert.equal(Object.hasOwn(detail, 'agentExecutions'), false);
  assert.equal(detail.lineage[0].ref.path, 'analysis/plan.json');
  assert.equal(listed.count, 1);
  assert.equal(listed.runs[0].artifactCount, 1);
  assert.equal(listed.runs[0].agentExecutionCount, 1);
  for (const secret of ['SECRET_FAILURE', 'SECRET_ARTIFACT_BODY', 'SECRET_RESULT_BODY', 'SECRET_KEY']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const forbiddenKey of ['messages', 'args', 'result', 'rawToolResult']) {
    assert.equal(Object.hasOwn(JSON.parse(serialized), forbiddenKey), false);
  }
});

test('Project Agent execution timeline is scoped, paginated, and 404s unknown runs', () => {
  const projectSpace = projectSpaceFixture();
  const first = getProjectAgentExecutionTimeline('proj-1', 'run-1', agentRunId, {
    projectSpace,
    limit: 2,
  });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[1].tool.name, 'ws_read_file');
  const second = getProjectAgentExecutionTimeline('proj-1', 'run-1', agentRunId, {
    projectSpace,
    afterSequence: first.nextAfterSequence,
    limit: 2,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].status, 'SUCCEEDED');
  assert.equal(second.hasMore, false);
  assert.throws(
    () => getProjectAgentExecutionTimeline('proj-1', 'run-missing', agentRunId, {
      projectSpace,
    }),
    (error) => error.code === 'RUN_NOT_FOUND' && error.statusCode === 404,
  );
});

test('pure run projection rejects missing runs and preserves only safe trace fields', () => {
  assert.throws(
    () => projectRunTrace({ projectId: 'proj-1', runId: 'missing' }),
    (error) => error.code === 'RUN_NOT_FOUND',
  );
});

test('canonical workflow projection exposes the versioned spec, graph edges, and Agent bindings', () => {
  const projection = runAnalysisWorkflowProjection();
  assert.equal(projection.schemaVersion, 'workflow-graph.v1');
  assert.equal(projection.workflow.id, 'run-analysis.v2');
  assert.equal(projection.workflow.hash, RUN_ANALYSIS_WORKFLOW_SPEC_HASH);
  assert.equal(projection.nodes.length, 8);
  assert.ok(projection.edges.some((edge) => edge.from === 'run-research-rounds' && edge.to === 'compose-report'));
  assert.deepEqual(
    projection.nodes.find((node) => node.id === 'review-report').agentIds,
    ['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer', 'data-scoreboard-evaluator', 'industry-scoreboard-evaluator', 'company-scoreboard-evaluator'],
  );
  assert.deepEqual(projection.topologicalOrder.at(-1), 'finalize-project');
  assert.equal(projection.spec.version, '2.0.0');
});
