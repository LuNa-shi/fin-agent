// Idea product API facade.
// Generation/classification orchestration lives under workflows/idea-generation;
// this module retains the existing list/status and earnings-calendar surface.
import { IdeaStore } from '../../domains/ideas/index.js';
import { readToolCache, writeToolCache } from '../../tools/cache.js';
import { getFxQuotes, getProfile, getUpcomingEarnings } from '../../tools/fmp.js';
import {
  classifyProjectSeed,
  recoverInterruptedIdeaGenerationRuns,
  resumeIdeaGenerationWorkflow,
  runIdeaGenerationWorkflow,
} from './ideaGeneration.workflow.js';
import { persistIdeaArtifact } from './nodes/ideaPersistence.js';
import {
  ideaGenerationAgentTimeline,
  ideaGenerationProgress,
  ideaGenerationTrace,
  ideaGenerationTraces,
  ideaGenerationWorkflowProjection,
} from './runApiProjection.js';
import { publicIdeaGenerationResult } from './publicProjection.js';

const ETF_INDEX = new Set(['SPX', 'SPY', 'DXY', 'GLD', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'TLT', 'HYG', 'SLV', 'USO', 'UUP', 'VIX', 'NDX', 'RUT']);

function earningsTickerShapeOk(symbol) {
  if (typeof symbol !== 'string') return false;
  const normalized = symbol.trim().toUpperCase();
  if (!normalized || ETF_INDEX.has(normalized)) return false;
  return /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(normalized) && /[A-Z]/.test(normalized);
}

function shortCompanyDescription(profile = {}) {
  const raw = profile.description || profile.companyDescription || profile.longBusinessSummary || '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 220);
}

function normalizeCurrency(currency = '') {
  const normalized = String(currency || '').trim().toUpperCase();
  if (!normalized) return 'USD';
  if (normalized === 'ZAC') return 'ZAR';
  if (normalized === 'GBX' || normalized === 'GBP' || normalized === 'GBP.L' || normalized === 'GBPp'.toUpperCase()) return 'GBP';
  if (normalized === 'ILA' || normalized === 'ILX') return 'ILS';
  return normalized;
}

async function attachUsdMarketCaps(rows = []) {
  const currencies = [...new Set(rows
    .map((row) => normalizeCurrency(row.marketCapCurrency || row.currency))
    .filter((currency) => currency && currency !== 'USD'))];
  if (!currencies.length) return rows.map((row) => ({ ...row, marketCapUsd: row.marketCapLocal ?? row.marketCapUsd ?? null }));
  const pairs = currencies.flatMap((currency) => [`USD${currency}`, `${currency}USD`]);
  const fx = await getFxQuotes({ pairs, limit: pairs.length }).catch(() => ({ quotes: [] }));
  const quotes = Object.fromEntries((fx.quotes || []).map((quote) => [String(quote.symbol || '').toUpperCase(), Number(quote.price)]));
  return rows.map((row) => {
    const local = Number(row.marketCapLocal ?? row.marketCapUsd);
    const currency = normalizeCurrency(row.marketCapCurrency || row.currency);
    if (!Number.isFinite(local) || local <= 0) return { ...row, marketCapUsd: null };
    if (currency === 'USD') return { ...row, marketCapUsd: local, marketCapFx: null };
    const direct = quotes[`USD${currency}`];
    const inverse = quotes[`${currency}USD`];
    const usd = direct > 0 ? local / direct : inverse > 0 ? local * inverse : null;
    return { ...row, marketCapUsd: usd ? Math.round(usd) : null, marketCapFx: usd ? `${currency}->USD` : null };
  });
}

function isUsEarningsRow(row = {}) {
  const exchange = row.exchange || '';
  const symbol = row.symbol || '';
  if (exchange) return /NASDAQ|NYSE|AMEX|OTC/i.test(exchange);
  return !/\.[A-Z]{1,4}$/i.test(symbol);
}

function sortEarningsRows(rows = []) {
  return [...rows].sort((a, b) => {
    const marketCapA = Number(a.marketCapUsd || 0);
    const marketCapB = Number(b.marketCapUsd || 0);
    if (marketCapB !== marketCapA) return marketCapB - marketCapA;
    return String(a.date || '').localeCompare(String(b.date || '')) || String(a.symbol || '').localeCompare(String(b.symbol || ''));
  });
}

