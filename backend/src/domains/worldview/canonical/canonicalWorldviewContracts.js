import { createHash } from 'node:crypto';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../../core/contracts/ArtifactRef.js';

export const CANONICAL_WORLDVIEW_PACKAGE_CONTRACT = 'canonical-worldview-package.v1';
export const WORLDVIEW_AGENT_RESULT_CONTRACT = 'worldview-agent-result.v1';
export const CURRENT_WORLDVIEW_CONTRACT = 'current-worldview.v1';
export const WORLDVIEW_EVALUATION_RECORD_CONTRACT = 'worldview-evaluation-record.v1';
export const WORLDVIEW_UPDATE_RECORD_CONTRACT = 'worldview-update-record.v1';
export const WORLDVIEW_AGENT_RUN_CONTRACT = 'worldview-agent-run.v1';
export const WORLDVIEW_OVERVIEW_MANIFEST_CONTRACT = 'worldview-overview-manifest.v1';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONFIDENCE = new Set(['low', 'medium', 'high']);

function fail(message, code = 'INVALID_CANONICAL_WORLDVIEW', statusCode = 400) {
  const error = new TypeError(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, required, optional, label) {
  object(value, label);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(`${label} requires ${missing.join(', ')}`);
}

export function canonicalWorldviewSafeId(value, label = 'id') {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    fail(`${label} is unsafe`, 'INVALID_CANONICAL_WORLDVIEW_ID');
  }
  return value;
}

export function canonicalWorldviewDigest(value, label = 'digest') {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail(`${label} must be a sha256 digest`, 'INVALID_CANONICAL_WORLDVIEW_DIGEST');
  }
  return value;
}

export function canonicalWorldviewTimestamp(value, label = 'timestamp') {
  if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a canonical ISO timestamp`, 'INVALID_CANONICAL_WORLDVIEW_TIMESTAMP');
  }
  return value;
}

function boundedText(value, label, { max = 100_000 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000') || value.length > max) {
    fail(`${label} must be bounded non-empty text`);
  }
  return value.trim();
}

function textArray(value, label, { maxItems = 256, maxText = 2_000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must be a bounded array`);
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, { max: maxText }));
}

function evidenceRef(value, label) {
  exactKeys(value, ['reportVersionId', 'contentDigest'], [], label);
  return {
    reportVersionId: canonicalWorldviewSafeId(value.reportVersionId, `${label}.reportVersionId`),
    contentDigest: canonicalWorldviewDigest(value.contentDigest, `${label}.contentDigest`),
  };
}

function evidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length > 1_000) fail(`${label} must be a bounded array`);
  return value.map((item, index) => evidenceRef(item, `${label}[${index}]`));
}

function normalizeRelationship(value, index) {
  const label = `worldview.package.causalRelationships[${index}]`;
  exactKeys(value, ['relationshipId', 'cause', 'effect', 'mechanism', 'confidence', 'evidence', 'counterEvidence'], [], label);
  if (!CONFIDENCE.has(value.confidence)) fail(`${label}.confidence is invalid`);
  return {
    relationshipId: canonicalWorldviewSafeId(value.relationshipId, `${label}.relationshipId`),
    cause: boundedText(value.cause, `${label}.cause`, { max: 2_000 }),
    effect: boundedText(value.effect, `${label}.effect`, { max: 2_000 }),
    mechanism: boundedText(value.mechanism, `${label}.mechanism`, { max: 10_000 }),
    confidence: value.confidence,
    evidence: evidenceRefs(value.evidence, `${label}.evidence`),
    counterEvidence: evidenceRefs(value.counterEvidence, `${label}.counterEvidence`),
  };
}

