import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256, canonicalStringify } from '../src/core/contracts/ArtifactRef.js';

import {
  ClaimStore,
  claimIntegrityDigest,
  deriveClaimId,
} from '../src/domains/claims/index.js';

const digest = (hex) => `sha256:${hex.repeat(64)}`;

function createClock(start = '2026-09-05T00:00:00.000Z') {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value).toISOString();
    value += 1_000;
    return current;
  };
}

function evidence(reportVersionId = 'report-1', hex = 'a') {
  return {
    reportVersionId,
    contentDigest: digest(hex),
    fingerprint: digest(hex === 'f' ? 'e' : 'f'),
  };
}

function claimBody({ reportVersionId = 'report-1', hex = 'a', assertion = 'Cloud demand will increase Acme revenue over the next year.' } = {}) {
  return {
    assertion,
    subject: 'Acme cloud revenue',
    tickers: ['ACME'],
    rationale: 'Enterprise cloud migrations should expand contracted recurring revenue.',
    verification: { pointAt: '2027-09-30T00:00:00.000Z' },
    metric: 'Year-over-year cloud revenue growth',
    acceptanceCondition: 'Reported cloud revenue growth is at least 15%.',
    invalidationCondition: 'Reported cloud revenue growth is below 5% for two quarters.',
    evidence: [evidence(reportVersionId, hex)],
  };
}

function addAction(actionId, body = claimBody()) {
  return {
    actionId,
    action: 'ADD',
    rationale: 'No similar assertion exists in the frozen Claim table.',
    claim: body,
  };
}

function publicationAuthority() {
  const completed = new Map();
  return {
    reader: (publicationId) => completed.get(publicationId) || null,
    complete(staged) {
      const marker = {
        publicationId: staged.publicationId,
        claimPublicationDigest: staged.publicationDigest,
      };
      completed.set(staged.publicationId, marker);
      return marker;
    },
  };
}

function makeStore(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-library-v1-'));
  const authority = publicationAuthority();
  const publicationReader = options.publicationReader ?? authority.reader;
  const storeOptions = { ...options };
  delete storeOptions.publicationReader;
  return {
    rootDir,
    authority,
    completePublication: authority.complete,
    store: new ClaimStore({
      rootDir,
      now: createClock(),
      ...storeOptions,
      publicationReader,
    }),
  };
}

test('staged Claim records require one external Worldview run publication marker', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-library-private-v1-'));
  const store = new ClaimStore({ rootDir, now: createClock() });
  const staged = store.stageActions({
    originatingRunId: 'run-1',
    publicationId: 'publication-1',
    eligibleEvidence: [evidence()],
    actions: [addAction('action-1')],
  });

  assert.equal(staged.status, 'staged');
  assert.equal(staged.replayed, false);
  assert.equal(staged.acceptedActions.length, 1);
  assert.equal(staged.rejectedActions.length, 0);
  assert.equal(staged.acceptedActions[0].resultClaim.claimId, deriveClaimId('run-1', 'action-1'));
  assert.deepEqual(store.list(), { schemaVersion: 'claim-library-list.v1', claims: [], nextCursor: null });
  assert.equal(store.get(deriveClaimId('run-1', 'action-1')), null);
  assert.deepEqual(store.actions().actions, []);
  assert.equal(store.publication('publication-1'), null);
  assert.equal(typeof store.markPublicationCompleted, 'undefined');

  const prepared = store.getStagedPublication('publication-1');
  assert.equal(prepared.publicationDigest, staged.publicationDigest);
  assert.equal(prepared.claims.length, 1);

  const authority = publicationAuthority();
  store.bindPublicationReader(authority.reader);
  authority.complete(staged);
  assert.equal(store.publication('publication-1').publicationDigest, staged.publicationDigest);

  const claim = store.get(deriveClaimId('run-1', 'action-1'));
  assert.equal(claim.contract, 'claim.v1');
  assert.equal(claim.version, 1);
  assert.equal(claim.originatingRunId, 'run-1');
  assert.equal(claim.publicationId, 'publication-1');
  assert.equal(Object.isFrozen(claim), true);
  assert.equal(store.list().claims.length, 1);
  const history = store.history(claim.claimId);
  assert.deepEqual(history.versions.map((item) => item.version), [1]);
  assert.deepEqual(history.actions.map((item) => item.action), ['ADD']);
  assert.deepEqual(history.rejections, []);

  const replay = store.stageActions({
    originatingRunId: 'run-1',
    publicationId: 'publication-1',
    eligibleEvidence: [evidence()],
    actions: [addAction('action-1')],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.publicationDigest, staged.publicationDigest);
  assert.equal(store.history(claim.claimId).versions.length, 1);
});


