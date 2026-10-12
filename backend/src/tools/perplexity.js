// 外部工具库 - Perplexity 工具（联网检索 / 金融问答 / 页面问答），含演示回退
// 文档：https://docs.perplexity.ai
import { runtime } from '../config.js';
import { curlPostJSON, fetchJSON } from '../lib/http.js';

const ENDPOINT = 'https://api.perplexity.ai/chat/completions';

// —— 传输层：api.perplexity.ai 在部分网络环境被 DNS 污染/SNI 阻断（解析到 Facebook IP 段），
// 直连永远黑洞超时。支持经本地代理（PPLX_PROXY / HTTPS_PROXY，如 Clash 的 http://127.0.0.1:7897）。
// 首次调用探测可用传输并记忆（直连黑洞会吃满超时，不能每次都试一遍）。
let transportMemo = null; // 'direct' | 'proxy'
function pplxProxy() { return process.env.PPLX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || ''; }
async function pplxTransport(req) {
  const proxy = pplxProxy();
  const direct = async () => {
    try { return await fetchJSON(ENDPOINT, req); }
    catch { return curlPostJSON(ENDPOINT, { ...req, connectTimeoutSec: 8 }); }
  };
  const viaProxy = () => curlPostJSON(ENDPOINT, { ...req, proxy, connectTimeoutSec: 8 });
  // 记忆命中：直接走上次成功的传输；失败则清记忆重新探测
  if (transportMemo === 'proxy' && proxy) {
    try { return await viaProxy(); } catch (e) { transportMemo = null; throw e; }
  }
  if (transportMemo === 'direct') {
    try { return await direct(); } catch { transportMemo = null; }
  }
  // 探测：有代理配置时优先代理（直连黑洞的探测成本太高）
  if (proxy) {
    try { const r = await viaProxy(); transportMemo = 'proxy'; return r; } catch { /* 代理不行再试直连 */ }
  }
  const r = await direct();
  transportMemo = 'direct';
  return r;
}

async function pplxChat({ model = 'sonar', system, query, maxTokens = 700, temperature = 0.2, recency, searchMode, afterDate, beforeDate, domains, contextSize, timeoutMs = 45000 }) {
  const key = runtime.PERPLEXITY_API_KEY;
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: query },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (recency) body.search_recency_filter = recency; // hour|day|week|month|year
  if (searchMode) body.search_mode = searchMode;     // 'sec'（SEC 备案语料）| 'academic'
  if (afterDate) body.search_after_date_filter = afterDate;    // 'M/D/YYYY'：内容发布时间下限
  if (beforeDate) body.search_before_date_filter = beforeDate; // 'M/D/YYYY'：内容发布时间上限
  if (Array.isArray(domains) && domains.length) body.search_domain_filter = domains.slice(0, 10); // 白名单域名（'-域名' 为排除）
  if (contextSize) body.web_search_options = { search_context_size: contextSize }; // low|medium|high：检索上下文量
  const req = {
    method: 'POST',
    timeoutMs,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const data = await pplxTransport(req);
  const answer = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || (data.search_results || []).map((s) => s.url).filter(Boolean);
  const sources = (data.search_results || []).map((s) => ({ title: s.title, url: s.url, date: s.date }));
  return { answer, citations, sources, model: data.model || model, _demo: false };
}

// 未配置 key 的演示回退（仅在确实缺 key 时使用）
function demo(query, label) {
  return {
    answer: `【演示】未配置 Perplexity key，无法实时检索「${query}」。配置后可返回带引用来源的${label}。`,
    citations: [], sources: [], model: 'demo', _demo: true, _noKey: true,
  };
}
// API 调用失败的真实错误回退（key 已配置，但请求/网络/限流出错）——不要误报成"未配置 key"
function fail(query, err) {
  return {
    answer: '', citations: [], sources: [], model: 'error', _demo: false,
    error: String(err?.message || err),
  };
}

/** 通用联网检索问答（sonar）。支持时间窗（afterDate/beforeDate 'M/D/YYYY'）与域名过滤。 */
export async function pplxSearch(query, { model = 'sonar', recency, afterDate, beforeDate, domains } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(query, '联网检索结果');
  if (!query || !String(query).trim()) return fail(query, '缺少检索内容（query 为空）');
  try {
    return await pplxChat({
      model,
      system: '你是严谨的研究助手。基于最新联网信息回答，给出关键事实与数据，并标注来源。回答简洁、结构化、可引用。',
      query, recency, afterDate, beforeDate, domains,
    });
  } catch (e) { return fail(query, e); }
}