function normalizeEvidence(value, index, expectedKind) {
  const label = `worldview.package.${expectedKind === 'supporting' ? 'evidence' : 'counterEvidence'}[${index}]`;
  exactKeys(value, ['reportVersionId', 'contentDigest', 'kind', 'summary'], [], label);
  if (value.kind !== expectedKind) fail(`${label}.kind must be ${expectedKind}`);
  return {
    reportVersionId: canonicalWorldviewSafeId(value.reportVersionId, `${label}.reportVersionId`),
    contentDigest: canonicalWorldviewDigest(value.contentDigest, `${label}.contentDigest`),
    kind: expectedKind,
    summary: boundedText(value.summary, `${label}.summary`, { max: 10_000 }),
  };
}

function normalizeImplication(value, index) {
  const label = `worldview.package.investmentImplications[${index}]`;
  exactKeys(value, ['theme', 'implication', 'horizon', 'confidence'], [], label);
  if (!CONFIDENCE.has(value.confidence)) fail(`${label}.confidence is invalid`);
  return {
    theme: boundedText(value.theme, `${label}.theme`, { max: 1_000 }),
    implication: boundedText(value.implication, `${label}.implication`, { max: 10_000 }),
    horizon: boundedText(value.horizon, `${label}.horizon`, { max: 1_000 }),
    confidence: value.confidence,
  };
}

function normalizeCoverage(value) {
  exactKeys(value, ['overviewIds', 'reportVersionIds', 'selectedFullReadReportVersionIds'], [], 'worldview.package.coverage');
  const ids = (items, label) => {
    if (!Array.isArray(items) || items.length > 10_000) fail(`${label} must be a bounded array`);
    const normalized = items.map((item, index) => canonicalWorldviewSafeId(item, `${label}[${index}]`));
    if (new Set(normalized).size !== normalized.length) fail(`${label} must be unique`);
    return normalized;
  };
  return {
    overviewIds: ids(value.overviewIds, 'worldview.package.coverage.overviewIds'),
    reportVersionIds: ids(value.reportVersionIds, 'worldview.package.coverage.reportVersionIds'),
    selectedFullReadReportVersionIds: ids(value.selectedFullReadReportVersionIds, 'worldview.package.coverage.selectedFullReadReportVersionIds'),
  };
}

function normalizeUpdateSummary(value) {
  exactKeys(value, ['retained', 'changed', 'added', 'removed'], [], 'worldview.package.updateSummary');
  return {
    retained: textArray(value.retained, 'worldview.package.updateSummary.retained'),
    changed: textArray(value.changed, 'worldview.package.updateSummary.changed'),
    added: textArray(value.added, 'worldview.package.updateSummary.added'),
    removed: textArray(value.removed, 'worldview.package.updateSummary.removed'),
  };
}

function normalizePackage(value) {
  exactKeys(value, [
    'title', 'asOf', 'narrativeMarkdown', 'causalRelationships', 'evidence', 'counterEvidence',
    'investmentImplications', 'coverage', 'updateSummary',
  ], [], 'worldview.package');
  if (!Array.isArray(value.causalRelationships) || value.causalRelationships.length < 1 || value.causalRelationships.length > 1_000) {
    fail('worldview.package.causalRelationships must be a non-empty bounded array');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 10_000) {
    fail('worldview.package.evidence must be a non-empty bounded array');
  }
  if (!Array.isArray(value.counterEvidence) || value.counterEvidence.length > 10_000) fail('worldview.package.counterEvidence must be a bounded array');
  if (!Array.isArray(value.investmentImplications) || value.investmentImplications.length < 1 || value.investmentImplications.length > 1_000) {
    fail('worldview.package.investmentImplications must be a non-empty bounded array');
  }
  return {
    title: boundedText(value.title, 'worldview.package.title', { max: 500 }),
    asOf: canonicalWorldviewTimestamp(value.asOf, 'worldview.package.asOf'),
    narrativeMarkdown: boundedText(value.narrativeMarkdown, 'worldview.package.narrativeMarkdown', { max: 500_000 }),
    causalRelationships: value.causalRelationships.map(normalizeRelationship),
    evidence: value.evidence.map((item, index) => normalizeEvidence(item, index, 'supporting')),
    counterEvidence: value.counterEvidence.map((item, index) => normalizeEvidence(item, index, 'counter')),
    investmentImplications: value.investmentImplications.map(normalizeImplication),
    coverage: normalizeCoverage(value.coverage),
    updateSummary: normalizeUpdateSummary(value.updateSummary),
  };
}

