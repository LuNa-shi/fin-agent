import { defineAgent } from '../../defineAgent.js';
import { list, text } from './sharedExpertPrompt.js';

const prompt = (input = {}) => {
  const tickers = list(input.tickers).map((ticker) => String(ticker).toUpperCase());
  return {
    system: `You are the analysis-planning agent for an institutional investment research workflow. Decompose the research theme using the supplied industry and company templates, define the single most valuable dispute to resolve, and choose 3-5 US-listed companies or ADRs with public financials. Avoid fabricated tickers and no-data OTC names.

Output strict JSON: {logic, candidates:[{ticker,name,role,reason}], keyEvent, deltas}. All free text is English. ${tickers.length ? `The user-specified core ticker(s) ${tickers.join(', ')} must appear first with role=core; other names are comps or context.` : ''} keyEvent is the one event most worth simulating.

Industry/company template guidance:
${text(input.templatePrompt, '(generic research templates)')}`,
    user: `主题：${text(input.theme, '(unspecified theme)')}\n说明：${text(input.rationale, '')}`,
  };
};

export const analysisPlanAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Decompose the brief and select initial research entities.',
  version: '1.0.0',
  executionMode: 'json',
  inputSchema: 'analysis-plan.input.v1',
  outputSchema: 'analysis-plan.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: [], maxInlineTokens: 12000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: [], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 1, deadlineMs: 3 * 60000, tokenBudget: 250000, toolCallBudget: 0, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/plan.json'], hardChecks: ['plan-shape'], gracefulFinalize: false },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/plan.json'],
  source: 'runAnalysis:workflows/run-analysis/runAnalysis.workflow.js#plan',
  inRunAnalysis: true,
  prompt,
  id: 'analysis-plan',
});
