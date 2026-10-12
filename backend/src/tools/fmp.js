// 外部工具库 - FMP 数据抓取工具（含演示回退）
// 文档：https://site.financialmodelingprep.com/developer/docs
import { runtime } from '../config.js';
import { fetchJSON } from '../lib/http.js';
import { readToolCache, writeToolCache } from './cache.js';

const V3 = 'https://financialmodelingprep.com/api/v3';
const V4 = 'https://financialmodelingprep.com/api/v4';

async function fmpGet(url, params = {}, opts = {}) {
  const key = runtime.FMP_API_KEY;
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  // 统一超时(15s)+重试，避免数据源卡死整条分析链；opts 可覆盖（批量因子抓取走 best-effort）
  return fetchJSON(`${url}?${qs}`, { timeoutMs: opts.timeoutMs ?? 15000, retries: opts.retries ?? 2 });
}

// ---- 磁盘缓存封装 ----
// 多轮分析里基本面/估值/纪要等慢变数据在 TTL 内直接命中磁盘，避免同一标的每轮重复抓取。
// 只有「有 FMP key 且结果既非 demo 又非 error」才写缓存——demo 兜底与失败结果永不落盘，
// 保证下次分析不会把编造/缺失的数据当成真实值复用。
function isBadResult(result) {
  const bad = (o) => !o || typeof o !== 'object' || o._demo || o.error;
  if (Array.isArray(result)) return !result.length || result.some(bad);
  return bad(result);
}
async function cached(name, args, ttlHours, fn) {
  if (!runtime.FMP_API_KEY) return fn(); // 无 key 走 demo，不缓存
  // 命名空间前缀：与 tools/index.js 的「工具层缓存」隔离——后者用相同的 cache 模块与同名 key
  // (fmp_profile / fmp_dcf …) 但存的是工具封装后的结果，直接同名会 SHA1 撞同一文件、互相覆盖。
  const nsName = `fmpfn_${name}`;
  const hit = readToolCache(nsName, args, { maxAgeHours: ttlHours });
  if (hit) return hit.result;
  const result = await fn();
  if (!isBadResult(result)) writeToolCache(nsName, args, result, { maxAgeHours: ttlHours });
  return result;
}

function demoQuote(symbol) {
  const base = 100 + (symbol.charCodeAt(0) % 50) * 3;
  const change = (Math.random() - 0.45) * 6;
  return {
    symbol, name: symbol, price: +(base + change).toFixed(2),
    change: +change.toFixed(2), changesPercentage: +(change / base * 100).toFixed(2),
    marketCap: Math.round((base * 1e8) * (1 + Math.random())), pe: +(15 + Math.random() * 25).toFixed(1),
    _demo: true,
  };
}

// ===== 行情 / 基本面（原有） =====
// 数据可信底线：demo 兜底只在「无 key」时生效。有 key 但请求失败时返回 error 标记（price 等字段为空），
// 让下游按「数据缺失」处理，绝不把编造的价格/PE 混进真实分析与虚拟盘。
export async function getQuote(symbol) {
  if (!runtime.FMP_API_KEY) return demoQuote(symbol);
  try { return (await fmpGet(`${V3}/quote/${symbol}`))?.[0] || { symbol, price: null, error: 'no data' }; }
  catch (e) { return { symbol, price: null, error: String(e.message || e) }; }
}

export async function getQuotes(symbols = []) {
  const list = symbols.filter(Boolean);
  if (!list.length) return [];
  if (!runtime.FMP_API_KEY) return list.map(demoQuote);
  try {
    const data = await fmpGet(`${V3}/quote/${list.join(',')}`);
    if (Array.isArray(data) && data.length) return data;
    return list.map((s) => ({ symbol: s, price: null, error: 'no data' }));
  } catch (e) { return list.map((s) => ({ symbol: s, price: null, error: String(e.message || e) })); }
}

export async function getProfile(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, companyName: symbol, sector: '演示行业', industry: '演示', description: '演示公司简介。', _demo: true };
  return cached('fmp_profile', { symbol }, 24, async () => {
    try { return (await fmpGet(`${V3}/profile/${symbol}`))?.[0] || { symbol, companyName: symbol, error: 'no data' }; }
    catch (e) { return { symbol, companyName: symbol, error: String(e.message || e) }; }
  });
}

