// Tool execution gateway and scheduler.
// Registration authority lives in toolCatalog; this module owns Agent projections,
// cache/retry behavior, health accounting, and execution normalization.
import { runtime } from '../config.js';
import { allToolHealth, classifyToolError, recordToolHealth, toolHealthStatus } from './health.js';
import { readToolCache, writeToolCache } from './cache.js';
import { pLimit } from '../lib/http.js';
import { listAgentDefinitions } from '../agents/registry.js';
import { toolRegistry, validateRunToolInput } from './toolCatalog.js';

// Frozen object view retained for existing runtime/Pi adapters.
export const TOOL_REGISTRY = toolRegistry.toObject();

const activeAgentDefinitions = listAgentDefinitions();
const activeAgentTools = new Map(activeAgentDefinitions.map((definition) => [
  definition.id,
  [...definition.toolPolicy.allow],
]));

const TOOL_META_OVERRIDES = {
  fmp_quote: { costClass: 'low', latencyClass: 'fast', freshness: { expectedMaxAgeHours: 0.5, marketData: true }, qualitySignals: ['price', 'marketCap'] },
  fmp_forward_estimates: { costClass: 'medium', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 24, marketData: false }, qualitySignals: ['fy1', 'fy2', 'analysts'] },
  fmp_income: { costClass: 'low', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 720, marketData: false }, qualitySignals: ['revenue', 'netIncome'] },
  fmp_balance_sheet: { costClass: 'low', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 720, marketData: false }, qualitySignals: ['cashAndCashEquivalents', 'totalDebt'] },
  fmp_cash_flow: { costClass: 'low', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 720, marketData: false }, qualitySignals: ['freeCashFlow', 'capitalExpenditure'] },
  edgar_filings: { costClass: 'low', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 24, marketData: false }, fallback: 'none', qualitySignals: ['form', 'filingDate'] },
  edgar_section: { freshness: { expectedMaxAgeHours: 720, marketData: false }, fallback: 'none' }, // 文档 URL 内容不可变
  fmp_transcript: { freshness: { expectedMaxAgeHours: 720, marketData: false } },                  // 指定季度 transcript 不可变
  pplx_finance: { costClass: 'high', latencyClass: 'slow', freshness: { expectedMaxAgeHours: 24, marketData: false }, fallback: 'none', qualitySignals: ['citations'] },
  pplx_sec: { costClass: 'high', latencyClass: 'slow', freshness: { expectedMaxAgeHours: 72, marketData: false }, fallback: 'none', qualitySignals: ['citations'] },
  pplx_reasoning: { costClass: 'high', latencyClass: 'slow', freshness: { expectedMaxAgeHours: 24, marketData: false }, fallback: 'none', qualitySignals: ['citations'] },
  pplx_deep_research: { costClass: 'high', latencyClass: 'slow', freshness: { expectedMaxAgeHours: 168, marketData: false }, fallback: 'none', qualitySignals: ['citations'] },
  tavily_search: { costClass: 'medium', latencyClass: 'normal', freshness: { expectedMaxAgeHours: 24, marketData: false }, fallback: 'none', qualitySignals: ['results'] },
};

// —— 默认 freshness 分层（TOOL_META_OVERRIDES 有更细定义时以 override 为准）——
// 行情/盘面 0.5h；历史/估值/报表/分析师/持仓 24h；可比公司/画像 7d；新闻与观点流 6h；日历 12h。
// 项目库(workspace)工具刻意不给 freshness → 不缓存（项目文件是活状态，缓存会读到陈旧内容）。
const FAST_MARKET_TOOLS = new Set(['fmp_quote', 'fmp_intraday', 'fmp_market_movers', 'fmp_sector', 'fmp_fx_quotes', 'fmp_commodity_quotes']);
const GROUP_DEFAULT_FRESHNESS = {
  '行情/基本面': 24, '宏观': 24, '财报': 24, '可比公司': 168, '估值': 24,
  '新闻': 6, '分析师': 24, '筛选': 24, '持仓/信号': 24, '信号': 24,
  '日历': 12, '一手材料': 24, '联网检索': 24, '网页': 24, '观点流': 6,
  // '项目库' 缺省 → null → 不缓存
};
function defaultFreshnessFor(name, t) {
  if (FAST_MARKET_TOOLS.has(name)) return { expectedMaxAgeHours: 0.5, marketData: true };
  const h = GROUP_DEFAULT_FRESHNESS[t.group];
  return { expectedMaxAgeHours: h ?? null, marketData: false };
}
const PROVIDER_LIMITS = {
  fmp: pLimit(4),
  perplexity: pLimit(2),
  tavily: pLimit(3),
  fred: pLimit(2),
  edgar: pLimit(3),
  research: pLimit(3),
};
function abortError(reason = 'tool execution aborted') {
  return Object.assign(new Error(reason), { name: 'AbortError', code: 'RUN_ABORTED' });
}