/** 金融专向检索（强调财报/估值/分析师观点/最新动态）。contextSize=high 吃满检索上下文。 */
export async function pplxFinance(query, { model = 'sonar-pro', recency = 'month', afterDate, beforeDate, domains } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(query, '金融检索结果');
  if (!query || !String(query).trim()) return fail(query, '缺少检索内容（query 为空）');
  try {
    return await pplxChat({
      model,
      system: '你是专业的卖方金融研究助手。围绕标的/主题，给出：最新业绩与指引、估值与分析师目标价、关键催化与风险、近期重大新闻。务必引用可靠财经来源（公司公告、主流财经媒体、分析师报告）。',
      query, recency, afterDate, beforeDate, domains, maxTokens: 900, contextSize: 'high',
    });
  } catch (e) { return fail(query, e); }
}

/** SEC 备案语料检索（search_mode=sec）：直接在 10-K/10-Q/8-K/S-1 等 filing 语料里检索问答——
 * 比通用网页检索更适合回答「披露了什么/风险因素/分部口径/管理层讨论」类问题。 */
export async function pplxSec(query, { model = 'sonar-pro', recency, afterDate, beforeDate } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(query, 'SEC 备案检索结果');
  if (!query || !String(query).trim()) return fail(query, '缺少检索内容（query 为空）');
  try {
    return await pplxChat({
      model,
      system: '你是 SEC 备案研究助手。仅基于公司 SEC filings（10-K/10-Q/8-K/S-1/424B/DEF 14A 等）回答：引用具体 filing、章节与数字；filing 中没有的信息明确说明未披露，不要用其他来源补。',
      query, recency, afterDate, beforeDate, searchMode: 'sec', maxTokens: 1200, contextSize: 'high',
    });
  } catch (e) { return fail(query, e); }
}

/** 多步推理检索（sonar-reasoning-pro）：需要跨来源综合+逻辑推理的复杂问题
 * （如「A 公司产能爬坡对 B 环节价格的传导路径与时点」），比单发检索更能给出论证链。 */
export async function pplxReason(query, { recency = 'month', afterDate, beforeDate, domains } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(query, '推理检索结果');
  if (!query || !String(query).trim()) return fail(query, '缺少检索内容（query 为空）');
  try {
    return await pplxChat({
      model: 'sonar-reasoning-pro',
      system: '你是买方研究员。对给定问题做多步推理：先拆解子问题，逐个检索证据，再综合成结论。给出论证链（前提→证据→推论）与关键数字，标注每步来源；证据不足处明确说明。',
      query, recency, afterDate, beforeDate, domains, maxTokens: 2000, contextSize: 'high', timeoutMs: 120000,
    });
  } catch (e) { return fail(query, e); }
}

/** 深度研究报告（sonar-deep-research）：对一个主题做穷尽式多来源研究并产出结构化报告。
 * 慢（数分钟）且贵（数十次检索），一次分析最多用 1-2 次，用于「行业历程/产业链全景」级问题。 */
export async function pplxDeepResearch(query, { afterDate, beforeDate } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(query, '深度研究报告');
  if (!query || !String(query).trim()) return fail(query, '缺少研究主题（query 为空）');
  try {
    return await pplxChat({
      model: 'sonar-deep-research',
      system: '你是行业深度研究员。对给定主题做穷尽式研究，产出结构化报告：现状与规模、历史演进与拐点、产业链各环节与玩家、供需与价格证据、关键分歧与市场预期、可跟踪的验证信号。全部结论必须带来源与数字。',
      query, afterDate, beforeDate, maxTokens: 6000, timeoutMs: 420000,
    });
  } catch (e) { return fail(query, e); }
}

/** 针对特定 URL/页面内容的问答（让模型联网读取后回答）。 */
export async function pplxAskPage(url, question, { model = 'sonar' } = {}) {
  if (!runtime.PERPLEXITY_API_KEY) return demo(`${url} - ${question}`, '页面问答结果');
  if (!url || !question) return fail(`${url} - ${question}`, '缺少 url 或 question');
  try {
    return await pplxChat({
      model,
      system: '你将基于给定网页链接的内容回答问题。请优先依据该页面信息，必要时联网补充，并标注来源。',
      query: `网页：${url}\n问题：${question}`,
    });
  } catch (e) { return fail(url, e); }
}
