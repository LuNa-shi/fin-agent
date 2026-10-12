import {
  ProjectSpace as ProjectFS,
  latestVerifiedRunAnalysisReportPackage,
} from '../../../project-space/index.js';
import { TemplateSystem } from '../../../domains/research/templates/templateSystem.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { screenStocks } from '../../../tools/fmp.js';
import { SCHEMAS } from '../../../lib/schemas.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { emit } from '../projection/events.js';
import { DEEP_RESEARCH_CAP as DEEP_CAP } from '../research/selectiveResearchRemediation.js';
import {
  authoritativeCompanyTickers,
  tickerScopeMode,
} from '../research/tickerScope.js';

function textTokens(text = '') {
  const en = (String(text).match(/[A-Za-z]{2,}/g) || []).map((word) => word.toLowerCase());
  const cjkChars = String(text).replace(/[^一-鿿]/g, '');
  const cjk = [];
  for (let i = 0; i < cjkChars.length - 1; i++) cjk.push(cjkChars.slice(i, i + 2));
  return new Set([...en, ...cjk]);
}

// ---- 跨项目结论复用：按 标的交集 + 主题相关性 检索库内已分析项目的结构性结论 ----
// 库里已有的行业/公司研究（如算力链、云、广告）是现成的知识资产，新项目不应从零开始。
function relatedProjectFindings(excludeId, themeText, tickers = []) {
  const mine = new Set(tickers.map((ticker) => String(ticker).toUpperCase()));
  const themeTokens = textTokens(themeText);
  const scored = ProjectFS.list()
    .map((project) => {
      if (project.id === excludeId) return null;
      const reportPackage = latestVerifiedRunAnalysisReportPackage(project.id);
      return reportPackage ? {
        ...project,
        conclusion: reportPackage.conclusion,
      } : null;
    })
    .filter(Boolean)
    .map((project) => {
      const projectTickers = (project.conclusion.stocks || []).map((stock) => String(stock.ticker || '').toUpperCase());
      const tickerHits = projectTickers.filter((ticker) => mine.has(ticker)).length;
      const projectTokens = textTokens(`${project.title} ${project.theme || ''} ${project.industryView || ''}`);
      let overlap = 0; for (const token of themeTokens) if (projectTokens.has(token)) overlap++;
      return { project, score: tickerHits * 10 + overlap };
    })
    .filter((item) => item.score > 3).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(({ project }) =>
    `《${project.title}》(${new Date(project.analyzedAt || project.createdAt).toISOString().slice(0, 10)}，评级:${project.conclusion.rating || '—'}/推荐度${project.recommendationScore ?? '—'})：行业判断「${(project.industryView || '').slice(0, 160)}」；结论「${(project.conclusion.summary || '').slice(0, 160)}」`
  ).join('\n');
}

