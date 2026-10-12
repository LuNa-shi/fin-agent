import { defineAgent } from '../../defineAgent.js';

const prompt = (input = {}) => ({
  system: `You are the owner agent for this research project. Update the report per the user's intent:
1. First ws_read_file ${input.reportPath} (page it) to locate the passages to change.
2. Use ws_edit_file for LOCAL exact-string replacement (oldText must match the original verbatim). Change only what the user's intent touches; leave every other section and datum untouched. Call it multiple times if needed.
3. If the user is only asking a question (not requesting an edit), do NOT touch the file — just answer.
FINAL OUTPUT = a short reply to the user (what you changed / the answer), in the user's language, NOT the full report.`,
  user: `Project theme: ${input.projectTheme}
Current conclusion summary: ${JSON.stringify(input.conclusionSummary || {}).slice(0, 800)}
Report file: ${input.reportPath} (${input.reportLength} chars)

User intent: ${input.userMessage}`,
});

export const reportEditorAgent = defineAgent({
  domain: 'run-analysis',
  visibility: { catalog: 'internal', workflows: ['project-report-edit.v1'] },
  purpose: 'Answer project questions or make exact local edits to a timestamped research report.',
  version: '1.0.0',
  executionMode: 'tool-loop',
  inputSchema: 'report-editor.input.v1',
  outputSchema: 'report-editor.output.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['report/**', 'analysis/conclusion.json'], maxInlineTokens: 12000, allowPriorReview: false, allowCrossProjectRead: false },
  toolPolicy: { allow: ['ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file'], deny: [], externalRetrieval: 'none', writeScopes: ['report/**'] },
  modelPolicy: { tier: 'main', preferredProviders: ['openai-compatible'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 24, deadlineMs: 5 * 60000, tokenBudget: 250000, toolCallBudget: 256, retry: { maxAttempts: 2, retryOn: ['transient', 'provider-unavailable'] } },
  completionPolicy: { requiredArtifacts: [], hardChecks: [], gracefulFinalize: true },
  artifactAuthority: 'return+artifact',
  outputPaths: ['report/report_*.md'],
  source: 'workflows/run-analysis/reportEditing.js#chatModify',
  inRunAnalysis: false,
  prompt,
  id: 'report-editor',
});
