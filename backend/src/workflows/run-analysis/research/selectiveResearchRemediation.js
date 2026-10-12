import { contractEnforcer } from '../../../core/validation/ContractEnforcer.js';
import { getAgentDefinition } from '../../../agents/registry.js';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { renderCompanyPrelimReport, renderIndustryPrelimReport } from '../artifacts/preliminaryReports.js';
import { runCompanyRound } from './companyRound.js';
import { runDataRound } from './dataRound.js';
import { runIndustryRound } from './industryRound.js';
import { authoritativeCompanyTickers } from './tickerScope.js';

export const DEEP_RESEARCH_CAP = 3;

function assertContractArtifactsCommitted(projectId, contractId) {
  contractEnforcer.assertArtifactsCommitted({
    contract: getAgentDefinition(contractId),
    artifacts: ProjectFS.files(projectId).filter((file) => !file.dir).map((file) => file.name),
  });
}

function projectJSON(id, relPath, fallback = null) {
  try { return JSON.parse(ProjectFS.fileContent(id, relPath) || 'null') ?? fallback; } catch { return fallback; }
}

function remediationInstructions(remediation, owners) {
  const selected = (remediation?.issues || []).filter((issue) => owners.has(issue.owner));
  return selected.map((issue, index) => (
    `${index + 1}. [${issue.owner}/${issue.severity}] ${issue.requestedAction} (location: ${issue.location})`
  )).join('\n');
}

function dataContextFromRound(context, roundState) {
  const round = roundState?.dataRound || roundState?.round || context.cp.round || 1;
  const organized = projectJSON(context.id, `data/organized_r${round}.json`, {}) || {};
  const quoteFile = projectJSON(context.id, 'data/quotes.json', []) || [];
  const evidenceBundle = projectJSON(context.id, `data/evidence_bundle_r${round}.json`, {}) || {};
  const organizedPoints = (organized.organized || []).flatMap((group) => (group.points || []).map((point) => ({
    category: group.dimension,
    point: point.fact,
    source: point.source,
    ticker: point.ticker,
    credibility: point.credibility,
    type: point.type,
    claimId: point.claimId,
    claimStatus: point.claimStatus,
    evidenceRefs: point.evidenceRefs || [],
  })));
  return {
    tickers: context.tickers,
    theme: context.theme,
    quotes: Array.isArray(quoteFile) ? quoteFile : (quoteFile.quotes || []),
    fundamentals: roundState?.fundamentals || projectJSON(context.id, 'data/fundamentals.json', {}) || {},
    transcripts: projectJSON(context.id, 'data/transcripts.json', []) || [],
    research: Array.isArray(quoteFile) ? {} : (quoteFile.research || {}),
    industry: projectJSON(context.id, 'data/industry.json', {}) || {},
    detail: projectJSON(context.id, 'data/detail.json', {}) || {},
    dataReport: roundState?.dataReport || ProjectFS.fileContent(context.id, 'data/data_report.md') || '',
    briefs: roundState?.briefs || {},
    organized: organized.organized || [],
    excerpts: roundState?.excerpts || organizedPoints,
    sourceQuality: organized.sourceQuality || [],
    contradictions: roundState?.contradictions || organized.contradictions || [],
    gaps: organized.gaps || [],
    nextDataFocus: organized.nextDataFocus || roundState?.nextFocus || { questions: [], tickers: [], tools: [] },
    coverage: organized.coverage || { score: roundState?.coverage ?? 0 },
    dataPlan: projectJSON(context.id, `data/data_plan_r${round}.json`, null),
    evidenceBundle,
    sourceDocuments: projectJSON(context.id, `data/source_documents_r${round}.json`, {})?.documents || [],
    domainEvents: projectJSON(context.id, `data/domain_events_r${round}.json`, {})?.events || [],
  };
}

