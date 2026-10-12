import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentExecutionRuntime,
  withAgentResultObserver,
} from '../src/agents/AgentExecutionRuntime.js';
import { getAgentDefinition } from '../src/agents/registry.js';
import { IdempotentAgentBackend } from '../src/core/agent-backend/IdempotentAgentBackend.js';
import { PiAgentBackend } from '../src/core/agent-backend/PiAgentBackend.js';
import {
  AgentResultIdempotencyStore,
  IDEMPOTENCY_CONFLICT_CODE,
} from '../src/core/agent-backend/AgentResultIdempotencyStore.js';
import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { beginDirectAgentCommand } from '../src/core/contracts/AgentExecutionScope.js';
import { createAgentRunResult } from '../src/core/contracts/agentContracts.js';
import { createDeterministicDemoRoute } from '../src/core/models/deterministicDemo.js';
import {
  currentWorkflowNodeContext,
  runWithWorkflowNodeContext,
} from '../src/core/workflow/WorkflowRunContext.js';

const AS_OF = '2026-07-23T06:00:00.000Z';
const WORKFLOW_HASH = `sha256:${'a'.repeat(64)}`;

function definition({
  id = 'unit-agent',
  allowPriorReview = false,
  artifactSelectors = ['analysis/**'],
  mounts = [],
  toolAllow = [],
  writeScopes = [],
  revision = 'unit-revision-1',
} = {}) {
  return Object.freeze({
    id,
    version: '1.2.3',
    contextPolicy: Object.freeze({
      allowPriorReview,
      artifactSelectors: Object.freeze([...artifactSelectors]),
      mounts: Object.freeze([...mounts]),
    }),
    toolPolicy: Object.freeze({
      allow: Object.freeze([...toolAllow]),
      writeScopes: Object.freeze([...writeScopes]),
    }),
    effectiveConfig: Object.freeze({
      revision,
      digest: canonicalSha256({ id, revision }),
    }),
  });
}

function succeeded(label = 'ok') {
  return createAgentRunResult({
    status: 'succeeded',
    output: { label },
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 },
    stopReason: 'final',
    traceRef: `trace-${label}`,
  });
}

function failed(label = 'failed') {
  return createAgentRunResult({
    status: 'failed',
    output: null,
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 },
    stopReason: label,
    traceRef: `trace-${label}`,
  });
}

function recordingBackend({
  result = succeeded(),
  onRun = null,
  cancelResult = false,
} = {}) {
  const calls = [];
  const cancellations = [];
  return {
    calls,
    cancellations,
    async run(request, runtime = {}) {
      const call = { request, runtime: { ...runtime } };
      calls.push(call);
      if (onRun) await onRun(call);
      return typeof result === 'function' ? result(call) : result;
    },
    async cancel(runId, nodeId) {
      cancellations.push({ runId, nodeId });
      return typeof cancelResult === 'function'
        ? cancelResult(runId, nodeId)
        : cancelResult;
    },
  };
}

function executionRuntime({ agentDefinition = definition(), backend, onResolveBackend = null } = {}) {
  return new AgentExecutionRuntime({
    definitionResolver(agentId) {
      assert.equal(agentId, agentDefinition.id);
      return agentDefinition;
    },
    backendResolver() {
      if (onResolveBackend) onResolveBackend();
      return backend;
    },
  });
}

function directScope({
  commandId = 'command-1',
  workflowId = 'direct-unit.v1',
  nodeId = 'run-unit-agent',
  projectId = 'global',
  asOf = AS_OF,
  signal,
} = {}) {
  const options = {
    commandId,
    workflowId,
    nodeId,
    projectId,
    asOf,
    workspaceMode: 'none',
  };
  if (signal !== undefined) options.signal = signal;
  return beginDirectAgentCommand(options);
}

