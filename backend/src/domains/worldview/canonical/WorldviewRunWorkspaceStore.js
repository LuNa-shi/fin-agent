import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from '../../../core/contracts/ArtifactRef.js';
import { atomicCreateFileSync } from '../../../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  ensureOwnedStorageDirectory,
} from '../../../lib/storageBoundary.js';
import {
  canonicalWorldviewSafeId,
  canonicalWorldviewTimestamp,
} from './canonicalWorldviewContracts.js';

export const WORLDVIEW_RUN_WORKSPACE_CONTRACT = 'worldview-run-workspace.v1';
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function fail(message, code = 'WORLDVIEW_WORKSPACE_CORRUPT') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, field) {
  assertObject(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${field}.${key} is not supported`);
  }
}

function normalizeClaimTable(value) {
  if (!Array.isArray(value)) throw new TypeError('workspace.claimTable must be an array');
  const seen = new Set();
  return value.map((item, index) => {
    exactKeys(item, ['claimId', 'version', 'assertion'], `workspace.claimTable[${index}]`);
    const claimId = canonicalWorldviewSafeId(item.claimId, `workspace.claimTable[${index}].claimId`);
    if (seen.has(claimId)) throw new TypeError(`workspace.claimTable contains duplicate ${claimId}`);
    seen.add(claimId);
    if (!Number.isInteger(item.version) || item.version < 1) {
      throw new TypeError(`workspace.claimTable[${index}].version must be positive`);
    }
    if (typeof item.assertion !== 'string' || !item.assertion.trim() || /[\r\n]/u.test(item.assertion)) {
      throw new TypeError(`workspace.claimTable[${index}].assertion must be one non-empty line`);
    }
    return { claimId, version: item.version, assertion: item.assertion.trim() };
  });
}

function normalizeWorkspaceContent(input) {
  exactKeys(input, [
    'runId', 'triggerId', 'batchId', 'cycleOrdinal', 'createdAt', 'asOf',
    'frozenRange', 'manifest', 'currentWorldview', 'claims', 'claimTable',
    'effectiveConfig', 'promptIdentity', 'retryPolicies', 'bounds', 'capabilityScopeId',
    'approvedCapabilities',
  ], 'workspace');
  const manifest = assertObject(input.manifest, 'workspace.manifest');
  if (!Array.isArray(manifest.items) || manifest.items.length < 1 || manifest.items.length > 100) {
    throw new TypeError('workspace.manifest must contain between 1 and 100 Reports');
  }
  if (!Array.isArray(input.claims)) throw new TypeError('workspace.claims must be an array');
  if (!Array.isArray(input.approvedCapabilities) || !input.approvedCapabilities.length) {
    throw new TypeError('workspace.approvedCapabilities must be a non-empty array');
  }
  const retryPolicies = assertObject(input.retryPolicies, 'workspace.retryPolicies');
  if (retryPolicies.wholeAgent?.maxAttempts !== 3) {
    throw new TypeError('workspace whole-Agent retry maxAttempts must be 3');
  }
  if (retryPolicies.modelApi?.maxAttempts !== 5) {
    throw new TypeError('workspace model API retry maxAttempts must be 5');
  }
  return {
    runId: canonicalWorldviewSafeId(input.runId, 'workspace.runId'),
    triggerId: canonicalWorldviewSafeId(input.triggerId, 'workspace.triggerId'),
    batchId: canonicalWorldviewSafeId(input.batchId, 'workspace.batchId'),
    cycleOrdinal: input.cycleOrdinal,
    createdAt: canonicalWorldviewTimestamp(input.createdAt, 'workspace.createdAt'),
    asOf: canonicalWorldviewTimestamp(input.asOf, 'workspace.asOf'),
    frozenRange: clone(input.frozenRange),
    manifest: clone(manifest),
    currentWorldview: input.currentWorldview === null ? null : clone(assertObject(input.currentWorldview, 'workspace.currentWorldview')),
    claims: clone(input.claims),
    claimTable: normalizeClaimTable(input.claimTable),
    effectiveConfig: clone(assertObject(input.effectiveConfig, 'workspace.effectiveConfig')),
    promptIdentity: clone(assertObject(input.promptIdentity, 'workspace.promptIdentity')),
    retryPolicies: clone(retryPolicies),
    bounds: clone(assertObject(input.bounds, 'workspace.bounds')),
    capabilityScopeId: canonicalWorldviewSafeId(input.capabilityScopeId, 'workspace.capabilityScopeId'),
    approvedCapabilities: [...input.approvedCapabilities],
  };
}

function normalizedRecord(input) {
  exactKeys(input, ['contract', 'workspaceId', 'workspaceDigest', 'content'], 'workspace record');
  if (input.contract !== WORLDVIEW_RUN_WORKSPACE_CONTRACT) fail('Worldview workspace contract is invalid');
  const workspaceId = canonicalWorldviewSafeId(input.workspaceId, 'workspaceId');
  if (!DIGEST_RE.test(input.workspaceDigest)) fail('Worldview workspace digest is invalid');
  const content = normalizeWorkspaceContent(input.content);
  const expectedId = `worldview_workspace_${canonicalSha256({
    runId: content.runId,
    triggerId: content.triggerId,
    manifestDigest: content.manifest.manifestDigest,
    effectiveConfigDigest: content.effectiveConfig.effectiveConfigDigest,
  }).slice('sha256:'.length)}`;
  if (workspaceId !== expectedId) fail('Worldview workspace identity is invalid');
  const expectedDigest = canonicalSha256(content);
  if (input.workspaceDigest !== expectedDigest) fail('Worldview workspace digest verification failed');
  return deepFreeze({ contract: WORLDVIEW_RUN_WORKSPACE_CONTRACT, workspaceId, workspaceDigest: expectedDigest, content });
}

export class WorldviewRunWorkspaceStore {
  constructor({ rootDir } = {}) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('WorldviewRunWorkspaceStore rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.workspacesDir = path.join(this.rootDir, 'workspaces');
    ensureOwnedStorageDirectory(this.workspacesDir, 'Worldview Run Workspace directory', { create: true, recursive: true });
  }

  freeze(input) {
    const content = normalizeWorkspaceContent(input);
    const workspaceId = `worldview_workspace_${canonicalSha256({
      runId: content.runId,
      triggerId: content.triggerId,
      manifestDigest: content.manifest.manifestDigest,
      effectiveConfigDigest: content.effectiveConfig.effectiveConfigDigest,
    }).slice('sha256:'.length)}`;
    const record = normalizedRecord({
      contract: WORLDVIEW_RUN_WORKSPACE_CONTRACT,
      workspaceId,
      workspaceDigest: canonicalSha256(content),
      content,
    });
    const file = path.join(this.workspacesDir, `${workspaceId}.json`);
    if (fs.existsSync(file)) {
      const existing = this.load(workspaceId);
      if (canonicalStringify(existing) !== canonicalStringify(record)) {
        fail('Worldview workspace identity conflicts with existing immutable bytes', 'WORLDVIEW_WORKSPACE_CONFLICT');
      }
      return existing;
    }
    atomicCreateFileSync(file, `${canonicalStringify(record)}\n`);
    return this.load(workspaceId);
  }

  load(workspaceIdInput) {
    const workspaceId = canonicalWorldviewSafeId(workspaceIdInput, 'workspaceId');
    const file = path.join(this.workspacesDir, `${workspaceId}.json`);
    if (!fs.existsSync(file)) return null;
    assertOwnedStorageFile(file, 'Worldview Run Workspace', { allowMissing: false });
    try {
      return normalizedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code?.startsWith('WORLDVIEW_WORKSPACE_')) throw error;
      fail(`Worldview workspace is corrupt: ${error.message}`);
    }
  }

  listIds() {
    return deepFreeze(fs.readdirSync(this.workspacesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => canonicalWorldviewSafeId(
        entry.name.slice(0, -'.json'.length),
        'workspaceId',
      ))
      .sort());
  }
}

export function createWorldviewRunWorkspaceStore(options = {}) {
  return new WorldviewRunWorkspaceStore(options);
}
