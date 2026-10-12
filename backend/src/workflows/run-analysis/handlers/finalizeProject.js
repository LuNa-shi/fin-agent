import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { FRAMEWORK_VERSION } from '../../../config.js';
import { emit } from '../projection/events.js';

export async function finalizeProject(context, _node, { shouldRun }) {
  const { id, meta, cp, industry, conclusion, last } = context;
  if (!shouldRun) return hydrateFinalizeProject(context);

  // Analysis-first publication deliberately publishes the canonical Composer body
  // only. Forecast, Scenario, and numeric-fidelity tails remain compatibility
  // readers for historical projects but are not active node outputs.
  const report = ProjectFS.draftReport(id);
  const finalReport = ProjectFS.setTimestampedReport(id, report, {
    language: meta.reportLanguage || 'en',
    ts: Date.parse(cp.artifactAsOf),
  });
  emit(id, 'final-report', {
    step: 4,
    text: `既有 canonical report 已原样发布：${finalReport.path}`,
    data: { report: finalReport.path },
  });

  const totalMs = Object.values(cp.timings || {}).reduce((sum, value) => sum + value, 0);
  const breakdown = Object.entries(cp.timings || {}).sort((a, b) => b[1] - a[1])
    .map(([key, ms]) => `${key} ${(ms / 1000).toFixed(0)}s(${totalMs ? Math.round(ms / totalMs * 100) : 0}%)`)
    .join(' · ');
  emit(id, 'final-report', {
    step: 4,
    text: `分析结束。总耗时 ${(totalMs / 60000).toFixed(1)}min｜${breakdown}`,
    data: { timings: cp.timings || {}, totalMs },
  });

  return {
    finalReport,
    metaPatch: {
      status: 'analyzed',
      analyzedAt: Date.parse(cp.artifactAsOf),
      rounds: cp.targetRounds,
      frameworkVersion: FRAMEWORK_VERSION,
      conclusion,
      scenarios: null,
      worldTraceId: null,
      industryView: industry?.structuralView || null,
      reflectionDepth: null,
      recommendationScore: conclusion?.recommendationScore ?? null,
      dataCoverage: last?.coverage ?? null,
      timings: { ...(cp.timings || {}), totalMs },
      runtimeMetrics: context.runtimeMetrics.snapshot(),
      live: cp.live,
    },
  };
}

export async function hydrateFinalizeProject(context) {
  context.cp.done = true;
  context.saveCp?.();
  return ProjectFS.updateMeta(context.id, { status: 'analyzed', lastError: null });
}

export { finalizeProject as execute, hydrateFinalizeProject as hydrate };
