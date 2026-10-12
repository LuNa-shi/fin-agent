import assert from 'node:assert/strict';
import test from 'node:test';

import { agentExecutionRuntime } from '../src/agents/AgentExecutionRuntime.js';
import {
  createWorkflowNodeExecutionContext,
  runWithWorkflowNodeContext,
} from '../src/core/workflow/WorkflowRunContext.js';
import { acquireData } from '../src/workflows/run-analysis/research/dataAgent.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../src/workflows/run-analysis/workflowSpec.js';

const AS_OF = '2026-06-30T20:00:00.000Z';

function dataWorkflowContext(backend) {
  const node = RUN_ANALYSIS_WORKFLOW_SPEC.nodes
    .find((candidate) => candidate.id === 'run-research-rounds');
  const record = { nodeId: node.id, attempt: 1 };
  const run = {
    runId: 'frozen-data-seam-run',
    projectId: 'project-frozen-data-seam',
    asOf: AS_OF,
    workflowSpec: {
      id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
      hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    },
    nodes: { [node.id]: record },
  };
  return createWorkflowNodeExecutionContext({
    spec: RUN_ANALYSIS_WORKFLOW_SPEC,
    run,
    node,
    record,
    workspaceSnapshotId: 'frozen-data-seam:snapshot',
    agentRuntime: agentExecutionRuntime,
    agentBackend: backend,
  });
}

function frozenData() {
  return {
    quotes: [{ symbol: 'ACME', price: 42, changesPercentage: 1.2, timestamp: Date.parse(AS_OF) / 1000 }],
    fundamentals: {
      ACME: {
        pe: 18,
        revenueGrowth: 0.12,
        roe: 0.2,
        fcfPerShare: 3,
        fwdPE1: 16,
        nextEarnings: { date: '2026-07-20' },
      },
    },
    transcripts: [{ symbol: 'ACME', quarter: 1, year: 2026, date: AS_OF, excerpt: 'Revenue grew 12%. Free cash flow improved.' }],
    research: {
      finance: { answer: 'ACME trades at 16 times frozen forward earnings.', citations: ['frozen-snapshot://finance'] },
      competitive: { answer: 'A larger peer competes on price.', citations: ['frozen-snapshot://competitive'] },
      drivers: { answer: 'Revenue growth and cash conversion are the decisive variables.', sources: ['frozen-snapshot://drivers'] },
      news: [],
      opinions: [],
    },
    industry: {
      sectors: ['Test sector +1%'],
      peers: ['PEER1', 'PEER2'],
      comps: [
        { ticker: 'ACME', isTarget: true, pe: 18, fwdPE1: 16, revenueGrowth: 0.12 },
        { ticker: 'PEER1', pe: 20, fwdPE1: 18, revenueGrowth: 0.1 },
        { ticker: 'PEER2', pe: 15, fwdPE1: 14, revenueGrowth: 0.08 },
      ],
    },
    detail: {
      ACME: {
        gradeBias: 'neutral',
        topHolders: ['Long-only funds'],
        revenueSegments: { Subscription: 4_000_000_000 },
        piotroski: 7,
        altmanZ: 5,
        sec: { latestReport: '2026 Q1 filing', events: 'None', riskExcerpt: 'Customer concentration is material.' },
      },
    },
    highFreq: [],
  };
}

test('frozenData bypasses provider acquisition while retaining Planner, Evidence Collector, Agent organization, and Auditor', async () => {
  const requests = [];
  const backend = {
    async run(request, runtime) {
      requests.push({ request, runtime });
      return {
        status: 'succeeded',
        output: {
          organized: [],
          sourceQuality: [],
          contradictions: [],
          gaps: [],
          nextDataFocus: { questions: [], tickers: [], tools: [] },
          competitorDossier: { competitors: [], items: [] },
        },
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: { turns: 1, toolCalls: 0 },
        steps: 1,
        toolCallsMade: 0,
        stopReason: 'final',
        live: false,
        valid: true,
        trace: { toolCalls: [] },
      };
    },
  };
  const result = await runWithWorkflowNodeContext(dataWorkflowContext(backend), () => acquireData({
    id: null,
    tickers: ['ACME'],
    theme: 'Frozen evidence seam',
    brief: 'Use only frozen point-in-time evidence.',
    guideline: 'Preserve evidence identifiers.',
    cfg: {
      fundamentals: true,
      transcript: true,
      research: true,
      depth: { data: 2, dataMin: 1 },
    },
    round: 1,
    asOf: AS_OF,
    frozenData: frozenData(),
  }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.agentContractId, 'data-orchestrator');
  assert.equal(requests[0].runtime.toolCallBudget, 0);
  assert.equal(result.quotes[0].price, 42);
  assert.ok(result.sourceDocuments.length > 0);
  assert.ok(result.sourceDocuments.every((document) => document.metadata.sourceMode === 'frozen-snapshot-replay'));
  assert.equal(result.evidenceBundle.asOf, AS_OF);
  assert.match(result.dataReport, /Evidence mode: frozen-snapshot-replay/u);
});

test('frozenData fails closed when the provider-shaped tuple is incomplete', async () => {
  await assert.rejects(acquireData({
    id: null,
    tickers: ['ACME'],
    theme: 'Invalid frozen evidence',
    guideline: '',
    cfg: { fundamentals: false, transcript: false, research: false, depth: { data: 1, dataMin: 1 } },
    round: 1,
    asOf: AS_OF,
    frozenData: { quotes: [] },
  }), /frozenData is missing fields/u);
});

test('data acquisition requires an explicit canonical asOf instead of ambient Workflow time', async () => {
  await assert.rejects(acquireData({
    id: null,
    tickers: ['ACME'],
    theme: 'Missing as-of',
    guideline: '',
    cfg: { fundamentals: false, transcript: false, research: false, depth: { data: 1, dataMin: 1 } },
    round: 1,
    frozenData: frozenData(),
  }), /acquireData asOf must be an ISO timestamp/u);
});
