import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-w6-run-service-'));
process.env.FIN_DATA_DIR = dataDir;

const [
  { ProjectSpace },
  { RUN_STATUSES },
  {
    RunAnalysisService,
    verifiedReportPackage,
  },
  {
    openWorkflowRun,
    reserveWorkflowRun,
    retryPolicyForWorkflowNode,
    workflowNodeRetryDelayMs,
  },
  {
    RUN_ANALYSIS_WORKFLOW_SPEC,
    RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  },
] = await Promise.all([
  import('../src/project-space/index.js'),
  import('../src/project-space/RunStore.js'),
  import('../src/workflows/run-analysis/RunAnalysisService.js'),
  import('../src/workflows/run-analysis/policies/runPolicy.js'),
  import('../src/workflows/run-analysis/workflowSpec.js'),
]);

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const WORKFLOW = Object.freeze({
  id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
  version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
  hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
});

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function recordFor(projectId, runId, status = RUN_STATUSES.RUNNING) {
  const nodes = Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node, index) => [
    node.id,
    {
      nodeId: node.id,
      status: index === 0 && status === RUN_STATUSES.RUNNING ? 'RUNNING' : 'PENDING',
      artifactRefs: [],
      attempt: index === 0 && status === RUN_STATUSES.RUNNING ? 1 : 0,
      stopReason: null,
    },
  ]));
  return {
    projectId,
    runId,
    workflowSpec: { ...WORKFLOW },
    status,
    stopReason: status === RUN_STATUSES.BLOCKED ? 'human-review' : null,
    nodes,
  };
}

function fakeProjectSpace(ids = ['proj_a', 'proj_b']) {
  const projects = new Map(ids.map((id) => [id, {
    id,
    title: id,
    status: 'created',
    createdAt: 1,
    updatedAt: 1,
  }]));
  const records = new Map(ids.map((id) => [id, []]));
  const checkpoints = new Map();
  const lineages = new Map();
  const files = new Map();
  const corruptRefs = new Set();
  const stores = new Map(ids.map((id) => [id, {
    list() { return records.get(id); },
    load(runId) { return records.get(id).find((record) => record.runId === runId) || null; },
    cancelRun(runId, reason) {
      const record = this.load(runId);
      record.status = RUN_STATUSES.CANCELLED;
      record.stopReason = reason;
      for (const node of Object.values(record.nodes)) {
        if (['PENDING', 'READY', 'RUNNING'].includes(node.status)) {
          node.status = 'CANCELLED';
          node.stopReason = reason;
        }
      }
      return record;
    },
  }]));

  return {
    projects,
    records,
    stores,
    checkpoints,
    lineages,
    files,
    corruptRefs,
    meta(id) { return projects.get(id) || null; },
    updateMeta(id, patch) {
      const current = projects.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, id, updatedAt: current.updatedAt + 1 };
      projects.set(id, next);
      return next;
    },
    list() { return [...projects.values()]; },
    checkpoint(id) { return checkpoints.get(id) || null; },
    runStore(id) { return stores.get(id); },
    artifactLineage(id, runId) {
      return (lineages.get(id) || []).filter((entry) => entry.runId === runId);
    },
    artifactStore() {
      return {
        read(ref) {
          if (corruptRefs.has(ref.artifactId)) throw new Error('corrupt artifact');
          return files.get(ref.path);
        },
      };
    },
    fileContent(_id, file) { return files.get(file) ?? null; },
  };
}

