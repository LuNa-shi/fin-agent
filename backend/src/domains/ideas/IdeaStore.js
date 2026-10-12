import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { IDEAS_DIR } from '../../config.js';
import { canonicalSha256 } from '../../core/contracts/ArtifactRef.js';
import { globalContentIndex } from '../../core/persistence/GlobalContentIndex.js';
import { Store } from '../../core/persistence/globalState.js';
import {
  atomicCreateFileSync,
  atomicWriteFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';

export const IDEA_RECORD_SCHEMA_VERSION = 'idea-record.v1';
export const LEGACY_IDEA_READ_ONLY_CODE = 'LEGACY_IDEA_READ_ONLY';

export const normalizeIdeaTitle = (value = '') => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  .slice(0, 48);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const W5_EXECUTION_LINEAGE_FIELDS = Object.freeze([
  'sourceIdeaRunId',
  'sourceRunInputSnapshotId',
  'sourceRunAsOf',
  'sourceEffectiveConfigDigest',
  'sourceGeneratorTraceRef',
  'sourceQualityTraceRef',
]);
const ENVELOPE_FIELDS = new Set([
  'schemaVersion',
  'id',
  'status',
  'title',
  'createdAt',
  'updatedAt',
  'sourceRunId',
  'sourceSnapshotId',
  'body',
]);
const CREATE_CONTROLLED_BODY_FIELDS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'sourceRunId',
  'sourceSnapshotId',
  'contentRef',
  'contentDigest',
]);
const UPDATE_IMMUTABLE_BODY_FIELDS = new Set([
  ...CREATE_CONTROLLED_BODY_FIELDS,
  ...W5_EXECUTION_LINEAGE_FIELDS,
]);

export class IdeaStoreError extends Error {
  constructor(message, code = 'IDEA_STORE_ERROR', options = {}) {
    super(message, options);
    this.name = 'IdeaStoreError';
    this.code = code;
  }
}

function ideaError(message, code = 'IDEA_STORE_ERROR', options = {}) {
  return new IdeaStoreError(message, code, options);
}

function fail(message, code) {
  throw ideaError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function assertSafeIdeaId(id, label = 'idea id') {
  if (
    typeof id !== 'string'
    || !SAFE_ID.test(id)
    || id === '.'
    || id === '..'
    || id.includes('/')
    || id.includes('\\')
    || id.includes('\0')
    || path.posix.isAbsolute(id)
    || path.win32.isAbsolute(id)
  ) {
    fail(`${label} is unsafe: ${String(id)}`, 'UNSAFE_IDEA_ID');
  }
  return id;
}

function assertText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} must be a non-empty string`, 'INVALID_IDEA_RECORD');
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative epoch-ms timestamp`, 'INVALID_IDEA_RECORD');
  }
  return value;
}

function assertLineageValue(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    fail(`${label} is unsafe`, 'INVALID_IDEA_LINEAGE');
  }
  return value;
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw ideaError(`${label} must be JSON-compatible`, 'INVALID_IDEA_RECORD', {
      cause: error,
    });
  }
}

function normalizeLineage({ sourceRunId, sourceSnapshotId } = {}) {
  const hasRun = sourceRunId !== undefined && sourceRunId !== null;
  const hasSnapshot = sourceSnapshotId !== undefined && sourceSnapshotId !== null;
  if (hasRun !== hasSnapshot) {
    fail(
      'sourceRunId and sourceSnapshotId must be supplied together',
      'INVALID_IDEA_LINEAGE',
    );
  }
  if (!hasRun) return {};
  return {
    sourceRunId: assertLineageValue(sourceRunId, 'sourceRunId'),
    sourceSnapshotId: assertLineageValue(sourceSnapshotId, 'sourceSnapshotId'),
  };
}

