import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { reviewDependencyDigest } from '../../../domains/research/contracts/reviewDependency.js';
import { authoritativeCompanyTickers } from '../research/tickerScope.js';
import { DEEP_RESEARCH_CAP } from '../research/selectiveResearchRemediation.js';

export const REPORT_SCORECARD_LENSES = Object.freeze(['data', 'industry', 'company']);

function executionRefs(context, nodeId) {
  return context.cp?.nodeExecutions?.[nodeId]?.artifactRefs || [];
}

function requiredRef(refs, path, source) {
  const matches = refs.filter((ref) => ref?.path === path);
  if (matches.length !== 1) throw new TypeError(`${source} must provide exactly one ArtifactRef for ${path}`);
  return structuredClone(matches[0]);
}

function reportScorecardIdentity(context) {
  const composeRefs = executionRefs(context, 'compose-report');
  const candidate = composeRefs.find((ref) => ref?.path === 'report/report.md');
  if (!candidate) return null;
  const candidateRef = structuredClone(candidate);
  const researchRefs = executionRefs(context, 'run-research-rounds');
  const dependencyRefs = {
    data: [requiredRef(researchRefs, 'data/data_report.md', 'run-research-rounds')],
    industry: [requiredRef(researchRefs, 'analysis/industry.json', 'run-research-rounds')],
    company: [requiredRef(researchRefs, 'analysis/company.json', 'run-research-rounds')],
  };
  return {
    candidateIdentity: {
      candidateRef,
      candidateDigest: candidateRef.contentDigest,
    },
    dependencyIdentity: {
      dependencyRefs,
      dependencyDigest: reviewDependencyDigest(dependencyRefs),
    },
  };
}

function materialIndustries(context) {
  const industryId = String(
    context.meta?.theme
    || context.meta?.industryTemplateName
    || context.theme
    || 'primary-industry',
  ).trim();
  return [{
    industryId,
    classification: 'material',
    materialityWeightBps: 10000,
  }];
}

function compactResult(contractId, value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasOutput = Object.prototype.hasOwnProperty.call(result, 'output');
  return {
    contractId,
    output: hasOutput ? result.output : value,
    status: result.status,
    stopReason: result.stopReason,
    valid: result.valid,
    live: result.live,
    provider: result.provider,
    model: result.model,
    metrics: result.metrics && typeof result.metrics === 'object' ? { ...result.metrics } : {},
    errors: Array.isArray(result.errors) ? [...result.errors] : [],
    error: result.error ? { code: result.error.code || null, message: result.error.message || null } : null,
  };
}

export async function runReportScorecards(context, {
  reviewRound,
  cycle,
  draftReport,
  researchBrief,
  evidenceBundle,
  priorOpenIssues = [],
  runEvaluator = runDefinedAgent,
} = {}) {
  if (typeof runEvaluator !== 'function') throw new TypeError('runEvaluator must be a function');
  const identity = reportScorecardIdentity(context);
  if (!identity) return { outputs: {}, results: [], identity: null };
  const authoritativeTickers = authoritativeCompanyTickers({
    meta: context.meta,
    cp: context.cp,
    fallbackTickers: context.deepTickers?.length ? context.deepTickers : context.tickers,
    maxTickers: DEEP_RESEARCH_CAP + 1,
  });
  const industries = materialIndustries(context);
  const common = {
    projectId: context.id,
    scope: { projectId: context.id, authoritativeTickers, industries },
    asOf: context.cp.artifactAsOf,
    createdAt: context.cp.artifactAsOf,
    draftReport,
    researchBrief,
    evidenceBundle,
    priorOpenIssues,
    cycle,
    ...identity,
    inputDigest: canonicalSha256({
      projectId: context.id,
      reviewRound,
      cycle,
      ...identity,
    }),
  };
  const inputs = {
    data: common,
    industry: { ...common, materialIndustries: industries, weightsAuditable: true },
    company: { ...common, authoritativeTickers },
  };
  const results = [];
  for (const lens of REPORT_SCORECARD_LENSES) {
    const contractId = `${lens}-scoreboard-evaluator`;
    try {
      const result = await runEvaluator(contractId, inputs[lens], {
        callId: `report-scorecard:${lens}:r${reviewRound}`,
        stage: 'report-review-scorecard',
        throwOnFailure: false,
      });
      results.push(compactResult(contractId, result));
    } catch (error) {
      results.push(compactResult(contractId, {
        status: 'failed',
        valid: false,
        stopReason: error?.stopReason || 'error',
        error: { code: error?.code || 'SCORECARD_EVALUATION_FAILED' },
      }));
    }
  }
  const outputs = {};
  const failures = results.filter((result) => result.status === 'failed' || result.valid !== true || !result.output);
  if (failures.length) {
    return {
      outputs: {},
      results,
      identity,
      status: 'unavailable',
      unavailable: true,
      failures: failures.map((result) => ({ contractId: result.contractId, status: result.status || null, stopReason: result.stopReason || null })),
    };
  }
  for (const result of results) {
    const lens = result.contractId.replace('-scoreboard-evaluator', '');
    outputs[lens] = result.output;
  }
  for (const lens of REPORT_SCORECARD_LENSES) {
    ProjectFS.setAnalysisFile(context.id, `scorecards/${lens}_r${reviewRound}.json`, outputs[lens]);
  }
  return { outputs, results, identity };
}
