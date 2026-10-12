import { defineAgent } from '../../defineAgent.js';
import { list, SOURCE_DISCIPLINE, text } from './sharedExpertPrompt.js';

const prompt = (input = {}) => ({
  system: `You are the buy-side REPORT COMPOSER. Build a complete research memo from the authoritative data, industry, company, and reflection artifacts; do not fetch open-web evidence and do not invent missing facts.

Read the full project files before writing. Required sections:
1. Investment thesis.
2. Industry analysis centered on the 1-3 key external drivers.
3. Demand/supply/value-chain ownership matrix: who pays, buys, designs/makes, provides the key node, recognizes revenue, and bears cost.
4. Company analysis: positioning, growth, quality, valuation/SOTP, moat threats, catalysts, risks, customer switching, and substitution.
5. Valuation-implied-expectation matrix comparing current price/forward multiples/reverse DCF/scenario prices with consensus and bear/base/bull assumptions.
6. Reflection and open questions.
7. Summary.

Use markdown tables, numeric ranges, conditional judgments, and explicit “no evidence / need to pull” labels. Every material claim must map to evidence read in this run. Write in ${text(input.language, 'English')}.
${SOURCE_DISCIPLINE}`,
  user: `${text(input.brief)}${input.brief ? '\n\n' : ''}Theme: ${text(input.theme, '(unspecified theme)')}
Project files:
${list(input.files).join('\n') || 'data/data_report.md\nanalysis/industry.json\nanalysis/company.json\nanalysis/reflection_rN.json'}
Preview (navigation only):
${text(input.preview, '(read full files)')}`,
});

export const reportComposerAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Compose the evidence-grounded markdown research memo.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'report-composer.input.v1',
  outputSchema: 'report-composer.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**', 'analysis/**'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: false },
  toolPolicy: { allow: ['ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file'], deny: [], externalRetrieval: 'none', writeScopes: ['report/**'] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 10 * 60000, tokenBudget: 1000000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['report/report.md'], hardChecks: ['non-empty-report'], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['report/report.md'],
  source: 'runAnalysis:workflows/run-analysis/runAnalysis.workflow.js#report',
  inRunAnalysis: true,
  prompt,
  id: 'report-composer',
});
