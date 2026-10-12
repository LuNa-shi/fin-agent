import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REVIEWERS = new Set(['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer']);
const MATERIAL_EVIDENCE_RE = /\b(?:valuation|price|revenue|sales|growth|margin|profit|earnings|eps|ebitda|cash flow|capex|demand|supply|backlog|market share|cost|risk)\b/iu;

function canonicalPassingReport(citationLedger) {
  const evidence = (citationLedger?.evidenceItems || []).find((item) => MATERIAL_EVIDENCE_RE.test(item.statement || ''));
  assert.ok(evidence?.evidenceId, 'selective-remediation fixture requires material atomic evidence');
  const statement = String(evidence.statement || '')
    .replace(/\s+/gu, ' ')
    .replace(/\[|\]/gu, '')
    .replace(/\|/gu, '/');
  const marker = `[src: ${evidence.evidenceId}]`;
  return {
    evidenceId: evidence.evidenceId,
    markdown: `# Selective remediation fixture report

## Investment thesis
The canonical atomic record states: ${statement} ${marker}

## Industry Analysis
The fixture intentionally introduces no additional factual assertion in this section.

## Company analysis
The fixture intentionally introduces no additional factual assertion in this section.

## Demand / supply / value chain
Ownership mapping is intentionally withheld until additional atomic records are available.

## Valuation
Quantitative modeling is intentionally withheld in this routing fixture.

## Risks and invalidation
Failure conditions are not asserted beyond the cited atomic record.

## Reflection / open questions / summary
The evidence boundary is explicit and no unsupported conclusion is added.`,
  };
}

function scriptedReportResult(request, { createAgentRunResult, ProjectFS, traceSuffix }) {
  const citationLedger = JSON.parse(ProjectFS.fileContent(request.projectId, 'data/citation_ledger.json') || 'null');
  const report = canonicalPassingReport(citationLedger);
  return createAgentRunResult({
    status: 'succeeded',
    output: report.markdown,
    text: report.markdown,
    artifacts: [],
    evidenceRefs: [report.evidenceId],
    openQuestions: [],
    dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 },
    stopReason: 'final',
    traceRef: `${request.runId}:${traceSuffix}`,
    live: false,
    valid: true,
  });
}

function projectJson(ProjectFS, projectId, relPath) {
  return JSON.parse(ProjectFS.fileContent(projectId, relPath) || 'null');
}

function reviewOutput(request, { owner = null } = {}) {
  const reviewerType = request.agentContractId === 'requirement-reviewer'
    ? 'requirements'
    : request.agentContractId.replace('-reviewer', '');
  const issue = owner && request.agentContractId === 'logic-reviewer'
    ? [{
      id: `${owner}-blocking`,
      severity: 'critical',
      owner,
      message: `${owner} remediation required`,
      location: 'Valuation',
      claim: 'The draft requires selective remediation.',
      evidenceRefs: ['evidence://selective-remediation'],
      remediation: `Repair only the ${owner} owner branch.`,
    }]
    : [];
  return {
    schemaVersion: '1.0.0',
    asOf: request.asOf,
    producer: request.agentContractId,
    contractVersion: request.contractVersion,
    inputDigest: request.input.inputDigest,
    createdAt: request.asOf,
    evidenceRefs: [],
    reviewerType,
    score: issue.length ? 0.4 : 0.95,
    issues: issue,
    verdict: issue.length ? 'remediate' : 'pass',
  };
}

