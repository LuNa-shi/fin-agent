import test from 'node:test';
import assert from 'node:assert/strict';
import { scorecardEntries } from '../src/views/dailyReportPresentation.js';

test('scorecard presentation keeps stable lens ordering and display-only values', () => {
  const entries = scorecardEntries({
    company: { finalScoreBps: 9200, qualityBand: 'A', displayResult: 'pass' },
    data: { finalScoreBps: 3750, qualityBand: 'F', displayResult: 'fail' },
    industry: { finalScoreBps: 8000, qualityBand: 'B', displayResult: 'pass' },
  });
  assert.deepEqual(entries.map((entry) => entry.lens), ['data', 'industry', 'company']);
  assert.deepEqual(entries.map((entry) => entry.score), [37.5, 80, 92]);
});

test('missing or malformed scorecards are not rendered as a score', () => {
  assert.deepEqual(scorecardEntries({ data: { finalScoreBps: 'not-a-score' } }), [{
    lens: 'data', label: 'Data', score: null, band: null, result: null, cycle: null, asOf: null,
  }]);
  assert.deepEqual(scorecardEntries(null), []);
});

import { readFile } from 'node:fs/promises';

test('scorecard UI is read-only and includes an explicit unavailable state', async () => {
  const source = await readFile(new URL('../src/views/DailyReportContentView.jsx', import.meta.url), 'utf8');
  assert.match(source, /Scorecards · 仅展示/u);
  assert.match(source, /当前报告未提供可验证的 Scorecard 结果/u);
  assert.doesNotMatch(source, /api\.scorecard|scorecard.*(?:post|put|patch|delete)/iu);
});
