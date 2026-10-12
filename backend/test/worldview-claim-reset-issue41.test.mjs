import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WorldviewRunPublicationStore } from '../src/workflows/worldview/WorldviewRunPublicationStore.js';
import {
  acquireCanonicalWorldviewActiveSequenceGuard,
  canonicalWorldviewActiveSequenceGuardPath,
} from '../src/workflows/worldview/worldviewActiveSequenceGuard.js';

const SCRIPT_FILE = fileURLToPath(new URL('../scripts/resetWorldviewClaimAuthorities.mjs', import.meta.url));
const ACKNOWLEDGEMENT = 'RESET_LEGACY_CLAIM_AND_CANONICAL_WORLDVIEW_AUTHORITIES';

function runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot, extraArgs = [] }) {
  return spawnSync(process.execPath, [
    SCRIPT_FILE,
    '--claims-root', claimsRoot,
    '--canonical-worldview-root', canonicalWorldviewRoot,
    '--acknowledge-owner-authorized-reset', ACKNOWLEDGEMENT,
    ...extraArgs,
  ], {
    encoding: 'utf8',
    env: { ...process.env, FIN_DATA_DIR: dataRoot },
  });
}

test('explicit dry-run reports only authority root counts and changes nothing', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(path.join(claimsRoot, 'claim.json'), 'CLAIM_SECRET_CONTENT');
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'worldview.json'), 'WORLDVIEW_SECRET_CONTENT');

  const result = runReset({
    claimsRoot,
    canonicalWorldviewRoot,
    dataRoot,
    extraArgs: ['--dry-run'],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    mode: 'dry-run',
    roots: {
      claims: { root: claimsRoot, existed: true, entryCount: 1 },
      canonicalWorldview: { root: canonicalWorldviewRoot, existed: true, entryCount: 1 },
    },
    totalEntryCount: 2,
  });
  assert.equal(fs.readFileSync(path.join(claimsRoot, 'claim.json'), 'utf8'), 'CLAIM_SECRET_CONTENT');
  assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'worldview.json'), 'utf8'), 'WORLDVIEW_SECRET_CONTENT');
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /claim\.json|worldview\.json|CLAIM_SECRET_CONTENT|WORLDVIEW_SECRET_CONTENT/u,
  );
});


test('owner-authorized reset deletes only the two authority roots and is idempotent', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  fs.mkdirSync(path.join(claimsRoot, 'versions'), { recursive: true });
  fs.writeFileSync(path.join(claimsRoot, 'versions', 'claim.json'), 'claim');
  fs.mkdirSync(path.join(canonicalWorldviewRoot, 'versions', 'legacy_v1'), { recursive: true });
  fs.mkdirSync(path.join(canonicalWorldviewRoot, 'updates'), { recursive: true });
  fs.mkdirSync(path.join(canonicalWorldviewRoot, 'evaluations'), { recursive: true });
  fs.mkdirSync(path.join(canonicalWorldviewRoot, 'workflow-runs'), { recursive: true });
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'current.json'), JSON.stringify({ contract: 'current-worldview.v1' }));
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'versions', 'legacy_v1', 'package.json'), JSON.stringify({ contract: 'canonical-worldview-package.v1' }));
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'updates', 'legacy.json'), JSON.stringify({ contract: 'worldview-update-record.v1' }));
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'evaluations', 'legacy.json'), JSON.stringify({ contract: 'worldview-evaluation-record.v1' }));
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'workflow-runs', 'legacy.json'), JSON.stringify({ contract: 'canonical-worldview-processing.v1' }));

  const protectedSiblings = [
    'report-library',
    'projects',
    'idea-generation',
    'global',
    'portfolio',
    'traces',
    'unrelated-sibling',
  ];
  for (const sibling of protectedSiblings) {
    const siblingRoot = path.join(dataRoot, sibling);
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingRoot, 'keep.txt'), `keep-${sibling}`);
  }

  const first = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    ok: true,
    mode: 'reset',
    roots: {
      claims: { root: claimsRoot, existed: true, entryCount: 2 },
      canonicalWorldview: { root: canonicalWorldviewRoot, existed: true, entryCount: 10 },
    },
    totalEntryCount: 12,
  });
  assert.equal(fs.existsSync(claimsRoot), false);
  assert.equal(fs.existsSync(canonicalWorldviewRoot), false);
  for (const sibling of protectedSiblings) {
    assert.equal(
      fs.readFileSync(path.join(dataRoot, sibling, 'keep.txt'), 'utf8'),
      `keep-${sibling}`,
    );
  }

  const second = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), {
    ok: true,
    mode: 'reset',
    roots: {
      claims: { root: claimsRoot, existed: false, entryCount: 0 },
      canonicalWorldview: { root: canonicalWorldviewRoot, existed: false, entryCount: 0 },
    },
    totalEntryCount: 0,
  });
  for (const sibling of protectedSiblings) {
    assert.equal(
      fs.readFileSync(path.join(dataRoot, sibling, 'keep.txt'), 'utf8'),
      `keep-${sibling}`,
    );
  }
});