function fakeReserve(projectSpace) {
  let sequence = 0;
  return (projectId, options = {}) => {
    const existing = projectSpace.records.get(projectId).at(-1);
    const record = options.resume && existing
      ? existing
      : recordFor(projectId, `run_${projectId}_${++sequence}`);
    record.status = RUN_STATUSES.RUNNING;
    record.stopReason = null;
    if (!projectSpace.records.get(projectId).includes(record)) {
      projectSpace.records.get(projectId).push(record);
    }
    projectSpace.updateMeta(projectId, { status: 'queued' });
    return { runStore: projectSpace.runStore(projectId), record };
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function nextTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function installSuccessfulPackage(projectSpace, projectId, record, {
  reportLanguage = 'en',
} = {}) {
  const conclusion = '{"rating":"hold"}';
  const report = '# Verified report';
  const reportSuffix = reportLanguage === 'en' ? '' : `.${reportLanguage}`;
  const conclusionRef = {
    artifactId: `${projectId}:analysis/conclusion.json`,
    version: 1,
    path: 'analysis/conclusion.json',
    contentDigest: digest(conclusion),
  };
  const reportRef = {
    artifactId: `${projectId}:report/report_20260723_120000${reportSuffix}.md`,
    version: 1,
    path: `report/report_20260723_120000${reportSuffix}.md`,
    contentDigest: digest(report),
  };
  record.status = RUN_STATUSES.SUCCEEDED;
  for (const node of Object.values(record.nodes)) node.status = 'SUCCEEDED';
  record.nodes['synthesize-conclusion'].artifactRefs = [conclusionRef];
  record.nodes['finalize-project'].artifactRefs = [reportRef];
  projectSpace.files.set(conclusionRef.path, conclusion);
  projectSpace.files.set(reportRef.path, report);
  projectSpace.lineages.set(projectId, [
    { projectId, runId: record.runId, nodeId: 'synthesize-conclusion', ref: conclusionRef },
    { projectId, runId: record.runId, nodeId: 'finalize-project', ref: reportRef },
  ]);
  projectSpace.updateMeta(projectId, {
    conclusion: JSON.parse(conclusion),
    scenarios: null,
  });
  return { conclusionRef, reportRef };
}

test('queued starts reserve a stable durable run id and concurrent duplicates dedupe', async () => {
  const projectSpace = fakeProjectSpace();
  const gates = new Map([
    ['proj_a', deferred()],
    ['proj_b', deferred()],
  ]);
  const calls = [];
  const runner = async (projectId) => {
    calls.push(projectId);
    await gates.get(projectId).promise;
    const record = projectSpace.records.get(projectId).at(-1);
    record.status = RUN_STATUSES.FAILED;
    record.stopReason = 'fixture-complete';
  };
  const service = new RunAnalysisService({
    projectSpace,
    runner,
    reserveRun: fakeReserve(projectSpace),
    maxConcurrent: 1,
    logger: { error() {} },
  });

  const first = service.start('proj_a');
  const queued = service.start('proj_b');
  const duplicate = service.start('proj_b');

  assert.equal(first.started, true);
  assert.equal(first.status, 'analyzing');
  assert.match(first.runId, /^run_proj_a_/u);
  assert.equal(queued.started, true);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuePosition, 1);
  assert.match(queued.runId, /^run_proj_b_/u);
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'already-running');
  assert.equal(duplicate.runId, queued.runId);
  assert.deepEqual(calls, []);

  await nextTurn();
  assert.deepEqual(calls, ['proj_a']);
  gates.get('proj_a').resolve();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(calls, ['proj_a', 'proj_b']);
  assert.equal(service.status('proj_b').runId, queued.runId);
  gates.get('proj_b').resolve();
  await nextTurn();
});

