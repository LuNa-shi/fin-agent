import { Agent } from '@earendil-works/pi-agent-core';

import { createAgentRunRequest, createAgentRunResult } from '../contracts/agentContracts.js';
import { ContextManager } from '../context/ContextManager.js';
import { ToolGateway } from '../tools/ToolGateway.js';
import { getAgentSchema } from '../validation/agentSchemaRegistry.js';
import { OutputGate } from '../validation/OutputGate.js';
import { ContractEnforcer } from '../validation/ContractEnforcer.js';
import { adaptAgentOutput, adapterValidationErrors } from '../validation/AgentOutputAdapter.js';
import { ModelRouter } from '../models/ModelRouter.js';
import { DEMO_PROVIDER_ID } from '../models/deterministicDemo.js';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../models/openAICompatibleProvider.js';
import { agentPromptCacheSessionId } from '../models/agentPromptCache.js';
import { recordModelUsage } from '../models/modelUsageLedger.js';
import { AgentBackend } from './AgentBackend.js';
import { PiEventAdapter } from './PiEventAdapter.js';
import { createPiTools } from './PiToolAdapter.js';
import { RunPolicyController } from './RunPolicyController.js';
import { runTool } from '../../tools/index.js';
import { toolRegistry as authoritativeToolRegistry } from '../../tools/toolCatalog.js';
import { canonicalAgentStatus, canonicalAgentStopReason } from './agentOutcome.js';
import { runtimeToolNames } from './runtimeToolPolicy.js';

const NO_REPAIR_STOPS = new Set(['cancelled', 'deadline', 'error', 'maxTurns', 'token-budget', 'cost-budget', 'tool-budget']);
const DEFAULT_MODEL_API_RETRY_ATTEMPTS = 2;
const DEFAULT_MODEL_API_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_MODEL_API_RETRY_MAX_DELAY_MS = 5_000;
const RETRYABLE_MODEL_ERROR = /(?:stream error|INTERNAL_ERROR|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:reset|closed)|temporar(?:y|ily)|timeout)/iu;
const RETRYABLE_PROVIDER_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PROVIDER_STATUS_RE = /(?:HTTP(?: status)?|status(?: code)?|request failed:)\s*(\d{3})\b/iu;
const BARE_PROVIDER_STATUS_RE = /^\s*(\d{3})\s*:/u;

function providerStatus(error, message) {
  for (const candidate of [error?.status, error?.statusCode, error?.response?.status]) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const text = String(message || error?.message || error || '');
  const match = text.match(PROVIDER_STATUS_RE) || text.match(BARE_PROVIDER_STATUS_RE);
  return match ? Number(match[1]) : null;
}

function classifyModelFailure(error, message) {
  const status = providerStatus(error, message);
  if (RETRYABLE_PROVIDER_STATUS.has(status)) {
    error.code = 'MODEL_PROVIDER_TRANSIENT';
    error.transient = true;
  } else if (status !== null) {
    error.code = 'MODEL_PROVIDER_PERMANENT';
    error.transient = false;
  } else if (error.transient === true || RETRYABLE_MODEL_ERROR.test(String(message || error?.message || error))) {
    error.code = 'MODEL_TRANSPORT_TRANSIENT';
    error.transient = true;
  }
  if (status !== null) error.statusCode = status;
  return error;
}
const keyFor = (runId, nodeId) => `${runId}:${nodeId}`;

function registryTool(registry, name) {
  try {
    return typeof registry?.get === 'function' ? registry.get(name) : registry?.[name] || null;
  } catch {
    return null;
  }
}

function thinkingLevel(value) {
  return ({ off: 'off', minimal: 'minimal', low: 'low', standard: 'medium', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })[value] || 'medium';
}

function executionTruthForRoute(route) {
  return Object.freeze({
    live: route.provider !== DEMO_PROVIDER_ID,
    costKnown: route.provider !== OPENAI_COMPATIBLE_PROVIDER_ID,
  });
}

function assistantText(messages = []) {
  const message = [...messages].reverse().find((item) => item?.role === 'assistant');
  const text = (message?.content || []).filter((item) => item?.type === 'text').map((item) => item.text || '').join('');
  return { message, text };
}

function modelStopReason(message) {
  if (!message) return 'error';
  if (message.stopReason === 'stop') return 'final';
  if (message.stopReason === 'length') return 'model-length';
  if (message.stopReason === 'aborted') return 'cancelled';
  if (message.stopReason === 'error') return 'error';
  return 'final';
}

