import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentDefinition } from '../src/agents/registry.js';
import { PiAgentBackend } from '../src/core/agent-backend/PiAgentBackend.js';
import { OutputGate, validateJsonSchema } from '../src/core/validation/OutputGate.js';
import { getResearchSchema } from '../src/domains/research/contracts/schemaRegistry.js';
import { adjudicateReviews } from '../src/workflows/run-analysis/reviewers/adjudicator.js';
import {
  companyAssumptionConflictIssues,
  projectDataOrchestratorOutput,
  projectCompanyAnalysisOutput,
  projectIndustryAnalysisOutput,
  projectReviewResultOutput,
} from '../src/domains/research/contracts/outputProjections.js';

const asOf = '2026-07-16T00:00:00.000Z';

function requestFor(agentContractId, input = {}) {
  return {
    runId: `run:${agentContractId}`,
    workflowId: 'run-analysis.v1',
    nodeId: 'run-research-rounds',
    projectId: 'project-1',
    agentContractId,
    contractVersion: '1.0.0',
    asOf,
    input,
    inputArtifactRefs: [],
    workspaceSnapshotId: 'project-1:snapshot',
    idempotencyKey: `idem:${agentContractId}`,
  };
}

const rawIndustry = {
  marketSize: '$100B',
  industryMainline: 'Capacity normalizes while inference demand broadens.',
  keyExternalDrivers: 'Inference utilization and power availability.',
  demandSupplyMap: 'Cloud buyers -> accelerators -> power and cooling.',
  drivers: [{ driver: 'inference utilization', direction: 'accelerating', evidence: '[src: fixture]' }],
  competition: 'Platform vendors compete on delivered inference cost.',
  valuationExpectationMatrix: 'Current multiples imply durable 20% growth.',
  evidenceGaps: ['Independent utilization series'],
  variantPerception: 'Consensus underweights utilization sensitivity.',
  structuralView: 'Delivered inference cost determines profit-pool capture.',
  evidenceRefs: ['fixture:industry'],
};

const rawCompany = {
  ticker: 'nvda',
  positioning: 'Platform leader with high ecosystem switching costs.',
  growth: 'Growth depends on inference utilization and supply conversion.',
  quality: 'High margins with working-capital sensitivity.',
  valuation: '35x forward earnings',
  impliedExpectations: 'Sustained 20%+ growth.',
  customerMap: 'Hyperscalers and enterprise inference buyers.',
  orderSwitching: 'Custom accelerators are the primary substitution risk.',
  moatThreat: 'Customer silicon and software portability.',
  management: 'Execution remains strong.',
  marketPerformance: 'Outperformed semiconductors.',
  evidenceGaps: ['Customer-level inference mix'],
  catalysts: ['Inference revenue disclosure'],
  risks: ['Gross margin falls below 70%'],
  driverBridge: [{
    driver: 'inference utilization',
    companyExposure: 'positive',
    mechanism: 'Higher utilization increases accelerator and networking demand.',
    kpis: ['data-center revenue'],
    lineItems: ['revenue', 'gross profit'],
    valuationImpact: 'Supports the growth duration embedded in the multiple.',
    evidence: ['fixture:industry', 'fixture:company'],
    confidence: 0.8,
  }],
  assumptionConflicts: [{
    message: 'Industry supply normalization conflicts with the company margin assumption.',
    industryAssumption: 'Supply normalizes.',
    companyAssumption: 'Scarcity pricing persists.',
    evidenceRefs: ['fixture:industry'],
  }],
  verdict: 'Attractive only if inference utilization offsets supply normalization.',
  conviction: 0.7,
  evidenceRefs: ['fixture:company'],
};

const rawData = {
  organized: [{ dimension: 'valuation', points: [{ fact: 'ACME fwdPE is 20x', source: 'FMP', ticker: 'ACME' }] }],
  sourceQuality: [{ source: 'FMP', quality: 'high' }],
  contradictions: [],
  gaps: ['Independent demand data'],
  nextDataFocus: { questions: ['Validate demand'], tickers: ['acme'], tools: ['edgar_filings'] },
  competitorDossier: { competitors: ['PeerCo'], items: [{ name: 'PeerCo' }] },
};

