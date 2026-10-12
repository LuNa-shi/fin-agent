import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { TemplateSystem } from '../../../domains/research/templates/templateSystem.js';
import { FRAMEWORK_VERSION, runtime } from '../../../config.js';
import { topologicalNodeOrder } from '../../../core/workflow/WorkflowGraph.js';
import { stampWorkflowSpecIdentity } from '../../../core/workflow/WorkflowExecutor.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../workflowSpec.js';
import { assertWorkflowNodeCompletion } from '../completion/workflowCompletion.js';
import { RUN_ANALYSIS_CONDITION_BINDINGS } from '../policies/conditions.js';
import { INTENSITY } from '../policies/intensity.js';
import { reconcileCheckpointRemediation } from '../policies/remediation.js';
import { emit } from '../projection/events.js';
import { createArtifactRunId } from './runIdentity.js';

function checkpointOutputForNode(context, node) {
  const { cp, id } = context;
  if (node.id === 'initialize-checkpoint') return cp;
  if (node.id === 'plan-research') return cp.plan;
  if (node.id === 'select-candidates') return cp.scan;
  if (node.id === 'run-research-rounds') return cp.rounds;
  if (node.id === 'compose-report') return ProjectFS.draftReport(id);
  if (node.id === 'review-report') return cp.reportReview;
  if (node.id === 'synthesize-conclusion') return cp.conclusion;
  if (node.id === 'finalize-project') {
    return {
      finalReport: { path: ProjectFS.latestReportPath(id) },
      metaPatch: ProjectFS.meta(id),
    };
  }
  return null;
}

function checkpointShowsNodeComplete(context, node) {
  return RUN_ANALYSIS_CONDITION_BINDINGS[node.conditionId](context, node) === false;
}

function reconcileRunStoreFromCheckpoint(context) {
  if (!context.runStore || !context.runId || !context.cp) return;
  for (const nodeId of topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC)) {
    if (nodeId === 'initialize-checkpoint') continue;
    const node = RUN_ANALYSIS_WORKFLOW_SPEC.nodes.find((candidate) => candidate.id === nodeId);
    const durable = context.runStore.load(context.runId).nodes[nodeId];
    if (durable.status === 'SUCCEEDED') continue;
    const checkpointExecution = context.cp.nodeExecutions?.[nodeId];
    if (checkpointExecution?.status === 'succeeded') {
      const refs = checkpointExecution.artifactRefs || [];
      if (refs.length || node.artifactPolicy === 'pure-return') {
        context.runStore.reconcileSucceededNode(context.runId, nodeId, {
          artifactRefs: refs,
          output: checkpointExecution.output,
          pureReturn: node.artifactPolicy === 'pure-return',
          attempt: checkpointExecution.attempt || 1,
        });
        continue;
      }
    }
    if (!checkpointShowsNodeComplete(context, node)) continue;
    try {
      const result = checkpointOutputForNode(context, node);
      const completion = assertWorkflowNodeCompletion({ context, node, result });
      context.runStore.reconcileSucceededNode(context.runId, nodeId, {
        artifactRefs: completion.artifacts,
        output: completion.output,
        pureReturn: node.artifactPolicy === 'pure-return',
      });
    } catch (error) {
      if (['CONTRACT_COMPLETION_REJECTED', 'ARTIFACT_FILE_MISSING'].includes(error?.code)) continue;
      throw error;
    }
  }
  context.saveCp?.();
}

