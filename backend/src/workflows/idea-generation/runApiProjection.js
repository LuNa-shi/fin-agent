import { canonicalSha256 } from '../../core/contracts/ArtifactRef.js';
import {
  FAILURE_NODE_STATES,
  NODE_STATES,
} from '../../core/workflow/NodeState.js';
import { RUN_STATUSES } from '../../project-space/RunStore.js';
import {
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  projectRunTrace,
} from '../../project-space/runApiProjection.js';
import {
  agentExecutionTimeline,
  listAgentExecutionSummaries,
} from '../../project-space/agentRunTraceProjection.js';
import { ideaGenerationRunStorage } from './runtime/IdeaGenerationRunStorage.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  ideaGenerationWorkflowSpecHash,
  topologicalIdeaGenerationNodeOrder,
} from './workflowSpec.js';
import { publicIdeaGenerationNodeOutput } from './publicProjection.js';

export const IDEA_GENERATION_TRACE_SCHEMA_VERSION = 'idea-generation-trace.v3';
export const IDEA_GENERATION_PROGRESS_SCHEMA_VERSION = 'idea-generation-progress.v3';

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TERMINAL_NODE_FAILURES = new Set([
  ...FAILURE_NODE_STATES,
  NODE_STATES.BLOCKED,
  NODE_STATES.CANCELLED,
]);
const LEGACY_STAGES = Object.freeze([
  {
    stage: 'context',
    label: '收集决策上下文',
    nodeIds: Object.freeze(['collect-market-context']),
  },
  {
    stage: 'memory',
    label: '注入去重约束',
    nodeIds: Object.freeze(['build-diversification-constraints']),
  },
  {
    stage: 'source',
    label: '多来源发现',
    nodeIds: Object.freeze(['collect-market-context']),
  },
  {
    stage: 'reason',
    label: '过量发散生成',
    nodeIds: Object.freeze(['generate-candidates']),
  },
  {
    stage: 'screen',
    label: '标的校验与质量评分',
    nodeIds: Object.freeze(['verify-candidates', 'review-quality']),
  },
  {
    stage: 'output',
    label: '产出并入库',
    nodeIds: Object.freeze(['persist-ideas']),
  },
]);

function apiError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertWorkflowFilter(workflowId) {
  if (
    workflowId !== undefined
    && workflowId !== null
    && workflowId !== ''
    && workflowId !== IDEA_GENERATION_WORKFLOW_SPEC.id
  ) {
    throw apiError(
      `Idea Generation workflow not found: ${workflowId}`,
      'IDEA_WORKFLOW_NOT_FOUND',
      404,
    );
  }
}

function assertRunId(runId) {
  if (
    typeof runId !== 'string'
    || !SAFE_RUN_ID.test(runId)
    || runId === '.'
    || runId === '..'
  ) {
    throw apiError('Idea Generation run id is unsafe', 'UNSAFE_IDEA_RUN_ID', 400);
  }
  return runId;
}

function assertNodeId(nodeId) {
  if (nodeId === undefined || nodeId === null || nodeId === '') return null;
  if (!IDEA_GENERATION_WORKFLOW_SPEC.nodes.some((node) => node.id === nodeId)) {
    throw apiError(
      `Idea Generation node not found: ${nodeId}`,
      'IDEA_NODE_NOT_FOUND',
      404,
    );
  }
  return nodeId;
}

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('Idea Generation run filters must be an object');
  }
  assertWorkflowFilter(filters.workflowId);
  return {
    runId: filters.runId === undefined || filters.runId === null || filters.runId === ''
      ? null
      : assertRunId(filters.runId),
    nodeId: assertNodeId(filters.nodeId),
  };
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return 40;
  return Math.min(limit, 100);
}

