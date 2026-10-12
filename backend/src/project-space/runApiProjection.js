import { createHash } from 'node:crypto';

import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  validateArtifactRef,
} from '../core/contracts/ArtifactRef.js';
import {
  ProjectSpace,
  isTimestampedReportPath,
} from './ProjectSpace.js';
import {
  agentExecutionTimeline,
  listAgentExecutionSummaries,
} from './agentRunTraceProjection.js';
import {
  DURABLE_EVENT_TYPES,
  isAgentExecutionEventType,
} from './EventBus.js';
import { RUN_STATUSES } from './RunStore.js';
import { validateScorecardEvaluation } from '../domains/research/scorecards/scorecardCore.js';
import { getScorecardSpec } from '../domains/research/scorecards/scorecardCatalog.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  topologicalNodeOrder,
  workflowSpecHash,
} from '../workflows/run-analysis/workflowSpec.js';

export const RUN_TRACE_SCHEMA_VERSION = 'run-trace.v2';
export const RUN_SUMMARY_SCHEMA_VERSION = 'run-summary.v2';
export const WORKFLOW_GRAPH_SCHEMA_VERSION = 'workflow-graph.v1';

const SAFE_API_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TERMINAL_EVENT_TYPES = new Set([
  DURABLE_EVENT_TYPES.RUN_SUCCEEDED,
  DURABLE_EVENT_TYPES.RUN_FAILED,
  DURABLE_EVENT_TYPES.RUN_BLOCKED,
  DURABLE_EVENT_TYPES.RUN_CANCELLED,
]);
const ARTIFACT_REF_FIELDS = [...ARTIFACT_REF_REQUIRED_FIELDS, ...ARTIFACT_REF_LOCATION_FIELDS];

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameArtifactRef(left, right) {
  if (!left || !right) return false;
  try {
    return canonicalSha256(left) === canonicalSha256(right);
  } catch {
    return false;
  }
}

function selectNodeRef(record, nodeId, predicate) {
  const node = record?.nodes?.[nodeId];
  if (node?.status !== 'SUCCEEDED') return null;
  return (node.artifactRefs || []).find((ref) => predicate(ref.path || '')) || null;
}

function selectNodeRefs(record, nodeId, predicate) {
  const node = record?.nodes?.[nodeId];
  if (node?.status !== 'SUCCEEDED') return [];
  return (node.artifactRefs || []).filter((ref) => predicate(ref.path || ''));
}

function verifiedCurrentRunContent(projectSpace, projectId, runId, nodeId, ref, lineage) {
  if (!ref) return null;
  const ownsRef = lineage.some((entry) => (
    entry.runId === runId
    && entry.nodeId === nodeId
    && sameArtifactRef(entry.ref, ref)
  ));
  if (!ownsRef) return null;
  projectSpace.artifactStore(projectId).read(ref);
  const content = projectSpace.fileContent(projectId, ref.path);
  return typeof content === 'string' && sha256Text(content) === ref.contentDigest
    ? content
    : null;
}

