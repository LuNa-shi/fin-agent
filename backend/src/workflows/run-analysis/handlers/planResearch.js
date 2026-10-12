import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { TemplateSystem } from '../../../domains/research/templates/templateSystem.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { parseJsonOutput } from '../../../core/validation/OutputGate.js';
import { assertContractArtifactsCommitted } from '../completion/workflowCompletion.js';
import { emit } from '../projection/events.js';

function normalizePlanCandidate(candidate) {
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const ticker = String(candidate.ticker || candidate.symbol || '').trim().toUpperCase();
    if (!ticker) return null;
    return {
      ...candidate,
      ticker,
      name: candidate.name || ticker,
      role: candidate.role || '候选',
      reason: candidate.reason || '',
    };
  }
  const ticker = String(candidate || '').trim().toUpperCase();
  if (!ticker) return null;
  return { ticker, name: ticker, role: '候选', reason: '' };
}

export function normalizeAnalysisPlanOutput(output, fallback = {}) {
  const parsed = typeof output === 'string' ? parseJsonOutput(output) : output;
  const plan = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  const fallbackCandidates = Array.isArray(fallback.candidates)
    ? fallback.candidates.map(normalizePlanCandidate).filter(Boolean)
    : [];
  const candidates = Array.isArray(plan.candidates)
    ? plan.candidates.map(normalizePlanCandidate).filter(Boolean)
    : [];
  return {
    ...fallback,
    ...plan,
    candidates: candidates.length ? candidates : fallbackCandidates,
  };
}

export async function planResearch(context, _node, { shouldRun }) {
  const {
    id, meta, theme, intensityKey, industryTpl, companyTpl, cp, saveCp, tstep,
  } = context;
  // ---- 规划（checkpoint：cp.plan）----
  if (shouldRun) {
    emit(id, 'initial-plan', { step: 1, text: '初步 plan：拆解问题、定义核心分歧、确定候选标的。' });
    const planFallback = {
      logic: meta.rationale || '', candidates: (meta.tickers || ['NVDA']).map((t) => ({ ticker: t, name: t, role: '候选', reason: '主题相关' })),
      keyEvent: `${theme} 的核心分歧`, deltas: '需求/供给/政策',
    };
    const planR = await tstep('plan', () => runDefinedAgent('analysis-plan', {
      theme,
      rationale: meta.rationale || '',
      tickers: meta.tickers || [],
      templatePrompt: TemplateSystem.toPrompt({ industryTpl, companyTpl }),
    }, { kind: 'analysis-json', temperature: 0.6, agent: 'main-orchestrator', fallback: planFallback }));
    cp.plan = normalizeAnalysisPlanOutput(planR.output, planFallback); cp.live = planR.live;
    // 硬性保证：用户指定标的必须在候选中且排首位（曾出现「Google 项目候选里没有 GOOGL」——LLM 只选了竞争对手）
    const userTickers = (meta.tickers || []).map((t) => String(t).toUpperCase()).filter(Boolean);
    const planTickers = (cp.plan.candidates || []).map((c) => String(c.ticker || '').toUpperCase()).filter(Boolean);
    cp.tickers = [...new Set([...userTickers, ...planTickers])].slice(0, 6);
    for (const t of userTickers) {
      if (!planTickers.includes(t)) (cp.plan.candidates = cp.plan.candidates || []).unshift({ ticker: t, name: t, role: '核心标的（用户指定）', reason: '项目主题的主体标的' });
    }
    ProjectFS.setAnalysisFile(id, 'plan.json', { industryTemplate: industryTpl?.id, companyTemplate: companyTpl?.id, intensity: intensityKey, ...cp.plan });
    assertContractArtifactsCommitted(id, 'analysis-plan');
    saveCp();
    emit(id, 'initial-plan', { step: 1, text: `问题定义完成：候选标的 ${cp.tickers.length} 个：${cp.tickers.join(', ')}`, data: cp.plan });
  }
  return hydratePlanResearch(context);
}

export async function hydratePlanResearch(context) {
  context.plan = context.cp.plan;
  return context.cp.plan;
}

export { planResearch as execute, hydratePlanResearch as hydrate };
