import { getMarketMovers, getNews, getSectorPerformance } from '../../../tools/fmp.js';
import { researchDigest, saLatest, socialSentiment, xSearch } from '../../../tools/research.js';
import {
  captureSourceCall,
  failedSourceNodeProvenance,
  redactSourceError,
} from './sourceProvenance.js';

const clean = (s = '') => String(s || '').replace(/\s+/g, ' ').trim();
const tickerList = (xs = []) => [...new Set(xs.map((x) => String(x || '').toUpperCase()).filter((x) => /^[A-Z][A-Z.-]{0,5}$/.test(x)))].slice(0, 5);

function withProvenance(result, provenance, enabled) {
  return enabled ? { ...result, provenance } : result;
}

function candidate({ title, theme, tickers = [], catalyst = '', edge = '', sourceAgent, evidence = [], heat = 60, rationale = '' }) {
  const sentence = clean(title || rationale);
  return {
    title: sentence,
    sentence,
    theme: theme || 'cross-asset',
    heat,
    rationale: rationale || sentence,
    tickers: tickerList(tickers),
    catalyst,
    edge,
    sourceAgents: [sourceAgent],
    evidence: evidence.filter(Boolean).slice(0, 4),
    timeHorizon: 'next 2-4 quarters',
    status: 'new',
  };
}

export async function collectNewsIdeas({
  target = 8,
  captureProvenance = false,
  now = () => new Date().toISOString(),
  sourceFunctions = {},
} = {}) {
  const sectorSource = sourceFunctions.getSectorPerformance || getSectorPerformance;
  const moversSource = sourceFunctions.getMarketMovers || getMarketMovers;
  const newsSource = sourceFunctions.getNews || getNews;
  const [sectorCall, moversCall, newsCall] = await Promise.all([
    captureSourceCall({
      callId: 'news-source.sector-performance',
      source: 'fmp-sector-performance',
      provider: 'fmp',
      args: {},
      execute: () => sectorSource(),
      fallback: () => ({ sectors: [] }),
      normalize: (value) => value?.sectors || [],
      now,
    }),
    captureSourceCall({
      callId: 'news-source.market-movers',
      source: 'fmp-market-movers',
      provider: 'fmp',
      args: { type: 'gainers' },
      execute: () => moversSource('gainers'),
      fallback: () => ({ movers: [] }),
      normalize: (value) => value?.movers || [],
      now,
    }),
    captureSourceCall({
      callId: 'news-source.news',
      source: 'fmp-news',
      provider: 'fmp',
      args: { tickers: [], limit: 20 },
      execute: () => newsSource([], 20),
      fallback: () => [],
      normalize: (value) => value || [],
      now,
    }),
  ]);
  const sector = sectorCall.value;
  const movers = moversCall.value;
  const news = newsCall.value;
  const out = [];
  for (const n of (news || []).slice(0, target)) {
    const tks = tickerList([n.symbol]);
    out.push(candidate({
      title: `${tks[0] || 'A listed company'} may offer a news-driven opportunity if ${clean(n.title).slice(0, 120)} changes near-term expectations.`,
      theme: 'news catalyst',
      tickers: tks,
      catalyst: n.title,
      edge: 'Fresh news may not be fully reflected in forward estimates yet.',
      sourceAgent: 'news-idea-agent',
      heat: 65,
      evidence: [{ source: n.site || 'FMP news', title: n.title, url: n.url, confidence: 0.55 }],
    }));
  }
  for (const m of (movers.movers || []).slice(0, 4)) {
    out.push(candidate({
      title: `${m.symbol} deserves review after unusual market momentum because price action may be signaling a catalyst or positioning shift.`,
      theme: 'market movers',
      tickers: [m.symbol],
      catalyst: `${m.changePct || ''} price move`,
      edge: 'Unusual movers can surface early revisions before the thesis is fully written up.',
      sourceAgent: 'news-idea-agent',
      heat: 60,
      evidence: [{ source: 'FMP market movers', title: m.name || m.symbol, confidence: 0.5 }],
    }));
  }
  const topSector = (sector.sectors || [])[0];
  if (topSector?.sector) {
    out.push(candidate({
      title: `${topSector.sector} strength may point to a sector-rotation opportunity if earnings revisions follow price leadership.`,
      theme: topSector.sector,
      catalyst: 'sector relative strength',
      edge: 'Sector rotation often creates second-order beneficiaries before consensus estimates update.',
      sourceAgent: 'news-idea-agent',
      heat: 58,
      evidence: [{ source: 'FMP sector performance', title: topSector.sector, confidence: 0.5 }],
    }));
  }
  return withProvenance(
    { agent: 'news-idea-agent', ideas: out.slice(0, target), count: out.length },
    [sectorCall.provenance, moversCall.provenance, newsCall.provenance],
    captureProvenance,
  );
}

