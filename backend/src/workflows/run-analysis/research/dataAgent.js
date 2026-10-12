// 数据获取 sub-agent：为项目分析系统性收集「行业级 + 公司级」资料，
// 产出 整理源清单 + 关键数据摘录 + 每个来源的信息质量评估。可被行业/公司分析 agent 调取。
// 由数据获取模板(dataGuideline)引导，上一轮 Data focus 可驱动后续轮的定向补数据。
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { auditEvidence, buildCitationLedger, buildDataPlan, collectEvidence } from '../../../domains/research/evidence/index.js';
import { pLimit } from '../../../lib/http.js';
import {
  getQuotes, getNews, getRatios, getFinancialGrowth, getPriceTarget, getDCF, getEarningsSurprises,
  getForwardEstimates, forwardMultiples, getTranscript, getSectorPerformance, getProfile,
  getUpgradesDowngrades, getInstitutionalOwnership, getRevenueByProduct, getFinancialScore,
  getKeyMetrics, getIncomeStatement, getValuationHistory, percentileRank, getComps, getEarningsCalendar,
} from '../../../tools/fmp.js';
import { edgarBrief } from '../../../tools/edgar.js';
import { runTool } from '../../../tools/index.js';
import { impliedFcfGrowth } from '../../../lib/valuation.js';
import { SCHEMAS } from '../../../lib/schemas.js';
import { pplxFinance } from '../../../tools/perplexity.js';
import { tavilySearch } from '../../../tools/tavily.js';
import { researchDigest } from '../../../tools/research.js';
import { withTimeout } from '../../../lib/async.js';

export const DATA_EVIDENCE_REQUIRED_ARTIFACTS = Object.freeze([
  'data/data_plan_rN.json',
  'data/source_documents_rN.json',
  'data/evidence_bundle_rN.json',
  'data/citation_ledger.json',
  'data/domain_events_rN.json',
  'data/organized_rN.json',
  'data/data_report.md',
]);

function assertDataArtifactsCommitted(projectId, round) {
  const files = new Set(ProjectFS.files(projectId).filter((file) => !file.dir).map((file) => file.name));
  const missing = DATA_EVIDENCE_REQUIRED_ARTIFACTS
    .map((pattern) => pattern.replace(/rN\b/gu, `r${round}`))
    .filter((path) => !files.has(path));
  if (missing.length) {
    const error = new Error(`Data evidence completion rejected: ${missing.join(', ')}`);
    error.code = 'CONTRACT_COMPLETION_REJECTED';
    error.errors = missing.map((path) => `required artifact is absent: ${path}`);
    throw error;
  }
  return true;
}

// 读上一轮落盘的 data/ 产物（轮间基线携带用）；不存在/损坏返回 null。
function readDataFile(id, name) {
  try { return JSON.parse(ProjectFS.fileContent(id, `data/${name}`) || 'null'); } catch { return null; }
}

function dataEvent(id, text, data = undefined) {
  if (!id) return;
  try {
    ProjectFS.appendEvent(id, {
      type: 'subagent',
      step: 2,
      stage: 'data',
      agent: 'data-orchestrator',
      round: data?.round ?? null,
      artifact: data?.artifact || 'data/data_report.md',
      text,
      data,
    });
  } catch {}
}

// ---------- 基本面（含前瞻倍数） ----------
async function fetchFundamentals(tickers = []) {
  const list = tickers.filter(Boolean).slice(0, 6);
  if (!list.length) return {};
  const limit = pLimit(4);
  const entries = await Promise.all(list.map((t) => limit(async () => {
    const [ratios, growth, target, dcf, surprises, est, prof, km, income, vh, ecal] = await Promise.all([
      getRatios(t).catch(() => null), getFinancialGrowth(t, { limit: 2 }).catch(() => null),
      getPriceTarget(t).catch(() => null), getDCF(t).catch(() => null),
      getEarningsSurprises(t, { limit: 3 }).catch(() => null), getForwardEstimates(t).catch(() => null),
      getProfile(t).catch(() => null),
      getKeyMetrics(t).catch(() => null),
      getIncomeStatement(t, { period: 'annual', limit: 2 }).catch(() => null),
      getValuationHistory(t, { quarters: 20 }).catch(() => null),
      getEarningsCalendar(t).catch(() => null),
    ]);
    const g = Array.isArray(growth) ? growth[0] : growth;
    // 资产负债/现金流/稀释：净债/EBITDA、ROIC、每股 FCF（收益率在 attach 步骤结合现价算）、股本 YoY 变化
    const inc = Array.isArray(income) ? income : [];
    const sh0 = inc[0]?.weightedAverageShsOutDil, sh1 = inc[1]?.weightedAverageShsOutDil;
    const dilutionYoY = (sh0 && sh1) ? +(((sh0 - sh1) / sh1) * 100).toFixed(1) : null;
    const pe = ratios?.peRatioTTM;
    return [t, {
      pe, peg: ratios?.pegRatioTTM, ps: ratios?.priceToSalesRatioTTM,
      grossMargin: ratios?.grossProfitMarginTTM, netMargin: ratios?.netProfitMarginTTM, roe: ratios?.returnOnEquityTTM,
      revenueGrowth: g?.revenueGrowth, epsGrowth: g?.epsgrowth,
      analystTarget: target?.lastMonthAvgPriceTarget || target?.lastQuarterAvgPriceTarget,
      dcfValue: dcf?.dcf, dcfVsPrice: dcf?.['Stock Price'],
      lastSurprises: (Array.isArray(surprises) ? surprises : []).map((s) => s.surprisePct).filter((x) => x != null),
      sector: prof?.sector, industry: prof?.industry, beta: prof?.beta,
      netDebtToEbitda: km?.netDebtToEBITDATTM, roic: km?.roicTTM, fcfPerShare: km?.freeCashFlowPerShareTTM,
      dilutionYoY,
      pePctile5y: percentileRank(pe, vh?.peSeries), psPctile5y: percentileRank(ratios?.priceToSalesRatioTTM, vh?.psSeries),
      peRange5y: vh?.peRange || null,
      nextEarnings: ecal?.upcoming || null, // 催化剂日期来自数据而非 LLM 记忆
      _est: est,
    }];
  })));
  return Object.fromEntries(entries);
}
function attachForwardMultiples(fundamentals, quotes) {
  const qmap = Object.fromEntries((quotes || []).map((q) => [String(q.symbol).toUpperCase(), q]));
  for (const [t, d] of Object.entries(fundamentals)) {
    if (d._est && (d._est.fy1 || d._est.fy2)) {
      const m = forwardMultiples(qmap[t] || {}, d._est);
      Object.assign(d, { fwdPE1: m.fwdPE1, fwdPE2: m.fwdPE2, fwdPS1: m.fwdPS1, fwdPEG: m.fwdPEG, estRevGrowthFwd: m.estRevGrowthFwd, estEpsGrowthFwd: m.estEpsGrowthFwd, estEpsCagrFwd: m.estEpsCagrFwd, fy1: m.fy1, fy1Analysts: m.fy1Analysts });
    }
    // 需要现价的派生指标：FCF 收益率 + 反向 DCF（价格隐含 FCF 增速，对照共识增速看预期差）
    const price = qmap[t]?.price;
    if (price > 0 && d.fcfPerShare > 0) {
      d.fcfYield = +((d.fcfPerShare / price) * 100).toFixed(2);
      const g = impliedFcfGrowth({ price, fcfPerShare: d.fcfPerShare });
      d.impliedFcfGrowth = g != null ? +(g * 100).toFixed(1) : null;
    }
    delete d._est;
  }
  return fundamentals;
}
export function fundamentalsBrief(f = {}) {
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const num = (x) => (x == null ? '—' : (typeof x === 'number' ? +x.toFixed(2) : x));
  return Object.entries(f).map(([t, d]) => {
    const fwd = (d.fwdPE1 != null) ? `｜前瞻(${d.fy1 || 'FY1'},${d.fy1Analysts || 0}家) fwdPE ${num(d.fwdPE1)}→${num(d.fwdPE2)} fwdPS ${num(d.fwdPS1)} fwdPEG ${num(d.fwdPEG)}｜共识增速 营收${d.estRevGrowthFwd ?? '—'}% EPS${d.estEpsGrowthFwd ?? '—'}%${d.estEpsCagrFwd != null ? `(CAGR ${d.estEpsCagrFwd}%)` : ''}` : '';
    const histAnchor = (d.pePctile5y != null || d.psPctile5y != null)
      ? `｜历史分位 PE第${d.pePctile5y ?? '—'}分位/PS第${d.psPctile5y ?? '—'}分位(5y${d.peRange5y ? ` PE区间${d.peRange5y.min}-${d.peRange5y.max} 中位${d.peRange5y.median}` : ''})` : '';
    const bsCf = `｜净债/EBITDA ${num(d.netDebtToEbitda)} ROIC${pct(d.roic)} FCF/股 ${num(d.fcfPerShare)}${d.fcfYield != null ? `(收益率${d.fcfYield}%)` : ''} 稀释${d.dilutionYoY != null ? (d.dilutionYoY > 0 ? '+' : '') + d.dilutionYoY + '%/yr' : '—'}`;
    const rdcf = d.impliedFcfGrowth != null ? `｜反向DCF:现价隐含FCF增速${d.impliedFcfGrowth}%/10y` : '';
    const ecal = d.nextEarnings ? `｜下次财报 ${d.nextEarnings.date}${d.nextEarnings.epsEst != null ? `(共识EPS ${d.nextEarnings.epsEst})` : ''}` : '';
    return `${t}[${d.sector || '—'}]: PE ${num(d.pe)}/PEG ${num(d.peg)}/PS ${num(d.ps)}｜毛利${pct(d.grossMargin)} 净利${pct(d.netMargin)} ROE${pct(d.roe)}｜营收增速${pct(d.revenueGrowth)}｜目标价${num(d.analystTarget)} DCF${num(d.dcfValue)} beta${num(d.beta)}${fwd}${histAnchor}${bsCf}${rdcf}${ecal}`;
  }).join('\n');
}

