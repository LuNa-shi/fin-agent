import { canonicalSha256, canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';

export const CLAIM_LIBRARY_SCHEMA_VERSION = 'claim-library.v1';
export const CLAIM_CONTRACT = 'claim.v1';
export const CLAIM_ACTION_CONTRACT = 'claim-action.v1';
export const CLAIM_ACTION_REJECTION_CONTRACT = 'claim-action-rejection.v1';
export const CLAIM_PUBLICATION_CONTRACT = 'claim-publication.v1';
export const CLAIM_ACTIONS = Object.freeze(['ADD', 'UPDATE', 'NOOP']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TICKER_RE = /^[A-Z0-9][A-Z0-9._:-]{0,31}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class ClaimContractError extends TypeError {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ClaimContractError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ClaimContractError(code, message);
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CLAIM_INVALID_OBJECT', `${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CLAIM_INVALID_OBJECT', `${field} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('CLAIM_UNKNOWN_FIELD', `${field}.${key} is not part of Claim Library v1`);
  }
}

function boundedText(value, field, { max = 20_000, oneLine = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('CLAIM_INVALID_TEXT', `${field} must be non-empty text of at most ${max} characters`);
  }
  if (oneLine && /[\r\n\u2028\u2029]/u.test(value)) {
    fail('CLAIM_ASSERTION_MULTILINE', `${field} must be one line`);
  }
  return value.trim();
}

export function safeClaimId(value, field = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') {
    fail('CLAIM_UNSAFE_ID', `${field} is unsafe`);
  }
  return value;
}

export function claimDigest(value, field = 'digest') {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail('CLAIM_INVALID_DIGEST', `${field} must be a sha256 digest`);
  }
  return value;
}

export function claimTimestamp(value, field = 'timestamp') {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== 'string'
    || !ISO_RE.test(value)
    || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== value
  ) {
    fail('CLAIM_INVALID_TIMESTAMP', `${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeTickers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail('CLAIM_INVALID_TICKERS', 'tickers must be a bounded array');
  const normalized = value.map((ticker, index) => {
    if (typeof ticker !== 'string') fail('CLAIM_INVALID_TICKER', `tickers[${index}] is invalid`);
    const result = ticker.trim().toUpperCase();
    if (!TICKER_RE.test(result)) fail('CLAIM_INVALID_TICKER', `tickers[${index}] is invalid`);
    return result;
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizeVerification(value) {
  const verification = plainObject(value, 'verification');
  exactKeys(verification, ['pointAt', 'window'], 'verification');
  const hasPoint = Object.prototype.hasOwnProperty.call(verification, 'pointAt');
  const hasWindow = Object.prototype.hasOwnProperty.call(verification, 'window');
  if (hasPoint === hasWindow) {
    fail('CLAIM_INVALID_VERIFICATION', 'verification requires exactly one pointAt or window');
  }
  if (hasPoint) return { pointAt: claimTimestamp(verification.pointAt, 'verification.pointAt') };
  const window = plainObject(verification.window, 'verification.window');
  exactKeys(window, ['startAt', 'endAt'], 'verification.window');
  const startAt = claimTimestamp(window.startAt, 'verification.window.startAt');
  const endAt = claimTimestamp(window.endAt, 'verification.window.endAt');
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    fail('CLAIM_INVALID_VERIFICATION_WINDOW', 'verification.window.endAt must be after startAt');
  }
  return { window: { startAt, endAt } };
}

export function normalizeClaimEvidenceReference(value, field = 'evidence') {
  const reference = plainObject(value, field);
  exactKeys(reference, ['reportVersionId', 'contentDigest', 'fingerprint'], field);
  return {
    reportVersionId: safeClaimId(reference.reportVersionId, `${field}.reportVersionId`),
    contentDigest: claimDigest(reference.contentDigest, `${field}.contentDigest`),
    fingerprint: claimDigest(reference.fingerprint, `${field}.fingerprint`),
  };
}

function normalizeEvidence(value, field = 'evidence') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    fail('CLAIM_EVIDENCE_REQUIRED', `${field} must contain between 1 and 100 exact ReportVersion references`);
  }
  const normalized = value.map((item, index) => normalizeClaimEvidenceReference(item, `${field}[${index}]`));
  const seen = new Set();
  for (const reference of normalized) {
    if (seen.has(reference.reportVersionId)) {
      fail('CLAIM_DUPLICATE_EVIDENCE', `${field} contains duplicate ReportVersion ${reference.reportVersionId}`);
    }
    seen.add(reference.reportVersionId);
  }
  return normalized;
}

export function normalizeClaimBody(value) {
  const body = plainObject(value, 'claim');
  exactKeys(body, [
    'assertion',
    'subject',
    'tickers',
    'rationale',
    'verification',
    'metric',
    'acceptanceCondition',
    'invalidationCondition',
    'evidence',
  ], 'claim');
  return deepFreeze({
    assertion: boundedText(body.assertion, 'claim.assertion', { max: 500, oneLine: true }),
    subject: boundedText(body.subject, 'claim.subject', { max: 500 }),
    tickers: normalizeTickers(body.tickers),
    rationale: boundedText(body.rationale, 'claim.rationale', { max: 20_000 }),
    verification: normalizeVerification(body.verification),
    metric: boundedText(body.metric, 'claim.metric', { max: 1_000 }),
    acceptanceCondition: boundedText(body.acceptanceCondition, 'claim.acceptanceCondition', { max: 4_000 }),
    invalidationCondition: boundedText(body.invalidationCondition, 'claim.invalidationCondition', { max: 4_000 }),
    evidence: normalizeEvidence(body.evidence),
  });
}

function normalizeTarget(value, field = 'target') {
  const target = plainObject(value, field);
  exactKeys(target, ['claimId', 'expectedVersion'], field);
  if (!Number.isInteger(target.expectedVersion) || target.expectedVersion < 1) {
    fail('CLAIM_INVALID_EXPECTED_VERSION', `${field}.expectedVersion must be a positive integer`);
  }
  return {
    claimId: safeClaimId(target.claimId, `${field}.claimId`),
    expectedVersion: target.expectedVersion,
  };
}

export function normalizeClaimAction(value) {
  const input = plainObject(value, 'claim action');
  const action = input.action;
  if (!CLAIM_ACTIONS.includes(action)) {
    fail('CLAIM_ACTION_UNSUPPORTED', 'claim action must be ADD, UPDATE, or NOOP');
  }
  const common = {
    actionId: safeClaimId(input.actionId, 'claim action.actionId'),
    action,
    rationale: boundedText(input.rationale, 'claim action.rationale', { max: 8_000 }),
  };
  if (action === 'ADD') {
    exactKeys(input, ['actionId', 'action', 'rationale', 'claim'], 'claim action');
    return deepFreeze({ ...common, claim: normalizeClaimBody(input.claim) });
  }
  if (action === 'UPDATE') {
    exactKeys(input, ['actionId', 'action', 'rationale', 'target', 'claim'], 'claim action');
    return deepFreeze({ ...common, target: normalizeTarget(input.target), claim: normalizeClaimBody(input.claim) });
  }
  exactKeys(input, ['actionId', 'action', 'rationale', 'target', 'evidence'], 'claim action');
  return deepFreeze({ ...common, target: normalizeTarget(input.target), evidence: normalizeEvidence(input.evidence) });
}

export function deriveClaimId(originatingRunIdInput, actionIdInput) {
  const originatingRunId = safeClaimId(originatingRunIdInput, 'originatingRunId');
  const actionId = safeClaimId(actionIdInput, 'actionId');
  const digest = canonicalSha256({ originatingRunId, actionId });
  return `claim_${digest.slice('sha256:'.length)}`;
}

export function claimIntegrityDigest(record) {
  const { integrityDigest: _integrityDigest, ...projection } = record;
  return canonicalSha256(projection);
}

function claimBodyProjection(value) {
  return {
    assertion: value.assertion,
    subject: value.subject,
    tickers: value.tickers,
    rationale: value.rationale,
    verification: value.verification,
    metric: value.metric,
    acceptanceCondition: value.acceptanceCondition,
    invalidationCondition: value.invalidationCondition,
    evidence: value.evidence,
  };
}

function normalizeClaimReference(value, field = 'Claim reference') {
  const reference = plainObject(value, field);
  exactKeys(reference, ['claimId', 'version'], field);
  if (!Number.isInteger(reference.version) || reference.version < 1) {
    fail('CLAIM_INVALID_REFERENCE_VERSION', `${field}.version must be a positive integer`);
  }
  return { claimId: safeClaimId(reference.claimId, `${field}.claimId`), version: reference.version };
}

export function normalizeClaimRecord(value, { allowMissingIntegrityDigest = false } = {}) {
  const record = plainObject(value, 'Claim record');
  exactKeys(record, [
    'contract', 'claimId', 'version', 'assertion', 'subject', 'tickers', 'rationale', 'verification', 'metric',
    'acceptanceCondition', 'invalidationCondition', 'evidence', 'originatingRunId', 'publicationId', 'createdAt',
    'updatedAt', 'previousVersion', 'integrityDigest',
  ], 'Claim record');
  if (record.contract !== CLAIM_CONTRACT) fail('CLAIM_CONTRACT_MISMATCH', `Claim record contract must be ${CLAIM_CONTRACT}`);
  if (!Number.isInteger(record.version) || record.version < 1) fail('CLAIM_INVALID_VERSION', 'Claim version must be positive');
  const body = normalizeClaimBody(claimBodyProjection(record));
  const result = {
    contract: CLAIM_CONTRACT,
    claimId: safeClaimId(record.claimId, 'claimId'),
    version: record.version,
    ...body,
    originatingRunId: safeClaimId(record.originatingRunId, 'originatingRunId'),
    publicationId: safeClaimId(record.publicationId, 'publicationId'),
    createdAt: claimTimestamp(record.createdAt, 'createdAt'),
    updatedAt: claimTimestamp(record.updatedAt, 'updatedAt'),
    previousVersion: record.previousVersion === null ? null : record.previousVersion,
    integrityDigest: record.integrityDigest ?? null,
  };
  if (result.previousVersion !== null && (!Number.isInteger(result.previousVersion) || result.previousVersion < 1)) {
    fail('CLAIM_INVALID_PREVIOUS_VERSION', 'previousVersion must be null or a positive integer');
  }
  if (result.version === 1 && result.previousVersion !== null) fail('CLAIM_INVALID_PREVIOUS_VERSION', 'Claim v1 cannot have a previousVersion');
  if (result.version > 1 && result.previousVersion !== result.version - 1) fail('CLAIM_INVALID_PREVIOUS_VERSION', 'Claim previousVersion must be the preceding version');
  if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
    fail('CLAIM_INVALID_TIMESTAMP_ORDER', 'Claim updatedAt must not be before createdAt');
  }
  if (result.integrityDigest === null) {
    if (!allowMissingIntegrityDigest) fail('CLAIM_INTEGRITY_MISMATCH', 'Claim integrityDigest is required');
    result.integrityDigest = claimIntegrityDigest(result);
  } else if (claimDigest(result.integrityDigest, 'integrityDigest') !== claimIntegrityDigest(result)) {
    fail('CLAIM_INTEGRITY_MISMATCH', 'Claim integrityDigest is invalid');
  }
  return deepFreeze(result);
}

export function normalizeClaimActionRecord(value, { allowMissingIntegrityDigest = false } = {}) {
  const record = plainObject(value, 'Claim action record');
  exactKeys(record, [
    'contract', 'actionRecordId', 'publicationId', 'originatingRunId', 'actionIndex', 'actionId', 'action',
    'rationale', 'target', 'resultClaim', 'evidence', 'recordedAt', 'integrityDigest',
  ], 'Claim action record');
  if (record.contract !== CLAIM_ACTION_CONTRACT) fail('CLAIM_CONTRACT_MISMATCH', `Claim action record contract must be ${CLAIM_ACTION_CONTRACT}`);
  if (!Number.isInteger(record.actionIndex) || record.actionIndex < 0) fail('CLAIM_INVALID_ACTION_INDEX', 'actionIndex must be non-negative');
  if (!CLAIM_ACTIONS.includes(record.action)) fail('CLAIM_ACTION_UNSUPPORTED', 'Claim action record action is invalid');
  const nullableTarget = record.target === null ? null : normalizeTarget(record.target);
  const resultClaim = record.resultClaim === null ? null : normalizeClaimReference(record.resultClaim, 'resultClaim');
  const normalized = {
    contract: CLAIM_ACTION_CONTRACT,
    actionRecordId: safeClaimId(record.actionRecordId, 'actionRecordId'),
    publicationId: safeClaimId(record.publicationId, 'publicationId'),
    originatingRunId: safeClaimId(record.originatingRunId, 'originatingRunId'),
    actionIndex: record.actionIndex,
    actionId: safeClaimId(record.actionId, 'actionId'),
    action: record.action,
    rationale: boundedText(record.rationale, 'rationale', { max: 8_000 }),
    target: nullableTarget,
    resultClaim,
    evidence: normalizeEvidence(record.evidence),
    recordedAt: claimTimestamp(record.recordedAt, 'recordedAt'),
    integrityDigest: record.integrityDigest ?? null,
  };
  if (normalized.integrityDigest === null) {
    if (!allowMissingIntegrityDigest) fail('CLAIM_INTEGRITY_MISMATCH', 'Claim action integrityDigest is required');
    normalized.integrityDigest = claimIntegrityDigest(normalized);
  } else if (claimDigest(normalized.integrityDigest, 'integrityDigest') !== claimIntegrityDigest(normalized)) {
    fail('CLAIM_INTEGRITY_MISMATCH', 'Claim action integrityDigest is invalid');
  }
  return deepFreeze(normalized);
}

export function normalizeClaimRejectionRecord(value, { allowMissingIntegrityDigest = false } = {}) {
  const record = plainObject(value, 'Claim rejection record');
  exactKeys(record, [
    'contract', 'rejectionId', 'publicationId', 'originatingRunId', 'actionIndex', 'actionId', 'action',
    'target', 'code', 'reason', 'rejectedAt', 'integrityDigest',
  ], 'Claim rejection record');
  if (record.contract !== CLAIM_ACTION_REJECTION_CONTRACT) fail('CLAIM_CONTRACT_MISMATCH', `Claim rejection contract must be ${CLAIM_ACTION_REJECTION_CONTRACT}`);
  if (!Number.isInteger(record.actionIndex) || record.actionIndex < 0) fail('CLAIM_INVALID_ACTION_INDEX', 'actionIndex must be non-negative');
  const normalized = {
    contract: CLAIM_ACTION_REJECTION_CONTRACT,
    rejectionId: safeClaimId(record.rejectionId, 'rejectionId'),
    publicationId: safeClaimId(record.publicationId, 'publicationId'),
    originatingRunId: safeClaimId(record.originatingRunId, 'originatingRunId'),
    actionIndex: record.actionIndex,
    actionId: record.actionId === null ? null : safeClaimId(record.actionId, 'actionId'),
    action: CLAIM_ACTIONS.includes(record.action) ? record.action : null,
    target: record.target === null ? null : normalizeTarget(record.target),
    code: safeClaimId(record.code, 'rejection code'),
    reason: boundedText(record.reason, 'rejection reason', { max: 1_000 }),
    rejectedAt: claimTimestamp(record.rejectedAt, 'rejectedAt'),
    integrityDigest: record.integrityDigest ?? null,
  };
  if (normalized.integrityDigest === null) {
    if (!allowMissingIntegrityDigest) fail('CLAIM_INTEGRITY_MISMATCH', 'Claim rejection integrityDigest is required');
    normalized.integrityDigest = claimIntegrityDigest(normalized);
  } else if (claimDigest(normalized.integrityDigest, 'integrityDigest') !== claimIntegrityDigest(normalized)) {
    fail('CLAIM_INTEGRITY_MISMATCH', 'Claim rejection integrityDigest is invalid');
  }
  return deepFreeze(normalized);
}

export function changedClaimFields(previous, nextBody) {
  const left = normalizeClaimBody(claimBodyProjection(previous));
  const right = normalizeClaimBody(claimBodyProjection(nextBody));
  return Object.keys(right).filter((key) => canonicalStringify(left[key]) !== canonicalStringify(right[key]));
}
