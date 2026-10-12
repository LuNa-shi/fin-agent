// ThesisContract — PM agent 的「可证伪产出单元」。
// 每只入选标的在建仓时冻结一份契约：为什么买(why)、赔率(odds)、持有期(horizon)、
// 先行验证信号(signposts)、关键分歧(cruxes)、离场条件(invalidation)、建仓快照(entrySnapshot)。
// 之后到检查点(checkpoints)按 signpost 对账，平仓时做双轴复盘——把「当时怎么想」钉死，杜绝事后叙事。
// 纯确定性组装（无 LLM）：所有字段来自已产出的分析工件（结论/推演），只做归集与冻结。
import { Contracts } from '../../core/persistence/globalState.js';

const MS_DAY = 86400000;

// 解析 mandate.horizonPref（如 '6-12M' / '12M' / '3-6个月' / '1Y'）→ 最长天数。
export function horizonToDays(h = '6-12M') {
  const s = String(h);
  const yr = s.match(/(\d+(?:\.\d+)?)\s*(?:Y|y|年)/);
  if (yr) return Math.round(parseFloat(yr[1]) * 365);
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const months = nums.length ? Math.max(...nums) : 12; // 取区间上界
  return Math.round(months * 30.4);
}

// 由持有期派生检查点：1/3、2/3、到期三处 signpost 复核。
function checkpointsFor(horizon, now) {
  const days = horizonToDays(horizon);
  return [1 / 3, 2 / 3, 1].map((frac) => ({
    at: now + Math.round(days * frac * MS_DAY),
    kind: 'signpost-review',
    label: `${Math.round(days * frac)}天`,
    done: false,
  }));
}

/**
 * 组装并冻结一份论点契约（同时落盘到 Contracts.open）。
 * @param {object} cand 天梯选出的候选（含 odds/signposts/cruxes/invalidation/thesis/reason/projectId）
 * @param {{ factors?, entryPrice?, mandate?, now? }} ctx
 */
export function freezeContract(cand, { factors = {}, entryPrice = null, mandate = {}, now = Date.now() } = {}) {
  const ticker = String(cand.ticker || '').toUpperCase();
  if (!ticker) return null;
  const o = cand.odds || {};
  const horizon = mandate.horizonPref || '6-12M';
  const contract = {
    id: 'ctr_' + Math.random().toString(36).slice(2, 9),
    ticker, name: cand.name || ticker,
    why: cand.thesis || cand.reason || '',
    odds: {
      expectedReturnPct: o.expectedReturnPct ?? null,
      skew: o.skew ?? null,                 // 赔率：概率加权上行/|下行|
      upsidePct: o.upsidePct ?? null,
      downsidePct: o.downsidePct ?? null,
      coverage: o.coverage ?? null,
    },
    horizon,
    signposts: Array.isArray(cand.signposts) ? cand.signposts.slice(0, 8) : [],
    cruxes: Array.isArray(cand.cruxes) ? cand.cruxes.slice(0, 6) : [],
    invalidation: cand.invalidation || '',
    entrySnapshot: {
      price: entryPrice ?? factors.price ?? null,
      pe: factors.pe ?? null, peg: factors.peg ?? null, pb: factors.pb ?? null,
      marketCap: factors.marketCap ?? null, sector: factors.sector ?? null,
      beta: factors.beta ?? null, mom3m: factors.mom3m ?? null,
      date: now,
    },
    rating: cand.rating ?? null, conservative: cand.conservative ?? null, // 天梯评分快照
    ladderRank: cand.ladderRank ?? null,
    projectId: cand.projectId || (cand.sources || [])[0]?.projectId || null,
    checkpoints: checkpointsFor(horizon, now),
    status: 'open',
    createdAt: now,
  };
  // 语言卫生：英文管线里混入多数 CJK 的论点/信号（多半来自旧框架项目的结论）只警告不硬拦——
  // 契约仍冻结，但这是上游项目该重新分析的信号。
  const cjkRatio = (s = '') => { const str = String(s); const cjk = (str.match(/[一-鿿]/g) || []).length; return str.length ? cjk / str.length : 0; };
  const zhFields = [['why', contract.why], ...contract.signposts.map((s, i) => [`signposts[${i}]`, s])].filter(([, v]) => cjkRatio(v) > 0.3).map(([k]) => k);
  if (zhFields.length) console.warn(`[contract] ${ticker} 契约含中文字段（${zhFields.join(', ')}）——来源项目可能是旧框架产物，建议重新分析`);

  Contracts.freeze(contract);
  return contract;
}
