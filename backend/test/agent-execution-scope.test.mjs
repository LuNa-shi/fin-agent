import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_WORKSPACE_MODES,
  assertDirectExecutionScopeBinding,
  beginDirectAgentCommand,
  createDirectExecutionScope,
} from '../src/core/contracts/AgentExecutionScope.js';

const AS_OF = '2026-07-23T06:00:00.000Z';

function validScope(overrides = {}) {
  return {
    runId: 'direct:decision.v1:command-1',
    workflowId: 'decision.v1',
    nodeId: 'rank-ideas',
    projectId: 'global',
    asOf: AS_OF,
    workspaceMode: 'none',
    workspaceSnapshotId: 'none:direct:decision.v1:command-1',
    inputArtifactRefs: [],
    priorReviewIssues: [],
    idempotencyKey: 'direct-command:command-1',
    ...overrides,
  };
}

test('direct execution scope validates, clones, and deeply freezes semantic state', () => {
  const inputArtifactRefs = [{
    artifactId: 'analysis.plan',
    lineage: { paths: ['analysis/plan.json'] },
  }];
  const priorReviewIssues = [{
    issueId: 'issue-1',
    evidence: [{ ref: 'analysis.plan' }],
  }];
  const controller = new AbortController();

  const scope = createDirectExecutionScope(validScope({
    inputArtifactRefs,
    priorReviewIssues,
    signal: controller.signal,
  }));

  assert.deepEqual(AGENT_WORKSPACE_MODES, ['project', 'idea-run', 'none']);
  assert.equal(Object.isFrozen(AGENT_WORKSPACE_MODES), true);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.inputArtifactRefs), true);
  assert.equal(Object.isFrozen(scope.inputArtifactRefs[0]), true);
  assert.equal(Object.isFrozen(scope.inputArtifactRefs[0].lineage.paths), true);
  assert.equal(Object.isFrozen(scope.priorReviewIssues[0].evidence[0]), true);
  assert.notEqual(scope.inputArtifactRefs, inputArtifactRefs);
  assert.notEqual(scope.inputArtifactRefs[0], inputArtifactRefs[0]);
  assert.notEqual(scope.priorReviewIssues, priorReviewIssues);

  inputArtifactRefs[0].artifactId = 'mutated';
  inputArtifactRefs[0].lineage.paths.push('analysis/other.json');
  priorReviewIssues[0].evidence[0].ref = 'mutated';
  assert.equal(scope.inputArtifactRefs[0].artifactId, 'analysis.plan');
  assert.deepEqual(scope.inputArtifactRefs[0].lineage.paths, ['analysis/plan.json']);
  assert.equal(scope.priorReviewIssues[0].evidence[0].ref, 'analysis.plan');
  assert.throws(() => scope.inputArtifactRefs.push({}), /not extensible/u);

  assert.equal(scope.signal, controller.signal);
  assert.equal(Object.isFrozen(scope.signal), false);
  controller.abort('test');
  assert.equal(scope.signal.aborted, true);
});

test('direct execution scope rejects missing, malformed, and unknown semantics', () => {
  assert.throws(
    () => createDirectExecutionScope(null),
    /DirectExecutionScope must be an object/u,
  );

  for (const field of [
    'runId',
    'workflowId',
    'nodeId',
    'projectId',
    'asOf',
    'workspaceMode',
    'workspaceSnapshotId',
    'inputArtifactRefs',
    'priorReviewIssues',
    'idempotencyKey',
  ]) {
    const value = validScope();
    delete value[field];
    assert.throws(
      () => createDirectExecutionScope(value),
      new RegExp(`DirectExecutionScope\\.${field} is required`, 'u'),
      `${field} must remain required`,
    );
  }

  assert.throws(
    () => createDirectExecutionScope(validScope({ asOf: '2026-07-23' })),
    /asOf must be an ISO timestamp/u,
  );
  assert.throws(
    () => createDirectExecutionScope(validScope({ workspaceMode: 'global' })),
    /workspaceMode is invalid/u,
  );
  assert.throws(
    () => createDirectExecutionScope(validScope({ inputArtifactRefs: {} })),
    /inputArtifactRefs must be an array/u,
  );
  assert.throws(
    () => createDirectExecutionScope(validScope({ priorReviewIssues: null })),
    /priorReviewIssues must be an array/u,
  );
  assert.throws(
    () => createDirectExecutionScope({ ...validScope(), attempt: 1 }),
    /unknown fields: attempt/u,
  );
  assert.throws(
    () => createDirectExecutionScope(validScope({
      priorReviewIssues: [{ score: Number.NaN }],
    })),
    /finite JSON-compatible semantic values/u,
  );
});