// ===== 财报电话会议纪要 transcript =====
export async function getTranscript(symbol, { quarter, year } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, quarter, year, content: '【演示】未配置 FMP key，无法获取财报电话会纪要。', _demo: true };
  return cached('fmp_transcript', { symbol, quarter, year }, 24, async () => {
    try {
      const params = {};
      if (quarter) params.quarter = quarter;
      if (year) params.year = year;
      const data = await fmpGet(`${V3}/earning_call_transcript/${symbol}`, params);
      const r = Array.isArray(data) ? data[0] : data;
      if (!r) return { symbol, content: '', note: '无可用纪要' };
      // 保留全文（transcript 是信息密度最高的一手来源，此前 16K 截断丢了大半）；下游按需分页读。
      return { symbol: r.symbol, quarter: r.quarter, year: r.year, date: r.date, content: (r.content || '').slice(0, 60000), length: (r.content || '').length };
    } catch (e) { return { symbol, content: '', error: String(e.message || e) }; }
  });
}

// ===== 可比公司 peers（用于 comps） =====
export async function getPeers(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, peers: ['AAPL', 'MSFT', 'GOOGL'], _demo: true };
  try {
    const data = await fmpGet(`${V4}/stock_peers`, { symbol });
    return { symbol, peers: data?.[0]?.peersList || [] };
  } catch (e) { return { symbol, peers: [], error: String(e.message || e) }; }
}

// ===== 同业对比表 comps：peers + 各自估值/增速/利润率（横向交叉验证"贵/便宜"） =====
// include：强制并入的可比（FMP peers 可能给出不合理集合，如 GOOGL 配 TSM/NVDA——
// 调用方应把主题候选标的传入，保证 comps 集合与投资逻辑一致）。
export async function getComps(symbol, { maxPeers = 6, include = [] } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, rows: [], _demo: true };
  return cached('fmp_comps', { symbol, maxPeers, include: [...include].sort() }, 24, () => _getComps(symbol, { maxPeers, include }));
}
async function _getComps(symbol, { maxPeers = 6, include = [] } = {}) {
  try {
    const { peers } = await getPeers(symbol);
    const names = [symbol, ...include, ...(peers || [])].map((s) => String(s).toUpperCase()).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, maxPeers + 1);
    const quotes = await getQuotes(names);
    const qmap = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
    const rows = await Promise.all(names.map(async (t) => {
      const [ratios, growth, est] = await Promise.all([
        getRatios(t).catch(() => ({})),
        getFinancialGrowth(t, { limit: 1 }).catch(() => ([])),
        getForwardEstimates(t).catch(() => ({})),
      ]);
      const g = Array.isArray(growth) ? growth[0] : growth;
      const m = forwardMultiples(qmap[t] || {}, est || {});
      return {
        ticker: t, isTarget: t === String(symbol).toUpperCase(),
        price: qmap[t]?.price ?? null, marketCap: qmap[t]?.marketCap ?? null,
        pe: ratios?.peRatioTTM ?? null, ps: ratios?.priceToSalesRatioTTM ?? null,
        fwdPE1: m.fwdPE1 ?? null, fwdPEG: m.fwdPEG ?? null,
        grossMargin: ratios?.grossProfitMarginTTM ?? null, roe: ratios?.returnOnEquityTTM ?? null,
        revenueGrowth: g?.revenueGrowth ?? null,
      };
    }));
    return { symbol, rows: rows.filter((r) => r.price != null || r.pe != null) };
  } catch (e) { return { symbol, rows: [], error: String(e.message || e) }; }
}

// ===== 股票新闻 news =====
export async function getNews(tickers = [], limit = 8) {
  const list = (Array.isArray(tickers) ? tickers : [tickers]).filter(Boolean);
  if (!runtime.FMP_API_KEY) return list.map((t, i) => ({ symbol: t, title: `【演示】${t} 相关新闻 ${i + 1}`, site: 'demo', text: '配置 FMP key 后显示真实新闻。', _demo: true }));
  try {
    const params = { limit };
    if (list.length) params.tickers = list.join(',');
    const data = await fmpGet(`${V3}/stock_news`, params);
    return (data || []).map((n) => ({ symbol: n.symbol, title: n.title, site: n.site, url: n.url, publishedDate: n.publishedDate, text: (n.text || '').slice(0, 600) }));
  } catch (e) { return [{ error: String(e.message || e) }]; }
}

// ===== 财务比率 TTM（估值/盈利能力） =====
export async function getRatios(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, peRatioTTM: 22.5, pegRatioTTM: 1.8, priceToSalesRatioTTM: 6.2, _demo: true };
  return cached('fmp_ratios_ttm', { symbol }, 12, async () => {
    try { return (await fmpGet(`${V3}/ratios-ttm/${symbol}`))?.[0] || { symbol }; }
    catch (e) { return { symbol, error: String(e.message || e) }; }
  });
}

