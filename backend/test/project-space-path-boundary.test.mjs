import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function runIsolatedProjectScript(source) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-boundary-'));
  try {
    return await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: backendRoot,
      env: { ...process.env, FIN_DATA_DIR: dataDir },
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function runWithSymlinkedDataRoot(source) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-root-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-root-outside-'));
  const dataDir = path.join(container, 'data');
  fs.symlinkSync(outside, dataDir, 'dir');
  try {
    return await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: backendRoot,
      env: { ...process.env, FIN_DATA_DIR: dataDir },
    });
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('ProjectSpace rejects symlinked configured data and projects roots', async () => {
  const linkedData = await runWithSymlinkedDataRoot(`
    import assert from 'node:assert/strict';
    await assert.rejects(
      () => import('./src/project-space/ProjectSpace.js'),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    process.stdout.write('data-ok');
  `);
  assert.equal(linkedData.stdout, 'data-ok');

  const linkedProjects = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { PROJECTS_DIR } from './src/config.js';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-projects-root-outside-'));
    fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
    fs.symlinkSync(outside, PROJECTS_DIR, 'dir');
    assert.throws(
      () => ProjectSpace.list(),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    fs.unlinkSync(PROJECTS_DIR);
    fs.rmSync(outside, { recursive: true, force: true });
    process.stdout.write('projects-ok');
  `);
  assert.equal(linkedProjects.stdout, 'projects-ok');
});

test('ProjectSpace resolves only safe direct-child project identities', async () => {
  const { stdout } = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    for (const id of ['../escape', '..', '.', '/absolute', 'nested/project', 'nested\\\\project', 'bad:colon', 'bad\\0id']) {
      assert.throws(() => ProjectSpace.dir(id), (error) => error?.code === 'UNSAFE_PROJECT_ID');
    }

    const project = ProjectSpace.create({
      id: '../forged',
      status: 'done',
      createdAt: 1,
      title: 'Safe identity',
    });
    assert.match(project.id, /^proj_[a-z0-9]+$/u);
    assert.equal(project.status, 'created');
    assert.notEqual(project.createdAt, 1);
    assert.equal(project.updatedAt, project.createdAt);
    assert.throws(
      () => ProjectSpace.updateMeta(project.id, { id: 'proj_forged' }),
      (error) => error?.code === 'PROJECT_IDENTITY_MISMATCH',
    );
    assert.equal(ProjectSpace.meta(project.id).id, project.id);
    assert.throws(
      () => ProjectSpace.delete('../escape'),
      (error) => error?.code === 'UNSAFE_PROJECT_ID',
    );
    assert.equal(ProjectSpace.delete(project.id), true);
    process.stdout.write('ok');
  `);
  assert.equal(stdout, 'ok');
});

test('ProjectSpace create never reuses a colliding pre-existing directory', async () => {
  const { stdout } = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { PROJECTS_DIR } from './src/config.js';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-collision-outside-'));
    const firstRandom = 0.5;
    const collidingId = \`proj_\${firstRandom.toString(36).slice(2, 9)}\`;
    const collidingDir = path.join(PROJECTS_DIR, collidingId);
    fs.mkdirSync(collidingDir);
    fs.symlinkSync(outside, path.join(collidingDir, 'data'), 'dir');

    const values = [firstRandom, 0.75];
    const originalRandom = Math.random;
    Math.random = () => values.shift() ?? originalRandom();
    let created;
    try {
      created = ProjectSpace.create({ title: 'Exclusive Project directory' });
    } finally {
      Math.random = originalRandom;
    }

    assert.notEqual(created.id, collidingId);
    assert.equal(fs.existsSync(path.join(outside, 'quotes.json')), false);
    assert.equal(ProjectSpace.meta(created.id).title, created.title);

    ProjectSpace.delete(created.id);
    fs.unlinkSync(path.join(collidingDir, 'data'));
    fs.rmSync(collidingDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    process.stdout.write('ok');
  `);
  assert.equal(stdout, 'ok');
});

