import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAgentDefinition,
  listRunAnalysisAgentDefinitions,
  RUN_ANALYSIS_AGENT_IDS,
} from '../src/agents/registry.js';
import { buildScorecardPrompt } from '../src/agents/definitions/run-analysis/sharedScorecardPrompt.js';

const expectedIds = [
  'analysis-plan',
  'scan-score',
  'data-orchestrator',
  'data-scoreboard-evaluator',
  'industry-analyst',
  'industry-scoreboard-evaluator',
  'company-analyst',
  'company-scoreboard-evaluator',
  'report-composer',
  'evidence-reviewer',
  'requirement-reviewer',
  'logic-reviewer',
  'conclusion-synthesizer',
];
const reviewerIds = ['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer'];
const scorecardIds = ['data-scoreboard-evaluator', 'industry-scoreboard-evaluator', 'company-scoreboard-evaluator'];
const scorecardReadTools = ['ws_read_file'];
const workspaceReadTools = ['ws_list_files', 'ws_read_file', 'ws_search_library'];
const workspaceReadWriteTools = [...workspaceReadTools, 'ws_write_file', 'ws_append_file', 'ws_edit_file'];

const sorted = (xs) => [...xs].sort();
const expectedDataTools = [
  'pplx_search', 'pplx_finance', 'pplx_ask_page', 'pplx_sec', 'pplx_reasoning', 'pplx_deep_research',
  'tavily_search', 'tavily_extract', 'edgar_filings', 'edgar_fulltext', 'edgar_section',
  'fmp_quote', 'fmp_profile', 'fmp_transcript', 'fmp_income', 'fmp_balance_sheet', 'fmp_cash_flow',
  'fmp_growth', 'fmp_key_metrics', 'fmp_ratios', 'fmp_forward_estimates', 'fmp_estimates', 'fmp_valuation_history',
  'fmp_dcf', 'fmp_price_target', 'fmp_rating', 'fmp_grade_changes', 'fmp_earnings_surprise', 'fmp_earnings_calendar',
  'fmp_revenue_product', 'fmp_revenue_geo', 'fmp_insider', 'fmp_institutional', 'fmp_sec_filings',
  'fmp_shares_float', 'fmp_short_interest', 'fmp_financial_score', 'fmp_enterprise_values',
  'fmp_comps', 'fmp_peers', 'fmp_screener', 'fmp_historical', 'fmp_news', 'fmp_news_search',
  'fred_series', 'fmp_economic', 'fmp_treasury', 'fmp_sector', 'social_sentiment', 'sa_symbol', 'research_digest',
  'ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file',
];

test('Agent Registry freezes the complete Run Analysis LLM node set and excludes other systems', () => {
  assert.deepEqual(sorted(RUN_ANALYSIS_AGENT_IDS), sorted(expectedIds));
  assert.deepEqual(sorted(listRunAnalysisAgentDefinitions().map((definition) => definition.id)), sorted(expectedIds));
  assert.equal(new Set(RUN_ANALYSIS_AGENT_IDS).size, expectedIds.length);
  for (const id of RUN_ANALYSIS_AGENT_IDS) {
    assert.ok(!/(idea|portfolio|belief|attribution|verifier|self)/i.test(id), `${id} is out of runAnalysis scope`);
  }
});

test('every Run Analysis definition is versioned, frozen, prompt-owning, and artifact-authoritative', () => {
  for (const definition of listRunAnalysisAgentDefinitions()) {
    assert.match(definition.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Object.isFrozen(definition));
    assert.ok(['return', 'artifact', 'return+artifact'].includes(definition.artifactAuthority));
    assert.ok(Array.isArray(definition.outputPaths));
    assert.ok(definition.source?.startsWith('runAnalysis:'), `${definition.id} must identify its source`);
    assert.doesNotMatch(definition.prompt.toString(), /legacyPrompt/);
    const promptInput = {};
    const prompt = definition.prompt(promptInput);
    assert.equal(typeof prompt.system, 'string');
    assert.equal(typeof prompt.user, 'string');
    assert.ok(prompt.system.length >= 120, `${definition.id} system prompt is not frozen substantively`);
    assert.ok(prompt.user.length >= 1, `${definition.id} user prompt is missing`);
  }
});

