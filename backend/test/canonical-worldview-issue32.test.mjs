import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DailyReportBatchAdmission,
  ReportAdmissionService,
  ReportLibraryStore,
  ReportOverviewService,
} from '../src/domains/reports/index.js';
import {
  CANONICAL_WORLDVIEW_PACKAGE_CONTRACT,
  CURRENT_WORLDVIEW_CONTRACT,
  WORLDVIEW_AGENT_RESULT_CONTRACT,
  CanonicalWorldviewStore,
  WorldviewCapabilityScope,
  normalizeWorldviewAgentResult,
  runWorldviewCapabilityTool,
  worldviewOverviewManifest,
} from '../src/domains/worldview/canonical/index.js';
import { CanonicalWorldviewCoordinator } from '../src/workflows/worldview/canonicalWorldviewCoordinator.js';
import { ToolGateway } from '../src/core/tools/ToolGateway.js';
import { getAgentDefinition } from '../src/agents/registry.js';
import { runTool } from '../src/tools/index.js';
import { toolRegistry } from '../src/tools/toolCatalog.js';

const sha256 = (value) => `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;

function createClock(start = '2026-08-20T00:00:00.000Z') {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value).toISOString();
    value += 1_000;
    return current;
  };
}

function reportPackage({
  projectId,
  analysisRunId,
  dailyReportRunId = null,
  ticker,
  title,
  asOf,
  markdown = `# ${title}\n\nExact evidence for ${ticker}.\n`,
}) {
  return {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('run-analysis.v2') },
      reportRef: {
        contract: 'artifact-ref.v1',
        artifactId: `artifact-${analysisRunId}`,
        version: 1,
        path: 'report/report.md',
        contentDigest: sha256(markdown),
        schemaVersion: 'run-analysis-report.v1',
        producer: 'run-analysis',
        contractVersion: '1.0.0',
        inputDigest: sha256(`input-${analysisRunId}`),
        createdAt: '2026-08-20T00:00:00.000Z',
        asOf,
      },
    },
    lineage: { projectId, analysisRunId },
    dailyReport: dailyReportRunId === null ? null : { runId: dailyReportRunId },
    report: { mediaType: 'text/markdown', charset: 'utf-8', markdown, contentDigest: sha256(markdown) },
    metadata: {
      tickers: [ticker],
      theme: 'Canonical Worldview acceptance',
      searchTags: ['worldview', ticker],
      title,
      asOf,
      generatedAt: '2026-08-20T00:00:00.000Z',
    },
  };
}

function reportOverviewOutput(input) {
  return {
    overview: {
      reportVersionId: input.reportVersionId,
      contentDigest: input.contentDigest,
      summary: `Discovery summary for ${input.metadata.title}.`,
      keyThemes: ['canonical worldview'],
      entities: [{ name: input.metadata.tickers[0], type: 'ticker', tickers: input.metadata.tickers }],
      materialDevelopments: [`Material development in ${input.metadata.title}.`],
      uncertainties: ['Exact ReportVersion reading is required before direct evidence use.'],
    },
  };
}

function updateResult({ request, fullReport }) {
  const evidenceRef = {
    reportVersionId: fullReport.reportVersionId,
    contentDigest: fullReport.contentDigest,
  };
  return {
    contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
    worldview: {
      action: 'UPDATE',
      baseWorldviewVersionId: request.input.baseWorldviewVersionId,
      rationale: 'The newly admitted evidence establishes the initial canonical causal view.',
      package: {
        title: 'Canonical Investment Worldview',
        asOf: request.asOf,
        narrativeMarkdown: '# Canonical Investment Worldview\n\nAI infrastructure demand and constrained supply shape the current causal view.\n',
        causalRelationships: [{
          relationshipId: 'ai-demand-to-capacity',
          cause: 'AI infrastructure demand',
          effect: 'Capacity investment',
          mechanism: 'Sustained demand raises utilization and induces capacity investment.',
          confidence: 'medium',
          evidence: [evidenceRef],
          counterEvidence: [],
        }],
        evidence: [{ ...evidenceRef, kind: 'supporting', summary: 'Exact report evidence supports the causal view.' }],
        counterEvidence: [],
        investmentImplications: [{
          theme: 'AI infrastructure',
          implication: 'Prefer capacity owners with visible demand and disciplined expansion.',
          horizon: '12-24 months',
          confidence: 'medium',
        }],
        coverage: {
          overviewIds: request.input.overviews.map((item) => item.overviewId),
          reportVersionIds: request.input.overviews.map((item) => item.reportVersionId),
          selectedFullReadReportVersionIds: [fullReport.reportVersionId],
        },
        updateSummary: {
          retained: [],
          changed: [],
          added: ['Initial AI infrastructure causal relationship'],
          removed: [],
        },
      },
    },
    claimActions: [],
  };
}

