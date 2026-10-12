import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify,
  deepFreeze,
} from '../../core/contracts/ArtifactRef.js';
import {
  atomicWriteFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import {
  normalizeBackfillManifest,
  normalizeInternalReportPackage,
  backfillManifestDigest,
  reportIngestionId,
  reportVersionId,
} from './reportContracts.js';
import {
  ReportLibraryEventStore,
  REPORT_LIBRARY_EVENT_TYPES,
  reportLibraryEventId,
} from './ReportLibraryEventStore.js';
import { ReportAdmissionService } from './ReportOverviewService.js';
import { safePublicFailure } from './safeFailure.js';

export const REPORT_LIBRARY_BACKFILL_STATE_CONTRACT = 'report-library-backfill-state.v1';
export const REPORT_LIBRARY_BACKFILL_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'data');

function backfillError(message, code = 'REPORT_LIBRARY_BACKFILL_ERROR', statusCode = 500, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    throw backfillError(`${field} is unsafe`, 'INVALID_REPORT_LIBRARY_BACKFILL_ID', 400);
  }
  return value;
}

function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw backfillError(`${field} must be a sha256 digest`, 'INVALID_REPORT_LIBRARY_BACKFILL_DIGEST', 400);
  }
  return value;
}

function nowIso(now) {
  const value = now();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw backfillError('backfill clock must return an ISO timestamp', 'INVALID_REPORT_LIBRARY_BACKFILL_CLOCK');
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function hashBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}


function ensurePlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw backfillError(`${field} must be an object`, 'INVALID_REPORT_LIBRARY_BACKFILL', 400);
  }
  return value;
}

/**
 * Normalize a manifest once, including its package contracts.  The resulting
 * value is immutable and is safe to persist as the input snapshot for a run.
 */
export function freezeBackfillManifest(input) {
  const initial = normalizeBackfillManifest(input);
  const normalized = {
    contract: initial.contract,
    manifestId: initial.manifestId,
    asOf: initial.asOf,
    items: initial.items.map((item) => ({
      itemId: item.itemId,
      package: normalizeInternalReportPackage(item.package),
      source: item.source ? { ...item.source } : null,
    })),
  };
  return deepFreeze(normalized);
}

export const normalizeFrozenBackfillManifest = freezeBackfillManifest;

export function reportLibraryBackfillRunId(manifestInput) {
  const manifest = freezeBackfillManifest(manifestInput);
  // Keep the human supplied manifest identity visible while making the run
  // namespace unambiguous.  The manifest digest remains the immutable guard.
  return `backfill_${manifest.manifestId}`;
}

function stateFileName(runId) {
  return `${assertSafeId(runId, 'backfill runId')}.json`;
}

function defaultRoot(options = {}) {
  return path.resolve(
    options.rootDir
      || process.env.REPORT_LIBRARY_DIR
      || path.join(process.env.FIN_DATA_DIR || DEFAULT_DATA_DIR, 'report-library'),
  );
}

function defaultSourceRoot(options = {}) {
  const value = options.sourceRoot
    || process.env.REPORT_LIBRARY_BACKFILL_SOURCE_ROOT
    || process.env.REPORT_LIBRARY_SOURCE_ROOT
    || null;
  return value ? path.resolve(value) : null;
}

function assertWithin(root, target, code = 'REPORT_LIBRARY_BACKFILL_PATH_OUTSIDE_ROOT') {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw backfillError('backfill source path escapes its root', code, 400);
  }
}

/**
 * Resolve and read a source file without traversing symlinks.  Verification is
 * intentionally byte based: no newline normalization or UTF-8 round trip is
 * performed before digest comparison.
 */
