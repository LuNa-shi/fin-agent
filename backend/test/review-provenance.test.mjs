import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvidenceReviewProvenance,
  projectSourceManifestForReview,
} from '../src/workflows/run-analysis/reviewers/reviewProvenance.js';

const AS_OF = '2026-06-30T20:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);
const LEDGER_DIGEST = `sha256:${'a'.repeat(64)}`;

test('review provenance projects source-manifest and round generatedAt values to ISO-8601 without mutation', () => {
  const sourceManifest = {
    generatedAt: AS_OF_MS,
    rounds: [
      { round: 1, generatedAt: AS_OF_MS, sources: [{ id: 'source-1' }] },
      { round: 2, generatedAt: '2026-06-30T19:00:00.000Z', sources: [] },
    ],
  };
  const before = structuredClone(sourceManifest);

  const projected = projectSourceManifestForReview(sourceManifest);

  assert.deepEqual(sourceManifest, before);
  assert.notEqual(projected, sourceManifest);
  assert.equal(projected.generatedAt, AS_OF);
  assert.deepEqual(projected.rounds.map((round) => round.generatedAt), [
    AS_OF,
    '2026-06-30T19:00:00.000Z',
  ]);
  assert.deepEqual(projected.rounds[0].sources, [{ id: 'source-1' }]);
});

test('review provenance names digest scopes and explicitly expects ledger/review-package digests to differ', () => {
  const result = buildEvidenceReviewProvenance({
    asOf: AS_OF,
    sourceManifest: {
      generatedAt: AS_OF_MS,
      rounds: [{ round: 1, generatedAt: AS_OF_MS }],
    },
    citationLedger: {
      inputDigest: LEDGER_DIGEST,
      markerContract: { source: 'exact markers only' },
      aliases: [{ alias: '10-K', sourceId: 'source-1' }],
      ambiguousAliases: [],
      navigationOnlyArtifacts: [{ path: 'data/data_report.md' }],
    },
  });

  assert.equal(result.sourceManifest.generatedAt, AS_OF);
  assert.equal(result.sourceManifest.rounds[0].generatedAt, AS_OF);
  assert.equal(result.citationContract.inputDigest, undefined);
  assert.equal(result.citationContract.evidenceSetDigest, LEDGER_DIGEST);
  assert.equal(result.citationContract.ledgerInputDigest, LEDGER_DIGEST);
  assert.equal(result.citationContract.expectedToDifferFromReviewPackageInputDigest, true);
  assert.match(result.citationContract.digestScope.evidenceSetDigest, /normalized evidence set/u);
  assert.match(result.citationContract.digestScope.reviewPackageInputDigest, /draftReport/u);
  assert.match(result.citationContract.digestComparisonRule, /Do not require/u);
  assert.deepEqual(result.citationContract.markerContract, { source: 'exact markers only' });
});

test('review provenance makes equality with asOf explicit and reports manifest cutoff safety deterministically', () => {
  const inBounds = buildEvidenceReviewProvenance({
    asOf: AS_OF,
    sourceManifest: {
      generatedAt: AS_OF_MS,
      rounds: [
        { round: 1, generatedAt: AS_OF_MS - 1 },
        { round: 2, generatedAt: AS_OF_MS },
      ],
    },
    citationLedger: { inputDigest: LEDGER_DIGEST },
  });

  assert.deepEqual(inBounds.citationContract.asOfSafety, {
    asOf: AS_OF,
    generatedAtFormat: 'ISO-8601 UTC',
    generatedAtSemantics: 'sourceManifest generatedAt fields project the declared evidence cutoff, not a later source observation.',
    equalityWithAsOfIsInBounds: true,
    allManifestTimestampsAtOrBeforeAsOf: true,
    sourceRecencyRule: 'Post-as-of evidence safety is determined from SourceDocument/EvidenceItem publishedAt, observedAt, and fetchedAt fields; a manifest generatedAt equal to asOf is safe.',
  });

  const outOfBounds = buildEvidenceReviewProvenance({
    asOf: AS_OF,
    sourceManifest: { generatedAt: AS_OF_MS + 1, rounds: [] },
    citationLedger: { inputDigest: LEDGER_DIGEST },
  });
  assert.equal(outOfBounds.citationContract.asOfSafety.allManifestTimestampsAtOrBeforeAsOf, false);
});

test('review provenance rejects malformed timestamps instead of leaking ambiguous numeric values', () => {
  assert.throws(
    () => projectSourceManifestForReview({ generatedAt: 'not-a-date', rounds: [] }),
    /sourceManifest\.generatedAt must be a valid timestamp/u,
  );
  assert.throws(
    () => projectSourceManifestForReview({ generatedAt: null, rounds: [] }),
    /sourceManifest\.generatedAt must be a valid timestamp/u,
  );
  assert.throws(
    () => buildEvidenceReviewProvenance({ asOf: 'not-a-date', sourceManifest: null, citationLedger: null }),
    /asOf must be a valid timestamp/u,
  );
});