export function verifiedRunAnalysisReportPackage(projectId, record, {
  projectSpace = ProjectSpace,
  requirePublishedMeta = true,
} = {}) {
  if (!record || record.status !== RUN_STATUSES.SUCCEEDED) return null;
  const conclusionRef = selectNodeRef(
    record,
    'synthesize-conclusion',
    (file) => file === 'analysis/conclusion.json',
  );
  const reportRef = selectNodeRef(
    record,
    'finalize-project',
    isTimestampedReportPath,
  );
  if (!conclusionRef || !reportRef) return null;

  try {
    const lineage = projectSpace.artifactLineage(projectId, record.runId);
    const conclusionContent = verifiedCurrentRunContent(
      projectSpace,
      projectId,
      record.runId,
      'synthesize-conclusion',
      conclusionRef,
      lineage,
    );
    if (conclusionContent === null) return null;
    const reportContent = verifiedCurrentRunContent(
      projectSpace,
      projectId,
      record.runId,
      'finalize-project',
      reportRef,
      lineage,
    );
    if (reportContent === null) return null;
    const conclusion = JSON.parse(conclusionContent);
    // Scenario/Forecast are historical compatibility artifacts only. Never
    // promote stale files into a current v2 verified package.
    const scenarios = null;
    const verifiedScenariosRef = null;

    let scorecards = null;
    let scorecardRefs = [];
    const reviewNode = record.nodes?.['review-report'];
    const rawRefs = (reviewNode?.status === 'SUCCEEDED' ? reviewNode.artifactRefs || [] : [])
      .filter((ref) => /^analysis\/scorecards\/(?:data|industry|company)_r\d+\.json$/u.test(ref?.path || ''));
    const byLens = new Map();
    for (const ref of rawRefs) {
      const match = /^analysis\/scorecards\/(data|industry|company)_r(\d+)\.json$/u.exec(ref.path);
      if (match) byLens.set(match[1], { ref, cycle: Number(match[2]) - 1 });
    }
    if (
      rawRefs.length === 3
      && byLens.size === 3
      && new Set([...byLens.values()].map((item) => item.cycle)).size === 1
    ) {
      const cycle = [...byLens.values()][0].cycle;
      const parsed = {};
      for (const lens of ['data', 'industry', 'company']) {
        const item = byLens.get(lens);
        const content = verifiedCurrentRunContent(
          projectSpace,
          projectId,
          record.runId,
          'review-report',
          item.ref,
          lineage,
        );
        if (content === null) {
          parsed[lens] = null;
          break;
        }
        parsed[lens] = JSON.parse(content);
      }
      const first = parsed.data;
      const meta = projectSpace.meta(projectId) || {};
      const authoritativeTickers = Array.isArray(meta.tickers)
        ? meta.tickers.map(String).filter(Boolean).sort()
        : [];
      const materialIndustries = [{
        industryId: String(meta.theme || meta.industryTemplateName || 'primary-industry').trim(),
        classification: 'material',
        materialityWeightBps: 10000,
      }];
      const candidateRef = selectNodeRef(
        record,
        'compose-report',
        (file) => file === 'report/report.md',
      );
      const candidateDigest = candidateRef?.contentDigest;
      const candidateContent = candidateRef
        ? verifiedCurrentRunContent(
          projectSpace,
          projectId,
          record.runId,
          'compose-report',
          candidateRef,
          lineage,
        )
        : null;
      const expectedResearchRefs = {
        data: selectNodeRefs(
          record,
          'run-research-rounds',
          (file) => file === 'data/data_report.md',
        ),
        industry: selectNodeRefs(
          record,
          'run-research-rounds',
          (file) => file === 'analysis/industry.json',
        ),
        company: selectNodeRefs(
          record,
          'run-research-rounds',
          (file) => file === 'analysis/company.json',
        ),
      };
      const expectedIdentity = first ? {
        candidateIdentity: first.candidateIdentity,
        dependencyIdentity: first.dependencyIdentity,
        artifactsScored: first.artifactsScored,
      } : null;
      const dependencyClosureMatchesCurrentRun = expectedIdentity
        && canonicalSha256(expectedIdentity.dependencyIdentity?.dependencyRefs || {}) === canonicalSha256(expectedResearchRefs)
        && canonicalSha256(expectedIdentity.artifactsScored || []) === canonicalSha256([
          'analysis/company.json',
          'analysis/industry.json',
          'data/data_report.md',
          'report/report.md',
        ]);
      const identitiesMatch = expectedIdentity && parsed.data && parsed.industry && parsed.company
        && [parsed.data, parsed.industry, parsed.company].every((value) => (
          canonicalSha256(value.candidateIdentity) === canonicalSha256(expectedIdentity.candidateIdentity)
          && canonicalSha256(value.dependencyIdentity) === canonicalSha256(expectedIdentity.dependencyIdentity)
          && canonicalSha256(value.artifactsScored) === canonicalSha256(expectedIdentity.artifactsScored)
          && value.cycle === cycle
          && value.asOf === record.asOf
          && value.candidateIdentity?.candidateDigest === candidateDigest
        ));
      if (
        dependencyClosureMatchesCurrentRun
        && identitiesMatch
        && candidateRef
        && candidateContent !== null
        && canonicalSha256(expectedIdentity.candidateIdentity.candidateRef) === canonicalSha256(candidateRef)
      ) {
        const projected = {};
        for (const lens of ['data', 'industry', 'company']) {
          const value = parsed[lens];
          const ref = byLens.get(lens).ref;
          const validation = validateArtifactRef(ref);
          const errors = validation.valid ? validateScorecardEvaluation(value, {
            projectId,
            authoritativeTickers,
            materialIndustries,
            weightsAuditable: true,
          }) : ['invalid scorecard ArtifactRef'];
          const spec = getScorecardSpec(lens);
          const summary = lens === 'industry'
            ? value.aggregation
            : value.units.length === 1 ? value.units[0] : null;
          if (
            errors.length
            || !summary
            || value.lens !== lens
            || value.rubricVersion !== 'v3.1-en'
            || ref.path !== `analysis/scorecards/${lens}_r${cycle + 1}.json`
            || ref.producer !== `${lens}-scoreboard-evaluator`
            || ref.schemaVersion !== 'scorecard-evaluation.v1'
            || !Number.isSafeInteger(summary.finalScoreBps)
            || summary.qualityBand !== spec.qualityBands
              .find((band) => summary.finalScoreBps >= band.minimumScoreBps)?.id
            || !['pass', 'fail'].includes(summary.displayResult)
          ) {
            projected[lens] = null;
            break;
          }
          projected[lens] = {
            lens,
            rubricVersion: value.rubricVersion,
            asOf: value.asOf,
            cycle: value.cycle,
            candidateIdentity: {
              candidateDigest: value.candidateIdentity.candidateDigest,
              candidateRef: structuredClone(value.candidateIdentity.candidateRef),
            },
            sourceCandidateDigest: value.candidateIdentity.candidateDigest,
            sourceDigest: value.candidateIdentity.candidateDigest,
            finalScoreBps: summary.finalScoreBps,
            qualityBand: summary.qualityBand,
            displayResult: summary.displayResult,
            units: value.units.map((unit) => ({
              unitId: unit.unitId,
              unitKind: unit.unitKind,
              unitStatus: unit.unitStatus,
              finalScoreBps: unit.finalScoreBps,
              qualityBand: unit.qualityBand,
              displayResult: unit.displayResult,
            })),
            ref: structuredClone(ref),
          };
        }
        if (Object.values(projected).every(Boolean)) {
          scorecards = projected;
          scorecardRefs = [...byLens.values()].map((item) => item.ref);
        }
      }
    }

    if (requirePublishedMeta) {
      const meta = projectSpace.meta(projectId);
      if (
        !meta
        || canonicalSha256(meta.conclusion) !== canonicalSha256(conclusion)
        || (
          verifiedScenariosRef
          && canonicalSha256(meta.scenarios) !== canonicalSha256(scenarios)
        )
      ) return null;
    }
    return {
      projectId,
      runId: record.runId,
      reportPath: reportRef.path,
      conclusionPath: conclusionRef.path,
      scenariosPath: verifiedScenariosRef?.path || null,
      reportRef,
      conclusionRef,
      conclusion,
      scenarios,
      scorecards,
      scorecardRefs,
      ...(verifiedScenariosRef ? { scenariosRef: verifiedScenariosRef } : {}),
    };
  } catch {
    return null;
  }
}

