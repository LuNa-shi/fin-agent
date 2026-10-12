import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.dirname(backendRoot);
const runnerFile = path.join(
  backendRoot,
  'scripts',
  'runW8DeterministicAcceptance.mjs',
);
const evidenceDir = path.join(
  repositoryRoot,
  'artifacts',
  'local',
  'workflow-w8',
);
const EXPECTED_EVIDENCE_FILES = [
  'lineage.json',
  'run-record.json',
  'status-matrix.json',
  'summary.json',
  'validation.txt',
];
const BYTE_STABLE_EVIDENCE_FILES = [
  'summary.json',
  'status-matrix.json',
  'validation.txt',
];
const EXACT_RUN_INTEGRITY_FILES = [
  'run-record.json',
  'lineage.json',
];
const EXPECTED_CASE_OUTCOMES = [
  { case: 'all-valid-ideas', actual: 'passed' },
  { case: 'successful-publish', actual: 'analyzed' },
  { case: 'review-required', actual: 'review-required' },
  { case: 'human-resolution', actual: 'analyzed' },
  { case: 'snapshot-immutability', actual: 'passed' },
  { case: 'idempotent-replay', actual: 'passed' },
  { case: 'crash-resume', actual: 'passed' },
  { case: 'legacy-idea', actual: 'passed' },
];
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function evidenceSnapshot() {
  if (!fs.existsSync(evidenceDir)) return null;
  const directory = fs.lstatSync(evidenceDir);
  assert.equal(directory.isDirectory(), true);
  assert.equal(directory.isSymbolicLink(), false);
  return Object.fromEntries(
    fs.readdirSync(evidenceDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        assert.equal(entry.isFile(), true);
        assert.equal(entry.isSymbolicLink(), false);
        return [
          entry.name,
          fileDigest(path.join(evidenceDir, entry.name)),
        ];
      }),
  );
}

async function runAcceptance() {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [runnerFile, '--test'],
    {
      cwd: backendRoot,
      env: process.env,
      timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.doesNotMatch(stderr, /(?:private|secret|apikey|endpoint)/iu);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.mode, 'test');
  assert.equal(result.commitSha, 'test-mode');
  assert.equal(result.caseCount, 8);
  assert.deepEqual(result.caseOutcomes, EXPECTED_CASE_OUTCOMES);
  assert.equal(result.successProjectStatus, 'analyzed');
  assert.equal(result.reviewBlockedStatus, 'review-required');
  assert.equal(result.reviewFinalStatus, 'analyzed');
  assert.equal(result.networkGuardActive, true);
  assert.equal(result.blockedNetworkAttemptCount, 0);
  assert.equal(result.createOnlyPublicationVerified, true);
  assert.deepEqual(
    [...result.evidenceFiles].sort(),
    EXPECTED_EVIDENCE_FILES,
  );
  assert.match(result.structuralAcceptanceDigest, DIGEST_RE);
  assert.match(result.evidenceDigest, DIGEST_RE);
  assert.deepEqual(result.repeatabilityPolicy, {
    schemaVersion: 'workflow-w8-repeatability-policy.v1',
    byteStableFiles: BYTE_STABLE_EVIDENCE_FILES,
    exactRunIntegrityFiles: EXACT_RUN_INTEGRITY_FILES,
    generatedProseBytesCompared: false,
  });
  assert.deepEqual(
    Object.keys(result.evidenceFileDigests).sort(),
    EXPECTED_EVIDENCE_FILES,
  );
  for (const digest of Object.values(result.evidenceFileDigests)) {
    assert.match(digest, DIGEST_RE);
  }
  return result;
}

test('W8 deterministic production composition repeats its structural record while retaining exact run integrity', {
  timeout: 500_000,
}, async () => {
  const evidenceBefore = evidenceSnapshot();
  const first = await runAcceptance();
  const second = await runAcceptance();

  assert.equal(
    second.structuralAcceptanceDigest,
    first.structuralAcceptanceDigest,
  );
  for (const file of BYTE_STABLE_EVIDENCE_FILES) {
    assert.equal(
      second.evidenceFileDigests[file],
      first.evidenceFileDigests[file],
    );
  }
  assert.deepEqual(evidenceSnapshot(), evidenceBefore);
});
