import { getNews, getSectorPerformance } from '../../../tools/fmp.js';
import { researchDigest, saAssembleIdeas } from '../../../tools/research.js';
import { captureSourceCall } from './sourceProvenance.js';

const ETF_INDEX = new Set(['SPX', 'SPY', 'DXY', 'GLD', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'TLT', 'HYG', 'SLV', 'USO', 'UUP', 'VIX', 'NDX', 'RUT']);

export function tickerShapeOk(symbol) {
  return typeof symbol === 'string' && /^[A-Z][A-Z.-]{0,5}$/.test(symbol) && !ETF_INDEX.has(symbol);
}

export async function gatherMarketContext({
  captureProvenance = false,
  now = () => new Date().toISOString(),
  sourceFunctions = {},
} = {}) {
  const sectorSource = sourceFunctions.getSectorPerformance || getSectorPerformance;
  const newsSource = sourceFunctions.getNews || getNews;
  const digestSource = sourceFunctions.researchDigest || researchDigest;
  const saSource = sourceFunctions.saAssembleIdeas || saAssembleIdeas;
  const [sectorCall, newsCall, digestCall, saCall] = await Promise.all([
    captureSourceCall({
      callId: 'market-context.sector-performance',
      source: 'fmp-sector-performance',
      provider: 'fmp',
      args: {},
      execute: () => sectorSource(),
      fallback: () => ({ sectors: [] }),
      normalize: (value) => value?.sectors || [],
      now,
    }),
    captureSourceCall({
      callId: 'market-context.news',
      source: 'fmp-news',
      provider: 'fmp',
      args: { tickers: [], limit: 10 },
      execute: () => newsSource([], 10),
      fallback: () => [],
      normalize: (value) => value || [],
      now,
    }),
    captureSourceCall({
      callId: 'market-context.research-digest',
      source: 'research-digest',
      provider: 'research',
      args: { perSource: 3, sourceLimit: 10 },
      execute: () => digestSource({ perSource: 3, sourceLimit: 10 }),
      fallback: () => ({ items: [] }),
      normalize: (value) => ({
        items: value?.items || [],
        sourcesUsed: value?.sourcesUsed || [],
        domainsUsed: value?.domainsUsed || [],
      }),
      now,
    }),
    captureSourceCall({
      callId: 'market-context.seeking-alpha-pool',
      source: 'seeking-alpha-idea-pool',
      provider: 'seeking-alpha',
      args: { target: 60 },
      execute: () => saSource({ target: 60 }),
      fallback: () => ({ ideas: [] }),
      normalize: (value) => value?.ideas || [],
      now,
    }),
  ]);
  const sectorRes = sectorCall.value;
  const news = newsCall.value;
  const digest = digestCall.value;
  const saPool = saCall.value;
  const sectors = (sectorRes.sectors || []).map((item) => ({ sector: item.sector, chg: parseFloat(item.changesPercentage) }))
    .filter((item) => !Number.isNaN(item.chg)).sort((a, b) => b.chg - a.chg);
  const top = sectors.slice(0, 3).map((item) => `${item.sector} ${item.chg > 0 ? '+' : ''}${item.chg.toFixed(2)}%`);
  const bottom = sectors.slice(-3).map((item) => `${item.sector} ${item.chg.toFixed(2)}%`);
  const sectorTable = sectors.map((item) => `${item.sector} ${item.chg > 0 ? '+' : ''}${item.chg.toFixed(2)}%`);
  const headlines = (news || []).map((item) => item.title).filter(Boolean).slice(0, 10);
  const research = (digest.items || []).slice(0, 20).map((item) => ({
    source: item.source,
    title: item.title,
    summary: (item.summary || '').slice(0, 180),
    tickers: item.tickers || [],
    url: item.url,
  }));
  const saIdeas = (saPool.ideas || []).filter((item) => tickerShapeOk(item.ticker))
    .slice(0, 40).map((item) => ({ ticker: item.ticker, title: item.title, source: item.source }));
  const market = {
    top,
    bottom,
    sectorTable,
    headlines,
    research,
    saIdeas,
    sourcesUsed: digest.sourcesUsed || [],
    domainsUsed: digest.domainsUsed || [],
    hasData: !!(sectors.length || headlines.length || research.length || saIdeas.length),
  };
  return captureProvenance
    ? {
        ...market,
        provenance: [
          sectorCall.provenance,
          newsCall.provenance,
          digestCall.provenance,
          saCall.provenance,
        ],
      }
    : market;
}
