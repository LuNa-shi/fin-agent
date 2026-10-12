import { matchesAnyPathPattern, normalizeSafeRelativePath } from '../policy/pathPolicy.js';
import { coerceToolInputForTool } from '../../tools/toolCatalog.js';

const GATEWAY_EXECUTOR = Symbol('FinAgent.ToolGatewayExecutor');
const SENSITIVE_KEY = /(api[-_]?key|authorization|bearer|cookie|password|secret|session|token|scope[-_]?id)/iu;
const PAYLOAD_KEY = /^(body|content|messages|newText|oldText|payload|prompt|providerPayload|raw)$/iu;

export const TOOL_DENIAL_REASONS = Object.freeze({
  UNKNOWN: 'tool-not-registered',
  DENY: 'tool-explicitly-denied',
  ALLOW: 'tool-not-allowed',
  EXTERNAL: 'external-retrieval-denied',
  PROJECT_MOUNT: 'project-mount-required',
  PROJECT_IDENTITY: 'project-identity-mismatch',
  CROSS_PROJECT: 'cross-project-read-denied',
  UNSAFE_PATH: 'unsafe-tool-path',
  CATALOG_PATH: 'catalog-write-path-denied',
  WRITE_SCOPE: 'write-scope-denied',
  TOOL_BUDGET: 'tool-call-budget-exhausted',
  TEMPORAL_INVALID: 'temporal-argument-invalid',
  TEMPORAL_FUTURE: 'temporal-argument-after-as-of',
});

export class ToolPermissionError extends Error {
  constructor(toolName, reason, auditRecord = null) {
    super(`Tool permission denied [${reason}]: ${toolName}`);
    this.name = 'ToolPermissionError';
    this.code = 'TOOL_PERMISSION_DENIED';
    this.toolName = toolName;
    this.reason = reason;
    this.auditRecord = auditRecord;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function scrubString(value) {
  const withoutBearer = value.replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]');
  const withoutQuerySecrets = withoutBearer.replace(/([?&](?:api[-_]?key|key|secret|token)=)[^&\s]*/giu, '$1[REDACTED]');
  return withoutQuerySecrets.length > 240 ? `${withoutQuerySecrets.slice(0, 240)}…` : withoutQuerySecrets;
}

function payloadLength(value) {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return 'unknown';
  }
}

function sanitizeValue(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (PAYLOAD_KEY.test(key)) {
    return `[REDACTED:${payloadLength(value)}]`;
  }
  if (depth >= 4) return '[REDACTED:depth]';
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, '', depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.keys(value).sort().slice(0, 40).map((childKey) => [
    childKey,
    sanitizeValue(value[childKey], childKey, depth + 1),
  ]));
}

export function sanitizeToolArguments(args) {
  return deepFreeze(sanitizeValue(args && typeof args === 'object' ? args : { value: args }));
}

function registryTool(registry, name) {
  try {
    if (typeof registry?.get === 'function') return registry.get(name);
    return registry?.[name] || null;
  } catch {
    return null;
  }
}

function calendarDay(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/u);
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year * 10_000 + month * 100 + day;
}

function requestCalendarDay(asOf) {
  const date = new Date(asOf);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function projectRegistryView(registry) {
  return typeof registry?.toObject === 'function' ? registry.toObject() : registry;
}

function abortError(reason = 'run aborted') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'RUN_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(typeof signal.reason === 'string' ? signal.reason : 'run aborted');
}

export function isToolGatewayExecutor(value) {
  return !!value?.[GATEWAY_EXECUTOR];
}