function keepResult({ request }) {
  return {
    contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
    worldview: {
      action: 'KEEP',
      baseWorldviewVersionId: request.input.baseWorldviewVersionId,
      rationale: 'The evidence changes confidence and coverage but not the core macro causal understanding.',
      package: null,
    },
    claimActions: [],
  };
}

function successfulAgentResult(request, output) {
  return {
    status: 'succeeded',
    valid: true,
    output,
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    provider: 'scripted',
    model: request.agentContractId === 'core-worldview' ? 'scripted-high-capability' : 'scripted-small',
    live: false,
    metrics: { providerAttempts: 0, networkAttempts: 0, liveModelAttempts: 0 },
    stopReason: 'final',
    traceRef: `trace:${request.runId}`,
  };
}

async function admitReport(reportLibrary, packageInput, now) {
  const overviewService = new ReportOverviewService({
    agentRunner: async (_agentId, input) => ({
      status: 'succeeded',
      valid: true,
      output: reportOverviewOutput(input),
      artifacts: [],
      evidenceRefs: [],
      openQuestions: [],
      dataRequests: [],
      provider: 'scripted',
      model: 'scripted-small',
      live: false,
      metrics: { providerAttempts: 0, networkAttempts: 0, liveModelAttempts: 0 },
      stopReason: 'final',
      traceRef: 'trace:late-report-overview',
    }),
    now,
  });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  return admissionService.admit(packageInput);
}

async function admitReady(admission, { batchId, itemId, packageInput, attemptId }) {
  return admission.completeItem({
    batchId,
    itemId,
    packageInput: { ...packageInput, dailyReport: { runId: batchId } },
    admissionAttemptId: attemptId,
  });
}

