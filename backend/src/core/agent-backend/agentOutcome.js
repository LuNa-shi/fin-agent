const STOP_REASON_ALIASES = Object.freeze({
  stop: 'final',
  length: 'model-length',
  aborted: 'cancelled',
});

export const PARTIAL_AGENT_STOP_REASONS = Object.freeze(new Set([
  'cancelled',
  'deadline',
  'maxTurns',
  'model-length',
  'tool-budget',
  'token-budget',
  'cost-budget',
  'schema-invalid',
]));

export function canonicalAgentStopReason(value, { budgetExhausted = false } = {}) {
  const raw = value || (budgetExhausted ? 'token-budget' : 'final');
  return STOP_REASON_ALIASES[raw] || raw;
}

export function canonicalAgentStatus({ stopReason, valid = true, outputPresent = true, budgetExhausted = false } = {}) {
  const canonicalStop = canonicalAgentStopReason(stopReason, { budgetExhausted });
  if (canonicalStop === 'error') return 'failed';
  if (!valid || !outputPresent || budgetExhausted || PARTIAL_AGENT_STOP_REASONS.has(canonicalStop)) return 'partial';
  return 'succeeded';
}
