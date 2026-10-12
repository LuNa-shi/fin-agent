import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAnalysisPlanOutput } from '../src/workflows/run-analysis/handlers/planResearch.js';

test('normalizeAnalysisPlanOutput parses JSON string plan outputs', () => {
  const output = JSON.stringify({
    logic: 'Analyze VERV as a speculative, event-driven gene-editing investment.',
    candidates: [
      { ticker: 'verv', name: 'Verve Therapeutics', role: 'core', reason: 'Clinical catalyst' },
    ],
    keyEvent: 'Clinical update',
    deltas: 'efficacy/safety/financing',
  });

  const plan = normalizeAnalysisPlanOutput(output, {
    logic: 'fallback',
    candidates: [{ ticker: 'NVDA', name: 'NVDA', role: '候选', reason: 'fallback' }],
    keyEvent: 'fallback event',
    deltas: 'fallback',
  });

  assert.equal(plan.logic, 'Analyze VERV as a speculative, event-driven gene-editing investment.');
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].ticker, 'VERV');
  assert.equal(plan.candidates[0].name, 'Verve Therapeutics');
});

test('normalizeAnalysisPlanOutput falls back when output is not an object plan', () => {
  const plan = normalizeAnalysisPlanOutput('not json', {
    logic: 'fallback',
    candidates: [{ ticker: 'MSFT', name: 'Microsoft', role: '候选', reason: 'fallback' }],
    keyEvent: 'fallback event',
    deltas: 'fallback',
  });

  assert.equal(plan.logic, 'fallback');
  assert.deepEqual(plan.candidates, [
    { ticker: 'MSFT', name: 'Microsoft', role: '候选', reason: 'fallback' },
  ]);
});
