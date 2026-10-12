import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ReportAdmissionService,
  ReportLibraryStore,
  ReportOverviewService,
} from '../src/domains/reports/index.js';
import {
  canonicalPackageDigest,
  CanonicalWorldviewStore,
  WORLDVIEW_AGENT_RESULT_CONTRACT,
} from '../src/domains/worldview/canonical/index.js';
import { ClaimStore } from '../src/domains/claims/index.js';
import { CanonicalWorldviewCoordinator } from '../src/workflows/worldview/canonicalWorldviewCoordinator.js';
import { WorldviewRunPublicationStore } from '../src/workflows/worldview/WorldviewRunPublicationStore.js';
import { ToolGateway } from '../src/core/tools/ToolGateway.js';
import { getAgentDefinition } from '../src/agents/registry.js';
import { runTool } from '../src/tools/index.js';
import { toolRegistry } from '../src/tools/toolCatalog.js';
import { FileArtifactStore, FileRunStore } from '../src/project-space/index.js';
import { canonicalSha256, canonicalStringify } from '../src/core/contracts/ArtifactRef.js';
import { getAgentSchema } from '../src/core/validation/agentSchemaRegistry.js';
import { validateJsonSchema } from '../src/core/validation/OutputGate.js';

const sha256 = (value) => `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;

function createClock(start = '2026-09-05T00:00:00.000Z') {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value).toISOString();
    value += 1_000;
    return current;
  };
}

function reportPackage(index) {
  const markdown = `# Report ${index}\n\nExact evidence for T${index}.\n`;
  const asOf = new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 1_000).toISOString();
  return {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('run-analysis.v2') },
      reportRef: {
        contract: 'artifact-ref.v1',
        artifactId: `artifact-${index}`,
        version: 1,
        path: 'report/report.md',
        contentDigest: sha256(markdown),
        schemaVersion: 'run-analysis-report.v1',
        producer: 'run-analysis',
        contractVersion: '1.0.0',
        inputDigest: sha256(`input-${index}`),
        createdAt: '2026-09-05T00:00:00.000Z',
        asOf,
      },
    },
    lineage: { projectId: `project-${index}`, analysisRunId: `analysis-${index}` },
    dailyReport: null,
    report: { mediaType: 'text/markdown', charset: 'utf-8', markdown, contentDigest: sha256(markdown) },
    metadata: {
      tickers: [`T${index}`],
      theme: 'Issue 41 acceptance',
      searchTags: ['issue-41', `T${index}`],
      title: `Report ${index}`,
      asOf,
      generatedAt: '2026-09-05T00:00:00.000Z',
    },
  };
}

function overviewOutput(input) {
  return {
    overview: {
      reportVersionId: input.reportVersionId,
      contentDigest: input.contentDigest,
      summary: `Discovery summary for ${input.metadata.title}.`,
      keyThemes: ['issue 41'],
      entities: [{ name: input.metadata.tickers[0], type: 'ticker', tickers: input.metadata.tickers }],
      materialDevelopments: [`Material development in ${input.metadata.title}.`],
      uncertainties: ['Read the exact ReportVersion before citing it.'],
    },
  };
}

function successfulResult(request, output) {
  return {
    status: 'succeeded',
    valid: true,
    output,
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    provider: 'scripted',
    model: request.agentContractId === 'core-worldview' ? 'gpt-5.6-sol' : 'gpt-5.6-sol',
    live: false,
    metrics: { providerAttempts: 0, networkAttempts: 0, liveModelAttempts: 0 },
    stopReason: 'final',
    traceRef: `trace:${request.runId}`,
  };
}

async function admit(reportLibrary, packageInput, now) {
  const overviewService = new ReportOverviewService({
    agentRunner: async (_agentId, input) => successfulResult(
      { agentContractId: 'report-overview', runId: input.reportVersionId },
      overviewOutput(input),
    ),
    now,
  });
  return new ReportAdmissionService({
    reportLibrary,
    overviewService,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  }).admit(packageInput);
}

function updateResult({ request, overviews, fullReport, claimActions = [] }) {
  const evidenceRef = {
    reportVersionId: fullReport.reportVersionId,
    contentDigest: fullReport.contentDigest,
  };
  return {
    contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
    worldview: {
      action: 'UPDATE',
      baseWorldviewVersionId: request.input.baseWorldviewVersionId,
      rationale: 'The frozen evidence establishes the initial current Worldview.',
      package: {
        title: 'Current Investment Worldview',
        asOf: request.asOf,
        narrativeMarkdown: '# Current Investment Worldview\n\nThe admitted evidence establishes the initial causal view.\n',
        causalRelationships: [{
          relationshipId: 'evidence-to-view',
          cause: 'New evidence',
          effect: 'Updated investment judgment',
          mechanism: 'Digest-verified reports change the current causal assessment.',
          confidence: 'medium',
          evidence: [evidenceRef],
          counterEvidence: [],
        }],
        evidence: [{ ...evidenceRef, kind: 'supporting', summary: 'The full report supports the view.' }],
        counterEvidence: [],
        investmentImplications: [{
          theme: 'Issue 41',
          implication: 'Track the evidence-defined causal mechanism.',
          horizon: '12 months',
          confidence: 'medium',
        }],
        coverage: {
          overviewIds: overviews.map((item) => item.overviewId),
          reportVersionIds: overviews.map((item) => item.reportVersionId),
          selectedFullReadReportVersionIds: [fullReport.reportVersionId],
        },
        updateSummary: { retained: [], changed: [], added: ['Initial view'], removed: [] },
      },
    },
    claimActions,
  };
}

test('one Issue 41 run freezes only the oldest bounded Pending prefix and leaves the later report Pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-claim-issue41-'));
  const now = createClock();
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = [];
  for (let index = 1; index <= 3; index += 1) {
    admitted.push(await admit(reportLibrary, reportPackage(index), now));
  }

  const coreCalls = [];
  const backend = {
    async run(request, runtime = {}) {
      assert.equal(request.agentContractId, 'core-worldview');
      coreCalls.push(request);
      const gateway = new ToolGateway({
        request,
        contract: getAgentDefinition('core-worldview'),
        registry: toolRegistry,
        executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
        beforeExecute: runtime.beforeToolExecution,
        toolCallBudget: runtime.toolCallBudget,
      });
      const overviews = await gateway.execute('worldview_enumerate_overviews', {
        scopeId: request.input.capabilityScopeId,
      });
      const fullReport = await gateway.execute('worldview_read_report_version', {
        scopeId: request.input.capabilityScopeId,
        reportVersionId: overviews[0].reportVersionId,
      });
      return successfulResult(request, updateResult({ request, overviews, fullReport }));
    },
  };

  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: backend,
    now,
    maxOverviewCountPerRun: 2,
  });
  const trigger = {
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-issue41-one-group',
    batchId: 'batch-issue41-one-group',
    status: 'requested',
    pendingReportVersionIds: admitted.map((item) => item.reportVersionId),
    publishedAt: now(),
  };

  const result = await coordinator.processTrigger(trigger);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].overviewCount, 2);
  assert.equal(coreCalls.length, 1);
  assert.equal(result.runs[0].workspaceId.startsWith('worldview_workspace_'), true);
  assert.match(result.runs[0].workspaceDigest, /^sha256:[a-f0-9]{64}$/u);
  const workspace = JSON.parse(fs.readFileSync(path.join(
    worldviewStore.rootDir,
    'run-workspaces',
    'workspaces',
    `${result.runs[0].workspaceId}.json`,
  ), 'utf8'));
  assert.equal(workspace.workspaceDigest, result.runs[0].workspaceDigest);
  assert.equal(workspace.content.manifest.items.length, 2);
  assert.equal(workspace.content.currentWorldview, null);
  assert.deepEqual(workspace.content.claims, []);
  assert.deepEqual(workspace.content.claimTable, []);
  assert.deepEqual(workspace.content.effectiveConfig.capturedRoute, {
    provider: 'openai-compatible',
    model: 'gpt-5.6-sol',
    reasoningLevel: 'high',
  });
  assert.match(workspace.content.promptIdentity.systemPromptDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(workspace.content.retryPolicies, {
    wholeAgent: { maxAttempts: 3 },
    modelApi: { maxAttempts: 5 },
  });
  assert.deepEqual(workspace.content.approvedCapabilities, [
    'worldview_read_current',
    'worldview_enumerate_overviews',
    'worldview_read_report_version',
    'worldview_search_claims',
  ]);

  reportLibrary.rebuildProjections();
  assert.deepEqual(
    admitted.map((item) => reportLibrary.get(item.reportVersionId).processingStatus),
    ['Processed', 'Processed', 'Pending'],
  );

  const replay = await coordinator.processTrigger(trigger);
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.runs.length, 1);
  assert.equal(replay.runs[0].runId, result.runs[0].runId);
  assert.equal(coreCalls.length, 1, 'the exact trigger replay must not spend another Agent call');
  assert.equal(reportLibrary.get(admitted[2].reportVersionId).processingStatus, 'Pending');
});