export function readVerifiedBackfillSource(source, { sourceRoot } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw backfillError('backfill source is required', 'INVALID_BACKFILL_SOURCE', 400);
  }
  const rootValue = sourceRoot && path.resolve(sourceRoot);
  if (!rootValue) throw backfillError('backfill source root is required', 'BACKFILL_SOURCE_ROOT_REQUIRED', 400);
  const root = path.resolve(rootValue);
  ensureOwnedStorageDirectory(root, 'Report Library backfill source root');
  const relativePath = source.relativePath;
  if (
    typeof relativePath !== 'string'
    || !relativePath
    || path.isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.includes('\u0000')
  ) {
    throw backfillError('backfill source path is unsafe', 'UNSAFE_BACKFILL_PATH', 400);
  }
  const pieces = relativePath.split('/');
  if (pieces.some((part) => !part || part === '.' || part === '..')) {
    throw backfillError('backfill source path is unsafe', 'UNSAFE_BACKFILL_PATH', 400);
  }
  let current = root;
  for (let i = 0; i < pieces.length - 1; i += 1) {
    current = path.join(current, pieces[i]);
    assertWithin(root, current);
    ensureOwnedStorageDirectory(current, `Report Library backfill source directory ${pieces[i]}`);
  }
  const file = path.resolve(root, ...pieces);
  assertWithin(root, file);
  assertOwnedStorageFile(file, 'Report Library backfill source file', { allowMissing: false });
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw backfillError('unable to read backfill source file', 'BACKFILL_SOURCE_READ_FAILED', 400, error);
  }
  const digest = hashBytes(bytes);
  assertDigest(source.contentDigest, 'backfill source.contentDigest');
  if (digest !== source.contentDigest) {
    throw backfillError('backfill source digest does not match exact file bytes', 'BACKFILL_SOURCE_DIGEST_MISMATCH', 409);
  }
  return { bytes, digest, relativePath };
}

function packageWithVerifiedSource(item, sourceRoot) {
  const pkg = normalizeInternalReportPackage(item.package);
  if (!item.source) return pkg;
  const verified = readVerifiedBackfillSource(item.source, { sourceRoot });
  const packageBytes = Buffer.from(pkg.report.markdown, 'utf8');
  if (!Buffer.equals(verified.bytes, packageBytes)) {
    throw backfillError(
      `backfill source bytes do not match package Markdown: ${item.itemId}`,
      'BACKFILL_SOURCE_CONTENT_MISMATCH',
      409,
    );
  }
  // Verify the package digest separately even though the package contract does
  // so; this keeps this security boundary explicit for callers and tests.
  if (hashBytes(packageBytes) !== pkg.report.contentDigest) {
    throw backfillError(`report package digest mismatch: ${item.itemId}`, 'REPORT_CONTENT_DIGEST_MISMATCH', 409);
  }
  return pkg;
}

function errorDto(error) {
  return safePublicFailure(error, {
    fallbackCode: 'REPORT_LIBRARY_BACKFILL_FAILED',
    fallbackMessage: 'Report Library backfill failed',
  });
}

function safeBackfillError(error) {
  return error ? safePublicFailure(error, {
    fallbackCode: 'REPORT_LIBRARY_BACKFILL_FAILED',
    fallbackMessage: 'Report Library backfill failed',
  }) : null;
}

function summarize(state) {
  const items = Object.values(state.items);
  const counts = items.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    total: items.length,
    pending: counts.pending || 0,
    running: counts.running || 0,
    succeeded: counts.succeeded || 0,
    failed: counts.failed || 0,
  };
}

function publicState(state) {
  return deepFreeze({
    contract: state.contract,
    runId: state.runId,
    manifestId: state.manifestId,
    manifestDigest: state.manifestDigest,
    asOf: state.asOf,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    resumable: state.status !== REPORT_LIBRARY_BACKFILL_STATUSES.SUCCEEDED,
    summary: summarize(state),
    items: Object.values(state.items).map((item) => ({ ...item, error: safeBackfillError(item.error) })),
    errors: Object.values(state.items).filter((item) => item.error).map((item) => ({
      itemId: item.itemId,
      ...safeBackfillError(item.error),
    })),
  });
}

