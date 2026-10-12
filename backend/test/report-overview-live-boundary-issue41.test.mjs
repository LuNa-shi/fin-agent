import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentDefinition } from '../src/agents/registry.js';

test('Report Overview maxTurns is a high safety fuse rather than the expected one-response completion count', () => {
  const definition = getAgentDefinition('report-overview');
  assert.ok(definition.runPolicy.maxTurns >= 4);
  assert.equal(definition.modelPolicy.preferredProviders.includes('openai-compatible'), true);
  assert.equal(definition.completionPolicy.hardChecks.includes('output-schema'), true);
});
