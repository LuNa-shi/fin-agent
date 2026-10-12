import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { runtime } from '../../../config.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { emit } from '../projection/events.js';
import { selectReportMarkdown } from '../projection/reportMarkdown.js';

function promptSafeJson(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

export async function composeReport(context, _node, { shouldRun }) {
  const {
    id, meta, theme, brief, cp, cfg, saveCp, tstep,
    industry, companies, briefs,
  } = context;
  // ---- Phase 1 产出：报告（checkpoint：cp.reportDone）----
  // M2：composer 跑在 runtime 上，用 ws_read_file 读累计数据报告与各轮产物全文（不再 slice 截断）。
  // 提速：报告撰写与 Phase 2 的「crux 研判→推演」互不依赖 → 并行执行，结论前汇合。
  if (!shouldRun) return hydrateComposeReport(context);
  emit(id, 'final-report', { step: 3, text: 'final report：综合 data/industry/company loop 产物，撰写深度报告（与推演并行）。' });
  const reportLang = meta.reportLanguage || runtime.REPORT_LANGUAGE || 'en';
  const priorReviewIssues = cp.activeRemediation?.issues || [];
  const humanReviewRemediation = cp.activeRemediation?.kind === 'human-review'
    ? {
      kind: 'human-review',
      automaticRemediationCycle: cp.activeRemediation.cycle,
      humanReviewAttempt: cp.activeRemediation.humanReviewAttempt,
      reviewRound: cp.activeRemediation.reviewRound,
      decisionId: cp.activeRemediation.decisionId,
      decisionDigest: cp.activeRemediation.decisionDigest,
      selectedAction: cp.activeRemediation.selectedAction,
      downgradeInstruction: cp.activeRemediation.downgradeInstruction,
      issues: priorReviewIssues,
      publicationGate: 'canonical-review-required',
    }
    : null;
  const remediationBrief = humanReviewRemediation
    ? `${brief}\n\n<human_review_remediation>\n${promptSafeJson(humanReviewRemediation)}\n</human_review_remediation>`
    : priorReviewIssues.length
    ? `${brief}\n\n<review_remediation cycle="${cp.activeRemediation.cycle}">\n${priorReviewIssues.map((issue, index) => `${index + 1}. [${issue.owner}/${issue.severity}] ${issue.requestedAction} (location: ${issue.location})`).join('\n')}\n</review_remediation>`
    : brief;
  let citationLedger = null;
  try {
    citationLedger = JSON.parse(ProjectFS.fileContent(id, 'data/citation_ledger.json') || 'null');
  } catch {}
  const citationContract = citationLedger
    ? `<citation_contract ledger="data/citation_ledger.json" digest="${citationLedger.inputDigest}">
For every factual material claim, use an exact EvidenceItem/SourceDocument marker or a project-unique alias listed in the ledger.
The ledger's navigationOnlyArtifacts (including data_report, company.json, industry.json, and reflection_rN) are navigation aids, never atomic evidence citations.
If atomic support is absent, use [est] or [open-issue: missing evidence]. Keep one marker per bracket; compound-marker parsing is compatibility-only.
</citation_contract>`
    : '<citation_contract status="missing">Atomic citation ledger is unavailable; do not present unsupported factual material claims.</citation_contract>';
  const reportBrief = `${remediationBrief}\n\n${citationContract}`;
  const priorReport = ProjectFS.draftReport(id);
  const atomicEvidenceFiles = [
    'data/citation_ledger.json',
    ...cp.rounds.flatMap((item) => [
    `data/source_documents_r${item.round}.json`,
    `data/evidence_bundle_r${item.round}.json`,
    ]),
  ];
  const reportRes = await tstep('report', () => runDefinedAgent('report-composer', {
    language: reportLang === 'zh' ? 'Chinese (中文)' : 'English',
    brief: reportBrief,
    theme,
    files: [
      ...atomicEvidenceFiles,
      'data/data_report.md',
      'analysis/industry.json',
      'analysis/company.json',
    ],
    preview: `Industry: ${(industry?.structuralView || '').slice(0, 200)}\nCompanies: ${companies.map((c) => `${c.ticker}(${c.conviction ?? '—'})`).join(', ')}\nFundamentals: ${briefs.fundamentals || ''}`,
  }, {
    deadlineMs: (cfg.depth?.composerMin ?? 8) * 60000,
    step: 3, stage: 'report', artifact: 'report/report.md',
    kind: 'analysis-report', temperature: 0.55,
  }));
  const reportMd = selectReportMarkdown({
    returnedText: reportRes.text,
    writtenReport: ProjectFS.draftReport(id),
    priorReport,
    live: reportRes.live,
  });
  ProjectFS.setReport(id, reportMd || `# ${theme}\n\n_报告生成失败（demo/降级模式）。_`);
  assertContractArtifactsCommitted(id, 'report-composer');
  cp.reportDone = true; saveCp();
  emit(id, 'final-report', { step: 3, text: `阶段报告已生成（report/report.md）：${reportRes.metrics?.toolCalls ?? 0} 次文件读取，${reportMd.length} 字符。` });
  return reportMd;
}

export async function hydrateComposeReport(context) {
  return ProjectFS.draftReport(context.id);
}

export { composeReport as execute, hydrateComposeReport as hydrate };
