import fs from 'node:fs';
import path from 'node:path';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';
import {
  atomicCreateFileSync,
  atomicWriteFileSync,
  processOwnerStatus,
  processStartIdentity,
  withFileLockSync,
} from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';
import {
  normalizeInternalReportPackage,
  normalizeReportOverviewContent,
  reportLogicalIdentity,
  reportVersionFingerprint,
  reportVersionId,
} from './reportContracts.js';
import { safePublicFailure, safePublicStopReason } from './safeFailure.js';

export const REPORT_ADMISSION_CANDIDATE_CONTRACT = 'report-admission-candidate.v1';
export const REPORT_ADMISSION_CANDIDATE_STATES = Object.freeze({
  STAGED: 'staged',
  ATTEMPTING: 'attempting',
  RETRYABLE: 'retryable',
  PREPARED: 'prepared',
  ADMITTED: 'admitted',
  BLOCKED: 'blocked',
});

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const CANDIDATE_FIELDS = Object.freeze([
  'contract', 'candidateId', 'reportVersionId', 'contentDigest', 'fingerprint', 'source', 'batch',
  'package', 'overviewConfigDigest', 'immediateAttemptBudget', 'state', 'stagedAt', 'updatedAt', 'attempts', 'ownership',
  'preparedOverview', 'admission', 'lastError', 'nextEligibleAt', 'stateDigest',
]);

function fail(message, code = 'REPORT_ADMISSION_STORE_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function candidateInFlightError(candidateId, cause) {
  const error = new Error(
    `Report admission candidate is already in progress: ${candidateId}`,
    { cause },
  );
  error.code = 'REPORT_ADMISSION_IN_FLIGHT';
  error.statusCode = 409;
  error.candidateId = candidateId;
  return error;
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    fail(`${field} is unsafe`, 'REPORT_ADMISSION_UNSAFE_ID', 400);
  }
  return value;
}

