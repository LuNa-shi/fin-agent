import { createHash } from 'node:crypto';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { runReviewerGroup } from '../reviewers/reviewerGroup.js';
import { buildEvidenceReviewProvenance } from '../reviewers/reviewProvenance.js';
import {
  auditReportQuality,
  deriveMaterialClaimsFromReport,
} from '../reviewers/reportQualityAudit.js';
import { authoritativeCompanyTickers } from '../research/tickerScope.js';
import { DEEP_RESEARCH_CAP as DEEP_CAP } from '../research/selectiveResearchRemediation.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { RUN_ANALYSIS_WORKFLOW_SPEC } from '../workflowSpec.js';
import { emit } from '../projection/events.js';
import { runReportScorecards } from '../reviewers/reportScorecards.js';

function reportReviewIdentity(cp, cycle, reviewRound) {
  const remediation = cp.activeRemediation;
  if (remediation?.kind !== 'human-review') {
    return {
      kind: 'automatic',
      cycle,
      reviewRound,
    };
  }
  return {
    kind: 'human-review',
    automaticRemediationCycle: cycle,
    humanReviewAttempt: remediation.humanReviewAttempt,
    reviewRound,
    taskId: remediation.taskId,
    taskVersion: remediation.taskVersion,
    decisionId: remediation.decisionId,
    decisionDigest: remediation.decisionDigest,
    selectedAction: remediation.selectedAction,
    downgradeInstruction: structuredClone(remediation.downgradeInstruction),
  };
}

function historyReviewIdentity(value) {
  if (value?.reviewIdentity) return value.reviewIdentity;
  const cycle = Number.isInteger(value?.decision?.cycle) ? value.decision.cycle : 0;
  const reviewRound = Number.isInteger(value?.reviewRound) ? value.reviewRound : cycle + 1;
  return { kind: 'automatic', cycle, reviewRound };
}

