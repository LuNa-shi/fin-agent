import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { getAgentDefinition } from '../src/agents/registry.js';

import {
  DailyReportBatchAdmission,
  DailyReportBatchStore,
  REPORT_ADMISSION_CANDIDATE_STATES,
  REPORT_LIBRARY_EVENT_TYPES,
  ReportAdmissionStore,
  ReportAdmissionService,
  ReportLibraryBackfill,
  ReportLibraryEventStore,
  ReportLibraryStore,
  ReportOverviewService,
  normalizeInternalReportPackage,
  projectDailyReportBatchCandidateAdmissions,
  projectDailyReportBatchPublicFailures,
  reportAdmissionCandidateId,
  reportIngestionId,
  reportLibraryEventId,
  reportVersionFingerprint,
  reportVersionId,
} from '../src/domains/reports/index.js';
import { safePublicFailure } from '../src/domains/reports/safeFailure.js';

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-report-admission-issue40-'));
process.env.FIN_DATA_DIR = TEST_DATA_DIR;
test.after(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

const NOW = '2026-09-03T00:00:00.000Z';
const PROCESS_WORKER = fileURLToPath(new URL('./support/report-admission-process-worker.mjs', import.meta.url));

function sha256(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function reportPackage({
  projectId = 'project-issue-40',
  analysisRunId = 'analysis-issue-40',
  dailyReportRunId = null,
} = {}) {
  const markdown = '# Durable admission\n\nExact report evidence.\n';
  return {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('workflow') },
      reportRef: {
        contract: 'artifact-ref.v1',
        artifactId: `report:${analysisRunId}`,
        version: 1,
        path: 'report/report.md',
        contentDigest: sha256(markdown),
        schemaVersion: 'run-analysis-report.v1',
        producer: 'run-analysis',
        contractVersion: '1.0.0',
        inputDigest: sha256(`input:${analysisRunId}`),
        createdAt: '2026-09-02T23:00:00.000Z',
        asOf: '2026-09-02T22:00:00.000Z',
      },
    },
    lineage: { projectId, analysisRunId },
    dailyReport: dailyReportRunId === null ? null : { runId: dailyReportRunId },
    report: {
      mediaType: 'text/markdown',
      charset: 'utf-8',
      markdown,
      contentDigest: sha256(markdown),
    },
    metadata: {
      tickers: ['AAPL'],
      theme: 'Durable admission',
      searchTags: ['admission'],
      title: 'Issue 40 report',
      asOf: '2026-09-02T22:00:00.000Z',
      generatedAt: '2026-09-02T23:00:00.000Z',
    },
  };
}

function successfulOverview(request) {
  return {
    status: 'succeeded',
    valid: true,
    output: {
      overview: {
        reportVersionId: request.input.reportVersionId,
        contentDigest: request.input.contentDigest,
        summary: 'The report describes a durable admission boundary.',
        keyThemes: ['Report Library'],
        entities: [{ name: 'Apple', type: 'company', tickers: ['AAPL'] }],
        materialDevelopments: ['The report was prepared for atomic admission.'],
        uncertainties: ['Downstream processing has not started.'],
      },
    },
    artifacts: [],
    evidenceRefs: [],
    openQuestions: [],
    dataRequests: [],
    metrics: { turns: 1 },
    stopReason: 'final',
    traceRef: request.runId,
    provider: 'scripted',
    model: 'scripted-small',
    live: false,
  };
}

function failedOverview(request, {
  stopReason = 'provider-unavailable',
  code = 'TEMPORARY_PROVIDER_FAILURE',
  message = 'temporary failure',
  transient = true,
} = {}) {
  return {
    status: 'failed', valid: false, output: null, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
    metrics: {}, stopReason, traceRef: request.runId, provider: 'scripted', model: 'scripted-small', live: false,
    error: { code, message, transient },
  };
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fileAppearsWithin(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fs.existsSync(file);
}

function startProcessWorker({ rootDir, packageFile, callsFile, resultFile, mode, releaseFile, batchId, itemId }) {
  return spawn(process.execPath, [
    PROCESS_WORKER,
    rootDir,
    packageFile,
    callsFile,
    resultFile,
    mode,
    releaseFile,
    batchId,
    itemId,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}
function readCallLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

class FaultingAdmissionEventStore {
  constructor(delegate, { fail = 'before' } = {}) {
    this.delegate = delegate;
    this.fail = fail;
    this.triggered = false;
  }

  list() { return this.delegate.list(); }

  get(eventId) { return this.delegate.get(eventId); }

  publish(input) {
    if (input.eventType !== REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED || this.triggered) {
      return this.delegate.publish(input);
    }
    this.triggered = true;
    const error = new Error(`injected ${this.fail}-visibility-marker failure`);
    error.code = this.fail === 'before' ? 'TEST_BEFORE_VISIBILITY_MARKER' : 'TEST_AFTER_VISIBILITY_MARKER';
    if (this.fail === 'before') throw error;
    this.delegate.publish(input);
    throw error;
  }
}

class ConflictingAdmissionEventStore {
  constructor(event) { this.event = event; }

  list() { return [structuredClone(this.event)]; }

  get(eventId) { return eventId === this.event.eventId ? structuredClone(this.event) : null; }

  publish(input) {
    if (input.eventId === this.event.eventId) {
      const error = new Error(`Report Library event idempotency conflict: ${input.eventId}`);
      error.code = 'REPORT_EVENT_IDEMPOTENCY_CONFLICT';
      error.statusCode = 409;
      throw error;
    }
    throw new Error(`unexpected event: ${input.eventType}`);
  }
}

test('a report candidate stays invisible until its Overview-backed admission commits', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-issue40-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let signalStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { signalStarted = resolve; });
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  const backend = {
    async run(request) {
      signalStarted();
      await providerReleased;
      return successfulOverview(request);
    },
  };
  const overviewService = new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW });
  const admissionService = new ReportAdmissionService({ reportLibrary, overviewService });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-paused-admission',
    items: [{ itemId: 'item-paused', projectId: 'project-issue-40', sourceIdeaId: 'idea-paused' }],
  });
  const packageInput = reportPackage({ dailyReportRunId: created.batchId });
  const expectedReportVersionId = reportVersionId(packageInput);

  const admission = batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-paused',
    packageInput,
  });
  await providerStarted;

  const staged = admissionService.candidateStore.list();
  assert.equal(staged.length, 1);
  assert.equal(staged[0].state, REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING);
  assert.deepEqual(staged[0].package, normalizeInternalReportPackage(packageInput));
  assert.match(staged[0].overviewConfigDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(staged[0].attempts.length, 1);
  assert.equal(staged[0].attempts[0].status, 'running');
  assert.deepEqual(staged[0].batch, { batchId: created.batchId, itemId: 'item-paused' });
  const checkpoint = batchAdmission.batchStore.inspectItem(created.batchId, 'item-paused').item;
  assert.equal(checkpoint.status, 'pending');
  assert.equal(checkpoint.admissionCandidate.candidateId, staged[0].candidateId);
  assert.equal(checkpoint.admissionCandidate.analysisRunId, packageInput.lineage.analysisRunId);
  assert.equal(checkpoint.admissionCandidate.overviewConfigDigest, staged[0].overviewConfigDigest);
  assert.equal(reportLibrary.get(expectedReportVersionId), null);
  assert.deepEqual(reportLibrary.list().reports, []);

  releaseProvider();
  const admitted = await admission;
  assert.equal(admitted.item.outcome.reportVersionId, expectedReportVersionId);
  assert.equal(reportLibrary.get(expectedReportVersionId).processingStatus, 'Pending');
  assert.equal(reportLibrary.getOverview(expectedReportVersionId).reportVersion.reportVersionId, expectedReportVersionId);
});

test('one daily batch item binds one candidate before provider work begins', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-item-cas-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  let signalStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { signalStarted = resolve; });
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          signalStarted();
          await providerReleased;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-04',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-item-cas',
    items: [{ itemId: 'item-cas', projectId: 'project-cas', sourceIdeaId: 'idea-cas' }],
  });
  const firstPackage = reportPackage({
    projectId: 'project-cas', analysisRunId: 'analysis-cas-first', dailyReportRunId: created.batchId,
  });
  const conflictingPackage = reportPackage({
    projectId: 'project-cas', analysisRunId: 'analysis-cas-second', dailyReportRunId: created.batchId,
  });

  const first = batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-cas',
    packageInput: firstPackage,
  });
  await providerStarted;
  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-cas',
      packageInput: conflictingPackage,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  releaseProvider();
  const completed = await first;
  assert.equal(completed.item.status, 'succeeded');
  assert.equal(completed.item.outcome.analysisRunId, 'analysis-cas-first');
  assert.equal(providerCalls, 1);
  assert.equal(admissionService.candidateStore.list().length, 1);
  assert.equal(reportLibrary.list().reports.length, 1);
});

test('same-candidate concurrency reuses the first durable batch attempt context', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-item-replay-context-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  let signalStarted;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { signalStarted = resolve; });
  const providerReleased = new Promise((resolve) => { releaseProvider = resolve; });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          signalStarted();
          await providerReleased;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-08',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-item-replay-context',
    items: [{ itemId: 'item-replay-context', projectId: 'project-replay-context', sourceIdeaId: 'idea-replay-context' }],
  });
  const packageInput = reportPackage({
    projectId: 'project-replay-context',
    analysisRunId: 'analysis-replay-context',
    dailyReportRunId: created.batchId,
  });
  const first = batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-replay-context',
    packageInput,
    admissionAttemptId: 'first',
    productionAttempts: [{
      attemptId: 'production-first', analysisRunId: 'analysis-replay-context', status: 'succeeded', error: null,
    }],
  });
  await providerStarted;
  const second = batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-replay-context',
    packageInput,
    admissionAttemptId: 'second',
    productionAttempts: [{
      attemptId: 'production-second', analysisRunId: 'analysis-replay-context', status: 'succeeded', error: null,
    }],
  });
  releaseProvider();

  const outcomes = await Promise.all([first, second]);
  assert.equal(providerCalls, 1);
  assert.equal(outcomes[0].item.outcome.admissionAttempts[0].attemptId, 'admission-first');
  assert.equal(outcomes[1].item.outcome.admissionAttempts[0].attemptId, 'admission-first');
  assert.equal(outcomes[0].item.outcome.productionAttempts[0].attemptId, 'production-first');
  assert.equal(outcomes[1].item.outcome.productionAttempts[0].attemptId, 'production-first');
  assert.equal(outcomes.filter((outcome) => outcome.replayed).length, 1);
});

test('an expired lease does not start a second Overview call while the original owner process is alive', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-live-owner-expired-lease-'));
  let currentTime = NOW;
  const now = () => currentTime;
  const firstLibrary = new ReportLibraryStore({ rootDir, now });
  let releaseFirst;
  let signalFirstStarted;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  let firstProviderCalls = 0;
  const firstService = new ReportAdmissionService({
    reportLibrary: firstLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: firstLibrary,
      agentBackend: {
        async run(request) {
          firstProviderCalls += 1;
          signalFirstStarted();
          await firstReleased;
          return successfulOverview(request);
        },
      },
      now,
    }),
    now,
    leaseMs: 600_000,
  });
  const firstAdmission = new DailyReportBatchAdmission({
    reportLibrary: firstLibrary,
    admissionService: firstService,
    now,
  });
  const created = firstAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-09',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-live-owner-expired-lease',
    items: [{
      itemId: 'item-live-owner-expired-lease',
      projectId: 'project-live-owner-expired-lease',
      sourceIdeaId: 'idea-live-owner-expired-lease',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-live-owner-expired-lease',
    analysisRunId: 'analysis-live-owner-expired-lease',
    dailyReportRunId: created.batchId,
  });
  const first = firstAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-live-owner-expired-lease',
    packageInput,
  });
  await firstStarted;

  currentTime = '2026-09-03T00:11:00.000Z';
  const secondLibrary = new ReportLibraryStore({ rootDir, now });
  let secondProviderCalls = 0;
  const secondService = new ReportAdmissionService({
    reportLibrary: secondLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: secondLibrary,
      agentBackend: {
        async run(request) {
          secondProviderCalls += 1;
          return successfulOverview(request);
        },
      },
      now,
    }),
    now,
    leaseMs: 600_000,
  });
  const secondAdmission = new DailyReportBatchAdmission({
    reportLibrary: secondLibrary,
    admissionService: secondService,
    now,
  });

  await assert.rejects(
    secondAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-live-owner-expired-lease',
      packageInput,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_IN_FLIGHT',
  );
  assert.equal(secondProviderCalls, 0);

  releaseFirst();
  const completed = await first;
  const replay = await secondAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-live-owner-expired-lease',
    packageInput,
  });
  const candidate = secondService.candidateStore.list()[0];
  assert.equal(completed.item.status, 'succeeded');
  assert.equal(replay.replayed, true);
  assert.equal(firstProviderCalls, 1);
  assert.equal(secondProviderCalls, 0);
  assert.equal(candidate.state, REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED);
  assert.equal(candidate.attempts.length, 1);
  assert.equal(candidate.attempts[0].reclaimCount, 0);
  assert.equal(secondAdmission.close(created.batchId).batch.status, 'closed');
});