test('service projects the complete truthful Project and durable-run status matrix', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {},
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });
  assert.equal(service.status('proj_a').projectStatus, 'created');

  const record = recordFor('proj_a', 'run_matrix');
  projectSpace.records.get('proj_a').push(record);
  assert.equal(service.status('proj_a').projectStatus, 'failed');
  assert.equal(service.status('proj_a').resumable, true);
  assert.equal(service.status('proj_a').currentNodeId, 'initialize-checkpoint');

  record.status = RUN_STATUSES.FAILED;
  record.stopReason = 'business-error';
  record.nodes['initialize-checkpoint'].status = 'FAILED_BUSINESS';
  assert.equal(service.status('proj_a').projectStatus, 'failed');

  record.status = RUN_STATUSES.BLOCKED;
  record.stopReason = 'human-review';
  record.nodes['initialize-checkpoint'].status = 'BLOCKED';
  assert.equal(service.status('proj_a').projectStatus, 'failed');

  record.status = RUN_STATUSES.CANCELLED;
  record.stopReason = 'operator-cancelled';
  record.nodes['initialize-checkpoint'].status = 'CANCELLED';
  assert.equal(service.status('proj_a').projectStatus, 'cancelled');
  projectSpace.updateMeta('proj_a', { status: 'paused' });
  assert.equal(service.status('proj_a').projectStatus, 'paused');

  projectSpace.updateMeta('proj_a', { status: 'analyzed' });
  installSuccessfulPackage(projectSpace, 'proj_a', record);
  const analyzed = service.status('proj_a');
  assert.equal(analyzed.projectStatus, 'analyzed');
  assert.equal(analyzed.reportReady, true);
  assert.equal(analyzed.runStatus, RUN_STATUSES.SUCCEEDED);

  record.nodes['synthesize-conclusion'].artifactRefs = [];
  const invalid = service.status('proj_a');
  assert.equal(invalid.projectStatus, 'failed');
  assert.equal(invalid.reportReady, false);
});

test('verified report package rejects placeholder, missing lineage, and tampered files', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_report', RUN_STATUSES.SUCCEEDED);
  projectSpace.records.get('proj_a').push(record);

  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);
  const { reportRef } = installSuccessfulPackage(projectSpace, 'proj_a', record);
  assert.equal(
    verifiedReportPackage('proj_a', record, { projectSpace })?.reportPath,
    reportRef.path,
  );

  projectSpace.lineages.set('proj_a', []);
  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);

  installSuccessfulPackage(projectSpace, 'proj_a', record);
  projectSpace.files.set(reportRef.path, '# Tampered');
  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);

  installSuccessfulPackage(projectSpace, 'proj_a', record);
  projectSpace.corruptRefs.add(reportRef.artifactId);
  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);

  projectSpace.corruptRefs.clear();
  installSuccessfulPackage(projectSpace, 'proj_a', record);
  const lineage = projectSpace.lineages.get('proj_a');
  lineage[1] = {
    ...lineage[1],
    ref: { ...lineage[1].ref, producer: 'different-producer' },
  };
  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);

  projectSpace.corruptRefs.clear();
  const auto = installSuccessfulPackage(projectSpace, 'proj_a', record, {
    reportLanguage: 'auto',
  });
  assert.equal(
    verifiedReportPackage('proj_a', record, { projectSpace })?.reportPath,
    auto.reportRef.path,
  );

  projectSpace.updateMeta('proj_a', {
    conclusion: { rating: 'buy', stocks: [{ ticker: 'WRONG' }] },
  });
  assert.equal(verifiedReportPackage('proj_a', record, { projectSpace }), null);
});

test('Run Analysis workflow gives transient Agent nodes four retries', () => {
  const byId = Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => [node.id, node]));

  assert.deepEqual(retryPolicyForWorkflowNode(byId['initialize-checkpoint']), {
    maxAttempts: 1,
    retryOn: [],
  });
  assert.deepEqual(retryPolicyForWorkflowNode(byId['run-research-rounds']), {
    maxAttempts: 5,
    retryOn: ['transient', 'provider-unavailable'],
  });
  assert.deepEqual(retryPolicyForWorkflowNode(byId['compose-report']), {
    maxAttempts: 5,
    retryOn: ['transient', 'provider-unavailable'],
  });
});

test('Run Analysis workflow retry backoff is bounded and configurable', () => {
  assert.equal(workflowNodeRetryDelayMs(1, { env: {} }), 10_000);
  assert.equal(workflowNodeRetryDelayMs(2, { env: {} }), 30_000);
  assert.equal(workflowNodeRetryDelayMs(4, { env: {} }), 180_000);
  assert.equal(workflowNodeRetryDelayMs(9, { env: {} }), 180_000);
  assert.equal(workflowNodeRetryDelayMs(2, {
    env: { RUN_ANALYSIS_TRANSIENT_RETRY_BACKOFF_MS: '0,250,999999' },
  }), 250);
  assert.equal(workflowNodeRetryDelayMs(3, {
    env: { RUN_ANALYSIS_TRANSIENT_RETRY_BACKOFF_MS: '0,250,999999' },
  }), 300_000);
});