test('per-item validation uses ordered first-valid-wins without semantic matching or unrelated blocking', () => {
  const { store, completePublication } = makeStore();
  const initial = store.stageActions({
    originatingRunId: 'run-initial',
    publicationId: 'publication-initial',
    eligibleEvidence: [evidence()],
    actions: [
      addAction('add-a'),
      addAction('add-b'),
    ],
  });
  completePublication(initial);
  const claimA = deriveClaimId('run-initial', 'add-a');
  const claimB = deriveClaimId('run-initial', 'add-b');
  assert.notEqual(claimA, claimB);
  assert.equal(store.list({ limit: 10_000 }).claims.length, 2);

  const newEvidence = evidence('report-2', 'b');
  const mixed = store.stageActions({
    originatingRunId: 'run-mixed',
    publicationId: 'publication-mixed',
    eligibleEvidence: [newEvidence],
    actions: [
      {
        actionId: 'invalid-first',
        action: 'UPDATE',
        rationale: 'This item cites evidence that was not fully read.',
        target: { claimId: claimA, expectedVersion: 1 },
        claim: claimBody({ reportVersionId: 'report-unread', hex: 'c' }),
      },
      {
        actionId: 'valid-second',
        action: 'UPDATE',
        rationale: 'The newly read report materially changes the assertion.',
        target: { claimId: claimA, expectedVersion: 1 },
        claim: {
          ...claimBody({ assertion: 'Cloud demand will increase Acme revenue faster than previously expected.' }),
          evidence: [evidence(), newEvidence],
        },
      },
      {
        actionId: 'conflict-third',
        action: 'NOOP',
        rationale: 'This later action conflicts with the accepted target action.',
        target: { claimId: claimA, expectedVersion: 1 },
        evidence: [newEvidence],
      },
      {
        actionId: 'unrelated-noop',
        action: 'NOOP',
        rationale: 'The new report leaves the other Claim unchanged.',
        target: { claimId: claimB, expectedVersion: 1 },
        evidence: [newEvidence],
      },
      addAction('unrelated-add', claimBody({ reportVersionId: 'report-2', hex: 'b' })),
      {
        actionId: 'legacy-invalid',
        action: 'ADD',
        rationale: 'Legacy fields are not accepted.',
        claim: { ...claimBody({ reportVersionId: 'report-2', hex: 'b' }), profile: 'recommendation' },
      },
    ],
  });

  assert.deepEqual(mixed.acceptedActions.map((item) => item.actionIndex), [1, 3, 4]);
  assert.deepEqual(mixed.rejectedActions.map((item) => item.code), [
    'CLAIM_ACTION_EVIDENCE_INELIGIBLE',
    'CLAIM_ACTION_TARGET_CONFLICT',
    'CLAIM_UNKNOWN_FIELD',
  ]);
  assert.equal(store.get(claimA).version, 1);
  assert.equal(store.rejections().rejections.length, 0);

  completePublication(mixed);
  assert.equal(store.get(claimA).version, 2);
  assert.equal(store.get(claimA, { version: 1 }).version, 1);
  assert.equal(store.get(claimB).version, 1);
  assert.equal(store.get(deriveClaimId('run-mixed', 'unrelated-add')).version, 1);
  assert.deepEqual(store.history(claimA).versions.map((item) => item.version), [2, 1]);
  assert.deepEqual(store.history(claimA).actions.map((item) => item.action), ['UPDATE', 'ADD']);
  assert.deepEqual(store.rejections({ publicationId: 'publication-mixed' }).rejections.map((item) => item.code), [
    'CLAIM_ACTION_EVIDENCE_INELIGIBLE',
    'CLAIM_ACTION_TARGET_CONFLICT',
    'CLAIM_UNKNOWN_FIELD',
  ]);
});