test('a live legacy owner without process-start identity is not reclaimed after lease expiry', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-legacy-live-owner-'));
  let currentTime = NOW;
  const store = new ReportAdmissionStore({ rootDir, now: () => currentTime });
  const packageInput = reportPackage({ analysisRunId: 'analysis-legacy-live-owner' });
  const candidate = store.stage(packageInput, {
    source: 'producer',
    overviewConfigDigest: sha256('legacy-live-owner-config'),
    immediateAttemptBudget: 1,
    stagedAt: currentTime,
  }).candidate;
  store.claim(candidate.candidateId, {
    ownerToken: 'legacy-live-owner-one',
    pid: process.pid,
    claimedAt: currentTime,
    leaseMs: 1_000,
  });
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidate.candidateId}.json`);
  const legacy = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  delete legacy.ownership.processStartIdentity;
  delete legacy.stateDigest;
  legacy.stateDigest = canonicalSha256(legacy);
  fs.writeFileSync(candidatePath, `${JSON.stringify(legacy)}\n`);

  currentTime = '2026-09-03T00:00:02.000Z';
  const competing = store.claim(candidate.candidateId, {
    ownerToken: 'legacy-live-owner-two',
    pid: process.pid,
    claimedAt: currentTime,
    leaseMs: 1_000,
  });

  assert.equal(competing.claimed, false);
  assert.equal(competing.reason, 'owned');
  assert.equal(competing.candidate.attempts.length, 1);
  assert.equal(competing.candidate.attempts[0].reclaimCount, 0);
});

test('a crash between candidate staging and item checkpoint preserves the first candidate for recovery', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-pre-checkpoint-crash-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-06',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-pre-checkpoint-crash',
    items: [{
      itemId: 'item-pre-checkpoint',
      projectId: 'project-pre-checkpoint',
      sourceIdeaId: 'idea-pre-checkpoint',
    }],
  });
  const firstPackage = reportPackage({
    projectId: 'project-pre-checkpoint',
    analysisRunId: 'analysis-pre-checkpoint-first',
    dailyReportRunId: created.batchId,
  });
  const firstCandidate = admissionService.candidateStore.stage(firstPackage, {
    batchId: created.batchId,
    itemId: 'item-pre-checkpoint',
    overviewConfigDigest: admissionService.overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  const conflictingPackage = reportPackage({
    projectId: 'project-pre-checkpoint',
    analysisRunId: 'analysis-pre-checkpoint-second',
    dailyReportRunId: created.batchId,
  });

  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-pre-checkpoint',
      packageInput: conflictingPackage,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );
  assert.equal(batchAdmission.batchStore.inspectItem(created.batchId, 'item-pre-checkpoint').item.status, 'pending');
  assert.equal(providerCalls, 0);

  const recovery = await admissionService.recover();
  const recoveredItem = batchAdmission.batchStore.inspectItem(created.batchId, 'item-pre-checkpoint').item;
  assert.deepEqual(recovery.map((entry) => entry.candidateId), [firstCandidate.candidateId]);
  assert.equal(providerCalls, 1);
  assert.equal(recoveredItem.status, 'succeeded');
  assert.equal(recoveredItem.outcome.candidateId, firstCandidate.candidateId);
  assert.equal(batchAdmission.close(created.batchId).batch.status, 'closed');
});

test('recovery terminalizes an admitted candidate whose daily batch outcome was not recorded', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-checkpoint-recovery-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-05',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-checkpoint-recovery',
    items: [{ itemId: 'item-checkpoint', projectId: 'project-checkpoint', sourceIdeaId: 'idea-checkpoint' }],
  });
  let providerCalls = 0;
  const packageInput = reportPackage({
    projectId: 'project-checkpoint',
    analysisRunId: 'analysis-checkpoint',
    dailyReportRunId: created.batchId,
  });
  const firstWorker = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    now: () => NOW,
  });

  const admitted = await firstWorker.admit(packageInput, {
    batchId: created.batchId,
    itemId: 'item-checkpoint',
    admissionAttemptId: 'admission-before-crash',
    productionAttempts: [{
      attemptId: 'production-before-crash',
      analysisRunId: 'analysis-checkpoint',
      status: 'succeeded',
      error: null,
    }],
  });
  const interrupted = batchStore.inspectItem(created.batchId, 'item-checkpoint').item;
  assert.equal(interrupted.status, 'pending');
  assert.equal(interrupted.admissionCandidate.candidateId, admitted.candidateId);

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: { async run() { throw new Error('provider must not rerun an admitted candidate'); } },
      now: () => NOW,
    }),
    now: () => NOW,
  });
  const recovery = await recoveredWorker.recover();
  const recoveredItem = recoveredWorker.batchStore.inspectItem(created.batchId, 'item-checkpoint').item;

  assert.deepEqual(recovery.map((entry) => entry.reportVersionId), [admitted.reportVersionId]);
  assert.equal(providerCalls, 1);
  assert.equal(recoveredItem.status, 'succeeded');
  assert.equal(recoveredItem.outcome.candidateId, admitted.candidateId);
  assert.equal(recoveredItem.outcome.productionAttempts[0].attemptId, 'production-before-crash');
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary: recoveredLibrary,
    admissionService: recoveredWorker,
    now: () => NOW,
  });
  assert.equal(batchAdmission.close(created.batchId).batch.status, 'closed');
});

test('an exhausted staged candidate is recovered later without producer resubmission', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-recovery-'));
  let currentTime = NOW;
  const now = () => currentTime;
  const reportLibrary = new ReportLibraryStore({ rootDir, now });
  const delays = [];
  let failedCalls = 0;
  const failedBackend = {
    async run(request) {
      failedCalls += 1;
      return {
        status: 'failed',
        valid: false,
        output: null,
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: {},
        stopReason: 'provider-unavailable',
        traceRef: request.runId,
        provider: 'scripted',
        model: 'scripted-small',
        live: false,
        error: { code: 'TEMPORARY_PROVIDER_FAILURE', message: 'temporary failure' },
      };
    },
  };
  const firstWorker = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: failedBackend, now }),
    now,
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 25,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-recovery' });
  const expectedReportVersionId = reportVersionId(packageInput);

  await assert.rejects(
    firstWorker.admit(packageInput, { source: 'producer' }),
    (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE',
  );

  assert.equal(failedCalls, 2);
  assert.deepEqual(delays, [25]);
  assert.equal(reportLibrary.get(expectedReportVersionId), null);
  currentTime = '2026-09-03T00:00:00.100Z';

  await assert.rejects(
    firstWorker.admit(packageInput, { source: 'producer' }),
    (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE',
  );
  assert.equal(failedCalls, 2, 'producer replay must not spend a new exhausted-candidate budget');

  let recoveryCalls = 0;
  const recoveryBackend = {
    async run(request) {
      recoveryCalls += 1;
      return successfulOverview(request);
    },
  };
  const restartedWorker = new ReportAdmissionService({
    reportLibrary: new ReportLibraryStore({ rootDir, now }),
    overviewService: new ReportOverviewService({
      reportLibrary: new ReportLibraryStore({ rootDir, now }),
      agentBackend: recoveryBackend,
      now,
    }),
    now,
    maxImmediateAttempts: 2,
    sleep: async () => {},
  });

  const recovered = await restartedWorker.recover();

  assert.equal(recoveryCalls, 1);
  assert.deepEqual(recovered.map((result) => result.reportVersionId), [expectedReportVersionId]);
  assert.equal(restartedWorker.reportLibrary.get(expectedReportVersionId).processingStatus, 'Pending');
});

test('restart resumes only the persisted remainder of an immediate retry budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-retry-remainder-'));
  let currentTime = NOW;
  const now = () => currentTime;
  const reportLibrary = new ReportLibraryStore({ rootDir, now });
  let initialCalls = 0;
  const interruptedWorker = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          initialCalls += 1;
          return failedOverview(request);
        },
      },
      now,
    }),
    now,
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 4,
    sleep: async () => { throw Object.assign(new Error('simulated process interruption'), { code: 'TEST_INTERRUPTED' }); },
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-retry-remainder' });

  await assert.rejects(
    interruptedWorker.admit(packageInput),
    (error) => error?.code === 'TEST_INTERRUPTED',
  );
  const interrupted = interruptedWorker.candidateStore.list()[0];
  assert.equal(initialCalls, 1);
  assert.equal(interrupted.immediateAttemptBudget, 2);
  assert.equal(interrupted.attempts.length, 1);

  currentTime = '2026-09-03T00:00:00.100Z';
  let recoveryCalls = 0;
  const restartedWorker = new ReportAdmissionService({
    reportLibrary: new ReportLibraryStore({ rootDir, now }),
    overviewService: new ReportOverviewService({
      reportLibrary: new ReportLibraryStore({ rootDir, now }),
      agentBackend: {
        async run(request) {
          recoveryCalls += 1;
          return failedOverview(request);
        },
      },
      now,
    }),
    now,
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 4,
    sleep: async () => {},
  });

  const resumedInitialWindow = await restartedWorker.recover();
  assert.equal(resumedInitialWindow[0].status, 'retryable');
  assert.equal(recoveryCalls, 1, 'restart must consume only the one persisted immediate attempt remaining');
  assert.equal(restartedWorker.candidateStore.list()[0].attempts.length, 2);

  currentTime = '2026-09-03T00:00:01.000Z';
  const laterExplicitWorker = await restartedWorker.recover();
  assert.equal(laterExplicitWorker[0].status, 'retryable');
  assert.equal(recoveryCalls, 2, 'an exhausted candidate receives one new governed attempt per later worker start');
  assert.equal(restartedWorker.candidateStore.list()[0].attempts.length, 3);
});

test('admission configuration cannot expand the Overview Agent governed attempt budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-governed-budget-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({ reportLibrary, maxImmediateAttempts: 3 });
  await assert.rejects(
    admissionService.admit(reportPackage({ analysisRunId: 'analysis-governed-budget' })),
    /cannot exceed the Report Overview Agent governed maximum of 2/u,
  );
  assert.deepEqual(admissionService.candidateStore.list(), []);
});

test('an invalid Overview binding cannot create a partially admitted ReportVersion', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-invalid-binding-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const backend = {
    async run(request) {
      providerCalls += 1;
      const result = successfulOverview(request);
      result.output.overview.contentDigest = sha256('different report bytes');
      return result;
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
    maxImmediateAttempts: 2,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-invalid-binding' });
  const expectedReportVersionId = reportVersionId(packageInput);

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'REPORT_OVERVIEW_BINDING_MISMATCH',
  );

  assert.equal(providerCalls, 1);
  assert.equal(admissionService.candidateStore.list()[0].state, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED);
  assert.equal(reportLibrary.get(expectedReportVersionId), null);
  assert.deepEqual(reportLibrary.list().reports, []);
});

test('invalid Overview output is repaired within one candidate-level physical-call budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-repair-budget-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const runtimes = [];
  const delays = [];
  let calls = 0;
  const agentRunner = async (_agentId, input, runtime) => {
    calls += 1;
    runtimes.push(runtime);
    if (calls === 1) {
      return failedOverview({ input, runId: runtime.scope.runId }, {
        stopReason: 'schema-invalid',
        code: 'OUTPUT_SCHEMA_INVALID',
        message: 'invalid structured output',
        transient: false,
      });
    }
    return successfulOverview({ input, runId: runtime.scope.runId });
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentRunner, now: () => NOW }),
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 30,
    maxRetryDelayMs: 30,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });

  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-output-repair' }));

  assert.equal(calls, 2);
  assert.deepEqual(delays, [30]);
  const attempts = admissionService.candidateStore.get(admitted.candidateId).attempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.stopReason), ['schema-invalid', 'final']);
  for (const runtime of runtimes) {
    assert.equal(runtime.modelApiRetry?.maxAttempts, 1);
    assert.equal(runtime.maxTurns, getAgentDefinition('report-overview').runPolicy.maxTurns);
  }
  assert.equal(reportLibrary.list().reports.length, 1);
});

test('common transport exceptions retry inside the same governed candidate budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-transport-retry-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let calls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' });
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });

  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-transport-retry' }));

  assert.equal(calls, 2);
  assert.equal(reportLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
  assert.equal(admissionService.candidateStore.get(admitted.candidateId).attempts.length, 2);
});

test('replaying an admitted candidate with a different batch association fails before provider work', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-conflict-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let calls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { calls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const originalBatch = admissionService.batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-batch-conflict',
    items: [{ itemId: 'item-original', projectId: 'project-issue-40', sourceIdeaId: 'idea-original' }],
  });
  const packageInput = reportPackage({
    analysisRunId: 'analysis-batch-conflict',
    dailyReportRunId: originalBatch.batchId,
  });
  const first = await admissionService.admit(packageInput, { batchId: originalBatch.batchId, itemId: 'item-original' });
  const replay = await admissionService.admit(packageInput, { batchId: originalBatch.batchId, itemId: 'item-original' });

  assert.equal(replay.candidateId, first.candidateId);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  const admissionEvents = reportLibrary.eventStore.list()
    .filter((event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED);
  assert.equal(admissionEvents.length, 1);
  assert.equal(admissionEvents[0].payload.admissionReceipt.candidateId, first.candidateId);
  assert.equal(admissionEvents[0].payload.admissionReceipt.fingerprint, first.reportVersion.fingerprint);
  assert.deepEqual(admissionEvents[0].payload.admissionReceipt.batch, {
    batchId: originalBatch.batchId, itemId: 'item-original',
  });
  assert.equal(admissionEvents[0].payload.admissionReceipt.admittedAt, first.reportVersion.ingestion.admittedAt);
  assert.equal(admissionEvents[0].payload.admissionReceipt.admissionSequence, admissionEvents[0].sequence);
  assert.equal(admissionEvents[0].payload.admissionReceipt.initialProcessingStatus, 'Pending');
  const receipt = admissionService.candidateStore.get(first.candidateId).admission;
  assert.equal(receipt.source, 'producer');
  assert.equal(receipt.initialProcessingStatus, 'Pending');
  assert.equal(receipt.admissionSequence, admissionEvents[0].sequence);

  await assert.rejects(
    async () => admissionService.admit(packageInput, { batchId: 'daily_batch_different', itemId: 'item-different' }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  await assert.rejects(
    async () => admissionService.admit({
      ...packageInput,
      metadata: { ...packageInput.metadata, title: 'Conflicting staged title' },
    }, { batchId: originalBatch.batchId, itemId: 'item-original' }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );
  const changedMarkdown = '# Changed report\n\nDifferent exact bytes.\n';
  await assert.rejects(
    async () => admissionService.admit({
      ...packageInput,
      producer: {
        ...packageInput.producer,
        reportRef: { ...packageInput.producer.reportRef, contentDigest: sha256(changedMarkdown) },
      },
      report: { ...packageInput.report, markdown: changedMarkdown, contentDigest: sha256(changedMarkdown) },
    }, { batchId: originalBatch.batchId, itemId: 'item-original' }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );
  await assert.rejects(
    async () => admissionService.admit(reportPackage({
      analysisRunId: 'analysis-fresh-batch-lineage-conflict',
      dailyReportRunId: 'daily_batch_other',
    }), { batchId: originalBatch.batchId, itemId: 'item-original' }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  assert.equal(calls, 1);
});

test('daily and non-daily lineage are bidirectionally bound before candidate staging', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-lineage-binding-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const existingBatch = admissionService.batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-lineage-binding',
    items: [
      { itemId: 'item-valid', projectId: 'project-issue-40', sourceIdeaId: 'idea-valid' },
      { itemId: 'item-wrong-project', projectId: 'project-other', sourceIdeaId: 'idea-other' },
    ],
  });
  const dailyPackage = reportPackage({
    analysisRunId: 'analysis-daily-without-batch',
    dailyReportRunId: existingBatch.batchId,
  });
  const nonDailyPackage = reportPackage({ analysisRunId: 'analysis-nondaily-with-batch' });

  await assert.rejects(
    async () => admissionService.admit(dailyPackage),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  await assert.rejects(
    async () => admissionService.admit(nonDailyPackage, { batchId: existingBatch.batchId, itemId: 'item-valid' }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  await assert.rejects(
    async () => admissionService.admit(nonDailyPackage, {
      source: 'backfill',
      batchId: existingBatch.batchId,
      itemId: 'item-valid',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  await assert.rejects(
    async () => admissionService.admit(reportPackage({
      analysisRunId: 'analysis-fabricated-batch',
      dailyReportRunId: 'daily_batch_does_not_exist',
    }), { batchId: 'daily_batch_does_not_exist', itemId: 'item-does-not-exist' }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  await assert.rejects(
    async () => admissionService.admit(reportPackage({
      analysisRunId: 'analysis-wrong-project-item',
      dailyReportRunId: existingBatch.batchId,
    }), { batchId: existingBatch.batchId, itemId: 'item-wrong-project' }),
    (error) => error?.code === 'REPORT_ADMISSION_INVALID_BATCH_REF',
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);

  const historical = await admissionService.admit(reportPackage({
    analysisRunId: 'analysis-historical-daily-backfill',
    dailyReportRunId: 'daily_batch_historical',
  }), { source: 'backfill' });
  assert.equal(historical.status, 'admitted');
  assert.equal(historical.reportVersion.dailyReport.runId, 'daily_batch_historical');
  assert.equal(providerCalls, 1);
});

test('the low-level store cannot commit a ReportVersion without a durable prepared candidate', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-no-candidate-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });

  assert.throws(
    () => reportLibrary.commitPreparedAdmission('candidate_missing'),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_NOT_FOUND',
  );
  assert.deepEqual(reportLibrary.list().reports, []);
  assert.deepEqual(reportLibrary.eventStore.list(), []);
});

test('a conflicting authoritative admission marker fails closed and never becomes public', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-marker-conflict-'));
  const packageInput = reportPackage({ analysisRunId: 'analysis-marker-conflict' });
  const id = reportVersionId(packageInput);
  const ingestionId = reportIngestionId(packageInput);
  const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED, {
    reportVersionId: id,
    contentDigest: packageInput.report.contentDigest,
    ingestionId,
  });
  const eventStore = new ConflictingAdmissionEventStore({
    eventId,
    eventType: REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED,
    schemaVersion: 'report-library-event.v1',
    scope: 'report-library',
    correlationId: ingestionId,
    causationId: null,
    runId: packageInput.lineage.analysisRunId,
    payload: {
      reportVersionId: id,
      contentDigest: packageInput.report.contentDigest,
      logicalIdentity: sha256('conflicting-logical-identity'),
      ingestionId,
      source: 'producer',
      tickers: ['MSFT'],
    },
    timestamp: NOW,
    sequence: 1,
  });

  const reportLibrary = new ReportLibraryStore({ rootDir, eventStore, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'REPORT_EVENT_IDEMPOTENCY_CONFLICT',
  );
  assert.equal(providerCalls, 1);
  const blocked = admissionService.candidateStore.list()[0];
  assert.equal(blocked.state, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED);
  assert.equal(blocked.lastError.code, 'REPORT_EVENT_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await admissionService.recover(), []);
  assert.equal(providerCalls, 1);
  assert.throws(
    () => reportLibrary.get(id),
    (error) => error?.code === 'REPORT_LIBRARY_ADMISSION_CONFLICT',
  );
  assert.deepEqual(reportLibrary.list().reports, []);
});

test('a conflicting ingestion record fails before the authoritative visibility marker', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-ingestion-conflict-'));
  const packageInput = reportPackage({ analysisRunId: 'analysis-ingestion-conflict' });
  const id = reportVersionId(packageInput);
  const ingestionId = reportIngestionId(packageInput);
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  fs.writeFileSync(path.join(rootDir, 'ingestions', `${ingestionId}.json`), JSON.stringify({
    schemaVersion: 'report-library-ingestion.v1',
    id: ingestionId,
    ingestionId,
    status: 'admitted',
    source: 'producer',
    reportVersionId: id,
    contentDigest: sha256('conflicting-content'),
    logicalIdentity: sha256('conflicting-logical-identity'),
    admittedAt: NOW,
  }));
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'REPORT_LIBRARY_IDEMPOTENCY_CONFLICT',
  );

  assert.equal(providerCalls, 1);
  const blocked = admissionService.candidateStore.list()[0];
  assert.equal(blocked.state, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED);
  assert.equal(blocked.lastError.code, 'REPORT_LIBRARY_IDEMPOTENCY_CONFLICT');
  assert.equal(reportLibrary.get(id), null);
  assert.equal(reportLibrary.readContent(id), null);
  assert.deepEqual(reportLibrary.list().reports, []);
  assert.equal(reportLibrary.eventStore.list().some(
    (event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED,
  ), false);
});

test('an admitted replay rejects a candidate receipt that no longer matches the immutable pair', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-receipt-tamper-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-receipt-tamper' });
  const admitted = await admissionService.admit(packageInput);
  const candidateFile = path.join(rootDir, 'admission-candidates', `${admitted.candidateId}.json`);
  const tampered = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  tampered.admission.overviewDigest = sha256('different-overview');
  const { stateDigest: _stateDigest, ...content } = tampered;
  tampered.stateDigest = canonicalSha256(content);
  fs.writeFileSync(candidateFile, JSON.stringify(tampered));

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'REPORT_ADMISSION_CORRUPT',
  );
  assert.equal(providerCalls, 1);
  assert.equal(reportLibrary.list().reports.length, 1);
});

test('staging tamper and effective-config drift fail closed before provider execution', async () => {
  const tamperRoot = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-tamper-'));
  const tamperLibrary = new ReportLibraryStore({ rootDir: tamperRoot, now: () => NOW });
  let providerCalls = 0;
  const tamperService = new ReportAdmissionService({
    reportLibrary: tamperLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: tamperLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-staging-tamper' });
  const staged = tamperService.candidateStore.stage(packageInput, {
    source: 'producer',
    overviewConfigDigest: tamperService.overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  const stagedFile = path.join(tamperRoot, 'admission-candidates', `${staged.candidateId}.json`);
  const tampered = JSON.parse(fs.readFileSync(stagedFile, 'utf8'));
  tampered.package.metadata.title = 'Tampered after staging';
  fs.writeFileSync(stagedFile, JSON.stringify(tampered));
  assert.throws(
    () => tamperService.candidateStore.get(staged.candidateId),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  );
  assert.equal(providerCalls, 0);

  const reboundDigest = structuredClone(staged);
  reboundDigest.contentDigest = sha256('top-level digest drift');
  const { stateDigest: _digestState, ...digestContent } = reboundDigest;
  reboundDigest.stateDigest = canonicalSha256(digestContent);
  fs.writeFileSync(stagedFile, JSON.stringify(reboundDigest));
  assert.throws(
    () => tamperService.candidateStore.get(staged.candidateId),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  );

  const reboundSource = structuredClone(staged);
  reboundSource.source = 'Producer';
  const { stateDigest: _sourceState, ...sourceContent } = reboundSource;
  reboundSource.stateDigest = canonicalSha256(sourceContent);
  fs.writeFileSync(stagedFile, JSON.stringify(reboundSource));
  assert.throws(
    () => tamperService.candidateStore.get(staged.candidateId),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  );

  const configRoot = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-config-drift-'));
  const configLibrary = new ReportLibraryStore({ rootDir: configRoot, now: () => NOW });
  const baselineOverview = new ReportOverviewService({ reportLibrary: configLibrary, now: () => NOW });
  const baselineDefinition = baselineOverview.effectiveDefinition();
  const candidateStore = new ReportAdmissionStore({ rootDir: configRoot, now: () => NOW });
  const configPackage = reportPackage({ analysisRunId: 'analysis-config-drift' });
  const configCandidate = candidateStore.stage(configPackage, {
    source: 'producer',
    overviewConfigDigest: baselineDefinition.effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  const changedDefinition = {
    ...baselineDefinition,
    effectiveConfig: { ...baselineDefinition.effectiveConfig, digest: sha256('changed-overview-config') },
  };
  const configWorker = new ReportAdmissionService({
    reportLibrary: configLibrary,
    candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary: configLibrary,
      definitionResolver: () => changedDefinition,
      agentBackend: { async run() { providerCalls += 1; throw new Error('provider must not execute'); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });

  const recovery = await configWorker.recover();
  assert.equal(recovery[0].status, 'failed');
  assert.equal(candidateStore.get(configCandidate.candidateId).state, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED);
  assert.equal(providerCalls, 0);
  assert.deepEqual(configLibrary.list().reports, []);
});

test('the closed candidate contract rejects injected provider payload even with a recomputed state digest', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-closed-candidate-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-closed-candidate' }));
  const stagedFile = path.join(rootDir, 'admission-candidates', `${admitted.candidateId}.json`);
  const tampered = JSON.parse(fs.readFileSync(stagedFile, 'utf8'));
  tampered.attempts[0].provenance.providerPayload = { raw: 'must never persist' };
  const { stateDigest: _stateDigest, ...content } = tampered;
  tampered.stateDigest = canonicalSha256(content);
  fs.writeFileSync(stagedFile, JSON.stringify(tampered));

  assert.throws(
    () => admissionService.candidateStore.get(admitted.candidateId),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  );
});

test('the private Overview record rejects fields outside its closed contract', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-closed-overview-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-closed-overview' }));
  const overviewFile = path.join(rootDir, 'reports', admitted.reportVersionId, 'overview', 'report-overview.json');
  const tampered = JSON.parse(fs.readFileSync(overviewFile, 'utf8'));
  tampered.providerPayload = { raw: 'must never persist' };
  fs.writeFileSync(overviewFile, JSON.stringify(tampered));

  assert.throws(
    () => reportLibrary.getOverview(admitted.reportVersionId),
    (error) => error?.code === 'REPORT_OVERVIEW_CORRUPT',
  );
});

test('the public ReportVersion anchor rejects injected private admission metadata', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-closed-anchor-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-closed-anchor' }));
  const anchorFile = path.join(rootDir, 'reports', admitted.reportVersionId, 'report-version.json');
  const tampered = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
  tampered.admission.providerPayload = { raw: 'must never become public' };
  fs.writeFileSync(anchorFile, JSON.stringify(tampered));

  assert.throws(
    () => reportLibrary.get(admitted.reportVersionId),
    (error) => error?.code === 'REPORT_LIBRARY_CORRUPT_ANCHOR',
  );
});

test('mixed batch candidates succeed, repair transient output, or remain independently exhausted', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-mixed-batch-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const calls = new Map();
  const backend = {
    async run(request) {
      const runId = request.input.metadata.lineage.analysisRunId;
      const count = (calls.get(runId) || 0) + 1;
      calls.set(runId, count);
      if (runId === 'analysis-mixed-success') return successfulOverview(request);
      if (runId === 'analysis-mixed-transient' && count === 1) return failedOverview(request);
      if (runId === 'analysis-mixed-transient') return successfulOverview(request);
      return failedOverview(request, {
        stopReason: 'schema-invalid',
        code: 'OUTPUT_SCHEMA_INVALID',
        message: 'invalid output',
        transient: false,
      });
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend, now: () => NOW }),
    maxImmediateAttempts: 2,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-04',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-mixed',
    items: [
      { itemId: 'item-success', projectId: 'project-success', sourceIdeaId: 'idea-success' },
      { itemId: 'item-transient', projectId: 'project-transient', sourceIdeaId: 'idea-transient' },
      { itemId: 'item-exhausted', projectId: 'project-exhausted', sourceIdeaId: 'idea-exhausted' },
    ],
  });
  const results = await Promise.all([
    batchAdmission.completeItem({ batchId: created.batchId, itemId: 'item-success', packageInput: reportPackage({ projectId: 'project-success', analysisRunId: 'analysis-mixed-success', dailyReportRunId: created.batchId }) }),
    batchAdmission.completeItem({ batchId: created.batchId, itemId: 'item-transient', packageInput: reportPackage({ projectId: 'project-transient', analysisRunId: 'analysis-mixed-transient', dailyReportRunId: created.batchId }) }),
    batchAdmission.completeItem({ batchId: created.batchId, itemId: 'item-exhausted', packageInput: reportPackage({ projectId: 'project-exhausted', analysisRunId: 'analysis-mixed-exhausted', dailyReportRunId: created.batchId }) }),
  ]);

  assert.deepEqual(results.map((result) => result.item.status), ['succeeded', 'succeeded', 'failed']);
  assert.deepEqual(Object.fromEntries(calls), {
    'analysis-mixed-success': 1,
    'analysis-mixed-transient': 2,
    'analysis-mixed-exhausted': 2,
  });
  assert.equal(reportLibrary.list().reports.length, 2);
  const candidates = admissionService.candidateStore.list();
  assert.deepEqual(
    candidates.map((candidate) => candidate.state).sort(),
    [REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED, REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED, REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE].sort(),
  );
  const exhausted = candidates.find((candidate) => candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE);
  assert.equal(exhausted.attempts.length, 2);
  assert.equal(exhausted.lastError.code, 'REPORT_OVERVIEW_OUTPUT_INVALID');
  assert.equal(exhausted.nextEligibleAt, NOW);
  assert.equal(reportLibrary.get(exhausted.reportVersionId), null);
});

test('batch item identity is checked before candidate staging or provider work', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-preflight-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-05',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-preflight',
    items: [{ itemId: 'item-expected', projectId: 'project-expected', sourceIdeaId: 'idea-expected' }],
  });

  const mismatch = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-expected',
    packageInput: reportPackage({ projectId: 'project-other', analysisRunId: 'analysis-other' }),
  });
  assert.equal(mismatch.item.status, 'failed');
  assert.equal(mismatch.item.outcome.error.code, 'DAILY_REPORT_BATCH_PACKAGE_MISMATCH');
  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);

  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-unknown',
      packageInput: reportPackage({ projectId: 'project-expected', analysisRunId: 'analysis-unknown' }),
    }),
    (error) => error?.code === 'DAILY_REPORT_BATCH_ITEM_NOT_FOUND',
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);
});

test('daily batch lineage is checked before candidate staging or provider work', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-lineage-preflight-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-09',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-lineage-preflight',
    items: [{ itemId: 'item-lineage', projectId: 'project-lineage', sourceIdeaId: 'idea-lineage' }],
  });

  const mismatch = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-lineage',
    packageInput: reportPackage({ projectId: 'project-lineage', analysisRunId: 'analysis-lineage' }),
  });

  assert.equal(mismatch.item.status, 'failed');
  assert.equal(mismatch.item.outcome.error.code, 'DAILY_REPORT_BATCH_PACKAGE_MISMATCH');
  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);
});

test('a terminal daily batch replay validates exact candidate bytes before returning its historical outcome', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-terminal-replay-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-06',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-terminal-replay',
    items: [{ itemId: 'item-exact', projectId: 'project-exact', sourceIdeaId: 'idea-exact' }],
  });
  const packageInput = reportPackage({
    projectId: 'project-exact',
    analysisRunId: 'analysis-exact',
    dailyReportRunId: created.batchId,
  });

  const first = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-exact',
    packageInput,
  });
  const replay = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-exact',
    packageInput,
  });

  assert.equal(first.item.status, 'succeeded');
  assert.equal(replay.replayed, true);
  assert.equal(providerCalls, 1);
  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-exact',
      packageInput: {
        ...packageInput,
        metadata: { ...packageInput.metadata, title: 'Conflicting terminal replay' },
      },
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );
  assert.equal(providerCalls, 1);
});

test('a terminal failed batch item replays its frozen candidate after Overview configuration changes', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-frozen-terminal-replay-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const firstService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return failedOverview(request);
        },
      },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  const firstAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: firstService,
    now: () => NOW,
  });
  const created = firstAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-10-01',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-frozen-terminal-replay',
    items: [{
      itemId: 'item-frozen-terminal-replay',
      projectId: 'project-frozen-terminal-replay',
      sourceIdeaId: 'idea-frozen-terminal-replay',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-frozen-terminal-replay',
    analysisRunId: 'analysis-frozen-terminal-replay',
    dailyReportRunId: created.batchId,
  });
  const first = await firstAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-frozen-terminal-replay',
    packageInput,
  });
  assert.equal(first.item.status, 'failed');
  assert.equal(providerCalls, 1);

  const baselineDefinition = firstService.overviewService.effectiveDefinition();
  const changedDefinition = {
    ...baselineDefinition,
    effectiveConfig: {
      ...baselineDefinition.effectiveConfig,
      digest: sha256('changed-terminal-replay-config'),
    },
  };
  const replayService = new ReportAdmissionService({
    reportLibrary,
    batchStore: firstService.batchStore,
    candidateStore: firstService.candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      definitionResolver: () => changedDefinition,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const replayAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService: replayService,
    now: () => NOW,
  });

  const replay = await replayAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-frozen-terminal-replay',
    packageInput,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.item.status, 'failed');
  assert.equal(providerCalls, 1);

  fs.rmSync(path.join(
    rootDir,
    'admission-candidates',
    `${first.item.outcome.candidateId}.json`,
  ));
  const checkpointReplay = await replayAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-frozen-terminal-replay',
    packageInput,
  });
  assert.equal(checkpointReplay.replayed, true);
  assert.equal(checkpointReplay.item.status, 'failed');
  assert.equal(providerCalls, 1);
});

test('a lease heartbeat keeps one live logical attempt owned without advancing its identity', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-heartbeat-'));
  let currentTime = NOW;
  const store = new ReportAdmissionStore({ rootDir, now: () => currentTime });
  const packageInput = reportPackage({ analysisRunId: 'analysis-heartbeat' });
  const candidate = store.stage(packageInput, {
    source: 'producer',
    overviewConfigDigest: sha256('heartbeat-config'),
    immediateAttemptBudget: 1,
    stagedAt: currentTime,
  }).candidate;
  const first = store.claim(candidate.candidateId, {
    ownerToken: 'heartbeat-owner-one',
    pid: process.pid,
    claimedAt: currentTime,
    leaseMs: 1_000,
  });
  currentTime = '2026-09-03T00:00:00.800Z';
  const renewed = store.renew(candidate.candidateId, {
    ownerToken: 'heartbeat-owner-one',
    attemptId: first.attemptId,
    renewedAt: currentTime,
    leaseMs: 1_000,
  });
  currentTime = '2026-09-03T00:00:01.500Z';
  const competing = store.claim(candidate.candidateId, {
    ownerToken: 'heartbeat-owner-two',
    pid: process.pid,
    claimedAt: currentTime,
    leaseMs: 1_000,
  });

  assert.equal(renewed.ownership.attemptId, first.attemptId);
  assert.equal(competing.claimed, false);
  assert.equal(competing.reason, 'owned');
  assert.equal(competing.candidate.attempts.length, 1);
  assert.equal(competing.candidate.attempts[0].reclaimCount, 0);
});

test('public failure diagnostics redact endpoints, credentials, and local paths', () => {
  const safe = safePublicFailure({
    code: 'PROVIDER/FAILED',
    message: 'POST https://user:secret@private.example/v1/models failed; api_key=sk-secret; Authorization: Basic dXNlcjpwYXNz; client_secret=hunter2; raw payload {"secret":"private-body"}; /tmp/private/provider.json',
  });
  assert.equal(safe.code, 'REPORT_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(safe), /private\.example|user|secret|\/tmp\/private|sk-secret|Basic|dXNl|hunter2|raw payload|private-body/iu);
  assert.equal(safe.message, 'Report operation failed');
});

test('historical batch and candidate errors are allow-listed again at the public projection boundary', () => {
  const unsafe = {
    code: 'OLD_PROVIDER_FAILURE',
    message: 'Authorization: Basic dXNlcjpwYXNz client_secret=hunter2 raw payload {"secret":"body"} https://private.example /tmp/private.json',
  };
  const batch = {
    contract: 'daily-report-batch.v1',
    batchId: 'daily_batch_historical_unsafe',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report', endpoint: 'https://private.example/producer' },
    productionRunId: 'daily-run-historical-unsafe',
    status: 'closed',
    createdAt: NOW,
    completion: {
      closedAt: NOW,
      summary: { total: 1, succeeded: 0, failed: 1, rawProviderSummary: 'RAW_PRIVATE_SUMMARY' },
      processingTrigger: {
        contract: 'worldview-processing-trigger.v1',
        triggerId: 'worldview_trigger_historical_unsafe',
        batchId: 'daily_batch_historical_unsafe',
        publishedAt: NOW,
        status: 'no-work',
        pendingReportVersionIds: [],
        pendingReportCount: 0,
        coreWorldviewAgentCalls: 0,
        processingTarget: 'canonical-worldview-processing.v1',
        apiKey: 'secret-trigger-key',
      },
      completionDigest: sha256('historical-completion'),
      providerPayload: { secret: 'completion-secret' },
    },
    providerPayload: { secret: 'batch-secret' },
    items: [{
      itemId: 'item-historical-unsafe',
      projectId: 'project-historical-unsafe',
      sourceIdeaId: null,
      status: 'failed',
      completedAt: NOW,
      endpoint: 'https://private.example/item',
      outcome: {
        status: 'failed',
        stage: 'admission',
        analysisRunId: 'analysis-historical-unsafe',
        candidateId: 'candidate_historical_unsafe',
        error: unsafe,
        productionAttempts: [{
          attemptId: 'production-1', analysisRunId: 'analysis-historical-unsafe', status: 'failed', error: unsafe,
          endpoint: 'https://private.example/attempt',
        }],
        admissionAttempts: [{
          attemptId: 'admission-1', reportVersionId: null, status: 'failed', error: unsafe,
          providerPayload: { secret: 'attempt-secret' },
        }],
        ownerToken: 'private-owner-token',
      },
    }],
  };
  const candidateStore = {
    get: () => ({
      candidateId: 'candidate_historical_unsafe',
      state: REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED,
      attempts: [{
        attemptId: 'attempt-000001', status: 'failed', stopReason: 'provider-unavailable',
        error: unsafe, startedAt: NOW, completedAt: NOW,
      }],
      lastError: unsafe,
      nextEligibleAt: null,
      admission: null,
      providerPayload: { secret: 'candidate-secret' },
    }),
  };

  const original = structuredClone(batch);
  const publicOnly = projectDailyReportBatchPublicFailures(batch);
  const projected = projectDailyReportBatchCandidateAdmissions(batch, candidateStore);
  const serialized = JSON.stringify(projected);
  assert.deepEqual(batch, original, 'projection must not rewrite historical durable bytes');
  assert.doesNotMatch(serialized, /Basic|dXNl|client_secret|hunter2|raw payload|private\.example|\/tmp\/private|"secret"|providerPayload|ownerToken|endpoint|apiKey|RAW_PRIVATE_SUMMARY/iu);
  assert.equal(projected.items[0].outcome.error.code, 'REPORT_ADMISSION_FAILED');
  assert.equal(projected.items[0].outcome.productionAttempts[0].error.code, 'REPORT_PRODUCTION_FAILED');
  assert.equal(projected.items[0].outcome.candidateAdmission.lastAttempt.stopReason, 'provider-unavailable');
  assert.deepEqual(Object.keys(publicOnly).sort(), [
    'batchId', 'completion', 'contract', 'createdAt', 'items', 'producer', 'productionDate',
    'productionRunId', 'status', 'summary',
  ]);
  assert.deepEqual(Object.keys(publicOnly.producer), ['id']);
  assert.deepEqual(Object.keys(publicOnly.completion).sort(), [
    'closedAt', 'completionDigest', 'processingTrigger', 'summary',
  ]);
  assert.deepEqual(Object.keys(publicOnly.completion.processingTrigger).sort(), [
    'batchId', 'contract', 'coreWorldviewAgentCalls', 'pendingReportCount', 'pendingReportVersionIds',
    'processingTarget', 'publishedAt', 'status', 'triggerId',
  ]);
  assert.deepEqual(Object.keys(publicOnly.items[0]).sort(), [
    'completedAt', 'itemId', 'outcome', 'projectId', 'sourceIdeaId', 'status',
  ]);
  assert.deepEqual(Object.keys(publicOnly.items[0].outcome).sort(), [
    'admissionAttempts', 'analysisRunId', 'candidateAdmission', 'candidateId', 'error',
    'productionAttempts', 'stage', 'status',
  ]);
  assert.deepEqual(Object.keys(publicOnly.items[0].outcome.productionAttempts[0]).sort(), [
    'analysisRunId', 'attemptId', 'error', 'status',
  ]);
  assert.deepEqual(Object.keys(publicOnly.items[0].outcome.admissionAttempts[0]).sort(), [
    'attemptId', 'error', 'reportVersionId', 'status',
  ]);
});

test('historical batch projections preserve pre-bound item and trigger cardinality without rewriting bytes', () => {
  const historicalItems = Array.from({ length: 101 }, (_, index) => ({
    itemId: `historical-item-${index}`,
    projectId: `historical-project-${index}`,
    sourceIdeaId: null,
    status: 'pending',
    outcome: null,
    completedAt: null,
  }));
  const historicalBatch = {
    contract: 'daily-report-batch.v1',
    batchId: 'daily_batch_historical_cardinality',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-historical-cardinality',
    status: 'open',
    createdAt: NOW,
    completion: null,
    items: historicalItems,
  };
  const originalBatchBytes = JSON.stringify(historicalBatch);
  const projectedBatch = projectDailyReportBatchPublicFailures(historicalBatch);
  assert.equal(projectedBatch.items.length, 101);
  assert.equal(JSON.stringify(historicalBatch), originalBatchBytes);

  const pendingReportVersionIds = Array.from({ length: 1001 }, (_, index) => `rv_historical_${index}`);
  const historicalTriggerBatch = {
    ...historicalBatch,
    batchId: 'daily_batch_historical_trigger_cardinality',
    productionRunId: 'daily-run-historical-trigger-cardinality',
    status: 'closed',
    items: [],
    completion: {
      closedAt: NOW,
      summary: { total: 0, succeeded: 0, failed: 0 },
      processingTrigger: {
        contract: 'worldview-processing-trigger.v1',
        triggerId: 'worldview_trigger_historical_cardinality',
        batchId: 'daily_batch_historical_trigger_cardinality',
        publishedAt: NOW,
        status: 'requested',
        pendingReportVersionIds,
        pendingReportCount: pendingReportVersionIds.length,
        coreWorldviewAgentCalls: 0,
        processingTarget: 'canonical-worldview-processing.v1',
      },
      completionDigest: sha256('historical-trigger-cardinality'),
    },
  };
  const originalTriggerBytes = JSON.stringify(historicalTriggerBatch);
  const projectedTriggerBatch = projectDailyReportBatchPublicFailures(historicalTriggerBatch);
  assert.equal(projectedTriggerBatch.completion.processingTrigger.pendingReportVersionIds.length, 1001);
  assert.equal(JSON.stringify(historicalTriggerBatch), originalTriggerBytes);
});

test('historical raw ingestion failure events replay safely without rewriting evidence', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-ingestion-historical-event-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const projectId = 'project-historical-event';
  const analysisRunId = 'analysis-historical-event';
  const ingestionId = `ingest_${canonicalSha256({
    origin: 'internal', producerType: 'run-analysis', projectId, analysisRunId,
  }).slice('sha256:'.length)}`;
  const unsafe = {
    code: 'OLD_PROVIDER_FAILURE',
    message: 'Authorization: Bearer secret-token https://private.example /tmp/provider.json',
    providerPayload: { token: 'secret-token' },
  };
  const eventId = reportLibraryEventId(REPORT_LIBRARY_EVENT_TYPES.INGESTION_FAILED, {
    ingestionId, projectId, analysisRunId,
  });
  reportLibrary.eventStore.publish({
    eventId,
    eventType: REPORT_LIBRARY_EVENT_TYPES.INGESTION_FAILED,
    correlationId: ingestionId,
    causationId: null,
    runId: analysisRunId,
    payload: {
      ingestionId,
      projectId,
      analysisRunId,
      source: 'producer',
      error: unsafe,
      rawProviderPayload: { secret: 'historical-event-secret' },
    },
  });
  const ingestionFile = path.join(rootDir, 'ingestions', `${ingestionId}.json`);
  fs.writeFileSync(ingestionFile, JSON.stringify({
    schemaVersion: 'report-library-ingestion.v1',
    id: ingestionId,
    ingestionId,
    status: 'failed',
    source: 'producer',
    projectId,
    analysisRunId,
    error: unsafe,
    failedAt: NOW,
    providerPayload: { secret: 'historical-ingestion-secret' },
  }));
  const eventFile = path.join(rootDir, 'events', 'outbox', '000000000001.json');
  const originalEventBytes = fs.readFileSync(eventFile, 'utf8');
  const originalIngestionBytes = fs.readFileSync(ingestionFile, 'utf8');

  const replay = reportLibrary.recordFailure({
    projectId,
    analysisRunId,
    source: 'producer',
    error: new Error('a new private provider message must not escape'),
  });

  assert.deepEqual(replay.error, {
    code: 'REPORT_LIBRARY_INGESTION_FAILED',
    message: 'Report Library ingestion failed',
  });
  assert.doesNotMatch(JSON.stringify(replay), /private\.example|secret-token|providerPayload|\/tmp\/provider/iu);
  assert.deepEqual(reportLibrary.getIngestion(ingestionId), replay);
  assert.equal(fs.readFileSync(eventFile, 'utf8'), originalEventBytes);
  assert.equal(fs.readFileSync(ingestionFile, 'utf8'), originalIngestionBytes);
});

test('historical backfill errors are allow-listed again at the public Report Library boundary', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-backfill-historical-error-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const backfillsDir = path.join(rootDir, 'backfills');
  fs.mkdirSync(backfillsDir, { recursive: true });
  const unsafe = {
    code: 'OLD_BACKFILL_PROVIDER_ERROR',
    message: 'Authorization: Bearer secret-token https://private.example /tmp/provider.json raw payload {"secret":"body"}',
  };
  fs.writeFileSync(path.join(backfillsDir, 'backfill_historical_unsafe.json'), JSON.stringify({
    contract: 'report-library-backfill-state.v1',
    runId: 'backfill_historical_unsafe',
    manifestId: 'historical_unsafe',
    manifestDigest: sha256('historical-backfill-manifest'),
    asOf: NOW,
    status: 'failed',
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    items: {
      'item-historical': {
        itemId: 'item-historical',
        status: 'failed',
        attempts: 1,
        reportVersionId: null,
        ingestionId: null,
        error: unsafe,
      },
    },
  }));

  const detail = reportLibrary.getBackfillStatus('backfill_historical_unsafe');
  const listed = reportLibrary.listBackfills().backfills[0];
  for (const projection of [detail, listed]) {
    assert.equal(projection.items[0].error.code, 'REPORT_LIBRARY_BACKFILL_FAILED');
    assert.equal(projection.items[0].error.message, 'Report Library backfill failed');
    assert.doesNotMatch(JSON.stringify(projection), /Bearer|secret-token|private\.example|\/tmp\/provider|raw payload|"secret"/iu);
  }
});

test('historical failed ingestion records are closed and sanitized at every public read boundary', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-ingestion-historical-error-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const unsafe = {
    schemaVersion: 'report-library-ingestion.v1',
    id: 'ingest_historical_unsafe',
    ingestionId: 'ingest_historical_unsafe',
    status: 'failed',
    source: 'producer',
    projectId: 'project-historical-unsafe',
    analysisRunId: 'analysis-historical-unsafe',
    error: {
      code: 'OLD_PROVIDER_FAILURE',
      message: 'https://private.example/v1 API_KEY=secret RAW_PRIVATE_PAYLOAD /tmp/provider.json',
    },
    failedAt: NOW,
    providerPayload: { token: 'secret-token', raw: 'RAW_PRIVATE_PAYLOAD' },
  };
  const projection = {
    schemaVersion: 'report-library-ingestions.v1',
    projectionDigest: canonicalSha256({
      schemaVersion: 'report-library-ingestions.v1',
      entries: [unsafe],
    }),
    entries: [unsafe],
  };
  fs.writeFileSync(path.join(rootDir, 'projections', 'ingestions.json'), JSON.stringify(projection));
  fs.writeFileSync(path.join(rootDir, 'ingestions', `${unsafe.ingestionId}.json`), JSON.stringify(unsafe));

  const assertSafeProjection = () => {
    const detail = reportLibrary.getIngestion(unsafe.ingestionId);
    const listed = reportLibrary.listIngestions().ingestions[0];
    for (const entry of [detail, listed]) {
      assert.deepEqual(entry.error, {
        code: 'REPORT_LIBRARY_INGESTION_FAILED',
        message: 'Report Library ingestion failed',
      });
      assert.deepEqual(Object.keys(entry).sort(), [
        'analysisRunId', 'error', 'failedAt', 'id', 'ingestionId', 'projectId', 'schemaVersion', 'source', 'status',
      ]);
      assert.doesNotMatch(JSON.stringify(entry), /private\.example|API_KEY|secret|RAW_PRIVATE_PAYLOAD|\/tmp\/provider/iu);
    }
  };

  assertSafeProjection();
  reportLibrary.rebuildProjections();
  assertSafeProjection();
});

test('batch candidate diagnostics never retain an unexpected raw provider payload', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-provider-redaction-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run() {
          const error = new Error('RAW_PRIVATE_PAYLOAD_ABC {"body":"sensitive"} from https://private.example/v1; token=secret');
          error.transient = true;
          throw error;
        },
      },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-07',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-provider-redaction',
    items: [{ itemId: 'item-redacted', projectId: 'project-redacted', sourceIdeaId: 'idea-redacted' }],
  });

  await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-redacted',
    packageInput: reportPackage({
      projectId: 'project-redacted',
      analysisRunId: 'analysis-redacted',
      dailyReportRunId: created.batchId,
    }),
  });
  const serialized = JSON.stringify(batchAdmission.get(created.batchId));

  assert.doesNotMatch(serialized, /RAW_PRIVATE_PAYLOAD_ABC|sensitive|private\.example|secret/iu);
  assert.match(serialized, /REPORT_OVERVIEW_PROVIDER_TRANSIENT/u);
});

test('a failure before the admission visibility marker exposes nothing and recovers without another Overview call', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-pre-marker-crash-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    now: () => NOW,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'before' }),
  });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-pre-marker-crash' });
  const id = reportVersionId(packageInput);

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'TEST_BEFORE_VISIBILITY_MARKER',
  );
  assert.equal(providerCalls, 1);
  assert.equal(admissionService.candidateStore.list()[0].state, REPORT_ADMISSION_CANDIDATE_STATES.PREPARED);
  assert.equal(reportLibrary.get(id), null);
  assert.equal(reportLibrary.readContent(id), null);
  assert.deepEqual(reportLibrary.list().reports, []);
  assert.deepEqual(reportLibrary.tickerTimeline('AAPL').reports, []);
  assert.equal(reportLibrary.status().reportVersionCount, 0);
  assert.equal(reportLibrary.ingest, undefined);
  reportLibrary.reconcile();
  assert.equal(reportLibrary.get(id), null, 'general reconciliation must not publish a prepared candidate');
  assert.deepEqual(reportLibrary.list().reports, []);
  assert.deepEqual(reportLibrary.listIngestions().ingestions, []);

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: { async run() { throw new Error('provider must not run during prepared recovery'); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();

  assert.deepEqual(recovery.map((entry) => entry.reportVersionId), [id]);
  assert.equal(providerCalls, 1);
  assert.equal(recoveredLibrary.list().reports.length, 1);
  assert.equal(delegate.list().filter((event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED).length, 1);
});

test('corrupt prepared Overview state is durably blocked instead of retried on every worker start', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-corrupt-prepared-overview-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    now: () => NOW,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'before' }),
  });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-corrupt-prepared-overview' });
  const id = reportVersionId(packageInput);

  await assert.rejects(
    admissionService.admit(packageInput),
    (error) => error?.code === 'TEST_BEFORE_VISIBILITY_MARKER',
  );
  const overviewPath = path.join(rootDir, 'reports', id, 'overview', 'report-overview.json');
  const corruptOverview = JSON.parse(fs.readFileSync(overviewPath, 'utf8'));
  corruptOverview.unexpectedProviderPayload = { raw: 'must not survive' };
  fs.writeFileSync(overviewPath, JSON.stringify(corruptOverview));

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: { async run() { providerCalls += 1; throw new Error('provider must not rerun'); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();
  const candidate = recoveredWorker.candidateStore.list()[0];

  assert.equal(providerCalls, 1);
  assert.equal(recovery[0].status, 'failed');
  assert.equal(recovery[0].error.code, 'REPORT_OVERVIEW_CORRUPT');
  assert.equal(candidate.state, REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED);
  assert.equal(candidate.lastError.code, 'REPORT_OVERVIEW_CORRUPT');
  assert.deepEqual(await recoveredWorker.recover(), []);
  assert.deepEqual(recoveredLibrary.list().reports, []);
});

test('one corrupt candidate cannot block recovery of another independently staged candidate', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-corrupt-candidate-isolation-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const overviewConfigDigest = admissionService.overviewService.effectiveDefinition().effectiveConfig.digest;
  const valid = admissionService.candidateStore.stage(
    reportPackage({ analysisRunId: 'analysis-recovery-valid' }),
    { overviewConfigDigest, immediateAttemptBudget: 1, stagedAt: NOW },
  ).candidate;
  const corrupt = admissionService.candidateStore.stage(
    reportPackage({ analysisRunId: 'analysis-recovery-corrupt' }),
    { overviewConfigDigest, immediateAttemptBudget: 1, stagedAt: NOW },
  ).candidate;
  const corruptPath = path.join(rootDir, 'admission-candidates', `${corrupt.candidateId}.json`);
  const tampered = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
  tampered.unexpectedProviderPayload = 'Authorization: Bearer secret-token https://private.example/raw';
  fs.writeFileSync(corruptPath, JSON.stringify(tampered));

  const recovery = await admissionService.recover();
  const corruptResult = recovery.find((result) => result.candidateId === corrupt.candidateId);
  const validResult = recovery.find((result) => result.candidateId === valid.candidateId);

  assert.equal(providerCalls, 1);
  assert.equal(corruptResult.status, 'failed');
  assert.deepEqual(corruptResult.error, {
    code: 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
    message: 'Report admission candidate state was corrupt',
  });
  assert.doesNotMatch(JSON.stringify(corruptResult), /Bearer|secret-token|private\.example|raw/iu);
  assert.equal(validResult.status, 'admitted');
  assert.equal(validResult.reportVersionId, valid.reportVersionId);
  assert.equal(reportLibrary.get(valid.reportVersionId).processingStatus, 'Pending');
  const repeatedRecovery = await admissionService.recover();
  assert.equal(providerCalls, 1);
  assert.deepEqual(repeatedRecovery.map((result) => result.candidateId), [corrupt.candidateId]);
});

test('recovery terminalizes a batch item from its checkpoint when the candidate file is corrupt', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-corrupt-batch-candidate-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-17',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-corrupt-candidate-recovery',
    items: [{
      itemId: 'item-corrupt-candidate',
      projectId: 'project-corrupt-candidate',
      sourceIdeaId: 'idea-corrupt-candidate',
    }],
  });
  let providerCalls = 0;
  const firstWorker = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return failedOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  const packageInput = reportPackage({
    projectId: 'project-corrupt-candidate',
    analysisRunId: 'analysis-corrupt-candidate',
    dailyReportRunId: created.batchId,
  });
  await assert.rejects(
    firstWorker.admit(packageInput, {
      batchId: created.batchId,
      itemId: 'item-corrupt-candidate',
      admissionAttemptId: 'admission-corrupt-candidate',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE',
  );
  const pendingItem = batchStore.inspectItem(created.batchId, 'item-corrupt-candidate').item;
  assert.equal(pendingItem.status, 'pending');
  const candidateId = pendingItem.admissionCandidate.candidateId;
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidateId}.json`);
  const tampered = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  tampered.unexpectedProviderPayload = 'Authorization: Bearer secret-token https://private.example/raw';
  delete tampered.stateDigest;
  tampered.stateDigest = canonicalSha256(tampered);
  fs.writeFileSync(candidatePath, JSON.stringify(tampered));
  const corruptBytes = fs.readFileSync(candidatePath);

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: recoveredLibrary.eventStore,
    now: () => NOW,
  });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    batchStore: recoveredBatchStore,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: {
        async run() {
          providerCalls += 1;
          throw new Error('provider must not run for a corrupt candidate');
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();
  const recoveredItem = recoveredBatchStore.inspectItem(created.batchId, 'item-corrupt-candidate').item;

  assert.equal(providerCalls, 1);
  assert.deepEqual(recovery, [{
    status: 'failed',
    candidateId,
    reportVersionId: null,
    error: {
      code: 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
      message: 'Report admission candidate state was corrupt',
    },
  }]);
  assert.equal(recoveredItem.status, 'failed');
  assert.equal(recoveredItem.outcome.candidateId, candidateId);
  assert.equal(recoveredItem.outcome.analysisRunId, 'analysis-corrupt-candidate');
  assert.deepEqual(recoveredItem.outcome.error, recovery[0].error);
  assert.doesNotMatch(JSON.stringify(recoveredItem), /Bearer|secret-token|private\.example|raw/iu);
  assert.deepEqual(fs.readFileSync(candidatePath), corruptBytes);
  const recoveredAdmission = new DailyReportBatchAdmission({
    reportLibrary: recoveredLibrary,
    admissionService: recoveredWorker,
    batchStore: recoveredBatchStore,
    now: () => NOW,
  });
  const projectedItem = recoveredAdmission.get(created.batchId).items[0];
  assert.equal(projectedItem.outcome.candidateAdmission, null);
  assert.deepEqual(recoveredAdmission.list().batches[0].items[0], projectedItem);
  assert.equal(recoveredAdmission.close(created.batchId).batch.status, 'closed');
});