function timestampMillis(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function sortedRecords(storage) {
  if (!storage || typeof storage.list !== 'function' || typeof storage.services !== 'function') {
    throw new TypeError('Idea Generation run storage must expose list() and services()');
  }
  return [...storage.list()].sort((left, right) => (
    (timestampMillis(right.createdAt) || 0) - (timestampMillis(left.createdAt) || 0)
    || String(left.runId).localeCompare(String(right.runId))
  ));
}

function assertCanonicalRunRecord(record) {
  const identity = record?.workflowSpec;
  if (
    identity?.id !== IDEA_GENERATION_WORKFLOW_SPEC.id
    || identity?.version !== IDEA_GENERATION_WORKFLOW_SPEC.version
    || identity?.hash !== IDEA_GENERATION_WORKFLOW_SPEC_HASH
  ) {
    throw apiError(
      `Idea Generation run has conflicting WorkflowSpec identity: ${record?.runId || '(unknown)'}`,
      'IDEA_WORKFLOW_IDENTITY_CONFLICT',
      500,
    );
  }
  return record;
}

function selectRecords(records, { runId }) {
  if (runId === null) return records;
  const selected = records.find((record) => record.runId === runId);
  if (!selected) {
    throw apiError(
      `Idea Generation run not found: ${runId}`,
      'IDEA_RUN_NOT_FOUND',
      404,
    );
  }
  return [selected];
}

function readNodeOutput({
  services,
  record,
  nodeId,
}) {
  const node = record.nodes?.[nodeId];
  if (!node || node.status !== NODE_STATES.SUCCEEDED) return null;
  if (!Array.isArray(node.artifactRefs) || node.artifactRefs.length !== 1) {
    throw apiError(
      `Idea Generation node has invalid durable artifacts: ${nodeId}`,
      'IDEA_NODE_ARTIFACT_INVALID',
      500,
    );
  }
  const [ref] = node.artifactRefs;
  if (
    ref.artifactId !== `${record.runId}:${nodeId}`
    || ref.path !== `outputs/${nodeId}.json`
    || ref.inputDigest !== node.inputDigest
  ) {
    throw apiError(
      `Idea Generation node artifact identity conflicts with durable state: ${nodeId}`,
      'IDEA_NODE_ARTIFACT_IDENTITY_MISMATCH',
      500,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(services.artifactStore.read(ref));
  } catch (error) {
    if (error?.code) throw error;
    throw apiError(
      `Idea Generation node artifact is unreadable: ${nodeId}`,
      'IDEA_NODE_ARTIFACT_INVALID',
      500,
    );
  }
  const expected = {
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    runId: record.runId,
    nodeId,
    snapshotId: record.workspaceSnapshotId || services.snapshot?.snapshotId,
    asOf: record.asOf,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (envelope?.[field] !== value) {
      throw apiError(
        `Idea Generation node artifact ${field} conflicts with durable state: ${nodeId}`,
        'IDEA_NODE_ARTIFACT_IDENTITY_MISMATCH',
        500,
      );
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(envelope, 'output')
    || canonicalSha256(envelope.output) !== node.outputDigest
  ) {
    throw apiError(
      `Idea Generation node output digest conflicts with durable state: ${nodeId}`,
      'IDEA_NODE_OUTPUT_DIGEST_MISMATCH',
      500,
    );
  }
  return publicIdeaGenerationNodeOutput(nodeId, envelope.output);
}

function outputsForRun({ services, record, nodeId }) {
  const nodeIds = nodeId === null
    ? IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.id)
    : [nodeId];
  return Object.fromEntries(nodeIds.map((id) => [
    id,
    readNodeOutput({ services, record, nodeId: id }),
  ]));
}

function stageStatus(record, nodeIds) {
  const statuses = nodeIds.map((nodeId) => (
    record.nodes?.[nodeId]?.status || NODE_STATES.PENDING
  ));
  if (statuses.every((status) => status === NODE_STATES.SUCCEEDED)) return 'done';
  if (statuses.some((status) => status === NODE_STATES.RUNNING)) return 'running';
  if (statuses.some((status) => TERMINAL_NODE_FAILURES.has(status))) return 'failed';
  return 'pending';
}

function stageText(stage, outputs) {
  const collected = outputs['collect-market-context'];
  const constraints = outputs['build-diversification-constraints'];
  const generated = outputs['generate-candidates'];
  const verified = outputs['verify-candidates'];
  const reviewed = outputs['review-quality'];
  const persisted = outputs['persist-ideas'];
  switch (stage) {
    case 'context':
      return collected
        ? '市场与决策上下文已写入本次 durable run。'
        : '等待收集市场与决策上下文。';
    case 'memory':
      return constraints
        ? `已记录去重与主题约束${constraints.heavyThemes?.length ? `，关注 ${constraints.heavyThemes.length} 个集中主题` : ''}。`
        : '等待建立去重与主题约束。';
    case 'source':
      return collected
        ? `已记录 ${collected.sourceCandidateCount || 0} 条生成素材；素材不会直接作为 Idea 发布。`
        : '等待收集多来源生成素材。';
    case 'reason':
      return generated
        ? `生成 Agent 返回 ${generated.rawCandidates?.length || 0} 条候选。`
        : '等待生成候选 Idea。';
    case 'screen':
      if (!verified && reviewed) {
        return `已记录 ${reviewed.annotations?.length || 0} 条质量评分与排序注释；质量审阅不控制发布。`;
      }
      if (!verified) return '等待规范化、标的校验与质量评分。';
      if (!reviewed) {
        return `已规范化 ${verified.validIdeas?.length || 0} 条有效 Idea；质量评分由 review-quality 节点单独记录。`;
      }
      return `已规范化 ${verified.validIdeas?.length || 0} 条有效 Idea；质量审阅仅评分和排序，不过滤发布。`;
    case 'output':
      return persisted
        ? `已持久化并索引 ${persisted.committed?.length || 0} 条有效 Idea。`
        : '等待持久化有效 Idea。';
    default:
      return reviewed ? '质量评分已记录。' : '';
  }
}

function stageData(stage, outputs) {
  const collected = outputs['collect-market-context'];
  const constraints = outputs['build-diversification-constraints'];
  const generated = outputs['generate-candidates'];
  const verified = outputs['verify-candidates'];
  const reviewed = outputs['review-quality'];
  const persisted = outputs['persist-ideas'];
  if (stage === 'context') {
    return {
      domainsUsed: collected?.market?.domainsUsed || [],
      sourceAgents: (collected?.sourceRuns || []).map((run) => run.sourceId).filter(Boolean),
    };
  }
  if (stage === 'memory') {
    return {
      heavyThemes: constraints?.heavyThemes || [],
    };
  }
  if (stage === 'source') {
    return {
      sourceMaterialCount: collected?.sourceCandidateCount || 0,
    };
  }
  if (stage === 'reason') {
    return {
      provider: generated?.agent?.provider || null,
      count: generated?.rawCandidates?.length || 0,
    };
  }
  if (stage === 'screen') {
    return {
      ...(verified
        ? {
            validTickers: verified.tickerVerification?.valid || [],
            droppedTickers: verified.tickerVerification?.invalid || [],
            validIdeas: verified.validIdeas?.length || 0,
            rejected: verified.rejected?.length || 0,
          }
        : {}),
      ...(reviewed
        ? { annotations: reviewed.annotations?.length || 0 }
        : {}),
    };
  }
  if (stage === 'output') {
    return {
      ideas: persisted?.committed || [],
    };
  }
  return {};
}

function legacySteps(record, outputs, nodeId) {
  return LEGACY_STAGES
    .filter((stage) => nodeId === null || stage.nodeIds.includes(nodeId))
    .map((stage) => {
      const nodeIds = nodeId === null ? stage.nodeIds : [nodeId];
      return {
        stage: stage.stage,
        label: stage.label,
        status: stageStatus(record, nodeIds),
        text: stageText(stage.stage, outputs),
        data: stageData(stage.stage, outputs),
        nodeIds: [...nodeIds],
      };
    });
}

function filteredDurableTrace(trace, nodeId) {
  if (nodeId === null) return trace;
  const nodes = trace.nodes.filter((node) => node.nodeId === nodeId);
  const lifecycle = trace.lifecycle.filter((event) => (
    event.nodeId === null || event.nodeId === nodeId
  ));
  const artifacts = nodes.flatMap((node) => node.artifactRefs);
  return {
    ...trace,
    agentIds: [...new Set(nodes.flatMap((node) => node.agentIds))],
    nodes,
    lifecycle,
    artifacts,
    nodeCounts: Object.fromEntries(nodes.map((node) => [node.status, 1])),
    attempts: nodes.reduce((total, node) => total + node.attempt, 0),
  };
}

function projectRecord(record, {
  storage,
  nodeId,
}) {
  assertCanonicalRunRecord(record);
  const services = storage.services(record.runId);
  const durableEvents = services.eventBus.list({ runId: record.runId });
  const replayRun = services.eventBus.replay({ runId: record.runId }).runs?.[record.runId] || null;
  const durable = filteredDurableTrace(projectRunTrace({
    projectId: record.scope?.id || services.scope?.id || record.projectId,
    runId: record.runId,
    record,
    replayRun,
    durableEvents,
    workflowSpec: IDEA_GENERATION_WORKFLOW_SPEC,
    activeRunId: record.status === RUN_STATUSES.RUNNING ? record.runId : null,
  }), nodeId);
  const agentExecutions = listAgentExecutionSummaries({
    events: durableEvents,
    workflowRunId: record.runId,
    nodeId,
  });
  const outputs = outputsForRun({ services, record, nodeId });
  const collected = outputs['collect-market-context'];
  const constraints = outputs['build-diversification-constraints'];
  const generated = outputs['generate-candidates'];
  const verified = outputs['verify-candidates'];
  const reviewed = outputs['review-quality'];
  const persisted = outputs['persist-ideas'];
  const ideas = persisted?.committed || reviewed?.ideas || verified?.validIdeas || [];
  const startedAt = timestampMillis(record.createdAt);
  const endedAt = timestampMillis(record.completedAt || record.updatedAt);
  const durationMs = startedAt === null || endedAt === null
    ? 0
    : Math.max(0, endedAt - startedAt);
  const snapshot = services.snapshot;
  const trace = {
    schemaVersion: IDEA_GENERATION_TRACE_SCHEMA_VERSION,
    id: record.runId,
    traceId: record.runId,
    ts: startedAt || 0,
    runId: record.runId,
    workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
    snapshotId: record.workspaceSnapshotId || snapshot?.snapshotId || null,
    asOf: record.asOf,
    count: snapshot?.inputs?.command?.count ?? ideas.length,
    poolSize: generated?.rawCandidates?.length || 0,
    sourceAgents: (collected?.sourceRuns || []).map((run) => run.sourceId).filter(Boolean),
    provider: generated?.agent?.provider || reviewed?.agent?.provider || null,
    live: generated?.agent?.live === true || reviewed?.agent?.live === true,
    durationMs,
    context: {
      heldThemes: constraints?.heldThemes || [],
      heavyThemes: constraints?.heavyThemes || [],
      domainsUsed: collected?.market?.domainsUsed || [],
      // Preserve the historical array/count UI contract without returning the
      // source tool's raw Idea payload.
      saIdeas: Array.from(
        { length: collected?.market?.saIdeaCount || 0 },
        (_value, index) => ({ index: index + 1 }),
      ),
      sourceMaterialCount: collected?.sourceCandidateCount || 0,
    },
    steps: legacySteps(record, outputs, nodeId),
    ideas,
    status: record.status,
    running: record.status === RUN_STATUSES.RUNNING,
    stopReason: record.stopReason,
    workflowSpec: durable.workflowSpec,
    scope: record.scope || services.scope || null,
    workspaceMode: record.workspaceMode || 'idea-run',
    inputDigest: record.inputDigest,
    configDigest: snapshot?.configDigest || null,
    nodes: durable.nodes,
    lifecycle: durable.lifecycle,
    artifacts: durable.artifacts,
    // Summaries only; detailed activity is available through the agent-scoped
    // paginated timeline endpoint so polling stays bounded.
    agentRuns: agentExecutions,
    nodeId,
  };
  if (nodeId !== null) trace.nodeOutput = outputs[nodeId];
  return trace;
}

export function ideaGenerationWorkflowProjection(
  spec = IDEA_GENERATION_WORKFLOW_SPEC,
) {
  const nodes = spec.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    handlerId: node.handlerId,
    dependsOn: [...node.dependsOn],
    conditionId: node.conditionId,
    condition: node.condition,
    agentIds: [...node.agentContractIds],
    artifactPolicy: node.artifactPolicy,
    outputDescription: node.outputDescription,
  }));
  return {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    workflow: {
      id: spec.id,
      version: spec.version,
      schemaVersion: spec.schemaVersion,
      hash: ideaGenerationWorkflowSpecHash(spec),
      description: spec.description,
      scope: structuredClone(spec.scope),
    },
    topologicalOrder: topologicalIdeaGenerationNodeOrder(spec),
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({
      from,
      to: node.id,
    }))),
    parallelGroups: structuredClone(spec.parallelGroups),
    spec: structuredClone(spec),
  };
}

