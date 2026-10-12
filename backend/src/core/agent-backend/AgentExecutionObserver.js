import { randomUUID } from 'node:crypto';

import { isSafeModelId } from '../models/modelMetadata.js';
import { assertAgentBackend } from './AgentBackend.js';
import {
  AGENT_PHYSICAL_EXECUTION_OBSERVER,
  agentResultExecutionProvenance,
} from './IdempotentAgentBackend.js';

const SAFE_METRIC_FIELDS = Object.freeze([
  'turns',
  'toolCalls',
  'toolAttempts',
  'toolDenied',
  'tokens',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'wallMs',
  'deadlineMs',
  'finalizeReserveMs',
  'toolCallSafetyLimit',
  'costKnown',
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SAFE_PROVIDER_IDS = new Set(['deepseek', 'demo', 'gpt-gateway', 'openai-compatible']);
const SAFE_STOP_REASONS = new Set([
  'aborted',
  'cancelled',
  'completed',
  'cost-budget',
  'deadline',
  'error',
  'fatal',
  'final',
  'human-review',
  'length',
  'maxTurns',
  'model-length',
  'process-interrupted',
  'provider-unavailable',
  'runtime-budget',
  'schema-invalid',
  'stop',
  'token-budget',
  'tool-budget',
  'toolUse',
  'unknown',
]);
const SAFE_BUDGET_DIMENSIONS = new Set([
  'cost-budget',
  'deadline',
  'maxTurns',
  'runtime-budget',
  'token-budget',
  'tool-budget',
  'turns',
  'wall-clock',
]);

function timestamp(value, now) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  const current = now();
  return typeof current === 'string' ? current : new Date(current).toISOString();
}

function safeIdentifier(value, fallback = null) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
    ? value
    : fallback;
}

function safeProvider(value) {
  return typeof value === 'string' && SAFE_PROVIDER_IDS.has(value)
    ? value
    : null;
}

function safeModel(value, provider) {
  return provider && isSafeModelId(value) ? value : null;
}

function safeStopReason(value, fallback = null) {
  return typeof value === 'string' && SAFE_STOP_REASONS.has(value)
    ? value
    : fallback;
}

function safeBudgetDimension(value) {
  return typeof value === 'string' && SAFE_BUDGET_DIMENSIONS.has(value)
    ? value
    : 'runtime-budget';
}

function safeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(SAFE_METRIC_FIELDS
    .filter((field) => (
      typeof value[field] === 'number'
      || typeof value[field] === 'boolean'
    ))
    .map((field) => [field, value[field]]));
}

function publicStatus(result) {
  if (result?.status === 'succeeded') return 'SUCCEEDED';
  if (result?.status === 'partial') return 'PARTIAL';
  return 'FAILED';
}

function workflowAttempt(runtime) {
  return Number.isInteger(runtime?.workflowAttempt) && runtime.workflowAttempt > 0
    ? runtime.workflowAttempt
    : 1;
}

function toolActivity(event, toolStartedAt) {
  const eventType = event?.eventType;
  if (![
    'tool.started',
    'tool.completed',
    'tool.failed',
    'tool.permission.denied',
  ].includes(eventType)) return null;
  const tool = safeIdentifier(event?.payload?.tool, 'unknown-tool');
  const callId = typeof event?.payload?.toolCallId === 'string'
    ? event.payload.toolCallId
    : null;
  const eventAt = Date.parse(event.timestamp);
  if (eventType === 'tool.started' && callId) toolStartedAt.set(callId, eventAt);
  const startedAt = callId ? toolStartedAt.get(callId) : null;
  const durationMs = Number.isFinite(eventAt) && Number.isFinite(startedAt)
    ? Math.max(0, eventAt - startedAt)
    : null;
  if (eventType !== 'tool.started' && callId) toolStartedAt.delete(callId);
  const status = eventType === 'tool.started'
    ? 'RUNNING'
    : eventType === 'tool.completed' ? 'SUCCEEDED' : 'FAILED';
  const verb = eventType === 'tool.started'
    ? 'selected'
    : status === 'SUCCEEDED' ? 'completed' : 'failed';
  return {
    activityType: eventType,
    activitySummary: `Tool ${tool} ${verb}.`,
    tool: {
      name: tool,
      status,
      sequence: event.sequence,
      ...(durationMs === null ? {} : { durationMs }),
    },
  };
}

