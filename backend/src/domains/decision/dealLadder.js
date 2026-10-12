// DealLadder — PM agent 的「比对/排序层」。
// 不再一次性让 LLM 从候选池里挑 10 只（一杆子买卖、无可比性、赔率/证伪信息全丢）。
// 改成天梯赛：候选按 5 只一组做「赚钱确定性 + 赔率」相对排名，转成成对胜负，用 Glicko-1
// 更新每个候选的评分 R 与不确定度 RD。多轮换组比对 → RD 收敛。
//   · 保守评分 = R − 2·RD（宁可低估：证据不足的候选不因偶然一胜上位）
//   · 赔率（skew=上行/|下行|）→ 初始 R 凸性加成（mandate.convexityBonus 可调）
// 产出：粗筛→精选 的有序候选（每个带 rating/rd/conservative/ladderRank/compareNotes）。
import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import {
  assertDirectExecutionScopeBinding,
  beginDirectAgentCommand,
} from '../../core/contracts/AgentExecutionScope.js';

// ---- Glicko-1 参数 ----
const Q = Math.log(10) / 400;         // ≈0.0057565
const PI2 = Math.PI * Math.PI;
const R0 = 1500;                       // 初始评分
const RD0 = 350;                       // 初始不确定度（无先验）
const RD_MIN = 30;                     // RD 下限（避免过度自信锁死）
const RD_MAX = 350;
const GROUP = 5;                       // 每组比对 5 只
// 轮数随池子自适应（小池换组意义有限，白花 LLM 调用与墙钟）：
// 池≤8 → 海选 2 轮；决赛≤5（一组打完）→ 精排 1 轮。9-15min 的构建目标 ≤5min。
const screenPassesFor = (n) => (n <= GROUP + 3 ? 2 : 3);
const finePassesFor = (n) => (n <= GROUP ? 1 : 2);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const gRD = (rd) => 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / PI2);

// 一个评分周期的批量更新：results = [{ rj, rdj, s }]（对手评分周期【前】的 R/RD、本人得分 1/0.5/0）
function updatePlayer(R, RD, results) {
  if (!results.length) return { R, RD }; // 本轮未参赛（组数不整除时可能发生）→ 不变
  let dInv = 0, sum = 0;
  for (const { rj, rdj, s } of results) {
    const g = gRD(rdj);
    const e = 1 / (1 + Math.pow(10, -g * (R - rj) / 400));
    dInv += Q * Q * g * g * e * (1 - e);
    sum += g * (s - e);
  }
  if (dInv <= 0) return { R, RD };
  const dSq = 1 / dInv;
  const denom = 1 / (RD * RD) + 1 / dSq;
  return { R: R + (Q / denom) * sum, RD: clamp(Math.sqrt(1 / denom), RD_MIN, RD_MAX) };
}

// 由候选先验播种初始 R/RD。
function seedPlayer(cand, mandate) {
  // 先验分 [0,1]：recommendationScore 优先，退化到最高来源置信度
  const rec = typeof cand.recommendationScore === 'number' ? cand.recommendationScore / 100
    : clamp(cand.confidence ?? 0.5, 0, 1);
  let R = R0 + (clamp(rec, 0, 1) - 0.5) * 500;
  // 赔率凸性：skew 越高（上行远大于下行）越加分
  const skew = cand.odds?.skew;
  if (typeof skew === 'number' && isFinite(skew)) {
    const conv = clamp((skew - 1) / 2, -0.5, 1.5); // skew 1→0，3→1，>3 封顶
    R += conv * 200 * (mandate?.convexityBonus ?? 0.15) / 0.15;
  }
  // 期望收益直接顺/逆风
  const er = cand.odds?.expectedReturnPct;
  if (typeof er === 'number' && isFinite(er)) R += clamp(er / 40, -1, 1) * 120;
  return { R, RD: RD0 };
}

// 把候选渲染成比对 prompt 的一行（赔率 + 因子 + 论点，供 LLM 相对排名）。
function line(cand, i) {
  const o = cand.odds || {};
  const f = cand.factors || {};
  const odds = o.skew != null || o.expectedReturnPct != null
    ? `E[ret] ${o.expectedReturnPct ?? '—'}% skew ${o.skew ?? '—'}:1 up ${o.upsidePct ?? '—'}/down ${o.downsidePct ?? '—'}`
    : 'odds not priced';
  const fac = [f.pe != null ? `PE ${(+f.pe).toFixed(0)}` : '', f.peg ? `PEG ${f.peg}` : '', f.roe != null ? `ROE ${Math.round(f.roe * 100)}%` : '', f.revenueGrowth != null ? `growth ${Math.round(f.revenueGrowth * 100)}%` : '', f.mom3m != null ? `3M ${f.mom3m}%` : ''].filter(Boolean).join(' ');
  return `${i + 1}. ${cand.ticker}(${cand.name || cand.ticker}) | ${odds} | ${fac} | thesis: ${(cand.thesis || cand.reason || '').slice(0, 70)}${cand.invalidation ? ` | invalidation: ${String(cand.invalidation).slice(0, 40)}` : ''}`;
}

