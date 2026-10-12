import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import {
  FileWorkspaceService,
  WORKSPACE_MOUNT_NAMES,
  WorkspacePermissionError,
} from '../src/project-space/WorkspaceService.js';

const digest = (char) => `sha256:${char.repeat(64)}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workspace-service-'));
  const projectsDir = path.join(root, 'projects');
  const projectDir = path.join(projectsDir, 'proj_test');
  fs.mkdirSync(path.join(projectDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'report'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'data', 'evidence.json'), '{"ok":true}');
  fs.writeFileSync(path.join(projectDir, 'report', 'report.md'), '# Report');
  fs.writeFileSync(path.join(projectDir, 'meta.json'), '{"id":"proj_test"}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    projectsDir,
    projectDir,
    service: new FileWorkspaceService({ projectId: 'proj_test', projectsDir }),
  };
}

function permission(fn, reason) {
  assert.throws(
    fn,
    (error) => error instanceof WorkspacePermissionError && error.reason === reason,
  );
}

test('WorkspaceService publishes deterministic snapshots with all five capability mounts', (t) => {
  const { service } = fixture(t);
  const ref = createArtifactRef({
    artifactId: 'proj_test:data/evidence.json',
    version: 1,
    path: 'data/evidence.json',
    contentDigest: digest('a'),
    schemaVersion: 'evidence.v1',
    producer: 'data-orchestrator',
    contractVersion: '1.0.0',
    inputDigest: digest('b'),
    createdAt: '2026-07-16T00:00:00.000Z',
    asOf: '2026-07-16T00:00:00.000Z',
  });
  const input = {
    runId: 'artifact-run-proj_test-1',
    nodeId: 'industry-analysis',
    asOf: '2026-07-16T00:00:00.000Z',
    artifactRefs: [ref],
  };
  const first = service.createSnapshot(input);
  const second = service.createSnapshot(input);

  assert.equal(first.snapshotId, second.snapshotId);
  assert.deepEqual(first, second);
  assert.deepEqual(first.mounts.map((mount) => mount.name), WORKSPACE_MOUNT_NAMES);
  assert.ok(first.mounts.every((mount) => mount.uri.startsWith('workspace://proj_test/')));
  assert.equal(service.loadSnapshot(first.snapshotId).snapshotId, first.snapshotId);
  assert.ok(Object.isFrozen(first));
});

test('WorkspaceService enforces mount capabilities, traversal, absolute paths, and symlink containment', (t) => {
  const { root, projectDir, service } = fixture(t);
  const allowed = service.resolve('/project/data/evidence.json', {
    allowedMounts: ['/project'],
    access: 'read',
  });
  assert.equal(allowed.relativePath, 'data/evidence.json');
  assert.equal(service.readText('/evidence/evidence.json', { allowedMounts: ['/evidence'] }), '{"ok":true}');

  permission(
    () => service.resolve('/library/proj_test/report/report.md', { allowedMounts: ['/project'], access: 'read' }),
    'mount-not-allowed',
  );
  permission(
    () => service.resolve('/etc/passwd', { allowedMounts: ['/project'], access: 'read' }),
    'unknown-mount',
  );
  permission(
    () => service.resolve('/project/../outside.txt', { allowedMounts: ['/project'], access: 'read' }),
    'unsafe-workspace-path',
  );

  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(projectDir, 'data', 'escape.txt'));
  permission(
    () => service.readText('/project/data/escape.txt', { allowedMounts: ['/project'] }),
    'symlink-escape-denied',
  );

  const outsideDir = path.join(root, 'outside-dir');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(projectDir, 'analysis', 'escape-dir'));
  permission(
    () => service.writeText('/project/analysis/escape-dir/file.md', 'blocked', { allowedMounts: ['/project'] }),
    'symlink-escape-denied',
  );
});

test('WorkspaceService keeps scratch isolated by run and output create-only', (t) => {
  const { service } = fixture(t);
  service.writeText('/scratch/note.md', 'run one', {
    allowedMounts: ['/scratch'],
    runId: 'run-one',
  });
  service.writeText('/scratch/note.md', 'run two', {
    allowedMounts: ['/scratch'],
    runId: 'run-two',
  });
  assert.equal(service.readText('/scratch/note.md', { allowedMounts: ['/scratch'], runId: 'run-one' }), 'run one');
  assert.equal(service.readText('/scratch/note.md', { allowedMounts: ['/scratch'], runId: 'run-two' }), 'run two');

  service.writeText('/output/final.md', 'version one', { allowedMounts: ['/output'] });
  permission(
    () => service.writeText('/output/final.md', 'overwrite', { allowedMounts: ['/output'] }),
    'output-overwrite-denied',
  );
});
