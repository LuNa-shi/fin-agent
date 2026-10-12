import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-event-bus-'));
process.env.FIN_DATA_DIR = dataDir;

const { NODE_STATES } = await import('../src/core/workflow/NodeState.js');
const { FileArtifactStore } = await import('../src/project-space/ArtifactStore.js');
const {
  DURABLE_EVENT_TYPES,
  EVENT_BUS_SCOPE,
  FileEventBus,
} = await import('../src/project-space/EventBus.js');
const { ProjectSpace } = await import('../src/project-space/ProjectSpace.js');
const { FileRunStore, RUN_STATUSES } = await import('../src/project-space/RunStore.js');

const digest = (char) => `sha256:${char.repeat(64)}`;
const workflowSpec = Object.freeze({ id: 'run-analysis.v1', version: '1.0.0', hash: digest('a') });

function runStarted(eventId, runId) {
  return {
    eventId,
    eventType: DURABLE_EVENT_TYPES.RUN_STARTED,
    correlationId: runId,
    causationId: null,
    runId,
    nodeId: null,
    payload: {
      status: RUN_STATUSES.RUNNING,
      workflowSpec,
      inputDigest: digest('b'),
      asOf: '2026-07-16T00:00:00.000Z',
    },
  };
}

function projectsFixture(t) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-event-projects-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  return projectsDir;
}

test('FileEventBus requires typed payloads, explicit root causation, and idempotent event identity', (t) => {
  const projectsDir = projectsFixture(t);
  const bus = new FileEventBus({ projectId: 'proj_events', projectsDir });
  const input = runStarted('evt-root', 'run-events');
  const first = bus.publish(input);
  const replay = bus.publish(input);

  assert.equal(FileEventBus.scope, EVENT_BUS_SCOPE);
  assert.deepEqual(replay, first);
  assert.equal(bus.list().length, 1);
  assert.throws(
    () => bus.publish({ ...input, payload: { ...input.payload, inputDigest: digest('c') } }),
    /idempotency conflict/u,
  );
  assert.throws(
    () => bus.publish({ ...runStarted('evt-invalid-digest', 'run-invalid'), payload: { ...input.payload, inputDigest: null } }),
    /inputDigest/u,
  );
  const missingCausation = { ...runStarted('evt-missing-cause', 'run-missing') };
  delete missingCausation.causationId;
  assert.throws(() => bus.publish(missingCausation), /causationId/u);
  assert.throws(
    () => bus.publish({ ...runStarted('evt-bad-payload', 'run-bad'), payload: { status: 'RUNNING' } }),
    /payload requires/u,
  );
  assert.throws(
    () => bus.publish({
      ...runStarted('evt-child', 'run-events'),
      eventType: DURABLE_EVENT_TYPES.RUN_RESUMED,
      causationId: 'evt-does-not-exist',
      payload: { status: 'RUNNING', reason: 'retry', resumeCount: 1 },
    }),
    /causation is missing/u,
  );
});

