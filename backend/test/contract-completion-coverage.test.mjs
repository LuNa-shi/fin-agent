import test from 'node:test';
import assert from 'node:assert/strict';

import { listAgentDefinitions } from '../src/agents/registry.js';
import { COMPLETION_HARD_CHECKS } from '../src/core/validation/ContractEnforcer.js';
import { matchesAnyPathPattern } from '../src/core/policy/pathPolicy.js';

function concretePattern(pattern) {
  return String(pattern || '')
    .replace(/_rN\b/gu, '_r*')
    .replace(/rN\b/gu, 'r*')
    .replace(/_N\b/gu, '_*');
}

test('all active completion fields have a shared runtime or workflow consumer', () => {
  const knownChecks = new Set(COMPLETION_HARD_CHECKS);
  const definitions = listAgentDefinitions();
  assert.equal(definitions.length, 22);

  const audited = definitions.map((definition) => ({
    id: definition.id,
    hardChecks: definition.completionPolicy.hardChecks,
    requiredArtifacts: definition.completionPolicy.requiredArtifacts,
    artifactAuthority: definition.artifactAuthority,
    outputPaths: definition.outputPaths,
  }));

  for (const definition of definitions) {
    for (const check of definition.completionPolicy.hardChecks) {
      assert.ok(knownChecks.has(check), `${definition.id} hard check is not registered: ${check}`);
    }
    for (const artifact of definition.completionPolicy.requiredArtifacts) {
      assert.ok(
        matchesAnyPathPattern(artifact, definition.outputPaths)
          || matchesAnyPathPattern(artifact, definition.outputPaths.map(concretePattern)),
        `${definition.id} required artifact is outside outputPaths: ${artifact}`,
      );
      assert.ok(
        ['artifact', 'return+artifact'].includes(definition.artifactAuthority),
        `${definition.id} requires artifacts but authority is ${definition.artifactAuthority}`,
      );
    }
    if (definition.artifactAuthority === 'return') {
      assert.deepEqual(definition.completionPolicy.requiredArtifacts, [], `${definition.id} return-only contracts cannot require artifacts`);
    }
  }
  assert.equal(new Set(audited.map((item) => item.id)).size, 22);
});
