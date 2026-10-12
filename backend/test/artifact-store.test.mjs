import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-artifact-store-'));
process.env.FIN_DATA_DIR = dataDir;

const { canonicalSha256 } = await import('../src/core/contracts/ArtifactRef.js');
const { ARTIFACT_MANIFEST_CONTRACT, FileArtifactStore } = await import('../src/project-space/ArtifactStore.js');

function store(projectId = 'proj_arc03a') {
  return new FileArtifactStore({ projectId });
}

function baseCommit(overrides = {}) {
  return {
    runId: 'run-1',
    nodeId: 'analysis-plan',
    idempotencyKey: 'idem-1',
    artifactId: 'analysis.plan',
    path: 'analysis/plan.json',
    schemaVersion: 'analysis-plan.v1',
    producer: 'analysis-plan',
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ seed: 'AAPL' }),
    asOf: '2026-07-15T00:00:00.000Z',
    content: { candidates: [{ ticker: 'AAPL' }] },
    inputArtifactRefs: [],
    ...overrides,
  };
}

test('FileArtifactStore commits immutable content-addressed versions with idempotent replay', () => {
  const artifacts = store();
  const first = artifacts.commit(baseCommit());
  const replay = artifacts.commit(baseCommit());
  const second = artifacts.commit(baseCommit({
    idempotencyKey: 'idem-2',
    content: { candidates: [{ ticker: 'MSFT' }] },
  }));

  assert.equal(first.version, 1);
  assert.deepEqual(replay, first);
  assert.equal(second.version, 2);
  assert.notEqual(second.contentDigest, first.contentDigest);
  assert.deepEqual(artifacts.get('analysis.plan', 1), first);
  assert.deepEqual(artifacts.history('analysis.plan').map((ref) => ref.version), [1, 2]);
  assert.deepEqual(artifacts.list().map((ref) => `${ref.artifactId}@${ref.version}`), [
    'analysis.plan@1',
    'analysis.plan@2',
  ]);
  assert.equal(artifacts.read(first), JSON.stringify({ candidates: [{ ticker: 'AAPL' }] }));
  assert.equal(artifacts.read(second), JSON.stringify({ candidates: [{ ticker: 'MSFT' }] }));

  const manifest = artifacts.manifest();
  assert.deepEqual(Object.keys(manifest).sort(), [...ARTIFACT_MANIFEST_CONTRACT.fields].sort());
  assert.deepEqual(Object.keys(manifest.versions[0]).sort(), [...ARTIFACT_MANIFEST_CONTRACT.versionEntryFields].sort());
  assert.deepEqual(
    Object.keys(Object.values(manifest.successfulCommits)[0]).sort(),
    [...ARTIFACT_MANIFEST_CONTRACT.successfulCommitFields].sort(),
  );
  assert.equal(manifest.versions.length, 2);
  assert.equal(manifest.versions[0].runId, 'run-1');
  assert.equal(manifest.versions[0].nodeId, 'analysis-plan');
  assert.equal(manifest.versions[0].idempotencyKey, 'idem-1');
  const lineage = artifacts.lineageForRun('run-1');
  assert.deepEqual(Object.keys(lineage[0]).sort(), [...ARTIFACT_MANIFEST_CONTRACT.lineageEntryFields].sort());
  assert.deepEqual(lineage.map((entry) => entry.ref.version), [1, 2]);
});

test('FileArtifactStore preserves exact report text bytes instead of JSON-quoting them', () => {
  const artifacts = store('proj_arc03a_text');
  const markdown = '# Report\n\nPrice target: $123.\n';
  const ref = artifacts.commit(baseCommit({
    artifactId: 'report.main',
    path: 'report/report.md',
    schemaVersion: 'report-markdown.v1',
    idempotencyKey: 'idem-report-1',
    content: markdown,
  }));

  assert.equal(artifacts.read(ref), markdown);
});

test('FileArtifactStore treats metadata changes under one artifact idempotency scope as conflicts', () => {
  const artifacts = store('proj_arc03a_idempotency');
  artifacts.commit(baseCommit());

  assert.throws(
    () => artifacts.commit(baseCommit({ schemaVersion: 'analysis-plan.v2' })),
    /idempotency conflict/u,
  );
  assert.throws(
    () => artifacts.commit(baseCommit({ content: { candidates: [{ ticker: 'MSFT' }] } })),
    /idempotency conflict/u,
  );
});