export function latestVerifiedRunAnalysisReportPackage(projectId, {
  projectSpace = ProjectSpace,
  requirePublishedMeta = true,
} = {}) {
  try {
    const record = projectSpace.runStore(projectId).list().at(-1) || null;
    return verifiedRunAnalysisReportPackage(projectId, record, {
      projectSpace,
      requirePublishedMeta,
    });
  } catch {
    return null;
  }
}

function apiError(message, code = 'RUN_API_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertApiIdentity(value, field, code) {
  if (
    typeof value !== 'string'
    || !SAFE_API_IDENTITY.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw apiError(`${field} is unsafe`, code, 400);
  }
  return value;
}

function safeArtifactUri(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0];
  }
}

function safeArtifactRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const projected = Object.fromEntries(ARTIFACT_REF_FIELDS
    .filter((field) => ref[field] !== undefined)
    .map((field) => [field, ref[field]]));
  if (projected.uri) projected.uri = safeArtifactUri(projected.uri);
  return projected;
}

function safeArtifactRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.map(safeArtifactRef).filter(Boolean);
}

function agentIdsForNode(nodeId, workflowSpec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  return [...(workflowSpec.nodes.find((node) => node.id === nodeId)?.agentContractIds || [])];
}

function safeFailure(failure) {
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return null;
  return Object.fromEntries(['category', 'reason', 'code', 'at']
    .filter((field) => failure[field] !== undefined)
    .map((field) => [field, failure[field]]));
}

function safeWorkflowSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  return Object.fromEntries(['id', 'version', 'hash']
    .filter((field) => spec[field] !== undefined)
    .map((field) => [field, spec[field]]));
}

function eventStatus(event) {
  if (typeof event?.payload?.status === 'string') return event.payload.status;
  if (event?.payload?.ok === true) return 'SUCCEEDED';
  if (event?.payload?.ok === false) return 'FAILED';
  if (/failed|error/iu.test(event?.eventType || '')) return 'FAILED';
  if (/started/iu.test(event?.eventType || '')) return 'RUNNING';
  if (/completed|succeeded/iu.test(event?.eventType || '')) return 'SUCCEEDED';
  return null;
}

export function safeDurableEventProjection(event, { workflowSpec = RUN_ANALYSIS_WORKFLOW_SPEC } = {}) {
  const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const agentIds = new Set(agentIdsForNode(event?.nodeId, workflowSpec));
  if (typeof event?.agentId === 'string' && event.agentId) agentIds.add(event.agentId);
  if (typeof payload.agentId === 'string' && payload.agentId) agentIds.add(payload.agentId);
  const projected = {
    eventId: event?.eventId || null,
    eventType: event?.eventType || null,
    sequence: Number.isInteger(event?.sequence) ? event.sequence : null,
    timestamp: typeof event?.timestamp === 'string' ? event.timestamp : null,
    correlationId: typeof event?.correlationId === 'string' ? event.correlationId : null,
    causationId: typeof event?.causationId === 'string' ? event.causationId : null,
    nodeId: typeof event?.nodeId === 'string' ? event.nodeId : null,
    agentIds: [...agentIds],
    status: eventStatus(event),
  };
  for (const field of [
    'attempt',
    'nextAttempt',
    'resumeCount',
    'cycle',
    'humanReviewAttempt',
    'reviewRound',
    'taskVersion',
    'reviewBlockCount',
  ]) {
    if (Number.isInteger(payload[field])) projected[field] = payload[field];
  }
  for (const field of ['stopReason', 'reason']) {
    if (typeof payload[field] === 'string') projected[field] = payload[field];
  }
  if (Array.isArray(payload.owners)) projected.owners = payload.owners.filter((value) => typeof value === 'string');
  if (Array.isArray(payload.nodeIds)) projected.nodeIds = payload.nodeIds.filter((value) => typeof value === 'string');
  if (Array.isArray(payload.rerunNodeIds)) projected.rerunNodeIds = payload.rerunNodeIds.filter((value) => typeof value === 'string');
  if (Array.isArray(payload.reopenNodeIds)) projected.reopenNodeIds = payload.reopenNodeIds.filter((value) => typeof value === 'string');
  if (Array.isArray(payload.openIssueIds)) projected.openIssueIds = payload.openIssueIds.filter((value) => typeof value === 'string');
  for (const field of [
    'taskId',
    'decisionId',
    'reviewerId',
    'selectedAction',
    'policyDigest',
    'decisionDigest',
    'requestDigest',
    'blockedStateDigest',
  ]) {
    if (typeof payload[field] === 'string') projected[field] = payload[field];
  }
  if (typeof payload.imported === 'boolean') projected.imported = payload.imported;
  if (payload.workflowSpec) projected.workflowSpec = safeWorkflowSpec(payload.workflowSpec);
  if (typeof payload.inputDigest === 'string') projected.inputDigest = payload.inputDigest;
  if (typeof payload.outputDigest === 'string') projected.outputDigest = payload.outputDigest;
  if (payload.failure) projected.failure = safeFailure(payload.failure);
  if (payload.artifactRefs) projected.artifactRefs = safeArtifactRefs(payload.artifactRefs);
  if (payload.artifactRef) projected.artifactRef = safeArtifactRef(payload.artifactRef);
  if (payload.taskRef) projected.taskRef = safeArtifactRef(payload.taskRef);
  if (payload.decisionRef) projected.decisionRef = safeArtifactRef(payload.decisionRef);
  if (payload.inputArtifactRefs) projected.inputArtifactRefs = safeArtifactRefs(payload.inputArtifactRefs);
  if (typeof payload.tool === 'string') {
    projected.tool = {
      name: payload.tool.slice(0, 200),
      status: eventStatus(event),
    };
  }
  return projected;
}

