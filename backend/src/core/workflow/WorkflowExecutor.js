import { canonicalSha256, createArtifactRef, deepFreeze } from '../contracts/ArtifactRef.js';
import { classifyWorkflowFailure, shouldRetryWorkflowFailure } from './FailurePolicy.js';
import { NODE_STATES } from './NodeState.js';
import { topologicalNodeOrder } from './WorkflowGraph.js';
import {
  assertWorkflowRunSpecIdentity,
  createWorkflowNodeExecutionContext,
  runWithWorkflowNodeContext,
} from './WorkflowRunContext.js';

function snapshotOutput(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
}

export function assertWorkflowHandlerBindings(spec, handlers) {
  if (!spec?.nodes?.length) throw new TypeError('WorkflowSpec nodes are required');
  if (!handlers || typeof handlers !== 'object') throw new TypeError('workflow handler bindings are required');
  const expected = spec.nodes.map((node) => node.handlerId);
  const expectedSet = new Set(expected);
  for (const handlerId of expected) {
    if (typeof handlers[handlerId] !== 'function') throw new Error(`missing workflow handler binding: ${handlerId}`);
  }
  for (const handlerId of Object.keys(handlers)) {
    if (!expectedSet.has(handlerId)) throw new Error(`unknown workflow handler binding: ${handlerId}`);
  }
  return true;
}

export function assertWorkflowConditionBindings(spec, conditions) {
  if (!spec?.nodes?.length) throw new TypeError('WorkflowSpec nodes are required');
  if (!conditions || typeof conditions !== 'object') throw new TypeError('workflow condition bindings are required');
  const expected = [...new Set(spec.nodes.map((node) => node.conditionId))];
  const expectedSet = new Set(expected);
  for (const conditionId of expected) {
    if (!conditionId || typeof conditions[conditionId] !== 'function') {
      throw new Error(`missing workflow condition binding: ${conditionId || '<undefined>'}`);
    }
  }
  for (const conditionId of Object.keys(conditions)) {
    if (!expectedSet.has(conditionId)) throw new Error(`unknown workflow condition binding: ${conditionId}`);
  }
  return true;
}

export function assertWorkflowHydrationBindings(spec, hydrators) {
  if (!spec?.nodes?.length) throw new TypeError('WorkflowSpec nodes are required');
  if (!hydrators || typeof hydrators !== 'object') throw new TypeError('workflow hydration bindings are required');
  const expected = spec.nodes.map((node) => node.handlerId);
  const expectedSet = new Set(expected);
  for (const handlerId of expected) {
    if (typeof hydrators[handlerId] !== 'function') throw new Error(`missing workflow hydration binding: ${handlerId}`);
  }
  for (const handlerId of Object.keys(hydrators)) {
    if (!expectedSet.has(handlerId)) throw new Error(`unknown workflow hydration binding: ${handlerId}`);
  }
  return true;
}

function completionArtifacts(completion) {
  return (Array.isArray(completion) ? completion : (completion?.artifacts || []))
    .map((ref) => createArtifactRef(ref));
}

function completionOutput(completion, result) {
  return !Array.isArray(completion) && Object.prototype.hasOwnProperty.call(completion || {}, 'output')
    ? completion.output
    : result;
}

function executionEntry({ output, artifactRefs, node, record = null }) {
  const entry = {
    status: 'succeeded',
    output: snapshotOutput(output),
    artifactRefs,
  };
  if (record) {
    entry.attempt = record.attempt;
    entry.inputDigest = record.inputDigest;
    entry.stopReason = record.stopReason;
  }
  if (artifactRefs.length === 0 && node.artifactPolicy === 'pure-return') entry.artifactPolicy = 'pure-return';
  return deepFreeze(entry);
}

