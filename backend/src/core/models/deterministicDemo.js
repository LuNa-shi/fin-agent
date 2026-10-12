// 显式 DEMO_MODE 的确定性模型输出；不会作为 live provider 失败后的自动回退。
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import { estimateTokens } from '../../lib/context.js';

export const DEMO_PROVIDER_ID = 'demo';
export const DEMO_MODEL_ID = 'deterministic-demo';
// 通过 opts.kind 区分不同生成场景，保证前端各模块可完整演示

const IDEA_BANK = [
  { title: '半导体供给瓶颈交易带来的投资机会初步筛选', theme: '半导体', heat: 92,
    rationale: '先进制程产能受地缘与设备出口管制约束，HBM/CoWoS 封装供给持续紧张，AI 需求拉动下存在阶段性错配。',
    catalyst: '台积电 CoWoS 扩产进度、HBM 厂商季度指引', edge: '市场低估封装环节瓶颈的持续时间', tickers: ['NVDA', 'TSM', 'AVGO', 'ASML'] },
  { title: '金刚石散热材料的产业化拐点与投资机会', theme: '新材料', heat: 78,
    rationale: 'GaN/SiC 功率器件与高功率 AI 芯片对散热提出更高要求，金刚石衬底热导率优势显著，量产成本下降带来渗透率提升。',
    catalyst: '头部 GPU 厂商导入金刚石散热方案', edge: '产业化拐点临近但尚未被定价', tickers: ['AMD', 'NVDA', 'COHR'] },
  { title: 'AI 推理算力下沉：边缘 AI 芯片的需求重估', theme: 'AI算力', heat: 85,
    rationale: '推理成本占比上升推动算力从云端向边缘迁移，端侧 NPU 与低功耗推理芯片需求被低估。',
    catalyst: '端侧大模型落地、新一代手机/PC NPU 发布', edge: '共识聚焦云端训练，忽视边缘推理弹性', tickers: ['QCOM', 'ARM', 'AAPL'] },
  { title: '电力瓶颈下的数据中心能源供给链机会', theme: '能源/电力', heat: 81,
    rationale: 'AI 数据中心电力需求激增，电网设备、变压器、天然气发电及核电成为供给瓶颈受益环节。',
    catalyst: '超大规模数据中心电力采购协议、电网投资计划', edge: '电力供给约束被低估为短期问题', tickers: ['VST', 'GEV', 'ETN'] },
  { title: 'GLP-1 产能扩张与上游 CDMO 的确定性机会', theme: '医药', heat: 74,
    rationale: '减重药需求超预期，原料药与灌装产能成为瓶颈，上游 CDMO 订单可见度高。',
    catalyst: '减重药新适应症获批、产能扩建公告', edge: '市场关注品牌药而非上游确定性产能', tickers: ['LLY', 'NVO'] },
  { title: '铜的结构性短缺：电气化与 AI 双重拉动', theme: '大宗商品', heat: 70,
    rationale: '电网升级、电动化与数据中心铜需求叠加，新增矿山供给周期长，中期供需缺口扩大。',
    catalyst: '主要铜矿减产/罢工、库存去化数据', edge: '需求侧 AI 数据中心增量未被充分计入', tickers: ['FCX', 'SCCO'] },
];

