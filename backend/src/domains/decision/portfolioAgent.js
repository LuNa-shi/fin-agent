// 组合构建 agent（PM）：三层漏斗——
//   粗筛(标准闸+赔率装配) → 精选(DealLadder 天梯比对) → 末端切片(风格倾斜 + 权重 + 论点契约冻结)。
// 每只入选标的产出一份可证伪的 ThesisContract；结果落地为推荐持仓，供虚拟盘跟踪与后续双轴复盘。
import fs from 'node:fs';
import path from 'node:path';
import { Store, Mandate } from '../../core/persistence/globalState.js';
import {
  ProjectSpace as ProjectFS,
  latestVerifiedRunAnalysisReportPackage,
} from '../../project-space/index.js';
import { MEMORY_DIR } from '../../config.js';
import { getProfile, getRatios, getFinancialGrowth, getHistoricalPrice } from '../../tools/fmp.js';
import { pLimit } from '../../lib/http.js';
import { capNormalize } from '../../lib/weights.js';
import { Ledger } from './ledger.js';
import { rankByLadder } from './dealLadder.js';
import { freezeContract } from './thesisContract.js';
import { capBucket } from '../../lib/enums.js';

// —— 决策轨迹持久化：与 idea-traces/world-traces 同模式。此前组合构建全程黑箱
// （onProgress 被丢弃、天梯逐轮理由不落盘），前端无法展示 PM 的思考过程。 ——
const DECISION_TRACE_FILE = path.join(MEMORY_DIR, 'decision-traces.jsonl');
function appendDecisionTrace(t) {
  const rec = { id: 'dec_t_' + Math.random().toString(36).slice(2, 9), ts: Date.now(), ...t };
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); fs.appendFileSync(DECISION_TRACE_FILE, JSON.stringify(rec) + '\n'); } catch {}
  return rec;
}
export function decisionTraces(limit = 20) {
  if (!fs.existsSync(DECISION_TRACE_FILE)) return [];
  const all = fs.readFileSync(DECISION_TRACE_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return all.reverse().slice(0, limit);
}

const NAME_CAP = 0.30;    // 单票占组合上限（≤30%）
const SECTOR_CAP = 0.45;  // 单一行业占组合上限（硬约束，超限压缩、释放权重给其他行业/现金）
const MAX_CASH = 0.30;    // 候选质量不足/数量不够时可留的最大现金比例

// ============ 粗筛①：按 ticker 装配候选（赔率/信号/证伪，一司一候选） ============
// 一家公司 = 一个候选（无论被多少项目命中）；把散落在结论/推演里的赔率、先行信号、证伪条件、
// 分析来源全部归集冻结，供天梯比对与后续论点契约使用。
// 非可投标的黑名单（现金/货币等曾被旧结论当 ticker 写进 stocks，进闸后按「数据缺口」占位）
const NON_INVESTABLE = new Set(['CASH', 'USD', 'USDT', 'CNY', 'EUR', 'GOLD']);
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,7}$/;