for (const owner of ['data', 'industry', 'company', 'report']) {
  test(`production Run Analysis selectively remediates owner=${owner}`, { timeout: 30000 }, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `finagent-selective-${owner}-`));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    process.env.DEMO_MODE = 'true';
    process.env.AUTO_RESUME = 'false';
    process.env.FIN_DATA_DIR = dataDir;

    const { createAgentRunResult } = await import('../src/core/contracts/agentContracts.js');
    const { PiAgentBackend } = await import('../src/core/agent-backend/PiAgentBackend.js');
    const { getAgentDefinition } = await import('../src/agents/registry.js');
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');

    const pi = new PiAgentBackend({ contractResolver: getAgentDefinition, usageRecorder: null });
    const calls = new Map();
    const requestInputs = new Map();
    const agentBackend = {
      async run(request, runtime) {
        calls.set(request.agentContractId, (calls.get(request.agentContractId) || 0) + 1);
        requestInputs.set(request.agentContractId, [
          ...(requestInputs.get(request.agentContractId) || []),
          structuredClone(request.input),
        ]);
        if (request.agentContractId === 'report-composer') {
          return scriptedReportResult(request, {
            createAgentRunResult,
            ProjectFS,
            traceSuffix: 'canonical-report',
          });
        }
        if (!REVIEWERS.has(request.agentContractId)) return pi.run(request, { ...runtime, demo: true, live: false });
        const cycle = request.input.cycle || 0;
        const output = reviewOutput(request, { owner: cycle === 0 ? owner : null });
        return createAgentRunResult({
          status: 'succeeded',
          output,
          artifacts: [],
          evidenceRefs: [],
          openQuestions: [],
          dataRequests: [],
          metrics: { turns: 1, toolCalls: 0 },
          stopReason: 'final',
          traceRef: `${request.runId}:scripted-review`,
        });
      },
    };

    const project = ProjectFS.create({
      title: `Selective remediation ${owner}`,
      theme: 'AI infrastructure',
      rationale: `Verify ${owner} selective remediation.`,
      tickers: ['NVDA'],
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
      companyLocale: 'global',
    });
    t.after(() => ProjectFS.delete(project.id));

    const analyzed = await runAnalysisWorkflow(project.id, {
      intensity: 'quick',
      resume: false,
      agentBackend,
    });
    assert.equal(analyzed.status, 'analyzed');
    const checkpoint = ProjectFS.checkpoint(project.id);
    assert.equal(checkpoint.reportReview.decision.route, 'publish');
    assert.deepEqual(checkpoint.reportReviewHistory.map((entry) => entry.decision.cycle), [0, 1]);
    assert.equal(checkpoint.rounds.at(-1).dataRound, owner === 'data' ? 2 : 1);
    assert.equal(ProjectFS.fileContent(project.id, 'analysis/reviews/evidence_r1.json') !== null, true);
    assert.equal(ProjectFS.fileContent(project.id, 'analysis/reviews/evidence_r2.json') !== null, true);
    for (const reviewRound of [1, 2]) {
      const qualityAudit = projectJson(ProjectFS, project.id, `analysis/reviews/report_quality_r${reviewRound}.json`);
      assert.equal(qualityAudit.passed, true, `report quality round ${reviewRound}`);
      assert.equal(qualityAudit.claims.citationCoverage, 1, `citation coverage round ${reviewRound}`);
      assert.equal(qualityAudit.claims.traceabilityCoverage, 1, `traceability round ${reviewRound}`);
    }
    if (owner === 'company') {
      const lastCompanyInput = requestInputs.get('company-analyst').at(-1);
      assert.ok(lastCompanyInput.files.includes('data/evidence_bundle_r1.json'));
      assert.ok(lastCompanyInput.files.includes('data/source_documents_r1.json'));
      assert.equal(lastCompanyInput.files.some((file) => file.includes('_r2.json')), false);
    }

    const expectedResearchCalls = {
      'data-orchestrator': 1 + (owner === 'data' ? 1 : 0),
      'industry-analyst': 1 + (owner === 'industry' ? 1 : 0),
      'company-analyst': 1 + (owner === 'company' ? 1 : 0),
    };
    for (const [contractId, expected] of Object.entries(expectedResearchCalls)) {
      assert.equal(calls.get(contractId), expected, `${contractId} call count`);
    }
    assert.equal(calls.get('report-composer'), 2);
    assert.equal(calls.get('conclusion-synthesizer'), 1);
    for (const reviewer of REVIEWERS) assert.equal(calls.get(reviewer), 2);

    const run = ProjectFS.runStore(project.id).load(checkpoint.artifactRunId);
    assert.equal(run.remediationHistory.length, 1);
    assert.deepEqual(run.remediationHistory[0].owners, [owner]);
    assert.equal(run.nodes['plan-research'].attempt, 1);
    assert.equal(run.nodes['run-research-rounds'].attempt, owner === 'report' ? 1 : 2);
  });
}