test('Daily Report Batch closure publishes bounded UPDATE/KEEP runs and leaves reports admitted during a run pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-issue32-'));
  const reportRoot = path.join(root, 'report-library');
  const worldviewRoot = path.join(root, 'canonical-worldview');
  const now = createClock();
  const reportLibrary = new ReportLibraryStore({ rootDir: reportRoot, now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: worldviewRoot, now });
  const calls = [];
  let lateAdmission = null;

  const backend = {
    async run(request, runtime = {}) {
      calls.push({ agentId: request.agentContractId, runId: request.runId });
      if (request.agentContractId === 'report-overview') {
        return successfulAgentResult(request, reportOverviewOutput(request.input));
      }
      assert.equal(request.agentContractId, 'core-worldview');
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
      assert.equal(overviews.length, request.input.baseWorldviewVersionId ? 1 : 2);
      if (request.input.baseWorldviewVersionId) {
        const current = await gateway.execute('worldview_read_current', {
          scopeId: request.input.capabilityScopeId,
        });
        assert.equal(current.versionId, request.input.baseWorldviewVersionId);
      }
      const fullReport = await gateway.execute('worldview_read_report_version', {
        scopeId: request.input.capabilityScopeId,
        reportVersionId: overviews[0].reportVersionId,
      });
      if (!lateAdmission) {
        const latePackage = reportPackage({
          projectId: 'project-late', analysisRunId: 'analysis-late',
          ticker: 'LATE', title: 'Late admitted report', asOf: '2026-01-01T00:00:00.000Z',
        });
        const admitted = await admitReport(reportLibrary, latePackage, now);
        lateAdmission = admitted;
      }
      const output = request.input.baseWorldviewVersionId
        ? keepResult({ request })
        : updateResult({ request, overview: overviews[0], fullReport });
      return successfulAgentResult(request, output);
    },
  };

  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root,
    reportLibrary,
    worldviewStore,
    agentBackend: backend,
    now,
    maxOverviewCountPerRun: 10,
    maxOverviewBytesPerRun: 100_000,
    maxWallClockMsPerRun: 2_000,
  });
  const overviewService = new ReportOverviewService({ reportLibrary, agentBackend: backend, now });
  const admission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: new ReportAdmissionService({ reportLibrary, overviewService }),
    worldviewCoordinator: coordinator,
    now,
  });

  const created = admission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-08-20',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-20',
    items: [
      { itemId: 'item-one', projectId: 'project-one', sourceIdeaId: 'idea-one' },
      { itemId: 'item-two', projectId: 'project-two', sourceIdeaId: 'idea-two' },
    ],
  });
  const first = await admitReady(admission, {
    batchId: created.batchId,
    itemId: 'item-one',
    attemptId: 'overview-one',
    packageInput: reportPackage({
      projectId: 'project-one', analysisRunId: 'analysis-one', dailyReportRunId: created.batchId,
      ticker: 'NEW', title: 'Newer as-of report', asOf: '2026-08-19T00:00:00.000Z',
    }),
  });
  const second = await admitReady(admission, {
    batchId: created.batchId,
    itemId: 'item-two',
    attemptId: 'overview-two',
    packageInput: reportPackage({
      projectId: 'project-two', analysisRunId: 'analysis-two', dailyReportRunId: created.batchId,
      ticker: 'OLD', title: 'Backfilled old as-of report', asOf: '2025-01-01T00:00:00.000Z',
    }),
  });

  const closed = admission.close(created.batchId);
  const concurrentReplay = admission.close(created.batchId);
  assert.equal(closed.processingTrigger.status, 'requested');
  assert.ok(closed.processingPromise instanceof Promise);
  assert.equal(concurrentReplay.processingPromise, closed.processingPromise);
  const cycle = await closed.processingPromise;

  assert.equal(cycle.status, 'succeeded');
  assert.equal(cycle.runs.length, 1);
  assert.deepEqual(cycle.runs.map((run) => run.outcome), ['UPDATE']);
  assert.equal(
    cycle.runs[0].frozenRange.startAdmissionSequence,
    reportLibrary.get(first.item.outcome.reportVersionId).admissionSequence,
  );
  assert.equal(cycle.runs[0].overviewCount, 2);
  assert.equal(calls.filter((call) => call.agentId === 'core-worldview').length, 1);
  assert.ok(lateAdmission);

  const versions = worldviewStore.listVersions();
  assert.equal(versions.versions.length, 1, 'KEEP must not create a redundant Worldview Version');
  assert.equal(versions.versions[0].contract, CANONICAL_WORLDVIEW_PACKAGE_CONTRACT);
  const version = worldviewStore.getVersion(versions.versions[0].versionId);
  assert.equal(version.documents.length, 7);
  assert.equal(version.integrity.valid, true);
  assert.equal(worldviewStore.current().contract, CURRENT_WORLDVIEW_CONTRACT);
  assert.equal(worldviewStore.listEvaluations().evaluations.length, 0);

  const log = worldviewStore.listProcessingRuns();
  assert.equal(log.runs.length, 1);
  assert.deepEqual(log.runs.map((run) => run.outcome), ['UPDATE']);
  assert.ok(log.runs.every((run) => run.state === 'succeeded'));
  assert.ok(log.runs.every((run) => run.selectedFullReads.length === 1));
  assert.ok(log.runs.every((run) => run.claimActionCount === 0));
  assert.ok(log.runs.every((run) => run.bounds.maxOverviewCountPerRun === 10));
  assert.ok(log.runs.every((run) => run.bounds.maxContextTokensPerRun === 32_000));
  assert.ok(log.runs.every((run) => run.bounds.maxOutputTokensPerRun === 32_768));
  assert.ok(log.runs.every((run) => run.bounds.maxWallClockMsPerRun === 2_000));
  assert.ok(log.runs.every((run) => run.bounds.maxToolCallsPerRun === 256));
  assert.ok(log.runs.every((run) => run.execution.live === false));
  assert.ok(log.runs.every((run) => run.execution.attemptEvidence.providerAttempts === 0));
  assert.ok(log.runs.every((run) => run.execution.attemptEvidence.networkAttempts === 0));
  assert.ok(log.runs.every((run) => run.execution.attemptEvidence.liveModelAttempts === 0));

  assert.equal(cycle.runs[0].processedReceipts.length, 2);
  assert.equal(reportLibrary.get(first.item.outcome.reportVersionId).processingStatus, 'Processed');
  assert.equal(reportLibrary.get(second.item.outcome.reportVersionId).processingStatus, 'Processed');
  assert.equal(reportLibrary.get(lateAdmission.reportVersionId).processingStatus, 'Pending');

  const followup = admission.createBatch({
    contract: 'daily-report-batch.v1', productionDate: '2026-08-21', producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-21', items: [],
  });
  const followupClosed = admission.close(followup.batchId);
  const followupCycle = await followupClosed.processingPromise;
  assert.equal(followupCycle.runs.length, 1);
  assert.equal(followupCycle.runs[0].frozenRange.startAdmissionSequence, lateAdmission.reportVersion.admissionSequence);
  assert.equal(reportLibrary.get(lateAdmission.reportVersionId).processingStatus, 'Processed');
  assert.equal(worldviewStore.listVersions().versions.length, 1);
  assert.equal(worldviewStore.listEvaluations().evaluations.length, 1);
  assert.equal(calls.some((call) => call.agentId !== 'report-overview' && call.agentId !== 'core-worldview'), false);
  const coreCallsBeforeReplay = calls.filter((call) => call.agentId === 'core-worldview').length;
  const replayAfterSuccess = admission.close(created.batchId);
  const replayedCycle = await replayAfterSuccess.processingPromise;
  assert.equal(replayedCycle.status, 'succeeded');
  assert.equal(replayedCycle.runs.length, 1);
  assert.equal(replayedCycle.runs[0].runId, cycle.runs[0].runId);
  assert.equal(calls.filter((call) => call.agentId === 'core-worldview').length, coreCallsBeforeReplay);
  assert.equal(worldviewStore.listVersions().versions.length, 1);
  fs.rmSync(path.join(worldviewRoot, 'current.json'));
  assert.equal(worldviewStore.rebuildCurrent().versionId, versions.versions[0].versionId);

  const worldviewDocument = path.join(worldviewRoot, 'versions', versions.versions[0].versionId, 'worldview.md');
  fs.appendFileSync(worldviewDocument, '\ntampered');
  assert.throws(() => worldviewStore.getVersion(versions.versions[0].versionId), /integrity|digest/i);
});