test('registry tool policies exactly freeze current report-chain permissions', () => {
  const expected = {
    'analysis-plan': [],
    'scan-score': [],
    'data-orchestrator': expectedDataTools,
    'data-scoreboard-evaluator': [...scorecardReadTools],
    'industry-analyst': [...workspaceReadWriteTools, 'fmp_sector', 'fmp_comps', 'fred_series', 'pplx_finance', 'pplx_reasoning', 'pplx_sec', 'tavily_search', 'edgar_fulltext'],
    'industry-scoreboard-evaluator': [...scorecardReadTools],
    'company-analyst': [...workspaceReadWriteTools, 'fmp_quote', 'fmp_transcript', 'fmp_comps', 'fmp_valuation_history', 'fmp_forward_estimates', 'edgar_filings', 'pplx_finance', 'pplx_sec'],
    'company-scoreboard-evaluator': [...scorecardReadTools],
    'report-composer': [...workspaceReadWriteTools],
    'conclusion-synthesizer': [...workspaceReadTools],
    'evidence-reviewer': [...workspaceReadTools],
    'requirement-reviewer': [...workspaceReadTools],
    'logic-reviewer': [...workspaceReadTools],
  };
  for (const [id, tools] of Object.entries(expected)) {
    assert.deepEqual(sorted(getAgentDefinition(id).toolPolicy.allow), sorted(tools), `${id} tool policy drifted`);
  }
});

test('reviewers cannot write and only the composer declares report write scope', () => {
  for (const id of [...reviewerIds, ...scorecardIds]) {
    const definition = getAgentDefinition(id);
    assert.deepEqual(definition.toolPolicy.writeScopes, []);
    assert.ok(definition.toolPolicy.allow.every((name) => !/(write|append|edit)/.test(name)));
  }
  assert.deepEqual(getAgentDefinition('report-composer').toolPolicy.writeScopes, ['report/**']);
  assert.deepEqual(getAgentDefinition('conclusion-synthesizer').toolPolicy.writeScopes, []);
});

test('report reviewers retain read-only output and completion policies', () => {
  for (const id of reviewerIds) {
    const definition = getAgentDefinition(id);
    assert.equal(definition.outputSchema, 'reviewResult.v1');
    assert.deepEqual(definition.completionPolicy.hardChecks, ['output-schema']);
    assert.deepEqual(definition.toolPolicy.writeScopes, []);
    assert.doesNotMatch(definition.toolPolicy.allow.join(','), /(write|append|edit)/i);
    assert.match(definition.prompt({}).system, /never (?:edit|rewrite|write)/i);
  }
});

test('scoreboard evaluator definitions are read-only scorecard contracts', () => {
  for (const id of scorecardIds) {
    const definition = getAgentDefinition(id);
    assert.equal(definition.outputSchema, 'scorecard-evaluation.v1');
    assert.deepEqual(definition.toolPolicy.allow, [...scorecardReadTools]);
    assert.deepEqual(definition.toolPolicy.writeScopes, []);
    assert.equal(definition.artifactAuthority, 'return');
    assert.deepEqual(definition.completionPolicy.requiredArtifacts, []);
  }
});