// ===== 关键指标 TTM =====
export async function getKeyMetrics(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, revenuePerShareTTM: 25, freeCashFlowPerShareTTM: 6, _demo: true };
  return cached('fmp_key_metrics_ttm', { symbol }, 12, async () => {
    try { return (await fmpGet(`${V3}/key-metrics-ttm/${symbol}`))?.[0] || { symbol }; }
    catch (e) { return { symbol, error: String(e.message || e) }; }
  });
}

// ===== 分析师目标价汇总 =====
export async function getPriceTarget(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, lastQuarterAvgPriceTarget: 0, _demo: true };
  return cached('fmp_price_target', { symbol }, 12, async () => {
    try { return (await fmpGet(`${V4}/price-target-summary`, { symbol }))?.[0] || { symbol }; }
    catch (e) { return { symbol, error: String(e.message || e) }; }
  });
}

// ===== 分析师预期（营收/利润预测） =====
export async function getAnalystEstimates(symbol, limit = 4) {
  if (!runtime.FMP_API_KEY) return [{ symbol, _demo: true }];
  try { return (await fmpGet(`${V3}/analyst-estimates/${symbol}`, { limit })) || []; }
  catch (e) { return [{ symbol, error: String(e.message || e) }]; }
}

// ===== 前瞻分析师预期（归一化为最近的未来 2 个财年 FY1/FY2，供前瞻估值倍数） =====
// 卖方共识的营收/EPS/EBITDA 预测，是计算 fwd P/E、fwd P/S 与「与共识对比」的基础。
export async function getForwardEstimates(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, fy1: null, fy2: null, _demo: true };
  return cached('fmp_forward_estimates', { symbol }, 12, () => _getForwardEstimates(symbol));
}
async function _getForwardEstimates(symbol) {
  try {
    const raw = (await fmpGet(`${V3}/analyst-estimates/${symbol}`, { limit: 8 })) || [];
    const now = Date.now();
    const norm = (e) => e && ({
      date: e.date, fy: (e.date || '').slice(0, 4),
      revenue: e.estimatedRevenueAvg, eps: e.estimatedEpsAvg, ebitda: e.estimatedEbitdaAvg, netIncome: e.estimatedNetIncomeAvg,
      analysts: e.numberAnalystsEstimatedEps || e.numberAnalystEstimatedRevenue || 0,
    });
    // 取「未来」财年，按日期升序，FY1=最近一个未来财年
    const future = raw.filter((e) => e.date && new Date(e.date).getTime() >= now - 86400000 * 60)
      .sort((a, b) => new Date(a.date) - new Date(b.date)).map(norm);
    return { symbol, fy1: future[0] || null, fy2: future[1] || null, years: future.slice(0, 4) };
  } catch (e) { return { symbol, fy1: null, fy2: null, error: String(e.message || e) }; }
}

// 给定行情(价格/市值)与前瞻预期，计算前瞻估值倍数（增长股的正确估值口径）。
export function forwardMultiples(quote = {}, est = {}) {
  const price = quote.price, mcap = quote.marketCap;
  const r = {};
  const div = (a, b) => (a && b && b !== 0 ? +(a / b).toFixed(2) : null);
  if (est.fy1) {
    r.fwdPE1 = div(price, est.fy1.eps);
    r.fwdPS1 = div(mcap, est.fy1.revenue);
    r.fwdPEBITDA1 = div(mcap, est.fy1.ebitda);
    r.fy1 = est.fy1.fy; r.fy1Analysts = est.fy1.analysts;
  }
  if (est.fy2) { r.fwdPE2 = div(price, est.fy2.eps); r.fy2 = est.fy2.fy; }
  // 共识隐含的前瞻增速
  if (est.fy1 && est.fy2) {
    r.estRevGrowthFwd = est.fy1.revenue ? +(((est.fy2.revenue - est.fy1.revenue) / est.fy1.revenue) * 100).toFixed(1) : null;
    r.estEpsGrowthFwd = est.fy1.eps ? +(((est.fy2.eps - est.fy1.eps) / Math.abs(est.fy1.eps)) * 100).toFixed(1) : null;
    // PEG 分母：优先用可得未来财年的 EPS CAGR（FY1→FYn），单年 FY1→FY2 增速噪音大
    const yrs = (est.years || []).filter((y) => y && typeof y.eps === 'number' && y.eps > 0);
    let growthForPeg = r.estEpsGrowthFwd;
    if (yrs.length >= 3) {
      const first = yrs[0].eps, lastE = yrs[yrs.length - 1].eps;
      const cagr = +((Math.pow(lastE / first, 1 / (yrs.length - 1)) - 1) * 100).toFixed(1);
      if (isFinite(cagr)) { growthForPeg = cagr; r.estEpsCagrFwd = cagr; }
    }
    if (r.fwdPE1 && growthForPeg > 0) r.fwdPEG = +(r.fwdPE1 / growthForPeg).toFixed(2);
  }
  return r;
}