export function ideaGenerationTraces(
  limit = 40,
  filters = {},
  { storage = ideaGenerationRunStorage } = {},
) {
  const normalized = normalizeFilters(filters);
  const records = selectRecords(
    sortedRecords(storage).map(assertCanonicalRunRecord),
    normalized,
  );
  return records
    .slice(0, normalizeLimit(limit))
    .map((record) => projectRecord(record, {
      storage,
      nodeId: normalized.nodeId,
    }));
}

export function ideaGenerationTrace(
  runId,
  filters = {},
  { storage = ideaGenerationRunStorage } = {},
) {
  const safeRunId = assertRunId(runId);
  const normalized = normalizeFilters(filters);
  if (normalized.runId !== null && normalized.runId !== safeRunId) {
    throw apiError(
      'Idea Generation path/query run ids conflict',
      'IDEA_RUN_FILTER_CONFLICT',
      400,
    );
  }
  return ideaGenerationTraces(1, {
    ...filters,
    runId: safeRunId,
  }, { storage })[0];
}

export function ideaGenerationAgentTimeline(
  runId,
  agentRunId,
  {
    afterSequence,
    limit,
    storage = ideaGenerationRunStorage,
  } = {},
) {
  const safeRunId = assertRunId(runId);
  const records = selectRecords(
    sortedRecords(storage).map(assertCanonicalRunRecord),
    { runId: safeRunId },
  );
  const record = records[0];
  const services = storage.services(record.runId);
  return agentExecutionTimeline({
    events: services.eventBus.list({ runId: record.runId }),
    workflowRunId: record.runId,
    agentRunId,
    afterSequence,
    limit,
  });
}