export async function collectForumIdeas({
  tickers = [],
  target = 8,
  captureProvenance = false,
  now = () => new Date().toISOString(),
  sourceFunctions = {},
} = {}) {
  const moversSource = sourceFunctions.getMarketMovers || getMarketMovers;
  const sentimentSource = sourceFunctions.socialSentiment || socialSentiment;
  const xSource = sourceFunctions.xSearch || xSearch;
  const latestSource = sourceFunctions.saLatest || saLatest;
  const provenance = [];
  let core = tickerList(tickers).slice(0, 4);
  if (!core.length) {
    const [activesCall, gainersCall] = await Promise.all([
      captureSourceCall({
        callId: 'forum-source.market-movers.actives',
        source: 'fmp-market-movers',
        provider: 'fmp',
        args: { type: 'actives' },
        execute: () => moversSource('actives'),
        fallback: () => ({ movers: [] }),
        normalize: (value) => value?.movers || [],
        now,
      }),
      captureSourceCall({
        callId: 'forum-source.market-movers.gainers',
        source: 'fmp-market-movers',
        provider: 'fmp',
        args: { type: 'gainers' },
        execute: () => moversSource('gainers'),
        fallback: () => ({ movers: [] }),
        normalize: (value) => value?.movers || [],
        now,
      }),
    ]);
    provenance.push(activesCall.provenance, gainersCall.provenance);
    const actives = activesCall.value;
    const gainers = gainersCall.value;
    core = tickerList([...(actives.movers || []), ...(gainers.movers || [])].map((m) => m.symbol)).slice(0, 4);
  }
  const socialCalls = await Promise.all(core.map((symbol) => captureSourceCall({
    callId: `forum-source.social-sentiment.${symbol}`,
    source: 'social-sentiment',
    provider: 'social',
    args: { symbol, limit: 8 },
    execute: () => sentimentSource(symbol, { limit: 8 }),
    fallback: () => null,
    normalize: (value) => value,
    now,
  })));
  provenance.push(...socialCalls.map((call) => call.provenance));
  const socials = socialCalls.map((call) => call.value);
  const xQuery = `${core.join(' OR ') || 'stocks'} earnings catalyst retail sentiment`;
  const xCall = await captureSourceCall({
    callId: 'forum-source.x-search',
    source: 'x-search',
    provider: 'x',
    args: { query: xQuery, limit: 8 },
    execute: () => xSource(xQuery, { limit: 8 }),
    fallback: () => ({ items: [] }),
    normalize: (value) => value?.items || value?.results || [],
    now,
  });
  provenance.push(xCall.provenance);
  const x = xCall.value;
  const out = [];
  for (const s of socials.filter(Boolean)) {
    const bullish = s?.sentiment?.bullish ?? s?.bullish;
    const bearish = s?.sentiment?.bearish ?? s?.bearish;
    out.push(candidate({
      title: `${s.symbol} may be worth checking because forum sentiment is shifting and could expose a disagreement with fundamentals.`,
      theme: 'forum sentiment',
      tickers: [s.symbol],
      catalyst: 'social sentiment shift',
      edge: `Bullish ${bullish ?? 'n/a'} vs bearish ${bearish ?? 'n/a'} discussion can reveal crowded or contrarian setups.`,
      sourceAgent: 'forum-idea-agent',
      heat: 52,
      evidence: [{ source: 'StockTwits/social', title: s.symbol, confidence: 0.35 }],
    }));
  }
  for (const item of (x.items || x.results || []).slice(0, target - out.length)) {
    const tks = tickerList(item.tickers || []);
    out.push(candidate({
      title: `${tks[0] || 'A discussed stock'} may offer a forum-led setup if recent social debate around ${clean(item.title || item.text).slice(0, 90)} proves fundamental.`,
      theme: 'forum debate',
      tickers: tks,
      catalyst: item.title || 'social discussion',
      edge: 'Forum attention is useful only if it maps to a measurable upcoming fundamental catalyst.',
      sourceAgent: 'forum-idea-agent',
      heat: 48,
      evidence: [{ source: item.source || 'X/social fallback', title: item.title || item.text, url: item.url, confidence: 0.3 }],
    }));
  }
  if (!out.length) {
    const latestCall = await captureSourceCall({
      callId: 'forum-source.seeking-alpha-latest',
      source: 'seeking-alpha-latest',
      provider: 'seeking-alpha',
      args: { limit: target },
      execute: () => latestSource({ limit: target }),
      fallback: () => ({ items: [] }),
      normalize: (value) => value?.items || value?.ideas || [],
      now,
    });
    provenance.push(latestCall.provenance);
    const latest = latestCall.value;
    for (const item of (latest.items || latest.ideas || []).slice(0, target)) {
      const tks = tickerList(item.tickers || [item.symbol]);
      out.push(candidate({
        title: `${tks[0] || 'A socially discussed stock'} may be worth checking because investor debate around "${clean(item.title).slice(0, 90)}" could reveal a near-term expectation gap.`,
        theme: 'forum fallback',
        tickers: tks,
        catalyst: item.title,
        edge: 'Forum/social agent had no direct ticker seed, so this fallback uses recent public debate as a watchlist seed.',
        sourceAgent: 'forum-idea-agent',
        heat: 44,
        evidence: [{ source: item.source || 'SeekingAlpha/latest', title: item.title, url: item.url, confidence: 0.3 }],
      }));
    }
  }
  return withProvenance(
    { agent: 'forum-idea-agent', ideas: out.slice(0, target), count: out.length },
    provenance,
    captureProvenance,
  );
}