function workflowContext({
  agentRuntime = null,
  agentBackend = null,
  runId = 'workflow-run-1',
  projectId = 'proj_1',
  scope = { kind: 'project', id: projectId },
  workspaceMode = 'project',
  asOf = AS_OF,
  nodeId = 'analyze',
  attempt = 1,
  artifactRefs = [],
  priorReviewIssues = [],
  workspaceSnapshotId = 'proj_1:snapshot-1',
  signal = null,
} = {}) {
  return {
    workflow: {
      id: 'workflow-unit.v1',
      version: '1.4.0',
      hash: WORKFLOW_HASH,
    },
    run: { runId, projectId, scope, workspaceMode, asOf },
    node: { nodeId, attempt },
    inputs: { artifactRefs, priorReviewIssues, workspaceSnapshotId },
    services: { agentRuntime, agentBackend },
    signal,
  };
}

test('constructs one exact direct AgentRunRequest and separates runtime options', async () => {
  const agentDefinition = definition();
  const backend = recordingBackend();
  let backendResolutions = 0;
  const runtime = executionRuntime({
    agentDefinition,
    backend,
    onResolveBackend: () => { backendResolutions += 1; },
  });
  const input = { ideaIds: ['idea-1', 'idea-2'] };
  const signal = new AbortController().signal;
  const scope = directScope({ signal });

  const result = await runtime.run(agentDefinition.id, input, {
    scope,
    callId: 'ranking-batch-1',
    throwOnFailure: true,
    temperature: 0.2,
    kind: 'ranking',
  });

  const callDigest = canonicalSha256({
    executionScope: {
      runId: scope.runId,
      workflowId: scope.workflowId,
      nodeId: scope.nodeId,
      projectId: scope.projectId,
      asOf: scope.asOf,
      workspaceMode: scope.workspaceMode,
      workspaceSnapshotId: scope.workspaceSnapshotId,
    },
    agentContractId: agentDefinition.id,
    effectiveConfigDigest: agentDefinition.effectiveConfig.digest,
    logicalCall: { callId: 'ranking-batch-1' },
  }).slice('sha256:'.length);
  const identitySuffix = `${agentDefinition.id}:${callDigest}`;
  assert.deepEqual(backend.calls[0].request, {
    runId: `${scope.runId}:${identitySuffix}`,
    workflowId: scope.workflowId,
    nodeId: scope.nodeId,
    projectId: scope.projectId,
    agentContractId: agentDefinition.id,
    contractVersion: agentDefinition.version,
    asOf: scope.asOf,
    input,
    inputArtifactRefs: [],
    workspaceSnapshotId: scope.workspaceSnapshotId,
    priorReviewIssues: [],
    effectiveConfigRevision: agentDefinition.effectiveConfig.revision,
    effectiveConfigDigest: agentDefinition.effectiveConfig.digest,
    idempotencyKey: `${scope.idempotencyKey}:${identitySuffix}`,
    idempotencyKeyMode: 'explicit',
  });
  assert.deepEqual(backend.calls[0].runtime, {
    temperature: 0.2,
    kind: 'ranking',
    artifactCommitOwner: 'agent',
    workspaceMode: 'none',
    projectId: scope.projectId,
    contractOverride: agentDefinition,
    signal,
  });
  assert.equal(result.output.label, 'ok');
  assert.equal(backendResolutions, 1);
});

test('enforces a captured effective Agent configuration digest before backend execution', async () => {
  const agentDefinition = definition();
  const backend = recordingBackend();
  const runtime = executionRuntime({ agentDefinition, backend });
  const scope = directScope();

  await runtime.run(agentDefinition.id, { topic: 'captured' }, {
    scope,
    expectedEffectiveConfigDigest: agentDefinition.effectiveConfig.digest,
  });
  assert.equal(backend.calls.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      backend.calls[0].runtime,
      'expectedEffectiveConfigDigest',
    ),
    false,
  );

  await assert.rejects(
    runtime.run(agentDefinition.id, { topic: 'changed' }, {
      scope,
      expectedEffectiveConfigDigest: canonicalSha256({ changed: true }),
    }),
    (error) => error?.code === 'EFFECTIVE_AGENT_CONFIG_MISMATCH',
  );
  await assert.rejects(
    runtime.run(agentDefinition.id, { topic: 'invalid' }, {
      scope,
      expectedEffectiveConfigDigest: 'not-a-digest',
    }),
    /canonical sha256 digest/u,
  );
  assert.equal(backend.calls.length, 1);
});