test('captured Core route honors the explicit OpenAI-compatible reasoning level', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-reasoning-issue41-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = createClock('2026-09-05T12:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let executedReasoningLevel = null;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: successfulCoreBackend((_request, executionRuntime) => {
      executedReasoningLevel = executionRuntime.reasoningLevel;
    }),
    modelRuntime: {
      DEMO_MODE: false,
      DEFAULT_PROVIDER: 'openai-compatible',
      MAIN_PROVIDER: '',
      MAIN_MODEL: '',
      OPENAI_COMPATIBLE_MODEL: 'gpt-5.6-sol',
      OPENAI_COMPATIBLE_REASONING_LEVEL: 'medium',
    },
    now,
  });

  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-explicit-core-reasoning',
    batchId: 'batch-explicit-core-reasoning',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  });

  const workspace = JSON.parse(fs.readFileSync(path.join(
    worldviewStore.rootDir,
    'run-workspaces',
    'workspaces',
    `${result.runs[0].workspaceId}.json`,
  ), 'utf8'));
  assert.equal(workspace.content.effectiveConfig.capturedRoute.reasoningLevel, 'medium');
  assert.equal(executedReasoningLevel, 'medium');
});


test('permanent Core route, config, permission, and frozen-report integrity failures do not spend another complete Agent attempt', async (t) => {
  const permanentCodes = [
    'PI_MODEL_UNAVAILABLE',
    'MODEL_PROVIDER_PERMANENT',
    'EFFECTIVE_AGENT_CONFIG_MISMATCH',
    'RUNTIME_TOOL_POLICY_EXPANSION',
    'CONTEXT_PERMISSION_DENIED',
    'TOOL_PERMISSION_DENIED',
    'WORLDVIEW_REPORT_ADMISSION_CORRUPT',
    'WORLDVIEW_REPORT_IDENTITY_MISMATCH',
    'WORLDVIEW_REPORT_CONTENT_MISMATCH',
  ];

  for (const [index, code] of permanentCodes.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `worldview-permanent-${index}-issue41-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = createClock(`2026-09-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`);
    const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
    const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
    const admitted = await admit(reportLibrary, reportPackage(index + 1), now);
    let calls = 0;
    const coordinator = new CanonicalWorldviewCoordinator({
      dataDir: root,
      reportLibrary,
      worldviewStore,
      agentBackend: {
        async run(request) {
          calls += 1;
          return {
            status: 'failed',
            valid: false,
            output: null,
            provider: 'openai-compatible',
            model: 'gpt-5.6-sol',
            live: false,
            metrics: { modelApiAttempts: 0 },
            stopReason: 'error',
            error: { code },
            traceRef: `trace:${request.runId}`,
          };
        },
      },
      now,
    });

    await assert.rejects(
      coordinator.processTrigger({
        contract: 'worldview-processing-trigger.v1',
        triggerId: `trigger-permanent-${index}`,
        batchId: `batch-permanent-${index}`,
        status: 'requested',
        pendingReportVersionIds: [admitted.reportVersionId],
        publishedAt: now(),
      }),
      (error) => error?.code === code,
      code,
    );
    assert.equal(calls, 1, code);
    const [run] = worldviewStore.listProcessingRuns().runs;
    assert.equal(run.state, 'FAILED_CLOSED', code);
    assert.equal(run.attempts.length, 1, code);
    assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending', code);
  }
});


test('retryable Core failures start fresh attempts over byte-identical frozen workspace content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-retry-issue41-'));
  const now = createClock('2026-09-06T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const requests = [];
  const backend = {
    async run(request, runtime = {}) {
      requests.push({
        runId: request.runId,
        input: structuredClone(request.input),
        modelApiRetry: structuredClone(runtime.modelApiRetry),
      });
      if (requests.length === 1) {
        return {
          status: 'failed',
          valid: false,
          output: null,
          provider: 'scripted',
          model: 'gpt-5.6-sol',
          live: false,
          metrics: { providerAttempts: 1, networkAttempts: 0, liveModelAttempts: 0 },
          stopReason: 'provider-interrupted',
          error: { code: 'PROVIDER_INTERRUPTED' },
        };
      }
      const gateway = new ToolGateway({
        request,
        contract: getAgentDefinition('core-worldview'),
        registry: toolRegistry,
        executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
        beforeExecute: runtime.beforeToolExecution,
        toolCallBudget: runtime.toolCallBudget,
      });
      const overviews = await gateway.execute('worldview_enumerate_overviews', {
        scopeId: request.input.capabilityScopeId,
      });
      const fullReport = await gateway.execute('worldview_read_report_version', {
        scopeId: request.input.capabilityScopeId,
        reportVersionId: overviews[0].reportVersionId,
      });
      return successfulResult(request, updateResult({ request, overviews, fullReport }));
    },
  };
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: backend,
    now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-issue41-retry',
    batchId: 'batch-issue41-retry',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].runId, requests[1].runId);
  assert.deepEqual(requests.map((item) => item.modelApiRetry), [
    { maxAttempts: 5 },
    { maxAttempts: 5 },
  ]);
  const run = worldviewStore.getProcessingRun(result.runs[0].runId);
  assert.equal(run.retryMetadata.agentAttempts, 2);
  assert.equal(run.retryMetadata.maxAttempts, 3);
  assert.equal(run.attempts.length, 2);
  assert.equal(run.attempts[0].status, 'failed');
  assert.equal(run.attempts[1].status, 'succeeded');
  assert.equal(run.attempts[0].workspaceDigest, result.runs[0].workspaceDigest);
  assert.equal(run.attempts[1].workspaceDigest, result.runs[0].workspaceDigest);
});


test('restart recovers a workspace orphaned before its processing-run record and blocks later triggers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-orphan-workspace-issue41-'));
  const now = createClock('2026-09-06T09:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let agentCalls = 0;
  const backend = successfulCoreBackend(() => { agentCalls += 1; });
  const injected = new Error('injected process death after workspace freeze');
  injected.code = 'WORLDVIEW_INJECTED_AFTER_WORKSPACE_FREEZE';
  worldviewStore.createProcessingRun = () => { throw injected; };
  const trigger = {
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-orphan-workspace',
    batchId: 'batch-orphan-workspace',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  };
  const first = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, agentBackend: backend, now,
  });

  await assert.rejects(first.processTrigger(trigger), (error) => error?.code === injected.code);
  assert.equal(agentCalls, 0);
  assert.equal(worldviewStore.listProcessingRuns().runs.length, 0);
  const workspaceDir = path.join(worldviewRoot, 'run-workspaces', 'workspaces');
  const [workspaceFile] = fs.readdirSync(workspaceDir);
  const originalWorkspaceBytes = fs.readFileSync(path.join(workspaceDir, workspaceFile));
  const originalWorkspace = JSON.parse(originalWorkspaceBytes);

  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: new ReportLibraryStore({ rootDir: reportRoot, now }),
    worldviewStore: new CanonicalWorldviewStore({ rootDir: worldviewRoot, now }),
    agentBackend: backend,
    now,
  });
  const [recoveredRun] = restarted.worldviewStore.listProcessingRuns().runs;
  assert.equal(recoveredRun.workspaceId, originalWorkspace.workspaceId);
  assert.equal(recoveredRun.workspaceDigest, originalWorkspace.workspaceDigest);
  assert.equal(recoveredRun.startedAt, originalWorkspace.content.createdAt);
  await assert.rejects(
    restarted.processTrigger({
      ...trigger,
      triggerId: 'trigger-after-orphan',
      batchId: 'batch-after-orphan',
    }),
    (error) => error?.code === 'WORLDVIEW_FROZEN_WORKSPACE_BLOCKED',
  );
  assert.equal(agentCalls, 0, 'a later trigger must not leapfrog the recovered workspace');

  const recovered = await restarted.processTrigger(trigger);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(agentCalls, 1);
  assert.deepEqual(fs.readFileSync(path.join(workspaceDir, workspaceFile)), originalWorkspaceBytes);
  assert.equal(recovered.runs[0].workspaceId, path.basename(workspaceFile, '.json'));
});


test('restart reuses the byte-identical frozen workspace and never exceeds three total complete attempts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-restart-budget-issue41-'));
  const now = createClock('2026-09-06T12:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let physicalCalls = 0;
  const observedRuntimeBounds = [];
  const interrupted = new Error('injected process interruption after durable attempt audit');
  interrupted.code = 'WORLDVIEW_INJECTED_PROCESS_INTERRUPTION';
  const retryableFailure = async (request, runtime) => {
    physicalCalls += 1;
    observedRuntimeBounds.push({
      deadlineMs: runtime.deadlineMs,
      tokenBudget: runtime.tokenBudget,
      toolCallBudget: runtime.toolCallBudget,
    });
    return {
      status: 'failed', valid: false, output: null,
      provider: 'scripted', model: 'gpt-5.6-sol', live: false,
      metrics: { providerAttempts: 1, modelApiAttempts: 1, networkAttempts: 0, liveModelAttempts: 0 },
      stopReason: 'provider-interrupted', error: { code: 'PROVIDER_INTERRUPTED' }, traceRef: `trace:${request.runId}`,
    };
  };
  const realUpdate = worldviewStore.updateProcessingRun.bind(worldviewStore);
  let auditInterrupted = false;
  worldviewStore.updateProcessingRun = (runId, patch, options) => {
    if (auditInterrupted) throw interrupted;
    if (patch?.state === 'running' && patch?.attempts?.[0]?.status === 'failed') {
      auditInterrupted = true;
      throw interrupted;
    }
    return realUpdate(runId, patch, options);
  };
  const trigger = {
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-restart-budget', batchId: 'batch-restart-budget',
    status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  };
  const firstCoordinator = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, agentBackend: { run: retryableFailure }, now,
  });
  await assert.rejects(
    firstCoordinator.processTrigger(trigger),
    (error) => error?.code === 'WORLDVIEW_INJECTED_PROCESS_INTERRUPTION',
  );
  assert.equal(physicalCalls, 1);
  const interruptedRun = worldviewStore.listProcessingRuns().runs[0];
  assert.equal(interruptedRun.state, 'running');
  assert.equal(interruptedRun.attempts.length, 1);
  const workspacePath = path.join(worldviewRoot, 'run-workspaces', 'workspaces', `${interruptedRun.workspaceId}.json`);
  const originalWorkspaceBytes = fs.readFileSync(workspacePath);
  const originalWorkspace = JSON.parse(originalWorkspaceBytes);

  const restartedReportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const restartedWorldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: restartedReportLibrary,
    worldviewStore: restartedWorldviewStore,
    agentBackend: { run: retryableFailure },
    maxOverviewCountPerRun: 1,
    maxOverviewBytesPerRun: 1_000,
    maxContextTokensPerRun: 1_000,
    maxOutputTokensPerRun: 1_000,
    maxWallClockMsPerRun: 1_000,
    maxToolCallsPerRun: 4,
    now,
  });
  await assert.rejects(
    restarted.processTrigger(trigger),
    (error) => error?.code === 'WORLDVIEW_AGENT_ATTEMPTS_EXHAUSTED',
  );

  assert.equal(physicalCalls, 3);
  assert.deepEqual(observedRuntimeBounds, [
    { deadlineMs: 600_000, tokenBudget: 64_768, toolCallBudget: 256 },
    { deadlineMs: 600_000, tokenBudget: 64_768, toolCallBudget: 256 },
    { deadlineMs: 600_000, tokenBudget: 64_768, toolCallBudget: 256 },
  ]);
  assert.deepEqual(fs.readFileSync(workspacePath), originalWorkspaceBytes);
  const finalWorkspace = JSON.parse(fs.readFileSync(workspacePath));
  assert.equal(finalWorkspace.content.createdAt, originalWorkspace.content.createdAt);
  assert.equal(finalWorkspace.content.asOf, originalWorkspace.content.asOf);
  const finalRun = restartedWorldviewStore.getProcessingRun(interruptedRun.runId);
  assert.equal(finalRun.state, 'FAILED_EXHAUSTED');
  assert.equal(finalRun.attempts.length, 3);
  assert.deepEqual(finalRun.attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
});



test('restart recovers a durably succeeded third attempt before its execute-node artifact commits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-third-success-recovery-issue41-'));
  const now = createClock('2026-09-06T15:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const successBackend = successfulCoreBackend();
  let physicalCalls = 0;
  const backend = {
    async run(request, runtime) {
      physicalCalls += 1;
      if (physicalCalls < 3) {
        return {
          status: 'failed', valid: false, output: null,
          provider: 'scripted', model: 'gpt-5.6-sol', live: false,
          metrics: { providerAttempts: 1, modelApiAttempts: 1, networkAttempts: 0, liveModelAttempts: 0 },
          stopReason: 'provider-interrupted', error: { code: 'PROVIDER_INTERRUPTED' }, traceRef: `trace:${request.runId}`,
        };
      }
      return successBackend.run(request, runtime);
    },
  };
  const injected = new Error('injected process death before execute-node artifact commit');
  injected.code = 'WORLDVIEW_INJECTED_BEFORE_EXECUTE_ARTIFACT';
  const realArtifactCommit = FileArtifactStore.prototype.commit;
  FileArtifactStore.prototype.commit = function commit(input) {
    if (input?.nodeId === 'execute-core-worldview-attempts') throw injected;
    return realArtifactCommit.call(this, input);
  };
  const realUpdate = worldviewStore.updateProcessingRun.bind(worldviewStore);
  worldviewStore.updateProcessingRun = (runId, patch, options) => {
    if (patch?.state === 'FAILED_CLOSED') throw injected;
    return realUpdate(runId, patch, options);
  };
  const trigger = {
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-third-success-recovery', batchId: 'batch-third-success-recovery',
    status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  };
  try {
    const first = new CanonicalWorldviewCoordinator({ dataDir: root, reportLibrary, worldviewStore, agentBackend: backend, now });
    await assert.rejects(first.processTrigger(trigger), (error) => error?.code === injected.code);
  } finally {
    FileArtifactStore.prototype.commit = realArtifactCommit;
  }
  assert.equal(physicalCalls, 3);
  const interruptedRun = worldviewStore.listProcessingRuns().runs[0];
  assert.equal(interruptedRun.attempts.length, 3);
  assert.equal(interruptedRun.attempts[2].status, 'succeeded');
  assert.equal(interruptedRun.attemptRecovery.validatedResult.worldview.action, 'UPDATE');

  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: new ReportLibraryStore({ rootDir: reportRoot, now }),
    worldviewStore: new CanonicalWorldviewStore({ rootDir: worldviewRoot, now }),
    agentBackend: { async run() { physicalCalls += 1; throw new Error('must not call a fourth physical attempt'); } },
    now,
  });
  const recovered = await restarted.processTrigger(trigger);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(physicalCalls, 3);
  const finalRun = restarted.worldviewStore.getProcessingRun(recovered.runs[0].runId);
  assert.equal(finalRun.attempts.length, 3);
  assert.equal(finalRun.attempts[2].status, 'succeeded');
});

test('restart hydrates the full attempt audit from the execute-node artifact into the publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-restart-hydration-issue41-'));
  const now = createClock('2026-09-06T18:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(worldviewRoot, 'run-publications'), now,
  });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let physicalCalls = 0;
  const successBackend = successfulCoreBackend();
  const backend = {
    async run(request, runtime) {
      physicalCalls += 1;
      await runtime.onModelApiAttempt({ phase: 'started', attempt: 1, maxAttempts: 5 });
      if (physicalCalls === 1) {
        await runtime.onModelApiAttempt({
          phase: 'completed', attempt: 1, maxAttempts: 5,
          status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 503,
        });
        return {
          status: 'failed', valid: false, output: null,
          provider: 'scripted', model: 'gpt-5.6-sol', live: false,
          metrics: { providerAttempts: 1, modelApiAttempts: 1, networkAttempts: 0, liveModelAttempts: 0 },
          stopReason: 'provider-interrupted', error: { code: 'PROVIDER_INTERRUPTED' }, traceRef: `trace:${request.runId}`,
        };
      }
      await runtime.onModelApiAttempt({
        phase: 'completed', attempt: 1, maxAttempts: 5,
        status: 'succeeded', code: null, statusCode: null,
      });
      const result = await successBackend.run(request, runtime);
      return {
        ...result,
        metrics: { ...result.metrics, providerAttempts: 1, modelApiAttempts: 1 },
      };
    },
  };
  const interrupted = new Error('injected process interruption after execute-node completion');
  interrupted.code = 'WORLDVIEW_INJECTED_AFTER_EXECUTION';
  publicationStore.stage = () => { throw interrupted; };
  const realUpdate = worldviewStore.updateProcessingRun.bind(worldviewStore);
  let publicationInterrupted = false;
  worldviewStore.updateProcessingRun = (runId, patch, options) => {
    if (patch?.state === 'FAILED_CLOSED') {
      publicationInterrupted = true;
      throw interrupted;
    }
    return realUpdate(runId, patch, options);
  };
  const trigger = {
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-restart-hydration', batchId: 'batch-restart-hydration',
    status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  };
  const firstCoordinator = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, publicationStore, agentBackend: backend, now,
  });
  await assert.rejects(
    firstCoordinator.processTrigger(trigger),
    (error) => error?.code === 'WORLDVIEW_INJECTED_AFTER_EXECUTION',
  );
  assert.equal(publicationInterrupted, true);
  assert.equal(physicalCalls, 2);
  const interruptedRun = worldviewStore.listProcessingRuns().runs[0];
  assert.equal(interruptedRun.attempts.length, 2);
  const workflowRoot = worldviewStore.workflowRunDir(interruptedRun.runId);
  const workflowRun = new FileRunStore({ projectId: 'worldview-universe:canonical', storageDir: workflowRoot, now })
    .load(interruptedRun.runId);
  const executeRef = workflowRun.nodes['execute-core-worldview-attempts'].artifactRefs[0];
  const executeArtifact = JSON.parse(new FileArtifactStore({
    projectId: 'worldview-universe:canonical', storageDir: workflowRoot,
  }).read(executeRef));
  assert.deepEqual(executeArtifact.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);
  assert.deepEqual(
    executeArtifact.attempts.map((attempt) => attempt.modelApiAttemptAudit.map(({ recordedAt: _recordedAt, ...event }) => event)),
    [
      [
        { sequence: 1, phase: 'started', attempt: 1, maxAttempts: 5, status: null, code: null, statusCode: null },
        { sequence: 2, phase: 'completed', attempt: 1, maxAttempts: 5, status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 503 },
      ],
      [
        { sequence: 1, phase: 'started', attempt: 1, maxAttempts: 5, status: null, code: null, statusCode: null },
        { sequence: 2, phase: 'completed', attempt: 1, maxAttempts: 5, status: 'succeeded', code: null, statusCode: null },
      ],
    ],
  );

  const restartedReportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const restartedWorldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const restartedPublicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(worldviewRoot, 'run-publications'), now,
  });
  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: restartedReportLibrary,
    worldviewStore: restartedWorldviewStore,
    publicationStore: restartedPublicationStore,
    agentBackend: { async run() { throw new Error('hydration must not call the Agent again'); } },
    now,
  });
  const recovered = await restarted.processTrigger(trigger);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(physicalCalls, 2);
  const publication = restartedPublicationStore.get(recovered.runs[0].publicationId);
  assert.deepEqual(publication.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);
  assert.deepEqual(
    publication.attempts.map((attempt) => attempt.modelApiAttemptAudit),
    executeArtifact.attempts.map((attempt) => attempt.modelApiAttemptAudit),
  );
  assert.deepEqual(
    restartedWorldviewStore.getProcessingRun(interruptedRun.runId).attempts,
    publication.attempts,
  );
});


test('three retryable complete failures end FAILED_EXHAUSTED with no publication or Processed receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-exhausted-issue41-'));
  const now = createClock('2026-09-07T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let calls = 0;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: {
      async run(request) {
        calls += 1;
        return {
          status: 'failed',
          valid: false,
          output: null,
          provider: 'scripted',
          model: 'gpt-5.6-sol',
          live: false,
          metrics: { providerAttempts: 1, modelApiAttempts: 1, networkAttempts: 0, liveModelAttempts: 0 },
          stopReason: 'provider-interrupted',
          error: { code: 'PROVIDER_INTERRUPTED' },
          traceRef: `trace:${request.runId}`,
        };
      },
    },
    now,
  });
  const trigger = {
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-issue41-exhausted',
    batchId: 'batch-issue41-exhausted',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  };

  await assert.rejects(
    coordinator.processTrigger(trigger),
    (error) => error?.code === 'WORLDVIEW_AGENT_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(calls, 3);
  const [run] = worldviewStore.listProcessingRuns().runs;
  assert.equal(run.state, 'FAILED_EXHAUSTED');
  assert.equal(run.attempts.length, 3);
  assert.equal(run.attempts.every((attempt) => attempt.workspaceDigest === run.workspaceDigest), true);
  assert.equal(worldviewStore.current(), null);
  reportLibrary.rebuildProjections();
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
  await assert.rejects(
    coordinator.processTrigger({
      ...trigger,
      triggerId: 'trigger-issue41-later-blocked',
      batchId: 'batch-issue41-later-blocked',
    }),
    (error) => error?.code === 'WORLDVIEW_FROZEN_WORKSPACE_BLOCKED',
  );
  assert.equal(calls, 3, 'later Pending Reports cannot leapfrog an exhausted frozen workspace');
});


function successfulCoreBackend(onCall = () => {}, { claimActionFactory = () => [] } = {}) {
  return {
    async run(request, runtime = {}) {
      onCall(request, runtime);
      const gateway = new ToolGateway({
        request,
        contract: getAgentDefinition('core-worldview'),
        registry: toolRegistry,
        executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
        beforeExecute: runtime.beforeToolExecution,
        toolCallBudget: runtime.toolCallBudget,
      });
      const overviews = await gateway.execute('worldview_enumerate_overviews', {
        scopeId: request.input.capabilityScopeId,
      });
      const fullReport = await gateway.execute('worldview_read_report_version', {
        scopeId: request.input.capabilityScopeId,
        reportVersionId: overviews[0].reportVersionId,
      });
      return successfulResult(request, updateResult({
        request,
        overviews,
        fullReport,
        claimActions: claimActionFactory({ request, overviews, fullReport }),
      }));
    },
  };
}

function oneValidClaimAction({ fullReport }, actionId = 'publication-crash-add') {
  return [{
    actionId,
    action: 'ADD',
    rationale: 'The full-read report supports one bounded crash-recovery Claim.',
    claim: {
      assertion: 'T1 utilization will exceed 72% by 2027-03-31.',
      subject: 'T1 production capacity',
      tickers: ['T1'],
      rationale: 'The exact report supports a time-bound utilization judgment.',
      verification: { pointAt: '2027-03-31T00:00:00.000Z' },
      metric: 'Reported T1 utilization percentage',
      acceptanceCondition: 'The reported utilization is greater than 72%.',
      invalidationCondition: 'The reported utilization is 62% or lower.',
      evidence: [{
        reportVersionId: fullReport.reportVersionId,
        contentDigest: fullReport.contentDigest,
        fingerprint: fullReport.fingerprint,
      }],
    },
  }];
}

async function publishSingleUpdateFixture(start) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-marker-object-issue41-'));
  const now = createClock(start);
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(root, 'canonical-worldview', 'run-publications'), now,
  });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, publicationStore,
    agentBackend: successfulCoreBackend(), now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1', triggerId: `trigger-${path.basename(root)}`,
    batchId: `batch-${path.basename(root)}`, status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  });
  return { root, now, reportLibrary, worldviewStore, publicationStore, result };
}


test('current Worldview fails closed when its projected version loses the unified publication marker', async () => {
  const { worldviewStore, publicationStore, result } = await publishSingleUpdateFixture('2026-09-07T09:00:00.000Z');
  const versionId = result.runs[0].resultingWorldviewVersionId;
  const publicationId = result.runs[0].publicationId;
  assert.equal(worldviewStore.current().versionId, versionId);

  fs.rmSync(path.join(publicationStore.markersDir, `${publicationId}.json`));
  assert.equal(worldviewStore.getVersion(versionId), null, 'the missing marker hides the staged version');
  assert.throws(
    () => worldviewStore.current(),
    (error) => error?.code === 'CURRENT_WORLDVIEW_CORRUPT',
  );
});


test('current Worldview remains null for a true bootstrap with no current projection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-current-bootstrap-issue41-'));
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview') });

  assert.equal(fs.existsSync(worldviewStore.currentPath), false);
  assert.equal(worldviewStore.current(), null);
});


test('current Worldview validates its exact projection against every marker-visible source field', async () => {
  const { worldviewStore } = await publishSingleUpdateFixture('2026-09-07T10:00:00.000Z');
  const validCurrent = JSON.parse(fs.readFileSync(worldviewStore.currentPath, 'utf8'));
  const withoutRebuiltAt = Object.fromEntries(
    Object.entries(validCurrent).filter(([field]) => field !== 'rebuiltAt'),
  );
  const corruptions = [
    ['an extra field', { ...validCurrent, unexpected: true }],
    ['a missing field', withoutRebuiltAt],
    ['versionId tampering', { ...validCurrent, versionId: 'worldview_v_missing' }],
    ['versionNumber tampering', { ...validCurrent, versionNumber: validCurrent.versionNumber + 1 }],
    ['packageDigest tampering', { ...validCurrent, packageDigest: sha256('tampered-current-package') }],
    ['runId tampering', { ...validCurrent, runId: 'tampered-current-run' }],
    ['publishedAt tampering', { ...validCurrent, publishedAt: '2026-09-08T00:00:00.000Z' }],
    ['an invalid rebuiltAt timestamp', { ...validCurrent, rebuiltAt: 'not-a-timestamp' }],
  ];

  for (const [label, current] of corruptions) {
    fs.writeFileSync(worldviewStore.currentPath, `${canonicalStringify(current)}\n`);
    assert.throws(
      () => worldviewStore.current(),
      (error) => error?.code === 'CURRENT_WORLDVIEW_CORRUPT',
      label,
    );
  }
});


test('current Worldview treats only a missing projection as absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-current-present-corrupt-issue41-'));
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview') });

  for (const current of ['null\n', '{\n']) {
    fs.writeFileSync(worldviewStore.currentPath, current);
    assert.throws(
      () => worldviewStore.current(),
      (error) => error?.code === 'CURRENT_WORLDVIEW_CORRUPT',
    );
  }
});


test('UPDATE package visibility rejects self-consistent bytes not bound by the publication marker', async () => {
  const { worldviewStore, result } = await publishSingleUpdateFixture('2026-09-07T12:00:00.000Z');
  const versionId = result.runs[0].resultingWorldviewVersionId;
  const versionDir = path.join(worldviewStore.rootDir, 'versions', versionId);
  const packagePath = path.join(versionDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const alteredNarrative = '# Current Investment Worldview\n\nSelf-consistent tampered narrative.\n';
  fs.writeFileSync(path.join(versionDir, 'worldview.md'), alteredNarrative);
  const narrativeEntry = manifest.documents.find((document) => document.path === 'worldview.md');
  narrativeEntry.contentDigest = sha256(alteredNarrative);
  narrativeEntry.byteLength = Buffer.byteLength(alteredNarrative);
  const { packageDigest: _originalDigest, ...manifestWithoutDigest } = manifest;
  const documents = manifest.documents.map((document) => ({
    ...document,
    bytes: fs.readFileSync(path.join(versionDir, document.path)),
  }));
  manifest.packageDigest = canonicalPackageDigest(manifestWithoutDigest, documents);
  fs.writeFileSync(packagePath, `${canonicalStringify(manifest)}\n`);

  assert.equal(
    worldviewStore.getVersion(versionId, { includeUncommitted: true }).packageDigest,
    manifest.packageDigest,
    'the altered package remains internally self-consistent',
  );
  assert.throws(
    () => worldviewStore.getVersion(versionId),
    (error) => error?.code === 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH',
  );
});


test('UPDATE record visibility rejects a recomputed digest not bound by the publication marker', async () => {
  const { worldviewStore, result } = await publishSingleUpdateFixture('2026-09-07T18:00:00.000Z');
  const versionId = result.runs[0].resultingWorldviewVersionId;
  const version = worldviewStore.getVersion(versionId);
  const recordPath = path.join(worldviewStore.rootDir, 'updates', `${version.updateRecord.updateRecordId}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.rationale = 'Self-consistent altered UPDATE rationale.';
  const { recordDigest: _originalDigest, ...content } = record;
  record.recordDigest = canonicalSha256(content);
  fs.writeFileSync(recordPath, `${canonicalStringify(record)}\n`);

  assert.equal(
    worldviewStore.getVersion(versionId, { includeUncommitted: true }).updateRecord.recordDigest,
    record.recordDigest,
    'the altered UPDATE record remains internally self-consistent',
  );
  assert.throws(
    () => worldviewStore.getVersion(versionId),
    (error) => error?.code === 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH',
  );
});


test('a failure before the run publication marker exposes no Worldview or Processed receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-pre-marker-issue41-'));
  const now = createClock('2026-09-08T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const claimStore = new ClaimStore({ rootDir: path.join(root, 'claims'), now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(root, 'canonical-worldview', 'run-publications'),
    now,
  });
  publicationStore.commit = () => {
    const error = new Error('injected failure before publication marker');
    error.code = 'WORLDVIEW_PUBLICATION_INJECTED_PRE_MARKER';
    throw error;
  };
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    claimStore,
    publicationStore,
    agentBackend: successfulCoreBackend(() => {}, { claimActionFactory: oneValidClaimAction }),
    now,
  });
  await assert.rejects(
    coordinator.processTrigger({
      contract: 'worldview-processing-trigger.v1',
      triggerId: 'trigger-pre-marker',
      batchId: 'batch-pre-marker',
      status: 'requested',
      pendingReportVersionIds: [admitted.reportVersionId],
      publishedAt: now(),
    }),
    (error) => error?.code === 'WORLDVIEW_PUBLICATION_INJECTED_PRE_MARKER',
  );
  assert.equal(publicationStore.list().publications.length, 0);
  assert.equal(worldviewStore.current(), null);
  const failedRun = worldviewStore.listProcessingRuns().runs[0];
  const publicationId = publicationStore.publicationId({
    runId: failedRun.runId,
    workspaceDigest: failedRun.workspaceDigest,
  });
  const stagedClaims = claimStore.getStagedPublication(publicationId);
  assert.equal(stagedClaims.claims.length, 1);
  assert.equal(claimStore.publication(publicationId), null);
  assert.equal(claimStore.list().claims.length, 0);
  assert.equal(claimStore.actions().actions.length, 0);
  assert.equal(claimStore.history(stagedClaims.claims[0].claimId).versions.length, 0);
  reportLibrary.rebuildProjections();
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
});