function stableNumber(value = '') {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickIdeas(n = 4, seed = '') {
  const offset = stableNumber(seed) % IDEA_BANK.length;
  return Array.from({ length: Math.min(n, IDEA_BANK.length) }, (_, index) => {
    const idea = IDEA_BANK[(offset + index) % IDEA_BANK.length];
    return { ...idea, heat: idea.heat + ((stableNumber(`${seed}:${index}`) % 5) - 2) };
  });
}

function ideaJSON(n, seed) {
  return JSON.stringify({ ideas: pickIdeas(n, seed) }, null, 2);
}

function analysisReport(prompt) {
  const ticker = String(prompt || '').match(/Companies:\s*([A-Z][A-Z0-9.-]{0,5})\b/u)?.[1] || 'NVDA';
  const fundamentals = `[src: fmp_fundamentals:${ticker}]`;
  const companyDetail = `[src: edgar_company_detail:${ticker}]`;
  return `# ${ticker} Demo Investment Report

## Investment thesis
The demo thesis treats durable AI-infrastructure demand and disciplined capital conversion as the central drivers of the investment case. ${fundamentals}

## Industry Analysis
Industry demand, financing conditions, and the pace of capacity additions are the principal external variables to monitor. [src: fmp_economic_calendar]

## Company analysis
The company view is anchored to the available fundamentals and filing-derived operating profile, while live investment use requires refreshed source data. ${fundamentals} ${companyDetail}

## Demand / supply / value chain
Demand visibility, supply response, customer concentration, and value-chain bargaining power determine whether growth converts into durable margins. ${companyDetail}

## Valuation
This demo uses a scenario valuation framework only; no live target price or recommendation should be inferred from the placeholder output. [est]

## Risks and invalidation
The thesis would weaken if demand slows, capacity expands faster than expected, or competitive pressure prevents revenue growth from converting into cash flow. [open-issue: validate with live evidence]

## Conclusion and recommendation
The deterministic demo supports an illustrative watchlist conclusion, while any real portfolio action requires a fresh full Agent run and current evidence. [est]`;
}

function analysisJSON(topic) {
  return JSON.stringify({
    confidence: 0.72,
    rating: '积极关注',
    summary: `${topic} 存在供需错配带来的中期机会，建议核心龙头打底、弹性标的进攻。`,
    stocks: [
      { ticker: 'NVDA', name: '英伟达', role: '核心龙头', confidence: 0.8, reason: 'AI 算力需求核心受益，份额与定价权稳固' },
      { ticker: 'TSM', name: '台积电', role: '制造卡位', confidence: 0.72, reason: '先进制程+CoWoS 封装产能稀缺' },
      { ticker: 'AVGO', name: '博通', role: '弹性标的', confidence: 0.6, reason: '定制 ASIC 与网络芯片受益算力扩张' },
    ],
    risks: ['需求证伪', '估值偏高', '地缘与出口管制扰动'],
  }, null, 2);
}

function scenarioJSON(event) {
  return JSON.stringify({
    baselineState: `${event || '目标事件'}：当前供给受限、需求维持高增，价格处于上行通道。`,
    futures: [
      { name: '基准情形', probability: 0.5, state: '缺口延续、龙头满产满销、价格高位震荡', narrative: '在需求维持+扩产周期偏长的变化量驱动下，缺口延续 2-3 个季度，龙头业绩稳步兑现。', impact: '正面', drivers: ['需求维持', '扩产周期长'], signposts: ['月度产能数据', '龙头订单指引'] },
      { name: '乐观情形', probability: 0.25, state: '量价齐升、板块加速重估', narrative: '需求超预期叠加供给受限，现货价格跳涨，资本开支上修，板块加速重估。', impact: '强正面', drivers: ['需求超预期', '供给刚性'], signposts: ['现货价格跳涨', '扩产资本开支上修'] },
      { name: '悲观情形', probability: 0.25, state: '库存累积、价格回落、杀估值', narrative: '需求证伪或政策扰动，库存累积引发价格回落与估值收缩。', impact: '负面', drivers: ['需求证伪', '政策扰动'], signposts: ['渠道库存上升', '价格环比转负'] },
    ],
    reflection: '本轮推演假设需求弹性偏高，需在 signposts 触发时及时修正概率分布。',
    confidence: 0.66,
  }, null, 2);
}

function valuationJSON() {
  return JSON.stringify({
    method: 'PE/PEG 相对估值 + 情景区间，AI 算力链给成长溢价',
    models: [
      { ticker: 'NVDA', currentPrice: 130, valuationRange: { low: 110, base: 155, high: 190 }, upside: '+19%~+46%', keyAssumptions: ['数据中心需求维持高增', '毛利率维持 70%+'], rating: '合理' },
      { ticker: 'TSM', currentPrice: 180, valuationRange: { low: 160, base: 205, high: 240 }, upside: '+14%~+33%', keyAssumptions: ['先进制程满产', 'CoWoS 扩产顺利'], rating: '低估' },
    ],
    summary: '龙头估值合理偏上，制造卡位标的相对低估，弹性来自产能兑现。',
  }, null, 2);
}

function crossrefJSON() {
  return JSON.stringify({
    analogies: [
      { case: '2017-2018 存储超级周期', industry: '半导体存储', similarity: '供给受限+需求爆发的量价齐升', outcome: '价格大涨约 18 个月后供给释放、周期反转', lesson: '高景气中提前布局供给响应信号', caution: '本轮 AI 需求驱动的供给壁垒更高，反转或更慢' },
      { case: '2020-2021 面板涨价周期', industry: '显示面板', similarity: '产能错配驱动持续涨价', outcome: '涨价持续约 5 个季度后回落', lesson: '紧盯下游库存与需求脉冲持续性', caution: '竞争格局与集中度差异显著' },
    ],
    summary: '历史类比显示供给瓶颈红利可观但具周期性，需用 signpost 把握退出时机。',
  }, null, 2);
}

function canonicalWorldviewJSON(prompt) {
  const baseLine = prompt.match(/^Frozen base Worldview Version:\s*(.+)$/mu)?.[1]?.trim() || 'null';
  const overviewsLine = prompt.match(/^Frozen ordered Overview discovery inputs:\s*(.+)$/mu)?.[1]?.trim() || '[]';
  const asOfLine = prompt.match(/^Frozen run as-of:\s*(.+)$/mu)?.[1]?.trim() || JSON.stringify('2026-01-01T00:00:00.000Z');
  let baseWorldviewVersionId = null;
  let overviews = [];
  let asOf = '2026-01-01T00:00:00.000Z';
  try { baseWorldviewVersionId = JSON.parse(baseLine); } catch {}
  try { overviews = JSON.parse(overviewsLine); } catch {}
  try { asOf = JSON.parse(asOfLine); } catch {}
  if (baseWorldviewVersionId) {
    return JSON.stringify({
      contract: 'worldview-agent-result.v1',
      worldview: {
        action: 'KEEP',
        baseWorldviewVersionId,
        rationale: 'Deterministic demo evidence does not change the core macro causal understanding.',
        package: null,
      },
      claimActions: [],
    }, null, 2);
  }
  return JSON.stringify({
    contract: 'worldview-agent-result.v1',
    worldview: {
      action: 'UPDATE',
      baseWorldviewVersionId: null,
      rationale: 'Deterministic demo creates the initial complete Canonical Worldview package.',
      package: {
        title: 'Deterministic Demo Canonical Worldview',
        asOf,
        narrativeMarkdown: '# Deterministic Demo Canonical Worldview\n\nThe demo establishes an illustrative causal view from the frozen Overview manifest without live-model or network access.\n',
        causalRelationships: [{
          relationshipId: 'demo-demand-capacity',
          cause: 'Illustrative investment demand',
          effect: 'Illustrative capacity response',
          mechanism: 'The deterministic demo represents demand and capacity as the initial causal relationship.',
          confidence: 'low',
          evidence: overviews[0] ? [{
            reportVersionId: overviews[0].reportVersionId,
            contentDigest: overviews[0].contentDigest,
          }] : [],
          counterEvidence: [],
        }],
        evidence: overviews[0] ? [{
          reportVersionId: overviews[0].reportVersionId,
          contentDigest: overviews[0].contentDigest,
          kind: 'supporting',
          summary: 'The deterministic demo fully read this exact ReportVersion through its governed capability.',
        }] : [],
        counterEvidence: [],
        investmentImplications: [{
          theme: 'Deterministic demo',
          implication: 'Use the package only to verify product mechanics; live investment use requires governed evidence reads.',
          horizon: 'demo only',
          confidence: 'low',
        }],
        coverage: {
          overviewIds: overviews.map((item) => item.overviewId),
          reportVersionIds: overviews.map((item) => item.reportVersionId),
          selectedFullReadReportVersionIds: overviews[0] ? [overviews[0].reportVersionId] : [],
        },
        updateSummary: { retained: [], changed: [], added: ['Initial deterministic demo causal view'], removed: [] },
      },
    },
    claimActions: overviews[0] ? [{
      actionId: 'demo-initial-claim',
      action: 'ADD',
      rationale: 'The deterministic demo publishes one bounded Claim to verify Claim Library mechanics.',
      claim: {
        assertion: 'The demo demand signal will remain observable through 2027-03-31.',
        subject: 'Deterministic demo demand signal',
        tickers: [],
        rationale: 'The exact demo ReportVersion provides the bounded source for this mechanical acceptance Claim.',
        verification: { pointAt: '2027-03-31T00:00:00.000Z' },
        metric: 'Presence of the defined demo demand signal',
        acceptanceCondition: 'The defined demand signal remains present at the verification point.',
        invalidationCondition: 'The defined demand signal is absent at the verification point.',
        evidence: [{
          reportVersionId: overviews[0].reportVersionId,
          contentDigest: overviews[0].contentDigest,
          fingerprint: overviews[0].fingerprint,
        }],
      },
    }] : [],
  }, null, 2);
}

function reportOverviewJSON(prompt) {
  const reportVersionId = prompt.match(/^ReportVersionId:\s*(.+)$/mu)?.[1]?.trim() || 'report_demo';
  const contentDigest = prompt.match(/^Content digest:\s*(sha256:[a-f0-9]{64})$/mu)?.[1]
    || `sha256:${'0'.repeat(64)}`;
  const ticker = prompt.match(/\b[A-Z]{1,6}\b/u)?.[0] || 'DEMO';
  return JSON.stringify({
    overview: {
      reportVersionId,
      contentDigest,
      summary: 'The report identifies a bounded investment-research theme for later exact-content review.',
      keyThemes: ['investment research'],
      entities: [{ name: ticker, type: 'ticker', tickers: [ticker] }],
      materialDevelopments: ['The report contains material developments that require exact ReportVersion review.'],
      uncertainties: ['This Overview is discovery material and does not replace report evidence.'],
    },
  }, null, 2);
}

function reviewerJSON(kind, prompt) {
  const reviewerType = kind === 'requirement-reviewer' ? 'requirements' : kind.replace('-reviewer', '');
  const asOf = prompt.match(/^As of:\s*(.+)$/m)?.[1]?.trim() || '2026-01-01T00:00:00.000Z';
  const inputDigest = prompt.match(/^Input digest:\s*(.+)$/m)?.[1]?.trim() || 'sha256:demo';
  return JSON.stringify({
    schemaVersion: '1.0.0',
    asOf,
    producer: kind,
    contractVersion: '1.0.0',
    inputDigest,
    createdAt: asOf,
    evidenceRefs: [],
    reviewerType,
    score: 0.9,
    issues: [],
    verdict: 'pass',
  }, null, 2);
}

function classifyJSON(text) {
  const t = String(text || '');
  let theme = '综合', industryTemplate = 'industry_generic', companyTemplate = 'company_generic', tickers = ['NVDA', 'TSM'];
  if (/半导体|芯片|晶圆|封测|GPU|存储/.test(t)) { theme = '半导体'; industryTemplate = 'industry_semiconductor'; companyTemplate = 'company_semiconductor'; tickers = ['NVDA', 'TSM', 'AVGO']; }
  else if (/供给|瓶颈|短缺|产能|管制/.test(t)) { theme = '供给瓶颈'; industryTemplate = 'industry_supply_bottleneck'; companyTemplate = 'company_supply_bottleneck'; tickers = ['ASML', 'TSM']; }
  else if (/材料|散热|衬底|金刚石/.test(t)) { theme = '新材料'; industryTemplate = 'industry_new_material'; companyTemplate = 'company_new_material'; tickers = ['COHR', 'AMD']; }
  else if (/电力|能源|数据中心|核电/.test(t)) { theme = '能源/电力'; industryTemplate = 'industry_demand_resurgence'; companyTemplate = 'company_demand_resurgence'; tickers = ['VST', 'GEV']; }
  return JSON.stringify({
    title: t.length > 6 ? t.slice(0, 40) : `${t} 投资机会初步筛选`,
    theme, industryTemplate, companyTemplate,
    rationale: `围绕「${t}」的供需与产业趋势，存在结构性预期差，值得用 ${theme} 思路深入分析。`,
    tickers,
  }, null, 2);
}

export function demoComplete(messages, opts = {}) {
  const kind = opts.kind || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (kind === 'idea') return ideaJSON(opts.count || 4, lastUser);
  if (kind === 'idea-screen') {
    // 演示：从候选池编号 0..n-1 顺序选出前若干（真实筛选需模型 key）
    const nums = (lastUser.match(/^(\d+)\./gm) || []).map((s) => parseInt(s, 10));
    const uniq = [...new Set(nums)].slice(0, 6);
    return JSON.stringify({ selected: uniq.map((index) => ({ index, score: 70, reason: '演示择优' })) }, null, 2);
  }
  if (kind === 'analysis-json') return analysisJSON(lastUser.slice(0, 40));
  if (kind === 'analysis-report') return analysisReport(lastUser);
  if (kind === 'report-overview') return reportOverviewJSON(lastUser);
  if (kind === 'canonical-worldview') return canonicalWorldviewJSON(lastUser);
  if (['data-scoreboard-evaluator', 'industry-scoreboard-evaluator', 'company-scoreboard-evaluator'].includes(kind)) {
    const rubricIds = {
      'data-scoreboard-evaluator': ['D-COV-01','D-COV-02','D-COV-03','D-COV-04','D-COV-05','D-COV-06','D-COV-07','D-COV-08','D-COV-09','D-ACC-01','D-ACC-02','D-ACC-03','D-ACC-04','D-ACC-05','D-ORG-01','D-ORG-02','D-ORG-03','D-ORG-04','D-ORG-05','D-DEP-01','D-DEP-02','D-DEP-03','D-HOF-01','D-HOF-02'],
      'industry-scoreboard-evaluator': ['I-DEF-01','I-DEF-02','I-DEF-03','I-DEF-04','I-DYN-01','I-DYN-02','I-DYN-03','I-DYN-04','I-DYN-05','I-NAR-01','I-NAR-02','I-NAR-03','I-COM-01','I-COM-02','I-COM-03','I-ANA-01','I-ANA-02','I-QNT-01','I-QNT-02','I-QNT-03','I-QNT-04','I-REP-01','I-REP-02','I-REP-03'],
      'company-scoreboard-evaluator': ['C-HIS-01','C-HIS-02','C-HIS-03','C-MGT-01','C-MGT-02','C-MGT-03','C-BIZ-01','C-BIZ-02','C-BIZ-03','C-BIZ-04','C-KEY-01','C-KEY-02','C-KEY-03','C-MKT-01','C-MKT-02','C-MKT-03','C-MOD-01','C-MOD-02','C-MOD-03','C-MOD-04','C-MOD-05','C-VAL-01','C-VAL-02','C-VAL-03','C-VAL-04','C-REP-01','C-REP-02','C-REP-03'],
    }[kind];
    const contextLine = lastUser.match(/Authoritative unit context:\s*(.+)$/mu)?.[1]?.trim() || '';
    let authoritative = [];
    try { authoritative = JSON.parse(contextLine); } catch { authoritative = []; }
    const unit = kind === 'data-scoreboard-evaluator'
      ? (typeof authoritative === 'string' ? authoritative : 'current-project')
      : (Array.isArray(authoritative) && authoritative.length
        ? (typeof authoritative[0] === 'string' ? authoritative[0] : (authoritative[0].unitId || authoritative[0].industryId || 'primary-industry'))
        : (kind === 'company-scoreboard-evaluator' ? 'NVDA' : 'primary-industry'));
    return JSON.stringify({
      rawSourceChecks: [],
      units: [{ unitId: unit, rubricResults: rubricIds.map((rubricId) => ({ rubricId, status: 'scored', rating: 4, decisiveEvidence: ['report/report.md'], whyNotHigher: 'No higher rating exists on the fixed scale.', errorTags: [], confidence: 'high' })), capTriggers: [] }],
      priorIssueChecks: [],
    }, null, 2);
  }
  if (['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer'].includes(kind)) return reviewerJSON(kind, lastUser);
  if (kind === 'scenario') return scenarioJSON(lastUser.slice(0, 40));
  if (kind === 'valuation') return valuationJSON();
  if (kind === 'crossref') return crossrefJSON();
  if (kind === 'classify') return classifyJSON(opts.userText || lastUser);
  if (kind === 'decision') {
    return JSON.stringify({
      reason: '基于项目库结论，该标的产业链卡位清晰、置信度较高，给予组合配置。',
      confidence: 0.7,
      suggestedWeight: 0.15,
    }, null, 2);
  }
  if (kind === 'reflect') {
    const biases = ['高估需求弹性', '低估政策风险', '过度自信', '锚定历史估值'];
    const bias = biases[stableNumber(lastUser) % biases.length];
    return JSON.stringify({
      lesson: `本次对「${lastUser.slice(0, 24)}」的推演与实际结果存在偏差，主因${bias}。后续应提高对不确定性的权重，并在关键 signpost 触发时及时修正概率分布。`,
      biasType: bias,
      adjustment: '将基准情形概率下调 5-10%，并提高悲观情形权重',
    }, null, 2);
  }
  if (kind === 'chat') {
    const intent = (opts.userText || lastUser).slice(0, 60);
    return `（演示回复）我已理解你的修改意图："${intent}"。\n\n我会从以下角度更新该项目：\n1. 重新校准投资逻辑的核心假设\n2. 补充对应的数据验证点\n3. 调整置信度与标的权重建议\n\n配置真实模型 key 后，这里会变为完整的 agent 推理与文件改写。`;
  }
  return `（演示输出）已收到请求：${lastUser.slice(0, 80)}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (item?.type === 'text') return item.text || '';
    if (item?.type === 'thinking') return item.thinking || '';
    if (item?.type === 'toolCall') return `${item.name || 'tool'}:${JSON.stringify(item.arguments || {})}`;
    return '';
  }).join('\n');
}

function demoMessages(context = {}) {
  const messages = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: String(context.systemPrompt) });
  for (const message of context.messages || []) {
    messages.push({ role: message?.role || 'user', content: contentText(message?.content) });
  }
  return messages;
}

function canonicalWorldviewDemoToolCall(context) {
  const lastUser = [...(context.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
  const userText = contentText(lastUser);
  const scopeLine = userText.match(/^Governed capability scope:\s*(.+)$/mu)?.[1]?.trim() || 'null';
  const baseLine = userText.match(/^Frozen base Worldview Version:\s*(.+)$/mu)?.[1]?.trim() || 'null';
  const overviewsLine = userText.match(/^Frozen ordered Overview discovery inputs:\s*(.+)$/mu)?.[1]?.trim() || '[]';
  let scopeId = null;
  let baseWorldviewVersionId = null;
  let overviews = [];
  try { scopeId = JSON.parse(scopeLine); } catch {}
  try { baseWorldviewVersionId = JSON.parse(baseLine); } catch {}
  try { overviews = JSON.parse(overviewsLine); } catch {}
  const completed = new Set((context.messages || [])
    .filter((message) => message.role === 'toolResult' && !message.isError)
    .map((message) => message.toolName));
  if (!completed.has('worldview_enumerate_overviews')) {
    return { id: 'demo-worldview-enumerate', name: 'worldview_enumerate_overviews', arguments: { scopeId } };
  }
  if (baseWorldviewVersionId && !completed.has('worldview_read_current')) {
    return { id: 'demo-worldview-current', name: 'worldview_read_current', arguments: { scopeId } };
  }
  if (!baseWorldviewVersionId && overviews[0] && !completed.has('worldview_read_report_version')) {
    return {
      id: 'demo-worldview-report',
      name: 'worldview_read_report_version',
      arguments: { scopeId, reportVersionId: overviews[0].reportVersionId },
    };
  }
  return null;
}

function demoText(context, runtime, contractId) {
  if (runtime.fallback !== undefined && runtime.fallback !== null) {
    return typeof runtime.fallback === 'string'
      ? runtime.fallback
      : JSON.stringify(runtime.fallback, null, 2);
  }
  return demoComplete(demoMessages(context), {
    ...runtime,
    kind: runtime.kind || contractId,
  });
}

const DEMO_MODEL = Object.freeze({
  id: DEMO_MODEL_ID,
  name: 'Deterministic Demo',
  api: 'deterministic-demo',
  provider: DEMO_PROVIDER_ID,
  baseUrl: 'local',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_768,
});

function usageFor(context, output) {
  const input = estimateTokens(demoMessages(context).map((message) => message.content).join('\n'));
  const out = estimateTokens(output);
  return {
    input,
    output: out,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + out,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createDeterministicDemoRoute({ runtime = {}, contractId = '', reasoningLevel = 'off' } = {}) {
  const streamFn = (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    globalThis.queueMicrotask(() => {
      const timestamp = Date.now();
      if (options.signal?.aborted) {
        const aborted = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: usageFor(context, ''), stopReason: 'aborted', errorMessage: 'Request was aborted', timestamp,
        };
        stream.push({ type: 'error', reason: 'aborted', error: aborted });
        stream.end(aborted);
        return;
      }
      const kind = runtime.kind || contractId;
      const toolCall = kind === 'canonical-worldview' ? canonicalWorldviewDemoToolCall(context) : null;
      const output = toolCall ? JSON.stringify(toolCall.arguments) : demoText(context, runtime, contractId);
      const content = toolCall ? [{ type: 'toolCall', ...toolCall }] : [{ type: 'text', text: output }];
      const message = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usageFor(context, output),
        stopReason: toolCall ? 'toolUse' : 'stop',
        timestamp,
      };
      const partial = { ...message, content: [] };
      stream.push({ type: 'start', partial });
      if (toolCall) {
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...partial, content } });
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: output, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message });
      } else {
        stream.push({ type: 'text_start', contentIndex: 0, partial: { ...partial, content } });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: output, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: output, partial: message });
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  return Object.freeze({
    model: DEMO_MODEL,
    streamFn,
    provider: DEMO_PROVIDER_ID,
    modelId: DEMO_MODEL_ID,
    reasoningLevel,
    attemptedProviders: Object.freeze([DEMO_PROVIDER_ID]),
    fallbackFrom: null,
  });
}