function signalFrom(value) {
  if (value?.signal) return value.signal;
  if (value && typeof value.addEventListener === 'function' && 'aborted' in value) return value;
  return null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(typeof signal.reason === 'string' ? signal.reason : undefined);
}

const sleep = (ms, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError());
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

function enrichToolMeta(name, t) {
  const agents = agentsForTool(name);
  return {
    name,
    provider: t.provider,
    group: t.group,
    desc: t.desc,
    params: t.params || [],
    agents,
    costClass: 'low',
    latencyClass: 'normal',
    freshness: defaultFreshnessFor(name, t),
    fallback: t.provider === 'fmp' ? 'demo' : (t.provider === 'edgar' || t.provider === 'research' ? 'none' : 'none'),
    qualitySignals: [],
    ...(TOOL_META_OVERRIDES[name] || {}),
  };
}
export function agentsForTool(name) {
  return activeAgentDefinitions
    .filter((definition) => definition.toolPolicy.allow.includes(name))
    .map((definition) => definition.id);
}
// 供「agent→工具」表：返回每个 agent 注册的工具名清单
export function agentToolTable() {
  return Object.fromEntries(activeAgentDefinitions.map((definition) => [
    definition.id,
    [...definition.toolPolicy.allow],
  ]));
}
// 某 agent 可用的工具名
export function toolsForAgent(agent) {
  return [...(activeAgentTools.get(agent) || [])];
}

// 工具清单（供前端工具库页面渲染），附带 provider 连接态 + agent 归属
export function listTools() {
  // research（Seeking Alpha / Substack RSS）无需 key，始终可用；x_search 无 key 时回退 Perplexity。
  const conn = { fmp: !!runtime.FMP_API_KEY, perplexity: !!runtime.PERPLEXITY_API_KEY, tavily: !!runtime.TAVILY_API_KEY, research: true, edgar: true, fred: !!runtime.FRED_API_KEY, workspace: true, worldview: true };
  return toolRegistry.entries().map(([name, t]) => ({
    ...enrichToolMeta(name, t),
    connected: !!conn[t.provider],
    health: toolHealthStatus(name, t),
  }));
}

// 执行单个工具（供测试端点 / agent 复用）。
// Catalog schema owns coercion/defaults; forceRefresh is a runTool-only control flag and is never exposed to tool executors.
export async function runTool(name, args = {}, options = {}) {
  const signal = signalFrom(options);
  throwIfAborted(signal);
  const t = toolRegistry.get(name);
  const { args: merged, forceRefresh } = validateRunToolInput(name, args);
  const meta = enrichToolMeta(name, t);
  const cacheable = t.provider !== 'worldview';
  const cache = !cacheable || forceRefresh ? null : readToolCache(name, merged, { maxAgeHours: meta.freshness?.expectedMaxAgeHours });
  if (cache) {
    const quality = summarizeToolQuality(cache.result);
    const normalized = normalizeToolResult(name, cache.result);
    recordToolHealth(name, t, { ok: !quality.errorLike, durationMs: 0, coverageScore: quality.score, ts: Date.now() });
    return { name, provider: t.provider, args: merged, result: cache.result, normalized, durationMs: 0, ok: !quality.errorLike, quality, cacheHit: true, health: toolHealthStatus(name, t) };
  }
  const started = Date.now();
  try {
    const result = await runWithProviderLimit(t, merged, { signal });
    throwIfAborted(signal);
    const durationMs = Date.now() - started;
    const quality = summarizeToolQuality(result);
    const normalized = normalizeToolResult(name, result);
    if (cacheable && !quality.errorLike) writeToolCache(name, merged, result, { maxAgeHours: meta.freshness?.expectedMaxAgeHours });
    recordToolHealth(name, t, { ok: !quality.errorLike, durationMs, coverageScore: quality.score, ts: started });
    return { name, provider: t.provider, args: merged, result, normalized, durationMs, ok: !quality.errorLike, quality, cacheHit: false, health: toolHealthStatus(name, t) };
  } catch (e) {
    const durationMs = Date.now() - started;
    recordToolHealth(name, t, { ok: false, durationMs, ts: started, ...classifyToolError(e) });
    throw e;
  }
}

export async function runPublicToolTest(name, args = {}, options = {}) {
  const tool = toolRegistry.get(name);
  if (tool.provider === 'workspace' || tool.provider === 'worldview') {
    const error = new Error('Internal scoped tools cannot run through the public test endpoint');
    error.code = tool.provider === 'workspace'
      ? 'PUBLIC_TOOL_TEST_WORKSPACE_DENIED'
      : 'PUBLIC_TOOL_TEST_WORLDVIEW_DENIED';
    error.statusCode = 403;
    throw error;
  }
  return runTool(name, args, options);
}