test('bootstrap KEEP exhausts the bounded attempt window without publication or receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-invalid-'));
  const now = createClock('2026-08-22T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const worldviewStore = new CanonicalWorldviewStore({ rootDir: path.join(root, 'canonical-worldview'), now });
  const admitted = await admitReport(reportLibrary, reportPackage({
    projectId: 'invalid-project', analysisRunId: 'invalid-analysis',
    ticker: 'BAD', title: 'Invalid bootstrap report', asOf: '2026-08-22T00:00:00.000Z',
  }), now);
  let calls = 0;
  const backend = {
    async run(request, runtime = {}) {
      calls += 1;
      runtime.worldviewCapabilities.enumerateOverviews();
      return successfulAgentResult(request, keepResult({ request }));
    },
  };
  const coordinator = new CanonicalWorldviewCoordinator({
    dataDir: root, reportLibrary, worldviewStore, agentBackend: backend, now,
  });
  await assert.rejects(
    coordinator.processTrigger({
      contract: 'worldview-processing-trigger.v1', triggerId: 'worldview_trigger_invalid', batchId: 'daily_batch_invalid',
      publishedAt: now(), status: 'requested', pendingReportVersionIds: [admitted.reportVersionId],
      pendingReportCount: 1, coreWorldviewAgentCalls: 0,
    }),
    (error) => error?.code === 'WORLDVIEW_AGENT_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(calls, 3);
  assert.equal(worldviewStore.listVersions().versions.length, 0);
  const runs = worldviewStore.listProcessingRuns().runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'FAILED_EXHAUSTED');
  assert.equal(runs[0].outcome, null);
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
});


