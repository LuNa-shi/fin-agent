import { defineAgent } from '../../defineAgent.js';
import { projectIndustryAnalysisOutput } from '../../../domains/research/contracts/outputProjections.js';
import { json, list, SOURCE_DISCIPLINE, text, VARIANT_DISCIPLINE } from './sharedExpertPrompt.js';

const prompt = (input = {}) => ({
  system: `You are the INDUSTRY ANALYST in a buy-side research workflow. Explain industry structure and external drivers; do not issue a final company recommendation, target portfolio weight, or final rating.

Required method:
1. Read data/data_report.md and the relevant organized evidence before reasoning.
2. Identify the 1-3 key external drivers that truly determine intrinsic value and explain why they dominate other variables.
3. Map demand, supply, value-chain ownership, technology/substitution, regulation, cycle position, competition, and peer economics only where material.
4. Separate who pays, buys, designs/makes, provides the key node, recognizes revenue, and bears cost.
5. Quantify the industry's consensus view, variant view, and market-implied expectations.
6. For multi-segment companies, analyze every material segment independently, including cycle, monetization, competition, and a segment valuation anchor.
7. Record surprises that overturn the initial hypothesis and unresolved data requests.

Output strict JSON with these exact compatibility fields: {"marketSize","industryMainline","keyExternalDrivers","demandSupplyMap","drivers":[{"driver","direction":"accelerating|stable|decelerating","evidence"}],"competition","crossIndustry","valuationExpectationMatrix","evidenceGaps":[],"inflection","surprises":[],"variantPerception","structuralView","segments":[]}. Do not rename evidenceGaps to gaps or valuationExpectationMatrix to a generic valuation field.

Guidance:
${text(input.guidance, '(generic industry template)')}
${SOURCE_DISCIPLINE}
${VARIANT_DISCIPLINE}`,
  user: `${text(input.brief)}${input.brief ? '\n\n' : ''}Theme: ${text(input.theme, '(unspecified theme)')}
Round: ${input.round ?? 1}
Project files: ${list(input.files).join(' | ') || 'data/data_report.md | data/organized_rN.json | analysis/data_notes.md'}
Material company segments requiring independent sub-analysis: ${json(input.segments || [])}
Related library findings (staleness must be checked): ${text(input.relatedFindings, '(none)')}
Data preview: ${text(input.preview, '(read project files for authoritative content)')}`,
});

export const industryAnalystAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Explain industry structure, external drivers, and peer economics without final company ratings.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'industry-analyst.input.v1',
  outputSchema: 'industryAnalysis.v1',
  outputAdapter: projectIndustryAnalysisOutput,
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**', 'analysis/industry*', 'analysis/company.json'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: true },
  toolPolicy: {
    allow: [
      'ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file',
      'fmp_sector', 'fmp_comps', 'fred_series', 'pplx_finance', 'pplx_reasoning', 'pplx_sec', 'tavily_search', 'edgar_fulltext',
    ],
    deny: [],
    externalRetrieval: 'targeted',
    writeScopes: ['analysis/industry*'],
  },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 8 * 60000, tokenBudget: 250000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/industry.json'], hardChecks: ['output-schema', 'structural-view'], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/industry.json', 'analysis/industry_report_rN.md'],
  source: 'runAnalysis:workflows/run-analysis/nodes/analysisSubAgents.js#industryAnalysisAgent',
  inRunAnalysis: true,
  prompt,
  id: 'industry-analyst',
});
