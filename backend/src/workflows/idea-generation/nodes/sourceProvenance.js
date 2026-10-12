import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';

export const IDEA_SOURCE_CALL_PROVENANCE_SCHEMA_VERSION = 'idea-source-call-provenance.v1';

const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SENSITIVE_ARGUMENT_FIELD = /(?:api.?key|authorization|bearer|cookie|credential|endpoint|password|provider.?payload|raw.?payload|secret|token)/iu;
const SENSITIVE_QUERY_VALUE = /(?:\b(?:Basic|Bearer)\s+\S+|(?:api.?key|authorization|cookie|credential|endpoint|password|secret|token)\s*[:=]|https?:\/\/|sk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
const OBSERVED_TIME_FIELDS = Object.freeze([
  'observedAt',
  'observed_at',
  'updatedAt',
  'updated_at',
  'lastUpdated',
  'last_updated',
  'timestamp',
]);
const PUBLISHED_TIME_FIELDS = Object.freeze([
  'publishedAt',
  'published_at',
  'publishedDate',
  'published_date',
  'datetime',
  'date',
]);
const FETCHED_TIME_FIELDS = Object.freeze([
  'fetchedAt',
  'fetched_at',
  'collectedAt',
  'collected_at',
]);
const RESULT_CONTAINER_FIELDS = Object.freeze([
  'data',
  'events',
  'ideas',
  'items',
  'movers',
  'news',
  'quotes',
  'results',
  'sectors',
]);

function assertText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function isoTimestamp(value) {
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function nowTimestamp(now) {
  if (typeof now !== 'function') throw new TypeError('source provenance clock must be a function');
  const value = isoTimestamp(now());
  if (value === null) throw new TypeError('source provenance clock must return a timestamp');
  return value;
}

function timestampFromResult(value, fields, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const timestamp = timestampFromResult(item, fields, depth + 1);
      if (timestamp !== null) return timestamp;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const field of fields) {
    const timestamp = isoTimestamp(value[field]);
    if (timestamp !== null) return timestamp;
  }
  for (const field of RESULT_CONTAINER_FIELDS) {
    const timestamp = timestampFromResult(value[field], fields, depth + 1);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function digestValue(value) {
  return canonicalSha256(value === undefined ? null : value);
}

function safeArgumentProjection(value) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(safeArgumentProjection);
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value)
    .filter(([field]) => !SENSITIVE_ARGUMENT_FIELD.test(field))
    .map(([field, child]) => [field, safeArgumentProjection(child)]));
}

function safeQueryProjection(args) {
  const value = typeof args?.query === 'string'
    ? args.query.replace(/\s+/gu, ' ').trim()
    : '';
  if (!value || SENSITIVE_QUERY_VALUE.test(value)) return null;
  return value.slice(0, 512);
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

function optionalTimestamp(value, label) {
  if (value === null) return null;
  const timestamp = isoTimestamp(value);
  if (timestamp === null) throw new TypeError(`${label} must be a timestamp or null`);
  return timestamp;
}

export function redactSourceError(error) {
  const requestedCode = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'SOURCE_CALL_FAILED';
  return {
    category: 'source-call-failed',
    code: requestedCode,
  };
}

function reportedSourceError(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const reported = reportedSourceError(item);
      if (reported !== null) return reported;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.error !== undefined && value.error !== null && value.error !== '') {
    if (typeof value.error === 'object') return value.error;
    return { code: 'SOURCE_REPORTED_ERROR' };
  }
  return null;
}

