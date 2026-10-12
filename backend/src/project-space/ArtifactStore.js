import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { PROJECTS_DIR } from '../config.js';
import {
  assertValidArtifactRef,
  canonicalSha256,
  canonicalStringify,
  createArtifactRef,
  deepFreeze,
  validateArtifactRef,
} from '../core/contracts/ArtifactRef.js';
import {
  atomicCreateFileSync,
  atomicWriteFileSync,
  withFileLockSync,
} from '../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
  resolveDirectStorageDirectory,
} from '../lib/storageBoundary.js';
import { DURABLE_EVENT_TYPES, FileEventBus, durableEventId } from './EventBus.js';

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 'artifact-manifest.v1';
export const ARTIFACT_STORE_SCOPE = 'cross-process-single-writer';
export const ARTIFACT_STORE_CONCURRENCY_NOTE = 'WS-01 serializes manifest commits with a cross-process single-writer project lock.';
const LEGACY_ARTIFACT_STORE_SCOPE = 'single-process';
const LEGACY_ARTIFACT_STORE_CONCURRENCY_NOTE = 'ARC-03a is a single-process primitive; cross-process CAS/single-writer concurrency remains WS-01.';
export const ARTIFACT_MANIFEST_CONTRACT = deepFreeze({
  schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
  storeScope: ARTIFACT_STORE_SCOPE,
  fields: ['schemaVersion', 'projectId', 'storeScope', 'concurrencyNote', 'versions', 'successfulCommits'],
  versionEntryFields: [
    'ref',
    'runId',
    'nodeId',
    'idempotencyKey',
    'inputDigest',
    'inputArtifactRefs',
    'objectDigest',
    'objectPath',
    'committedAt',
  ],
  successfulCommitFields: ['fingerprint', 'ref'],
  lineageEntryFields: ['runId', 'nodeId', 'idempotencyKey', 'inputArtifactRefs', 'ref'],
});

function atomicWriteJSON(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
}

function atomicWriteTextIfAbsent(file, text) {
  if (fs.existsSync(file)) return;
  try {
    atomicCreateFileSync(file, text);
  } catch (error) {
    if (error?.code === 'EEXIST') return;
    throw error;
  }
}

function fail(message, code = 'ARTIFACT_STORE_ERROR') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertSafeProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(projectId)) {
    fail(`unsafe project id: ${projectId}`, 'UNSAFE_PROJECT_ID');
  }
}

function assertSafeScopedIdentity(scopeId) {
  if (typeof scopeId !== 'string' || !/^[A-Za-z0-9_.:-]+$/u.test(scopeId)) {
    fail(`unsafe scoped storage identity: ${scopeId}`, 'UNSAFE_STORAGE_IDENTITY');
  }
}

function assertRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`, 'INVALID_ARTIFACT_COMMIT');
}

function normalizeArtifactPath(relPath) {
  if (typeof relPath !== 'string') fail('artifact path is required', 'UNSAFE_ARTIFACT_PATH');
  if (relPath.includes('\\') || path.isAbsolute(relPath)) {
    fail(`unsafe artifact path: ${relPath}`, 'UNSAFE_ARTIFACT_PATH');
  }
  const normalized = path.posix.normalize(relPath);
  const parts = normalized.split('/');
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || parts.some((part) => part === '' || part === '..')
  ) {
    fail(`unsafe artifact path: ${relPath}`, 'UNSAFE_ARTIFACT_PATH');
  }
  return normalized;
}

function digestHex(digest) {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(digest);
  if (!match) fail(`invalid digest: ${digest}`, 'INVALID_DIGEST');
  return match[1];
}

function sha256Text(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function serializeContent(content) {
  return typeof content === 'string' ? content : canonicalStringify(content);
}

function idempotencyScope(input) {
  return canonicalSha256({
    artifactId: input.artifactId,
    idempotencyKey: input.idempotencyKey,
    nodeId: input.nodeId,
    path: input.path,
    runId: input.runId,
  });
}

function commitFingerprint(input, contentDigest, inputArtifactRefs) {
  return canonicalSha256({
    asOf: input.asOf,
    artifactId: input.artifactId,
    contractVersion: input.contractVersion,
    contentDigest,
    idempotencyKey: input.idempotencyKey,
    inputDigest: input.inputDigest,
    inputArtifactRefs,
    nodeId: input.nodeId,
    path: input.path,
    producer: input.producer,
    runId: input.runId,
    schemaVersion: input.schemaVersion,
  });
}

function emptyManifest(projectId) {
  return {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    projectId,
    storeScope: ARTIFACT_STORE_SCOPE,
    concurrencyNote: FileArtifactStore.concurrencyNote,
    versions: [],
    successfulCommits: {},
  };
}

export class FileArtifactStore {
  static scope = ARTIFACT_STORE_SCOPE;

  static concurrencyNote = ARTIFACT_STORE_CONCURRENCY_NOTE;

  constructor({
    projectId,
    projectsDir = PROJECTS_DIR,
    storageDir = null,
    eventBus = null,
  } = {}) {
    if (storageDir === null) assertSafeProjectId(projectId);
    else assertSafeScopedIdentity(projectId);
    this.projectId = projectId;
    this.projectsDir = path.resolve(projectsDir);
    this.directStorageDir = storageDir !== null;
    this.storageDir = this.directStorageDir
      ? resolveDirectStorageDirectory(storageDir, 'ArtifactStore storageDir')
      : path.join(this.projectsDir, projectId);
    this.projectDir = this.storageDir;
    this.rootDir = path.join(this.storageDir, '.artifacts');
    this.objectDir = path.join(this.rootDir, 'objects', 'sha256');
    this.manifestPath = path.join(this.rootDir, 'manifest.json');
    this.manifestLockPath = path.join(this.rootDir, '.locks', 'manifest.lock');
    this.eventBus = eventBus || new FileEventBus({
      projectId,
      projectsDir: this.projectsDir,
      ...(this.directStorageDir ? { storageDir: this.storageDir } : {}),
    });
    this.#ensureStorageTree({ createLockRoot: false });
  }

  manifest() {
    return deepFreeze(this.#loadManifest());
  }

  commit(input) {
    return this.commitMany([input])[0];
  }

  commitMany(inputs) {
    if (!Array.isArray(inputs)) fail('artifact commit batch must be an array', 'INVALID_ARTIFACT_COMMIT');
    if (inputs.length === 0) return [];
    this.#ensureStorageTree({ createLockRoot: true });
    const refs = withFileLockSync(this.manifestLockPath, () => this.#commitManyLocked(inputs));
    this.#publishArtifactEvents(inputs, refs);
    return refs;
  }

  reconcileCommittedEvent(ref) {
    assertValidArtifactRef(ref);
    const entry = this.#loadManifest().versions.find((candidate) => (
      candidate.ref.artifactId === ref.artifactId
      && candidate.ref.version === ref.version
      && candidate.ref.contentDigest === ref.contentDigest
    ));
    if (!entry) {
      fail(
        `artifact not found for event reconciliation: ${ref.artifactId}@${ref.version}`,
        'ARTIFACT_NOT_FOUND',
      );
    }
    const committedRef = createArtifactRef(entry.ref);
    this.#publishArtifactEvents([entry], [committedRef]);
    return committedRef;
  }

  #publishArtifactEvents(inputs, refs) {
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const ref = refs[index];
      const eventId = durableEventId(DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED, {
        artifactId: ref.artifactId,
        contentDigest: ref.contentDigest,
        projectId: this.projectId,
        version: ref.version,
      });
      const existing = this.eventBus.get(eventId);
      const nodeStarted = this.eventBus.latest({
        runId: input.runId,
        nodeId: input.nodeId,
        eventTypes: [DURABLE_EVENT_TYPES.NODE_STARTED],
      });
      this.eventBus.publish({
        eventId,
        eventType: DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED,
        correlationId: input.runId,
        causationId: existing?.causationId ?? nodeStarted?.eventId ?? null,
        runId: input.runId,
        nodeId: input.nodeId,
        payload: {
          artifactRef: ref,
          inputArtifactRefs: (input.inputArtifactRefs || []).map((item) => createArtifactRef(item)),
          idempotencyKey: input.idempotencyKey,
          inputDigest: input.inputDigest,
        },
      });
    }
  }

  #commitManyLocked(inputs) {
    const now = new Date().toISOString();
    const manifest = this.#loadManifest();
    const versions = [...manifest.versions];
    const successfulCommits = { ...manifest.successfulCommits };
    const refs = [];
    const pendingByScope = new Map();
    const objects = new Map();
    let hasNewEntries = false;

    for (const input of inputs) {
      assertRequiredString(input?.runId, 'runId');
      assertRequiredString(input?.nodeId, 'nodeId');
      assertRequiredString(input?.idempotencyKey, 'idempotencyKey');
      const pathValue = normalizeArtifactPath(input.path);
      const text = serializeContent(input.content);
      const contentDigest = sha256Text(text);
      const inputArtifactRefs = (input.inputArtifactRefs || []).map((item) => createArtifactRef(item));
      const normalizedInput = { ...input, path: pathValue };
      const scope = idempotencyScope(normalizedInput);
      const fingerprint = commitFingerprint(normalizedInput, contentDigest, inputArtifactRefs);
      const priorCommit = manifest.successfulCommits[scope];

      if (priorCommit) {
        if (priorCommit.fingerprint !== fingerprint) {
          fail(`idempotency conflict for ${input.idempotencyKey}`, 'ARTIFACT_IDEMPOTENCY_CONFLICT');
        }
        const priorRef = createArtifactRef(priorCommit.ref);
        this.#assertObjectDigest(priorRef.contentDigest);
        refs.push(priorRef);
        continue;
      }

      const pending = pendingByScope.get(scope);
      if (pending) {
        if (pending.fingerprint !== fingerprint) {
          fail(`idempotency conflict for ${input.idempotencyKey}`, 'ARTIFACT_IDEMPOTENCY_CONFLICT');
        }
        refs.push(pending.ref);
        continue;
      }

      const version = 1 + versions
        .filter((entry) => entry.ref?.artifactId === input.artifactId)
        .reduce((max, entry) => Math.max(max, entry.ref.version), 0);
      const ref = createArtifactRef({
        artifactId: input.artifactId,
        version,
        path: pathValue,
        contentDigest,
        schemaVersion: input.schemaVersion,
        producer: input.producer,
        contractVersion: input.contractVersion,
        inputDigest: input.inputDigest,
        createdAt: now,
        asOf: input.asOf,
      });
      const objectPath = this.objectPathForDigest(contentDigest);
      const entry = {
        ref,
        runId: input.runId,
        nodeId: input.nodeId,
        idempotencyKey: input.idempotencyKey,
        inputDigest: input.inputDigest,
        inputArtifactRefs,
        objectDigest: contentDigest,
        objectPath: path.relative(this.rootDir, objectPath).split(path.sep).join('/'),
        committedAt: now,
      };

      versions.push(entry);
      successfulCommits[scope] = { fingerprint, ref };
      pendingByScope.set(scope, { fingerprint, ref });
      objects.set(contentDigest, text);
      refs.push(ref);
      hasNewEntries = true;
    }

    if (!hasNewEntries) return refs;
    for (const [digest, text] of objects) {
      atomicWriteTextIfAbsent(this.objectPathForDigest(digest), text);
      this.#assertObjectDigest(digest);
    }
    atomicWriteJSON(this.manifestPath, {
      ...manifest,
      storeScope: ARTIFACT_STORE_SCOPE,
      concurrencyNote: ARTIFACT_STORE_CONCURRENCY_NOTE,
      versions,
      successfulCommits,
    });
    return refs;
  }

  list() {
    return this.#loadManifest().versions.map((entry) => createArtifactRef(entry.ref));
  }

  history(artifactId) {
    return this.#loadManifest().versions
      .filter((entry) => entry.ref.artifactId === artifactId)
      .map((entry) => createArtifactRef(entry.ref));
  }

  get(artifactId, version) {
    const entry = this.#loadManifest().versions
      .find((item) => item.ref.artifactId === artifactId && item.ref.version === version);
    return entry ? createArtifactRef(entry.ref) : null;
  }

  read(ref) {
    assertValidArtifactRef(ref);
    const found = this.#loadManifest().versions
      .find((entry) => entry.ref.artifactId === ref.artifactId && entry.ref.version === ref.version);
    if (!found) fail(`artifact not found: ${ref.artifactId}@${ref.version}`, 'ARTIFACT_NOT_FOUND');
    if (found.ref.contentDigest !== ref.contentDigest) fail('ArtifactRef digest does not match manifest', 'ARTIFACT_DIGEST_MISMATCH');
    const file = this.objectPathForDigest(ref.contentDigest);
    if (!fs.existsSync(file)) fail(`artifact object missing: ${ref.contentDigest}`, 'ARTIFACT_OBJECT_MISSING');
    this.#assertObjectDigest(ref.contentDigest);
    return fs.readFileSync(file, 'utf8');
  }

  lineageForRun(runId) {
    return deepFreeze(this.#loadManifest().versions
      .filter((entry) => entry.runId === runId)
      .map((entry) => ({
        runId: entry.runId,
        nodeId: entry.nodeId,
        idempotencyKey: entry.idempotencyKey,
        inputArtifactRefs: entry.inputArtifactRefs.map((ref) => createArtifactRef(ref)),
        ref: createArtifactRef(entry.ref),
      })));
  }

  objectPathForDigest(digest) {
    return path.join(this.objectDir, digestHex(digest));
  }

  #loadManifest() {
    this.#ensureStorageTree({ createLockRoot: false });
    if (!assertOwnedStorageFile(this.manifestPath, 'ArtifactStore manifest')) {
      return emptyManifest(this.projectId);
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
    }
    const currentScope = manifest?.storeScope === ARTIFACT_STORE_SCOPE
      && manifest?.concurrencyNote === ARTIFACT_STORE_CONCURRENCY_NOTE;
    const legacyScope = manifest?.storeScope === LEGACY_ARTIFACT_STORE_SCOPE
      && manifest?.concurrencyNote === LEGACY_ARTIFACT_STORE_CONCURRENCY_NOTE;
    if (
      !manifest
      || manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION
      || manifest.projectId !== this.projectId
      || (!currentScope && !legacyScope)
    ) {
      fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
    }
    if (
      !Array.isArray(manifest.versions)
      || !manifest.successfulCommits
      || typeof manifest.successfulCommits !== 'object'
      || Array.isArray(manifest.successfulCommits)
    ) {
      fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
    }
    const versionKeys = new Set();
    for (const entry of manifest.versions) {
      if (
        !entry
        || validateArtifactRef(entry.ref).valid === false
        || typeof entry.ref.path !== 'string'
        || typeof entry.runId !== 'string' || !entry.runId
        || typeof entry.nodeId !== 'string' || !entry.nodeId
        || typeof entry.idempotencyKey !== 'string' || !entry.idempotencyKey
        || !isDigest(entry.inputDigest)
        || entry.inputDigest !== entry.ref.inputDigest
        || !Array.isArray(entry.inputArtifactRefs)
        || entry.inputArtifactRefs.some((ref) => !validateArtifactRef(ref).valid)
        || entry.objectDigest !== entry.ref.contentDigest
        || typeof entry.objectPath !== 'string'
        || !isIsoTimestamp(entry.committedAt)
      ) {
        fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      }
      let refPath;
      let objectPath;
      try {
        refPath = normalizeArtifactPath(entry.ref.path);
        objectPath = normalizeArtifactPath(entry.objectPath);
      } catch {
        fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      }
      const expectedObjectPath = path.relative(this.rootDir, this.objectPathForDigest(entry.objectDigest)).split(path.sep).join('/');
      if (refPath !== entry.ref.path || objectPath !== entry.objectPath || objectPath !== expectedObjectPath) {
        fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      }
      const versionKey = `${entry.ref.artifactId}\0${entry.ref.version}`;
      if (versionKeys.has(versionKey)) fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      versionKeys.add(versionKey);
    }
    for (const [scope, successful] of Object.entries(manifest.successfulCommits)) {
      if (!isDigest(scope) || !successful || !isDigest(successful.fingerprint)) {
        fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      }
      if (!validateArtifactRef(successful.ref).valid) fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      const version = manifest.versions.find((entry) => (
        entry.ref.artifactId === successful.ref.artifactId
        && entry.ref.version === successful.ref.version
        && entry.ref.contentDigest === successful.ref.contentDigest
      ));
      if (!version) fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      try {
        if (canonicalStringify(version.ref) !== canonicalStringify(successful.ref)) {
          fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
        }
      } catch (error) {
        if (error?.code === 'CORRUPT_ARTIFACT_MANIFEST') throw error;
        fail('corrupt artifact manifest', 'CORRUPT_ARTIFACT_MANIFEST');
      }
    }
    return legacyScope
      ? { ...manifest, storeScope: ARTIFACT_STORE_SCOPE, concurrencyNote: ARTIFACT_STORE_CONCURRENCY_NOTE }
      : manifest;
  }

  #assertObjectDigest(digest) {
    const file = this.objectPathForDigest(digest);
    if (!assertOwnedStorageFile(file, `ArtifactStore object ${digest}`)) {
      fail(`artifact object missing: ${digest}`, 'ARTIFACT_OBJECT_MISSING');
    }
    const text = fs.readFileSync(file, 'utf8');
    if (sha256Text(text) !== digest) fail('artifact object digest mismatch', 'ARTIFACT_DIGEST_MISMATCH');
  }

  #ensureStorageTree({ createLockRoot }) {
    if (this.directStorageDir) {
      resolveDirectStorageDirectory(this.storageDir, 'ArtifactStore storageDir');
    } else {
      ensureOwnedStorageDirectory(this.storageDir, 'ArtifactStore storage directory', {
        create: true,
        recursive: true,
      });
    }
    ensureOwnedStorageDirectory(this.rootDir, 'ArtifactStore hidden root', { create: true });
    ensureOwnedStorageDirectory(path.join(this.rootDir, 'objects'), 'ArtifactStore object root', { create: true });
    ensureOwnedStorageDirectory(this.objectDir, 'ArtifactStore digest root', { create: true });
    ensureOwnedStorageDirectory(path.dirname(this.manifestLockPath), 'ArtifactStore lock root', {
      create: createLockRoot,
    });
    assertStorageLockBoundary(this.manifestLockPath, 'ArtifactStore manifest lock');
  }
}