test('coordinator construction recovers a real post-marker pre-projection crash without another Agent call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-post-marker-issue41-'));
  const now = createClock('2026-09-09T00:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const claimRoot = path.join(root, 'claims');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const claimStore = new ClaimStore({ rootDir: claimRoot, now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(worldviewRoot, 'run-publications'),
    now,
  });
  const realRebuildCurrent = worldviewStore.rebuildCurrent.bind(worldviewStore);
  worldviewStore.rebuildCurrent = () => {
    const error = new Error('injected process crash before projections and run-log completion');
    error.code = 'WORLDVIEW_PROJECTION_INJECTED_CRASH';
    throw error;
  };
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  let calls = 0;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    claimStore,
    publicationStore,
    agentBackend: successfulCoreBackend(() => { calls += 1; }, { claimActionFactory: oneValidClaimAction }),
    now,
  });
  const trigger = {
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-post-marker',
    batchId: 'batch-post-marker',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  };
  await assert.rejects(
    coordinator.processTrigger(trigger),
    (error) => error?.code === 'WORLDVIEW_PROJECTION_INJECTED_CRASH',
  );
  assert.equal(calls, 1);
  assert.equal(publicationStore.list().publications.length, 1);
  assert.equal(fs.existsSync(path.join(worldviewRoot, 'current.json')), false);
  assert.notEqual(worldviewStore.listProcessingRuns().runs[0].state, 'succeeded');
  worldviewStore.rebuildCurrent = realRebuildCurrent;

  const restartedReportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const restartedWorldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const restartedClaimStore = new ClaimStore({ rootDir: claimRoot, now });
  const restartedPublicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(worldviewRoot, 'run-publications'),
    now,
  });
  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: restartedReportLibrary,
    worldviewStore: restartedWorldviewStore,
    claimStore: restartedClaimStore,
    publicationStore: restartedPublicationStore,
    agentBackend: successfulCoreBackend(() => { calls += 1; }, { claimActionFactory: oneValidClaimAction }),
    now,
  });

  assert.notEqual(restartedWorldviewStore.current(), null);
  assert.equal(restartedReportLibrary.get(admitted.reportVersionId).processingStatus, 'Processed');
  const [recoveredRun] = restartedWorldviewStore.listProcessingRuns().runs;
  assert.equal(recoveredRun.state, 'succeeded');
  assert.equal(recoveredRun.publicationId, restartedPublicationStore.list().publications[0].publicationId);
  assert.equal(recoveredRun.attempts.length, 1);
  assert.equal(restartedClaimStore.list().claims.length, 1);
  assert.equal(restartedClaimStore.actions().actions.length, 1);
  assert.equal(restartedClaimStore.publication(recoveredRun.publicationId).claims.length, 1);
  const recoveredClaim = restartedClaimStore.list().claims[0];
  assert.equal(recoveredClaim.publicationId, recoveredRun.publicationId);
  assert.equal(recoveredClaim.originatingRunId, recoveredRun.runId);
  const replay = await restarted.processTrigger(trigger);
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.runs[0].runId, recoveredRun.runId);
  assert.equal(restartedClaimStore.actions().actions.length, 1);
  assert.equal(restartedClaimStore.history(recoveredClaim.claimId).versions.length, 1);
  assert.equal(calls, 1);
});


