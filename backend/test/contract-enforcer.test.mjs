import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentDefinition } from '../src/agents/registry.js';
import { ContractEnforcer } from '../src/core/validation/ContractEnforcer.js';

const enforcer = new ContractEnforcer();

test('ContractEnforcer accepts declared output and required artifact paths', () => {
  const result = enforcer.evaluate({
    contract: getAgentDefinition('analysis-plan'),
    output: { candidates: [] },
    artifacts: [{ path: 'analysis/plan.json' }],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('ContractEnforcer delegates required artifact verification to the workflow owner without weakening Agent-owned runs', () => {
  const contract = getAgentDefinition('analysis-plan');
  const delegated = enforcer.evaluate({
    contract,
    output: { candidates: [] },
    artifacts: [],
    artifactCommitOwner: 'workflow',
  });
  assert.equal(delegated.valid, true);
  assert.equal(delegated.artifactCommitOwner, 'workflow');
  assert.deepEqual(delegated.delegatedRequiredArtifacts, ['analysis/plan.json']);

  const agentOwned = enforcer.evaluate({ contract, output: { candidates: [] }, artifacts: [] });
  assert.equal(agentOwned.valid, false);
  assert.match(agentOwned.errors.join('\n'), /required artifact is absent: analysis\/plan\.json/u);
});

test('ContractEnforcer fails closed on missing, unsafe, and unauthorized artifacts', () => {
  const contract = getAgentDefinition('analysis-plan');
  const missing = enforcer.evaluate({ contract, output: { candidates: [] }, artifacts: [] });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join('\n'), /required artifact is absent: analysis\/plan\.json/);

  const invalidPaths = enforcer.evaluate({
    contract,
    output: { candidates: [] },
    artifacts: ['analysis/plan.json', '../outside.json', 'report/report.md'],
  });
  assert.equal(invalidPaths.valid, false);
  assert.match(invalidPaths.errors.join('\n'), /unsafe artifact path: \.\.\/outside\.json/);
  assert.match(invalidPaths.errors.join('\n'), /unauthorized artifact path: report\/report\.md/);

  const invalidDeclaration = enforcer.evaluate({
    contract: {
      ...contract,
      completionPolicy: { ...contract.completionPolicy, requiredArtifacts: [] },
      outputPaths: ['../outside.json'],
    },
    output: { candidates: [] },
  });
  assert.equal(invalidDeclaration.valid, false);
  assert.match(invalidDeclaration.errors.join('\n'), /unsafe output path pattern: \.\.\/outside\.json/);
});

test('ContractEnforcer enforces artifact authority independently of path matching', () => {
  const returnOnly = {
    ...getAgentDefinition('report-translator'),
    outputPaths: ['report/translated.md'],
  };
  const returnResult = enforcer.evaluate({
    contract: returnOnly,
    output: 'translated report',
    text: 'translated report',
    artifacts: ['report/translated.md'],
  });
  assert.equal(returnResult.valid, false);
  assert.match(returnResult.errors.join('\n'), /artifact authority return does not allow artifact paths/);

  const artifactOnly = {
    ...getAgentDefinition('analysis-plan'),
    artifactAuthority: 'artifact',
  };
  const artifactResult = enforcer.evaluate({
    contract: artifactOnly,
    output: { candidates: [] },
    artifacts: ['analysis/plan.json'],
  });
  assert.equal(artifactResult.valid, false);
  assert.match(artifactResult.errors.join('\n'), /artifact authority artifact does not allow return output/);
});
