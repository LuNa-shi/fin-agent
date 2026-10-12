import { getQuotes } from '../../../tools/fmp.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import {
  normalizeIdeaTitle as normalizeStoredIdeaTitle,
} from '../../../domains/ideas/IdeaStore.js';
import { tickerShapeOk } from './marketContext.js';

export const normalizeIdeaTitle = normalizeStoredIdeaTitle;

export const GENERATOR_OUTPUT_REJECTION_REASONS = Object.freeze({
  MISSING_TITLE: 'missing-title',
  MISSING_THEME: 'missing-theme',
  EMPTY_NORMALIZED_TITLE: 'empty-normalized-title',
  DUPLICATE_EXISTING_TITLE: 'duplicate-existing-title',
  DUPLICATE_PRIOR_OUTPUT: 'duplicate-prior-output',
  ALL_TICKERS_INVALID: 'all-tickers-invalid',
});

function requireIdentityText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function deriveStableIdeaId({
  workflow,
  runId,
  snapshotId,
  candidate,
} = {}) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new TypeError('workflow identity must be an object');
  }
  const workflowId = requireIdentityText(workflow.id, 'workflow.id');
  const workflowVersion = requireIdentityText(workflow.version, 'workflow.version');
  const workflowHash = requireIdentityText(workflow.hash, 'workflow.hash');
  if (!/^sha256:[a-f0-9]{64}$/u.test(workflowHash)) {
    throw new TypeError('workflow.hash must be a canonical sha256 digest');
  }
  const normalizedTitle = normalizeIdeaTitle(candidate?.title);
  if (!normalizedTitle) {
    throw new TypeError('candidate.title must have a non-empty normalized identity');
  }
  const digest = canonicalSha256({
    workflow: {
      id: workflowId,
      version: workflowVersion,
      hash: workflowHash,
    },
    runId: requireIdentityText(runId, 'runId'),
    snapshotId: requireIdentityText(snapshotId, 'snapshotId'),
    candidate: { normalizedTitle },
  });
  return `idea_${digest.slice('sha256:'.length)}`;
}

export function measureThemeConcentration(ideas, portfolio) {
  const counts = {};
  for (const idea of ideas) {
    const theme = (idea.theme || '').trim();
    if (theme) counts[theme] = (counts[theme] || 0) + 1;
  }
  for (const position of portfolio) {
    const theme = (position.theme || '').trim();
    if (theme) counts[theme] = (counts[theme] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0) || 1;
  const heavy = sorted.filter(([, count]) => count / total >= 0.2 || count >= 3).map(([theme, count]) => `${theme}(${count})`);
  return { sorted, heavy, total };
}

export async function verifyCandidateTickers(tickers) {
  const shaped = [...new Set(tickers.filter(tickerShapeOk))];
  if (!shaped.length) return new Set();
  const valid = new Set();
  for (let index = 0; index < shaped.length; index += 40) {
    const batch = shaped.slice(index, index + 40);
    const quotes = await getQuotes(batch).catch(() => []);
    for (const quote of quotes || []) {
      if (quote && quote.symbol && quote.price != null && !quote.error) valid.add(String(quote.symbol).toUpperCase());
    }
  }
  return valid;
}

export function normalizeGeneratorOutputs(generatorOutputs, validSet, existingTitles) {
  const existing = new Set(existingTitles.map(normalizeIdeaTitle));
  const accepted = new Set();
  const valid = [];
  const rejected = [];
  const reject = (index, reason) => rejected.push({ index, reason });

  let index = 0;
  for (const raw of generatorOutputs) {
    const sourceIndex = index;
    index += 1;
    if (!raw || !raw.title) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.MISSING_TITLE);
      continue;
    }
    if (!raw.theme) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.MISSING_THEME);
      continue;
    }
    const key = normalizeIdeaTitle(raw.title);
    if (!key) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.EMPTY_NORMALIZED_TITLE);
      continue;
    }
    if (existing.has(key)) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.DUPLICATE_EXISTING_TITLE);
      continue;
    }
    if (accepted.has(key)) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.DUPLICATE_PRIOR_OUTPUT);
      continue;
    }
    const tickers = Array.isArray(raw.tickers) ? raw.tickers.map((ticker) => String(ticker).toUpperCase().trim()) : [];
    const validTickers = tickers.filter((ticker) => validSet.has(ticker));
    const droppedTickers = tickers.filter((ticker) => !validSet.has(ticker));
    if (tickers.length && !validTickers.length) {
      reject(sourceIndex, GENERATOR_OUTPUT_REJECTION_REASONS.ALL_TICKERS_INVALID);
      continue;
    }
    accepted.add(key);
    valid.push({
      title: String(raw.title).trim(),
      theme: String(raw.theme).trim(),
      heat: typeof raw.heat === 'number' ? Math.max(0, Math.min(100, raw.heat)) : 60,
      rationale: raw.rationale || '',
      tickers: validTickers,
      droppedTickers,
      catalyst: raw.catalyst || '',
      edge: raw.edge || '',
      titleZh: raw.titleZh ? String(raw.titleZh).trim() : '',
      rationaleZh: raw.rationaleZh || '',
      catalystZh: raw.catalystZh || '',
      edgeZh: raw.edgeZh || '',
    });
  }
  return { valid, rejected };
}

