import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECTS_DIR } from '../config.js';
import { canonicalSha256, createArtifactRef, deepFreeze } from '../core/contracts/ArtifactRef.js';
import { normalizeSafeRelativePath } from '../core/policy/pathPolicy.js';
import { atomicCreateFileSync, atomicWriteFileSync, withFileLockSync } from '../lib/fileLock.js';

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 'workspace-snapshot.v1';
export const WORKSPACE_MOUNT_NAMES = Object.freeze(['library', 'evidence', 'project', 'scratch', 'output']);

const MOUNT_CONFIG = Object.freeze({
  library: Object.freeze({ mode: 'ro', allowedGlobs: ['**'], maxReadBytes: 24_000, maxWriteBytes: 0 }),
  evidence: Object.freeze({ mode: 'ro', allowedGlobs: ['**'], maxReadBytes: 24_000, maxWriteBytes: 0 }),
  project: Object.freeze({ mode: 'rw', allowedGlobs: ['data/**', 'analysis/**', 'report/**'], maxReadBytes: 24_000, maxWriteBytes: 1_000_000 }),
  scratch: Object.freeze({ mode: 'rw', allowedGlobs: ['**'], maxReadBytes: 24_000, maxWriteBytes: 1_000_000 }),
  output: Object.freeze({ mode: 'create', allowedGlobs: ['**'], maxReadBytes: 24_000, maxWriteBytes: 1_000_000 }),
});

export class WorkspacePermissionError extends Error {
  constructor(reason, details = {}) {
    super(`Workspace permission denied: ${reason}`);
    this.name = 'WorkspacePermissionError';
    this.code = 'WORKSPACE_PERMISSION_DENIED';
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

function deny(reason, details) {
  throw new WorkspacePermissionError(reason, details);
}

function assertIdentity(value, field) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    throw new TypeError(`${field} is unsafe`);
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoSymlink(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      deny('symlink-escape-denied', { path: target });
    }
  }
}

function parseWorkspacePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || value.includes('\\')) {
    deny('unsafe-workspace-path', { path: value });
  }
  if (!value.startsWith('/')) {
    const relativePath = normalizeSafeRelativePath(value);
    if (!relativePath) deny('unsafe-workspace-path', { path: value });
    return { mount: 'project', relativePath };
  }
  const [mount, ...segments] = value.slice(1).split('/');
  if (!WORKSPACE_MOUNT_NAMES.includes(mount)) deny('unknown-mount', { path: value, mount });
  const relativePath = normalizeSafeRelativePath(segments.join('/'));
  if (!relativePath) deny('unsafe-workspace-path', { path: value });
  return { mount, relativePath };
}

export class FileWorkspaceService {
  constructor({ projectId, projectsDir = PROJECTS_DIR } = {}) {
    assertIdentity(projectId, 'projectId');
    this.projectId = projectId;
    this.projectsDir = path.resolve(projectsDir);
    this.projectDir = path.join(this.projectsDir, projectId);
    this.workspaceDir = path.join(this.projectDir, '.workspace');
    this.snapshotDir = path.join(this.workspaceDir, 'snapshots');
    this.lockDir = path.join(this.workspaceDir, 'locks');
  }

  mounts({ runId = 'unbound' } = {}) {
    assertIdentity(runId, 'runId');
    return deepFreeze(WORKSPACE_MOUNT_NAMES.map((name) => ({
      name,
      mountPath: `/${name}`,
      uri: `workspace://${this.projectId}/${name}`,
      ...MOUNT_CONFIG[name],
      ...(name === 'scratch' ? { runId } : {}),
    })));
  }

