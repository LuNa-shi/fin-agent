import { hydrateIdeaNodeOutput } from '../completion/nodeArtifacts.js';

export function hydrate(context, node, execution) {
  return hydrateIdeaNodeOutput(context, node, execution);
}

export function jsonSnapshot(value, fallback = null) {
  if (value === undefined) return fallback;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? fallback : JSON.parse(serialized);
}

export function safeAgentResult(result) {
  return Object.fromEntries(Object.entries({
    status: result?.status || 'failed',
    valid: result?.valid !== false,
    provider: result?.provider || null,
    model: result?.model || null,
    live: result?.live === true,
    stopReason: result?.stopReason || null,
    traceRef: result?.traceRef || null,
    metrics: jsonSnapshot(result?.metrics, {}),
  }).filter(([, value]) => value !== undefined));
}
