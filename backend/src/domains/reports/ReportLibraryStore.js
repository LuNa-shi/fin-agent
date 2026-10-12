import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORT_VERSION_CONTRACT,
  normalizeInternalReportPackage,
  reportIngestionId,
  reportLogicalIdentity,
  reportVersionFingerprint,
  reportVersionId,
} from './reportContracts.js';
import {
  REPORT_LIBRARY_EVENT_TYPES,
  ReportLibraryEventStore,
  reportLibraryEventId,
} from './ReportLibraryEventStore.js';
import {
  REPORT_ADMISSION_CANDIDATE_STATES,
  ReportAdmissionStore,
} from './ReportAdmissionStore.js';
import { ReportOverviewStore } from './ReportOverviewStore.js';
import { safePublicFailure } from './safeFailure.js';
import {
  atomicCreateFileSync,
  atomicWriteFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../../core/contracts/ArtifactRef.js';

export const REPORT_LIBRARY_SCHEMA_VERSION = 'report-library.v1';
export const REPORT_LIBRARY_INDEX_SCHEMA_VERSION = 'report-library-index.v1';
export const REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION = 'report-library-ticker-timelines.v1';
export const REPORT_LIBRARY_INGESTION_SCHEMA_VERSION = 'report-library-ingestions.v1';
export const REPORT_LIBRARY_STATUS_SCHEMA_VERSION = 'report-library-status.v1';
export const REPORT_LIBRARY_PROJECTION_SCHEMA_VERSION = 'report-library-projection.v1';
export const REPORT_LIBRARY_STORE_SCOPE = 'report-library';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_TICKER_RE = /^[A-Z0-9][A-Z0-9._:-]{0,31}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTENT_ROOT = 'objects/sha256';
const REPORT_PACKAGE_CONTRACT = 'internal-run-analysis-report-package.v1';
const REPORTS_ROOT = 'reports';
const PROJECTIONS_ROOT = 'projections';
const INGESTIONS_ROOT = 'ingestions';
const LOCKS_ROOT = '.locks';
const STORE_LOCK_NAME = 'store.lock';
const PROJECTION_LOCK_NAME = 'projections.lock';
const REPORT_ANCHOR_NAME = 'report-version.json';
const INDEX_NAME = 'reports.json';
const TIMELINE_INDEX_NAME = 'ticker-timelines.json';
const INGESTION_INDEX_NAME = 'ingestions.json';
const STATUS_NAME = 'status.json';

function storeError(message, code = 'REPORT_LIBRARY_ERROR', statusCode = 500, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function fail(message, code = 'REPORT_LIBRARY_ERROR', statusCode = 500, options = {}) {
  throw storeError(message, code, statusCode, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeId(value, field = 'id') {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    fail(`${field} is unsafe`, 'REPORT_LIBRARY_UNSAFE_ID', 400);
  }
  return value;
}

function assertTicker(value) {
  if (typeof value !== 'string') fail('ticker is required', 'REPORT_LIBRARY_INVALID_TICKER', 400);
  const ticker = value.trim().toUpperCase();
  if (!SAFE_TICKER_RE.test(ticker)) fail('ticker is unsafe', 'REPORT_LIBRARY_INVALID_TICKER', 400);
  return ticker;
}

function assertDigest(value, field = 'digest') {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail(`${field} must be a sha256 digest`, 'REPORT_LIBRARY_INVALID_DIGEST', 400);
  }
  return value;
}

function assertIso(value, field) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be a canonical ISO timestamp`, 'REPORT_LIBRARY_INVALID_TIMESTAMP', 400);
  }
  return value;
}

function assertRelativePath(value, field) {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || value.includes('\u0000')
    || path.posix.isAbsolute(value)
  ) fail(`${field} is unsafe`, 'REPORT_LIBRARY_UNSAFE_PATH', 400);
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized.split('/').some((part) => !part || part === '..' || part === '.')
  ) fail(`${field} is unsafe`, 'REPORT_LIBRARY_UNSAFE_PATH', 400);
  return normalized;
}

function assertInside(root, target, code = 'REPORT_LIBRARY_PATH_OUTSIDE_ROOT') {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('Report Library path escapes its configured root', code, 400);
  }
}

function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digestHex(digest) {
  return assertDigest(digest, 'contentDigest').slice('sha256:'.length);
}

function clone(value) {
  return structuredClone(value);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`${label} is corrupt`, 'REPORT_LIBRARY_CORRUPT_JSON', 500, { cause: error });
  }
}

function readRequiredJson(file, label) {
  const value = readJson(file, label);
  if (value === null) fail(`${label} is missing`, 'REPORT_LIBRARY_NOT_FOUND', 404);
  return value;
}

function safeReadJson(file, label) {
  assertOwnedStorageFile(file, label, { allowMissing: false });
  return readRequiredJson(file, label);
}

function writeJson(file, value) {
  atomicWriteFileSync(file, `${canonicalStringify(value)}\n`);
}

function createDirectory(root, segments = []) {
  let current = path.resolve(root);
  ensureOwnedStorageDirectory(current, 'Report Library root', { create: true, recursive: true });
  for (const segment of segments) {
    assertRelativePath(segment, 'storage directory');
    current = path.join(current, segment);
    assertInside(root, current);
    ensureOwnedStorageDirectory(current, `Report Library directory ${segment}`, { create: true });
  }
  return current;
}

function defaultRoot() {
  const configured = String(process.env.REPORT_LIBRARY_DIR || '').trim();
  if (configured) return path.resolve(configured);
  const dataDir = String(process.env.FIN_DATA_DIR || '').trim();
  if (dataDir) return path.join(path.resolve(dataDir), 'report-library');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/report-library');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReportEntries(left, right) {
  return compareText(left.asOf || '', right.asOf || '')
    || compareText(left.generatedAt || '', right.generatedAt || '')
    || compareText(left.id, right.id);
}

function compareTimelineReports(left, right) {
  return compareText(left.asOf || '', right.asOf || '')
    || compareText(left.generatedAt || '', right.generatedAt || '')
    || compareText(left.reportVersionId, right.reportVersionId);
}

function parseLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 1000);
}

function cursorOffset(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (!/^\d+$/u.test(String(cursor))) fail('cursor is invalid', 'REPORT_LIBRARY_INVALID_CURSOR', 400);
  return Number(cursor);
}

function paginate(items, { limit = 100, cursor = null } = {}) {
  const offset = cursorOffset(cursor);
  const pageSize = parseLimit(limit);
  const page = items.slice(offset, offset + pageSize);
  return {
    items: page,
    nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
  };
}

function digestProjection(schemaVersion, entries) {
  return canonicalSha256({ schemaVersion, entries });
}

function reportContentObjectPath(root, digest) {
  return path.join(root, ...CONTENT_ROOT.split('/'), digestHex(digest));
}

function reportAnchorPath(root, id) {
  return path.join(root, REPORTS_ROOT, id, REPORT_ANCHOR_NAME);
}

function ingestionPath(root, id) {
  return path.join(root, INGESTIONS_ROOT, `${id}.json`);
}

function normalizeSource(source) {
  const value = String(source || 'producer').trim().toLowerCase();
  if (!['producer', 'backfill'].includes(value)) {
    fail('ingestion source must be producer or backfill', 'REPORT_LIBRARY_INVALID_SOURCE', 400);
  }
  return value;
}

function publicIngestionEntry(record) {
  if (!isPlainObject(record)) fail('ingestion entry is invalid', 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  const id = assertSafeId(record.id, 'ingestion id');
  const ingestionId = assertSafeId(record.ingestionId, 'ingestion ingestionId');
  if (id !== ingestionId) fail('ingestion identity is inconsistent', 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  const common = {
    schemaVersion: 'report-library-ingestion.v1',
    id,
    ingestionId,
    status: record.status,
    source: normalizeSource(record.source),
  };
  if (record.status === 'failed') {
    return {
      ...common,
      projectId: assertSafeId(record.projectId, 'ingestion projectId'),
      analysisRunId: assertSafeId(record.analysisRunId, 'ingestion analysisRunId'),
      error: safePublicFailure(record.error, {
        fallbackCode: 'REPORT_LIBRARY_INGESTION_FAILED',
        fallbackMessage: 'Report Library ingestion failed',
      }),
      failedAt: assertIso(record.failedAt, 'ingestion failedAt'),
    };
  }
  if (record.status !== 'admitted' || !Number.isInteger(record.admissionSequence) || record.admissionSequence < 1) {
    fail('ingestion status or admission sequence is invalid', 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  }
  return {
    ...common,
    reportVersionId: assertSafeId(record.reportVersionId, 'ingestion reportVersionId'),
    contentDigest: assertDigest(record.contentDigest, 'ingestion contentDigest'),
    logicalIdentity: assertDigest(record.logicalIdentity, 'ingestion logicalIdentity'),
    admittedAt: assertIso(record.admittedAt, 'ingestion admittedAt'),
    admissionSequence: record.admissionSequence,
  };
}

function ingestionFailureEventInput(record) {
  const safeRecord = publicIngestionEntry(record);
  if (safeRecord.status !== 'failed') {
    fail('ingestion failure event requires a failed ingestion', 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  }
  const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.INGESTION_FAILED, {
    ingestionId: safeRecord.ingestionId,
    projectId: safeRecord.projectId,
    analysisRunId: safeRecord.analysisRunId,
  });
  return {
    eventId,
    eventType: REPORT_LIBRARY_EVENT_TYPES.INGESTION_FAILED,
    correlationId: safeRecord.ingestionId,
    causationId: null,
    runId: safeRecord.analysisRunId,
    payload: {
      ingestionId: safeRecord.ingestionId,
      projectId: safeRecord.projectId,
      analysisRunId: safeRecord.analysisRunId,
      source: safeRecord.source,
      error: clone(safeRecord.error),
    },
  };
}

function comparableIngestionFailureEvent(event) {
  if (!isPlainObject(event) || !isPlainObject(event.payload)
    || !Object.prototype.hasOwnProperty.call(event.payload, 'error')) {
    return null;
  }
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    correlationId: event.correlationId,
    causationId: event.causationId,
    runId: event.runId,
    payload: {
      ingestionId: event.payload.ingestionId,
      projectId: event.payload.projectId,
      analysisRunId: event.payload.analysisRunId,
      source: event.payload.source,
      error: safePublicFailure(event.payload.error, {
        fallbackCode: 'REPORT_LIBRARY_INGESTION_FAILED',
        fallbackMessage: 'Report Library ingestion failed',
      }),
    },
  };
}

function compactProducer(producer) {
  return {
    type: producer.type,
    workflow: clone(producer.workflow),
  };
}

function compactReportRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const result = {
    contract: ref.contract,
    artifactId: ref.artifactId,
    version: ref.version,
    contentDigest: ref.contentDigest,
    schemaVersion: ref.schemaVersion,
    producer: ref.producer,
    contractVersion: ref.contractVersion,
    inputDigest: ref.inputDigest,
    createdAt: ref.createdAt,
    asOf: ref.asOf,
  };
  // The producer path is provenance metadata, not a filesystem authority. It is
  // intentionally omitted from public projections.
  return result;
}

function worldviewReadiness(overview, processedReceipt = null) {
  const ready = overview?.status === 'ready';
  const processed = ready && processedReceipt !== null;
  return {
    status: !ready ? 'not-ready' : processed ? 'processed' : 'pending',
    eligible: ready,
    pending: ready && !processed,
    processed,
    processedReceipt: processed ? clone(processedReceipt) : null,
  };
}

function compactReportVersion(anchor, { overview = null, admissionSequence = null, processedReceipt = null } = {}) {
  const overviewStatus = overview || {
    status: 'missing', ready: false, overviewId: null, overviewDigest: null, producedAt: null, error: null,
  };
  return {
    id: anchor.id,
    reportVersionId: anchor.id,
    schemaVersion: anchor.schemaVersion,
    origin: anchor.origin,
    contentDigest: anchor.contentDigest,
    title: anchor.metadata.title,
    tickers: [...anchor.metadata.tickers],
    theme: anchor.metadata.theme,
    searchTags: [...anchor.metadata.searchTags],
    asOf: anchor.metadata.asOf,
    generatedAt: anchor.metadata.generatedAt,
    producer: compactProducer(anchor.producer),
    lineage: clone(anchor.lineage),
    dailyReport: clone(anchor.dailyReport),
    admission: anchor.admission ? clone(anchor.admission) : null,
    admissionSequence,
    overview: clone(overviewStatus),
    worldview: worldviewReadiness(overviewStatus, processedReceipt),
    ingestion: {
      id: anchor.ingestion.id,
      source: anchor.ingestion.source,
      admittedAt: anchor.ingestion.admittedAt,
      admissionSequence,
    },
  };
}

function publicReportVersion(projection) {
  const value = clone(projection);
  const processingStatus = value.worldview?.processed === true ? 'Processed' : 'Pending';
  delete value.overview;
  delete value.worldview;
  return { ...value, processingStatus };
}

function detailReportVersion(anchor, projection = {}) {
  return {
    ...compactReportVersion(anchor, projection),
    mediaType: anchor.report.mediaType,
    charset: anchor.report.charset,
    byteLength: anchor.report.byteLength,
    producer: {
      ...compactProducer(anchor.producer),
      reportRef: compactReportRef(anchor.producer.reportRef),
    },
    reportRef: compactReportRef(anchor.producer.reportRef),
    logicalIdentity: anchor.logicalIdentity,
    fingerprint: anchor.fingerprint,
    ingestion: {
      ...clone(anchor.ingestion),
      admissionSequence: projection.admissionSequence ?? null,
    },
  };
}

function timelineEntry(report) {
  return {
    reportVersionId: report.id,
    id: report.id,
    contentDigest: report.contentDigest,
    asOf: report.asOf,
    generatedAt: report.generatedAt,
    title: report.title,
    theme: report.theme,
    processingStatus: report.worldview?.processed === true ? 'Processed' : 'Pending',
  };
}

function validateAnchor(anchor, { markdown = null } = {}) {
  if (!isPlainObject(anchor)) fail('report anchor must be an object', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  for (const field of ['id', 'schemaVersion', 'origin', 'contentDigest', 'logicalIdentity', 'fingerprint', 'producer', 'lineage', 'dailyReport', 'report', 'metadata', 'ingestion']) {
    if (!Object.prototype.hasOwnProperty.call(anchor, field)) fail(`report anchor requires ${field}`, 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  }
  assertSafeId(anchor.id, 'report anchor id');
  if (anchor.schemaVersion !== REPORT_VERSION_CONTRACT) fail('unsupported report anchor schema', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  assertDigest(anchor.contentDigest, 'report anchor contentDigest');
  assertDigest(anchor.logicalIdentity, 'report anchor logicalIdentity');
  assertDigest(anchor.fingerprint, 'report anchor fingerprint');
  if (!isPlainObject(anchor.report)
    || anchor.report.mediaType !== 'text/markdown'
    || anchor.report.charset !== 'utf-8'
    || !Number.isInteger(anchor.report.byteLength)
    || anchor.report.byteLength < 1
    || Object.keys(anchor.report).some((field) => !['mediaType', 'charset', 'byteLength'].includes(field))) {
    fail('report anchor format is invalid', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  }
  if (markdown !== null) {
    const normalized = normalizeInternalReportPackage({
      contract: anchor.producerPackageContract || REPORT_PACKAGE_CONTRACT,
      origin: anchor.origin,
      producer: anchor.producer,
      lineage: anchor.lineage,
      dailyReport: anchor.dailyReport,
      report: {
        mediaType: anchor.report.mediaType,
        charset: anchor.report.charset,
        markdown,
        contentDigest: anchor.contentDigest,
      },
      metadata: anchor.metadata,
    });
    if (reportVersionId(normalized) !== anchor.id) fail('report anchor identity mismatch', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
    if (reportLogicalIdentity(normalized) !== anchor.logicalIdentity) fail('report anchor logical identity mismatch', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
    if (reportVersionFingerprint(normalized) !== anchor.fingerprint) fail('report anchor fingerprint mismatch', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  }
  if (!isPlainObject(anchor.ingestion)) fail('report anchor ingestion is invalid', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
  assertIso(anchor.ingestion.admittedAt, 'report anchor ingestion.admittedAt');
  assertSafeId(anchor.ingestion.id, 'report anchor ingestion.id');
  normalizeSource(anchor.ingestion.source);
  if (anchor.admission !== undefined && anchor.admission !== null) {
    if (!isPlainObject(anchor.admission)
      || canonicalStringify(Object.keys(anchor.admission).sort()) !== canonicalStringify(['batch', 'candidateId'])) {
      fail('report anchor admission is invalid', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
    }
    assertSafeId(anchor.admission.candidateId, 'report anchor admission.candidateId');
    if (anchor.admission.batch !== null) {
      if (!isPlainObject(anchor.admission.batch)
        || canonicalStringify(Object.keys(anchor.admission.batch).sort()) !== canonicalStringify(['batchId', 'itemId'])) {
        fail('report anchor admission batch is invalid', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
      }
      assertSafeId(anchor.admission.batch.batchId, 'report anchor admission.batchId');
      assertSafeId(anchor.admission.batch.itemId, 'report anchor admission.itemId');
    }
  }
  return anchor;
}

function validateProjectionDocument(value, schemaVersion, field) {
  if (!isPlainObject(value) || value.schemaVersion !== schemaVersion || !Array.isArray(value[field])) {
    fail(`invalid ${field} projection`, 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  }
  if (value.projectionDigest !== digestProjection(schemaVersion, value[field])) {
    fail(`${field} projection digest mismatch`, 'REPORT_LIBRARY_CORRUPT_PROJECTION');
  }
  return value;
}

function expectedAdmissionEvent(anchor, overviewStore, { admissionSequence = null } = {}) {
  const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED, {
    reportVersionId: anchor.id,
    contentDigest: anchor.contentDigest,
    ingestionId: anchor.ingestion.id,
  });
  const payload = {
    reportVersionId: anchor.id,
    contentDigest: anchor.contentDigest,
    logicalIdentity: anchor.logicalIdentity,
    ingestionId: anchor.ingestion.id,
    source: anchor.ingestion.source,
    tickers: [...anchor.metadata.tickers],
  };
  if (anchor.admission) {
    const overview = overviewStore.status(detailReportVersion(anchor));
    if (overview.status !== 'ready') {
      fail('Prepared admission is missing its private Overview', 'REPORT_LIBRARY_ADMISSION_INCOMPLETE');
    }
    payload.admissionReceipt = {
      contract: 'report-admission-receipt.v1',
      candidateId: anchor.admission.candidateId,
      reportVersionId: anchor.id,
      contentDigest: anchor.contentDigest,
      fingerprint: anchor.fingerprint,
      overviewId: overview.overviewId,
      overviewDigest: overview.overviewDigest,
      source: anchor.ingestion.source,
      batch: clone(anchor.admission.batch),
      admittedAt: anchor.ingestion.admittedAt,
      admissionSequence,
      initialProcessingStatus: 'Pending',
    };
  }
  return {
    eventId,
    eventType: REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED,
    correlationId: anchor.ingestion.id,
    causationId: null,
    runId: anchor.lineage.analysisRunId,
    payload,
  };
}

function comparableAdmissionEvent(event) {
  return {
    eventId: event?.eventId,
    eventType: event?.eventType,
    correlationId: event?.correlationId,
    causationId: event?.causationId,
    runId: event?.runId,
    payload: event?.payload,
  };
}

function emptyIndex() {
  const entries = [];
  return {
    schemaVersion: REPORT_LIBRARY_INDEX_SCHEMA_VERSION,
    projectionDigest: digestProjection(REPORT_LIBRARY_INDEX_SCHEMA_VERSION, entries),
    entries,
  };
}

function emptyTimelines() {
  const entries = [];
  return {
    schemaVersion: REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION,
    projectionDigest: digestProjection(REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION, entries),
    entries,
  };
}

function emptyIngestionIndex() {
  const entries = [];
  return {
    schemaVersion: REPORT_LIBRARY_INGESTION_SCHEMA_VERSION,
    projectionDigest: digestProjection(REPORT_LIBRARY_INGESTION_SCHEMA_VERSION, entries),
    entries,
  };
}

export class ReportLibraryStore {
  static scope = REPORT_LIBRARY_STORE_SCOPE;

  constructor({
    rootDir = null,
    now = () => new Date().toISOString(),
    eventStore = null,
    overviewStore = null,
    processedReceiptReader = () => [],
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('ReportLibraryStore now must be a function');
    if (typeof processedReceiptReader !== 'function') throw new TypeError('ReportLibraryStore processedReceiptReader must be a function');
    this.rootDir = path.resolve(rootDir || defaultRoot());
    this.now = now;
    this.objectsDir = path.join(this.rootDir, ...CONTENT_ROOT.split('/'));
    this.reportsDir = path.join(this.rootDir, REPORTS_ROOT);
    this.projectionsDir = path.join(this.rootDir, PROJECTIONS_ROOT);
    this.ingestionsDir = path.join(this.rootDir, INGESTIONS_ROOT);
    this.locksDir = path.join(this.rootDir, LOCKS_ROOT);
    this.storeLockPath = path.join(this.locksDir, STORE_LOCK_NAME);
    this.projectionLockPath = path.join(this.locksDir, PROJECTION_LOCK_NAME);
    this.indexPath = path.join(this.projectionsDir, INDEX_NAME);
    this.timelinePath = path.join(this.projectionsDir, TIMELINE_INDEX_NAME);
    this.ingestionIndexPath = path.join(this.projectionsDir, INGESTION_INDEX_NAME);
    this.statusPath = path.join(this.projectionsDir, STATUS_NAME);
    this.eventStore = eventStore || new ReportLibraryEventStore({ rootDir: this.rootDir, now });
    this.processedReceiptReader = processedReceiptReader;
    this.#ensureTree();
    this.overviewStore = overviewStore || new ReportOverviewStore({ rootDir: this.rootDir, now });
  }

  bindProcessedReceiptReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('ReportLibraryStore processed receipt reader must be a function');
    this.processedReceiptReader = reader;
    this.rebuildProjections();
    return this;
  }

  processedReceipts() {
    const receipts = this.processedReceiptReader() || [];
    if (!Array.isArray(receipts)) throw new TypeError('Report Library processed receipt reader must return an array');
    return receipts;
  }

  commitPreparedAdmission(candidateIdInput) {
    const candidateId = assertSafeId(candidateIdInput, 'admission candidateId');
    const candidateStore = new ReportAdmissionStore({ rootDir: this.rootDir, now: this.now });
    return candidateStore.withCandidateLock(candidateId, (candidate) => (
      this.#commitPreparedCandidate(candidateId, candidate)
    ));
  }

  #commitPreparedCandidate(candidateId, candidate) {
    if (![REPORT_ADMISSION_CANDIDATE_STATES.PREPARED, REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED].includes(candidate.state)) {
      fail(`Report admission candidate is not prepared: ${candidateId}`, 'REPORT_ADMISSION_INVALID_STATE', 409);
    }
    const reportPackage = normalizeInternalReportPackage(candidate.package);
    const preparedOverview = candidate.preparedOverview;
    const normalizedSource = normalizeSource(candidate.source);
    const batch = candidate.batch;
    const id = reportVersionId(reportPackage);
    const logicalIdentity = reportLogicalIdentity(reportPackage);
    const fingerprint = reportVersionFingerprint(reportPackage);
    const ingestionId = reportIngestionId(reportPackage);
    return withFileLockSync(this.storeLockPath, () => {
      const existing = this.#readAnchorIfExists(id);
      if (existing) {
        if (existing.contentDigest !== reportPackage.report.contentDigest || existing.fingerprint !== fingerprint) {
          fail(`ReportVersion identity conflict: ${id}`, 'REPORT_LIBRARY_IDEMPOTENCY_CONFLICT', 409);
        }
        const requestedAdmission = {
          candidateId,
          batch: batch === null ? null : {
            batchId: assertSafeId(batch.batchId, 'admission batchId'),
            itemId: assertSafeId(batch.itemId, 'admission itemId'),
          },
        };
        if (canonicalStringify(existing.admission || null) !== canonicalStringify(requestedAdmission)) {
          fail(`ReportVersion admission receipt conflict: ${id}`, 'REPORT_LIBRARY_ADMISSION_CONFLICT', 409);
        }
        this.#assertContentObject(existing.contentDigest, reportPackage.report.markdown);
        const overview = this.overviewStore.commit({ reportVersion: detailReportVersion(existing), ...preparedOverview });
        this.#finalizeAdmission(existing);
        return Object.freeze({
          status: 'admitted',
          created: false,
          replayed: true,
          reportVersionId: existing.id,
          contentDigest: existing.contentDigest,
          reportVersion: this.#detail(existing),
          overview,
        });
      }

      const admittedAt = this.now();
      assertIso(admittedAt, 'ingestion admittedAt');
      const anchor = {
        schemaVersion: REPORT_VERSION_CONTRACT,
        producerPackageContract: reportPackage.contract,
        id,
        logicalIdentity,
        fingerprint,
        origin: reportPackage.origin,
        contentDigest: reportPackage.report.contentDigest,
        producer: clone(reportPackage.producer),
        lineage: clone(reportPackage.lineage),
        dailyReport: clone(reportPackage.dailyReport),
        report: {
          mediaType: reportPackage.report.mediaType,
          charset: reportPackage.report.charset,
          byteLength: Buffer.byteLength(reportPackage.report.markdown, 'utf8'),
        },
        metadata: clone(reportPackage.metadata),
        ingestion: { id: ingestionId, source: normalizedSource, admittedAt },
        admission: {
          candidateId,
          batch: batch === null ? null : {
            batchId: assertSafeId(batch.batchId, 'admission batchId'),
            itemId: assertSafeId(batch.itemId, 'admission itemId'),
          },
        },
      };
      validateAnchor(anchor, { markdown: reportPackage.report.markdown });

      const commitsRoot = path.join(this.rootDir, 'admission-commits');
      ensureOwnedStorageDirectory(commitsRoot, 'Report admission commit staging directory', { create: true });
      const commitRoot = path.join(commitsRoot, `.${id}.${process.pid}.${crypto.randomUUID()}`);
      const stagedReportsRoot = path.join(commitRoot, REPORTS_ROOT);
      const stagedReportDir = path.join(stagedReportsRoot, id);
      ensureOwnedStorageDirectory(commitRoot, 'Prepared report admission directory', { create: true });
      ensureOwnedStorageDirectory(stagedReportsRoot, 'Prepared report roots directory', { create: true });
      ensureOwnedStorageDirectory(stagedReportDir, 'Prepared ReportVersion directory', { create: true });
      let renamed = false;
      try {
        atomicCreateFileSync(path.join(stagedReportDir, REPORT_ANCHOR_NAME), `${canonicalStringify(anchor)}\n`);
        const stagedOverviewStore = new ReportOverviewStore({ rootDir: commitRoot, now: this.now });
        stagedOverviewStore.commit({ reportVersion: detailReportVersion(anchor), ...preparedOverview });
        this.#writeContentObject(reportPackage.report.contentDigest, reportPackage.report.markdown);
        fs.renameSync(stagedReportDir, path.join(this.reportsDir, id));
        renamed = true;
      } finally {
        fs.rmSync(commitRoot, { recursive: true, force: true });
      }
      if (!renamed) fail('Prepared report admission did not reach its visibility boundary', 'REPORT_LIBRARY_ADMISSION_INCOMPLETE');

      this.#finalizeAdmission(anchor);
      const overview = this.overviewStore.status(detailReportVersion(anchor));
      return Object.freeze({
        status: 'admitted',
        created: true,
        replayed: false,
        reportVersionId: anchor.id,
        contentDigest: anchor.contentDigest,
        reportVersion: this.#detail(anchor),
        overview: { ...overview, overview: this.overviewStore.get(detailReportVersion(anchor)), created: true, replayed: false },
      });
    });
  }

  recordFailure({ projectId, analysisRunId, source = 'producer', error: failure } = {}) {
    const safeProjectId = assertSafeId(projectId, 'projectId');
    const safeRunId = assertSafeId(analysisRunId, 'analysisRunId');
    const sourceValue = normalizeSource(source);
    const ingestionId = `ingest_${canonicalSha256({ origin: 'internal', producerType: 'run-analysis', projectId: safeProjectId, analysisRunId: safeRunId }).slice('sha256:'.length)}`;
    const record = {
      schemaVersion: 'report-library-ingestion.v1',
      id: ingestionId,
      ingestionId,
      status: 'failed',
      source: sourceValue,
      projectId: safeProjectId,
      analysisRunId: safeRunId,
      error: safePublicFailure(failure, { fallbackCode: 'REPORT_LIBRARY_INGESTION_FAILED', fallbackMessage: 'Report Library ingestion failed' }),
      failedAt: this.now(),
    };
    assertIso(record.failedAt, 'ingestion failedAt');
    return withFileLockSync(this.storeLockPath, () => {
      const file = ingestionPath(this.rootDir, ingestionId);
      if (fs.existsSync(file)) {
        const existing = safeReadJson(file, `ingestion ${ingestionId}`);
        if (existing.status === 'admitted') return clone(existing);
        const publicExisting = publicIngestionEntry(existing);
        this.#ensureIngestionFailureEvent(publicExisting);
        this.#rebuildProjectionsLocked();
        return clone(publicExisting);
      }
      atomicCreateFileSync(file, `${canonicalStringify(record)}\n`);
      this.#ensureIngestionFailureEvent(record);
      this.#rebuildProjectionsLocked();
      return clone(record);
    });
  }

  get(reportVersionIdInput) {
    const id = assertSafeId(reportVersionIdInput, 'reportVersionId');
    const anchor = this.#readAnchor(id);
    if (!anchor) return null;
    const detail = this.#visibleDetail(anchor);
    return detail ? publicReportVersion(detail) : null;
  }

  getDetail(id) {
    return this.get(id);
  }

  getForProcessing(reportVersionIdInput) {
    const id = assertSafeId(reportVersionIdInput, 'reportVersionId');
    const anchor = this.#readAnchor(id);
    return anchor ? this.#detail(anchor) : null;
  }

  readContent(reportVersionIdInput) {
    const id = assertSafeId(reportVersionIdInput, 'reportVersionId');
    const anchor = this.#readAnchor(id);
    if (!anchor) return null;
    if (!this.#visibleDetail(anchor)) return null;
    const object = reportContentObjectPath(this.rootDir, anchor.contentDigest);
    this.#assertContentObject(anchor.contentDigest, anchor.report.markdown);
    return fs.readFileSync(object, 'utf8');
  }

  content(id) {
    return this.readContent(id);
  }

  getOverview(reportVersionIdInput) {
    const id = assertSafeId(reportVersionIdInput, 'reportVersionId');
    const anchor = this.#readAnchor(id);
    if (!anchor) return null;
    return this.overviewStore.get(detailReportVersion(anchor));
  }

  overviewStatus(reportVersionIdInput) {
    const id = assertSafeId(reportVersionIdInput, 'reportVersionId');
    const anchor = this.#readAnchor(id);
    if (!anchor) return null;
    return this.overviewStore.status(detailReportVersion(anchor));
  }

  listPendingReports() {
    const reports = this.listAdmissionOrdered().reports
      .filter((entry) => entry.worldview?.processed !== true);
    return {
      schemaVersion: 'report-library-pending-reports.v1',
      reports: reports.map(clone),
    };
  }

  listAdmissionOrdered({ afterSequence = 0, throughSequence = Number.MAX_SAFE_INTEGER } = {}) {
    const after = Number(afterSequence);
    const through = Number(throughSequence);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(through) || through < after) {
      throw new TypeError('Report Library admission range is invalid');
    }
    const reports = this.#visibleReports()
      .filter((entry) => Number.isInteger(entry.admissionSequence))
      .filter((entry) => entry.admissionSequence > after && entry.admissionSequence <= through)
      .sort((left, right) => left.admissionSequence - right.admissionSequence)
      .map(clone);
    return { schemaVersion: 'report-library-admission-ordered.v1', reports };
  }

  list({ ticker = null, theme = null, origin = null, from = null, to = null, limit = 100, cursor = null } = {}) {
    const entries = this.#visibleReports().filter((entry) => {
      if (ticker !== null && !entry.tickers.includes(assertTicker(ticker))) return false;
      if (theme !== null && entry.theme !== String(theme)) return false;
      if (origin !== null && entry.origin !== String(origin)) return false;
      if (from !== null && entry.asOf < assertIso(from, 'from')) return false;
      if (to !== null && entry.asOf > assertIso(to, 'to')) return false;
      return true;
    });
    const page = paginate(entries, { limit, cursor });
    return {
      schemaVersion: 'report-library-list.v1',
      reports: page.items.map((entry) => publicReportVersion(entry)),
      nextCursor: page.nextCursor,
    };
  }

  tickerTimeline(tickerInput, { limit = 100, cursor = null } = {}) {
    const ticker = assertTicker(tickerInput);
    const reports = this.#visibleReports()
      .filter((report) => report.tickers.includes(ticker))
      .map(timelineEntry)
      .sort(compareTimelineReports);
    const page = paginate(reports, { limit, cursor });
    return {
      schemaVersion: 'ticker-report-timeline.v1',
      ticker,
      reports: page.items.map((item) => clone(item)),
      nextCursor: page.nextCursor,
    };
  }

  timeline(ticker, options = {}) {
    return this.tickerTimeline(ticker, options);
  }

  tickers() {
    return [...new Set(this.#visibleReports().flatMap((entry) => entry.tickers))].sort(compareText);
  }

  getIngestion(ingestionIdInput) {
    const ingestionId = assertSafeId(ingestionIdInput, 'ingestionId');
    const entry = this.#readIngestionIndex().entries.find((item) => item.ingestionId === ingestionId);
    return entry ? clone(publicIngestionEntry(entry)) : null;
  }

  getBackfillStatus(backfillRunIdInput) {
    const runId = assertSafeId(backfillRunIdInput, 'backfillRunId');
    const file = path.join(this.rootDir, 'backfills', `${runId}.json`);
    if (!fs.existsSync(file)) return null;
    const state = safeReadJson(file, `backfill ${runId}`);
    return this.#publicBackfillState(state);
  }

  listBackfills({ status = null, limit = 100, cursor = null } = {}) {
    const root = path.join(this.rootDir, 'backfills');
    if (!fs.existsSync(root)) return { schemaVersion: 'report-library-backfill-list.v1', backfills: [], nextCursor: null };
    const states = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => this.#publicBackfillState(safeReadJson(path.join(root, entry.name), `backfill ${entry.name}`)))
      .filter((entry) => status === null || entry.status === String(status))
      .sort((left, right) => compareText(left.runId, right.runId));
    const page = paginate(states, { limit, cursor });
    return { schemaVersion: 'report-library-backfill-list.v1', backfills: page.items, nextCursor: page.nextCursor };
  }

  backfillStatus(runId) {
    return this.getBackfillStatus(runId);
  }

  backfills(options = {}) {
    return this.listBackfills(options);
  }

  listIngestions({ status = null, limit = 100, cursor = null } = {}) {
    const entries = this.#readIngestionIndex().entries.map(publicIngestionEntry).filter((entry) => (
      status === null || entry.status === String(status)
    ));
    const page = paginate(entries, { limit, cursor });
    return {
      schemaVersion: 'report-library-ingestion-list.v1',
      ingestions: page.items.map((item) => clone(item)),
      nextCursor: page.nextCursor,
    };
  }

  ingestions(options = {}) {
    return this.listIngestions(options);
  }

  status() {
    const index = this.#readIndex();
    const visibleReports = this.#visibleReports();
    const timelines = this.#readTimelines();
    const ingestions = this.#readIngestionIndex();
    const counts = ingestions.entries.reduce((result, entry) => {
      result[entry.status] = (result[entry.status] || 0) + 1;
      return result;
    }, { admitted: 0, failed: 0, pending: 0 });
    const processedReportCount = visibleReports.filter((entry) => entry.worldview?.processed === true).length;
    const pendingReportCount = visibleReports.length - processedReportCount;
    return {
      schemaVersion: REPORT_LIBRARY_STATUS_SCHEMA_VERSION,
      reportVersionCount: visibleReports.length,
      pendingReportCount,
      processedReportCount,
      tickerCount: new Set(visibleReports.flatMap((entry) => entry.tickers)).size,
      ingestionCount: ingestions.entries.length,
      ingestions: counts,
      projectionDigest: canonicalSha256({ reports: index.projectionDigest, timelines: timelines.projectionDigest, ingestions: ingestions.projectionDigest }),
    };
  }

  rebuildProjections() {
    return withFileLockSync(this.storeLockPath, () => (
      withFileLockSync(this.projectionLockPath, () => this.#rebuildProjectionsLocked())
    ));
  }

  reconcile() {
    return withFileLockSync(this.storeLockPath, () => {
      const anchors = this.#loadAnchors();
      for (const anchor of anchors) {
        this.#assertContentObject(anchor.contentDigest, anchor.report.markdown);
        this.#writeIngestionRecord(anchor);
      }
      return this.#rebuildProjectionsLocked();
    });
  }

  #admissionSequence(anchor, events = this.eventStore.list()) {
    const expectedHeader = expectedAdmissionEvent(anchor, this.overviewStore);
    const matches = events.filter((entry) => entry.eventId === expectedHeader.eventId);
    if (matches.length > 1) {
      fail(`Duplicate ReportVersion admission marker: ${anchor.id}`, 'REPORT_LIBRARY_ADMISSION_CONFLICT', 409);
    }
    const event = matches[0] || null;
    if (!event) return null;
    const expected = expectedAdmissionEvent(anchor, this.overviewStore, { admissionSequence: event.sequence });
    if (canonicalStringify(comparableAdmissionEvent(event)) !== canonicalStringify(expected)
      || !Number.isInteger(event.sequence) || event.sequence < 1) {
      fail(`ReportVersion admission marker conflict: ${anchor.id}`, 'REPORT_LIBRARY_ADMISSION_CONFLICT', 409);
    }
    return event.sequence;
  }

  #processedReceipt(anchor, admissionSequence) {
    const receipt = this.processedReceipts().find((item) => item?.reportVersionId === anchor.id) || null;
    if (!receipt) return null;
    return receipt.contentDigest === anchor.contentDigest
      && receipt.fingerprint === anchor.fingerprint
      && receipt.admissionSequence === admissionSequence
      ? clone(receipt)
      : null;
  }

  #detail(anchor) {
    const base = detailReportVersion(anchor);
    const admissionSequence = this.#admissionSequence(anchor);
    return detailReportVersion(anchor, {
      admissionSequence,
      overview: this.overviewStore.status(base),
      processedReceipt: this.#processedReceipt(anchor, admissionSequence),
    });
  }

  #visibleDetail(anchor, events = this.eventStore.list()) {
    const base = detailReportVersion(anchor);
    const overview = this.overviewStore.status(base);
    if (overview.status !== 'ready') return null;
    const admissionSequence = this.#admissionSequence(anchor, events);
    if (!Number.isInteger(admissionSequence)) return null;
    return detailReportVersion(anchor, {
      admissionSequence,
      overview,
      processedReceipt: this.#processedReceipt(anchor, admissionSequence),
    });
  }

  #visibleReports() {
    const events = this.eventStore.list();
    const seen = new Set();
    return this.#readIndex().entries.map((entry) => {
      const id = assertSafeId(entry?.reportVersionId || entry?.id, 'projected reportVersionId');
      if (seen.has(id)) fail(`Duplicate ReportVersion projection: ${id}`, 'REPORT_LIBRARY_CORRUPT_PROJECTION');
      seen.add(id);
      const anchor = this.#readAnchor(id);
      if (!anchor) fail(`Projected ReportVersion is missing: ${id}`, 'REPORT_LIBRARY_CORRUPT_PROJECTION');
      return this.#visibleDetail(anchor, events);
    }).filter(Boolean).sort(compareReportEntries);
  }

  #publicBackfillState(state) {
    if (!isPlainObject(state)) fail('backfill state is invalid', 'REPORT_LIBRARY_CORRUPT_BACKFILL');
    const items = isPlainObject(state.items) ? Object.values(state.items) : [];
    const counts = items.reduce((result, item) => {
      const itemStatus = String(item?.status || 'pending');
      result[itemStatus] = (result[itemStatus] || 0) + 1;
      return result;
    }, {});
    return clone({
      contract: state.contract || null,
      runId: state.runId || null,
      manifestId: state.manifestId || null,
      manifestDigest: state.manifestDigest || null,
      asOf: state.asOf || null,
      status: state.status || null,
      startedAt: state.startedAt || null,
      updatedAt: state.updatedAt || null,
      completedAt: state.completedAt || null,
      summary: {
        total: items.length,
        pending: counts.pending || 0,
        running: counts.running || 0,
        succeeded: counts.succeeded || 0,
        failed: counts.failed || 0,
      },
      items: items.map((item) => ({
        itemId: item.itemId || null,
        status: item.status || null,
        attempts: Number.isInteger(item.attempts) ? item.attempts : 0,
        reportVersionId: item.reportVersionId || null,
        ingestionId: item.ingestionId || null,
        error: item.error ? safePublicFailure(item.error, {
          fallbackCode: 'REPORT_LIBRARY_BACKFILL_FAILED',
          fallbackMessage: 'Report Library backfill failed',
        }) : null,
      })),
    });
  }

  #ensureTree() {
    createDirectory(this.rootDir);
    createDirectory(this.rootDir, ['objects']);
    createDirectory(this.rootDir, CONTENT_ROOT.split('/'));
    createDirectory(this.rootDir, [REPORTS_ROOT]);
    createDirectory(this.rootDir, [PROJECTIONS_ROOT]);
    createDirectory(this.rootDir, [INGESTIONS_ROOT]);
    createDirectory(this.rootDir, [LOCKS_ROOT]);
    assertStorageLockBoundary(this.storeLockPath, 'Report Library store lock');
    assertStorageLockBoundary(this.projectionLockPath, 'Report Library projection lock');
  }

  #readAnchorIfExists(id) {
    const file = reportAnchorPath(this.rootDir, id);
    if (!fs.existsSync(file)) return null;
    const anchor = safeReadJson(file, `ReportVersion ${id}`);
    validateAnchor(anchor);
    const object = reportContentObjectPath(this.rootDir, anchor.contentDigest);
    assertOwnedStorageFile(object, `Report Library content object ${anchor.contentDigest}`, { allowMissing: false });
    const markdown = fs.readFileSync(object, 'utf8');
    if (hashBytes(Buffer.from(markdown, 'utf8')) !== anchor.contentDigest) {
      fail(`Report Library content digest mismatch: ${anchor.contentDigest}`, 'REPORT_LIBRARY_CONTENT_DIGEST_MISMATCH', 409);
    }
    return validateAnchor(anchor, { markdown });
  }

  #readAnchor(id) {
    return this.#readAnchorIfExists(id);
  }

  #loadAnchors() {
    const root = path.join(this.rootDir, REPORTS_ROOT);
    if (!fs.existsSync(root)) return [];
    const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name));
    return entries.map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail('Report Library reports root contains an invalid entry', 'REPORT_LIBRARY_CORRUPT_ANCHOR');
      const id = assertSafeId(entry.name, 'reportVersionId');
      const anchor = safeReadJson(reportAnchorPath(this.rootDir, id), `ReportVersion ${id}`);
      validateAnchor(anchor);
      const object = reportContentObjectPath(this.rootDir, anchor.contentDigest);
      assertOwnedStorageFile(object, `Report Library content object ${anchor.contentDigest}`, { allowMissing: false });
      const markdown = fs.readFileSync(object, 'utf8');
      if (hashBytes(Buffer.from(markdown, 'utf8')) !== anchor.contentDigest) {
        fail(`Report Library content digest mismatch: ${anchor.contentDigest}`, 'REPORT_LIBRARY_CONTENT_DIGEST_MISMATCH', 409);
      }
      return validateAnchor(anchor, { markdown });
    }).sort((a, b) => compareText(a.id, b.id));
  }

  #writeContentObject(digest, markdown) {
    const object = reportContentObjectPath(this.rootDir, digest);
    const parent = path.dirname(object);
    createDirectory(this.rootDir, [CONTENT_ROOT.split('/')[0], CONTENT_ROOT.split('/')[1]]);
    if (fs.existsSync(object)) {
      this.#assertContentObject(digest, markdown);
      return;
    }
    atomicCreateFileSync(object, markdown);
    this.#assertContentObject(digest, markdown);
    assertInside(this.rootDir, object);
    ensureOwnedStorageDirectory(parent, 'Report Library content directory', { create: true });
  }

  #assertContentObject(digest, expectedMarkdown = null) {
    const object = reportContentObjectPath(this.rootDir, digest);
    assertOwnedStorageFile(object, `Report Library content object ${digest}`, { allowMissing: false });
    const bytes = fs.readFileSync(object);
    if (hashBytes(bytes) !== digest) fail(`Report Library content digest mismatch: ${digest}`, 'REPORT_LIBRARY_CONTENT_DIGEST_MISMATCH', 409);
    if (expectedMarkdown !== null && bytes.compare(Buffer.from(expectedMarkdown, 'utf8')) !== 0) {
      fail(`Report Library content object differs from package: ${digest}`, 'REPORT_LIBRARY_CONTENT_CONFLICT', 409);
    }
  }

  #finalizeAdmission(anchor) {
    this.#writeIngestionRecord(anchor);
    // The admission outbox event is the authoritative visibility marker and
    // is written only after all supporting durable records are complete.
    this.#ensureAdmissionEvent(anchor);
    this.#rebuildProjectionsLocked();
  }

  #writeIngestionRecord(anchor) {
    const record = {
      schemaVersion: 'report-library-ingestion.v1',
      id: anchor.ingestion.id,
      ingestionId: anchor.ingestion.id,
      status: 'admitted',
      source: anchor.ingestion.source,
      reportVersionId: anchor.id,
      contentDigest: anchor.contentDigest,
      logicalIdentity: anchor.logicalIdentity,
      admittedAt: anchor.ingestion.admittedAt,
    };
    const file = ingestionPath(this.rootDir, anchor.ingestion.id);
    if (fs.existsSync(file)) {
      const existing = safeReadJson(file, `ingestion ${anchor.ingestion.id}`);
      if (existing.status === 'failed') {
        // A durable failure record is a retry marker, not a competing
        // ReportVersion. The first successful admission atomically promotes
        // the same ingestion identity to admitted.
        atomicWriteFileSync(file, `${canonicalStringify(record)}\n`);
        return;
      }
      if (canonicalStringify(existing) !== canonicalStringify(record)) fail(`ingestion conflict: ${anchor.ingestion.id}`, 'REPORT_LIBRARY_IDEMPOTENCY_CONFLICT', 409);
      return;
    }
    atomicCreateFileSync(file, `${canonicalStringify(record)}\n`);
  }

  #ensureIngestionFailureEvent(record) {
    const expected = ingestionFailureEventInput(record);
    const existing = typeof this.eventStore.get === 'function'
      ? this.eventStore.get(expected.eventId)
      : this.eventStore.list().find((event) => event.eventId === expected.eventId) || null;
    if (existing) {
      // Historical evidence stays immutable; compare its closed safe projection
      // so legacy raw failure details do not defeat idempotent replay.
      if (canonicalStringify(comparableIngestionFailureEvent(existing)) !== canonicalStringify(expected)) {
        fail(
          `Report Library event idempotency conflict: ${expected.eventId}`,
          'REPORT_EVENT_IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      return existing;
    }
    return this.eventStore.publish(expected);
  }

  #ensureAdmissionEvent(anchor) {
    const event = expectedAdmissionEvent(anchor, this.overviewStore);
    return this.eventStore.publish({
      ...event,
      payload: ({ sequence }) => expectedAdmissionEvent(anchor, this.overviewStore, {
        admissionSequence: sequence,
      }).payload,
    });
  }

  #readProjection(file, schemaVersion, field, fallback) {
    if (!fs.existsSync(file)) return fallback();
    return validateProjectionDocument(safeReadJson(file, path.basename(file)), schemaVersion, field);
  }

  #readIndex() {
    return this.#readProjection(this.indexPath, REPORT_LIBRARY_INDEX_SCHEMA_VERSION, 'entries', emptyIndex);
  }

  #readTimelines() {
    return this.#readProjection(this.timelinePath, REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION, 'entries', emptyTimelines);
  }

  #readIngestionIndex() {
    return this.#readProjection(this.ingestionIndexPath, REPORT_LIBRARY_INGESTION_SCHEMA_VERSION, 'entries', emptyIngestionIndex);
  }

  #rebuildProjectionsLocked() {
    const anchors = this.#loadAnchors();
    const events = this.eventStore.list();
    const admissionSequenceByReport = new Map(anchors
      .map((anchor) => [anchor.id, this.#admissionSequence(anchor, events)])
      .filter(([, sequence]) => Number.isInteger(sequence)));
    const receiptByReport = new Map(this.processedReceipts().map((receipt) => [receipt.reportVersionId, receipt]));
    const reports = anchors.map((anchor) => {
      const admissionSequence = admissionSequenceByReport.get(anchor.id) || null;
      const candidateReceipt = receiptByReport.get(anchor.id) || null;
      const processedReceipt = candidateReceipt
        && candidateReceipt.contentDigest === anchor.contentDigest
        && candidateReceipt.fingerprint === anchor.fingerprint
        && candidateReceipt.admissionSequence === admissionSequence
        ? candidateReceipt
        : null;
      return compactReportVersion(anchor, {
        admissionSequence,
        overview: this.overviewStore.status(detailReportVersion(anchor)),
        processedReceipt,
      });
    }).filter((report) => report.overview?.status === 'ready' && Number.isInteger(report.admissionSequence)).sort(compareReportEntries);
    const byTicker = new Map();
    for (const report of reports) {
      for (const ticker of report.tickers) {
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker).push(timelineEntry(report));
      }
    }
    const timelineEntries = [...byTicker.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([ticker, tickerReports]) => ({
        ticker,
        reports: tickerReports.sort(compareTimelineReports),
      }));
    const visibleReportIds = new Set(reports.map((report) => report.id));
    const admittedIngestionEntries = anchors.filter((anchor) => visibleReportIds.has(anchor.id)).map((anchor) => ({
      schemaVersion: 'report-library-ingestion.v1',
      id: anchor.ingestion.id,
      ingestionId: anchor.ingestion.id,
      status: 'admitted',
      source: anchor.ingestion.source,
      reportVersionId: anchor.id,
      contentDigest: anchor.contentDigest,
      logicalIdentity: anchor.logicalIdentity,
      admittedAt: anchor.ingestion.admittedAt,
      admissionSequence: admissionSequenceByReport.get(anchor.id) || null,
    }));
    const admittedIds = new Set(admittedIngestionEntries.map((entry) => entry.id));
    const failedIngestionEntries = [];
    if (fs.existsSync(this.ingestionsDir)) {
      for (const name of fs.readdirSync(this.ingestionsDir).filter((value) => value.endsWith('.json'))) {
        const record = safeReadJson(path.join(this.ingestionsDir, name), `ingestion ${name}`);
        if (record?.status === 'failed' && !admittedIds.has(record.id)) {
          const entry = publicIngestionEntry(record);
          if (name !== `${entry.ingestionId}.json`) {
            fail('ingestion filename does not match its identity', 'REPORT_LIBRARY_CORRUPT_PROJECTION');
          }
          failedIngestionEntries.push(entry);
        }
      }
    }
    const ingestionEntries = [...admittedIngestionEntries, ...failedIngestionEntries]
      .sort((left, right) => compareText(left.id, right.id));
    const index = {
      schemaVersion: REPORT_LIBRARY_INDEX_SCHEMA_VERSION,
      projectionDigest: digestProjection(REPORT_LIBRARY_INDEX_SCHEMA_VERSION, reports),
      entries: reports,
    };
    const timelines = {
      schemaVersion: REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION,
      projectionDigest: digestProjection(REPORT_LIBRARY_TIMELINE_SCHEMA_VERSION, timelineEntries),
      entries: timelineEntries,
    };
    const ingestions = {
      schemaVersion: REPORT_LIBRARY_INGESTION_SCHEMA_VERSION,
      projectionDigest: digestProjection(REPORT_LIBRARY_INGESTION_SCHEMA_VERSION, ingestionEntries),
      entries: ingestionEntries,
    };
    writeJson(this.indexPath, index);
    writeJson(this.timelinePath, timelines);
    writeJson(this.ingestionIndexPath, ingestions);
    const status = {
      schemaVersion: REPORT_LIBRARY_STATUS_SCHEMA_VERSION,
      reportVersionCount: reports.length,
      tickerCount: timelineEntries.length,
      ingestionCount: ingestionEntries.length,
      projectionDigest: canonicalSha256({
        reports: index.projectionDigest,
        timelines: timelines.projectionDigest,
        ingestions: ingestions.projectionDigest,
      }),
      rebuiltAt: this.now(),
    };
    assertIso(status.rebuiltAt, 'projection rebuiltAt');
    writeJson(this.statusPath, status);
    return deepFreeze({ index, timelines, ingestions, status });
  }
}

export function reportLibraryRoot() {
  return defaultRoot();
}

export function createReportLibraryStore(options = {}) {
  return new ReportLibraryStore(options);
}