test('owner-authorized reset accepts empty roots and remains idempotent once they are absent', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });

  const empty = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).totalEntryCount, 0);
  assert.equal(fs.existsSync(claimsRoot), false);
  assert.equal(fs.existsSync(canonicalWorldviewRoot), false);

  const absent = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).totalEntryCount, 0);
  assert.equal(fs.existsSync(claimsRoot), false);
  assert.equal(fs.existsSync(canonicalWorldviewRoot), false);
});

test('destructive reset refuses a live canonical Worldview sequence guard without touching either authority root', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  const claimSentinel = path.join(claimsRoot, 'legacy-claim.json');
  const worldviewSentinel = path.join(canonicalWorldviewRoot, 'legacy-worldview.json');
  const guardPath = canonicalWorldviewActiveSequenceGuardPath(canonicalWorldviewRoot);
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(claimSentinel, 'keep-legacy-claim');
  fs.writeFileSync(worldviewSentinel, 'keep-legacy-worldview');
  const release = acquireCanonicalWorldviewActiveSequenceGuard({
    worldviewRoot: canonicalWorldviewRoot,
    ownerId: 'worldview_trigger_live',
    now: () => '2026-09-05T00:00:00.000Z',
  });
  t.after(release);
  const before = fs.readFileSync(guardPath, 'utf8');

  const result = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /active canonical Worldview processing sequence/u);
  assert.equal(fs.readFileSync(claimSentinel, 'utf8'), 'keep-legacy-claim');
  assert.equal(fs.readFileSync(worldviewSentinel, 'utf8'), 'keep-legacy-worldview');
  assert.equal(fs.readFileSync(guardPath, 'utf8'), before);
  assert.deepEqual(
    fs.readdirSync(dataRoot).sort(),
    ['.locks', 'canonical-worldview', 'claims'],
  );
});



test('canonical Worldview sequence guard remains exclusive when the authority root is renamed', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-sequence-guard-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const canonicalWorldviewRoot = path.join(temp, 'canonical-worldview');
  const quarantinedRoot = path.join(temp, '.canonical-worldview.reset-quarantine');
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  const release = acquireCanonicalWorldviewActiveSequenceGuard({
    worldviewRoot: canonicalWorldviewRoot,
    ownerId: 'owner-authorized-reset',
  });
  t.after(release);

  fs.renameSync(canonicalWorldviewRoot, quarantinedRoot);

  assert.throws(
    () => acquireCanonicalWorldviewActiveSequenceGuard({
      worldviewRoot: canonicalWorldviewRoot,
      ownerId: 'concurrent-worldview-trigger',
    }),
    (error) => error?.code === 'WORLDVIEW_SEQUENCE_BUSY',
  );
});

test('canonical Worldview sequence guard release does not remove a replacement owner', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-sequence-guard-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const canonicalWorldviewRoot = path.join(temp, 'canonical-worldview');
  const guardPath = canonicalWorldviewActiveSequenceGuardPath(canonicalWorldviewRoot);
  const displacedPath = `${guardPath}.displaced`;
  const release = acquireCanonicalWorldviewActiveSequenceGuard({
    worldviewRoot: canonicalWorldviewRoot,
    ownerId: 'worldview_trigger_original',
  });
  fs.renameSync(guardPath, displacedPath);
  const replacement = {
    pid: process.pid,
    triggerId: 'worldview_trigger_replacement',
    startedAt: '2026-09-05T00:00:00.000Z',
  };
  fs.writeFileSync(guardPath, JSON.stringify(replacement), { flag: 'wx' });

  release();

  assert.deepEqual(JSON.parse(fs.readFileSync(guardPath, 'utf8')), replacement);
  assert.equal(fs.existsSync(displacedPath), true);
});