function makeInitialState(manifest, runId, now) {
  const timestamp = nowIso(now);
  return {
    contract: REPORT_LIBRARY_BACKFILL_STATE_CONTRACT,
    runId,
    manifestId: manifest.manifestId,
    manifestDigest: backfillManifestDigest(manifest),
    asOf: manifest.asOf,
    manifest: clone(manifest),
    status: REPORT_LIBRARY_BACKFILL_STATUSES.QUEUED,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastEventId: null,
    items: Object.fromEntries(manifest.items.map((item) => [item.itemId, {
      itemId: item.itemId,
      status: 'pending',
      attempts: 0,
      reportVersionId: null,
      ingestionId: null,
      error: null,
    }])),
  };
}

function parseState(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw backfillError('backfill state is missing or invalid', 'CORRUPT_REPORT_LIBRARY_BACKFILL_STATE', 500, error);
  }
  ensurePlainObject(value, 'backfill state');
  if (value.contract !== REPORT_LIBRARY_BACKFILL_STATE_CONTRACT) {
    throw backfillError('unsupported backfill state contract', 'UNSUPPORTED_REPORT_LIBRARY_BACKFILL_STATE', 500);
  }
  assertSafeId(value.runId, 'backfill state.runId');
  assertDigest(value.manifestDigest, 'backfill state.manifestDigest');
  ensurePlainObject(value.items, 'backfill state.items');
  return value;
}

export class ReportLibraryBackfill {
  constructor({
    store,
    admissionService = null,
    overviewService = null,
    rootDir,
    sourceRoot,
    eventStore,
    now = () => new Date().toISOString(),
    maxAttempts = 3,
  } = {}) {
    if (!store || typeof store.commitPreparedAdmission !== 'function') {
      throw new TypeError('Report Library backfill requires the standard Report Library admission store');
    }
    if (admissionService !== null && typeof admissionService?.admit !== 'function') {
      throw new TypeError('Report Library backfill admissionService must provide admit');
    }
    if (typeof now !== 'function') throw new TypeError('Report Library backfill clock is required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new TypeError('Report Library backfill maxAttempts must be between 1 and 100');
    }
    this.store = store;
    this.admissionService = admissionService || new ReportAdmissionService({
      reportLibrary: store,
      overviewService,
    });
    this.rootDir = defaultRoot({ rootDir });
    this.sourceRoot = defaultSourceRoot({ sourceRoot });
    this.stateDir = path.join(this.rootDir, 'backfills');
    this.lockPath = path.join(this.rootDir, 'backfills', '.locks', 'state.lock');
    this.eventStore = eventStore || new ReportLibraryEventStore({ rootDir: this.rootDir, now });
    this.now = now;
    this.maxAttempts = maxAttempts;
    ensureOwnedStorageDirectory(this.rootDir, 'Report Library backfill root', { create: true, recursive: true });
    ensureOwnedStorageDirectory(this.stateDir, 'Report Library backfill state directory', { create: true });
  }