function validateW5ExecutionLineage(body, lineage) {
  const present = W5_EXECUTION_LINEAGE_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(body, field)
  ));
  if (present.length === 0) return;
  if (present.length !== W5_EXECUTION_LINEAGE_FIELDS.length) {
    fail(
      `Idea execution lineage is incomplete: ${present.join(', ')}`,
      'INVALID_IDEA_LINEAGE',
    );
  }

  const sourceIdeaRunId = assertLineageValue(
    body.sourceIdeaRunId,
    'sourceIdeaRunId',
  );
  const sourceRunInputSnapshotId = assertLineageValue(
    body.sourceRunInputSnapshotId,
    'sourceRunInputSnapshotId',
  );
  if (
    sourceIdeaRunId !== lineage.sourceRunId
    || sourceRunInputSnapshotId !== lineage.sourceSnapshotId
  ) {
    fail(
      'Idea execution lineage aliases do not match the authoritative run/snapshot lineage',
      'INVALID_IDEA_LINEAGE',
    );
  }

  const asOfMillis = typeof body.sourceRunAsOf === 'string'
    ? Date.parse(body.sourceRunAsOf)
    : NaN;
  if (
    !Number.isFinite(asOfMillis)
    || new Date(asOfMillis).toISOString() !== body.sourceRunAsOf
  ) {
    fail('sourceRunAsOf must be an ISO timestamp', 'INVALID_IDEA_LINEAGE');
  }
  if (
    typeof body.sourceEffectiveConfigDigest !== 'string'
    || !SHA256_DIGEST.test(body.sourceEffectiveConfigDigest)
  ) {
    fail(
      'sourceEffectiveConfigDigest must be a sha256 digest',
      'INVALID_IDEA_LINEAGE',
    );
  }
  for (const field of ['sourceGeneratorTraceRef', 'sourceQualityTraceRef']) {
    const value = body[field];
    if (
      value !== null
      && (
        typeof value !== 'string'
        || !value.trim()
        || value !== value.trim()
        || value.includes('\0')
      )
    ) {
      fail(`${field} must be null or a non-empty trace ref`, 'INVALID_IDEA_LINEAGE');
    }
  }
}

function validateEnvelope(value, expectedId) {
  assertPlainObject(value, 'Idea record');
  const unknown = Object.keys(value).filter((field) => !ENVELOPE_FIELDS.has(field));
  if (unknown.length) {
    fail(`Idea record contains unknown fields: ${unknown.join(', ')}`, 'INVALID_IDEA_RECORD');
  }
  if (value.schemaVersion !== IDEA_RECORD_SCHEMA_VERSION) {
    fail('Idea record schemaVersion is unsupported', 'INVALID_IDEA_RECORD');
  }
  const id = assertSafeIdeaId(value.id);
  if (id !== expectedId) {
    fail(
      `Idea folder/record identity mismatch: folder=${expectedId} record=${id}`,
      'IDEA_IDENTITY_MISMATCH',
    );
  }
  const title = assertText(value.title, 'Idea record.title');
  const status = assertText(value.status, 'Idea record.status');
  const createdAt = assertTimestamp(value.createdAt, 'Idea record.createdAt');
  const updatedAt = assertTimestamp(value.updatedAt, 'Idea record.updatedAt');
  if (updatedAt < createdAt) {
    fail('Idea record.updatedAt precedes createdAt', 'INVALID_IDEA_RECORD');
  }
  assertPlainObject(value.body, 'Idea record.body');
  if (
    value.body.id !== id
    || value.body.title !== title
    || value.body.status !== status
    || value.body.createdAt !== createdAt
    || value.body.updatedAt !== updatedAt
  ) {
    fail('Idea record metadata does not match its body', 'IDEA_IDENTITY_MISMATCH');
  }
  const lineage = normalizeLineage(value);
  if (
    (lineage.sourceRunId || null) !== (value.body.sourceRunId || null)
    || (lineage.sourceSnapshotId || null) !== (value.body.sourceSnapshotId || null)
  ) {
    fail('Idea record lineage does not match its body', 'IDEA_IDENTITY_MISMATCH');
  }
  validateW5ExecutionLineage(value.body, lineage);
  canonicalSha256(value);
  return value;
}

