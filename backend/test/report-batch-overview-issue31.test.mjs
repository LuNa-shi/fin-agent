import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAgentDefinition } from '../src/agents/registry.js';
import { getAgentSchema } from '../src/core/validation/agentSchemaRegistry.js';
import {
  DAILY_REPORT_BATCH_CONTRACT,
  DailyReportBatchAdmission,
  DailyReportBatchStore,
  ReportAdmissionService,
  ReportLibraryBackfill,
  ReportLibraryStore,
  ReportOverviewService,
  dailyReportBatchId,
} from '../src/domains/reports/index.js';

const PRODUCTION_DATE = '2026-08-16';
const NOW = '2026-08-16T23:00:00.000Z';

function batchPlan(overrides = {}) {
  return {
    contract: DAILY_REPORT_BATCH_CONTRACT,
    productionDate: PRODUCTION_DATE,
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-report-run-20260816',
    items: [
      { itemId: 'item-alpha', projectId: 'project-alpha', sourceIdeaId: 'idea-alpha' },
      { itemId: 'item-beta', projectId: 'project-beta', sourceIdeaId: 'idea-beta' },
    ],
    ...overrides,
  };
}

test('Daily Report Batch has one stable producer-owned identity per production day', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-batch-'));
  const store = new DailyReportBatchStore({ rootDir, now: () => NOW });
  const first = store.create(batchPlan());
  const replay = store.create(batchPlan({ productionRunId: 'daily-report-restart-20260816' }));

  assert.equal(first.batchId, dailyReportBatchId({
    productionDate: PRODUCTION_DATE,
    producerId: 'scheduled-daily-report',
  }));
  assert.equal(replay.batchId, first.batchId);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.batch.productionRunId, 'daily-report-run-20260816');
  assert.throws(
    () => store.create(batchPlan({ producer: { id: 'other-producer' } })),
    /identity conflict|producer/i,
  );
});


test('Daily Report Batch records terminal outcomes and closes explicitly with an idempotent processing trigger', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-batch-close-'));
  const store = new DailyReportBatchStore({ rootDir, now: () => NOW });
  const created = store.create(batchPlan());
  const success = store.recordOutcome(created.batchId, 'item-alpha', {
    status: 'succeeded',
    stage: 'admission',
    analysisRunId: 'analysis-alpha',
    reportVersionId: 'report-alpha',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    fingerprint: `sha256:${'b'.repeat(64)}`,
  });
  const failure = store.recordOutcome(created.batchId, 'item-beta', {
    status: 'failed',
    stage: 'production',
    analysisRunId: 'analysis-beta',
    error: { code: 'REPORT_PRODUCTION_FAILED', message: '/private/provider/path was unavailable' },
  });

  assert.equal(success.item.status, 'succeeded');
  assert.equal(failure.item.status, 'failed');
  assert.doesNotMatch(failure.item.outcome.error.message, /\/private\/provider\/path/u);
  const closed = store.close(created.batchId, { pendingReportVersionIds: ['report-alpha'] });
  const replay = store.close(created.batchId, { pendingReportVersionIds: ['report-alpha'] });

  assert.equal(closed.batch.status, 'closed');
  assert.deepEqual(closed.batch.completion.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(closed.processingTrigger.status, 'requested');
  assert.deepEqual(closed.processingTrigger.pendingReportVersionIds, ['report-alpha']);
  assert.deepEqual(replay, closed);
  assert.throws(
    () => store.recordOutcome(created.batchId, 'item-beta', {
      status: 'failed', stage: 'production', analysisRunId: 'analysis-beta', error: { code: 'OTHER', message: 'changed' },
    }),
    /closed|immutable/i,
  );
  const triggerEvents = store.eventStore.list().filter((event) => event.eventType === 'report-library.worldview-processing.triggered');
  assert.equal(triggerEvents.length, 1);
});

test('Daily Report Batch closure accepts zero successes but rejects unfinished items', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-batch-zero-'));
  const store = new DailyReportBatchStore({ rootDir, now: () => NOW });
  const unfinished = store.create(batchPlan({ productionDate: '2026-08-17' }));
  assert.throws(() => store.close(unfinished.batchId), /pending|terminal/i);

  const empty = store.create(batchPlan({ productionDate: '2026-08-18', items: [] }));
  const closed = store.close(empty.batchId);
  assert.deepEqual(closed.batch.completion.summary, { total: 0, succeeded: 0, failed: 0 });
  assert.equal(closed.processingTrigger.status, 'no-work');
  assert.deepEqual(closed.processingTrigger.pendingReportVersionIds, []);
});


