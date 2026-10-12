import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getAgentDefinition, RUN_ANALYSIS_AGENT_IDS } from '../src/agents/registry.js';
import { reportEditorAgent } from '../src/agents/definitions/run-analysis/report-editor.agent.js';
import { reportTranslatorAgent } from '../src/agents/definitions/run-analysis/report-translator.agent.js';

test('report support roles own explicit definitions', async () => {
  const definitions = [
    ['report-editor', reportEditorAgent, 'report-editor.agent.js'],
    ['report-translator', reportTranslatorAgent, 'report-translator.agent.js'],
  ];
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');
  for (const [id, definition, filename] of definitions) {
    assert.equal(definition.id, id);
    assert.equal(definition.domain, 'run-analysis');
    assert.equal(getAgentDefinition(id), definition);
    assert.equal(RUN_ANALYSIS_AGENT_IDS.includes(id), false);
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));
    const source = await readFile(new URL(`../src/agents/definitions/run-analysis/${filename}`, import.meta.url), 'utf8');
    assert.match(source, /defineAgent\s*\(/u);
    assert.match(source, /system\s*:/u);
    assert.match(source, /toolPolicy\s*:/u);
    assert.match(source, /outputSchema\s*:/u);
    assert.match(source, /visibility\s*:/u);
  }
});

test('report support Tool Use preserves the frozen pre-migration permissions', () => {
  assert.deepEqual(reportEditorAgent.toolPolicy.allow, [
    'ws_list_files', 'ws_read_file', 'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file',
  ]);
  assert.deepEqual(reportEditorAgent.toolPolicy.writeScopes, ['report/**']);
  assert.deepEqual(reportTranslatorAgent.toolPolicy.allow, []);
  assert.deepEqual(reportTranslatorAgent.toolPolicy.writeScopes, []);
});

test('report support call sites route through runDefinedAgent without embedded expert assets', async () => {
  const [reportEditingSource, serverSource] = await Promise.all([
    readFile(new URL('../src/workflows/run-analysis/reportEditing.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);
  const chatModifySource = reportEditingSource.slice(reportEditingSource.indexOf('export async function chatModify'));
  assert.match(chatModifySource, /runDefinedAgent\s*\(\s*['"]report-editor['"]/u);
  assert.match(chatModifySource, /beginDirectAgentCommand\s*\(/u);
  assert.match(chatModifySource, /workspaceMode:\s*['"]project['"]/u);
  assert.doesNotMatch(chatModifySource, /runAgent\s*\(|system\s*:|tools\s*:/u);
  assert.doesNotMatch(reportEditingSource, /from ['"]\.\/runtime\.js['"]|AGENT_TOOLSETS/u);
  assert.match(serverSource, /runDefinedAgent\s*\(\s*['"]report-translator['"]/u);
  assert.match(serverSource, /beginDirectAgentCommand\s*\(/u);
  assert.doesNotMatch(serverSource, /reportTranslatorSystemPrompt|Translate the following investment research report/u);
});
