import { Type } from '@earendil-works/pi-ai';
import { TOOL_REGISTRY, runTool } from '../../tools/index.js';
import { coerceToolInputForTool } from '../../tools/toolCatalog.js';
import { isToolGatewayExecutor } from '../tools/ToolGateway.js';

function parametersFor(tool) {
  if (tool.inputSchema) return tool.inputSchema;
  const properties = {};
  for (const param of tool.params || []) {
    properties[param.name] = Type.Optional(Type.String({ description: param.label || param.name }));
  }
  return Type.Object(properties, { additionalProperties: false });
}

function textOf(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isWriteTool(tool) {
  return tool.effect?.type === 'write';
}

function schemaParameterNames(tool) {
  return new Set([
    ...Object.keys(tool.inputSchema?.properties || {}),
    ...(tool.params || []).map((param) => param.name),
  ]);
}

function mergeSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length <= 1) return active[0];
  return globalThis.AbortSignal.any(active);
}

export function createPiTools({
  toolNames = [], toolRegistry = TOOL_REGISTRY, executeTool = runTool, projectId = null, signal: runSignal = null,
} = {}) {
  return toolNames.map((name) => {
    const tool = toolRegistry[name];
    if (!tool) throw new Error(`unknown Pi tool: ${name}`);
    const parameterNames = schemaParameterNames(tool);
    return {
      name,
      label: tool.desc || name,
      description: tool.desc || name,
      parameters: parametersFor(tool),
      executionMode: isWriteTool(tool) ? 'sequential' : 'parallel',
      async execute(_toolCallId, params = {}, signal) {
        const effectiveSignal = mergeSignals(runSignal, signal);
        if (effectiveSignal?.aborted) throw new Error(`tool ${name} aborted before execution`);
        const args = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : params;
        const gatewayExecutor = isToolGatewayExecutor(executeTool);
        if (!gatewayExecutor && args && typeof args === 'object' && !Array.isArray(args)) {
          if (projectId && parameterNames.has('currentProjectId')) args.currentProjectId = projectId;
          if (projectId && parameterNames.has('projectId')) args.projectId = projectId;
        }
        const runtimeArgs = gatewayExecutor || !tool.inputSchema
          ? args
          : coerceToolInputForTool(name, tool, args, { requireRuntimeIdentity: true });
        const response = await executeTool(name, runtimeArgs, effectiveSignal);
        if (effectiveSignal?.aborted) throw new Error(`tool ${name} aborted after execution`);
        const details = response?.result ?? response;
        return { content: [{ type: 'text', text: textOf(details) }], details };
      },
    };
  });
}
