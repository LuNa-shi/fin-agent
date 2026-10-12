import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_DIR } from '../../config.js';

const LEDGER_PATH = path.join(MEMORY_DIR, 'model-usage.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const nonnegative = (value) => Math.max(0, finite(value));

function tokenUsage(metrics = {}) {
  return {
    input: nonnegative(metrics.inputTokens),
    output: nonnegative(metrics.outputTokens),
    reasoning: nonnegative(metrics.reasoningTokens),
    cacheRead: nonnegative(metrics.cacheReadTokens),
    cacheWrite: nonnegative(metrics.cacheWriteTokens),
    total: nonnegative(metrics.tokens),
  };
}

function rotate() {
  try {
    if (fs.statSync(LEDGER_PATH).size <= MAX_BYTES) return;
    for (let index = 2; index >= 1; index -= 1) {
      try { fs.renameSync(`${LEDGER_PATH}.${index}`, `${LEDGER_PATH}.${index + 1}`); } catch {}
    }
    fs.renameSync(LEDGER_PATH, `${LEDGER_PATH}.1`);
  } catch {}
}

export function recordModelUsage({ request, result, startedAt = Date.now(), completedAt = Date.now() } = {}) {
  if (!request || !result) return;
  const costKnown = result.metrics?.costKnown === true;
  const record = {
    ts: completedAt,
    startedAt,
    runId: request.runId,
    workflowId: request.workflowId,
    nodeId: request.nodeId,
    agentId: request.agentContractId,
    provider: result.provider || 'unreported',
    model: result.model || 'unreported',
    live: result.live === true,
    status: result.status,
    stopReason: result.stopReason,
    wallMs: Math.max(0, completedAt - startedAt),
    tokenUsage: tokenUsage(result.metrics),
    toolCalls: nonnegative(result.metrics?.toolCalls),
    turns: nonnegative(result.metrics?.turns),
    costKnown,
    costUsd: costKnown ? nonnegative(result.metrics?.costUsd) : null,
  };
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    rotate();
    fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(record)}\n`);
  } catch {
    // Usage telemetry must never change the Agent result.
  }
}

function recordsSince(sinceMs) {
  let lines = [];
  try { lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean); } catch {}
  return lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((record) => record && Number(record.ts) >= sinceMs);
}

function emptyAggregate(extra = {}) {
  return {
    ...extra,
    calls: 0,
    wallMs: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensReasoning: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensTotal: 0,
    toolCalls: 0,
    turns: 0,
    errors: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    costUsd: null,
  };
}

function add(aggregate, record) {
  aggregate.calls += 1;
  aggregate.wallMs += nonnegative(record.wallMs);
  aggregate.tokensInput += nonnegative(record.tokenUsage?.input);
  aggregate.tokensOutput += nonnegative(record.tokenUsage?.output);
  aggregate.tokensReasoning += nonnegative(record.tokenUsage?.reasoning);
  aggregate.tokensCacheRead += nonnegative(record.tokenUsage?.cacheRead);
  aggregate.tokensCacheWrite += nonnegative(record.tokenUsage?.cacheWrite);
  aggregate.tokensTotal += nonnegative(record.tokenUsage?.total);
  aggregate.toolCalls += nonnegative(record.toolCalls);
  aggregate.turns += nonnegative(record.turns);
  if (record.status !== 'succeeded') aggregate.errors += 1;
  if (record.costKnown === true && Number.isFinite(record.costUsd)) {
    aggregate.knownCostCalls += 1;
    aggregate.costUsd = +((aggregate.costUsd || 0) + record.costUsd).toFixed(8);
  } else {
    aggregate.unknownCostCalls += 1;
  }
}

export function modelUsage({ sinceMs = 0 } = {}) {
  const records = recordsSince(Number(sinceMs) || 0);
  const total = emptyAggregate();
  const groups = new Map();
  for (const record of records) {
    add(total, record);
    const key = JSON.stringify([record.agentId, record.provider, record.model]);
    const aggregate = groups.get(key) || emptyAggregate({
      agentId: record.agentId,
      provider: record.provider,
      model: record.model,
    });
    add(aggregate, record);
    groups.set(key, aggregate);
  }
  const finalize = (aggregate) => ({
    ...aggregate,
    costKnown: aggregate.calls > 0 && aggregate.unknownCostCalls === 0,
    costUsd: aggregate.knownCostCalls > 0 ? aggregate.costUsd : null,
  });
  return {
    total: finalize(total),
    byAgent: [...groups.values()]
      .map(finalize)
      .sort((left, right) => right.wallMs - left.wallMs || left.agentId.localeCompare(right.agentId)),
  };
}

export const MODEL_USAGE_LEDGER_PATH = LEDGER_PATH;