test('production Run Analysis publishes after automatic remediation is exhausted', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-human-review-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  process.env.DEMO_MODE = 'true';
  process.env.AUTO_RESUME = 'false';
  process.env.FIN_DATA_DIR = dataDir;

  const { createAgentRunResult } = await import('../src/core/contracts/agentContracts.js');
  const { PiAgentBackend } = await import('../src/core/agent-backend/PiAgentBackend.js');
  const { getAgentDefinition } = await import('../src/agents/registry.js');
  const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
  const { RUN_STATUSES } = await import('../src/project-space/RunStore.js');
  const { NODE_STATES } = await import('../src/core/workflow/NodeState.js');
  const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');

  const pi = new PiAgentBackend({ contractResolver: getAgentDefinition, usageRecorder: null });
  const calls = new Map();
  const agentBackend = {
    async run(request, runtime) {
      calls.set(request.agentContractId, (calls.get(request.agentContractId) || 0) + 1);
      if (request.agentContractId === 'report-composer') {
        return scriptedReportResult(request, {
          createAgentRunResult,
          ProjectFS,
          traceSuffix: 'canonical-human-review-report',
        });
      }
      if (!REVIEWERS.has(request.agentContractId)) return pi.run(request, { ...runtime, demo: true, live: false });
      const output = reviewOutput(request, { owner: 'report' });
      return createAgentRunResult({
        status: 'succeeded', output, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
        metrics: { turns: 1, toolCalls: 0 }, stopReason: 'final', traceRef: `${request.runId}:human-review`,
      });
    },
  };

  const project = ProjectFS.create({
    title: 'Automatic publish after review exhaustion',
    theme: 'AI infrastructure',
    rationale: 'Keep a blocking report issue open.',
    tickers: ['NVDA'],
    intensity: 'quick',
    analysisLanguage: 'en',
    reportLanguage: 'en',
    companyLocale: 'global',
  });
  t.after(() => ProjectFS.delete(project.id));

  const result = await runAnalysisWorkflow(project.id, {
    intensity: 'quick',
    resume: false,
    agentBackend,
  });
  assert.equal(result.status, 'analyzed');
  assert.ok(result.conclusion);
  assert.equal(calls.get('conclusion-synthesizer'), 1);
  const checkpoint = ProjectFS.checkpoint(project.id);
  assert.equal(checkpoint.done, true);
  assert.equal(checkpoint.humanReviewBypassed.route, 'human-review');
  assert.equal(checkpoint.humanReviewBypassed.cycle, 2);
  assert.deepEqual(checkpoint.reportReviewHistory.map((entry) => entry.decision.cycle), [0, 1, 2]);
  assert.equal(checkpoint.reportReview.decision.route, 'human-review');
  assert.deepEqual(checkpoint.openIssues, []);
  assert.equal(ProjectFS.fileContent(project.id, 'analysis/reviews/logic_r3.json') !== null, true);
  assert.equal(ProjectFS.report(project.id).includes('# Selective remediation fixture report'), true);
  for (const reviewRound of [1, 2, 3]) {
    const qualityAudit = projectJson(ProjectFS, project.id, `analysis/reviews/report_quality_r${reviewRound}.json`);
    assert.equal(qualityAudit.passed, true, `report quality round ${reviewRound}`);
  }

  const run = ProjectFS.runStore(project.id).load(checkpoint.artifactRunId);
  assert.equal(run.status, RUN_STATUSES.SUCCEEDED);
  assert.equal(run.nodes['synthesize-conclusion'].status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes['finalize-project'].status, NODE_STATES.SUCCEEDED);
  assert.deepEqual(run.openIssues, []);
  assert.equal(ProjectFS.activeRun(project.id), null);
});
