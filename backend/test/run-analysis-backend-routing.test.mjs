import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withAgentResultObserver } from '../src/agents/AgentExecutionRuntime.js';
import { createRunAnalysisRuntimeMetrics } from '../src/workflows/run-analysis/runAnalysis.workflow.js';
import { priorReviewIssuesForNode } from '../src/workflows/run-analysis/runAnalysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

test('Run Analysis runtime metrics aggregate complete Agent results once and retain unknown cost as null', async () => {
  const runtimeMetrics = createRunAnalysisRuntimeMetrics();
  const results = new Map([
    ['agent-run-1', {
      traceRef: 'agent-run-1',
      metrics: {
        wallMs: 10,
        turns: 1,
        toolCalls: 0,
        toolAttempts: 0,
        toolDenied: 0,
        inputTokens: 6,
        outputTokens: 4,
        reasoningTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        tokens: 10,
        costKnown: true,
        costUsd: 0.1,
      },
    }],
    ['agent-run-2', {
      traceRef: 'agent-run-2',
      metrics: {
        wallMs: 20,
        turns: 2,
        toolCalls: 1,
        toolAttempts: 2,
        toolDenied: 1,
        inputTokens: 3,
        outputTokens: 2,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: 5,
        costKnown: false,
        costUsd: null,
      },
    }],
  ]);
  const backend = withAgentResultObserver({
    run: async (request) => results.get(request.runId),
  }, runtimeMetrics.record);

  await backend.run({ runId: 'agent-run-1' });
  runtimeMetrics.record({
    request: { runId: 'agent-run-1' },
    result: results.get('agent-run-1'),
    provenance: 'cache-hit',
  });
  await backend.run({ runId: 'agent-run-2' });

  assert.deepEqual(runtimeMetrics.snapshot(), {
    schemaVersion: 'run-analysis-runtime-metrics.v1',
    complete: true,
    agentRuns: 2,
    wallMs: 30,
    turns: 3,
    toolCalls: 1,
    toolAttempts: 2,
    toolDenied: 1,
    tokenUsage: {
      input: 9,
      output: 6,
      reasoning: 2,
      cacheRead: 1,
      cacheWrite: 0,
      total: 15,
    },
    costKnown: false,
    costUsd: null,
    recordedRunIds: ['agent-run-1', 'agent-run-2'],
  });

  const resumed = createRunAnalysisRuntimeMetrics(runtimeMetrics.snapshot());
  resumed.record({
    request: { runId: 'agent-run-2' },
    result: results.get('agent-run-2'),
    provenance: 'cache-hit',
  });
  assert.deepEqual(resumed.snapshot(), runtimeMetrics.snapshot());

  const historicalWithoutMetrics = createRunAnalysisRuntimeMetrics({});
  historicalWithoutMetrics.record({ request: { runId: 'agent-run-1' }, result: results.get('agent-run-1') });
  assert.equal(historicalWithoutMetrics.snapshot().complete, false);
});

test('Run Analysis metrics count physical retry usage without changing logical Agent counts', () => {
  const runtimeMetrics = createRunAnalysisRuntimeMetrics();
  const request = { runId: 'agent-run-retry' };
  const result = {
    metrics: {
      wallMs: 10,
      turns: 1,
      toolCalls: 0,
      toolAttempts: 0,
      toolDenied: 0,
      inputTokens: 6,
      outputTokens: 4,
      reasoningTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      tokens: 10,
      costKnown: false,
      costUsd: null,
    },
  };

  runtimeMetrics.record({ request, result, provenance: 'physical' });
  runtimeMetrics.record({ request, result, provenance: 'physical' });
  runtimeMetrics.record({ request, result, provenance: 'cache-hit' });
  runtimeMetrics.record({ request, result, provenance: 'coalesced' });

  const snapshot = runtimeMetrics.snapshot();
  assert.equal(snapshot.agentRuns, 1);
  assert.equal(snapshot.wallMs, 20);
  assert.deepEqual(snapshot.recordedRunIds, ['agent-run-retry']);
});

test('Run Analysis supplies active remediation issues only to report composition and review', () => {
  const issues = [{ id: 'review-1', owner: 'report', blocking: true }];
  const context = { cp: { activeRemediation: { issues } } };

  for (const nodeId of ['compose-report', 'review-report']) {
    assert.equal(
      priorReviewIssuesForNode({ context, node: { id: nodeId } }),
      issues,
    );
  }
  for (const nodeId of [
    'initialize-checkpoint',
    'plan-research',
    'select-candidates',
    'run-research-rounds',
    'synthesize-conclusion',
    'finalize-project',
  ]) {
    assert.deepEqual(
      priorReviewIssuesForNode({ context, node: { id: nodeId } }),
      [],
      nodeId,
    );
  }
  assert.deepEqual(
    priorReviewIssuesForNode({
      context: { cp: { activeRemediation: null } },
      node: { id: 'compose-report' },
    }),
    [],
  );
});

test('runAnalysis composition injects the unified execution backend without owning node behavior', () => {
  const facade = read('src/workflows/run-analysis/runAnalysis.workflow.js');
  const composition = read('src/workflows/run-analysis/runAnalysis.js');
  const backendObserver = read('src/workflows/run-analysis/runtime/agentBackend.js');
  const handlers = [
    'planResearch',
    'selectCandidates',
    'composeReport',
    'reviewReport',
    'synthesizeConclusion',
  ].map((name) => read(`src/workflows/run-analysis/handlers/${name}.js`)).join('\n');
  assert.doesNotMatch(handlers, /\brunAgent\s*\(/);
  assert.doesNotMatch(handlers, /\bchatJSON\s*\(/);
  for (const id of ['analysis-plan', 'scan-score', 'report-composer', 'conclusion-synthesizer']) {
    assert.match(handlers, new RegExp(`runDefinedAgent\\(\\s*['"]${id}['"]`), `${id} is not routed`);
  }
  assert.doesNotMatch(handlers, /runInvestmentAgent|currentWorkflowNodeContext/u);
  assert.match(handlers, /runReviewerGroup\s*\(/, 'draft report does not enter the Week 3 Reviewer Group');
  assert.match(handlers, /report_review_decision\.json/, 'review adjudication is not persisted');
  assert.match(composition, /executeWorkflowWithRemediation\s*\(/, 'production entry point does not use the canonical remediation executor');
  assert.match(composition, /agentRuntime:\s*agentExecutionRuntime/u, 'composition does not inject the canonical Agent runtime');
  assert.match(composition, /observeRunAnalysisAgentBackend\s*\(/u, 'composition does not inject the observed backend');
  assert.match(backendObserver, /withAgentResultObserver\s*\(/u, 'runtime helper does not observe results outside the selected backend');
  assert.match(backendObserver, /withAgentExecutionObserver\s*\(/u, 'runtime helper does not persist Agent execution traces');
  assert.doesNotMatch(composition, /getResearchAgentBackend|withResearchAgentMetrics/u, 'composition retains Research-specific backend ownership');
  assert.doesNotMatch(composition, /options:\s*\{[^}]*agentBackend/su, 'composition leaks backend authority through mutable context options');
  assert.doesNotMatch(composition, /runInvestmentAgent\s*\(|runReviewerGroup\s*\(/u, 'production entry point still owns node behavior');
  assert.doesNotMatch(facade, /runInvestmentAgent|runReviewerGroup|executeWorkflowWithRemediation/u, 'compatibility facade owns runtime behavior');
});