  #statePath(runId) {
    return path.join(this.stateDir, stateFileName(runId));
  }

  #load(runId) {
    const file = this.#statePath(runId);
    if (!fs.existsSync(file)) throw backfillError(`backfill run not found: ${runId}`, 'REPORT_LIBRARY_BACKFILL_NOT_FOUND', 404);
    return parseState(file);
  }

  #save(state) {
    state.updatedAt = nowIso(this.now);
    atomicWriteFileSync(this.#statePath(state.runId), `${canonicalStringify(state)}\n`);
  }

  #event(type, state, identity, payload, causationId = state.lastEventId) {
    if (!this.eventStore || typeof this.eventStore.publish !== 'function') return null;
    const eventId = reportLibraryEventId(type, { runId: state.runId, ...identity });
    const event = this.eventStore.publish({
      eventId,
      eventType: type,
      correlationId: state.runId,
      causationId,
      runId: state.runId,
      payload: { manifestId: state.manifestId, ...payload },
    });
    state.lastEventId = event.eventId;
    return event;
  }

  #loadOrCreate(manifest) {
    const runId = reportLibraryBackfillRunId(manifest);
    const file = this.#statePath(runId);
    return withFileLockSync(this.lockPath, () => {
      if (!fs.existsSync(file)) {
        const state = makeInitialState(manifest, runId, this.now);
        this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_STARTED, state, { manifestDigest: state.manifestDigest }, {
          itemCount: manifest.items.length,
          manifestDigest: state.manifestDigest,
        }, null);
        this.#save(state);
        return state;
      }
      const state = parseState(file);
      if (state.manifestDigest !== backfillManifestDigest(manifest)) {
        throw backfillError('backfill run already exists for a different frozen manifest', 'BACKFILL_MANIFEST_CONFLICT', 409);
      }
      return state;
    });
  }

  async #process(runId, { retryFailed = false, maxAttempts = this.maxAttempts } = {}) {
    const state = this.#load(runId);
    if (state.status === REPORT_LIBRARY_BACKFILL_STATUSES.SUCCEEDED) return publicState(state);
    const attemptsLimit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : this.maxAttempts;
    state.status = REPORT_LIBRARY_BACKFILL_STATUSES.RUNNING;
    // A process dying between these two writes leaves running items. Resume
    // safely converts them back to pending before admission.
    for (const manifestItem of state.manifest.items) {
      const item = state.items[manifestItem.itemId];
      if (!item || item.status === 'succeeded') continue;
      if (item.status === 'running') item.status = 'pending';
      // Reconcile the crash window after Store admission but before the
      // per-item success checkpoint before enforcing the attempt budget. An
      // authoritative marker may only need projection repair, which must stay
      // recoverable even when the provider-producing attempt used the budget.
      try {
        const reconciledPackage = packageWithVerifiedSource(manifestItem, this.sourceRoot);
        const existing = this.store.get?.(reportVersionId(reconciledPackage));
        if (existing && existing.contentDigest === reconciledPackage.report.contentDigest) {
          const admitted = await this.admissionService.admit(reconciledPackage, {
            source: 'backfill',
          });
          this.store.reconcile?.();
          item.status = 'succeeded';
          item.error = null;
          item.reportVersionId = admitted?.reportVersionId || reportVersionId(reconciledPackage);
          item.ingestionId = admitted?.ingestionId || admitted?.ingestId || reportIngestionId(reconciledPackage);
          this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_ITEM_SUCCEEDED, state, { itemId: item.itemId }, {
            itemId: item.itemId,
            reportVersionId: item.reportVersionId,
            ingestionId: item.ingestionId,
            reconciled: true,
          });
          this.#save(state);
          continue;
        }
      } catch (error) {
        // The normal attempt below records source/package failures durably.
      }
      if (item.status === 'failed' && !retryFailed && item.attempts >= attemptsLimit) continue;
      if (item.attempts >= attemptsLimit) continue;
      if (item.status === 'failed' && retryFailed) item.error = null;
      item.status = 'running';
      item.attempts += 1;
      item.error = null;
      this.#save(state);
      try {
        const pkg = packageWithVerifiedSource(manifestItem, this.sourceRoot);
        // This is deliberately the sole write/admission seam. Backfill never
        // calls providers or reconstructs ReportLibraryStore persistence.
        const admitted = await this.admissionService.admit(pkg, {
          source: 'backfill',
        });
        item.status = 'succeeded';
        item.reportVersionId = admitted?.reportVersionId || admitted?.id || reportVersionId(pkg);
        item.ingestionId = admitted?.ingestionId || admitted?.ingestId || reportIngestionId(pkg);
        this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_ITEM_SUCCEEDED, state, { itemId: item.itemId }, {
          itemId: item.itemId,
          reportVersionId: item.reportVersionId,
          ingestionId: item.ingestionId,
        });
      } catch (error) {
        item.status = 'failed';
        item.error = errorDto(error);
        this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_ITEM_FAILED, state, { itemId: item.itemId, attempt: item.attempts }, {
          itemId: item.itemId,
          attempt: item.attempts,
          error: item.error,
        });
      }
      this.#save(state);
    }
    const summary = summarize(state);
    if (summary.succeeded === summary.total) {
      state.status = REPORT_LIBRARY_BACKFILL_STATUSES.SUCCEEDED;
      state.completedAt = nowIso(this.now);
      this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_COMPLETED, state, { manifestDigest: state.manifestDigest }, {
        itemCount: summary.total,
        succeeded: summary.succeeded,
      });
    } else {
      state.status = REPORT_LIBRARY_BACKFILL_STATUSES.FAILED;
      state.completedAt = null;
    }
    this.#save(state);
    return publicState(state);
  }

  async start(manifestInput, options = {}) {
    const manifest = freezeBackfillManifest(manifestInput);
    const state = this.#loadOrCreate(manifest);
    return this.#process(state.runId, options);
  }

  async resume(runIdOrManifest, options = {}) {
    let runId = runIdOrManifest;
    if (runIdOrManifest && typeof runIdOrManifest === 'object') {
      const manifest = freezeBackfillManifest(runIdOrManifest);
      const state = this.#loadOrCreate(manifest);
      runId = state.runId;
    }
    assertSafeId(runId, 'backfill runId');
    const state = this.#load(runId);
    if (state.status !== REPORT_LIBRARY_BACKFILL_STATUSES.SUCCEEDED) {
      state.status = REPORT_LIBRARY_BACKFILL_STATUSES.QUEUED;
      for (const item of Object.values(state.items)) {
        if (item.status === 'running') item.status = 'pending';
      }
      this.#event(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_RESUMED, state, { manifestDigest: state.manifestDigest }, {
        itemCount: state.manifest.items.length,
      });
      this.#save(state);
    }
    return this.#process(runId, { retryFailed: true, ...options });
  }

  status(runIdOrManifest) {
    const runId = runIdOrManifest && typeof runIdOrManifest === 'object'
      ? reportLibraryBackfillRunId(runIdOrManifest)
      : runIdOrManifest;
    assertSafeId(runId, 'backfill runId');
    return publicState(this.#load(runId));
  }

  async recoverInterrupted({ retryFailed = false } = {}) {
    if (!fs.existsSync(this.stateDir)) return [];
    const recovered = [];
    for (const entry of fs.readdirSync(this.stateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const state = parseState(path.join(this.stateDir, entry.name));
        if (state.status === REPORT_LIBRARY_BACKFILL_STATUSES.RUNNING || state.summary?.running) {
          recovered.push(await this.resume(state.runId, { retryFailed }));
        }
      } catch (error) {
        recovered.push({ runId: entry.name.slice(0, -5), status: 'failed', error: errorDto(error) });
      }
    }
    return recovered;
  }

  recover(options = {}) { return this.recoverInterrupted(options); }
  retry(runId, options = {}) { return this.resume(runId, { ...options, retryFailed: true }); }
}

export function startReportLibraryBackfill(manifest, options = {}) {
  const service = options.service || new ReportLibraryBackfill(options);
  return service.start(manifest, options);
}

export function resumeReportLibraryBackfill(runId, options = {}) {
  const service = options.service || new ReportLibraryBackfill(options);
  return service.resume(runId, options);
}

export function getReportLibraryBackfillStatus(runId, options = {}) {
  const service = options.service || new ReportLibraryBackfill(options);
  return service.status(runId);
}

export const startBackfill = startReportLibraryBackfill;
export const resumeBackfill = resumeReportLibraryBackfill;
export const statusBackfill = getReportLibraryBackfillStatus;