// ===== 历史估值分位：近 N 年季度 PE/PS 分布（"贵/便宜"的历史锚）。分位用 percentileRank 计算 =====
export function percentileRank(cur, arr = []) {
  if (cur == null || !(cur > 0) || arr.length < 8) return null;
  return +((arr.filter((x) => x <= cur).length / arr.length) * 100).toFixed(0);
}
export async function getValuationHistory(symbol, { quarters = 20 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, peSeries: [], psSeries: [], _demo: true };
  return cached('fmp_valuation_history', { symbol, quarters }, 12, () => _getValuationHistory(symbol, { quarters }));
}
async function _getValuationHistory(symbol, { quarters = 20 } = {}) {
  try {
    const data = (await fmpGet(`${V3}/ratios/${symbol}`, { period: 'quarter', limit: quarters })) || [];
    const series = (k) => data.map((d) => d?.[k]).filter((x) => typeof x === 'number' && isFinite(x) && x > 0);
    const range = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return { min: +s[0].toFixed(1), median: +s[Math.floor(s.length / 2)].toFixed(1), max: +s[s.length - 1].toFixed(1) };
    };
    const pe = series('priceEarningsRatio'), ps = series('priceToSalesRatio');
    return { symbol, quarters: data.length, peSeries: pe, psSeries: ps, peRange: range(pe), psRange: range(ps) };
  } catch (e) { return { symbol, peSeries: [], psSeries: [], error: String(e.message || e) }; }
}

// ===== 利润表（最近若干期） =====
export async function getIncomeStatement(symbol, { period = 'annual', limit = 3 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, revenue: 0, netIncome: 0, _demo: true }];
  return cached('fmp_income_statement', { symbol, period, limit }, 12, async () => {
    try { return (await fmpGet(`${V3}/income-statement/${symbol}`, { period, limit })) || []; }
    catch (e) { return [{ symbol, error: String(e.message || e) }]; }
  });
}

// ===== 资产负债表（杠杆/现金/营运资本） =====
export async function getBalanceSheet(symbol, { period = 'annual', limit = 3 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, totalDebt: 0, cashAndCashEquivalents: 0, _demo: true }];
  return cached('fmp_balance_sheet', { symbol, period, limit }, 12, async () => {
    try { return (await fmpGet(`${V3}/balance-sheet-statement/${symbol}`, { period, limit })) || []; }
    catch (e) { return [{ symbol, error: String(e.message || e) }]; }
  });
}

// ===== 现金流量表（FCF/资本开支/经营现金流） =====
export async function getCashFlow(symbol, { period = 'annual', limit = 3 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, freeCashFlow: 0, capitalExpenditure: 0, _demo: true }];
  return cached('fmp_cash_flow', { symbol, period, limit }, 12, async () => {
    try { return (await fmpGet(`${V3}/cash-flow-statement/${symbol}`, { period, limit })) || []; }
    catch (e) { return [{ symbol, error: String(e.message || e) }]; }
  });
}

// ===== 财务成长性（营收/利润/FCF 增速） =====
export async function getFinancialGrowth(symbol, { period = 'annual', limit = 4 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, revenueGrowth: 0.2, epsgrowth: 0.25, _demo: true }];
  return cached('fmp_financial_growth', { symbol, period, limit }, 12, async () => {
    try { return (await fmpGet(`${V3}/financial-growth/${symbol}`, { period, limit })) || []; }
    catch (e) { return [{ symbol, error: String(e.message || e) }]; }
  });
}

