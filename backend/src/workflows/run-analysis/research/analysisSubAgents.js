// 分析 sub-agents：行业分析 + 公司分析。均由模板(industry/company guidance)引导，
// 消费数据 agent 产出的 dataContext(数据报告/摘录/基本面/研究/行业上下文)。
// M2：跑在统一 runtime 上。prompt 保留结构化基线简报（快、便宜），完整产物（数据报告全文/
// 财报会全文/竞对档案）改为文件引用 + agent 用 ws_read_file 按需分页读；也可少量调用数据工具补证。
//
// 多分部机制（数据驱动，非公司特判）：当核心标的的收入分部 ≥2 且非最大分部合计占比 >20% 时，
// 行业分析必须对每个占比 ≥10% 的分部做独立子分析（市场规模/周期/变现效率/竞争与替代/分部可比资产锚），
// 公司分析必须用分部估值加总(SOTP)交叉验证整体估值。
// 依据：多业务公司用单一行业视角必然把「基本盘的周期性」「新业务的期权价值」「被替代风险」揉成一团浆糊。
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { SCHEMAS } from '../../../lib/schemas.js';

// 从 dataContext 提取核心标的的分部结构（收入占比降序）；不足以支撑分部分析时返回 null
export function extractSegments(dataContext) {
  const primary = (dataContext?.tickers || [])[0];
  const segsRaw = dataContext?.detail?.[primary]?.revenueSegments;
  if (!segsRaw || typeof segsRaw !== 'object') return null;
  const entries = Object.entries(segsRaw).filter(([, v]) => typeof v === 'number' && v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return null;
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const segs = entries.map(([name, v]) => ({ name, revenue: v, share: +(v / total).toFixed(3) }));
  const nonTopShare = 1 - segs[0].share;
  if (nonTopShare < 0.2) return null; // 单一主业公司，无需分部化
  return { ticker: primary, segments: segs.filter((s) => s.share >= 0.08) };
}

export function analystDeadlineMs(depth, { isComparison = false, promoted = false } = {}) {
  if (isComparison) return (promoted ? 6 : 4) * 60000;
  return Math.max(8, Number(depth?.analystMin) || 6) * 60000;
}

// 行业分析 agent：结构性变化视角。多分部公司 → 逐分部子分析；单一主业 → 原有整体视角。
export async function industryAnalysisAgent({ theme, brief = '', dataContext, guidance, relatedFindings = '', projectId = null, round = 1, dataRound = round, depth = null }) {
  const ctx = dataContext || {};
  const segInfo = extractSegments(ctx);
  const preview = JSON.stringify({
    industry: ctx.briefs?.industry || null,
    competitorDossier: ctx.briefs?.competitorDossier || null,
    competitive: ctx.research?.competitive?.answer || null,
    drivers: ctx.research?.drivers?.answer || null,
    finance: ctx.research?.finance?.answer || null,
  });
  const r = await runDefinedAgent('industry-analyst', {
    theme,
    brief,
    guidance,
    round,
    files: projectId ? ['data/data_report.md', `data/organized_r${dataRound}.json`, `data/evidence_bundle_r${dataRound}.json`, `data/source_documents_r${dataRound}.json`, `data/competitor_dossier_r${dataRound}.json`] : [],
    relatedFindings,
    segments: segInfo?.segments || [],
    preview,
  }, {
    outputSchema: { required: ['structuralView'] },
    deadlineMs: analystDeadlineMs(depth),
    round, step: 2, stage: 'industry', artifact: 'analysis/industry.json',
    kind: 'industry', temperature: 0.5,
  });
  return r.output || {
    marketSize: 'data insufficient', keyExternalDrivers: 'data insufficient', demandSupplyMap: 'data insufficient', drivers: [], competition: '', crossIndustry: '', valuationExpectationMatrix: 'data insufficient', evidenceGaps: [], inflection: '', structuralView: `${theme} is in structural change; more data needed to confirm.`, segments: [],
  };
}

// 公司分析 agent：多维度评估单个公司。多分部公司必须做 SOTP 交叉验证。
// role='primary' 全维度深挖；role='comparison' 轻量对照画像（定向单票项目中被晋升的 peers——
// 对比所需的是相对差异而非全量深挖，因此使用更窄的 wall-clock profile）。
export async function companyAnalysisAgent({ ticker, theme, brief = '', dataContext, guidance, projectId = null, round = 1, dataRound = round, depth = null, role = 'primary', promoted = false }) {
  const isComparison = role === 'comparison';
  const ctx = dataContext || {};
  const fund = (ctx.briefs?.fundamentals || '').split('\n').find((l) => l.startsWith(ticker)) || '';
  const excerpts = (ctx.excerpts || []).filter((e) => !e.ticker || e.ticker === ticker).map((e) => {
    const trace = e.claimStatus === 'supported' ? ` [evidence:${(e.evidenceRefs || []).slice(0, 3).join(',')}]` : (e.claimStatus === 'estimate' ? ' [est]' : ' [open-issue]');
    return `· [${e.category}] ${e.point}${trace}`;
  }).join('\n');
  const hasTranscript = (ctx.transcripts || []).some((t) => t.symbol === ticker);
  const segInfo = extractSegments(ctx);
  const isPrimaryMultiSeg = segInfo && segInfo.ticker === ticker;
  const preview = JSON.stringify({
    fundamentals: fund || null,
    transcriptAvailable: hasTranscript,
    competitorDossier: ctx.briefs?.competitorDossier || null,
    drivers: ctx.research?.drivers?.answer || null,
    competitive: ctx.research?.competitive?.answer || null,
    excerpts: excerpts.slice(0, 3000),
  });
  const r = await runDefinedAgent('company-analyst', {
    theme,
    brief,
    ticker,
    guidance,
    round,
    role,
    files: projectId ? ['data/data_report.md', `data/evidence_bundle_r${dataRound}.json`, `data/source_documents_r${dataRound}.json`, 'analysis/industry.json', 'analysis/spill/'] : [],
    industryContext: ctx.industry || {},
    segments: isPrimaryMultiSeg ? segInfo.segments : [],
    isComparison,
    promoted,
    hasTranscript,
    preview,
  }, {
    outputSchema: SCHEMAS.company,
    deadlineMs: analystDeadlineMs(depth, { isComparison, promoted }),
    round, step: 2, stage: 'company', artifact: 'analysis/company.json',
    kind: 'company', temperature: 0.45,
  });
  const data = r.output || {
    ticker, positioning: '', growth: '', quality: '', valuation: '', impliedExpectations: 'data insufficient', customerMap: 'data insufficient', orderSwitching: 'data insufficient', moatThreat: '', management: 'data insufficient', marketPerformance: 'data insufficient', evidenceGaps: [], catalysts: [], risks: [], verdict: 'data insufficient; inconclusive.', conviction: 0.5,
  };
  return { ...data, ticker };
}
