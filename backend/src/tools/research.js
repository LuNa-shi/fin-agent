// 外部工具库 - 研究/观点采集层（Research Sources）
// 与「结构化数据(FMP)」和「通用搜索(Tavily/Perplexity)」并列的第三类数据基础设施：
// 采集专业分析师与行业博主的「观点流」，这是 idea alpha 的真正来源。
//
// 三类来源（按可达性分级，均无 key 时优雅降级）：
//   - Seeking Alpha：RSS 可直取（按标的的分析师文章流 + 全站最新 ideas），无需 key。
//   - Substack / 行业博客：发布物 RSS 公开可取，无需 key；来源在 research-sources.json 中curate。
//   - X/Twitter：需付费 API（X_BEARER_TOKEN）；无 key 时回退 Perplexity 社交检索。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtime, DATA_DIR } from '../config.js';
import { fetchWithRetry } from '../lib/http.js';
import { pplxSearch } from './perplexity.js';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (compatible; FinAgentResearch/1.0; +https://fin-agent.local)';
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// curl 传输：部分数据源（如 StockTwits）按 TLS/JA3 指纹封锁 node undici，但放行 curl。
// 本地单用户工具，curl 在 macOS/Linux 必备，作为这些源的可靠传输层。
async function curlJSON(url, { timeoutMs = 10000 } = {}) {
  const { stdout } = await execFileP('curl', ['-sL', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', UA_BROWSER, '-H', 'Accept: application/json', url], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ---------------- 轻量 RSS/Atom 解析（无三方依赖） ----------------
function stripTags(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    // 数字实体（&#x2019; / &#8217;）
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    // 命名实体
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}
function pickLink(block) {
  // RSS: <link>url</link>；Atom: <link href="url" .../>
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return stripTags(rss[1]);
  const atom = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : '';
}
function extractTickers(text = '') {
  const set = new Set();
  // $TICKER 形式
  for (const m of text.matchAll(/\$([A-Z]{1,5})\b/g)) set.add(m[1]);
  return [...set].slice(0, 8);
}

function parseFeed(xml, { limit = 15 } = {}) {
  if (!xml) return [];
  const isAtom = /<entry[\s>]/.test(xml) && !/<item[\s>]/.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const blocks = xml.split(new RegExp(`<${tag}[\\s>]`)).slice(1).map((b) => b.slice(0, b.indexOf(`</${tag}>`) + 1 || undefined));
  return blocks.slice(0, limit).map((b) => {
    const title = pick(b, 'title');
    const summaryRaw = pick(b, 'description') || pick(b, 'summary') || pick(b, 'content:encoded') || pick(b, 'content');
    const author = pick(b, 'dc:creator') || pick(b, 'author') || pick(b, 'name');
    const date = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated');
    // Seeking Alpha 等在 <category type="symbol" ...>TICKER</category> 标注主标的
    const symbolCats = [...b.matchAll(/<category[^>]*type=["']symbol["'][^>]*>([A-Z][A-Z.-]{0,6})<\/category>/g)].map((m) => m[1]);
    const tickers = [...new Set([...symbolCats, ...extractTickers(`${title} ${summaryRaw}`)])].slice(0, 8);
    return {
      title,
      url: pickLink(b),
      author: author || '',
      publishedAt: date || '',
      summary: (summaryRaw || '').slice(0, 400),
      symbol: symbolCats[0] || tickers[0] || null,
      tickers,
    };
  }).filter((x) => x.title);
}

async function getFeed(url, { limit = 15, timeoutMs = 12000 } = {}) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, timeoutMs, retries: 1 });
  if (!res.ok) throw new Error(`feed ${res.status}: ${url}`);
  let xml = await res.text();
  // Substack 的 content:encoded 会把整篇 HTML 塞进每个 item（单 feed 可达 ~800KB）。
  // 只保留前 200KB（足够覆盖前若干条的标题/链接/摘要），避免多 feed 并发时内存膨胀。
  if (xml.length > 200000) xml = xml.slice(0, 200000);
  return parseFeed(xml, { limit });
}

// ---------------- 来源注册表（可 curate，落盘 data/research-sources.json） ----------------
const SOURCES_FILE = path.join(DATA_DIR, 'research-sources.json');
const DEFAULT_SOURCES = [
  // 半导体 / AI 硬件（均已实测可取）
  { id: 'thechipletter', name: 'The Chip Letter', type: 'blog', domain: 'semis', url: 'https://thechipletter.substack.com/feed' },
  { id: 'chipstrat', name: 'Chipstrat', type: 'blog', domain: 'semis', url: 'https://www.chipstrat.com/feed' },
  { id: 'semianalysis', name: 'SemiAnalysis', type: 'blog', domain: 'semis', url: 'https://semianalysis.com/feed' },
  { id: 'fabricatedknowledge', name: 'Fabricated Knowledge', type: 'blog', domain: 'semis', url: 'https://www.fabricatedknowledge.com/feed' },
  { id: 'morethanmoore', name: 'More Than Moore', type: 'blog', domain: 'semis', url: 'https://morethanmoore.substack.com/feed' },
  // AI / 软件
  { id: 'interconnects', name: 'Interconnects (AI)', type: 'blog', domain: 'ai', url: 'https://www.interconnects.ai/feed' },
  { id: 'thezvi', name: "Don't Worry About the Vase (AI)", type: 'blog', domain: 'ai', url: 'https://thezvi.wordpress.com/feed' },
  // 能源 / 电力（呼应数据中心电力主题）
  { id: 'doomberg', name: 'Doomberg', type: 'blog', domain: 'energy', url: 'https://doomberg.substack.com/feed' },
  { id: 'volts', name: 'Volts (清洁能源/电气化)', type: 'blog', domain: 'energy', url: 'https://www.volts.wtf/feed' },
  // 宏观 / 利率 / 流动性
  { id: 'apricitas', name: 'Apricitas Economics', type: 'blog', domain: 'macro', url: 'https://www.apricitas.io/feed' },
  { id: 'concoda', name: 'Concoda (利率/流动性)', type: 'blog', domain: 'macro', url: 'https://concoda.substack.com/feed' },
  // 金融 / 财报 / 软件（0.2 扩容，均已实测可取）
  { id: 'netinterest', name: 'Net Interest (金融业)', type: 'blog', domain: 'financials', url: 'https://www.netinterest.co/feed' },
  { id: 'thetranscript', name: 'The Transcript (财报会精粹)', type: 'blog', domain: 'general', url: 'https://thetranscript.substack.com/feed' },
  { id: 'appeconomy', name: 'App Economy Insights (软件/平台)', type: 'blog', domain: 'software', url: 'https://www.appeconomyinsights.com/feed' },
  { id: 'constructionphysics', name: 'Construction Physics (工业/制造)', type: 'blog', domain: 'industrials', url: 'https://constructionphysics.substack.com/feed' },
];

function loadSources() {
  try {
    const d = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
    if (Array.isArray(d?.sources) && d.sources.length) {
      // 迁移：新增的内置来源合并进已落盘的注册表（不覆盖用户自定义/已删除以外的既有项）
      const have = new Set(d.sources.map((s) => s.id));
      const missing = DEFAULT_SOURCES.filter((s) => !have.has(s.id));
      if (missing.length) { d.sources.push(...missing); saveSources(d.sources); }
      return d.sources;
    }
  } catch { /* seed */ }
  saveSources(DEFAULT_SOURCES);
  return DEFAULT_SOURCES;
}
function saveSources(sources) {
  fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
  fs.writeFileSync(SOURCES_FILE, JSON.stringify({ sources }, null, 2));
}
// 按 domain 分层轮询挑选来源：保证跨行业覆盖（避免只取注册表靠前的半导体/AI 源，
// 导致宏观/金融/软件/能源/工业等垂直博客长期不被采样 → idea 选题被单一行业垂直喂养）。
// 每个 domain 内先洗牌，让同一 domain 每次轮换到不同博客，进一步扩大长期覆盖面。
function pickStratified(sources, n) {
  const byDomain = new Map();
  for (const s of sources) {
    const d = s.domain || 'general';
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(s);
  }
  for (const arr of byDomain.values()) arr.sort(() => Math.random() - 0.5);
  const domains = [...byDomain.keys()].sort(() => Math.random() - 0.5);
  const picked = [];
  let guard = 0;
  while (picked.length < n && guard++ < n * domains.length + domains.length) {
    let progressed = false;
    for (const d of domains) {
      const arr = byDomain.get(d);
      if (arr.length) { picked.push(arr.shift()); progressed = true; }
      if (picked.length >= n) break;
    }
    if (!progressed) break;
  }
  return picked;
}

export const ResearchSources = {
  list: () => loadSources(),
  upsert(s) {
    const list = loadSources();
    if (!s.id) s.id = 'src_' + Math.random().toString(36).slice(2, 8);
    const i = list.findIndex((x) => x.id === s.id);
    if (i >= 0) list[i] = { ...list[i], ...s }; else list.push({ type: 'blog', domain: 'general', ...s });
    saveSources(list); return list;
  },
  remove(id) { const list = loadSources().filter((x) => x.id !== id); saveSources(list); return list; },
};

// ---------------- Seeking Alpha ----------------
/** 某标的的分析师文章流（观点/多空论点）。 */
export async function saSymbol(symbol, { limit = 12 } = {}) {
  const s = String(symbol || '').toUpperCase().trim();
  if (!s) return { symbol: s, items: [], error: 'symbol required' };
  try {
    const items = await getFeed(`https://seekingalpha.com/api/sa/combined/${s}.xml`, { limit });
    return { symbol: s, items: items.map((it) => ({ ...it, source: 'SeekingAlpha', sourceType: 'analyst', tickers: it.tickers.length ? it.tickers : [s] })) };
  } catch (e) { return { symbol: s, items: [], error: String(e.message || e) }; }
}

/** Seeking Alpha 全站最新 ideas/文章流（用于发散选题）。 */
export async function saLatest({ limit = 20 } = {}) {
  try {
    const items = await getFeed('https://seekingalpha.com/feed.xml', { limit });
    return { items: items.map((it) => ({ ...it, source: 'SeekingAlpha', sourceType: 'analyst' })) };
  } catch (e) { return { items: [], error: String(e.message || e) }; }
}

// 多个 SA 公开 feed（实测可取），合并去重后可凑到 ~100 条近期 idea（每条带主标的）。
const SA_FEEDS = [
  'https://seekingalpha.com/feed.xml',
  'https://seekingalpha.com/tag/long-ideas.xml',
  'https://seekingalpha.com/tag/growth.xml',
  'https://seekingalpha.com/tag/value.xml',
  'https://seekingalpha.com/tag/ipo-analysis.xml',
  'https://seekingalpha.com/market_currents.xml',
  // 0.2 扩容（实测可取）：编辑精选 + 股息类 idea，扩大海选 universe
  'https://seekingalpha.com/tag/editors-picks.xml',
  'https://seekingalpha.com/tag/dividend-ideas.xml',
];

const ETF_INDEX = new Set(['SPX', 'SPY', 'DXY', 'GLD', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'EWG', 'EFA', 'TLT', 'HYG', 'SLV', 'USO', 'UUP', 'VIX', 'NDX', 'RUT', 'BUZZ', 'SPXC']);
// 仅保留可分析的美股普通股/主流 ADR：排除指数/ETF、5 字母 OTC 粉单(常以 F/Y 结尾的外股)
function validUSStock(sym) {
  if (!sym || !/^[A-Z]{1,5}$/.test(sym)) return false;
  if (ETF_INDEX.has(sym)) return false;
  if (sym.length === 5 && /[FY]$/.test(sym)) return false; // OTC 外股粉单
  return true;
}

/** 汇集最近 N 条 SA idea（跨多 feed 去重，按发布时间倒序，仅保留可分析的美股代码者）。 */
export async function saAssembleIdeas({ target = 100 } = {}) {
  const results = await Promise.allSettled(SA_FEEDS.map((u) => getFeed(u, { limit: 30, timeoutMs: 15000 })));
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set();
  const ideas = [];
  for (const it of all) {
    const sym = it.symbol;
    if (!validUSStock(sym) || seen.has(sym)) continue;
    seen.add(sym);
    ideas.push({ ticker: sym, title: it.title, author: it.author, publishedAt: it.publishedAt, url: it.url, source: 'SeekingAlpha' });
  }
  ideas.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  return { count: ideas.length, feeds: SA_FEEDS.length, ideas: ideas.slice(0, target) };
}

// ---------------- Substack / 行业博客 ----------------
/** 抓取单个发布物 RSS（传 source id 或直接传 url）。 */
export async function substackFeed(idOrUrl, { limit = 12 } = {}) {
  const src = loadSources().find((s) => s.id === idOrUrl);
  const url = src?.url || (/^https?:\/\//.test(idOrUrl) ? idOrUrl : '');
  if (!url) return { items: [], error: `unknown source: ${idOrUrl}` };
  try {
    const items = await getFeed(url, { limit });
    return { source: src?.name || url, domain: src?.domain, items: items.map((it) => ({ ...it, source: src?.name || 'Substack', sourceType: 'blog', domain: src?.domain })) };
  } catch (e) { return { items: [], error: String(e.message || e) }; }
}

// ---------------- StockTwits（第三方 fintwit 聚合，免费无 key，按标的） ----------------
/** 某标的的社交情绪（多空票数 + 近期热门消息）。X 维度的主力来源。 */
export async function socialSentiment(symbol, { limit = 20 } = {}) {
  const s = String(symbol || '').toUpperCase().trim();
  if (!s) return { symbol: s, messages: [], error: 'symbol required' };
  try {
    const data = await curlJSON(`https://api.stocktwits.com/api/2/streams/symbol/${s}.json`, { timeoutMs: 10000 });
    const msgs = (data.messages || []).slice(0, limit).map((m) => ({ body: (m.body || '').slice(0, 200), sentiment: m.entities?.sentiment?.basic || null, user: m.user?.username, likes: m.likes?.total || 0, createdAt: m.created_at }));
    const bull = msgs.filter((m) => m.sentiment === 'Bullish').length;
    const bear = msgs.filter((m) => m.sentiment === 'Bearish').length;
    return {
      symbol: s, source: 'StockTwits', count: msgs.length,
      sentiment: { bullish: bull, bearish: bear, ratio: (bull + bear) ? +(bull / (bull + bear)).toFixed(2) : null, label: bull > bear ? '偏多' : (bear > bull ? '偏空' : '分歧') },
      top: msgs.filter((m) => m.sentiment).sort((a, b) => b.likes - a.likes).slice(0, 6),
    };
  } catch (e) { return { symbol: s, messages: [], error: String(e.message || e) }; }
}

// ---------------- X / Twitter（X API 可选；无 key 回退 Perplexity 社交检索） ----------------
export async function xSearch(query, { limit = 12 } = {}) {
  const token = runtime.X_BEARER_TOKEN;
  if (token) {
    try {
      const url = `https://api.twitter.com/2/tweets/search/recent?max_results=${Math.min(Math.max(limit, 10), 100)}&tweet.fields=created_at,public_metrics,author_id&query=${encodeURIComponent(query + ' -is:retweet lang:en')}`;
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 12000, retries: 1 });
      if (!res.ok) throw new Error(`X ${res.status}`);
      const data = await res.json();
      const items = (data.data || []).map((t) => ({ source: 'X', sourceType: 'social', title: (t.text || '').slice(0, 160), summary: t.text || '', url: `https://x.com/i/web/status/${t.id}`, publishedAt: t.created_at, metrics: t.public_metrics, tickers: extractTickers(t.text) }));
      return { items, via: 'x-api' };
    } catch (e) { return { items: [], error: String(e.message || e), via: 'x-api' }; }
  }
  // 回退：用 Perplexity 检索社交/讨论热点（非实时 tweet，但能近似 fintwit 共识）
  const r = await pplxSearch(`近期 X/Twitter 与投资社区关于「${query}」的主要观点、多空论点与讨论热点`, { recency: 'week' }).catch((e) => ({ answer: '', error: String(e) }));
  return { items: r.answer ? [{ source: 'X(via Perplexity)', sourceType: 'social', title: `社交讨论摘要：${query}`, summary: r.answer.slice(0, 600), url: '', citations: r.citations || [] }] : [], via: 'perplexity-fallback', error: r.error };
}

// ---------------- 聚合：研究摘要（idea 生成与分析研究步共用） ----------------
/**
 * 汇总多来源观点流，去重、限量，返回带来源归属的 ResearchItem[]。
 * @param {{tickers?:string[], theme?:string, domains?:string[], perSource?:number, includeX?:boolean}} opts
 */
export async function researchDigest({ tickers = [], theme = '', domains = [], perSource = 4, includeX = false, sourceLimit = 8 } = {}) {
  const pool = loadSources().filter((s) => !domains.length || domains.includes(s.domain));
  // 跨 domain 分层轮询，保证覆盖面（而非固定取注册表靠前的同类源）
  const sources = pickStratified(pool, sourceLimit);
  const jobs = [];
  // 1) 标的级 SA 分析师观点
  for (const t of tickers.slice(0, 4)) jobs.push(saSymbol(t, { limit: perSource }).then((r) => r.items || []));
  // 2) 无标的或补充：SA 全站最新 ideas
  if (!tickers.length) jobs.push(saLatest({ limit: 12 }).then((r) => r.items || []));
  // 3) 行业博客 / Substack（已跨 domain 分层）
  for (const s of sources) jobs.push(substackFeed(s.id, { limit: perSource }).then((r) => r.items || []));
  // 4)（可选）社交情绪：优先 StockTwits（免费聚合，按标的），无标的时回退 X/Perplexity 主题检索
  const includeSocial = includeX; // 兼容旧参数名
  if (includeSocial && tickers.length) {
    for (const t of tickers.slice(0, 4)) jobs.push(socialSentiment(t).then((r) => (
      r.sentiment && r.count ? [{ source: 'StockTwits', sourceType: 'social', title: `${t} 社交情绪：${r.sentiment.label}（多 ${r.sentiment.bullish}/空 ${r.sentiment.bearish}）`, summary: (r.top || []).map((m) => `${m.sentiment === 'Bullish' ? '多' : '空'}:${m.body.slice(0, 50)}`).join(' ｜ '), tickers: [t] }] : []
    )));
  } else if (includeSocial && theme) {
    jobs.push(xSearch(theme, { limit: 6 }).then((r) => r.items || []));
  }

  const settled = await Promise.allSettled(jobs);
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  // 去重（按标题归一）
  const seen = new Set();
  const items = [];
  for (const it of all) {
    const key = (it.title || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '').slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key); items.push(it);
  }
  // 主题相关性粗排：标题/摘要命中主题词或标的的优先
  const kw = [theme, ...tickers].filter(Boolean).map((s) => String(s).toLowerCase());
  const score = (it) => {
    const hay = `${it.title} ${it.summary} ${(it.tickers || []).join(' ')}`.toLowerCase();
    return kw.reduce((a, k) => a + (hay.includes(k) ? 1 : 0), 0);
  };
  items.sort((a, b) => score(b) - score(a));
  return { count: items.length, items: items.slice(0, 28), sourcesUsed: sources.map((s) => s.name), domainsUsed: [...new Set(sources.map((s) => s.domain))] };
}

export const RESEARCH_TOOLS = [
  { name: 'sa_symbol', provider: 'research', desc: 'Seeking Alpha 某标的的分析师文章/观点流' },
  { name: 'sa_latest', provider: 'research', desc: 'Seeking Alpha 全站最新 ideas/文章流' },
  { name: 'substack_feed', provider: 'research', desc: '行业博客/Substack 发布物 RSS（按来源 id 或 url）' },
  { name: 'social_sentiment', provider: 'research', desc: 'StockTwits 标的社交情绪（多空票数+热门消息，免费无 key）' },
  { name: 'x_search', provider: 'research', desc: 'X/Twitter 社交观点检索（需 X API key，否则回退 Perplexity）' },
  { name: 'research_digest', provider: 'research', desc: '多来源观点流聚合摘要（SA+博客+社交，去重排序）' },
];
