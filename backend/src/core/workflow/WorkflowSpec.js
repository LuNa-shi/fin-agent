import { createHash } from 'node:crypto';

function canonicalValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((child, index) => canonicalValue(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') throw new TypeError(`unsupported canonical value at ${path}`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], `${path}.${key}`)]));
}

export function canonicalWorkflowSpecJSON(spec) {
  return JSON.stringify(canonicalValue(spec));
}

export function workflowSpecHash(spec) {
  return `sha256:${createHash('sha256').update(canonicalWorkflowSpecJSON(spec)).digest('hex')}`;
}

export function validateWorkflowSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('WorkflowSpec is required');
  for (const key of ['schemaVersion', 'id', 'version']) {
    if (typeof spec[key] !== 'string' || !spec[key]) throw new TypeError(`WorkflowSpec.${key} is required`);
  }
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) throw new TypeError('WorkflowSpec.nodes must be a non-empty array');

  const nodeIds = new Set();
  const handlerIds = new Set();
  for (const node of spec.nodes) {
    if (!node?.id || nodeIds.has(node.id)) {
      throw new Error(node?.id ? `duplicate workflow node: ${node.id}` : 'workflow node id is required');
    }
    nodeIds.add(node.id);
    if (!node.handlerId || handlerIds.has(node.handlerId)) {
      throw new Error(node.handlerId ? `duplicate workflow handler: ${node.handlerId}` : `handlerId is required for ${node.id}`);
    }
    handlerIds.add(node.handlerId);
    if (!Array.isArray(node.dependsOn)) throw new TypeError(`dependsOn must be an array for ${node.id}`);
    if (typeof node.conditionId !== 'string' || !node.conditionId) throw new TypeError(`conditionId is required for ${node.id}`);
    if (typeof node.condition !== 'string' || !node.condition) throw new TypeError(`condition is required for ${node.id}`);
    if (!Array.isArray(node.agentContractIds)) throw new TypeError(`agentContractIds must be an array for ${node.id}`);
  }
  return true;
}