test('separate commands differ while replaying one command reproduces request identity', async () => {
  const agentDefinition = definition();
  const backend = recordingBackend();
  const runtime = executionRuntime({ agentDefinition, backend });
  const input = { topic: 'semiconductors' };
  const firstScope = directScope({ commandId: 'command-first' });
  const secondScope = directScope({ commandId: 'command-second' });
  const replayScope = directScope({ commandId: 'command-first' });

  await runtime.run(agentDefinition.id, input, { scope: firstScope });
  await runtime.run(agentDefinition.id, input, { scope: secondScope });
  await runtime.run(agentDefinition.id, input, { scope: replayScope });

  const [first, second, replay] = backend.calls.map((call) => call.request);
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.runId, replay.runId);
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.deepEqual(first, replay);

  await runtime.run(agentDefinition.id, { topic: 'memory' }, { scope: firstScope });
  assert.notEqual(
    backend.calls[0].request.idempotencyKey,
    backend.calls[3].request.idempotencyKey,
  );
});

test('changed input under one direct logical call fails closed in idempotency storage', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-execution-runtime-idem-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const agentDefinition = definition();
  const rawBackend = recordingBackend({ result: succeeded('cached') });
  const backend = new IdempotentAgentBackend({
    backend: rawBackend,
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const runtime = executionRuntime({ agentDefinition, backend });
  const scope = directScope({ commandId: 'command-conflict' });

  await runtime.run(agentDefinition.id, { value: 1 }, {
    scope,
    callId: 'stable-logical-call',
  });
  await assert.rejects(
    runtime.run(agentDefinition.id, { value: 2 }, {
      scope,
      callId: 'stable-logical-call',
    }),
    (error) => error?.code === IDEMPOTENCY_CONFLICT_CODE,
  );
  assert.equal(rawBackend.calls.length, 1);
});

test('rejects request-shaped handler options instead of mixing them into runtime overrides', async () => {
  const agentDefinition = definition();
  const backend = recordingBackend();
  const runtime = executionRuntime({ agentDefinition, backend });
  const scope = directScope();
  const forbiddenFields = [
    'runId',
    'workflowId',
    'nodeId',
    'projectId',
    'agentContractId',
    'contractVersion',
    'asOf',
    'input',
    'inputArtifactRefs',
    'workspaceSnapshotId',
    'priorReviewIssues',
    'effectiveConfigRevision',
    'effectiveConfigDigest',
    'idempotencyKey',
    'idempotencyKeyMode',
    'artifactCommitOwner',
    'costKnown',
    'contractOverride',
    'demo',
    'live',
    'signal',
    'workflowAttempt',
    'workspaceMode',
  ];

  for (const field of forbiddenFields) {
    await assert.rejects(
      runtime.run(agentDefinition.id, {}, {
        scope,
        [field]: field.endsWith('Refs') || field.endsWith('Issues') ? [] : 'forged',
      }),
      new RegExp(`execution scope: ${field}`, 'u'),
      field,
    );
  }
  await assert.rejects(
    runtime.run(agentDefinition.id, {}, { scope, callId: '' }),
    /callId must be a non-empty string/u,
  );
  for (const invalidBackend of [null, false, 0, '']) {
    await assert.rejects(
      runtime.run(agentDefinition.id, {}, { scope, backend: invalidBackend }),
      /agent backend must implement/u,
    );
  }

  const mountedDefinition = definition({
    id: 'mounted-agent',
    mounts: ['/project'],
    toolAllow: ['ws_read_file'],
  });
  const mountedRuntime = executionRuntime({
    agentDefinition: mountedDefinition,
    backend,
  });
  await assert.rejects(
    mountedRuntime.run(mountedDefinition.id, {}, { scope }),
    /requires workspace inputs.*mode is none/u,
  );
  assert.equal(backend.calls.length, 0);
});

test('derives deterministic demo provenance and cost truth from the resolved route', async () => {
  const checkedIn = getAgentDefinition('project-classifier');
  const effectiveConfig = Object.freeze({
    revision: 'demo-route-test',
    digest: canonicalSha256({
      agentId: checkedIn.id,
      revision: 'demo-route-test',
    }),
  });
  const effective = Object.freeze({ ...checkedIn, effectiveConfig });
  const backend = new PiAgentBackend({
    contractResolver: () => checkedIn,
    modelRouter: {
      resolve(modelPolicy, runtime) {
        return createDeterministicDemoRoute({
          runtime,
          contractId: runtime.agentContractId,
          reasoningLevel: modelPolicy.reasoningLevel,
        });
      },
    },
    usageRecorder: null,
  });
  const runtime = new AgentExecutionRuntime({
    definitionResolver: () => effective,
    backendResolver: () => backend,
  });
  const scope = beginDirectAgentCommand({
    commandId: 'demo-route-command',
    workflowId: 'quick-project.v1',
    nodeId: 'classify-project-seed',
    projectId: 'global',
    asOf: AS_OF,
    workspaceMode: 'none',
  });
  const fallback = {
    title: 'Deterministic demo project',
    titleZh: '确定性演示项目',
    theme: 'demo',
    industryTemplate: 'industry_generic',
    companyTemplate: 'company_generic',
    rationale: 'No-network execution provenance regression fixture.',
    tickers: [],
  };

  const result = await runtime.run(checkedIn.id, {
    text: 'deterministic demo',
    industryTemplates: [],
    companyTemplates: [],
  }, {
    scope,
    kind: 'classify',
    fallback,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.provider, 'demo');
  assert.equal(result.live, false);
  assert.equal(result.metrics.costKnown, true);
  assert.equal(result.metrics.costUsd, 0);
  assert.deepEqual(result.output, fallback);
});

test('direct execution applies the same ArtifactRef and prior-review policy as Workflow execution', async () => {
  const agentDefinition = definition({
    allowPriorReview: false,
    artifactSelectors: ['analysis/**'],
    mounts: ['/project'],
  });
  const backend = recordingBackend();
  const runtime = executionRuntime({ agentDefinition, backend });
  const scope = beginDirectAgentCommand({
    commandId: 'direct-policy',
    workflowId: 'direct-policy.v1',
    nodeId: 'run-policy-agent',
    projectId: 'proj_policy',
    asOf: AS_OF,
    workspaceMode: 'project',
    inputArtifactRefs: [
      { artifactId: 'allowed', path: 'analysis/plan.json' },
      { artifactId: 'denied', path: 'report/private.md' },
      { artifactId: 'uri-only', uri: 'artifact://uri-only/1' },
    ],
    priorReviewIssues: [{ issueId: 'private-review' }],
  });

  await runtime.run(agentDefinition.id, { stable: true }, { scope });

  assert.deepEqual(
    backend.calls[0].request.inputArtifactRefs.map((ref) => ref.artifactId),
    ['allowed'],
  );
  assert.deepEqual(backend.calls[0].request.priorReviewIssues, []);
});

test('throws failed Agent results by default and returns them only when requested', async () => {
  const agentDefinition = definition();
  const failure = failed('schema-invalid');
  const backend = recordingBackend({ result: failure });
  const runtime = executionRuntime({ agentDefinition, backend });
  const scope = directScope();

  await assert.rejects(
    runtime.run(agentDefinition.id, {}, { scope }),
    (error) => (
      error?.stopReason === 'schema-invalid'
      && error?.agentRunResult === failure
      && /unit-agent failed: schema-invalid/u.test(error.message)
    ),
  );
  assert.equal(
    await runtime.run(agentDefinition.id, {}, { scope, throwOnFailure: false }),
    failure,
  );
});

test('Workflow context owns durable identity, filters refs, gates review, and excludes attempt', async () => {
  const agentDefinition = definition({
    artifactSelectors: ['analysis/**', 'data/allowed.json'],
    allowPriorReview: false,
  });
  const backend = recordingBackend();
  const replacementBackend = recordingBackend();
  const runtime = executionRuntime({
    agentDefinition,
    backend: replacementBackend,
  });
  const controller = new AbortController();
  const base = {
    agentRuntime: runtime,
    agentBackend: backend,
    artifactRefs: [
      { artifactId: 'allowed-analysis', path: 'analysis/plan.json' },
      { artifactId: 'allowed-data', path: 'data/allowed.json' },
      { artifactId: 'denied-report', path: 'report/report.md' },
      { artifactId: 'uri-only', uri: 'artifact://uri-only/1' },
    ],
    priorReviewIssues: [{ issueId: 'private-review' }],
    signal: controller.signal,
  };
  for (const attempt of [1, 2]) {
    await runWithWorkflowNodeContext(
      workflowContext({ ...base, attempt }),
      () => runtime.run(agentDefinition.id, { stable: true }, {
        callId: 'stable-workflow-call',
        temperature: 0.4,
      }),
    );
  }

  const [first, retry] = backend.calls;
  assert.equal(first.request.workflowId, 'workflow-unit.v1');
  assert.equal(first.request.nodeId, 'analyze');
  assert.equal(first.request.projectId, 'proj_1');
  assert.equal(first.request.asOf, AS_OF);
  assert.equal(first.request.workspaceSnapshotId, 'proj_1:snapshot-1');
  assert.deepEqual(
    first.request.inputArtifactRefs.map((ref) => ref.artifactId),
    ['allowed-analysis', 'allowed-data'],
  );
  assert.deepEqual(first.request.priorReviewIssues, []);
  assert.equal(Object.hasOwn(first.request, 'attempt'), false);
  assert.equal(first.request.runId, retry.request.runId);
  assert.equal(first.request.idempotencyKey, retry.request.idempotencyKey);
  assert.deepEqual(first.runtime, {
    temperature: 0.4,
    artifactCommitOwner: 'workflow',
    workflowAttempt: 1,
    workspaceMode: 'project',
    projectId: 'proj_1',
    contractOverride: agentDefinition,
    signal: controller.signal,
  });
  assert.equal(retry.runtime.workflowAttempt, 2);
  assert.equal(replacementBackend.calls.length, 0);

  await assert.rejects(
    runWithWorkflowNodeContext(
      workflowContext(base),
      () => runtime.run(agentDefinition.id, {}, {
        backend: replacementBackend,
      }),
    ),
    /Workflow Agent backend cannot be replaced/u,
  );
  assert.equal(replacementBackend.calls.length, 0);

  await assert.rejects(
    runWithWorkflowNodeContext(
      workflowContext(base),
      () => runtime.run(agentDefinition.id, {}, {
        scope: directScope({ commandId: 'forged-workflow-scope' }),
      }),
    ),
    /Workflow Agent direct scope cannot be supplied/u,
  );
  await assert.rejects(
    runWithWorkflowNodeContext(
      workflowContext({ ...base, agentRuntime: null }),
      () => runtime.run(agentDefinition.id, {}),
    ),
    /runtime does not match/u,
  );
  await assert.rejects(
    runWithWorkflowNodeContext(
      workflowContext({ ...base, agentBackend: null }),
      () => runtime.run(agentDefinition.id, {}),
    ),
    /backend must be injected/u,
  );
});

test('Workflow idea-run scope preserves durable identity and denies Project capabilities', async () => {
  const scopeId = 'idea-universe:local-user';
  const snapshotId = 'idea-run-input-snapshot:'.concat('b'.repeat(64));
  const safeDefinition = definition({ artifactSelectors: [] });
  const backend = recordingBackend();
  const runtime = executionRuntime({ agentDefinition: safeDefinition, backend });
  const context = workflowContext({
    agentRuntime: runtime,
    agentBackend: backend,
    runId: 'idea-run-1',
    projectId: scopeId,
    scope: { kind: 'idea-universe', id: scopeId },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: snapshotId,
  });

  await runWithWorkflowNodeContext(
    context,
    () => runtime.run(safeDefinition.id, { stable: true }),
  );

  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].request.projectId, scopeId);
  assert.equal(backend.calls[0].request.workspaceSnapshotId, snapshotId);
  assert.equal(backend.calls[0].runtime.workspaceMode, 'idea-run');

  for (const agentDefinition of [
    definition({ id: 'project-mount-agent', mounts: ['/project'] }),
    definition({ id: 'nested-project-mount-agent', mounts: ['/project/data'] }),
    definition({ id: 'project-tool-agent', toolAllow: ['project_read_file'] }),
    definition({ id: 'workspace-tool-agent', toolAllow: ['ws_read_file'] }),
    definition({ id: 'project-writer-agent', writeScopes: ['report/**'] }),
  ]) {
    const deniedBackend = recordingBackend();
    const deniedRuntime = executionRuntime({ agentDefinition, backend: deniedBackend });
    await assert.rejects(
      runWithWorkflowNodeContext(
        workflowContext({
          ...context,
          agentRuntime: deniedRuntime,
          agentBackend: deniedBackend,
          projectId: scopeId,
          scope: { kind: 'idea-universe', id: scopeId },
          workspaceMode: 'idea-run',
          workspaceSnapshotId: snapshotId,
        }),
        () => deniedRuntime.run(agentDefinition.id, {}),
      ),
      /requires Project workspace access/u,
    );
    assert.equal(deniedBackend.calls.length, 0);
  }
});