export async function executeWorkflowSpec({
  spec,
  handlers,
  hydrators = null,
  conditions,
  context = {},
  onNodeComplete = null,
  onNodeHydrate = null,
  onNodeRetry = null,
  runStore = null,
  runId = null,
  nodeInputDigest = null,
  retryPolicyForNode = null,
  workspaceSnapshotForNode = null,
  priorReviewIssuesForNode = null,
  agentRuntime = null,
  agentBackend = null,
  signal = null,
  failureClassifier = classifyWorkflowFailure,
  stopAfterNodeId = null,
} = {}) {
  assertWorkflowHandlerBindings(spec, handlers);
  assertWorkflowConditionBindings(spec, conditions);
  assertWorkflowHydrationBindings(spec, hydrators);
  if (!runStore || typeof runStore.load !== 'function') {
    throw new TypeError('durable RunStore is required');
  }
  if (onNodeComplete !== null && typeof onNodeComplete !== 'function') {
    throw new TypeError('onNodeComplete must be a function');
  }
  if (onNodeHydrate !== null && typeof onNodeHydrate !== 'function') throw new TypeError('onNodeHydrate must be a function');
  if (onNodeRetry !== null && typeof onNodeRetry !== 'function') throw new TypeError('onNodeRetry must be a function');
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required with RunStore');
  const initialRun = runStore.load(runId);
  if (!initialRun) throw new Error(`RunStore is missing workflow run: ${runId}`);
  assertWorkflowRunSpecIdentity(spec, initialRun);
  if (nodeInputDigest !== null && typeof nodeInputDigest !== 'function') throw new TypeError('nodeInputDigest must be a function');
  if (retryPolicyForNode !== null && typeof retryPolicyForNode !== 'function') throw new TypeError('retryPolicyForNode must be a function');
  if (workspaceSnapshotForNode !== null && typeof workspaceSnapshotForNode !== 'function') {
    throw new TypeError('workspaceSnapshotForNode must be a function');
  }
  if (priorReviewIssuesForNode !== null && typeof priorReviewIssuesForNode !== 'function') {
    throw new TypeError('priorReviewIssuesForNode must be a function');
  }
  if (typeof failureClassifier !== 'function') throw new TypeError('failureClassifier must be a function');
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  if (stopAfterNodeId !== null && !byId.has(stopAfterNodeId)) {
    throw new Error(`unknown workflow stop node: ${stopAfterNodeId}`);
  }
  const groups = new Map((spec.parallelGroups || [])
    .filter((group) => group.scope === 'nodes')
    .map((group) => [group.id, group]));
  const ordered = topologicalNodeOrder(spec);
  const completed = new Set();
  const nodeResults = {};
  const nodeExecutions = {};
  context.nodeResults = nodeResults;
  context.nodeExecutions = nodeExecutions;

  const assertDependencies = (node, groupIds = new Set()) => {
    for (const dependency of node.dependsOn || []) {
      if (!completed.has(dependency) && !groupIds.has(dependency)) {
        throw new Error(`workflow dependency ${dependency} for ${node.id} has not completed`);
      }
    }
  };
  const invoke = async (node) => {
    const conditionAllowsRun = conditions[node.conditionId](context, node);
    if (typeof conditionAllowsRun !== 'boolean') {
      throw new TypeError(`workflow condition ${node.conditionId} must return a boolean`);
    }
    let run = runStore.load(runId);
    let record = run?.nodes?.[node.id];
    if (!record) throw new Error(`RunStore is missing node state: ${node.id}`);

    if (record.status === NODE_STATES.SUCCEEDED) {
      await onNodeHydrate?.({ context, node, record, result: undefined });
      const output = await hydrators[node.handlerId](context, node, { record, conditionId: node.conditionId });
      const artifactRefs = record.artifactRefs.map((ref) => createArtifactRef(ref));
      nodeExecutions[node.id] = executionEntry({ output, artifactRefs, node, record });
      return output;
    }
    if (!conditionAllowsRun) {
      const output = await hydrators[node.handlerId](context, node, { record, conditionId: node.conditionId });
      const checkpointRefs = context.cp?.nodeExecutions?.[node.id]?.artifactRefs || [];
      run = runStore.reconcileSucceededNode(runId, node.id, {
        artifactRefs: checkpointRefs,
        output,
        pureReturn: node.artifactPolicy === 'pure-return',
      });
      record = run.nodes[node.id];
      await onNodeHydrate?.({ context, node, record, result: output });
      const artifactRefs = record.artifactRefs.map((ref) => createArtifactRef(ref));
      nodeExecutions[node.id] = executionEntry({ output, artifactRefs, node, record });
      return output;
    }

    const retryPolicy = retryPolicyForNode?.(node, context) || { maxAttempts: 1, retryOn: [] };
    while (true) {
      run = runStore.load(runId);
      record = run.nodes[node.id];
      const dependencyRefs = (node.dependsOn || []).flatMap((dependencyId) => nodeExecutions[dependencyId]?.artifactRefs || []);
      const suppliedWorkspaceSnapshotId = workspaceSnapshotForNode
        ? await workspaceSnapshotForNode({
            context,
            node,
            dependencyArtifactRefs: dependencyRefs,
            run,
          })
        : null;
      if (
        suppliedWorkspaceSnapshotId !== null
        && suppliedWorkspaceSnapshotId !== undefined
        && (typeof suppliedWorkspaceSnapshotId !== 'string' || !suppliedWorkspaceSnapshotId)
      ) {
        throw new TypeError(`workspace snapshot id is required for ${node.id}`);
      }
      if (
        run.workspaceSnapshotId
        && suppliedWorkspaceSnapshotId
        && run.workspaceSnapshotId !== suppliedWorkspaceSnapshotId
      ) {
        const error = new Error(
          `workflow snapshot identity conflict for ${node.id}: expected ${run.workspaceSnapshotId}, got ${suppliedWorkspaceSnapshotId}`,
        );
        error.code = 'WORKFLOW_SNAPSHOT_IDENTITY_CONFLICT';
        throw error;
      }
      const workspaceMode = run.workspaceMode || 'project';
      const workspaceSnapshotId = run.workspaceSnapshotId
        || suppliedWorkspaceSnapshotId
        || (workspaceMode === 'project' ? `${run.projectId}:run:${runId}` : null);
      if (typeof workspaceSnapshotId !== 'string' || !workspaceSnapshotId) {
        throw new TypeError(`workspace snapshot id is required for ${node.id}`);
      }
      const calculatedDigest = record.inputDigest || await nodeInputDigest?.({
        context,
        node,
        dependencyArtifactRefs: dependencyRefs,
        run,
      }) || canonicalSha256({
        workflowSpec: { id: spec.id, version: spec.version },
        runId,
        nodeId: node.id,
        dependencyArtifactRefs: dependencyRefs,
      });
      if (record.status === NODE_STATES.PENDING) {
        run = runStore.markReady(runId, node.id);
        record = run.nodes[node.id];
      }
      run = runStore.startNode(runId, node.id, calculatedDigest);
      record = run.nodes[node.id];
      try {
        const priorReviewIssues = priorReviewIssuesForNode
          ? await priorReviewIssuesForNode({
            context,
            node,
            dependencyArtifactRefs: dependencyRefs,
            run,
            record,
          })
          : [];
        const nodeExecutionContext = createWorkflowNodeExecutionContext({
          spec,
          run,
          node,
          record,
          artifactRefs: dependencyRefs,
          priorReviewIssues,
          workspaceSnapshotId,
          agentRuntime,
          agentBackend,
          signal,
        });
        const result = await runWithWorkflowNodeContext(nodeExecutionContext, () => handlers[node.handlerId](context, node, {
          shouldRun: true,
          conditionId: node.conditionId,
          attempt: record.attempt,
        }));
        const completion = onNodeComplete
          ? await onNodeComplete({
              context,
              node,
              shouldRun: true,
              result,
              dependencyArtifactRefs: dependencyRefs,
            })
          : [];
        const artifactRefs = completionArtifacts(completion);
        const output = completionOutput(completion, result);
        run = runStore.succeedNode(runId, node.id, {
          artifactRefs,
          output,
          pureReturn: node.artifactPolicy === 'pure-return',
        });
        record = run.nodes[node.id];
        nodeExecutions[node.id] = executionEntry({ output, artifactRefs, node, record });
        return output;
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        const classification = failureClassifier(cause);
        run = runStore.failNode(runId, node.id, classification, cause);
        record = run.nodes[node.id];
        if (shouldRetryWorkflowFailure(classification, retryPolicy, record.attempt)) {
          await onNodeRetry?.({ context, node, attempt: record.attempt, classification, error: cause });
          runStore.retryNode(runId, node.id);
          continue;
        }
        cause.workflowNodeId = node.id;
        cause.workflowFailure = classification;
        throw cause;
      }
    }
  };
  const executionResult = (stoppedAt = null) => {
    const finalNodeId = stoppedAt || ordered.at(-1);
    return {
      nodeResults,
      nodeExecutions,
      result: nodeResults[finalNodeId],
      ...(stoppedAt ? { stoppedAt } : {}),
    };
  };

  for (const nodeId of ordered) {
    if (completed.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node.parallelGroup) {
      assertDependencies(node);
      nodeResults[node.id] = await invoke(node);
      completed.add(node.id);
      if (node.id === stopAfterNodeId) return executionResult(node.id);
      continue;
    }

    const group = groups.get(node.parallelGroup);
    if (!group) throw new Error(`unknown workflow parallel group: ${node.parallelGroup}`);
    const members = group.nodeIds.map((memberId) => {
      const member = byId.get(memberId);
      if (!member) throw new Error(`unknown workflow parallel-group node: ${memberId}`);
      if (member.parallelGroup !== group.id) throw new Error(`parallel-group mismatch for ${memberId}`);
      return member;
    });
    const memberIds = new Set(group.nodeIds);
    for (const member of members) {
      for (const dependency of member.dependsOn || []) {
        if (memberIds.has(dependency) && !completed.has(dependency)) {
          throw new Error(`parallel group ${group.id} has unmet dependency ${dependency} for ${member.id}`);
        }
      }
      assertDependencies(member, memberIds);
    }
    const settled = await Promise.allSettled(members.map(invoke));
    const rejected = settled.find((item) => item.status === 'rejected');
    if (rejected) throw rejected.reason;
    const results = settled.map((item) => item.value);
    members.forEach((member, index) => {
      nodeResults[member.id] = results[index];
      completed.add(member.id);
    });
    if (members.some((member) => member.id === stopAfterNodeId)) return executionResult(stopAfterNodeId);
  }

  return executionResult();
}