export async function captureSourceCall({
  callId,
  source,
  provider = source,
  args = {},
  execute,
  fallback,
  normalize = (value) => value,
  now = () => new Date().toISOString(),
} = {}) {
  assertText(callId, 'source provenance callId');
  assertText(source, 'source provenance source');
  assertText(provider, 'source provenance provider');
  if (typeof execute !== 'function') throw new TypeError('source provenance execute must be a function');
  if (typeof fallback !== 'function') throw new TypeError('source provenance fallback must be a function');
  if (typeof normalize !== 'function') throw new TypeError('source provenance normalize must be a function');

  const startedAt = nowTimestamp(now);
  let value;
  let status = 'succeeded';
  let error = null;
  try {
    value = await execute();
  } catch (cause) {
    value = fallback();
    status = 'failed';
    error = redactSourceError(cause);
  }
  const reportedError = reportedSourceError(value);
  if (status === 'succeeded' && reportedError !== null) {
    status = 'failed';
    error = redactSourceError(reportedError);
  }
  const completedAt = nowTimestamp(now);
  const normalized = normalize(value);
  return {
    value,
    provenance: {
      schemaVersion: IDEA_SOURCE_CALL_PROVENANCE_SCHEMA_VERSION,
      callId,
      source,
      provider,
      query: safeQueryProjection(args),
      argsDigest: digestValue(safeArgumentProjection(args)),
      observedAt: timestampFromResult(value, OBSERVED_TIME_FIELDS),
      publishedAt: timestampFromResult(value, PUBLISHED_TIME_FIELDS),
      fetchedAt: timestampFromResult(value, FETCHED_TIME_FIELDS) || completedAt,
      startedAt,
      completedAt,
      status,
      error,
      rawDigest: digestValue(value),
      normalizedDigest: digestValue(normalized),
    },
  };
}

export function failedSourceNodeProvenance({
  callId,
  source,
  provider = source,
  args = {},
  error,
  now = () => new Date().toISOString(),
} = {}) {
  const timestamp = nowTimestamp(now);
  return {
    schemaVersion: IDEA_SOURCE_CALL_PROVENANCE_SCHEMA_VERSION,
    callId: assertText(callId, 'source provenance callId'),
    source: assertText(source, 'source provenance source'),
    provider: assertText(provider, 'source provenance provider'),
    query: safeQueryProjection(args),
    argsDigest: digestValue(safeArgumentProjection(args)),
    observedAt: null,
    publishedAt: null,
    fetchedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    status: 'failed',
    error: redactSourceError(error),
    rawDigest: digestValue(null),
    normalizedDigest: digestValue(null),
  };
}

export function bindSourceCallProvenance(calls, {
  runId,
  nodeId,
  snapshotId,
  asOf,
} = {}) {
  if (!Array.isArray(calls)) throw new TypeError('source provenance calls must be an array');
  return calls.map((call, index) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) {
      throw new TypeError(`source provenance calls[${index}] must be an object`);
    }
    if (call.schemaVersion !== IDEA_SOURCE_CALL_PROVENANCE_SCHEMA_VERSION) {
      throw new TypeError(`source provenance calls[${index}] has an unsupported schema`);
    }
    if (!['succeeded', 'failed'].includes(call.status)) {
      throw new TypeError(`source provenance calls[${index}] has an invalid status`);
    }
    return {
      schemaVersion: IDEA_SOURCE_CALL_PROVENANCE_SCHEMA_VERSION,
      callId: assertText(call.callId, `source provenance calls[${index}].callId`),
      source: assertText(call.source, `source provenance calls[${index}].source`),
      provider: assertText(call.provider, `source provenance calls[${index}].provider`),
      query: call.query === null || call.query === undefined
        ? null
        : assertText(call.query, `source provenance calls[${index}].query`),
      argsDigest: assertDigest(
        call.argsDigest,
        `source provenance calls[${index}].argsDigest`,
      ),
      observedAt: optionalTimestamp(
        call.observedAt,
        `source provenance calls[${index}].observedAt`,
      ),
      publishedAt: optionalTimestamp(
        call.publishedAt,
        `source provenance calls[${index}].publishedAt`,
      ),
      fetchedAt: optionalTimestamp(
        call.fetchedAt,
        `source provenance calls[${index}].fetchedAt`,
      ),
      startedAt: optionalTimestamp(
        call.startedAt,
        `source provenance calls[${index}].startedAt`,
      ),
      completedAt: optionalTimestamp(
        call.completedAt,
        `source provenance calls[${index}].completedAt`,
      ),
      status: call.status,
      error: call.status === 'failed' ? redactSourceError(call.error) : null,
      rawDigest: assertDigest(
        call.rawDigest,
        `source provenance calls[${index}].rawDigest`,
      ),
      normalizedDigest: assertDigest(
        call.normalizedDigest,
        `source provenance calls[${index}].normalizedDigest`,
      ),
      runId: assertText(runId, 'source provenance runId'),
      nodeId: assertText(nodeId, 'source provenance nodeId'),
      snapshotId: assertText(snapshotId, 'source provenance snapshotId'),
      asOf: assertText(asOf, 'source provenance asOf'),
    };
  });
}