test('BLOCKED review can be replaced by fresh analysis when Human Review is disabled', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const blocked = recordFor('proj_a', 'run_blocked', RUN_STATUSES.BLOCKED);
  projectSpace.records.get('proj_a').push(blocked);
  let reserveCalls = 0;
  let runnerCalls = 0;
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => { runnerCalls += 1; },
    reserveRun: (...args) => {
      reserveCalls += 1;
      return fakeReserve(projectSpace)(...args);
    },
    logger: { error() {} },
  });

  const fresh = service.start('proj_a', { resume: false });
  assert.equal(fresh.started, true);
  assert.equal(fresh.mode, 'fresh');
  assert.notEqual(fresh.runId, blocked.runId);
  assert.equal(fresh.projectStatus, 'analyzing');
  assert.equal(reserveCalls, 1);
  await nextTurn();
  assert.equal(runnerCalls, 1);
  await nextTurn();
});

test('reviewed resume enqueues only an exact durable Human Review transition', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_reviewed');
  record.humanReviewHistory = [{
    kind: 'resume',
    decisionId: 'hrd_reviewed',
    humanReviewAttempt: 1,
    reviewRound: 4,
  }];
  projectSpace.records.get('proj_a').push(record);
  projectSpace.checkpoints.set('proj_a', {
    artifactRunId: record.runId,
    done: false,
    activeRemediation: {
      kind: 'human-review',
      decisionId: 'hrd_reviewed',
      humanReviewAttempt: 1,
      reviewRound: 4,
    },
  });
  const gate = deferred();
  let runnerCalls = 0;
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {
      runnerCalls += 1;
      await gate.promise;
      record.status = RUN_STATUSES.FAILED;
      record.stopReason = 'fixture-complete';
    },
    reserveRun() {
      throw new Error('reviewed resume must not reserve or prepare a generic run');
    },
    logger: { error() {} },
  });

  assert.throws(
    () => service.resumeReviewed('proj_a', {
      runId: record.runId,
      decisionId: 'hrd_wrong',
      humanReviewAttempt: 1,
      reviewRound: 4,
    }),
    (error) => error?.code === 'REVIEWED_RESUME_NOT_AUTHORIZED',
  );
  const started = service.resumeReviewed('proj_a', {
    runId: record.runId,
    decisionId: 'hrd_reviewed',
    humanReviewAttempt: 1,
    reviewRound: 4,
  });
  assert.equal(started.started, true);
  assert.equal(started.mode, 'human-review-resume');
  assert.equal(started.runId, record.runId);
  const replay = service.resumeReviewed('proj_a', {
    runId: record.runId,
    decisionId: 'hrd_reviewed',
    humanReviewAttempt: 1,
    reviewRound: 4,
  });
  assert.equal(replay.started, false);
  assert.equal(replay.reason, 'already-running');
  await nextTurn();
  assert.equal(runnerCalls, 1);
  gate.resolve();
  await nextTurn();
  await nextTurn();
});

test('human-review termination is never projected or recovered as resumable', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_terminated', RUN_STATUSES.CANCELLED);
  record.stopReason = 'human-review-terminated';
  projectSpace.records.get('proj_a').push(record);
  projectSpace.checkpoints.set('proj_a', { artifactRunId: record.runId, done: false });
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {},
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  assert.equal(service.status('proj_a').resumable, false);
  assert.throws(
    () => service.resume('proj_a'),
    (error) => error?.code === 'RUN_NOT_RESUMABLE',
  );
  assert.deepEqual(service.recoverInterrupted(), []);
});

