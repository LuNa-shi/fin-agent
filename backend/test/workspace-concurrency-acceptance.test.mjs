import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const artifactStoreUrl = pathToFileURL(path.resolve('src/project-space/ArtifactStore.js')).href;
const workspaceServiceUrl = pathToFileURL(path.resolve('src/project-space/WorkspaceService.js')).href;

function fixture(t) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-ws01-acceptance-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  return projectsDir;
}

function workerCode() {
  return `
    import { FileArtifactStore } from ${JSON.stringify(artifactStoreUrl)};
    import { FileWorkspaceService } from ${JSON.stringify(workspaceServiceUrl)};
    const [projectsDir, projectId, role, relativePath, marker, startText] = process.argv.slice(1);
    const startAt = Number(startText);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < startAt) Atomics.wait(waiter, 0, 0, Math.min(10, startAt - Date.now()));
    const content = JSON.stringify({ role, payload: marker.repeat(300000) });
    new FileWorkspaceService({ projectId, projectsDir }).writeText('/project/' + relativePath, content, {
      allowedMounts: ['/project'],
    });
    new FileArtifactStore({ projectId, projectsDir }).commit({
      runId: 'run-concurrency',
      nodeId: role,
      idempotencyKey: 'commit-' + role,
      artifactId: 'concurrency.' + role,
      path: relativePath,
      schemaVersion: 'concurrency-output.v1',
      producer: role,
      contractVersion: '1.0.0',
      inputDigest: 'sha256:' + marker.repeat(64),
      asOf: '2026-07-16T00:00:00.000Z',
      content,
      inputArtifactRefs: [],
    });
  `;
}

function runWorker({ projectsDir, projectId, role, relativePath, marker, startAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      workerCode(),
      projectsDir,
      projectId,
      role,
      relativePath,
      marker,
      String(startAt),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${projectId}/${role} failed (${exitCode}): ${stderr}`));
    });
  });
}

function tempFiles(root) {
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const item = path.join(dir, name);
      if (fs.statSync(item).isDirectory()) walk(item);
      else if (name.endsWith('.tmp')) found.push(path.relative(root, item));
    }
  };
  walk(root);
  return found;
}

test('WS-01 serializes same-project Industry, Company, and Review writers without partial files or lost manifest entries', async (t) => {
  const projectsDir = fixture(t);
  const projectId = 'proj_ws01_same_project';
  const startAt = Date.now() + 300;
  const roles = [
    { role: 'industry', relativePath: 'analysis/industry.json', marker: 'a' },
    { role: 'company', relativePath: 'analysis/company.json', marker: 'b' },
    { role: 'review', relativePath: 'analysis/reviews/final.json', marker: 'c' },
  ];
  await Promise.all(roles.map((role) => runWorker({ projectsDir, projectId, startAt, ...role })));

  const { FileArtifactStore } = await import('../src/project-space/ArtifactStore.js');
  const { FileEventBus } = await import('../src/project-space/EventBus.js');
  const store = new FileArtifactStore({ projectId, projectsDir });
  const manifest = store.manifest();
  assert.equal(manifest.versions.length, roles.length);
  assert.deepEqual(new Set(manifest.versions.map((entry) => entry.nodeId)), new Set(roles.map((role) => role.role)));

  for (const role of roles) {
    const file = path.join(projectsDir, projectId, role.relativePath);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.role, role.role);
    assert.equal(parsed.payload, role.marker.repeat(300000));
  }
  const events = new FileEventBus({ projectId, projectsDir }).list();
  assert.equal(events.length, roles.length);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(tempFiles(path.join(projectsDir, projectId)).length, 0);
});

test('WS-01 isolates parallel projects that write the same relative path and artifact identity', async (t) => {
  const projectsDir = fixture(t);
  const startAt = Date.now() + 300;
  const jobs = [
    { projectId: 'proj_ws01_alpha', role: 'company', relativePath: 'analysis/shared.json', marker: 'd' },
    { projectId: 'proj_ws01_beta', role: 'company', relativePath: 'analysis/shared.json', marker: 'e' },
  ];
  await Promise.all(jobs.map((job) => runWorker({ projectsDir, startAt, ...job })));

  const { FileArtifactStore } = await import('../src/project-space/ArtifactStore.js');
  const { FileEventBus } = await import('../src/project-space/EventBus.js');
  for (const job of jobs) {
    const other = jobs.find((candidate) => candidate.projectId !== job.projectId);
    const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, job.projectId, job.relativePath), 'utf8'));
    assert.equal(parsed.payload, job.marker.repeat(300000));
    assert.notEqual(parsed.payload, other.marker.repeat(300000));
    const manifest = new FileArtifactStore({ projectId: job.projectId, projectsDir }).manifest();
    assert.equal(manifest.projectId, job.projectId);
    assert.equal(manifest.versions.length, 1);
    assert.equal(manifest.versions[0].ref.contentDigest, manifest.versions[0].objectDigest);
    const events = new FileEventBus({ projectId: job.projectId, projectsDir }).list();
    assert.deepEqual(events.map((event) => event.projectId), [job.projectId]);
  }
});