// ===== 历史行情（计算动量/区间收益，供推演与择时） =====
export async function getHistoricalPrice(symbol, { days = 120 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, history: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/historical-price-full/${symbol}`, { timeseries: days });
    const hist = (data?.historical || []).slice(0, days).map((d) => ({ date: d.date, close: d.close, changePercent: d.changePercent, volume: d.volume }));
    // 派生动量指标，便于 agent 直接使用
    const closes = hist.map((h) => h.close).filter((x) => typeof x === 'number');
    const ret = (n) => (closes.length > n ? +(((closes[0] - closes[n]) / closes[n]) * 100).toFixed(2) : null);
    return { symbol, history: hist, momentum: { ret1m: ret(21), ret3m: ret(63), high: Math.max(...closes), low: Math.min(...closes) } };
  } catch (e) { return { symbol, history: [], error: String(e.message || e) }; }
}

export async function getIntradayPrice(symbol, { interval = '5min', limit = 78 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, interval, bars: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/historical-chart/${interval}/${symbol}`);
    return { symbol, interval, bars: (data || []).slice(0, limit).map((d) => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume })) };
  } catch (e) { return { symbol, interval, bars: [], error: String(e.message || e) }; }
}

export async function getMarketCapHistory(symbol, { limit = 120 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, history: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/historical-market-capitalization/${symbol}`, { limit });
    return { symbol, history: (data || []).slice(0, limit).map((d) => ({ date: d.date, marketCap: d.marketCap })) };
  } catch (e) { return { symbol, history: [], error: String(e.message || e) }; }
}

// ===== 内部人交易（信号：高管增减持） =====
export async function getInsiderTrading(symbol, { limit = 20 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, trades: [], _demo: true };
  try {
    const data = await fmpGet(`${V4}/insider-trading`, { symbol, page: 0, limit });
    const trades = (data || []).map((t) => ({ date: t.transactionDate, name: t.reportingName, type: t.transactionType, shares: t.securitiesTransacted, price: t.price }));
    const buys = trades.filter((t) => /P-|Purchase|Buy/i.test(t.type || '')).length;
    const sells = trades.filter((t) => /S-|Sale|Sell/i.test(t.type || '')).length;
    return { symbol, trades: trades.slice(0, 12), summary: { buys, sells, bias: buys > sells ? '净增持' : (sells > buys ? '净减持' : '中性') } };
  } catch (e) { return { symbol, trades: [], error: String(e.message || e) }; }
}

// ===== 业绩超预期历史（beat/miss 记录） =====
export async function getEarningsSurprises(symbol, { limit = 8 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, _demo: true }];
  return cached('fmp_earnings_surprises', { symbol, limit }, 12, async () => {
    try {
      const data = await fmpGet(`${V3}/earnings-surprises/${symbol}`);
      return (data || []).slice(0, limit).map((e) => ({ date: e.date, actualEPS: e.actualEarningResult, estimatedEPS: e.estimatedEarning, surprisePct: e.estimatedEarning ? +(((e.actualEarningResult - e.estimatedEarning) / Math.abs(e.estimatedEarning)) * 100).toFixed(1) : null }));
    } catch (e) { return [{ symbol, error: String(e.message || e) }]; }
  });
}

// ===== FMP 内置 DCF 估值（与自研估值子 agent 交叉验证） =====
export async function getDCF(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, dcf: 0, _demo: true };
  return cached('fmp_dcf', { symbol }, 12, async () => {
    try { return (await fmpGet(`${V3}/discounted-cash-flow/${symbol}`))?.[0] || { symbol }; }
    catch (e) { return { symbol, error: String(e.message || e) }; }
  });
}

// ===== 分析师评级共识（强买/买/持有/卖出分布） =====
export async function getRating(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, rating: '—', _demo: true };
  try { return (await fmpGet(`${V3}/rating/${symbol}`))?.[0] || { symbol }; }
  catch (e) { return { symbol, error: String(e.message || e) }; }
}

// ===== 板块表现（宏观/轮动视角） =====
export async function getSectorPerformance() {
  if (!runtime.FMP_API_KEY) return { sectors: [], _demo: true };
  return cached('fmp_sector_performance', {}, 6, async () => {
    try { return { sectors: (await fmpGet(`${V3}/sectors-performance`)) || [] }; }
    catch (e) { return { sectors: [], error: String(e.message || e) }; }
  });
}

// ===== 股票筛选器（按行业/市值/估值发现标的，辅助 idea 落地） =====
export async function screenStocks({ sector, marketCapMoreThan, betaLowerThan, limit = 15, exchange = 'NASDAQ,NYSE' } = {}) {
  if (!runtime.FMP_API_KEY) return { results: [], _demo: true };
  try {
    const params = { limit, exchange, isActivelyTrading: true };
    if (sector) params.sector = sector;
    if (marketCapMoreThan) params.marketCapMoreThan = marketCapMoreThan;
    if (betaLowerThan) params.betaLowerThan = betaLowerThan;
    const data = await fmpGet(`${V3}/stock-screener`, params);
    return { results: (data || []).map((s) => ({ symbol: s.symbol, name: s.companyName, sector: s.sector, marketCap: s.marketCap, price: s.price, beta: s.beta })) };
  } catch (e) { return { results: [], error: String(e.message || e) }; }
}

// ===== 机构持仓（13F 主力持有人） =====
export async function getInstitutionalOwnership(symbol, { limit = 12 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, holders: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/institutional-holder/${symbol}`);
    return { symbol, holders: (data || []).slice(0, limit).map((h) => ({ holder: h.holder, shares: h.shares, change: h.change, date: h.dateReported })) };
  } catch (e) { return { symbol, holders: [], error: String(e.message || e) }; }
}