export async function runSelectiveResearchRemediation(context) {
  const {
    id, meta, theme, brief, cp, cfg, saveCp, tstep, tickers,
    dataGuideline, dataAutoTools, industryTemplatePrompt,
    companyTemplatePrompt, relatedFindings, emit,
  } = context;
  if (typeof emit !== 'function') throw new TypeError('selective remediation requires an event emitter');
  const remediation = cp.activeRemediation;
  const owners = new Set(remediation?.owners || []);
  const last = cp.rounds[cp.rounds.length - 1] || {};
  const round = cp.round + 1;
  const instructionText = remediationInstructions(remediation, owners);
  const remediationBrief = `${brief}\n\n<review_remediation cycle="${remediation.cycle}">\n${instructionText}\n</review_remediation>`;
  let dataContext = dataContextFromRound(context, last);
  let industry = last.industry || {};
  let companies = last.companies || [];

  emit(id, 'main-orchestrator', {
    step: 2,
    round,
    text: `选择性返工研究轮：仅执行 ${[...owners].join(' + ')} owner 分支，并保留未受影响的上一轮正式产物。`,
    data: { remediationCycle: remediation.cycle, owners: [...owners], issues: remediation.issues || [] },
  });

  if (owners.has('data')) {
    const result = await tstep(`remediation${remediation.cycle}:data`, () => runDataRound({
      id,
      tickers,
      theme,
      brief: remediationBrief,
      guideline: `${dataGuideline}\n\n【报告评审返工指令】\n${instructionText}`,
      autoTools: dataAutoTools,
      cfg,
      round,
      focus: {
        questions: (remediation.issues || []).filter((issue) => issue.owner === 'data').map((issue) => issue.requestedAction),
        tickers,
        tools: [],
      },
      asOf: cp.artifactAsOf,
      frozenData: context.options?.frozenDataByRound?.[round]
        || context.options?.frozenDataByRound?.[String(round)]
        || context.options?.frozenDataByRound?.[last.dataRound || last.round || 1]
        || context.options?.frozenDataByRound?.[String(last.dataRound || last.round || 1)]
        || null,
    }));
    dataContext = result.dataContext;
  }

  const topT = authoritativeCompanyTickers({
    meta,
    cp,
    fallbackTickers: (context.deepTickers || []).length ? context.deepTickers : tickers,
    maxTickers: DEEP_RESEARCH_CAP + 1,
  });
  const dataRound = owners.has('data') ? round : (last.round || cp.round);
  const tasks = [];
  if (owners.has('industry')) {
    tasks.push(tstep(`remediation${remediation.cycle}:industry`, () => runIndustryRound({
      projectId: id,
      round,
      dataRound,
      theme,
      brief: remediationBrief,
      dataContext,
      guidance: `${industryTemplatePrompt}\n\n【报告评审返工指令】\n${instructionText}`,
      relatedFindings,
      depth: cfg.depth,
    })).then((result) => { industry = result.industry; }));
  }
  if (owners.has('company')) {
    tasks.push(tstep(`remediation${remediation.cycle}:company`, () => runCompanyRound({
      projectId: id,
      round,
      dataRound,
      tickers: topT,
      theme,
      brief: remediationBrief,
      comparisonTickers: [],
      dataContext: { ...dataContext, industry },
      guidance: `${companyTemplatePrompt}\n\n【报告评审返工指令】\n${instructionText}`,
      depth: cfg.depth,
    })).then((result) => { companies = result.companies; }));
  }
  await Promise.all(tasks);

  if (owners.has('industry')) {
    ProjectFS.setAnalysisFile(id, 'industry.json', industry);
    const report = renderIndustryPrelimReport({ round, theme, industry, dataContext });
    ProjectFS.setAnalysisText(id, `industry_report_r${round}.md`, report);
    ProjectFS.setAnalysisText(id, 'industry_report.md', report);
    assertContractArtifactsCommitted(id, 'industry-analyst');
  }
  if (owners.has('company')) {
    ProjectFS.setAnalysisFile(id, 'company.json', companies);
    const report = renderCompanyPrelimReport({ round, theme, companies, dataContext });
    ProjectFS.setAnalysisText(id, `company_report_r${round}.md`, report);
    ProjectFS.setAnalysisText(id, 'company_report.md', report);
    assertContractArtifactsCommitted(id, 'company-analyst');
  }


  const entry = {
    round,
    dataRound,
    remediationCycle: remediation.cycle,
    remediationOwners: [...owners],
    industry,
    companies,
    nextFocus: dataContext.nextDataFocus || {},
    contradictions: dataContext.contradictions || [],
    briefs: dataContext.briefs || {},
    excerpts: dataContext.excerpts || [],
    quotes: dataContext.quotes || [],
    fundamentals: dataContext.fundamentals || {},
    dataReport: dataContext.dataReport || '',
    coverage: dataContext.coverage?.score ?? last.coverage ?? null,
  };
  cp.rounds.push(entry);
  if (cp.rounds.length > 1) {
    const previous = cp.rounds[cp.rounds.length - 2];
    for (const key of ['briefs', 'excerpts', 'quotes', 'fundamentals', 'dataReport', 'contradictions', 'industry', 'companies']) delete previous[key];
  }
  cp.round = round;
  cp.targetRounds = Math.max(cp.targetRounds, round);
  cp.maxRounds = Math.max(cp.maxRounds, round);
  saveCp();
  emit(id, 'main-orchestrator', {
    step: 2,
    round,
    text: `选择性返工研究轮完成：${[...owners].join(',')} 已更新；未命中分支调用数为 0。`,
    data: { remediationCycle: remediation.cycle, owners: [...owners] },
  });
  return entry;
}
