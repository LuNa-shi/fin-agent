import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentExecutionRuntime } from '../src/agents/AgentExecutionRuntime.js';
import { runDefinedAgent } from '../src/agents/runDefinedAgent.js';
import { AgentResultIdempotencyStore } from '../src/core/agent-backend/AgentResultIdempotencyStore.js';
import { withAgentResultIdempotency } from '../src/core/agent-backend/IdempotentAgentBackend.js';
import { createAgentRunResult } from '../src/core/contracts/agentContracts.js';
import { runWithWorkflowNodeContext } from '../src/core/workflow/WorkflowRunContext.js';

const WORKFLOW_HASH = `sha256:${'a'.repeat(64)}`;

function context(agentBackend, attempt) {
  return {
    workflow: {
      id: 'run-analysis.v1',
      version: '1.2.0',
      hash: WORKFLOW_HASH,
    },
    run: {
      runId: 'artifact-run-proj_test-1',
      projectId: 'proj_test',
      asOf: '2026-07-16T00:00:00.000Z',
    },
    node: {
      nodeId: 'plan-research',
      attempt,
    },
    inputs: {
      artifactRefs: [],
      priorReviewIssues: [],
      workspaceSnapshotId: 'proj_test:run:artifact-run-proj_test-1',
    },
    services: {
      agentRuntime: agentExecutionRuntime,
      agentBackend,
    },
    signal: null,
  };
}

test('Workflow Agent identities are retry-stable, input-sensitive, and conflict-safe', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workflow-agent-idem-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const requests = [];
  const rawBackend = {
    async run(request) {
      requests.push(request);
      return createAgentRunResult({
        status: 'succeeded',
        output: { logic: 'supply' },
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: { turns: 1, toolCalls: 0 },
        stopReason: 'final',
        traceRef: request.runId,
      });
    },
  };
  const agentBackend = withAgentResultIdempotency(rawBackend, {
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const scopedRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workflow-agent-idem-scoped-'));
  t.after(() => fs.rmSync(scopedRootDir, { recursive: true, force: true }));
  const narrowerAgentBackend = withAgentResultIdempotency(agentBackend, {
    store: new AgentResultIdempotencyStore({ rootDir: scopedRootDir }),
  });
  assert.notEqual(narrowerAgentBackend, agentBackend);
  assert.equal(narrowerAgentBackend.backend, rawBackend);
  const input = {
    theme: 'HBM',
    rationale: 'supply',
    tickers: ['NVDA'],
    templatePrompt: 'semi',
  };

  await runWithWorkflowNodeContext(
    context(agentBackend, 1),
    () => runDefinedAgent('analysis-plan', input),
  );
  await runWithWorkflowNodeContext(
    context(agentBackend, 2),
    () => runDefinedAgent('analysis-plan', input),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].idempotencyKeyMode, 'explicit');
  assert.match(
    requests[0].idempotencyKey,
    /^artifact-run-proj_test-1:plan-research:analysis-plan:[a-f0-9]{64}$/u,
  );

  await runWithWorkflowNodeContext(
    context(agentBackend, 3),
    () => runDefinedAgent('analysis-plan', { ...input, theme: 'HBM2' }),
  );
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);

  await runWithWorkflowNodeContext(
    context(agentBackend, 4),
    () => runDefinedAgent('analysis-plan', input, { callId: 'fixed-slot' }),
  );
  await assert.rejects(
    runWithWorkflowNodeContext(
      context(agentBackend, 5),
      () => runDefinedAgent('analysis-plan', { ...input, theme: 'HBM3' }, {
        callId: 'fixed-slot',
      }),
    ),
    (error) => error?.code === 'AGENT_RESULT_IDEMPOTENCY_CONFLICT',
  );

  await runWithWorkflowNodeContext(
    context(agentBackend, 6),
    () => runDefinedAgent('analysis-plan', { ...input, theme: 'HBM3' }, {
      callId: 'next-slot',
    }),
  );
  assert.equal(requests.length, 4);
  assert.notEqual(requests[2].idempotencyKey, requests[3].idempotencyKey);
});