// ===== 分析师评级变动（上调/下调 grade changes） =====
export async function getUpgradesDowngrades(symbol, { limit = 15 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, changes: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/grade/${symbol}`, { limit });
    const changes = (data || []).slice(0, limit).map((g) => ({ date: g.date, firm: g.gradingCompany, from: g.previousGrade, to: g.newGrade }));
    const up = changes.filter((c) => /buy|outperform|overweight|strong/i.test(c.to || '')).length;
    const down = changes.filter((c) => /sell|underperform|underweight/i.test(c.to || '')).length;
    return { symbol, changes, summary: { up, down, bias: up > down ? '偏上调' : (down > up ? '偏下调' : '中性') } };
  } catch (e) { return { symbol, changes: [], error: String(e.message || e) }; }
}

// ===== SEC 备案（10-K/10-Q/8-K 等） =====
export async function getSecFilings(symbol, { limit = 12 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, filings: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/sec_filings/${symbol}`, { limit });
    return { symbol, filings: (data || []).slice(0, limit).map((f) => ({ type: f.type, date: f.fillingDate || f.acceptedDate, link: f.finalLink })) };
  } catch (e) { return { symbol, filings: [], error: String(e.message || e) }; }
}

// ===== 收入结构：按产品线拆分 =====
export async function getRevenueByProduct(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, segments: [], _demo: true };
  try {
    const data = await fmpGet(`${V4}/revenue-product-segmentation`, { symbol, structure: 'flat', period: 'annual' });
    const latest = Array.isArray(data) && data.length ? data[0] : data;
    const key = latest ? Object.keys(latest)[0] : null;
    return { symbol, period: key, segments: latest && key ? latest[key] : (latest || {}) };
  } catch (e) { return { symbol, segments: [], error: String(e.message || e) }; }
}

// ===== 收入结构：按地区拆分 =====
export async function getRevenueByGeo(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, segments: [], _demo: true };
  try {
    const data = await fmpGet(`${V4}/revenue-geographic-segmentation`, { symbol, structure: 'flat', period: 'annual' });
    const latest = Array.isArray(data) && data.length ? data[0] : data;
    const key = latest ? Object.keys(latest)[0] : null;
    return { symbol, period: key, segments: latest && key ? latest[key] : (latest || {}) };
  } catch (e) { return { symbol, segments: [], error: String(e.message || e) }; }
}

// ===== 企业价值（EV / EV倍数） =====
export async function getEnterpriseValues(symbol, { limit = 3 } = {}) {
  if (!runtime.FMP_API_KEY) return [{ symbol, _demo: true }];
  try { return (await fmpGet(`${V3}/enterprise-values/${symbol}`, { limit })) || []; }
  catch (e) { return [{ symbol, error: String(e.message || e) }]; }
}

// ===== 财务健康度评分（Piotroski / Altman Z） =====
export async function getFinancialScore(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, _demo: true };
  try {
    const d = (await fmpGet(`${V4}/score`, { symbol }))?.[0] || {};
    return { symbol, piotroskiScore: d.piotroskiScore, altmanZScore: d.altmanZScore, workingCapital: d.workingCapital };
  } catch (e) { return { symbol, error: String(e.message || e) }; }
}

// ===== 流通股本 / 内部人+机构持股比例 =====
export async function getSharesFloat(symbol) {
  if (!runtime.FMP_API_KEY) return { symbol, _demo: true };
  try {
    const d = (await fmpGet(`${V4}/shares_float`, { symbol }))?.[0] || {};
    return { symbol, freeFloat: d.freeFloat, floatShares: d.floatShares, outstandingShares: d.outstandingShares };
  } catch (e) { return { symbol, error: String(e.message || e) }; }
}

