import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ToolRegistry } from '../src/core/tools/ToolRegistry.js';
import { getAgentDefinition, listAgentDefinitions } from '../src/agents/registry.js';
import { toolRegistry } from '../src/tools/toolCatalog.js';
import { TOOL_REGISTRY, agentToolTable, listTools, normalizeToolResult, runTool, toolsForAgent } from '../src/tools/index.js';
import { allToolHealth, recordToolHealth } from '../src/tools/health.js';

const EXPECTED_TOOL_IDS = Object.freeze([
  'fmp_quote', 'fmp_profile', 'fmp_transcript', 'fmp_peers', 'fmp_comps',
  'fmp_valuation_history', 'fmp_news', 'fmp_ratios', 'fmp_key_metrics',
  'fmp_price_target', 'fmp_estimates', 'fmp_forward_estimates', 'fmp_income',
  'fmp_balance_sheet', 'fmp_cash_flow', 'fmp_growth', 'fmp_historical',
  'fmp_intraday', 'fmp_market_cap_history', 'fmp_insider', 'fmp_earnings_surprise',
  'fmp_dcf', 'fmp_rating', 'fmp_sector', 'fmp_screener', 'fmp_institutional',
  'fmp_grade_changes', 'fmp_sec_filings', 'fmp_revenue_product', 'fmp_revenue_geo',
  'fmp_enterprise_values', 'fmp_financial_score', 'fmp_shares_float',
  'fmp_short_interest', 'fmp_etf_holders', 'fmp_dividends', 'fmp_treasury',
  'fmp_economic', 'fmp_market_movers', 'fmp_fx_quotes', 'fmp_commodity_quotes',
  'fmp_macro_asset_history', 'fmp_ipo_calendar', 'fmp_news_search',
  'fmp_earnings_calendar', 'fmp_upcoming_earnings', 'fmp_economic_calendar',
  'edgar_filings', 'edgar_fulltext', 'edgar_section', 'fred_series', 'pplx_search',
  'pplx_finance', 'pplx_ask_page', 'pplx_sec', 'pplx_reasoning',
  'pplx_deep_research', 'tavily_search', 'tavily_extract', 'sa_symbol', 'sa_latest',
  'substack_feed', 'social_sentiment', 'x_search', 'research_digest',
  'worldview_read_current', 'worldview_enumerate_overviews',
  'worldview_read_report_version', 'worldview_search_claims',
  'project_search', 'project_read_file', 'project_write_current_file',
  'project_append_current_file', 'ws_list_files', 'ws_read_file',
  'ws_search_library', 'ws_write_file', 'ws_append_file', 'ws_edit_file',
]);
const EXPECTED_CATALOG_METADATA_SHA256 = 'ae8a170e4c62cb60a62cb3a4433787343efc83da01d323fa95ae3f0aaefb22cc';

test('ToolRegistry rejects duplicate ids and preserves registration order', () => {
  const registry = new ToolRegistry([
    ['alpha', { provider: 'unit', group: 'test', desc: 'A', params: [], run: async () => 'a' }],
    ['beta', { provider: 'unit', group: 'test', desc: 'B', params: [], run: async () => 'b' }],
  ]);

  assert.deepEqual(registry.ids(), ['alpha', 'beta']);
  assert.throws(
    () => registry.register('alpha', { provider: 'unit', group: 'test', desc: 'duplicate', run: async () => null }),
    /duplicate tool: alpha/u,
  );
  assert.deepEqual(registry.ids(), ['alpha', 'beta']);
});

test('ToolRegistry supports lookup, listing, execution, and a frozen compatibility view', async () => {
  const run = async ({ value }) => ({ doubled: value * 2 });
  const registry = new ToolRegistry([
    ['double', { provider: 'unit', group: 'test', desc: 'Double', params: [{ name: 'value' }], run }],
  ]);

  assert.equal(registry.has('double'), true);
  assert.equal(registry.get('double').run, run);
  assert.deepEqual(registry.list().map(({ name, provider, group, desc, params }) => ({ name, provider, group, desc, params })), [
    { name: 'double', provider: 'unit', group: 'test', desc: 'Double', params: [{ name: 'value' }] },
  ]);
  assert.deepEqual(await registry.execute('double', { value: 4 }), { doubled: 8 });
  assert.throws(() => registry.get('missing'), /unknown tool: missing/u);
  await assert.rejects(() => registry.execute('missing', {}), /unknown tool: missing/u);

  const compatibility = registry.toObject();
  assert.equal(Object.isFrozen(compatibility), true);
  assert.deepEqual(Object.keys(compatibility), ['double']);
  assert.equal(compatibility.double, registry.get('double'));
});