test('recovery terminalizes a pending batch checkpoint whose candidate file is missing', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-missing-batch-candidate-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-18',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-missing-candidate-recovery',
    items: [{
      itemId: 'item-missing-candidate',
      projectId: 'project-missing-candidate',
      sourceIdeaId: 'idea-missing-candidate',
    }],
  });
  let providerCalls = 0;
  const firstWorker = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return failedOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => {},
  });
  const packageInput = reportPackage({
    projectId: 'project-missing-candidate',
    analysisRunId: 'analysis-missing-candidate',
    dailyReportRunId: created.batchId,
  });
  await assert.rejects(
    firstWorker.admit(packageInput, {
      batchId: created.batchId,
      itemId: 'item-missing-candidate',
      admissionAttemptId: 'admission-missing-candidate',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_RETRYABLE',
  );
  const candidateId = batchStore.inspectItem(
    created.batchId,
    'item-missing-candidate',
  ).item.admissionCandidate.candidateId;
  fs.rmSync(path.join(rootDir, 'admission-candidates', `${candidateId}.json`));

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: recoveredLibrary.eventStore,
    now: () => NOW,
  });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    batchStore: recoveredBatchStore,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: {
        async run() {
          providerCalls += 1;
          throw new Error('provider must not run for a missing candidate');
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();
  const recoveredItem = recoveredBatchStore.inspectItem(created.batchId, 'item-missing-candidate').item;

  assert.equal(providerCalls, 1);
  assert.deepEqual(recovery, [{
    status: 'failed',
    candidateId,
    reportVersionId: null,
    error: {
      code: 'REPORT_ADMISSION_CANDIDATE_NOT_FOUND',
      message: 'Report admission candidate was not found',
    },
  }]);
  assert.equal(recoveredItem.status, 'failed');
  assert.equal(recoveredItem.outcome.candidateId, candidateId);
  assert.deepEqual(recoveredItem.outcome.error, recovery[0].error);
  const recoveredAdmission = new DailyReportBatchAdmission({
    reportLibrary: recoveredLibrary,
    admissionService: recoveredWorker,
    batchStore: recoveredBatchStore,
    now: () => NOW,
  });
  assert.equal(recoveredAdmission.get(created.batchId).items[0].outcome.candidateAdmission, null);
  assert.equal(recoveredAdmission.close(created.batchId).batch.status, 'closed');
});