export async function getShortInterest(symbol, { limit = 12 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, records: [], _demo: true };
  try {
    const data = await fmpGet(`${V4}/short_interest`, { symbol });
    return { symbol, records: (data || []).slice(0, limit).map((d) => ({ date: d.date, shortInterest: d.shortInterest, float: d.float, daysToCover: d.daysToCover })) };
  } catch (e) { return { symbol, records: [], error: String(e.message || e) }; }
}

export async function getEtfHolders(symbol, { limit = 20 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, holders: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/etf-holder/${symbol}`);
    return { symbol, holders: (data || []).slice(0, limit).map((d) => ({ etf: d.asset || d.symbol, name: d.name, shares: d.sharesNumber, weight: d.weightPercentage })) };
  } catch (e) { return { symbol, holders: [], error: String(e.message || e) }; }
}

// ===== 分红历史 =====
export async function getDividends(symbol, { limit = 8 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, dividends: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/historical-price-full/stock_dividend/${symbol}`);
    return { symbol, dividends: (data?.historical || []).slice(0, limit).map((x) => ({ date: x.date, dividend: x.dividend, yield: x.yield })) };
  } catch (e) { return { symbol, dividends: [], error: String(e.message || e) }; }
}

// ===== 美债收益率曲线（宏观） =====
export async function getTreasuryRates() {
  if (!runtime.FMP_API_KEY) return { rates: null, _demo: true };
  try { return { rates: (await fmpGet(`${V4}/treasury`))?.[0] || null }; }
  catch (e) { return { rates: null, error: String(e.message || e) }; }
}

// ===== 宏观经济指标（GDP/CPI/失业率等） =====
export async function getEconomicIndicator(name = 'realGDP') {
  if (!runtime.FMP_API_KEY) return { name, series: [], _demo: true };
  try {
    const data = await fmpGet(`${V4}/economic`, { name });
    return { name, series: (data || []).slice(0, 8).map((x) => ({ date: x.date, value: x.value })) };
  } catch (e) { return { name, series: [], error: String(e.message || e) }; }
}

// ===== 财报日历：某标的下次财报日期（催化剂日期必须来自数据而非 LLM 记忆） =====
export async function getEarningsCalendar(symbol, { limit = 8 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, upcoming: null, recent: [], _demo: true };
  return cached('fmp_earnings_calendar', { symbol, limit }, 6, () => _getEarningsCalendar(symbol, { limit }));
}
async function _getEarningsCalendar(symbol, { limit = 8 } = {}) {
  try {
    const data = (await fmpGet(`${V3}/historical/earning_calendar/${symbol}`, { limit: Math.max(limit, 8) })) || [];
    const today = new Date().toISOString().slice(0, 10);
    const norm = (e) => ({ date: e.date, time: e.time || null, epsEst: e.epsEstimated ?? null, revenueEst: e.revenueEstimated ?? null, eps: e.eps ?? null });
    const future = data.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    return { symbol, upcoming: future[0] ? norm(future[0]) : null, recent: data.filter((e) => e.date < today).slice(0, 4).map(norm) };
  } catch (e) { return { symbol, upcoming: null, recent: [], error: String(e.message || e) }; }
}

export async function getUpcomingEarnings({ days = 7, limit = 200 } = {}) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + Number(days || 7) * 86400000).toISOString().slice(0, 10);
  if (!runtime.FMP_API_KEY) {
    const demo = [
      { symbol: 'MSFT', date: from, time: 'amc', epsEst: 3.1, revenueEst: 76000000000 },
      { symbol: 'TSLA', date: to, time: 'amc', epsEst: 0.72, revenueEst: 28500000000 },
      { symbol: 'NFLX', date: to, time: 'bmo', epsEst: 7.05, revenueEst: 11200000000 },
    ];
    return { from, to, events: demo.slice(0, limit), _demo: true };
  }
  try {
    const data = (await fmpGet(`${V3}/earning_calendar`, { from, to })) || [];
    const events = data
      .map((e) => ({
        symbol: e.symbol,
        date: e.date,
        time: e.time || null,
        epsEst: e.epsEstimated ?? e.epsEstimate ?? null,
        revenueEst: e.revenueEstimated ?? e.revenueEstimate ?? null,
      }))
      .filter((e) => e.symbol && e.date >= from && e.date <= to)
      .slice(0, limit);
    return { from, to, events };
  } catch (e) { return { from, to, events: [], error: String(e.message || e) }; }
}

