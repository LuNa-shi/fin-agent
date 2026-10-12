import fs from 'node:fs';

import {
  DailyReportBatchAdmission,
  ReportAdmissionStore,
  ReportAdmissionService,
  ReportLibraryStore,
  ReportOverviewService,
} from '../../src/domains/reports/index.js';

const [rootDir, packageFile, callsFile, resultFile, mode, releaseFile, batchId, itemId] = process.argv.slice(2);

function successfulOverview(request) {
  return {
    status: 'succeeded',
    valid: true,
    output: {
      overview: {
        reportVersionId: request.input.reportVersionId,
        contentDigest: request.input.contentDigest,
        summary: 'Cross-process admission completed.',
        keyThemes: ['Report Library'],
        entities: [],
        materialDevelopments: ['A durable candidate was admitted.'],
        uncertainties: [],
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

async function waitForRelease() {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(releaseFile)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for admission test release');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForReleaseSync() {
  const deadline = Date.now() + 10_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releaseFile)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for admission test release');
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

const packageInput = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const reportLibrary = new ReportLibraryStore({ rootDir });
const backend = {
  async run(request) {
    fs.appendFileSync(callsFile, `${JSON.stringify({
      pid: process.pid,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      nodeId: request.nodeId,
    })}\n`);
    if (mode === 'crash') process.exit(86);
    if (mode === 'pause') {
      fs.writeFileSync(`${resultFile}.ready`, 'ready\n');
      await waitForRelease();
    }
    return successfulOverview(request);
  },
};
const admissionService = new ReportAdmissionService({
  reportLibrary,
  overviewService: new ReportOverviewService({ reportLibrary, agentBackend: backend }),
  maxImmediateAttempts: 1,
  baseRetryDelayMs: 0,
  maxRetryDelayMs: 0,
  sleep: async () => {},
});
const batchAdmission = new DailyReportBatchAdmission({ reportLibrary, admissionService });

if (mode === 'recover-pause-outcome') {
  const recordOutcome = admissionService.batchStore.recordOutcome.bind(admissionService.batchStore);
  admissionService.batchStore.recordOutcome = (...args) => {
    fs.writeFileSync(`${resultFile}.ready`, 'ready\n');
    waitForReleaseSync();
    return recordOutcome(...args);
  };
}

if (mode === 'signal-stage') {
  const stage = admissionService.candidateStore.stage.bind(admissionService.candidateStore);
  admissionService.candidateStore.stage = (...args) => {
    fs.writeFileSync(`${resultFile}.contending`, 'contending\n');
    return stage(...args);
  };
}

if (mode === 'pause-commit-lock') {
  const withCandidateLock = ReportAdmissionStore.prototype.withCandidateLock;
  let candidateLockReads = 0;
  ReportAdmissionStore.prototype.withCandidateLock = function pauseInsideCandidateLock(candidateId, action) {
    return withCandidateLock.call(this, candidateId, (candidate) => {
      candidateLockReads += 1;
      if (candidateLockReads === 2) {
        fs.writeFileSync(`${resultFile}.ready`, 'ready\n');
        waitForReleaseSync();
      }
      return action(candidate);
    });
  };
}

try {
  const value = ['recover', 'recover-pause-outcome'].includes(mode)
    ? await admissionService.recover()
    : await batchAdmission.completeItem({ batchId, itemId, packageInput, source: 'producer' });
  fs.writeFileSync(resultFile, `${JSON.stringify({ ok: true, value })}\n`);
} catch (error) {
  fs.writeFileSync(resultFile, `${JSON.stringify({
    ok: false,
    error: { code: String(error?.code || 'ERROR'), message: String(error?.message || error) },
  })}\n`);
}
