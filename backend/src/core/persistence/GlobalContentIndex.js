import fs from 'node:fs';
import path from 'node:path';

import {
  GLOBAL_DIR,
  IDEAS_DIR,
  PROJECTS_DIR,
} from '../../config.js';
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../contracts/ArtifactRef.js';
import {
  atomicWriteFileSync,
  withFileLockSync,
} from '../../lib/fileLock.js';

export const GLOBAL_CONTENT_INDEX_SCHEMA_VERSION = 'global-content-index.v1';
export const GLOBAL_CONTENT_INDEX_ENTRY_FIELDS = Object.freeze([
  'id',
  'type',
  'status',
  'title',
  'contentRef',
  'contentDigest',
  'createdAt',
  'updatedAt',
]);

const INDEX_FIELDS = Object.freeze(['schemaVersion', 'indexDigest', 'entries']);
const CONTENT_TYPES = Object.freeze(['idea', 'project']);
const CONTENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

const TYPE_CONFIG = Object.freeze({
  idea: Object.freeze({
    anchorFile: 'idea.json',
    contentRefPrefix: 'idea-generation/ideas',
  }),
  project: Object.freeze({
    anchorFile: 'meta.json',
    contentRefPrefix: 'projects',
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareEntries(left, right) {
  return compareText(left.type, right.type) || compareText(left.id, right.id);
}

export class GlobalContentIndexError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'GlobalContentIndexError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new GlobalContentIndexError(code, message, cause ? { cause } : {});
}

function assertPathInput(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`GlobalContentIndex ${label} must be a non-empty path`);
  }
  return path.resolve(value);
}

function assertSafeContentId(id, context) {
  if (
    typeof id !== 'string'
    || !CONTENT_ID_RE.test(id)
    || id === '.'
    || id === '..'
    || id.includes('/')
    || id.includes('\\')
    || id.includes('\0')
    || path.posix.isAbsolute(id)
    || path.win32.isAbsolute(id)
  ) {
    fail('UNSAFE_GLOBAL_CONTENT_ID', `unsafe global content id at ${context}: ${String(id)}`);
  }
  return id;
}

function assertDirectoryIfPresent(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail('GLOBAL_CONTENT_SYMLINK_DENIED', `${label} must not be a symlink: ${directory}`);
  }
  if (!stat.isDirectory()) {
    fail('INVALID_GLOBAL_CONTENT_ROOT', `${label} must be a directory: ${directory}`);
  }
  return true;
}

function assertRegularAnchor(anchorFile, type, id) {
  let stat;
  try {
    stat = fs.lstatSync(anchorFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail(
      'GLOBAL_CONTENT_SYMLINK_DENIED',
      `${type} anchor must not be a symlink: ${id}`,
    );
  }
  if (!stat.isFile()) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor must be a regular file: ${id}`,
    );
  }
  return true;
}

function readAnchor(anchorFile, type, id) {
  let text;
  try {
    text = fs.readFileSync(anchorFile, 'utf8');
  } catch (error) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `unable to read ${type} anchor: ${id}`,
      error,
    );
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `invalid JSON in ${type} anchor: ${id}`,
      error,
    );
  }
  if (!isPlainObject(record)) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor must contain an object: ${id}`,
    );
  }
  return record;
}

function requiredText(value, field, type, id) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor requires non-empty ${field}: ${id}`,
    );
  }
  return value;
}

function timestamp(value, field, type, id) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor requires a non-negative epoch-ms ${field}: ${id}`,
    );
  }
  return value;
}

function contentRefFor(type, id) {
  return path.posix.join(TYPE_CONFIG[type].contentRefPrefix, id);
}

