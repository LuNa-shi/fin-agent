// 外部工具库 - Tavily 工具（网页搜索 + 网页正文抓取），含演示回退
// 文档：https://docs.tavily.com
import { runtime } from '../config.js';
import { fetchJSON } from '../lib/http.js';

const SEARCH = 'https://api.tavily.com/search';
const EXTRACT = 'https://api.tavily.com/extract';

/** 网页搜索：返回 AI 摘要 answer + 结果列表（标题/url/正文片段）。 */
export async function tavilySearch(query, { maxResults = 5, depth = 'basic', includeAnswer = true, topic = 'general', days } = {}) {
  if (!runtime.TAVILY_API_KEY) {
    return { query, answer: `【演示】未配置 Tavily key，无法搜索「${query}」。`, results: [], _demo: true };
  }
  try {
    const body = {
      api_key: runtime.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      search_depth: depth,        // basic | advanced
      include_answer: includeAnswer,
      topic,                      // general | news
    };
    if (days) body.days = days;
    const data = await fetchJSON(SEARCH, {
      method: 'POST', timeoutMs: 30000,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return {
      query,
      answer: data.answer || '',
      results: (data.results || []).map((r) => ({
        title: r.title, url: r.url, content: r.content, score: r.score, published: r.published_date,
      })),
      responseTime: data.response_time,
      _demo: false,
    };
  } catch (e) {
    return { query, answer: '', results: [], _demo: false, error: String(e.message || e) };
  }
}

/** 网页正文抓取：传入若干 url，返回每页清洗后的正文。 */
export async function tavilyExtract(urls, { extractDepth = 'basic' } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return { results: [], failed: [] };
  if (!runtime.TAVILY_API_KEY) {
    return { results: list.map((u) => ({ url: u, content: `【演示】未配置 Tavily key，无法抓取 ${u}`, _demo: true })), failed: [] };
  }
  try {
    const data = await fetchJSON(EXTRACT, {
      method: 'POST', timeoutMs: 30000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: runtime.TAVILY_API_KEY, urls: list, extract_depth: extractDepth }),
    });
    return {
      results: (data.results || []).map((r) => ({
        url: r.url,
        content: (r.raw_content || '').slice(0, 12000), // 截断防止过大
        length: (r.raw_content || '').length,
      })),
      failed: (data.failed_results || []).map((f) => f.url || f),
      _demo: false,
    };
  } catch (e) {
    return { results: [], failed: list, error: String(e.message || e) };
  }
}
