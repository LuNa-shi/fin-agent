import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  atomicCreateFileSync,
  atomicWriteFileSync,
} from '../src/lib/fileLock.js';

const digest = (char) => `sha256:${char.repeat(64)}`;

function symlinkOutside(tempPath, outsidePath) {
  fs.mkdirSync(path.dirname(tempPath), { recursive: true });
  fs.symlinkSync(outsidePath, tempPath);
}

function removeIfPresent(target) {
  try { fs.unlinkSync(target); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

test('durable writers never follow pre-positioned predictable temp symlinks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-atomic-temp-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const helperOutside = path.join(root, 'helper-outside.txt');
  fs.writeFileSync(helperOutside, 'helper-safe');
  const replaceTarget = path.join(root, 'helper', 'replace.json');
  const replaceTrap = `${replaceTarget}.${process.pid}.1.tmp`;
  symlinkOutside(replaceTrap, helperOutside);
  atomicWriteFileSync(replaceTarget, 'inside-replace');
  assert.equal(fs.readFileSync(helperOutside, 'utf8'), 'helper-safe');
  assert.equal(fs.readFileSync(replaceTarget, 'utf8'), 'inside-replace');
  removeIfPresent(replaceTrap);

  const createTarget = path.join(root, 'helper', 'create.json');
  const createTrap = `${createTarget}.${process.pid}.2.tmp`;
  symlinkOutside(createTrap, helperOutside);
  atomicCreateFileSync(createTarget, 'inside-create');
  assert.equal(fs.readFileSync(helperOutside, 'utf8'), 'helper-safe');
  assert.equal(fs.readFileSync(createTarget, 'utf8'), 'inside-create');
  removeIfPresent(createTrap);

  const { FileRunStore } = await import(
    `../src/project-space/RunStore.js?temp-symlink=${Date.now()}`
  );
  const runStorageDir = path.join(root, 'run-store');
  const runOutside = path.join(root, 'run-outside.json');
  const runId = 'idea-run-temp-symlink';
  fs.mkdirSync(path.join(runStorageDir, '.runs'), { recursive: true });
  fs.writeFileSync(runOutside, 'run-safe');
  const runRecord = path.join(
    runStorageDir,
    '.runs',
    `run-${crypto.createHash('sha256').update(runId).digest('hex')}.json`,
  );
  const runTrap = `${runRecord}.${process.pid}.1.tmp`;
  symlinkOutside(runTrap, runOutside);
  const runEventBus = {
    get: () => null,
    publish: (event) => event,
  };
  const runStore = new FileRunStore({
    projectId: 'idea-universe:local-user',
    storageDir: runStorageDir,
    eventBus: runEventBus,
  });
  runStore.begin({
    runId,
    workflowSpec: {
      id: 'idea-generation.v2',
      version: '2.0.0',
      hash: digest('1'),
    },
    inputDigest: digest('2'),
    asOf: '2026-07-23T00:00:00.000Z',
    nodeIds: ['collect-market-context'],
    scope: {
      kind: 'idea-universe',
      id: 'idea-universe:local-user',
    },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: 'idea-run-input-snapshot:temp-symlink',
  });
  assert.equal(fs.readFileSync(runOutside, 'utf8'), 'run-safe');
  assert.equal(fs.lstatSync(runRecord).isFile(), true);
  removeIfPresent(runTrap);

  const { FileArtifactStore } = await import(
    `../src/project-space/ArtifactStore.js?temp-symlink=${Date.now()}`
  );
  const artifactStorageDir = path.join(root, 'artifact-store');
  const artifactOutside = path.join(root, 'artifact-outside.txt');
  fs.mkdirSync(artifactStorageDir);
  fs.writeFileSync(artifactOutside, 'artifact-safe');
  const artifactEventBus = {
    get: () => null,
    latest: () => null,
    publish: (event) => event,
  };
  const artifactStore = new FileArtifactStore({
    projectId: 'idea-universe:local-user',
    storageDir: artifactStorageDir,
    eventBus: artifactEventBus,
  });
  const content = 'artifact-content';
  const contentDigest = crypto.createHash('sha256').update(content).digest('hex');
  const objectPath = path.join(artifactStore.objectDir, contentDigest);
  const objectTrap = `${objectPath}.${process.pid}.1.tmp`;
  symlinkOutside(objectTrap, artifactOutside);
  artifactStore.commit({
    runId: 'idea-run-temp-symlink',
    nodeId: 'collect-market-context',
    idempotencyKey: 'idea-run-temp-symlink:collect-market-context',
    artifactId: 'idea-run-temp-symlink:collect-market-context',
    path: 'outputs/collect-market-context.json',
    schemaVersion: 'idea-source-batch.v1',
    producer: 'collect-market-context',
    contractVersion: '1.0.0',
    inputDigest: digest('3'),
    asOf: '2026-07-23T00:00:00.000Z',
    content,
    inputArtifactRefs: [],
  });
  assert.equal(fs.readFileSync(artifactOutside, 'utf8'), 'artifact-safe');
  assert.equal(fs.readFileSync(objectPath, 'utf8'), content);
  removeIfPresent(objectTrap);
});