test('FileArtifactStore rejects unsafe paths, corrupt manifests, and digest mismatches', () => {
  const artifacts = store('proj_arc03a_security');
  assert.throws(() => store('../other_project'), /unsafe project id/u);
  assert.throws(() => artifacts.commit(baseCommit({ path: '../escape.json' })), /unsafe artifact path/u);
  assert.throws(() => artifacts.commit(baseCommit({ path: '/tmp/escape.json' })), /unsafe artifact path/u);
  assert.throws(() => artifacts.commit(baseCommit({ path: 'analysis/../../escape.json' })), /unsafe artifact path/u);

  const ref = artifacts.commit(baseCommit({ path: 'analysis/safe.json' }));
  const objectPath = artifacts.objectPathForDigest(ref.contentDigest);
  fs.writeFileSync(objectPath, '{"tampered":true}');
  assert.throws(() => artifacts.read(ref), /digest mismatch/u);
  assert.throws(
    () => artifacts.commit(baseCommit({ path: 'analysis/safe.json' })),
    /digest mismatch/u,
    'idempotent replay must verify immutable bytes before returning a cached ref',
  );
  fs.writeFileSync(objectPath, 'not-json');
  assert.throws(() => artifacts.read(ref), /digest mismatch/u);

  fs.writeFileSync(artifacts.manifestPath, '{not-json');
  assert.throws(() => artifacts.list(), /corrupt artifact manifest/u);
});

test('FileArtifactStore rejects manifest contract and lineage metadata drift', () => {
  const artifacts = store('proj_arc03a_manifest_contract');
  artifacts.commit(baseCommit());
  const valid = JSON.parse(fs.readFileSync(artifacts.manifestPath, 'utf8'));
  const writeManifest = (mutate) => {
    const next = structuredClone(valid);
    mutate(next);
    fs.writeFileSync(artifacts.manifestPath, JSON.stringify(next, null, 2));
  };

  writeManifest((manifest) => { manifest.storeScope = 'distributed'; });
  assert.throws(() => artifacts.list(), /corrupt artifact manifest/u);

  writeManifest((manifest) => { manifest.versions[0].inputArtifactRefs = null; });
  assert.throws(() => artifacts.lineageForRun('run-1'), /corrupt artifact manifest/u);

  writeManifest((manifest) => { manifest.versions[0].objectPath = '../outside'; });
  assert.throws(() => artifacts.manifest(), /corrupt artifact manifest/u);

  writeManifest((manifest) => {
    const successful = Object.values(manifest.successfulCommits)[0];
    successful.ref.producer = 'tampered-producer';
  });
  assert.throws(() => artifacts.commit(baseCommit()), /corrupt artifact manifest/u);
});

test('FileArtifactStore reads Gate A single-process manifests and upgrades them on the next commit', () => {
  const artifacts = store('proj_ws01_legacy_manifest');
  artifacts.commit(baseCommit());
  const legacy = JSON.parse(fs.readFileSync(artifacts.manifestPath, 'utf8'));
  legacy.storeScope = 'single-process';
  legacy.concurrencyNote = 'ARC-03a is a single-process primitive; cross-process CAS/single-writer concurrency remains WS-01.';
  fs.writeFileSync(artifacts.manifestPath, JSON.stringify(legacy, null, 2));

  assert.equal(artifacts.manifest().storeScope, 'cross-process-single-writer');
  artifacts.commit(baseCommit({
    idempotencyKey: 'legacy-upgrade-2',
    artifactId: 'analysis.scan',
    path: 'analysis/scan.json',
  }));
  const upgraded = JSON.parse(fs.readFileSync(artifacts.manifestPath, 'utf8'));
  assert.equal(upgraded.storeScope, 'cross-process-single-writer');
  assert.equal(upgraded.versions.length, 2);
});

test('FileArtifactStore uses atomic temp+rename commits without leaving temp files on success', () => {
  const artifacts = store('proj_arc03a_atomic');
  artifacts.commit(baseCommit());

  const leftovers = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const item = path.join(dir, name);
      if (fs.statSync(item).isDirectory()) walk(item);
      else if (name.includes('.tmp')) leftovers.push(path.relative(artifacts.rootDir, item));
    }
  };
  walk(artifacts.rootDir);

  assert.deepEqual(leftovers, []);
});

test('FileArtifactStore publishes a node artifact batch atomically', () => {
  const artifacts = store('proj_arc03a_batch');
  const refs = artifacts.commitMany([
    baseCommit({ idempotencyKey: 'batch-plan', artifactId: 'analysis.plan' }),
    baseCommit({
      idempotencyKey: 'batch-scan',
      artifactId: 'analysis.scan',
      path: 'analysis/scan.json',
      schemaVersion: 'scan-score.v1',
      producer: 'scan-score',
      content: { scores: [{ ticker: 'AAPL', score: 1 }] },
    }),
  ]);

  assert.equal(refs.length, 2);
  assert.deepEqual(artifacts.manifest().versions.map((entry) => entry.ref.artifactId), [
    'analysis.plan',
    'analysis.scan',
  ]);

  const before = artifacts.manifest();
  assert.throws(
    () => artifacts.commitMany([
      baseCommit({
        idempotencyKey: 'batch-new',
        artifactId: 'analysis.new',
        path: 'analysis/new.json',
      }),
      baseCommit({
        idempotencyKey: 'batch-plan',
        artifactId: 'analysis.plan',
        content: { candidates: [{ ticker: 'MSFT' }] },
      }),
    ]),
    /idempotency conflict/u,
  );
  assert.deepEqual(artifacts.manifest(), before, 'a rejected batch must publish no partial manifest entries');
  assert.equal(artifacts.get('analysis.new', 1), null);

  const duplicateStore = store('proj_arc03a_batch_duplicate');
  const duplicate = baseCommit({ idempotencyKey: 'same-scope' });
  const duplicateRefs = duplicateStore.commitMany([duplicate, duplicate]);
  assert.deepEqual(duplicateRefs[1], duplicateRefs[0]);
  assert.equal(duplicateStore.manifest().versions.length, 1);
});