// ---------- 财报电话会（transcript 矩阵）----------
// 纵向：核心标的近 4 个季度全文（比对 guidance/产能/价格/订单措辞演变，还原基本面拐点）；
// 横向：产业链其他标的最新一期。全文写入 analysis/spill/，分析 agent 用 ws_read_file 分页通读——
// 此前只抓最新 1 期、截断 3500 字符，把最富信息的一手来源丢了 90%。
function priorQuarter(q, y) { return q > 1 ? { quarter: q - 1, year: y } : { quarter: 4, year: y - 1 }; }

async function gatherTranscripts(tickers = [], { projectId, primary = [], quartersBack = 4 } = {}) {
  const primarySet = new Set(primary.map((t) => String(t).toUpperCase()));
  const list = tickers.filter(Boolean).slice(0, 5);
  if (!list.length) return [];
  const limit = pLimit(3);
  const spillIndex = [];
  const out = await Promise.all(list.map((t) => limit(async () => {
    const T = String(t).toUpperCase();
    const latest = await getTranscript(t).catch(() => null);
    if (!latest || !latest.content) return null;
    const quarters = [latest];
    // 核心标的纵向补抓前几季（横向标的只取最新一期，控成本）
    if (primarySet.has(T) && latest.quarter && latest.year) {
      let { quarter, year } = latest;
      for (let i = 1; i < quartersBack; i++) {
        ({ quarter, year } = priorQuarter(quarter, year));
        const r = await getTranscript(t, { quarter, year }).catch(() => null);
        if (r && r.content) quarters.push(r);
      }
    }
    // 全文落 spill（供 ws_read_file 分页通读）
    for (const r of quarters) {
      if (projectId) {
        try {
          const rel = `spill/transcript_${T}_Q${r.quarter}_${r.year}.txt`;
          ProjectFS.setAnalysisText(projectId, rel, String(r.content));
          spillIndex.push({ symbol: T, quarter: r.quarter, year: r.year, file: `analysis/${rel}`, chars: r.content.length });
        } catch {}
      }
    }
    return { symbol: T, quarter: latest.quarter, year: latest.year, excerpt: String(latest.content).slice(0, 3500), quartersFetched: quarters.length };
  })));
  const items = out.filter(Boolean);
  items._spillIndex = spillIndex;
  return items;
}
export function transcriptsBrief(ts = []) {
  const idx = ts._spillIndex || [];
  const idxBlock = idx.length ? `\n（全文已存 analysis/spill/，用 ws_read_file 分页通读：${idx.map((x) => `${x.symbol} Q${x.quarter}'${x.year}`).join('、')}）` : '';
  return ts.map((t) => `【${t.symbol} ${t.year}Q${t.quarter} 电话会${t.quartersFetched > 1 ? `（+前 ${t.quartersFetched - 1} 季全文）` : ''}】\n${t.excerpt}`).join('\n\n') + idxBlock;
}

// ---------- 联网研究 + 观点流 ----------
// heavy 的观点流聚合（多 RSS feed + StockTwits）只在首轮做；后续轮只做聚焦的 pplxFinance + 新闻，控内存/延迟。
// 竞争/替代视角：不再用硬编码的主题→竞对映射（旧 COMPETITOR_ALIASES 只覆盖 3 类主题，其余主题必空）。
// 竞对识别与逐个建档由 data agent（tool loop）自主完成，见 acquireData 的 AgentBackend 任务项。

