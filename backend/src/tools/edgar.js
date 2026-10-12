// SEC/EDGAR 一手材料工具（免费、无 key；SEC 要求 User-Agent 带联系方式）。
// 一手材料层级：SEC 备案 > 财报电话会 > 结构化财务 > 二手转述 > 观点。
// 此前只有 transcript 一种一手材料；这里补上 10-K/10-Q 章节（Risk Factors/MD&A）、8-K 事件与全文检索。
import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from '../config.js';
import { fetchWithRetry } from '../lib/http.js';

const UA = 'FinAgent research (contact: foxzeq@gmail.com)';
const CIK_CACHE = path.join(MEMORY_DIR, 'edgar-ciks.json');
const CIK_TTL = 7 * 86400000;

async function edgarGet(url, { asText = false, timeoutMs = 20000 } = {}) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, timeoutMs, retries: 1 });
  if (!res.ok) throw new Error(`EDGAR ${res.status}: ${url}`);
  return asText ? res.text() : res.json();
}

// ---------- ticker → CIK（官方映射表 ~1MB，磁盘缓存 7 天） ----------
async function cikMap() {
  try {
    const c = JSON.parse(fs.readFileSync(CIK_CACHE, 'utf8'));
    if (Date.now() - c.ts < CIK_TTL && c.map) return c.map;
  } catch { /* refetch */ }
  const raw = await edgarGet('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const v of Object.values(raw)) map[String(v.ticker).toUpperCase()] = { cik: v.cik_str, name: v.title };
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(CIK_CACHE, JSON.stringify({ ts: Date.now(), map }));
  return map;
}
export async function tickerToCik(symbol) {
  const m = await cikMap();
  return m[String(symbol).toUpperCase()] || null;
}

// ---------- 备案清单（submissions API） ----------
export async function edgarFilings(symbol, { forms = '', limit = 12 } = {}) {
  try {
    const hit = await tickerToCik(symbol);
    if (!hit) return { symbol, filings: [], error: `未找到 ${symbol} 的 CIK` };
    const cik10 = String(hit.cik).padStart(10, '0');
    const data = await edgarGet(`https://data.sec.gov/submissions/CIK${cik10}.json`);
    const r = data.filings?.recent || {};
    const wanted = forms ? String(forms).split(/[,，\s]+/).filter(Boolean).map((f) => f.toUpperCase()) : null;
    const out = [];
    for (let i = 0; i < (r.form || []).length && out.length < limit; i++) {
      const form = r.form[i];
      if (wanted && !wanted.some((w) => form.toUpperCase().startsWith(w))) continue;
      const adsh = r.accessionNumber[i].replace(/-/g, '');
      out.push({
        form, filedAt: r.filingDate[i], report: r.reportDate?.[i] || null,
        primaryDoc: r.primaryDocument[i], items: r.items?.[i] || null, // 8-K 的 items 编号（事件类型）
        url: `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${adsh}/${r.primaryDocument[i]}`,
      });
    }
    return { symbol, cik: hit.cik, name: hit.name, filings: out };
  } catch (e) { return { symbol, filings: [], error: String(e.message || e) }; }
}

// ---------- 全文检索（efts.sec.gov） ----------
export async function edgarFullText(query, { forms = '', limit = 10 } = {}) {
  try {
    const params = new URLSearchParams({ q: `"${String(query).replace(/"/g, '')}"` });
    if (forms) params.set('forms', forms);
    const data = await edgarGet(`https://efts.sec.gov/LATEST/search-index?${params}`);
    const hits = (data.hits?.hits || []).slice(0, limit).map((h) => {
      const [adsh, file] = String(h._id).split(':');
      const cik = (h._source?.ciks || [])[0]?.replace(/^0+/, '');
      return {
        company: (h._source?.display_names || [])[0] || '',
        form: h._source?.file_type || h._source?.root_forms?.[0] || '',
        filedAt: h._source?.file_date || '',
        url: cik ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}` : null,
      };
    });
    return { query, total: data.hits?.total?.value ?? hits.length, hits };
  } catch (e) { return { query, hits: [], error: String(e.message || e) }; }
}

// ---------- 文档抓取 + 章节抽取（10-K/10-Q 的 Risk Factors / MD&A） ----------
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;|&#x[0-9a-f]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
// 章节定位启发式：候选 = 所有起始标记；排除交叉引用语境（前文含 see/refer/in Item 等）；
// 在剩余候选中取「节体最长」者——目录条目和引用后面紧跟别的内容，真正的章节正文一定最长。
const SECTIONS = {
  risk: { start: /item\s*1a[.\s:：]*\s*risk\s*factors/gi, end: /item\s*1b[.\s:：]|item\s*2[.\s:：]/gi, label: 'Item 1A Risk Factors' },
  mdna: { start: /item\s*[27][.\s:：]*\s*management'?s?\s*discussion/gi, end: /item\s*[38]a?[.\s:：]*\s*(quantitative|financial\s*statements)/gi, label: 'MD&A' },
  // 10-K 的 Item 3 / 10-Q 的 Part II Item 1（反垄断/诉讼是平台型公司的核心变量）
  legal: { start: /item\s*[13][.\s:：]*\s*legal\s*proceedings/gi, end: /item\s*(1a|4)[.\s:：]/gi, label: 'Legal Proceedings' },
};
const XREF_BEFORE = /(see|refer\s*to|described\s+in|under|within|in)\s*(part\s*[ivx]+[,.\s]*)?$/i;
const TOC_AFTER = /^\s*\.{0,5}\s*\d{1,3}\s/; // 标记后紧跟页码 → 目录条目
export async function edgarSection(url, { section = 'risk', maxChars = 6000 } = {}) {
  try {
    const html = await edgarGet(url, { asText: true });
    const text = htmlToText(html);
    const rule = SECTIONS[section] || SECTIONS.risk;
    const candidates = [...text.matchAll(rule.start)]
      .filter((m) => !XREF_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index)))
      .filter((m) => !TOC_AFTER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 12)));
    const all = candidates.length ? candidates : [...text.matchAll(rule.start)];
    if (!all.length) return { url, section, excerpt: text.slice(0, maxChars), note: '未定位到章节标记，返回文档开头' };
    let best = null;
    for (const m of all) {
      const endRe = new RegExp(rule.end.source, rule.end.flags);
      endRe.lastIndex = m.index + 100;
      const endM = endRe.exec(text);
      const len = (endM ? endM.index : text.length) - m.index;
      if (!best || len > best.len) best = { s: m.index, e: endM ? endM.index : m.index + maxChars, len };
    }
    return { url, section: rule.label, excerpt: text.slice(best.s, Math.min(best.e, best.s + maxChars)) };
  } catch (e) { return { url, section, excerpt: '', error: String(e.message || e) }; }
}

// ---------- 组合便捷：某标的最新一手材料摘要（8-K 事件清单 + 最新 10-K/10-Q 风险章节节选） ----------
export async function edgarBrief(symbol, { maxChars = 3000 } = {}) {
  try {
    const [events, reports] = await Promise.all([
      edgarFilings(symbol, { forms: '8-K', limit: 5 }),
      edgarFilings(symbol, { forms: '10-K,10-Q', limit: 1 }),
    ]);
    const evLines = (events.filings || []).map((f) => `${f.filedAt} 8-K${f.items ? `(items ${f.items})` : ''}`).join('；');
    let riskExcerpt = '';
    const latest = (reports.filings || [])[0];
    if (latest) {
      const sec = await edgarSection(latest.url, { section: 'risk', maxChars });
      riskExcerpt = sec.excerpt ? `【${latest.form} ${latest.filedAt} ${sec.section}节选】${sec.excerpt.slice(0, maxChars)}` : '';
    }
    return { symbol, events: evLines, latestReport: latest ? `${latest.form} ${latest.filedAt}` : null, riskExcerpt };
  } catch (e) { return { symbol, events: '', riskExcerpt: '', error: String(e.message || e) }; }
}

export const EDGAR_TOOLS = [
  { name: 'edgar_filings', provider: 'edgar', desc: 'SEC 备案清单（10-K/10-Q/8-K，含文档链接与 8-K 事件项）' },
  { name: 'edgar_fulltext', provider: 'edgar', desc: 'EDGAR 全文检索（在所有备案文件中搜关键词）' },
  { name: 'edgar_section', provider: 'edgar', desc: '抓取备案文档并抽取章节（Risk Factors / MD&A）' },
];