test('queued and running pause retain resumable durable cancellation truth', async () => {
  const projectSpace = fakeProjectSpace();
  const gates = new Map([
    ['proj_a', deferred()],
    ['proj_b', deferred()],
  ]);
  const runner = async (projectId, options) => {
    await gates.get(projectId).promise;
    if (options.cancelled()) {
      throw new Error('analysis paused or cancelled');
    }
  };
  const service = new RunAnalysisService({
    projectSpace,
    runner,
    reserveRun: fakeReserve(projectSpace),
    maxConcurrent: 1,
    logger: { error() {} },
  });
  service.start('proj_a');
  service.start('proj_b');

  const queuedPause = service.pause('proj_b');
  assert.equal(queuedPause.projectStatus, 'paused');
  assert.equal(queuedPause.removedQueued, true);
  assert.equal(projectSpace.records.get('proj_b').at(-1).status, RUN_STATUSES.CANCELLED);

  const runningPause = service.pause('proj_a');
  assert.equal(runningPause.projectStatus, 'paused');
  assert.equal(runningPause.running, true);
  gates.get('proj_a').resolve();
  await nextTurn();
  await nextTurn();
  assert.equal(service.status('proj_a').projectStatus, 'paused');
  assert.equal(
    projectSpace.records.get('proj_a').at(-1).stopReason,
    'operator-paused',
  );
});

test('cooperative operator cancellation preserves its durable terminal reason', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const gate = deferred();
  const service = new RunAnalysisService({
    projectSpace,
    runner: async (_projectId, options) => {
      await gate.promise;
      if (options.cancelled()) throw new Error('analysis paused or cancelled');
    },
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  service.start('proj_a');
  await nextTurn();
  assert.equal(service.cancel('proj_a').projectStatus, 'cancelled');
  gate.resolve();
  await nextTurn();
  await nextTurn();

  const record = projectSpace.records.get('proj_a').at(-1);
  assert.equal(record.status, RUN_STATUSES.CANCELLED);
  assert.equal(record.stopReason, 'operator-cancelled');
  assert.equal(service.status('proj_a').projectStatus, 'cancelled');
});

test('durable terminal truth wins a late cooperative pause request', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const gate = deferred();
  const runner = async (projectId) => {
    await gate.promise;
    installSuccessfulPackage(
      projectSpace,
      projectId,
      projectSpace.records.get(projectId).at(-1),
    );
  };
  const service = new RunAnalysisService({
    projectSpace,
    runner,
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  service.start('proj_a');
  await nextTurn();
  assert.equal(service.pause('proj_a').projectStatus, 'paused');
  gate.resolve();
  await nextTurn();
  await nextTurn();

  assert.equal(service.status('proj_a').projectStatus, 'analyzed');
  assert.equal(projectSpace.meta('proj_a').status, 'analyzed');
});

test('historical run queries keep current Project status and queue truth separate', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const historical = recordFor('proj_a', 'run_historical', RUN_STATUSES.SUCCEEDED);
  projectSpace.records.get('proj_a').push(historical);
  installSuccessfulPackage(projectSpace, 'proj_a', historical);
  projectSpace.updateMeta('proj_a', { status: 'analyzed' });
  const gate = deferred();
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => gate.promise,
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  const started = service.start('proj_a', { resume: false });
  const historicalStatus = service.status('proj_a', { runId: historical.runId });

  assert.equal(historicalStatus.projectStatus, 'analyzing');
  assert.equal(historicalStatus.reportReady, false);
  assert.equal(historicalStatus.currentRunId, started.runId);
  assert.equal(historicalStatus.runId, historical.runId);
  assert.equal(historicalStatus.run.status, RUN_STATUSES.SUCCEEDED);
  assert.equal(historicalStatus.run.reportReady, true);
  gate.resolve();
  await nextTurn();
});

test('historical run queries keep a current resuming Human Review projected as review-required', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const historical = recordFor('proj_a', 'run_historical_review', RUN_STATUSES.SUCCEEDED);
  projectSpace.records.get('proj_a').push(historical);
  installSuccessfulPackage(projectSpace, 'proj_a', historical);
  const current = recordFor('proj_a', 'run_current_review');
  projectSpace.records.get('proj_a').push(current);
  projectSpace.updateMeta('proj_a', { status: 'analyzing' });
  const reviewTask = {
    taskId: 'hrt_current_review',
    projectId: 'proj_a',
    runId: current.runId,
    status: 'resuming',
    decision: { decisionId: 'hrd_current_review' },
    resume: {
      humanReviewAttempt: 1,
      reviewRound: 4,
    },
  };
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {},
    reserveRun: fakeReserve(projectSpace),
    humanReviewController: {
      open(projectId) {
        assert.equal(projectId, 'proj_a');
        return reviewTask;
      },
    },
    logger: { error() {} },
  });

  const status = service.status('proj_a', { runId: historical.runId });

  assert.equal(status.projectStatus, 'review-required');
  assert.equal(status.status, 'review-required');
  assert.equal(status.currentRunId, current.runId);
  assert.equal(status.runId, historical.runId);
  assert.equal(status.run.status, RUN_STATUSES.SUCCEEDED);
  assert.equal(status.run.reportReady, true);
  assert.equal(status.reportReady, false);
  assert.equal(status.reviewTask, reviewTask);
});