function assembleCandidates({ mandate = null } = {}) {
  const md = mandate || Mandate.get();
  const maxAgeMs = (md.maxProjectAgeDays || 45) * 86400000;
  const all = ProjectFS.list().map((project) => {
    const reportPackage = latestVerifiedRunAnalysisReportPackage(project.id);
    return reportPackage ? {
      ...project,
      conclusion: reportPackage.conclusion,
      scenarios: reportPackage.scenarios || [],
    } : null;
  }).filter(Boolean);
  // 时效/版本闸：老框架（<1.0，中文论点、无赔率口径）与过期结论不进组合——
  // 曾有 31/36 候选来自修复前的旧项目，把整个组合建在陈旧中文论点上。
  const projects = all.filter((p) => {
    const fresh = (Date.now() - (p.analyzedAt || p.createdAt || 0)) <= maxAgeMs;
    const versionOk = parseFloat(p.frameworkVersion || '0') >= 1.0;
    return fresh && versionOk;
  });
  const excludedStale = all.filter((p) => !projects.includes(p)).map((p) => ({
    projectId: p.id, title: p.title,
    reason: parseFloat(p.frameworkVersion || '0') < 1.0 ? 'framework_outdated' : 'stale',
    analyzedAt: p.analyzedAt || null,
  }));
  const map = {};
  for (const p of projects) {
    const c = p.conclusion;
    const erByT = Object.fromEntries((c.expectedReturns || []).map((e) => [String(e.ticker).toUpperCase(), e]));
    const signposts = [...new Set((p.scenarios || []).flatMap((f) => f.signposts || []))];
    for (const s of (c.stocks || [])) {
      if (!s.ticker) continue;
      const t = String(s.ticker).toUpperCase();
      // 非可投标的/畸形代码不进候选（CASH 曾被当 ticker 装配进闸）；仅上下文角色的对照标的也不进
      if (NON_INVESTABLE.has(t) || !TICKER_RE.test(t)) continue;
      if (s.role === 'context' || s._contextOnly) continue;
      const entry = (map[t] = map[t] || { ticker: t, name: s.name || t, sources: [], signposts: [], _dataGap: true });
      entry.sources.push({
        project: p.title, projectId: p.id, theme: p.theme || p.title, rating: c.rating || '',
        projectConf: c.confidence, confidence: s.confidence, suggestedWeight: s.suggestedWeight,
        reason: s.reason, invalidation: s.invalidation,
        recommendationScore: p.recommendationScore ?? null, analyzedAt: p.analyzedAt || p.createdAt,
      });
      const er = erByT[t];
      if (er && (!entry.odds || (er.coverage || 0) > (entry.odds.coverage || 0))) entry.odds = er;
      for (const sp of signposts) if (!entry.signposts.includes(sp)) entry.signposts.push(sp);
      if (!s._dataGap) entry._dataGap = false;
    }
  }
  const candidates = Object.values(map).map((c) => {
    const top = [...c.sources].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || {};
    const recommendationScore = Math.max(...c.sources.map((s) => s.recommendationScore ?? Math.round((s.confidence || 0.5) * 100)));
    const invalidation = c.sources.map((s) => s.invalidation).find(Boolean) || '';
    return {
      ...c,
      thesis: top.reason, reason: top.reason, theme: top.theme, confidence: top.confidence,
      recommendationScore, invalidation,
      odds: c.odds,
      signposts: c.signposts.slice(0, 10), theses: c.sources.length, projectId: top.projectId,
    };
  });
  return { candidates, excludedStale };
}

// ============ 粗筛②：确定性标准安全闸 + mandate 底线 ============
// 只做「能不能进场」的硬性安全判断（流动性/杠杆/数据缺口），不替 agent 做选股。
// 通过者不足 mandate.minCandidates 时按优先级放宽回收；超 maxCandidates 时按优先级截断。
function priorityScore(c) {
  const rec = (c.recommendationScore ?? 50) / 100;
  const er = typeof c.odds?.expectedReturnPct === 'number' ? c.odds.expectedReturnPct / 100 : 0;
  return rec + er * 0.5 + Math.min(c.theses || 1, 3) * 0.03;
}
function standardsGate(cands, fdata, mandate) {
  const gated = cands.map((c) => {
    const f = fdata[c.ticker] || {};
    const reasons = [];
    // 原因用英文代码（前端 i18n 映射中文；冒号后带参数 detail）
    if (!mandate.allowDataGap && c._dataGap) reasons.push('data_gap');
    if (f.marketCap != null && mandate.minMarketCap && f.marketCap < mandate.minMarketCap) reasons.push(`low_liquidity:${capBucket(f.marketCap) || ''}`);
    if (f.debtToEquity != null && mandate.maxLeverage && f.debtToEquity > mandate.maxLeverage) reasons.push(`high_leverage:D/E ${f.debtToEquity.toFixed(1)}`);
    return { ...c, _gateReasons: reasons, _priority: +priorityScore(c).toFixed(3) };
  });
  let pass = gated.filter((c) => !c._gateReasons.length);
  let blocked = gated.filter((c) => c._gateReasons.length);
  // 底线：不足 minCandidates → 按优先级回收 blocked（次优安全放宽，标记 _gateRelaxed）
  if (pass.length < (mandate.minCandidates || 3) && blocked.length) {
    blocked.sort((a, b) => b._priority - a._priority);
    const need = (mandate.minCandidates || 3) - pass.length;
    const recovered = blocked.slice(0, need).map((c) => ({ ...c, _gateRelaxed: true }));
    pass = [...pass, ...recovered];
    blocked = blocked.slice(need);
  }
  // 上限：按优先级截断到 maxCandidates
  pass = pass.sort((a, b) => b._priority - a._priority).slice(0, mandate.maxCandidates || 24);
  return { survivors: pass, blocked };
}