test('Data projection adds provenance and a central schema while preserving expert output shape', () => {
  const request = requestFor('data-orchestrator', { theme: 'AI infrastructure' });
  const output = projectDataOrchestratorOutput(rawData, { request });
  assert.equal(output.producer, 'data-orchestrator');
  assert.deepEqual(output.nextDataFocus.tickers, ['ACME']);
  assert.deepEqual(output.organized[0].points, rawData.organized[0].points);
  assert.deepEqual(validateJsonSchema(output, getResearchSchema('data-orchestrator.output.v1')), []);
});

test('Data projection preserves structured gap meaning instead of stringifying objects opaquely', () => {
  const request = requestFor('data-orchestrator', { theme: 'AI infrastructure' });
  const output = projectDataOrchestratorOutput({
    ...rawData,
    gaps: [{ message: 'Missing filing-level capex bridge', owner: 'data' }],
    nextDataFocus: { questions: [{ question: 'Pull capex and D&A by period' }], tickers: ['acme'], tools: ['edgar_filings'] },
    competitorDossier: { competitors: [{ name: 'PeerCo', ticker: 'PEER' }], items: [] },
  }, { request });
  assert.deepEqual(output.gaps, ['Missing filing-level capex bridge']);
  assert.deepEqual(output.nextDataFocus.questions, ['Pull capex and D&A by period']);
  assert.deepEqual(output.competitorDossier.competitors, ['PeerCo']);
});