test('Claim history bounds and independently paginates immutable versions, actions, and rejections', () => {
  const { store, completePublication } = makeStore();
  const initial = store.stageActions({
    originatingRunId: 'run-history-initial',
    publicationId: 'publication-history-initial',
    eligibleEvidence: [evidence()],
    actions: [addAction('history-add')],
  });
  completePublication(initial);
  const claimId = deriveClaimId('run-history-initial', 'history-add');
  const newEvidence = evidence('report-history-update', 'b');
  const update = store.stageActions({
    originatingRunId: 'run-history-update',
    publicationId: 'publication-history-update',
    eligibleEvidence: [newEvidence],
    actions: [
      {
        actionId: 'history-update',
        action: 'UPDATE',
        rationale: 'The new evidence changes the assertion.',
        target: { claimId, expectedVersion: 1 },
        claim: {
          ...claimBody({ assertion: 'Cloud demand will increase Acme revenue faster than the prior Claim expected.' }),
          evidence: [evidence(), newEvidence],
        },
      },
      ...Array.from({ length: 51 }, (_, index) => ({
        actionId: `history-conflict-${index + 1}`,
        action: 'NOOP',
        rationale: 'A prior valid action already targeted this Claim in the ordered publication.',
        target: { claimId, expectedVersion: 1 },
        evidence: [newEvidence],
      })),
    ],
  });
  assert.equal(update.acceptedActions.length, 1);
  assert.equal(update.rejectedActions.length, 51);
  completePublication(update);

  const defaultPage = store.history(claimId);
  assert.deepEqual(defaultPage.totalCounts, { versions: 2, actions: 2, rejections: 51 });
  assert.equal(defaultPage.versions.length, 2);
  assert.equal(defaultPage.actions.length, 2);
  assert.equal(defaultPage.rejections.length, 50);
  assert.equal(defaultPage.nextCursors.versions, null);
  assert.equal(defaultPage.nextCursors.actions, null);
  assert.ok(defaultPage.nextCursors.rejections);

  const firstPage = store.history(claimId, {
    versionsLimit: 1,
    actionsLimit: 1,
    rejectionsLimit: 1,
  });
  assert.deepEqual(firstPage.versions.map((item) => item.version), [2]);
  assert.deepEqual(firstPage.actions.map((item) => item.action), ['UPDATE']);
  assert.equal(firstPage.rejections[0].actionId, 'history-conflict-51');
  assert.ok(firstPage.nextCursors.versions);
  assert.ok(firstPage.nextCursors.actions);
  assert.ok(firstPage.nextCursors.rejections);

  const insertedEvidence = evidence('report-history-inserted', 'c');
  const inserted = store.stageActions({
    originatingRunId: 'run-history-inserted',
    publicationId: 'publication-history-inserted',
    eligibleEvidence: [insertedEvidence],
    actions: [
      {
        actionId: 'history-inserted-update',
        action: 'UPDATE',
        rationale: 'A later publication must not shift existing history cursors.',
        target: { claimId, expectedVersion: 2 },
        claim: {
          ...claimBody({ assertion: 'A later Claim version was published after the first history page.' }),
          evidence: [evidence(), newEvidence, insertedEvidence],
        },
      },
      {
        actionId: 'history-inserted-conflict',
        action: 'NOOP',
        rationale: 'This later rejection must not shift the existing rejection cursor.',
        target: { claimId, expectedVersion: 2 },
        evidence: [insertedEvidence],
      },
    ],
  });
  completePublication(inserted);

  const secondPage = store.history(claimId, {
    versionsLimit: 1,
    versionsCursor: firstPage.nextCursors.versions,
    actionsLimit: 1,
    actionsCursor: firstPage.nextCursors.actions,
    rejectionsLimit: 50,
    rejectionsCursor: defaultPage.nextCursors.rejections,
  });
  assert.deepEqual(secondPage.versions.map((item) => item.version), [1]);
  assert.deepEqual(secondPage.actions.map((item) => item.action), ['ADD']);
  assert.equal(secondPage.rejections.length, 1);
  assert.equal(secondPage.nextCursors.versions, null);
  assert.equal(secondPage.nextCursors.actions, null);
  assert.equal(secondPage.nextCursors.rejections, null);

  assert.throws(
    () => store.history(claimId, { versionsLimit: 101 }),
    (error) => error.code === 'CLAIM_INVALID_LIMIT'
      && error.message === 'versionsLimit must be an integer between 1 and 100',
  );
  assert.throws(
    () => store.history(claimId, { actionsCursor: 'not-a-cursor' }),
    (error) => error.code === 'CLAIM_INVALID_CURSOR'
      && error.message === 'actionsCursor is invalid',
  );
});

