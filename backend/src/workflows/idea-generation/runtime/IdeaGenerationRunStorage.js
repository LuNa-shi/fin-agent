import fs from 'node:fs';
import path from 'node:path';

import { IDEA_RUNS_DIR } from '../../../config.js';
import { canonicalStringify, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import {
  FileIdeaRunInputSnapshotStore,
  ideaRunInputSnapshotStore,
} from '../../../domains/ideas/index.js';
import { atomicCreateFileSync } from '../../../lib/fileLock.js';
import {
  FileArtifactStore,
  FileEventBus,
  FileRunStore,
} from '../../../project-space/index.js';

export const IDEA_GENERATION_SCOPE = deepFreeze({
  kind: 'idea-universe',
  id: 'idea-universe:local-user',
});
export const IDEA_RUN_RETENTION_SCHEMA_VERSION = 'idea-run-retention.v1';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function storageError(message, code = 'IDEA_RUN_STORAGE_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(message, code) {
  throw storageError(message, code);
}

function assertRunId(runId) {
  if (
    typeof runId !== 'string'
    || !SAFE_RUN_ID.test(runId)
    || runId === '.'
    || runId === '..'
    || runId.includes('/')
    || runId.includes('\\')
    || runId.includes('\0')
    || path.posix.isAbsolute(runId)
    || path.win32.isAbsolute(runId)
  ) {
    fail(`unsafe Idea Generation run id: ${String(runId)}`, 'UNSAFE_IDEA_RUN_ID');
  }
  return runId;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('Idea Generation scope must be an object');
  }
  const keys = Object.keys(scope).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'kind') {
    throw new TypeError('Idea Generation scope must contain exactly kind and id');
  }
  if (scope.kind !== 'idea-universe') {
    throw new TypeError('Idea Generation scope.kind must be idea-universe');
  }
  if (
    typeof scope.id !== 'string'
    || !SAFE_SCOPE_ID.test(scope.id)
    || !scope.id.startsWith('idea-universe:')
  ) {
    throw new TypeError('Idea Generation scope.id is invalid');
  }
  return deepFreeze({ kind: scope.kind, id: scope.id });
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(target, label) {
  const stat = lstatOrNull(target);
  if (stat === null) return false;
  if (stat.isSymbolicLink()) {
    fail(`${label} must not be a symlink`, 'IDEA_RUN_STORAGE_SYMLINK');
  }
  if (!stat.isDirectory()) {
    fail(`${label} must be a directory`, 'IDEA_RUN_STORAGE_CORRUPT');
  }
  return true;
}

function retentionRecord(snapshot) {
  return {
    schemaVersion: IDEA_RUN_RETENTION_SCHEMA_VERSION,
    runId: snapshot.runId,
    policy: 'explicit-cleanup-only',
    createdAt: snapshot.asOf,
  };
}

function ensureRetentionMarker(runDir, snapshot) {
  const file = path.join(runDir, 'retention.json');
  const expected = retentionRecord(snapshot);
  const stat = lstatOrNull(file);
  if (stat === null) {
    atomicCreateFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    return deepFreeze(expected);
  }
  if (stat.isSymbolicLink()) {
    fail('Idea Generation retention marker must not be a symlink', 'IDEA_RUN_STORAGE_SYMLINK');
  }
  if (!stat.isFile()) {
    fail('Idea Generation retention marker must be a file', 'IDEA_RUN_STORAGE_CORRUPT');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('Idea Generation retention marker is unreadable', 'IDEA_RUN_STORAGE_CORRUPT');
  }
  if (canonicalStringify(parsed) !== canonicalStringify(expected)) {
    fail('Idea Generation retention marker identity conflicts with the run', 'IDEA_RUN_STORAGE_CONFLICT');
  }
  return deepFreeze(parsed);
}

export class IdeaGenerationRunStorage {
  constructor({
    runsDir = IDEA_RUNS_DIR,
    snapshotStore = ideaRunInputSnapshotStore,
    scope = IDEA_GENERATION_SCOPE,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof runsDir !== 'string' || !runsDir) {
      throw new TypeError('IdeaGenerationRunStorage runsDir is required');
    }
    if (
      !(snapshotStore instanceof FileIdeaRunInputSnapshotStore)
      && (
        typeof snapshotStore?.load !== 'function'
        || typeof snapshotStore?.resolve !== 'function'
        || typeof snapshotStore?.directory !== 'function'
        || typeof snapshotStore?.list !== 'function'
      )
    ) {
      throw new TypeError('IdeaGenerationRunStorage snapshotStore is invalid');
    }
    if (typeof now !== 'function') throw new TypeError('IdeaGenerationRunStorage now must be a function');
    this.runsDir = path.resolve(runsDir);
    this.snapshotStore = snapshotStore;
    this.scope = normalizeScope(scope);
    this.now = now;
    this.inFlight = new Map();
  }

