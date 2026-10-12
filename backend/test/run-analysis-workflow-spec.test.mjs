import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { listAgentDefinitions } from '../src/agents/registry.js';
import {
  canonicalWorkflowSpecJSON as canonicalWorkflowSpecJSONCore,
  validateWorkflowSpec,
  workflowSpecHash as workflowSpecHashCore,
} from '../src/core/workflow/WorkflowSpec.js';
import {
  topologicalNodeOrder as topologicalNodeOrderCore,
  validateWorkflowParallelGroups,
} from '../src/core/workflow/WorkflowGraph.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  canonicalWorkflowSpecJSON,
  remediationNodesFor,
  renderRunAnalysisWorkflowMarkdown,
  topologicalNodeOrder,
  validateRunAnalysisWorkflowSpec,
  workflowSpecHash,
} from '../src/workflows/run-analysis/workflowSpec.js';

const EXPECTED_WORKFLOW_SPEC_HASH = 'sha256:12580210704a77827a353d260223e00f38b71fe9e92ff630eb570212a125c709';

const expectedNodeIds = [
  'initialize-checkpoint',
  'plan-research',
  'select-candidates',
  'run-research-rounds',
  'compose-report',
  'review-report',
  'synthesize-conclusion',
  'finalize-project',
];

const reverseObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
};