test('Workflow prior review is forwarded only for a definition that allows it', async () => {
  const deniedDefinition = definition({ id: 'denied-review-agent' });
  const allowedDefinition = definition({
    id: 'allowed-review-agent',
    allowPriorReview: true,
  });
  const deniedBackend = recordingBackend();
  const allowedBackend = recordingBackend();
  const deniedRuntime = executionRuntime({
    agentDefinition: deniedDefinition,
    backend: deniedBackend,
  });
  const allowedRuntime = executionRuntime({
    agentDefinition: allowedDefinition,
    backend: allowedBackend,
  });
  const issues = [{ issueId: 'issue-1', blocking: true }];

  await runWithWorkflowNodeContext(
    workflowContext({ agentRuntime: deniedRuntime, agentBackend: deniedBackend, priorReviewIssues: issues }),
    () => deniedRuntime.run(deniedDefinition.id, {}),
  );
  await runWithWorkflowNodeContext(
    workflowContext({ agentRuntime: allowedRuntime, agentBackend: allowedBackend, priorReviewIssues: issues }),
    () => allowedRuntime.run(allowedDefinition.id, {}),
  );

  assert.deepEqual(deniedBackend.calls[0].request.priorReviewIssues, []);
  assert.deepEqual(allowedBackend.calls[0].request.priorReviewIssues, issues);
});