test('direct command derives stable explicit project identity and defaults', () => {
  const first = beginDirectAgentCommand({
    commandId: 'command-42',
    workflowId: 'decision.v1',
    nodeId: 'rank-ideas',
    workspaceMode: 'project',
    projectId: 'proj_42',
    asOf: AS_OF,
  });
  const repeated = beginDirectAgentCommand({
    commandId: 'command-42',
    workflowId: 'decision.v1',
    nodeId: 'rank-ideas',
    workspaceMode: 'project',
    projectId: 'proj_42',
    asOf: AS_OF,
  });

  assert.deepEqual(first, repeated);
  assert.equal(first.runId, 'direct:decision.v1:command-42');
  assert.equal(first.idempotencyKey, 'direct-command:command-42');
  assert.equal(first.workspaceSnapshotId, 'proj_42:live');
  assert.deepEqual(first.inputArtifactRefs, []);
  assert.deepEqual(first.priorReviewIssues, []);
  assert.equal(Object.isFrozen(first), true);

  const noWorkspace = beginDirectAgentCommand({
    commandId: 'command-none',
    workflowId: 'support.v1',
    nodeId: 'translate-report',
    workspaceMode: 'none',
    asOf: AS_OF,
  });
  assert.equal(noWorkspace.projectId, 'global');
  assert.equal(noWorkspace.workspaceSnapshotId, `none:${noWorkspace.runId}`);
  assert.throws(
    () => beginDirectAgentCommand({
      commandId: 'missing-project',
      workflowId: 'support.v1',
      nodeId: 'edit-report',
      workspaceMode: 'project',
      asOf: AS_OF,
    }),
    /projectId is required for project workspace mode/u,
  );
});

test('direct command preserves explicit identity and requires idea-run snapshot', () => {
  const scope = beginDirectAgentCommand({
    commandId: 'command-idea',
    runId: 'idea-run-7',
    idempotencyKey: 'idea-command-7',
    workflowId: 'idea-generation.v2',
    nodeId: 'generate-candidates',
    workspaceMode: 'idea-run',
    workspaceSnapshotId: 'idea-snapshot-7',
    projectId: 'global',
    asOf: AS_OF,
    inputArtifactRefs: [{ artifactId: 'mandate.v1' }],
    priorReviewIssues: [{ issueId: 'issue-7' }],
  });

  assert.equal(scope.runId, 'idea-run-7');
  assert.equal(scope.idempotencyKey, 'idea-command-7');
  assert.equal(scope.workspaceSnapshotId, 'idea-snapshot-7');
  assert.throws(
    () => beginDirectAgentCommand({
      commandId: 'command-idea',
      workflowId: 'idea-generation.v2',
      nodeId: 'generate-candidates',
      workspaceMode: 'idea-run',
      asOf: AS_OF,
    }),
    /workspaceSnapshotId is required for idea-run workspace mode/u,
  );
});

test('separate direct commands get distinct identities while supplied command ids replay', () => {
  const options = {
    workflowId: 'support.v1',
    nodeId: 'edit-report',
    workspaceMode: 'none',
  };
  const first = beginDirectAgentCommand(options);
  const second = beginDirectAgentCommand(options);

  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.match(second.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

  const replayOptions = { ...options, commandId: 'stable-command', asOf: AS_OF };
  assert.deepEqual(
    beginDirectAgentCommand(replayOptions),
    beginDirectAgentCommand(replayOptions),
  );
});

test('direct command requires intentional workspace mode and strict options', () => {
  assert.throws(
    () => beginDirectAgentCommand({
      workflowId: 'support.v1',
      nodeId: 'edit-report',
    }),
    /workspaceMode is required/u,
  );
  assert.throws(
    () => beginDirectAgentCommand({
      workflowId: 'support.v1',
      nodeId: 'edit-report',
      workspaceMode: 'other',
    }),
    /workspaceMode is invalid/u,
  );
  assert.throws(
    () => beginDirectAgentCommand({
      workflowId: 'support.v1',
      nodeId: 'edit-report',
      workspaceMode: 'none',
      attempt: 1,
    }),
    /unknown fields: attempt/u,
  );
});

test('direct scope binding rejects cross-command and cross-project substitution', () => {
  const scope = beginDirectAgentCommand({
    commandId: 'bound-command',
    workflowId: 'report-edit.v1',
    nodeId: 'edit-report',
    projectId: 'proj_bound',
    workspaceMode: 'project',
    asOf: AS_OF,
  });
  assert.deepEqual(assertDirectExecutionScopeBinding(scope, {
    workflowId: 'report-edit.v1',
    nodeId: 'edit-report',
    projectId: 'proj_bound',
    workspaceMode: 'project',
  }), scope);
  for (const [field, value] of [
    ['workflowId', 'other-workflow.v1'],
    ['nodeId', 'other-node'],
    ['projectId', 'proj_other'],
    ['workspaceMode', 'none'],
  ]) {
    assert.throws(
      () => assertDirectExecutionScopeBinding(scope, { [field]: value }),
      new RegExp(`${field} mismatch`, 'u'),
      field,
    );
  }
});