// 抓取每个标的的历史量化因子（beta/估值/成长/质量/动量/市值/杠杆/行业/现价）
async function fetchFactorData(tickers) {
  const limit = pLimit(4);
  const entries = await Promise.all(tickers.map((t) => limit(async () => {
    const [prof, ratios, growth, hist] = await Promise.all([
      getProfile(t).catch(() => ({})),
      getRatios(t).catch(() => ({})),
      getFinancialGrowth(t, { limit: 1 }).catch(() => ([])),
      getHistoricalPrice(t, { days: 70 }).catch(() => ({})),
    ]);
    const g = Array.isArray(growth) ? growth[0] : growth;
    return [t, {
      beta: num(prof.beta), sector: prof.sector || '其他', industry: prof.industry,
      marketCap: prof.mktCap || prof.marketCap, price: num(prof.price),
      pe: num(ratios.peRatioTTM), pb: num(ratios.priceToBookRatioTTM), ps: num(ratios.priceToSalesRatioTTM), peg: num(ratios.pegRatioTTM),
      roe: num(ratios.returnOnEquityTTM), netMargin: num(ratios.netProfitMarginTTM),
      debtToEquity: num(ratios.debtEquityRatioTTM), // 杠杆（标准闸用）
      revenueGrowth: num(g?.revenueGrowth), epsGrowth: num(g?.epsgrowth),
      mom3m: num(hist.momentum?.ret3m), mom1m: num(hist.momentum?.ret1m),
      vol: annualizedVol(hist.history), // 个股历史年化波动率(%)
      _rets: dailyReturns(hist.history), // 日收益序列（组合协方差用，不注入 prompt）
    }];
  })));
  return Object.fromEntries(entries);
}

// history 为倒序（最新在前）：rets[k] = (close[k] - close[k+1]) / close[k+1]
function dailyReturns(history) {
  const closes = (history || []).map((h) => h.close).filter((x) => typeof x === 'number');
  const rets = [];
  for (let i = 0; i < closes.length - 1; i++) rets.push((closes[i] - closes[i + 1]) / closes[i + 1]);
  return rets;
}

// 由历史收盘价计算年化波动率(%)：日收益标准差 × √252。
function annualizedVol(history) {
  const rets = dailyReturns(history);
  if (rets.length < 10) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return +(Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(1);
}

// 真实组合波动率：w'Σw（样本协方差，按重叠区间对齐），并找出相关性最高的一对持仓。
// 个股波动率的加权平均不是组合波动率——忽略相关性既算不出分散效果，也看不见集中风险。
function portfolioRisk(holdings, fdata) {
  const hs = holdings.filter((h) => ((fdata[h.ticker] || {})._rets || []).length >= 20);
  if (hs.length < 2) return { portfolioVol: null, topCorrelation: null };
  const L = Math.min(...hs.map((h) => fdata[h.ticker]._rets.length));
  const X = hs.map((h) => fdata[h.ticker]._rets.slice(0, L));
  const means = X.map((s) => s.reduce((a, b) => a + b, 0) / L);
  const cov = (i, j) => { let c = 0; for (let k = 0; k < L; k++) c += (X[i][k] - means[i]) * (X[j][k] - means[j]); return c / L; };
  const sd = X.map((_, i) => Math.sqrt(cov(i, i)));
  const wsum = hs.reduce((a, h) => a + (h.weight || 0), 0) || 1;
  const w = hs.map((h) => (h.weight || 0) / wsum);
  let varP = 0; let top = null;
  for (let i = 0; i < hs.length; i++) {
    for (let j = 0; j < hs.length; j++) {
      const c = cov(i, j);
      varP += w[i] * w[j] * c;
      if (i < j && sd[i] > 0 && sd[j] > 0) {
        const rho = c / (sd[i] * sd[j]);
        if (!top || Math.abs(rho) > Math.abs(top.rho)) top = { pair: [hs[i].ticker, hs[j].ticker], rho: +rho.toFixed(2) };
      }
    }
  }
  return {
    portfolioVol: +(Math.sqrt(Math.max(varP, 0) * 252) * 100).toFixed(1), // 年化(%)，已含相关性
    topCorrelation: top,
  };
}

// 行业集中度硬约束：超限行业内部等比压缩至 cap，释放权重按比例分给未超限行业；
// 若全组合集中于超限行业（无处可分），释放部分自然落入现金。（export 供单元测试）
export function applySectorCap(weights, sectors, cap = SECTOR_CAP, target = 1) {
  let w = [...weights];
  for (let iter = 0; iter < 4; iter++) {
    const sums = {};
    w.forEach((x, i) => { sums[sectors[i]] = (sums[sectors[i]] || 0) + x; });
    const over = new Set(Object.entries(sums).filter(([, s]) => s > cap * target + 1e-6).map(([k]) => k));
    if (!over.size) break;
    let excess = 0;
    w = w.map((x, i) => {
      if (!over.has(sectors[i])) return x;
      const scaled = x * (cap * target / sums[sectors[i]]);
      excess += x - scaled;
      return scaled;
    });
    const freeSum = w.reduce((a, x, i) => a + (over.has(sectors[i]) ? 0 : x), 0);
    if (freeSum <= 1e-9) break; // 无未超限持仓可接收 → 余量转现金
    w = w.map((x, i) => (over.has(sectors[i]) ? x : x + excess * (x / freeSum)));
  }
  return w;
}

function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }

