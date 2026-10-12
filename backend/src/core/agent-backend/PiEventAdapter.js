import { createEventEnvelope } from '../contracts/agentContracts.js';
import { sanitizeToolArguments } from '../tools/ToolGateway.js';

function timestamp(now) {
  const value = now();
  return typeof value === 'string' ? value : new Date(value).toISOString();
}

function resultText(result, toolName = '') {
  if (String(toolName).startsWith('worldview_')) return '[REDACTED:run-scoped-worldview-capability]';
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('');
}

export class PiEventAdapter {
  constructor({ request, contract, now = Date.now, onEvent = null } = {}) {
    this.request = request;
    this.contract = contract;
    this.now = now;
    this.onEvent = onEvent;
    this.sequence = 0;
    this.events = [];
    this.toolCalls = [];
    this.started = false;
    this.stopped = false;
  }

  async emit(eventType, payload = {}) {
    const sequence = ++this.sequence;
    const event = createEventEnvelope({
      eventId: `${this.request.runId}:${sequence}`,
      eventType,
      schemaVersion: '1.0.0',
      timestamp: timestamp(this.now),
      sequence,
      correlationId: this.request.workflowId,
      causationId: sequence > 1 ? `${this.request.runId}:${sequence - 1}` : null,
      projectId: this.request.projectId,
      runId: this.request.runId,
      nodeId: this.request.nodeId,
      agentId: this.contract.id,
      payload,
    });
    this.events.push(event);
    try { await this.onEvent?.(event); } catch {}
    return event;
  }

  async accept(event) {
    if (event.type === 'agent_start') {
      if (!this.started) {
        this.started = true;
        await this.emit('agent.started', { contractVersion: this.contract.version });
      }
      return;
    }
    if (event.type === 'tool_execution_start') {
      const args = sanitizeToolArguments(event.args);
      this.toolCalls.push({ id: event.toolCallId, tool: event.toolName, args, ok: null, result: '' });
      await this.emit('tool.started', { toolCallId: event.toolCallId, tool: event.toolName, args });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const call = this.toolCalls.find((item) => item.id === event.toolCallId);
      if (call) {
        call.ok = !event.isError;
        call.result = resultText(event.result, event.toolName);
        if (!event.isError && typeof event.result?.details?.file === 'string') call.artifactPath = event.result.details.file;
      }
      await this.emit(event.isError ? 'tool.failed' : 'tool.completed', {
        toolCallId: event.toolCallId, tool: event.toolName, ok: !event.isError, result: resultText(event.result, event.toolName),
      });
      return;
    }
    if (event.type === 'turn_end') {
      await this.emit('agent.turn.completed', {
        stopReason: event.message?.stopReason || null,
        usage: event.message?.usage || null,
        toolResults: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
      });
    }
  }

  async stop(stopReason, payload = {}) {
    if (this.stopped) return;
    this.stopped = true;
    await this.emit('agent.stopped', { stopReason, ...payload });
  }

  trace() {
    return this.toolCalls.map((call) => ({ ...call }));
  }
}