// 竞对档案渲染：兼容 agent 产出的新 shape（{name, role, summary, filings, sources}）
// 与旧 shape（{name, filingSearch, web, finance}）——历史项目文件仍可展示。
function competitorDossierBrief(dossier = {}) {
  return (dossier.items || []).map((c) => {
    if (c.summary !== undefined || c.sources !== undefined) {
      const src = (c.sources || []).slice(0, 3).map((s) => (typeof s === 'string' ? s : s.title || s.url || '')).filter(Boolean).join('；');
      return `- ${c.name}（${c.role || '竞争者'}）：${String(c.summary || '').replace(/\s+/g, ' ').slice(0, 700)}${c.filings ? `｜SEC/招股书：${String(c.filings).slice(0, 200)}` : ''}${src ? `｜来源：${src}` : ''}`;
    }
    const sec = c.filingSearch?.hits?.length
      ? c.filingSearch.hits.map((h) => `${h.company || c.name} ${h.form || ''} ${h.filedAt || ''}`).join('；')
      : c.filingSearch?.note || 'No filing search result.';
    const web = (c.web?.results || []).map((r) => r.title).filter(Boolean).slice(0, 2).join('；');
    const ans = (c.finance?.answer || c.web?.answer || '').replace(/\s+/g, ' ').slice(0, 700);
    return `- ${c.name}：SEC/招股书检索=${sec}｜网页线索=${web || '—'}｜竞争摘要=${ans || '—'}`;
  }).join('\n');
}

// 每个子查询独立超时（部分失败容忍）：此前调用点用一个 90s withTimeout 包住整个聚合，
// 任一子查询慢就把 finance/drivers/competitive 全部丢弃（「数据空心」的主因之一）。
// 现在聚合永远 resolve，慢/挂的子查询单独降级为 {error:'timeout'}。查询语句改英文——
// 海外公司的检索源是英文，中文 query 召回质量差（工作语言纪律同样适用于硬编码 query）。
const RESEARCH_SUBQ_TIMEOUT_MS = 75000;
async function doResearch(tickers, theme, focusQuestions = [], heavy = true) {
  const q = focusQuestions.length
    ? `On "${theme}", answer: ${focusQuestions.join('; ')}`
    : `${theme} (tickers: ${tickers.join(', ')}): latest results, valuation, price targets, catalysts and risks`;
  const compQ = `Competitor & substitution view on ${tickers[0] || theme}, independent of the company's own framing: who is contesting each of its revenue pools? Latest progress and relative strength of competing products/substitute technologies, share shifts, and recent funding valuations of relevant private competitors. Facts and numbers required.`;
  const driverQ = `For "${theme}" (tickers: ${tickers.join(', ')}), first identify the 1-3 external drivers that most affect the investment judgment, then for each give current evidence and a data-acquisition plan: which of demand/supply/capacity/capex/pricing/regulation/tech substitution/customer budgets/order flow/channel inventory are the core variables? Which primary or high-credibility sources (filings, earnings-call transcripts, industry reports, peer disclosures, structured data) should be checked, covering which companies or value-chain links, and how should the 1-3 year outlook be sanity-checked? Do not force-fit an inapplicable theme; if AI capex or order flow genuinely is a key variable, expand it as one of the drivers.`;
  const sub = (p, fb) => withTimeout(p.catch((e) => ({ ...fb, error: String(e?.message || e) })), RESEARCH_SUBQ_TIMEOUT_MS, { ...fb, error: 'timeout' });
  const [finance, competitive, drivers, news, web, digest] = await Promise.all([
    sub(pplxFinance(q), {}),
    sub(pplxFinance(compQ), {}),
    sub(pplxFinance(driverQ), {}),
    withTimeout(getNews(tickers, 6).catch(() => ([])), RESEARCH_SUBQ_TIMEOUT_MS, []),
    heavy ? sub(tavilySearch(`${theme} ${tickers.join(' ')} latest catalyst`, { maxResults: 5, topic: 'news', days: 30 }), {}) : Promise.resolve({}),
    heavy ? sub(researchDigest({ tickers: tickers.slice(0, 3), theme, perSource: 3, includeX: false }), { items: [] }) : Promise.resolve({ items: [] }),
  ]);
  return {
    finance: { answer: finance.answer, citations: finance.citations || [], error: finance.error, _demo: finance._demo === true },
    competitive: { answer: competitive.answer, citations: competitive.citations || [], error: competitive.error, _demo: competitive._demo === true },
    drivers: { answer: drivers.answer, citations: drivers.citations || [], sources: drivers.sources || [], required: true, error: drivers.error, _demo: drivers._demo === true },
    news: (Array.isArray(news) ? news : []).map((n) => ({ symbol: n.symbol, title: n.title, site: n.site, url: n.url, publishedDate: n.publishedDate, text: n.text })),
    web: { answer: web.answer, results: (web.results || []).map((r) => ({ title: r.title, url: r.url })) },
    opinions: (digest.items || []).slice(0, 10).map((it) => ({ source: it.source, title: it.title, summary: (it.summary || '').slice(0, 140) })),
  };
}

// ---------- 明细数据（仅数据 sub-agent 用，取核心标的）：评级变动/机构持仓/收入结构/财务评分 ----------
async function fetchDetailData(tickers = []) {
  const list = tickers.filter(Boolean).slice(0, 2);
  if (!list.length) return {};
  const limit = pLimit(4);
  const entries = await Promise.all(list.map((t) => limit(async () => {
    const [grades, inst, revProd, score, sec] = await Promise.all([
      getUpgradesDowngrades(t).catch(() => null),
      getInstitutionalOwnership(t, { limit: 6 }).catch(() => null),
      getRevenueByProduct(t).catch(() => null),
      getFinancialScore(t).catch(() => null),
      edgarBrief(t, { maxChars: 1200 }).catch(() => null), // SEC 一手材料：8-K 事件 + 最新 10-K/Q 风险章节节选
    ]);
    return [t, {
      gradeBias: grades?.summary?.bias, recentGrades: (grades?.changes || []).slice(0, 4),
      topHolders: (inst?.holders || []).slice(0, 4).map((h) => h.holder),
      revenueSegments: revProd?.segments || null,
      piotroski: score?.piotroskiScore, altmanZ: score?.altmanZScore,
      sec: sec && !sec.error ? { events: sec.events, latestReport: sec.latestReport, riskExcerpt: sec.riskExcerpt } : null,
    }];
  })));
  return Object.fromEntries(entries);
}
// SEC 一手材料简报（供 gathered 注入，标注为最高可信层级）
function secBrief(detail = {}) {
  return Object.entries(detail).filter(([, d]) => d.sec).map(([t, d]) =>
    `${t}: 最新报告 ${d.sec.latestReport || '—'}｜近期 8-K：${d.sec.events || '—'}${d.sec.riskExcerpt ? `\n${d.sec.riskExcerpt.slice(0, 1000)}` : ''}`
  ).join('\n');
}

// ---------- 行业高频数据（数据模板 autoTools 挂载：FRED 序列 / 宏观日历等，round 1 执行） ----------
async function runAutoTools(autoTools = []) {
  const out = [];
  for (const at of autoTools.slice(0, 4)) {
    try {
      const r = await runTool(at.tool, at.args || {});
      out.push({ tool: at.tool, label: at.label || at.tool, result: r.result });
    } catch (e) { out.push({ tool: at.tool, label: at.label || at.tool, error: String(e.message || e) }); }
  }
  return out;
}
function highFreqBrief(items = []) {
  return items.map((it) => {
    if (it.error || it.result?.error) return `[${it.label}] 不可用（${(it.error || it.result.error).slice(0, 60)}）`;
    const r = it.result || {};
    if (r.latest) return `[${it.label}] 最新 ${r.latest.value}（${r.latest.date}）｜环比 ${r.momChange ?? '—'}% 同比 ${r.yoyChange ?? '—'}%`;
    if (r.events) return `[宏观日历] ${r.events.slice(0, 5).map((e) => `${e.date.slice(0, 10)} ${e.event}`).join('；') || '未来两周无高影响事件'}`;
    return `[${it.label}] ${JSON.stringify(r).slice(0, 160)}`;
  }).join('\n');
}

