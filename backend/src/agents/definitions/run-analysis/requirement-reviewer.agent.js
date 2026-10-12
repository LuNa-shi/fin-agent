import { defineAgent } from '../../defineAgent.js';
import { projectReviewResultOutput } from '../../../domains/research/contracts/outputProjections.js';
import { json, text } from './sharedExpertPrompt.js';

const prompt = (input = {}) => ({
  system: `You are the independent REQUIREMENTS REVIEWER in a buy-side report optimization workflow. Review the research brief, required sections, requested entities, valuation framing, and unanswered questions. Never edit, rewrite, or write the report. Never continue the analysis as its author. Return issues and remediation instructions only.

Output strict JSON matching reviewResult.v1 with provenance fields plus reviewerType, score, issues, and verdict. Each issue must contain id, severity (info|warning|critical), owner (data|industry|company|report|system), message, optional location/claim/evidenceRefs, and remediation. Use critical only when publication would be unsafe. verdict is pass, remediate, or human-review.`,
  user: `Reviewer type: requirements
As of: ${text(input.asOf, '(unspecified)')}
Input digest: ${text(input.inputDigest, '(unspecified)')}
Research brief: ${json(input.researchBrief || {})}
Evidence bundle: ${json(input.evidenceBundle || {})}
Draft report:
${typeof input.draftReport === 'string' ? input.draftReport : json(input.draftReport || {})}
Prior issues: ${json(input.priorReviewIssues || [])}`,
});

export const requirementReviewerAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['report-optimization.v1'] },
  purpose: 'Read-only requirements review of a draft report package.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'requirement-reviewer.input.v1',
  outputSchema: 'reviewResult.v1',
  outputAdapter: projectReviewResultOutput,
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['report/**', 'data/**', 'analysis/**'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: false },
  toolPolicy: { allow: ['ws_list_files', 'ws_read_file', 'ws_search_library'], deny: [], externalRetrieval: 'none', writeScopes: [] },
  modelPolicy: { tier: 'review', preferredProviders: ['openai-compatible'], reasoningLevel: 'high' },
  runPolicy: { maxTurns: 24, deadlineMs: 4 * 60000, tokenBudget: 180000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: ['analysis/reviews/requirements_rN.json'], hardChecks: ['output-schema'], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['analysis/reviews/requirements_rN.json'],
  source: 'runAnalysis:workflows/run-analysis/reviewers/reviewerGroup.js#requirements',
  inRunAnalysis: true,
  prompt,
  id: 'requirement-reviewer',
});