test('pause is a no-op once durable terminal truth exists', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_complete', RUN_STATUSES.SUCCEEDED);
  projectSpace.records.get('proj_a').push(record);
  installSuccessfulPackage(projectSpace, 'proj_a', record);
  projectSpace.updateMeta('proj_a', { status: 'analyzed' });
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {},
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  const paused = service.pause('proj_a');
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'not-active');
  assert.equal(paused.projectStatus, 'analyzed');
  assert.equal(projectSpace.meta('proj_a').status, 'analyzed');
  assert.equal(record.status, RUN_STATUSES.SUCCEEDED);
});

test('startup recovery re-enqueues a durable resuming Human Review with the same identity', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_review_recovery');
  const identity = {
    runId: record.runId,
    decisionId: 'hrd_review_recovery',
    humanReviewAttempt: 2,
    reviewRound: 5,
  };
  record.humanReviewHistory = [{
    kind: 'resume',
    decisionId: identity.decisionId,
    humanReviewAttempt: identity.humanReviewAttempt,
    reviewRound: identity.reviewRound,
  }];
  projectSpace.records.get('proj_a').push(record);
  projectSpace.checkpoints.set('proj_a', {
    artifactRunId: record.runId,
    done: false,
    activeRemediation: {
      kind: 'human-review',
      decisionId: identity.decisionId,
      humanReviewAttempt: identity.humanReviewAttempt,
      reviewRound: identity.reviewRound,
    },
  });
  projectSpace.updateMeta('proj_a', { status: 'analyzing' });
  const reviewTask = {
    taskId: 'hrt_review_recovery',
    projectId: 'proj_a',
    runId: record.runId,
    status: 'resuming',
    decision: { decisionId: identity.decisionId },
    resume: {
      humanReviewAttempt: identity.humanReviewAttempt,
      reviewRound: identity.reviewRound,
    },
  };
  const gate = deferred();
  const runnerCalls = [];
  let reserveCalls = 0;
  const service = new RunAnalysisService({
    projectSpace,
    runner: async (projectId, options) => {
      runnerCalls.push({ projectId, preparedRunId: options.preparedRunId });
      await gate.promise;
      record.status = RUN_STATUSES.FAILED;
      record.stopReason = 'fixture-complete';
    },
    reserveRun() {
      reserveCalls += 1;
      throw new Error('Human Review recovery must not reserve a new run');
    },
    humanReviewController: {
      open(projectId) {
        assert.equal(projectId, 'proj_a');
        return reviewTask;
      },
    },
    logger: { error() {} },
  });
  const resumedIdentities = [];
  const resumeReviewed = service.resumeReviewed.bind(service);
  service.resumeReviewed = (projectId, resumeIdentity) => {
    resumedIdentities.push({ projectId, identity: { ...resumeIdentity } });
    return resumeReviewed(projectId, resumeIdentity);
  };
  const historyBefore = JSON.stringify(record.humanReviewHistory);
  const checkpointBefore = JSON.stringify(projectSpace.checkpoints.get('proj_a'));

  const outcomes = service.recoverInterrupted();

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].projectId, 'proj_a');
  assert.equal(outcomes[0].runId, record.runId);
  assert.equal(outcomes[0].recovered, true);
  assert.equal(outcomes[0].result.started, true);
  assert.equal(outcomes[0].result.mode, 'human-review-resume');
  assert.deepEqual(resumedIdentities, [{ projectId: 'proj_a', identity }]);
  assert.equal(reserveCalls, 0);
  assert.equal(JSON.stringify(record.humanReviewHistory), historyBefore);
  assert.equal(JSON.stringify(projectSpace.checkpoints.get('proj_a')), checkpointBefore);

  await nextTurn();
  assert.deepEqual(runnerCalls, [{
    projectId: 'proj_a',
    preparedRunId: record.runId,
  }]);
  gate.resolve();
  await nextTurn();
  await nextTurn();
});

