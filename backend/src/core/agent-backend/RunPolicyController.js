const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function usageNumber(usage, keys) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function turnRequiresContinuation(message) {
  return !new Set(['stop', 'aborted', 'error']).has(message?.stopReason);
}

export class RunPolicyController {
  constructor(policy = {}, { now = Date.now } = {}) {
    this.now = now;
    this.startedAt = now();
    this.maxTurns = Math.max(1, numberOr(policy.maxTurns, 10));
    this.softTurnLimit = Math.max(1, Math.min(this.maxTurns, numberOr(policy.softTurnLimit, Math.max(1, this.maxTurns - 1))));
    this.deadlineMs = Math.max(0, numberOr(policy.deadlineMs, 0));
    const defaultFinalizeReserve = this.deadlineMs > 0 ? Math.min(60_000, Math.floor(this.deadlineMs * 0.15)) : 0;
    this.finalizeReserveMs = Math.max(0, Math.min(this.deadlineMs, numberOr(policy.finalizeReserveMs, defaultFinalizeReserve)));
    this.softDeadlineMs = Math.max(0, this.deadlineMs - this.finalizeReserveMs);
    this.tokenBudget = Math.max(0, numberOr(policy.tokenBudget, Infinity));
    this.toolCallBudget = Math.min(256, Math.max(0, numberOr(policy.toolCallBudget, Infinity)));
    this.maxCostUsd = Math.max(0, numberOr(policy.maxCostUsd, Infinity));
    this.costKnown = policy.costKnown !== false;
    this.turns = 0;
    this.toolCalls = 0;
    this.toolAttempts = 0;
    this.toolDenied = 0;
    this.tokens = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.reasoningTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.costUsd = 0;
    this.warned = false;
  }

  observeTurn(message = {}) {
    const usage = message.usage || {};
    this.turns += 1;
    this.tokens += usageNumber(usage, ['totalTokens', 'total']);
    this.inputTokens += usageNumber(usage, ['input', 'inputTokens']);
    this.outputTokens += usageNumber(usage, ['output', 'outputTokens']);
    this.reasoningTokens += usageNumber(usage, ['reasoning', 'reasoningTokens']);
    this.cacheReadTokens += usageNumber(usage, ['cacheRead', 'cacheReadTokens']);
    this.cacheWriteTokens += usageNumber(usage, ['cacheWrite', 'cacheWriteTokens']);
    this.costUsd += numberOr(usage.cost?.total, 0);
    if (this.tokens > this.tokenBudget) return { stopReason: 'token-budget' };
    if (this.costKnown && this.costUsd > this.maxCostUsd) return { stopReason: 'cost-budget' };
    const continuing = turnRequiresContinuation(message);
    if (continuing && this.turns >= this.maxTurns) return { stopReason: 'maxTurns' };
    if (continuing && !this.warned && this.turns >= this.softTurnLimit) {
      this.warned = true;
      return { warning: 'turns' };
    }
    return {};
  }

  continuationDecision() {
    if (this.tokens > this.tokenBudget) return { stopReason: 'token-budget' };
    if (this.costKnown && this.costUsd > this.maxCostUsd) return { stopReason: 'cost-budget' };
    if (this.turns >= this.maxTurns) return { stopReason: 'maxTurns' };
    if (this.checkDeadline()) return { stopReason: 'deadline' };
    return {};
  }

  reserveTool() {
    this.toolAttempts += 1;
    if (this.toolCalls >= this.toolCallBudget) {
      this.toolDenied += 1;
      return { allowed: false, stopReason: 'tool-budget' };
    }
    this.toolCalls += 1;
    return { allowed: true };
  }

  remainingMs() {
    if (this.deadlineMs <= 0) return Infinity;
    return Math.max(0, this.deadlineMs - (this.now() - this.startedAt));
  }

  softDeadlineDelayMs() {
    if (this.deadlineMs <= 0 || this.softDeadlineMs <= 0) return 0;
    return Math.max(0, this.softDeadlineMs - (this.now() - this.startedAt));
  }

  checkDeadline() {
    return this.deadlineMs > 0 && this.now() - this.startedAt >= this.deadlineMs ? 'deadline' : null;
  }

  report() {
    return Object.freeze({
      turns: this.turns,
      toolCalls: this.toolCalls,
      toolAttempts: this.toolAttempts,
      toolDenied: this.toolDenied,
      tokens: this.tokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      costUsd: this.costKnown ? +this.costUsd.toFixed(8) : null,
      costKnown: this.costKnown,
      wallMs: Math.max(0, this.now() - this.startedAt),
      deadlineMs: this.deadlineMs,
      finalizeReserveMs: this.finalizeReserveMs,
      toolCallSafetyLimit: this.toolCallBudget,
    });
  }
}
