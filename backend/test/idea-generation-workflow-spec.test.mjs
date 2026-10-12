import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getAgentDefinition, listAgentDefinitions } from '../src/agents/registry.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  canonicalIdeaGenerationWorkflowSpecJSON,
  ideaGenerationWorkflowSpecHash,
  renderIdeaGenerationWorkflowMarkdown,
  topologicalIdeaGenerationNodeOrder,
  validateIdeaGenerationWorkflowSpec,
} from '../src/workflows/idea-generation/workflowSpec.js';

const EXPECTED_WORKFLOW_SPEC_HASH = 'sha256:087c7781a753b1c5f936993ed1d9d91771fe89fc6bac1411a886aa950630f1eb';
const EXPECTED_NODE_IDS = [
  'collect-market-context',
  'build-diversification-constraints',
  'generate-candidates',
  'verify-candidates',
  'review-quality',
  'persist-ideas',
];

const reverseObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
};

test('canonical Idea Generation v2 WorkflowSpec is frozen, valid, and acyclic', () => {
  assert.equal(IDEA_GENERATION_WORKFLOW_SPEC.schemaVersion, 'workflow-spec.v1');
  assert.equal(IDEA_GENERATION_WORKFLOW_SPEC.id, 'idea-generation.v2');
  assert.equal(IDEA_GENERATION_WORKFLOW_SPEC.version, '2.0.0');
  assert.deepEqual(IDEA_GENERATION_WORKFLOW_SPEC.scope, {
    kind: 'idea-universe',
    workspaceMode: 'idea-run',
  });
  assert.deepEqual(
    IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => node.id),
    EXPECTED_NODE_IDS,
  );
  assert.equal(Object.isFrozen(IDEA_GENERATION_WORKFLOW_SPEC), true);
  assert.equal(Object.isFrozen(IDEA_GENERATION_WORKFLOW_SPEC.nodes), true);
  assert.ok(IDEA_GENERATION_WORKFLOW_SPEC.nodes.every(Object.isFrozen));
  assert.equal(validateIdeaGenerationWorkflowSpec(IDEA_GENERATION_WORKFLOW_SPEC), true);
  assert.deepEqual(
    topologicalIdeaGenerationNodeOrder(IDEA_GENERATION_WORKFLOW_SPEC),
    EXPECTED_NODE_IDS,
  );
});

test('Idea Generation v2 owns the exact six-node sequential DAG and formal outputs', () => {
  const byId = Object.fromEntries(
    IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => [node.id, node]),
  );
  assert.deepEqual(byId['collect-market-context'].dependsOn, []);
  assert.deepEqual(
    byId['build-diversification-constraints'].dependsOn,
    ['collect-market-context'],
  );
  assert.deepEqual(
    byId['generate-candidates'].dependsOn,
    ['build-diversification-constraints'],
  );
  assert.deepEqual(byId['verify-candidates'].dependsOn, ['generate-candidates']);
  assert.deepEqual(byId['review-quality'].dependsOn, ['verify-candidates']);
  assert.deepEqual(byId['persist-ideas'].dependsOn, ['review-quality']);
  assert.ok(IDEA_GENERATION_WORKFLOW_SPEC.nodes.every((node) => (
    node.conditionId === 'always'
    && node.condition === 'always'
    && node.artifactPolicy === 'artifact'
    && node.outputDescription
  )));
  assert.deepEqual(IDEA_GENERATION_WORKFLOW_SPEC.parallelGroups, []);
});

test('Idea Generation v2 binds only the generator and quality reviewer exactly once', () => {
  const boundIds = IDEA_GENERATION_WORKFLOW_SPEC.nodes
    .flatMap((node) => node.agentContractIds);
  const visibleIds = listAgentDefinitions()
    .filter((definition) => (
      definition.domain === 'idea-generation'
      && definition.visibility.workflows.includes(IDEA_GENERATION_WORKFLOW_SPEC.id)
    ))
    .map((definition) => definition.id)
    .sort();

  assert.deepEqual(boundIds, ['idea-generator', 'idea-quality-reviewer']);
  assert.deepEqual([...boundIds].sort(), visibleIds);
  assert.equal(new Set(boundIds).size, boundIds.length);
  assert.equal(boundIds.includes('project-classifier'), false);
  for (const agentId of boundIds) {
    assert.deepEqual(
      getAgentDefinition(agentId).visibility.workflows,
      ['idea-generation.v1', 'idea-generation.v2'],
    );
  }
});

test('Idea Generation canonical serialization and hash are deterministic', () => {
  const reordered = reverseObjectKeys(structuredClone(IDEA_GENERATION_WORKFLOW_SPEC));
  assert.equal(
    canonicalIdeaGenerationWorkflowSpecJSON(reordered),
    canonicalIdeaGenerationWorkflowSpecJSON(IDEA_GENERATION_WORKFLOW_SPEC),
  );
  assert.equal(
    ideaGenerationWorkflowSpecHash(reordered),
    IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  );
  assert.equal(IDEA_GENERATION_WORKFLOW_SPEC_HASH, EXPECTED_WORKFLOW_SPEC_HASH);
});

test('Idea Generation WorkflowSpec stays non-Project and its checked-in Markdown has no drift', async () => {
  const [source, checkedIn] = await Promise.all([
    readFile(
      new URL('../src/workflows/idea-generation/workflowSpec.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../documents/generated/idea-generation-workflow.md', import.meta.url),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(
    source,
    /(?:from\s+|import\s*\(\s*)['"][^'"]*(?:project-space|workflows\/run-analysis)/u,
  );
  assert.equal(
    checkedIn,
    renderIdeaGenerationWorkflowMarkdown(IDEA_GENERATION_WORKFLOW_SPEC),
  );
  assert.ok(checkedIn.includes(IDEA_GENERATION_WORKFLOW_SPEC_HASH));
  assert.match(checkedIn, /```mermaid[\s\S]*flowchart TD/u);
  assert.match(
    checkedIn,
    /source material remains run input; every valid normalized\/deduplicated generated Idea is persisted/u,
  );
});