function entryFromAnchor(type, id, anchor) {
  if (anchor.id !== id) {
    fail(
      'GLOBAL_CONTENT_IDENTITY_MISMATCH',
      `${type} folder/anchor id mismatch: folder=${id} anchor=${String(anchor.id)}`,
    );
  }
  if (
    type === 'idea'
    && isPlainObject(anchor.body)
    && Object.prototype.hasOwnProperty.call(anchor.body, 'id')
    && anchor.body.id !== id
  ) {
    fail(
      'GLOBAL_CONTENT_IDENTITY_MISMATCH',
      `idea folder/body id mismatch: folder=${id} body=${String(anchor.body.id)}`,
    );
  }

  const createdAt = timestamp(anchor.createdAt, 'createdAt', type, id);
  const updatedAt = timestamp(
    anchor.updatedAt === undefined ? createdAt : anchor.updatedAt,
    'updatedAt',
    type,
    id,
  );
  if (updatedAt < createdAt) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor updatedAt precedes createdAt: ${id}`,
    );
  }

  let contentDigest;
  try {
    contentDigest = canonicalSha256(anchor);
  } catch (error) {
    fail(
      'INVALID_GLOBAL_CONTENT_ANCHOR',
      `${type} anchor is not canonically digestible: ${id}`,
      error,
    );
  }

  return {
    id,
    type,
    status: requiredText(anchor.status, 'status', type, id),
    title: requiredText(anchor.title, 'title', type, id),
    contentRef: contentRefFor(type, id),
    contentDigest,
    createdAt,
    updatedAt,
  };
}

function scanContentRoot(root, type) {
  if (!assertDirectoryIfPresent(root, `${type} content root`)) return [];

  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  const projected = [];

  for (const directoryEntry of entries) {
    if (directoryEntry.isSymbolicLink()) {
      fail(
        'GLOBAL_CONTENT_SYMLINK_DENIED',
        `${type} content root must not contain symlinks: ${directoryEntry.name}`,
      );
    }
    if (!directoryEntry.isDirectory()) {
      if (
        directoryEntry.isFile()
        || directoryEntry.isFIFO()
        || directoryEntry.isSocket()
        || directoryEntry.isCharacterDevice()
        || directoryEntry.isBlockDevice()
      ) {
        continue;
      }
      fail(
        'INVALID_GLOBAL_CONTENT_ROOT',
        `unsupported ${type} content root entry: ${directoryEntry.name}`,
      );
    }

    const id = assertSafeContentId(directoryEntry.name, `${type} content root`);
    const folder = path.join(root, id);
    if (!assertDirectoryIfPresent(folder, `${type} content folder`)) continue;
    const anchorFile = path.join(folder, TYPE_CONFIG[type].anchorFile);

    // The anchor is the commit marker. A direct-child folder without it is an
    // incomplete content commit and is not authoritative yet.
    if (!assertRegularAnchor(anchorFile, type, id)) continue;
    projected.push(entryFromAnchor(type, id, readAnchor(anchorFile, type, id)));
  }
  return projected;
}

function indexDigest(entries) {
  return canonicalSha256({
    schemaVersion: GLOBAL_CONTENT_INDEX_SCHEMA_VERSION,
    entries,
  });
}

function createIndex(entries) {
  const ordered = [...entries].sort(compareEntries);
  return {
    schemaVersion: GLOBAL_CONTENT_INDEX_SCHEMA_VERSION,
    indexDigest: indexDigest(ordered),
    entries: ordered,
  };
}

function validateStoredEntry(entry, index) {
  if (!isPlainObject(entry) || !sameKeys(entry, GLOBAL_CONTENT_INDEX_ENTRY_FIELDS)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index entry shape at entries[${index}]`);
  }
  const type = entry.type;
  if (!CONTENT_TYPES.includes(type)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index type at entries[${index}]`);
  }
  assertSafeContentId(entry.id, `global index entries[${index}]`);
  if (typeof entry.status !== 'string' || !entry.status.trim()) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index status at entries[${index}]`);
  }
  if (typeof entry.title !== 'string' || !entry.title.trim()) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index title at entries[${index}]`);
  }
  if (entry.contentRef !== contentRefFor(type, entry.id)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index contentRef at entries[${index}]`);
  }
  if (typeof entry.contentDigest !== 'string' || !SHA256_RE.test(entry.contentDigest)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index contentDigest at entries[${index}]`);
  }
  if (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index createdAt at entries[${index}]`);
  }
  if (
    !Number.isSafeInteger(entry.updatedAt)
    || entry.updatedAt < entry.createdAt
  ) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', `invalid global index updatedAt at entries[${index}]`);
  }
}