test('run-scoped Worldview capabilities reject undeclared and out-of-range reads while tracing exact verified content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-capability-'));
  const now = createClock('2026-08-24T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const admitted = await admitReport(reportLibrary, reportPackage({
    projectId: 'capability-project', analysisRunId: 'capability-analysis',
    ticker: 'CAP', title: 'Capability report', asOf: '2026-08-24T00:00:00.000Z',
  }), now);
  const overview = admitted.overview.overview;
  const detail = reportLibrary.get(admitted.reportVersionId);
  const manifest = worldviewOverviewManifest([{
    ordinal: 0,
    admissionSequence: detail.admissionSequence,
    reportVersionId: detail.reportVersionId,
    contentDigest: detail.contentDigest,
    fingerprint: detail.fingerprint,
    overviewId: overview.overviewId,
    overviewDigest: overview.overviewDigest,
    overviewContentDigest: overview.contentDigest,
    overview: overview.content,
  }]);
  const scope = new WorldviewCapabilityScope({
    scopeId: 'worldview_scope_capability', runId: 'worldview_run_capability', manifest, frozenCurrent: null,
    reportLibrary, tracePath: path.join(root, 'trace.jsonl'), now,
  });
  const release = scope.activate();
  try {
    const overviews = runWorldviewCapabilityTool('worldview_enumerate_overviews', { scopeId: scope.scopeId });
    assert.equal(overviews.length, 1);
    const full = runWorldviewCapabilityTool('worldview_read_report_version', {
      scopeId: scope.scopeId,
      reportVersionId: admitted.reportVersionId,
    });
    assert.equal(full.verified, true);
    assert.equal(full.contentDigest, admitted.contentDigest);
    assert.throws(() => runWorldviewCapabilityTool('worldview_read_report_version', {
      scopeId: scope.scopeId,
      reportVersionId: 'report_outside_frozen_range',
    }), /outside the frozen/i);
    assert.throws(() => scope.authorizeTool({
      toolName: 'ws_read_file', args: { scopeId: scope.scopeId, file: '../../secret' },
    }), /not approved/i);
    assert.deepEqual(runWorldviewCapabilityTool('worldview_search_claims', { scopeId: scope.scopeId, query: 'AI' }).claims, []);
    assert.deepEqual(scope.selectedFullReads().map((item) => item.reportVersionId), [admitted.reportVersionId]);
  } finally {
    release();
  }
  assert.throws(() => runWorldviewCapabilityTool('worldview_enumerate_overviews', { scopeId: scope.scopeId }), /not active/i);
});

