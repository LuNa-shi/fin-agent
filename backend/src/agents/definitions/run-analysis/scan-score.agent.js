import { defineAgent } from '../../defineAgent.js';
import { list, text } from './sharedExpertPrompt.js';

const prompt = (input = {}) => {
  const pool = list(input.pool);
  return {
    system: `You are the beneficiary-screening agent. Score every supplied candidate on the same research-template yardstick. Do not add tickers outside the candidate pool. Output strict JSON: {scores:[{ticker,score,take}]}; score is 0-100 and take is one evidence-oriented sentence. Cover every candidate exactly once.

Screening guidance:
${text(input.scanPrompt, '(generic beneficiary scoring: catalyst, exposure, economics, valuation, tradability)')}`,
    user: `Theme: ${text(input.theme, '(unspecified theme)')}\nResearch brief: ${text(input.rationale, '(none provided)')}\nCandidate pool (${pool.length}):\n${pool.map((p) => `${p.ticker || ''} ${p.name || ''} | ${p.role || ''} | ${p.reason || ''}`.slice(0, 180)).join('\n') || '(empty)'}`,
  };
};

export const scanScoreAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Score a bounded discovery pool and select deep-analysis candidates.',
  version: '1.0.0',
  executionMode: 'json',
  inputSchema: 'scan-score.input.v1',
  outputSchema: 'scan-score.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: [], maxInlineTokens: 12000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'fast', preferredProviders: ['openai-compatible'], reasoningLevel: 'low' },
  runPolicy: { maxTurns: 1, deadlineMs: 3 * 60000, tokenBudget: 250000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/scan.json'], hardChecks: ['bounded-pool', 'screen-shape'], gracefulFinalize: false },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/scan.json'],
  source: 'runAnalysis:workflows/run-analysis/runAnalysis.workflow.js#scan-score',
  inRunAnalysis: true,
  prompt,
  id: 'scan-score',
});
