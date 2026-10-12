import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_REF_CONTRACT_VERSION,
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  createArtifactRef,
  validateArtifactRef,
} from '../src/core/contracts/ArtifactRef.js';

test('ArtifactRef validates required metadata and is deeply immutable', () => {
  const ref = createArtifactRef({
    artifactId: 'analysis.plan',
    version: 1,
    path: 'analysis/plan.json',
    contentDigest: canonicalSha256({ candidates: [] }),
    schemaVersion: 'analysis-plan.v1',
    producer: 'analysis-plan',
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ input: 'seed' }),
    createdAt: '2026-07-15T00:00:00.000Z',
    asOf: '2026-07-15T00:00:00.000Z',
    lineage: {
      inputArtifactRefs: [
        {
          artifactId: 'seed',
          version: 1,
          path: 'data/seed.json',
          contentDigest: canonicalSha256({ seed: true }),
          schemaVersion: 'seed.v1',
          producer: 'seed-node',
          contractVersion: '1.0.0',
          inputDigest: canonicalSha256(null),
          createdAt: '2026-07-15T00:00:00.000Z',
          asOf: '2026-07-15T00:00:00.000Z',
        },
      ],
    },
  });

  assert.equal(ref.contract, ARTIFACT_REF_CONTRACT_VERSION);
  assert.equal(validateArtifactRef(ref).valid, true);
  assert.throws(() => { ref.version = 2; }, /read only|Cannot assign/u);
  assert.throws(() => { ref.lineage.inputArtifactRefs.push({}); }, /not extensible|read only/u);

  const invalid = validateArtifactRef({ ...ref, version: 0 });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join('\n'), /positive version/u);

  assert.equal(validateArtifactRef({ ...ref, contract: undefined }).valid, false);
  assert.equal(validateArtifactRef({ ...ref, contractVersion: '1.0' }).valid, false);
  assert.equal(validateArtifactRef({ ...ref, path: 42, uri: 'artifact://analysis.plan/1' }).valid, false);

  for (const field of ARTIFACT_REF_REQUIRED_FIELDS) {
    const missing = structuredClone(ref);
    delete missing[field];
    assert.equal(validateArtifactRef(missing).valid, false, `${field} must remain required by the runtime validator`);
  }
  assert.deepEqual(ARTIFACT_REF_LOCATION_FIELDS, ['path', 'uri']);
  assert.equal(validateArtifactRef({ ...ref, path: undefined, uri: 'artifact://analysis.plan/1' }).valid, false);
  const uriOnly = structuredClone(ref);
  delete uriOnly.path;
  uriOnly.uri = 'artifact://analysis.plan/1';
  assert.equal(validateArtifactRef(uriOnly).valid, true);
});

test('canonical sha256 is deterministic and rejects unsupported values', () => {
  assert.equal(
    canonicalSha256({ b: 2, a: [true, null, 'x'] }),
    canonicalSha256({ a: [true, null, 'x'], b: 2 }),
  );

  assert.throws(() => canonicalSha256({ n: Number.NaN }), /non-finite number/u);
  assert.throws(() => canonicalSha256({ n: Infinity }), /non-finite number/u);
  assert.throws(() => canonicalSha256({ x: undefined }), /unsupported value/u);
  assert.throws(() => canonicalSha256({ x: 1n }), /unsupported value/u);
});