async function loadEarningsCalendarRows({ days = 7, limit = 120, forceRefresh = false } = {}) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + Number(days || 7) * 86400000).toISOString().slice(0, 10);
  const args = { from, to, days: Number(days || 7), limit: Math.min(Math.max(limit, 120), 160) };
  const cached = forceRefresh ? null : readToolCache('earnings_calendar_enriched', args, { maxAgeHours: 6 });
  if (cached?.result?.rows?.length) return { ...cached.result, cacheHit: true };

  const calendar = await getUpcomingEarnings({ days, limit: args.limit });
  const events = (calendar.events || [])
    .filter((event) => earningsTickerShapeOk(String(event.symbol || '').toUpperCase()))
    .slice(0, args.limit);
  const limitConcurrency = (items, size = 8) => {
    let index = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
      const output = [];
      while (index < items.length) output.push(await items[index++]());
      return output;
    });
    return Promise.all(workers).then((chunks) => chunks.flat());
  };
  const rows = await limitConcurrency(events.map((event) => async () => {
    const symbol = String(event.symbol || '').toUpperCase();
    const profile = await getProfile(symbol).catch(() => ({ symbol }));
    const exchange = profile.exchangeShortName || profile.exchange || '';
    const country = profile.country || '';
    const companyName = profile.companyName || profile.name || symbol;
    const marketCapLocal = profile.mktCap ?? profile.marketCap ?? null;
    const marketCapCurrency = normalizeCurrency(profile.currency || 'USD');
    return {
      symbol,
      companyName,
      description: shortCompanyDescription(profile),
      marketCapLocal,
      marketCapCurrency,
      marketCapUsd: marketCapCurrency === 'USD' ? marketCapLocal : null,
      exchange,
      country,
      currency: profile.currency || '',
      sector: profile.sector || '',
      industry: profile.industry || '',
      date: event.date,
      time: event.time,
      epsEst: event.epsEst ?? null,
      revenueEst: event.revenueEst ?? null,
      sentence: `${symbol} reports earnings on ${event.date}; add it to the idea library for pre-earnings review.`,
      rationale: `${companyName}（${profile.sector || 'sector n/a'}${exchange ? `｜${exchange}` : ''}${country ? `｜${country}` : ''}）未来 7 天披露财报。按市值排序，适合加入 idea 库做财报前快速检查。`,
    };
  }), 8);
  const enriched = await attachUsdMarketCaps(rows.filter(Boolean));
  const result = {
    from: calendar.from,
    to: calendar.to,
    days,
    rows: sortEarningsRows(enriched),
    error: calendar.error,
    demo: calendar._demo || false,
    cachedAt: Date.now(),
  };
  writeToolCache('earnings_calendar_enriched', args, result, { maxAgeHours: 6 });
  return { ...result, cacheHit: false };
}

export const IdeaSystem = {
  list() { return IdeaStore.getIdeas(); },
  workflow() { return ideaGenerationWorkflowProjection(); },
  traces(limit = 40, filters = {}) { return ideaGenerationTraces(limit, filters); },
  trace(id, filters = {}) { return ideaGenerationTrace(id, filters); },
  agentTimeline(runId, agentRunId, options = {}) {
    return ideaGenerationAgentTimeline(runId, agentRunId, options);
  },
  progress(filters = {}) { return ideaGenerationProgress(filters); },
  async generate(count = 20, options = {}) {
    return publicIdeaGenerationResult(
      await runIdeaGenerationWorkflow(count, options),
    );
  },
  async resume(runId, options = {}) {
    return publicIdeaGenerationResult(
      await resumeIdeaGenerationWorkflow(runId, options),
    );
  },
  recoverInterrupted(options = {}) {
    return recoverInterruptedIdeaGenerationRuns(options);
  },
  updateStatus(id, status) { return IdeaStore.updateIdea(id, { status }); },
  remove(id) { return IdeaStore.removeIdea(id); },

  async earningsPreview({ days = 7, limit = 120, market = 'global', forceRefresh = false } = {}) {
    const marketKey = String(market || 'global').toLowerCase();
    const calendar = await loadEarningsCalendarRows({ days, limit, forceRefresh });
    const filtered = marketKey === 'us' ? calendar.rows.filter(isUsEarningsRow) : calendar.rows;
    return {
      from: calendar.from,
      to: calendar.to,
      days,
      market: marketKey,
      candidates: sortEarningsRows(filtered).slice(0, limit),
      error: calendar.error,
      demo: calendar.demo || false,
      cacheHit: calendar.cacheHit || false,
      cachedAt: calendar.cachedAt || null,
    };
  },

  addEarningsIdeas(candidates = []) {
    const ideas = (candidates || []).filter((candidate) => candidate?.symbol).map((candidate) => ({
      title: candidate.sentence || `${candidate.symbol} earnings calendar setup ahead of ${candidate.date}`,
      sentence: candidate.sentence || `${candidate.symbol} reports earnings on ${candidate.date}; add it to the idea library for pre-earnings review.`,
      theme: 'earnings calendar',
      heat: candidate.marketCapUsd ? Math.min(95, Math.max(45, Math.round(Math.log10(Number(candidate.marketCapUsd)) * 9))) : 55,
      rationale: candidate.rationale || '',
      tickers: [String(candidate.symbol).toUpperCase()],
      catalyst: `Earnings date: ${candidate.date}${candidate.time ? ` ${candidate.time}` : ''}`,
      edge: 'Upcoming earnings event; use this idea to run pre-earnings diligence and decide whether there is a tradable setup.',
      qualityScore: candidate.marketCapUsd ? Math.min(95, Math.max(45, Math.round(Math.log10(Number(candidate.marketCapUsd)) * 9))) : 55,
      sourceAgents: ['earnings-calendar-agent'],
      timeHorizon: 'next 7 days',
      status: 'new',
      earnings: candidate,
    }));
    const { saved, newlyAdded } = persistIdeaArtifact(ideas);
    return { ideas: saved, added: newlyAdded.slice(0, ideas.length) };
  },

  classify(text, options = {}) { return classifyProjectSeed(text, options); },
};
