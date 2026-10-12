import {
  DURABLE_EVENT_TYPES,
  durableEventId,
  isAgentExecutionEventType,
} from './EventBus.js';

export const AGENT_RUN_TRACE_SCHEMA_VERSION = 'agent-run-trace.v2';
export const AGENT_EXECUTION_TIMELINE_SCHEMA_VERSION = 'agent-execution-timeline.v1';

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

function apiError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertIdentity(value, label, code) {
  if (
    typeof value !== 'string'
    || !SAFE_IDENTITY.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw apiError(`${label} is unsafe`, code, 400);
  }
  return value;
}

function normalizeInteger(value, {
  label,
  defaultValue,
  minimum,
  maximum,
}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isInteger(parsed)
    || parsed < minimum
    || (maximum !== undefined && parsed > maximum)
  ) {
    throw apiError(`${label} is invalid`, 'INVALID_AGENT_TIMELINE_PAGINATION', 400);
  }
  return parsed;
}

function agentEvents(events, workflowRunId, agentRunId = null) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => (
      event?.runId === workflowRunId
      && isAgentExecutionEventType(event.eventType)
      && (agentRunId === null || event.payload?.agentRunId === agentRunId)
    ))
    .sort((left, right) => left.sequence - right.sequence);
}

function completionDuration(summary) {
  if (Number.isFinite(summary.metrics?.wallMs)) return summary.metrics.wallMs;
  const started = Date.parse(summary.startedAt || '');
  const completed = Date.parse(summary.completedAt || '');
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : null;
}

function emptySummary(event) {
  const payload = event.payload;
  return {
    schemaVersion: AGENT_RUN_TRACE_SCHEMA_VERSION,
    agentRunId: payload.agentRunId,
    agentId: payload.agentId,
    contractVersion: payload.contractVersion,
    nodeId: event.nodeId,
    workflowAttempt: payload.workflowAttempt,
    status: 'RUNNING',
    stopReason: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    activityCount: 0,
    toolCount: 0,
    provider: null,
    model: null,
    metrics: {},
    firstSequence: event.sequence,
    lastSequence: event.sequence,
  };
}

export function listAgentRunTraces({
  events = [],
  workflowRunId,
  nodeId = null,
} = {}) {
  const safeRunId = assertIdentity(
    workflowRunId,
    'workflow run id',
    'UNSAFE_WORKFLOW_RUN_ID',
  );
  if (nodeId !== null) assertIdentity(nodeId, 'workflow node id', 'UNSAFE_WORKFLOW_NODE_ID');
  const summaries = new Map();
  for (const event of agentEvents(events, safeRunId)) {
    if (nodeId !== null && event.nodeId !== nodeId) continue;
    const payload = event.payload;
    const summary = summaries.get(payload.agentRunId) || emptySummary(event);
    summary.lastSequence = event.sequence;
    if (event.eventType === DURABLE_EVENT_TYPES.AGENT_EXECUTION_STARTED) {
      summary.status = payload.status;
      summary.startedAt ||= event.timestamp;
    } else if (event.eventType === DURABLE_EVENT_TYPES.AGENT_EXECUTION_ACTIVITY) {
      summary.activityCount += 1;
      if (payload.tool?.status === 'RUNNING') summary.toolCount += 1;
    } else if (event.eventType === DURABLE_EVENT_TYPES.AGENT_EXECUTION_COMPLETED) {
      summary.status = payload.status;
      summary.stopReason = payload.stopReason;
      summary.completedAt = event.timestamp;
      summary.provider = payload.provider || null;
      summary.model = payload.model || null;
      summary.metrics = structuredClone(payload.metrics);
    }
    summary.durationMs = completionDuration(summary);
    summaries.set(payload.agentRunId, summary);
  }
  return [...summaries.values()].sort((left, right) => (
    left.firstSequence - right.firstSequence
    || left.agentRunId.localeCompare(right.agentRunId)
  ));
}

export const listAgentExecutionSummaries = listAgentRunTraces;

function timelineItem(event) {
  const payload = event.payload;
  return {
    sequence: event.sequence,
    agentEventSequence: payload.agentEventSequence,
    timestamp: event.timestamp,
    eventType: event.eventType,
    agentRunId: payload.agentRunId,
    agentId: payload.agentId,
    contractVersion: payload.contractVersion,
    nodeId: event.nodeId,
    workflowAttempt: payload.workflowAttempt,
    status: payload.status,
    stopReason: payload.stopReason || null,
    activityType: payload.activityType || null,
    summary: payload.activitySummary,
    ...(payload.tool ? { tool: structuredClone(payload.tool) } : {}),
    ...(payload.metrics ? { metrics: structuredClone(payload.metrics) } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.provenance ? { provenance: payload.provenance } : {}),
  };
}