function normalizedActivity(event, toolStartedAt) {
  const tool = toolActivity(event, toolStartedAt);
  if (tool) return tool;
  if (event?.eventType === 'agent.turn.completed') {
    const stopReason = safeStopReason(event.payload?.stopReason);
    return {
      activityType: event.eventType,
      activitySummary: stopReason
        ? `Agent turn completed with stop reason ${stopReason}.`
        : 'Agent turn completed.',
      ...(stopReason ? { stopReason } : {}),
    };
  }
  if (event?.eventType === 'agent.stopped') {
    const stopReason = safeStopReason(event.payload?.stopReason, 'unknown');
    return {
      activityType: event.eventType,
      activitySummary: `Agent stopped with reason ${stopReason}.`,
      stopReason,
    };
  }
  if (event?.eventType === 'budget.warning' || event?.eventType === 'budget.exhausted') {
    const dimension = safeBudgetDimension(
      event.payload?.dimension || event.payload?.reason,
    );
    return {
      activityType: event.eventType,
      activitySummary: event.eventType === 'budget.warning'
        ? `Agent runtime budget warning for ${dimension}.`
        : `Agent runtime budget exhausted for ${dimension}.`,
      stopReason: dimension,
    };
  }
  return null;
}

function executionIdentity(idFactory) {
  const value = idFactory();
  if (typeof value !== 'string' || !/^agent_run_[A-Za-z0-9-]{8,80}$/u.test(value)) {
    throw new TypeError('Agent execution id factory must return an opaque agent_run_ identity');
  }
  return value;
}

function tracePersistenceError(cause) {
  const error = new Error('Agent execution trace could not be persisted');
  error.code = 'AGENT_EXECUTION_TRACE_PERSISTENCE_FAILED';
  error.cause = cause;
  return error;
}

/**
 * Observes one workflow-scoped backend without adding services to the immutable
 * Workflow node context. Only bounded lifecycle metadata is sent to observer;
 * prompts, messages, thinking, arguments, raw results, and private output never
 * enter this boundary.
 */
