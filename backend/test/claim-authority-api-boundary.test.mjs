import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_ACTIONS,
  CLAIM_ACTION_CONTRACT,
  CLAIM_CONTRACT,
  CLAIM_LIBRARY_SCHEMA_VERSION,
  ClaimContractError,
  deriveClaimId,
  normalizeClaimAction,
  normalizeClaimBody,
} from '../src/domains/claims/index.js';

const digest = (hex) => `sha256:${hex.repeat(64)}`;

function evidence(reportVersionId = 'report-1', hex = 'a') {
  return {
    reportVersionId,
    contentDigest: digest(hex),
    fingerprint: digest(hex === 'f' ? 'e' : 'f'),
  };
}

function claimBody(overrides = {}) {
  return {
    assertion: 'Cloud demand will increase Acme revenue over the next year.',
    subject: 'Acme cloud revenue',
    tickers: ['acme', ' ACME ', 'MSFT'],
    rationale: 'Enterprise cloud migrations should expand contracted recurring revenue.',
    verification: { window: { startAt: '2026-10-01T00:00:00.000Z', endAt: '2027-09-30T00:00:00.000Z' } },
    metric: 'Year-over-year cloud revenue growth',
    acceptanceCondition: 'Reported cloud revenue growth is at least 15%.',
    invalidationCondition: 'Reported cloud revenue growth is below 5% for two quarters.',
    evidence: [evidence()],
    ...overrides,
  };
}

test('Claim Library v1 exposes only the small action and Claim contracts', () => {
  assert.equal(CLAIM_LIBRARY_SCHEMA_VERSION, 'claim-library.v1');
  assert.equal(CLAIM_CONTRACT, 'claim.v1');
  assert.equal(CLAIM_ACTION_CONTRACT, 'claim-action.v1');
  assert.deepEqual(CLAIM_ACTIONS, ['ADD', 'UPDATE', 'NOOP']);

  const body = normalizeClaimBody(claimBody());
  assert.deepEqual(body.tickers, ['ACME', 'MSFT']);
  assert.equal(Object.isFrozen(body), true);
  assert.deepEqual(Object.keys(body), [
    'assertion',
    'subject',
    'tickers',
    'rationale',
    'verification',
    'metric',
    'acceptanceCondition',
    'invalidationCondition',
    'evidence',
  ]);
});

test('ADD identity is replay-stable from runId and actionId rather than Claim semantics', () => {
  assert.equal(
    deriveClaimId('run-1', 'action-1'),
    'claim_8b0f6551a7abe026ace3740e70ae57f91471619555b007c71e3b5fae2d194952',
  );
  assert.equal(
    deriveClaimId('run-1', 'action-1'),
    deriveClaimId('run-1', 'action-1'),
  );

  const action = normalizeClaimAction({
    actionId: 'action-1',
    action: 'ADD',
    rationale: 'No similar assertion exists in the frozen Claim table.',
    claim: claimBody(),
  });
  assert.equal(action.action, 'ADD');
  assert.equal('target' in action, false);
});

test('UPDATE and NOOP require explicit stable targets while legacy semantic fields fail closed', () => {
  const update = normalizeClaimAction({
    actionId: 'action-update',
    action: 'UPDATE',
    rationale: 'New evidence materially changes the assertion.',
    target: { claimId: 'claim-existing', expectedVersion: 2 },
    claim: claimBody(),
  });
  assert.deepEqual(update.target, { claimId: 'claim-existing', expectedVersion: 2 });

  const noop = normalizeClaimAction({
    actionId: 'action-noop',
    action: 'NOOP',
    rationale: 'New evidence leaves the existing judgment materially unchanged.',
    target: { claimId: 'claim-existing', expectedVersion: 2 },
    evidence: [evidence('report-2', 'b')],
  });
  assert.equal('claim' in noop, false);

  for (const invalid of [
    { ...claimBody(), assertion: 'First line.\nSecond line.' },
    { ...claimBody(), profile: 'recommendation' },
    { ...claimBody(), recommendation: { targetTickers: ['ACME'] } },
    { ...claimBody(), worldviewRef: { packageId: 'worldview-1' } },
    { ...claimBody(), verification: { window: { startAt: '2027-01-01T00:00:00.000Z', endAt: '2026-01-01T00:00:00.000Z' } } },
  ]) {
    assert.throws(() => normalizeClaimBody(invalid), ClaimContractError);
  }
});


test('active Claim Library source has no legacy resolver, Worldview FK, or semantic identity path', async () => {
  const fs = await import('node:fs');
  const source = [
    fs.readFileSync(new URL('../src/domains/claims/claimContracts.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/domains/claims/ClaimStore.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /claimFamily|semanticDigest|logicalIdentity|normalizeResolution|worldviewRef|recommendation|causalSteps|verificationSources|completedPublicationReader|markPublicationCompleted|claim-publication-marker/u);
});