test('reset refuses a completed Issue #41 publication before touching either authority root', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  const claimSentinel = path.join(claimsRoot, 'legacy-claim.json');
  const worldviewSentinel = path.join(canonicalWorldviewRoot, 'legacy-worldview.json');
  const publicationId = 'worldview_publication_active';
  const publicationRoot = path.join(canonicalWorldviewRoot, 'run-publications');
  const completedMarker = path.join(publicationRoot, 'completed', `${publicationId}.json`);
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(claimSentinel, 'keep-legacy-claim');
  fs.writeFileSync(worldviewSentinel, 'keep-legacy-worldview');
  const publicationStore = new WorldviewRunPublicationStore({
    rootDir: publicationRoot,
    now: () => '2026-09-05T00:00:00.000Z',
  });
  publicationStore.stage({
    publicationId,
    runId: 'worldview_run_active',
    triggerId: 'trigger_active',
    batchId: 'batch_active',
    workspaceId: 'worldview_workspace_active',
    workspaceDigest: `sha256:${'1'.repeat(64)}`,
    worldview: {
      outcome: 'KEEP',
      evaluationRecordId: 'worldview_evaluation_active',
      evaluationRecordDigest: `sha256:${'2'.repeat(64)}`,
    },
    claims: { publicationId: 'claim_publication_active' },
    attempts: [],
    receipts: [{
      reportVersionId: 'report_version_active',
      admissionSequence: 1,
      contentDigest: `sha256:${'3'.repeat(64)}`,
      fingerprint: `sha256:${'4'.repeat(64)}`,
    }],
  });
  publicationStore.commit(publicationId);

  const result = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /active Issue #41 authority content/u);
  assert.equal(fs.readFileSync(claimSentinel, 'utf8'), 'keep-legacy-claim');
  assert.equal(fs.readFileSync(worldviewSentinel, 'utf8'), 'keep-legacy-worldview');
  assert.equal(JSON.parse(fs.readFileSync(completedMarker, 'utf8')).contract, 'worldview-run-publication-marker.v1');
});

test('reset refuses every active Issue #41 authority tree before touching either authority root', async (t) => {
  const cases = [
    {
      name: 'staged run publication',
      authority: 'canonicalWorldview',
      relativePath: ['run-publications', 'staged', 'publication.json'],
      record: { contract: 'worldview-run-publication.v1' },
    },
    {
      name: 'frozen run workspace',
      authority: 'canonicalWorldview',
      relativePath: ['run-workspaces', 'workspaces', 'workspace.json'],
      record: { contract: 'worldview-run-workspace.v1' },
    },
    {
      name: 'processing run',
      authority: 'canonicalWorldview',
      relativePath: ['processing-runs', 'run.json'],
      record: { contract: 'worldview-agent-run.v1' },
    },
    {
      name: 'Claim Library publication',
      authority: 'claimLibrary',
      relativePath: ['publications', 'claim_publication_active', 'publication.json'],
      record: { contract: 'claim-publication.v1' },
    },
    {
      name: 'recognized nested v1 contract',
      authority: 'canonicalWorldview',
      relativePath: ['unexpected-layout', 'record.json'],
      record: { audit: { contract: 'processed-report-version-receipt.v1' } },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
      const dataRoot = path.join(temp, 'resident-data');
      const claimsRoot = path.join(dataRoot, 'claims');
      const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
      const claimSentinel = path.join(claimsRoot, 'legacy-claim.json');
      const worldviewSentinel = path.join(canonicalWorldviewRoot, 'legacy-worldview.json');
      fs.mkdirSync(claimsRoot, { recursive: true });
      fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
      fs.writeFileSync(claimSentinel, 'keep-legacy-claim');
      fs.writeFileSync(worldviewSentinel, 'keep-legacy-worldview');
      const authorityRoot = {
        claims: claimsRoot,
        claimLibrary: path.join(dataRoot, 'claim-library'),
        canonicalWorldview: canonicalWorldviewRoot,
      }[scenario.authority];
      const activeFile = path.join(authorityRoot, ...scenario.relativePath);
      fs.mkdirSync(path.dirname(activeFile), { recursive: true });
      fs.writeFileSync(activeFile, JSON.stringify(scenario.record));

      try {
        const result = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });

        assert.equal(result.status, 2);
        assert.match(result.stderr, /active Issue #41 authority content/u);
        assert.equal(fs.readFileSync(claimSentinel, 'utf8'), 'keep-legacy-claim');
        assert.equal(fs.readFileSync(worldviewSentinel, 'utf8'), 'keep-legacy-worldview');
        assert.deepEqual(JSON.parse(fs.readFileSync(activeFile, 'utf8')), scenario.record);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    });
  }
});

