import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalSha256, canonicalStringify, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { atomicCreateFileSync, atomicWriteFileSync, withFileLockSync } from '../../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
} from '../../../lib/storageBoundary.js';
import {
  CANONICAL_WORLDVIEW_PACKAGE_CONTRACT,
  CURRENT_WORLDVIEW_CONTRACT,
  WORLDVIEW_AGENT_RUN_CONTRACT,
  WORLDVIEW_EVALUATION_RECORD_CONTRACT,
  WORLDVIEW_UPDATE_RECORD_CONTRACT,
  canonicalDocumentDigest,
  canonicalPackageDigest,
  canonicalWorldviewDigest,
  canonicalWorldviewSafeId,
  canonicalWorldviewTimestamp,
} from './canonicalWorldviewContracts.js';

function fail(message, code = 'CANONICAL_WORLDVIEW_STORE_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function stateDigest(value) {
  const { stateDigest: _stateDigest, ...content } = value;
  return canonicalSha256(content);
}

function withStateDigest(value) {
  return { ...value, stateDigest: stateDigest(value) };
}

const MISSING_JSON_FILE = Symbol('missing-json-file');

function readJson(file, label, {
  allowMissing = false,
  corruptCode = 'CANONICAL_WORLDVIEW_CORRUPT',
  missingValue = null,
} = {}) {
  if (!assertOwnedStorageFile(file, label, { allowMissing })) return missingValue;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is corrupt`, corruptCode, 500, { cause: error });
  }
  return value;
}

function writeJson(file, value, { create = false } = {}) {
  const text = `${canonicalStringify(value)}\n`;
  if (create) atomicCreateFileSync(file, text);
  else atomicWriteFileSync(file, text);
  return value;
}

function safeFailure(error) {
  const code = String(error?.code || 'WORLDVIEW_RUN_FAILED').slice(0, 120);
  let message = String(error?.message || 'Worldview processing failed')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[-_]?key|key|secret|token)=)[^&\s]*/giu, '$1[REDACTED]')
    .replace(/(?:[A-Za-z]:)?[/\\](?:[^\s/\\]+[/\\]){2,}[^\s]*/gu, '[local path]');
  if (message.length > 1_000) message = `${message.slice(0, 997)}...`;
  return { code, message };
}

function jsonDocument(pathname, value) {
  return {
    path: pathname,
    mediaType: 'application/json',
    bytes: Buffer.from(`${canonicalStringify(value)}\n`, 'utf8'),
  };
}

function textDocument(pathname, value) {
  return {
    path: pathname,
    mediaType: 'text/markdown',
    bytes: Buffer.from(String(value), 'utf8'),
  };
}

function packageDocuments(packageValue, lineage) {
  return [
    textDocument('worldview.md', packageValue.narrativeMarkdown),
    jsonDocument('causal-relationships.json', { relationships: packageValue.causalRelationships }),
    jsonDocument('evidence.json', { evidence: packageValue.evidence, counterEvidence: packageValue.counterEvidence }),
    jsonDocument('investment-implications.json', { implications: packageValue.investmentImplications }),
    jsonDocument('coverage.json', packageValue.coverage),
    jsonDocument('update-report.json', packageValue.updateSummary),
    jsonDocument('lineage.json', lineage),
  ];
}

function summarizeDocument(document) {
  return {
    path: document.path,
    mediaType: document.mediaType,
    byteLength: document.bytes.length,
    contentDigest: canonicalDocumentDigest(document.bytes),
  };
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name));
}

function ensureImmutableJson(file, value, label) {
  if (fs.existsSync(file)) {
    const existing = readJson(file, label);
    if (canonicalStringify(existing) !== canonicalStringify(value)) {
      fail(`${label} identity conflict`, 'CANONICAL_WORLDVIEW_IDEMPOTENCY_CONFLICT', 409);
    }
    return existing;
  }
  writeJson(file, value, { create: true });
  return value;
}

function versionSummary(manifest) {
  return {
    contract: manifest.contract,
    versionId: manifest.versionId,
    versionNumber: manifest.versionNumber,
    title: manifest.title,
    asOf: manifest.asOf,
    publishedAt: manifest.publishedAt,
    packageDigest: manifest.packageDigest,
    baseWorldviewVersionId: manifest.baseWorldviewVersionId,
    runId: manifest.runId,
    triggerId: manifest.triggerId,
    documentCount: manifest.documents.length,
    frozenRange: clone(manifest.frozenRange),
    updateRecordId: manifest.updateRecordId,
  };
}

const CURRENT_WORLDVIEW_FIELDS = Object.freeze([
  'contract',
  'versionId',
  'versionNumber',
  'packageDigest',
  'runId',
  'publishedAt',
  'rebuiltAt',
]);

function assertCurrentWorldviewProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Current Worldview Projection must be an object', 'CURRENT_WORLDVIEW_CORRUPT');
  }
  const fields = Object.keys(value);
  if (
    fields.length !== CURRENT_WORLDVIEW_FIELDS.length
    || CURRENT_WORLDVIEW_FIELDS.some((field) => !Object.hasOwn(value, field))
  ) {
    fail('Current Worldview Projection fields are invalid', 'CURRENT_WORLDVIEW_CORRUPT');
  }
  if (value.contract !== CURRENT_WORLDVIEW_CONTRACT) {
    fail('Current Worldview Projection contract is invalid', 'CURRENT_WORLDVIEW_CORRUPT');
  }
  try {
    canonicalWorldviewTimestamp(value.rebuiltAt, 'current.rebuiltAt');
  } catch {
    fail('Current Worldview Projection rebuiltAt is invalid', 'CURRENT_WORLDVIEW_CORRUPT');
  }
}

export class CanonicalWorldviewStore {
  constructor({ rootDir, now = () => new Date().toISOString(), publicationReader = null } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('CanonicalWorldviewStore rootDir is required');
    if (typeof now !== 'function') throw new TypeError('CanonicalWorldviewStore now must be a function');
    this.rootDir = path.resolve(rootDir);
    this.versionsDir = path.join(this.rootDir, 'versions');
    this.updatesDir = path.join(this.rootDir, 'updates');
    this.evaluationsDir = path.join(this.rootDir, 'evaluations');
    this.processingRunsDir = path.join(this.rootDir, 'processing-runs');
    this.workflowRunsDir = path.join(this.rootDir, 'workflow-runs');
    this.locksDir = path.join(this.rootDir, '.locks');
    this.publishLockPath = path.join(this.locksDir, 'publish.lock');
    this.runLockPath = path.join(this.locksDir, 'processing-runs.lock');
    this.currentPath = path.join(this.rootDir, 'current.json');
    this.now = now;
    this.publicationReader = typeof publicationReader === 'function' ? publicationReader : () => true;
    for (const dir of [
      this.rootDir, this.versionsDir, this.updatesDir, this.evaluationsDir,
      this.processingRunsDir, this.workflowRunsDir, this.locksDir,
    ]) {
      ensureOwnedStorageDirectory(dir, 'Canonical Worldview storage directory', { create: true, recursive: true });
    }
    for (const lock of [this.publishLockPath, this.runLockPath]) {
      assertStorageLockBoundary(lock, 'Canonical Worldview lock');
    }
  }

  bindPublicationReader(reader) {
    if (typeof reader !== 'function') throw new TypeError('CanonicalWorldviewStore publication reader must be a function');
    this.publicationReader = reader;
    return this;
  }

  isPublicationCompleted(publicationId, expectedWorldview = null) {
    if (publicationId === null || publicationId === undefined) return false;
    const completion = this.publicationReader(publicationId, expectedWorldview === null ? null : clone(expectedWorldview));
    if (!completion) return false;
    if (completion === true || typeof completion !== 'object' || Array.isArray(completion)) {
      fail('Worldview publication reader did not return marker-bound object identity', 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH');
    }
    if (completion.publicationId !== publicationId) {
      fail('Worldview publication reader returned the wrong publication identity', 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH');
    }
    if (expectedWorldview !== null && canonicalStringify(completion.worldview) !== canonicalStringify(expectedWorldview)) {
      fail('Worldview publication marker does not bind the visible Worldview object', 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH');
    }
    if (completion.worldviewObjectDigest !== canonicalSha256(completion.worldview)) {
      fail('Worldview publication marker Worldview object digest is invalid', 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH');
    }
    return true;
  }

  workflowRunDir(runId) {
    return path.join(this.workflowRunsDir, canonicalWorldviewSafeId(runId, 'runId'));
  }

  current() {
    const current = readJson(this.currentPath, 'Current Worldview Projection', {
      allowMissing: true,
      corruptCode: 'CURRENT_WORLDVIEW_CORRUPT',
      missingValue: MISSING_JSON_FILE,
    });
    if (current === MISSING_JSON_FILE) return null;
    assertCurrentWorldviewProjection(current);
    let version;
    try {
      version = this.getVersion(current.versionId);
    } catch {
      fail('Current Worldview Projection is not rebuildable from canonical records', 'CURRENT_WORLDVIEW_CORRUPT');
    }
    if (!version) fail('Current Worldview Projection is not rebuildable from canonical records', 'CURRENT_WORLDVIEW_CORRUPT');
    const expected = {
      contract: CURRENT_WORLDVIEW_CONTRACT,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      packageDigest: version.packageDigest,
      runId: version.runId,
      publishedAt: version.publishedAt,
    };
    if (Object.entries(expected).some(([field, value]) => current[field] !== value)) {
      fail('Current Worldview Projection does not match its marker-visible version', 'CURRENT_WORLDVIEW_CORRUPT');
    }
    return deepFreeze(clone(current));
  }

  rebuildCurrent() {
    const versions = this.listVersions().versions;
    if (!versions.length) {
      if (fs.existsSync(this.currentPath)) fs.rmSync(this.currentPath);
      return null;
    }
    const latest = versions.at(-1);
    const value = {
      contract: CURRENT_WORLDVIEW_CONTRACT,
      versionId: latest.versionId,
      versionNumber: latest.versionNumber,
      packageDigest: latest.packageDigest,
      runId: latest.runId,
      publishedAt: latest.publishedAt,
      rebuiltAt: canonicalWorldviewTimestamp(this.now(), 'current.rebuiltAt'),
    };
    writeJson(this.currentPath, value);
    return deepFreeze(clone(value));
  }

  publishUpdate({ publicationId, updateCurrent = false, runId, triggerId, batchId, frozenRange, manifest, selectedFullReads, agentResult, effectiveConfig, publishedAt: publishedAtInput = null } = {}) {
    const packageValue = agentResult?.worldview?.package;
    if (agentResult?.worldview?.action !== 'UPDATE' || !packageValue) throw new TypeError('publishUpdate requires an UPDATE result');
    const normalizedRunId = canonicalWorldviewSafeId(runId, 'runId');
    const normalizedPublicationId = canonicalWorldviewSafeId(publicationId, 'publicationId');
    const normalizedTriggerId = canonicalWorldviewSafeId(triggerId, 'triggerId');
    const normalizedBatchId = canonicalWorldviewSafeId(batchId, 'batchId');
    return withFileLockSync(this.publishLockPath, () => {
      const existingVersions = this.listVersions().versions;
      const current = existingVersions.at(-1) || null;
      const baseVersionId = agentResult.worldview.baseWorldviewVersionId;
      if ((current?.versionId || null) !== baseVersionId) {
        fail('Canonical Worldview base changed before publication', 'WORLDVIEW_PUBLICATION_BASE_CONFLICT', 409);
      }
      const versionNumber = (current?.versionNumber || 0) + 1;
      const versionId = `worldview_v_${canonicalSha256({
        contract: CANONICAL_WORLDVIEW_PACKAGE_CONTRACT,
        runId: normalizedRunId,
        manifestDigest: manifest.manifestDigest,
        package: packageValue,
      }).slice('sha256:'.length)}`;
      const updateRecordId = `worldview_update_${canonicalSha256({ runId: normalizedRunId, versionId }).slice('sha256:'.length)}`;
      const lineage = {
        runId: normalizedRunId,
        publicationId: normalizedPublicationId,
        triggerId: normalizedTriggerId,
        batchId: normalizedBatchId,
        baseWorldviewVersionId: baseVersionId,
        frozenRange: clone(frozenRange),
        overviewManifestDigest: manifest.manifestDigest,
        overviewManifest: manifest.items.map((item) => ({
          ordinal: item.ordinal,
          admissionSequence: item.admissionSequence,
          reportVersionId: item.reportVersionId,
          contentDigest: item.contentDigest,
          fingerprint: item.fingerprint,
          overviewId: item.overviewId,
          overviewDigest: item.overviewDigest,
        })),
        selectedFullReads: clone(selectedFullReads),
        effectiveConfig: clone(effectiveConfig),
      };
      const documents = packageDocuments(packageValue, lineage);
      const documentManifest = documents.map(summarizeDocument);
      const publishedAt = canonicalWorldviewTimestamp(publishedAtInput || this.now(), 'package.publishedAt');
      const manifestWithoutDigest = {
        contract: CANONICAL_WORLDVIEW_PACKAGE_CONTRACT,
        versionId,
        versionNumber,
        title: packageValue.title,
        asOf: packageValue.asOf,
        publishedAt,
        baseWorldviewVersionId: baseVersionId,
        runId: normalizedRunId,
        publicationId: normalizedPublicationId,
        triggerId: normalizedTriggerId,
        batchId: normalizedBatchId,
        frozenRange: clone(frozenRange),
        overviewManifestDigest: manifest.manifestDigest,
        updateRecordId,
        documents: documentManifest,
      };
      const packageDigest = canonicalPackageDigest(manifestWithoutDigest, documents);
      const packageManifest = { ...manifestWithoutDigest, packageDigest };
      const updateRecord = {
        contract: WORLDVIEW_UPDATE_RECORD_CONTRACT,
        updateRecordId,
        publicationId: normalizedPublicationId,
        runId: normalizedRunId,
        triggerId: normalizedTriggerId,
        baseWorldviewVersionId: baseVersionId,
        resultingWorldviewVersionId: versionId,
        rationale: agentResult.worldview.rationale,
        retained: clone(packageValue.updateSummary.retained),
        changed: clone(packageValue.updateSummary.changed),
        added: clone(packageValue.updateSummary.added),
        removed: clone(packageValue.updateSummary.removed),
        createdAt: publishedAt,
        recordDigest: canonicalSha256({
          contract: WORLDVIEW_UPDATE_RECORD_CONTRACT,
          updateRecordId,
          publicationId: normalizedPublicationId,
          runId: normalizedRunId,
          triggerId: normalizedTriggerId,
          baseWorldviewVersionId: baseVersionId,
          resultingWorldviewVersionId: versionId,
          rationale: agentResult.worldview.rationale,
          retained: packageValue.updateSummary.retained,
          changed: packageValue.updateSummary.changed,
          added: packageValue.updateSummary.added,
          removed: packageValue.updateSummary.removed,
          createdAt: publishedAt,
        }),
      };
      ensureImmutableJson(path.join(this.updatesDir, `${updateRecordId}.json`), updateRecord, 'Worldview Update Record');
      const versionDir = path.join(this.versionsDir, versionId);
      const manifestPath = path.join(versionDir, 'package.json');
      if (fs.existsSync(manifestPath)) {
        const existing = this.getVersion(versionId, { includeUncommitted: true });
        if (existing.packageDigest !== packageDigest) fail('Canonical Worldview package identity conflict', 'CANONICAL_WORLDVIEW_PACKAGE_CONFLICT', 409);
        if (updateCurrent) {
          writeJson(this.currentPath, {
            contract: CURRENT_WORLDVIEW_CONTRACT,
            versionId,
            versionNumber,
            packageDigest,
            runId: normalizedRunId,
            publishedAt,
            rebuiltAt: publishedAt,
          });
        }
        return existing;
      }
      if (fs.existsSync(versionDir)) fail('Canonical Worldview package directory is incomplete', 'CANONICAL_WORLDVIEW_PACKAGE_CORRUPT');
      const staging = path.join(this.versionsDir, `.${versionId}.tmp-${process.pid}-${crypto.randomUUID()}`);
      ensureOwnedStorageDirectory(staging, 'Canonical Worldview staging directory', { create: true });
      try {
        for (const document of documents) fs.writeFileSync(path.join(staging, document.path), document.bytes, { flag: 'wx' });
        fs.writeFileSync(path.join(staging, 'package.json'), `${canonicalStringify(packageManifest)}\n`, { flag: 'wx' });
        fs.renameSync(staging, versionDir);
      } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      const currentProjection = {
        contract: CURRENT_WORLDVIEW_CONTRACT,
        versionId,
        versionNumber,
        packageDigest,
        runId: normalizedRunId,
        publishedAt,
        rebuiltAt: publishedAt,
      };
      if (updateCurrent) writeJson(this.currentPath, currentProjection);
      return this.getVersion(versionId, { includeUncommitted: true });
    });
  }

  recordEvaluation({ publicationId, runId, triggerId, batchId, baseWorldviewVersionId, frozenRange, manifestDigest, selectedFullReads, rationale, effectiveConfig, createdAt: createdAtInput = null } = {}) {
    const normalizedRunId = canonicalWorldviewSafeId(runId, 'runId');
    const normalizedPublicationId = canonicalWorldviewSafeId(publicationId, 'publicationId');
    const versionId = canonicalWorldviewSafeId(baseWorldviewVersionId, 'baseWorldviewVersionId');
    const evaluationId = `worldview_evaluation_${canonicalSha256({ runId: normalizedRunId, versionId, manifestDigest }).slice('sha256:'.length)}`;
    const createdAt = canonicalWorldviewTimestamp(createdAtInput || this.now(), 'evaluation.createdAt');
    const content = {
      contract: WORLDVIEW_EVALUATION_RECORD_CONTRACT,
      evaluationId,
      publicationId: normalizedPublicationId,
      runId: normalizedRunId,
      triggerId: canonicalWorldviewSafeId(triggerId, 'triggerId'),
      batchId: canonicalWorldviewSafeId(batchId, 'batchId'),
      baseWorldviewVersionId: versionId,
      frozenRange: clone(frozenRange),
      overviewManifestDigest: canonicalWorldviewDigest(manifestDigest, 'manifestDigest'),
      selectedFullReads: clone(selectedFullReads),
      outcome: 'KEEP',
      rationale: String(rationale),
      effectiveConfig: clone(effectiveConfig),
      createdAt,
    };
    const record = { ...content, recordDigest: canonicalSha256(content) };
    return deepFreeze(clone(ensureImmutableJson(path.join(this.evaluationsDir, `${evaluationId}.json`), record, 'Worldview Evaluation Record')));
  }

  getVersion(versionId, { includeUncommitted = false } = {}) {
    const id = canonicalWorldviewSafeId(versionId, 'versionId');
    const dir = path.join(this.versionsDir, id);
    const manifestPath = path.join(dir, 'package.json');
    const manifest = readJson(manifestPath, 'Canonical Worldview package', { allowMissing: true });
    if (!manifest) return null;
    if (manifest.contract !== CANONICAL_WORLDVIEW_PACKAGE_CONTRACT || manifest.versionId !== id) {
      fail('Canonical Worldview package manifest is invalid', 'CANONICAL_WORLDVIEW_PACKAGE_CORRUPT');
    }
    const documents = manifest.documents.map((entry) => {
      const file = path.join(dir, entry.path);
      assertOwnedStorageFile(file, `Canonical Worldview document ${entry.path}`, { allowMissing: false });
      const bytes = fs.readFileSync(file);
      if (canonicalDocumentDigest(bytes) !== entry.contentDigest || bytes.length !== entry.byteLength) {
        fail(`Canonical Worldview document integrity failed: ${entry.path}`, 'CANONICAL_WORLDVIEW_PACKAGE_CORRUPT');
      }
      return { ...clone(entry), content: bytes.toString('utf8'), bytes };
    });
    const { packageDigest, ...manifestWithoutDigest } = manifest;
    const computed = canonicalPackageDigest(manifestWithoutDigest, documents);
    if (computed !== packageDigest) fail('Canonical Worldview package digest mismatch', 'CANONICAL_WORLDVIEW_PACKAGE_CORRUPT');
    const updateRecord = readJson(path.join(this.updatesDir, `${manifest.updateRecordId}.json`), 'Worldview Update Record', { allowMissing: false });
    const { recordDigest: updateDigest, ...updateContent } = updateRecord;
    if (
      updateRecord.contract !== WORLDVIEW_UPDATE_RECORD_CONTRACT
      || updateRecord.updateRecordId !== manifest.updateRecordId
      || updateRecord.publicationId !== manifest.publicationId
      || updateRecord.runId !== manifest.runId
      || updateRecord.resultingWorldviewVersionId !== id
      || updateDigest !== canonicalSha256(updateContent)
    ) {
      fail('Worldview Update Record integrity failed', 'WORLDVIEW_UPDATE_RECORD_CORRUPT');
    }
    const expectedWorldview = {
      outcome: 'UPDATE',
      versionId: id,
      packageDigest,
      updateRecordId: updateRecord.updateRecordId,
      updateRecordDigest: updateRecord.recordDigest,
    };
    if (!includeUncommitted && !this.isPublicationCompleted(manifest.publicationId, expectedWorldview)) return null;
    return deepFreeze({
      ...clone(manifest),
      documents: documents.map(({ bytes: _bytes, ...document }) => document),
      updateRecord: clone(updateRecord),
      integrity: { valid: true, computedPackageDigest: computed },
    });
  }

  listVersions() {
    const versions = fs.readdirSync(this.versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => this.getVersion(entry.name))
      .filter(Boolean)
      .sort((left, right) => left.versionNumber - right.versionNumber)
      .map(versionSummary);
    return deepFreeze({ schemaVersion: 'canonical-worldview-version-list.v1', versions });
  }

  listEvaluations() {
    const evaluations = listJsonFiles(this.evaluationsDir)
      .map((file) => readJson(file, 'Worldview Evaluation Record'))
      .map((record) => {
        const { recordDigest, ...content } = record;
        if (record.contract !== WORLDVIEW_EVALUATION_RECORD_CONTRACT || recordDigest !== canonicalSha256(content)) {
          fail('Worldview Evaluation Record integrity failed', 'WORLDVIEW_EVALUATION_RECORD_CORRUPT');
        }
        return record;
      })
      .filter((record) => this.isPublicationCompleted(record.publicationId, {
        outcome: 'KEEP',
        evaluationRecordId: record.evaluationId,
        evaluationRecordDigest: record.recordDigest,
      }))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    return deepFreeze({ schemaVersion: 'worldview-evaluation-list.v1', evaluations: evaluations.map(clone) });
  }

  createProcessingRun(input) {
    const runId = canonicalWorldviewSafeId(input?.runId, 'runId');
    const startedAt = canonicalWorldviewTimestamp(input.startedAt || this.now(), 'run.startedAt');
    const content = {
      contract: WORLDVIEW_AGENT_RUN_CONTRACT,
      runId,
      triggerId: canonicalWorldviewSafeId(input.triggerId, 'triggerId'),
      batchId: canonicalWorldviewSafeId(input.batchId, 'batchId'),
      cycleOrdinal: Number(input.cycleOrdinal),
      state: 'frozen',
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      frozenBaseWorldviewVersionId: input.frozenBaseWorldviewVersionId || null,
      frozenRange: clone(input.frozenRange),
      overviewCount: input.manifest.items.length,
      overviewManifestDigest: input.manifest.manifestDigest,
      overviewManifest: input.manifest.items.map((item) => ({
        ordinal: item.ordinal,
        admissionSequence: item.admissionSequence,
        reportVersionId: item.reportVersionId,
        contentDigest: item.contentDigest,
        overviewId: item.overviewId,
        overviewDigest: item.overviewDigest,
      })),
      effectiveConfig: clone(input.effectiveConfig),
      approvedCapabilities: [...input.approvedCapabilities],
      bounds: clone(input.bounds),
      retryPolicies: clone(input.retryPolicies || {
        wholeAgent: { maxAttempts: Number(input.maxAttempts || 1) },
        modelApi: { maxAttempts: 1 },
      }),
      workspaceId: input.workspaceId || null,
      workspaceDigest: input.workspaceDigest || null,
      claimTable: clone(input.claimTable || []),
      execution: null,
      selectedFullReads: [],
      capabilityTraceCount: 0,
      retryMetadata: { agentAttempts: 0, maxAttempts: Number(input.maxAttempts || 1), resumed: false },
      outcome: null,
      rationale: null,
      evaluationRecordId: null,
      resultingWorldviewVersionId: null,
      claimActionCount: 0,
      failure: null,
    };
    const record = withStateDigest(content);
    const file = path.join(this.processingRunsDir, `${runId}.json`);
    return withFileLockSync(this.runLockPath, () => {
      if (fs.existsSync(file)) {
        const existing = this.getProcessingRun(runId);
        const frozenIdentity = (value) => ({
          triggerId: value.triggerId,
          batchId: value.batchId,
          cycleOrdinal: value.cycleOrdinal,
          frozenBaseWorldviewVersionId: value.frozenBaseWorldviewVersionId,
          frozenRange: value.frozenRange,
          overviewCount: value.overviewCount,
          overviewManifestDigest: value.overviewManifestDigest,
          overviewManifest: value.overviewManifest,
          effectiveConfig: value.effectiveConfig,
          approvedCapabilities: value.approvedCapabilities,
          bounds: value.bounds,
          retryPolicies: value.retryPolicies,
          workspaceId: value.workspaceId,
          workspaceDigest: value.workspaceDigest,
          claimTable: value.claimTable,
        });
        if (canonicalStringify(frozenIdentity(existing)) !== canonicalStringify(frozenIdentity(content))) {
          fail('Worldview Agent Run freeze identity conflict', 'WORLDVIEW_RUN_FREEZE_CONFLICT', 409);
        }
        return existing;
      }
      writeJson(file, record, { create: true });
      return deepFreeze(clone(record));
    });
  }

  updateProcessingRun(runId, patch = {}, { at = null } = {}) {
    const id = canonicalWorldviewSafeId(runId, 'runId');
    const file = path.join(this.processingRunsDir, `${id}.json`);
    return withFileLockSync(this.runLockPath, () => {
      const current = this.getProcessingRun(id);
      if (!current) fail('Worldview Agent Run not found', 'WORLDVIEW_RUN_NOT_FOUND', 404);
      const updatedAt = canonicalWorldviewTimestamp(at || this.now(), 'run.updatedAt');
      const next = {
        ...clone(current),
        ...clone(patch),
        runId: id,
        contract: WORLDVIEW_AGENT_RUN_CONTRACT,
        updatedAt,
      };
      delete next.stateDigest;
      if (patch.failure instanceof Error) next.failure = safeFailure(patch.failure);
      if (['succeeded', 'failed', 'FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(next.state) && !next.completedAt) next.completedAt = updatedAt;
      const record = withStateDigest(next);
      writeJson(file, record);
      return deepFreeze(clone(record));
    });
  }

  getProcessingRun(runId) {
    const id = canonicalWorldviewSafeId(runId, 'runId');
    const value = readJson(path.join(this.processingRunsDir, `${id}.json`), 'Worldview Agent Run', { allowMissing: true });
    if (!value) return null;
    if (value.contract !== WORLDVIEW_AGENT_RUN_CONTRACT || value.runId !== id || value.stateDigest !== stateDigest(value)) {
      fail('Worldview Agent Run integrity failed', 'WORLDVIEW_RUN_CORRUPT');
    }
    return deepFreeze(clone(value));
  }

  listProcessingRuns() {
    const runs = listJsonFiles(this.processingRunsDir)
      .map((file) => readJson(file, 'Worldview Agent Run'))
      .map((value) => {
        if (value.stateDigest !== stateDigest(value)) fail('Worldview Agent Run integrity failed', 'WORLDVIEW_RUN_CORRUPT');
        return clone(value);
      })
      .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)) || left.cycleOrdinal - right.cycleOrdinal);
    return deepFreeze({
      schemaVersion: 'worldview-processing-log-list.v1',
      runs,
    });
  }
}

export function createCanonicalWorldviewStore(options = {}) {
  return new CanonicalWorldviewStore(options);
}
