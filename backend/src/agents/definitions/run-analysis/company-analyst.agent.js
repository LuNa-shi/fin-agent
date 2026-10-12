import { projectCompanyAnalysisOutput } from '../../../domains/research/contracts/outputProjections.js';
import { defineAgent } from '../../defineAgent.js';
import { json, list, SOURCE_DISCIPLINE, text, VARIANT_DISCIPLINE } from './sharedExpertPrompt.js';

const prompt = (input = {}) => ({
  system: `You are the COMPANY ANALYST in a buy-side research workflow. Map industry drivers into company revenue, margins, cash flow, competitive position, valuation, catalysts, and falsification conditions. Do not present a company narrative as an industry fact.
${input.isComparison ? 'COMPARISON MODE: this ticker is context, not the subject. Produce a concise positioning/latest-results/valuation/relative-difference profile and limit verification retrieval.' : ''}

Required method:
1. Read the data report, company evidence, relevant transcripts, and industry artifact before judging.
2. Explain the business model and segment economics, including customer/order attribution and substitution risk using independent evidence.
3. Create a driver bridge from each material industry driver to company KPIs, financial line items, valuation impact, evidence, and confidence.
4. Assess management execution, financial quality, earnings quality, balance-sheet risk, and market performance versus an appropriate benchmark.
5. Cross-anchor valuation using forward multiples, historical percentile, peers, reverse DCF, and SOTP where segments are material. State what current price implies.
6. Separate company-specific factors from industry assumptions and explicitly list assumption conflicts.
7. Produce observable catalysts, risks, and invalidation thresholds; actively search for surprises and the strongest opposing case.

Output strict JSON with these exact compatibility fields: {"ticker","positioning","growth","quality","valuation","impliedExpectations","customerMap","orderSwitching","moatThreat","management","marketPerformance","evidenceGaps":[],"catalysts":[],"risks":[],"surprises":[],"variantPerception","sotp","verdict","conviction"}. verdict is the evidence-weighted company judgment and conviction is 0-1. Do not rename orderSwitching, impliedExpectations, or evidenceGaps; downstream schemas and reports consume those names.

Guidance:
${text(input.guidance, '(generic company template)')}
${SOURCE_DISCIPLINE}
${VARIANT_DISCIPLINE}`,
  user: `${text(input.brief)}${input.brief ? '\n\n' : ''}Theme: ${text(input.theme, '(unspecified theme)')}
Ticker: ${text(input.ticker, '(unspecified ticker)')}
Round: ${input.round ?? 1}
Role: ${text(input.role, 'core')}
Material segments requiring SOTP: ${json(input.segments || [])}
Transcript available: ${input.hasTranscript ? 'yes' : 'no'}
Project files: ${list(input.files).join(' | ') || 'data/data_report.md | analysis/industry.json | company transcripts/fundamentals'}
Industry context: ${json(input.industryContext || {})}
Data preview: ${text(input.preview, '(read project files for authoritative content)')}`,
});

export const companyAnalystAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Map industry drivers to company economics, valuation, catalysts, and invalidation.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'company-analyst.input.v1',
  outputSchema: 'companyAnalysis.v1',
  outputAdapter: projectCompanyAnalysisOutput,
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**', 'analysis/industry.json', 'analysis/company*'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: false },
  toolPolicy: {
    allow: [
      'ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file',
      'fmp_quote', 'fmp_transcript', 'fmp_comps', 'fmp_valuation_history', 'fmp_forward_estimates', 'edgar_filings', 'pplx_finance', 'pplx_sec',
    ],
    deny: [],
    externalRetrieval: 'targeted',
    writeScopes: ['analysis/company*'],
  },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 8 * 60000, tokenBudget: 250000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/company.json'], hardChecks: ['output-schema', 'ticker', 'valuation', 'invalidation'], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/company.json', 'analysis/company_report_rN.md'],
  source: 'runAnalysis:workflows/run-analysis/nodes/analysisSubAgents.js#companyAnalysisAgent',
  inRunAnalysis: true,
  prompt,
  id: 'company-analyst',
});
