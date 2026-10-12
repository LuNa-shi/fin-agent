import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GLOBAL_CONTENT_INDEX_ENTRY_FIELDS,
  GLOBAL_CONTENT_INDEX_SCHEMA_VERSION,
  GlobalContentIndex,
} from '../src/core/persistence/GlobalContentIndex.js';
import {
  canonicalSha256,
} from '../src/core/contracts/ArtifactRef.js';

function makeRoots(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-global-index-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const roots = {
    dataDir,
    globalDir: path.join(dataDir, 'global'),
    ideasDir: path.join(dataDir, 'idea-generation', 'ideas'),
    projectsDir: path.join(dataDir, 'projects'),
  };
  fs.mkdirSync(roots.ideasDir, { recursive: true });
  fs.mkdirSync(roots.projectsDir, { recursive: true });
  return roots;
}

function createIndex(roots) {
  return new GlobalContentIndex({
    globalDir: roots.globalDir,
    ideasDir: roots.ideasDir,
    projectsDir: roots.projectsDir,
  });
}

function ideaRecord(id, overrides = {}) {
  const createdAt = overrides.createdAt ?? 1_700_000_000_000;
  const updatedAt = overrides.updatedAt ?? createdAt;
  const status = overrides.status ?? 'candidate';
  const title = overrides.title ?? `Idea ${id}`;
  return {
    schemaVersion: 'idea-record.v1',
    id,
    status,
    title,
    createdAt,
    updatedAt,
    body: {
      id,
      status,
      title,
      createdAt,
      updatedAt,
      thesis: `Thesis for ${id}`,
    },
    ...overrides,
  };
}

function projectRecord(id, overrides = {}) {
  return {
    title: `Project ${id}`,
    status: 'created',
    id,
    createdAt: 1_700_000_100_000,
    ...overrides,
  };
}

function writeAnchor(root, id, file, value) {
  const folder = path.join(root, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, file), `${JSON.stringify(value, null, 2)}\n`);
  return folder;
}

function writeIdea(roots, id, overrides) {
  const record = ideaRecord(id, overrides);
  writeAnchor(roots.ideasDir, id, 'idea.json', record);
  return record;
}

function writeProject(roots, id, overrides) {
  const record = projectRecord(id, overrides);
  writeAnchor(roots.projectsDir, id, 'meta.json', record);
  return record;
}

function runChildRebuild(moduleUrl, roots) {
  const source = [
    `import { GlobalContentIndex } from ${JSON.stringify(moduleUrl)};`,
    'const dataDir = process.argv[1];',
    'const index = new GlobalContentIndex({',
    "  globalDir: new URL('./global', `file://${dataDir}/`).pathname,",
    "  ideasDir: new URL('./idea-generation/ideas', `file://${dataDir}/`).pathname,",
    "  projectsDir: new URL('./projects', `file://${dataDir}/`).pathname,",
    '});',
    'index.rebuild();',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', source, roots.dataDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`index rebuild child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test('unified index has exact schema, deterministic type/id order, refs, and logical digest', (t) => {
  const roots = makeRoots(t);
  const ideaZ = writeIdea(roots, 'z-idea', { createdAt: 20, updatedAt: 21 });
  const ideaShared = writeIdea(roots, 'shared', { createdAt: 10, updatedAt: 11 });
  const projectZ = writeProject(roots, 'z-project', { createdAt: 40, updatedAt: 41 });
  const projectShared = writeProject(roots, 'shared', { createdAt: 30 });
  const index = createIndex(roots);

  const projection = index.rebuild();

  assert.deepEqual(Object.keys(projection), ['schemaVersion', 'indexDigest', 'entries']);
  assert.equal(projection.schemaVersion, GLOBAL_CONTENT_INDEX_SCHEMA_VERSION);
  assert.deepEqual(
    projection.entries.map(({ type, id }) => `${type}:${id}`),
    ['idea:shared', 'idea:z-idea', 'project:shared', 'project:z-project'],
  );
  for (const entry of projection.entries) {
    assert.deepEqual(Object.keys(entry), GLOBAL_CONTENT_INDEX_ENTRY_FIELDS);
  }
  assert.deepEqual(
    projection.entries.map(({ contentRef }) => contentRef),
    [
      'idea-generation/ideas/shared',
      'idea-generation/ideas/z-idea',
      'projects/shared',
      'projects/z-project',
    ],
  );
  assert.equal(projection.entries[0].contentDigest, canonicalSha256(ideaShared));
  assert.equal(projection.entries[1].contentDigest, canonicalSha256(ideaZ));
  assert.equal(projection.entries[2].contentDigest, canonicalSha256(projectShared));
  assert.equal(projection.entries[2].updatedAt, projectShared.createdAt);
  assert.equal(projection.entries[3].contentDigest, canonicalSha256(projectZ));
  assert.equal(
    projection.indexDigest,
    canonicalSha256({
      schemaVersion: GLOBAL_CONTENT_INDEX_SCHEMA_VERSION,
      entries: projection.entries,
    }),
  );
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.entries));
  assert.ok(projection.entries.every(Object.isFrozen));

  const firstBytes = fs.readFileSync(index.indexPath, 'utf8');
  fs.unlinkSync(index.indexPath);
  const rebuilt = index.rebuild();
  assert.deepEqual(rebuilt, projection);
  assert.equal(fs.readFileSync(index.indexPath, 'utf8'), firstBytes);
  assert.deepEqual(fs.readdirSync(roots.globalDir), ['index.json']);
});