test('stale targets and ineligible evidence are rejected without changing current Claim versions', () => {
  const { store, completePublication } = makeStore();
  const first = store.stageActions({
    originatingRunId: 'run-first',
    publicationId: 'publication-first',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-first')],
  });
  completePublication(first);
  const claimId = deriveClaimId('run-first', 'add-first');

  const rejected = store.stageActions({
    originatingRunId: 'run-stale',
    publicationId: 'publication-stale',
    eligibleEvidence: [evidence('report-2', 'b')],
    actions: [
      {
        actionId: 'stale-update',
        action: 'UPDATE',
        rationale: 'The target version is stale.',
        target: { claimId, expectedVersion: 2 },
        claim: claimBody({ reportVersionId: 'report-2', hex: 'b' }),
      },
      {
        actionId: 'outside-ledger-noop',
        action: 'NOOP',
        rationale: 'This evidence was not read in the run.',
        target: { claimId, expectedVersion: 1 },
        evidence: [evidence('report-3', 'c')],
      },
    ],
  });
  assert.deepEqual(rejected.rejectedActions.map((item) => item.code), [
    'CLAIM_ACTION_STALE_TARGET',
    'CLAIM_ACTION_EVIDENCE_INELIGIBLE',
  ]);
  completePublication(rejected);
  assert.equal(store.get(claimId).version, 1);
  assert.equal(store.history(claimId).versions.length, 1);
});

test('a bound Worldview publication reader controls visibility and binds the exact Claim digest', () => {
  const completed = new Map();
  const { store } = makeStore({
    publicationReader: (publicationId) => completed.get(publicationId) || null,
  });
  const staged = store.stageActions({
    originatingRunId: 'run-external',
    publicationId: 'publication-external',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-external')],
  });
  assert.equal(store.list().claims.length, 0);

  completed.set('publication-external', true);
  assert.throws(
    () => store.list(),
    (error) => error.code === 'CLAIM_PUBLICATION_MARKER_MISMATCH',
  );
  completed.set('publication-external', { publicationId: 'publication-external' });
  assert.throws(
    () => store.list(),
    (error) => error.code === 'CLAIM_PUBLICATION_MARKER_MISMATCH',
  );

  completed.set('publication-external', {
    publicationId: 'publication-external',
    claimPublicationDigest: staged.publicationDigest,
  });
  assert.equal(store.list().claims.length, 1);

  completed.set('publication-external', {
    publicationId: 'publication-other',
    claimPublicationDigest: staged.publicationDigest,
  });
  assert.throws(
    () => store.list(),
    (error) => error.code === 'CLAIM_PUBLICATION_MARKER_MISMATCH',
  );
  completed.set('publication-external', {
    publicationId: 'publication-external',
    claimPublicationDigest: digest('d'),
  });
  assert.throws(
    () => store.list(),
    (error) => error.code === 'CLAIM_PUBLICATION_MARKER_MISMATCH',
  );
});


