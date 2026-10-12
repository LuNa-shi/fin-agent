import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillDemoIdeas,
  deriveStableIdeaId,
  GENERATOR_OUTPUT_REJECTION_REASONS,
  normalizeGeneratorOutputs,
  sanitizeCandidatePool,
} from '../src/workflows/idea-generation/nodes/candidateSelection.js';

const workflow = Object.freeze({
  id: 'idea-generation.v2',
  version: '2.0.0',
  hash: `sha256:${'a'.repeat(64)}`,
});

function candidate(title, overrides = {}) {
  return {
    title,
    theme: 'power infrastructure',
    heat: 70,
    rationale: 'Grid investment remains above consensus.',
    tickers: ['GEV'],
    catalyst: 'Utility capital plans',
    edge: 'Order growth is underestimated.',
    ...overrides,
  };
}

test('generator normalization records missing fields and empty normalized titles by source index', () => {
  const result = normalizeGeneratorOutputs([
    { theme: 'software' },
    { title: 'Missing theme' },
    candidate('!!!'),
  ], new Set(['GEV']), []);

  assert.deepEqual(result, {
    valid: [],
    rejected: [
      { index: 0, reason: GENERATOR_OUTPUT_REJECTION_REASONS.MISSING_TITLE },
      { index: 1, reason: GENERATOR_OUTPUT_REJECTION_REASONS.MISSING_THEME },
      { index: 2, reason: GENERATOR_OUTPUT_REJECTION_REASONS.EMPTY_NORMALIZED_TITLE },
    ],
  });
});

test('generator normalization distinguishes existing and prior-output title duplicates', () => {
  const result = normalizeGeneratorOutputs([
    candidate('Existing idea!'),
    candidate('New grid idea'),
    candidate('NEW-grid idea.'),
  ], new Set(['GEV']), ['Existing Idea']);

  assert.deepEqual(result.valid.map((idea) => idea.title), ['New grid idea']);
  assert.deepEqual(result.rejected, [
    { index: 0, reason: GENERATOR_OUTPUT_REJECTION_REASONS.DUPLICATE_EXISTING_TITLE },
    { index: 2, reason: GENERATOR_OUTPUT_REJECTION_REASONS.DUPLICATE_PRIOR_OUTPUT },
  ]);
});

test('generator normalization accepts tickerless and mixed-validity candidates', () => {
  const result = normalizeGeneratorOutputs([
    candidate('Macro idea without a ticker', { tickers: undefined }),
    candidate('Mixed ticker idea', { tickers: ['gev', ' bad ', 'ETN'] }),
  ], new Set(['GEV', 'ETN']), []);

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.valid[0].tickers, []);
  assert.deepEqual(result.valid[0].droppedTickers, []);
  assert.deepEqual(result.valid[1].tickers, ['GEV', 'ETN']);
  assert.deepEqual(result.valid[1].droppedTickers, ['BAD']);
});

test('generator normalization rejects candidates whose supplied tickers are all invalid', () => {
  const result = normalizeGeneratorOutputs([
    candidate('Unverified ticker idea', { tickers: ['bad', 'worse'] }),
  ], new Set(), []);

  assert.deepEqual(result, {
    valid: [],
    rejected: [
      { index: 0, reason: GENERATOR_OUTPUT_REJECTION_REASONS.ALL_TICKERS_INVALID },
    ],
  });
});

test('generator normalization preserves heat defaults and clamps numeric heat', () => {
  const result = normalizeGeneratorOutputs([
    candidate('Low heat', { heat: -20 }),
    candidate('High heat', { heat: 120 }),
    candidate('Default heat', { heat: 'high' }),
  ], new Set(['GEV']), []);

  assert.deepEqual(result.valid.map((idea) => idea.heat), [0, 100, 60]);
});

test('sanitizeCandidatePool remains a valid-only compatibility projection', () => {
  const inputs = [
    candidate('Valid compatibility idea'),
    candidate('Invalid compatibility idea', { tickers: ['BAD'] }),
  ];

  assert.deepEqual(
    sanitizeCandidatePool(inputs, new Set(['GEV']), []),
    normalizeGeneratorOutputs(inputs, new Set(['GEV']), []).valid,
  );
});

test('stable Idea ids use workflow, run, snapshot, and normalized-title identity', () => {
  const normalized = normalizeGeneratorOutputs(
    [candidate('Grid equipment opportunity!')],
    new Set(['GEV']),
    [],
  ).valid[0];
  const input = {
    workflow,
    runId: 'idea_run_1',
    snapshotId: `idea-run-input-snapshot:${'b'.repeat(64)}`,
    candidate: normalized,
  };
  const stable = deriveStableIdeaId(input);

  assert.match(stable, /^idea_[a-f0-9]{64}$/u);
  assert.equal(deriveStableIdeaId(structuredClone(input)), stable);
  assert.equal(
    deriveStableIdeaId({
      ...input,
      candidate: { ...normalized, title: 'GRID-equipment opportunity', heat: 5 },
    }),
    stable,
    'same normalized identity retains one id so divergent content is a detectable conflict',
  );
  assert.notEqual(
    deriveStableIdeaId({ ...input, runId: 'idea_run_2' }),
    stable,
  );
  assert.notEqual(
    deriveStableIdeaId({
      ...input,
      snapshotId: `idea-run-input-snapshot:${'c'.repeat(64)}`,
    }),
    stable,
  );
  assert.notEqual(
    deriveStableIdeaId({
      ...input,
      workflow: { ...workflow, hash: `sha256:${'d'.repeat(64)}` },
    }),
    stable,
  );
  assert.notEqual(
    deriveStableIdeaId({
      ...input,
      candidate: { ...normalized, title: 'Different normalized title' },
    }),
    stable,
  );
});

test('stable Idea id derivation fails closed on conflicting or incomplete identities', () => {
  const candidateInput = candidate('Safe identity');
  assert.throws(
    () => deriveStableIdeaId({
      workflow: { ...workflow, hash: 'sha256:conflict' },
      runId: 'idea_run_1',
      snapshotId: 'snapshot_1',
      candidate: candidateInput,
    }),
    /workflow\.hash must be a canonical sha256 digest/u,
  );
  assert.throws(
    () => deriveStableIdeaId({
      workflow,
      runId: 'idea_run_1',
      snapshotId: 'snapshot_1',
      candidate: candidate('!!!'),
    }),
    /candidate\.title must have a non-empty normalized identity/u,
  );
});

test('demo backfill advances to a distinct titled cycle when prior demo titles exist', () => {
  const firstCycle = backfillDemoIdeas([], 8, []);
  const second = backfillDemoIdeas([], 1, firstCycle.map((idea) => idea.title));

  assert.equal(firstCycle.length, 8);
  assert.equal(second.length, 1);
  assert.equal(firstCycle.some((idea) => idea.title === second[0].title), false);
  assert.match(second[0].title, /^Follow-up 2:/u);
});