export async function prepareCheckpointContext(context, { emitLifecycle = true } = {}) {
  const { id, options } = context;
  const meta = ProjectFS.meta(id);
  if (!meta) throw new Error('project not found');
  const checkCancelled = () => {
    if (options.cancelled?.() || ProjectFS.meta(id)?.status === 'paused') {
      throw new Error('analysis paused or cancelled');
    }
  };
  checkCancelled();

  // ---- 载入/初始化 checkpoint ----
  const storedCheckpoint = options.resume ? ProjectFS.checkpoint(id) : null;
  // A checkpoint without an explicit Workflow identity predates durable v2
  // topology and is never silently migrated into the analysis-first graph.
  if (storedCheckpoint && !storedCheckpoint.workflowSpec) {
    throw new Error('checkpoint workflow spec identity is missing; legacy Run Analysis checkpoint cannot resume');
  }
  const existing = storedCheckpoint
    ? stampWorkflowSpecIdentity(storedCheckpoint, RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH)
    : null;
  const runRecord = context.runStore?.load(context.runId) || context.runRecord || null;
  if (existing?.artifactRunId && runRecord && existing.artifactRunId !== runRecord.runId) {
    throw new Error(`checkpoint run conflict: expected ${runRecord.runId}, got ${existing.artifactRunId}`);
  }
  const resuming = options.resume === true && !!(runRecord || (existing && !existing.done));
  const intensityKey = existing?.intensityKey || options.intensity || meta.intensity || 'standard';
  const cfg = INTENSITY[intensityKey] || INTENSITY.standard;
  const baseRounds = cfg.rounds || 1;
  const maxRounds = cfg.maxRounds || baseRounds;
  const theme = meta.title;
  // 工作语言：海外公司的一手材料（filings/transcripts/研报）是英文，分析与中间产物用英文保真度与效率
  // 更高（中文 prompt 曾导致全部中间文件是中文）。最终报告按 reportLanguage；结构化枚举字段保持规定值。
  const analysisLang = meta.analysisLanguage || runtime.ANALYSIS_LANGUAGE || 'en';
  const langDirective = analysisLang === 'en'
    ? `\n<working_language>Do ALL analysis, intermediate artifacts, notes, tool-call queries (web/research searches), and JSON free-text fields in ENGLISH (primary sources are English; English keeps quotes and figures faithful). This applies EVEN IF the brief above is written in Chinese — restate it to yourself in English and work in English throughout. Enum fields use their prescribed ENGLISH values (e.g. rating strong_buy|buy|hold|avoid|strong_avoid).</working_language>`
    : '';
  // 研究任务书：title+theme+rationale 完整传给每个分析 agent——rationale 里往往写着用户真正想回答的
  // 具体问题（曾因只传 theme 导致任务书要求全程丢失：GOOGL 项目的管理层/相对表现/技术路线问题无人回应）。
  // 包装必须英文：中文包装曾把上下文主导语言带偏成中文，langDirective 压不住（批测项目结论全中文）。
  const brief = `<research_brief>Respond to EVERY item below; for items outside your role, note briefly which agent covers them.\nTitle: ${meta.title}\nTheme: ${meta.theme || '—'}\nRequirements: ${meta.rationale || '—'}</research_brief>${langDirective}`;
  // 模板匹配用 title+theme+rationale 全文（只看 title 会漏：如「英伟达…」不含"半导体"关键词）
  const matchText = `${theme} ${meta.theme || ''} ${meta.rationale || ''}`;
  const industryTplId = existing?.industryTplId || options.industryTemplate || meta.industryTemplate || null;
  const companyTplId = existing?.companyTplId || options.companyTemplate || meta.companyTemplate || null;
  let industryTpl = industryTplId ? TemplateSystem.get(industryTplId) : null;
  let companyTpl = companyTplId ? TemplateSystem.get(companyTplId) : null;
  if (!industryTpl || industryTpl.kind !== 'industry') industryTpl = TemplateSystem.matchIndustryTemplate(matchText).template;
  if (!companyTpl || companyTpl.kind !== 'company') companyTpl = TemplateSystem.matchCompanyTemplate(matchText).template;

  let cp;
  if (resuming && existing) {
    cp = existing;
    if (emitLifecycle) emit(id, 'initial-plan', { step: 1, text: `断点续跑「${theme}」：已完成 ${cp.round}/${cp.targetRounds || baseRounds} 轮${cp.reportDone ? ' + 报告' : ''}，从中断处继续。` });
  } else {
    if (!resuming) {
      ProjectFS.clearEvents(id);
      ProjectFS.clearCheckpoint(id);
    }
    cp = {
      v: 2,
      workflowSpec: {
        id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
        version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
        hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
      },
      intensityKey,
      industryTplId: industryTpl?.id || null,
      companyTplId: companyTpl?.id || null,
      theme,
      plan: null,
      tickers: [],
      round: 0,
      targetRounds: baseRounds,
      maxRounds,
      rounds: [],
      reportDone: false,
      conclusion: null,
      done: false,
      artifactRunId: runRecord?.runId || createArtifactRunId(id),
      artifactAsOf: runRecord?.asOf || new Date().toISOString(),
      nodeExecutions: {},
    };
    if (emitLifecycle) {
      emit(id, 'initial-plan', {
        step: 1,
        text: resuming
          ? `恢复「${theme}」的 durable run：checkpoint 尚未建立，从 initialize-checkpoint 继续。`
          : `定义问题：「${theme}」。力度：${cfg.label}（${baseRounds} 个固定研究轮次）。先完成 Data closure，再基于同一数据版本并行执行 Industry 与 Company。`,
        data: { intensity: intensityKey, industryTemplate: industryTpl?.name, companyTemplate: companyTpl?.name, rounds: baseRounds, maxRounds },
      });
    }
  }
  cp.targetRounds = cp.targetRounds || baseRounds;
  cp.maxRounds = cp.maxRounds || maxRounds;
  cp.artifactRunId = cp.artifactRunId || runRecord?.runId || createArtifactRunId(id);
  cp.artifactAsOf = cp.artifactAsOf || runRecord?.asOf || new Date().toISOString();
  cp.nodeExecutions = cp.nodeExecutions || {};
  cp.reportReviewHistory = cp.reportReviewHistory || [];
  cp.industryTplId = cp.industryTplId || industryTpl?.id || null;
  cp.companyTplId = cp.companyTplId || companyTpl?.id || null;
  reconcileCheckpointRemediation(cp, runRecord);
  cp.runtimeMetrics = context.runtimeMetrics.snapshot();
  // Historical checkpoints are accepted and stamped. A conflicting identity has
  // already failed closed above, before events, metadata, or analysis work changed.
  ProjectFS.setCheckpoint(id, cp);
  ProjectFS.updateMeta(id, {
    status: 'analyzing',
    intensity: intensityKey,
    industryTemplate: industryTpl?.id || null,
    industryTemplateName: industryTpl?.name || null,
    companyTemplate: companyTpl?.id || null,
    companyTemplateName: companyTpl?.name || null,
    lastError: null,
    frameworkVersion: FRAMEWORK_VERSION,
  });
  // Runtime metrics are observational only. Agent definitions own deadline/token/context
  // boundaries and retain high turn/tool-call anomaly fuses; the Workflow no longer owns a
  // second mutable resource limiter.
  const saveCp = () => {
    cp.updatedAt = Date.now();
    cp.runtimeMetrics = context.runtimeMetrics.snapshot();
    ProjectFS.setCheckpoint(id, cp);
  };

  // 计时遥测：每步耗时累计进 cp.timings（含重试；断点续跑跨进程累计），结束时写 meta 并输出分解。
  // 不测量就没法优化——这是模型分层/并行化决策的数据基础。
  cp.timings = cp.timings || {};
  const tstep = async (key, fn) => {
    checkCancelled();
    const t0 = Date.now();
    try {
      const out = await fn();
      checkCancelled();
      return out;
    }
    finally { cp.timings[key] = (cp.timings[key] || 0) + (Date.now() - t0); }
  };

  Object.assign(context, {
    meta, checkCancelled, resuming, intensityKey, cfg, baseRounds, maxRounds,
    theme, brief, matchText, industryTpl, companyTpl, cp,
    saveCp, tstep, emit,
  });
  reconcileRunStoreFromCheckpoint(context);
  return cp;
}