test('FileEventBus allocates unique contiguous sequences across concurrent processes', async (t) => {
  const projectsDir = projectsFixture(t);
  const projectId = 'proj_event_concurrent';
  const moduleUrl = pathToFileURL(path.resolve('src/project-space/EventBus.js')).href;
  const startAt = Date.now() + 400;
  const workers = 16;
  const code = `
    import { DURABLE_EVENT_TYPES, FileEventBus } from ${JSON.stringify(moduleUrl)};
    const [projectsDir, projectId, indexText, startText] = process.argv.slice(1);
    const index = Number(indexText);
    const startAt = Number(startText);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < startAt) Atomics.wait(waiter, 0, 0, Math.min(10, startAt - Date.now()));
    const runId = 'run-' + index;
    new FileEventBus({ projectId, projectsDir }).publish({
      eventId: 'evt-worker-' + index,
      eventType: DURABLE_EVENT_TYPES.RUN_STARTED,
      correlationId: runId,
      causationId: null,
      runId,
      nodeId: null,
      payload: {
        status: 'RUNNING',
        workflowSpec: { id: 'run-analysis.v1', version: '1.0.0', hash: 'sha256:' + 'a'.repeat(64) },
        inputDigest: 'sha256:' + 'b'.repeat(64),
        asOf: '2026-07-16T00:00:00.000Z',
      },
    });
  `;
  const runWorker = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, projectsDir, projectId, String(index), String(startAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`worker ${index} failed (${exitCode}): ${stderr}`));
    });
  });
  await Promise.all(Array.from({ length: workers }, (_, index) => runWorker(index)));

  const events = new FileEventBus({ projectId, projectsDir }).list();
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: workers }, (_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.eventId)).size, workers);
  assert.equal(fs.readdirSync(path.join(projectsDir, projectId, '.events', 'outbox')).length, workers);
});

test('FileEventBus readers wait for atomic outbox writers instead of observing temp files', async (t) => {
  const projectsDir = projectsFixture(t);
  const projectId = 'proj_event_reader_lock';
  const bus = new FileEventBus({ projectId, projectsDir });
  bus.publish(runStarted('evt-reader-lock', 'run-reader-lock'));
  const fileLockUrl = pathToFileURL(path.resolve('src/lib/fileLock.js')).href;
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { withFileLockSync } from ${JSON.stringify(fileLockUrl)};
    const [lockPath, outboxDir] = process.argv.slice(1);
    withFileLockSync(lockPath, () => {
      const temp = path.join(outboxDir, '000000000002.json.' + process.pid + '.1.tmp');
      fs.writeFileSync(temp, '{}');
      process.stdout.write('ready\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      fs.rmSync(temp);
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, bus.outboxLockPath, bus.outboxDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`reader-lock worker failed (${exitCode}): ${stderr}`));
    });
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  assert.deepEqual(bus.list().map((event) => event.eventId), ['evt-reader-lock']);
  await exitPromise;
});

test('FileEventBus keeps projects isolated and rejects corrupt or gapped outboxes', (t) => {
  const projectsDir = projectsFixture(t);
  const first = new FileEventBus({ projectId: 'proj_one', projectsDir });
  const second = new FileEventBus({ projectId: 'proj_two', projectsDir });
  first.publish(runStarted('evt-one', 'run-one'));
  second.publish(runStarted('evt-two', 'run-two'));
  assert.deepEqual(first.list().map((event) => event.projectId), ['proj_one']);
  assert.deepEqual(second.list().map((event) => event.projectId), ['proj_two']);

  first.publish(runStarted('evt-one-b', 'run-one-b'));
  fs.rmSync(path.join(first.outboxDir, '000000000001.json'));
  assert.throws(() => first.list(), /sequence gap/u);

  const corrupt = new FileEventBus({ projectId: 'proj_corrupt', projectsDir });
  corrupt.publish(runStarted('evt-corrupt', 'run-corrupt'));
  fs.writeFileSync(path.join(corrupt.outboxDir, '000000000001.json'), '{not-json');
  assert.throws(() => corrupt.replay(), /unreadable/u);
});