export function agentExecutionTimeline({
  events = [],
  workflowRunId,
  agentRunId,
  afterSequence = 0,
  limit = 50,
} = {}) {
  const safeRunId = assertIdentity(
    workflowRunId,
    'workflow run id',
    'UNSAFE_WORKFLOW_RUN_ID',
  );
  const safeAgentRunId = assertIdentity(
    agentRunId,
    'Agent execution id',
    'UNSAFE_AGENT_RUN_ID',
  );
  if (!safeAgentRunId.startsWith('agent_run_')) {
    throw apiError('Agent execution id is unsafe', 'UNSAFE_AGENT_RUN_ID', 400);
  }
  const normalizedAfter = normalizeInteger(afterSequence, {
    label: 'afterSequence',
    defaultValue: 0,
    minimum: 0,
  });
  const normalizedLimit = normalizeInteger(limit, {
    label: 'limit',
    defaultValue: 50,
    minimum: 1,
    maximum: 100,
  });
  const scoped = agentEvents(events, safeRunId, safeAgentRunId);
  if (!scoped.length) {
    throw apiError(
      `Agent execution not found: ${safeAgentRunId}`,
      'AGENT_RUN_NOT_FOUND',
      404,
    );
  }
  const remaining = scoped.filter((event) => event.sequence > normalizedAfter);
  const page = remaining.slice(0, normalizedLimit);
  return {
    schemaVersion: AGENT_EXECUTION_TIMELINE_SCHEMA_VERSION,
    workflowRunId: safeRunId,
    agentRunId: safeAgentRunId,
    afterSequence: normalizedAfter,
    limit: normalizedLimit,
    nextAfterSequence: page.at(-1)?.sequence ?? normalizedAfter,
    hasMore: remaining.length > page.length,
    items: page.map(timelineItem),
  };
}

/**
 * Binds the generic backend observer to one run-owned FileEventBus. Entries have
 * already been reduced to safe lifecycle metadata; EventBus typed validation is
 * the second fail-closed boundary before persistence.
 */
export function createDurableAgentExecutionObserver({
  eventBus,
  workflowRunId,
  flushIntervalMs = 250,
  maxBatchSize = 32,
} = {}) {
  if (
    !eventBus
    || typeof eventBus.publish !== 'function'
    || typeof eventBus.publishMany !== 'function'
  ) {
    throw new TypeError('Durable Agent execution observer requires an EventBus');
  }
  if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 1) {
    throw new TypeError('Durable Agent execution observer flushIntervalMs must be a positive integer');
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) {
    throw new TypeError('Durable Agent execution observer maxBatchSize must be between 1 and 100');
  }
  const safeRunId = assertIdentity(
    workflowRunId,
    'workflow run id',
    'UNSAFE_WORKFLOW_RUN_ID',
  );
  const previousEventByAgentRun = new Map();
  const pending = [];
  let timer = null;
  let flushTail = Promise.resolve();
  let persistenceError = null;

  const eventInput = (entry, causationId) => {
    if (entry.workflowRunId !== safeRunId) {
      throw new TypeError('Agent execution observer workflow run identity mismatch');
    }
    const eventType = entry.kind === 'started'
      ? DURABLE_EVENT_TYPES.AGENT_EXECUTION_STARTED
      : entry.kind === 'activity'
        ? DURABLE_EVENT_TYPES.AGENT_EXECUTION_ACTIVITY
        : entry.kind === 'completed'
          ? DURABLE_EVENT_TYPES.AGENT_EXECUTION_COMPLETED
          : null;
    if (eventType === null) throw new TypeError('Unknown Agent execution observer entry');
    const payload = Object.fromEntries(Object.entries(entry)
      .filter(([field, value]) => (
        !['kind', 'timestamp', 'workflowRunId', 'nodeId'].includes(field)
        && value !== null
        && value !== undefined
      )));
    const eventId = durableEventId(eventType, {
      workflowRunId: safeRunId,
      agentRunId: entry.agentRunId,
      agentEventSequence: entry.agentEventSequence,
    });
    return {
      eventId,
      eventType,
      correlationId: safeRunId,
      causationId,
      runId: safeRunId,
      nodeId: entry.nodeId,
      timestamp: entry.timestamp,
      payload,
    };
  };

  const writeBatch = (entries) => {
    const priorByAgentRun = new Map(previousEventByAgentRun);
    const inputs = entries.map((entry) => {
      const input = eventInput(
        entry,
        priorByAgentRun.get(entry.agentRunId) || null,
      );
      priorByAgentRun.set(entry.agentRunId, input.eventId);
      return input;
    });
    const published = eventBus.publishMany(inputs);
    for (let index = 0; index < entries.length; index += 1) {
      previousEventByAgentRun.set(
        entries[index].agentRunId,
        published[index].eventId,
      );
    }
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.length) return flushTail;
    const batch = pending.splice(0, pending.length);
    const current = flushTail.then(() => {
      if (persistenceError) throw persistenceError;
      writeBatch(batch);
    });
    flushTail = current.catch((error) => {
      persistenceError ||= error instanceof Error ? error : new Error(String(error));
    });
    return current;
  };

  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(() => {
        // The next awaited lifecycle boundary propagates this durable failure.
      });
    }, flushIntervalMs);
    timer.unref?.();
  };

  return async (entry) => {
    if (persistenceError) throw persistenceError;
    pending.push(entry);
    if (
      entry.kind === 'started'
      || entry.kind === 'completed'
      || pending.length >= maxBatchSize
    ) {
      await flush();
    } else {
      scheduleFlush();
    }
    if (persistenceError) throw persistenceError;
  };
}