test('valid and invalid Claim actions publish independently with the Worldview and exact receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-claims-mixed-issue41-'));
  const now = createClock('2026-09-10T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(root, 'canonical-worldview', 'run-publications'),
    now,
  });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    publicationStore,
    agentBackend: {
      async run(request, runtime = {}) {
        const gateway = new ToolGateway({
          request,
          contract: getAgentDefinition('core-worldview'),
          registry: toolRegistry,
          executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
          beforeExecute: runtime.beforeToolExecution,
          toolCallBudget: runtime.toolCallBudget,
        });
        const overviews = await gateway.execute('worldview_enumerate_overviews', {
          scopeId: request.input.capabilityScopeId,
        });
        const fullReport = await gateway.execute('worldview_read_report_version', {
          scopeId: request.input.capabilityScopeId,
          reportVersionId: overviews[0].reportVersionId,
        });
        const evidence = [{
          reportVersionId: fullReport.reportVersionId,
          contentDigest: fullReport.contentDigest,
          fingerprint: fullReport.fingerprint,
        }];
        const claimActions = [{
          actionId: 'action-valid-add',
          action: 'ADD',
          rationale: 'The report creates a new falsifiable judgment.',
          claim: {
            assertion: 'T1 capacity utilization will exceed 80% by 2027-03-31.',
            subject: 'T1 production capacity',
            tickers: ['T1'],
            rationale: 'Demand growth is outpacing the currently announced capacity additions.',
            verification: { pointAt: '2027-03-31T00:00:00.000Z' },
            metric: 'Reported production capacity utilization percentage',
            acceptanceCondition: 'The reported utilization is greater than 80%.',
            invalidationCondition: 'The reported utilization is 70% or lower.',
            evidence,
          },
        }, {
          actionId: 'action-invalid-add',
          action: 'ADD',
          rationale: 'This malformed item must be isolated.',
          claim: {
            assertion: 'This item omits its required acceptance condition.',
            subject: 'Malformed item',
            tickers: [],
            rationale: 'Invalid by contract.',
            verification: { pointAt: '2027-03-31T00:00:00.000Z' },
            metric: 'Missing-condition metric',
            invalidationCondition: 'Any contrary observation.',
            evidence,
          },
        }];
        return successfulResult(request, updateResult({ request, overviews, fullReport, claimActions }));
      },
    },
    now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-mixed-claims',
    batchId: 'batch-mixed-claims',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  });

  assert.equal(result.runs[0].acceptedClaimActions.length, 1);
  assert.equal(result.runs[0].rejectedClaimActions.length, 1);
  assert.equal(result.runs[0].rejectedClaimActions[0].code, 'CLAIM_INVALID_TEXT');
  const claimStore = new ClaimStore({
    rootDir: path.join(root, 'claim-library'),
    now,
    publicationReader: (publicationId) => {
      const publication = publicationStore.get(publicationId);
      return publication ? {
        publicationId,
        claimPublicationDigest: publication.claims.publicationDigest,
      } : false;
    },
  });
  const claims = claimStore.list().claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].assertion, 'T1 capacity utilization will exceed 80% by 2027-03-31.');
  assert.equal(claims[0].originatingRunId, result.runs[0].runId);
  assert.equal(claims[0].publicationId, result.runs[0].publicationId);
  assert.equal(worldviewStore.current().runId, result.runs[0].runId);
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Processed');
});