export function sanitizeCandidatePool(pool, validSet, existingTitles) {
  return normalizeGeneratorOutputs(pool, validSet, existingTitles).valid;
}

export function selectDiverseCandidates(pool, count) {
  const ranked = [...pool].sort((a, b) => (b.heat || 0) - (a.heat || 0));
  const perTheme = {};
  const picked = [];
  for (const item of ranked) {
    if (picked.length >= count) break;
    const theme = item.theme || '其他';
    if ((perTheme[theme] || 0) >= 2) continue;
    perTheme[theme] = (perTheme[theme] || 0) + 1;
    picked.push(item);
  }
  for (const item of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.slice(0, count);
}

export function backfillDemoIdeas(ideas, count, existingTitles = []) {
  const seen = new Set([...existingTitles.map(normalizeIdeaTitle), ...ideas.map((idea) => normalizeIdeaTitle(idea.title))]);
  const fills = [
    { theme: 'software', ticker: 'MSFT', edge: 'AI feature bundling may lift ARPU faster than consensus models assume.' },
    { theme: 'payments', ticker: 'V', edge: 'Cross-border volume normalization may create operating leverage without large incremental capex.' },
    { theme: 'industrial automation', ticker: 'ROK', edge: 'Factory automation order recovery could arrive before headline PMI turns.' },
    { theme: 'cybersecurity', ticker: 'PANW', edge: 'Platform consolidation may shift budget share toward scaled vendors.' },
    { theme: 'medical devices', ticker: 'ISRG', edge: 'Procedure volume growth can compound even when hospital capex is tight.' },
    { theme: 'aerospace aftermarket', ticker: 'GE', edge: 'Engine service revenue may stay stronger than new aircraft delivery sentiment suggests.' },
    { theme: 'insurance pricing', ticker: 'PGR', edge: 'Pricing discipline can expand underwriting margins if claims inflation cools.' },
    { theme: 'waste management', ticker: 'WM', edge: 'Route density and pricing power can defend margins in a slower economy.' },
  ];
  let index = 0;
  while (ideas.length < count) {
    const seed = fills[index % fills.length];
    const cycle = Math.floor(index / fills.length) + 1;
    const baseTitle = `${seed.ticker} may offer a ${seed.theme} opportunity if ${seed.edge}`;
    const title = cycle === 1 ? baseTitle : `Follow-up ${cycle}: ${baseTitle}`;
    const key = normalizeIdeaTitle(title);
    index += 1;
    if (seen.has(key)) continue;
    seen.add(key);
    ideas.push({
      title,
      sentence: title,
      theme: seed.theme,
      heat: 50,
      rationale: seed.edge,
      tickers: [seed.ticker],
      catalyst: 'follow-up screening',
      edge: seed.edge,
      qualityScore: 50,
      sourceAgents: ['backfill-idea-agent'],
      timeHorizon: 'next 2-4 quarters',
      status: 'new',
    });
  }
  return ideas;
}