function sha256(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function reportPackage({
  projectId = 'project-overview',
  analysisRunId = 'analysis-overview',
  dailyReportRunId = null,
  markdown = '# Overview source\n\nExact report evidence.\n',
} = {}) {
  return {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('workflow') },
      reportRef: {
        contract: 'artifact-ref.v1', artifactId: `report:${analysisRunId}`, version: 1,
        path: 'report/report.md', contentDigest: sha256(markdown), schemaVersion: 'run-analysis-report.v1',
        producer: 'run-analysis', contractVersion: '1.0.0', inputDigest: sha256(`input:${analysisRunId}`),
        createdAt: '2026-08-16T21:00:00.000Z', asOf: '2026-08-16T20:00:00.000Z',
      },
    },
    lineage: { projectId, analysisRunId },
    dailyReport: dailyReportRunId === null ? null : { runId: dailyReportRunId },
    report: { mediaType: 'text/markdown', charset: 'utf-8', markdown, contentDigest: sha256(markdown) },
    metadata: {
      tickers: ['AAPL'], theme: 'AI infrastructure', searchTags: ['AI'], title: 'Overview source report',
      asOf: '2026-08-16T20:00:00.000Z', generatedAt: '2026-08-16T21:00:00.000Z',
    },
  };
}

function successfulOverviewOutput(request) {
  return {
    status: 'succeeded', valid: true,
    output: {
      overview: {
        reportVersionId: request.input.reportVersionId,
        contentDigest: request.input.contentDigest,
        summary: 'Apple infrastructure demand remains the primary discovery theme.',
        keyThemes: ['AI infrastructure'],
        entities: [{ name: 'Apple', type: 'company', tickers: ['AAPL'] }],
        materialDevelopments: ['Infrastructure demand remains material.'],
        uncertainties: ['Demand durability requires exact-report review.'],
      },
    },
    artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
    metrics: { turns: 1, tokens: 321 }, stopReason: 'final', traceRef: request.runId,
    provider: 'scripted', model: 'scripted-small', live: false,
  };
}

test('Report Overview Agent is strict, tool-less, and governed by the lower-cost route', () => {
  const definition = getAgentDefinition('report-overview');
  assert.equal(definition.domain, 'report-library');
  assert.equal(definition.modelPolicy.tier, 'small');
  assert.deepEqual(definition.modelPolicy.preferredProviders, ['openai-compatible']);
  assert.deepEqual(definition.toolPolicy.allow, []);
  assert.deepEqual(definition.contextPolicy.mounts, []);
  assert.ok(getAgentSchema(definition.outputSchema));
});

test('standard admission creates one digest-bound immutable Overview and projects it as pending', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-admission-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const calls = [];
  const backend = {
    async run(request, runtime) {
      calls.push({ request, runtime });
      return successfulOverviewOutput(request);
    },
  };
  const overviewService = new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW });
  const admissionService = new ReportAdmissionService({ reportLibrary, overviewService });

  const first = await admissionService.admit(reportPackage(), { source: 'producer' });
  const replay = await admissionService.admit(reportPackage(), { source: 'producer' });
  const report = reportLibrary.get(first.reportVersionId);
  const overview = reportLibrary.getOverview(first.reportVersionId);
  const pending = reportLibrary.listPendingReports();

  assert.equal(first.overview.status, 'ready');
  assert.equal(replay.overview.overviewDigest, first.overview.overviewDigest);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.agentContractId, 'report-overview');
  assert.equal(calls[0].request.input.contentDigest, first.contentDigest);
  assert.equal(calls[0].request.workspaceSnapshotId.startsWith('none:'), true);
  assert.equal(report.processingStatus, 'Pending');
  assert.equal(Object.hasOwn(report, 'overview'), false);
  assert.equal(Object.hasOwn(report, 'worldview'), false);
  assert.equal(overview.reportVersion.contentDigest, first.contentDigest);
  assert.equal('authority' in overview, false);
  assert.equal(overview.provenance.provider, 'scripted');
  assert.equal(overview.provenance.model, 'scripted-small');
  assert.deepEqual(pending.reports.map((item) => item.reportVersionId), [first.reportVersionId]);
  assert.doesNotMatch(JSON.stringify(report), /report\/report\.md|Exact report evidence|api[_-]?key/iu);
});