test('Core WorkflowSpec and WorkflowGraph helpers are domain-neutral', async () => {
  const spec = {
    schemaVersion: 'workflow-spec.v1',
    id: 'core-test.v1',
    version: '1.0.0',
    nodes: [
      {
        id: 'start',
        handlerId: 'start',
        dependsOn: [],
        conditionId: 'always',
        condition: 'always',
        agentContractIds: [],
        parallelGroup: 'fork',
      },
      {
        id: 'finish',
        handlerId: 'finish',
        dependsOn: ['start'],
        conditionId: 'always',
        condition: 'always',
        agentContractIds: [],
        parallelGroup: 'fork',
      },
    ],
    parallelGroups: [{ id: 'fork', scope: 'nodes', nodeIds: ['start', 'finish'] }],
  };

  assert.equal(validateWorkflowSpec(spec), true);
  assert.deepEqual(topologicalNodeOrderCore(spec), ['start', 'finish']);
  assert.equal(validateWorkflowParallelGroups(spec), true);
  assert.equal(canonicalWorkflowSpecJSONCore(reverseObjectKeys(spec)), canonicalWorkflowSpecJSONCore(spec));
  assert.equal(workflowSpecHashCore(reverseObjectKeys(spec)), workflowSpecHashCore(spec));
  assert.throws(
    () => topologicalNodeOrderCore({ ...spec, nodes: [{ ...spec.nodes[0], dependsOn: ['missing'] }, spec.nodes[1]] }),
    /unknown dependency missing for start/u,
  );
  assert.throws(
    () => topologicalNodeOrderCore({
      ...spec,
      nodes: [{ ...spec.nodes[0], dependsOn: ['finish'] }, spec.nodes[1]],
    }),
    /workflow contains a cycle/u,
  );

  for (const filename of ['WorkflowSpec.js', 'WorkflowGraph.js', 'WorkflowExecutor.js']) {
    const text = await readFile(new URL(`../src/core/workflow/${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(?:from\s+|import\s*\(\s*)['"][^'"]*(?:workflows\/run-analysis|\/agents\/|agents\/registry)/u, filename);
  }
});

test('canonical Run Analysis WorkflowSpec is versioned, frozen, valid, and acyclic', () => {
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC.schemaVersion, 'workflow-spec.v1');
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC.id, 'run-analysis.v2');
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC.version, '2.0.0');
  assert.equal(Object.isFrozen(RUN_ANALYSIS_WORKFLOW_SPEC), true);
  assert.deepEqual(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.id), expectedNodeIds);
  assert.equal(validateRunAnalysisWorkflowSpec(RUN_ANALYSIS_WORKFLOW_SPEC), true);
  assert.deepEqual(topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC), expectedNodeIds);
});

test('WorkflowSpec binds every active Run Analysis Agent id exactly once from the registry', () => {
  const activeIds = listAgentDefinitions()
    .filter((definition) => definition.domain === 'run-analysis' && definition.inRunAnalysis)
    .map((definition) => definition.id)
    .sort();
  const boundIds = RUN_ANALYSIS_WORKFLOW_SPEC.nodes
    .flatMap((node) => node.agentContractIds)
    .sort();

  assert.deepEqual(boundIds, activeIds);
  assert.equal(new Set(boundIds).size, boundIds.length);
  for (const fakeId of ['data-planner', 'data-agent', 'review-adjudicator', 'publisher']) {
    assert.equal(boundIds.includes(fakeId), false, `${fakeId} must not masquerade as an active Agent contract`);
  }
});

test('dependencies, conditions, production parallel groups, and dynamic rounds are explicit', () => {
  const byId = Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId['plan-research'].dependsOn, ['initialize-checkpoint']);
  assert.deepEqual(byId['select-candidates'].dependsOn, ['plan-research']);
  assert.deepEqual(byId['run-research-rounds'].dependsOn, ['select-candidates']);
  assert.deepEqual(byId['compose-report'].dependsOn, ['run-research-rounds']);
  assert.deepEqual(byId['review-report'].dependsOn, ['compose-report']);
  assert.deepEqual(byId['synthesize-conclusion'].dependsOn, ['review-report']);
  assert.deepEqual(byId['finalize-project'].dependsOn, ['synthesize-conclusion']);

  assert.equal(byId['plan-research'].condition, 'checkpoint.plan == null');
  assert.equal(byId['plan-research'].conditionId, 'checkpoint-plan-missing');
  assert.equal(byId['review-report'].condition, 'checkpoint.reportReview == null');
  assert.equal(byId['review-report'].conditionId, 'checkpoint-report-review-missing');
  assert.deepEqual(byId['review-report'].artifactSelection, { roundField: 'reviewRound' });
  assert.deepEqual(byId['run-research-rounds'].artifactSelection, {
    roundField: 'round',
    declaredRoundField: 'dataRound',
  });
  assert.equal(byId['run-research-rounds'].artifactPolicy, 'artifact');
  assert.equal(byId['run-research-rounds'].artifacts.producer, 'data-evidence-pipeline');
  assert.deepEqual(byId['run-research-rounds'].artifacts.requiredArtifacts, [
    'data/data_plan_rN.json',
    'data/source_documents_rN.json',
    'data/evidence_bundle_rN.json',
    'data/citation_ledger.json',
    'data/domain_events_rN.json',
    'data/organized_rN.json',
    'data/data_report.md',
  ]);

  const groups = Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.parallelGroups.map((group) => [group.id, group]));
  assert.deepEqual(groups['round-analysis'].agentContractIds, ['industry-analyst', 'company-analyst']);
  assert.deepEqual(groups['report-reviewers'].agentContractIds, [
    'evidence-reviewer',
    'requirement-reviewer',
    'logic-reviewer',
  ]);
});

test('canonical serialization and spec hash are deterministic', () => {
  const reordered = reverseObjectKeys(structuredClone(RUN_ANALYSIS_WORKFLOW_SPEC));
  assert.equal(canonicalWorkflowSpecJSON(reordered), canonicalWorkflowSpecJSON(RUN_ANALYSIS_WORKFLOW_SPEC));
  assert.equal(workflowSpecHash(reordered), RUN_ANALYSIS_WORKFLOW_SPEC_HASH);
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC_HASH, workflowSpecHash(RUN_ANALYSIS_WORKFLOW_SPEC));
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC_HASH, EXPECTED_WORKFLOW_SPEC_HASH);
  assert.match(RUN_ANALYSIS_WORKFLOW_SPEC_HASH, /^sha256:[a-f0-9]{64}$/u);
});

test('canonical remediation lookup routes to the smallest affected subgraph', () => {
  assert.deepEqual(remediationNodesFor('report'), ['compose-report', 'review-report']);
  assert.deepEqual(remediationNodesFor('system'), ['human-review']);
  assert.throws(() => remediationNodesFor('idea'), /unknown remediation owner/i);
});

test('checked-in Run Analysis Markdown is generated without drift from the canonical spec', async () => {
  const checkedIn = await readFile(new URL('../../documents/generated/run-analysis-workflow.md', import.meta.url), 'utf8');
  assert.equal(checkedIn, renderRunAnalysisWorkflowMarkdown(RUN_ANALYSIS_WORKFLOW_SPEC));
  assert.ok(checkedIn.includes(RUN_ANALYSIS_WORKFLOW_SPEC_HASH));
  assert.match(checkedIn, /```mermaid[\s\S]*flowchart TD/u);
});