async function runWithProviderLimit(t, args, { signal = null } = {}) {
  if (t.provider === 'worldview') return t.run(args, { signal });
  const limit = PROVIDER_LIMITS[t.provider] || ((fn) => fn());
  return limit(() => retryToolCall(() => t.run(args, { signal }), { signal }), { signal });
}

async function retryToolCall(fn, { signal = null } = {}) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    throwIfAborted(signal);
    try {
      const result = await fn();
      throwIfAborted(signal);
      return result;
    }
    catch (e) {
      lastErr = e;
      if (signal?.aborted || e?.name === 'AbortError' || e?.code === 'RUN_ABORTED') throw abortError();
      const s = String(e?.message || e);
      if (i < 2 && /(429|rate.?limit|too many requests|5\d\d|ECONNRESET|ETIMEDOUT|timeout)/i.test(s)) {
        await sleep(300 * Math.pow(2, i) + Math.floor(Math.random() * 120), signal);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function summarizeToolQuality(result) {
  const missingFields = [];
  const warnings = [];
  const scan = Array.isArray(result) ? result : (result && typeof result === 'object' ? [result] : []);
  const errorLike = scan.some((r) => r && typeof r === 'object' && r.error);
  if (errorLike) warnings.push('result contains error field');
  if (result == null || (Array.isArray(result) && !result.length)) warnings.push('empty result');
  const score = Math.max(0, 1 - warnings.length * 0.35 - missingFields.length * 0.1);
  return { score: +score.toFixed(2), missingFields, warnings, errorLike };
}

export function normalizeToolResult(name, result) {
  const withSchema = (schema, rows, extra = {}) => ({ schema, rows: rows || [], ...extra });
  const arr = Array.isArray(result) ? result : [];
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  if (name === 'fmp_quote') {
    return {
      schema: 'quote.v1',
      row: {
        symbol: obj.symbol || null,
        name: obj.name || obj.companyName || null,
        price: obj.price ?? null,
        marketCap: obj.marketCap ?? null,
        pe: obj.pe ?? obj.peRatioTTM ?? null,
        changePct: obj.changesPercentage ?? obj.changePct ?? null,
        error: obj.error || null,
      },
    };
  }
  if (['fmp_income', 'fmp_balance_sheet', 'fmp_cash_flow', 'fmp_growth', 'fmp_estimates'].includes(name)) {
    return withSchema(`${name.replace('fmp_', '')}.v1`, arr.map((r) => ({ date: r.date || r.calendarYear || null, symbol: r.symbol || obj.symbol || null, ...r })));
  }
  if (['fmp_news', 'fmp_news_search'].includes(name)) {
    const rows = name === 'fmp_news_search' ? (obj.news || []) : (Array.isArray(result) ? result : []);
    return withSchema('news.v1', rows.map((n) => ({
      symbol: n.symbol || null,
      title: n.title || null,
      source: n.site || n.source || null,
      url: n.url || null,
      publishedAt: n.publishedDate || n.date || null,
      summary: n.text || n.summary || null,
      error: n.error || null,
    })));
  }
  if (['fmp_historical', 'fmp_market_cap_history', 'fmp_macro_asset_history'].includes(name)) {
    return withSchema('timeseries.v1', (obj.history || []).map((p) => ({
      date: p.date,
      close: p.close ?? null,
      marketCap: p.marketCap ?? null,
      volume: p.volume ?? null,
      changePct: p.changePercent ?? null,
    })), { symbol: obj.symbol || null });
  }
  if (['fmp_fx_quotes', 'fmp_commodity_quotes'].includes(name)) {
    return withSchema('macro_quotes.v1', (obj.quotes || []).map((q) => ({
      symbol: q.symbol,
      name: q.name || null,
      price: q.price ?? null,
      changePct: q.changePct ?? null,
      timestamp: q.timestamp ?? null,
    })));
  }
  if (name === 'fmp_forward_estimates') {
    return { schema: 'forward_estimates.v1', symbol: obj.symbol || null, fy1: obj.fy1 || null, fy2: obj.fy2 || null, years: obj.years || [], error: obj.error || null };
  }
  return { schema: 'raw.v1', valueType: Array.isArray(result) ? 'array' : typeof result, rows: Array.isArray(result) ? result : undefined };
}

export async function checkToolHealth(name) {
  const t = toolRegistry.get(name);
  try {
    const r = await runTool(name, {});
    return { name, ok: true, health: r.health, durationMs: r.durationMs, quality: r.quality };
  } catch (e) {
    return { name, ok: false, health: toolHealthStatus(name, t), error: String(e.message || e) };
  }
}

export async function checkAllToolHealth({ limit = 12 } = {}) {
  const names = toolRegistry.ids().slice(0, limit);
  const results = [];
  for (const name of names) results.push(await checkToolHealth(name));
  return { checked: results.length, results, health: allToolHealth(TOOL_REGISTRY) };
}

export function toolHealth() {
  return allToolHealth(TOOL_REGISTRY);
}
