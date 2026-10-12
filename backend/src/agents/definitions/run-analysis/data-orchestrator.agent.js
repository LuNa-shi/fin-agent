import { defineAgent } from '../../defineAgent.js';
import { projectDataOrchestratorOutput } from '../../../domains/research/contracts/outputProjections.js';
import { list, SOURCE_DISCIPLINE, text } from './sharedExpertPrompt.js';

export const DATA_ORCHESTRATOR_TOOL_ALLOWLIST = Object.freeze([
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
]);

const prompt = (input = {}) => {
  const focus = input.focus || {};
  return {
    system: `You are the DATA ORCHESTRATOR for buy-side research. Work in two phases.

Phase 1 — evidence planning and retrieval:
1. Identify the 1-3 external drivers that most change the investment judgment; do not force a fixed thematic template.
2. Map each driver to observable facts, time window, preferred primary sources, fallback sources, and missing evidence.
3. Cover demand, supply, value-chain ownership, company fundamentals, forward estimates, valuation-implied expectations, catalysts, competition, and falsification evidence where relevant.
4. Use the allowed tools and project workspace. Prefer SEC filings, earnings transcripts, structured financials, and primary industry data over commentary.
5. Build an independent competitor dossier, including private competitors where material; never rely only on management framing.

Phase 2 — organize and audit:
Output strict JSON with {organized, sourceQuality, contradictions, gaps, nextDataFocus, competitorDossier}.
- organized groups evidence by dimension and assigns credibility/type.
- contradictions names conflicting claims, a testable hypothesis, and resolveBy.
- nextDataFocus is specific and executable for the next round.
- valuation-implied expectations must connect price/multiples to revenue, EPS/FCF, margin, capex intensity, or terminal assumptions.
- Never fabricate missing data. Mark unavailable evidence and the exact source/tool needed.

Data guidance:
${text(input.guideline, '(general primary-source and structured-data guidance)')}
${SOURCE_DISCIPLINE}`,
    user: `${text(input.brief)}${input.brief ? '\n\n' : ''}Theme: ${text(input.theme, '(unspecified theme)')}
Tickers: ${list(input.tickers).join(', ') || '(none)'}
Round: ${input.round ?? 1}
Prior focus questions: ${list(focus.questions).join('; ') || '(none)'}
Priority tools: ${list(focus.tools).join(', ') || '(none)'}
Priority tickers: ${list(focus.tickers).join(', ') || '(none)'}

Deterministic data baseline:
${text(input.gathered, '(not supplied)')}`,
  };
};

export const dataOrchestratorAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Plan, retrieve, organize, and audit investment evidence.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'data-orchestrator.input.v1',
  outputSchema: 'data-orchestrator.output.v1',
  outputAdapter: projectDataOrchestratorOutput,
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**', 'analysis/plan.json', 'analysis/reflection_*.json'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: true },
  toolPolicy: { allow: [...DATA_ORCHESTRATOR_TOOL_ALLOWLIST], deny: [], externalRetrieval: 'full', writeScopes: ['data/**', 'analysis/data_notes.md'] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 10 * 60000, tokenBudget: 500000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema', 'data-organize-schema', 'coverage'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'runAnalysis:workflows/run-analysis/nodes/dataAgent.js#organize',
  inRunAnalysis: true,
  prompt,
  id: 'data-orchestrator',
});