test('FileEventBus supports a scoped direct storage root and rejects hidden-root symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-scoped-event-bus-'));
  const storageDir = path.join(root, 'idea-run-1');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(outside);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scopeId = 'idea-universe:local-user';
  const snapshotId = 'idea-run-input-snapshot:'.concat('4'.repeat(64));
  const bus = new FileEventBus({ projectId: scopeId, storageDir });
  const event = bus.publish({
    ...runStarted('evt-idea-run', 'idea-run-1'),
    payload: {
      ...runStarted('unused', 'idea-run-1').payload,
      scope: { kind: 'idea-universe', id: scopeId },
      workspaceMode: 'idea-run',
      workspaceSnapshotId: snapshotId,
    },
  });

  assert.equal(event.projectId, scopeId);
  assert.equal(fs.existsSync(path.join(storageDir, '.events', 'outbox', '000000000001.json')), true);
  assert.deepEqual(bus.replay({ runId: 'idea-run-1' }).runs['idea-run-1'].scope, {
    kind: 'idea-universe',
    id: scopeId,
  });
  assert.throws(
    () => bus.publish({
      ...runStarted('evt-wrong-scope', 'idea-run-2'),
      payload: {
        ...runStarted('unused', 'idea-run-2').payload,
        scope: { kind: 'idea-universe', id: 'idea-universe:someone-else' },
        workspaceMode: 'idea-run',
        workspaceSnapshotId: snapshotId,
      },
    }),
    /scope\.id must match projectId/u,
  );

  const hostileDir = path.join(root, 'hostile-run');
  fs.mkdirSync(hostileDir);
  fs.symlinkSync(outside, path.join(hostileDir, '.events'));
  const hostile = new FileEventBus({ projectId: scopeId, storageDir: hostileDir });
  assert.throws(
    () => hostile.publish(runStarted('evt-hostile', 'hostile-run')),
    /must not be a symlink/u,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('RunStore and ArtifactStore publish replayable run, node, and artifact lineage', (t) => {
  const projectsDir = projectsFixture(t);
  const projectId = 'proj_replay';
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 6, 16, 0, 0, tick++)).toISOString();
  const eventBus = new FileEventBus({ projectId, projectsDir, now });
  const runStore = new FileRunStore({ projectId, projectsDir, now, eventBus });
  const artifactStore = new FileArtifactStore({ projectId, projectsDir, eventBus });
  const runId = 'run-replay';
  const run = runStore.begin({
    runId,
    workflowSpec,
    inputDigest: digest('b'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['produce'],
  });
  runStore.markReady(runId, 'produce');
  runStore.startNode(runId, 'produce', digest('c'));
  const sourceRef = artifactStore.commit({
    runId,
    nodeId: 'produce',
    idempotencyKey: 'source-1',
    artifactId: 'evidence.source',
    path: 'data/source.json',
    schemaVersion: 'evidence-source.v1',
    producer: 'produce',
    contractVersion: '1.0.0',
    inputDigest: digest('c'),
    asOf: run.asOf,
    content: { value: 40 },
    inputArtifactRefs: [],
  });
  const ref = artifactStore.commit({
    runId,
    nodeId: 'produce',
    idempotencyKey: 'produce-1',
    artifactId: 'analysis.result',
    path: 'analysis/result.json',
    schemaVersion: 'analysis-result.v1',
    producer: 'produce',
    contractVersion: '1.0.0',
    inputDigest: digest('c'),
    asOf: run.asOf,
    content: { result: 42 },
    inputArtifactRefs: [sourceRef],
  });
  runStore.succeedNode(runId, 'produce', { artifactRefs: [sourceRef, ref], output: { result: 42 } });
  runStore.completeRun(runId);

  const beforeReplayCount = eventBus.list().length;
  artifactStore.commit({
    runId,
    nodeId: 'produce',
    idempotencyKey: 'produce-1',
    artifactId: 'analysis.result',
    path: 'analysis/result.json',
    schemaVersion: 'analysis-result.v1',
    producer: 'produce',
    contractVersion: '1.0.0',
    inputDigest: digest('c'),
    asOf: run.asOf,
    content: { result: 42 },
    inputArtifactRefs: [sourceRef],
  });
  runStore.succeedNode(runId, 'produce', { artifactRefs: [sourceRef, ref], output: { result: 42 } });
  runStore.completeRun(runId);
  assert.equal(eventBus.list().length, beforeReplayCount, 'idempotent writes must not duplicate outbox events');

  const replay = eventBus.replay({ runId });
  assert.equal(replay.runs[runId].status, RUN_STATUSES.SUCCEEDED);
  assert.equal(replay.runs[runId].nodes.produce.status, NODE_STATES.SUCCEEDED);
  assert.equal(replay.runs[runId].nodes.produce.attempt, 1);
  assert.deepEqual(replay.runs[runId].nodes.produce.artifactRefs, [sourceRef, ref]);
  assert.deepEqual(replay.artifactLineage.map((entry) => entry.ref), [sourceRef, ref]);
  assert.deepEqual(replay.artifactLineage[1].inputArtifactRefs, [sourceRef]);
  assert.deepEqual(eventBus.list().map((event) => event.eventType), [
    DURABLE_EVENT_TYPES.RUN_STARTED,
    DURABLE_EVENT_TYPES.NODE_READY,
    DURABLE_EVENT_TYPES.NODE_STARTED,
    DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED,
    DURABLE_EVENT_TYPES.ARTIFACT_COMMITTED,
    DURABLE_EVENT_TYPES.NODE_SUCCEEDED,
    DURABLE_EVENT_TYPES.RUN_SUCCEEDED,
  ]);
  assert.equal(eventBus.list().slice(1).every((event) => event.causationId !== null), true);
});