// ===== 宏观事件日历（FOMC/CPI/非农等，取未来 N 天高影响事件） =====
export async function getEconomicCalendar({ days = 14, country = 'US' } = {}) {
  if (!runtime.FMP_API_KEY) return { events: [], _demo: true };
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const data = (await fmpGet(`${V3}/economic_calendar`, { from, to })) || [];
    const events = data
      .filter((e) => (!country || e.country === country) && /high/i.test(e.impact || ''))
      .slice(0, 20)
      .map((e) => ({ date: e.date, event: e.event, impact: e.impact, estimate: e.estimate ?? null, previous: e.previous ?? null }));
    return { from, to, events };
  } catch (e) { return { events: [], error: String(e.message || e) }; }
}

// ===== 市场异动榜（涨幅/跌幅/活跃） =====
export async function getMarketMovers(kind = 'gainers') {
  const path = kind === 'losers' ? 'losers' : kind === 'actives' ? 'actives' : 'gainers';
  if (!runtime.FMP_API_KEY) return { kind, movers: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/stock_market/${path}`);
    return { kind, movers: (data || []).slice(0, 15).map((m) => ({ symbol: m.symbol, name: m.name, changePct: m.changesPercentage, price: m.price })) };
  } catch (e) { return { kind, movers: [], error: String(e.message || e) }; }
}

function filterBySymbols(rows = [], symbols = [], limit = 20) {
  const wanted = new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(/[,，\s]+/)).map((s) => String(s).toUpperCase()).filter(Boolean));
  return (rows || [])
    .filter((r) => !wanted.size || wanted.has(String(r.symbol || '').toUpperCase()))
    .slice(0, limit)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name || r.currency || r.commodity || null,
      price: r.price ?? null,
      change: r.change ?? null,
      changePct: r.changesPercentage ?? r.changePercentage ?? null,
      timestamp: r.timestamp ?? null,
    }));
}

// ===== FX / Commodity quotes：行业分析里用于汇率、能源、金属等外部驱动 =====
export async function getFxQuotes({ pairs = ['EURUSD', 'USDJPY', 'USDCNH'], limit = 20 } = {}) {
  if (!runtime.FMP_API_KEY) return { pairs, quotes: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/quotes/forex`);
    return { pairs, quotes: filterBySymbols(data, pairs, limit) };
  } catch (e) { return { pairs, quotes: [], error: String(e.message || e) }; }
}

export async function getCommodityQuotes({ symbols = ['CLUSD', 'NGUSD', 'GCUSD', 'SIUSD', 'HGUSD'], limit = 20 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbols, quotes: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/quotes/commodity`);
    return { symbols, quotes: filterBySymbols(data, symbols, limit) };
  } catch (e) { return { symbols, quotes: [], error: String(e.message || e) }; }
}

export async function getMacroAssetHistory(symbol, { days = 120 } = {}) {
  if (!runtime.FMP_API_KEY) return { symbol, history: [], _demo: true };
  try {
    const data = await fmpGet(`${V3}/historical-price-full/${symbol}`, { timeseries: days });
    return { symbol, history: (data?.historical || []).slice(0, days).map((d) => ({ date: d.date, close: d.close, changePercent: d.changePercent, volume: d.volume })) };
  } catch (e) { return { symbol, history: [], error: String(e.message || e) }; }
}

export async function getIpoCalendar({ from, to, limit = 50 } = {}) {
  if (!runtime.FMP_API_KEY) return { ipos: [], _demo: true };
  try {
    const start = from || new Date().toISOString().slice(0, 10);
    const end = to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const data = await fmpGet(`${V3}/ipo_calendar`, { from: start, to: end });
    return { from: start, to: end, ipos: (data || []).slice(0, limit).map((d) => ({ date: d.date, symbol: d.symbol, company: d.company, exchange: d.exchange, priceRange: d.priceRange, shares: d.shares })) };
  } catch (e) { return { ipos: [], error: String(e.message || e) }; }
}

export async function searchStockNews({ query = '', tickers = [], limit = 20 } = {}) {
  const list = Array.isArray(tickers) ? tickers : String(tickers || '').split(/[,，\s]+/).filter(Boolean);
  const news = await getNews(list, Math.max(limit, 20));
  const q = String(query || '').toLowerCase();
  const filtered = q ? (news || []).filter((n) => `${n.title || ''} ${n.text || ''}`.toLowerCase().includes(q)) : news;
  return { query, tickers: list, news: (filtered || []).slice(0, limit) };
}
