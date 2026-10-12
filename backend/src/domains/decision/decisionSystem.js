// 系统③：决策、跟踪与绩效复盘 — 基于项目结论形成股票池、仓位分配、收益跟踪与人工回看记录
// 绩效口径：Ledger（交易流水 + 份额制 NAV），调仓过账、盯市出净值，α 与回撤均基于 NAV 序列。
import { Store, Contracts } from '../../core/persistence/globalState.js';
import { IdeaStore } from '../ideas/index.js';
import {
  ProjectSpace as ProjectFS,
  latestVerifiedRunAnalysisReportPackage,
} from '../../project-space/index.js';
import { capNormalize } from '../../lib/weights.js';
import { recommendPortfolio } from './portfolioAgent.js';
import { Ledger } from './ledger.js';
import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import {
  assertDirectExecutionScopeBinding,
  beginDirectAgentCommand,
} from '../../core/contracts/AgentExecutionScope.js';

// 组合级参数
const GROSS_TARGET = 1.0;   // 目标总仓位（相对权重和=100%；多项目不再叠加超 100%）
const NAME_CAP = 0.25;      // 单一标的占整个组合的上限（组合级集中度约束，严于项目内 0.4）

// —— 双轴四象限判定（纯函数，供 reflectPosition 与单测使用）——
// 轴①论点对/错：股价是否按契约预期方向兑现；轴②赚/亏：相对基准超额。
// |ret|<2% 视为论点未决 → 从赚钱轴借判。
export const QUADRANTS = {
  'right-made': { key: '验证', note: '论点兑现且跑赢基准。' },
  'right-lost': { key: '对而未赚', note: '方向正确但输给基准，需要检查择时与仓位执行。' },
  'wrong-made': { key: '蒙对', note: '结果为正但原论点错误，需要警惕归因偏差。' },
  'wrong-lost': { key: '证伪', note: '论点错误且跑输基准，需要重新检查研究依据。' },
};
export function classifyQuadrant({ ret = 0, excess = null, confidence = 0.6, contract = null }) {
  const madeMoney = (excess ?? ret) >= 0;
  const predictedUp = contract?.odds?.expectedReturnPct != null ? contract.odds.expectedReturnPct >= 0
    : (contract?.odds?.skew != null ? contract.odds.skew >= 1 : (confidence ?? 0.6) >= 0.5);
  const actualUp = ret >= 0;
  const inconclusive = Math.abs(ret) < 2;
  const thesisRight = inconclusive ? madeMoney : (predictedUp === actualUp);
  const qk = `${thesisRight ? 'right' : 'wrong'}-${madeMoney ? 'made' : 'lost'}`;
  return { qk, quad: QUADRANTS[qk], thesisRight, madeMoney, inconclusive };
}

// 多来源仓位聚合 + 全局归一化：每个项目内部权重已和=1（视为一个等权 sleeve），
// 跨项目按 ticker 聚合来源权重后，统一归一到 GROSS_TARGET，并施加单票上限。
// 同一标的被多个项目命中 → 来源权重相加，而非互相覆盖。
function rebuildWeights(portfolio) {
  const conv = portfolio.map((p) => (p.sources || []).reduce((a, s) => a + (s.sleeveWeight || 0), 0));
  const w = capNormalize(conv, NAME_CAP, GROSS_TARGET);
  return portfolio.map((p, i) => ({ ...p, weight: +w[i].toFixed(4) }));
}

