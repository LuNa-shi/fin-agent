import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('model usage ledger aggregates wall-clock, tokens, tools, turns, and unknown cost honestly', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'finagent-model-usage-'));
  const previous = process.env.FIN_DATA_DIR;
  process.env.FIN_DATA_DIR = dataDir;
  try {
    const { modelUsage, recordModelUsage } = await import(`../src/core/models/modelUsageLedger.js?test=${Date.now()}`);
    recordModelUsage({
      request: { runId: 'run-1', workflowId: 'wf', nodeId: 'node-a', agentContractId: 'agent-a' },
      result: {
        provider: 'gpt-gateway', model: 'luna', live: true, status: 'succeeded', stopReason: 'final',
        metrics: {
          inputTokens: 100, outputTokens: 20, reasoningTokens: 30, cacheReadTokens: 4,
          cacheWriteTokens: 2, tokens: 156, toolCalls: 3, turns: 2, costKnown: false,
        },
      },
      startedAt: 1_000,
      completedAt: 1_750,
    });
    recordModelUsage({
      request: { runId: 'run-2', workflowId: 'wf', nodeId: 'node-b', agentContractId: 'agent-a' },
      result: {
        provider: 'gpt-gateway', model: 'luna', live: true, status: 'partial', stopReason: 'deadline',
        metrics: {
          inputTokens: 40, outputTokens: 10, tokens: 50, toolCalls: 1, turns: 1,
          costKnown: true, costUsd: 0.25,
        },
      },
      startedAt: 2_000,
      completedAt: 2_500,
    });

    const usage = modelUsage();
    assert.equal(usage.total.calls, 2);
    assert.equal(usage.total.wallMs, 1_250);
    assert.equal(usage.total.tokensTotal, 206);
    assert.equal(usage.total.toolCalls, 4);
    assert.equal(usage.total.turns, 3);
    assert.equal(usage.total.errors, 1);
    assert.equal(usage.total.knownCostCalls, 1);
    assert.equal(usage.total.unknownCostCalls, 1);
    assert.equal(usage.total.costKnown, false);
    assert.equal(usage.total.costUsd, 0.25);
    assert.equal(usage.byAgent.length, 1);
  } finally {
    if (previous === undefined) delete process.env.FIN_DATA_DIR;
    else process.env.FIN_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