export function withAgentExecutionObserver(agentBackend, {
  workflowRunId,
  observer,
  idFactory = () => `agent_run_${randomUUID()}`,
  now = Date.now,
} = {}) {
  const observedBackend = assertAgentBackend(agentBackend);
  if (typeof workflowRunId !== 'string' || !workflowRunId) {
    throw new TypeError('Agent execution observer requires workflowRunId');
  }
  if (typeof observer !== 'function') {
    throw new TypeError('Agent execution observer callback is required');
  }
  if (typeof idFactory !== 'function') {
    throw new TypeError('Agent execution observer idFactory must be a function');
  }
  if (typeof now !== 'function') throw new TypeError('Agent execution observer now must be a function');

  return {
    async run(request, runtime = {}) {
      const agentRunId = executionIdentity(idFactory);
      const attempt = workflowAttempt(runtime);
      const agentId = safeIdentifier(request?.agentContractId, 'unknown-agent');
      const contractVersion = safeIdentifier(request?.contractVersion, '0.0.0');
      const toolStartedAt = new Map();
      const originalOnEvent = runtime.onEvent;
      let started = false;
      let completed = false;
      let physicalExecutionAuthorized = false;
      let lastAgentEventSequence = 0;
      let lastTimestamp = null;
      let persistenceError = null;

      const observe = async (entry) => {
        try {
          await observer({
            workflowRunId,
            agentRunId,
            nodeId: safeIdentifier(request?.nodeId, 'unknown-node'),
            agentId,
            contractVersion,
            workflowAttempt: attempt,
            ...entry,
          });
        } catch (error) {
          persistenceError ||= error instanceof Error ? error : new Error(String(error));
        }
      };
      const start = async (eventSequence = 0, at = null) => {
        if (started) return;
        started = true;
        lastAgentEventSequence = Math.max(lastAgentEventSequence, eventSequence);
        lastTimestamp = timestamp(at, now);
        await observe({
          kind: 'started',
          timestamp: lastTimestamp,
          agentEventSequence: eventSequence,
          status: 'RUNNING',
          activitySummary: 'Agent execution started.',
        });
      };
      const observedRuntime = {
        ...runtime,
        onEvent: async (event) => {
          const sequence = Number.isInteger(event?.sequence) && event.sequence >= 0
            ? event.sequence
            : lastAgentEventSequence + 1;
          await start(sequence, event?.timestamp);
          lastAgentEventSequence = Math.max(lastAgentEventSequence, sequence);
          lastTimestamp = timestamp(event?.timestamp, now);
          const activity = normalizedActivity(event, toolStartedAt);
          if (activity) {
            await observe({
              kind: 'activity',
              timestamp: lastTimestamp,
              agentEventSequence: sequence,
              status: 'RUNNING',
              ...activity,
            });
          }
          try {
            await originalOnEvent?.(event);
          } catch {
            // Preserve the existing best-effort external observer semantics.
          }
        },
      };

      const finish = async ({
        result = null,
        error = null,
        provenance = 'physical',
      } = {}) => {
        if (completed || provenance !== 'physical') return;
        await start(0, result?.trace?.startedAt);
        completed = true;
        const stopReason = safeStopReason(
          result?.stopReason || error?.stopReason,
          error ? 'error' : 'unknown',
        );
        const status = error ? 'FAILED' : publicStatus(result);
        const provider = safeProvider(result?.provider);
        await observe({
          kind: 'completed',
          timestamp: timestamp(null, now),
          agentEventSequence: lastAgentEventSequence + 1,
          status,
          stopReason,
          activitySummary: status === 'SUCCEEDED'
            ? 'Agent execution completed successfully.'
            : status === 'PARTIAL'
              ? `Agent execution completed partially with stop reason ${stopReason}.`
              : `Agent execution failed with stop reason ${stopReason}.`,
          provenance: 'physical',
          metrics: safeMetrics(result?.metrics),
          provider,
          model: safeModel(result?.model, provider),
        });
        if (persistenceError) {
          throw tracePersistenceError(persistenceError);
        }
      };
      observedRuntime[AGENT_PHYSICAL_EXECUTION_OBSERVER] = async ({ phase, result }) => {
        if (phase === 'started') {
          await start();
          if (persistenceError) throw tracePersistenceError(persistenceError);
          physicalExecutionAuthorized = true;
          return;
        }
        if (phase !== 'completed') {
          throw new TypeError('Unknown physical Agent execution observer phase');
        }
        await finish({ result, provenance: 'physical' });
      };

      try {
        const result = await observedBackend.run(request, observedRuntime);
        const provenance = agentResultExecutionProvenance(observedRuntime);
        await finish({ result, provenance });
        return result;
      } catch (error) {
        const provenance = agentResultExecutionProvenance(observedRuntime);
        if (
          error?.code === 'AGENT_EXECUTION_TRACE_PERSISTENCE_FAILED'
          && !physicalExecutionAuthorized
        ) {
          throw error;
        }
        await finish({ error, provenance });
        if (persistenceError && error?.code !== 'AGENT_EXECUTION_TRACE_PERSISTENCE_FAILED') {
          throw tracePersistenceError(persistenceError);
        }
        throw error;
      }
    },
    async cancel(runId, nodeId) {
      return typeof observedBackend.cancel === 'function'
        ? observedBackend.cancel(runId, nodeId)
        : false;
    },
  };
}
