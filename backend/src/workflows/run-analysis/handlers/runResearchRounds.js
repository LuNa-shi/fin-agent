import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { runDataRound } from '../research/dataRound.js';
import { runIndustryRound } from '../research/industryRound.js';
import { runCompanyRound } from '../research/companyRound.js';
import {
  DEEP_RESEARCH_CAP as DEEP_CAP,
  runSelectiveResearchRemediation,
} from '../research/selectiveResearchRemediation.js';
import { tickerPromotions } from '../research/tickerScope.js';
import { renderCompanyPrelimReport, renderIndustryPrelimReport } from '../artifacts/preliminaryReports.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { emit } from '../projection/events.js';

function normalizedNextFocus(nextDataFocus, tickers) {
  const rationale = String(nextDataFocus?.rationale || '').trim();
  return {
    questions: [...new Set(nextDataFocus?.questions || [])].slice(0, 5),
    tickers: [...new Set([...(nextDataFocus?.tickers || []), ...tickers])].slice(0, 8),
    tools: [...new Set(nextDataFocus?.tools || [])],
    ...(rationale ? { rationale } : {}),
  };
}

export async function runResearchRounds(context, _node, { shouldRun }) {
  const {
    id, meta, theme, brief, cp, cfg, saveCp, tstep, checkCancelled,
    resuming, tickers, dataGuideline, dataAutoTools,
    industryTemplatePrompt, companyTemplatePrompt, relatedFindings,
  } = context;
  if (shouldRun && cp.activeRemediation?.owners?.some((owner) => ['data', 'industry', 'company'].includes(owner))) {
    const entry = await runSelectiveResearchRemediation(context);
    await hydrateResearchRounds(context);
    return [entry];
  }
  let { deepTickers } = context;
  const lastCp = cp.rounds.length ? cp.rounds[cp.rounds.length - 1] : null;
  let focus = lastCp ? (lastCp.nextFocus || {}) : {};
  let priorIndustry = lastCp?.industry || null;
  let priorCompanies = lastCp?.companies || null;

  for (let round = cp.round + 1; shouldRun && round <= cp.targetRounds; round++) {
    checkCancelled();
    emit(id, 'main-orchestrator', {
      step: 2,
      round,
      text: `第 ${round}/${cp.targetRounds} 轮 main orchestrator：先完成 Data closure，再并行执行 Industry 与 Company${resuming ? '（续跑）' : ''}。`,
    });

    emit(id, 'subagent', {
      step: 2,
      round,
      agent: 'data-orchestrator',
      text: round === 1
        ? 'data-orchestrator：按数据模板抓取行业+公司资料并提交本轮 Data closure。'
        : `data-orchestrator：按上一轮数据缺口定向补数（${(focus.questions || [])[0] || '关键缺口'}）并提交刷新后的 Data closure。`,
    });
    const { dataContext } = await tstep(`r${round}:data`, () => runDataRound({
      id,
      tickers,
      theme,
      brief,
      guideline: dataGuideline,
      autoTools: dataAutoTools,
      cfg,
      round,
      focus,
      asOf: cp.artifactAsOf,
      frozenData: context.options?.frozenDataByRound?.[round]
        || context.options?.frozenDataByRound?.[String(round)]
        || null,
    }));
    emit(id, 'subagent', {
      step: 2,
      round,
      agent: 'data-orchestrator',
      text: `data-orchestrator 完成并提交 Data closure：${dataContext.excerpts.length} 条摘录 · 覆盖度 ${Math.round((dataContext.coverage?.score ?? 0) * 100)}% · 缺口 ${dataContext.gaps.length} 项`,
      data: {
        coverage: dataContext.coverage,
        organized: dataContext.organized,
        sourceQuality: dataContext.sourceQuality,
        contradictions: dataContext.contradictions,
        gaps: dataContext.gaps,
        nextDataFocus: dataContext.nextDataFocus,
      },
    });

    // 两个分析分支只依赖同一份已提交的本轮 Data closure，彼此之间没有同轮依赖。
    const topT = (deepTickers.length ? deepTickers : tickers).slice(0, DEEP_CAP + 1);
    const runIndustry = () => tstep(`r${round}:industry`, () => runIndustryRound({
      projectId: id,
      round,
      dataRound: round,
      theme,
      brief,
      dataContext,
      guidance: industryTemplatePrompt,
      relatedFindings,
      depth: cfg.depth,
    }).catch((error) => ({
      industry: { structuralView: '行业分析失败: ' + error.message, drivers: [] },
    })));
    const runCompany = () => tstep(`r${round}:company`, () => runCompanyRound({
      projectId: id,
      round,
      dataRound: round,
      tickers: topT,
      theme,
      brief,
      comparisonTickers: [],
      dataContext,
      guidance: companyTemplatePrompt,
      depth: cfg.depth,
    }).catch(() => ({
      companies: topT.map((ticker) => ({ ticker, verdict: '分析失败', conviction: 0.4 })),
    })));

    emit(id, 'subagent', {
      step: 2,
      round,
      agent: 'industry-orchestrator',
      text: 'Data closure 已提交；industry-orchestrator 与 company-orchestrator 基于同一 Data closure 并行推进。',
    });
    const [industryResult, companyResult] = await Promise.all([runIndustry(), runCompany()]);
    let { industry } = industryResult;
    let { companies } = companyResult;

    // 坏轮次（解析失败落 fallback 占位符）不得覆盖好轮次的正式产物。
    const substance = (value) => JSON.stringify(value || {}).length;
    const fieldSubstantive = (value) => typeof value === 'string'
      && value.trim().length >= 40
      && !/^(data insufficient|missing|n\/?a|—|unknown)/i.test(value.trim());
    const industryOk = (value) => !!value
      && fieldSubstantive(value.structuralView)
      && (fieldSubstantive(value.industryMainline) || fieldSubstantive(value.marketSize));
    const companyOk = (value) => !!value
      && fieldSubstantive(value.verdict)
      && (fieldSubstantive(value.valuation) || fieldSubstantive(value.positioning));
    const isRegression = (current, previous, valid) => valid(previous)
      && (!valid(current) || (substance(current) < 800 && substance(previous) > substance(current) * 2));
    if (priorIndustry && isRegression(industry, priorIndustry, industryOk)) {
      emit(id, 'main-orchestrator', {
        step: 2,
        round,
        text: `本轮行业分析关键字段空心（疑似占位符，${substance(industry)} 字符），保留上一轮产物（${substance(priorIndustry)} 字符）。`,
      });
      industry = priorIndustry;
    }
    if (priorCompanies?.length) {
      companies = companies.map((company) => {
        const previous = priorCompanies.find((candidate) => candidate.ticker === company.ticker);
        if (previous && isRegression(company, previous, companyOk)) {
          emit(id, 'main-orchestrator', {
            step: 2,
            round,
            text: `${company.ticker} 本轮公司分析关键字段空心（疑似占位符），保留上一轮产物。`,
          });
          return previous;
        }
        return company;
      });
    }

    ProjectFS.setAnalysisFile(id, 'industry.json', industry);
    ProjectFS.setAnalysisFile(id, 'company.json', companies);
    const industryPrelim = renderIndustryPrelimReport({ round, theme, industry, dataContext });
    const companyPrelim = renderCompanyPrelimReport({ round, theme, companies, dataContext });
    ProjectFS.setAnalysisText(id, `industry_report_r${round}.md`, industryPrelim);
    ProjectFS.setAnalysisText(id, `company_report_r${round}.md`, companyPrelim);
    ProjectFS.setAnalysisText(id, 'industry_report.md', industryPrelim);
    ProjectFS.setAnalysisText(id, 'company_report.md', companyPrelim);
    assertContractArtifactsCommitted(id, 'industry-analyst');
    assertContractArtifactsCommitted(id, 'company-analyst');
    emit(id, 'subagent', {
      step: 2,
      round,
      agent: 'company-orchestrator',
      text: `Industry 与 Company 分支完成：公司分析 ${companies.length} 家；行业判断摘要：${(industry.structuralView || '').slice(0, 80)}`,
      data: { industry, companies },
    });

    const nextDataFocus = dataContext.nextDataFocus || {};
    if (round < cp.targetRounds) {
      const named = [...new Set(nextDataFocus.tickers || [])]
        .map((ticker) => String(ticker).toUpperCase())
        .filter((ticker) => /^[A-Z][A-Z.-]{0,5}$/.test(ticker));
      const promote = tickerPromotions({
        meta,
        cp,
        currentTickers: deepTickers,
        namedTickers: named,
        maxTickers: DEEP_CAP + 1,
      });
      if (promote.length) {
        deepTickers = [...deepTickers, ...promote];
        cp.deepPromoted = [...new Set([...(cp.deepPromoted || []), ...promote])];
        emit(id, 'main-orchestrator', {
          step: 2,
          round,
          text: `深度标的晋升：${promote.join(', ')} 被 Data closure 点名，下一轮纳入公司深度分析（名单 ${deepTickers.join(', ')}）。`,
        });
      }
    }
    focus = normalizedNextFocus(nextDataFocus, tickers);
    priorIndustry = industry;
    priorCompanies = companies;

    cp.rounds.push({
      round,
      dataRound: round,
      industry,
      companies,
      nextFocus: focus,
      contradictions: dataContext.contradictions,
      briefs: dataContext.briefs,
      excerpts: dataContext.excerpts,
      quotes: dataContext.quotes,
      fundamentals: dataContext.fundamentals,
      dataReport: dataContext.dataReport,
      coverage: dataContext.coverage?.score ?? null,
    });
    // 下游只消费最后一轮重字段；历史轮保留轻量的 Data focus 与 coverage。
    if (cp.rounds.length > 1) {
      const previous = cp.rounds[cp.rounds.length - 2];
      for (const key of ['briefs', 'excerpts', 'quotes', 'fundamentals', 'dataReport', 'contradictions', 'industry', 'companies']) delete previous[key];
    }
    cp.round = round;
    saveCp();
  }

  context.deepTickers = deepTickers;
  return hydrateResearchRounds(context);
}

export async function hydrateResearchRounds(context) {
  const { cp } = context;
  const last = cp.rounds[cp.rounds.length - 1] || {};
  const industry = last.industry || {};
  const companies = last.companies || [];
  const fundamentals = last.fundamentals || {};
  const briefs = last.briefs || {};

  Object.assign(context, {
    deepTickers: context.deepTickers,
    last,
    industry,
    companies,
    fundamentals,
    briefs,
  });
  return cp.rounds;
}

export { runResearchRounds as execute, hydrateResearchRounds as hydrate };