function validateStoredIndex(value) {
  if (!isPlainObject(value) || !sameKeys(value, INDEX_FIELDS)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', 'invalid global index document shape');
  }
  if (value.schemaVersion !== GLOBAL_CONTENT_INDEX_SCHEMA_VERSION) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', 'unsupported global index schemaVersion');
  }
  if (!Array.isArray(value.entries)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', 'global index entries must be an array');
  }

  let previous = null;
  const identities = new Set();
  value.entries.forEach((entry, index) => {
    validateStoredEntry(entry, index);
    const identity = `${entry.type}\0${entry.id}`;
    if (identities.has(identity)) {
      fail('INVALID_GLOBAL_CONTENT_INDEX', `duplicate global index entry: ${entry.type}/${entry.id}`);
    }
    identities.add(identity);
    if (previous && compareEntries(previous, entry) >= 0) {
      fail('INVALID_GLOBAL_CONTENT_INDEX', 'global index entries are not in deterministic type/id order');
    }
    previous = entry;
  });

  if (value.indexDigest !== indexDigest(value.entries)) {
    fail('INVALID_GLOBAL_CONTENT_INDEX', 'global index digest mismatch');
  }
  return value;
}

export class GlobalContentIndex {
  constructor({
    globalDir = GLOBAL_DIR,
    ideasDir = IDEAS_DIR,
    projectsDir = PROJECTS_DIR,
  } = {}) {
    this.globalDir = assertPathInput(globalDir, 'globalDir');
    this.ideasDir = assertPathInput(ideasDir, 'ideasDir');
    this.projectsDir = assertPathInput(projectsDir, 'projectsDir');
    this.dataDir = path.dirname(this.globalDir);

    if (
      this.globalDir !== path.join(this.dataDir, 'global')
      || this.ideasDir !== path.join(this.dataDir, 'idea-generation', 'ideas')
      || this.projectsDir !== path.join(this.dataDir, 'projects')
    ) {
      throw new TypeError(
        'GlobalContentIndex roots must be DATA_DIR/global, DATA_DIR/idea-generation/ideas, and DATA_DIR/projects',
      );
    }

    this.indexPath = path.join(this.globalDir, 'index.json');
    this.lockPath = path.join(this.globalDir, 'index.lock');
    Object.freeze(this);
  }

  #prepareGlobalRoot() {
    if (!assertDirectoryIfPresent(this.dataDir, 'configured data root')) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      assertDirectoryIfPresent(this.dataDir, 'configured data root');
    }
    if (!assertDirectoryIfPresent(this.globalDir, 'global index root')) {
      try {
        fs.mkdirSync(this.globalDir);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      assertDirectoryIfPresent(this.globalDir, 'global index root');
    }

    let lockStat;
    try {
      lockStat = fs.lstatSync(this.lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isDirectory() && !lockStat.isFile())) {
      fail('GLOBAL_CONTENT_SYMLINK_DENIED', `invalid global index lock path: ${this.lockPath}`);
    }
  }

  #assertScanRoots() {
    assertDirectoryIfPresent(this.dataDir, 'configured data root');

    const ideaGenerationDir = path.dirname(this.ideasDir);
    if (assertDirectoryIfPresent(ideaGenerationDir, 'idea-generation root')) {
      assertDirectoryIfPresent(this.ideasDir, 'idea content root');
    }
    assertDirectoryIfPresent(this.projectsDir, 'project content root');
  }

  #buildFromFolders() {
    this.#assertScanRoots();
    const ideas = scanContentRoot(this.ideasDir, 'idea');
    const projects = scanContentRoot(this.projectsDir, 'project');
    return createIndex([...ideas, ...projects]);
  }

  #readStoredIndex() {
    let stat;
    try {
      stat = fs.lstatSync(this.indexPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return null;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch (error) {
      if (error?.code && error.code !== 'ENOENT') throw error;
      return null;
    }
    try {
      return validateStoredIndex(parsed);
    } catch (error) {
      if (error instanceof GlobalContentIndexError) return null;
      throw error;
    }
  }

  #write(index) {
    atomicWriteFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  read() {
    this.#prepareGlobalRoot();
    return withFileLockSync(this.lockPath, () => {
      this.#assertScanRoots();
      const authoritative = this.#buildFromFolders();
      const stored = this.#readStoredIndex();
      if (
        stored === null
        || canonicalStringify(stored) !== canonicalStringify(authoritative)
      ) {
        this.#write(authoritative);
      }
      return deepFreeze(authoritative);
    });
  }

  rebuild() {
    this.#prepareGlobalRoot();
    return withFileLockSync(this.lockPath, () => {
      this.#assertScanRoots();
      const authoritative = this.#buildFromFolders();
      this.#write(authoritative);
      return deepFreeze(authoritative);
    });
  }
}

export const globalContentIndex = new GlobalContentIndex();
