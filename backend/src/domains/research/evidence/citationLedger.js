import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { getResearchSchema } from '../contracts/schemaRegistry.js';

export const CITATION_LEDGER_ARTIFACT_PATTERN = 'data/citation_ledger.json';

const array = (value) => Array.isArray(value) ? value : [];

function strings(value) {
  return [...new Set(array(value).map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

function normalizedAlias(value) {
  return String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[`'"‘’“”]+|[`'"‘’“”]+$/gu, '')
    .replace(/\\/gu, '/')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stableObjects(values, identity) {
  const byId = new Map();
  for (const value of array(values)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const id = identity(value);
    if (id && !byId.has(id)) byId.set(id, value);
  }
  return [...byId.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function sourceRound(source, sourceRounds) {
  const value = sourceRounds instanceof Map
    ? sourceRounds.get(String(source?.sourceId || ''))
    : sourceRounds?.[String(source?.sourceId || '')];
  const round = Number(value);
  return Number.isInteger(round) && round > 0 ? round : 0;
}

function sourceTimestamp(source, field) {
  const timestamp = Date.parse(source?.[field]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareSourceRecency(left, right, sourceRounds) {
  const roundDelta = sourceRound(left, sourceRounds) - sourceRound(right, sourceRounds);
  if (roundDelta) return roundDelta;
  const observedDelta = sourceTimestamp(left, 'observedAt') - sourceTimestamp(right, 'observedAt');
  if (observedDelta) return observedDelta;
  const publishedDelta = sourceTimestamp(left, 'publishedAt') - sourceTimestamp(right, 'publishedAt');
  if (publishedDelta) return publishedDelta;
  return sourceTimestamp(left, 'fetchedAt') - sourceTimestamp(right, 'fetchedAt');
}

function latestSourcesByUri(sources, sourceRounds) {
  const latest = new Map();
  for (const source of sources) {
    const key = String(source.uri || source.sourceId || '');
    const current = latest.get(key) || [];
    if (current.length === 0) {
      latest.set(key, [source]);
      continue;
    }
    const comparison = compareSourceRecency(source, current[0], sourceRounds);
    if (comparison > 0) latest.set(key, [source]);
    else if (comparison === 0) latest.set(key, [...current, source]);
  }
  return [...latest.values()].flat();
}

function navigationOnlyArtifacts(round) {
  return [
    { path: 'data/data_report.md', labels: ['data_report'] },
    { path: 'analysis/industry.json', labels: ['industry.json'] },
    { path: 'analysis/company.json', labels: ['company.json'] },
    ...Array.from({ length: round }, (_, index) => ({
      path: `analysis/reflection_r${index + 1}.json`,
      labels: [`reflection_r${index + 1}`],
    })),
  ];
}

export function buildCitationLedger({
  round = 1,
  asOf,
  sourceDocuments = [],
  evidenceItems = [],
  sourceRounds = {},
} = {}) {
  const normalizedRound = Number(round);
  if (!Number.isInteger(normalizedRound) || normalizedRound < 1) throw new TypeError('CitationLedger.round must be a positive integer');
  const normalizedAsOf = new Date(asOf).toISOString();
  const documents = stableObjects(sourceDocuments, (source) => String(source.sourceId || ''));
  const items = stableObjects(evidenceItems, (item) => String(item.evidenceId || ''));
  const evidenceBySource = new Map();
  for (const item of items) {
    const sourceId = String(item.sourceId || '');
    if (!evidenceBySource.has(sourceId)) evidenceBySource.set(sourceId, []);
    evidenceBySource.get(sourceId).push(String(item.evidenceId));
  }

  const navigationArtifacts = navigationOnlyArtifacts(normalizedRound);
  const navigationAliases = new Set(
    navigationArtifacts.flatMap((artifact) => artifact.labels).map(normalizedAlias).filter(Boolean),
  );
  const aliasOwners = new Map();
  for (const source of latestSourcesByUri(documents, sourceRounds)) {
    const labels = strings([source.title, ...array(source.metadata?.citationLabels)]);
    for (const alias of labels) {
      const key = normalizedAlias(alias);
      if (!key || navigationAliases.has(key)) continue;
      if (!aliasOwners.has(key)) aliasOwners.set(key, { labels: new Set(), sourceIds: new Set() });
      aliasOwners.get(key).labels.add(alias);
      aliasOwners.get(key).sourceIds.add(String(source.sourceId));
    }
  }
  const aliases = [];
  const ambiguousAliases = [];
  for (const [, owners] of [...aliasOwners.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const alias = [...owners.labels].sort()[0];
    const sourceIds = [...owners.sourceIds].sort();
    if (sourceIds.length === 1) aliases.push({ alias, sourceId: sourceIds[0], marker: `[src: ${alias}]` });
    else ambiguousAliases.push({ alias, sourceIds });
  }

  const sources = documents.map((source) => ({
    sourceId: String(source.sourceId),
    marker: `[src: ${source.sourceId}]`,
    provider: String(source.provider || ''),
    title: String(source.title || ''),
    uri: String(source.uri || ''),
    publishedAt: String(source.publishedAt || ''),
    entityIds: strings(source.entityIds),
    evidenceIds: strings(evidenceBySource.get(String(source.sourceId))),
  }));
  const normalizedEvidenceItems = items.map((item) => ({
    evidenceId: String(item.evidenceId),
    marker: `[src: ${item.evidenceId}]`,
    sourceId: String(item.sourceId),
    statement: String(item.statement || ''),
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.unit !== undefined ? { unit: String(item.unit) } : {}),
    ...(item.period !== undefined ? { period: String(item.period) } : {}),
    evidenceType: String(item.evidenceType || ''),
    confidence: Number(item.confidence),
    locator: item.locator && typeof item.locator === 'object' && !Array.isArray(item.locator) ? item.locator : {},
  }));
  const inputDigest = canonicalSha256({
    asOf: normalizedAsOf,
    aliases,
    ambiguousAliases,
    sources,
    evidenceItems: normalizedEvidenceItems,
  });
  const ledger = {
    schemaVersion: 'citation-ledger.v1',
    asOf: normalizedAsOf,
    round: normalizedRound,
    inputDigest,
    markerContract: {
      source: 'Use [src: evidence:<id>], [src: source:<id>], or a unique alias listed below for factual material claims.',
      estimate: 'Use [est] for an analytical estimate that is not directly supported by atomic evidence.',
      openIssue: 'Use [open-issue: <missing evidence>] when the claim cannot yet be established.',
      navigationArtifactsAreAtomicEvidence: false,
    },
    aliases,
    sources,
    evidenceItems: normalizedEvidenceItems,
    ambiguousAliases,
    navigationOnlyArtifacts: navigationArtifacts,
  };
  const errors = validateJsonSchema(ledger, getResearchSchema('citationLedger.v1'));
  if (errors.length) throw new TypeError(`citationLedger.v1 validation failed: ${errors.join('; ')}`);
  return deepFreeze(ledger);
}
