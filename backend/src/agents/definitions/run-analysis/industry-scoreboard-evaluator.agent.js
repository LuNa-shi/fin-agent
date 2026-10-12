import { defineAgent } from '../../defineAgent.js';
import { projectScorecardEvaluationOutput } from '../../../domains/research/scorecards/scorecardOutputProjection.js';
import { buildScorecardPrompt } from './sharedScorecardPrompt.js';

export const industryScoreboardEvaluatorAgent = defineAgent({
  id: 'industry-scoreboard-evaluator',
  version: '1.0.0',
  domain: 'run-analysis',
  purpose: 'Read-only Scorecard v3.1 evaluation of Industry quality for an exact draft dependency closure.',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  executionMode: 'tool-loop',
  prompt: (input = {}) => buildScorecardPrompt('industry', input),
  inputSchema: 'scorecard-evaluator.input.v1',
  outputSchema: 'scorecard-evaluation.v1',
  outputAdapter: projectScorecardEvaluationOutput,
  contextPolicy: {
    mounts: ['/project'],
    artifactSelectors: ['report/**', 'data/**', 'analysis/**'],
    maxInlineTokens: 12000,
    allowPriorReview: true,
    allowCrossProjectRead: false,
  },
  toolPolicy: {
    allow: ['ws_read_file'],
    deny: [],
    externalRetrieval: 'none',
    writeScopes: [],
  },
  modelPolicy: {
    tier: 'review',
    preferredProviders: ['openai-compatible'],
    reasoningLevel: 'high',
  },
  runPolicy: {
    maxTurns: 24,
    deadlineMs: 8 * 60000,
    tokenBudget: 180000,
    toolCallBudget: 256,
    retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] },
  },
  completionPolicy: {
    requiredArtifacts: [],
    hardChecks: ['output-schema'],
    gracefulFinalize: true,
  },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'runAnalysis:workflows/run-analysis/handlers/reviewReport.js#scorecards',
  inRunAnalysis: true,
});
