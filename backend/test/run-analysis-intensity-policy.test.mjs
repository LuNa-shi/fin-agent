import assert from 'node:assert/strict';
import test from 'node:test';

import { reportComposerAgent } from '../src/agents/definitions/run-analysis/report-composer.agent.js';
import { INTENSITY } from '../src/workflows/run-analysis/policies/intensity.js';

test('quick Run Analysis gives report composer a 600 second deadline', () => {
  assert.equal(INTENSITY.quick.depth.composerMin, 10);
  assert.equal(reportComposerAgent.runPolicy.deadlineMs, 600_000);
});