test('a transient Overview failure is repaired inside admission before one Pending report becomes visible', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-retry-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let calls = 0;
  const backend = {
    async run(request) {
      calls += 1;
      if (calls === 1) {
        return {
          status: 'failed', valid: false, output: null, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
          metrics: {}, stopReason: 'provider-unavailable', traceRef: request.runId,
          provider: 'scripted', model: 'scripted-small', live: false,
          error: { code: 'TEMPORARY_PROVIDER_FAILURE', message: 'temporary failure' },
        };
      }
      return successfulOverviewOutput(request);
    },
  };
  const overviewService = new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW });
  const admissionService = new ReportAdmissionService({ reportLibrary, overviewService });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-retry' }));

  assert.equal(admitted.status, 'admitted');
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
  assert.equal(reportLibrary.listPendingReports().reports.length, 1);
  assert.equal(calls, 2);
});

test('admitted Overview mutation is unavailable and tampered ReportVersion content fails closed', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-conflict-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const backend = { async run(request) { return successfulOverviewOutput(request); } };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-conflict' }));
  assert.equal(reportLibrary.commitOverview, undefined);

  const contentObject = path.join(rootDir, 'objects', 'sha256', admitted.contentDigest.slice('sha256:'.length));
  fs.writeFileSync(contentObject, '# tampered\n');
  assert.throws(
    () => reportLibrary.getOverview(admitted.reportVersionId),
    /digest mismatch|content digest/i,
  );
  assert.throws(() => reportLibrary.getOverview('../unsafe'), /unsafe/i);
});


test('highest Daily Report Batch admission seam preserves partial outcomes and publishes one trigger', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-admission-seam-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const agentCalls = [];
  const backend = {
    async run(request) {
      agentCalls.push(request.agentContractId);
      return successfulOverviewOutput(request);
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
  });
  const coordinator = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = coordinator.createBatch(batchPlan());

  const success = await coordinator.completeItem({
    batchId: created.batchId,
    itemId: 'item-alpha',
    packageInput: reportPackage({
      projectId: 'project-alpha', analysisRunId: 'analysis-alpha', dailyReportRunId: created.batchId,
    }),
  });
  const failure = coordinator.failItem({
    batchId: created.batchId,
    itemId: 'item-beta',
    analysisRunId: 'analysis-beta',
    stage: 'production',
    error: { code: 'RUN_ANALYSIS_FAILED', message: 'analysis did not publish a verified report' },
  });
  const closed = coordinator.close(created.batchId);
  await admissionService.admit(reportPackage({ projectId: 'late-project', analysisRunId: 'late-analysis' }), {
    source: 'producer',
  });
  const replay = coordinator.close(created.batchId);

  assert.equal(success.item.status, 'succeeded');
  assert.deepEqual(success.item.outcome.admissionAttempts.map(({ attemptId, status, reportVersionId }) => ({ attemptId, status, reportVersionId })), [{
    attemptId: 'admission-initial',
    status: 'succeeded',
    reportVersionId: success.item.outcome.reportVersionId,
  }]);
  assert.equal(failure.item.status, 'failed');
  assert.deepEqual(closed.batch.completion.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(closed.processingTrigger.status, 'requested');
  assert.deepEqual(closed.processingTrigger.pendingReportVersionIds, [success.item.outcome.reportVersionId]);
  assert.deepEqual(replay, closed);
  assert.deepEqual(agentCalls, ['report-overview', 'report-overview']);
  assert.equal(closed.processingTrigger.coreWorldviewAgentCalls, 0);
});