test('coordinator rejects a ClaimStore composition that could silently drop Claim actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-invalid-claim-store-issue41-'));
  assert.throws(() => new CanonicalWorldviewCoordinator({
    dataDir: root,
    claimStore: {},
    agentBackend: successfulCoreBackend(),
  }), /claimStore must expose snapshot/u);
});


test('configuration cannot raise the hard 100-Report workspace maximum', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-hard-100-issue41-'));
  const now = createClock('2026-09-11T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  assert.throws(() => new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: successfulCoreBackend(),
    now,
    maxOverviewCountPerRun: 101,
  }), /between 1 and 100/u);

  const admitted = [];
  for (let index = 1; index <= 101; index += 1) {
    admitted.push(await admit(reportLibrary, reportPackage(index), now));
  }
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: successfulCoreBackend(),
    now,
    maxOverviewCountPerRun: 100,
    maxOverviewBytesPerRun: 1_000_000,
    maxContextTokensPerRun: 400_000,
    maxOutputTokensPerRun: 400_000,
    maxWallClockMsPerRun: 3_600_000,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-hard-100',
    batchId: 'batch-hard-100',
    status: 'requested',
    pendingReportVersionIds: admitted.map((item) => item.reportVersionId),
    publishedAt: now(),
  });
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].overviewCount, 100);
  assert.equal(result.runs[0].processedReceipts.length, 100);
  assert.equal(reportLibrary.get(admitted[100].reportVersionId).processingStatus, 'Pending');
});