export async function collectPortfolioIdeas({
  portfolio = [],
  target = 8,
  captureProvenance = false,
  now = () => new Date().toISOString(),
} = {}) {
  const out = [];
  for (const p of portfolio.slice(0, target)) {
    out.push(candidate({
      title: `${p.ticker} thesis can be extended into suppliers, peers, or hedges if the original ${p.theme || 'portfolio'} driver remains valid.`,
      theme: p.theme || 'portfolio extension',
      tickers: [p.ticker],
      catalyst: 'portfolio thesis extension',
      edge: 'The best follow-up idea may be a cleaner beneficiary or hedge of an existing thesis.',
      sourceAgent: 'portfolio-idea-agent',
      heat: 62,
      evidence: [{ source: 'portfolio', title: p.reason || p.theme || p.ticker, confidence: 0.65 }],
    }));
  }
  const result = {
    agent: 'portfolio-idea-agent',
    ideas: out.slice(0, target),
    count: out.length,
  };
  if (!captureProvenance) return result;
  const portfolioCall = await captureSourceCall({
    callId: 'portfolio-source.captured-positions',
    source: 'captured-portfolio',
    provider: 'internal',
    args: { target },
    execute: async () => portfolio,
    fallback: () => [],
    normalize: () => result.ideas,
    now,
  });
  return withProvenance(result, [portfolioCall.provenance], true);
}