function compatibilityTimestamp(event) {
  if (Number.isFinite(event?.ts)) return new Date(event.ts).toISOString();
  if (typeof event?.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp))) return event.timestamp;
  return null;
}

export function safeCompatibilityEventProjection(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = typeof event.type === 'string' ? event.type : null;
  const projected = {
    timestamp: compatibilityTimestamp(event),
    type,
    stage: typeof event.stage === 'string' ? event.stage : null,
    agentId: typeof event.agent === 'string' ? event.agent : null,
    round: Number.isInteger(event.round) ? event.round : null,
    artifact: typeof event.artifact === 'string' ? event.artifact : null,
  };
  if (typeof event.tool === 'string') {
    projected.tool = event.tool.slice(0, 200);
    projected.status = event.ok === false || /error|failed/iu.test(type || '')
      ? 'FAILED'
      : (event.ok === true || /done|complete|success/iu.test(type || '') ? 'SUCCEEDED' : 'OBSERVED');
  }
  return projected;
}

function eventTime(event) {
  const value = typeof event?.timestamp === 'string' ? event.timestamp : compatibilityTimestamp(event);
  const millis = value ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

function runEventWindow(record, durableEvents) {
  const start = record?.createdAt ? Date.parse(record.createdAt) : eventTime(durableEvents[0]);
  const endValue = record?.completedAt || record?.updatedAt;
  const end = endValue ? Date.parse(endValue) : eventTime(durableEvents.at(-1));
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
  };
}

function compatibleEventsForRun(record, durableEvents, compatibilityEvents) {
  const { start, end } = runEventWindow(record, durableEvents);
  if (start === null) return [];
  return compatibilityEvents
    .filter((event) => {
      const timestamp = eventTime(event);
      return timestamp !== null && timestamp >= start && (end === null || timestamp <= end);
    })
    .map(safeCompatibilityEventProjection)
    .filter(Boolean);
}

function replayNodeLifecycle(nodeId, durableEvents, workflowSpec) {
  return durableEvents
    .filter((event) => (
      event.nodeId === nodeId
      && !isAgentExecutionEventType(event.eventType)
    ))
    .map((event) => safeDurableEventProjection(event, { workflowSpec }));
}

function nodeTimestamp(lifecycle, typePattern, edge) {
  const matches = lifecycle.filter((event) => typePattern.test(event.eventType || ''));
  return matches.at(edge)?.timestamp || null;
}

function projectNode(nodeId, recordNode, replayNode, durableEvents, workflowSpec) {
  const lifecycle = replayNodeLifecycle(nodeId, durableEvents, workflowSpec);
  const source = recordNode || replayNode || {};
  return {
    nodeId,
    status: source.status || 'PENDING',
    attempt: Number.isInteger(source.attempt) ? source.attempt : 0,
    stopReason: source.stopReason || null,
    startedAt: recordNode?.startedAt || nodeTimestamp(lifecycle, /node\.started$/u, 0),
    completedAt: recordNode?.completedAt || nodeTimestamp(lifecycle, /node\.(succeeded|failed)$/u, -1),
    imported: source.imported === true,
    agentIds: agentIdsForNode(nodeId, workflowSpec),
    artifactRefs: safeArtifactRefs(source.artifactRefs),
    lastFailure: safeFailure(source.lastFailure),
    lifecycle,
  };
}

function safeLineageEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return {
    eventId: typeof entry.eventId === 'string' ? entry.eventId : null,
    sequence: Number.isInteger(entry.sequence) ? entry.sequence : null,
    projectId: typeof entry.projectId === 'string' ? entry.projectId : null,
    runId: typeof entry.runId === 'string' ? entry.runId : null,
    nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : null,
    ref: safeArtifactRef(entry.ref),
    inputArtifactRefs: safeArtifactRefs(entry.inputArtifactRefs),
  };
}

function timestampsFor(record, durableEvents) {
  const first = durableEvents[0]?.timestamp || null;
  const last = durableEvents.at(-1)?.timestamp || null;
  const terminal = [...durableEvents].reverse().find((event) => TERMINAL_EVENT_TYPES.has(event.eventType));
  return {
    createdAt: record?.createdAt || first,
    updatedAt: record?.updatedAt || last,
    completedAt: record?.completedAt || terminal?.timestamp || null,
    asOf: record?.asOf || null,
  };
}

