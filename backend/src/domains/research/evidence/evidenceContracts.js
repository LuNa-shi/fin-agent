import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { getResearchSchema } from '../contracts/schemaRegistry.js';

export const EVIDENCE_CONTRACT_VERSION = '1.0.0';
export const EVIDENCE_TYPES = Object.freeze(['fact', 'management_statement', 'estimate', 'opinion']);
export const DOMAIN_EVENT_SIGNIFICANCE = Object.freeze(['low', 'medium', 'high']);
export const DOMAIN_EVENT_STATUSES = Object.freeze(['reported', 'confirmed', 'revised', 'cancelled']);

function iso(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function validateContract(value, schemaId) {
  const errors = validateJsonSchema(value, getResearchSchema(schemaId));
  if (errors.length) {
    const error = new TypeError(`${schemaId} validation failed: ${errors.join('; ')}`);
    error.code = 'EVIDENCE_CONTRACT_INVALID';
    error.errors = errors;
    throw error;
  }
  return deepFreeze(value);
}

export function isAtOrBefore(value, asOf) {
  return new Date(value).getTime() <= new Date(asOf).getTime();
}

export function createSourceDocument(input = {}) {
  const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? null);
  if (!content.trim()) throw new TypeError('SourceDocument.content must be non-empty');
  const publishedAt = iso(input.publishedAt, 'SourceDocument.publishedAt');
  const observedAt = iso(input.observedAt, 'SourceDocument.observedAt');
  const fetchedAt = iso(input.fetchedAt ?? observedAt, 'SourceDocument.fetchedAt');
  const contentHash = canonicalSha256(content);
  const sourceId = `source:${canonicalSha256({
    contentHash,
    provider: String(input.provider || ''),
    uri: String(input.uri || ''),
  }).slice('sha256:'.length)}`;
  return validateContract({
    schemaVersion: EVIDENCE_CONTRACT_VERSION,
    sourceId,
    contentHash,
    uri: String(input.uri || '').trim(),
    provider: String(input.provider || '').trim(),
    title: String(input.title || '').trim(),
    content,
    publishedAt,
    observedAt,
    fetchedAt,
    mimeType: String(input.mimeType || 'application/json').trim(),
    entityIds: strings(input.entityIds),
    asOfSafe: input.asOfSafe === true,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
  }, 'sourceDocument.v1');
}

export function createEvidenceItem(input = {}) {
  const statement = String(input.statement || '').trim();
  if (!statement) throw new TypeError('EvidenceItem.statement must be non-empty');
  const publishedAt = iso(input.publishedAt, 'EvidenceItem.publishedAt');
  const observedAt = iso(input.observedAt, 'EvidenceItem.observedAt');
  const locator = {
    ...(Number.isInteger(input.locator?.page) ? { page: input.locator.page } : {}),
    section: String(input.locator?.section || '').trim(),
    quoteHash: input.locator?.quoteHash || canonicalSha256(statement),
  };
  const identity = {
    sourceId: String(input.sourceId || ''),
    statement,
    ...(input.value !== undefined ? { value: input.value } : {}),
    locator,
  };
  return validateContract({
    schemaVersion: EVIDENCE_CONTRACT_VERSION,
    evidenceId: `evidence:${canonicalSha256(identity).slice('sha256:'.length)}`,
    sourceId: String(input.sourceId || ''),
    entityIds: strings(input.entityIds),
    statement,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.unit !== undefined ? { unit: String(input.unit) } : {}),
    ...(input.period !== undefined ? { period: String(input.period) } : {}),
    publishedAt,
    observedAt,
    ...(input.validFrom ? { validFrom: iso(input.validFrom, 'EvidenceItem.validFrom') } : {}),
    ...(input.validTo ? { validTo: iso(input.validTo, 'EvidenceItem.validTo') } : {}),
    locator,
    evidenceType: EVIDENCE_TYPES.includes(input.evidenceType) ? input.evidenceType : 'fact',
    confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
    supersedes: strings(input.supersedes),
    contradicts: strings(input.contradicts),
  }, 'evidenceItem.v1');
}

export function createDomainEvent(input = {}) {
  const publishedAt = iso(input.publishedAt, 'DomainEvent.publishedAt');
  const observedAt = iso(input.observedAt, 'DomainEvent.observedAt');
  const summary = String(input.summary || '').trim();
  const identity = {
    eventType: String(input.eventType || ''),
    entityIds: strings(input.entityIds),
    occurredAt: input.occurredAt || null,
    publishedAt,
    summary,
  };
  return validateContract({
    schemaVersion: EVIDENCE_CONTRACT_VERSION,
    eventId: `event:${canonicalSha256(identity).slice('sha256:'.length)}`,
    eventType: String(input.eventType || '').trim(),
    entityIds: strings(input.entityIds),
    ...(input.occurredAt ? { occurredAt: iso(input.occurredAt, 'DomainEvent.occurredAt') } : {}),
    ...(input.announcedAt ? { announcedAt: iso(input.announcedAt, 'DomainEvent.announcedAt') } : {}),
    publishedAt,
    observedAt,
    evidenceRefs: strings(input.evidenceRefs),
    summary,
    significance: DOMAIN_EVENT_SIGNIFICANCE.includes(input.significance) ? input.significance : 'medium',
    status: DOMAIN_EVENT_STATUSES.includes(input.status) ? input.status : 'reported',
    relatedEventIds: strings(input.relatedEventIds),
  }, 'domainEvent.v1');
}

export function assertPointInTimeSafe(records = [], asOf) {
  const cutoff = iso(asOf, 'asOf');
  const unsafe = records.filter((record) => (
    !isAtOrBefore(record.publishedAt, cutoff)
    || !isAtOrBefore(record.observedAt, cutoff)
    || record.asOfSafe === false
  ));
  if (unsafe.length) {
    const error = new Error(`Point-in-time evidence rejected: ${unsafe.map((item) => item.sourceId || item.evidenceId || item.eventId).join(', ')}`);
    error.code = 'EVIDENCE_AFTER_AS_OF';
    throw error;
  }
  return true;
}
