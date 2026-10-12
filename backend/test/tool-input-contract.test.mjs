import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';

import * as catalog from '../src/tools/toolCatalog.js';
import { createPiTools } from '../src/core/agent-backend/PiToolAdapter.js';

const { toolRegistry } = catalog;

test('catalog owns object inputSchema and explicit effect metadata for every registered tool', () => {
  assert.equal(toolRegistry.size, 79);

  for (const [name, tool] of toolRegistry.entries()) {
    assert.equal(tool.inputSchema?.type, 'object', `${name} inputSchema must be an object schema`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} must reject unknown input properties`);
    assert.ok(Array.isArray(tool.inputSchema.required), `${name} must declare required semantics`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties || {}), (tool.params || []).map((param) => param.name), `${name} schema properties must match params exactly`);
    assert.equal(typeof tool.effect?.type, 'string', `${name} effect.type required`);
    assert.ok(Object.hasOwn(tool.effect, 'retrieval'), `${name} effect.retrieval required`);
    assert.ok(Object.hasOwn(tool.effect, 'project'), `${name} effect.project required`);
    assert.ok(Object.hasOwn(tool.effect, 'path'), `${name} effect.path required`);
  }

  const transcript = toolRegistry.get('fmp_transcript').inputSchema.properties;
  assert.equal(transcript.quarter.type, 'number');
  assert.equal(transcript.quarter.default, 1);
  assert.equal(transcript.year.type, 'number');
  assert.equal(transcript.year.default, 2025);

  assert.equal(toolRegistry.get('research_digest').inputSchema.properties.includeX.type, 'boolean');
  assert.equal(toolRegistry.get('research_digest').inputSchema.properties.includeX.default, false);
  assert.equal(toolRegistry.get('ws_edit_file').inputSchema.properties.replaceAll.type, 'boolean');
  assert.equal(toolRegistry.get('ws_edit_file').inputSchema.properties.replaceAll.default, false);

  assert.deepEqual(toolRegistry.get('fmp_intraday').inputSchema.properties.interval.enum, ['5min', '15min', '30min', '1hour']);
  assert.deepEqual(toolRegistry.get('fmp_market_movers').inputSchema.properties.kind.enum, ['gainers', 'losers', 'actives']);
  assert.deepEqual(toolRegistry.get('edgar_section').inputSchema.properties.section.enum, ['risk', 'mdna', 'legal']);
  assert.deepEqual(toolRegistry.get('ws_write_file').inputSchema.required, []);
  assert.deepEqual(toolRegistry.get('ws_edit_file').inputSchema.required, ['oldText']);
  assert.equal(toolRegistry.get('ws_write_file').inputSchema.properties.currentProjectId.minLength, undefined);
  assert.equal(toolRegistry.get('ws_write_file').inputSchema.properties.projectId.minLength, undefined);
  assert.equal(toolRegistry.get('ws_edit_file').inputSchema.properties.oldText.minLength, 1);
});

test('all catalog schemas compile in Pi while runtime-owned project identity stays optional to the model', () => {
  const tools = createPiTools({
    toolNames: toolRegistry.ids(),
    toolRegistry: toolRegistry.toObject(),
    projectId: 'project-1',
    executeTool: async () => ({ result: { ok: true } }),
  });

  assert.equal(tools.length, 79);
  for (const tool of tools) {
    const args = tool.name === 'edgar_section'
      ? { url: 'https://example.test/filing' }
      : tool.name === 'ws_edit_file'
        ? { oldText: 'needle' }
        : tool.name === 'worldview_read_report_version'
          ? { scopeId: 'worldview_scope_test', reportVersionId: 'report_test' }
          : tool.name.startsWith('worldview_')
            ? { scopeId: 'worldview_scope_test' }
            : {};
    assert.doesNotThrow(
      () => validateToolArguments(tool, { name: tool.name, arguments: args }),
      `${tool.name} must expose a Pi-compatible JSON Schema`,
    );
  }
});

test('catalog validator coerces typed inputs and fills typed defaults', () => {
  assert.equal(typeof catalog.validateToolInput, 'function');

  assert.deepEqual(catalog.validateToolInput('fmp_transcript', { symbol: 'AAPL', quarter: '2', year: '2026' }), {
    symbol: 'AAPL',
    quarter: 2,
    year: 2026,
  });
  assert.equal(catalog.validateToolInput('research_digest', { tickers: 'NVDA', theme: 'AI', includeX: 'true' }).includeX, true);
  assert.deepEqual(catalog.validateToolInput('fmp_intraday', { symbol: 'NVDA' }), {
    symbol: 'NVDA',
    interval: '5min',
    limit: 78,
  });
  assert.deepEqual(catalog.validateToolInput('fmp_intraday', { symbol: '', interval: '', limit: '' }), {
    symbol: 'NVDA',
    interval: '5min',
    limit: 78,
  });
  assert.deepEqual(catalog.validateToolInput('ws_search_library', { currentProjectId: 'p1', query: '' }), {
    currentProjectId: 'p1',
    query: '',
    limit: 8,
  });
});

test('catalog validator rejects unknown, enum, type, and required input issues with stable ToolInputError', () => {
  assert.equal(typeof catalog.ToolInputError, 'function');

  assert.throws(
    () => catalog.validateToolInput('fmp_quote', { symbol: 'NVDA', extra: 'nope' }),
    (error) => error instanceof catalog.ToolInputError
      && error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'unknown' && issue.path === 'extra'),
  );
  assert.throws(
    () => catalog.validateToolInput('fmp_intraday', { symbol: 'NVDA', interval: 'daily' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'enum' && issue.path === 'interval'),
  );
  assert.throws(
    () => catalog.validateToolInput('fmp_transcript', { symbol: 'AAPL', quarter: 'Q2', year: '2026' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'type' && issue.path === 'quarter'),
  );
  assert.throws(
    () => catalog.validateToolInput('edgar_section', { url: '' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'url'),
  );
  assert.throws(
    () => catalog.validateToolInput('edgar_section', {}),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'url'),
  );
  assert.throws(
    () => catalog.validateToolInput('ws_read_file', { projectId: '', file: '' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'projectId'),
  );
  assert.throws(
    () => catalog.validateToolInput('ws_edit_file', { currentProjectId: 'p1', projectId: 'p1', oldText: '' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'oldText'),
  );
  assert.throws(
    () => catalog.validateToolInput('ws_edit_file', { currentProjectId: 'p1', projectId: 'p1' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'oldText'),
  );
  assert.throws(
    () => catalog.validateToolInput('fmp_sector', 'not-object'),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'type' && issue.path === ''),
  );
});

test('Pi model-facing schemas allow runtime-owned identity to be injected after agent-core validation', async () => {
  const [tool] = createPiTools({
    toolNames: ['ws_write_file'],
    toolRegistry: toolRegistry.toObject(),
    projectId: 'project-1',
    executeTool: async (name, args) => ({ result: { name, args } }),
  });

  assert.deepEqual(
    validateToolArguments(tool, { name: 'ws_write_file', arguments: { file: 'analysis/notes.md', content: 'x' } }),
    { file: 'analysis/notes.md', content: 'x' },
  );
  assert.deepEqual(
    validateToolArguments(tool, { name: 'ws_write_file', arguments: { currentProjectId: '', projectId: '', file: 'analysis/notes.md' } }),
    { currentProjectId: '', projectId: '', file: 'analysis/notes.md' },
  );

  const result = await tool.execute('call-1', { file: 'analysis/notes.md', content: 'x' });
  assert.deepEqual(result.details.args, {
    currentProjectId: 'project-1',
    projectId: 'project-1',
    file: 'analysis/notes.md',
    content: 'x',
  });
});

test('Pi model-facing schemas still require genuinely model-supplied fields', () => {
  const tools = createPiTools({
    toolNames: ['edgar_section', 'ws_edit_file', 'fmp_transcript', 'research_digest', 'fmp_intraday'],
    toolRegistry: toolRegistry.toObject(),
    projectId: 'project-1',
    executeTool: async () => ({ result: { ok: true } }),
  });
  const edgar = tools.find((tool) => tool.name === 'edgar_section');
  const edit = tools.find((tool) => tool.name === 'ws_edit_file');
  const transcript = tools.find((tool) => tool.name === 'fmp_transcript');
  const digest = tools.find((tool) => tool.name === 'research_digest');
  const intraday = tools.find((tool) => tool.name === 'fmp_intraday');

  assert.deepEqual(
    validateToolArguments(transcript, { name: 'fmp_transcript', arguments: { quarter: '2', year: '2026' } }),
    { quarter: 2, year: 2026 },
  );
  assert.deepEqual(
    validateToolArguments(digest, { name: 'research_digest', arguments: { includeX: 'true' } }),
    { includeX: true },
  );

  assert.throws(
    () => validateToolArguments(edgar, { name: 'edgar_section', arguments: {} }),
    /url/u,
  );
  assert.throws(
    () => validateToolArguments(edit, { name: 'ws_edit_file', arguments: { file: 'report/report.md' } }),
    /oldText/u,
  );
  assert.throws(
    () => validateToolArguments(digest, { name: 'research_digest', arguments: { includeX: 'yes' } }),
    /includeX/u,
  );
  assert.throws(
    () => validateToolArguments(intraday, { name: 'fmp_intraday', arguments: { interval: 'daily' } }),
    /interval/u,
  );
});

test('runTool input validation is deterministic and rejects direct identity gaps before executor dispatch', () => {
  assert.throws(
    () => catalog.validateRunToolInput('fmp_quote', { symbol: 'NVDA', extra: true }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'unknown' && issue.path === 'extra'),
  );
  assert.throws(
    () => catalog.validateRunToolInput('fmp_quote', { symbol: 'NVDA', forceRefresh: 'yes' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'type' && issue.path === 'forceRefresh'),
  );
  assert.throws(
    () => catalog.validateRunToolInput('ws_search_library', { query: '' }),
    (error) => error.code === 'TOOL_INPUT_INVALID'
      && error.issues.some((issue) => issue.code === 'required' && issue.path === 'currentProjectId'),
  );
  assert.deepEqual(catalog.validateRunToolInput('fmp_quote', { symbol: 'NVDA', forceRefresh: true }), {
    args: { symbol: 'NVDA' },
    forceRefresh: true,
  });
});
