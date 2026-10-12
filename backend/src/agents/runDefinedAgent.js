import { agentExecutionRuntime } from './AgentExecutionRuntime.js';

export async function runDefinedAgent(agentId, input = {}, options = {}) {
  return agentExecutionRuntime.run(agentId, input, options);
}