test('Industry projection creates a provenance-complete canonical schema without changing expert prompt assets', () => {
  const request = requestFor('industry-analyst', { theme: 'AI infrastructure' });
  const output = projectIndustryAnalysisOutput(rawIndustry, { request });
  assert.equal(output.producer, 'industry-analyst');
  assert.match(output.inputDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(output.industryDrivers, rawIndustry.drivers);
  assert.deepEqual(output.openQuestions, rawIndustry.evidenceGaps);
  assert.deepEqual(validateJsonSchema(output, getResearchSchema('industryAnalysis.v1')), []);
});

test('Company projection makes DriverBridge and assumptionConflicts schema-mandatory', () => {
  const request = requestFor('company-analyst', { ticker: 'NVDA' });
  const output = projectCompanyAnalysisOutput(rawCompany, { request });
  assert.equal(output.ticker, 'NVDA');
  assert.equal(output.driverBridge[0].industryDriverId, 'inference utilization');
  assert.deepEqual(output.driverBridge[0].companyKpis, ['data-center revenue']);
  assert.equal(output.assumptionConflicts[0].severity, 'critical');
  assert.deepEqual(validateJsonSchema(output, getResearchSchema('companyAnalysis.v1')), []);
});

test('Company projection preserves structured invalidation meaning without opaque object coercion', () => {
  const request = requestFor('company-analyst', { ticker: 'NVDA' });
  const output = projectCompanyAnalysisOutput({
    ...rawCompany,
    invalidation: [{
      metric: 'grossMargin',
      operator: '<',
      threshold: 0.7,
      periods: 2,
      rationale: 'Sustained margin pressure would invalidate operating leverage.',
    }],
  }, { request });

  assert.deepEqual(output.invalidation, [
    '{"metric":"grossMargin","operator":"<","threshold":0.7,"periods":2,"rationale":"Sustained margin pressure would invalidate operating leverage."}',
  ]);
  assert.equal(output.invalidation.includes('[object Object]'), false);
  assert.deepEqual(validateJsonSchema(output, getResearchSchema('companyAnalysis.v1')), []);
});

test('Company assumption conflicts deterministically become company-owned ReviewIssues', () => {
  const company = projectCompanyAnalysisOutput(rawCompany, { request: requestFor('company-analyst', { ticker: 'NVDA' }) });
  assert.deepEqual(companyAssumptionConflictIssues([company]), [{
    id: 'NVDA-assumption-conflict-1',
    severity: 'critical',
    owner: 'company',
    location: 'analysis/company.json:NVDA',
    message: 'Industry supply normalization conflicts with the company margin assumption.',
    evidenceRefs: ['fixture:industry'],
    remediation: 'Resolve the Industry/Company assumption conflict for NVDA and update DriverBridge evidence.',
  }]);
});

test('Review projection owns provenance and normalizes model-authored compatibility metadata', () => {
  const request = requestFor('evidence-reviewer', {
    reviewerType: 'evidence',
    draftReport: '# Report',
  });
  const contract = getAgentDefinition('evidence-reviewer');
  const output = projectReviewResultOutput({
    schemaVersion: 'reviewResult.v1',
    producer: 'independent-evidence-reviewer',
    contractVersion: 'reviewResult.v1',
    reviewerType: 'evidence',
    score: 0.4,
    verdict: 'remediate',
    evidenceRefs: ['fixture:evidence'],
    issues: [{
      id: 'EVID-1', severity: 'warning', owner: 'report', message: 'Citation is incomplete.',
      evidenceRefs: ['fixture:evidence'], remediation: 'Attach the primary source.',
    }],
  }, { request, contract });

  assert.equal(output.schemaVersion, '1.0.0');
  assert.equal(output.producer, 'evidence-reviewer');
  assert.equal(output.contractVersion, '1.0.0');
  assert.equal(output.reviewerType, 'evidence');
  assert.deepEqual(output.issues[0], {
    id: 'EVID-1',
    severity: 'warning',
    owner: 'report',
    message: 'Citation is incomplete.',
    remediation: 'Attach the primary source.',
    evidenceRefs: ['fixture:evidence'],
  });
  assert.deepEqual(validateJsonSchema(output, getResearchSchema('reviewResult.v1')), []);
});

test('Review projection cannot turn malformed model output into a passing review', () => {
  const request = requestFor('logic-reviewer', { reviewerType: 'evidence', draftReport: '# Report' });
  const output = projectReviewResultOutput({}, {
    request,
    contract: getAgentDefinition('logic-reviewer'),
  });
  assert.equal(output.reviewerType, 'logic');
  assert.equal(output.score, undefined);
  assert.equal(output.verdict, undefined);
  assert.notDeepEqual(validateJsonSchema(output, getResearchSchema('reviewResult.v1')), []);
});

test('Review projection keeps human review only for critical findings and normalizes lesser severities', () => {
  const request = requestFor('evidence-reviewer', { inputDigest: 'sha256:draft' });
  const contract = getAgentDefinition('evidence-reviewer');
  const projected = (issues) => projectReviewResultOutput({
    score: 0.7,
    verdict: 'human-review',
    issues,
  }, { request, contract });
  const finding = (severity, owner = 'report') => ({
    id: `${severity}-finding`,
    severity,
    owner,
    message: `${severity} finding`,
    remediation: `Resolve the ${severity} finding.`,
  });

  assert.equal(projected([finding('critical')]).verdict, 'human-review');
  assert.equal(projected([finding('warning')]).verdict, 'remediate');
  assert.equal(projected([finding('info', 'system')]).verdict, 'pass');
  assert.equal(projected([]).verdict, 'pass');
});

test('Review projection preserves the reviewed package digest and canonical identities for all three smoke-shaped outputs', () => {
  const inputDigest = 'sha256:9f4f6bc460c2c822c17f79b4646434ff58aa072ae8a2b059d1fe8935b9d7e26d';
  const cases = [
    ['evidence-reviewer', 'evidence', 'reviewResult.v1', 'independent-evidence-reviewer'],
    ['requirement-reviewer', 'requirements', 'reviewResult.v1', 'requirements-reviewer'],
    ['logic-reviewer', 'logic', '1.0.0', 'independent-logic-reviewer'],
  ];
  const reviewerResults = cases.map(([contractId, reviewerType, schemaVersion, producer]) => {
    const request = requestFor(contractId, {
      inputDigest,
      reviewerType,
      draftReport: '# Report',
      cycle: 0,
    });
    const output = projectReviewResultOutput({
      schemaVersion,
      producer,
      contractVersion: 'reviewResult.v1',
      reviewerType,
      score: 0.8,
      verdict: 'pass',
      evidenceRefs: ['fixture:evidence'],
      issues: [],
    }, { request, contract: getAgentDefinition(contractId) });
    assert.equal(output.inputDigest, inputDigest);
    assert.equal(output.producer, contractId);
    assert.equal(output.reviewerType, reviewerType);
    assert.deepEqual(validateJsonSchema(output, getResearchSchema('reviewResult.v1')), []);
    return {
      contractId,
      expectedReviewerType: reviewerType,
      output,
      status: 'succeeded',
      stopReason: 'final',
      valid: true,
      errors: [],
      budgetExhausted: false,
    };
  });

  const decision = adjudicateReviews({
    reviews: reviewerResults,
    deterministicIssues: [],
    cycle: 0,
    asOf,
    inputDigest,
  });
  assert.equal(decision.route, 'publish');
  assert.equal(decision.converged, true);
  assert.ok(decision.openIssues.every((issue) => !issue.id.startsWith('invalid-')));
});

test('Review projection leaves malformed verdict/score schema-invalid and rejects unknown contract identities', () => {
  const contract = getAgentDefinition('evidence-reviewer');
  const request = requestFor('evidence-reviewer', { inputDigest: 'sha256:draft' });
  for (const raw of [
    'not-json',
    {},
    { score: 0.5, issues: [], evidenceRefs: [] },
    { verdict: 'pass', issues: [], evidenceRefs: [] },
    { score: 2, verdict: 'pass', issues: [], evidenceRefs: [] },
  ]) {
    const output = projectReviewResultOutput(raw, { request, contract });
    assert.notDeepEqual(validateJsonSchema(output, getResearchSchema('reviewResult.v1')), []);
  }
  assert.throws(() => projectReviewResultOutput({ score: 1, verdict: 'pass', issues: [] }, {
    request,
    contract: { ...contract, id: 'style-reviewer' },
  }), /Unsupported ReviewResult producer/u);
});

class ScriptedAgent {
  constructor(options, output) {
    this.output = output;
    this.state = { ...options.initialState, messages: [] };
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt() {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify(this.output) }],
      stopReason: 'stop',
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      timestamp: 0,
    };
    this.state.messages.push(message);
    for (const listener of this.listeners) await listener({ type: 'turn_end', message, toolResults: [] });
  }

  abort() {}
}