test('reset refuses a missing or inexact destructive acknowledgement before deletion', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(path.join(claimsRoot, 'keep.txt'), 'keep-claim');
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'keep-worldview');

  for (const acknowledgementArgs of [
    [],
    ['--acknowledge-owner-authorized-reset', 'yes'],
  ]) {
    const result = spawnSync(process.execPath, [
      SCRIPT_FILE,
      '--claims-root', claimsRoot,
      '--canonical-worldview-root', canonicalWorldviewRoot,
      ...acknowledgementArgs,
    ], {
      encoding: 'utf8',
      env: { ...process.env, FIN_DATA_DIR: dataRoot },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exact owner-authorized reset acknowledgement is required/u);
    assert.equal(fs.readFileSync(path.join(claimsRoot, 'keep.txt'), 'utf8'), 'keep-claim');
    assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
  }
});

test('reset refuses non-exact and protected roots before touching either authority', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(dataRoot, 'claims');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  fs.mkdirSync(claimsRoot, { recursive: true });
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(path.join(claimsRoot, 'keep.txt'), 'keep-claim');
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'keep-worldview');
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const cases = [
    { name: 'relative Claim root', unsafeRoot: 'claims' },
    { name: 'wrong Claim basename', unsafeRoot: path.join(dataRoot, 'claim-library') },
    { name: 'filesystem root', unsafeRoot: path.parse(dataRoot).root },
    { name: 'repository root', unsafeRoot: repoRoot },
    { name: 'FIN_DATA_DIR root', unsafeRoot: dataRoot },
    { name: 'Claim root inside report-library', unsafeRoot: path.join(dataRoot, 'report-library', 'claims') },
    { name: 'same-basename Claim root outside FIN_DATA_DIR', unsafeRoot: path.join(temp, 'other-authority', 'claims') },
    { name: 'tracked-source Claim descendant', unsafeRoot: path.join(repoRoot, 'backend', 'test', 'fixtures', 'claims') },
  ];
  for (const scenario of cases) {
    const result = runReset({
      claimsRoot: scenario.unsafeRoot,
      canonicalWorldviewRoot,
      dataRoot,
      extraArgs: ['--dry-run'],
    });
    assert.notEqual(result.status, 0, scenario.name);
    assert.equal(fs.readFileSync(path.join(claimsRoot, 'keep.txt'), 'utf8'), 'keep-claim');
    assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
  }

  for (const unsafeCanonicalRoot of [
    path.join(dataRoot, 'worldview'),
    path.join(temp, 'other-authority', 'canonical-worldview'),
    path.join(repoRoot, 'backend', 'test', 'fixtures', 'canonical-worldview'),
  ]) {
    const wrongCanonicalRoot = runReset({
      claimsRoot,
      canonicalWorldviewRoot: unsafeCanonicalRoot,
      dataRoot,
    });
    assert.equal(wrongCanonicalRoot.status, 2);
    assert.equal(fs.readFileSync(path.join(claimsRoot, 'keep.txt'), 'utf8'), 'keep-claim');
    assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
  }
});