test('a symlinked candidate is isolated as corruption without breaking batch reads or closure', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-symlink-candidate-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run() { throw new Error('provider must not run'); } },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService,
    now: () => NOW,
  });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-19',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-symlink-candidate',
    items: [{
      itemId: 'item-symlink-candidate',
      projectId: 'project-symlink-candidate',
      sourceIdeaId: 'idea-symlink-candidate',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-symlink-candidate',
    analysisRunId: 'analysis-symlink-candidate',
    dailyReportRunId: created.batchId,
  });
  const candidate = admissionService.candidateStore.stage(packageInput, {
    batchId: created.batchId,
    itemId: 'item-symlink-candidate',
    overviewConfigDigest: admissionService.overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  admissionService.batchStore.linkAdmissionCandidate(created.batchId, 'item-symlink-candidate', {
    candidateId: candidate.candidateId,
    analysisRunId: candidate.package.lineage.analysisRunId,
    reportVersionId: candidate.reportVersionId,
    contentDigest: candidate.contentDigest,
    fingerprint: candidate.fingerprint,
    overviewConfigDigest: candidate.overviewConfigDigest,
    admissionAttemptId: 'admission-symlink-candidate',
    productionAttempts: [],
  });
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidate.candidateId}.json`);
  const outsidePath = path.join(rootDir, 'private-candidate-target.json');
  fs.writeFileSync(outsidePath, 'Authorization: Bearer symlink-secret https://private.example/raw');
  fs.rmSync(candidatePath);
  fs.symlinkSync(outsidePath, candidatePath);

  const recovery = await admissionService.recover();
  assert.deepEqual(recovery, [{
    status: 'failed',
    candidateId: candidate.candidateId,
    reportVersionId: null,
    error: {
      code: 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
      message: 'Report admission candidate state was corrupt',
    },
  }]);
  const projected = batchAdmission.get(created.batchId);
  assert.equal(projected.items[0].status, 'failed');
  assert.equal(projected.items[0].outcome.candidateAdmission, null);
  assert.doesNotMatch(JSON.stringify(projected), /Bearer|symlink-secret|private\.example|raw/iu);
  assert.deepEqual(batchAdmission.list().batches[0], projected);
  assert.equal(batchAdmission.close(created.batchId).batch.status, 'closed');
});

test('an authoritative admitted report wins when its pending batch checkpoint candidate is unavailable', async () => {
  for (const mode of ['missing', 'corrupt']) {
    const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, `report-admission-marker-wins-${mode}-`));
    const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
    let providerCalls = 0;
    const admissionService = new ReportAdmissionService({
      reportLibrary,
      overviewService: new ReportOverviewService({
        reportLibrary,
        agentBackend: {
          async run(request) {
            providerCalls += 1;
            return successfulOverview(request);
          },
        },
        now: () => NOW,
      }),
      now: () => NOW,
      maxImmediateAttempts: 1,
      sleep: async () => {},
    });
    const batchAdmission = new DailyReportBatchAdmission({
      reportLibrary,
      admissionService,
      now: () => NOW,
    });
    const created = batchAdmission.createBatch({
      contract: 'daily-report-batch.v1',
      productionDate: mode === 'missing' ? '2026-09-20' : '2026-09-21',
      producer: { id: 'scheduled-daily-report' },
      productionRunId: `daily-run-marker-wins-${mode}`,
      items: [{
        itemId: `item-marker-wins-${mode}`,
        projectId: `project-marker-wins-${mode}`,
        sourceIdeaId: `idea-marker-wins-${mode}`,
      }],
    });
    const packageInput = reportPackage({
      projectId: `project-marker-wins-${mode}`,
      analysisRunId: `analysis-marker-wins-${mode}`,
      dailyReportRunId: created.batchId,
    });
    const admitted = await admissionService.admit(packageInput, {
      batchId: created.batchId,
      itemId: `item-marker-wins-${mode}`,
      admissionAttemptId: `admission-marker-wins-${mode}`,
    });
    assert.equal(admissionService.batchStore.inspectItem(
      created.batchId,
      `item-marker-wins-${mode}`,
    ).item.status, 'pending');
    const candidatePath = path.join(rootDir, 'admission-candidates', `${admitted.candidateId}.json`);
    if (mode === 'missing') {
      fs.rmSync(candidatePath);
    } else {
      const tampered = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      tampered.unexpectedProviderPayload = 'Authorization: Bearer must-not-surface';
      delete tampered.stateDigest;
      tampered.stateDigest = canonicalSha256(tampered);
      fs.writeFileSync(candidatePath, JSON.stringify(tampered));
    }

    const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
    const recoveredBatchStore = new DailyReportBatchStore({
      rootDir,
      eventStore: recoveredLibrary.eventStore,
      now: () => NOW,
    });
    const recoveredService = new ReportAdmissionService({
      reportLibrary: recoveredLibrary,
      batchStore: recoveredBatchStore,
      overviewService: new ReportOverviewService({
        reportLibrary: recoveredLibrary,
        agentBackend: {
          async run() {
            providerCalls += 1;
            throw new Error('provider must not run after the authoritative admission marker');
          },
        },
        now: () => NOW,
      }),
      now: () => NOW,
      maxImmediateAttempts: 1,
      sleep: async () => {},
    });
    const directReplay = await recoveredService.admit(packageInput, {
      batchId: created.batchId,
      itemId: `item-marker-wins-${mode}`,
    });
    assert.equal(directReplay.status, 'admitted');
    assert.equal(directReplay.replayed, true);
    assert.equal(directReplay.candidateId, admitted.candidateId);
    assert.equal(providerCalls, 1);
    const recovery = await recoveredService.recover();
    assert.equal(providerCalls, 1);
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].status, 'admitted');
    assert.equal(recovery[0].candidateId, admitted.candidateId);
    assert.equal(recovery[0].reportVersionId, admitted.reportVersionId);
    assert.equal(recoveredBatchStore.inspectItem(
      created.batchId,
      `item-marker-wins-${mode}`,
    ).item.status, 'succeeded');
    assert.equal(recoveredLibrary.get(admitted.reportVersionId).processingStatus, 'Pending');
    assert.deepEqual(await recoveredService.recover(), []);

    const recoveredAdmission = new DailyReportBatchAdmission({
      reportLibrary: recoveredLibrary,
      admissionService: recoveredService,
      batchStore: recoveredBatchStore,
      now: () => NOW,
    });
    const replay = await recoveredAdmission.completeItem({
      batchId: created.batchId,
      itemId: `item-marker-wins-${mode}`,
      packageInput,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.item.status, 'succeeded');
    assert.equal(recoveredAdmission.get(created.batchId).items[0].outcome.candidateAdmission, null);
    assert.equal(recoveredAdmission.close(created.batchId).batch.status, 'closed');
  }
});

test('marker-only candidate recovery rebuilds stale list and timeline projections before batch success', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-marker-rebuild-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const faultingLibrary = new ReportLibraryStore({
    rootDir,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'after' }),
    now: () => NOW,
  });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: faultingLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-22',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-marker-rebuild',
    items: [{
      itemId: 'item-marker-rebuild',
      projectId: 'project-marker-rebuild',
      sourceIdeaId: 'idea-marker-rebuild',
    }],
  });
  let providerCalls = 0;
  const overviewService = new ReportOverviewService({
    reportLibrary: faultingLibrary,
    agentBackend: {
      async run(request) {
        providerCalls += 1;
        return successfulOverview(request);
      },
    },
    now: () => NOW,
  });
  const candidateStore = new ReportAdmissionStore({ rootDir, now: () => NOW });
  const packageInput = reportPackage({
    projectId: 'project-marker-rebuild',
    analysisRunId: 'analysis-marker-rebuild',
    dailyReportRunId: created.batchId,
  });
  const staged = candidateStore.stage(packageInput, {
    batchId: created.batchId,
    itemId: 'item-marker-rebuild',
    overviewConfigDigest: overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  batchStore.linkAdmissionCandidate(created.batchId, 'item-marker-rebuild', {
    candidateId: staged.candidateId,
    analysisRunId: staged.package.lineage.analysisRunId,
    reportVersionId: staged.reportVersionId,
    contentDigest: staged.contentDigest,
    fingerprint: staged.fingerprint,
    overviewConfigDigest: staged.overviewConfigDigest,
    admissionAttemptId: 'admission-marker-rebuild',
    productionAttempts: [],
  });
  const ownerToken = 'owner-marker-rebuild';
  const claim = candidateStore.claim(staged.candidateId, {
    ownerToken,
    claimedAt: NOW,
    leaseMs: 60_000,
  });
  const preparedOverview = await overviewService.prepare(staged.package, {
    candidateId: staged.candidateId,
    overviewConfigDigest: staged.overviewConfigDigest,
    attemptId: claim.attemptId,
    stagedAt: staged.stagedAt,
  });
  candidateStore.markPrepared(staged.candidateId, {
    ownerToken,
    attemptId: claim.attemptId,
    preparedOverview,
    preparedAt: NOW,
  });
  assert.throws(
    () => faultingLibrary.commitPreparedAdmission(staged.candidateId),
    (error) => error?.code === 'TEST_AFTER_VISIBILITY_MARKER',
  );
  const checkpoint = batchStore.inspectItem(created.batchId, 'item-marker-rebuild').item.admissionCandidate;
  fs.rmSync(path.join(rootDir, 'admission-candidates', `${checkpoint.candidateId}.json`));
  assert.equal(faultingLibrary.get(checkpoint.reportVersionId).processingStatus, 'Pending');
  assert.deepEqual(faultingLibrary.list().reports, []);
  assert.deepEqual(faultingLibrary.tickerTimeline('AAPL').reports, []);

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: recoveredLibrary.eventStore,
    now: () => NOW,
  });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    batchStore: recoveredBatchStore,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: {
        async run() {
          providerCalls += 1;
          throw new Error('provider must not run while rebuilding admission projections');
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();

  assert.equal(providerCalls, 1);
  assert.equal(recovery[0].status, 'admitted');
  assert.equal(recovery[0].reportVersionId, checkpoint.reportVersionId);
  assert.equal(recoveredLibrary.get(checkpoint.reportVersionId).processingStatus, 'Pending');
  assert.deepEqual(
    recoveredLibrary.list().reports.map((report) => report.reportVersionId),
    [checkpoint.reportVersionId],
  );
  assert.deepEqual(
    recoveredLibrary.tickerTimeline('AAPL').reports.map((report) => report.reportVersionId),
    [checkpoint.reportVersionId],
  );
  assert.equal(recoveredBatchStore.inspectItem(created.batchId, 'item-marker-rebuild').item.status, 'succeeded');
});

test('a post-marker commit exception cannot make the daily batch record a false failure', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-post-marker-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'after' }),
    now: () => NOW,
  });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService,
    now: () => NOW,
  });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-23',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-batch-post-marker',
    items: [{
      itemId: 'item-batch-post-marker',
      projectId: 'project-batch-post-marker',
      sourceIdeaId: 'idea-batch-post-marker',
    }],
  });
  const completed = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-batch-post-marker',
    packageInput: reportPackage({
      projectId: 'project-batch-post-marker',
      analysisRunId: 'analysis-batch-post-marker',
      dailyReportRunId: created.batchId,
    }),
  });

  assert.equal(providerCalls, 1);
  assert.equal(completed.item.status, 'succeeded');
  assert.equal(completed.item.outcome.status, 'succeeded');
  assert.equal(reportLibrary.get(completed.item.outcome.reportVersionId).processingStatus, 'Pending');
  assert.deepEqual(
    reportLibrary.list().reports.map((report) => report.reportVersionId),
    [completed.item.outcome.reportVersionId],
  );
  assert.deepEqual(
    reportLibrary.tickerTimeline('AAPL').reports.map((report) => report.reportVersionId),
    [completed.item.outcome.reportVersionId],
  );
});

test('a projection repair failure after the authoritative marker keeps the batch retryable', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-projection-retry-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'after' }),
    now: () => NOW,
  });
  const reconcile = reportLibrary.reconcile.bind(reportLibrary);
  let remainingRepairFailures = 1;
  reportLibrary.reconcile = () => {
    if (remainingRepairFailures > 0) {
      remainingRepairFailures -= 1;
      const error = new Error('injected projection repair failure');
      error.code = 'TEST_PROJECTION_REPAIR_FAILED';
      throw error;
    }
    return reconcile();
  };
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService,
    now: () => NOW,
  });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-27',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-projection-retry',
    items: [{
      itemId: 'item-projection-retry',
      projectId: 'project-projection-retry',
      sourceIdeaId: 'idea-projection-retry',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-projection-retry',
    analysisRunId: 'analysis-projection-retry',
    dailyReportRunId: created.batchId,
  });

  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-projection-retry',
      packageInput,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_PROJECTION_REPAIR_PENDING',
  );
  const pending = batchAdmission.batchStore.inspectItem(created.batchId, 'item-projection-retry').item;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.outcome, null);
  assert.equal(providerCalls, 1);
  assert.equal(reportLibrary.get(pending.admissionCandidate.reportVersionId).processingStatus, 'Pending');
  assert.deepEqual(reportLibrary.list().reports, []);

  const completed = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-projection-retry',
    packageInput,
  });
  assert.equal(completed.item.status, 'succeeded');
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    reportLibrary.list().reports.map((report) => report.reportVersionId),
    [completed.item.outcome.reportVersionId],
  );
  assert.deepEqual(
    batchAdmission.close(created.batchId).processingTrigger.pendingReportVersionIds,
    [completed.item.outcome.reportVersionId],
  );
});

test('producer and backfill replays trust an exact marker before recreating a missing candidate', async () => {
  for (const source of ['producer', 'backfill']) {
    const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, `report-admission-marker-first-${source}-`));
    const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
    let initialCalls = 0;
    const packageInput = reportPackage({ analysisRunId: `analysis-marker-first-${source}` });
    const firstService = new ReportAdmissionService({
      reportLibrary,
      overviewService: new ReportOverviewService({
        reportLibrary,
        agentBackend: {
          async run(request) {
            initialCalls += 1;
            return successfulOverview(request);
          },
        },
        now: () => NOW,
      }),
      now: () => NOW,
      maxImmediateAttempts: 1,
      sleep: async () => {},
    });
    const admitted = await firstService.admit(packageInput, { source });
    fs.rmSync(path.join(rootDir, 'admission-candidates', `${admitted.candidateId}.json`));

    let replayCalls = 0;
    const replayService = new ReportAdmissionService({
      reportLibrary,
      overviewService: new ReportOverviewService({
        reportLibrary,
        agentBackend: {
          async run() {
            replayCalls += 1;
            throw new Error('marker replay must not invoke the provider');
          },
        },
        now: () => NOW,
      }),
      now: () => NOW,
      maxImmediateAttempts: 1,
      sleep: async () => {},
    });
    const replayed = await replayService.admit(packageInput, { source });
    assert.equal(initialCalls, 1);
    assert.equal(replayCalls, 0);
    assert.equal(replayed.status, 'admitted');
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.candidateId, admitted.candidateId);
    assert.deepEqual(replayService.candidateStore.list(), []);
  }
});

test('an exact daily marker replay is independent of later Overview configuration', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-marker-config-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-29',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-marker-config',
    items: [{
      itemId: 'item-marker-config',
      projectId: 'project-marker-config',
      sourceIdeaId: 'idea-marker-config',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-marker-config',
    analysisRunId: 'analysis-marker-config',
    dailyReportRunId: created.batchId,
  });
  let initialCalls = 0;
  const firstService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          initialCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const admitted = await firstService.admit(packageInput, {
    batchId: created.batchId,
    itemId: 'item-marker-config',
  });
  const baseline = firstService.overviewService.effectiveDefinition();
  const changedDefinition = {
    ...baseline,
    effectiveConfig: { ...baseline.effectiveConfig, digest: sha256('later-overview-config') },
  };
  let replayCalls = 0;
  const replayService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    candidateStore: firstService.candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      definitionResolver: () => changedDefinition,
      agentBackend: { async run() { replayCalls += 1; throw new Error('must not run'); } },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const replayed = await replayService.admit(packageInput, {
    batchId: created.batchId,
    itemId: 'item-marker-config',
  });
  assert.equal(initialCalls, 1);
  assert.equal(replayCalls, 0);
  assert.equal(replayed.candidateId, admitted.candidateId);
  assert.equal(replayed.replayed, true);
});

test('an exact marker replay does not resolve current Agent configuration', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-marker-no-config-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const packageInput = reportPackage({ analysisRunId: 'analysis-marker-no-config' });
  const initial = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const admitted = await initial.admit(packageInput);
  let definitionResolutions = 0;
  const replay = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      definitionResolver() {
        definitionResolutions += 1;
        throw Object.assign(new Error('registry unavailable'), { code: 'RUNTIME_REGISTRY_CORRUPT' });
      },
      agentBackend: { async run() { throw new Error('provider must not run for marker replay'); } },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });

  const replayed = await replay.admit(packageInput);
  assert.equal(definitionResolutions, 0);
  assert.equal(replayed.candidateId, admitted.candidateId);
  assert.equal(replayed.replayed, true);
});

test('a candidate create failure cannot leave a checkpoint-only daily admission', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-create-failure-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-30',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-create-failure',
    items: [{
      itemId: 'item-create-failure',
      projectId: 'project-create-failure',
      sourceIdeaId: 'idea-create-failure',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-create-failure',
    analysisRunId: 'analysis-create-failure',
    dailyReportRunId: created.batchId,
  });
  const candidateId = reportAdmissionCandidateId(packageInput);
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidateId}.json`);
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = (sourcePath, destinationPath) => {
    if (!injected && path.resolve(destinationPath) === path.resolve(candidatePath)) {
      injected = true;
      const error = new Error('injected candidate create failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLinkSync(sourcePath, destinationPath);
  };
  try {
    await assert.rejects(
      admissionService.admit(packageInput, {
        batchId: created.batchId,
        itemId: 'item-create-failure',
      }),
      (error) => error?.code === 'EIO',
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.equal(injected, true);
  assert.equal(providerCalls, 0);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(batchStore.inspectItem(created.batchId, 'item-create-failure').item.admissionCandidate, undefined);

  const admitted = await admissionService.admit(packageInput, {
    batchId: created.batchId,
    itemId: 'item-create-failure',
  });
  assert.equal(providerCalls, 1);
  assert.equal(admitted.candidateId, candidateId);
  assert.equal(batchStore.inspectItem(created.batchId, 'item-create-failure').item.admissionCandidate.candidateId, candidateId);
});

test('candidate lock contention stays retryable and cannot terminalize a daily item', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-live-lock-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-10-01',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-live-lock',
    items: [{ itemId: 'item-live-lock', projectId: 'project-live-lock', sourceIdeaId: 'idea-live-lock' }],
  });
  const packageInput = reportPackage({
    projectId: 'project-live-lock',
    analysisRunId: 'analysis-live-lock',
    dailyReportRunId: created.batchId,
  });
  const candidateId = reportAdmissionCandidateId(packageInput);
  const candidateStore = new ReportAdmissionStore({
    rootDir,
    now: () => NOW,
    lockOptions: { timeoutMs: 5, staleMs: 1, retryMs: 1 },
  });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    batchStore,
    admissionService,
    now: () => NOW,
  });
  const lockDir = path.join(rootDir, 'admission-candidates', '.locks', 'candidates', `${candidateId}.lock`);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    acquiredAt: '2026-01-01T00:00:00.000Z',
  }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  await assert.rejects(
    batchAdmission.completeItem({
      batchId: created.batchId,
      itemId: 'item-live-lock',
      packageInput,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_IN_FLIGHT' && error.candidateId === candidateId,
  );
  assert.equal(providerCalls, 0);
  assert.equal(batchStore.inspectItem(created.batchId, 'item-live-lock').item.status, 'pending');
  fs.rmSync(lockDir, { recursive: true, force: true });

  const completed = await batchAdmission.completeItem({
    batchId: created.batchId,
    itemId: 'item-live-lock',
    packageInput,
  });
  assert.equal(completed.item.status, 'succeeded');
  assert.equal(providerCalls, 1);
});