test('read repairs missing, corrupt, malicious, and stale projections from folder truth', (t) => {
  const roots = makeRoots(t);
  const idea = writeIdea(roots, 'repair-me', { title: 'Folder truth', createdAt: 10 });
  writeProject(roots, 'remove-me', { createdAt: 20 });
  const index = createIndex(roots);
  const initial = index.rebuild();

  const forged = structuredClone(initial);
  forged.entries[0].contentRef = '../../outside';
  forged.entries[0].title = 'Forged index title';
  forged.indexDigest = canonicalSha256({
    schemaVersion: forged.schemaVersion,
    entries: forged.entries,
  });
  fs.writeFileSync(index.indexPath, JSON.stringify(forged));

  const repairedForged = index.read();
  assert.equal(repairedForged.entries[0].contentRef, 'idea-generation/ideas/repair-me');
  assert.equal(repairedForged.entries[0].title, idea.title);

  fs.writeFileSync(index.indexPath, '{"schemaVersion":');
  assert.deepEqual(index.read(), initial);

  const updatedIdea = ideaRecord('repair-me', {
    title: 'Newer folder title',
    createdAt: 10,
    updatedAt: 30,
  });
  fs.writeFileSync(
    path.join(roots.ideasDir, 'repair-me', 'idea.json'),
    JSON.stringify(updatedIdea),
  );
  fs.rmSync(path.join(roots.projectsDir, 'remove-me'), { recursive: true });

  const repairedStale = index.read();
  assert.equal(repairedStale.entries.length, 1);
  assert.equal(repairedStale.entries[0].title, 'Newer folder title');
  assert.equal(repairedStale.entries[0].updatedAt, 30);
  assert.equal(repairedStale.entries[0].contentDigest, canonicalSha256(updatedIdea));
  assert.deepEqual(JSON.parse(fs.readFileSync(index.indexPath, 'utf8')), repairedStale);
});