test('reset refuses symlink roots, symlink ancestors, and symlinks inside an authority', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const canonicalWorldviewRoot = path.join(dataRoot, 'canonical-worldview');
  const outsideRoot = path.join(temp, 'outside');
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'keep-worldview');
  fs.writeFileSync(path.join(outsideRoot, 'keep.txt'), 'keep-outside');

  const symlinkRoot = path.join(dataRoot, 'claims');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.symlinkSync(outsideRoot, symlinkRoot, 'dir');
  let result = runReset({
    claimsRoot: symlinkRoot,
    canonicalWorldviewRoot,
    dataRoot,
  });
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(path.join(outsideRoot, 'keep.txt'), 'utf8'), 'keep-outside');
  assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
  fs.unlinkSync(symlinkRoot);

  const realParent = path.join(temp, 'real-parent');
  const parentLink = path.join(temp, 'parent-link');
  fs.mkdirSync(path.join(realParent, 'claims'), { recursive: true });
  fs.writeFileSync(path.join(realParent, 'claims', 'keep.txt'), 'keep-ancestor-target');
  fs.symlinkSync(realParent, parentLink, 'dir');
  result = runReset({
    claimsRoot: path.join(parentLink, 'claims'),
    canonicalWorldviewRoot,
    dataRoot,
  });
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(path.join(realParent, 'claims', 'keep.txt'), 'utf8'), 'keep-ancestor-target');
  assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');

  const claimsWithNestedLink = path.join(dataRoot, 'claims');
  fs.mkdirSync(claimsWithNestedLink, { recursive: true });
  fs.symlinkSync(path.join(outsideRoot, 'keep.txt'), path.join(claimsWithNestedLink, 'linked.txt'));
  result = runReset({
    claimsRoot: claimsWithNestedLink,
    canonicalWorldviewRoot,
    dataRoot,
  });
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(path.join(outsideRoot, 'keep.txt'), 'utf8'), 'keep-outside');
  assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
});

test('nested same-basename authority roots are refused before either root is touched', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-worldview-claim-reset-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataRoot = path.join(temp, 'resident-data');
  const claimsRoot = path.join(temp, 'isolated-authorities', 'claims');
  const canonicalWorldviewRoot = path.join(claimsRoot, 'canonical-worldview');
  fs.mkdirSync(canonicalWorldviewRoot, { recursive: true });
  fs.writeFileSync(path.join(claimsRoot, 'keep.txt'), 'keep-claim');
  fs.writeFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'keep-worldview');

  const result = runReset({ claimsRoot, canonicalWorldviewRoot, dataRoot });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be exactly FIN_DATA_DIR\/claims/u);
  assert.equal(fs.readFileSync(path.join(claimsRoot, 'keep.txt'), 'utf8'), 'keep-claim');
  assert.equal(fs.readFileSync(path.join(canonicalWorldviewRoot, 'keep.txt'), 'utf8'), 'keep-worldview');
});

test('destructive reset and coordinator share the canonical sequence fence before the final scan', () => {
  const resetSource = fs.readFileSync(SCRIPT_FILE, 'utf8');
  const coordinatorFile = fileURLToPath(new URL('../src/workflows/worldview/canonicalWorldviewCoordinator.js', import.meta.url));
  const coordinatorSource = fs.readFileSync(coordinatorFile, 'utf8');
  const acquireIndex = resetSource.indexOf('releaseActiveSequence = acquireCanonicalWorldviewActiveSequenceGuard');
  const finalScanIndex = resetSource.indexOf('const fencedClaims = scanRoot');
  const quarantineIndex = resetSource.indexOf('quarantines.push(quarantineRoot(options.claimsRoot, fencedClaims))');

  assert.ok(acquireIndex >= 0, 'destructive reset must acquire the canonical Worldview sequence fence');
  assert.ok(finalScanIndex > acquireIndex, 'the final active-content scan must occur after fence acquisition');
  assert.ok(quarantineIndex > finalScanIndex, 'quarantine renames must occur after the fenced scan');
  assert.match(coordinatorSource, /acquireCanonicalWorldviewActiveSequenceGuard/u);
  assert.doesNotMatch(coordinatorSource, /openSync\(this\.activeSequencePath/u);
});

test('reset command is standalone and never part of server startup', () => {
  const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
  const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(packageJson.scripts.start, 'node src/server.js');
  assert.equal(
    packageJson.scripts['reset:worldview-claim-authorities'],
    'node scripts/resetWorldviewClaimAuthorities.mjs',
  );
  assert.doesNotMatch(fs.readFileSync(serverFile, 'utf8'), /resetWorldviewClaimAuthorities/u);
});