// 让 LLM 对一组候选按「风险调整后赚钱确定性」相对排名（best→worst）。返回 ticker 有序数组。
async function compareGroup(group, {
  horizon,
  backend,
  executionScope,
  callId,
}) {
  if (group.length <= 1) return group.map((c) => c.ticker);
  const fb = { ranking: group.map((c, i) => ({ ticker: c.ticker, rank: i + 1, note: '' })) };
  let ranking = fb.ranking;
  try {
    const result = await runDefinedAgent('deal-ladder-ranking', {
      candidateCount: group.length,
      horizon,
      candidateLines: group.map(line).join('\n'),
    }, {
      scope: executionScope,
      callId,
      ...(backend === undefined ? {} : { backend }),
      kind: 'ladder-compare',
      temperature: 0.3,
      fallback: fb,
    });
    const data = result.output;
    if (Array.isArray(data?.ranking) && data.ranking.length) ranking = data.ranking;
  } catch { ranking = fb.ranking; }
  // 归一：只保留本组内 ticker，按 rank 排序，补齐遗漏者到末尾
  const inGroup = new Set(group.map((c) => c.ticker));
  const seen = new Set();
  const notes = {};
  const ordered = ranking
    .filter((r) => r && inGroup.has(String(r.ticker).toUpperCase()))
    .map((r) => ({ t: String(r.ticker).toUpperCase(), rank: r.rank ?? 99, note: r.note || '' }))
    .sort((a, b) => a.rank - b.rank)
    .filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true)));
  ordered.forEach((r) => { notes[r.t] = r.note; });
  const tickers = ordered.map((r) => r.t);
  for (const c of group) if (!seen.has(c.ticker)) tickers.push(c.ticker); // 遗漏者排最后
  return { order: tickers, notes };
}

// 把一组的有序结果转成成对胜负，累计进 results[ticker]。
function accretePairs(order, players, results) {
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i], b = order[j];         // a 排在 b 前 → a 胜 b
      const pa = players[a], pb = players[b];
      if (!pa || !pb) continue;
      (results[a] = results[a] || []).push({ rj: pb.R, rdj: pb.RD, s: 1 });
      (results[b] = results[b] || []).push({ rj: pa.R, rdj: pa.RD, s: 0 });
    }
  }
}

// 分组：按当前保守评分排序后，用 pass 偏移做「蛇形/错位」分组，
// 让强者也会碰到中游、不同轮遇到不同对手（否则总是强碰强、弱碰弱，跨档不可比）。
function makeGroups(tickers, players, pass) {
  const sorted = [...tickers].sort((a, b) => (players[b].R - 2 * players[b].RD) - (players[a].R - 2 * players[a].RD));
  const rotated = sorted.slice(pass % Math.max(sorted.length, 1)).concat(sorted.slice(0, pass % Math.max(sorted.length, 1)));
  const groups = [];
  for (let i = 0; i < rotated.length; i += GROUP) {
    const g = rotated.slice(i, i + GROUP);
    if (g.length === 1 && groups.length) groups[groups.length - 1].push(g[0]); // 落单者并入上一组
    else groups.push(g);
  }
  return groups;
}

// 跑若干轮换组比对（一轮=一个 Glicko 评分周期，快照前值→全体一起更新）。
// 每组的排名与理由通过 onCompare 完整上抛（决策过程要可见、可存 trace——此前逐轮推理被整体丢弃）。
// 各组比对直接全并发（ladder-compare 是插队的优先级 kind，全局 pLimitFair 兜底限流；
// 此前本地 concurrency=4 是多余的二级瓶颈，同一轮内组间本就无依赖）。
async function runPasses(tickers, players, notes, {
  phase,
  passes,
  mandate,
  horizon,
  backend,
  executionScope,
  onCompare,
}) {
  for (let pass = 0; pass < passes; pass++) {
    const groups = makeGroups(tickers, players, pass);
    const results = {};
    const outs = await Promise.all(groups.map((g, groupIndex) => compareGroup(
      g.map((t) => players[t].cand),
      {
        mandate,
        horizon,
        backend,
        executionScope,
        callId: `${phase}:pass-${pass + 1}:group-${groupIndex + 1}`,
      },
    )));
    outs.forEach((out, gi) => {
      const order = Array.isArray(out) ? out : out.order;
      const ns = Array.isArray(out) ? {} : out.notes;
      accretePairs(order, players, results);
      for (const [t, n] of Object.entries(ns)) if (n) notes[t] = n;
      onCompare?.(pass + 1, passes, gi + 1, groups.length, { order, notes: ns });
    });
    // 快照更新：用本轮【前】的 R/RD 计算，再统一写回
    const snap = Object.fromEntries(tickers.map((t) => [t, { R: players[t].R, RD: players[t].RD }]));
    for (const t of tickers) {
      const upd = updatePlayer(snap[t].R, snap[t].RD, results[t] || []);
      players[t].R = upd.R; players[t].RD = upd.RD;
    }
  }
}