export function remediationPlanForDecision(spec, decision) {
  if (!spec || typeof spec !== 'object') throw new TypeError('WorkflowSpec is required');
  if (!decision || typeof decision !== 'object') throw new TypeError('review decision is required');
  const routes = new Map((spec.remediationRoutes || []).map((route) => [route.owner, route]));
  const blockingIssues = (decision.openIssues || [])
    .filter((issue) => issue?.blocking !== false);
  const routeOwners = blockingIssues
    .map((issue) => issue?.owner)
    .filter((owner) => owner && owner !== 'system');
  if (!routeOwners.length && !['publish', 'human-review'].includes(decision.route)) routeOwners.push(decision.route);
  const owners = [...new Set(routeOwners)];
  for (const owner of owners) {
    if (!routes.has(owner)) throw new Error(`unknown remediation owner: ${owner}`);
  }
  const selected = new Set(owners.flatMap((owner) => routes.get(owner).nodeIds || []));
  const nodeIds = topologicalNodeOrder(spec).filter((nodeId) => selected.has(nodeId));
  const systemIssues = blockingIssues.filter((issue) => issue?.owner === 'system');
  const humanReview = decision.route === 'human-review'
    || systemIssues.some((issue) => issue?.severity === 'critical')
    || (systemIssues.length > 0 && owners.length === 0);
  return deepFreeze({ owners, nodeIds, humanReview });
}

