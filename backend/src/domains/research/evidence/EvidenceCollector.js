import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import {
  assertPointInTimeSafe,
  createDomainEvent,
  createEvidenceItem,
  createSourceDocument,
  isAtOrBefore,
} from './evidenceContracts.js';

export const SOURCE_DOCUMENT_ARTIFACT_PATTERN = 'data/source_documents_rN.json';
export const DOMAIN_EVENT_ARTIFACT_PATTERN = 'data/domain_events_rN.json';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function iso(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function entityIds(tickers = []) {
  return [...new Set(tickers.map((ticker) => String(ticker || '').trim().toUpperCase()).filter(Boolean))]
    .map((ticker) => `ticker:${ticker}`);
}

function stringContent(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

function primitiveLeaves(value, prefix = '', out = []) {
  if (out.length >= 160) return out;
  if (value === null || value === undefined || value === '') return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push({ path: prefix || 'value', value });
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 30).forEach((item, index) => primitiveLeaves(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).sort().filter((key) => !['content', 'text', 'answer'].includes(key)).slice(0, 50)
      .forEach((key) => primitiveLeaves(value[key], prefix ? `${prefix}.${key}` : key, out));
  }
  return out;
}

function splitStatements(value) {
  return String(value || '').replace(/\s+/gu, ' ').split(/(?<=[.!?。！？])\s+/u).map((item) => item.trim()).filter(Boolean).slice(0, 24);
}

function estimatePath(path) {
  return /(estimate|target|forward|fwd|dcf|implied|consensus|forecast|upcoming)/iu.test(path);
}

function demoPayload(value) {
  try { return JSON.stringify(value).includes('"_demo":true'); } catch { return false; }
}

function citationLabelsForSource({ provider, uri, title }) {
  const labels = [title];
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedUri = String(uri || '').trim();
  let match;
  if (normalizedProvider === 'fmp' && (match = normalizedUri.match(/^fmp:\/\/quote\/([^/]+)$/iu))) {
    labels.push('fmp_quote', `fmp_quote:${match[1].toUpperCase()}`);
  } else if (normalizedProvider === 'fmp' && (match = normalizedUri.match(/^fmp:\/\/fundamentals\/([^/]+)$/iu))) {
    labels.push('fmp_fundamentals', `fmp_fundamentals:${match[1].toUpperCase()}`);
  } else if (normalizedProvider === 'fmp' && (match = normalizedUri.match(/^fmp:\/\/earnings-calendar\/([^/]+)$/iu))) {
    labels.push('fmp_earnings_calendar', `fmp_earnings_calendar:${match[1].toUpperCase()}`);
  } else if (normalizedProvider === 'fmp' && (match = normalizedUri.match(/^fmp:\/\/transcript\/([^/]+)\/(\d{4})Q(\d+)$/iu))) {
    const [, ticker, year, quarter] = match;
    labels.push(
      `transcript Q${quarter}'${year.slice(-2)}`,
      `fmp_transcript:${ticker.toUpperCase()}:${year}Q${quarter}`,
    );
  } else if (normalizedProvider === 'edgar' && (match = normalizedUri.match(/^edgar:\/\/company-detail\/([^/]+)$/iu))) {
    labels.push('company_detail', 'edgar_company_detail', `edgar_company_detail:${match[1].toUpperCase()}`);
  } else if (normalizedProvider === 'fmp' && normalizedUri === 'fmp://industry/context') {
    labels.push('industry context', 'fmp_industry_context', 'fmp_comps', 'fmp_peers', 'fmp_sector');
  }
  return [...new Set(labels.map((label) => String(label || '').trim()).filter(Boolean))];
}

export function collectEvidence({ plan, raw = {}, asOf = plan?.asOf, sourceMode = 'live-provider' } = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('EvidenceCollector requires DataPlan');
  const cutoff = iso(asOf, null);
  if (!cutoff) throw new TypeError('EvidenceCollector.asOf must be an ISO timestamp');
  const documents = new Map();
  const evidence = new Map();
  const events = new Map();
  const excluded = [];

  const addSource = ({
    provider, uri, title, content, tickers = [], publishedAt, observedAt = cutoff, mimeType = 'application/json', metadata = {},
    statements = [], event = null,
  }) => {
    const normalizedObservedAt = iso(observedAt, cutoff);
    const normalizedPublishedAt = iso(publishedAt, normalizedObservedAt);
    if (!isAtOrBefore(normalizedPublishedAt, cutoff) || !isAtOrBefore(normalizedObservedAt, cutoff)) {
      excluded.push({ provider, uri, title, reason: 'published-or-observed-after-asOf', publishedAt: normalizedPublishedAt, observedAt: normalizedObservedAt });
      return null;
    }
    const ids = entityIds(tickers);
    const document = createSourceDocument({
      provider,
      uri,
      title,
      content: stringContent(content),
      publishedAt: normalizedPublishedAt,
      observedAt: normalizedObservedAt,
      fetchedAt: normalizedObservedAt,
      mimeType,
      entityIds: ids,
      asOfSafe: true,
      metadata: {
        ...metadata,
        citationLabels: [...new Set([
          ...citationLabelsForSource({ provider, uri, title }),
          ...(Array.isArray(metadata.citationLabels) ? metadata.citationLabels : []),
        ])],
        ...(sourceMode === 'live-provider' ? {} : { sourceMode }),
      },
    });
    documents.set(document.sourceId, document);
    const refs = [];
    for (const statement of statements) {
      const text = String(statement.statement || '').trim();
      if (!text) continue;
      const item = createEvidenceItem({
        sourceId: document.sourceId,
        entityIds: statement.entityIds || ids,
        statement: text,
        ...(statement.value !== undefined ? { value: statement.value } : {}),
        ...(statement.unit !== undefined ? { unit: statement.unit } : {}),
        ...(statement.period !== undefined ? { period: statement.period } : {}),
        publishedAt: normalizedPublishedAt,
        observedAt: normalizedObservedAt,
        locator: { section: statement.section || title, quoteHash: canonicalSha256(text) },
        evidenceType: statement.evidenceType || 'fact',
        confidence: statement.confidence ?? 0.7,
      });
      evidence.set(item.evidenceId, item);
      refs.push(item.evidenceId);
    }
    if (event && refs.length) {
      const domainEvent = createDomainEvent({
        ...event,
        entityIds: event.entityIds || ids,
        publishedAt: normalizedPublishedAt,
        observedAt: normalizedObservedAt,
        evidenceRefs: refs,
      });
      events.set(domainEvent.eventId, domainEvent);
    }
    return { document, evidenceRefs: refs };
  };

  const structuredSource = ({ provider, uri, title, value, tickers = [], publishedAt, section = title, confidence = 0.9 }) => {
    const isDemo = demoPayload(value);
    const statements = primitiveLeaves(value).map((leaf) => ({
      statement: `${title}: ${leaf.path} = ${typeof leaf.value === 'string' ? leaf.value : JSON.stringify(leaf.value)}`,
      value: leaf.value,
      period: leaf.path,
      section,
      evidenceType: isDemo || estimatePath(leaf.path) ? 'estimate' : 'fact',
      confidence: isDemo ? 0.2 : (estimatePath(leaf.path) ? Math.min(confidence, 0.7) : confidence),
    }));
    if (!statements.length) return null;
    return addSource({ provider: isDemo ? 'demo' : provider, uri, title, content: value, tickers, publishedAt, metadata: { structured: true, demo: isDemo }, statements });
  };

  for (const quote of raw.quotes || []) {
    const ticker = quote.symbol || quote.ticker;
    structuredSource({
      provider: 'fmp', uri: `fmp://quote/${ticker || 'unknown'}`, title: `${ticker || 'Unknown'} market quote`, value: quote,
      tickers: [ticker], publishedAt: iso(quote.timestamp, cutoff), confidence: 0.9,
    });
  }
  for (const [ticker, value] of Object.entries(object(raw.fundamentals))) {
    structuredSource({ provider: 'fmp', uri: `fmp://fundamentals/${ticker}`, title: `${ticker} fundamentals and estimates`, value, tickers: [ticker], publishedAt: cutoff, confidence: 0.9 });
    const upcoming = value?.nextEarnings;
    if (upcoming?.date) {
      const result = addSource({
        provider: 'fmp', uri: `fmp://earnings-calendar/${ticker}`, title: `${ticker} earnings calendar`, content: upcoming,
        tickers: [ticker], publishedAt: cutoff, statements: [{ statement: `${ticker} next earnings is scheduled for ${upcoming.date}.`, value: upcoming.date, evidenceType: 'fact', confidence: 0.85 }],
        event: { eventType: 'earnings-release-scheduled', occurredAt: iso(upcoming.date, cutoff), summary: `${ticker} earnings release scheduled for ${upcoming.date}.`, significance: 'high', status: 'reported' },
      });
      if (!result) excluded.push({ provider: 'fmp', uri: `fmp://earnings-calendar/${ticker}`, reason: 'calendar-source-rejected' });
    }
  }
  for (const transcript of raw.transcripts || []) {
    const ticker = transcript.symbol || transcript.ticker;
    const publishedAt = iso(transcript.date, cutoff);
    const statements = splitStatements(transcript.excerpt || transcript.content).map((statement) => ({
      statement,
      section: `Q${transcript.quarter || '?'} ${transcript.year || ''} earnings call`,
      evidenceType: 'management_statement',
      confidence: transcript._demo ? 0.2 : 0.8,
    }));
    addSource({
      provider: transcript._demo ? 'demo' : 'fmp', uri: `fmp://transcript/${ticker || 'unknown'}/${transcript.year || 'unknown'}Q${transcript.quarter || 'unknown'}`,
      title: `${ticker || 'Unknown'} earnings transcript`, content: transcript.excerpt || transcript.content || transcript,
      tickers: [ticker], publishedAt, mimeType: 'text/plain', statements,
      event: { eventType: 'earnings-call', occurredAt: publishedAt, summary: `${ticker || 'Company'} earnings call published.`, significance: 'high', status: 'confirmed' },
    });
  }
  for (const [ticker, value] of Object.entries(object(raw.detail))) {
    structuredSource({ provider: value?.sec ? 'edgar' : 'fmp', uri: `${value?.sec ? 'edgar' : 'fmp'}://company-detail/${ticker}`, title: `${ticker} company detail`, value, tickers: [ticker], publishedAt: cutoff, confidence: value?.sec ? 0.95 : 0.85 });
  }
  structuredSource({ provider: 'fmp', uri: 'fmp://industry/context', title: 'Industry and peer context', value: raw.industry || {}, tickers: plan.entities.filter((item) => item.entityType === 'company').map((item) => item.label), publishedAt: cutoff, confidence: 0.85 });

  const research = object(raw.research);
  for (const [kind, entry] of [['finance', research.finance], ['competitive', research.competitive], ['drivers', research.drivers]]) {
    if (!entry?.answer) continue;
    const isDemo = entry._demo === true;
    addSource({
      provider: isDemo ? 'demo' : 'perplexity', uri: `perplexity://research/${kind}`, title: `Research ${kind}`, content: entry.answer,
      tickers: plan.entities.filter((item) => item.entityType === 'company').map((item) => item.label), publishedAt: cutoff, mimeType: 'text/plain',
      metadata: { citations: entry.citations || entry.sources || [], demo: isDemo },
      statements: splitStatements(entry.answer).map((statement) => ({
        statement,
        section: kind,
        evidenceType: isDemo ? 'estimate' : 'opinion',
        confidence: isDemo ? 0.2 : 0.55,
      })),
    });
  }
  for (const news of research.news || []) {
    const ticker = news.symbol || news.ticker;
    const publishedAt = iso(news.publishedDate || news.publishedAt || news.date, cutoff);
    addSource({
      provider: news._demo ? 'demo' : 'fmp', uri: news.url || `fmp://news/${canonicalSha256(news.title || '').slice('sha256:'.length, 'sha256:'.length + 16)}`,
      title: news.title || 'News item', content: news.text || news.title || news, tickers: [ticker], publishedAt, mimeType: 'text/plain',
      statements: [{ statement: news.title || news.text, section: news.site || 'news', evidenceType: news._demo ? 'estimate' : 'fact', confidence: news._demo ? 0.2 : 0.65 }],
      event: { eventType: 'news-publication', occurredAt: publishedAt, summary: news.title || 'News item published.', significance: 'medium', status: 'reported' },
    });
  }
  for (const opinion of research.opinions || []) {
    addSource({
      provider: opinion.source || 'research-digest', uri: opinion.url || `research://opinion/${canonicalSha256(opinion.title || opinion.summary || '').slice('sha256:'.length, 'sha256:'.length + 16)}`,
      title: opinion.title || 'Research opinion', content: opinion.summary || opinion.title || opinion, publishedAt: iso(opinion.publishedAt, cutoff), mimeType: 'text/plain',
      statements: [{ statement: opinion.summary || opinion.title, section: opinion.source || 'opinion', evidenceType: 'opinion', confidence: 0.4 }],
    });
  }
  for (const item of raw.highFreq || []) {
    const publishedAt = iso(item?.result?.latest?.date, cutoff);
    structuredSource({ provider: item.tool?.startsWith('fred') ? 'fred' : 'mixed', uri: `tool://${item.tool || 'high-frequency'}/${canonicalSha256(item.label || item).slice('sha256:'.length, 'sha256:'.length + 16)}`, title: item.label || item.tool || 'High-frequency data', value: item, publishedAt, confidence: 0.85 });
  }

  const sourceDocuments = [...documents.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const evidenceItems = [...evidence.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  const domainEvents = [...events.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
  assertPointInTimeSafe(sourceDocuments, cutoff);
  assertPointInTimeSafe(evidenceItems, cutoff);
  assertPointInTimeSafe(domainEvents, cutoff);
  return deepFreeze({
    schemaVersion: 'evidence-collection.v1',
    asOf: cutoff,
    planDigest: plan.inputDigest,
    sourceDocuments,
    evidenceItems,
    domainEvents,
    excluded,
    stats: {
      sourceDocuments: sourceDocuments.length,
      evidenceItems: evidenceItems.length,
      domainEvents: domainEvents.length,
      excludedAfterAsOf: excluded.length,
    },
  });
}
