import { pLimitFair } from '../../lib/http.js';
import { AgentBackend, assertAgentBackend } from './AgentBackend.js';

const CONCURRENCY = Math.max(1, Number(process.env.LLM_MAX_CONCURRENCY) || 40);
const limit = pLimitFair(CONCURRENCY);
const PRIORITY_AGENTS = new Set([
  'conclusion-synthesizer',
  'idea-quality-reviewer',
  'project-classifier',
  'deal-ladder-ranking',
]);

export class ConcurrentAgentBackend extends AgentBackend {
  constructor({ backend } = {}) {
    super();
    this.backend = assertAgentBackend(backend);
  }

  run(request, runtime = {}) {
    return limit(() => this.backend.run(request, runtime), {
      lane: request?.projectId || request?.runId || 'global',
      priority: runtime.priority === true || PRIORITY_AGENTS.has(request?.agentContractId),
    });
  }

  cancel(runId, nodeId) {
    return this.backend.cancel?.(runId, nodeId) ?? false;
  }
}

export function agentQueueStats() {
  return {
    concurrency: CONCURRENCY,
    active: limit.stats.active(),
    queued: limit.stats.depth(),
  };
}