test('a contended candidate does not hold the global staging fence', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-stage-lock-scope-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const resultFile = path.join(rootDir, 'contended-result.json');
  const releaseFile = path.join(rootDir, 'unused-release');
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-10-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-stage-lock-scope',
    items: [{
      itemId: 'item-stage-lock-contended',
      projectId: 'project-stage-lock-contended',
      sourceIdeaId: 'idea-stage-lock-contended',
    }],
  });
  const contendedPackage = reportPackage({
    projectId: 'project-stage-lock-contended',
    analysisRunId: 'analysis-stage-lock-contended',
    dailyReportRunId: created.batchId,
  });
  fs.writeFileSync(packageFile, JSON.stringify(contendedPackage));
  const candidateStore = new ReportAdmissionStore({ rootDir, now: () => NOW });
  const contendedCandidateId = reportAdmissionCandidateId(contendedPackage);
  const lockDir = path.join(
    rootDir,
    'admission-candidates',
    '.locks',
    'candidates',
    `${contendedCandidateId}.lock`,
  );
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    acquiredAt: NOW,
  }));
  const child = startProcessWorker({
    rootDir,
    packageFile,
    callsFile,
    resultFile,
    mode: 'signal-stage',
    releaseFile,
    batchId: created.batchId,
    itemId: 'item-stage-lock-contended',
  });
  await waitForFile(`${resultFile}.contending`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const globalStageLock = path.join(rootDir, 'admission-candidates', '.locks', 'stage.lock');
  const globalFenceHeldWhileWaiting = fs.existsSync(globalStageLock);
  let unrelated = null;
  if (!globalFenceHeldWhileWaiting) {
    unrelated = candidateStore.stage(
      reportPackage({ analysisRunId: 'analysis-stage-lock-independent' }),
      {
        overviewConfigDigest: new ReportOverviewService({ now: () => NOW })
          .effectiveDefinition().effectiveConfig.digest,
        immediateAttemptBudget: 1,
        stagedAt: NOW,
      },
    ).candidate;
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
  const childExit = await waitForProcess(child);

  assert.equal(globalFenceHeldWhileWaiting, false);
  assert.equal(unrelated?.package.lineage.analysisRunId, 'analysis-stage-lock-independent');
  assert.equal(childExit.code, 0, childExit.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).ok, true);
});