const modelRouter = {
  resolve: () => ({
    model: { id: 'fixture', provider: 'fixture', api: 'fixture', cost: { input: 0, output: 0 } },
    provider: 'fixture', modelId: 'fixture', reasoningLevel: 'standard', attemptedProviders: ['fixture'], fallbackFrom: null,
    streamFn: () => {},
  }),
};

test('Pi applies the canonical CompanyAnalysis projection before OutputGate', async () => {
  const actual = getAgentDefinition('company-analyst');
  const contract = {
    ...actual,
    completionPolicy: { ...actual.completionPolicy, requiredArtifacts: [] },
  };
  const resolve = () => contract;
  const request = requestFor('company-analyst', { ticker: 'NVDA' });
  const pi = new PiAgentBackend({
    contractResolver: resolve,
    modelRouter,
    outputGate: new OutputGate({ schemaResolver: getResearchSchema }),
    agentFactory: (options) => new ScriptedAgent(options, rawCompany),
  });
  const piResult = await pi.run(request, { live: false });
  assert.equal(piResult.status, 'succeeded');
  assert.deepEqual(piResult.output, projectCompanyAnalysisOutput(rawCompany, { request, contract }));
  assert.deepEqual(validateJsonSchema(piResult.output, getResearchSchema('companyAnalysis.v1')), []);
});