test('result observer distinguishes physical execution from cache reconciliation', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-execution-observer-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const agentDefinition = definition();
  const rawBackend = recordingBackend({
    result: succeeded('observable'),
    cancelResult: (runId, nodeId) => `cancelled:${runId}:${nodeId}`,
  });
  const idempotentBackend = new IdempotentAgentBackend({
    backend: rawBackend,
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const observations = [];
  const observedBackend = withAgentResultObserver(
    idempotentBackend,
    async (event) => {
      await Promise.resolve();
      observations.push(event);
    },
  );
  const runtime = executionRuntime({ agentDefinition, backend: observedBackend });
  const scope = directScope({ commandId: 'command-observer' });

  const first = await runtime.run(agentDefinition.id, { stable: true }, { scope });
  const replay = await runtime.run(agentDefinition.id, { stable: true }, { scope });
  assert.equal(rawBackend.calls.length, 1);
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map(({ provenance }) => provenance),
    ['physical', 'cache-hit'],
  );
  assert.equal(observations[0].runtime.workspaceMode, 'none');
  assert.deepEqual(observations[0].request, observations[1].request);
  assert.deepEqual(observations[0].result, observations[1].result);
  assert.deepEqual(replay, first);

  assert.equal(
    await observedBackend.cancel('agent-run-1', 'agent-node-1'),
    'cancelled:agent-run-1:agent-node-1',
  );
  assert.deepEqual(rawBackend.cancellations, [{
    runId: 'agent-run-1',
    nodeId: 'agent-node-1',
  }]);
});