test('KEEP can atomically publish Claim changes and receipts without a redundant Worldview Version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-keep-claims-issue41-'));
  const now = createClock('2026-09-12T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const claimStore = new ClaimStore({ rootDir: path.join(root, 'claims'), now });
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    claimStore,
    agentBackend: {
      async run(request, runtime = {}) {
        const gateway = new ToolGateway({
          request,
          contract: getAgentDefinition('core-worldview'),
          registry: toolRegistry,
          executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
          beforeExecute: runtime.beforeToolExecution,
          toolCallBudget: runtime.toolCallBudget,
        });
        const overviews = await gateway.execute('worldview_enumerate_overviews', {
          scopeId: request.input.capabilityScopeId,
        });
        if (request.input.baseWorldviewVersionId) {
          await gateway.execute('worldview_read_current', { scopeId: request.input.capabilityScopeId });
        }
        const fullReport = await gateway.execute('worldview_read_report_version', {
          scopeId: request.input.capabilityScopeId,
          reportVersionId: overviews[0].reportVersionId,
        });
        if (!request.input.baseWorldviewVersionId) {
          return successfulResult(request, updateResult({
            request,
            overviews,
            fullReport,
            claimActions: [{
              actionId: 'bootstrap-add-claim',
              action: 'ADD',
              rationale: 'The bootstrap report introduces the first Claim.',
              claim: {
                assertion: 'T1 capacity utilization will exceed 70% by 2027-03-31.',
                subject: 'T1 production capacity',
                tickers: ['T1'],
                rationale: 'The first newly full-read report supports this bounded judgment.',
                verification: { pointAt: '2027-03-31T00:00:00.000Z' },
                metric: 'Reported T1 capacity utilization percentage',
                acceptanceCondition: 'The reported utilization is greater than 70%.',
                invalidationCondition: 'The reported utilization is 60% or lower.',
                evidence: [{
                  reportVersionId: fullReport.reportVersionId,
                  contentDigest: fullReport.contentDigest,
                  fingerprint: fullReport.fingerprint,
                }],
              },
            }],
          }));
        }
        assert.equal(request.input.currentClaims.length, 1);
        assert.equal(request.input.currentClaims[0].assertion, 'T1 capacity utilization will exceed 70% by 2027-03-31.');
        return successfulResult(request, {
          contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
          worldview: {
            action: 'KEEP',
            baseWorldviewVersionId: request.input.baseWorldviewVersionId,
            rationale: 'The new evidence changes a bounded Claim but not the coherent Worldview.',
            package: null,
          },
          claimActions: [{
            actionId: 'keep-add-claim',
            action: 'ADD',
            rationale: 'The new report introduces a distinct time-bound judgment.',
            claim: {
              assertion: 'T2 capacity utilization will exceed 75% by 2027-06-30.',
              subject: 'T2 production capacity',
              tickers: ['T2'],
              rationale: 'The newly full-read report supports the capacity judgment.',
              verification: { pointAt: '2027-06-30T00:00:00.000Z' },
              metric: 'Reported T2 capacity utilization percentage',
              acceptanceCondition: 'The reported utilization is greater than 75%.',
              invalidationCondition: 'The reported utilization is 65% or lower.',
              evidence: [{
                reportVersionId: fullReport.reportVersionId,
                contentDigest: fullReport.contentDigest,
                fingerprint: fullReport.fingerprint,
              }],
            },
          }],
        });
      },
    },
    now,
  });
  const first = await admit(reportLibrary, reportPackage(1), now);
  await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-keep-bootstrap', batchId: 'batch-keep-bootstrap',
    status: 'requested', pendingReportVersionIds: [first.reportVersionId], publishedAt: now(),
  });
  const versionId = worldviewStore.current().versionId;
  const second = await admit(reportLibrary, reportPackage(2), now);
  const keep = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-keep-claim', batchId: 'batch-keep-claim',
    status: 'requested', pendingReportVersionIds: [second.reportVersionId], publishedAt: now(),
  });

  assert.equal(keep.runs[0].outcome, 'KEEP');
  const frozenWorkspace = JSON.parse(fs.readFileSync(path.join(
    worldviewStore.rootDir,
    'run-workspaces',
    'workspaces',
    `${keep.runs[0].workspaceId}.json`,
  ), 'utf8'));
  assert.equal(frozenWorkspace.content.currentWorldview.versionId, versionId);
  assert.equal(frozenWorkspace.content.currentWorldview.documents.length, 7);
  assert.equal(frozenWorkspace.content.claims.length, 1);
  assert.deepEqual(frozenWorkspace.content.claimTable, [{
    claimId: frozenWorkspace.content.claims[0].claimId,
    version: 1,
    assertion: 'T1 capacity utilization will exceed 70% by 2027-03-31.',
  }]);
  assert.equal(worldviewStore.current().versionId, versionId);
  assert.equal(worldviewStore.listVersions().versions.length, 1);
  assert.equal(worldviewStore.listEvaluations().evaluations.length, 1);
  assert.equal(claimStore.list().claims.length, 2);
  assert.equal(keep.runs[0].acceptedClaimActions.length, 1);
  assert.equal(keep.runs[0].processedReceipts.length, 1);
  assert.equal(reportLibrary.get(first.reportVersionId).processingStatus, 'Processed');
  assert.equal(reportLibrary.get(second.reportVersionId).processingStatus, 'Processed');
});