test('one contended checkpoint cannot abort recovery of another candidate', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-recovery-lock-isolation-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-10-02',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-recovery-lock-isolation',
    items: [
      { itemId: 'item-lock-contended', projectId: 'project-lock-contended', sourceIdeaId: 'idea-lock-contended' },
      { itemId: 'item-lock-independent', projectId: 'project-lock-independent', sourceIdeaId: 'idea-lock-independent' },
    ],
  });
  const candidateStore = new ReportAdmissionStore({
    rootDir,
    now: () => NOW,
    lockOptions: { timeoutMs: 5, staleMs: 1, retryMs: 1 },
  });
  const overviewConfigDigest = new ReportOverviewService({ now: () => NOW })
    .effectiveDefinition().effectiveConfig.digest;
  const stageMissingCheckpoint = (itemId, projectId, analysisRunId) => {
    const packageInput = reportPackage({ projectId, analysisRunId, dailyReportRunId: created.batchId });
    const candidate = candidateStore.stage(packageInput, {
      batchId: created.batchId,
      itemId,
      overviewConfigDigest,
      immediateAttemptBudget: 1,
      stagedAt: NOW,
    }).candidate;
    batchStore.linkAdmissionCandidate(created.batchId, itemId, {
      candidateId: candidate.candidateId,
      analysisRunId: candidate.package.lineage.analysisRunId,
      reportVersionId: candidate.reportVersionId,
      contentDigest: candidate.contentDigest,
      fingerprint: candidate.fingerprint,
      overviewConfigDigest: candidate.overviewConfigDigest,
      admissionAttemptId: `admission-${itemId}`,
      productionAttempts: [],
    });
    fs.rmSync(path.join(rootDir, 'admission-candidates', `${candidate.candidateId}.json`));
    return candidate;
  };
  const contended = stageMissingCheckpoint(
    'item-lock-contended',
    'project-lock-contended',
    'analysis-lock-contended',
  );
  const independent = stageMissingCheckpoint(
    'item-lock-independent',
    'project-lock-independent',
    'analysis-lock-independent',
  );
  const lockDir = path.join(
    rootDir,
    'admission-candidates',
    '.locks',
    'candidates',
    `${contended.candidateId}.lock`,
  );
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    acquiredAt: NOW,
  }));
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run() { throw new Error('provider must not run'); } },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });

  const recovery = await admissionService.recover();
  fs.rmSync(lockDir, { recursive: true, force: true });

  assert.deepEqual(recovery.map((entry) => [entry.candidateId, entry.status]), [
    [contended.candidateId, 'retryable'],
    [independent.candidateId, 'failed'],
  ]);
  assert.equal(batchStore.inspectItem(created.batchId, 'item-lock-contended').item.status, 'pending');
  assert.equal(batchStore.inspectItem(created.batchId, 'item-lock-independent').item.status, 'failed');
});

test('backfill repairs an authoritative marker before applying its exhausted attempt budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-backfill-repair-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'after' }),
    now: () => NOW,
  });
  const reconcile = reportLibrary.reconcile.bind(reportLibrary);
  let repairFailures = 1;
  reportLibrary.reconcile = () => {
    if (repairFailures > 0) {
      repairFailures -= 1;
      const error = new Error('injected backfill projection repair failure');
      error.code = 'TEST_BACKFILL_PROJECTION_REPAIR_FAILED';
      throw error;
    }
    return reconcile();
  };
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-backfill-projection-repair' });
  const backfill = new ReportLibraryBackfill({
    store: reportLibrary,
    admissionService,
    rootDir,
    now: () => NOW,
    maxAttempts: 1,
  });
  const first = await backfill.start({
    contract: 'report-library-backfill-manifest.v1',
    manifestId: 'manifest-backfill-projection-repair',
    asOf: NOW,
    items: [{ itemId: 'item-backfill-projection-repair', package: packageInput, source: null }],
  });
  assert.equal(first.status, 'failed');
  assert.equal(first.items[0].attempts, 1);
  assert.equal(first.items[0].error.code, 'REPORT_ADMISSION_PROJECTION_REPAIR_PENDING');
  assert.equal(providerCalls, 1);

  const resumed = await backfill.resume(first.runId, { maxAttempts: 1 });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.items[0].attempts, 1);
  assert.equal(resumed.items[0].error, null);
  assert.equal(providerCalls, 1);
});

