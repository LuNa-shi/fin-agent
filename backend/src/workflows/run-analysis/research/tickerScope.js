function normalizeTickers(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((ticker) => String(ticker || '').trim().toUpperCase())
    .filter(Boolean))];
}

export function tickerScopeMode({ meta = {}, cp = {} } = {}) {
  if (normalizeTickers(meta.tickers).length) return 'targeted';
  if (meta.mode === 'targeted' || cp.scan?.mode === 'targeted') return 'targeted';
  return 'discovery';
}

export function authoritativeCompanyTickers({
  meta = {},
  cp = {},
  fallbackTickers = [],
  maxTickers = Number.POSITIVE_INFINITY,
} = {}) {
  const scanTickers = normalizeTickers(cp.scan?.deepTickers);
  const explicitTickers = normalizeTickers(meta.tickers);
  const fallback = normalizeTickers(fallbackTickers);
  if (tickerScopeMode({ meta, cp }) === 'targeted') {
    return (explicitTickers.length ? explicitTickers : scanTickers).slice(0, maxTickers);
  }
  const selected = scanTickers.length ? scanTickers : fallback;
  return [...new Set([...selected, ...normalizeTickers(cp.deepPromoted)])].slice(0, maxTickers);
}

export function tickerPromotions({
  meta = {},
  cp = {},
  currentTickers = [],
  namedTickers = [],
  maxTickers = Number.POSITIVE_INFINITY,
} = {}) {
  if (tickerScopeMode({ meta, cp }) === 'targeted') return [];
  const current = normalizeTickers(currentTickers);
  const currentSet = new Set(current);
  const room = Math.max(0, maxTickers - current.length);
  return normalizeTickers(namedTickers).filter((ticker) => !currentSet.has(ticker)).slice(0, room);
}