test('direct evidence that was not fully read is rejected by deterministic Worldview validation', () => {
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const manifest = worldviewOverviewManifest([{
    ordinal: 0, admissionSequence: 1, reportVersionId: 'report_unread', contentDigest,
    fingerprint: `sha256:${'b'.repeat(64)}`, overviewId: 'overview_unread',
    overviewDigest: `sha256:${'c'.repeat(64)}`, overviewContentDigest: `sha256:${'d'.repeat(64)}`,
    overview: { summary: 'Unread report discovery.' },
  }]);
  const result = {
    contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
    worldview: {
      action: 'UPDATE', baseWorldviewVersionId: null, rationale: 'Invalid unread evidence.',
      package: {
        title: 'Invalid', asOf: '2026-08-24T00:00:00.000Z', narrativeMarkdown: '# Invalid\n',
        causalRelationships: [{ relationshipId: 'invalid-unread', cause: 'A', effect: 'B', mechanism: 'C', confidence: 'low', evidence: [{ reportVersionId: 'report_unread', contentDigest }], counterEvidence: [] }],
        evidence: [{ reportVersionId: 'report_unread', contentDigest, kind: 'supporting', summary: 'Unread.' }],
        counterEvidence: [],
        investmentImplications: [{ theme: 'Invalid', implication: 'Reject.', horizon: 'none', confidence: 'low' }],
        coverage: { overviewIds: ['overview_unread'], reportVersionIds: ['report_unread'], selectedFullReadReportVersionIds: [] },
        updateSummary: { retained: [], changed: [], added: ['Invalid'], removed: [] },
      },
    },
    claimActions: [],
  };
  assert.throws(() => normalizeWorldviewAgentResult(result, {
    baseWorldviewVersionId: null, manifest, selectedFullReads: [],
  }), /unread|unverified/i);
});

test('a failed admission candidate stays private and does not add a readiness branch to Pending reports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-gap-'));
  const now = createClock('2026-08-25T00:00:00.000Z');
  const reportLibrary = new ReportLibraryStore({ rootDir: path.join(root, 'report-library'), now });
  const failedPackage = reportPackage({
    projectId: 'gap-first', analysisRunId: 'gap-first-analysis',
    ticker: 'GAP', title: 'Earlier failed admission', asOf: '2026-08-25T00:00:00.000Z',
  });
  const failedAdmission = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      agentBackend: { async run() { throw Object.assign(new Error('temporary'), { transient: true }); } },
      now,
    }),
    maxImmediateAttempts: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  await assert.rejects(failedAdmission.admit(failedPackage), (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE');
  const second = await admitReport(reportLibrary, reportPackage({
    projectId: 'gap-second', analysisRunId: 'gap-second-analysis',
    ticker: 'NEXT', title: 'Later ready report', asOf: '2026-08-25T01:00:00.000Z',
  }), now);
  const pending = reportLibrary.listAdmissionOrdered().reports;
  assert.deepEqual(pending.map((report) => report.reportVersionId), [second.reportVersionId]);
  assert.equal(reportLibrary.get(failedAdmission.candidateStore.list()[0].reportVersionId), null);
  assert.equal(reportLibrary.get(second.reportVersionId).processingStatus, 'Pending');
});


test('Core Worldview Agent registry, schemas, Golden fixture inputs, and return-only authority are governed', async () => {
  const [{ getAgentDefinition, listCanonicalWorldviewAgentDefinitions }, { getAgentSchema }] = await Promise.all([
    import('../src/agents/registry.js'),
    import('../src/core/validation/agentSchemaRegistry.js'),
  ]);
  const definition = getAgentDefinition('core-worldview');
  assert.deepEqual(listCanonicalWorldviewAgentDefinitions().map((item) => item.id), ['core-worldview']);
  assert.equal(definition.executionMode, 'tool-loop');
  assert.equal(definition.modelPolicy.tier, 'main');
  assert.equal(definition.modelPolicy.reasoningLevel, 'high');
  assert.equal(definition.artifactAuthority, 'return');
  assert.deepEqual(definition.outputPaths, []);
  assert.deepEqual(definition.toolPolicy.allow, [
    'worldview_read_current', 'worldview_enumerate_overviews',
    'worldview_read_report_version', 'worldview_search_claims',
  ]);
  assert.ok(getAgentSchema('worldview-agent-result.v1'));
  assert.ok(getAgentSchema('core-worldview.input.v1'));

  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/canonical-worldview/v1/bootstrap-update.json', import.meta.url), 'utf8'));
  const manifest = worldviewOverviewManifest([{
    ordinal: 0, admissionSequence: 1, reportVersionId: 'report_fixture', contentDigest: `sha256:${'a'.repeat(64)}`,
    fingerprint: `sha256:${'b'.repeat(64)}`, overviewId: 'overview_fixture',
    overviewDigest: `sha256:${'c'.repeat(64)}`, overviewContentDigest: `sha256:${'d'.repeat(64)}`,
    overview: { summary: 'Fixture Overview.' },
  }]);
  assert.equal(normalizeWorldviewAgentResult(fixture, {
    baseWorldviewVersionId: null,
    manifest,
    selectedFullReads: [{ reportVersionId: 'report_fixture', contentDigest: `sha256:${'a'.repeat(64)}` }],
  }).worldview.action, 'UPDATE');
  const keep = JSON.parse(fs.readFileSync(new URL('./fixtures/canonical-worldview/v1/incremental-keep.json', import.meta.url), 'utf8'));
  assert.equal(normalizeWorldviewAgentResult(keep, {
    baseWorldviewVersionId: 'worldview_v_fixture',
  }).worldview.action, 'KEEP');
});


