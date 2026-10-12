import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => ({
  system: `You are a buy-side portfolio manager doing a HEAD-TO-HEAD comparison (not one-by-one evaluation). Given ${input.candidateCount} candidates (each with expected return/odds, belief support, quant factors, thesis, and invalidation condition), rank them best→worst on ONE yardstick: [risk-adjusted certainty of making money within ${input.horizon} × convexity of the odds].
Judging: favorable odds (upside >> downside) + solid evidence + belief-aligned (macro/industry/theme) + valuation/growth/quality fit rank HIGH; poor odds, thin logic, belief-contrarian, or easily-triggered invalidation rank LOW. This is a RELATIVE ranking — produce a total order (no ties unless truly indistinguishable).
Output STRICTLY JSON: { "ranking":[{ "ticker","rank","note" }] } — rank starts at 1 (best), covers ALL ${input.candidateCount} tickers; note is one English sentence naming the decisive reason it wins/loses.`,
  user: `This group's ${input.candidateCount} candidates (head-to-head):
${input.candidateLines}`,
});

export const dealLadderRankingAgent = defineAgent({
  domain: 'decision',
  visibility: { catalog: 'internal', workflows: ['decision-deal-ladder.v1'] },
  purpose: 'Produce a total head-to-head ranking for one Deal Ladder candidate group.',
  version: '1.0.0',
  executionMode: 'json',
  inputSchema: 'deal-ladder-ranking.input.v1',
  outputSchema: 'deal-ladder-ranking.output.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 12000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 2 * 60000, tokenBudget: 100000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['ladder-compare-schema', 'output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'domains/decision/dealLadder.js#compareGroup',
  inRunAnalysis: false,
  prompt,
  id: 'deal-ladder-ranking',
});