test('ProjectSpace rejects symlinked project folders, metadata, and visible content', async () => {
  const { stdout } = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { PROJECTS_DIR } from './src/config.js';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-outside-'));
    const linkedProject = path.join(PROJECTS_DIR, 'proj_link');
    fs.symlinkSync(outside, linkedProject, 'dir');
    assert.throws(
      () => ProjectSpace.list(),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    fs.unlinkSync(linkedProject);

    const project = ProjectSpace.create({ title: 'Symlink denial' });
    const outsideMeta = path.join(outside, 'meta.json');
    fs.writeFileSync(outsideMeta, JSON.stringify({ id: project.id }));
    const metaFile = path.join(ProjectSpace.dir(project.id), 'meta.json');
    fs.unlinkSync(metaFile);
    fs.symlinkSync(outsideMeta, metaFile);
    assert.throws(
      () => ProjectSpace.meta(project.id),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    assert.throws(
      () => ProjectSpace.updateMeta(project.id, { status: 'blocked' }),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    assert.throws(
      () => ProjectSpace.list(),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    fs.unlinkSync(metaFile);
    fs.writeFileSync(metaFile, JSON.stringify(project));

    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(ProjectSpace.dir(project.id), 'report', 'linked.txt'));
    assert.throws(
      () => ProjectSpace.files(project.id),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    ProjectSpace.delete(project.id);
    fs.rmSync(outside, { recursive: true, force: true });
    process.stdout.write('ok');
  `);
  assert.equal(stdout, 'ok');
});

test('ProjectSpace validates dynamic content paths and preserves safe nested review paths', async () => {
  const { stdout } = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    const project = ProjectSpace.create({ title: 'Content boundary' });
    const calls = [
      () => ProjectSpace.setDataFile(project.id, '../escape.json', {}),
      () => ProjectSpace.setDataText(project.id, '/absolute.txt', 'x'),
      () => ProjectSpace.setAnalysisFile(project.id, '../escape.json', {}),
      () => ProjectSpace.setAnalysisText(project.id, 'reviews/../../escape.md', 'x'),
      () => ProjectSpace.analysisFile(project.id, '../escape.json'),
      () => ProjectSpace.setReportText(project.id, '..\\\\escape.md', 'x'),
    ];
    for (const call of calls) {
      assert.throws(call, (error) => error?.code === 'UNSAFE_PROJECT_PATH');
    }

    ProjectSpace.setAnalysisFile(project.id, 'reviews/round_1.json', { ok: true });
    ProjectSpace.setAnalysisText(project.id, 'reviews/round_1.md', '# Review');
    assert.deepEqual(
      ProjectSpace.analysisFile(project.id, 'reviews/round_1.json'),
      { ok: true },
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-project-content-outside-'));
    const reviewsDir = path.join(ProjectSpace.dir(project.id), 'analysis', 'reviews');
    fs.rmSync(reviewsDir, { recursive: true, force: true });
    fs.symlinkSync(outside, reviewsDir, 'dir');
    assert.throws(
      () => ProjectSpace.setAnalysisFile(project.id, 'reviews/escaped.json', { escaped: true }),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    assert.throws(
      () => ProjectSpace.analysisFile(project.id, 'reviews/escaped.json'),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );
    fs.unlinkSync(reviewsDir);
    fs.mkdirSync(reviewsDir);

    const outsideFile = path.join(outside, 'linked.json');
    fs.writeFileSync(outsideFile, JSON.stringify({ secret: true }));
    fs.symlinkSync(outsideFile, path.join(reviewsDir, 'linked.json'));
    assert.throws(
      () => ProjectSpace.analysisFile(project.id, 'reviews/linked.json'),
      (error) => error?.code === 'PROJECT_SYMLINK_DENIED',
    );

    ProjectSpace.delete(project.id);
    fs.rmSync(outside, { recursive: true, force: true });
    process.stdout.write('ok');
  `);
  assert.equal(stdout, 'ok');
});

test('ProjectSpace commits content before projection and index rebuild follows folder truth', async () => {
  const { stdout } = await runIsolatedProjectScript(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { GLOBAL_DIR } from './src/config.js';
    import { globalContentIndex } from './src/core/persistence/GlobalContentIndex.js';
    import { ProjectSpace } from './src/project-space/ProjectSpace.js';

    const project = ProjectSpace.create({ title: 'Indexed Project' });
    let entry = globalContentIndex.read().entries.find(
      (candidate) => candidate.type === 'project' && candidate.id === project.id,
    );
    assert.equal(entry.status, 'created');
    assert.equal(entry.contentRef, \`projects/\${project.id}\`);

    const updated = ProjectSpace.updateMeta(project.id, { status: 'analyzing' });
    entry = globalContentIndex.read().entries.find(
      (candidate) => candidate.type === 'project' && candidate.id === project.id,
    );
    assert.equal(entry.status, 'analyzing');
    assert.equal(entry.updatedAt, updated.updatedAt);

    ProjectSpace.delete(project.id);
    assert.equal(
      globalContentIndex.read().entries.some((candidate) => candidate.id === project.id),
      false,
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-global-index-failure-'));
    fs.rmSync(GLOBAL_DIR, { recursive: true, force: true });
    fs.symlinkSync(outside, GLOBAL_DIR, 'dir');
    const committed = ProjectSpace.create({ title: 'Folder survives projection failure' });
    assert.equal(ProjectSpace.meta(committed.id).title, committed.title);
    fs.unlinkSync(GLOBAL_DIR);
    const rebuilt = globalContentIndex.read();
    assert.equal(
      rebuilt.entries.some(
        (candidate) => candidate.type === 'project' && candidate.id === committed.id,
      ),
      true,
    );
    ProjectSpace.delete(committed.id);
    fs.rmSync(outside, { recursive: true, force: true });
    process.stdout.write('ok');
  `);
  assert.equal(stdout, 'ok');
});
