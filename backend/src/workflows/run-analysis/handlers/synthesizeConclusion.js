import { IdeaStore } from '../../../domains/ideas/index.js';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { capNormalize } from '../../../lib/weights.js';
import { expectedReturnsBrief } from '../../../lib/valuation.js';
import { normalizeRating } from '../../../lib/enums.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { emit } from '../projection/events.js';

function hasUsableFundamentals(fundamentals) {
  if (!fundamentals) return false;
  return [fundamentals.pe, fundamentals.ps, fundamentals.peg, fundamentals.revenueGrowth, fundamentals.analystTarget, fundamentals.dcfValue].some((value) => value != null);
}

// 规整结论：risks 转字符串、无数据标的降权、单票上限归一、低数据覆盖封顶置信度。
// investable：可入组合的标的集合（定向项目=用户指定标的；对照/晋升的 peer 只做上下文，
// 不进持仓——否则推演用主体标的的看空情景给 peer 定价，会误把 peer 推成高权重，见 GOOGL→MSFT 50% 的 bug）。
function normalizeConclusion(conclusion, fundamentals = {}, gateOnData = true, coverage = null, investable = null) {
  const normalized = { ...conclusion };
  normalized.rating = normalizeRating(normalized.rating); // 英文规范值（旧中文值读时归一；前端 i18n 映射中文展示）
  // 覆盖度硬约束：模板要求的数据拿到 <60% 时，confidence 封顶 0.6——数据不足不允许高置信结论
  if (coverage != null && coverage < 0.6 && (normalized.confidence ?? 0) > 0.6) {
    normalized.confidence = 0.6;
    normalized._coverageCapped = coverage;
  }
  normalized.risks = (Array.isArray(normalized.risks) ? normalized.risks : []).map((risk) => {
    if (typeof risk === 'string') return risk;
    if (risk && typeof risk === 'object') return risk.risk || risk.text || risk.desc || risk.name || Object.values(risk).filter((value) => typeof value === 'string').join('：');
    return String(risk);
  }).filter(Boolean);
  const SINGLE_NAME_CAP = 0.4;
  const investSet = investable && investable.length ? new Set(investable.map((ticker) => String(ticker).toUpperCase())) : null;
  let stocks = (Array.isArray(normalized.stocks) ? normalized.stocks : []).map((stock) => {
    const ticker = String(stock.ticker || '').toUpperCase();
    const usable = !gateOnData || hasUsableFundamentals(fundamentals[ticker]);
    // 对照标的（不在 investable 集合）权重清零、标记为上下文——它们的推演 E[ret] 只是单变量条件收益
    const isContext = investSet && !investSet.has(ticker);
    const weight = typeof stock.suggestedWeight === 'number' ? stock.suggestedWeight : (stock.confidence ?? 0.5);
    return { ...stock, ticker, _dataGap: gateOnData && !usable, _contextOnly: isContext || undefined, suggestedWeight: isContext ? 0 : (usable ? weight : Math.min(weight, 0.05)) };
  });
  const weights = capNormalize(stocks.map((stock) => stock.suggestedWeight || 0), SINGLE_NAME_CAP);
  stocks = stocks.map((stock, index) => ({ ...stock, suggestedWeight: +weights[index].toFixed(4) }));
  normalized.stocks = stocks;
  normalized._dataGaps = stocks.filter((stock) => stock._dataGap).map((stock) => stock.ticker);
  normalized._contextOnly = stocks.filter((stock) => stock._contextOnly).map((stock) => stock.ticker);
  return normalized;
}

// 评分锚定的程序化 clamp：prompt 里的软约束（E[ret]/赔率 → recommendationScore 区间）改为硬执行。
// 只对「主体标的」的期望收益生效（推演的适用边界）：取权重最高股票对应的 expectedReturns 条目。
function clampRecommendationScore(conclusion, expectedReturns = []) {
  if (!expectedReturns.length || conclusion.recommendationScore == null) return conclusion;
  const topStock = [...(conclusion.stocks || [])].sort((a, b) => (b.suggestedWeight || 0) - (a.suggestedWeight || 0))[0];
  const expectedReturn = expectedReturns.find((item) => item.ticker === topStock?.ticker) || expectedReturns[0];
  const returnPct = expectedReturn?.expectedReturnPct;
  const skew = expectedReturn?.skew;
  if (typeof returnPct !== 'number' || !isFinite(returnPct)) return conclusion;
  const before = conclusion.recommendationScore;
  let lower = 0, upper = 100;
  if (returnPct < 0) upper = 39;
  else if (returnPct < 15 || (typeof skew === 'number' && skew < 1.5)) { lower = 30; upper = 65; }
  else if (!(returnPct > 25 && (skew == null || skew >= 2))) upper = 74; // 不满足高分条件 → 封顶 74
  const clamped = Math.max(lower, Math.min(upper, before));
  if (clamped !== before) {
    conclusion.recommendationScore = clamped;
    conclusion._scoreClamped = { before, after: clamped, anchor: { ticker: expectedReturn?.ticker, expectedReturnPct: returnPct, skew: skew ?? null } };
  }
  return conclusion;
}