// ---------- 数据报告（data/data_report.md，累积式）：给「人 + 后续分析 agent」看的数据总结 ----------
// organized JSON 是机器结构；这里渲染成带置信度的可读报告：关键数字表/分部收入/按维度事实/竞争动态/矛盾/缺口。
// 确定性渲染（不经 LLM），行业/公司/结论 agent 消费当轮报告，前端项目文件夹可直接阅读。
function renderDataReport({ round, theme, asOf, coverage, fBrief, cBrief, sBrief, hBrief, competitorBrief, detail, organizedData, tickers, research, sourceMode = 'live-provider' }) {
  const pts = (organizedData.organized || []).flatMap((g) => (g.points || []).map((p) => ({ dim: g.dimension, ...p })));
  const byDim = {};
  for (const p of pts) (byDim[p.dim] = byDim[p.dim] || []).push(p);
  const dimBlock = Object.entries(byDim).map(([dim, ps]) =>
    `### ${dim}\n${ps.map((p) => {
      const trace = p.claimStatus === 'supported'
        ? ` [evidence:${(p.evidenceRefs || []).slice(0, 3).join(',')}]`
        : (p.claimStatus === 'estimate' ? ' [est]' : ' [open-issue]');
      return `- ${p.fact}${p.ticker ? `（${p.ticker}）` : ''}${trace} ｜可信度:${p.credibility || '—'}｜${p.type || ''}｜来源:${p.source || '—'}`;
    }).join('\n')}`
  ).join('\n\n');
  const segLines = Object.entries(detail || {}).filter(([, d]) => d.revenueSegments && typeof d.revenueSegments === 'object')
    .map(([t, d]) => `**${t}**：${Object.entries(d.revenueSegments).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} $${(v / 1e9).toFixed(1)}B`).join('｜')}`).join('\n');
  const contradictions = (organizedData.contradictions || []).map((c) => `- **${c.topic}**：${(c.conflicting || []).map((x) => `「${x.claim}」(${x.source})`).join(' vs ')}\n  假设：${c.hypothesis || '—'}｜验证：${c.resolveBy || '—'}`).join('\n');
  const gaps = (organizedData.gaps || []).map((g) => `- ${g}`).join('\n');
  const covLine = coverage ? `Coverage **${Math.round(coverage.score * 100)}%** (${coverage.dims.map((d) => `${d.name} ${Math.round(d.score * 100)}%`).join(' | ')})` : '';
  return `## Round ${round} Data Report · ${new Date(asOf).toISOString().slice(0, 10)}

Theme: ${theme} | Tickers: ${tickers.join(', ')} | ${sourceMode === 'live-provider' ? '' : `Evidence mode: ${sourceMode} | `}${covLine}

### Key figures (structured fundamentals, credibility: high/structured financials)
${fBrief || '—'}

${segLines ? `### Segment revenue structure (credibility: high/SEC basis)\n${segLines}\n` : ''}
${cBrief ? `### Peer comps (★=core ticker)\n${cBrief}\n` : ''}
${sBrief ? `### SEC primary material\n${sBrief.slice(0, 1500)}\n` : ''}
${competitorBrief ? `### Competitor dossier (independent sources / incl. prospectus search)\n${competitorBrief.slice(0, 2600)}\n` : ''}
${research?.drivers?.answer ? `### Key external drivers & evidence path (web research)\n${research.drivers.answer.slice(0, 2200)}\n` : ''}
${hBrief ? `### Industry high-frequency / macro\n${hBrief}\n` : ''}
${dimBlock}

### Contradictions (hypotheses to falsify)
${contradictions || '(none this round)'}

