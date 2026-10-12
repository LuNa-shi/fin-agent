import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => ({
  system: `Translate the following investment research report to ${input.targetLanguage || 'zh'}. Preserve Markdown structure, tables, numbers, tickers, citations, and JSON code blocks. Do not add new analysis.`,
  user: String(input.source || '').slice(0, 60000),
});

export const reportTranslatorAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-translation.v1'] },
  purpose: 'Translate a completed investment report without changing its analysis or Markdown structure.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'report-translator.input.v1',
  outputSchema: 'report-translator.output.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 20000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 2 * 60000, tokenBudget: 100000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['non-empty-report'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'server.js#/api/projects/:id/report/translate',
  inRunAnalysis: false,
  prompt,
  id: 'report-translator',
});