test('the bound Worldview publication reader can revoke and restore Claim visibility', () => {
  const authority = publicationAuthority();
  const { store } = makeStore({ publicationReader: authority.reader });
  const staged = store.stageActions({
    originatingRunId: 'run-authority',
    publicationId: 'publication-authority',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-authority')],
  });
  authority.complete(staged);
  assert.equal(store.list().claims.length, 1);

  store.bindPublicationReader(() => false);
  assert.equal(store.list().claims.length, 0);
  store.bindPublicationReader(authority.reader);
  assert.equal(store.list().claims.length, 1);
});


test('Claim Library fails closed for idempotency conflicts, tampering, unsafe paths, and symlinks', () => {
  const { rootDir, store, completePublication } = makeStore();
  const staged = store.stageActions({
    originatingRunId: 'run-safe',
    publicationId: 'publication-safe',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-safe')],
  });
  assert.throws(
    () => store.stageActions({
      originatingRunId: 'run-safe',
      publicationId: 'publication-safe',
      eligibleEvidence: [evidence()],
      actions: [addAction('different-action')],
    }),
    (error) => error.code === 'CLAIM_PUBLICATION_IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => store.get('../escape'),
    (error) => error.code === 'CLAIM_UNSAFE_ID',
  );

  completePublication(staged);
  const claimId = deriveClaimId('run-safe', 'add-safe');
  const claimFile = path.join(rootDir, 'publications', 'publication-safe', 'claims', `${claimId}.v1.json`);
  const record = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  fs.writeFileSync(claimFile, `${JSON.stringify({ ...record, assertion: 'Tampered assertion.' })}\n`);
  assert.throws(
    () => store.get(claimId),
    (error) => error.code === 'CLAIM_STORAGE_INTEGRITY_MISMATCH',
  );

  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-library-symlink-'));
  fs.symlinkSync(rootDir, path.join(symlinkRoot, 'claims-link'));
  assert.throws(
    () => new ClaimStore({ rootDir: path.join(symlinkRoot, 'claims-link') }),
    (error) => error.code === 'STORAGE_DIRECTORY_SYMLINK',
  );
});




test('zero actions and NOOP publish audit without creating a Claim version', () => {
  const { store, completePublication } = makeStore();
  const empty = store.stageActions({
    originatingRunId: 'run-empty',
    publicationId: 'publication-empty',
    actions: [],
    eligibleEvidence: [],
  });
  assert.equal(empty.claimVersionCount, 0);
  assert.equal(empty.acceptedActions.length, 0);
  assert.equal(empty.rejectedActions.length, 0);
  completePublication(empty);
  assert.equal(store.status().publicationCount, 1);
  assert.equal(store.status().claimCount, 0);

  const added = store.stageActions({
    originatingRunId: 'run-add-noop',
    publicationId: 'publication-add-noop',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-noop')],
  });
  completePublication(added);
  const claimId = deriveClaimId('run-add-noop', 'add-noop');
  const noop = store.stageActions({
    originatingRunId: 'run-noop',
    publicationId: 'publication-noop',
    eligibleEvidence: [evidence('report-2', 'b')],
    actions: [{
      actionId: 'noop-existing',
      action: 'NOOP',
      rationale: 'The new evidence leaves the assertion materially unchanged.',
      target: { claimId, expectedVersion: 1 },
      evidence: [evidence('report-2', 'b')],
    }],
  });
  assert.equal(noop.claimVersionCount, 0);
  assert.equal(noop.acceptedActions[0].action, 'NOOP');
  completePublication(noop);
  assert.deepEqual(store.history(claimId).versions.map((item) => item.version), [1]);
  assert.deepEqual(store.history(claimId).actions.map((item) => item.action), ['NOOP', 'ADD']);
});