/**
 * 天梯排序主入口。
 * @param {Array} candidates 粗筛后的候选（含 odds/factors/thesis/invalidation/recommendationScore/confidence）
 * @param {{ mandate, horizon?, topN?, onProgress? }} opts
 * @returns {Array} 有序候选（含 rating/rd/conservative/ladderRank/compareNote），已切到 topN
 */
export async function rankByLadder(candidates, {
  mandate = {},
  horizon,
  topN,
  onProgress,
  backend,
  executionScope,
} = {}) {
  const scope = assertDirectExecutionScopeBinding(executionScope === undefined
    ? beginDirectAgentCommand({
      workflowId: 'deal-ladder.v1',
      nodeId: 'rank-candidates',
      projectId: 'global',
      asOf: new Date().toISOString(),
      workspaceMode: 'none',
    })
    : executionScope, {
    workflowId: 'deal-ladder.v1',
    nodeId: 'rank-candidates',
    projectId: 'global',
    workspaceMode: 'none',
  });
  const hz = horizon || mandate.horizonPref || '6-12M';
  const N = topN || mandate.maxHoldings || 10;
  const uniq = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const t = String(c.ticker || '').toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t); uniq.push({ ...c, ticker: t });
  }
  if (uniq.length === 0) return [];
  if (uniq.length <= 2) { // 太少无需比对，直接按先验保守分排
    return uniq.map((c, i) => ({ ...c, rating: seedPlayer(c, mandate).R, rd: RD0, conservative: seedPlayer(c, mandate).R - 2 * RD0, ladderRank: i + 1, compareNote: '候选过少，未做天梯比对' }))
      .sort((a, b) => b.conservative - a.conservative).map((c, i) => ({ ...c, ladderRank: i + 1 }));
  }

  const players = {};
  for (const c of uniq) { const s = seedPlayer(c, mandate); players[c.ticker] = { R: s.R, RD: s.RD, cand: c }; }
  const notes = {};
  const tickers = uniq.map((c) => c.ticker);

  // ① 粗筛→精选：全体多轮换组比对
  const screenPasses = screenPassesFor(tickers.length);
  onProgress?.('screen-start', { candidates: tickers.length, passes: screenPasses });
  await runPasses(tickers, players, notes, {
    phase: 'screen',
    passes: screenPasses,
    mandate,
    horizon: hz,
    backend,
    executionScope: scope,
    onCompare: (p, ps, g, gs, detail) => onProgress?.('screen', { pass: p, passes: ps, group: g, groups: gs, ...detail }),
  });

  // 保守评分 R−2RD 排序 → 取 topN（决赛圈）
  const ranked = tickers.map((t) => ({ t, cons: players[t].R - 2 * players[t].RD }))
    .sort((a, b) => b.cons - a.cons);
  const finalists = ranked.slice(0, N).map((x) => x.t);

  // ② 精排：入围者内部再比对，收窄 RD、定最终次序（round-robin 近似）
  if (finalists.length > 2) {
    const finePasses = finePassesFor(finalists.length);
    onProgress?.('fine-start', { finalists: finalists.length, passes: finePasses });
    await runPasses(finalists, players, notes, {
      phase: 'fine',
      passes: finePasses,
      mandate,
      horizon: hz,
      backend,
      executionScope: scope,
      onCompare: (p, ps, g, gs, detail) => onProgress?.('fine', { pass: p, passes: ps, group: g, groups: gs, ...detail }),
    });
  }

  const out = finalists.map((t) => {
    const p = players[t];
    return { ...p.cand, rating: +p.R.toFixed(0), rd: +p.RD.toFixed(0), conservative: +(p.R - 2 * p.RD).toFixed(0), compareNote: notes[t] || '' };
  }).sort((a, b) => b.conservative - a.conservative)
    .map((c, i) => ({ ...c, ladderRank: i + 1 }));
  onProgress?.('done', { selected: out.length });
  return out;
}

export const _internal = { seedPlayer, updatePlayer, gRD, makeGroups, accretePairs };