test('startup recovery skips operator terminals and isolates a corrupt Project', async () => {
  const projectSpace = fakeProjectSpace();
  const operatorCancelled = recordFor('proj_a', 'run_operator', RUN_STATUSES.CANCELLED);
  operatorCancelled.stopReason = 'operator-cancelled';
  projectSpace.records.get('proj_a').push(operatorCancelled);
  projectSpace.updateMeta('proj_a', { status: 'analyzing' });

  const serviceError = recordFor('proj_b', 'run_service', RUN_STATUSES.CANCELLED);
  serviceError.stopReason = 'service-error';
  projectSpace.records.get('proj_b').push(serviceError);
  projectSpace.updateMeta('proj_b', { status: 'failed' });
  const gate = deferred();
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => gate.promise,
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  let listCalls = 0;
  const originalList = projectSpace.stores.get('proj_a').list;
  projectSpace.stores.get('proj_a').list = function corruptOnce() {
    listCalls += 1;
    if (listCalls === 1) throw new Error('corrupt run record');
    return originalList.call(this);
  };
  const outcomes = service.recoverInterrupted();

  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((outcome) => outcome.projectId), ['proj_a', 'proj_b']);
  assert.equal(outcomes[0].recovered, false);
  assert.equal(outcomes[0].error.code, 'RUN_RECOVERY_FAILED');
  assert.equal(outcomes[1].recovered, true);
  assert.equal(outcomes[1].result.mode, 'resume');
  gate.resolve();
  await nextTurn();
});

test('startup recovery never reopens an operator-cancelled run', () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const record = recordFor('proj_a', 'run_cancelled', RUN_STATUSES.CANCELLED);
  record.stopReason = 'operator-cancelled';
  projectSpace.records.get('proj_a').push(record);
  projectSpace.updateMeta('proj_a', { status: 'cancelled' });
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {
      throw new Error('runner must not be called');
    },
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  assert.deepEqual(service.recoverInterrupted(), []);
  assert.equal(record.status, RUN_STATUSES.CANCELLED);
});

