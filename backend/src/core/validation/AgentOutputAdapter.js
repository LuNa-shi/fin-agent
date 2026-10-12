import { parseJsonOutput } from './OutputGate.js';

const STRUCTURED_HARD_CHECKS = new Set([
  'bounded-pool',
  'claims-shape',
  'conclusion-schema',
  'coverage',
  'crux-shape',
  'data-organize-schema',
  'expected-return-score-clamp',
  'invalidation',
  'ladder-compare-schema',
  'output-schema',
  'plan-shape',
  'probability-sum',
  'rankings-shape',
  'reflection-shape',
  'review-shape',
  'scenario-schema',
  'screen-shape',
  'structural-view',
  'ticker',
  'valuation',
]);

function requiresStructuredOutput(contract) {
  return contract.executionMode === 'json'
    || (contract.completionPolicy?.hardChecks || []).some((check) => STRUCTURED_HARD_CHECKS.has(check));
}

/**
 * Return only bounded, line-safe validation details from an output adapter.
 * Adapter exception messages may contain arbitrary model output, so callers
 * must not put `error.message` directly into a repair prompt.
 */
export function adapterValidationErrors(error) {
  const details = Array.isArray(error?.errors) ? error.errors : [];
  const sanitized = [...new Set(details
    .map((detail) => String(detail).replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240))
    .filter(Boolean))].slice(0, 12);
  return sanitized.length ? sanitized : ['structured output projection rejected'];
}

export function adaptAgentOutput({ contract, request, output, text = '' } = {}) {
  if (!contract || typeof contract !== 'object') throw new TypeError('Agent output adaptation requires a contract');
  const adapter = typeof contract.outputAdapter === 'function' ? contract.outputAdapter : null;
  if (!adapter && !requiresStructuredOutput(contract)) return output;
  let candidate = output;
  if (typeof candidate === 'string') candidate = parseJsonOutput(candidate) ?? candidate;
  if (candidate === undefined || candidate === null) candidate = parseJsonOutput(text);
  return adapter ? adapter(candidate, { request, contract, text }) : candidate;
}
