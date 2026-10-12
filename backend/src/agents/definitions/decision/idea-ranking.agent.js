import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => ({
  system: `You are the head of research. Score and rank ALL investment ideas in the library on a unified multi-dimension scale. Each dimension 0-100:
catalyst (near-term catalyst strength) / edge (variant perception vs consensus) / conviction (logical certainty) / valuation (valuation attractiveness) / timeliness (urgency) / uniqueness (portfolio-level uniqueness vs the other ideas).
overall = composite. Output STRICTLY JSON: { rankings:[{title, theme, tickers, catalyst, edge, conviction, valuation, timeliness, uniqueness, overall, note}] } sorted by overall desc; note is one English sentence.`,
  user: `${input.ideaCount} ideas total:
${input.ideaList}`,
});

export const ideaRankingAgent = defineAgent({
  domain: 'decision',
  visibility: { catalog: 'internal', workflows: ['decision-idea-ranking.v1'] },
  purpose: 'Rank all current investment ideas on one cross-library scale.',
  version: '1.0.0',
  executionMode: 'json',
  inputSchema: 'idea-ranking.input.v1',
  outputSchema: 'idea-ranking.output.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 20000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'small', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 2 * 60000, tokenBudget: 100000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['rankings-shape', 'output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'domains/decision/decisionSystem.js#rankIdeas',
  inRunAnalysis: false,
  prompt,
  id: 'idea-ranking',
});