test('FileArtifactStore serializes concurrent cross-process manifest writers without lost updates', async () => {
  const projectsDir = path.join(dataDir, 'cross-process-projects');
  const projectId = 'proj_ws01_concurrent';
  const moduleUrl = pathToFileURL(path.resolve('src/project-space/ArtifactStore.js')).href;
  const startAt = Date.now() + 500;
  const workers = 12;
  const code = `
    import { FileArtifactStore } from ${JSON.stringify(moduleUrl)};
    const [projectsDir, projectId, indexText, startText] = process.argv.slice(1);
    const index = Number(indexText);
    const startAt = Number(startText);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < startAt) Atomics.wait(waiter, 0, 0, Math.min(10, startAt - Date.now()));
    const char = (index % 10).toString(16);
    const store = new FileArtifactStore({ projectId, projectsDir });
    store.commit({
      runId: 'run-concurrent',
      nodeId: 'node-' + index,
      idempotencyKey: 'idem-' + index,
      artifactId: 'artifact-' + index,
      path: 'analysis/concurrent-' + index + '.json',
      schemaVersion: 'concurrent.v1',
      producer: 'worker-' + index,
      contractVersion: '1.0.0',
      inputDigest: 'sha256:' + char.repeat(64),
      asOf: '2026-07-16T00:00:00.000Z',
      content: { index, payload: 'x'.repeat(250000) },
      inputArtifactRefs: [],
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

  const artifacts = new FileArtifactStore({ projectId, projectsDir });
  const manifest = artifacts.manifest();
  assert.equal(manifest.versions.length, workers);
  assert.equal(new Set(manifest.versions.map((entry) => entry.ref.artifactId)).size, workers);
  assert.equal(Object.keys(manifest.successfulCommits).length, workers);
});

test('FileArtifactStore documents the WS-01 cross-process single-writer scope', () => {
  assert.equal(FileArtifactStore.scope, 'cross-process-single-writer');
  assert.match(FileArtifactStore.concurrencyNote, /single-writer/u);
});

test('FileArtifactStore preserves the legacy Project constructor directory layout', (t) => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-artifact-layout-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const artifacts = new FileArtifactStore({ projectId: 'proj_layout', projectsDir });

  assert.equal(fs.existsSync(artifacts.objectDir), true);
  assert.equal(fs.existsSync(path.join(artifacts.rootDir, '.locks')), false);
  artifacts.manifest();
  assert.equal(fs.existsSync(path.join(artifacts.rootDir, '.locks')), false);
});

test('FileArtifactStore commits scoped artifacts under a validated direct storage root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-scoped-artifact-store-'));
  const storageDir = path.join(root, 'idea-generation', 'runs', 'idea-run-1');
  fs.mkdirSync(storageDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scopeId = 'idea-universe:local-user';
  const artifacts = new FileArtifactStore({ projectId: scopeId, storageDir });
  const ref = artifacts.commit(baseCommit({
    runId: 'idea-run-1',
    nodeId: 'collect-market-context',
    idempotencyKey: 'idea-run-1:collect-market-context:output',
    artifactId: 'idea-run-1:collect-market-context',
    path: 'outputs/collect-market-context.json',
    schemaVersion: 'idea-source-batch.v1',
    producer: 'collect-market-context',
    content: { sources: [], runId: 'idea-run-1' },
  }));

  assert.equal(artifacts.manifest().projectId, scopeId);
  assert.equal(artifacts.read(ref), JSON.stringify({ runId: 'idea-run-1', sources: [] }));
  assert.equal(fs.existsSync(path.join(storageDir, '.artifacts', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(storageDir, '.events', 'outbox')), true);
  assert.equal(fs.existsSync(path.join(root, 'projects')), false);
});

test('FileArtifactStore direct storage rejects symlinked hidden roots without outside writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-scoped-artifact-security-'));
  const storageDir = path.join(root, 'idea-run');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(storageDir, '.artifacts'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => new FileArtifactStore({
      projectId: 'idea-universe:local-user',
      storageDir,
    }),
    /must not be a symlink/u,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
