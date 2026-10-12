import assert from 'node:assert/strict';
import test from 'node:test';

import { analystDeadlineMs } from '../src/workflows/run-analysis/research/analysisSubAgents.js';

test('primary analyst deadlines do not shrink on later rounds and preserve wall-clock headroom', () => {
  assert.equal(analystDeadlineMs({ analystMin: 5 }), 8 * 60000);
  assert.equal(analystDeadlineMs({ analystMin: 8 }), 8 * 60000);
  assert.equal(analystDeadlineMs({ analystMin: 11 }), 11 * 60000);
  assert.equal(analystDeadlineMs(null), 8 * 60000);
});

test('comparison analysts retain bounded wall-clock profiles without inheriting the primary window', () => {
  assert.equal(analystDeadlineMs({ analystMin: 11 }, { isComparison: true }), 4 * 60000);
  assert.equal(analystDeadlineMs({ analystMin: 5 }, { isComparison: true, promoted: true }), 6 * 60000);
});