function modelFailure(message) {
  const errorMessage = String(message?.errorMessage || '').trim();
  if (message?.stopReason !== 'error' || !errorMessage) return null;
  const error = new Error(errorMessage);
  error.name = 'PiModelError';
  return classifyModelFailure(error, errorMessage);
}

function promptFailure(error) {
  const failure = error instanceof Error ? error : new Error(String(error || 'Model prompt failed'));
  return classifyModelFailure(failure, String(failure.message || failure));
}

function modelApiRetryPolicy(runtime = {}) {
  const policy = runtime.modelApiRetry || {};
  const maxAttempts = Number.isInteger(policy.maxAttempts)
    ? policy.maxAttempts
    : DEFAULT_MODEL_API_RETRY_ATTEMPTS;
  const baseDelayMs = Number.isFinite(Number(policy.baseDelayMs))
    ? Number(policy.baseDelayMs)
    : DEFAULT_MODEL_API_RETRY_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(Number(policy.maxDelayMs))
    ? Number(policy.maxDelayMs)
    : DEFAULT_MODEL_API_RETRY_MAX_DELAY_MS;
  return {
    maxAttempts: Math.max(1, Math.min(5, maxAttempts)),
    baseDelayMs: Math.max(0, baseDelayMs),
    maxDelayMs: Math.max(0, maxDelayMs),
  };
}

function modelRetryDelayMs(policy, retryIndex) {
  if (policy.baseDelayMs <= 0 || policy.maxDelayMs <= 0) return 0;
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retryIndex));
}

function structuredOutputContract(contract) {
  return contract.executionMode === 'json'
    || typeof contract.outputAdapter === 'function'
    || contract.completionPolicy?.hardChecks?.includes('output-schema');
}

function scorecardClosureRepairGuidance(contract, errors) {
  if (contract.outputSchema !== 'scorecard-evaluation.v1'
    || !errors.some((error) => /outside (?:the )?immutable closure/iu.test(String(error)))) return '';
  return `

Scorecard immutable-closure repair rule: rewrite every offending decisiveEvidence/evidenceRefs item to a single bare allowed path copied exactly from the supplied immutable closure (for example, \`data/data_report.md\`), with no colon, line range, section text, anchor, query, prose, URI, or appended location. Put location/context only in whyNotHigher or rawSourceChecks.location/notes. Preserve the strict closure check; do not coerce or omit invalid references.`;
}

function effectiveRuntimeContract(checkedIn, request, runtime) {
  const override = runtime.contractOverride;
  if (override === undefined) return checkedIn;
  if (!override || typeof override !== 'object' || override.id !== checkedIn.id || override.version !== checkedIn.version) {
    throw new TypeError(`runtime contract override identity mismatch for ${checkedIn.id}`);
  }
  if (typeof override.prompt !== 'function') throw new TypeError(`runtime contract override prompt is invalid for ${checkedIn.id}`);
  if (
    !request.effectiveConfigDigest
    || override.effectiveConfig?.digest !== request.effectiveConfigDigest
    || override.effectiveConfig?.revision !== request.effectiveConfigRevision
  ) {
    throw new TypeError(`runtime contract override revision mismatch for ${checkedIn.id}`);
  }
  const effectiveTools = runtimeToolNames(checkedIn, {
    toolAllow: Array.isArray(override.toolPolicy?.allow) ? override.toolPolicy.allow : [],
  });
  return {
    ...checkedIn,
    displayName: override.displayName,
    purpose: override.purpose,
    visibility: override.visibility,
    prompt: override.prompt,
    toolPolicy: { ...checkedIn.toolPolicy, allow: effectiveTools },
    assignedSkills: override.assignedSkills,
    effectiveConfig: override.effectiveConfig,
  };
}