test('scorecard prompts stay bounded and use the immutable workspace closure for evidence', () => {
  const marker = 'INLINE_SCORECARD_PAYLOAD_SHOULD_NOT_BE_DUPLICATED';
  for (const lens of ['data', 'industry', 'company']) {
    const prompt = buildScorecardPrompt(lens, {
      asOf: '2026-08-14T06:50:52.048Z',
      projectId: 'project-1',
      candidateRef: { path: 'report/report.md', contentDigest: `sha256:${'a'.repeat(64)}` },
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      dependencyRefs: {
        data: [{ path: 'data/data_report.md' }],
        industry: [{ path: 'analysis/industry.json' }],
        company: [{ path: 'analysis/company.json' }],
      },
      materialIndustries: [{ industryId: 'software', classification: 'material', materialityWeightBps: 10000 }],
      authoritativeTickers: ['AAA'],
      draftReport: `${marker}${'x'.repeat(200_000)}`,
      evidenceBundle: { marker, payload: 'x'.repeat(200_000) },
    });

    assert.ok(prompt.user.length < 20_000, `${lens} scorecard request prompt grew to ${prompt.user.length} characters`);
    assert.equal(prompt.user.includes(marker), false);
    assert.match(prompt.user, /read-only workspace tools to inspect the exact Candidate ref and Dependency refs/u);
    assert.match(prompt.system, /use only (?:the minimal read-only tool )?ws_read_file/iu);
    assert.match(prompt.system, /exact immutable closure/u);
    assert.match(prompt.system, /Every rawSourceChecks status MUST be exactly one of supported, contradicted, inconclusive, or not-checked/u);
    assert.match(prompt.system, /Every decisiveEvidence item and every evidenceRefs item MUST be one single bare exact path string/u);
    assert.match(prompt.system, /no colon, line range, section text, anchor, query, prose, URI, or appended location/u);
    assert.match(prompt.system, /Put location or context only in whyNotHigher or rawSourceChecks\.location\/notes/u);
    assert.match(prompt.user, /Scope projectId \(Data unitId MUST equal this exact value\)/u);
    if (lens === 'data') assert.match(prompt.system, /unitId MUST equal scope\.projectId exactly, character-for-character/u);
    if (lens === 'industry') assert.match(prompt.system, /unitId MUST equal exactly one supplied materialIndustries\[\]\.industryId/u);
    if (lens === 'company') assert.match(prompt.system, /unitId MUST equal exactly one supplied authoritativeTickers entry/u);
    assert.match(prompt.user, /Exact immutable closure paths/u);
    assert.match(prompt.user, /Candidate: report\/report\.md/u);
    assert.match(prompt.user, /Dependency \(data\): data\/data_report\.md/u);
    assert.match(prompt.user, /Dependency \(industry\): analysis\/industry\.json/u);
    assert.match(prompt.user, /Dependency \(company\): analysis\/company\.json/u);
    assert.match(prompt.user, /offset 0.*nextOffset/isu);
    assert.match(prompt.user, /read only these|read every exact .* path/iu);
    assert.doesNotMatch(prompt.user, /ws_list_files|ws_search_library/u);
    assert.match(prompt.user, /complete bound artifact scope before scoring/u);
  }
});


test('Run Analysis prompts retain the investment behavior anchors', () => {
  const industry = getAgentDefinition('industry-analyst').prompt({}).system;
  const company = getAgentDefinition('company-analyst').prompt({}).system;
  assert.match(industry, /key external drivers/i);
  assert.match(industry, /valuationExpectationMatrix/);
  assert.match(industry, /evidenceGaps/);
  assert.match(company, /valuation/i);
  assert.match(company, /orderSwitching/);
  assert.match(company, /impliedExpectations/);
  assert.match(company, /verdict/);
  assert.match(getAgentDefinition('report-composer').prompt({}).system, /demand\/supply\/value-chain ownership/i);
  assert.match(getAgentDefinition('conclusion-synthesizer').prompt({}).system, /expected return.*odds/i);
});

test('registry preserves stable demo-visible user prompt prefixes used in event payloads', () => {
  const plan = getAgentDefinition('analysis-plan').prompt({ theme: 'AI infrastructure', rationale: 'Capex check' });
  assert.equal(plan.user, '主题：AI infrastructure\n说明：Capex check');
});

test('direct JSON nodes are distinguished from tool-loop agents', () => {
  const jsonNodes = ['analysis-plan', 'scan-score', 'numeric-fidelity-reviewer'];
  for (const id of RUN_ANALYSIS_AGENT_IDS) {
    assert.equal(getAgentDefinition(id).executionMode, jsonNodes.includes(id) ? 'json' : 'tool-loop', `${id} execution mode drifted`);
  }
});

test('non-Run Analysis definitions remain outside the formal Run Analysis set', () => {
  assert.equal(RUN_ANALYSIS_AGENT_IDS.includes('idea-generator'), false);
  assert.equal(listRunAnalysisAgentDefinitions().includes(getAgentDefinition('idea-generator')), false);
});