function reviewIdentityDigest(identity) {
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function readProjectJson(projectId, relPath) {
  try {
    return JSON.parse(ProjectFS.fileContent(projectId, relPath) || 'null');
  } catch {
    return null;
  }
}

function reportEvidenceForRounds(projectId, rounds) {
  const sourceDocuments = [];
  const evidenceItems = [];
  const contradictions = [];
  for (const item of rounds || []) {
    const sourceSet = readProjectJson(projectId, `data/source_documents_r${item.round}.json`) || {};
    const evidenceBundle = readProjectJson(projectId, `data/evidence_bundle_r${item.round}.json`) || {};
    sourceDocuments.push(...(sourceSet.documents || []));
    evidenceItems.push(...(evidenceBundle.items || evidenceBundle.evidenceItems || []));
    contradictions.push(...(evidenceBundle.contradictions || []));
  }
  return {
    sourceDocuments,
    evidenceItems,
    contradictions,
    citationLedger: readProjectJson(projectId, 'data/citation_ledger.json'),
  };
}

export function canonicalReportQualityIssues(audit) {
  const issues = [];
  const issue = (id, message, remediation, location = 'report') => ({
    id,
    severity: 'critical',
    owner: 'report',
    message,
    location,
    evidenceRefs: [],
    remediation,
  });
  const unresolvedLabels = audit.markers?.unresolvedSourceLabels || [];
  if (audit.checks?.sourceLabelsResolved !== true) {
    issues.push(issue(
      'gate-canonical-source-labels',
      `Report contains ${audit.markers?.unresolvedSourceMarkers || 0} unresolved or ambiguous source markers: ${unresolvedLabels.slice(0, 8).join(', ') || 'unreported labels'}.`,
      'Replace each unresolved/ambiguous marker with an exact marker or project-unique alias from data/citation_ledger.json; navigation-only artifact labels are not atomic evidence.',
    ));
  }
  if (audit.checks?.citationCoverage !== true) {
    const missing = (audit.claims?.audits || [])
      .filter((claim) => claim.citationRequired !== false && !claim.cited)
      .slice(0, 8)
      .map((claim) => `line ${claim.reportLine || '?'}: ${String(claim.assertion || '').slice(0, 120)}`);
    issues.push(issue(
      'gate-material-claim-citation-coverage',
      `Material-claim citation coverage is ${audit.claims?.citationCoverage ?? 0}; required minimum is 0.95.`,
      `Attach canonical atomic citations to uncited factual claims or mark unsupported analysis [est]/[open-issue]. Examples: ${missing.join(' | ') || 'see report quality artifact'}.`,
    ));
  }
  if (audit.checks?.traceabilityCoverage !== true) {
    const missing = (audit.claims?.audits || []).filter((claim) => !claim.traceable).slice(0, 8)
      .map((claim) => `line ${claim.reportLine || '?'}: ${String(claim.assertion || '').slice(0, 120)}`);
    issues.push(issue(
      'gate-material-claim-traceability',
      `Material-claim traceability coverage is ${audit.claims?.traceabilityCoverage ?? 0}; required value is 1.0.`,
      `Map every material claim to an EvidenceItem/SourceDocument marker, [est], or [open-issue]. Workflow artifacts such as data_report/company.json/reflection_rN do not qualify. Examples: ${missing.join(' | ') || 'see report quality artifact'}.`,
    ));
  }
  if (audit.checks?.requiredSections !== true || audit.checks?.materialClaimPopulation !== true || audit.checks?.materialClaimsLocated !== true) {
    issues.push(issue(
      'gate-report-quality-structure',
      `Canonical report structure/claim-location checks failed (required-section pass=${audit.structure?.requiredSectionPassRate ?? 0}, location coverage=${audit.claims?.locationCoverage ?? 0}).`,
      'Restore all required substantive sections and ensure every material claim is uniquely locatable in the report.',
    ));
  }
  if (audit.checks?.criticalContradictions !== true) {
    issues.push(issue(
      'gate-critical-contradictions',
      `Report contains ${audit.contradictions?.unresolvedCriticalContradictedMaterialClaims || 0} unresolved critical contradicted material claims.`,
      'Remove, resolve, or explicitly caveat each contradicted material claim before publication.',
    ));
  }
  return issues;
}

export async function reviewReport(context, _node, { shouldRun }) {
  const {
    id, meta, theme, brief, cp, last, tickers, deepTickers, companies, saveCp, tstep,
  } = context;
  // Week 3：报告草稿进入相互独立的 Evidence / Requirement / Logic Reviewer Group；
  // deterministic adjudicator 的 blocking issues 由 executor 路由到最多两轮选择性返工。
  if (shouldRun) {
    const cycle = cp.activeRemediation?.cycle ?? 0;
    const reviewRound = cp.activeRemediation?.reviewRound ?? cycle + 1;
    const reviewIdentity = reportReviewIdentity(cp, cycle, reviewRound);
    const currentReviewIdentityDigest = reviewIdentityDigest(reviewIdentity);
    const priorReviewIssues = cp.activeRemediation?.issues || [];
    const draftReport = ProjectFS.draftReport(id);
    const reportEvidence = reportEvidenceForRounds(id, cp.rounds);
    const materialClaims = deriveMaterialClaimsFromReport(draftReport);
    const qualityAudit = auditReportQuality({
      report: draftReport,
      materialClaims,
      sourceDocuments: reportEvidence.sourceDocuments,
      evidenceItems: reportEvidence.evidenceItems,
      citationLedger: reportEvidence.citationLedger,
      manifests: [ProjectFS.sourceManifest(id), ProjectFS.artifactManifest(id)],
      contradictions: reportEvidence.contradictions,
    });
    const qualityIssues = canonicalReportQualityIssues(qualityAudit);
    ProjectFS.setAnalysisFile(id, `reviews/report_quality_r${reviewRound}.json`, qualityAudit);
    const citationLedger = reportEvidence.citationLedger;
    const reviewAsOf = cp.artifactAsOf;
    const reviewProvenance = buildEvidenceReviewProvenance({
      sourceManifest: ProjectFS.sourceManifest(id),
      citationLedger,
      asOf: reviewAsOf,
    });
    const evidenceBundle = {
      sourceManifest: reviewProvenance.sourceManifest,
      toolCoverage: ProjectFS.toolCoverage(id),
      dataCoverage: last.coverage ?? null,
      contradictions: (last.contradictions || []).slice(0, 20),
      citationContract: reviewProvenance.citationContract,
      reportQualityAudit: {
        passed: qualityAudit.passed,
        checks: qualityAudit.checks,
        citationCoverage: qualityAudit.claims.citationCoverage,
        traceabilityCoverage: qualityAudit.claims.traceabilityCoverage,
        requiredSectionPassRate: qualityAudit.structure.requiredSectionPassRate,
        unresolvedSourceLabels: qualityAudit.markers.unresolvedSourceLabels,
      },
    };
    const inputDigest = `sha256:${createHash('sha256').update(JSON.stringify({
      brief,
      evidenceBundle,
      draftReport,
      qualityAudit,
      reviewIdentity,
    })).digest('hex')}`;
    emit(id, 'final-report', { step: 3, agent: 'reviewer-group', text: '独立报告评审：Evidence / Requirement / Logic 三个 reviewer 并行审阅，随后执行确定性裁决。' });
    const reviewResult = await tstep('report-review', () => runReviewerGroup({
      projectId: id,
      workflowId: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      runId: `${id}:report-review:${reviewRound}`,
      asOf: reviewAsOf,
      createdAt: reviewAsOf,
      inputDigest,
      draftReport,
      researchBrief: {
        title: theme,
        question: meta.rationale || theme,
        theme: meta.theme || theme,
        entities: authoritativeCompanyTickers({
          meta,
          cp,
          fallbackTickers: deepTickers?.length ? deepTickers : tickers,
          maxTickers: DEEP_CAP + 1,
        }),
      },
      evidenceBundle,
      companies,
      deterministicIssues: qualityIssues,
      reviewIdentity,
      humanReviewDecision: reviewIdentity.kind === 'human-review'
        ? {
          decisionId: reviewIdentity.decisionId,
          decisionDigest: reviewIdentity.decisionDigest,
          selectedAction: reviewIdentity.selectedAction,
          downgradeInstruction: reviewIdentity.downgradeInstruction,
        }
        : null,
      inputArtifactRefs: [
        'report/report.md',
        'data/source_manifest.json',
        'analysis/tool_coverage.json',
        'data/citation_ledger.json',
      ],
      priorReviewIssues,
      cycle,
    }, { reviewerRuntime: { stage: 'report-review' } }));
    let scorecardResult;
    try {
      scorecardResult = await tstep('report-scorecards', () => runReportScorecards(context, {
        reviewRound,
        cycle,
        draftReport,
        researchBrief: {
          title: theme,
          question: meta.rationale || theme,
          theme: meta.theme || theme,
          entities: authoritativeCompanyTickers({
            meta,
            cp,
            fallbackTickers: deepTickers?.length ? deepTickers : tickers,
            maxTickers: DEEP_CAP + 1,
          }),
        },
        evidenceBundle,
        priorOpenIssues: [],
      }));
    } catch {
      scorecardResult = { status: 'unavailable', outputs: {}, results: [] };
    }
    // Scorecards are observational only. Their failure must never replace or mutate
    // the three-reviewer result, publication state, or remediation decision. The
    // result is intentionally consumed only as a best-effort side effect here;
    // unavailable scorecards remain absent from reviewer/adjudication state.
    void scorecardResult;
    reviewResult.reviewRound = reviewRound;
    reviewResult.reviewIdentity = reviewIdentity;
    reviewResult.reviewIdentityDigest = currentReviewIdentityDigest;
    reviewResult.decision = {
      ...reviewResult.decision,
      reviewIdentity,
      reviewIdentityDigest: currentReviewIdentityDigest,
    };
    for (const result of reviewResult.reviewerResults || []) {
      emit(id, 'subagent', {
        stage: 'report-review',
        agent: result.contractId,
        text: `${result.contractId} 完成：status=${result.status || 'unknown'}，stop=${result.stopReason || 'unknown'}。`,
        data: {
          status: result.status || null,
          stopReason: result.stopReason || null,
          steps: result.metrics?.turns ?? 0,
          valid: result.valid === true,
          live: result.live === true,
          provider: result.provider || null,
          model: result.model || null,
        },
      });
    }
    for (const review of reviewResult.reviews) {
      if (!review?.reviewerType) continue;
      ProjectFS.setAnalysisFile(id, `reviews/${review.reviewerType}_r${reviewRound}.json`, review);
    }
    assertContractArtifactsCommitted(id, 'evidence-reviewer');
    assertContractArtifactsCommitted(id, 'requirement-reviewer');
    assertContractArtifactsCommitted(id, 'logic-reviewer');
    ProjectFS.setAnalysisFile(id, 'report_review_decision.json', reviewResult.decision);
    cp.reportReview = reviewResult;
    cp.reportReviewHistory = [
      ...(cp.reportReviewHistory || []).filter((item) => (
        reviewIdentityDigest(historyReviewIdentity(item)) !== currentReviewIdentityDigest
      )),
      structuredClone(reviewResult),
    ].sort((a, b) => (
      historyReviewIdentity(a).reviewRound - historyReviewIdentity(b).reviewRound
    ));
    saveCp();
    const criticalCount = reviewResult.decision.openIssues.filter((issue) => issue.severity === 'critical').length;
    emit(id, 'final-report', {
      step: 3,
      agent: 'review-adjudicator',
      text: reviewResult.decision.converged
        ? '报告评审收敛：所有 reviewer 与 deterministic gates 通过。'
        : `报告评审未收敛：cycle=${cycle}，route=${reviewResult.decision.route}，critical=${criticalCount}；由 executor 进入最小子图返工，返工上限后继续生成最终报告。`,
      data: reviewResult.decision,
      artifact: 'analysis/report_review_decision.json',
    });
  }
  return hydrateReviewReport(context);
}

export async function hydrateReviewReport(context) {
  return context.cp.reportReview;
}

export { reviewReport as execute, hydrateReviewReport as hydrate };