### Data gaps
${gaps || '(none)'}
`;
}

// ---------- 覆盖度打分：模板要求的数据拿到了几成（机械计算，不经 LLM） ----------
// 分数随 dataContext 下传：<0.6 时结论 confidence 会被硬性封顶——「数据不足」是硬约束而非软提示。
function computeCoverage({ quotes, fundamentals, transcripts, research, industry, detail, cfg, heavyResearch = true }) {
  const dims = [];
  const add = (name, ok) => dims.push({ name, score: typeof ok === 'number' ? +ok.toFixed(2) : (ok ? 1 : 0) });
  add('行情可信', quotes.length > 0 && quotes.every((q) => q.price > 0));
  if (cfg.fundamentals) {
    const fields = ['pe', 'revenueGrowth', 'roe', 'fcfPerShare', 'fwdPE1', 'pePctile5y', 'nextEarnings'];
    const ds = Object.values(fundamentals);
    add('基本面完整度', ds.length ? ds.reduce((a, d) => a + fields.filter((f) => d[f] != null).length / fields.length, 0) / ds.length : 0);
    add('前瞻共识', ds.some((d) => d.fwdPE1 != null));
    add('一手材料(SEC)', Object.values(detail || {}).some((d) => d.sec));
  }
  if (cfg.transcript) add('财报会', transcripts.length > 0);
  if (cfg.research) {
    add('联网研究', !!research?.finance?.answer);
    add('关键外部驱动', !!research?.drivers?.answer);
    add('竞争对手资料', (research?.competitorDossier?.items || []).length > 0);
    if (heavyResearch) add('观点流', (research?.opinions || []).length > 0);
  }
  add('同业comps', (industry.comps || []).length > 2);
  const score = dims.length ? +(dims.reduce((a, d) => a + d.score, 0) / dims.length).toFixed(2) : 0;
  return { score, dims };
}

function buildSourceManifest({ round, asOf, activeTickers, quotes, fundamentals, transcripts, research, industry, detail, highFreq, focusTools, coverage, sourceRefs = [], sourceMode = 'live-provider' }) {
  const sources = [
    { id: `r${round}:fmp_quotes`, provider: 'fmp', tools: ['fmp_quote'], category: 'market', tickers: activeTickers, ok: quotes.length > 0, qualityScore: quotes.length ? 1 : 0 },
    { id: `r${round}:fmp_fundamentals`, provider: 'fmp', tools: ['fmp_ratios', 'fmp_growth', 'fmp_forward_estimates', 'fmp_key_metrics', 'fmp_income', 'fmp_valuation_history'], category: 'fundamentals', tickers: Object.keys(fundamentals || {}), ok: Object.keys(fundamentals || {}).length > 0, qualityScore: coverage?.dims?.find((d) => d.name === '基本面完整度')?.score ?? null },
    { id: `r${round}:fmp_transcripts`, provider: 'fmp', tools: ['fmp_transcript'], category: 'transcripts', tickers: (transcripts || []).map((t) => t.symbol), ok: (transcripts || []).length > 0, qualityScore: (transcripts || []).length ? 1 : 0 },
    { id: `r${round}:edgar`, provider: 'edgar', tools: ['edgar_filings', 'edgar_section'], category: 'primary-filings', tickers: Object.keys(detail || {}).filter((t) => detail[t]?.sec), ok: Object.values(detail || {}).some((d) => d.sec), qualityScore: coverage?.dims?.find((d) => d.name === '一手材料(SEC)')?.score ?? null },
    { id: `r${round}:industry`, provider: 'fmp', tools: ['fmp_sector', 'fmp_comps', 'fmp_peers'], category: 'industry-comps', tickers: activeTickers, ok: (industry?.comps || []).length > 0, qualityScore: coverage?.dims?.find((d) => d.name === '同业comps')?.score ?? null },
    { id: `r${round}:research`, provider: 'mixed', tools: ['pplx_finance', 'tavily_search', 'research_digest'], category: 'web-research', tickers: activeTickers, ok: !!(research?.finance?.answer || research?.drivers?.answer), qualityScore: coverage?.dims?.find((d) => d.name === '联网研究')?.score ?? null },
    { id: `r${round}:competitor_dossier`, provider: 'mixed', tools: ['pplx_finance', 'tavily_search', 'edgar_fulltext'], category: 'competition-research', tickers: activeTickers, ok: (research?.competitorDossier?.items || []).length > 0, qualityScore: coverage?.dims?.find((d) => d.name === '竞争对手资料')?.score ?? null },
    { id: `r${round}:highfreq`, provider: 'mixed', tools: (highFreq || []).map((x) => x.tool).filter(Boolean), category: 'macro-highfreq', tickers: [], ok: (highFreq || []).length > 0, qualityScore: (highFreq || []).length ? 1 : null },
    { id: `r${round}:focus_tools`, provider: 'mixed', tools: (focusTools || []).map((x) => x.tool).filter(Boolean), category: 'focused-followup', tickers: (focusTools || []).map((x) => x.symbol).filter(Boolean), ok: (focusTools || []).length > 0, qualityScore: (focusTools || []).length ? 1 : null },
  ];
  return {
    round,
    generatedAt: Date.parse(asOf),
    ...(sourceMode === 'live-provider' ? {} : { sourceMode }),
    coverageScore: coverage?.score ?? null,
    sourceRefs,
    sources: sources.filter((s) => s.ok || s.qualityScore != null || s.tools.length),
  };
}

function buildToolCoverage({ round, asOf, cfg, research, coverage, focusTools, highFreq, sourceMode = 'live-provider' }) {
  const requiredTools = ['fmp_quote'];
  if (cfg.fundamentals) requiredTools.push('fmp_ratios', 'fmp_growth', 'fmp_forward_estimates', 'fmp_key_metrics', 'fmp_income', 'fmp_valuation_history', 'edgar_filings');
  if (cfg.transcript) requiredTools.push('fmp_transcript');
  if (cfg.research) requiredTools.push('pplx_finance', 'research_digest');
  if (cfg.research) requiredTools.push('tavily_search', 'edgar_fulltext');
  const usedTools = [
    'fmp_quote',
    cfg.fundamentals && ['fmp_ratios', 'fmp_growth', 'fmp_forward_estimates', 'fmp_key_metrics', 'fmp_income', 'fmp_valuation_history', 'edgar_filings', 'fmp_comps'],
    cfg.transcript && 'fmp_transcript',
    research?.finance?.answer && 'pplx_finance',
    research?.drivers?.answer && 'pplx_finance',
    (research?.competitorDossier?.items || []).length && ['pplx_finance', 'tavily_search', 'edgar_fulltext'],
    ...(highFreq || []).map((x) => x.tool),
    ...(focusTools || []).map((x) => x.tool),
  ].flat().filter(Boolean);
  const missingTools = [...new Set(requiredTools.filter((t) => !usedTools.includes(t)))];
  const healthIssues = [
    research?.finance?.error && `pplx_finance: ${research.finance.error.slice(0, 120)}`,
    research?.drivers?.error && `pplx_finance(drivers): ${research.drivers.error.slice(0, 120)}`,
    research?.competitorDossier?.error && `competitor_dossier: ${research.competitorDossier.error.slice(0, 120)}`,
    ...(research?.competitorDossier?.items || []).flatMap((x) => [x.filingSearch?.error && `edgar_fulltext:${x.name} ${x.filingSearch.error.slice(0, 80)}`, x.web?.error && `tavily_search:${x.name} ${x.web.error.slice(0, 80)}`, x.finance?.error && `pplx_finance:${x.name} ${x.finance.error.slice(0, 80)}`].filter(Boolean)),
    ...(focusTools || []).filter((x) => x.error).map((x) => `${x.tool}:${x.symbol} ${x.error.slice(0, 80)}`),
  ].filter(Boolean);
  return {
    round,
    generatedAt: Date.parse(asOf),
    ...(sourceMode === 'live-provider' ? {} : { sourceMode }),
    requiredTools: [...new Set(requiredTools)],
    usedTools: [...new Set(usedTools)],
    missingTools,
    healthIssues,
    coverageScore: coverage?.score ?? null,
  };
}
function detailBrief(detail = {}) {
  return Object.entries(detail).map(([t, d]) => {
    const seg = d.revenueSegments && typeof d.revenueSegments === 'object' ? Object.entries(d.revenueSegments).slice(0, 4).map(([k, v]) => `${k}:${typeof v === 'number' ? (v / 1e9).toFixed(1) + 'B' : v}`).join(' ') : '—';
    return `${t}: 评级变动 ${d.gradeBias || '—'}｜Piotroski ${d.piotroski ?? '—'} / AltmanZ ${d.altmanZ ?? '—'}｜前十机构 ${(d.topHolders || []).join('/') || '—'}｜收入结构 ${seg}`;
  }).join('\n');
}

const FROZEN_DATA_FIELDS = Object.freeze([
  'quotes',
  'fundamentals',
  'transcripts',
  'research',
  'industry',
  'detail',
  'highFreq',
]);

function normalizedFrozenData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('frozenData must be a provider-shaped evidence object');
  }
  const missing = FROZEN_DATA_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length) throw new TypeError(`frozenData is missing fields: ${missing.join(', ')}`);
  const clone = structuredClone(value);
  if (!Array.isArray(clone.quotes)) throw new TypeError('frozenData.quotes must be an array');
  if (!clone.fundamentals || typeof clone.fundamentals !== 'object' || Array.isArray(clone.fundamentals)) throw new TypeError('frozenData.fundamentals must be an object');
  if (!Array.isArray(clone.transcripts)) throw new TypeError('frozenData.transcripts must be an array');
  if (!clone.research || typeof clone.research !== 'object' || Array.isArray(clone.research)) throw new TypeError('frozenData.research must be an object');
  if (!clone.industry || typeof clone.industry !== 'object' || Array.isArray(clone.industry)) throw new TypeError('frozenData.industry must be an object');
  if (!clone.detail || typeof clone.detail !== 'object' || Array.isArray(clone.detail)) throw new TypeError('frozenData.detail must be an object');
  if (!Array.isArray(clone.highFreq)) throw new TypeError('frozenData.highFreq must be an array');
  return clone;
}

// ---------- 行业级上下文（板块表现 + 同业 comps 表） ----------
async function gatherIndustry(tickers) {
  const [sector, comps] = await Promise.all([
    getSectorPerformance().catch(() => ({ sectors: [] })),
    // 主题候选标的强制并入 comps（FMP peers 集合可能与投资逻辑脱节）
    tickers[0] ? getComps(tickers[0], { maxPeers: 7, include: tickers.slice(1, 4) }).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
  ]);
  const sectors = (sector.sectors || []).map((s) => `${s.sector} ${s.changesPercentage}`);
  return { sectors, peers: (comps.rows || []).filter((r) => !r.isTarget).map((r) => r.ticker), comps: comps.rows || [] };
}
// comps 表 → 简报（横向"贵/便宜"锚，标注目标公司）
function compsBrief(rows = []) {
  if (!rows.length) return '';
  const num = (x, d = 1) => (x == null ? '—' : (+x).toFixed(d));
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '%');
  return rows.map((r) => `${r.isTarget ? '★' : '·'} ${r.ticker}: PE ${num(r.pe)} fwdPE ${num(r.fwdPE1)} PS ${num(r.ps)} fwdPEG ${num(r.fwdPEG, 2)}｜毛利${pct(r.grossMargin)} ROE${pct(r.roe)} 营收增速${pct(r.revenueGrowth)}`).join('\n');
}

/**
 * 数据获取主流程。返回 dataContext（供行业/公司 agent 使用）+ 落盘 sources/excerpts。
 * @param {object} p { id, tickers, theme, guideline, cfg, round, focus }
 */
export async function acquireData({ id, tickers, theme, brief = '', guideline, autoTools = [], cfg, round = 1, focus = {}, asOf, frozenData = null }) {
  const evidenceAsOfMillis = Date.parse(asOf);
  if (!Number.isFinite(evidenceAsOfMillis) || new Date(evidenceAsOfMillis).toISOString() !== asOf) {
    throw new TypeError('acquireData asOf must be an ISO timestamp');
  }
  const evidenceAsOf = asOf;
  const focusTickers = (focus.tickers || []).filter(Boolean);
  const activeTickers = round === 1 ? tickers : [...new Set([...(focusTickers.length ? focusTickers : tickers)])];
  const focusQs = (focus.questions || []).slice(0, 3);
  const dataPlan = buildDataPlan({ brief, theme, tickers: activeTickers, round, focus, cfg, autoTools, asOf: evidenceAsOf });
  if (id) ProjectFS.setDataFile(id, `data_plan_r${round}.json`, dataPlan);

  // —— 第一段：确定性「必采集基线」——便宜、稳定、结构化，不占 agent 步数，不该让 LLM 逐个要。
  // 轮间基线携带：round>1 时基本面/明细/transcripts/行业上下文对「上一轮已覆盖的标的」直接
  // 复用落盘产物（基本面季度内不会变），只对新晋升的 focus 标的增量抓取——省时省预算。
  // 行情必须新抓（分析中价格会动）；研究检索按 focus 问题定向重跑（这正是后续轮的目的）。
  let quotes;
  let fundamentals;
  let transcripts;
  let research;
  let industry;
  let detail;
  let highFreq;
  if (frozenData) {
    ({ quotes, fundamentals, transcripts, research, industry, detail, highFreq } = normalizedFrozenData(frozenData));
    dataEvent(id, `数据阶段：载入第 ${round} 轮 versioned frozen evidence snapshot；外部采集调用数为 0。`, {
      round,
      tickers: activeTickers,
      sourceMode: 'frozen',
    });
  } else {
    const prevFund = (round > 1 && id) ? (readDataFile(id, 'fundamentals.json') || {}) : {};
    const prevDetail = (round > 1 && id) ? (readDataFile(id, 'detail.json') || {}) : {};
    const prevTranscripts = (round > 1 && id) ? (readDataFile(id, 'transcripts.json') || []) : [];
    const prevIndustry = (round > 1 && id) ? readDataFile(id, 'industry.json') : null;
    const newTickers = round === 1 ? activeTickers : activeTickers.filter((t) => !prevFund[String(t).toUpperCase()]);
    const transcriptCovered = new Set((Array.isArray(prevTranscripts) ? prevTranscripts : []).map((t) => t.symbol));
    const transcriptTickers = round === 1 ? activeTickers : activeTickers.filter((t) => !transcriptCovered.has(String(t).toUpperCase()));
    dataEvent(id, `数据阶段：开始抓取结构化数据基线（第 ${round} 轮）${round > 1 ? `：复用上一轮 ${activeTickers.length - newTickers.length} 个标的基线，增量抓取 ${newTickers.length} 个` : ''}`, { round, tickers: activeTickers, incremental: round > 1 ? newTickers : undefined });
    let fundNew;
    let transcriptsNew;
    let industryNew;
    let detailNew;
    [quotes, fundNew, transcriptsNew, research, industryNew, detailNew, highFreq] = await Promise.all([
      getQuotes(activeTickers).catch(() => []),
      (cfg.fundamentals && newTickers.length) ? fetchFundamentals(newTickers).catch(() => ({})) : Promise.resolve({}),
      (cfg.transcript && transcriptTickers.length) ? gatherTranscripts(transcriptTickers, { projectId: id, primary: (focus.tickers?.length ? focus.tickers : tickers).slice(0, 2), quartersBack: round === 1 ? 4 : 2 }).catch(() => []) : Promise.resolve([]),
      // doResearch 内部已做逐子查询超时（部分失败容忍），聚合永远 resolve——不再整体式超时
      cfg.research ? doResearch(activeTickers, theme, focusQs, round === 1).catch((e) => ({ finance: { error: String(e.message || e) }, drivers: { error: String(e.message || e), required: true }, opinions: [] })) : Promise.resolve(null),
      (round === 1 || newTickers.length) ? gatherIndustry(round === 1 ? activeTickers : newTickers).catch(() => ({ sectors: [], peers: [] })) : Promise.resolve(prevIndustry || { sectors: [], peers: [] }),
      (cfg.fundamentals && newTickers.length) ? fetchDetailData(newTickers).catch(() => ({})) : Promise.resolve({}),
      round === 1 ? runAutoTools(autoTools).catch(() => []) : Promise.resolve([]),
    ]);
    fundamentals = round === 1 ? fundNew : { ...prevFund, ...fundNew };
    detail = round === 1 ? detailNew : { ...prevDetail, ...detailNew };
    transcripts = round === 1 ? transcriptsNew : [...(Array.isArray(prevTranscripts) ? prevTranscripts : []), ...transcriptsNew];
    industry = (round > 1 && prevIndustry && !newTickers.length) ? prevIndustry : industryNew;
  }
  dataEvent(id, `数据阶段：基线抓取完成，data agent 开始自主补数与整理（覆盖候选 ${activeTickers.length} 个）`, {
    round,
    researchTimeout: !!research?._timeout,
    quoteCount: quotes.length,
    fundamentalCount: Object.keys(fundamentals || {}).length,
  });
  if (cfg.fundamentals) attachForwardMultiples(fundamentals, quotes);

  const fBrief = fundamentalsBrief(fundamentals);
  const tBrief = transcriptsBrief(transcripts);
  const oBrief = (research?.opinions || []).map((o) => `[${o.source}] ${o.title}`).join('\n');
  const cBrief = compsBrief(industry.comps);
  const iBrief = `板块表现：${industry.sectors.slice(0, 6).join('、') || '—'}｜可比公司：${industry.peers.slice(0, 8).join(', ') || '—'}`;
  const dBrief = detailBrief(detail);
  const sBrief = secBrief(detail);
  const hBrief = highFreqBrief(highFreq);

  const sourceMode = frozenData ? 'frozen-snapshot-replay' : 'live-provider';
  const collection = collectEvidence({
    plan: dataPlan,
    asOf: evidenceAsOf,
    raw: { quotes, fundamentals, transcripts, research, industry, detail, highFreq },
    sourceMode,
  });
  const normalizedEvidenceBrief = collection.evidenceItems.slice(0, 120)
    .map((item) => `[${item.evidenceId}] ${item.statement}`)
    .join('\n');

  // 已抓取原始资料（标注来源，供 data agent 判可信度/矛盾，并决定还缺什么）
  const gathered = [
    `行情[来源:FMP行情]：${JSON.stringify(quotes.map((q) => ({ s: q.symbol, p: q.price, chg: q.changesPercentage })))}`,
    fBrief && `基本面+前瞻[来源:FMP财务/共识]：\n${fBrief}`,
    dBrief && `明细[来源:FMP机构/评级/收入结构/评分]：\n${dBrief}`,
    iBrief && `行业上下文[来源:FMP板块/可比]：${iBrief}`,
    cBrief && `同业对比表[来源:FMP comps，★=核心标的]：\n${cBrief}`,
    sBrief && `SEC 备案[来源:EDGAR一手,可信度最高]：\n${sBrief.slice(0, 2200)}`,
    hBrief && `行业高频/宏观[来源:FRED/日历]：\n${hBrief}`,
    tBrief && `财报会[来源:管理层一手]：\n${tBrief.slice(0, 2000)}`,
    research?.finance?.answer && `联网研究[来源:Perplexity二手]：${research.finance.answer.slice(0, 800)}`,
    research?.finance?.error && `联网研究失败[来源:Perplexity错误]：${research.finance.error.slice(0, 300)}`,
    research?.competitive?.answer && `竞争/替代视角[来源:独立联网检索，非公司口径]：${research.competitive.answer.slice(0, 1000)}`,
    research?.competitive?.error && `竞争/替代检索失败[来源:Perplexity错误]：${research.competitive.error.slice(0, 300)}`,
    research?.drivers?.answer && `关键外部驱动与证据路径[来源:独立联网检索，非公司口径]：${research.drivers.answer.slice(0, 1800)}`,
    research?.drivers?.error && `关键外部驱动检索失败[来源:Perplexity错误]：${research.drivers.error.slice(0, 300)}`,
    oBrief && `分析师/博主观点[来源:SA/博客/社交,观点非事实]：\n${oBrief.slice(0, 500)}`,
    normalizedEvidenceBrief && `规范化 EvidenceItem（引用时保留 evidence id）：\n${normalizedEvidenceBrief}`,
  ].filter(Boolean).join('\n\n');

  // —— 第二段：data agent（tool loop）——基线之上自主补数、建竞对档案、整理可信度/矛盾/缺口。
  const organizeFallback = {
    organized: [],
    sourceQuality: [],
    contradictions: [],
    gaps: ['Data agent timed out or failed; downstream agents should treat this round as low-confidence and rely on deterministic raw data briefs.'],
    nextDataFocus: { questions: ['Retry data organization and validate core assumptions with primary sources.'], tickers: activeTickers.slice(0, 2), tools: ['edgar_filings', 'fmp_forward_estimates'] },
    competitorDossier: { competitors: [], items: [] },
  };
  const agentRes = await runDefinedAgent('data-orchestrator', {
    brief,
    theme,
    tickers: activeTickers,
    round,
    focus: { questions: focusQs, tools: focus.tools || [], tickers: focusTickers },
    gathered,
    guideline,
  }, {
    outputSchema: SCHEMAS['data-organize'],
    toolAllow: [],
    toolCallBudget: 0,
    // Wall-clock is the primary completion boundary. Later rounds retain the full deadline
    // because first-token latency does not shrink linearly with the narrower task scope.
    deadlineMs: (cfg.depth?.dataMin ?? 10) * 60000,
    round, step: 2, stage: 'data', artifact: `data/organized_r${round}.json`,
    kind: 'data-agent', temperature: 0.3,
  });
  let data = agentRes.output || organizeFallback;
  // 整理失败不再空转：回收上一轮 organized（降级标注 stale）——0 条摘录会让整轮行业/公司分析
  // 在真空上推理（ax4b1ri 第 3 轮因此覆盖度 100→87、结论跟着垮）。宁可用旧摘录也不给空集。
  if (!agentRes.output) {
    if (round > 1 && id) {
      try {
        const prev = JSON.parse(ProjectFS.fileContent(id, `data/organized_r${round - 1}.json`) || 'null');
        if (Array.isArray(prev?.organized) && prev.organized.length) {
          data = {
            ...organizeFallback,
            organized: prev.organized.map((g) => ({ ...g, points: (g.points || []).map((p) => ({ ...p, note: `[stale r${round - 1}] ${p.note || ''}`.trim() })) })),
            sourceQuality: prev.sourceQuality || [],
            contradictions: prev.contradictions || [],
            gaps: [...organizeFallback.gaps, `Round ${round} organization failed; reusing round ${round - 1} excerpts (stale).`],
          };
        }
      } catch { /* 上一轮也没有就用 fallback */ }
    }
    dataEvent(id, `数据阶段：data agent 未产出合法结构（或 demo 模式），${data.organized.length ? `已回收上一轮 ${data.organized.length} 组摘录（标记 stale）继续` : '已使用低置信度 fallback 继续流程'}`, { round, stopReason: agentRes.stopReason, salvaged: data.organized.length });
  }
  if (agentRes.budgetExhausted) dataEvent(id, '数据阶段：预算耗尽，data agent 已基于已有材料提前收尾', { round });

  // 竞对档案由 agent 自主检索产出（替代旧 COMPETITOR_ALIASES 硬编码），归一化后挂回 research 供下游/覆盖度消费
  const dossier = {
    competitors: Array.isArray(data.competitorDossier?.competitors) ? data.competitorDossier.competitors : [],
    items: Array.isArray(data.competitorDossier?.items) ? data.competitorDossier.items : [],
  };
  const researchOut = research || {};
  researchOut.competitorDossier = dossier;
  const compDossierBrief = competitorDossierBrief(dossier);

  // 覆盖度在 agent 补数之后计算（竞对档案等维度依赖 agent 产出）
  const coverage = computeCoverage({ quotes, fundamentals, transcripts, research: researchOut, industry, detail, cfg, theme, heavyResearch: round === 1 });

  const audited = auditEvidence({ plan: dataPlan, collection, organizedOutput: data });
  const priorSourceDocumentSets = Array.from({ length: Math.max(0, round - 1) }, (_, index) => ({
    round: index + 1,
    documents: readDataFile(id, `source_documents_r${index + 1}.json`)?.documents || [],
  }));
  const priorSourceDocuments = priorSourceDocumentSets.flatMap((entry) => entry.documents);
  const priorEvidenceItems = Array.from({ length: Math.max(0, round - 1) }, (_, index) => {
    const bundle = readDataFile(id, `evidence_bundle_r${index + 1}.json`) || {};
    return bundle.items || bundle.evidenceItems || [];
  }).flat();
  const citationLedger = buildCitationLedger({
    round,
    asOf: evidenceAsOf,
    sourceDocuments: [...priorSourceDocuments, ...collection.sourceDocuments],
    evidenceItems: [...priorEvidenceItems, ...collection.evidenceItems],
    sourceRounds: Object.fromEntries([
      ...priorSourceDocumentSets.flatMap((entry) => entry.documents.map((source) => [source.sourceId, entry.round])),
      ...collection.sourceDocuments.map((source) => [source.sourceId, round]),
    ]),
  });
  const originalFocus = data.nextDataFocus || { questions: [], tickers: [], tools: [] };
  data = {
    ...data,
    organized: audited.organized,
    gaps: audited.bundle.gaps,
    nextDataFocus: {
      questions: [...new Set([...(originalFocus.questions || []), ...audited.nextRequests.map((request) => request.question)])],
      tickers: [...new Set(originalFocus.tickers || [])],
      tools: [...new Set([...(originalFocus.tools || []), ...audited.nextRequests.flatMap((request) => request.preferredTools || [])])],
    },
    evidenceAudit: audited.bundle.claimAudit,
    openIssues: audited.openIssues,
  };

  // agent 的实际工具调用（来自 AgentTrace），供 source manifest / tool coverage 记账
  const agentToolCalls = (agentRes.trace?.toolCalls || []).map((tc) => ({ tool: tc.tool, ok: tc.ok, error: tc.ok ? null : 'tool call failed' }));

  // 兼容下游：把 organized 展平成 excerpts（category/point/source/ticker + credibility）
  const excerpts = (data.organized || []).flatMap((g) => (g.points || []).map((p) => ({
    category: g.dimension,
    point: p.fact,
    source: p.source,
    ticker: p.ticker,
    credibility: p.credibility,
    type: p.type,
    claimId: p.claimId,
    claimStatus: p.claimStatus,
    evidenceRefs: p.evidenceRefs || [],
  })));

  // 数据报告（当轮渲染 + 追加到累积文件）
  const dataReport = renderDataReport({ round, theme, asOf: evidenceAsOf, coverage, fBrief, cBrief, sBrief, hBrief, competitorBrief: compDossierBrief, detail, organizedData: data, tickers: activeTickers, research: researchOut, sourceMode });

  if (id) {
    ProjectFS.setData(id, { plan: { logic: theme }, quotes, research: researchOut, fetchedAt: Date.parse(evidenceAsOf) });
    if (cfg.fundamentals) { ProjectFS.setDataFile(id, 'fundamentals.json', fundamentals); ProjectFS.setDataFile(id, 'detail.json', detail); }
    if (transcripts.length) ProjectFS.setDataFile(id, 'transcripts.json', transcripts);
    if (dossier.items.length) ProjectFS.setDataFile(id, `competitor_dossier_r${round}.json`, dossier);
    ProjectFS.setDataFile(id, `source_documents_r${round}.json`, {
      schemaVersion: 'source-document-set.v1',
      asOf: evidenceAsOf,
      planDigest: dataPlan.inputDigest,
      sourceRefs: collection.sourceDocuments.map((source) => source.sourceId),
      documents: collection.sourceDocuments,
      excluded: collection.excluded,
      stats: collection.stats,
    });
    ProjectFS.setDataFile(id, `evidence_bundle_r${round}.json`, audited.bundle);
    ProjectFS.setDataFile(id, 'citation_ledger.json', citationLedger);
    ProjectFS.setDataFile(id, `domain_events_r${round}.json`, {
      schemaVersion: 'domain-event-set.v1',
      asOf: evidenceAsOf,
      evidenceRefs: collection.domainEvents.flatMap((event) => event.evidenceRefs),
      events: collection.domainEvents,
    });
    ProjectFS.setDataFile(id, `organized_r${round}.json`, { coverage, ...data, evidenceBundle: `data/evidence_bundle_r${round}.json` }); // 格式化数据整理（含覆盖度/可信度/矛盾/下一轮方向）
    ProjectFS.setDataFile(id, 'industry.json', industry);
    if (highFreq.length) ProjectFS.setDataFile(id, 'highfreq.json', highFreq);
    ProjectFS.appendDataReport(id, dataReport, round);
    assertDataArtifactsCommitted(id, round);
    const manifest = buildSourceManifest({ round, asOf: evidenceAsOf, activeTickers, quotes, fundamentals, transcripts, research: researchOut, industry, detail, highFreq, focusTools: agentToolCalls, coverage, sourceRefs: audited.bundle.sourceRefs, sourceMode });
    const prevManifest = ProjectFS.sourceManifest(id);
    ProjectFS.setSourceManifest(id, {
      generatedAt: Date.parse(evidenceAsOf),
      rounds: [...(prevManifest?.rounds || []).filter((r) => r.round !== round), manifest].sort((a, b) => a.round - b.round),
    });
    const toolCoverage = buildToolCoverage({ round, asOf: evidenceAsOf, cfg, research: researchOut, coverage, focusTools: agentToolCalls, highFreq, sourceMode });
    const prevCoverage = ProjectFS.toolCoverage(id);
    ProjectFS.setToolCoverage(id, {
      generatedAt: Date.parse(evidenceAsOf),
      rounds: [...(prevCoverage?.rounds || []).filter((r) => r.round !== round), toolCoverage].sort((a, b) => a.round - b.round),
      latest: toolCoverage,
    });
  }

  return {
    tickers: activeTickers, theme, quotes, fundamentals, transcripts, research: researchOut, industry, detail, highFreq,
    dataReport,
    dataPlan,
    evidenceBundle: audited.bundle,
    citationLedger,
    sourceDocuments: collection.sourceDocuments,
    domainEvents: collection.domainEvents,
    briefs: { fundamentals: fBrief, transcripts: tBrief, opinions: oBrief, industry: iBrief, detail: dBrief, comps: cBrief, sec: sBrief, highFreq: hBrief, competitorDossier: compDossierBrief },
    organized: data.organized || [], excerpts,
    sourceQuality: data.sourceQuality || [], contradictions: data.contradictions || [],
    gaps: data.gaps || [], nextDataFocus: data.nextDataFocus || { questions: [], tickers: [], tools: [] },
    coverage,
    agent: { steps: agentRes.steps, toolCallsMade: agentRes.toolCallsMade, stopReason: agentRes.stopReason, budgetExhausted: !!agentRes._budgetExhausted },
  };
}
