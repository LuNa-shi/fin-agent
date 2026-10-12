// Characterization inputs for investment-expert-owned Agent assets.
//
// These values are deliberately synthetic and deterministic. They exist only to
// render every existing System Prompt branch and freeze the effective Tool Use
// before structural cleanup moves either asset to a new definition file.

export const RESEARCH_AGENT_ASSET_CASES = Object.freeze([
  Object.freeze({
    agentId: 'analysis-plan',
    caseId: 'with-core-ticker',
    input: Object.freeze({
      tickers: Object.freeze(['AAPL']),
      templatePrompt: 'Fixture industry and company template guidance.',
    }),
  }),
  Object.freeze({
    agentId: 'analysis-plan',
    caseId: 'without-core-ticker',
    input: Object.freeze({ templatePrompt: 'Fixture generic template guidance.' }),
  }),
  Object.freeze({
    agentId: 'scan-score',
    caseId: 'default',
    input: Object.freeze({ scanPrompt: 'Fixture beneficiary scoring guidance.' }),
  }),
  Object.freeze({
    agentId: 'data-orchestrator',
    caseId: 'default',
    input: Object.freeze({ guideline: 'Fixture primary-source data guidance.' }),
  }),
  Object.freeze({
    agentId: 'industry-analyst',
    caseId: 'default',
    input: Object.freeze({ guidance: 'Fixture industry analysis guidance.' }),
  }),
  Object.freeze({
    agentId: 'company-analyst',
    caseId: 'subject',
    input: Object.freeze({ guidance: 'Fixture company analysis guidance.', isComparison: false }),
  }),
  Object.freeze({
    agentId: 'company-analyst',
    caseId: 'comparison',
    input: Object.freeze({ guidance: 'Fixture comparison-company guidance.', isComparison: true }),
  }),

  Object.freeze({
    agentId: 'report-composer',
    caseId: 'english',
    input: Object.freeze({ language: 'English' }),
  }),
  Object.freeze({
    agentId: 'report-composer',
    caseId: 'chinese',
    input: Object.freeze({ language: 'Chinese' }),
  }),
  Object.freeze({ agentId: 'evidence-reviewer', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'requirement-reviewer', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'logic-reviewer', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'data-scoreboard-evaluator', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'industry-scoreboard-evaluator', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'company-scoreboard-evaluator', caseId: 'default', input: Object.freeze({}) }),
  Object.freeze({ agentId: 'conclusion-synthesizer', caseId: 'default', input: Object.freeze({}) }),

]);

export const WORLDVIEW_AGENT_ASSET_CASES = Object.freeze([
  Object.freeze({ agentId: 'core-worldview', caseId: 'bootstrap-range', input: Object.freeze({
    runId: 'worldview_run_fixture',
    asOf: '2026-08-20T00:00:00.000Z',
    capabilityScopeId: 'worldview_scope_fixture',
    baseWorldviewVersionId: null,
    frozenRange: Object.freeze({ priorProcessedReceiptCount: 0, startAdmissionSequence: 1, endAdmissionSequence: 1 }),
    overviewManifestDigest: `sha256:${'c'.repeat(64)}`,
    overviews: Object.freeze([]),
    approvedCapabilities: Object.freeze(['worldview_read_current', 'worldview_enumerate_overviews', 'worldview_read_report_version', 'worldview_search_claims']),
  }) }),
]);

export const DIRECT_AGENT_ASSET_CASES = Object.freeze([
  Object.freeze({
    agentId: 'report-overview',
    caseId: 'single-report',
    definitionInput: Object.freeze({
      reportVersionId: 'report_fixture',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      fingerprint: `sha256:${'b'.repeat(64)}`,
      metadata: Object.freeze({ title: 'Fixture report', tickers: Object.freeze(['AAPL']) }),
      markdown: '# Fixture report',
    }),
  }),
  Object.freeze({
    agentId: 'idea-generator',
    caseId: 'pool-24',
    definitionInput: Object.freeze({ poolTarget: 24 }),
  }),
  Object.freeze({
    agentId: 'idea-quality-reviewer',
    caseId: 'select-12',
    definitionInput: Object.freeze({ count: 12 }),
  }),
  Object.freeze({
    agentId: 'project-classifier',
    caseId: 'template-catalog',
    definitionInput: Object.freeze({
      industryTemplates: Object.freeze([
        Object.freeze({ id: 'industry_generic', name: 'General Industry', scope: 'generic' }),
        Object.freeze({ id: 'industry_semiconductor', name: 'Semiconductor Industry', scope: 'semiconductors' }),
      ]),
      companyTemplates: Object.freeze([
        Object.freeze({ id: 'company_generic', name: 'General Company', scope: 'generic' }),
        Object.freeze({ id: 'company_growth', name: 'Growth Company', scope: 'growth' }),
      ]),
    }),
  }),
  Object.freeze({
    agentId: 'report-editor',
    caseId: 'timestamped-report',
    definitionInput: Object.freeze({ reportPath: 'report/report_2026-07-14T00-00-00.md' }),
  }),
  Object.freeze({
    agentId: 'deal-ladder-ranking',
    caseId: 'five-candidates',
    definitionInput: Object.freeze({ candidateCount: 5, horizon: '12 months', candidateLines: '' }),
  }),

  Object.freeze({
    agentId: 'idea-ranking',
    caseId: 'default',
    definitionInput: Object.freeze({ ideaCount: 0, ideaList: '' }),
  }),
  Object.freeze({
    agentId: 'report-translator',
    caseId: 'to-zh',
    definitionInput: Object.freeze({ targetLanguage: 'zh', source: '' }),
  }),
]);
