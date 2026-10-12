import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../../core/contracts/ArtifactRef.js';
import { atomicCreateFileSync, withFileLockSync } from '../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../lib/storageBoundary.js';

export const WORLDVIEW_RUN_PUBLICATION_CONTRACT = 'worldview-run-publication.v1';
export const PROCESSED_REPORT_VERSION_RECEIPT_CONTRACT = 'processed-report-version-receipt.v1';
const MARKER_CONTRACT = 'worldview-run-publication-marker.v1';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function clone(value) {
  return structuredClone(value);
}

function safeId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new TypeError(`${field} is unsafe`);
  return value;
}

function digest(value, field) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function exactKeys(value, allowed, field) {
  object(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

function normalizeWorldviewObject(input) {
  exactKeys(input, [
    'outcome', 'versionId', 'packageDigest', 'updateRecordId', 'updateRecordDigest',
    'evaluationRecordId', 'evaluationRecordDigest',
  ], 'publication.worldview');
  if (input.outcome === 'UPDATE') {
    return {
      outcome: 'UPDATE',
      versionId: safeId(input.versionId, 'publication.worldview.versionId'),
      packageDigest: digest(input.packageDigest, 'publication.worldview.packageDigest'),
      updateRecordId: safeId(input.updateRecordId, 'publication.worldview.updateRecordId'),
      updateRecordDigest: digest(input.updateRecordDigest, 'publication.worldview.updateRecordDigest'),
    };
  }
  if (input.outcome === 'KEEP') {
    return {
      outcome: 'KEEP',
      evaluationRecordId: safeId(input.evaluationRecordId, 'publication.worldview.evaluationRecordId'),
      evaluationRecordDigest: digest(input.evaluationRecordDigest, 'publication.worldview.evaluationRecordDigest'),
    };
  }
  throw new TypeError('publication.worldview.outcome must be UPDATE or KEEP');
}

function fail(message, code = 'WORLDVIEW_PUBLICATION_CORRUPT') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  throw error;
}

function immutableJson(file, value, label) {
  if (fs.existsSync(file)) {
    assertOwnedStorageFile(file, label, { allowMissing: false });
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (canonicalStringify(existing) !== canonicalStringify(value)) {
      fail(`${label} identity conflicts with existing bytes`, 'WORLDVIEW_PUBLICATION_CONFLICT');
    }
    return existing;
  }
  atomicCreateFileSync(file, `${canonicalStringify(value)}\n`);
  return value;
}

function normalizeReceipt(input, publicationId, runId, processedAt) {
  const content = {
    contract: PROCESSED_REPORT_VERSION_RECEIPT_CONTRACT,
    receiptId: safeId(input.receiptId || `processed_receipt_${canonicalSha256({
      publicationId,
      reportVersionId: input.reportVersionId,
    }).slice('sha256:'.length)}`, 'receiptId'),
    publicationId,
    runId,
    reportVersionId: safeId(input.reportVersionId, 'receipt.reportVersionId'),
    admissionSequence: input.admissionSequence,
    contentDigest: digest(input.contentDigest, 'receipt.contentDigest'),
    fingerprint: digest(input.fingerprint, 'receipt.fingerprint'),
    processedAt,
  };
  if (!Number.isInteger(content.admissionSequence) || content.admissionSequence < 1) {
    throw new TypeError('receipt.admissionSequence must be positive');
  }
  return { ...content, receiptDigest: canonicalSha256(content) };
}

function normalizeStage(input) {
  object(input, 'publication');
  const publicationId = safeId(input.publicationId, 'publicationId');
  const runId = safeId(input.runId, 'runId');
  const workspaceId = safeId(input.workspaceId, 'workspaceId');
  const workspaceDigest = digest(input.workspaceDigest, 'workspaceDigest');
  const committedAt = timestamp(input.committedAt, 'committedAt');
  const receipts = (input.receipts || []).map((receipt) => normalizeReceipt(receipt, publicationId, runId, committedAt));
  if (!receipts.length) throw new TypeError('publication receipts are required');
  if (new Set(receipts.map((receipt) => receipt.reportVersionId)).size !== receipts.length) {
    throw new TypeError('publication receipts contain duplicate ReportVersions');
  }
  const payload = {
    contract: WORLDVIEW_RUN_PUBLICATION_CONTRACT,
    publicationId,
    runId,
    triggerId: safeId(input.triggerId, 'triggerId'),
    batchId: safeId(input.batchId, 'batchId'),
    workspaceId,
    workspaceDigest,
    committedAt,
    worldview: normalizeWorldviewObject(input.worldview),
    claims: clone(object(input.claims, 'publication.claims')),
    attempts: clone(Array.isArray(input.attempts) ? input.attempts : []),
    receipts,
  };
  const objectDigests = {
    worldview: canonicalSha256(payload.worldview),
    claims: canonicalSha256(payload.claims),
    attempts: canonicalSha256(payload.attempts),
    receipts: canonicalSha256(payload.receipts),
  };
  return deepFreeze({ ...payload, objectDigests, publicationDigest: canonicalSha256({ ...payload, objectDigests }) });
}

export class WorldviewRunPublicationStore {
  constructor({ rootDir, now = () => new Date().toISOString() } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('WorldviewRunPublicationStore rootDir is required');
    if (typeof now !== 'function') throw new TypeError('WorldviewRunPublicationStore now must be a function');
    this.rootDir = path.resolve(rootDir);
    this.stagedDir = path.join(this.rootDir, 'staged');
    this.markersDir = path.join(this.rootDir, 'completed');
    this.locksDir = path.join(this.rootDir, '.locks');
    this.lockPath = path.join(this.locksDir, 'publication.lock');
    this.now = now;
    for (const directory of [this.rootDir, this.stagedDir, this.markersDir, this.locksDir]) {
      ensureOwnedStorageDirectory(directory, 'Worldview publication directory', { create: true, recursive: true });
    }
    assertStorageLockBoundary(this.lockPath, 'Worldview publication lock');
  }

  publicationId({ runId, workspaceDigest }) {
    return `worldview_publication_${canonicalSha256({
      runId: safeId(runId, 'runId'),
      workspaceDigest: digest(workspaceDigest, 'workspaceDigest'),
    }).slice('sha256:'.length)}`;
  }

  stage(input) {
    const record = normalizeStage({ ...input, committedAt: input.committedAt || this.now() });
    return withFileLockSync(this.lockPath, () => deepFreeze(clone(immutableJson(
      path.join(this.stagedDir, `${record.publicationId}.json`),
      record,
      'Worldview staged publication',
    ))));
  }

  commit(publicationIdInput) {
    const publicationId = safeId(publicationIdInput, 'publicationId');
    return withFileLockSync(this.lockPath, () => {
      const staged = this.readStaged(publicationId);
      if (!staged) fail('Staged Worldview publication is missing', 'WORLDVIEW_PUBLICATION_STAGE_MISSING');
      const markerContent = {
        contract: MARKER_CONTRACT,
        publicationId,
        publicationDigest: staged.publicationDigest,
        objectDigests: clone(staged.objectDigests),
        committedAt: staged.committedAt,
      };
      const marker = { ...markerContent, markerDigest: canonicalSha256(markerContent) };
      immutableJson(path.join(this.markersDir, `${publicationId}.json`), marker, 'Worldview publication marker');
      return this.get(publicationId);
    });
  }

  readStaged(publicationIdInput) {
    const publicationId = safeId(publicationIdInput, 'publicationId');
    const file = path.join(this.stagedDir, `${publicationId}.json`);
    if (!fs.existsSync(file)) return null;
    assertOwnedStorageFile(file, 'Worldview staged publication', { allowMissing: false });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normalized = normalizeStage(raw);
    if (canonicalStringify(raw) !== canonicalStringify(normalized)) fail('Worldview staged publication integrity failed');
    return normalized;
  }

  isCompleted(publicationIdInput) {
    if (typeof publicationIdInput !== 'string' || !ID_RE.test(publicationIdInput)) return false;
    if (!fs.existsSync(path.join(this.markersDir, `${publicationIdInput}.json`))) return false;
    const publication = this.get(publicationIdInput);
    if (!publication) return false;
    return deepFreeze({
      publicationId: publication.publicationId,
      publicationDigest: publication.publicationDigest,
      worldview: clone(publication.worldview),
      worldviewObjectDigest: publication.objectDigests.worldview,
    });
  }

  get(publicationIdInput) {
    const publicationId = safeId(publicationIdInput, 'publicationId');
    const markerPath = path.join(this.markersDir, `${publicationId}.json`);
    if (!fs.existsSync(markerPath)) return null;
    assertOwnedStorageFile(markerPath, 'Worldview publication marker', { allowMissing: false });
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const { markerDigest, ...markerContent } = marker;
    if (
      marker.contract !== MARKER_CONTRACT
      || marker.publicationId !== publicationId
      || markerDigest !== canonicalSha256(markerContent)
    ) fail('Worldview publication marker integrity failed');
    const staged = this.readStaged(publicationId);
    if (
      !staged
      || staged.publicationDigest !== marker.publicationDigest
      || canonicalStringify(staged.objectDigests) !== canonicalStringify(marker.objectDigests)
    ) {
      fail('Worldview publication marker does not bind its staged objects');
    }
    return staged;
  }

  list() {
    const publications = fs.readdirSync(this.markersDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => this.get(entry.name.slice(0, -'.json'.length)))
      .sort((left, right) => left.committedAt.localeCompare(right.committedAt));
    return deepFreeze({ schemaVersion: 'worldview-run-publication-list.v1', publications });
  }

  processedReceipts() {
    return deepFreeze(this.list().publications.flatMap((publication) => clone(publication.receipts)));
  }
}

export function createWorldviewRunPublicationStore(options = {}) {
  return new WorldviewRunPublicationStore(options);
}
