import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.FIN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'report-library-issue31-api-'));
process.env.AUTO_RESUME = 'false';
process.env.DEMO_MODE = 'true';

const {
  DailyReportBatchAdmission,
  ReportAdmissionService,
  ReportLibraryStore,
  ReportOverviewService,
} = await import('../src/domains/reports/index.js');
const { canonicalSha256 } = await import('../src/core/contracts/ArtifactRef.js');
const { startServer } = await import('../src/server.js');

const NOW = '2026-08-16T23:00:00.000Z';
const sha256 = (value) => `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
const markdown = '# API report\n\nExact report bytes.\n';
const packageInput = ({ projectId, analysisRunId, dailyReportRunId }) => ({
  contract: 'internal-run-analysis-report-package.v1',
  origin: 'internal',
  producer: {
    type: 'run-analysis',
    workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('workflow') },
    reportRef: {
      contract: 'artifact-ref.v1', artifactId: `api-report-${analysisRunId}`, version: 1, path: 'report/report.md',
      contentDigest: sha256(markdown), schemaVersion: 'run-analysis-report.v1', producer: 'run-analysis',
      contractVersion: '1.0.0', inputDigest: sha256(`input-${analysisRunId}`), createdAt: NOW, asOf: '2026-08-16T20:00:00.000Z',
    },
  },
  lineage: { projectId, analysisRunId },
  dailyReport: { runId: dailyReportRunId },
  report: { mediaType: 'text/markdown', charset: 'utf-8', markdown, contentDigest: sha256(markdown) },
  metadata: { tickers: ['AAPL'], theme: 'API theme', searchTags: ['api'], title: 'API report', asOf: '2026-08-16T20:00:00.000Z', generatedAt: NOW },
});

const reportLibrary = new ReportLibraryStore({ now: () => NOW });
const admissionService = new ReportAdmissionService({
  reportLibrary,
  overviewService: new ReportOverviewService({
    reportLibrary,
    now: () => NOW,
    agentBackend: {
      async run(request) {
        if (request.input.metadata.lineage.analysisRunId.startsWith('api-failed-analysis')) {
          return {
            status: 'failed', valid: false, output: null, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [], metrics: {},
            stopReason: 'provider-unavailable at https://private.example/v1', traceRef: request.runId,
            provider: 'scripted', model: 'scripted-small', live: false,
            error: { code: 'PROVIDER_UNAVAILABLE', message: 'https://user:secret@private.example/v1 failed; token=secret-value', transient: true },
          };
        }
        return {
          status: 'succeeded', valid: true,
          output: { overview: {
            reportVersionId: request.input.reportVersionId,
            contentDigest: request.input.contentDigest,
            summary: 'API discovery summary.',
            keyThemes: ['API theme'], entities: [{ name: 'Apple', type: 'company', tickers: ['AAPL'] }],
            materialDevelopments: ['API development'], uncertainties: ['API uncertainty'],
          } },
          artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [], metrics: { tokens: 10 },
          stopReason: 'final', traceRef: request.runId, provider: 'scripted', model: 'scripted-small', live: false,
        };
      },
    },
  }),
  maxImmediateAttempts: 1,
  sleep: async () => {},
});
const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
const batch = batchAdmission.createBatch({
  contract: 'daily-report-batch.v1', productionDate: '2026-08-16', producer: { id: 'scheduled-daily-report' }, productionRunId: 'api-daily-run',
  items: [
    { itemId: 'api-success', projectId: 'api-project', sourceIdeaId: 'api-idea' },
    { itemId: 'api-failure', projectId: 'api-failed-project', sourceIdeaId: 'api-failed-idea' },
  ],
});
const admitted = await batchAdmission.completeItem({
  batchId: batch.batchId,
  itemId: 'api-success',
  packageInput: packageInput({
    projectId: 'api-project', analysisRunId: 'api-analysis', dailyReportRunId: batch.batchId,
  }),
});
await batchAdmission.completeItem({
  batchId: batch.batchId,
  itemId: 'api-failure',
  packageInput: packageInput({
    projectId: 'api-failed-project', analysisRunId: 'api-failed-analysis', dailyReportRunId: batch.batchId,
  }),
});
batchAdmission.close(batch.batchId);
const admittedReportVersionId = admitted.item.outcome.reportVersionId;
const batchFile = path.join(reportLibrary.rootDir, 'batches', '2026-08-16.json');
const historicalBatch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
historicalBatch.providerPayload = { secret: 'top-level-secret' };
historicalBatch.producer.endpoint = 'https://private.example/producer';
historicalBatch.completion.providerPayload = { secret: 'completion-secret' };
historicalBatch.completion.summary.rawProviderSummary = 'RAW_PRIVATE_SUMMARY';
historicalBatch.completion.processingTrigger.apiKey = 'secret-trigger-key';
historicalBatch.items[0].endpoint = 'https://private.example/item';
historicalBatch.items[0].outcome.ownerToken = 'private-owner-token';
historicalBatch.items[0].outcome.admissionAttempts[0].providerPayload = { secret: 'attempt-secret' };
delete historicalBatch.stateDigest;
historicalBatch.stateDigest = canonicalSha256(historicalBatch);
fs.writeFileSync(batchFile, JSON.stringify(historicalBatch));
const historicalBatchBytes = fs.readFileSync(batchFile, 'utf8');

test('Report Library APIs expose batch diagnostics, lineage, and only Pending or Processed report state', async () => {
  const server = startServer({ port: 0 });
  try {
    const port = server.address().port;
    const get = async (route) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, route);
      return response.json();
    };
    const status = await get('/api/report-library/status');
    assert.equal(status.status.batchCount, 1);
    assert.equal(status.status.pendingReportCount, 1);
    assert.equal(status.status.processedReportCount, 0);
    assert.equal(Object.keys(status.status).some((key) => /overview|notReady/iu.test(key)), false);

    const batches = await get('/api/report-library/batches');
    assert.equal(batches.batches.length, 1);
    assert.equal(batches.batches[0].status, 'closed');
    assert.equal(batches.batches[0].completion.processingTrigger.pendingReportCount, 1);
    assert.equal(
      Object.keys(batches.batches[0].completion.processingTrigger).some((key) => /overview|ready/iu.test(key)),
      false,
    );
    const detail = await get(`/api/report-library/batches/${batch.batchId}`);
    assert.equal(detail.batch.items.length, 2);
    assert.equal(detail.batch.items[1].status, 'failed');
    assert.equal(detail.batch.items[1].outcome.candidateAdmission.status, 'retryable');
    assert.equal(detail.batch.items[1].outcome.candidateAdmission.attemptCount, 1);
    assert.equal(Object.hasOwn(detail.batch.items[0].outcome, 'overview'), false);
    assert.deepEqual(Object.keys(batches.batches[0]).sort(), [
      'batchId', 'completion', 'contract', 'createdAt', 'producer', 'productionDate',
      'productionRunId', 'status', 'summary',
    ]);
    assert.deepEqual(Object.keys(detail.batch).sort(), [
      'batchId', 'completion', 'contract', 'createdAt', 'items', 'producer', 'productionDate',
      'productionRunId', 'status', 'summary',
    ]);
    assert.deepEqual(Object.keys(detail.batch.producer), ['id']);
    assert.deepEqual(Object.keys(detail.batch.completion).sort(), [
      'closedAt', 'completionDigest', 'processingTrigger', 'summary',
    ]);
    assert.deepEqual(Object.keys(detail.batch.items[0]).sort(), [
      'completedAt', 'itemId', 'outcome', 'projectId', 'sourceIdeaId', 'status',
    ]);
    assert.deepEqual(Object.keys(detail.batch.items[0].outcome.admissionAttempts[0]).sort(), [
      'attemptId', 'error', 'reportVersionId', 'status',
    ]);
    assert.equal(fs.readFileSync(batchFile, 'utf8'), historicalBatchBytes);

    const report = await get(`/api/report-library/reports/${admittedReportVersionId}`);
    assert.equal(report.report.processingStatus, 'Pending');
    assert.equal(Object.hasOwn(report.report, 'overview'), false);
    assert.equal(Object.hasOwn(report.report, 'worldview'), false);
    assert.equal(report.report.lineage.analysisRunId, 'api-analysis');
    const content = await get(`/api/report-library/reports/${admittedReportVersionId}/content`);
    assert.equal(content.content, markdown);
    const overview = await fetch(`http://127.0.0.1:${port}/api/report-library/reports/${admittedReportVersionId}/overview`);
    assert.equal(overview.status, 404);

    const serialized = JSON.stringify({ status, batches, detail, report, content });
    assert.doesNotMatch(serialized, /private\.example|\/private\/|secret-value|providerPayload|api[_-]?key|password|ownerToken|leaseExpiresAt|reclaimCount|reclaimedAt|scripted-small|RAW_PRIVATE_SUMMARY/iu);
    const durableCandidates = JSON.stringify(admissionService.candidateStore.list());
    assert.doesNotMatch(durableCandidates, /private\.example|secret-value|providerPayload|api[_-]?key|password|Bearer\s+\S+/iu);
    const mutation = await fetch(`http://127.0.0.1:${port}/api/report-library/batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(mutation.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('Report Library batch APIs stay readable after corrupt candidate recovery', async () => {
  const corruptBatch = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-08-17',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'api-corrupt-candidate-run',
    items: [{
      itemId: 'api-corrupt-candidate',
      projectId: 'api-corrupt-project',
      sourceIdeaId: 'api-corrupt-idea',
    }],
  });
  await assert.rejects(
    admissionService.admit(packageInput({
      projectId: 'api-corrupt-project',
      analysisRunId: 'api-failed-analysis-corrupt',
      dailyReportRunId: corruptBatch.batchId,
    }), {
      batchId: corruptBatch.batchId,
      itemId: 'api-corrupt-candidate',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE',
  );
  const candidateId = admissionService.batchStore.inspectItem(
    corruptBatch.batchId,
    'api-corrupt-candidate',
  ).item.admissionCandidate.candidateId;
  const candidatePath = path.join(reportLibrary.rootDir, 'admission-candidates', `${candidateId}.json`);
  const corruptCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  corruptCandidate.providerPayload = 'Authorization: Bearer api-secret https://private.example/raw';
  delete corruptCandidate.stateDigest;
  corruptCandidate.stateDigest = canonicalSha256(corruptCandidate);
  fs.writeFileSync(candidatePath, JSON.stringify(corruptCandidate));

  const recovery = await admissionService.recover();
  assert.equal(recovery.find((entry) => entry.candidateId === candidateId)?.error.code, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
  assert.equal(batchAdmission.close(corruptBatch.batchId).batch.status, 'closed');

  const server = startServer({ port: 0 });
  try {
    const port = server.address().port;
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/report-library/batches`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    const listedBatch = listed.batches.find((entry) => entry.batchId === corruptBatch.batchId);
    assert.equal(listedBatch.status, 'closed');

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/report-library/batches/${corruptBatch.batchId}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.batch.items[0].status, 'failed');
    assert.equal(detail.batch.items[0].outcome.error.code, 'REPORT_ADMISSION_CANDIDATE_CORRUPT');
    assert.equal(detail.batch.items[0].outcome.candidateAdmission, null);
    assert.doesNotMatch(JSON.stringify({ listedBatch, detail }), /Bearer|api-secret|private\.example|providerPayload|raw/iu);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