function contentProjection(envelope) {
  return {
    ...cloneJson(envelope.body, 'Idea record.body'),
    contentRef: `idea-generation/ideas/${envelope.id}`,
    contentDigest: canonicalSha256(envelope),
  };
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw ideaError(`${label} is unreadable`, 'INVALID_IDEA_RECORD', { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw ideaError(`${label} contains invalid JSON`, 'INVALID_IDEA_RECORD', {
      cause: error,
    });
  }
}

function legacyIdeas(legacyStore) {
  const ideas = legacyStore?.getIdeas?.();
  if (!Array.isArray(ideas)) {
    fail('legacy Idea compatibility source must return an array', 'INVALID_LEGACY_IDEA_SOURCE');
  }
  return cloneJson(ideas, 'legacy Ideas');
}

function createdAtDescending(left, right) {
  return Number(right.createdAt || 0) - Number(left.createdAt || 0)
    || String(left.id).localeCompare(String(right.id));
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureOwnedDirectory(directory, label, {
  create = false,
  recursive = false,
} = {}) {
  let stat = lstatIfPresent(directory);
  if (stat === null && create) {
    try {
      fs.mkdirSync(directory, { recursive });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    stat = lstatIfPresent(directory);
  }
  if (stat === null) return false;
  if (stat.isSymbolicLink()) {
    fail(`${label} must not be a symlink`, 'IDEA_SYMLINK_DENIED');
  }
  if (!stat.isDirectory()) {
    fail(`${label} must be a directory`, 'INVALID_IDEA_ROOT');
  }
  return true;
}

export class LegacyIdeaReadOnlyError extends Error {
  constructor(ideaId) {
    super(`legacy Idea is read-only: ${ideaId}`);
    this.name = 'LegacyIdeaReadOnlyError';
    this.code = LEGACY_IDEA_READ_ONLY_CODE;
    this.ideaId = ideaId;
  }
}

export class FileIdeaStore {
  constructor({
    ideasDir = IDEAS_DIR,
    legacyStore = Store,
    index = globalContentIndex,
    now = () => Date.now(),
    idFactory = () => `idea_${crypto.randomUUID().replaceAll('-', '')}`,
  } = {}) {
    if (typeof ideasDir !== 'string' || !ideasDir) {
      throw new TypeError('FileIdeaStore ideasDir is required');
    }
    if (!legacyStore || typeof legacyStore.getIdeas !== 'function') {
      throw new TypeError('FileIdeaStore legacyStore.getIdeas is required');
    }
    if (index !== null && typeof index?.rebuild !== 'function') {
      throw new TypeError('FileIdeaStore index must implement rebuild');
    }
    if (typeof now !== 'function') throw new TypeError('FileIdeaStore now must be a function');
    if (typeof idFactory !== 'function') {
      throw new TypeError('FileIdeaStore idFactory must be a function');
    }
    this.ideasDir = path.resolve(ideasDir);
    this.ideaGenerationDir = path.dirname(this.ideasDir);
    this.dataDir = path.dirname(this.ideaGenerationDir);
    this.lockPath = path.join(this.ideaGenerationDir, '.ideas.lock');
    this.legacyStore = legacyStore;
    this.index = index;
    this.now = now;
    this.idFactory = idFactory;
  }

  getIdeas() {
    const current = this.#folderIdeas();
    const ownedIds = new Set(current.map((idea) => idea.id));
    const ownedTitles = new Set(current.map((idea) => idea.title));
    return [
      ...current,
      ...legacyIdeas(this.legacyStore).filter((idea) => (
        !ownedIds.has(idea?.id)
        && !ownedTitles.has(idea?.title)
      )),
    ];
  }

  getIdea(id) {
    const safeId = assertSafeIdeaId(id);
    const envelope = this.#readEnvelope(safeId);
    if (envelope) return contentProjection(envelope);
    return legacyIdeas(this.legacyStore).find((idea) => idea?.id === safeId) || null;
  }

  isWritable(id) {
    const safeId = assertSafeIdeaId(id);
    return this.#readEnvelope(safeId) !== null;
  }

  withProjectAssociationLock(id, callback) {
    assertSafeIdeaId(id);
    if (typeof callback !== 'function') {
      throw new TypeError('Project association callback must be a function');
    }
    this.#ensureIdeasRoot();
    return withFileLockSync(this.lockPath, callback);
  }

  addIdeas(ideas, lineage = {}) {
    if (!Array.isArray(ideas)) throw new TypeError('ideas must be an array');
    const normalizedLineage = normalizeLineage(lineage);
    this.#ensureIdeasRoot();
    const committed = withFileLockSync(this.lockPath, () => {
      this.#ensureIdeasRoot();
      const existing = this.getIdeas();
      const titles = new Set(existing
        .map((idea) => normalizeIdeaTitle(idea?.title))
        .filter(Boolean));
      const ids = new Set(existing.map((idea) => idea?.id).filter(Boolean));
      const output = [];

      for (let index = 0; index < ideas.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(ideas, index)) {
          throw new TypeError('ideas must not contain sparse entries');
        }
        const input = assertPlainObject(ideas[index], `ideas[${index}]`);
        const title = assertText(input.title, `ideas[${index}].title`);
        const titleIdentity = normalizeIdeaTitle(title);
        if (!titleIdentity) {
          fail(
            `ideas[${index}].title must have a non-empty normalized identity`,
            'INVALID_IDEA_RECORD',
          );
        }
        if (titles.has(titleIdentity)) continue;
        const id = input.id === undefined
          ? this.#newId(ids)
          : assertSafeIdeaId(input.id, `ideas[${index}].id`);
        if (ids.has(id) || this.#readEnvelope(id)) {
          fail(`Idea id already exists: ${id}`, 'IDEA_ID_EXISTS');
        }
        const createdAt = assertTimestamp(this.now(), 'Idea createdAt');
        const status = input.status === undefined
          ? 'new'
          : assertText(input.status, `ideas[${index}].status`);
        const copiedInput = cloneJson(input, `ideas[${index}]`);
        for (const field of CREATE_CONTROLLED_BODY_FIELDS) delete copiedInput[field];
        const body = {
          ...copiedInput,
          ...normalizedLineage,
          id,
          title,
          status,
          createdAt,
          updatedAt: createdAt,
        };
        const envelope = {
          schemaVersion: IDEA_RECORD_SCHEMA_VERSION,
          id,
          status,
          title,
          createdAt,
          updatedAt: createdAt,
          ...normalizedLineage,
          body,
        };
        validateEnvelope(envelope, id);
        const folder = this.#folder(id, { allowMissing: true });
        try {
          fs.mkdirSync(folder);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            fail(`Idea folder already exists: ${id}`, 'IDEA_ID_EXISTS');
          }
          throw error;
        }
        atomicCreateFileSync(
          path.join(folder, 'idea.json'),
          `${JSON.stringify(envelope, null, 2)}\n`,
        );
        output.push(contentProjection(envelope));
        ids.add(id);
        titles.add(titleIdentity);
      }
      return output;
    });
    if (committed.length) this.#refreshIndex();
    return committed;
  }

  updateIdea(id, patch = {}, { refreshIndex = true } = {}) {
    const safeId = assertSafeIdeaId(id);
    assertPlainObject(patch, 'Idea update');
    const forbidden = Object.keys(patch).filter((field) => (
      UPDATE_IMMUTABLE_BODY_FIELDS.has(field)
    ));
    if (forbidden.length) {
      fail(`Idea update contains immutable fields: ${forbidden.join(', ')}`, 'IMMUTABLE_IDEA_FIELD');
    }
    if (!this.#assertRootChain()) {
      if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
        throw new LegacyIdeaReadOnlyError(safeId);
      }
      return null;
    }
    const updated = withFileLockSync(this.lockPath, () => {
      const current = this.#readEnvelope(safeId);
      if (!current) {
        if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
          throw new LegacyIdeaReadOnlyError(safeId);
        }
        return null;
      }
      const title = Object.prototype.hasOwnProperty.call(patch, 'title')
        ? assertText(patch.title, 'Idea update.title')
        : current.title;
      const status = Object.prototype.hasOwnProperty.call(patch, 'status')
        ? assertText(patch.status, 'Idea update.status')
        : current.status;
      if (title !== current.title) {
        const titleIdentity = normalizeIdeaTitle(title);
        if (!titleIdentity) {
          fail(
            'Idea update.title must have a non-empty normalized identity',
            'INVALID_IDEA_RECORD',
          );
        }
        const duplicate = this.getIdeas().some((idea) => (
          idea.id !== safeId
          && normalizeIdeaTitle(idea.title) === titleIdentity
        ));
        if (duplicate) fail(`Idea title already exists: ${title}`, 'IDEA_TITLE_EXISTS');
      }
      const updatedAt = Math.max(
        assertTimestamp(this.now(), 'Idea updatedAt'),
        current.updatedAt,
      );
      const body = {
        ...current.body,
        ...cloneJson(patch, 'Idea update'),
        id: current.id,
        title,
        status,
        createdAt: current.createdAt,
        updatedAt,
      };
      const envelope = {
        ...current,
        title,
        status,
        updatedAt,
        body,
      };
      atomicWriteFileSync(
        path.join(this.#folder(safeId), 'idea.json'),
        `${JSON.stringify(envelope, null, 2)}\n`,
      );
      return contentProjection(validateEnvelope(envelope, safeId));
    });
    if (updated && refreshIndex) this.#refreshIndex();
    return updated;
  }

  associateProject(id, projectId, { refreshIndex = true } = {}) {
    const safeId = assertSafeIdeaId(id);
    const safeProjectId = assertSafeIdeaId(projectId, 'project id');
    if (!this.#assertRootChain()) {
      if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
        throw new LegacyIdeaReadOnlyError(safeId);
      }
      return null;
    }
    const updated = withFileLockSync(this.lockPath, () => {
      const current = this.#readEnvelope(safeId);
      if (!current) {
        if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
          throw new LegacyIdeaReadOnlyError(safeId);
        }
        return null;
      }
      return this.updateIdea(safeId, {
        status: 'added',
        associatedProjectIds: [...new Set([
          ...(Array.isArray(current.body.associatedProjectIds)
            ? current.body.associatedProjectIds
            : []),
          safeProjectId,
        ])],
      }, { refreshIndex: false });
    });
    if (updated && refreshIndex) this.#refreshIndex();
    return updated;
  }

  removeIdea(id) {
    const safeId = assertSafeIdeaId(id);
    if (!this.#assertRootChain()) {
      if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
        throw new LegacyIdeaReadOnlyError(safeId);
      }
      return this.getIdeas();
    }
    const removed = withFileLockSync(this.lockPath, () => {
      const current = this.#readEnvelope(safeId);
      if (!current) {
        if (legacyIdeas(this.legacyStore).some((idea) => idea?.id === safeId)) {
          throw new LegacyIdeaReadOnlyError(safeId);
        }
        return false;
      }
      fs.rmSync(this.#folder(safeId), { recursive: true, force: false });
      return true;
    });
    if (removed) this.#refreshIndex();
    return this.getIdeas();
  }

  #newId(existingIds) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = assertSafeIdeaId(this.idFactory(), 'generated Idea id');
      if (!existingIds.has(id) && !fs.existsSync(path.join(this.ideasDir, id))) return id;
    }
    fail('unable to allocate a unique Idea id', 'IDEA_ID_ALLOCATION_FAILED');
  }

  #ensureIdeasRoot() {
    this.#assertRootChain({ create: true });
  }

  #assertRootChain({ create = false } = {}) {
    if (!ensureOwnedDirectory(this.dataDir, 'Idea data root', {
      create,
      recursive: true,
    })) return false;
    if (!ensureOwnedDirectory(this.ideaGenerationDir, 'Idea generation root', {
      create,
    })) return false;
    return ensureOwnedDirectory(this.ideasDir, 'Idea root', { create });
  }

  #folder(id, { allowMissing = false } = {}) {
    const safeId = assertSafeIdeaId(id);
    if (!this.#assertRootChain()) {
      return allowMissing ? path.join(this.ideasDir, safeId) : null;
    }
    const folder = path.resolve(this.ideasDir, safeId);
    const relative = path.relative(this.ideasDir, folder);
    if (relative !== safeId || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`Idea folder escapes configured root: ${id}`, 'UNSAFE_IDEA_ID');
    }
    const stat = lstatIfPresent(folder);
    if (stat !== null) {
      if (stat.isSymbolicLink()) fail(`Idea folder must not be a symlink: ${id}`, 'IDEA_SYMLINK_DENIED');
      if (!stat.isDirectory()) fail(`Idea folder must be a directory: ${id}`, 'INVALID_IDEA_RECORD');
    } else if (!allowMissing) {
      return null;
    }
    return folder;
  }

  #readEnvelope(id) {
    const folder = this.#folder(id);
    if (folder === null) return null;
    const file = path.join(folder, 'idea.json');
    const stat = lstatIfPresent(file);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) fail(`Idea record must not be a symlink: ${id}`, 'IDEA_SYMLINK_DENIED');
    if (!stat.isFile()) fail(`Idea record must be a regular file: ${id}`, 'INVALID_IDEA_RECORD');
    return validateEnvelope(readJson(file, `Idea record ${id}`), id);
  }

  #folderIdeas() {
    if (!this.#assertRootChain()) return [];
    const records = [];
    for (const entry of fs.readdirSync(this.ideasDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        fail(`Idea root must not contain symlinks: ${entry.name}`, 'IDEA_SYMLINK_DENIED');
      }
      if (!entry.isDirectory()) continue;
      const id = assertSafeIdeaId(entry.name, 'Idea folder id');
      const envelope = this.#readEnvelope(id);
      if (envelope) records.push(contentProjection(envelope));
    }
    return records.sort(createdAtDescending);
  }

  #refreshIndex() {
    if (!this.index) return null;
    try {
      return this.index.rebuild();
    } catch {
      // Idea content is authoritative. A later global-index read repairs projection.
      return null;
    }
  }
}

export const IdeaStore = new FileIdeaStore();
