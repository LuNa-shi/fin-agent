import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { getResearchSchema } from '../contracts/schemaRegistry.js';

export const DATA_PLAN_ARTIFACT_PATTERN = 'data/data_plan_rN.json';

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('DataPlan.asOf must be an ISO timestamp');
  return date.toISOString();
}

function tickerEntities(tickers = []) {
  return [...new Set(tickers.map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
    .map((ticker) => ({ entityId: `ticker:${ticker}`, entityType: 'company', label: ticker }));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeFocus(value) {
  if (value === null || value === undefined) return { questions: [], tickers: [], tools: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('DataPlan.focus must be an object');
  const focus = {
    questions: stringList(value.questions).slice(0, 6),
    tickers: stringList(value.tickers),
    tools: stringList(value.tools),
  };
  const rationale = String(value.rationale || '').trim();
  if (rationale) focus.rationale = rationale;
  return focus;
}

function questionTemplates({ theme, focusQuestions, cfg }) {
  if (focusQuestions.length) return focusQuestions;
  return [
    `Which 1-3 external drivers most change the investment judgment for ${theme}?`,
    cfg?.fundamentals === false ? null : `What do current fundamentals, forward estimates, and valuation-implied expectations show for ${theme}?`,
    `Who owns the value chain and where are competition, substitution, or private-company threats changing for ${theme}?`,
    `Which catalysts, contradictions, and falsification evidence could invalidate the current thesis for ${theme}?`,
  ].filter(Boolean);
}

function strategiesFor(question, index, entityIds, cfg, autoTools) {
  const lower = question.toLowerCase();
  const transcript = /management|guidance|order|catalyst|管理层|指引|订单/u.test(lower);
  const competition = /competition|substitution|value chain|竞争|替代|价值链/u.test(lower);
  const macro = /external driver|demand|supply|macro|外部驱动|需求|供给|宏观/u.test(lower);
  const providers = competition ? ['edgar', 'fmp', 'perplexity', 'tavily']
    : macro ? ['fred', 'fmp', 'edgar', 'perplexity']
      : ['fmp', 'edgar'];
  const tools = [
    'fmp_quote',
    cfg?.fundamentals === false ? null : 'fmp_forward_estimates',
    cfg?.fundamentals === false ? null : 'fmp_ratios',
    transcript ? 'fmp_transcript' : null,
    'edgar_filings',
    competition || macro ? 'pplx_finance' : null,
    competition ? 'tavily_search' : null,
    ...autoTools.map((item) => item?.tool),
  ].filter(Boolean);
  return {
    strategyId: `strategy-${index + 1}`,
    questionId: `question-${index + 1}`,
    priority: index + 1,
    entityIds,
    timeWindowId: index === 1 ? 'forward-window' : 'current-window',
    providers: [...new Set(providers)],
    tools: [...new Set(tools)],
    primarySourceTypes: ['regulatory-filing', 'earnings-transcript', 'structured-financial-data'],
    fallbackSourceTypes: ['provider-aggregated-research', 'targeted-web-search'],
  };
}

export function buildDataPlan({
  brief = '', theme = 'unspecified research theme', tickers = [], round = 1, focus = {}, cfg = {}, autoTools = [], asOf,
} = {}) {
  const normalizedAsOf = iso(asOf);
  const normalizedFocus = normalizeFocus(focus);
  const cutoff = new Date(normalizedAsOf);
  const currentStart = new Date(cutoff);
  currentStart.setUTCDate(currentStart.getUTCDate() - 90);
  const historicalStart = new Date(cutoff);
  historicalStart.setUTCFullYear(historicalStart.getUTCFullYear() - 5);
  const forwardEnd = new Date(cutoff);
  forwardEnd.setUTCFullYear(forwardEnd.getUTCFullYear() + 3);
  const entities = tickerEntities(tickers);
  const themeEntity = { entityId: `theme:${canonicalSha256(theme).slice('sha256:'.length, 'sha256:'.length + 16)}`, entityType: 'theme', label: String(theme) };
  const entityIds = entities.map((entity) => entity.entityId);
  const rawQuestions = questionTemplates({
    theme,
    focusQuestions: normalizedFocus.questions,
    cfg,
  });
  const questions = rawQuestions.map((question, index) => ({
    questionId: `question-${index + 1}`,
    question,
    material: true,
    entityIds,
    timeWindowId: index === 1 ? 'forward-window' : 'current-window',
  }));
  const sourceStrategies = questions.map((question, index) => strategiesFor(question.question, index, entityIds, cfg, autoTools));
  const inputDigest = canonicalSha256({
    brief,
    theme,
    tickers: entityIds,
    round,
    focus: normalizedFocus,
    cfg: {
      fundamentals: cfg.fundamentals ?? null,
      transcript: cfg.transcript ?? null,
      research: cfg.research ?? null,
    },
    autoTools,
  });
  const plan = {
    schemaVersion: '1.0.0',
    asOf: normalizedAsOf,
    producer: 'data-planner',
    contractVersion: '1.0.0',
    inputDigest,
    createdAt: normalizedAsOf,
    evidenceRefs: [],
    round,
    questions,
    entities: [...entities, themeEntity],
    timeWindows: [
      { timeWindowId: 'historical-window', label: 'Five-year historical baseline', start: historicalStart.toISOString(), end: normalizedAsOf, basis: 'historical' },
      { timeWindowId: 'current-window', label: 'Current evidence window', start: currentStart.toISOString(), end: normalizedAsOf, basis: 'current' },
      { timeWindowId: 'forward-window', label: 'Forward estimate horizon known at asOf', start: normalizedAsOf, end: forwardEnd.toISOString(), basis: 'forward' },
    ],
    sourceStrategies,
    freshnessPolicy: {
      asOf: normalizedAsOf,
      rejectPublishedAfterAsOf: true,
      unknownPublishedAt: 'use-observedAt-and-open-issue',
      maxAgeDaysByEvidenceType: { fact: 120, management_statement: 180, estimate: 45, opinion: 30 },
    },
    gaps: entities.length ? [] : ['No ticker entity was resolved; entity-specific collection will remain incomplete.'],
    expectedArtifacts: [
      `data/data_plan_r${round}.json`,
      `data/source_documents_r${round}.json`,
      `data/evidence_bundle_r${round}.json`,
      'data/citation_ledger.json',
      `data/domain_events_r${round}.json`,
      `data/organized_r${round}.json`,
      'data/data_report.md',
    ],
  };
  const errors = validateJsonSchema(plan, getResearchSchema('dataPlan.v1'));
  if (errors.length) throw new TypeError(`DataPlan validation failed: ${errors.join('; ')}`);
  return deepFreeze(plan);
}