export async function synthesizeConclusion(context, _node, { shouldRun }) {
  const {
    id, meta, theme, brief, cp, plan, tickers, industry, companies,
    briefs, relatedFindings, fundamentals, last, cfg,
    saveCp, tstep,
  } = context;
  if (shouldRun) {
    const allIdeas = IdeaStore.getIdeas().slice(0, 20).map((idea) => `${idea.title}（${idea.theme || ''}）`);
    emit(id, 'final-report', { step: 4, text: `最终结论：结合全库 ${allIdeas.length} 条 idea，形成评级、推荐程度与持仓建议。` });
    const erBrief = expectedReturnsBrief([]);
    const conclusionResult = await tstep('conclusion', () => runDefinedAgent('conclusion-synthesizer', {
      brief,
      theme,
      industry,
      companies,
      expectedReturnsBrief: erBrief,
      fundamentals: briefs.fundamentals || '',
      relatedFindings,
      libraryIdeas: allIdeas,
    }, {
      deadlineMs: (cfg.depth?.conclusionMin ?? 6) * 60000,
      step: 4, stage: 'conclusion', artifact: 'analysis/conclusion.json',
      kind: 'analysis-json', temperature: 0.45,
    }));
    // 质量门：真实模型下解析彻底失败 → 视为步骤失败，宁可 interrupted 也不落假结论
    if (!conclusionResult.output && conclusionResult.live) throw new Error('结论 JSON 解析失败（已拒绝落占位结论），请重试');
    if (conclusionResult.output && conclusionResult.valid === false) emit(id, 'final-report', { step: 4, text: `⚠️ 结论结构校验未完全通过（${(conclusionResult.errors || []).length} 处，已归一化处理）：${(conclusionResult.errors || [])[0] || ''}` });
    const conclusionData = conclusionResult.output || {
      rating: 'hold', recommendationScore: 55, confidence: 0.6, summary: `${theme}: opportunity exists but needs more verification.`,
      stocks: (plan.candidates || []).map((candidate, index) => ({ ...candidate, confidence: +(0.7 - index * 0.08).toFixed(2), suggestedWeight: 1 / Math.max(tickers.length, 1) })),
      vsConsensus: '', portfolioFit: '', risks: ['demand falsification', 'valuation stretched'],
    };
    const toolCoverageScore = ProjectFS.toolCoverage(id)?.latest?.coverageScore ?? null;
    const confidenceCoverage = [last.coverage, toolCoverageScore].filter((value) => value != null).reduce((a, b) => Math.min(a, b), 1);
    // 可入组合的标的：定向项目=用户指定标的；发现型项目=深度分析全集（无对照概念）
    const investable = meta.mode === 'targeted'
      ? (meta.tickers || []).map((ticker) => String(ticker).toUpperCase()).filter(Boolean)
      : null;
    const conclusion = normalizeConclusion(conclusionData, fundamentals, !!cfg.fundamentals, confidenceCoverage, investable);
    clampRecommendationScore(conclusion, []);
    conclusion.expectedReturns = null; // Scenario execution is intentionally outside the analysis-first topology
    // 可证伪判断是项目内报告产物，不注册到全局状态。
    ProjectFS.setAnalysisFile(id, 'claims.json', {
      generatedAt: Date.parse(cp.artifactAsOf),
      claims: Array.isArray(conclusion.claims) ? conclusion.claims : [],
    });
    ProjectFS.setAnalysisFile(id, 'conclusion.json', conclusion);
    assertContractArtifactsCommitted(id, 'conclusion-synthesizer');
    cp.conclusion = conclusion; cp.live = cp.live || conclusionResult.live; saveCp();
    emit(id, 'final-report', { step: 4, text: `最终结论：${conclusion.rating}（推荐度 ${conclusion.recommendationScore ?? '—'}/100，置信度 ${Math.round((conclusion.confidence || 0) * 100)}%）${conclusion._coverageCapped != null ? `｜数据覆盖度仅 ${Math.round(conclusion._coverageCapped * 100)}%，置信度已封顶 0.6` : ''}${conclusion._dataGaps?.length ? `，数据缺失降权：${conclusion._dataGaps.join(',')}` : ''}` });
  }
  return hydrateSynthesizeConclusion(context);
}

export async function hydrateSynthesizeConclusion(context) {
  context.conclusion = context.cp.conclusion;
  return context.cp.conclusion;
}

export { synthesizeConclusion as execute, hydrateSynthesizeConclusion as hydrate };
