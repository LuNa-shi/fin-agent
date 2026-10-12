import { assertAgentBackend } from '../core/agent-backend/AgentBackend.js';
import { ConcurrentAgentBackend } from '../core/agent-backend/ConcurrentAgentBackend.js';
import { withAgentResultIdempotency } from '../core/agent-backend/IdempotentAgentBackend.js';
import { PiAgentBackend } from '../core/agent-backend/PiAgentBackend.js';
import { getAgentDefinition } from './registry.js';

export function createDefaultAgentBackend({
  piBackend = new PiAgentBackend({ contractResolver: getAgentDefinition }),
  idempotencyStore,
  concurrent = true,
} = {}) {
  const executionBackend = concurrent
    ? new ConcurrentAgentBackend({ backend: piBackend })
    : assertAgentBackend(piBackend);
  return withAgentResultIdempotency(executionBackend, { store: idempotencyStore });
}

let backend = createDefaultAgentBackend();

export function setDefaultAgentBackend(nextBackend) {
  backend = assertAgentBackend(nextBackend);
}

export function resetDefaultAgentBackend() {
  backend = createDefaultAgentBackend();
}

export function getDefaultAgentBackend() {
  return backend;
}