  services(runId, { initialize = false } = {}) {
    const safeRunId = assertRunId(runId);
    if (typeof initialize !== 'boolean') {
      throw new TypeError('IdeaGenerationRunStorage initialize must be boolean');
    }
    const snapshot = this.snapshotStore.load(safeRunId);
    if (!snapshot) {
      fail(`Idea Generation input snapshot not found: ${safeRunId}`, 'IDEA_RUN_SNAPSHOT_NOT_FOUND');
    }
    const runDir = this.snapshotStore.directory(safeRunId, { create: false });
    if (!runDir || !assertDirectory(runDir, 'Idea Generation run directory')) {
      fail(`Idea Generation run directory not found: ${safeRunId}`, 'IDEA_RUN_NOT_FOUND');
    }
    const relative = path.relative(this.runsDir, runDir);
    if (relative !== safeRunId || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail('Idea Generation run directory escaped its configured root', 'UNSAFE_IDEA_RUN_ID');
    }
    if (initialize) ensureRetentionMarker(runDir, snapshot);
    const eventBus = new FileEventBus({
      projectId: this.scope.id,
      storageDir: runDir,
      now: this.now,
    });
    const runStore = new FileRunStore({
      projectId: this.scope.id,
      storageDir: runDir,
      eventBus,
      now: this.now,
    });
    const artifactStore = new FileArtifactStore({
      projectId: this.scope.id,
      storageDir: runDir,
      eventBus,
    });
    return {
      runDir,
      snapshot,
      scope: this.scope,
      eventBus,
      runStore,
      artifactStore,
    };
  }

  listSnapshots() {
    if (typeof this.snapshotStore.list !== 'function') {
      throw new TypeError('Idea Generation snapshot store must expose list()');
    }
    return this.snapshotStore.list();
  }

  list() {
    const rootStat = lstatOrNull(this.runsDir);
    if (rootStat === null) return [];
    if (rootStat.isSymbolicLink()) {
      fail('Idea Generation runs root must not be a symlink', 'IDEA_RUN_STORAGE_SYMLINK');
    }
    if (!rootStat.isDirectory()) {
      fail('Idea Generation runs root must be a directory', 'IDEA_RUN_STORAGE_CORRUPT');
    }
    const records = [];
    for (const entry of fs.readdirSync(this.runsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        fail(`Idea Generation runs root contains a symlink: ${entry.name}`, 'IDEA_RUN_STORAGE_SYMLINK');
      }
      if (!entry.isDirectory()) continue;
      const runId = assertRunId(entry.name);
      const stateDir = path.join(this.runsDir, runId, '.runs');
      if (!assertDirectory(stateDir, 'Idea Generation run state directory')) continue;
      const { runStore } = this.services(runId);
      const scopedRecords = runStore.list();
      if (scopedRecords.length === 0) continue;
      if (
        scopedRecords.length !== 1
        || scopedRecords[0].runId !== runId
      ) {
        fail(`Idea Generation run state is ambiguous: ${runId}`, 'IDEA_RUN_STORAGE_CORRUPT');
      }
      records.push(scopedRecords[0]);
    }
    return records.sort((left, right) => (
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || left.runId.localeCompare(right.runId)
    ));
  }

  async singleFlight(runId, execute) {
    const safeRunId = assertRunId(runId);
    if (typeof execute !== 'function') throw new TypeError('Idea run execution callback is required');
    const current = this.inFlight.get(safeRunId);
    if (current) return current;
    const running = Promise.resolve().then(execute);
    this.inFlight.set(safeRunId, running);
    try {
      return await running;
    } finally {
      if (this.inFlight.get(safeRunId) === running) this.inFlight.delete(safeRunId);
    }
  }
}

export const ideaGenerationRunStorage = new IdeaGenerationRunStorage();