// 3) 组合层面因子暴露 + 风险统计（按目标权重加权真实指标）+ thesis 暴露。
// candMap: ticker → candidate（含 sources[].theme），用于按 thesis/主题聚合暴露。
function portfolioFactors(holdings, fdata, candMap = {}) {
  const wsum = holdings.reduce((a, h) => a + (h.weight || 0), 0) || 1;
  const wavg = (fn) => +(holdings.reduce((a, h) => { const v = fn(fdata[h.ticker] || {}); return a + (h.weight || 0) * (num(v) ?? 0); }, 0) / wsum).toFixed(3);
  const sectors = {};
  holdings.forEach((h) => { const s = (fdata[h.ticker] || {}).sector || '其他'; sectors[s] = (sectors[s] || 0) + (h.weight || 0); });
  const betaCov = holdings.filter((h) => num((fdata[h.ticker] || {}).beta) != null).reduce((a, h) => a + (h.weight || 0), 0) / wsum;
  // thesis 暴露：按每个标的的来源主题聚合权重（一票多 thesis 时均摊）
  const thesis = {};
  holdings.forEach((h) => {
    const srcs = (candMap[h.ticker]?.sources || []);
    const themes = [...new Set(srcs.map((s) => (s.theme || s.project || '未分类')).filter(Boolean))];
    const list = themes.length ? themes : ['未分类'];
    list.forEach((t) => { thesis[t] = (thesis[t] || 0) + (h.weight || 0) / list.length; });
  });
  const risk = portfolioRisk(holdings, fdata);
  return {
    weightedBeta: wavg((f) => f.beta),
    betaCoverage: +betaCov.toFixed(2),
    weightedVol: wavg((f) => f.vol),          // 个股波动率加权平均（不含相关性，仅作参照）
    portfolioVol: risk.portfolioVol,          // 真实组合年化波动率(%)：w'Σw，含相关性
    topCorrelation: risk.topCorrelation,      // 相关性最高的一对持仓（分散度体检）
    weightedRevGrowth: +(wavg((f) => f.revenueGrowth) * 100).toFixed(1),
    weightedROE: +(wavg((f) => f.roe) * 100).toFixed(1),
    weightedPEG: wavg((f) => (f.peg > 0 ? f.peg : 0)),
    weightedMomentum3m: wavg((f) => f.mom3m),
    weightedPE: wavg((f) => (f.pe > 0 ? f.pe : 0)),
    sectorBreakdown: Object.entries(sectors).map(([sector, weight]) => ({ sector, weight: +weight.toFixed(4) })).sort((a, b) => b.weight - a.weight),
    thesisExposure: Object.entries(thesis).map(([thesis, weight]) => ({ thesis: String(thesis).slice(0, 40), weight: +weight.toFixed(4) })).sort((a, b) => b.weight - a.weight).slice(0, 8),
    topConcentration: +Math.max(...holdings.map((h) => h.weight || 0), 0).toFixed(4),
  };
}