test('KEEP evaluation visibility rejects a recomputed digest not bound by the publication marker', async () => {
  const fixture = await publishSingleUpdateFixture('2026-09-12T12:00:00.000Z');
  const admitted = await admit(fixture.reportLibrary, reportPackage(2), fixture.now);
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: fixture.root,
    reportLibrary: fixture.reportLibrary,
    worldviewStore: fixture.worldviewStore,
    publicationStore: fixture.publicationStore,
    agentBackend: {
      async run(request, runtime = {}) {
        const gateway = new ToolGateway({
          request,
          contract: getAgentDefinition('core-worldview'),
          registry: toolRegistry,
          executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
          beforeExecute: runtime.beforeToolExecution,
          toolCallBudget: runtime.toolCallBudget,
        });
        await gateway.execute('worldview_enumerate_overviews', { scopeId: request.input.capabilityScopeId });
        await gateway.execute('worldview_read_current', { scopeId: request.input.capabilityScopeId });
        await gateway.execute('worldview_read_report_version', {
          scopeId: request.input.capabilityScopeId,
          reportVersionId: request.input.overviews[0].reportVersionId,
        });
        return successfulResult(request, {
          contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
          worldview: {
            action: 'KEEP',
            baseWorldviewVersionId: request.input.baseWorldviewVersionId,
            rationale: 'The new material does not change the coherent Worldview.',
            package: null,
          },
          claimActions: [],
        });
      },
    },
    now: fixture.now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-keep-marker-tamper',
    batchId: 'batch-keep-marker-tamper', status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId], publishedAt: fixture.now(),
  });
  const evaluationId = result.runs[0].evaluationRecordId;
  const evaluationPath = path.join(fixture.worldviewStore.rootDir, 'evaluations', `${evaluationId}.json`);
  const evaluation = JSON.parse(fs.readFileSync(evaluationPath, 'utf8'));
  evaluation.rationale = 'Self-consistent altered KEEP rationale.';
  const { recordDigest: _originalDigest, ...content } = evaluation;
  evaluation.recordDigest = canonicalSha256(content);
  fs.writeFileSync(evaluationPath, `${canonicalStringify(evaluation)}\n`);

  assert.throws(
    () => fixture.worldviewStore.listEvaluations(),
    (error) => error?.code === 'WORLDVIEW_PUBLICATION_MARKER_MISMATCH',
  );
});


test('corrupt frozen workspace fails closed before spending a model attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-workspace-closed-issue41-'));
  const now = createClock('2026-09-13T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const realWorkspaceStore = new (await import('../src/domains/worldview/canonical/WorldviewRunWorkspaceStore.js')).WorldviewRunWorkspaceStore({
    rootDir: path.join(root, 'canonical-worldview', 'run-workspaces'),
  });
  const workspaceStore = {
    freeze: (input) => realWorkspaceStore.freeze(input),
    listIds: () => realWorkspaceStore.listIds(),
    load: () => {
      const error = new Error('workspace digest verification failed');
      error.code = 'WORLDVIEW_WORKSPACE_CORRUPT';
      throw error;
    },
  };
  let calls = 0;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    workspaceStore,
    agentBackend: { async run() { calls += 1; throw new Error('must not run'); } },
    now,
  });
  await assert.rejects(
    coordinator.processTrigger({
      contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-workspace-closed', batchId: 'batch-workspace-closed',
      status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
    }),
    (error) => error?.code === 'WORLDVIEW_WORKSPACE_CORRUPT',
  );
  assert.equal(calls, 0);
  const [run] = worldviewStore.listProcessingRuns().runs;
  assert.equal(run.state, 'FAILED_CLOSED');
  assert.deepEqual(run.attempts, []);
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
});


test('workspace freeze uses the complete Claim snapshot without a 10000-row pagination cutoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-complete-claims-issue41-'));
  const now = createClock('2026-09-29T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const claims = Array.from({ length: 10_001 }, (_, index) => ({
    claimId: `claim-${String(index).padStart(5, '0')}`,
    version: 1,
    assertion: `Claim assertion ${index}.`,
  }));
  let publicationReader = () => false;
  const claimStore = {
    snapshot: () => ({
      schemaVersion: 'claim-library-snapshot.v1',
      claims,
      table: claims,
      snapshotDigest: canonicalSha256(claims),
    }),
    bindPublicationReader: (reader) => { publicationReader = reader; return claimStore; },
    stageActions: ({ publicationId }) => ({
      status: 'staged', publicationId,
      publicationDigest: canonicalSha256({ publicationId, actions: [] }),
      acceptedActions: [], rejectedActions: [], claims: [],
    }),
    publication: (publicationId) => (publicationReader(publicationId) ? {
      publicationId, actions: [], rejections: [], claims: [],
    } : null),
  };
  let observedClaimCount = 0;
  let observedRequest = null;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    claimStore,
    agentBackend: successfulCoreBackend((request) => {
      observedRequest = request;
      observedClaimCount = request.input.currentClaims.length;
    }),
    maxContextTokensPerRun: 400_000,
    now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-complete-claims', batchId: 'batch-complete-claims',
    status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(observedClaimCount, 10_001);
  assert.deepEqual(validateJsonSchema(
    observedRequest.input.currentClaims,
    getAgentSchema('core-worldview.input.v1').properties.currentClaims,
  ), []);
  const prompt = getAgentDefinition('core-worldview').prompt(observedRequest.input);
  assert.match(prompt.user, /Claim assertion 10000\./u);
  assert.ok(Math.ceil(Buffer.byteLength(prompt.user, 'utf8') / 4) < 400_000);
  const workspace = JSON.parse(fs.readFileSync(path.join(
    worldviewStore.rootDir, 'run-workspaces', 'workspaces', `${result.runs[0].workspaceId}.json`,
  ), 'utf8'));
  assert.equal(workspace.content.claims.length, 10_001);
  assert.equal(workspace.content.claimTable.length, 10_001);
});


test('Canonical Worldview domain visibility requires a non-null unified publication marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-marker-required-issue41-'));
  const store = new CanonicalWorldviewStore({ rootDir: root });
  assert.equal(store.isPublicationCompleted(null), false);
  assert.equal(store.isPublicationCompleted(undefined), false);
  const source = fs.readFileSync(new URL('../src/domains/worldview/canonical/CanonicalWorldviewStore.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /publishUpdate\(\{ publicationId = null/u);
  assert.doesNotMatch(source, /recordEvaluation\(\{ publicationId = null/u);
});

test('resident server composes coordinator startup recovery before exposing Worldview reads', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const recoveryComposition = source.indexOf('createCanonicalWorldviewCoordinator({');
  const currentRoute = source.indexOf("app.get('/api/worldview/current'");
  assert.ok(recoveryComposition > 0);
  assert.ok(currentRoute > recoveryComposition);
});


test('complete attempts persist ordered safe physical model API start and completion audit in the unified publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-model-api-event-audit-issue41-'));
  const now = createClock('2026-09-06T15:30:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: path.join(worldviewRoot, 'run-publications'), now,
  });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const successBackend = successfulCoreBackend();
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    publicationStore,
    agentBackend: {
      async run(request, runtime) {
        await runtime.onModelApiAttempt({
          phase: 'started', attempt: 1, maxAttempts: 5, message: 'raw provider request must not persist',
        });
        await runtime.onModelApiAttempt({
          phase: 'completed', attempt: 1, maxAttempts: 5, status: 'failed',
          code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 429, message: 'raw provider failure must not persist',
        });
        await runtime.onModelApiAttempt({
          phase: 'started', attempt: 2, maxAttempts: 5, message: 'raw retry request must not persist',
        });
        await runtime.onModelApiAttempt({
          phase: 'completed', attempt: 2, maxAttempts: 5, status: 'succeeded',
          code: null, statusCode: null, message: 'raw response must not persist',
        });
        const result = await successBackend.run(request, runtime);
        return { ...result, metrics: { ...result.metrics, modelApiAttempts: 2 } };
      },
    },
    now,
  });
  const result = await coordinator.processTrigger({
    contract: 'worldview-processing-trigger.v1',
    triggerId: 'trigger-model-api-event-audit',
    batchId: 'batch-model-api-event-audit',
    status: 'requested',
    pendingReportVersionIds: [admitted.reportVersionId],
    publishedAt: now(),
  });

  const run = worldviewStore.getProcessingRun(result.runs[0].runId);
  const audit = run.attempts[0].modelApiAttemptAudit;
  assert.deepEqual(audit.map(({ recordedAt: _recordedAt, ...event }) => event), [
    { sequence: 1, phase: 'started', attempt: 1, maxAttempts: 5, status: null, code: null, statusCode: null },
    { sequence: 2, phase: 'completed', attempt: 1, maxAttempts: 5, status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 429 },
    { sequence: 3, phase: 'started', attempt: 2, maxAttempts: 5, status: null, code: null, statusCode: null },
    { sequence: 4, phase: 'completed', attempt: 2, maxAttempts: 5, status: 'succeeded', code: null, statusCode: null },
  ]);
  assert.ok(audit.every((event) => /^\d{4}-\d{2}-\d{2}T/u.test(event.recordedAt)));
  assert.doesNotMatch(JSON.stringify(audit), /raw provider|raw retry|raw response/u);
  assert.equal(run.attempts[0].modelApiAttempts, 2);
  assert.deepEqual(publicationStore.get(run.publicationId).attempts, run.attempts);
});