test('duplicate action IDs and later target conflicts have stable first-wins rejection reasons', () => {
  const { store, completePublication } = makeStore();
  const first = store.stageActions({
    originatingRunId: 'run-duplicate-base',
    publicationId: 'publication-duplicate-base',
    eligibleEvidence: [evidence()],
    actions: [addAction('base')],
  });
  completePublication(first);
  const claimId = deriveClaimId('run-duplicate-base', 'base');
  const newEvidence = evidence('report-2', 'b');
  const staged = store.stageActions({
    originatingRunId: 'run-duplicates',
    publicationId: 'publication-duplicates',
    eligibleEvidence: [newEvidence],
    actions: [
      {
        actionId: 'first-target',
        action: 'NOOP',
        rationale: 'The new evidence leaves the Claim unchanged.',
        target: { claimId, expectedVersion: 1 },
        evidence: [newEvidence],
      },
      {
        actionId: 'first-target',
        action: 'ADD',
        rationale: 'A duplicate action identity must not create another Claim.',
        claim: claimBody({ reportVersionId: 'report-2', hex: 'b' }),
      },
      {
        actionId: 'later-target',
        action: 'UPDATE',
        rationale: 'The accepted first target action wins even if this body is malformed.',
        target: { claimId, expectedVersion: 1 },
        claim: { assertion: 'Incomplete body.' },
      },
    ],
  });
  assert.deepEqual(staged.acceptedActions.map((item) => item.action), ['NOOP']);
  assert.deepEqual(staged.rejectedActions.map((item) => item.code), [
    'CLAIM_ACTION_DUPLICATE_ID',
    'CLAIM_ACTION_TARGET_CONFLICT',
  ]);
});



test('stagePublication joins full-read evidence to the frozen manifest and checks the frozen Claim snapshot', () => {
  const { store, completePublication } = makeStore();
  const snapshot = store.snapshot();
  const staged = store.stagePublication({
    runId: 'run-publication-api',
    publicationId: 'publication-api',
    rawClaimActions: [addAction('add-publication-api')],
    selectedFullReads: [{ reportVersionId: 'report-1', contentDigest: digest('a'), verified: true }],
    frozenReportManifest: { items: [evidence()] },
    frozenClaims: snapshot,
    publishedAt: '2026-09-05T00:00:01.000Z',
  });
  assert.deepEqual(staged.claimPublicationRef, {
    publicationId: 'publication-api',
    manifestDigest: staged.publicationDigest,
  });
  assert.equal(staged.baseClaimSnapshotDigest, snapshot.snapshotDigest);
  assert.throws(
    () => store.stagePublication({
      runId: 'run-unverified',
      publicationId: 'publication-unverified',
      rawClaimActions: [],
      selectedFullReads: [{ reportVersionId: 'report-1', contentDigest: digest('a'), verified: false }],
      frozenReportManifest: { items: [evidence()] },
      frozenClaims: snapshot,
    }),
    (error) => error.code === 'CLAIM_ELIGIBLE_EVIDENCE_CONFLICT',
  );
  assert.throws(
    () => store.stagePublication({
      runId: 'run-outside-manifest',
      publicationId: 'publication-outside-manifest',
      rawClaimActions: [],
      selectedFullReads: [{ ...evidence('report-outside', 'b'), verified: true }],
      frozenReportManifest: { items: [evidence()] },
      frozenClaims: snapshot,
    }),
    (error) => error.code === 'CLAIM_ELIGIBLE_EVIDENCE_CONFLICT',
  );

  const other = store.stageActions({
    originatingRunId: 'run-other',
    publicationId: 'publication-other',
    actions: [addAction('add-other')],
    eligibleEvidence: [evidence()],
    publishedAt: '2026-09-05T00:00:02.000Z',
  });
  completePublication(other);
  assert.throws(
    () => store.stagePublication({
      runId: 'run-stale-snapshot',
      publicationId: 'publication-stale-snapshot',
      rawClaimActions: [],
      selectedFullReads: [],
      frozenReportManifest: { items: [] },
      frozenClaims: snapshot,
      publishedAt: '2026-09-05T00:00:03.000Z',
    }),
    (error) => error.code === 'CLAIM_FROZEN_STATE_MISMATCH',
  );
});


