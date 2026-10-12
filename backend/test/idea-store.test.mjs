import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FileIdeaStore,
  IDEA_RECORD_SCHEMA_VERSION,
  LegacyIdeaReadOnlyError,
} from '../src/domains/ideas/IdeaStore.js';

function fixture(t, {
  legacy = [],
  index = { rebuild() {} },
  ids = ['idea_one', 'idea_two', 'idea_three'],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ideasDir = path.join(root, 'idea-generation', 'ideas');
  let timestamp = 1000;
  let idIndex = 0;
  const store = new FileIdeaStore({
    ideasDir,
    legacyStore: { getIdeas: () => structuredClone(legacy) },
    index,
    now: () => timestamp++,
    idFactory: () => ids[idIndex++],
  });
  return { root, ideasDir, store };
}

function idea(title, ticker = 'PWR') {
  return {
    title,
    sentence: title,
    theme: 'power',
    heat: 80,
    rationale: 'Grid investment',
    tickers: [ticker],
    catalyst: 'Capex',
    edge: 'Underestimated demand',
    sourceAgents: ['unit-source'],
    nested: { preserved: true },
    status: 'new',
  };
}

test('folder-backed Idea CRUD preserves full bodies, lineage, timestamps, and exact commits', (t) => {
  let rebuilds = 0;
  const { ideasDir, store } = fixture(t, {
    index: { rebuild() { rebuilds += 1; } },
  });
  const lineage = {
    sourceRunId: 'idea_run_1',
    sourceSnapshotId: `idea-run-input-snapshot:${'a'.repeat(64)}`,
  };

  const committed = store.addIdeas([
    idea('Grid equipment opportunity', 'GEV'),
    idea('Electrical component opportunity', 'ETN'),
  ], lineage);

  assert.deepEqual(committed.map((record) => record.id), ['idea_one', 'idea_two']);
  assert.equal(rebuilds, 1);
  assert.equal(committed[0].sourceRunId, lineage.sourceRunId);
  assert.equal(committed[0].sourceSnapshotId, lineage.sourceSnapshotId);
  assert.deepEqual(committed[0].nested, { preserved: true });
  assert.equal(committed[0].createdAt, 1000);
  assert.equal(committed[0].updatedAt, 1000);
  assert.match(committed[0].contentDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(committed[0].contentRef, 'idea-generation/ideas/idea_one');

  const envelope = JSON.parse(fs.readFileSync(
    path.join(ideasDir, 'idea_one', 'idea.json'),
    'utf8',
  ));
  assert.equal(envelope.schemaVersion, IDEA_RECORD_SCHEMA_VERSION);
  assert.equal(envelope.title, envelope.body.title);
  assert.equal(envelope.status, envelope.body.status);
  assert.equal(envelope.id, envelope.body.id);
  assert.equal(envelope.sourceRunId, envelope.body.sourceRunId);

  assert.deepEqual(
    store.addIdeas([idea('Grid equipment opportunity', 'GEV')], lineage),
    [],
  );
  assert.equal(rebuilds, 1);

  const updated = store.updateIdea('idea_one', {
    status: 'added',
    rationale: 'Updated rationale',
  });
  assert.equal(updated.status, 'added');
  assert.equal(updated.rationale, 'Updated rationale');
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.updatedAt, 1002);
  assert.equal(rebuilds, 2);

  const remaining = store.removeIdea('idea_one');
  assert.deepEqual(remaining.map((record) => record.id), ['idea_two']);
  assert.equal(fs.existsSync(path.join(ideasDir, 'idea_one')), false);
  assert.equal(rebuilds, 3);
});

test('legacy Ideas are query-time read-only compatibility and never create content or projection', (t) => {
  let rebuilds = 0;
  const legacy = [{
    id: 'idea_legacy',
    title: 'Legacy opportunity',
    theme: 'legacy',
    createdAt: 12,
    status: 'new',
  }];
  const { ideasDir, store } = fixture(t, {
    legacy,
    index: { rebuild() { rebuilds += 1; } },
  });

  assert.equal(fs.existsSync(ideasDir), false);
  assert.deepEqual(store.getIdeas(), legacy);
  assert.deepEqual(store.getIdea('idea_legacy'), legacy[0]);
  assert.equal(store.isWritable('idea_legacy'), false);
  assert.equal(fs.existsSync(ideasDir), false);
  assert.equal(rebuilds, 0);

  for (const operation of [
    () => store.updateIdea('idea_legacy', { status: 'added' }),
    () => store.removeIdea('idea_legacy'),
  ]) {
    assert.throws(operation, (error) => (
      error instanceof LegacyIdeaReadOnlyError
      && error.code === 'LEGACY_IDEA_READ_ONLY'
      && error.ideaId === 'idea_legacy'
    ));
  }
  assert.deepEqual(legacy, [{
    id: 'idea_legacy',
    title: 'Legacy opportunity',
    theme: 'legacy',
    createdAt: 12,
    status: 'new',
  }]);
  assert.equal(rebuilds, 0);
});

test('folder content wins legacy id/title collisions without copying legacy records', (t) => {
  const legacy = [];
  const { ideasDir, store } = fixture(t, { legacy });
  const [created] = store.addIdeas([{ ...idea('Owned title'), id: 'idea_owned' }]);

  legacy.push(
    { id: created.id, title: 'Conflicting legacy id', createdAt: 1, status: 'new' },
    { id: 'idea_legacy_title', title: created.title, createdAt: 2, status: 'new' },
    { id: 'idea_visible', title: 'Visible legacy title', createdAt: 3, status: 'new' },
  );

  assert.deepEqual(
    store.getIdeas().map((record) => record.id),
    ['idea_owned', 'idea_visible'],
  );
  assert.equal(fs.readdirSync(ideasDir).length, 1);
});

test('projection failure cannot roll back committed Idea content', (t) => {
  const { ideasDir, store } = fixture(t, {
    index: { rebuild() { throw new Error('injected index failure'); } },
  });

  const [committed] = store.addIdeas([idea('Content survives projection failure')]);
  assert.equal(committed.id, 'idea_one');
  assert.equal(fs.existsSync(path.join(ideasDir, committed.id, 'idea.json')), true);

  let rebuilds = 0;
  const restarted = new FileIdeaStore({
    ideasDir,
    legacyStore: { getIdeas: () => [] },
    index: { rebuild() { rebuilds += 1; } },
  });
  assert.equal(restarted.getIdea(committed.id).title, committed.title);
  restarted.updateIdea(committed.id, { status: 'added' });
  assert.equal(rebuilds, 1);
});

test('unsafe identities, immutable mutations, corruption, and symlinks fail closed', (t) => {
  const { root, ideasDir, store } = fixture(t);
  for (const id of ['../escape', '..', '.', '/absolute', 'nested/id', 'nested\\id', 'bad\0id']) {
    assert.throws(() => store.getIdea(id), (error) => error?.code === 'UNSAFE_IDEA_ID');
  }

  const [created] = store.addIdeas([idea('Boundary checks')]);
  for (const patch of [
    { id: 'idea_forged' },
    { createdAt: 1 },
    { updatedAt: 2 },
    { sourceRunId: 'idea_run_forged' },
    { sourceSnapshotId: 'snapshot_forged' },
  ]) {
    assert.throws(
      () => store.updateIdea(created.id, patch),
      (error) => error?.code === 'IMMUTABLE_IDEA_FIELD',
    );
  }

  const anchor = path.join(ideasDir, created.id, 'idea.json');
  const valid = fs.readFileSync(anchor, 'utf8');
  fs.writeFileSync(anchor, '{broken');
  assert.throws(
    () => store.getIdea(created.id),
    (error) => error?.code === 'INVALID_IDEA_RECORD',
  );
  fs.writeFileSync(anchor, valid);

  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, valid);
  fs.unlinkSync(anchor);
  fs.symlinkSync(outside, anchor);
  assert.throws(
    () => store.getIdea(created.id),
    (error) => error?.code === 'IDEA_SYMLINK_DENIED',
  );
  fs.unlinkSync(anchor);
  fs.writeFileSync(anchor, valid);

  const outsideDir = path.join(root, 'outside-dir');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(ideasDir, 'idea_link'), 'dir');
  assert.throws(
    () => store.getIdeas(),
    (error) => error?.code === 'IDEA_SYMLINK_DENIED',
  );

  const outsideGeneration = path.join(root, 'outside-generation');
  fs.mkdirSync(outsideGeneration);
  const configuredData = path.join(root, 'configured-data');
  fs.mkdirSync(configuredData);
  const linkedGeneration = path.join(configuredData, 'idea-generation');
  fs.symlinkSync(outsideGeneration, linkedGeneration, 'dir');
  const generationLinkedStore = new FileIdeaStore({
    ideasDir: path.join(linkedGeneration, 'ideas'),
    legacyStore: { getIdeas: () => [] },
    index: null,
    idFactory: () => 'idea_parent_link',
  });
  assert.throws(
    () => generationLinkedStore.addIdeas([idea('Parent symlink denial')]),
    (error) => error?.code === 'IDEA_SYMLINK_DENIED',
  );
  assert.equal(fs.existsSync(path.join(outsideGeneration, 'ideas')), false);

  const outsideData = path.join(root, 'outside-data');
  fs.mkdirSync(outsideData);
  const linkedData = path.join(root, 'linked-data');
  fs.symlinkSync(outsideData, linkedData, 'dir');
  const dataLinkedStore = new FileIdeaStore({
    ideasDir: path.join(linkedData, 'idea-generation', 'ideas'),
    legacyStore: { getIdeas: () => [] },
    index: null,
    idFactory: () => 'idea_data_link',
  });
  assert.throws(
    () => dataLinkedStore.addIdeas([idea('Data root symlink denial')]),
    (error) => error?.code === 'IDEA_SYMLINK_DENIED',
  );
  assert.equal(fs.existsSync(path.join(outsideData, 'idea-generation')), false);
});
