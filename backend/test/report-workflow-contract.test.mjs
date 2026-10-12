import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_STATES,
  canTransitionNodeState,
  transitionNodeState,
} from '../src/core/workflow/NodeState.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  remediationNodesFor,
  topologicalNodeOrder,
} from '../src/workflows/run-analysis/workflowSpec.js';

const expectedStates = [
  'PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED_TRANSIENT', 'FAILED_BUSINESS',
  'FAILED_SCHEMA', 'FAILED_PERMISSION', 'BLOCKED', 'CANCELLED',
];

test('report workflow v1 is versioned, frozen, and acyclic', () => {
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC.id, 'run-analysis.v2');
  assert.equal(RUN_ANALYSIS_WORKFLOW_SPEC.version, '2.0.0');
  assert.ok(Object.isFrozen(RUN_ANALYSIS_WORKFLOW_SPEC));
  const order = topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC);
  assert.equal(order.length, RUN_ANALYSIS_WORKFLOW_SPEC.nodes.length);
  assert.equal(new Set(order).size, order.length);
  const position = Object.fromEntries(order.map((id, index) => [id, index]));
  for (const node of RUN_ANALYSIS_WORKFLOW_SPEC.nodes) {
    for (const dependency of node.dependsOn) assert.ok(position[dependency] < position[node.id], `${dependency} must precede ${node.id}`);
  }
});

test('report workflow freezes the intended business chain and reviewer fan-out/join', () => {
  const byId = Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => [node.id, node]));
  assert.deepEqual(byId['run-research-rounds'].dependsOn, ['select-candidates']);
  assert.deepEqual(byId['compose-report'].dependsOn, ['run-research-rounds']);
  assert.deepEqual(byId['review-report'].dependsOn, ['compose-report']);
  assert.deepEqual(byId['synthesize-conclusion'].dependsOn, ['review-report']);
});

test('node state machine accepts only the frozen transition contract', () => {
  assert.deepEqual(Object.values(NODE_STATES), expectedStates);
  const allowed = [
    ['PENDING', 'READY'], ['READY', 'RUNNING'], ['RUNNING', 'SUCCEEDED'],
    ['RUNNING', 'FAILED_TRANSIENT'], ['FAILED_TRANSIENT', 'READY'],
    ['RUNNING', 'FAILED_BUSINESS'], ['RUNNING', 'FAILED_SCHEMA'],
    ['RUNNING', 'FAILED_PERMISSION'], ['RUNNING', 'BLOCKED'], ['RUNNING', 'CANCELLED'],
  ];
  for (const [from, to] of allowed) assert.equal(canTransitionNodeState(from, to), true, `${from} -> ${to}`);
  for (const [from, to] of [['PENDING', 'SUCCEEDED'], ['READY', 'SUCCEEDED'], ['SUCCEEDED', 'RUNNING']]) {
    assert.equal(canTransitionNodeState(from, to), false, `${from} -> ${to} must be rejected`);
    assert.throws(() => transitionNodeState({ status: from }, to), /invalid node state transition/i);
  }
  assert.throws(() => canTransitionNodeState('UNKNOWN', 'READY'), /invalid/u);
});

test('review remediation owners route to the smallest affected subgraph', () => {
  const compositeRoute = ['run-research-rounds', 'compose-report', 'review-report', 'synthesize-conclusion', 'finalize-project'];
  assert.deepEqual(remediationNodesFor('data'), compositeRoute);
  assert.deepEqual(remediationNodesFor('industry'), compositeRoute);
  assert.deepEqual(remediationNodesFor('company'), compositeRoute);
  assert.deepEqual(remediationNodesFor('report'), ['compose-report', 'review-report']);
  assert.deepEqual(remediationNodesFor('system'), ['human-review']);
  assert.throws(() => remediationNodesFor('idea'), /unknown remediation owner/i);
});