function iso(value, field) {
  if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be a canonical ISO timestamp`, 'REPORT_ADMISSION_INVALID_TIMESTAMP', 400);
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail(`${field} must be a sha256 digest`, 'REPORT_ADMISSION_INVALID_DIGEST', 400);
  }
  return value;
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  const expected = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !expected.has(field));
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length || missing.length) {
    fail(`${label} has an invalid closed shape`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function nullableIso(value, field) {
  return value === null ? null : iso(value, field);
}

function validateSafeFailure(value, field) {
  if (value === null) return null;
  exactKeys(value, ['code', 'message'], field);
  safeId(value.code, `${field}.code`);
  if (typeof value.message !== 'string' || value.message.length > 300) {
    fail(`${field}.message is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function hasSensitiveProvenanceText(value) {
  return /\bhttps?:\/\/|\bfile:\/\/|^[A-Za-z]:\\|^\/|\b(?:api[_-]?key|password|token)\s*[:=]|\bBearer\s+/iu.test(String(value || ''));
}

function safeStopReason(value) {
  if (value === null) return null;
  return safePublicStopReason(value);
}

function validateProvenance(value, field) {
  if (value === null) return null;
  exactKeys(value, [
    'agentId', 'agentVersion', 'effectiveConfigDigest', 'provider', 'model', 'live',
    'traceRef', 'stopReason', 'metrics',
  ], field);
  safeId(value.agentId, `${field}.agentId`);
  digest(value.effectiveConfigDigest, `${field}.effectiveConfigDigest`);
  for (const [name, limit] of [['agentVersion', 40], ['provider', 120], ['model', 160]]) {
    if (typeof value[name] !== 'string' || !value[name] || value[name].includes('\u0000') || value[name].length > limit
      || hasSensitiveProvenanceText(value[name])) {
      fail(`${field}.${name} is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
    }
  }
  if (typeof value.live !== 'boolean') fail(`${field}.live is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  for (const [name, limit] of [['traceRef', 300], ['stopReason', 120]]) {
    if (value[name] !== null && (typeof value[name] !== 'string' || value[name].includes('\u0000') || value[name].length > limit
      || hasSensitiveProvenanceText(value[name]))) {
      fail(`${field}.${name} is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
    }
  }
  if (!value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) {
    fail(`${field}.metrics is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  const metricEntries = Object.entries(value.metrics);
  if (metricEntries.length > 32 || metricEntries.some(([key, metric]) => (
    !/^[A-Za-z0-9_.:-]{1,80}$/u.test(key)
    || !(typeof metric === 'boolean' || (typeof metric === 'number' && Number.isFinite(metric)))
  ))) {
    fail(`${field}.metrics is invalid`, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function validateAttempt(attempt, index) {
  exactKeys(attempt, [
    'attemptId', 'status', 'startedAt', 'completedAt', 'error', 'provenance', 'stopReason',
    'reclaimCount', 'reclaimedAt',
  ], `candidate attempts[${index}]`);
  safeId(attempt.attemptId, `candidate attempts[${index}].attemptId`);
  if (!['running', 'failed', 'succeeded'].includes(attempt.status)) {
    fail('candidate attempt status is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  iso(attempt.startedAt, `candidate attempts[${index}].startedAt`);
  nullableIso(attempt.completedAt, `candidate attempts[${index}].completedAt`);
  nullableIso(attempt.reclaimedAt, `candidate attempts[${index}].reclaimedAt`);
  if (!Number.isInteger(attempt.reclaimCount) || attempt.reclaimCount < 0) {
    fail('candidate attempt reclaimCount is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  validateSafeFailure(attempt.error, `candidate attempts[${index}].error`);
  if (attempt.stopReason !== null && (typeof attempt.stopReason !== 'string' || attempt.stopReason.length > 120)) {
    fail('candidate attempt stopReason is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  validateProvenance(attempt.provenance, `candidate attempts[${index}].provenance`);
  if (attempt.status === 'running' && (attempt.completedAt !== null || attempt.error !== null)) {
    fail('running candidate attempt is terminal', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  if (attempt.status !== 'running' && attempt.completedAt === null) {
    fail('terminal candidate attempt lacks completedAt', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return attempt;
}

function validateOwnership(value, candidate) {
  if (value === null) return null;
  const fields = ['ownerToken', 'pid', 'attemptId', 'claimedAt', 'leaseExpiresAt'];
  const hasProcessStartIdentity = Object.prototype.hasOwnProperty.call(value, 'processStartIdentity');
  exactKeys(value, hasProcessStartIdentity ? [...fields, 'processStartIdentity'] : fields, 'candidate ownership');
  safeId(value.ownerToken, 'candidate ownership.ownerToken');
  safeId(value.attemptId, 'candidate ownership.attemptId');
  if (!Number.isInteger(value.pid) || value.pid <= 0) fail('candidate ownership.pid is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  if (hasProcessStartIdentity && value.processStartIdentity !== null) {
    safeId(value.processStartIdentity, 'candidate ownership.processStartIdentity');
  }
  iso(value.claimedAt, 'candidate ownership.claimedAt');
  iso(value.leaseExpiresAt, 'candidate ownership.leaseExpiresAt');
  if (!candidate.attempts.some((attempt) => attempt.attemptId === value.attemptId && attempt.status === 'running')) {
    fail('candidate ownership has no running attempt', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function validatePreparedOverview(value, candidate) {
  if (value === null) return null;
  exactKeys(value, ['content', 'provenance', 'producedAt', 'attemptId'], 'candidate preparedOverview');
  const content = normalizeReportOverviewContent(value.content);
  if (content.reportVersionId !== candidate.reportVersionId || content.contentDigest !== candidate.contentDigest) {
    fail('candidate prepared Overview binding is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  safeId(value.attemptId, 'candidate preparedOverview.attemptId');
  iso(value.producedAt, 'candidate preparedOverview.producedAt');
  if (value.provenance === null) fail('candidate prepared Overview provenance is missing', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  validateProvenance(value.provenance, 'candidate preparedOverview.provenance');
  if (value.provenance.effectiveConfigDigest !== candidate.overviewConfigDigest) {
    fail('candidate prepared Overview config binding is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function validateAdmission(value, candidate) {
  if (value === null) return null;
  exactKeys(value, [
    'contract', 'candidateId', 'reportVersionId', 'contentDigest', 'fingerprint', 'overviewId',
    'overviewDigest', 'source', 'batch', 'admittedAt', 'admissionSequence', 'initialProcessingStatus',
  ], 'candidate admission');
  if (value.contract !== 'report-admission-receipt.v1'
    || value.candidateId !== candidate.candidateId
    || value.reportVersionId !== candidate.reportVersionId
    || value.contentDigest !== candidate.contentDigest
    || value.fingerprint !== candidate.fingerprint
    || value.source !== candidate.source
    || value.initialProcessingStatus !== 'Pending'
    || canonicalStringify(value.batch) !== canonicalStringify(candidate.batch)) {
    fail('candidate admission binding is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  safeId(value.overviewId, 'candidate admission.overviewId');
  digest(value.overviewDigest, 'candidate admission.overviewDigest');
  iso(value.admittedAt, 'candidate admission.admittedAt');
  if (!Number.isInteger(value.admissionSequence) || value.admissionSequence < 1) {
    fail('candidate admission sequence is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function validateCandidate(value) {
  exactKeys(value, CANDIDATE_FIELDS, 'Report admission candidate');
  if (value.contract !== REPORT_ADMISSION_CANDIDATE_CONTRACT || !Object.values(REPORT_ADMISSION_CANDIDATE_STATES).includes(value.state)) {
    fail('Report admission candidate contract or state is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  safeId(value.candidateId, 'candidateId');
  safeId(value.reportVersionId, 'candidate reportVersionId');
  digest(value.contentDigest, 'candidate contentDigest');
  digest(value.fingerprint, 'candidate fingerprint');
  digest(value.overviewConfigDigest, 'candidate overviewConfigDigest');
  if (!Number.isInteger(value.immediateAttemptBudget) || value.immediateAttemptBudget < 1) {
    fail('candidate immediateAttemptBudget is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  if (normalizeSource(value.source) !== value.source) {
    fail('candidate source is not normalized', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  const normalizedBatch = value.batch === null ? null : normalizeBatchRef(value.batch);
  if (canonicalStringify(normalizedBatch) !== canonicalStringify(value.batch)) {
    fail('candidate batch binding is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  iso(value.stagedAt, 'candidate stagedAt');
  iso(value.updatedAt, 'candidate updatedAt');
  nullableIso(value.nextEligibleAt, 'candidate nextEligibleAt');
  if (!Array.isArray(value.attempts) || value.attempts.length > 10_000) {
    fail('candidate attempts are invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  value.attempts.forEach(validateAttempt);
  validateOwnership(value.ownership, value);
  validateSafeFailure(value.lastError, 'candidate lastError');
  validatePreparedOverview(value.preparedOverview, value);
  validateAdmission(value.admission, value);
  if ((value.state === REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING) !== (value.ownership !== null)) {
    fail('candidate ownership does not match state', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  if ([REPORT_ADMISSION_CANDIDATE_STATES.PREPARED, REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED].includes(value.state)
    && value.preparedOverview === null) {
    fail('prepared candidate lacks Overview', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  if ((value.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) !== (value.admission !== null)) {
    fail('candidate admission does not match state', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function normalizeSource(value) {
  const source = String(value || 'producer').trim().toLowerCase();
  if (!['producer', 'backfill'].includes(source)) {
    fail('candidate source must be producer or backfill', 'REPORT_ADMISSION_INVALID_SOURCE', 400);
  }
  return source;
}

function normalizeBatchRef({ batchId = null, itemId = null } = {}) {
  if (batchId === null && itemId === null) return null;
  if (batchId === null || itemId === null) {
    fail('candidate batchId and itemId must be supplied together', 'REPORT_ADMISSION_INVALID_BATCH_REF', 400);
  }
  return { batchId: safeId(batchId, 'candidate batchId'), itemId: safeId(itemId, 'candidate itemId') };
}

function validatePackageBatchBinding(reportPackage, batch, source) {
  if (source === 'backfill') {
    if (batch !== null) {
      fail(
        'backfill admission cannot claim a current Daily Report Batch item',
        'REPORT_ADMISSION_INVALID_BATCH_REF',
        409,
      );
    }
    return;
  }
  const hasDailyLineage = reportPackage.dailyReport !== null;
  const hasBatchRef = batch !== null;
  if (hasDailyLineage !== hasBatchRef || (hasBatchRef && reportPackage.dailyReport.runId !== batch.batchId)) {
    fail(
      'producer admission daily lineage must match an exact batch and item reference',
      'REPORT_ADMISSION_INVALID_BATCH_REF',
      409,
    );
  }
}

export function normalizeReportAdmissionBinding(packageInput, {
  source = 'producer',
  batchId = null,
  itemId = null,
} = {}) {
  const reportPackage = normalizeInternalReportPackage(packageInput);
  const normalizedSource = normalizeSource(source);
  const batch = normalizeBatchRef({ batchId, itemId });
  validatePackageBatchBinding(reportPackage, batch, normalizedSource);
  return deepFreeze({
    source: normalizedSource,
    batch: batch === null ? null : clone(batch),
  });
}

function stateDigest(value) {
  const { stateDigest: _stateDigest, ...content } = value;
  return canonicalSha256(content);
}

function candidateFile(rootDir, candidateId) {
  return path.join(rootDir, 'admission-candidates', `${safeId(candidateId, 'candidateId')}.json`);
}

function clone(value) {
  return structuredClone(value);
}

function readCandidate(file) {
  assertOwnedStorageFile(file, 'Report admission candidate', { allowMissing: false });
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('Report admission candidate is corrupt', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  if (value?.contract !== REPORT_ADMISSION_CANDIDATE_CONTRACT || value.stateDigest !== stateDigest(value)) {
    fail('Report admission candidate integrity check failed', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  validateCandidate(value);
  const reportPackage = normalizeInternalReportPackage(value.package);
  if (
    canonicalStringify(reportPackage) !== canonicalStringify(value.package)
    || reportVersionId(reportPackage) !== value.reportVersionId
    || reportPackage.report.contentDigest !== value.contentDigest
    || reportVersionFingerprint(reportPackage) !== value.fingerprint
    || reportAdmissionCandidateId(reportPackage) !== value.candidateId
  ) {
    fail('Report admission candidate package binding is invalid', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  }
  return value;
}

function claimsBatchBinding(file, batch) {
  // Probe only the association first: fully validating every historical file
  // would let one unrelated corrupt candidate block all new daily admissions.
  assertOwnedStorageFile(file, 'Report admission candidate', { allowMissing: false });
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  return value?.batch?.batchId === batch.batchId && value?.batch?.itemId === batch.itemId;
}

function writeCandidate(file, value, { create = false } = {}) {
  const candidate = { ...value, stateDigest: stateDigest(value) };
  const serialized = `${canonicalStringify(candidate)}\n`;
  if (create) atomicCreateFileSync(file, serialized);
  else atomicWriteFileSync(file, serialized);
  return candidate;
}

function ownershipActive(ownership, nowMs) {
  if (!ownership) return false;
  const ownerStatus = processOwnerStatus(ownership);
  if (ownerStatus === 'dead') return false;
  // A live owner may be paused between the provider request and durable result.
  // Prefer at-most-once physical execution over reclaiming a merely expired
  // heartbeat; dead and PID-reused owners remain reclaimable by identity.
  if (ownerStatus === 'alive') return true;
  const expiresAt = Date.parse(ownership.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function isRecoverableCandidate(candidate, nowMs) {
  if ([REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED].includes(candidate.state)) {
    return false;
  }
  if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING) {
    return !ownershipActive(candidate.ownership, nowMs);
  }
  if (candidate.state !== REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE) return true;
  return !candidate.nextEligibleAt || Date.parse(candidate.nextEligibleAt) <= nowMs;
}

function comparableIdentity(candidate) {
  return {
    contract: candidate.contract,
    candidateId: candidate.candidateId,
    reportVersionId: candidate.reportVersionId,
    contentDigest: candidate.contentDigest,
    fingerprint: candidate.fingerprint,
    source: candidate.source,
    batch: candidate.batch,
    package: candidate.package,
    overviewConfigDigest: candidate.overviewConfigDigest,
    immediateAttemptBudget: candidate.immediateAttemptBudget,
  };
}

export function reportAdmissionCandidateId(packageInput) {
  const reportPackage = normalizeInternalReportPackage(packageInput);
  return `candidate_${reportLogicalIdentity(reportPackage).slice('sha256:'.length)}`;
}

export class ReportAdmissionStore {
  constructor({ rootDir, now = () => new Date().toISOString(), lockOptions = {} } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('ReportAdmissionStore rootDir is required');
    if (typeof now !== 'function') throw new TypeError('ReportAdmissionStore now must be a function');
    if (!lockOptions || typeof lockOptions !== 'object' || Array.isArray(lockOptions)) {
      throw new TypeError('ReportAdmissionStore lockOptions must be an object');
    }
    this.rootDir = path.resolve(rootDir);
    this.candidatesDir = path.join(this.rootDir, 'admission-candidates');
    this.locksDir = path.join(this.candidatesDir, '.locks');
    this.candidateLocksDir = path.join(this.locksDir, 'candidates');
    this.stageLockPath = path.join(this.locksDir, 'stage.lock');
    this.now = now;
    this.lockOptions = { ...lockOptions };
    ensureOwnedStorageDirectory(this.rootDir, 'Report Library root', { create: true, recursive: true });
    ensureOwnedStorageDirectory(this.candidatesDir, 'Report admission candidate directory', { create: true });
    ensureOwnedStorageDirectory(this.locksDir, 'Report admission lock directory', { create: true });
    ensureOwnedStorageDirectory(this.candidateLocksDir, 'Report admission candidate lock directory', { create: true });
    assertStorageLockBoundary(this.stageLockPath, 'Report admission staging lock');
  }

  #candidateLockPath(candidateId) {
    const lockPath = path.join(this.candidateLocksDir, `${safeId(candidateId, 'candidateId')}.lock`);
    assertStorageLockBoundary(lockPath, 'Report admission candidate lock');
    return lockPath;
  }

  #withCandidateLock(candidateId, action) {
    try {
      return withFileLockSync(this.#candidateLockPath(candidateId), action, this.lockOptions);
    } catch (error) {
      if (error?.code === 'FILE_LOCK_TIMEOUT') {
        throw candidateInFlightError(candidateId, error);
      }
      throw error;
    }
  }

  stage(packageInput, {
    source = 'producer',
    batchId = null,
    itemId = null,
    overviewConfigDigest,
    immediateAttemptBudget,
    stagedAt = this.now(),
    beforeCreate = null,
  } = {}) {
    if (beforeCreate !== null && typeof beforeCreate !== 'function') {
      throw new TypeError('candidate beforeCreate must be a function');
    }
    const reportPackage = normalizeInternalReportPackage(packageInput);
    const candidateId = reportAdmissionCandidateId(reportPackage);
    const file = candidateFile(this.rootDir, candidateId);
    const binding = normalizeReportAdmissionBinding(reportPackage, { source, batchId, itemId });
    const identity = {
      contract: REPORT_ADMISSION_CANDIDATE_CONTRACT,
      candidateId,
      reportVersionId: reportVersionId(reportPackage),
      contentDigest: reportPackage.report.contentDigest,
      fingerprint: reportVersionFingerprint(reportPackage),
      source: binding.source,
      batch: binding.batch,
      package: clone(reportPackage),
      overviewConfigDigest: digest(overviewConfigDigest, 'candidate overviewConfigDigest'),
      immediateAttemptBudget: Number(immediateAttemptBudget),
    };
    if (!Number.isInteger(identity.immediateAttemptBudget) || identity.immediateAttemptBudget < 1) {
      fail('candidate immediateAttemptBudget must be a positive integer', 'REPORT_ADMISSION_INVALID_ATTEMPT_BUDGET', 400);
    }
    try {
      // Wait for candidate-local ownership before entering the short global
      // uniqueness fence. A contended replay must not hold up unrelated
      // candidates while it waits for its own lock.
      return this.#withCandidateLock(candidateId, () => withFileLockSync(this.stageLockPath, () => {
        if (fs.existsSync(file)) {
          const existing = readCandidate(file);
          if (canonicalStringify(comparableIdentity(existing)) !== canonicalStringify(comparableIdentity(identity))) {
            fail('Report admission candidate identity conflict', 'REPORT_ADMISSION_CANDIDATE_CONFLICT', 409);
          }
          return deepFreeze({ candidate: clone(existing), created: false, replayed: true });
        }
        if (binding.batch !== null) {
          const conflicting = fs.readdirSync(this.candidatesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
            .map((entry) => path.join(this.candidatesDir, entry.name))
            .filter((candidatePath) => claimsBatchBinding(candidatePath, binding.batch))
            .map((candidatePath) => readCandidate(candidatePath))
            .find((candidate) => (
              candidate.candidateId !== candidateId
              && canonicalStringify(candidate.batch) === canonicalStringify(binding.batch)
            ));
          if (conflicting) {
            fail(
              'Daily Report Batch item is already bound to another admission candidate',
              'REPORT_ADMISSION_CANDIDATE_CONFLICT',
              409,
            );
          }
        }
        let candidate = null;
        const createCandidate = () => {
          if (candidate) return deepFreeze(clone(candidate));
          const timestamp = iso(stagedAt, 'candidate stagedAt');
          candidate = writeCandidate(file, {
            ...identity,
            state: REPORT_ADMISSION_CANDIDATE_STATES.STAGED,
            stagedAt: timestamp,
            updatedAt: timestamp,
            attempts: [],
            ownership: null,
            preparedOverview: null,
            admission: null,
            lastError: null,
            nextEligibleAt: null,
          }, { create: true });
          return deepFreeze(clone(candidate));
        };
        if (beforeCreate) {
          const guardResult = beforeCreate(deepFreeze({
            candidateId,
            reportVersionId: identity.reportVersionId,
            contentDigest: identity.contentDigest,
            fingerprint: identity.fingerprint,
            analysisRunId: reportPackage.lineage.analysisRunId,
            overviewConfigDigest: identity.overviewConfigDigest,
            immediateAttemptBudget: identity.immediateAttemptBudget,
            binding: clone(binding),
          }), createCandidate);
          if (guardResult && typeof guardResult.then === 'function') {
            throw new TypeError('candidate beforeCreate must be synchronous');
          }
        }
        const created = candidate || createCandidate();
        return deepFreeze({ candidate: clone(created), created: true, replayed: false });
      }, this.lockOptions));
    } catch (error) {
      if (error?.code === 'FILE_LOCK_TIMEOUT') {
        throw candidateInFlightError(candidateId, error);
      }
      throw error;
    }
  }

  get(candidateId) {
    const file = candidateFile(this.rootDir, candidateId);
    if (!fs.existsSync(file)) return null;
    return deepFreeze(clone(readCandidate(file)));
  }

  withCandidateLock(candidateId, action) {
    const normalizedCandidateId = safeId(candidateId, 'candidateId');
    if (typeof action !== 'function') throw new TypeError('candidate lock action must be a function');
    return this.#withCandidateLock(normalizedCandidateId, () => {
      const file = candidateFile(this.rootDir, normalizedCandidateId);
      if (!fs.existsSync(file)) {
        fail(`Report admission candidate not found: ${normalizedCandidateId}`, 'REPORT_ADMISSION_CANDIDATE_NOT_FOUND', 404);
      }
      const result = action(deepFreeze(clone(readCandidate(file))));
      if (result && typeof result.then === 'function') {
        throw new TypeError('candidate lock action must be synchronous');
      }
      return result;
    });
  }

  reconcileUnavailable(candidateId, reconcile) {
    safeId(candidateId, 'candidateId');
    if (typeof reconcile !== 'function') {
      throw new TypeError('candidate unavailable reconciliation must be a function');
    }
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      if (fs.existsSync(file)) {
        try {
          return deepFreeze({
            available: true,
            candidate: clone(readCandidate(file)),
            error: null,
            reconciliation: null,
          });
        } catch (error) {
          return {
            available: false,
            candidate: null,
            error,
            reconciliation: reconcile({ candidateId, error }),
          };
        }
      }
      return {
        available: false,
        candidate: null,
        error: null,
        reconciliation: reconcile({ candidateId, error: null }),
      };
    });
  }

  list() {
    const entries = fs.readdirSync(this.candidatesDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => {
        if (entry.name === '.locks' && entry.isDirectory() && !entry.isSymbolicLink()) return false;
        if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
          fail('Report admission candidate directory contains an invalid entry', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
        }
        return true;
      })
      .map((entry) => readCandidate(path.join(this.candidatesDir, entry.name)))
      .sort((left, right) => left.stagedAt.localeCompare(right.stagedAt) || left.candidateId.localeCompare(right.candidateId));
    return deepFreeze(candidates.map(clone));
  }

  listRecoverable({ at = this.now() } = {}) {
    const nowMs = Date.parse(iso(at, 'recovery at'));
    return this.list().filter((candidate) => isRecoverableCandidate(candidate, nowMs));
  }

  scanRecoverable({ at = this.now() } = {}) {
    const nowMs = Date.parse(iso(at, 'recovery at'));
    return this.#scanCandidates((candidate) => isRecoverableCandidate(candidate, nowMs));
  }

  scanAll() {
    return this.#scanCandidates(() => true);
  }

  #scanCandidates(include) {
    const candidates = [];
    const failures = [];
    const entries = fs.readdirSync(this.candidatesDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.locks' && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let candidateId = null;
      try {
        if (!entry.name.endsWith('.json')) {
          fail('Report admission candidate directory contains an invalid entry', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
        }
        candidateId = safeId(entry.name.slice(0, -'.json'.length), 'candidateId');
        if (entry.isSymbolicLink() || !entry.isFile()) {
          fail('Report admission candidate directory contains an invalid entry', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
        }
        const candidate = readCandidate(path.join(this.candidatesDir, entry.name));
        if (candidate.candidateId !== candidateId) {
          fail('Report admission candidate filename does not match its identity', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
        }
        if (include(candidate)) candidates.push(candidate);
      } catch (error) {
        failures.push({
          candidateId,
          error: safePublicFailure(error, {
            fallbackCode: 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
            fallbackMessage: 'Report admission candidate state was corrupt',
          }),
        });
      }
    }
    candidates.sort((left, right) => left.stagedAt.localeCompare(right.stagedAt) || left.candidateId.localeCompare(right.candidateId));
    return deepFreeze({
      candidates: candidates.map(clone),
      failures: failures.map(clone),
    });
  }

  claim(candidateId, {
    ownerToken,
    pid = process.pid,
    claimedAt = this.now(),
    leaseMs = 10 * 60_000,
    ignoreEligibility = false,
  } = {}) {
    safeId(ownerToken, 'ownerToken');
    if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('candidate owner pid must be positive');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new TypeError('candidate leaseMs must be at least 1000');
    const timestamp = iso(claimedAt, 'candidate claimedAt');
    const nowMs = Date.parse(timestamp);
    const ownerProcessStartIdentity = processStartIdentity(pid);
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      const candidate = readCandidate(file);
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) {
        return deepFreeze({ claimed: false, reason: 'admitted', candidate: clone(candidate) });
      }
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED) {
        return deepFreeze({ claimed: false, reason: 'blocked', candidate: clone(candidate) });
      }
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.PREPARED) {
        return deepFreeze({ claimed: false, reason: 'prepared', candidate: clone(candidate) });
      }
      if (
        candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE
        && !ignoreEligibility
        && candidate.nextEligibleAt
        && Date.parse(candidate.nextEligibleAt) > nowMs
      ) {
        return deepFreeze({ claimed: false, reason: 'not-eligible', candidate: clone(candidate) });
      }
      if (ownershipActive(candidate.ownership, nowMs) && candidate.ownership.ownerToken !== ownerToken) {
        return deepFreeze({ claimed: false, reason: 'owned', candidate: clone(candidate) });
      }
      if (ownershipActive(candidate.ownership, nowMs)) {
        return deepFreeze({ claimed: false, reason: 'owned', candidate: clone(candidate) });
      }
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING) {
        const attemptId = safeId(candidate.ownership?.attemptId, 'candidate ownership attemptId');
        const attemptIndex = candidate.attempts.findIndex((attempt) => attempt.attemptId === attemptId);
        if (attemptIndex < 0 || candidate.attempts[attemptIndex].status !== 'running') {
          fail('Interrupted report admission attempt is corrupt', 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
        }
        const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
        const next = writeCandidate(file, {
          ...candidate,
          stateDigest: undefined,
          updatedAt: timestamp,
          ownership: {
            ownerToken,
            pid,
            processStartIdentity: ownerProcessStartIdentity,
            attemptId,
            claimedAt: timestamp,
            leaseExpiresAt,
          },
          attempts: candidate.attempts.map((attempt, index) => index === attemptIndex ? {
            ...attempt,
            reclaimCount: Number(attempt.reclaimCount || 0) + 1,
            reclaimedAt: timestamp,
          } : attempt),
        });
        return deepFreeze({ claimed: true, reason: 'reclaimed', attemptId, candidate: clone(next) });
      }
      const ordinal = candidate.attempts.length + 1;
      const attemptId = `attempt-${String(ordinal).padStart(6, '0')}`;
      const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      const next = writeCandidate(file, {
        ...candidate,
        stateDigest: undefined,
        state: REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING,
        updatedAt: timestamp,
        ownership: {
          ownerToken,
          pid,
          processStartIdentity: ownerProcessStartIdentity,
          attemptId,
          claimedAt: timestamp,
          leaseExpiresAt,
        },
        attempts: [...candidate.attempts, {
          attemptId,
          status: 'running',
          startedAt: timestamp,
          completedAt: null,
          error: null,
          provenance: null,
          stopReason: null,
          reclaimCount: 0,
          reclaimedAt: null,
        }],
      });
      return deepFreeze({ claimed: true, reason: null, attemptId, candidate: clone(next) });
    });
  }

  renew(candidateId, {
    ownerToken,
    attemptId,
    renewedAt = this.now(),
    leaseMs = 10 * 60_000,
  } = {}) {
    safeId(ownerToken, 'ownerToken');
    safeId(attemptId, 'attemptId');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new TypeError('candidate leaseMs must be at least 1000');
    const timestamp = iso(renewedAt, 'candidate renewedAt');
    const leaseExpiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString();
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      const candidate = readCandidate(file);
      if (
        candidate.state !== REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING
        || candidate.ownership?.ownerToken !== ownerToken
        || candidate.ownership?.attemptId !== attemptId
      ) {
        fail('Report admission lease ownership mismatch', 'REPORT_ADMISSION_OWNERSHIP_CONFLICT', 409);
      }
      const next = writeCandidate(file, {
        ...candidate,
        stateDigest: undefined,
        updatedAt: timestamp,
        ownership: { ...candidate.ownership, leaseExpiresAt },
      });
      return deepFreeze(clone(next));
    });
  }

  markFailure(candidateId, {
    ownerToken,
    attemptId,
    error,
    retryable = true,
    provenance = null,
    stopReason = null,
    failedAt = this.now(),
    nextEligibleAt = failedAt,
  } = {}) {
    const timestamp = iso(failedAt, 'candidate failedAt');
    const eligibleAt = iso(nextEligibleAt, 'candidate nextEligibleAt');
    return this.#finishAttempt(candidateId, { ownerToken, attemptId }, (candidate, index) => ({
      ...candidate,
      state: retryable ? REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE : REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED,
      updatedAt: timestamp,
      ownership: null,
      nextEligibleAt: retryable ? eligibleAt : null,
      lastError: safePublicFailure(error, {
        fallbackCode: 'REPORT_OVERVIEW_PRODUCTION_FAILED',
        fallbackMessage: 'Report Overview production failed',
      }),
      attempts: candidate.attempts.map((attempt, attemptIndex) => attemptIndex === index ? {
        ...attempt,
        status: 'failed',
        completedAt: timestamp,
        error: safePublicFailure(error, {
          fallbackCode: 'REPORT_OVERVIEW_PRODUCTION_FAILED',
          fallbackMessage: 'Report Overview production failed',
        }),
        provenance: provenance === null ? null : clone(provenance),
        stopReason: safeStopReason(stopReason),
      } : attempt),
    }));
  }

  markPrepared(candidateId, {
    ownerToken,
    attemptId,
    preparedOverview,
    preparedAt = this.now(),
  } = {}) {
    const timestamp = iso(preparedAt, 'candidate preparedAt');
    return this.#finishAttempt(candidateId, { ownerToken, attemptId }, (candidate, index) => ({
      ...candidate,
      state: REPORT_ADMISSION_CANDIDATE_STATES.PREPARED,
      updatedAt: timestamp,
      ownership: null,
      nextEligibleAt: null,
      lastError: null,
      preparedOverview: clone(preparedOverview),
      attempts: candidate.attempts.map((attempt, attemptIndex) => attemptIndex === index ? {
        ...attempt,
        status: 'succeeded',
        completedAt: timestamp,
        error: null,
        provenance: clone(preparedOverview.provenance || null),
        stopReason: safeStopReason(preparedOverview.provenance?.stopReason || null),
      } : attempt),
    }));
  }

  blockPrepared(candidateId, {
    error,
    blockedAt = this.now(),
  } = {}) {
    const timestamp = iso(blockedAt, 'candidate blockedAt');
    const safeError = safePublicFailure(error, {
      fallbackCode: 'REPORT_ADMISSION_FAILED',
      fallbackMessage: 'Report admission failed',
    });
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      const candidate = readCandidate(file);
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED) {
        if (canonicalStringify(candidate.lastError) !== canonicalStringify(safeError)) {
          fail('Report admission blocked state conflict', 'REPORT_ADMISSION_ATTEMPT_CONFLICT', 409);
        }
        return deepFreeze(clone(candidate));
      }
      if (candidate.state !== REPORT_ADMISSION_CANDIDATE_STATES.PREPARED) {
        fail('Report admission candidate is not prepared', 'REPORT_ADMISSION_INVALID_STATE', 409);
      }
      const next = writeCandidate(file, {
        ...candidate,
        stateDigest: undefined,
        state: REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED,
        updatedAt: timestamp,
        ownership: null,
        nextEligibleAt: null,
        lastError: safeError,
      });
      return deepFreeze(clone(next));
    });
  }

  markAdmitted(candidateId, admission, { updatedAt = this.now() } = {}) {
    const timestamp = iso(updatedAt, 'candidate admitted updatedAt');
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      const candidate = readCandidate(file);
      if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) {
        if (canonicalStringify(candidate.admission) !== canonicalStringify(admission)) {
          fail('Report admission receipt conflict', 'REPORT_ADMISSION_RECEIPT_CONFLICT', 409);
        }
        return deepFreeze(clone(candidate));
      }
      if (candidate.state !== REPORT_ADMISSION_CANDIDATE_STATES.PREPARED) {
        fail('Report admission candidate is not prepared', 'REPORT_ADMISSION_INVALID_STATE', 409);
      }
      const next = writeCandidate(file, {
        ...candidate,
        stateDigest: undefined,
        state: REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED,
        updatedAt: timestamp,
        ownership: null,
        admission: clone(admission),
      });
      return deepFreeze(clone(next));
    });
  }

  #finishAttempt(candidateId, { ownerToken, attemptId }, transform) {
    safeId(ownerToken, 'ownerToken');
    safeId(attemptId, 'attemptId');
    return this.#withCandidateLock(candidateId, () => {
      const file = candidateFile(this.rootDir, candidateId);
      const candidate = readCandidate(file);
      if (
        candidate.state !== REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING
        || candidate.ownership?.ownerToken !== ownerToken
        || candidate.ownership?.attemptId !== attemptId
      ) {
        fail('Report admission attempt ownership mismatch', 'REPORT_ADMISSION_OWNERSHIP_CONFLICT', 409);
      }
      const index = candidate.attempts.findIndex((attempt) => attempt.attemptId === attemptId);
      if (index < 0 || candidate.attempts[index].status !== 'running') {
        fail('Report admission attempt is missing', 'REPORT_ADMISSION_ATTEMPT_CONFLICT', 409);
      }
      const next = transform(candidate, index);
      return deepFreeze(clone(writeCandidate(file, { ...next, stateDigest: undefined })));
    });
  }
}

export const createReportAdmissionStore = (options = {}) => new ReportAdmissionStore(options);