test('RunStore interruption and cancellation replay explicit resumed and terminal lifecycle', (t) => {
  const projectsDir = projectsFixture(t);
  const projectId = 'proj_resume_cancel';
  const eventBus = new FileEventBus({ projectId, projectsDir });
  const runStore = new FileRunStore({ projectId, projectsDir, eventBus });
  const runId = 'run-resume-cancel';
  runStore.begin({
    runId,
    workflowSpec,
    inputDigest: digest('d'),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: ['interrupted'],
  });
  runStore.markReady(runId, 'interrupted');
  runStore.startNode(runId, 'interrupted', digest('e'));
  runStore.prepareResume(runId);

  let replay = eventBus.replay({ runId });
  assert.equal(replay.runs[runId].status, RUN_STATUSES.RUNNING);
  assert.equal(replay.runs[runId].nodes.interrupted.status, NODE_STATES.READY);
  assert.equal(replay.runs[runId].nodes.interrupted.lastFailure.reason, 'process-interrupted');
  assert.ok(eventBus.list().some((event) => event.eventType === DURABLE_EVENT_TYPES.RUN_RESUMED));

  runStore.cancelRun(runId, 'operator-paused');
  replay = eventBus.replay({ runId });
  assert.equal(replay.runs[runId].status, RUN_STATUSES.CANCELLED);
  assert.equal(replay.runs[runId].stopReason, 'operator-paused');
  assert.equal(replay.runs[runId].nodes.interrupted.status, NODE_STATES.CANCELLED);
  assert.equal(eventBus.list().at(-1).eventType, DURABLE_EVENT_TYPES.RUN_CANCELLED);
});

test('ProjectSpace keeps the durable outbox hidden and compatibility events.jsonl unchanged', () => {
  const project = ProjectSpace.create({ title: 'Event compatibility', tickers: ['AAPL'] });
  try {
    for (let index = 0; index < 41; index += 1) ProjectSpace.appendEvent(project.id, { type: 'compat', index });
    const bus = ProjectSpace.eventBus(project.id);
    bus.publish(runStarted('evt-project-space', 'run-project-space'));

    assert.equal(ProjectSpace.events(project.id).length, 41);
    assert.equal(ProjectSpace.durableEvents(project.id).length, 1);
    assert.equal(ProjectSpace.replayEvents(project.id).runs['run-project-space'].status, RUN_STATUSES.RUNNING);
    assert.equal(ProjectSpace.files(project.id).some((entry) => entry.name.startsWith('.events')), false);
    assert.equal(ProjectSpace.fileContent(project.id, '.events/outbox/000000000001.json'), null);
  } finally {
    ProjectSpace.delete(project.id);
  }
});
