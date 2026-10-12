import { AgentBackend, assertAgentBackend } from './AgentBackend.js';
import {
  AgentResultIdempotencyStore,
  IDEMPOTENCY_CONFLICT_CODE,
  agentResultIdempotencyScope,
  agentResultLogicalFingerprint,
  stableJson,
} from './AgentResultIdempotencyStore.js';
import { createAgentRunRequest } from '../contracts/agentContracts.js';

const WRAPPED = Symbol.for('finagent.agent-backend.idempotent');
const RESULT_PROVENANCE = new WeakMap();
export const AGENT_PHYSICAL_EXECUTION_OBSERVER = Symbol.for(
  'finagent.agent-backend.physical-execution-observer',
);

function markResultProvenance(runtime, provenance) {
  if (runtime && (typeof runtime === 'object' || typeof runtime === 'function')) {
    RESULT_PROVENANCE.set(runtime, provenance);
  }
}

export function agentResultExecutionProvenance(runtime) {
  return RESULT_PROVENANCE.get(runtime) || 'physical';
}

function inFlightKey(scope) {
  return stableJson(scope);
}

export class IdempotentAgentBackend extends AgentBackend {
  constructor({ backend, store = new AgentResultIdempotencyStore() } = {}) {
    super();
    this.backend = assertAgentBackend(backend);
    this.store = store;
    this.inFlight = new Map();
    this[WRAPPED] = true;
  }

  cancel(runId, nodeId) {
    return this.backend.cancel?.(runId, nodeId) ?? false;
  }

  async run(value, runtime = {}) {
    markResultProvenance(runtime, 'pending');
    if (!Object.prototype.hasOwnProperty.call(value || {}, 'idempotencyKey')) {
      markResultProvenance(runtime, 'physical');
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'started',
        request: value,
      });
      const result = await this.backend.run(value, runtime);
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'completed',
        request: value,
        result,
      });
      return result;
    }
    const request = createAgentRunRequest(value);
    if (request.idempotencyKeyMode !== 'explicit') {
      markResultProvenance(runtime, 'physical');
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'started',
        request,
      });
      const result = await this.backend.run(request, runtime);
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'completed',
        request,
        result,
      });
      return result;
    }

    const scope = agentResultIdempotencyScope(request);
    const fingerprint = agentResultLogicalFingerprint(request);
    const cached = this.store.read(scope, fingerprint);
    if (cached) {
      markResultProvenance(runtime, 'cache-hit');
      return cached;
    }

    const key = inFlightKey(scope);
    const active = this.inFlight.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        const error = new Error('Agent idempotency key was reused with different logical input');
        error.code = IDEMPOTENCY_CONFLICT_CODE;
        error.scope = scope;
        throw error;
      }
      markResultProvenance(runtime, 'coalesced');
      return active.promise;
    }

    markResultProvenance(runtime, 'physical');
    const promise = (async () => {
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'started',
        request,
      });
      const result = await this.backend.run(request, runtime);
      await runtime[AGENT_PHYSICAL_EXECUTION_OBSERVER]?.({
        phase: 'completed',
        request,
        result,
      });
      if (result?.status === 'succeeded') return this.store.writeSucceeded(scope, fingerprint, result);
      return result;
    })();
    this.inFlight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }
}

export function withAgentResultIdempotency(backend, options = {}) {
  const resolved = assertAgentBackend(backend);
  if (resolved[WRAPPED]) {
    // A caller-provided store defines a narrower durable identity boundary (for example,
    // one workflow run). Re-wrap the underlying backend instead of silently reusing a
    // process-global cache whose logical input may belong to another run/remediation.
    if (Object.prototype.hasOwnProperty.call(options, 'store')) {
      return new IdempotentAgentBackend({ backend: resolved.backend, ...options });
    }
    return resolved;
  }
  return new IdempotentAgentBackend({ backend: resolved, ...options });
}
