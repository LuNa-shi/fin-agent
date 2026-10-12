import { NODE_STATES } from './NodeState.js';

const TRANSIENT_CODES = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'MODEL_TRANSPORT_TRANSIENT',
  'PI_MODEL_UNAVAILABLE',
  'PROCESS_TERMINATED',
]);
const PERMISSION_CODES = new Set([
  'CONTEXT_PERMISSION_DENIED',
  'TOOL_PERMISSION_DENIED',
  'UNSAFE_ARTIFACT_PATH',
  'UNSAFE_PROJECT_ID',
]);
const SCHEMA_CODES = new Set([
  'CONTRACT_COMPLETION_REJECTED',
  'INVALID_ARTIFACT_REF',
  'TOOL_INPUT_INVALID',
]);

function messageFor(error) {
  return String(error?.message || error || 'workflow node failed');
}

export function classifyWorkflowFailure(error) {
  const code = String(error?.code || error?.cause?.code || '');
  const stopReason = String(error?.stopReason || error?.agentRunResult?.stopReason || '');
  const message = messageFor(error);

  if (stopReason === 'cancelled' || /\b(?:paused|cancelled|canceled|aborted)\b/iu.test(message)) {
    return Object.freeze({ state: NODE_STATES.CANCELLED, category: 'cancelled', reason: 'cancelled', retryKey: null });
  }
  if (PERMISSION_CODES.has(code) || /\bpermission denied\b/iu.test(message)) {
    return Object.freeze({ state: NODE_STATES.FAILED_PERMISSION, category: 'permission', reason: code || 'permission-denied', retryKey: null });
  }
  if (SCHEMA_CODES.has(code) || stopReason === 'schema-invalid') {
    return Object.freeze({ state: NODE_STATES.FAILED_SCHEMA, category: 'schema', reason: code || 'schema-invalid', retryKey: null });
  }
  if (
    TRANSIENT_CODES.has(code)
    || ['deadline', 'provider-unavailable'].includes(stopReason)
    || /(?:\b429\b|rate.?limit|too many requests|\b5\d\d\b|stream error|INTERNAL_ERROR|ECONNRESET|ETIMEDOUT|timeout|temporar(?:y|ily)|provider unavailable)/iu.test(message)
  ) {
    const retryKey = code === 'PI_MODEL_UNAVAILABLE' || stopReason === 'provider-unavailable'
      ? 'provider-unavailable'
      : 'transient';
    return Object.freeze({ state: NODE_STATES.FAILED_TRANSIENT, category: 'transient', reason: code || stopReason || 'transient', retryKey });
  }
  return Object.freeze({ state: NODE_STATES.FAILED_BUSINESS, category: 'business', reason: code || stopReason || 'business-error', retryKey: null });
}

export function shouldRetryWorkflowFailure(classification, retryPolicy = {}, attempt = 1) {
  if (!classification || classification.state !== NODE_STATES.FAILED_TRANSIENT) return false;
  const maxAttempts = Number.isInteger(retryPolicy.maxAttempts) ? retryPolicy.maxAttempts : 1;
  const retryOn = new Set(Array.isArray(retryPolicy.retryOn) ? retryPolicy.retryOn : []);
  return attempt < maxAttempts && retryOn.has(classification.retryKey || 'transient');
}