export class ToolGateway {
  constructor({
    request,
    contract,
    registry,
    executeTool,
    audit = null,
    beforeExecute = null,
    toolCallBudget,
    reserveTool = null,
    signal = null,
  } = {}) {
    if (!request || typeof request !== 'object') throw new TypeError('ToolGateway requires an AgentRunRequest');
    if (!contract || typeof contract !== 'object') throw new TypeError('ToolGateway requires a resolved contract');
    if (!registry || (typeof registry.get !== 'function' && typeof registry !== 'object')) {
      throw new TypeError('ToolGateway requires an authoritative registry');
    }
    if (typeof executeTool !== 'function') throw new TypeError('ToolGateway requires a raw executeTool seam');
    if (audit !== null && typeof audit !== 'function') throw new TypeError('ToolGateway audit must be a function');
    if (beforeExecute !== null && typeof beforeExecute !== 'function') {
      throw new TypeError('ToolGateway beforeExecute must be a function');
    }
    if (reserveTool !== null && typeof reserveTool !== 'function') throw new TypeError('ToolGateway reserveTool must be a function');
    this.request = request;
    this.contract = contract;
    this.registry = registry;
    this.registryView = projectRegistryView(registry);
    this.rawExecuteTool = executeTool;
    this.audit = audit;
    this.beforeExecute = beforeExecute;
    this.reserveToolCall = reserveTool;
    this.signal = signal;
    const configuredBudget = toolCallBudget ?? contract.runPolicy?.toolCallBudget;
    const numericBudget = (typeof configuredBudget === 'number' || (typeof configuredBudget === 'string' && configuredBudget.trim()))
      ? Number(configuredBudget)
      : Number.NaN;
    this.toolCallBudget = Number.isFinite(numericBudget) ? Math.max(0, Math.floor(numericBudget)) : 0;
    this.toolCalls = 0;
    this.toolAttempts = 0;
    this.toolDenied = 0;
    this.execute = this.execute.bind(this);
    Object.defineProperty(this.execute, GATEWAY_EXECUTOR, { value: true });
  }

  usage() {
    return Object.freeze({
      toolCalls: this.toolCalls,
      toolAttempts: this.toolAttempts,
      toolDenied: this.toolDenied,
      toolCallBudget: this.toolCallBudget,
    });
  }

  async deny(toolName, reason, args) {
    const record = deepFreeze({
      schemaVersion: '1.0.0',
      eventType: 'tool.permission.denied',
      runId: this.request.runId,
      workflowId: this.request.workflowId,
      nodeId: this.request.nodeId,
      agent: this.contract.id || this.request.agentContractId,
      projectId: this.request.projectId,
      tool: toolName,
      reason,
      sanitizedArgs: sanitizeToolArguments(args),
    });
    const error = new ToolPermissionError(toolName, reason, record);
    try {
      await this.audit?.(record);
    } catch (auditError) {
      error.auditError = auditError;
    }
    throw error;
  }

  async authorizeProject(toolName, tool, originalArgs, effectiveArgs) {
    const project = tool.effect?.project || {};
    if (project.scope === 'none' && tool.provider !== 'workspace') return;
    if (!this.contract.contextPolicy?.mounts?.includes('/project')) {
      await this.deny(toolName, TOOL_DENIAL_REASONS.PROJECT_MOUNT, originalArgs);
    }
    if (typeof this.request.projectId !== 'string' || !this.request.projectId.trim() || this.request.projectId === 'global') {
      await this.deny(toolName, TOOL_DENIAL_REASONS.PROJECT_IDENTITY, originalArgs);
    }

    for (const parameter of project.identityParams || []) {
      const supplied = effectiveArgs[parameter];
      if (supplied === undefined || supplied === null || String(supplied).trim() === '') {
        effectiveArgs[parameter] = this.request.projectId;
        continue;
      }
      if (parameter === 'currentProjectId' && supplied !== this.request.projectId) {
        await this.deny(toolName, TOOL_DENIAL_REASONS.PROJECT_IDENTITY, originalArgs);
      }
      if (parameter === 'projectId' && project.scope === 'current' && supplied !== this.request.projectId) {
        await this.deny(toolName, TOOL_DENIAL_REASONS.PROJECT_IDENTITY, originalArgs);
      }
    }

    if (project.access === 'project-library-read' && this.contract.contextPolicy.allowCrossProjectRead !== true) {
      await this.deny(toolName, TOOL_DENIAL_REASONS.CROSS_PROJECT, originalArgs);
    }
    if (project.access === 'project-file-read') {
      const targetProjectId = effectiveArgs.projectId || this.request.projectId;
      if (targetProjectId !== this.request.projectId && this.contract.contextPolicy.allowCrossProjectRead !== true) {
        await this.deny(toolName, TOOL_DENIAL_REASONS.CROSS_PROJECT, originalArgs);
      }
    }
  }