export function normalizeWorldviewAgentResult(input, {
  baseWorldviewVersionId = null,
  manifest = null,
  selectedFullReads = [],
} = {}) {
  exactKeys(input, ['contract', 'worldview', 'claimActions'], [], 'Worldview Agent result');
  if (input.contract !== WORLDVIEW_AGENT_RESULT_CONTRACT) {
    fail(`unsupported Worldview Agent result contract: ${input.contract}`, 'UNSUPPORTED_WORLDVIEW_AGENT_RESULT');
  }
  if (!Array.isArray(input.claimActions)) fail('claimActions must be an array');
  if (input.claimActions.length > 100) fail('claimActions must contain at most 100 items', 'WORLDVIEW_CLAIM_ACTION_LIMIT_EXCEEDED');
  exactKeys(input.worldview, ['action', 'baseWorldviewVersionId', 'rationale', 'package'], [], 'worldview');
  if (!['KEEP', 'UPDATE'].includes(input.worldview.action)) fail('worldview.action must be KEEP or UPDATE');
  const normalizedBase = input.worldview.baseWorldviewVersionId === null
    ? null
    : canonicalWorldviewSafeId(input.worldview.baseWorldviewVersionId, 'worldview.baseWorldviewVersionId');
  if (normalizedBase !== baseWorldviewVersionId) {
    fail('Worldview Agent result base reference does not match the frozen current Worldview', 'WORLDVIEW_BASE_REFERENCE_MISMATCH');
  }
  if (input.worldview.action === 'KEEP' && baseWorldviewVersionId === null) {
    fail('Bootstrap Worldview run cannot KEEP without a current Worldview; UPDATE is required', 'WORLDVIEW_BOOTSTRAP_KEEP_REJECTED');
  }
  if (input.worldview.action === 'KEEP' && input.worldview.package !== null) {
    fail('KEEP must not include a canonical package', 'WORLDVIEW_KEEP_PACKAGE_FORBIDDEN');
  }
  if (input.worldview.action === 'UPDATE' && (!input.worldview.package || typeof input.worldview.package !== 'object')) {
    fail('UPDATE requires a complete canonical Worldview package', 'WORLDVIEW_UPDATE_PACKAGE_REQUIRED');
  }
  const packageValue = input.worldview.action === 'UPDATE' ? normalizePackage(input.worldview.package) : null;
  const normalized = {
    contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
    worldview: {
      action: input.worldview.action,
      baseWorldviewVersionId: normalizedBase,
      rationale: boundedText(input.worldview.rationale, 'worldview.rationale', { max: 20_000 }),
      package: packageValue,
    },
    claimActions: structuredClone(input.claimActions),
  };

  if (manifest && packageValue) {
    const overviewIds = manifest.items.map((item) => item.overviewId);
    const reportVersionIds = manifest.items.map((item) => item.reportVersionId);
    if (canonicalStringify(packageValue.coverage.overviewIds) !== canonicalStringify(overviewIds)) {
      fail('Canonical Worldview coverage must include every frozen Overview in order', 'WORLDVIEW_OVERVIEW_COVERAGE_INCOMPLETE');
    }
    if (canonicalStringify(packageValue.coverage.reportVersionIds) !== canonicalStringify(reportVersionIds)) {
      fail('Canonical Worldview coverage must include every frozen ReportVersion in order', 'WORLDVIEW_REPORT_COVERAGE_INCOMPLETE');
    }
    const reads = selectedFullReads.map((item) => item.reportVersionId);
    if (canonicalStringify(packageValue.coverage.selectedFullReadReportVersionIds) !== canonicalStringify(reads)) {
      fail('Canonical Worldview selected full-read coverage does not match the capability trace', 'WORLDVIEW_FULL_READ_COVERAGE_MISMATCH');
    }
    const readDigests = new Map(selectedFullReads.map((item) => [item.reportVersionId, item.contentDigest]));
    if (readDigests.size < 1) {
      fail('Canonical Worldview UPDATE evidence is unread or unverified because no exact ReportVersion full read was recorded', 'WORLDVIEW_EXACT_EVIDENCE_REQUIRED');
    }
    const directRefs = [
      ...packageValue.evidence,
      ...packageValue.counterEvidence,
      ...packageValue.causalRelationships.flatMap((item) => [...item.evidence, ...item.counterEvidence]),
    ];
    for (const reference of directRefs) {
      if (readDigests.get(reference.reportVersionId) !== reference.contentDigest) {
        fail(
          `Direct Worldview evidence references unread or unverified ReportVersion ${reference.reportVersionId}`,
          'WORLDVIEW_UNREAD_EVIDENCE_REFERENCE',
        );
      }
    }
  }
  return deepFreeze(normalized);
}