test('digest-valid but incoherent stored action/version graphs fail closed', () => {
  const { rootDir, store } = makeStore();
  const staged = store.stageActions({
    originatingRunId: 'run-graph',
    publicationId: 'publication-graph',
    actions: [addAction('add-graph')],
    eligibleEvidence: [evidence()],
  });
  const publicationDir = path.join(rootDir, 'publications', 'publication-graph');
  const manifestFile = path.join(publicationDir, 'publication.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const actionEntry = manifest.objects.find((entry) => entry.kind === 'action');
  const actionFile = path.join(publicationDir, ...actionEntry.relativePath.split('/'));
  const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
  action.resultClaim.version = 2;
  action.integrityDigest = claimIntegrityDigest(action);
  fs.writeFileSync(actionFile, `${canonicalStringify(action)}\n`);
  actionEntry.objectDigest = action.integrityDigest;
  const { publicationDigest: _publicationDigest, ...publicationBase } = manifest;
  manifest.publicationDigest = canonicalSha256(publicationBase);
  fs.writeFileSync(manifestFile, `${canonicalStringify(manifest)}\n`);

  assert.equal(staged.claimVersionCount, 1);
  assert.throws(
    () => store.getStagedPublication('publication-graph'),
    (error) => error.code === 'CLAIM_STORAGE_INTEGRITY_MISMATCH',
  );
});

test('cross-process staging is single-writer and replay-safe', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-library-lock-'));
  const input = {
    originatingRunId: 'run-concurrent',
    publicationId: 'publication-concurrent',
    publishedAt: '2026-09-05T01:00:00.000Z',
    eligibleEvidence: [evidence()],
    actions: [addAction('add-concurrent')],
  };
  const storeUrl = new URL('../src/domains/claims/ClaimStore.js', import.meta.url).href;
  const script = `
    import { ClaimStore } from ${JSON.stringify(storeUrl)};
    const store = new ClaimStore({ rootDir: process.env.CLAIM_ROOT, now: () => '2026-09-05T02:00:00.000Z' });
    process.stdout.write(JSON.stringify(store.stageActions(JSON.parse(process.env.CLAIM_INPUT))));
  `;
  const env = { ...process.env, CLAIM_ROOT: rootDir, CLAIM_INPUT: JSON.stringify(input) };
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(stderr || `child exited ${code}`));
    });
  })));

  assert.equal(new Set(results.map((result) => result.publicationDigest)).size, 1);
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  const completed = new Map();
  const store = new ClaimStore({
    rootDir,
    now: createClock(),
    publicationReader: (publicationId) => completed.get(publicationId) || null,
  });
  const publicationDigest = results[0].publicationDigest;
  completed.set('publication-concurrent', {
    publicationId: 'publication-concurrent',
    claimPublicationDigest: publicationDigest,
  });
  assert.equal(store.history(deriveClaimId('run-concurrent', 'add-concurrent')).versions.length, 1);
  assert.equal(fs.existsSync(path.join(rootDir, '.locks', 'store.lock')), false);
});
