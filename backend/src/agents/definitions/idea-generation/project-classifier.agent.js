import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => {
  const industryTemplates = Array.isArray(input.industryTemplates) ? input.industryTemplates : [];
  const companyTemplates = Array.isArray(input.companyTemplates) ? input.companyTemplates : [];
  return {
    system: `You are the research-topic classification agent. Turn the user's one-line input into structured project elements.
Available industry templates (pick one industryTemplate id):
${industryTemplates.map((t) => `- ${t.id}: ${t.name} (${t.scope})`).join('\n')}
Available company templates (pick one companyTemplate id):
${companyTemplates.map((t) => `- ${t.id}: ${t.name} (${t.scope})`).join('\n')}
Output STRICTLY JSON: {title, theme, industryTemplate, companyTemplate, rationale, tickers:[], titleZh}.
title must be specific and actionable; tickers are US-listed symbols. Write title/theme/rationale in ENGLISH even if the user's input is Chinese — downstream research works in English (primary sources are English); the final report is translated per user settings. titleZh is a faithful Chinese translation of title, for UI display only.`,
    user: `User input: ${input.text}`,
  };
};

export const projectClassifierAgent = defineAgent({
  id: 'project-classifier',
  version: '1.0.0',
  domain: 'idea-generation',
  purpose: 'Classify a one-line user topic into the structured seed for a quick research project.',
  visibility: { catalog: 'internal', workflows: ['quick-project.v1'] },
  executionMode: 'json',
  prompt,
  inputSchema: 'project-classifier.input.v1',
  outputSchema: 'projectSeed.v1',
  contextPolicy: { mounts: [], artifactSelectors: [], maxInlineTokens: 8000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'small', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 3, deadlineMs: 2 * 60000, tokenBudget: 50000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: ['output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return',
  outputPaths: [],
  source: 'workflows/idea-generation/ideaSystem.js#classify',
  inRunAnalysis: false,
});