export async function recommendPortfolio({ onProgress } = {}) {
  const { candidates, excludedStale } = assembleCandidates();
  if (!candidates.length) {
    throw new Error(excludedStale.length
      ? `无可用候选：${excludedStale.length} 个项目因过期/旧框架被排除（重新分析后即可纳入）`
      : '暂无已分析项目（或结论为空），无法生成推荐持仓');
  }
  return constructPortfolio(candidates, { meta: { source: 'projects', excludedStale }, onProgress });
}

// 天梯评分 → 目标权重：以保守评分(R−2RD)为信念，平移到正区间后归一，再施加单票/行业上限。
// 入选数量不足 maxHoldings 时按比例留现金（宁缺毋滥，不为凑满仓摊薄到弱标的）。
function ladderWeights(selected, fdata, mandate) {
  const maxH = mandate.maxHoldings || 10;
  const cons = selected.map((s) => s.conservative ?? s.rating ?? 1500);
  const floor = Math.min(...cons);
  const raw = cons.map((x) => Math.max(x - floor + 120, 1)); // 平移到正、保留档差
  const cashByCount = +Math.min(MAX_CASH, Math.max(0, (maxH - selected.length) / maxH) * MAX_CASH).toFixed(4);
  const investTarget = 1 - cashByCount;
  let w = capNormalize(raw, NAME_CAP, investTarget);
  w = applySectorCap(w, selected.map((s) => (fdata[s.ticker] || {}).sector || '其他'), SECTOR_CAP, investTarget);
  return w;
}

// 末端切片的组合视图（风格倾斜说明 + beta/集中度点评），确定性生成（不再一杆子 LLM 选股）。
function portfolioView(positions, factors, mandate) {
  const styleMap = { growth: '成长倾斜', value: '价值倾斜', quality: '质量倾斜', balanced: '均衡' };
  const tilt = styleMap[mandate.style] || '均衡';
  const beta = factors.weightedBeta;
  const betaComment = beta == null ? 'beta 数据不足' : beta > 1.15 ? `组合 beta ${beta} 偏进攻` : beta < 0.9 ? `组合 beta ${beta} 偏防御` : `组合 beta ${beta} 接近市场`;
  const topSector = factors.sectorBreakdown?.[0];
  const concentrationComment = topSector ? `最大行业 ${topSector.sector} 占 ${Math.round(topSector.weight * 100)}%，最大单票 ${Math.round(factors.topConcentration * 100)}%` : '—';
  return { styleTilt: tilt, betaComment, concentrationComment, mandateStyle: mandate.style, horizon: mandate.horizonPref, keyRisks: (factors.topCorrelation ? [`最高相关对 ${factors.topCorrelation.pair?.join('/')} ρ=${factors.topCorrelation.rho}`] : []) };
}