test('a missing checkpointed candidate cannot be recreated with reset audit state', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-recreate-identity-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    admissionService,
    now: () => NOW,
  });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-24',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-recreate-identity',
    items: [{
      itemId: 'item-recreate-identity',
      projectId: 'project-recreate-identity',
      sourceIdeaId: 'idea-recreate-identity',
    }],
  });
  const originalPackage = reportPackage({
    projectId: 'project-recreate-identity',
    analysisRunId: 'analysis-recreate-original',
    dailyReportRunId: created.batchId,
  });
  const originalCandidate = admissionService.candidateStore.stage(originalPackage, {
    batchId: created.batchId,
    itemId: 'item-recreate-identity',
    overviewConfigDigest: admissionService.overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  admissionService.batchStore.linkAdmissionCandidate(created.batchId, 'item-recreate-identity', {
    candidateId: originalCandidate.candidateId,
    analysisRunId: originalCandidate.package.lineage.analysisRunId,
    reportVersionId: originalCandidate.reportVersionId,
    contentDigest: originalCandidate.contentDigest,
    fingerprint: originalCandidate.fingerprint,
    overviewConfigDigest: originalCandidate.overviewConfigDigest,
    admissionAttemptId: 'admission-recreate-original',
    productionAttempts: [],
  });
  fs.rmSync(path.join(rootDir, 'admission-candidates', `${originalCandidate.candidateId}.json`));

  const differentRun = reportPackage({
    projectId: 'project-recreate-identity',
    analysisRunId: 'analysis-recreate-different',
    dailyReportRunId: created.batchId,
  });
  await assert.rejects(
    async () => admissionService.admit(differentRun, {
      batchId: created.batchId,
      itemId: 'item-recreate-identity',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  const changedFingerprint = structuredClone(originalPackage);
  changedFingerprint.metadata.title = 'Conflicting same-identity report title';
  await assert.rejects(
    async () => admissionService.admit(changedFingerprint, {
      batchId: created.batchId,
      itemId: 'item-recreate-identity',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  await assert.rejects(
    async () => admissionService.admit(originalPackage, {
      batchId: created.batchId,
      itemId: 'item-recreate-identity',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  const baselineDefinition = admissionService.overviewService.effectiveDefinition();
  const changedDefinition = {
    ...baselineDefinition,
    effectiveConfig: {
      ...baselineDefinition.effectiveConfig,
      digest: sha256('changed-recreation-overview-config'),
    },
  };
  const changedConfigService = new ReportAdmissionService({
    reportLibrary,
    batchStore: admissionService.batchStore,
    candidateStore: admissionService.candidateStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      definitionResolver: () => changedDefinition,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  await assert.rejects(
    async () => changedConfigService.admit(originalPackage, {
      batchId: created.batchId,
      itemId: 'item-recreate-identity',
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  );

  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);
  const pending = admissionService.batchStore.inspectItem(created.batchId, 'item-recreate-identity').item;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.admissionCandidate.candidateId, originalCandidate.candidateId);
  assert.equal(pending.admissionCandidate.fingerprint, originalCandidate.fingerprint);
  assert.equal(pending.admissionCandidate.overviewConfigDigest, originalCandidate.overviewConfigDigest);
});

test('candidate-first checkpointing preserves staged work when a later batch link is interrupted', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-reservation-race-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-28',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-reservation-race',
    items: [{
      itemId: 'item-reservation-race',
      projectId: 'project-reservation-race',
      sourceIdeaId: 'idea-reservation-race',
    }],
  });
  const linkAdmissionCandidate = batchStore.linkAdmissionCandidate.bind(batchStore);
  let terminalized = false;
  batchStore.linkAdmissionCandidate = (...args) => {
    if (!terminalized) {
      terminalized = true;
      const error = new Error('concurrent report production failure');
      error.code = 'REPORT_PRODUCTION_FAILED';
      batchStore.recordOutcome(created.batchId, 'item-reservation-race', {
        status: 'failed',
        stage: 'production',
        analysisRunId: null,
        candidateId: null,
        error,
        productionAttempts: [],
        admissionAttempts: [],
      });
    }
    return linkAdmissionCandidate(...args);
  };
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    batchStore,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: {
        async run(request) {
          providerCalls += 1;
          return successfulOverview(request);
        },
      },
      now: () => NOW,
    }),
    now: () => NOW,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({
    projectId: 'project-reservation-race',
    analysisRunId: 'analysis-reservation-race',
    dailyReportRunId: created.batchId,
  });

  await assert.rejects(
    async () => admissionService.admit(packageInput, {
      batchId: created.batchId,
      itemId: 'item-reservation-race',
    }),
    (error) => error?.code === 'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT',
  );
  assert.equal(providerCalls, 0);
  const candidates = admissionService.candidateStore.list();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].state, REPORT_ADMISSION_CANDIDATE_STATES.STAGED);
  const pendingItem = batchStore.inspectItem(created.batchId, 'item-reservation-race').item;
  assert.equal(pendingItem.status, 'pending');
  assert.equal(pendingItem.admissionCandidate.candidateId, candidates[0].candidateId);
  const recovered = await admissionService.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'admitted');
  assert.equal(providerCalls, 1);
  assert.deepEqual(await admissionService.recover(), []);
});

test('missing-candidate recovery atomically fences a concurrent producer from recreating it', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-missing-candidate-race-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'release');
  const recoveryResult = path.join(rootDir, 'recovery-result.json');
  const producerResult = path.join(rootDir, 'producer-result.json');
  const setupLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const setupBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  });
  const created = setupBatchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-25',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-missing-candidate-race',
    items: [{
      itemId: 'item-missing-candidate-race',
      projectId: 'project-missing-candidate-race',
      sourceIdeaId: 'idea-missing-candidate-race',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-missing-candidate-race',
    analysisRunId: 'analysis-missing-candidate-race',
    dailyReportRunId: created.batchId,
  });
  fs.writeFileSync(packageFile, JSON.stringify(packageInput));
  const setupService = new ReportAdmissionService({
    reportLibrary: setupLibrary,
    batchStore: setupBatchStore,
    now: () => NOW,
  });
  const candidate = setupService.candidateStore.stage(packageInput, {
    batchId: created.batchId,
    itemId: 'item-missing-candidate-race',
    overviewConfigDigest: setupService.overviewService.effectiveDefinition().effectiveConfig.digest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  }).candidate;
  setupBatchStore.linkAdmissionCandidate(created.batchId, 'item-missing-candidate-race', {
    candidateId: candidate.candidateId,
    analysisRunId: candidate.package.lineage.analysisRunId,
    reportVersionId: candidate.reportVersionId,
    contentDigest: candidate.contentDigest,
    fingerprint: candidate.fingerprint,
    overviewConfigDigest: candidate.overviewConfigDigest,
    admissionAttemptId: 'admission-missing-candidate-race',
    productionAttempts: [],
  });
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidate.candidateId}.json`);
  fs.rmSync(candidatePath);

  const common = {
    rootDir,
    packageFile,
    callsFile,
    releaseFile,
    batchId: created.batchId,
    itemId: 'item-missing-candidate-race',
  };
  const recovery = startProcessWorker({
    ...common,
    resultFile: recoveryResult,
    mode: 'recover-pause-outcome',
  });
  await waitForFile(`${recoveryResult}.ready`);
  const producer = startProcessWorker({
    ...common,
    resultFile: producerResult,
    mode: 'signal-stage',
  });
  await waitForFile(`${producerResult}.contending`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(releaseFile, 'release\n');

  const [recoveryExit, producerExit] = await Promise.all([
    waitForProcess(recovery),
    waitForProcess(producer),
  ]);
  assert.equal(recoveryExit.code, 0, recoveryExit.stderr);
  assert.equal(producerExit.code, 0, producerExit.stderr);
  const recovered = JSON.parse(fs.readFileSync(recoveryResult, 'utf8'));
  const produced = JSON.parse(fs.readFileSync(producerResult, 'utf8'));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value[0].status, 'failed');
  assert.equal(recovered.value[0].error.code, 'REPORT_ADMISSION_CANDIDATE_NOT_FOUND');
  assert.equal(produced.ok, false);
  assert.equal(produced.error.code, 'REPORT_ADMISSION_CANDIDATE_CONFLICT');
  assert.deepEqual(readCallLog(callsFile), []);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(setupBatchStore.inspectItem(created.batchId, 'item-missing-candidate-race').item.status, 'failed');
});

test('unavailable-candidate recovery cannot fail a batch while its admission commit owns the candidate lock', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-commit-recovery-race-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'release');
  const producerResult = path.join(rootDir, 'producer-result.json');
  const recoveryResult = path.join(rootDir, 'recovery-result.json');
  const setupLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const setupBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  });
  const created = setupBatchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-26',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-commit-recovery-race',
    items: [{
      itemId: 'item-commit-recovery-race',
      projectId: 'project-commit-recovery-race',
      sourceIdeaId: 'idea-commit-recovery-race',
    }],
  });
  const packageInput = reportPackage({
    projectId: 'project-commit-recovery-race',
    analysisRunId: 'analysis-commit-recovery-race',
    dailyReportRunId: created.batchId,
  });
  fs.writeFileSync(packageFile, JSON.stringify(packageInput));
  const common = {
    rootDir,
    packageFile,
    callsFile,
    releaseFile,
    batchId: created.batchId,
    itemId: 'item-commit-recovery-race',
  };
  const producer = startProcessWorker({
    ...common,
    resultFile: producerResult,
    mode: 'pause-commit-lock',
  });
  await waitForFile(`${producerResult}.ready`);
  const checkpoint = setupBatchStore.inspectItem(created.batchId, 'item-commit-recovery-race').item.admissionCandidate;
  const candidatePath = path.join(rootDir, 'admission-candidates', `${checkpoint.candidateId}.json`);
  fs.rmSync(candidatePath);

  const recovery = startProcessWorker({
    ...common,
    resultFile: recoveryResult,
    mode: 'recover',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(recoveryResult), false, 'recovery must wait for the active admission commit');
  fs.writeFileSync(releaseFile, 'release\n');

  const [producerExit, recoveryExit] = await Promise.all([
    waitForProcess(producer),
    waitForProcess(recovery),
  ]);
  assert.equal(producerExit.code, 0, producerExit.stderr);
  assert.equal(recoveryExit.code, 0, recoveryExit.stderr);
  const produced = JSON.parse(fs.readFileSync(producerResult, 'utf8'));
  const recovered = JSON.parse(fs.readFileSync(recoveryResult, 'utf8'));
  assert.equal(produced.ok, true);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.every((result) => result.status === 'admitted'), true);
  assert.equal(recovered.value.every((result) => result.candidateId === checkpoint.candidateId), true);
  assert.equal(readCallLog(callsFile).length, 1);

  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  assert.equal(batchStore.inspectItem(created.batchId, 'item-commit-recovery-race').item.status, 'succeeded');
  assert.deepEqual(
    reportLibrary.list().reports.map((report) => report.reportVersionId),
    [checkpoint.reportVersionId],
  );
  const batchAdmission = new DailyReportBatchAdmission({
    reportLibrary,
    batchStore,
    admissionService: new ReportAdmissionService({ reportLibrary, batchStore, now: () => NOW }),
    now: () => NOW,
  });
  const closed = batchAdmission.close(created.batchId);
  assert.equal(closed.processingTrigger.status, 'requested');
  assert.deepEqual(closed.processingTrigger.pendingReportVersionIds, [checkpoint.reportVersionId]);
});

test('one candidate commit lock does not block an unrelated candidate admission', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-candidate-lock-isolation-'));
  const firstPackageFile = path.join(rootDir, 'first-package.json');
  const secondPackageFile = path.join(rootDir, 'second-package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'release');
  const firstResult = path.join(rootDir, 'first-result.json');
  const secondResult = path.join(rootDir, 'second-result.json');
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
    now: () => NOW,
  });
  const created = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-29',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-candidate-lock-isolation',
    items: [
      {
        itemId: 'item-candidate-lock-first',
        projectId: 'project-candidate-lock-first',
        sourceIdeaId: 'idea-candidate-lock-first',
      },
      {
        itemId: 'item-candidate-lock-second',
        projectId: 'project-candidate-lock-second',
        sourceIdeaId: 'idea-candidate-lock-second',
      },
    ],
  });
  fs.writeFileSync(firstPackageFile, JSON.stringify(reportPackage({
    projectId: 'project-candidate-lock-first',
    analysisRunId: 'analysis-candidate-lock-first',
    dailyReportRunId: created.batchId,
  })));
  fs.writeFileSync(secondPackageFile, JSON.stringify(reportPackage({
    projectId: 'project-candidate-lock-second',
    analysisRunId: 'analysis-candidate-lock-second',
    dailyReportRunId: created.batchId,
  })));

  const first = startProcessWorker({
    rootDir,
    packageFile: firstPackageFile,
    callsFile,
    resultFile: firstResult,
    mode: 'pause-commit-lock',
    releaseFile,
    batchId: created.batchId,
    itemId: 'item-candidate-lock-first',
  });
  const firstDone = waitForProcess(first);
  await waitForFile(`${firstResult}.ready`);
  const second = startProcessWorker({
    rootDir,
    packageFile: secondPackageFile,
    callsFile,
    resultFile: secondResult,
    mode: 'normal',
    releaseFile,
    batchId: created.batchId,
    itemId: 'item-candidate-lock-second',
  });
  const secondDone = waitForProcess(second);
  const secondCompletedWhileFirstLocked = await fileAppearsWithin(secondResult, 1_000);
  fs.writeFileSync(releaseFile, 'release\n');
  const [firstExit, secondExit] = await Promise.all([
    firstDone,
    secondDone,
  ]);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  const secondOutcome = JSON.parse(fs.readFileSync(secondResult, 'utf8'));
  assert.equal(secondCompletedWhileFirstLocked, true, JSON.stringify(secondOutcome));
  assert.equal(secondOutcome.ok, true);
  assert.equal(secondOutcome.value.item.status, 'succeeded');
  assert.equal(firstExit.code, 0, firstExit.stderr);
  const firstOutcome = JSON.parse(fs.readFileSync(firstResult, 'utf8'));
  assert.equal(firstOutcome.ok, true);
  assert.equal(firstOutcome.value.item.status, 'succeeded');
  assert.equal(readCallLog(callsFile).length, 2);
});

test('batch association lookup ignores unrelated corrupt candidates and fails the matching item closed', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-association-isolation-'));
  const candidateStore = new ReportAdmissionStore({ rootDir, now: () => NOW });
  const overviewConfigDigest = sha256('association-isolation-config');
  const corruptCandidate = (candidate) => {
    const candidatePath = path.join(rootDir, 'admission-candidates', `${candidate.candidateId}.json`);
    const value = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    value.unexpectedProviderPayload = 'https://private.example/raw';
    delete value.stateDigest;
    value.stateDigest = canonicalSha256(value);
    fs.writeFileSync(candidatePath, JSON.stringify(value));
  };
  const unrelated = candidateStore.stage(
    reportPackage({ analysisRunId: 'analysis-unrelated-corrupt' }),
    { overviewConfigDigest, immediateAttemptBudget: 1, stagedAt: NOW },
  ).candidate;
  corruptCandidate(unrelated);

  const isolatedBatchId = 'daily_batch_association_isolated';
  const isolated = candidateStore.stage(reportPackage({
    projectId: 'project-association-isolated',
    analysisRunId: 'analysis-association-isolated',
    dailyReportRunId: isolatedBatchId,
  }), {
    batchId: isolatedBatchId,
    itemId: 'item-association-isolated',
    overviewConfigDigest,
    immediateAttemptBudget: 1,
    stagedAt: NOW,
  });
  assert.equal(isolated.created, true);
  assert.equal(candidateStore.get(isolated.candidate.candidateId).candidateId, isolated.candidate.candidateId);

  corruptCandidate(isolated.candidate);
  assert.throws(
    () => candidateStore.stage(reportPackage({
      projectId: 'project-association-isolated',
      analysisRunId: 'analysis-association-conflict',
      dailyReportRunId: isolatedBatchId,
    }), {
      batchId: isolatedBatchId,
      itemId: 'item-association-isolated',
      overviewConfigDigest,
      immediateAttemptBudget: 1,
      stagedAt: NOW,
    }),
    (error) => error?.code === 'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  );
});

test('a failure after the visibility marker returns the authoritative admission and rebuilds without another Overview call', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-post-marker-crash-'));
  const delegate = new ReportLibraryEventStore({ rootDir, now: () => NOW });
  const reportLibrary = new ReportLibraryStore({
    rootDir,
    now: () => NOW,
    eventStore: new FaultingAdmissionEventStore(delegate, { fail: 'after' }),
  });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const packageInput = reportPackage({ analysisRunId: 'analysis-post-marker-crash' });
  const id = reportVersionId(packageInput);

  const admitted = await admissionService.admit(packageInput);
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.replayed, true);
  assert.equal(reportLibrary.get(id)?.processingStatus, 'Pending');
  assert.deepEqual(reportLibrary.list().reports.map((report) => report.reportVersionId), [id]);
  assert.equal(
    admissionService.candidateStore.get(admitted.candidateId).state,
    REPORT_ADMISSION_CANDIDATE_STATES.PREPARED,
  );

  const recoveredLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: recoveredLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary: recoveredLibrary,
      agentBackend: { async run() { throw new Error('provider must not run after marker commit'); } },
      now: () => NOW,
    }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const recovery = await recoveredWorker.recover();

  assert.equal(providerCalls, 1);
  assert.equal(recovery[0].status, 'admitted');
  assert.equal(recoveredLibrary.list().reports.length, 1);
  assert.equal(delegate.list().filter((event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED).length, 1);
});

test('two processes racing through batch completion keep the item pending for the active owner', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-process-race-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'release');
  const firstResult = path.join(rootDir, 'first-result.json');
  const secondResult = path.join(rootDir, 'second-result.json');
  const setupLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batch = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  }).create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-process-race',
    items: [{ itemId: 'item-process-race', projectId: 'project-issue-40', sourceIdeaId: 'idea-process-race' }],
  });
  fs.writeFileSync(packageFile, JSON.stringify(reportPackage({
    analysisRunId: 'analysis-process-race',
    dailyReportRunId: batch.batchId,
  })));
  const common = {
    rootDir, packageFile, callsFile, releaseFile,
    batchId: batch.batchId, itemId: 'item-process-race',
  };
  const first = startProcessWorker({ ...common, resultFile: firstResult, mode: 'pause' });
  await waitForFile(`${firstResult}.ready`);
  const second = startProcessWorker({ ...common, resultFile: secondResult, mode: 'normal' });
  const secondExit = await waitForProcess(second);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  const secondOutcome = JSON.parse(fs.readFileSync(secondResult, 'utf8'));
  assert.equal(secondOutcome.ok, false);
  assert.equal(secondOutcome.error.code, 'REPORT_ADMISSION_IN_FLIGHT');
  const pendingBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  });
  assert.equal(pendingBatchStore.inspectItem(batch.batchId, common.itemId).item.status, 'pending');
  fs.writeFileSync(releaseFile, 'release\n');
  const firstExit = await waitForProcess(first);
  assert.equal(firstExit.code, 0, firstExit.stderr);

  const reportLibrary = new ReportLibraryStore({ rootDir });
  const candidates = new ReportAdmissionService({ reportLibrary }).candidateStore.list();
  assert.equal(readCallLog(callsFile).length, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].state, REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED);
  assert.deepEqual(candidates[0].batch, { batchId: common.batchId, itemId: common.itemId });
  assert.equal(pendingBatchStore.inspectItem(batch.batchId, common.itemId).item.status, 'succeeded');
  assert.equal(reportLibrary.list().reports.length, 1);
  assert.equal(reportLibrary.eventStore.list().filter((event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED).length, 1);
});


test('an expired lease owned by a live paused process does not start a second physical Overview call', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-paused-owner-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'release');
  const firstResult = path.join(rootDir, 'first-result.json');
  const secondResult = path.join(rootDir, 'second-result.json');
  const setupLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  });
  const batch = batchStore.create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-10-02',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-paused-owner',
    items: [{
      itemId: 'item-paused-owner',
      projectId: 'project-paused-owner',
      sourceIdeaId: 'idea-paused-owner',
    }],
  });
  fs.writeFileSync(packageFile, JSON.stringify(reportPackage({
    projectId: 'project-paused-owner',
    analysisRunId: 'analysis-paused-owner',
    dailyReportRunId: batch.batchId,
  })));
  const common = {
    rootDir,
    packageFile,
    callsFile,
    releaseFile,
    batchId: batch.batchId,
    itemId: 'item-paused-owner',
  };
  const first = startProcessWorker({ ...common, resultFile: firstResult, mode: 'pause' });
  let firstFinished = false;
  t.after(() => {
    if (firstFinished) return;
    try { process.kill(first.pid, 'SIGCONT'); } catch {}
    try { process.kill(first.pid, 'SIGTERM'); } catch {}
  });
  await waitForFile(`${firstResult}.ready`);
  process.kill(first.pid, 'SIGSTOP');

  const candidateId = batchStore.inspectItem(batch.batchId, common.itemId).item.admissionCandidate.candidateId;
  const candidatePath = path.join(rootDir, 'admission-candidates', `${candidateId}.json`);
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  candidate.ownership.leaseExpiresAt = '2000-01-01T00:00:00.000Z';
  delete candidate.stateDigest;
  candidate.stateDigest = canonicalSha256(candidate);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`);

  const second = startProcessWorker({ ...common, resultFile: secondResult, mode: 'normal' });
  const secondExit = await waitForProcess(second);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  const secondOutcome = JSON.parse(fs.readFileSync(secondResult, 'utf8'));
  assert.equal(secondOutcome.ok, false);
  assert.equal(secondOutcome.error.code, 'REPORT_ADMISSION_IN_FLIGHT');
  assert.equal(readCallLog(callsFile).length, 1);

  process.kill(first.pid, 'SIGCONT');
  fs.writeFileSync(releaseFile, 'release\n');
  const firstExit = await waitForProcess(first);
  firstFinished = true;
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(readCallLog(callsFile).length, 1);
  assert.equal(new ReportLibraryStore({ rootDir }).list().reports.length, 1);
});