export class PiAgentBackend extends AgentBackend {
  constructor({
    contractResolver,
    modelRouter = new ModelRouter(),
    toolAdapter = createPiTools,
    outputGate = new OutputGate({ schemaResolver: getAgentSchema }),
    contractEnforcer = new ContractEnforcer({ outputGate }),
    agentFactory = (options) => new Agent(options),
    now = Date.now,
    onEvent = null,
    onAudit = null,
    contextManager = new ContextManager(),
    toolRegistry = authoritativeToolRegistry,
    executeTool = runTool,
    usageRecorder = process.env.NODE_TEST_CONTEXT ? null : recordModelUsage,
  } = {}) {
    super();
    if (typeof contractResolver !== 'function') throw new TypeError('PiAgentBackend requires a contractResolver');
    if (!modelRouter || typeof modelRouter.resolve !== 'function') throw new TypeError('PiAgentBackend requires a ModelRouter');
    if (!contextManager || typeof contextManager.preflight !== 'function') throw new TypeError('PiAgentBackend requires a ContextManager');
    if (typeof executeTool !== 'function') throw new TypeError('PiAgentBackend executeTool must be a function');
    if (usageRecorder !== null && typeof usageRecorder !== 'function') throw new TypeError('PiAgentBackend usageRecorder must be a function or null');
    if (onAudit !== null && typeof onAudit !== 'function') throw new TypeError('PiAgentBackend onAudit must be a function');
    this.contractResolver = contractResolver;
    this.modelRouter = modelRouter;
    this.toolAdapter = toolAdapter;
    this.outputGate = outputGate;
    this.contractEnforcer = contractEnforcer;
    this.agentFactory = agentFactory;
    this.now = now;
    this.onEvent = onEvent;
    this.onAudit = onAudit;
    this.contextManager = contextManager;
    this.toolRegistry = toolRegistry;
    this.executeTool = executeTool;
    this.usageRecorder = usageRecorder;
    this.active = new Map();
  }

  async cancel(runId, nodeId) {
    const active = this.active.get(keyFor(runId, nodeId));
    if (!active) return false;
    active.requestStop?.('cancelled', { hard: true });
    return true;
  }

