import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { canonicalStringify } from '../contracts/ArtifactRef.js';
import { createAgentRunResult } from '../contracts/agentContracts.js';

export const AGENT_RESULT_IDEMPOTENCY_STORE_VERSION = 1;
export const AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS = Object.freeze([
  'projectId',
  'agentContractId',
  'contractVersion',
  'idempotencyKey',
]);
export const AGENT_RESULT_LOGICAL_INPUT_FIELDS = Object.freeze([
  'workflowId',
  'nodeId',
  'input',
  'inputArtifactRefs',
  'workspaceSnapshotId',
  'priorReviewIssues',
]);
export const AGENT_RESULT_CACHEABLE_STATUSES = Object.freeze(['succeeded']);

export const IDEMPOTENCY_CONFLICT_CODE = 'AGENT_RESULT_IDEMPOTENCY_CONFLICT';
export const IDEMPOTENCY_CACHE_INVALID_CODE = 'AGENT_RESULT_IDEMPOTENCY_CACHE_INVALID';

function typedError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function stableJson(value) {
  return canonicalStringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWriteIfAbsent(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function persistableModelRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return route;
  const projected = {};
  for (const field of ['provider', 'modelId', 'reasoningLevel', 'fallbackFrom']) {
    if (route[field] !== undefined) projected[field] = route[field];
  }
  if (route.attemptedProviders !== undefined) {
    projected.attemptedProviders = Array.isArray(route.attemptedProviders)
      ? [...route.attemptedProviders]
      : route.attemptedProviders;
  }
  return projected;
}

function persistableSucceededResult(result) {
  const snapshot = { ...result };
  if (result?.trace && typeof result.trace === 'object' && !Array.isArray(result.trace)) {
    snapshot.trace = { ...result.trace };
    if (Object.prototype.hasOwnProperty.call(result.trace, 'modelRoute')) {
      snapshot.trace.modelRoute = persistableModelRoute(result.trace.modelRoute);
    }
  }
  return snapshot;
}

function normalizeSucceededResult(result) {
  try {
    const snapshot = JSON.parse(stableJson(persistableSucceededResult(result)));
    const validated = createAgentRunResult(snapshot);
    if (validated.status !== 'succeeded') {
      throw new TypeError('Agent result is not succeeded');
    }
    return validated;
  } catch (error) {
    if (error?.code === IDEMPOTENCY_CACHE_INVALID_CODE) throw error;
    throw typedError(
      `Agent idempotency result is not persistable: ${error.message}`,
      IDEMPOTENCY_CACHE_INVALID_CODE,
    );
  }
}

export function agentResultIdempotencyScope(request) {
  return Object.fromEntries(AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS.map((field) => [field, request[field]]));
}

export function agentResultLogicalFingerprint(request) {
  const logicalInput = Object.fromEntries(AGENT_RESULT_LOGICAL_INPUT_FIELDS.map((field) => [field, request[field]]));
  logicalInput.priorReviewIssues = request.priorReviewIssues || [];
  const serialized = JSON.stringify(logicalInput);
  const persistable = serialized === undefined ? String(logicalInput) : JSON.parse(serialized);
  return sha256(stableJson(persistable));
}

export class AgentResultIdempotencyStore {
  constructor({ dataDir = DATA_DIR, rootDir = path.join(dataDir, 'agent-result-idempotency') } = {}) {
    this.rootDir = path.resolve(rootDir);
  }

  pathForScope(scope) {
    const digest = sha256(stableJson(scope));
    return path.join(this.rootDir, digest.slice(0, 2), `${digest}.json`);
  }

  read(scope, fingerprint) {
    const file = this.pathForScope(scope);
    if (!fs.existsSync(file)) return null;
    const entry = this.#readEntry(file);
    if (stableJson(entry.scope) !== stableJson(scope)) {
      throw typedError('Agent idempotency cache scope digest mismatch', IDEMPOTENCY_CACHE_INVALID_CODE, { scope });
    }
    if (entry.fingerprint !== fingerprint) {
      throw typedError('Agent idempotency key was reused with different logical input', IDEMPOTENCY_CONFLICT_CODE, { scope });
    }
    return createAgentRunResult(entry.result);
  }

  writeSucceeded(scope, fingerprint, result) {
    if (result?.status !== 'succeeded') return result;
    const validated = normalizeSucceededResult(result);
    const file = this.pathForScope(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = this.#entry(scope, fingerprint, validated);
    if (atomicWriteIfAbsent(file, `${JSON.stringify(entry, null, 2)}\n`)) return validated;
    const existing = this.read(scope, fingerprint);
    if (existing?.status !== 'succeeded') {
      throw typedError('Agent idempotency cache entry is not a succeeded result', IDEMPOTENCY_CACHE_INVALID_CODE, { scope });
    }
    return existing;
  }

  #entry(scope, fingerprint, result) {
    const resultDigest = sha256(stableJson(result));
    const unsigned = {
      version: AGENT_RESULT_IDEMPOTENCY_STORE_VERSION,
      scope,
      fingerprint,
      resultDigest,
      result,
      createdAt: new Date().toISOString(),
    };
    return {
      ...unsigned,
      contentDigest: sha256(stableJson(unsigned)),
    };
  }

  #readEntry(file) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw typedError(`Agent idempotency cache entry is unreadable: ${error.message}`, IDEMPOTENCY_CACHE_INVALID_CODE);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw typedError('Agent idempotency cache entry must be an object', IDEMPOTENCY_CACHE_INVALID_CODE);
    }
    const { contentDigest, ...unsigned } = entry;
    if (
      entry.version !== AGENT_RESULT_IDEMPOTENCY_STORE_VERSION
      || !entry.scope || typeof entry.scope !== 'object' || Array.isArray(entry.scope)
      || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)
      || typeof entry.resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.resultDigest)
      || typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))
      || typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(contentDigest)
      || !entry.result || typeof entry.result !== 'object' || Array.isArray(entry.result)
    ) {
      throw typedError('Agent idempotency cache entry schema is invalid', IDEMPOTENCY_CACHE_INVALID_CODE);
    }
    try {
      if (sha256(stableJson(unsigned)) !== contentDigest) {
        throw typedError('Agent idempotency cache entry digest mismatch', IDEMPOTENCY_CACHE_INVALID_CODE);
      }
      if (sha256(stableJson(entry.result)) !== entry.resultDigest) {
        throw typedError('Agent idempotency result digest mismatch', IDEMPOTENCY_CACHE_INVALID_CODE);
      }
      return { ...entry, result: normalizeSucceededResult(entry.result) };
    } catch (error) {
      if (error?.code === IDEMPOTENCY_CACHE_INVALID_CODE) throw error;
      throw typedError(`Agent idempotency cache entry is invalid: ${error.message}`, IDEMPOTENCY_CACHE_INVALID_CODE);
    }
  }
}
