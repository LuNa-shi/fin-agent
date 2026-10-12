import crypto from 'node:crypto';

const SESSION_PREFIX = 'finagent-pc-v1-';
const SESSION_DIGEST_CHARS = 48;

function requiredIdentity(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`Agent prompt cache identity requires ${label}`);
  return text;
}

export function agentPromptCacheSessionId(request = {}) {
  const identity = [
    'finagent-agent-prompt-cache.v1',
    requiredIdentity(request.workflowId, 'workflowId'),
    requiredIdentity(request.runId, 'runId'),
    requiredIdentity(request.nodeId, 'nodeId'),
    requiredIdentity(request.agentContractId, 'agentContractId'),
    requiredIdentity(request.idempotencyKey, 'idempotencyKey'),
    String(request.effectiveConfigDigest || '').trim(),
  ].join('\0');
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return `${SESSION_PREFIX}${digest.slice(0, SESSION_DIGEST_CHARS)}`;
}