// 通用组合构建（三层漏斗）：候选池 → 标准闸粗筛 → DealLadder 精选/精排 → 权重 + 论点契约冻结。
// mandate 只在粗筛底线与末端切片处生效。全程 onProgress 上抛 + 决策轨迹落盘（PM 思考可见/可回放）。
export async function constructPortfolio(candidates, { meta = {}, mandate: mandateOverride, onProgress: onProgressExt } = {}) {
  if (!candidates?.length) throw new Error('候选池为空');
  const t0 = Date.now();
  const traceSteps = [];
  const onProgress = (stage, data) => { traceSteps.push({ stage, ts: Date.now(), ...data }); onProgressExt?.(stage, data); };
  const mandate = { ...Mandate.get(), ...(mandateOverride || {}) };
  onProgress('candidates', {
    count: candidates.length,
    list: candidates.map((c) => ({ ticker: c.ticker, theses: c.theses, projectId: c.projectId, eRet: c.odds?.expectedReturnPct ?? null, recScore: c.recommendationScore ?? null })),
    excludedStale: (meta.excludedStale || []).map((x) => ({ title: x.title, reason: x.reason })),
  });
  const fdata = await fetchFactorData(candidates.map((c) => c.ticker));

  // —— 粗筛：标准安全闸 + mandate 底线 ——
  const { survivors, blocked } = standardsGate(candidates, fdata, mandate);
  onProgress('gated', {
    survivors: survivors.length, blocked: blocked.length,
    blockedDetail: blocked.map((b) => ({ ticker: b.ticker, reasons: b._gateReasons })),
    relaxed: survivors.filter((s) => s._gateRelaxed).map((s) => s.ticker),
  });
  if (!survivors.length) throw new Error('标准闸后无合格候选（可放宽 mandate 的流动性/杠杆/数据缺口约束）');

  // —— 精选/精排：DealLadder 天梯比对 ——
  const ranked = await rankByLadder(survivors, { mandate, topN: mandate.maxHoldings, onProgress: (phase, d) => onProgress(`ladder:${phase}`, d) });
  if (!ranked.length) throw new Error('天梯比对未产出有效排名');

  // —— 末端切片：权重 + 因子 + 论点契约 ——
  const w = ladderWeights(ranked, fdata, mandate);
  const selected = ranked.map((c, i) => ({ ...c, weight: +w[i].toFixed(4) }));
  const investedSum = selected.reduce((a, h) => a + h.weight, 0);
  const cashWeight = +(1 - investedSum).toFixed(4);
  const candMap = Object.fromEntries(selected.map((c) => [c.ticker, c]));
  const factors = portfolioFactors(selected, fdata, candMap);

  const now = Date.now();
  const positions = selected.map((c) => {
    const f = fdata[c.ticker] || {};
    // 冻结论点契约（附关键分歧：读该标的最强来源项目的 cruxes.json）
    let cruxes = [];
    if (c.projectId) {
      const cx = ProjectFS.analysisFile(c.projectId, 'cruxes.json');
      cruxes = (cx?.cruxes || []).slice(0, 6).map((x) => ({ question: x.question, lean: x.lean, probUp: x.probUp, importance: x.importance }));
    }
    const contract = freezeContract({ ...c, cruxes }, { factors: f, entryPrice: f.price, mandate, now });
    return {
      id: 'pos_' + Math.random().toString(36).slice(2, 9), ticker: c.ticker, name: c.name || c.ticker,
      weight: c.weight, rank: c.ladderRank, confidence: c.confidence ?? 0.6,
      theme: c.theme, reason: c.thesis || c.reason, factorNote: c.compareNote, theses: (c.sources || []).length,
      rating: c.rating, conservative: c.conservative, rd: c.rd,       // 天梯评分快照
      odds: c.odds || null,
      signposts: c.signposts || [], invalidation: c.invalidation || '',
      contractId: contract?.id || null,
      factors: { beta: f.beta, vol: f.vol, sector: f.sector, marketCap: f.marketCap, pe: f.pe, peg: f.peg, roe: f.roe, revenueGrowth: f.revenueGrowth, mom3m: f.mom3m, capBucket: capBucket(f.marketCap) },
      entryPrice: null, lastPrice: null, returnPct: null, addedAt: now,
      sources: (c.sources || []).map((s) => ({ projectId: s.projectId, theme: s.theme || s.project, reason: s.reason, confidence: s.confidence, sleeveWeight: s.suggestedWeight })),
    };
  });
  Store.setPortfolio(positions);
  const recommendation = {
    ts: now, live: true, candidates: candidates.length, gated: survivors.length, holdings: positions.length,
    cashWeight, factors, portfolioView: portfolioView(positions, factors, mandate),
    excluded: blocked.map((b) => ({ ticker: b.ticker, reason: (b._gateReasons || []).join('、') })),
    mandate: { style: mandate.style, horizonPref: mandate.horizonPref, maxHoldings: mandate.maxHoldings, minMarketCap: mandate.minMarketCap, maxLeverage: mandate.maxLeverage },
    ladder: selected.map((c) => ({ ticker: c.ticker, rank: c.ladderRank, rating: c.rating, rd: c.rd, conservative: c.conservative })),
    ...meta,
  };
  Store.setRecommendation(recommendation);
  // 过账：目标权重换算成份额、差额记流水（权重和 <1 的部分即现金）
  await Ledger.rebalance(positions.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: `rebalance:${meta.source || 'recommend'}` }).catch((e) => console.error('[ledger]', e?.message || e));
  onProgress('done', {
    holdings: positions.map((p) => ({ ticker: p.ticker, weight: p.weight, rank: p.rank, note: p.factorNote })),
    cashWeight,
  });
  const trace = appendDecisionTrace({
    source: meta.source || 'recommend', durationMs: Date.now() - t0,
    candidates: candidates.length, gated: survivors.length, holdings: positions.length, cashWeight,
    steps: traceSteps,
    positions: positions.map((p) => ({ ticker: p.ticker, weight: p.weight, rank: p.rank, reason: p.reason, note: p.factorNote, contractId: p.contractId })),
  });
  return { positions, recommendation, traceId: trace.id };
}
