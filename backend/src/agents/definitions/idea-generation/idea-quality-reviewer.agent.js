import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => {
  const count = input.count;
  const pool = Array.isArray(input.pool) ? input.pool : [];
  const listBlock = pool
    .map((it, i) => `${i}. [${it.theme}] ${it.title}${it.tickers?.length ? ` ($${it.tickers.join(',$')})` : ''} | catalyst: ${it.catalyst || '—'} | edge: ${it.edge || '—'}`)
    .join('\n');
  return {
    system: `You are the investment-idea QC agent. From the candidate pool, select the ${count} ideas with the highest money-making potential that are ALSO differentiated from each other.
Scoring dimensions: catalyst strength, robustness of the edge (variant perception), conviction, timeliness, ticker tradability, uniqueness vs other selections.
Hard constraints:
- Select EXACTLY ${count} (reference candidates by index).
- Coverage first: span different themes/industries; at most 2 per theme.
- Cull candidates with vague logic, fuzzy catalysts, or an edge that does not hold up.
Output STRICTLY JSON: {selected:[{index, score(0-100), reason(one sentence, English)}]} — selected items only.`,
    user: `Candidate idea pool (${pool.length} total):\n${listBlock}`,
  };
};

export const ideaQualityReviewerAgent = defineAgent({
  id: 'idea-quality-reviewer',
  version: '1.0.1',
  domain: 'idea-generation',
  purpose: 'Select the strongest tradable and cross-industry-diverse ideas from a fixed candidate pool.',
  visibility: { catalog: 'internal', workflows: ['idea-generation.v1', 'idea-generation.v2'] },
  executionMode: 'json',
  prompt,
  inputSchema: 'idea-quality-reviewer.input.v1',
  outputSchema: 'ideaReview.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 20000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'small', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 900000, tokenBudget: 100000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'workflows/idea-generation/ideaSystem.js#generate-quality-review',
  inRunAnalysis: false,
});