function nodeCounts(nodes) {
  const counts = {};
  for (const node of nodes) counts[node.status] = (counts[node.status] || 0) + 1;
  return counts;
}

export function projectRunTrace({
  projectId,
  runId,
  record = null,
  replayRun = null,
  durableEvents = [],
  compatibilityEvents = [],
  agentExecutions = null,
  activeRunId = null,
  workflowSpec = RUN_ANALYSIS_WORKFLOW_SPEC,
} = {}) {
  if (!record && !replayRun) throw apiError(`run not found: ${runId}`, 'RUN_NOT_FOUND', 404);
  const nodeIds = [...new Set([
    ...Object.keys(record?.nodes || {}),
    ...Object.keys(replayRun?.nodes || {}),
  ])];
  const canonicalOrder = topologicalNodeOrder(workflowSpec);
  nodeIds.sort((a, b) => {
    const ai = canonicalOrder.indexOf(a);
    const bi = canonicalOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const nodes = nodeIds.map((nodeId) => projectNode(
    nodeId,
    record?.nodes?.[nodeId],
    replayRun?.nodes?.[nodeId],
    durableEvents,
    workflowSpec,
  ));
  const lifecycle = durableEvents
    .filter((event) => !isAgentExecutionEventType(event.eventType))
    .map((event) => safeDurableEventProjection(event, { workflowSpec }));
  const runtimeEvents = compatibleEventsForRun(record, durableEvents, compatibilityEvents);
  const toolEvents = runtimeEvents.filter((event) => event.tool);
  const executionSummaries = agentExecutions || listAgentExecutionSummaries({
    events: durableEvents,
    workflowRunId: runId,
  });
  const agentIds = [...new Set([
    ...nodes.flatMap((node) => node.agentIds),
    ...runtimeEvents.map((event) => event.agentId).filter(Boolean),
    ...executionSummaries.map((execution) => execution.agentId),
  ])];
  const lineage = (replayRun?.artifactLineage || []).map(safeLineageEntry).filter(Boolean);
  const status = record?.status || replayRun?.status || null;
  return {
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    projectId,
    runId,
    active: activeRunId === runId,
    status,
    stopReason: record?.stopReason ?? replayRun?.stopReason ?? null,
    workflowSpec: safeWorkflowSpec(record?.workflowSpec || replayRun?.workflowSpec),
    timestamps: timestampsFor(record, durableEvents),
    resumeCount: record?.resumeCount || 0,
    remediationCycle: record?.remediationCycle || replayRun?.remediationCycle || 0,
    attempts: nodes.reduce((sum, node) => sum + node.attempt, 0),
    nodeCounts: nodeCounts(nodes),
    agentIds,
    agentRuns: structuredClone(executionSummaries),
    nodes,
    lifecycle,
    runtimeEvents,
    toolEvents,
    artifacts: [...new Map(nodes.flatMap((node) => node.artifactRefs).map((ref) => [
      `${ref.artifactId || ''}:${ref.version || ''}:${ref.contentDigest || ''}`,
      ref,
    ])).values()],
    lineage,
  };
}

function summaryFromTrace(trace) {
  const agentExecutionCounts = {};
  for (const execution of trace.agentRuns) {
    agentExecutionCounts[execution.status] = (agentExecutionCounts[execution.status] || 0) + 1;
  }
  return {
    schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
    projectId: trace.projectId,
    runId: trace.runId,
    active: trace.active,
    status: trace.status,
    stopReason: trace.stopReason,
    workflowSpec: trace.workflowSpec,
    timestamps: trace.timestamps,
    attempts: trace.attempts,
    resumeCount: trace.resumeCount,
    remediationCycle: trace.remediationCycle,
    nodeCounts: trace.nodeCounts,
    agentIds: trace.agentIds,
    agentExecutionCount: trace.agentRuns.length,
    agentExecutionCounts,
    artifactCount: trace.artifacts.length,
  };
}

function projectSnapshot(projectId, projectSpace) {
  const safeProjectId = assertApiIdentity(projectId, 'project id', 'UNSAFE_PROJECT_ID');
  const meta = projectSpace.meta(safeProjectId);
  if (!meta) throw apiError(`project not found: ${safeProjectId}`, 'PROJECT_NOT_FOUND', 404);
  const runStore = projectSpace.runStore(safeProjectId);
  const records = runStore.list();
  const replay = projectSpace.replayEvents(safeProjectId);
  const compatibilityEvents = projectSpace.events(safeProjectId);
  const activeRunId = [...records].reverse().find(
    (record) => record.status === RUN_STATUSES.RUNNING,
  )?.runId || null;
  return { records, replay, compatibilityEvents, activeRunId };
}

export function listProjectRuns(projectId, { projectSpace = ProjectSpace } = {}) {
  const { records, replay, compatibilityEvents, activeRunId } = projectSnapshot(projectId, projectSpace);
  const byRunId = new Map(records.map((record) => [record.runId, record]));
  const eventsByRunId = new Map();
  for (const event of replay.events || []) {
    if (!eventsByRunId.has(event.runId)) eventsByRunId.set(event.runId, []);
    eventsByRunId.get(event.runId).push(event);
  }
  const runIds = [...new Set([...byRunId.keys(), ...Object.keys(replay.runs || {})])];
  const summaries = runIds.map((runId) => {
    const durableEvents = eventsByRunId.get(runId) || [];
    return summaryFromTrace(projectRunTrace({
      projectId,
      runId,
      record: byRunId.get(runId) || null,
      replayRun: replay.runs?.[runId] || null,
      durableEvents,
      compatibilityEvents,
      activeRunId,
    }));
  }).sort((a, b) => Date.parse(b.timestamps.createdAt || 0) - Date.parse(a.timestamps.createdAt || 0));
  return { projectId, count: summaries.length, activeRunId, runs: summaries };
}

export function getProjectRunDetail(projectId, runId, { projectSpace = ProjectSpace } = {}) {
  const safeRunId = assertApiIdentity(runId, 'workflow run id', 'UNSAFE_WORKFLOW_RUN_ID');
  const { records, replay, compatibilityEvents, activeRunId } = projectSnapshot(projectId, projectSpace);
  const record = records.find((item) => item.runId === safeRunId) || null;
  const replayRun = replay.runs?.[safeRunId] || null;
  const durableEvents = (replay.events || []).filter((event) => event.runId === safeRunId);
  return projectRunTrace({
    projectId,
    runId: safeRunId,
    record,
    replayRun,
    durableEvents,
    compatibilityEvents,
    activeRunId,
  });
}

export function getProjectAgentExecutionTimeline(
  projectId,
  runId,
  agentRunId,
  {
    afterSequence,
    limit,
    projectSpace = ProjectSpace,
  } = {},
) {
  const safeRunId = assertApiIdentity(runId, 'workflow run id', 'UNSAFE_WORKFLOW_RUN_ID');
  const { records, replay } = projectSnapshot(projectId, projectSpace);
  if (
    !records.some((record) => record.runId === safeRunId)
    && !replay.runs?.[safeRunId]
  ) {
    throw apiError(`run not found: ${safeRunId}`, 'RUN_NOT_FOUND', 404);
  }
  return agentExecutionTimeline({
    events: replay.events || [],
    workflowRunId: safeRunId,
    agentRunId,
    afterSequence,
    limit,
  });
}

export function runAnalysisWorkflowProjection(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  const nodes = spec.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    handlerId: node.handlerId,
    dependsOn: [...node.dependsOn],
    conditionId: node.conditionId,
    condition: node.condition,
    agentIds: [...node.agentContractIds],
    parallelGroup: node.parallelGroup || null,
    artifactPolicy: node.artifactPolicy || 'contract-derived',
    artifacts: node.artifacts ? structuredClone(node.artifacts) : null,
    artifactSelection: node.artifactSelection ? structuredClone(node.artifactSelection) : null,
    dynamicRounds: node.dynamicRounds ? structuredClone(node.dynamicRounds) : null,
  }));
  return {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    workflow: {
      id: spec.id,
      version: spec.version,
      schemaVersion: spec.schemaVersion,
      hash: workflowSpecHash(spec),
      description: spec.description,
      maxRemediationCycles: spec.maxRemediationCycles,
    },
    topologicalOrder: topologicalNodeOrder(spec),
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))),
    parallelGroups: structuredClone(spec.parallelGroups),
    remediationRoutes: structuredClone(spec.remediationRoutes),
    spec: structuredClone(spec),
  };
}