  createSnapshot({ runId, nodeId, asOf, artifactRefs = [] } = {}) {
    assertIdentity(runId, 'runId');
    assertIdentity(nodeId, 'nodeId');
    if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) throw new TypeError('asOf must be an ISO timestamp');
    const refs = artifactRefs.map((ref) => createArtifactRef(ref));
    const payload = {
      schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
      projectId: this.projectId,
      runId,
      nodeId,
      asOf,
      manifestDigest: canonicalSha256(refs),
      artifactRefs: refs,
      mounts: this.mounts({ runId }),
    };
    const digest = canonicalSha256(payload);
    const snapshotId = `workspace-snapshot:${digest.slice('sha256:'.length)}`;
    const record = deepFreeze({ ...payload, snapshotId, createdAt: asOf });
    const file = this.#snapshotPath(snapshotId);
    const lock = `${file}.lock`;
    withFileLockSync(lock, () => {
      if (!fs.existsSync(file)) atomicCreateFileSync(file, JSON.stringify(record, null, 2));
    });
    return this.loadSnapshot(snapshotId);
  }

  loadSnapshot(snapshotId) {
    const file = this.#snapshotPath(snapshotId);
    if (!fs.existsSync(file)) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { deny('invalid-workspace-snapshot', { snapshotId }); }
    if (
      record?.schemaVersion !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION
      || record.projectId !== this.projectId
      || record.snapshotId !== snapshotId
      || !Array.isArray(record.mounts)
      || !Array.isArray(record.artifactRefs)
    ) {
      deny('invalid-workspace-snapshot', { snapshotId });
    }
    record.artifactRefs = record.artifactRefs.map((ref) => createArtifactRef(ref));
    return deepFreeze(record);
  }

  resolve(workspacePath, {
    allowedMounts = ['/project'],
    access = 'read',
    runId = 'unbound',
    mustExist = access === 'read',
  } = {}) {
    const parsed = parseWorkspacePath(workspacePath);
    const mountPath = `/${parsed.mount}`;
    if (!Array.isArray(allowedMounts) || !allowedMounts.includes(mountPath)) {
      deny('mount-not-allowed', { path: workspacePath, mount: mountPath });
    }
    const config = MOUNT_CONFIG[parsed.mount];
    if (access !== 'read' && config.mode === 'ro') deny('mount-read-only', { path: workspacePath, mount: mountPath });
    const root = this.#mountRoot(parsed.mount, runId);
    if (access !== 'read') fs.mkdirSync(root, { recursive: true });
    const absolutePath = path.resolve(root, parsed.relativePath);
    if (!inside(root, absolutePath)) deny('unsafe-workspace-path', { path: workspacePath });
    assertNoSymlink(root, absolutePath);
    if (mustExist && (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory())) {
      deny('workspace-file-not-found', { path: workspacePath });
    }
    return Object.freeze({
      mount: mountPath,
      mountName: parsed.mount,
      relativePath: parsed.relativePath,
      absolutePath,
      root,
      mode: config.mode,
    });
  }

  readText(workspacePath, options = {}) {
    const resolved = this.resolve(workspacePath, { ...options, access: 'read', mustExist: true });
    return fs.readFileSync(resolved.absolutePath, 'utf8');
  }

  writeText(workspacePath, content, options = {}) {
    const resolved = this.resolve(workspacePath, { ...options, access: 'write', mustExist: false });
    const lock = this.#lockPath(resolved.absolutePath);
    return withFileLockSync(lock, () => {
      assertNoSymlink(resolved.root, resolved.absolutePath);
      if (resolved.mode === 'create' && fs.existsSync(resolved.absolutePath)) {
        deny('output-overwrite-denied', { path: workspacePath });
      }
      if (resolved.mode === 'create') atomicCreateFileSync(resolved.absolutePath, String(content));
      else atomicWriteFileSync(resolved.absolutePath, String(content));
      return Object.freeze({ mount: resolved.mount, path: resolved.relativePath, bytes: Buffer.byteLength(String(content)) });
    });
  }

  appendText(workspacePath, content, { separator = '', ...options } = {}) {
    const resolved = this.resolve(workspacePath, { ...options, access: 'write', mustExist: false });
    const lock = this.#lockPath(resolved.absolutePath);
    return withFileLockSync(lock, () => {
      assertNoSymlink(resolved.root, resolved.absolutePath);
      if (resolved.mode === 'create' && fs.existsSync(resolved.absolutePath)) {
        deny('output-overwrite-denied', { path: workspacePath });
      }
      const prior = fs.existsSync(resolved.absolutePath) ? fs.readFileSync(resolved.absolutePath, 'utf8') : '';
      const next = `${prior}${prior ? separator : ''}${String(content)}`;
      if (resolved.mode === 'create') atomicCreateFileSync(resolved.absolutePath, next);
      else atomicWriteFileSync(resolved.absolutePath, next);
      return Object.freeze({ mount: resolved.mount, path: resolved.relativePath, bytes: Buffer.byteLength(next) });
    });
  }

  editText(workspacePath, { oldText, newText = '', replaceAll = false } = {}, options = {}) {
    const resolved = this.resolve(workspacePath, { ...options, access: 'write', mustExist: true });
    const lock = this.#lockPath(resolved.absolutePath);
    return withFileLockSync(lock, () => {
      assertNoSymlink(resolved.root, resolved.absolutePath);
      if (resolved.mode === 'create') deny('output-overwrite-denied', { path: workspacePath });
      const current = fs.readFileSync(resolved.absolutePath, 'utf8');
      const old = String(oldText || '');
      if (!old) throw new Error('oldText required');
      const occurrences = current.split(old).length - 1;
      if (occurrences === 0) throw new Error('oldText not found in file（必须与原文完全一致，含空白）');
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`oldText matches ${occurrences} places; provide more context or set replaceAll=true`);
      }
      const next = replaceAll ? current.split(old).join(String(newText)) : current.replace(old, String(newText));
      atomicWriteFileSync(resolved.absolutePath, next);
      return Object.freeze({ mount: resolved.mount, path: resolved.relativePath, bytes: Buffer.byteLength(next) });
    });
  }

  #mountRoot(mount, runId) {
    if (mount === 'library') return this.projectsDir;
    if (mount === 'evidence') return path.join(this.projectDir, 'data');
    if (mount === 'project') return this.projectDir;
    if (mount === 'output') return path.join(this.projectDir, 'report');
    assertIdentity(runId, 'runId');
    return path.join(this.workspaceDir, 'scratch', runId);
  }

  #lockPath(file) {
    const digest = crypto.createHash('sha256').update(file).digest('hex');
    return path.join(this.lockDir, `${digest}.lock`);
  }

  #snapshotPath(snapshotId) {
    if (typeof snapshotId !== 'string' || !/^workspace-snapshot:[a-f0-9]{64}$/u.test(snapshotId)) {
      deny('invalid-workspace-snapshot', { snapshotId });
    }
    return path.join(this.snapshotDir, `${snapshotId.slice('workspace-snapshot:'.length)}.json`);
  }
}