export async function executeWorkflowWithRemediation({
  reviewNodeId,
  getReviewDecision,
  onRemediation = null,
  onHumanReview = null,
  ...executionOptions
} = {}) {
  const { spec, runStore, runId, context = {} } = executionOptions;
  if (typeof reviewNodeId !== 'string' || !reviewNodeId) throw new TypeError('reviewNodeId is required');
  if (typeof getReviewDecision !== 'function') throw new TypeError('getReviewDecision must be a function');
  if (!runStore || typeof runStore.invalidateNodes !== 'function' || typeof runStore.blockRun !== 'function') {
    throw new TypeError('durable RunStore remediation support is required');
  }
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required');
  if (onRemediation !== null && typeof onRemediation !== 'function') throw new TypeError('onRemediation must be a function');
  if (onHumanReview !== null && typeof onHumanReview !== 'function') throw new TypeError('onHumanReview must be a function');
  const maxCycles = Number.isInteger(spec?.maxRemediationCycles) ? spec.maxRemediationCycles : 0;

  while (true) {
    const prefix = await executeWorkflowSpec({ ...executionOptions, context, stopAfterNodeId: reviewNodeId });
    const decision = await getReviewDecision({ context, execution: prefix });
    if (!decision || decision.converged === true || decision.route === 'publish') {
      const completed = await executeWorkflowSpec({ ...executionOptions, context });
      return {
        ...completed,
        blocked: false,
        reviewDecision: decision || null,
        remediationCycles: decision?.cycle || 0,
      };
    }

    const plan = remediationPlanForDecision(spec, decision);
    if (plan.humanReview || decision.cycle >= maxCycles || plan.nodeIds.length === 0) {
      if (onHumanReview) {
        runStore.blockRun(runId, { reason: 'human-review', openIssues: decision.openIssues || [] });
        const result = await onHumanReview({ context, decision, execution: prefix, plan });
        return {
          ...prefix,
          result: result ?? decision,
          blocked: true,
          reviewDecision: decision,
          remediationCycles: decision.cycle,
        };
      }
      const completed = await executeWorkflowSpec({ ...executionOptions, context });
      return {
        ...completed,
        blocked: false,
        reviewDecision: decision,
        remediationCycles: decision.cycle,
        humanReviewBypassed: true,
      };
    }

    const cycle = decision.cycle + 1;
    runStore.invalidateNodes(runId, plan.nodeIds, {
      reason: 'review-remediation',
      cycle,
      owners: plan.owners,
      openIssues: decision.openIssues || [],
    });
    await onRemediation?.({ context, decision, execution: prefix, plan, cycle });
  }
}

export function stampWorkflowSpecIdentity(checkpoint, spec, hash) {
  if (!checkpoint || typeof checkpoint !== 'object') throw new TypeError('checkpoint is required');
  const identity = { id: spec.id, version: spec.version, hash };
  if (checkpoint.workflowSpec) {
    const current = checkpoint.workflowSpec;
    if (current.id !== identity.id || current.version !== identity.version || current.hash !== identity.hash) {
      throw new Error(`checkpoint workflow spec conflict: expected ${identity.id}@${identity.version} ${identity.hash}, got ${current.id}@${current.version} ${current.hash}`);
    }
  }
  return { ...checkpoint, workflowSpec: identity };
}
