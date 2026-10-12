import fs from 'node:fs';
import path from 'node:path';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';
import { atomicCreateFileSync, atomicWriteFileSync, withFileLockSync } from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import { safePublicFailure } from './safeFailure.js';
import { cloneReportValue, createReportValidators } from './reportValidation.js';
import {
  DAILY_REPORT_BATCH_CONTRACT,
  WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
  dailyReportBatchId,
  dailyReportBatchPlanFingerprint,
  normalizeDailyReportBatchPlan,
} from './reportContracts.js';
import {
  REPORT_LIBRARY_EVENT_TYPES,
  ReportLibraryEventStore,
  reportLibraryEventId,
} from './ReportLibraryEventStore.js';

export const DAILY_REPORT_BATCH_STATUS = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
});
export const DAILY_REPORT_BATCH_ADMISSION_CANDIDATE_CONTRACT = 'daily-report-batch-admission-candidate.v1';

function fail(message, code = 'DAILY_REPORT_BATCH_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

const clone = cloneReportValue;
const { safeId, digest, iso } = createReportValidators({
  fail,
  unsafeIdCode: 'DAILY_REPORT_BATCH_UNSAFE_ID',
  invalidDigestCode: 'DAILY_REPORT_BATCH_INVALID_DIGEST',
  invalidTimestampCode: 'DAILY_REPORT_BATCH_INVALID_TIMESTAMP',
});


function normalizeTerminalAttempts(value, {
  field,
  referenceField,
  fallbackCode,
  fallbackMessage,
}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    fail(`${field} must be a bounded array`, 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
  }
  return value.map((attempt, index) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
      fail(`${field}[${index}] must be an object`, 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
    }
    if (!['succeeded', 'failed'].includes(attempt.status)) {
      fail(`${field}[${index}] must be terminal`, 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
    }
    return {
      attemptId: safeId(attempt.attemptId, `${field}[${index}].attemptId`),
      [referenceField]: attempt[referenceField] == null
        ? null
        : safeId(attempt[referenceField], `${field}[${index}].${referenceField}`),
      status: attempt.status,
      error: attempt.status === 'failed'
        ? safePublicFailure(attempt.error, { fallbackCode, fallbackMessage })
        : null,
    };
  });
}

function normalizeProductionAttempts(value) {
  return normalizeTerminalAttempts(value, {
    field: 'productionAttempts',
    referenceField: 'analysisRunId',
    fallbackCode: 'REPORT_PRODUCTION_FAILED',
    fallbackMessage: 'Report production failed',
  });
}

function normalizeAdmissionAttempts(value) {
  return normalizeTerminalAttempts(value, {
    field: 'admissionAttempts',
    referenceField: 'reportVersionId',
    fallbackCode: 'REPORT_ADMISSION_FAILED',
    fallbackMessage: 'Report admission failed',
  });
}


function normalizeOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Daily Report Batch outcome must be an object', 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
  }
  if (value.status === 'succeeded') {
    if (value.stage !== 'admission') {
      fail('successful batch item stage must be admission', 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
    }
    return {
      status: 'succeeded',
      stage: 'admission',
      analysisRunId: safeId(value.analysisRunId, 'analysisRunId'),
      candidateId: value.candidateId == null ? null : safeId(value.candidateId, 'candidateId'),
      reportVersionId: safeId(value.reportVersionId, 'reportVersionId'),
      contentDigest: digest(value.contentDigest, 'contentDigest'),
      fingerprint: digest(value.fingerprint, 'fingerprint'),
      productionAttempts: normalizeProductionAttempts(value.productionAttempts),
      admissionAttempts: normalizeAdmissionAttempts(value.admissionAttempts),
    };
  }
  if (value.status === 'failed') {
    if (!['production', 'admission'].includes(value.stage)) {
      fail('failed batch item stage must be production or admission', 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
    }
    return {
      status: 'failed',
      stage: value.stage,
      analysisRunId: value.analysisRunId == null ? null : safeId(value.analysisRunId, 'analysisRunId'),
      candidateId: value.candidateId == null ? null : safeId(value.candidateId, 'candidateId'),
      error: safePublicFailure(value.error, { fallbackCode: value.stage === 'production' ? 'REPORT_PRODUCTION_FAILED' : 'REPORT_ADMISSION_FAILED', fallbackMessage: value.stage === 'production' ? 'Report production failed' : 'Report admission failed' }),
      productionAttempts: normalizeProductionAttempts(value.productionAttempts),
      admissionAttempts: normalizeAdmissionAttempts(value.admissionAttempts),
    };
  }
  fail('Daily Report Batch outcome must be terminal', 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
}

function comparableOutcome(value) {
  const projected = clone(value);
  // Preserve old closed batch bytes while allowing idempotent calls to compare
  // against the current outcome contract that no longer exposes Overview state.
  if (projected && typeof projected === 'object') delete projected.overview;
  return projected;
}

function stateDigest(state) {
  const { stateDigest: _stateDigest, ...content } = state;
  return canonicalSha256(content);
}

function batchFile(rootDir, productionDate) {
  return path.join(rootDir, 'batches', `${productionDate}.json`);
}

function readBatch(file) {
  assertOwnedStorageFile(file, 'Daily Report Batch', { allowMissing: false });
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('Daily Report Batch is corrupt', 'DAILY_REPORT_BATCH_CORRUPT', 500, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Daily Report Batch is invalid', 'DAILY_REPORT_BATCH_CORRUPT');
  }
  if (value.contract !== DAILY_REPORT_BATCH_CONTRACT || value.stateDigest !== stateDigest(value)) {
    fail('Daily Report Batch integrity check failed', 'DAILY_REPORT_BATCH_CORRUPT');
  }
  if (!Array.isArray(value.items)) fail('Daily Report Batch items are corrupt', 'DAILY_REPORT_BATCH_CORRUPT');
  for (const item of value.items) {
    if (item?.admissionCandidate != null) validateAdmissionCandidate(item.admissionCandidate);
  }
  return value;
}

function readTrustworthyBatches(batchesDir) {
  const batches = [];
  const names = fs.readdirSync(batchesDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
    .sort();
  for (const name of names) {
    try {
      batches.push(readBatch(path.join(batchesDir, name)));
    } catch {
      // A corrupt batch cannot serve as a trustworthy reverse index and must
      // not prevent recovery of candidate checkpoints in independent batches.
    }
  }
  return batches;
}

function writeBatch(file, state, { create = false } = {}) {
  const value = { ...state, stateDigest: stateDigest(state) };
  const serialized = `${canonicalStringify(value)}
`;
  if (create) atomicCreateFileSync(file, serialized);
  else atomicWriteFileSync(file, serialized);
  return value;
}

function initialItem(item) {
  return {
    ...clone(item),
    status: 'pending',
    outcome: null,
  };
}

function normalizeAdmissionCandidate(value, linkedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Daily Report Batch admission candidate must be an object', 'DAILY_REPORT_BATCH_INVALID_CANDIDATE', 400);
  }
  return {
    contract: DAILY_REPORT_BATCH_ADMISSION_CANDIDATE_CONTRACT,
    candidateId: safeId(value.candidateId, 'candidateId'),
    analysisRunId: safeId(value.analysisRunId, 'analysisRunId'),
    reportVersionId: safeId(value.reportVersionId, 'reportVersionId'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    fingerprint: digest(value.fingerprint, 'fingerprint'),
    overviewConfigDigest: digest(value.overviewConfigDigest, 'overviewConfigDigest'),
    admissionAttemptId: safeId(value.admissionAttemptId || 'admission-recovery', 'admissionAttemptId'),
    productionAttempts: normalizeProductionAttempts(value.productionAttempts || []),
    linkedAt: iso(linkedAt, 'Daily Report Batch candidate linkedAt'),
  };
}

function validateAdmissionCandidate(value) {
  try {
    const normalized = normalizeAdmissionCandidate(value, value?.linkedAt);
    if (canonicalStringify(normalized) !== canonicalStringify(value)) {
      fail('Daily Report Batch admission candidate has an invalid closed shape', 'DAILY_REPORT_BATCH_CORRUPT');
    }
  } catch (cause) {
    if (cause?.code === 'DAILY_REPORT_BATCH_CORRUPT') throw cause;
    fail('Daily Report Batch admission candidate is corrupt', 'DAILY_REPORT_BATCH_CORRUPT');
  }
}

function comparableAdmissionCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    contract: value.contract,
    candidateId: value.candidateId,
    analysisRunId: value.analysisRunId,
    reportVersionId: value.reportVersionId,
    contentDigest: value.contentDigest,
    fingerprint: value.fingerprint,
    overviewConfigDigest: value.overviewConfigDigest,
  };
}

export function createDailyReportAdmissionOutcome({
  association,
  admitted = null,
  error = null,
} = {}) {
  validateAdmissionCandidate(association);
  if ((admitted === null) === (error === null)) {
    fail(
      'Daily Report Batch admission outcome must contain exactly one result',
      'DAILY_REPORT_BATCH_INVALID_OUTCOME',
      400,
    );
  }
  if (admitted !== null) {
    if (!admitted || typeof admitted !== 'object' || Array.isArray(admitted)) {
      fail('Daily Report Batch admitted result must be an object', 'DAILY_REPORT_BATCH_INVALID_OUTCOME', 400);
    }
    const candidateId = safeId(admitted.candidateId, 'candidateId');
    const reportVersionIdValue = safeId(admitted.reportVersionId, 'reportVersionId');
    const contentDigestValue = digest(admitted.contentDigest, 'contentDigest');
    const fingerprintValue = admitted.reportVersion?.fingerprint == null
      ? association.fingerprint
      : digest(admitted.reportVersion.fingerprint, 'fingerprint');
    if (
      candidateId !== association.candidateId
      || reportVersionIdValue !== association.reportVersionId
      || contentDigestValue !== association.contentDigest
      || fingerprintValue !== association.fingerprint
    ) {
      fail(
        'Daily Report Batch admitted result conflicts with its candidate checkpoint',
        'DAILY_REPORT_BATCH_OUTCOME_CONFLICT',
        409,
      );
    }
    return deepFreeze(normalizeOutcome({
      status: 'succeeded',
      stage: 'admission',
      analysisRunId: association.analysisRunId,
      candidateId: association.candidateId,
      reportVersionId: association.reportVersionId,
      contentDigest: association.contentDigest,
      fingerprint: association.fingerprint,
      productionAttempts: association.productionAttempts,
      admissionAttempts: [{
        attemptId: association.admissionAttemptId,
        status: 'succeeded',
        reportVersionId: association.reportVersionId,
        error: null,
      }],
    }));
  }
  return deepFreeze(normalizeOutcome({
    status: 'failed',
    stage: 'admission',
    analysisRunId: association.analysisRunId,
    candidateId: association.candidateId,
    error,
    productionAttempts: association.productionAttempts,
    admissionAttempts: [{
      attemptId: association.admissionAttemptId,
      status: 'failed',
      reportVersionId: null,
      error,
    }],
  }));
}

export class DailyReportBatchStore {
  constructor({ rootDir, now = () => new Date().toISOString(), eventStore = null } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('DailyReportBatchStore rootDir is required');
    if (typeof now !== 'function') throw new TypeError('DailyReportBatchStore now must be a function');
    this.rootDir = path.resolve(rootDir);
    this.batchesDir = path.join(this.rootDir, 'batches');
    this.lockPath = path.join(this.batchesDir, '.locks', 'batches.lock');
    this.now = now;
    this.eventStore = eventStore || new ReportLibraryEventStore({ rootDir: this.rootDir, now });
    ensureOwnedStorageDirectory(this.rootDir, 'Report Library root', { create: true, recursive: true });
    ensureOwnedStorageDirectory(this.batchesDir, 'Daily Report Batch directory', { create: true });
    ensureOwnedStorageDirectory(path.dirname(this.lockPath), 'Daily Report Batch lock directory', { create: true });
    assertStorageLockBoundary(this.lockPath, 'Daily Report Batch lock');
  }

  create(input) {
    const plan = normalizeDailyReportBatchPlan(input);
    const batchId = dailyReportBatchId({
      productionDate: plan.productionDate,
      producerId: plan.producer.id,
    });
    const planFingerprint = dailyReportBatchPlanFingerprint(plan);
    const file = batchFile(this.rootDir, plan.productionDate);
    return withFileLockSync(this.lockPath, () => {
      if (fs.existsSync(file)) {
        const existing = readBatch(file);
        if (existing.batchId !== batchId || existing.planFingerprint !== planFingerprint) {
          fail(
            `Daily Report Batch identity conflict for ${plan.productionDate}`,
            'DAILY_REPORT_BATCH_IDENTITY_CONFLICT',
            409,
          );
        }
        this.#ensureCreatedEvent(existing);
        return deepFreeze({
          batchId: existing.batchId,
          created: false,
          replayed: true,
          batch: clone(existing),
        });
      }
      const createdAt = iso(this.now(), 'Daily Report Batch createdAt');
      const state = writeBatch(file, {
        contract: DAILY_REPORT_BATCH_CONTRACT,
        batchId,
        planFingerprint,
        productionDate: plan.productionDate,
        producer: clone(plan.producer),
        productionRunId: plan.productionRunId,
        status: DAILY_REPORT_BATCH_STATUS.OPEN,
        createdAt,
        items: plan.items.map(initialItem),
        completion: null,
      }, { create: true });
      this.#ensureCreatedEvent(state);
      return deepFreeze({
        batchId,
        created: true,
        replayed: false,
        batch: clone(state),
      });
    });
  }

  get(batchId) {
    const value = this.#readById(batchId);
    return value ? deepFreeze(clone(value.batch)) : null;
  }

  inspectItem(batchId, itemId) {
    const normalizedItemId = safeId(itemId, 'itemId');
    const found = this.#readById(batchId);
    if (!found) fail('Daily Report Batch not found', 'DAILY_REPORT_BATCH_NOT_FOUND', 404);
    const item = found.batch.items.find((candidate) => candidate.itemId === normalizedItemId);
    if (!item) fail('Daily Report Batch item not found', 'DAILY_REPORT_BATCH_ITEM_NOT_FOUND', 404);
    return deepFreeze({ batch: clone(found.batch), item: clone(item) });
  }

  findAdmissionCandidate(candidateId) {
    const normalizedCandidateId = safeId(candidateId, 'candidateId');
    return withFileLockSync(this.lockPath, () => {
      let match = null;
      for (const batch of readTrustworthyBatches(this.batchesDir)) {
        for (const item of batch.items) {
          if (item.admissionCandidate?.candidateId !== normalizedCandidateId) continue;
          if (match !== null) {
            fail(
              'Report admission candidate is bound to multiple Daily Report Batch items',
              'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT',
              409,
            );
          }
          match = { batch: clone(batch), item: clone(item) };
        }
      }
      return match === null ? null : deepFreeze(match);
    });
  }

  listPendingAdmissionCandidates() {
    return withFileLockSync(this.lockPath, () => {
      const items = [];
      for (const batch of readTrustworthyBatches(this.batchesDir)) {
        if (batch.status !== DAILY_REPORT_BATCH_STATUS.OPEN) continue;
        for (const item of batch.items) {
          if (item.status !== 'pending' || !item.admissionCandidate) continue;
          items.push({
            batchId: batch.batchId,
            itemId: item.itemId,
            admissionCandidate: clone(item.admissionCandidate),
          });
        }
      }
      return deepFreeze({
        schemaVersion: 'daily-report-batch-pending-admissions.v1',
        items,
      });
    });
  }

  linkAdmissionCandidate(batchId, itemId, candidateInput) {
    const normalizedItemId = safeId(itemId, 'itemId');
    const candidate = normalizeAdmissionCandidate(candidateInput, this.now());
    return withFileLockSync(this.lockPath, () => {
      const found = this.#readById(batchId);
      if (!found) fail('Daily Report Batch not found', 'DAILY_REPORT_BATCH_NOT_FOUND', 404);
      const { batch, file } = found;
      const index = batch.items.findIndex((item) => item.itemId === normalizedItemId);
      if (index < 0) fail('Daily Report Batch item not found', 'DAILY_REPORT_BATCH_ITEM_NOT_FOUND', 404);
      const item = batch.items[index];
      const existing = item.admissionCandidate || null;
      if (existing) {
        if (canonicalStringify(comparableAdmissionCandidate(existing)) !== canonicalStringify(comparableAdmissionCandidate(candidate))) {
          fail('Daily Report Batch item is already bound to another admission candidate', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
        }
        return deepFreeze({ batch: clone(batch), item: clone(item), created: false, replayed: true });
      }
      if (item.status !== 'pending' || batch.status !== DAILY_REPORT_BATCH_STATUS.OPEN) {
        if (item.outcome?.candidateId === candidate.candidateId) {
          return deepFreeze({ batch: clone(batch), item: clone(item), created: false, replayed: true });
        }
        fail('Daily Report Batch item cannot accept an admission candidate', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
      }
      const nextItem = { ...item, admissionCandidate: candidate };
      const items = batch.items.map((entry, itemIndex) => itemIndex === index ? nextItem : entry);
      const next = writeBatch(file, { ...batch, items });
      return deepFreeze({ batch: clone(next), item: clone(nextItem), created: true, replayed: false });
    });
  }

  createAdmissionCandidate(batchId, itemId, candidateInput, createCandidate) {
    const normalizedItemId = safeId(itemId, 'itemId');
    const candidate = normalizeAdmissionCandidate(candidateInput, this.now());
    if (typeof createCandidate !== 'function') {
      throw new TypeError('Daily Report Batch candidate creator must be a function');
    }
    return withFileLockSync(this.lockPath, () => {
      const found = this.#readById(batchId);
      if (!found) fail('Daily Report Batch not found', 'DAILY_REPORT_BATCH_NOT_FOUND', 404);
      const { batch, file } = found;
      const index = batch.items.findIndex((item) => item.itemId === normalizedItemId);
      if (index < 0) fail('Daily Report Batch item not found', 'DAILY_REPORT_BATCH_ITEM_NOT_FOUND', 404);
      const item = batch.items[index];
      const existing = item.admissionCandidate || null;
      if (existing) {
        if (canonicalStringify(comparableAdmissionCandidate(existing)) !== canonicalStringify(comparableAdmissionCandidate(candidate))) {
          fail('Daily Report Batch item is already bound to another admission candidate', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
        }
        fail(
          'A checkpointed Daily Report Batch admission candidate cannot be recreated',
          'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT',
          409,
        );
      }
      if (item.status !== 'pending' || batch.status !== DAILY_REPORT_BATCH_STATUS.OPEN) {
        fail('Daily Report Batch item cannot accept an admission candidate', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
      }

      // Keep the batch lock across the candidate create and checkpoint write.
      // A crash after candidate creation can leave only an orphan candidate,
      // which recovery can safely link from its complete frozen package. It
      // can never leave a checkpoint that falsely claims missing audit state.
      let createdCandidate;
      try {
        createdCandidate = createCandidate();
        if (createdCandidate && typeof createdCandidate.then === 'function') {
          throw new TypeError('Daily Report Batch candidate creator must be synchronous');
        }
        if (
          createdCandidate?.candidateId !== candidate.candidateId
          || createdCandidate.reportVersionId !== candidate.reportVersionId
          || createdCandidate.contentDigest !== candidate.contentDigest
          || createdCandidate.fingerprint !== candidate.fingerprint
          || createdCandidate.overviewConfigDigest !== candidate.overviewConfigDigest
          || canonicalStringify(createdCandidate.batch) !== canonicalStringify({ batchId, itemId: normalizedItemId })
        ) {
          fail('Created admission candidate does not match its Daily Report Batch checkpoint', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
        }
        const nextItem = { ...item, admissionCandidate: candidate };
        const items = batch.items.map((entry, itemIndex) => itemIndex === index ? nextItem : entry);
        const next = writeBatch(file, { ...batch, items });
        return deepFreeze({ batch: clone(next), item: clone(nextItem), created: true, replayed: false });
      } catch (error) {
        if (createdCandidate && error && typeof error === 'object' && !error.candidateId) {
          error.candidateId = candidate.candidateId;
        }
        throw error;
      }
    });
  }

  list({ status = null, limit = 100 } = {}) {
    const pageSize = Number.isInteger(Number(limit)) && Number(limit) > 0
      ? Math.min(Number(limit), 1000)
      : 100;
    const batches = fs.readdirSync(this.batchesDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
      .sort()
      .reverse()
      .map((name) => readBatch(path.join(this.batchesDir, name)))
      .filter((batch) => status === null || batch.status === status)
      .slice(0, pageSize)
      .map(clone);
    return deepFreeze({
      schemaVersion: 'daily-report-batch-list.v1',
      batches,
    });
  }

  recordOutcome(batchId, itemId, outcomeInput) {
    const normalizedItemId = safeId(itemId, 'itemId');
    const outcome = normalizeOutcome(outcomeInput);
    return withFileLockSync(this.lockPath, () => {
      const found = this.#readById(batchId);
      if (!found) fail('Daily Report Batch not found', 'DAILY_REPORT_BATCH_NOT_FOUND', 404);
      const { batch, file } = found;
      if (batch.status === DAILY_REPORT_BATCH_STATUS.CLOSED) {
        fail('Daily Report Batch is closed and immutable', 'DAILY_REPORT_BATCH_CLOSED', 409);
      }
      const index = batch.items.findIndex((item) => item.itemId === normalizedItemId);
      if (index < 0) fail('Daily Report Batch item not found', 'DAILY_REPORT_BATCH_ITEM_NOT_FOUND', 404);
      const existing = batch.items[index];
      if (existing.admissionCandidate && outcome.candidateId !== existing.admissionCandidate.candidateId) {
        fail('Daily Report Batch outcome does not match its bound admission candidate', 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT', 409);
      }
      if (existing.status !== 'pending') {
        if (canonicalStringify(comparableOutcome(existing.outcome)) !== canonicalStringify(outcome)) {
          fail('Daily Report Batch item outcome conflict', 'DAILY_REPORT_BATCH_OUTCOME_CONFLICT', 409);
        }
        this.#ensureItemEvent(batch, existing);
        return deepFreeze({ batch: clone(batch), item: clone(existing), replayed: true });
      }
      const completedAt = iso(this.now(), 'Daily Report Batch item completedAt');
      const item = {
        ...existing,
        status: outcome.status,
        outcome,
        completedAt,
      };
      const items = batch.items.map((candidate, itemIndex) => itemIndex === index ? item : candidate);
      const next = writeBatch(file, { ...batch, items });
      this.#ensureItemEvent(next, item);
      return deepFreeze({ batch: clone(next), item: clone(item), replayed: false });
    });
  }

  close(batchId, { pendingReportVersionIds = [], processingTarget = null } = {}) {
    if (!Array.isArray(pendingReportVersionIds)) {
      fail('pendingReportVersionIds must be an array', 'DAILY_REPORT_BATCH_INVALID_TRIGGER', 400);
    }
    const pendingIds = pendingReportVersionIds.map((id) => safeId(id, 'pendingReportVersionId'));
    const normalizedProcessingTarget = processingTarget === null
      ? null
      : safeId(processingTarget, 'processingTarget');
    if (new Set(pendingIds).size !== pendingIds.length) {
      fail('pendingReportVersionIds must be unique', 'DAILY_REPORT_BATCH_INVALID_TRIGGER', 400);
    }
    return withFileLockSync(this.lockPath, () => {
      const found = this.#readById(batchId);
      if (!found) fail('Daily Report Batch not found', 'DAILY_REPORT_BATCH_NOT_FOUND', 404);
      const { batch, file } = found;
      if (batch.status === DAILY_REPORT_BATCH_STATUS.CLOSED) {
        if (
          canonicalStringify(batch.completion?.processingTrigger?.pendingReportVersionIds || []) !== canonicalStringify(pendingIds)
          || (batch.completion?.processingTrigger?.processingTarget || null) !== normalizedProcessingTarget
        ) {
          fail('Daily Report Batch closure replay conflict', 'DAILY_REPORT_BATCH_CLOSURE_CONFLICT', 409);
        }
        this.#ensureClosureEvents(batch);
        return deepFreeze({
          batch: clone(batch),
          processingTrigger: clone(batch.completion.processingTrigger),
        });
      }
      const pendingItems = batch.items.filter((item) => item.status === 'pending');
      if (pendingItems.length) {
        fail(
          `Daily Report Batch cannot close with pending items: ${pendingItems.map((item) => item.itemId).join(', ')}`,
          'DAILY_REPORT_BATCH_PENDING_ITEMS',
          409,
        );
      }
      const closedAt = iso(this.now(), 'Daily Report Batch closedAt');
      const summary = batch.items.reduce((result, item) => {
        result[item.status] += 1;
        return result;
      }, { total: batch.items.length, succeeded: 0, failed: 0 });
      const triggerId = `worldview_trigger_${canonicalSha256({
        contract: WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
        batchId: batch.batchId,
      }).slice('sha256:'.length)}`;
      const processingTrigger = {
        contract: WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
        triggerId,
        batchId: batch.batchId,
        publishedAt: closedAt,
        status: pendingIds.length ? 'requested' : 'no-work',
        pendingReportVersionIds: [...pendingIds],
        pendingReportCount: pendingIds.length,
        coreWorldviewAgentCalls: 0,
        ...(normalizedProcessingTarget ? { processingTarget: normalizedProcessingTarget } : {}),
      };
      const completionValue = {
        closedAt,
        summary,
        processingTrigger,
      };
      const completion = {
        ...completionValue,
        completionDigest: canonicalSha256(completionValue),
      };
      const next = writeBatch(file, {
        ...batch,
        status: DAILY_REPORT_BATCH_STATUS.CLOSED,
        completion,
      });
      this.#ensureClosureEvents(next);
      return deepFreeze({
        batch: clone(next),
        processingTrigger: clone(processingTrigger),
      });
    });
  }

  #readById(batchId) {
    safeId(batchId, 'batchId');
    if (!batchId.startsWith('daily_batch_')) {
      fail('Daily Report Batch id is unsafe', 'DAILY_REPORT_BATCH_UNSAFE_ID', 400);
    }
    const names = fs.readdirSync(this.batchesDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name));
    for (const name of names) {
      const file = path.join(this.batchesDir, name);
      const batch = readBatch(file);
      if (batch.batchId === batchId) return { batch, file };
    }
    return null;
  }

  #ensureCreatedEvent(batch) {
    const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_CREATED, { batchId: batch.batchId });
    return this.eventStore.publish({
      eventId,
      eventType: REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_CREATED,
      correlationId: batch.batchId,
      causationId: null,
      runId: batch.batchId,
      payload: {
        batchId: batch.batchId,
        productionDate: batch.productionDate,
        producerId: batch.producer.id,
        itemCount: batch.items.length,
      },
    });
  }

  #ensureItemEvent(batch, item) {
    const createdEvent = this.#ensureCreatedEvent(batch);
    const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_ITEM_COMPLETED, {
      batchId: batch.batchId,
      itemId: item.itemId,
      outcome: item.outcome,
    });
    return this.eventStore.publish({
      eventId,
      eventType: REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_ITEM_COMPLETED,
      correlationId: batch.batchId,
      causationId: createdEvent.eventId,
      runId: batch.batchId,
      payload: {
        batchId: batch.batchId,
        itemId: item.itemId,
        projectId: item.projectId,
        status: item.status,
        outcome: clone(item.outcome),
      },
    });
  }

  #ensureClosureEvents(batch) {
    const createdEvent = this.#ensureCreatedEvent(batch);
    for (const item of batch.items) {
      if (item.status !== 'pending') this.#ensureItemEvent(batch, item);
    }
    const closedEventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_CLOSED, {
      batchId: batch.batchId,
      completionDigest: batch.completion.completionDigest,
    });
    const closedEvent = this.eventStore.publish({
      eventId: closedEventId,
      eventType: REPORT_LIBRARY_EVENT_TYPES.DAILY_REPORT_BATCH_CLOSED,
      correlationId: batch.batchId,
      causationId: createdEvent.eventId,
      runId: batch.batchId,
      payload: {
        batchId: batch.batchId,
        productionDate: batch.productionDate,
        completionDigest: batch.completion.completionDigest,
        summary: clone(batch.completion.summary),
      },
    });
    const trigger = batch.completion.processingTrigger;
    const triggerEventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.WORLDVIEW_PROCESSING_TRIGGERED, {
      triggerId: trigger.triggerId,
    });
    this.eventStore.publish({
      eventId: triggerEventId,
      eventType: REPORT_LIBRARY_EVENT_TYPES.WORLDVIEW_PROCESSING_TRIGGERED,
      correlationId: batch.batchId,
      causationId: closedEvent.eventId,
      runId: batch.batchId,
      payload: clone(trigger),
    });
  }
}

export const createDailyReportBatchStore = (options = {}) => new DailyReportBatchStore(options);