export async function selectCandidates(context, _node, { shouldRun }) {
  const {
    id, meta, theme, matchText, cp, saveCp, tstep,
  } = context;
  // ---- 扫描/筛选（checkpoint：cp.scan）：宽发现候选池 → 打分收敛到 ≤DEEP_CAP 个进深度分析 ----
  // 发现型项目（未指定标的，如「找 AI 电力受益股」「某行业变化谁受益」）先宽扫描一批候选，再按扫描模板的
  // 打分规则收敛。定向项目（指定了标的）跳过宽发现，仅对指定标的应用同一个硬上限。
  if (shouldRun) {
    const userTickers = (meta.tickers || []).map((ticker) => String(ticker).toUpperCase()).filter(Boolean);
    const mode = userTickers.length ? 'targeted' : 'discovery';
    const scanTpl = TemplateSystem.matchScanTemplate(matchText).template;
    const planCands = (cp.plan.candidates || [])
      .map((candidate) => ({ ticker: String(candidate.ticker || '').toUpperCase(), name: candidate.name || candidate.ticker, role: candidate.role || '', reason: candidate.reason || '' }))
      .filter((candidate) => candidate.ticker);

    if (mode === 'targeted' && userTickers.length <= DEEP_CAP) {
      // 定向且标的数已在上限内：无需扫描，直接用用户标的，仅切到 DEEP_CAP。
      cp.scan = { mode, scanTemplate: scanTpl?.id || null, pool: cp.tickers, scored: [], deepTickers: userTickers.slice(0, DEEP_CAP) };
      cp.tickers = userTickers.slice(0, 30);
      ProjectFS.setAnalysisFile(id, 'scan.json', cp.scan);
      emit(id, 'scan', { step: 1, text: `定向分析：深度分析标的 ${cp.scan.deepTickers.length} 个（≤${DEEP_CAP}）：${cp.scan.deepTickers.join(', ')}`, data: cp.scan });
    } else {
      emit(id, 'scan', { step: 1, text: `${mode === 'discovery' ? '发现型项目' : '候选超上限'}：宽扫描候选池 → 按扫描模板「${scanTpl?.name || '通用'}」打分，收敛到 ≤${DEEP_CAP} 个进深度分析。` });
      // 宽发现：plan 候选 + fmp_screener 宽召回（无 key/无命中则退化为纯 plan 候选）。
      let pool = [...planCands];
      const sector = scanTpl?.sectorHint;
      if (sector) {
        try {
          const scr = await tstep('scan-screen', () => screenStocks({ sector, marketCapMoreThan: 5e9, limit: 25 }));
          for (const result of (scr?.results || [])) {
            const ticker = String(result.symbol || '').toUpperCase();
            if (ticker && !pool.some((candidate) => candidate.ticker === ticker)) pool.push({ ticker, name: result.name || ticker, role: '筛选器发现', reason: `${result.sector || sector} · 市值 ${result.marketCap ? Math.round(result.marketCap / 1e9) + 'B' : '—'}` });
          }
        } catch { /* 无 key 或筛选失败：仅用 plan 候选 */ }
      }
      // 用户指定标的必须在池内（计入名额）。
      for (const ticker of userTickers) if (!pool.some((candidate) => candidate.ticker === ticker)) pool.unshift({ ticker, name: ticker, role: '用户指定', reason: '项目指定标的' });
      pool = pool.slice(0, 30);

      // 打分收敛（agent-template 方法）：小模型分层，按扫描模板规则给每个候选 0-100 打分 + take。
      const scanFallback = { scores: pool.map((candidate) => ({ ticker: candidate.ticker, score: 50, take: candidate.reason || '主题相关' })) };
      const scanR = await tstep('scan-score', () => runDefinedAgent('scan-score', {
        theme,
        rationale: meta.rationale || '',
        pool,
        scanPrompt: TemplateSystem.scanPrompt(scanTpl),
      }, { kind: 'idea-screen', temperature: 0.3, schema: SCHEMAS.screen, fallback: scanFallback }));
      const byTicker = Object.fromEntries((scanR.output.scores || []).map((score) => [String(score.ticker).toUpperCase(), score]));
      const scored = pool
        .map((candidate) => ({ ticker: candidate.ticker, name: candidate.name, score: Number(byTicker[candidate.ticker]?.score) || 0, take: byTicker[candidate.ticker]?.take || candidate.reason, role: candidate.role }))
        .sort((a, b) => b.score - a.score);

      // 硬上限收敛：用户指定标的强制保留并计入名额；其余按分数取满 DEEP_CAP。
      const forced = scored.filter((score) => userTickers.includes(score.ticker));
      const rest = scored.filter((score) => !userTickers.includes(score.ticker));
      const deepTickers = [...forced, ...rest].slice(0, DEEP_CAP).map((score) => score.ticker);

      cp.scan = { mode, scanTemplate: scanTpl?.id || null, pool: pool.map((candidate) => candidate.ticker), scored, deepTickers };
      // 宽池并入 tickers 供行业/数据分析当上下文；深度分析只用 deepTickers。
      cp.tickers = mode === 'targeted'
        ? userTickers.slice(0, 30)
        : [...new Set([...deepTickers, ...pool.map((candidate) => candidate.ticker)])].slice(0, 30);
      ProjectFS.setAnalysisFile(id, 'scan.json', cp.scan);
      emit(id, 'scan', { step: 1, text: `扫描完成：候选池 ${pool.length} 个 → 打分排序 → 深度分析 ${deepTickers.length} 个（≤${DEEP_CAP}）：${deepTickers.join(', ')}`, data: { mode, scanTemplate: scanTpl?.id, top: scored.slice(0, 8), deepTickers } });
    }
    assertContractArtifactsCommitted(id, 'scan-score');
    saveCp();
  }
  return hydrateSelectCandidates(context, { emitRelated: true });
}

export async function hydrateSelectCandidates(context, { emitRelated = false } = {}) {
  const {
    id, meta, theme, matchText, industryTpl, companyTpl, cp,
  } = context;
  const candidateTickers = cp.tickers || [];
  // 定向项目的权威 company 标的只来自用户输入/scan；reviewer 或数据整理点名的 peer
  // 只作为研究上下文。发现型项目仍允许轮间晋升关键遗漏标的，上限 DEEP_CAP+1。
  const deepTickers = authoritativeCompanyTickers({
    meta,
    cp,
    fallbackTickers: candidateTickers,
    maxTickers: DEEP_CAP + 1,
  });
  const tickers = tickerScopeMode({ meta, cp }) === 'targeted' ? deepTickers : candidateTickers;
  const dataGuideline = TemplateSystem.dataGuidelineFor(matchText);
  const dataAutoTools = TemplateSystem.autoToolsFor(matchText);
  const industryTemplatePrompt = TemplateSystem.industryPrompt(industryTpl);
  const companyTemplatePrompt = TemplateSystem.companyPrompt(companyTpl);
  // 跨项目结论复用：检索库内相关已分析项目的结构性结论，注入行业分析与结论
  const relatedFindings = relatedProjectFindings(id, `${theme} ${meta.theme || ''} ${meta.rationale || ''}`, tickers);
  if (emitRelated && relatedFindings && !cp.round) emit(id, 'main-orchestrator', { step: 1, text: `跨项目检索：找到 ${relatedFindings.split('\n').length} 个相关已分析项目，其结论将作为只读上下文复用。`, data: { relatedFindings } });

  Object.assign(context, {
    tickers, deepTickers, dataGuideline, dataAutoTools,
    industryTemplatePrompt, companyTemplatePrompt, relatedFindings,
  });
  return cp.scan;
}

export { selectCandidates as execute, hydrateSelectCandidates as hydrate };