export async function collectResearchIdeas({
  target = 10,
  captureProvenance = false,
  now = () => new Date().toISOString(),
  sourceFunctions = {},
} = {}) {
  const digestSource = sourceFunctions.researchDigest || researchDigest;
  const latestSource = sourceFunctions.saLatest || saLatest;
  const [digestCall, latestCall] = await Promise.all([
    captureSourceCall({
      callId: 'research-source.research-digest',
      source: 'research-digest',
      provider: 'research',
      args: { perSource: 4, sourceLimit: 8 },
      execute: () => digestSource({ perSource: 4, sourceLimit: 8 }),
      fallback: () => ({ items: [] }),
      normalize: (value) => value?.items || [],
      now,
    }),
    captureSourceCall({
      callId: 'research-source.seeking-alpha-latest',
      source: 'seeking-alpha-latest',
      provider: 'seeking-alpha',
      args: { limit: 16 },
      execute: () => latestSource({ limit: 16 }),
      fallback: () => ({ items: [], ideas: [] }),
      normalize: (value) => value?.items || value?.ideas || [],
      now,
    }),
  ]);
  const digest = digestCall.value;
  const latest = latestCall.value;
  const items = [...(digest.items || []), ...(latest.items || latest.ideas || [])];
  const out = items.slice(0, target).map((it) => candidate({
    title: `${tickerList(it.tickers || [it.ticker])[0] || 'A researched stock'} may be an investable opportunity if the recent expert thesis "${clean(it.title).slice(0, 90)}" has non-consensus evidence.`,
    theme: it.theme || it.source || 'research flow',
    tickers: tickerList(it.tickers || [it.ticker]),
    catalyst: it.title,
    edge: clean(it.summary || 'Expert writeup may contain a variant perception that has not reached consensus estimates.').slice(0, 180),
    sourceAgent: 'research-idea-agent',
    heat: 64,
    evidence: [{ source: it.source || 'research digest', title: it.title, url: it.url, confidence: 0.55 }],
  }));
  return withProvenance(
    { agent: 'research-idea-agent', ideas: out.slice(0, target), count: out.length },
    [digestCall.provenance, latestCall.provenance],
    captureProvenance,
  );
}

export async function runSourceDiscoveryNodes({
  tickers = [],
  portfolio = [],
  targetPerNode = 8,
  onProgress,
  captureProvenance = false,
  now = () => new Date().toISOString(),
  sourceFunctions = {},
} = {}) {
  const sourceIds = [
    'news-idea-agent',
    'forum-idea-agent',
    'portfolio-idea-agent',
    'research-idea-agent',
  ];
  const nodes = [
    collectNewsIdeas({
      target: targetPerNode,
      captureProvenance,
      now,
      sourceFunctions,
    }),
    collectForumIdeas({
      tickers,
      target: targetPerNode,
      captureProvenance,
      now,
      sourceFunctions,
    }),
    collectPortfolioIdeas({
      portfolio,
      target: targetPerNode,
      captureProvenance,
      now,
    }),
    collectResearchIdeas({
      target: targetPerNode,
      captureProvenance,
      now,
      sourceFunctions,
    }),
  ];
  const settled = await Promise.allSettled(nodes);
  const runs = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : ({
        agent: sourceIds[index],
        ideas: [],
        error: redactSourceError(result.reason),
        ...(captureProvenance
          ? {
              provenance: [failedSourceNodeProvenance({
                callId: `source-node.${sourceIds[index]}`,
                source: sourceIds[index],
                provider: 'deterministic-source-node',
                args: {
                  tickerCount: tickers.length,
                  portfolioCount: portfolio.length,
                  target: targetPerNode,
                },
                error: result.reason,
                now,
              })],
            }
          : {}),
      }));
  onProgress?.(runs);
  return {
    runs,
    ideas: runs.flatMap((run) => (run.ideas || []).map((idea) => ({ ...idea, sourceAgents: idea.sourceAgents || [run.agent] }))),
  };
}

export function selectSourceCandidates(candidates = [], existingTitles = [], count = 20) {
  const seen = new Set(existingTitles.map((s) => clean(s).toLowerCase()));
  const out = [];
  for (const item of candidates) {
    const key = clean(item.title || item.sentence).toLowerCase().slice(0, 90);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...item,
      title: item.title || item.sentence,
      sentence: item.sentence || item.title,
      qualityScore: item.qualityScore ?? Math.min(95, Math.max(35, (item.heat || 55) + (item.evidence?.length || 0) * 4)),
    });
  }
  return out.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)).slice(0, count);
}