  async run(value, runtime = {}) {
    const request = createAgentRunRequest(value);
    const checkedInContract = this.contractResolver(request.agentContractId);
    if (checkedInContract.version !== request.contractVersion) {
      throw new Error(`contract version mismatch for ${checkedInContract.id}: request=${request.contractVersion}, registry=${checkedInContract.version}`);
    }
    const contract = effectiveRuntimeContract(checkedInContract, request, runtime);
    this.contextManager.preflight(request, contract);
    const prompt = contract.prompt(request.input);
    if (!prompt || typeof prompt.system !== 'string' || typeof prompt.user !== 'string') {
      throw new TypeError(`contract ${contract.id} prompt must return {system,user}`);
    }

    const startedAt = this.now();
    const resolved = this.modelRouter.resolve(contract.modelPolicy, {
      ...runtime,
      agentContractId: request.agentContractId,
    });
    const routeTruth = executionTruthForRoute(resolved);
    const controller = new RunPolicyController({
      ...contract.runPolicy,
      maxTurns: runtime.maxTurns ?? contract.runPolicy.maxTurns,
      softTurnLimit: runtime.softTurnLimit,
      deadlineMs: runtime.deadlineMs ?? contract.runPolicy.deadlineMs,
      finalizeReserveMs: runtime.finalizeReserveMs,
      tokenBudget: runtime.tokenBudget ?? contract.runPolicy.tokenBudget,
      toolCallBudget: runtime.toolCallBudget ?? contract.runPolicy.toolCallBudget,
      maxCostUsd: runtime.maxCostUsd ?? contract.runPolicy.maxCostUsd,
      costKnown: routeTruth.costKnown,
    }, { now: this.now });
    const collector = new PiEventAdapter({ request, contract, now: this.now, onEvent: runtime.onEvent || this.onEvent });
    const runAbortController = new AbortController();
    let resolveHardBoundary;
    let hardBoundarySettled = false;
    let acceptingEvents = true;
    const hardBoundary = new Promise((resolve) => { resolveHardBoundary = resolve; });
    const active = { agent: null, stopReason: null, requestStop: null };
    const requestStop = (reason, { hard = false } = {}) => {
      const current = active.stopReason;
      if (!current || reason === 'deadline' || (reason === 'cancelled' && current !== 'deadline')) {
        active.stopReason = reason;
      }
      if (!runAbortController.signal.aborted) runAbortController.abort(active.stopReason || reason);
      active.agent?.abort?.();
      if (hard && !hardBoundarySettled) {
        hardBoundarySettled = true;
        resolveHardBoundary({ completed: false, reason: active.stopReason || reason });
      }
      return current !== active.stopReason;
    };
    active.requestStop = requestStop;
    const setPolicyStop = async (reason) => {
      const changed = requestStop(reason);
      if (changed && reason.endsWith('budget') && acceptingEvents) {
        await collector.emit('budget.exhausted', { reason, ...controller.report() });
      }
    };
    const externalAudit = runtime.onAudit || this.onAudit;
    const gateway = new ToolGateway({
      request,
      contract,
      registry: this.toolRegistry,
      executeTool: (name, args, { signal } = {}) => this.executeTool(name, args, { signal }),
      beforeExecute: runtime.beforeToolExecution || null,
      reserveTool: () => controller.reserveTool(),
      signal: runAbortController.signal,
      audit: async (record) => {
        if (!acceptingEvents) return;
        const payload = { ...record };
        delete payload.eventType;
        delete payload.schemaVersion;
        await collector.emit(record.eventType, payload);
        if (record.reason === 'tool-call-budget-exhausted') await setPolicyStop('tool-budget');
        await externalAudit?.(record);
      },
      toolCallBudget: runtime.toolCallBudget ?? contract.runPolicy.toolCallBudget,
    });
    const tools = this.toolAdapter({
      toolNames: runtimeToolNames(contract, runtime),
      toolRegistry: typeof this.toolRegistry.toObject === 'function' ? this.toolRegistry.toObject() : this.toolRegistry,
      executeTool: gateway.execute,
      projectId: request.projectId,
      request,
      contract,
      signal: runAbortController.signal,
    });

    const retryPolicy = modelApiRetryPolicy(runtime);
    let modelApiAttempts = 0;
    const completedModelApiAttempts = new Set();
    const recordModelApiAttempt = (event) => {
      if (typeof runtime.onModelApiAttempt !== 'function') return;
      const result = runtime.onModelApiAttempt(Object.freeze({
        ...event,
        maxAttempts: retryPolicy.maxAttempts,
      }));
      result?.catch?.(() => {});
    };
    const completeModelApiAttempt = (attempt, { message = null, error = null, status = null } = {}) => {
      if (completedModelApiAttempts.has(attempt)) return;
      const failure = error ? promptFailure(error) : modelFailure(message);
      completedModelApiAttempts.add(attempt);
      recordModelApiAttempt({
        phase: 'completed',
        attempt,
        status: status || (message?.stopReason === 'aborted' ? 'interrupted' : (failure ? 'failed' : 'succeeded')),
        code: failure?.code || null,
        statusCode: failure?.statusCode || null,
      });
    };
    const auditedModelStream = (stream, attempt) => new Proxy(stream, {
      get(target, property, _receiver) {
        if (property === 'result') {
          return async () => {
            try {
              const message = await target.result();
              completeModelApiAttempt(attempt, { message });
              return message;
            } catch (error) {
              completeModelApiAttempt(attempt, { error });
              throw error;
            }
          };
        }
        if (property === Symbol.asyncIterator) {
          return async function* auditedIterator() {
            let terminalEventObserved = false;
            try {
              for await (const event of target) {
                if (event?.type === 'done' || event?.type === 'error') {
                  terminalEventObserved = true;
                  completeModelApiAttempt(attempt, {
                    message: event.type === 'done' ? event.message : event.error,
                  });
                }
                yield event;
              }
            } catch (error) {
              completeModelApiAttempt(attempt, { error });
              throw error;
            } finally {
              if (!terminalEventObserved) completeModelApiAttempt(attempt, { status: 'interrupted' });
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const auditedStreamFn = (...args) => {
      if (resolved.provider === DEMO_PROVIDER_ID) return resolved.streamFn(...args);
      if (runtime.kind === 'canonical-worldview' && modelApiAttempts >= retryPolicy.maxAttempts) {
        const error = new Error(`Model API attempt limit exhausted: ${retryPolicy.maxAttempts}`);
        error.code = 'MODEL_API_ATTEMPTS_EXHAUSTED';
        throw error;
      }
      modelApiAttempts += 1;
      const attempt = modelApiAttempts;
      recordModelApiAttempt({ phase: 'started', attempt });
      try {
        const stream = resolved.streamFn(...args);
        if (typeof stream?.then === 'function') {
          return stream.then(
            (resolvedStream) => {
              try {
                return auditedModelStream(resolvedStream, attempt);
              } catch (error) {
                completeModelApiAttempt(attempt, { error });
                throw error;
              }
            },
            (error) => {
              completeModelApiAttempt(attempt, { error });
              throw error;
            },
          );
        }
        return auditedModelStream(stream, attempt);
      } catch (error) {
        completeModelApiAttempt(attempt, { error });
        throw error;
      }
    };
    const agent = this.agentFactory({
      initialState: {
        systemPrompt: prompt.system,
        model: resolved.model,
        thinkingLevel: thinkingLevel(resolved.reasoningLevel),
        tools,
        messages: [],
      },
      streamFn: auditedStreamFn,
      sessionId: resolved.provider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? agentPromptCacheSessionId(request)
        : undefined,
      toolExecution: 'parallel',
    });
    active.agent = agent;
    const activeKey = keyFor(request.runId, request.nodeId);
    this.active.set(activeKey, active);

    const unsubscribe = agent.subscribe(async (event) => {
      if (!acceptingEvents) return;
      await collector.accept(event);
      if (event.type !== 'turn_end') return;
      const decision = controller.observeTurn(event.message);
      if (decision.warning) {
        await collector.emit('budget.warning', { dimension: decision.warning, ...controller.report() });
        if (typeof agent.steer === 'function') {
          agent.steer({ role: 'user', content: 'Approaching the run limit. Stop gathering and produce the final output now.', timestamp: this.now() });
        }
      }
      if (decision.stopReason) {
        await setPolicyStop(decision.stopReason);
      }
    });

    const deadlineMs = controller.deadlineMs;
    const timer = deadlineMs > 0 ? setTimeout(() => requestStop('deadline', { hard: true }), controller.remainingMs()) : null;
    const softDelayMs = controller.softDeadlineDelayMs();
    const softTimer = deadlineMs > 0 && softDelayMs > 0 && softDelayMs < controller.remainingMs()
      ? setTimeout(() => {
        if (active.stopReason || !acceptingEvents) return;
        void collector.emit('budget.warning', { dimension: 'wall-clock', ...controller.report() }).catch(() => {});
        if (typeof agent.steer === 'function') {
          agent.steer({ role: 'user', content: 'Approaching the hard run deadline. Stop gathering and produce the final output now.', timestamp: this.now() });
        }
      }, softDelayMs)
      : null;
    const abortListener = () => {
      requestStop('cancelled', { hard: true });
    };
    runtime.signal?.addEventListener?.('abort', abortListener, { once: true });
    if (runtime.signal?.aborted) requestStop('cancelled', { hard: true });

    const promptWithinBoundary = async (text) => {
      const attemptsBeforePrompt = modelApiAttempts;
      const promptPromise = Promise.resolve().then(() => agent.prompt(text));
      const outcome = await Promise.race([
        promptPromise.then(
          () => ({ completed: true, error: null }),
          (error) => ({ completed: true, error: promptFailure(error) }),
        ),
        hardBoundary,
      ]);
      let syntheticAttempt = null;
      if (modelApiAttempts === attemptsBeforePrompt) {
        modelApiAttempts += 1;
        syntheticAttempt = modelApiAttempts;
        recordModelApiAttempt({ phase: 'started', attempt: syntheticAttempt, syntheticTestBoundary: true });
      }
      if (syntheticAttempt !== null) {
        completeModelApiAttempt(syntheticAttempt, {
          message: assistantText(agent.state.messages).message,
          error: outcome.error,
          status: !outcome.completed || active.stopReason ? 'interrupted' : null,
        });
      }
      if (outcome.error) {
        for (let attempt = attemptsBeforePrompt + 1; attempt <= modelApiAttempts; attempt += 1) {
          completeModelApiAttempt(attempt, { error: outcome.error });
        }
      }
      if (!outcome.completed) {
        for (let attempt = attemptsBeforePrompt + 1; attempt <= modelApiAttempts; attempt += 1) {
          completeModelApiAttempt(attempt, { status: 'interrupted' });
        }
        promptPromise.catch(() => {});
      }
      if (outcome.error) throw outcome.error;
      return outcome.completed;
    };
    const sleepWithinBoundary = async (ms) => {
      if (ms <= 0) return true;
      let timerId;
      const sleep = new Promise((resolve) => {
        timerId = setTimeout(() => resolve({ completed: true }), ms);
      });
      const outcome = await Promise.race([sleep, hardBoundary]);
      clearTimeout(timerId);
      return outcome.completed === true;
    };
    const readOnlyWorldviewRetryTrace = (calls) => calls.length > 0 && calls.every((call) => {
      const tool = registryTool(this.toolRegistry, call.tool);
      return call.ok === true
        && String(call.tool || '').startsWith('worldview_')
        && tool?.provider === 'worldview'
        && tool?.effect?.type === 'read';
    });
    const promptWithModelApiRetry = async (text) => {
      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        const traceStart = collector.trace().length;
        let completed;
        let failure = null;
        try {
          completed = await promptWithinBoundary(text);
        } catch (error) {
          failure = promptFailure(error);
          completed = true;
        }
        if (!failure) {
          const latest = assistantText(agent.state.messages);
          failure = modelFailure(latest.message);
        }
        const attemptTrace = collector.trace().slice(traceStart);
        const retriableWorldviewReads = runtime.kind === 'canonical-worldview'
          && readOnlyWorldviewRetryTrace(attemptTrace);
        const retryable = completed
          && !active.stopReason
          && failure?.transient === true
          && (runtime.kind === 'canonical-worldview'
            ? modelApiAttempts < retryPolicy.maxAttempts
            : attempt < retryPolicy.maxAttempts)
          && (attemptTrace.length === 0 || retriableWorldviewReads);
        if (runtime.kind === 'canonical-worldview') {
          await collector.emit('model.api.attempt.completed', {
            attempt: modelApiAttempts,
            maxAttempts: retryPolicy.maxAttempts,
            status: !completed || active.stopReason ? 'interrupted' : (failure ? 'failed' : 'succeeded'),
            code: failure?.code || null,
            toolCallCount: attemptTrace.length,
            readOnlyWorldviewToolCalls: retriableWorldviewReads,
            willRetry: retryable,
          });
        }
        if (!completed || active.stopReason) return completed;
        if (!retryable) {
          if (failure && !agent.state.messages.length) throw failure;
          return completed;
        }

        const delayMs = Math.min(modelRetryDelayMs(retryPolicy, attempt - 1), controller.remainingMs());
        const retryAttempt = runtime.kind === 'canonical-worldview' ? modelApiAttempts : attempt;
        await collector.emit('model.retrying', {
          attempt: retryAttempt,
          nextAttempt: retryAttempt + 1,
          maxAttempts: retryPolicy.maxAttempts,
          delayMs,
          reason: failure.message,
          code: failure.code || null,
          ...(runtime.kind === 'canonical-worldview' ? {
            toolCallCount: attemptTrace.length,
            retriedAfterReadOnlyWorldviewTools: retriableWorldviewReads,
          } : {}),
        });
        agent.state.messages = [];
        if (!(await sleepWithinBoundary(delayMs))) return false;
      }
      return true;
    };

    try {
      if (!active.stopReason) await promptWithModelApiRetry(prompt.user);
      let latest = assistantText(agent.state.messages);
      let stopReason = canonicalAgentStopReason(active.stopReason || modelStopReason(latest.message));
      const schemaId = contract.completionPolicy.hardChecks.includes('output-schema') ? contract.outputSchema : null;
      const evaluateOutput = (text) => {
        let adaptedOutput;
        let adaptationFailed = false;
        let adaptationErrors = [];
        try {
          adaptedOutput = adaptAgentOutput({ contract, request, text });
        } catch (error) {
          adaptationFailed = true;
          adaptationErrors = adapterValidationErrors(error);
        }
        const evaluated = this.outputGate.evaluate({
          output: adaptationFailed ? undefined : adaptedOutput,
          text,
          schemaId,
          hardChecks: contract.completionPolicy.hardChecks,
        });
        return Object.freeze({
          valid: !adaptationFailed && evaluated.valid,
          output: adaptationFailed ? undefined : evaluated.output,
          errors: Object.freeze([...new Set([...adaptationErrors, ...evaluated.errors])]),
          adaptationFailed,
        });
      };
      let gated = evaluateOutput(latest.text);

      if (!gated.valid
        && !NO_REPAIR_STOPS.has(stopReason)
        && contract.completionPolicy.gracefulFinalize
        && (!gated.adaptationFailed || structuredOutputContract(contract))) {
        const continuation = controller.continuationDecision();
        if (continuation.stopReason) {
          await setPolicyStop(continuation.stopReason);
        } else {
          agent.state.tools = [];
          const repairPrompt = this.outputGate.repairPrompt(gated);
          await promptWithinBoundary(`${repairPrompt}${scorecardClosureRepairGuidance(contract, gated.errors)}`);
          latest = assistantText(agent.state.messages);
          gated = evaluateOutput(latest.text);
        }
      }
      stopReason = canonicalAgentStopReason(active.stopReason || modelStopReason(latest.message));
      if (!gated.valid && stopReason === 'final') stopReason = 'schema-invalid';
      const failure = stopReason === 'error' ? modelFailure(latest.message) : null;

      const artifacts = collector.trace()
        .filter((call) => call.ok && call.artifactPath && registryTool(this.toolRegistry, call.tool)?.effect?.type === 'write')
        .map((call) => ({ path: call.artifactPath, tool: call.tool }));
      const artifactCommitOwner = runtime.artifactCommitOwner || 'agent';
      const enforced = this.contractEnforcer.evaluate({
        contract,
        request,
        output: gated.output,
        text: latest.text,
        artifacts,
        artifactCommitOwner,
      });
      const metrics = {
        ...controller.report(),
        modelApiAttempts,
        modelApiMaxAttempts: retryPolicy.maxAttempts,
      };
      acceptingEvents = false;
      await collector.stop(stopReason, metrics);
      const status = canonicalAgentStatus({
        stopReason,
        valid: enforced.valid,
        outputPresent: enforced.output !== undefined || latest.text !== '',
        budgetExhausted: stopReason.endsWith('budget'),
      });
      const result = createAgentRunResult({
        status,
        output: enforced.output ?? latest.text,
        artifacts,
        evidenceRefs: enforced.output?.evidenceRefs || [],
        openQuestions: enforced.output?.openQuestions || [],
        dataRequests: enforced.output?.dataRequests || [],
        metrics,
        stopReason,
        traceRef: request.runId,
        text: latest.text,
        provider: resolved.provider,
        model: resolved.modelId,
        live: routeTruth.live,
        valid: enforced.valid,
        errors: [...enforced.errors, ...(failure ? [failure.message] : [])],
        ...(failure ? { error: failure } : {}),
        artifactCommitOwner: enforced.artifactCommitOwner,
        delegatedRequiredArtifacts: [...enforced.delegatedRequiredArtifacts],
        trace: {
          runId: request.runId,
          workspaceMode: runtime.workspaceMode || null,
          ...(Number.isInteger(runtime.workflowAttempt)
            ? { workflowAttempt: runtime.workflowAttempt }
            : {}),
          toolCalls: collector.trace(),
          stopReason,
          modelRoute: resolved,
          budget: metrics,
          startedAt,
          artifactCommitOwner: enforced.artifactCommitOwner,
          delegatedRequiredArtifacts: [...enforced.delegatedRequiredArtifacts],
        },
        events: [...collector.events],
        budgetExhausted: stopReason.endsWith('budget'),
      });
      this.usageRecorder?.({ request, result, startedAt, completedAt: this.now() });
      return result;
    } catch (error) {
      const stopReason = canonicalAgentStopReason(active.stopReason || 'error');
      const metrics = {
        ...controller.report(),
        modelApiAttempts,
        modelApiMaxAttempts: retryPolicy.maxAttempts,
      };
      acceptingEvents = false;
      await collector.stop(stopReason, { ...metrics, error: String(error?.message || error) });
      const result = createAgentRunResult({
        status: canonicalAgentStatus({ stopReason, valid: false, outputPresent: false }),
        output: undefined,
        artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [], metrics, stopReason,
        traceRef: request.runId, text: '', provider: resolved.provider, model: resolved.modelId, live: routeTruth.live,
        valid: false,
        errors: [String(error?.message || error)],
        trace: {
          runId: request.runId,
          workspaceMode: runtime.workspaceMode || null,
          ...(Number.isInteger(runtime.workflowAttempt)
            ? { workflowAttempt: runtime.workflowAttempt }
            : {}),
          toolCalls: collector.trace(),
          stopReason,
        },
        events: [...collector.events], budgetExhausted: stopReason.endsWith('budget'),
        artifactCommitOwner: runtime.artifactCommitOwner || 'agent', delegatedRequiredArtifacts: [], error,
      });
      this.usageRecorder?.({ request, result, startedAt, completedAt: this.now() });
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (softTimer) clearTimeout(softTimer);
      runtime.signal?.removeEventListener?.('abort', abortListener);
      acceptingEvents = false;
      unsubscribe?.();
      this.active.delete(activeKey);
    }
  }
}