export function ideaGenerationProgress(
  filters = {},
  { storage = ideaGenerationRunStorage } = {},
) {
  const normalized = normalizeFilters(filters);
  const records = selectRecords(
    sortedRecords(storage).map(assertCanonicalRunRecord),
    normalized,
  );
  if (records.length === 0) return null;
  const record = normalized.runId !== null
    ? records[0]
    : records.find((candidate) => candidate.status === RUN_STATUSES.RUNNING) || records[0];
  const trace = projectRecord(record, {
    storage,
    nodeId: normalized.nodeId,
  });
  const agentExecutionCounts = {};
  for (const execution of trace.agentRuns) {
    agentExecutionCounts[execution.status] = (agentExecutionCounts[execution.status] || 0) + 1;
  }
  return {
    schemaVersion: IDEA_GENERATION_PROGRESS_SCHEMA_VERSION,
    id: trace.runId,
    runId: trace.runId,
    workflowId: trace.workflowId,
    snapshotId: trace.snapshotId,
    asOf: trace.asOf,
    running: trace.running,
    status: trace.status,
    stopReason: trace.stopReason,
    startedAt: trace.ts,
    endedAt: trace.running ? null : trace.ts + trace.durationMs,
    count: trace.count,
    steps: trace.steps,
    traceId: trace.traceId,
    provider: trace.provider,
    live: trace.live,
    generated: trace.ideas,
    ideas: trace.ideas,
    workflowSpec: trace.workflowSpec,
    nodes: trace.nodes,
    agentExecutionCount: trace.agentRuns.length,
    agentExecutionCounts,
    nodeId: trace.nodeId,
    ...(trace.nodeId === null ? {} : { nodeOutput: trace.nodeOutput }),
  };
}