test('single catalog preserves all 79 tool ids and exact registration metadata', () => {
  assert.deepEqual(toolRegistry.ids(), EXPECTED_TOOL_IDS);
  assert.deepEqual(Object.keys(TOOL_REGISTRY), EXPECTED_TOOL_IDS);
  for (const id of EXPECTED_TOOL_IDS) assert.equal(TOOL_REGISTRY[id], toolRegistry.get(id));

  const projection = toolRegistry.entries().map(([name, tool]) => ({
    name,
    provider: tool.provider,
    group: tool.group,
    desc: tool.desc,
    params: tool.params || [],
  }));
  const digest = crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
  assert.equal(digest, EXPECTED_CATALOG_METADATA_SHA256);
});

test('Tool Registry owns registrations but contains no Agent permission policy', async () => {
  const [registrySource, facadeSource] = await Promise.all([
    readFile(new URL('../src/core/tools/ToolRegistry.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/index.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(registrySource, /AGENT_TOOLSETS|ANALYSIS_TOOLS|agentToolTable|toolsForAgent|toolPolicy/u);
  assert.doesNotMatch(facadeSource, /AGENT_TOOLSETS|ANALYSIS_TOOLS|WS_READ_TOOLS|WS_RW_TOOLS/u);
  assert.match(facadeSource, /listAgentDefinitions/u);
  for (const [, tool] of toolRegistry.entries()) {
    assert.equal('agents' in tool, false);
    assert.equal('allow' in tool, false);
    assert.equal('toolPolicy' in tool, false);
  }
});

test('toolsForAgent: fine-grained agent registrations are scoped', () => {
  for (const id of ['data-orchestrator', 'company-analyst', 'report-composer']) {
    assert.deepEqual(toolsForAgent(id), [...getAgentDefinition(id).toolPolicy.allow]);
  }
  assert.deepEqual(toolsForAgent('unknown-agent'), []);
});

test('agentToolTable is derived only from active Agent definitions', () => {
  const table = agentToolTable();
  assert.deepEqual(Object.keys(table), listAgentDefinitions().map((definition) => definition.id));
  for (const definition of listAgentDefinitions()) {
    assert.deepEqual(table[definition.id], [...definition.toolPolicy.allow]);
  }
  for (const obsoleteId of ['news-idea-agent', 'company-orchestrator', 'data-adaptor', 'forecast-agent']) {
    assert.equal(obsoleteId in table, false);
  }
});

test('listTools includes metadata and health shape', () => {
  const quote = listTools().find((t) => t.name === 'fmp_quote');
  assert.equal(quote.costClass, 'low');
  assert.equal(quote.freshness.marketData, true);
  assert.ok(Array.isArray(quote.agents));
  assert.ok(quote.health.status);
  assert.deepEqual(Object.keys(quote).sort(), [
    'agents', 'connected', 'costClass', 'desc', 'fallback', 'freshness', 'group',
    'health', 'latencyClass', 'name', 'params', 'provider', 'qualitySignals',
  ]);
});

test('runTool wraps demo result with quality and health', async () => {
  const r = await runTool('fmp_quote', { symbol: 'AAPL' });
  assert.equal(r.name, 'fmp_quote');
  assert.equal(r.provider, 'fmp');
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(typeof r.quality.score, 'number');
  assert.equal(r.normalized.schema, 'quote.v1');
  assert.deepEqual(Object.keys(r).sort(), [
    'args', 'cacheHit', 'durationMs', 'health', 'name', 'normalized', 'ok',
    'provider', 'quality', 'result',
  ]);
});

test('tool health aggregation records provider status', () => {
  recordToolHealth('unit_tool', { provider: 'unit' }, { ok: true, durationMs: 12, ts: Date.now(), coverageScore: 0.8 });
  const h = allToolHealth({ unit_tool: { provider: 'unit' } });
  assert.equal(h.tools.unit_tool.status, 'healthy');
  assert.equal(h.providers.unit.provider, 'unit');
});

test('normalizers expose stable rows for news and macro quotes', () => {
  const news = normalizeToolResult('fmp_news', [{ symbol: 'NVDA', title: 'x', site: 'demo', publishedDate: '2026-01-01' }]);
  assert.equal(news.schema, 'news.v1');
  assert.equal(news.rows[0].source, 'demo');
  const macro = normalizeToolResult('fmp_fx_quotes', { quotes: [{ symbol: 'EURUSD', price: 1.1 }] });
  assert.equal(macro.schema, 'macro_quotes.v1');
  assert.equal(macro.rows[0].symbol, 'EURUSD');
});