test('closed batch with only retryable admission failures records no-work and makes no Core Worldview call', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-no-work-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const agentCalls = [];
  const backend = {
    async run(request) {
      agentCalls.push(request.agentContractId);
      return {
        status: 'failed', valid: false, output: null, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
        metrics: {}, stopReason: 'provider-unavailable', traceRef: request.runId,
      };
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
  });
  const coordinator = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const plan = batchPlan({ productionDate: '2026-08-19', items: [{ itemId: 'item-only', projectId: 'project-only', sourceIdeaId: 'idea-only' }] });
  const created = coordinator.createBatch(plan);
  const completed = await coordinator.completeItem({
    batchId: created.batchId,
    itemId: 'item-only',
    packageInput: reportPackage({
      projectId: 'project-only', analysisRunId: 'analysis-only', dailyReportRunId: created.batchId,
    }),
  });
  const closed = coordinator.close(created.batchId);

  assert.equal(completed.item.status, 'failed');
  assert.match(completed.item.outcome.candidateId, /^candidate_/u);
  assert.equal(coordinator.get(created.batchId).items[0].outcome.candidateAdmission.status, 'retryable');
  assert.equal(closed.processingTrigger.status, 'no-work');
  assert.equal(closed.processingTrigger.pendingReportCount, 0);
  assert.deepEqual(agentCalls, ['report-overview', 'report-overview']);
  assert.equal(agentCalls.includes('core-worldview'), false);
});


test('scheduled daily producer keeps work isolated while sharing the product Report Library authority', () => {
  const source = fs.readFileSync(new URL('../scripts/runScheduledDailyReportGate.mjs', import.meta.url), 'utf8');
  assert.match(source, /dataDir:\s*envText\(['"]DAILY_REPORT_DATA_DIR['"],\s*['"]['"]\)/u);
  assert.match(source, /DAILY_REPORT_LIBRARY_DIR[\s\S]*REPORT_LIBRARY_DIR[\s\S]*BACKEND_ROOT[\s\S]*['"]data['"][\s\S]*['"]report-library['"]/u);
});


test('Daily Report Batch closes independently of a 100-report success count', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-batch-100-'));
  const store = new DailyReportBatchStore({ rootDir, now: () => NOW });
  const items = Array.from({ length: 100 }, (_, index) => ({
    itemId: `item-${String(index + 1).padStart(3, '0')}`,
    projectId: `project-${String(index + 1).padStart(3, '0')}`,
    sourceIdeaId: `idea-${String(index + 1).padStart(3, '0')}`,
  }));
  const created = store.create(batchPlan({ productionDate: '2026-08-20', items }));
  items.forEach((item, index) => store.recordOutcome(created.batchId, item.itemId, {
    status: 'succeeded', stage: 'admission', analysisRunId: `analysis-${index + 1}`,
    reportVersionId: `report-${index + 1}`, contentDigest: `sha256:${'a'.repeat(64)}`,
    fingerprint: `sha256:${'b'.repeat(64)}`,
  }));
  const closed = store.close(created.batchId);
  assert.deepEqual(closed.batch.completion.summary, { total: 100, succeeded: 100, failed: 0 });
  assert.equal(closed.processingTrigger.status, 'no-work');
});


test('oversized ReportVersion remains a blocked private candidate without an Agent call', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-large-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let calls = 0;
  const backend = { async run(request) { calls += 1; return successfulOverviewOutput(request); } };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
  });
  const hugeMarkdown = `# Large report\n\n${'material evidence '.repeat(30000)}`;
  await assert.rejects(
    admissionService.admit(reportPackage({ analysisRunId: 'analysis-large', markdown: hugeMarkdown })),
    (error) => error?.code === 'REPORT_OVERVIEW_CONTEXT_TOO_LARGE',
  );
  const candidate = admissionService.candidateStore.list()[0];
  assert.equal(candidate.state, 'blocked');
  assert.equal(candidate.package.report.markdown, hugeMarkdown);
  assert.equal(reportLibrary.get(candidate.reportVersionId), null);
  assert.equal(calls, 0);
});


test('normal Run Analysis publication is wired to the standard Overview-producing admission seam', () => {
  const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const serviceSource = fs.readFileSync(new URL('../src/workflows/run-analysis/RunAnalysisService.js', import.meta.url), 'utf8');
  assert.match(serverSource, /createReportAdmissionService\s*\(\s*\{\s*reportLibrary\s*\}\s*\)/u);
  assert.match(serverSource, /reportLibraryIngest:\s*reportAdmissionService\.admit\.bind/u);
  assert.match(serviceSource, /await\s+this\.reportLibraryIngest\s*\(/u);
  assert.match(serviceSource, /Analysis queue ownership ends before the lower-cost Report Overview call/u);
});


test('Agent-authored Report Overview digest mismatch blocks admission instead of being repaired', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-mismatch-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const backend = {
    async run(request) {
      const result = successfulOverviewOutput(request);
      result.output.overview.contentDigest = `sha256:${'f'.repeat(64)}`;
      return result;
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
  });
  await assert.rejects(
    admissionService.admit(reportPackage({ analysisRunId: 'analysis-mismatch' })),
    (error) => error?.code === 'REPORT_OVERVIEW_BINDING_MISMATCH',
  );
  const candidate = admissionService.candidateStore.list()[0];
  assert.equal(candidate.state, 'blocked');
  assert.equal(reportLibrary.getOverview(candidate.reportVersionId), null);
  assert.equal(reportLibrary.get(candidate.reportVersionId), null);
});


test('historical backfill uses the same Overview-producing admission seam', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-overview-backfill-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let calls = 0;
  const overviewService = new ReportOverviewService({
    reportLibrary,
    agentBackend: { async run(request) { calls += 1; return successfulOverviewOutput(request); } },
    now: () => NOW,
  });
  const pkg = reportPackage({ projectId: 'backfill-project', analysisRunId: 'backfill-analysis' });
  const backfill = new ReportLibraryBackfill({
    store: reportLibrary,
    overviewService,
    rootDir,
    now: () => NOW,
  });
  const result = await backfill.start({
    contract: 'report-library-backfill-manifest.v1',
    manifestId: 'overview-backfill',
    asOf: NOW,
    items: [{ itemId: 'backfill-item', package: pkg, source: null }],
  });
  const reportVersionId = result.items[0].reportVersionId;
  assert.equal(result.status, 'succeeded');
  assert.equal(reportLibrary.get(reportVersionId).processingStatus, 'Pending');
  assert.equal(calls, 1);
});


