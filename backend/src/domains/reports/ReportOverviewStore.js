import fs from 'node:fs';
import path from 'node:path';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';
import { atomicCreateFileSync, withFileLockSync } from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import { safePublicFailure } from './safeFailure.js';
import { cloneReportValue, createReportValidators } from './reportValidation.js';
import {
  REPORT_OVERVIEW_CONTRACT,
  normalizeReportOverviewContent,
  reportOverviewContentDigest,
  reportOverviewId,
} from './reportContracts.js';

export const REPORT_OVERVIEW_STATUS = Object.freeze({
  MISSING: 'missing',
  FAILED: 'failed',
  READY: 'ready',
});

function fail(message, code = 'REPORT_OVERVIEW_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

const clone = cloneReportValue;
const { safeId, digest, iso } = createReportValidators({
  fail,
  unsafeIdCode: 'REPORT_OVERVIEW_UNSAFE_ID',
  invalidDigestCode: 'REPORT_OVERVIEW_INVALID_DIGEST',
  invalidTimestampCode: 'REPORT_OVERVIEW_INVALID_TIMESTAMP',
});


function overviewDir(rootDir, reportVersionId) {
  return path.join(rootDir, 'reports', reportVersionId, 'overview');
}

function overviewFile(rootDir, reportVersionId) {
  return path.join(overviewDir(rootDir, reportVersionId), 'report-overview.json');
}

function attemptsDir(rootDir, reportVersionId) {
  return path.join(overviewDir(rootDir, reportVersionId), 'attempts');
}

function attemptFile(rootDir, reportVersionId, attemptId) {
  const name = `attempt_${canonicalSha256({ attemptId }).slice('sha256:'.length)}.json`;
  return path.join(attemptsDir(rootDir, reportVersionId), name);
}

function ensureTree(rootDir, reportVersionId) {
  const reports = path.join(rootDir, 'reports');
  ensureOwnedStorageDirectory(rootDir, 'Report Library root', { create: true, recursive: true });
  ensureOwnedStorageDirectory(reports, 'Report Library reports directory', { create: true });
  ensureOwnedStorageDirectory(path.join(reports, reportVersionId), 'ReportVersion directory', { create: false });
  ensureOwnedStorageDirectory(overviewDir(rootDir, reportVersionId), 'Report Overview directory', { create: true });
  ensureOwnedStorageDirectory(attemptsDir(rootDir, reportVersionId), 'Report Overview attempts directory', { create: true });
}

function safeReadJson(file, label) {
  assertOwnedStorageFile(file, label, { allowMissing: false });
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is corrupt`, 'REPORT_OVERVIEW_CORRUPT');
  }
}

function reportIdentity(reportVersion) {
  const reportVersionId = safeId(reportVersion?.reportVersionId || reportVersion?.id, 'reportVersionId');
  return {
    reportVersionId,
    contentDigest: digest(reportVersion?.contentDigest, 'ReportVersion contentDigest'),
    fingerprint: digest(reportVersion?.fingerprint, 'ReportVersion fingerprint'),
  };
}

function safeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return {};
  return Object.fromEntries(Object.entries(metrics)
    .filter(([key, value]) => /^[A-Za-z0-9_.:-]{1,80}$/u.test(key) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))
    .slice(0, 32));
}

function normalizeProvenance(value = {}) {
  return {
    agentId: safeId(value.agentId || 'report-overview', 'provenance.agentId'),
    agentVersion: String(value.agentVersion || '1.0.0').slice(0, 40),
    effectiveConfigDigest: digest(value.effectiveConfigDigest, 'provenance.effectiveConfigDigest'),
    provider: String(value.provider || 'unreported').slice(0, 120),
    model: String(value.model || 'unreported').slice(0, 160),
    live: Boolean(value.live),
    traceRef: value.traceRef == null ? null : String(value.traceRef).slice(0, 300),
    stopReason: value.stopReason == null ? null : String(value.stopReason).slice(0, 120),
    metrics: safeMetrics(value.metrics),
  };
}

function comparableOverview(record) {
  return {
    contract: record.contract,
    reportVersion: record.reportVersion,
    content: record.content,
  };
}

function digestOverview(record) {
  const projection = comparableOverview(record);
  // Pre-Issue-40 records remain readable without carrying this retired
  // designation into newly prepared private Overview records.
  if (Object.hasOwn(record, 'authority')) projection.authority = record.authority;
  return projection;
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value || {});
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function validateOverview(record, reportVersion) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.contract !== REPORT_OVERVIEW_CONTRACT) {
    fail('Report Overview record is invalid', 'REPORT_OVERVIEW_CORRUPT');
  }
  if (!hasExactKeys(record, [
    'contract', 'overviewId', 'reportVersion', 'content', 'contentDigest', 'provenance',
    'producedAt', 'overviewDigest',
  ], ['authority'])) {
    fail('Report Overview record has fields outside its closed contract', 'REPORT_OVERVIEW_CORRUPT');
  }
  const identity = reportIdentity(reportVersion);
  if (canonicalStringify(record.reportVersion) !== canonicalStringify(identity)) {
    fail('Report Overview is bound to a different ReportVersion', 'REPORT_OVERVIEW_BINDING_MISMATCH', 409);
  }
  const content = normalizeReportOverviewContent({
    reportVersionId: identity.reportVersionId,
    contentDigest: identity.contentDigest,
    ...record.content,
  });
  const expectedId = reportOverviewId(identity);
  if (record.overviewId !== expectedId) fail('Report Overview identity mismatch', 'REPORT_OVERVIEW_CORRUPT');
  if (Object.hasOwn(record, 'authority') && canonicalStringify(record.authority) !== canonicalStringify({
    kind: 'discovery-only',
    reportVersionEvidenceAuthority: false,
  })) {
    fail('Report Overview legacy authority designation is invalid', 'REPORT_OVERVIEW_CORRUPT');
  }
  const expectedDigest = canonicalSha256({
    ...digestOverview(record),
    overviewId: record.overviewId,
    contentDigest: record.contentDigest,
    provenance: record.provenance,
    producedAt: record.producedAt,
  });
  if (record.overviewDigest !== expectedDigest) fail('Report Overview digest mismatch', 'REPORT_OVERVIEW_CORRUPT');
  if (reportOverviewContentDigest(content) !== record.contentDigest) fail('Report Overview content digest mismatch', 'REPORT_OVERVIEW_CORRUPT');
  iso(record.producedAt, 'Report Overview producedAt');
  if (canonicalStringify(normalizeProvenance(record.provenance)) !== canonicalStringify(record.provenance)) {
    fail('Report Overview provenance is outside its closed contract', 'REPORT_OVERVIEW_CORRUPT');
  }
  return record;
}

function readAttempts(rootDir, reportVersionId) {
  const root = attemptsDir(rootDir, reportVersionId);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith('.json'))
    .map((name) => safeReadJson(path.join(root, name), `Report Overview attempt ${name}`))
    .sort((left, right) => String(left.completedAt || '').localeCompare(String(right.completedAt || ''))
      || String(left.attemptId || '').localeCompare(String(right.attemptId || '')));
}

export class ReportOverviewStore {
  constructor({ rootDir, now = () => new Date().toISOString() } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('ReportOverviewStore rootDir is required');
    if (typeof now !== 'function') throw new TypeError('ReportOverviewStore now must be a function');
    this.rootDir = path.resolve(rootDir);
    this.lockPath = path.join(this.rootDir, '.locks', 'overviews.lock');
    this.now = now;
    ensureOwnedStorageDirectory(this.rootDir, 'Report Library root', { create: true, recursive: true });
    ensureOwnedStorageDirectory(path.dirname(this.lockPath), 'Report Overview lock directory', { create: true });
    assertStorageLockBoundary(this.lockPath, 'Report Overview lock');
  }

  get(reportVersion) {
    const identity = reportIdentity(reportVersion);
    const file = overviewFile(this.rootDir, identity.reportVersionId);
    if (!fs.existsSync(file)) return null;
    return deepFreeze(clone(validateOverview(safeReadJson(file, 'Report Overview'), reportVersion)));
  }

  status(reportVersion) {
    const ready = this.get(reportVersion);
    if (ready) {
      return deepFreeze({
        status: REPORT_OVERVIEW_STATUS.READY,
        ready: true,
        overviewId: ready.overviewId,
        overviewDigest: ready.overviewDigest,
        producedAt: ready.producedAt,
        error: null,
      });
    }
    const identity = reportIdentity(reportVersion);
    const attempts = readAttempts(this.rootDir, identity.reportVersionId);
    const latest = attempts.at(-1) || null;
    if (latest?.status === 'failed') {
      return deepFreeze({
        status: REPORT_OVERVIEW_STATUS.FAILED,
        ready: false,
        overviewId: null,
        overviewDigest: null,
        producedAt: null,
        error: clone(latest.error),
        failedAt: latest.completedAt,
      });
    }
    return deepFreeze({
      status: REPORT_OVERVIEW_STATUS.MISSING,
      ready: false,
      overviewId: null,
      overviewDigest: null,
      producedAt: null,
      error: null,
    });
  }

  commit({ reportVersion, content: contentInput, provenance: provenanceInput, producedAt = this.now(), attemptId = 'initial' } = {}) {
    const identity = reportIdentity(reportVersion);
    const content = normalizeReportOverviewContent(contentInput);
    if (content.reportVersionId !== identity.reportVersionId || content.contentDigest !== identity.contentDigest) {
      fail('Report Overview content binding does not match ReportVersion', 'REPORT_OVERVIEW_BINDING_MISMATCH', 409);
    }
    const provenance = normalizeProvenance(provenanceInput);
    const timestamp = iso(producedAt, 'Report Overview producedAt');
    const overviewIdValue = reportOverviewId(identity);
    const recordWithoutDigest = {
      contract: REPORT_OVERVIEW_CONTRACT,
      overviewId: overviewIdValue,
      reportVersion: identity,
      content: {
        summary: content.summary,
        keyThemes: clone(content.keyThemes),
        entities: clone(content.entities),
        materialDevelopments: clone(content.materialDevelopments),
        uncertainties: clone(content.uncertainties),
      },
      contentDigest: reportOverviewContentDigest(content),
      provenance,
      producedAt: timestamp,
    };
    const record = {
      ...recordWithoutDigest,
      overviewDigest: canonicalSha256(recordWithoutDigest),
    };
    return withFileLockSync(this.lockPath, () => {
      ensureTree(this.rootDir, identity.reportVersionId);
      const file = overviewFile(this.rootDir, identity.reportVersionId);
      if (fs.existsSync(file)) {
        const existing = validateOverview(safeReadJson(file, 'Report Overview'), reportVersion);
        if (canonicalStringify(comparableOverview(existing)) !== canonicalStringify(comparableOverview(record))) {
          fail('Report Overview idempotency conflict', 'REPORT_OVERVIEW_IDEMPOTENCY_CONFLICT', 409);
        }
        return deepFreeze({ status: 'ready', created: false, replayed: true, overview: clone(existing), ...this.status(reportVersion) });
      }
      atomicCreateFileSync(file, `${canonicalStringify(record)}\n`);
      this.#writeAttempt(identity, attemptId, {
        status: 'succeeded',
        overviewId: record.overviewId,
        overviewDigest: record.overviewDigest,
        completedAt: timestamp,
        provenance,
        error: null,
      });
      return deepFreeze({ status: 'ready', created: true, replayed: false, overview: clone(record), ...this.status(reportVersion) });
    });
  }

  recordFailure({ reportVersion, attemptId = 'initial', error, provenance = null, failedAt = this.now() } = {}) {
    const identity = reportIdentity(reportVersion);
    const timestamp = iso(failedAt, 'Report Overview failedAt');
    return withFileLockSync(this.lockPath, () => {
      ensureTree(this.rootDir, identity.reportVersionId);
      this.#writeAttempt(identity, attemptId, {
        status: 'failed',
        overviewId: null,
        overviewDigest: null,
        completedAt: timestamp,
        provenance: provenance ? normalizeProvenance(provenance) : null,
        error: safePublicFailure(error, { fallbackCode: 'REPORT_OVERVIEW_PRODUCTION_FAILED', fallbackMessage: 'Report Overview production failed' }),
      });
      return this.status(reportVersion);
    });
  }

  attempts(reportVersion) {
    const identity = reportIdentity(reportVersion);
    return deepFreeze(readAttempts(this.rootDir, identity.reportVersionId).map(clone));
  }

  #writeAttempt(identity, attemptId, value) {
    const normalizedAttemptId = safeId(attemptId, 'Report Overview attemptId');
    const file = attemptFile(this.rootDir, identity.reportVersionId, normalizedAttemptId);
    const record = {
      contract: 'report-overview-attempt.v1',
      attemptId: normalizedAttemptId,
      reportVersion: identity,
      ...value,
    };
    if (fs.existsSync(file)) {
      const existing = safeReadJson(file, 'Report Overview attempt');
      if (canonicalStringify(existing) !== canonicalStringify(record)) {
        fail('Report Overview attempt idempotency conflict', 'REPORT_OVERVIEW_ATTEMPT_CONFLICT', 409);
      }
      return existing;
    }
    atomicCreateFileSync(file, `${canonicalStringify(record)}\n`);
    return record;
  }
}

export const createReportOverviewStore = (options = {}) => new ReportOverviewStore(options);