test('result observer records each uncacheable physical attempt before success', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-execution-observer-retry-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const agentDefinition = definition();
  const results = [
    createAgentRunResult({
      status: 'partial',
      output: { label: 'partial' },
      artifacts: [],
      evidenceRefs: [],
      openQuestions: [],
      dataRequests: [],
      metrics: { turns: 1, toolCalls: 0 },
      stopReason: 'deadline',
      traceRef: 'trace-partial',
    }),
    succeeded('recovered'),
  ];
  const rawBackend = recordingBackend({
    result: () => results.shift(),
  });
  const idempotentBackend = new IdempotentAgentBackend({
    backend: rawBackend,
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const observations = [];
  const runtime = executionRuntime({
    agentDefinition,
    backend: withAgentResultObserver(
      idempotentBackend,
      async (event) => observations.push(event),
    ),
  });
  const scope = directScope({ commandId: 'command-observer-retry' });

  assert.equal(
    (await runtime.run(agentDefinition.id, { stable: true }, { scope })).status,
    'partial',
  );
  assert.equal(
    (await runtime.run(agentDefinition.id, { stable: true }, { scope })).status,
    'succeeded',
  );
  assert.equal(rawBackend.calls.length, 2);
  assert.deepEqual(
    observations.map(({ result, provenance }) => [result.status, provenance]),
    [['partial', 'physical'], ['succeeded', 'physical']],
  );
});

test('observer failure occurs after success caching and a cache hit can reconcile metrics', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-execution-observer-crash-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const agentDefinition = definition();
  const rawBackend = recordingBackend({ result: succeeded('persisted-before-observer') });
  const idempotentBackend = new IdempotentAgentBackend({
    backend: rawBackend,
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const scope = directScope({ commandId: 'command-observer-crash' });
  const failingRuntime = executionRuntime({
    agentDefinition,
    backend: withAgentResultObserver(idempotentBackend, async () => {
      throw new Error('injected observer failure');
    }),
  });

  await assert.rejects(
    failingRuntime.run(agentDefinition.id, { stable: true }, { scope }),
    /injected observer failure/u,
  );

  const reconciled = [];
  const resumedRuntime = executionRuntime({
    agentDefinition,
    backend: withAgentResultObserver(
      idempotentBackend,
      async (event) => reconciled.push(event),
    ),
  });
  const result = await resumedRuntime.run(agentDefinition.id, { stable: true }, { scope });

  assert.equal(result.output.label, 'persisted-before-observer');
  assert.equal(rawBackend.calls.length, 1);
  assert.deepEqual(reconciled.map(({ provenance }) => provenance), ['cache-hit']);
});

test('result observer marks an in-flight waiter as coalesced without repeating execution', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-execution-observer-coalesced-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const agentDefinition = definition();
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const rawBackend = recordingBackend({
    result: succeeded('coalesced'),
    onRun: async () => blocker,
  });
  const idempotentBackend = new IdempotentAgentBackend({
    backend: rawBackend,
    store: new AgentResultIdempotencyStore({ rootDir }),
  });
  const observations = [];
  const runtime = executionRuntime({
    agentDefinition,
    backend: withAgentResultObserver(
      idempotentBackend,
      async (event) => observations.push(event),
    ),
  });
  const scope = directScope({ commandId: 'command-observer-coalesced' });

  const first = runtime.run(agentDefinition.id, { stable: true }, { scope });
  await Promise.resolve();
  const waiter = runtime.run(agentDefinition.id, { stable: true }, { scope });
  release();
  await Promise.all([first, waiter]);

  assert.equal(rawBackend.calls.length, 1);
  assert.deepEqual(
    observations.map(({ provenance }) => provenance).sort(),
    ['coalesced', 'physical'],
  );
});

test('parallel Workflow contexts isolate runtime, backend, request, and signal state', async () => {
  const leftDefinition = definition({ id: 'left-agent', revision: 'left-revision' });
  const rightDefinition = definition({ id: 'right-agent', revision: 'right-revision' });
  const leftBackend = recordingBackend();
  const rightBackend = recordingBackend();
  let fallbackResolutions = 0;
  const leftRuntime = executionRuntime({
    agentDefinition: leftDefinition,
    backend: recordingBackend(),
    onResolveBackend: () => { fallbackResolutions += 1; },
  });
  const rightRuntime = executionRuntime({
    agentDefinition: rightDefinition,
    backend: recordingBackend(),
    onResolveBackend: () => { fallbackResolutions += 1; },
  });
  const leftSignal = new AbortController().signal;
  const rightSignal = new AbortController().signal;
  const leftContext = workflowContext({
    agentRuntime: leftRuntime,
    agentBackend: leftBackend,
    runId: 'left-run',
    projectId: 'left-project',
    workspaceSnapshotId: 'left-snapshot',
    signal: leftSignal,
  });
  const rightContext = workflowContext({
    agentRuntime: rightRuntime,
    agentBackend: rightBackend,
    runId: 'right-run',
    projectId: 'right-project',
    workspaceSnapshotId: 'right-snapshot',
    signal: rightSignal,
  });

  const leftRun = runWithWorkflowNodeContext(leftContext, async () => {
    await Promise.resolve();
    const context = currentWorkflowNodeContext();
    return context.services.agentRuntime.run(leftDefinition.id, { side: 'left' }, {
      lane: 'left',
    });
  });
  const rightRun = runWithWorkflowNodeContext(rightContext, async () => {
    await Promise.resolve();
    const context = currentWorkflowNodeContext();
    return context.services.agentRuntime.run(rightDefinition.id, { side: 'right' }, {
      lane: 'right',
    });
  });
  await Promise.all([leftRun, rightRun]);

  assert.equal(leftBackend.calls.length, 1);
  assert.equal(rightBackend.calls.length, 1);
  assert.equal(leftBackend.calls[0].request.projectId, 'left-project');
  assert.equal(leftBackend.calls[0].request.workspaceSnapshotId, 'left-snapshot');
  assert.equal(leftBackend.calls[0].request.agentContractId, 'left-agent');
  assert.equal(leftBackend.calls[0].runtime.lane, 'left');
  assert.equal(leftBackend.calls[0].runtime.signal, leftSignal);
  assert.equal(rightBackend.calls[0].request.projectId, 'right-project');
  assert.equal(rightBackend.calls[0].request.workspaceSnapshotId, 'right-snapshot');
  assert.equal(rightBackend.calls[0].request.agentContractId, 'right-agent');
  assert.equal(rightBackend.calls[0].runtime.lane, 'right');
  assert.equal(rightBackend.calls[0].runtime.signal, rightSignal);
  assert.equal(fallbackResolutions, 0);
  assert.equal(currentWorkflowNodeContext(), null);
});