test('a restarted worker reclaims dead ownership with the same logical Agent attempt key', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-stale-owner-'));
  const packageFile = path.join(rootDir, 'package.json');
  const callsFile = path.join(rootDir, 'physical-calls.jsonl');
  const releaseFile = path.join(rootDir, 'unused-release');
  const crashedResult = path.join(rootDir, 'crashed-result.json');
  const recoveredResult = path.join(rootDir, 'recovered-result.json');
  const setupLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const batch = new DailyReportBatchStore({
    rootDir,
    eventStore: setupLibrary.eventStore,
    now: () => NOW,
  }).create({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-stale-owner',
    items: [{ itemId: 'item-stale-owner', projectId: 'project-issue-40', sourceIdeaId: 'idea-stale-owner' }],
  });
  const packageInput = reportPackage({
    analysisRunId: 'analysis-stale-owner',
    dailyReportRunId: batch.batchId,
  });
  fs.writeFileSync(packageFile, JSON.stringify(packageInput));
  const common = {
    rootDir, packageFile, callsFile, releaseFile,
    batchId: batch.batchId, itemId: 'item-stale-owner',
  };
  const crashed = startProcessWorker({ ...common, resultFile: crashedResult, mode: 'crash' });
  const crashedExit = await waitForProcess(crashed);
  assert.equal(crashedExit.code, 86, crashedExit.stderr);

  const recovered = startProcessWorker({ ...common, resultFile: recoveredResult, mode: 'recover' });
  const recoveredExit = await waitForProcess(recovered);
  assert.equal(recoveredExit.code, 0, recoveredExit.stderr);
  const recoveredOutcome = JSON.parse(fs.readFileSync(recoveredResult, 'utf8'));
  assert.equal(recoveredOutcome.ok, true);

  const calls = readCallLog(callsFile);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.match(calls[0].idempotencyKey, new RegExp(reportVersionFingerprint(packageInput), 'u'));
  assert.equal(calls[0].runId, calls[1].runId);
  const reportLibrary = new ReportLibraryStore({ rootDir });
  assert.equal(reportLibrary.list().reports.length, 1);
  assert.equal(reportLibrary.eventStore.list().filter((event) => event.eventType === REPORT_LIBRARY_EVENT_TYPES.REPORT_VERSION_ADMITTED).length, 1);
  const recoveredBatchStore = new DailyReportBatchStore({
    rootDir,
    eventStore: reportLibrary.eventStore,
  });
  const recoveredItem = recoveredBatchStore.inspectItem(batch.batchId, 'item-stale-owner').item;
  assert.equal(recoveredItem.status, 'succeeded');
  assert.equal(recoveredItem.outcome.candidateId, recoveredItem.admissionCandidate.candidateId);
  const closed = recoveredBatchStore.close(batch.batchId, {
    pendingReportVersionIds: reportLibrary.listPendingReports().reports.map((report) => report.reportVersionId),
  });
  assert.equal(closed.batch.status, 'closed');
});

test('a later retry keeps the admitted ReportVersion associated with its original daily batch item', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-lineage-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const firstBackend = {
    async run(request) {
      if (request.input.metadata.lineage.analysisRunId === 'analysis-beta') {
        return {
          status: 'failed', valid: false, output: null, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
          metrics: {}, stopReason: 'provider-unavailable', traceRef: request.runId,
          provider: 'scripted', model: 'scripted-small', live: false,
          error: { code: 'TEMPORARY_PROVIDER_FAILURE', message: 'temporary failure' },
        };
      }
      return successfulOverview(request);
    },
  };
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({ reportLibrary, agentBackend: firstBackend, now: () => NOW }),
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const created = batchAdmission.createBatch({
    contract: 'daily-report-batch.v1',
    productionDate: '2026-09-03',
    producer: { id: 'scheduled-daily-report' },
    productionRunId: 'daily-run-issue-40',
    items: [
      { itemId: 'item-alpha', projectId: 'project-alpha', sourceIdeaId: 'idea-alpha' },
      { itemId: 'item-beta', projectId: 'project-beta', sourceIdeaId: 'idea-beta' },
    ],
  });
  const alphaPackage = reportPackage({
    projectId: 'project-alpha', analysisRunId: 'analysis-alpha', dailyReportRunId: created.batchId,
  });
  const betaPackage = reportPackage({
    projectId: 'project-beta', analysisRunId: 'analysis-beta', dailyReportRunId: created.batchId,
  });

  const [alpha, beta] = await Promise.all([
    batchAdmission.completeItem({ batchId: created.batchId, itemId: 'item-alpha', packageInput: alphaPackage }),
    batchAdmission.completeItem({ batchId: created.batchId, itemId: 'item-beta', packageInput: betaPackage }),
  ]);
  const closed = batchAdmission.close(created.batchId);
  const closedStateDigest = batchAdmission.batchStore.get(created.batchId).stateDigest;

  assert.equal(alpha.item.status, 'succeeded');
  assert.equal(beta.item.status, 'failed');
  assert.match(beta.item.outcome.candidateId, /^candidate_/u);
  assert.equal(reportLibrary.get(reportVersionId(betaPackage)), null);
  assert.equal(closed.batch.status, 'closed');

  const recoveredWorker = new ReportAdmissionService({
    reportLibrary: new ReportLibraryStore({ rootDir, now: () => '2026-09-03T00:00:01.000Z' }),
    overviewService: new ReportOverviewService({
      reportLibrary: new ReportLibraryStore({ rootDir, now: () => '2026-09-03T00:00:01.000Z' }),
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => '2026-09-03T00:00:01.000Z',
    }),
    now: () => '2026-09-03T00:00:01.000Z',
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  await recoveredWorker.recover();

  const recoveredReport = recoveredWorker.reportLibrary.get(reportVersionId(betaPackage));
  assert.deepEqual(recoveredReport.admission.batch, { batchId: created.batchId, itemId: 'item-beta' });
  assert.equal(recoveredReport.admission.candidateId, beta.item.outcome.candidateId);
  const projectedBatch = batchAdmission.get(created.batchId);
  assert.equal(projectedBatch.items[1].outcome.candidateId, beta.item.outcome.candidateId);
  assert.equal(projectedBatch.items[1].outcome.candidateAdmission.status, 'admitted');
  assert.equal(projectedBatch.items[1].outcome.candidateAdmission.reportVersionId, reportVersionId(betaPackage));
  assert.equal(Object.hasOwn(projectedBatch.items[0].outcome, 'overview'), false);
  assert.equal(batchAdmission.batchStore.get(created.batchId).stateDigest, closedStateDigest);
});

test('a daily producer batch is rejected above 100 candidates before admission work starts', () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-batch-bound-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  let providerCalls = 0;
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { providerCalls += 1; return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService, now: () => NOW });
  const items = Array.from({ length: 101 }, (_, index) => ({
    itemId: `item-${index}`,
    projectId: `project-${index}`,
    sourceIdeaId: `idea-${index}`,
  }));

  assert.throws(
    () => batchAdmission.createBatch({
      contract: 'daily-report-batch.v1',
      productionDate: '2026-09-03',
      producer: { id: 'scheduled-daily-report' },
      productionRunId: 'daily-run-too-large',
      items,
    }),
    /100/u,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(admissionService.candidateStore.list(), []);
});

test('public Report Library projections expose only the Pending or Processed business state', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-public-state-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-public-state' }));

  const detail = reportLibrary.get(admitted.reportVersionId);
  const listed = reportLibrary.list().reports[0];
  const timeline = reportLibrary.tickerTimeline('AAPL').reports[0];

  for (const projection of [detail, listed, timeline]) {
    assert.equal(projection.processingStatus, 'Pending');
    assert.equal(Object.hasOwn(projection, 'overview'), false);
    assert.equal(Object.hasOwn(projection, 'worldview'), false);
  }
  const status = reportLibrary.status();
  assert.equal(status.pendingReportCount, 1);
  assert.equal(status.processedReportCount, 0);
  assert.equal(Object.hasOwn(status, 'overviews'), false);
});

test('a pre-Issue-40 ready report with its original admission marker remains publicly readable', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-receiptless-anchor-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-receiptless-anchor' }));
  const anchorPath = path.join(rootDir, 'reports', admitted.reportVersionId, 'report-version.json');
  const legacyAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  delete legacyAnchor.admission;
  fs.writeFileSync(anchorPath, JSON.stringify(legacyAnchor));
  const eventPath = path.join(rootDir, 'events', 'outbox', '000000000001.json');
  const legacyEvent = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  delete legacyEvent.payload.admissionReceipt;
  fs.writeFileSync(eventPath, JSON.stringify(legacyEvent));
  fs.unlinkSync(path.join(rootDir, 'admission-candidates', `${admitted.candidateId}.json`));

  const reopened = new ReportLibraryStore({ rootDir, now: () => NOW });
  assert.equal(reopened.get(admitted.reportVersionId).processingStatus, 'Pending');
  assert.equal(reopened.readContent(admitted.reportVersionId), reportPackage().report.markdown);
  assert.deepEqual(reopened.list().reports.map((report) => report.reportVersionId), [admitted.reportVersionId]);
  assert.deepEqual(reopened.tickerTimeline('AAPL').reports.map((report) => report.reportVersionId), [admitted.reportVersionId]);
  reopened.reconcile();
  assert.equal(reopened.get(admitted.reportVersionId).lineage.analysisRunId, 'analysis-receiptless-anchor');
  assert.deepEqual(reopened.list().reports.map((report) => report.reportVersionId), [admitted.reportVersionId]);
});

test('public reads fail closed when a stale projection outlives its private Overview pair', async () => {
  const rootDir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'report-admission-stale-projection-'));
  const reportLibrary = new ReportLibraryStore({ rootDir, now: () => NOW });
  const admissionService = new ReportAdmissionService({
    reportLibrary,
    overviewService: new ReportOverviewService({
      reportLibrary,
      agentBackend: { async run(request) { return successfulOverview(request); } },
      now: () => NOW,
    }),
    sleep: async () => {},
  });
  const admitted = await admissionService.admit(reportPackage({ analysisRunId: 'analysis-stale-projection' }));
  fs.rmSync(path.join(rootDir, 'reports', admitted.reportVersionId, 'overview', 'report-overview.json'));

  assert.equal(reportLibrary.get(admitted.reportVersionId), null);
  assert.equal(reportLibrary.readContent(admitted.reportVersionId), null);
  assert.deepEqual(reportLibrary.list().reports, []);
  assert.deepEqual(reportLibrary.tickerTimeline('AAPL').reports, []);
  assert.equal(reportLibrary.status().reportVersionCount, 0);
});