test('Daily Report Batch closure records a restart-recoverable Canonical Worldview trigger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-trigger-recovery-'));
  const { DailyReportBatchStore } = await import('../src/domains/reports/index.js');
  const batchStore = new DailyReportBatchStore({ rootDir: root });
  const reportLibrary = {
    listPendingReports: () => ({ reports: [{ reportVersionId: 'report_recoverable' }] }),
  };
  const firstCoordinator = {
    processTrigger: () => new Promise(() => {}),
    resumeTriggers: async () => [],
  };
  const firstAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: {},
    batchStore,
    worldviewCoordinator: firstCoordinator,
  });
  const batch = firstAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-08-28',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-recovery',
    items: [],
  });
  const closed = firstAdmission.close(batch.batchId);
  assert.equal(closed.processingTrigger.processingTarget, 'canonical-worldview-processing.v1');

  let recovered = [];
  const restartedAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: {},
    batchStore,
    worldviewCoordinator: {
      processTrigger: async () => ({ status: 'no-work' }),
      resumeTriggers: async (triggers) => { recovered = triggers; return []; },
    },
  });
  await restartedAdmission.recoveryPromise;
  assert.deepEqual(recovered.map((trigger) => trigger.triggerId), [closed.processingTrigger.triggerId]);
});

test('registered Core Worldview schemas keep Worldview strict while Claim action items cross the partial-validation seam', async () => {
  const [{ getAgentSchema }, { validateJsonSchema }] = await Promise.all([
    import('../src/core/validation/agentSchemaRegistry.js'),
    import('../src/core/validation/OutputGate.js'),
  ]);
  const outputSchema = getAgentSchema('worldview-agent-result.v1');
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/canonical-worldview/v1/bootstrap-update.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateJsonSchema(fixture, outputSchema), []);
  const badOutput = structuredClone(fixture);
  badOutput.claimActions.push({ unsupported: true });
  assert.deepEqual(validateJsonSchema(badOutput, outputSchema), []);
  badOutput.claimActions = [];
  badOutput.worldview.package.coverage.extra = true;
  assert.ok(validateJsonSchema(badOutput, outputSchema).some((error) => /match exactly one|not allowed/u.test(error)));

  const inputSchema = getAgentSchema('core-worldview.input.v1');
  const invalidInput = {
    runId: 'worldview_run_schema',
    asOf: '2026-08-28T00:00:00.000Z',
    capabilityScopeId: 'worldview_scope_schema',
    baseWorldviewVersionId: null,
    frozenRange: { priorProcessedReceiptCount: 0, startAdmissionSequence: 1, endAdmissionSequence: 1, extra: true },
    overviewManifestDigest: `sha256:${'a'.repeat(64)}`,
    overviews: [{ reportVersionId: 'report_only' }],
    currentClaims: [],
    approvedCapabilities: ['worldview_enumerate_overviews'],
  };
  const errors = validateJsonSchema(invalidInput, inputSchema);
  assert.ok(errors.some((error) => /frozenRange\.extra.*not allowed/u.test(error)));
  assert.ok(errors.some((error) => /overviews\[0\].ordinal is required/u.test(error)));
});