export function worldviewOverviewManifest(items) {
  if (!Array.isArray(items) || !items.length) fail('Worldview Overview manifest requires at least one item');
  const normalizedItems = items.map((item, index) => {
    exactKeys(item, [
      'ordinal', 'admissionSequence', 'reportVersionId', 'contentDigest', 'fingerprint', 'overviewId',
      'overviewDigest', 'overviewContentDigest', 'overview',
    ], [], `manifest.items[${index}]`);
    if (!Number.isInteger(item.ordinal) || item.ordinal !== index) fail(`manifest.items[${index}].ordinal is invalid`);
    if (!Number.isInteger(item.admissionSequence) || item.admissionSequence < 1) fail(`manifest.items[${index}].admissionSequence is invalid`);
    object(item.overview, `manifest.items[${index}].overview`);
    return {
      ordinal: item.ordinal,
      admissionSequence: item.admissionSequence,
      reportVersionId: canonicalWorldviewSafeId(item.reportVersionId, `manifest.items[${index}].reportVersionId`),
      contentDigest: canonicalWorldviewDigest(item.contentDigest, `manifest.items[${index}].contentDigest`),
      fingerprint: canonicalWorldviewDigest(item.fingerprint, `manifest.items[${index}].fingerprint`),
      overviewId: canonicalWorldviewSafeId(item.overviewId, `manifest.items[${index}].overviewId`),
      overviewDigest: canonicalWorldviewDigest(item.overviewDigest, `manifest.items[${index}].overviewDigest`),
      overviewContentDigest: canonicalWorldviewDigest(item.overviewContentDigest, `manifest.items[${index}].overviewContentDigest`),
      overview: structuredClone(item.overview),
    };
  });
  const manifestDigest = canonicalSha256(normalizedItems);
  return deepFreeze({
    contract: WORLDVIEW_OVERVIEW_MANIFEST_CONTRACT,
    items: normalizedItems,
    manifestDigest,
  });
}

export function canonicalDocumentDigest(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function canonicalPackageDigest(manifestWithoutDigest, documents) {
  const hash = createHash('sha256');
  hash.update(Buffer.from(canonicalStringify(manifestWithoutDigest), 'utf8'));
  for (const document of [...documents].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(Buffer.from('\u0000', 'utf8'));
    hash.update(Buffer.from(document.path, 'utf8'));
    hash.update(Buffer.from('\u0000', 'utf8'));
    hash.update(Buffer.isBuffer(document.bytes) ? document.bytes : Buffer.from(document.bytes, 'utf8'));
  }
  return `sha256:${hash.digest('hex')}`;
}