  async authorizePath(toolName, tool, originalArgs, effectiveArgs) {
    const pathPolicy = tool.effect?.path;
    const parameter = pathPolicy?.param;
    if (!parameter) return;
    if (effectiveArgs[parameter] === undefined || effectiveArgs[parameter] === null || effectiveArgs[parameter] === '') {
      const defaultPath = tool.inputSchema?.properties?.[parameter]?.default;
      if (defaultPath !== undefined) effectiveArgs[parameter] = defaultPath;
    }
    const safePath = normalizeSafeRelativePath(effectiveArgs[parameter]);
    if (!safePath) await this.deny(toolName, TOOL_DENIAL_REASONS.UNSAFE_PATH, originalArgs);
    effectiveArgs[parameter] = safePath;
    if (tool.effect?.type !== 'write') return;

    const catalogPrefixes = pathPolicy.writablePrefixes || [];
    if (catalogPrefixes.length && !catalogPrefixes.some((prefix) => safePath.startsWith(prefix))) {
      await this.deny(toolName, TOOL_DENIAL_REASONS.CATALOG_PATH, originalArgs);
    }
    if (!matchesAnyPathPattern(safePath, this.contract.toolPolicy.writeScopes)) {
      await this.deny(toolName, TOOL_DENIAL_REASONS.WRITE_SCOPE, originalArgs);
    }
  }

  async authorizeTemporal(toolName, originalArgs) {
    if (!originalArgs || typeof originalArgs !== 'object' || Array.isArray(originalArgs)) return;
    const asOfDay = requestCalendarDay(this.request.asOf);
    for (const parameter of ['afterDate', 'beforeDate']) {
      if (!Object.hasOwn(originalArgs, parameter) || originalArgs[parameter] === '') continue;
      const day = calendarDay(originalArgs[parameter]);
      if (day === null) await this.deny(toolName, TOOL_DENIAL_REASONS.TEMPORAL_INVALID, originalArgs);
      if (day > asOfDay) await this.deny(toolName, TOOL_DENIAL_REASONS.TEMPORAL_FUTURE, originalArgs);
    }
    if (Object.hasOwn(originalArgs, 'year') && originalArgs.year !== '') {
      const year = Number(originalArgs.year);
      if (!Number.isInteger(year)) await this.deny(toolName, TOOL_DENIAL_REASONS.TEMPORAL_INVALID, originalArgs);
      if (year > new Date(this.request.asOf).getUTCFullYear()) {
        await this.deny(toolName, TOOL_DENIAL_REASONS.TEMPORAL_FUTURE, originalArgs);
      }
    }
  }

  async execute(toolName, args = {}, signal = this.signal) {
    throwIfAborted(signal);
    const tool = registryTool(this.registryView, toolName);
    if (!tool) await this.deny(toolName, TOOL_DENIAL_REASONS.UNKNOWN, args);
    const policy = this.contract.toolPolicy || {};
    if ((policy.deny || []).includes(toolName)) await this.deny(toolName, TOOL_DENIAL_REASONS.DENY, args);
    if (!(policy.allow || []).includes(toolName)) await this.deny(toolName, TOOL_DENIAL_REASONS.ALLOW, args);
    if (tool.effect?.retrieval?.external && !['targeted', 'full'].includes(policy.externalRetrieval)) {
      await this.deny(toolName, TOOL_DENIAL_REASONS.EXTERNAL, args);
    }

    const originalArgs = args;
    let effectiveArgs = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : args;
    if (effectiveArgs && typeof effectiveArgs === 'object' && !Array.isArray(effectiveArgs)) {
      await this.authorizeProject(toolName, tool, originalArgs, effectiveArgs);
      await this.authorizePath(toolName, tool, originalArgs, effectiveArgs);
      await this.authorizeTemporal(toolName, originalArgs);
    }
    effectiveArgs = coerceToolInputForTool(toolName, tool, effectiveArgs, { requireRuntimeIdentity: true });
    const executionAuthorization = this.beforeExecute?.({
      toolName,
      tool,
      args: effectiveArgs,
      request: this.request,
      contract: this.contract,
    });
    if (executionAuthorization && typeof executionAuthorization.then === 'function') {
      await executionAuthorization;
    }
    this.toolAttempts += 1;
    const reservation = this.reserveToolCall
      ? this.reserveToolCall({ toolName, args: effectiveArgs })
      : { allowed: this.toolCalls < this.toolCallBudget, stopReason: 'tool-budget' };
    if (!reservation?.allowed) {
      this.toolDenied += 1;
      await this.deny(toolName, TOOL_DENIAL_REASONS.TOOL_BUDGET, originalArgs);
    }
    this.toolCalls += 1;
    throwIfAborted(signal);
    const result = await this.rawExecuteTool(toolName, effectiveArgs, { signal });
    throwIfAborted(signal);
    return result;
  }
}