test('Core publication rejects invalid or incomplete physical model API audit transitions', async (t) => {
  const cases = [
    {
      name: 'completion before start',
      events: [{ phase: 'completed', attempt: 1, maxAttempts: 5, status: 'succeeded' }],
    },
    {
      name: 'started with terminal status',
      events: [{ phase: 'started', attempt: 1, maxAttempts: 5, status: 'succeeded' }],
    },
    {
      name: 'duplicate start',
      events: [
        { phase: 'started', attempt: 1, maxAttempts: 5 },
        { phase: 'started', attempt: 1, maxAttempts: 5 },
      ],
    },
    {
      name: 'completion without status',
      events: [
        { phase: 'started', attempt: 1, maxAttempts: 5 },
        { phase: 'completed', attempt: 1, maxAttempts: 5 },
      ],
    },
    {
      name: 'successful result with an open physical attempt',
      events: [{ phase: 'started', attempt: 1, maxAttempts: 5 }],
      delegate: true,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `worldview-invalid-model-audit-${index}-issue41-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const now = createClock(`2026-09-${String(10 + index).padStart(2, '0')}T18:00:00.000Z`);
    const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
    const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
    const admitted = await admit(reportLibrary, reportPackage(index + 1), now);
    const successBackend = successfulCoreBackend();
    const coordinator = new CanonicalWorldviewCoordinator({
      dataDir: root,
      reportLibrary,
      worldviewStore,
      agentBackend: {
        async run(request, runtime) {
          for (const event of item.events) await runtime.onModelApiAttempt(event);
          if (item.delegate) return successBackend.run(request, runtime);
          throw new Error('invalid audit event should fail before backend completion');
        },
      },
      now,
    });

    await assert.rejects(
      coordinator.processTrigger({
        contract: 'worldview-processing-trigger.v1',
        triggerId: `trigger-invalid-model-audit-${index}`,
        batchId: `batch-invalid-model-audit-${index}`,
        status: 'requested',
        pendingReportVersionIds: [admitted.reportVersionId],
        publishedAt: now(),
      }),
      (error) => error?.code === 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID',
      item.name,
    );
    const [run] = worldviewStore.listProcessingRuns().runs;
    assert.equal(run.state, 'FAILED_CLOSED', item.name);
    assert.equal(run.publicationId || null, null, item.name);
    assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending', item.name);
  }
});

test('a hard interruption preserves the started model API attempt audit before whole-Agent recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-model-api-audit-issue41-'));
  const now = createClock('2026-09-06T16:00:00.000Z');
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const abrupt = new Error('simulated hard interruption after physical model API start');
  abrupt.code = 'WORLDVIEW_INJECTED_MODEL_API_INTERRUPTION';
  const realUpdate = worldviewStore.updateProcessingRun.bind(worldviewStore);
  let durableModelStart = false;
  worldviewStore.updateProcessingRun = (runId, patch, options) => {
    const attempt = patch?.attempts?.at(-1);
    if (attempt?.status === 'running' && attempt.modelApiAttempts === 1) {
      const result = realUpdate(runId, patch, options);
      durableModelStart = true;
      return result;
    }
    if (durableModelStart && (attempt?.status === 'failed' || patch?.state === 'FAILED_CLOSED')) throw abrupt;
    return realUpdate(runId, patch, options);
  };
  const trigger = {
    contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-model-api-audit', batchId: 'batch-model-api-audit',
    status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
  };
  const interrupted = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore,
    agentBackend: {
      async run(_request, runtime) {
        await runtime.onModelApiAttempt({
          phase: 'started', attempt: 1, maxAttempts: 5, message: 'raw interrupted provider request',
        });
        throw abrupt;
      },
    },
    now,
  });
  await assert.rejects(interrupted.processTrigger(trigger), (error) => error?.code === abrupt.code);
  const interruptedRun = worldviewStore.listProcessingRuns().runs[0];
  assert.equal(interruptedRun.state, 'running');
  assert.equal(interruptedRun.attempts[0].status, 'running');
  assert.equal(interruptedRun.attempts[0].modelApiAttempts, 1);
  assert.equal(interruptedRun.attempts[0].modelApiLastStatus, 'started');
  assert.deepEqual(
    interruptedRun.attempts[0].modelApiAttemptAudit.map(({ recordedAt: _recordedAt, ...event }) => event),
    [{ sequence: 1, phase: 'started', attempt: 1, maxAttempts: 5, status: null, code: null, statusCode: null }],
  );
  assert.doesNotMatch(JSON.stringify(interruptedRun.attempts[0].modelApiAttemptAudit), /raw interrupted/u);

  const restartedStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const restarted = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary: new ReportLibraryStore({ rootDir: reportRoot, now }),
    worldviewStore: restartedStore,
    agentBackend: successfulCoreBackend(),
    now,
  });
  const recovered = await restarted.processTrigger(trigger);
  assert.equal(recovered.status, 'succeeded');
  const finalRun = restartedStore.getProcessingRun(interruptedRun.runId);
  assert.equal(finalRun.attempts.length, 2);
  assert.equal(finalRun.attempts[0].status, 'failed');
  assert.equal(finalRun.attempts[0].stopReason, 'process-interrupted');
  assert.equal(finalRun.attempts[0].modelApiAttempts, 1);
  assert.deepEqual(
    finalRun.attempts[0].modelApiAttemptAudit,
    interruptedRun.attempts[0].modelApiAttemptAudit,
  );
  assert.equal(finalRun.attempts[1].status, 'succeeded');
});


test('complete Claim table that exceeds the frozen context bound fails before a model call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldview-claim-context-bound-issue41-'));
  const now = createClock('2026-09-29T12:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admit(reportLibrary, reportPackage(1), now);
  const claims = Array.from({ length: 3_000 }, (_, index) => ({
    claimId: `bounded-claim-${String(index).padStart(5, '0')}`,
    version: 1,
    assertion: `A complete but deliberately context-heavy Claim assertion ${index}.`,
  }));
  const claimStore = {
    snapshot: () => ({ claims, table: claims, snapshotDigest: canonicalSha256(claims) }),
    bindPublicationReader: () => claimStore,
    stageActions: () => { throw new Error('must not stage'); },
    publication: () => null,
  };
  let calls = 0;
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, claimStore,
    agentBackend: { async run() { calls += 1; throw new Error('must not call model'); } },
    now,
  });
  await assert.rejects(
    coordinator.processTrigger({
      contract: 'worldview-processing-trigger.v1', triggerId: 'trigger-claim-context-bound', batchId: 'batch-claim-context-bound',
      status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], publishedAt: now(),
    }),
    (error) => error?.code === 'WORLDVIEW_COMPLETE_CLAIM_CONTEXT_TOO_LARGE',
  );
  assert.equal(calls, 0);
  assert.equal(worldviewStore.listProcessingRuns().runs.length, 0);
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
});


test('Core Worldview prompt states the exact nested package evidence and implication shapes', () => {
  const prompt = getAgentDefinition('core-worldview').prompt({});
  assert.match(prompt.system, /causalRelationships item is exactly \{relationshipId,cause,effect,mechanism,confidence,evidence,counterEvidence\}/u);
  assert.match(prompt.system, /package evidence item is exactly \{reportVersionId,contentDigest,kind:"supporting",summary\}/u);
  assert.match(prompt.system, /investmentImplications item is exactly \{theme,implication,horizon,confidence\}/u);
  assert.match(prompt.system, /updateSummary is exactly \{retained:\[string,\.\.\.\],changed:\[string,\.\.\.\],added:\[string,\.\.\.\],removed:\[string,\.\.\.\]\}/u);
  assert.match(prompt.system, /do not add fingerprint, summary, relevance, or other fields/u);
});


test('Core Worldview retries invalid result shape only as a fresh complete Agent attempt', () => {
  assert.equal(getAgentDefinition('core-worldview').completionPolicy.gracefulFinalize, false);
});