test('missing durable truth after runner settlement fails the Project', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const service = new RunAnalysisService({
    projectSpace,
    runner: async (projectId) => {
      projectSpace.records.set(projectId, []);
    },
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  service.start('proj_a');
  await nextTurn();
  await nextTurn();
  assert.equal(projectSpace.meta('proj_a').status, 'failed');
  assert.match(projectSpace.meta('proj_a').lastError, /durable run record missing/u);
});

test('a runner that settles without terminal durable truth fails closed', async () => {
  const projectSpace = fakeProjectSpace(['proj_a']);
  const service = new RunAnalysisService({
    projectSpace,
    runner: async () => {},
    reserveRun: fakeReserve(projectSpace),
    logger: { error() {} },
  });

  service.start('proj_a');
  await nextTurn();
  await nextTurn();
  const record = projectSpace.records.get('proj_a').at(-1);
  assert.equal(record.status, RUN_STATUSES.CANCELLED);
  assert.equal(record.stopReason, 'service-runner-returned-nonterminal');
  assert.equal(service.status('proj_a').projectStatus, 'failed');
  assert.match(projectSpace.meta('proj_a').lastError, /service-runner-returned-nonterminal/u);
});

test('real reservation returns the same prepared run without a second resume transition', () => {
  const project = ProjectSpace.create({
    title: 'Prepared Run',
    theme: 'service',
    rationale: 'verify queue reservation',
    tickers: ['TEST'],
  });
  const reserved = reserveWorkflowRun(project.id, {
    resume: false,
    asOf: '2026-07-23T12:00:00.000Z',
  });
  assert.equal(ProjectSpace.meta(project.id).status, 'queued');
  assert.equal(reserved.record.resumeCount, 0);

  const opened = openWorkflowRun(project.id, {
    resume: false,
    preparedRunId: reserved.record.runId,
  });
  assert.equal(opened.record.runId, reserved.record.runId);
  assert.equal(opened.record.resumeCount, 0);
  assert.equal(ProjectSpace.meta(project.id).status, 'analyzing');
});

test('direct resume cannot bypass a newer human-review run', () => {
  const project = ProjectSpace.create({
    title: 'Blocked Authority',
    theme: 'service',
    rationale: 'latest durable run must remain authoritative',
    tickers: ['TEST'],
  });
  const first = reserveWorkflowRun(project.id, {
    resume: false,
    asOf: '2026-07-23T12:00:00.000Z',
  });
  ProjectSpace.runStore(project.id).cancelRun(first.record.runId, 'older-cancelled');
  const latest = reserveWorkflowRun(project.id, {
    resume: false,
    asOf: '2026-07-23T13:00:00.000Z',
  });
  ProjectSpace.runStore(project.id).blockRun(latest.record.runId, {
    reason: 'human-review',
  });

  assert.throws(
    () => openWorkflowRun(project.id, { resume: true }),
    (error) => error?.code === 'RUN_REVIEW_REQUIRED',
  );
  assert.equal(
    ProjectSpace.runStore(project.id).load(first.record.runId).status,
    RUN_STATUSES.CANCELLED,
  );
  assert.equal(
    ProjectSpace.runStore(project.id).load(latest.record.runId).status,
    RUN_STATUSES.BLOCKED,
  );
});

test('prepared execution is bound to its reserved inputs', () => {
  const project = ProjectSpace.create({
    title: 'Prepared Input Binding',
    theme: 'service',
    rationale: 'durable input digest must match execution options',
    tickers: ['TEST'],
  });
  const reserved = reserveWorkflowRun(project.id, {
    resume: false,
    intensity: 'quick',
    asOf: '2026-07-23T12:00:00.000Z',
  });

  assert.throws(
    () => openWorkflowRun(project.id, {
      resume: false,
      preparedRunId: reserved.record.runId,
      intensity: 'deep',
      asOf: '2026-07-23T12:00:00.000Z',
    }),
    (error) => error?.code === 'PREPARED_RUN_INPUT_CONFLICT',
  );
  assert.equal(
    ProjectSpace.runStore(project.id).load(reserved.record.runId).status,
    RUN_STATUSES.RUNNING,
  );
});

test('timestamped report naming accepts supported auto language and rejects unsafe tokens', () => {
  const project = ProjectSpace.create({
    title: 'Report Language Contract',
    theme: 'service',
    rationale: 'report publication path must match supported language values',
    tickers: ['TEST'],
  });
  const report = ProjectSpace.setTimestampedReport(project.id, '# Auto report', {
    language: 'auto',
    ts: Date.UTC(2026, 6, 23, 12, 0, 0),
  });

  assert.match(report.path, /^report\/report_\d{8}_\d{6}\.auto\.md$/u);
  assert.equal(
    ProjectSpace.reportVersions(project.id).some((entry) => entry.path === report.path),
    true,
  );
  assert.throws(
    () => ProjectSpace.setTimestampedReport(project.id, '# Unsafe', {
      language: '../zh',
    }),
    (error) => error?.code === 'UNSAFE_PROJECT_PATH',
  );
});