test('Daily Report Batch records a terminal failed admission attempt safely', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-admission-failure-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const coordinator = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: {
      async admit() {
        throw Object.assign(new Error('token=secret /private/provider/payload.json'), { code: 'ADMISSION_REJECTED' });
      },
    },
    now: () => NOW,
  });
  const created = coordinator.createBatch(batchPlan({
    productionDate: '2026-08-24',
    items: [{ itemId: 'item-failed-admission', projectId: 'project-failed-admission', sourceIdeaId: 'idea-failed-admission' }],
  }));
  const completed = await coordinator.completeItem({
    batchId: created.batchId,
    itemId: 'item-failed-admission',
    packageInput: reportPackage({
      projectId: 'project-failed-admission',
      analysisRunId: 'analysis-failed-admission',
      dailyReportRunId: created.batchId,
    }),
    admissionAttemptId: 'attempt-1',
  });
  assert.equal(completed.item.status, 'failed');
  assert.equal(completed.item.outcome.stage, 'admission');
  assert.equal(completed.item.outcome.admissionAttempts.length, 1);
  assert.equal(completed.item.outcome.admissionAttempts[0].attemptId, 'admission-attempt-1');
  assert.equal(completed.item.outcome.admissionAttempts[0].status, 'failed');
  assert.equal(completed.item.outcome.admissionAttempts[0].error.code, 'REPORT_ADMISSION_FAILED');
  assert.doesNotMatch(JSON.stringify(completed.item.outcome), /secret|\/private\/provider/u);
});


test('ReportVersion replay fails closed on fingerprint, producer, or metadata drift', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-version-fingerprint-conflict-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverviewOutput(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const original = reportPackage({ projectId: 'fingerprint-project', analysisRunId: 'fingerprint-analysis' });
  await admissionService.admit(original);

  const changedMetadata = reportPackage({ projectId: 'fingerprint-project', analysisRunId: 'fingerprint-analysis' });
  changedMetadata.metadata.title = 'Conflicting producer title';
  await assert.rejects(
    async () => admissionService.admit(changedMetadata),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  const changedProducer = reportPackage({ projectId: 'fingerprint-project', analysisRunId: 'fingerprint-analysis' });
  changedProducer.producer.reportRef.artifactId = 'report:conflicting-artifact';
  await assert.rejects(
    async () => admissionService.admit(changedProducer),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );
  assert.equal(providerCalls, 1);
});