test('folder authority fails closed for malformed anchors, identities, paths, and symlinks', async (t) => {
  await t.test('corrupt committed anchor', (subtest) => {
    const roots = makeRoots(subtest);
    const folder = path.join(roots.ideasDir, 'corrupt');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'idea.json'), '{not-json');
    assert.throws(
      () => createIndex(roots).rebuild(),
      (error) => error?.code === 'INVALID_GLOBAL_CONTENT_ANCHOR',
    );
  });

  await t.test('folder and anchor id mismatch', (subtest) => {
    const roots = makeRoots(subtest);
    writeAnchor(roots.projectsDir, 'folder-id', 'meta.json', projectRecord('body-id'));
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'GLOBAL_CONTENT_IDENTITY_MISMATCH',
    );
  });

  await t.test('Idea envelope body id mismatch', (subtest) => {
    const roots = makeRoots(subtest);
    const idea = ideaRecord('idea-id');
    idea.body.id = 'other-id';
    writeAnchor(roots.ideasDir, 'idea-id', 'idea.json', idea);
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'GLOBAL_CONTENT_IDENTITY_MISMATCH',
    );
  });

  await t.test('unsafe direct-child id', (subtest) => {
    const roots = makeRoots(subtest);
    writeAnchor(roots.ideasDir, 'bad\\id', 'idea.json', ideaRecord('bad\\id'));
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'UNSAFE_GLOBAL_CONTENT_ID',
    );
  });

  await t.test('symlink content folder', (subtest) => {
    const roots = makeRoots(subtest);
    const outside = path.join(roots.dataDir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(roots.projectsDir, 'linked'));
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'GLOBAL_CONTENT_SYMLINK_DENIED',
    );
  });

  await t.test('symlink anchor file', (subtest) => {
    const roots = makeRoots(subtest);
    const outside = path.join(roots.dataDir, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(ideaRecord('linked')));
    const folder = path.join(roots.ideasDir, 'linked');
    fs.mkdirSync(folder);
    fs.symlinkSync(outside, path.join(folder, 'idea.json'));
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'GLOBAL_CONTENT_SYMLINK_DENIED',
    );
  });

  await t.test('symlink configured content root', (subtest) => {
    const roots = makeRoots(subtest);
    fs.rmSync(roots.projectsDir, { recursive: true });
    const outside = path.join(roots.dataDir, 'outside-projects');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, roots.projectsDir);
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'GLOBAL_CONTENT_SYMLINK_DENIED',
    );
  });

  await t.test('invalid timestamp and non-empty text contract', (subtest) => {
    const roots = makeRoots(subtest);
    writeProject(roots, 'invalid', { title: ' ', createdAt: -1 });
    assert.throws(
      () => createIndex(roots).read(),
      (error) => error?.code === 'INVALID_GLOBAL_CONTENT_ANCHOR',
    );
  });
});

test('missing anchors are uncommitted and never erase or mutate folder content', (t) => {
  const roots = makeRoots(t);
  const incomplete = path.join(roots.ideasDir, 'incomplete');
  fs.mkdirSync(incomplete);
  fs.writeFileSync(path.join(incomplete, 'working.json'), '{"candidate":true}');
  const committed = writeProject(roots, 'committed', { createdAt: 10 });
  const anchor = path.join(roots.projectsDir, 'committed', 'meta.json');
  const before = fs.readFileSync(anchor, 'utf8');

  const projection = createIndex(roots).rebuild();

  assert.deepEqual(
    projection.entries.map(({ type, id }) => `${type}:${id}`),
    ['project:committed'],
  );
  assert.equal(fs.readFileSync(anchor, 'utf8'), before);
  assert.deepEqual(JSON.parse(before), committed);
  assert.equal(fs.readFileSync(path.join(incomplete, 'working.json'), 'utf8'), '{"candidate":true}');
});

test('concurrent cross-process rebuilds publish one valid deterministic projection', async (t) => {
  const roots = makeRoots(t);
  writeIdea(roots, 'idea-a', { createdAt: 10 });
  writeIdea(roots, 'idea-b', { createdAt: 20 });
  writeProject(roots, 'project-a', { createdAt: 30 });
  const moduleUrl = pathToFileURL(
    path.resolve('src/core/persistence/GlobalContentIndex.js'),
  ).href;

  await Promise.all(
    Array.from({ length: 8 }, () => runChildRebuild(moduleUrl, roots)),
  );

  const index = createIndex(roots);
  const projection = index.read();
  assert.deepEqual(
    projection.entries.map(({ type, id }) => `${type}:${id}`),
    ['idea:idea-a', 'idea:idea-b', 'project:project-a'],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(index.indexPath, 'utf8')), projection);
  assert.equal(fs.existsSync(index.lockPath), false);
  assert.deepEqual(fs.readdirSync(roots.globalDir), ['index.json']);
});
