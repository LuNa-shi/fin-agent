export function topologicalNodeOrder(spec) {
  const byId = new Map();
  for (const node of spec.nodes || []) {
    if (!node?.id) throw new Error('workflow node id is required');
    if (byId.has(node.id)) throw new Error(`duplicate workflow node: ${node.id}`);
    byId.set(node.id, node);
  }

  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const outgoing = new Map([...byId.keys()].map((id) => [id, []]));
  for (const node of byId.values()) {
    for (const dependency of node.dependsOn || []) {
      if (!byId.has(dependency)) throw new Error(`unknown dependency ${dependency} for ${node.id}`);
      indegree.set(node.id, indegree.get(node.id) + 1);
      outgoing.get(dependency).push(node.id);
    }
  }

  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (ordered.length !== byId.size) throw new Error('workflow contains a cycle');
  return ordered;
}

export function validateWorkflowParallelGroups(spec) {
  const nodeIds = new Set((spec.nodes || []).map((node) => node.id));
  const boundAgentIds = (spec.nodes || []).flatMap((node) => node.agentContractIds || []);
  const groupIds = new Set();
  for (const group of spec.parallelGroups || []) {
    if (!group?.id || groupIds.has(group.id)) {
      throw new Error(group?.id ? `duplicate parallel group: ${group.id}` : 'parallel group id is required');
    }
    groupIds.add(group.id);
    for (const nodeId of group.nodeIds || []) {
      if (!nodeIds.has(nodeId)) throw new Error(`unknown parallel-group node: ${nodeId}`);
    }
    if (group.nodeId && !nodeIds.has(group.nodeId)) throw new Error(`unknown parallel-group owner node: ${group.nodeId}`);
    for (const contractId of group.agentContractIds || []) {
      if (!boundAgentIds.includes(contractId)) throw new Error(`unknown parallel-group Agent contract: ${contractId}`);
    }
  }
  for (const node of spec.nodes || []) {
    if (node.parallelGroup && !groupIds.has(node.parallelGroup)) {
      throw new Error(`unknown parallel group ${node.parallelGroup} for ${node.id}`);
    }
  }
  return true;
}
