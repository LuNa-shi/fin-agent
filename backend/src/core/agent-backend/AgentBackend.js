/**
 * Domain-neutral execution boundary. Implementations accept a versioned
 * AgentRunRequest plus runtime-only overrides and return AgentRunResult.
 */
export class AgentBackend {
  async run(_request, _runtime = {}) {
    throw new Error('AgentBackend.run must be implemented by a backend');
  }

  async cancel(_runId, _nodeId) {
    return false;
  }
}

export function assertAgentBackend(value) {
  if (!value || typeof value.run !== 'function') throw new TypeError('agent backend must implement run(request, runtime)');
  return value;
}