export const DecisionSystem = {
  portfolio() { return Store.getPortfolio(); },
  recommendation() { return Store.getRecommendation(); },

  // 一键更新推荐持仓：从项目库海选候选 → 标准闸 → 天梯比对 → 仓位配比 + 契约冻结。
  // onProgress 全程上抛（前端实时展示 PM 思考），轨迹持久化到 decision-traces.jsonl。
  async recommend(opts = {}) { return recommendPortfolio(opts); },

  ideaRanking() { return Store.getIdeaRanking(); },

  // 重看项目库所有 idea，多维度打分排序（催化/预期差/确定性/估值/时效/组合独特性）。
  async rankIdeas({ backend, executionScope } = {}) {
    const scope = assertDirectExecutionScopeBinding(executionScope === undefined
      ? beginDirectAgentCommand({
        workflowId: 'decision-idea-ranking.v1',
        nodeId: 'rank-ideas',
        projectId: 'global',
        asOf: new Date().toISOString(),
        workspaceMode: 'none',
      })
      : executionScope, {
      workflowId: 'decision-idea-ranking.v1',
      nodeId: 'rank-ideas',
      projectId: 'global',
      workspaceMode: 'none',
    });
    const ideas = IdeaStore.getIdeas();
    const projects = ProjectFS.list().map((project) => {
      const reportPackage = latestVerifiedRunAnalysisReportPackage(project.id);
      return reportPackage ? {
        ...project,
        conclusion: reportPackage.conclusion,
      } : null;
    }).filter(Boolean);
    // idea 池：生成的 idea + 已分析项目（带推荐度）
    const pool = [
      ...ideas.map((i) => ({ id: i.id, title: i.title, theme: i.theme, tickers: i.tickers || [], catalyst: i.catalyst, edge: i.edge, source: 'idea' })),
      ...projects.map((p) => ({ id: p.id, title: p.title, theme: p.theme, tickers: (p.conclusion.stocks || []).map((s) => s.ticker), recScore: p.recommendationScore ?? Math.round((p.conclusion.confidence || 0.6) * 100), source: 'project' })),
    ];
    if (!pool.length) throw new Error('项目库暂无 idea');
    const dedup = []; const seen = new Set();
    for (const x of pool) { const k = (x.title || '').slice(0, 24); if (seen.has(k)) continue; seen.add(k); dedup.push(x); }
    const list = dedup.slice(0, 40).map((x, i) => `${i + 1}. ${x.title} | theme: ${x.theme || '—'} | tickers: ${(x.tickers || []).slice(0, 4).join(',')} | ${x.source === 'project' ? 'analyzed, rec score ' + (x.recScore ?? '—') : 'catalyst: ' + (x.catalyst || '—').slice(0, 30)}`).join('\n');
    const result = await runDefinedAgent('idea-ranking', { ideaCount: dedup.length, ideaList: list }, {
      scope,
      callId: 'rank-ideas',
      ...(backend === undefined ? {} : { backend }),
      kind: 'idea-rank',
      temperature: 0.35,
      fallback: { rankings: [] },
    });
    const data = result.output || { rankings: [] };
    const rankings = (data.rankings || []).map((r) => ({
      ...r,
      tickers: Array.isArray(r.tickers) ? r.tickers : String(r.tickers || '').split(/[,，\s]+/).filter(Boolean),
    })).sort((a, b) => (b.overall || 0) - (a.overall || 0));
    const ranking = { ts: Date.now(), count: dedup.length, rankings };
    Store.setIdeaRanking(ranking);
    return ranking;
  },

  // 加入观察系统：重置账本（NAV=1 起算）、按当前权重建仓过账，之后持续 track。
  async watch() {
    const rec = Store.getRecommendation();
    if (rec) Store.setRecommendation({ ...rec, watchedAt: Date.now() });
    Ledger.reset('watch');
    const port = Store.getPortfolio();
    await Ledger.rebalance(port.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: 'watch:建仓基准' });
    return this.track(); // 建立首个净值快照
  },

  // 把某个已分析项目的结论纳入股票池：按 ticker 聚合多项目论点，做组合级仓位分配。
  async promoteFromProject(projectId) {
    const meta = ProjectFS.meta(projectId);
    const reportPackage = meta
      ? latestVerifiedRunAnalysisReportPackage(projectId)
      : null;
    if (!meta || !reportPackage) throw new Error('项目尚未产出已验证结论');
    const conclusion = reportPackage.conclusion;
    const stocks = (conclusion.stocks || []).filter((s) => s.ticker);

    let port = Store.getPortfolio();
    // 幂等：先清除本项目此前贡献的 source，再重新加入（重复 promote 不会叠加/污染）
    port = port.map((p) => ({ ...p, sources: (p.sources || []).filter((s) => s.projectId !== projectId) }));

    for (const s of stocks) {
      const ticker = String(s.ticker).toUpperCase();
      const source = {
        projectId, theme: meta.title, reason: s.reason,
        confidence: s.confidence ?? conclusion.confidence ?? 0.6,
        sleeveWeight: typeof s.suggestedWeight === 'number' ? s.suggestedWeight : (s.confidence ?? 0.5),
        dataGap: !!s._dataGap,
      };
      const idx = port.findIndex((p) => p.ticker === ticker);
      if (idx >= 0) port[idx].sources.push(source);
      else port.push({
        id: 'pos_' + Math.random().toString(36).slice(2, 9), ticker, name: s.name || ticker,
        sources: [source], entryPrice: null, lastPrice: null, returnPct: null, addedAt: Date.now(),
      });
    }
    // 丢弃已无任何来源的持仓（例如某项目被重新分析后不再推荐）
    port = port.filter((p) => (p.sources || []).length);
    // 派生展示字段：主题/理由/置信度取信念最高的来源
    port = port.map((p) => {
      const top = [...(p.sources || [])].sort((a, b) => (b.sleeveWeight || 0) - (a.sleeveWeight || 0))[0] || {};
      return { ...p, theme: top.theme, reason: top.reason, confidence: top.confidence, theses: p.sources.length };
    });
    port = rebuildWeights(port);
    Store.setPortfolio(port);
    ProjectFS.updateMeta(projectId, { promoted: true });
    await Ledger.rebalance(port.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: `promote:${projectId}` });
    return Store.getPortfolio();
  },

  // 手动调仓：固定某标的权重，其余按信念在剩余预算内重新归一（保持总和=GROSS_TARGET），并过账。
  async setWeight(ticker, weight) {
    const t = String(ticker).toUpperCase();
    let port = Store.getPortfolio();
    const target = Math.max(0, Math.min(GROSS_TARGET, Number(weight) || 0));
    const others = port.filter((p) => p.ticker !== t);
    const othConv = others.map((p) => (p.sources || []).reduce((a, s) => a + (s.sleeveWeight || 0), 0));
    const othW = capNormalize(othConv, NAME_CAP, Math.max(0, GROSS_TARGET - target));
    let j = 0;
    port = port.map((p) => p.ticker === t ? { ...p, weight: +target.toFixed(4), _pinned: true } : { ...p, weight: +othW[j++].toFixed(4) });
    Store.setPortfolio(port);
    await Ledger.rebalance(port.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: `setWeight:${t}=${target}` });
    return port;
  },

  async remove(ticker) {
    const t = String(ticker).toUpperCase();
    let port = Store.getPortfolio().filter((p) => p.ticker !== t);
    port = rebuildWeights(port);
    Store.setPortfolio(port);
    await Ledger.rebalance(port.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: `remove:${t}` });
    return port;
  },

  // 虚拟盘跟踪：账本盯市 → NAV/基准净值/α/最大回撤 + 逐持仓（成本口径收益 + 相对基准超额）。
  async track() {
    const port = Store.getPortfolio();
    if (!port.length) return { positions: [], summary: null, snapshots: Store.getSnapshots() };
    let mark = await Ledger.markToMarket();
    if (!mark) {
      // 账本未初始化（老数据迁移）：按当前目标权重建仓后再盯市
      await Ledger.rebalance(port.map((p) => ({ ticker: p.ticker, weight: p.weight })), { note: 'init:迁移建账' });
      mark = await Ledger.markToMarket();
    }
    if (!mark) throw new Error('账本盯市失败（行情不可用）');

    const updated = port.map((p) => {
      const m = mark.positions[p.ticker] || {};
      return {
        ...p,
        entryPrice: m.avgCost ?? p.entryPrice ?? null, entryDate: m.openedAt ?? p.entryDate ?? null,
        lastPrice: m.lastPrice ?? p.lastPrice ?? null, priceLive: m.priceLive ?? false,
        currentWeight: m.weight ?? null,              // 漂移后的实际权重（weight 仍为目标权重）
        returnPct: m.returnPct ?? null,
        benchReturnPct: m.benchReturnPct ?? null,     // 同期 SPY 收益（自该仓建仓起）
        excessPct: m.excessPct ?? null,               // 相对基准超额（复盘/校准用的胜负口径）
      };
    });
    Store.setPortfolio(updated);

    const winners = updated.filter((p) => (p.excessPct ?? p.returnPct ?? 0) > 0).length;
    const losers = updated.filter((p) => (p.excessPct ?? p.returnPct ?? 0) < 0).length;
    const summary = {
      asOf: mark.ts, benchmark: 'SPY',
      nav: mark.nav, benchNav: mark.benchNav,
      portReturn: mark.portReturn, benchReturn: mark.benchReturn, alpha: mark.alpha,
      maxDrawdownPct: mark.maxDrawdownPct, cashWeight: mark.cashWeight,
      winners, losers, flat: updated.length - winners - losers, positions: updated.length,
    };
    return { positions: updated, summary, snapshots: Store.getSnapshots() };
  },

  snapshots() { return Store.getSnapshots(); },
  ledger(limit = 200) { return Ledger.ledger(limit); },

  contracts() { return Contracts.open(); },
  contractArchive(limit = 200) { return Contracts.archive(limit); },
  dueContracts() { return Contracts.due(); },

  // 反思（双轴复盘）：拉出该持仓的论点契约，沿两个正交轴分类——
  //   ① 论点对/错（股价是否按契约预期方向兑现）  ② 赚/亏钱（相对基准超额）
  // 四象限用于生成确定性的绩效复盘标签；不再触发自动学习或影响后续 Agent。
  async reflectPosition(ticker) {
    const port = Store.getPortfolio();
    const pos = port.find((p) => p.ticker === ticker);
    if (!pos) throw new Error('持仓不存在');
    const ret = pos.returnPct ?? 0;
    const benchRet = pos.benchReturnPct;
    const excess = pos.excessPct ?? (benchRet != null ? +(ret - benchRet).toFixed(2) : null);
    const madeMoney = (excess ?? ret) >= 0;                    // 赚钱轴：相对基准超额（跑输 SPY 的浮盈算亏）
    const contract = Contracts.get(ticker) || (pos.contractId ? null : null);

    const { quad, thesisRight } = classifyQuadrant({ ret, excess, confidence: pos.confidence, contract });

    const outcome = excess != null
      ? `${madeMoney ? '跑赢' : '跑输'}基准 ${Math.abs(excess)}pp（绝对收益 ${ret}% vs 同期 SPY ${benchRet}%）｜四象限:${quad.key}`
      : (ret >= 0 ? `盈利 ${ret}%（基准缺失）｜四象限:${quad.key}` : `亏损 ${ret}%（基准缺失）｜四象限:${quad.key}`);

    const r = {
      lesson: quad.note,
      biasType: 'performance-review',
      adjustment: 'No automatic learning action.',
    };

    // 保留只读绩效样本，供人工查看；不再回灌 Agent 或改变未来赔率。
    const top = [...(pos.sources || [])].sort((a, b) => (b.sleeveWeight || b.confidence || 0) - (a.sleeveWeight || a.confidence || 0))[0];
    const recScore = (top?.projectId ? ProjectFS.meta(top.projectId)?.recommendationScore : null) ?? Math.round((pos.confidence || 0.6) * 100);
    if (excess != null) {
      Store.addCalibration({
        ts: Date.now(), ticker, recScore, excessPct: excess, returnPct: ret,
        predictedRetPct: contract?.odds?.expectedReturnPct ?? null, quadrant: quad.key, thesisRight,
      });
    }
    const reflection = {
      ticker, lesson: r.lesson, biasType: r.biasType, adjustment: r.adjustment,
      returnPct: ret, excessPct: excess, outcome,
      quadrant: quad.key, thesisRight, madeMoney, quadNote: quad.note,
    };
    Store.addReflection(reflection);
    // 平仓归档契约（复盘 = 结账；把契约移入 archive 记结局）
    if (contract) Contracts.close(ticker, { ret, excess, madeMoney, thesisRight, quadrant: quad.key });
    return { ...r, outcome, excessPct: excess, quadrant: quad.key, thesisRight, madeMoney, quadNote: quad.note };
  },

  reflections() { return Store.getReflections(); },

  // 校准曲线：recommendationScore 分箱 → 样本数/平均超额/胜率。分数是否"说到做到"，一看便知。
  calibration() {
    const recs = Store.getCalibration();
    const bins = [
      { label: '0-40', lo: 0, hi: 40 }, { label: '40-60', lo: 40, hi: 60 },
      { label: '60-75', lo: 60, hi: 75 }, { label: '75-100', lo: 75, hi: 101 },
    ].map((b) => {
      const xs = recs.filter((r) => r.recScore >= b.lo && r.recScore < b.hi);
      const wins = xs.filter((r) => r.excessPct > 0).length;
      return {
        bin: b.label, n: xs.length,
        avgExcessPct: xs.length ? +(xs.reduce((a, r) => a + r.excessPct, 0) / xs.length).toFixed(2) : null,
        winRate: xs.length ? +(wins / xs.length).toFixed(2) : null,
      };
    });
    return { samples: recs.length, bins, recent: recs.slice(-20).reverse() };
  },
};
