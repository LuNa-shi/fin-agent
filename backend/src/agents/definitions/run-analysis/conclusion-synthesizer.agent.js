import { defineAgent } from '../../defineAgent.js';
import { json, list, SOURCE_DISCIPLINE, text, VARIANT_DISCIPLINE } from './sharedExpertPrompt.js';

const prompt = (input = {}) => ({
  system: `You are the head of buy-side research. Synthesize industry, company, reflection, scenario pricing, and library context into one conclusion grounded in expected return and odds.

Output strict JSON with rating (strong_buy|buy|hold|avoid|strong_avoid), recommendationScore, confidence, summary, stocks, vsConsensus, conflictAdjudication, killTest, portfolioFit, risks, and 2-5 falsifiable claims with owner/deadline/verifyVia.

Hard rules:
- recommendationScore >=75 requires expected return above +25% and odds at least 2:1; expected return 0-15% or odds below 1.5:1 maps to 40-60; negative expected return or downside larger than upside maps below 40.
- Scenario expected return is complete only for the dispute's subject ticker. For other tickers it is conditional and cannot justify high weight.
- Multi-segment weights must reflect SOTP and segment anchors.
- Every stock needs an observable invalidation condition. Single-name weight <=0.4 and weights sum to approximately one.
- Adjudicate every unresolved conflict with evidence or explicitly reduce confidence.
- Run the strongest kill test before settling the rating; if it survives, move the rating toward it.
- Claims must be machine-verifiable and time-bounded; they preserve current output compatibility but do not activate any self-evolving infrastructure here.
${SOURCE_DISCIPLINE}
${VARIANT_DISCIPLINE}`,
  user: `${text(input.brief)}${input.brief ? '\n\n' : ''}Theme: ${text(input.theme, '(unspecified theme)')}
Industry analysis: ${json(input.industry || {})}
Company analyses: ${json(input.companies || [])}
Ranked cruxes: ${json(input.cruxes || [])}
Scenario futures: ${json(input.futures || [])}
Expected return and odds: ${text(input.expectedReturnsBrief, '(not available)')}
Reflections/open items: ${json(input.reflections || [])}
Unresolved conflicts: ${json(input.unresolvedConflicts || [])}
Fundamentals: ${text(input.fundamentals, '(read project files)')}
Related findings: ${text(input.relatedFindings, '(none)')}
Idea-library panorama: ${list(input.libraryIdeas).join('\n') || '(none)'}`,
});

export const conclusionSynthesizerAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Synthesize an expected-return/odds-anchored investment conclusion.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'conclusion-synthesizer.input.v1',
  outputSchema: 'conclusion-synthesizer.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**', 'analysis/**', 'report/report.md'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: true },
  toolPolicy: { allow: ['ws_list_files', 'ws_read_file', 'ws_search_library'], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 6 * 60000, tokenBudget: 300000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/conclusion.json'], hardChecks: ['conclusion-schema', 'expected-return-score-clamp'], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/conclusion.json', 'analysis/claims.json'],
  source: 'runAnalysis:workflows/run-analysis/runAnalysis.workflow.js#conclusion',
  inRunAnalysis: true,
  prompt,
  id: 'conclusion-synthesizer',
});
