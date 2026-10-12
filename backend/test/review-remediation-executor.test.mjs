import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import { DURABLE_EVENT_TYPES } from '../src/project-space/EventBus.js';
import { FileRunStore, RUN_STATUSES } from '../src/project-space/RunStore.js';
import {
  executeWorkflowWithRemediation,
  remediationPlanForDecision,
} from '../src/workflows/run-analysis/workflowExecutor.js';

const node = (id, dependsOn = [], parallelGroup = undefined) => ({
  id,
  handlerId: id,
  conditionId: 'always',
  dependsOn,
  artifactPolicy: 'pure-return',
  ...(parallelGroup ? { parallelGroup } : {}),
});

const spec = Object.freeze({
  id: 'review-remediation-test.v1',
  version: '1.0.0',
  maxRemediationCycles: 2,
  nodes: [
    node('initialize'),
    node('plan', ['initialize']),
    node('research', ['plan']),
    node('compose', ['research'], 'report-and-scenarios'),
    node('simulate', ['research'], 'report-and-scenarios'),
    node('review', ['compose', 'simulate']),
    node('conclusion', ['review']),
    node('finalize', ['conclusion']),
  ],
  parallelGroups: [{
    id: 'report-and-scenarios',
    scope: 'nodes',
    nodeIds: ['compose', 'simulate'],
    joinBefore: 'review',
  }],
  remediationRoutes: [
    { owner: 'data', nodeIds: ['research', 'compose', 'simulate', 'review', 'conclusion', 'finalize'] },
    { owner: 'industry', nodeIds: ['research', 'compose', 'simulate', 'review', 'conclusion', 'finalize'] },
    { owner: 'company', nodeIds: ['research', 'compose', 'simulate', 'review', 'conclusion', 'finalize'] },
    { owner: 'report', nodeIds: ['compose', 'review'] },
    { owner: 'system', nodeIds: [], terminal: 'human-review' },
  ],
});

function issue(owner, id = `${owner}-issue`) {
  return {
    schemaVersion: 'review-issue.v1',
    id,
    owner,
    severity: 'critical',
    location: 'report',
    evidence: [],
    requestedAction: `repair ${owner}`,
    message: `${owner} is blocking`,
    sourceReviewer: 'test',
    blocking: true,
  };
}

function decision(owner, cycle, { humanReview = false } = {}) {
  const openIssues = [issue(owner, `${owner}-issue-c${cycle}`)];
  return {
    converged: false,
    cycle,
    route: humanReview ? 'human-review' : owner,
    openIssues,
  };
}

const publishDecision = (cycle) => ({ converged: true, cycle, route: 'publish', openIssues: [] });

function fixture(t, decisions) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-review-remediation-'));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const runStore = new FileRunStore({ projectId: 'proj_review', projectsDir });
  const runId = 'run-review';
  runStore.begin({
    runId,
    workflowSpec: { id: spec.id, version: spec.version, hash: canonicalSha256(spec) },
    inputDigest: canonicalSha256({ project: 'review' }),
    asOf: '2026-07-16T00:00:00.000Z',
    nodeIds: spec.nodes.map((entry) => entry.id),
  });
  const context = {
    calls: Object.fromEntries(spec.nodes.map((entry) => [entry.id, 0])),
    branches: { data: 0, industry: 0, company: 0 },
    decisions: [...decisions],
    currentDecision: null,
    activeRemediation: null,
  };
  const handlers = Object.fromEntries(spec.nodes.map((entry) => [entry.handlerId, async (current) => {
    current.calls[entry.id] += 1;
    if (entry.id === 'research') {
      const owners = current.activeRemediation?.owners || ['data', 'industry', 'company'];
      for (const owner of owners) current.branches[owner] += 1;
    }
    if (entry.id === 'review') current.currentDecision = current.decisions.shift();
    return { nodeId: entry.id, call: current.calls[entry.id] };
  }]));
  const hydrators = Object.fromEntries(spec.nodes.map((entry) => [entry.handlerId, async () => null]));
  return { context, handlers, hydrators, runId, runStore };
}

async function runFixture(fx, { onHumanReview = null } = {}) {
  return executeWorkflowWithRemediation({
    spec,
    handlers: fx.handlers,
    hydrators: fx.hydrators,
    conditions: { always: () => true },
    context: fx.context,
    runStore: fx.runStore,
    runId: fx.runId,
    reviewNodeId: 'review',
    getReviewDecision: ({ context }) => context.currentDecision,
    onRemediation: ({ context, plan, cycle, decision: currentDecision }) => {
      context.activeRemediation = {
        cycle,
        owners: plan.owners,
        nodeIds: plan.nodeIds,
        issues: currentDecision.openIssues,
      };
    },
    onHumanReview,
  });
}

test('remediation planning unions multiple owner routes in canonical node order', () => {
  const plan = remediationPlanForDecision(spec, {
    route: 'data',
    cycle: 0,
    openIssues: [issue('report'), issue('data')],
  });
  assert.deepEqual(plan.owners, ['report', 'data']);
  assert.deepEqual(plan.nodeIds, ['research', 'compose', 'simulate', 'review', 'conclusion', 'finalize']);
  assert.equal(plan.humanReview, false);
});

test('remediation planning preserves a system warning without pre-empting concrete owner routes', () => {
  const systemWarning = {
    ...issue('system', 'system-warning'),
    severity: 'warning',
    message: 'The deterministic quality audit remains unresolved.',
  };
  const plan = remediationPlanForDecision(spec, {
    route: 'report',
    cycle: 0,
    openIssues: [issue('report'), systemWarning],
  });

  assert.deepEqual(plan.owners, ['report']);
  assert.deepEqual(plan.nodeIds, ['compose', 'review']);
  assert.equal(plan.humanReview, false);
});

test('remediation planning still escalates system-only and critical system issues', () => {
  const warningOnly = remediationPlanForDecision(spec, {
    route: 'human-review',
    cycle: 0,
    openIssues: [{ ...issue('system'), severity: 'warning' }],
  });
  const criticalMixed = remediationPlanForDecision(spec, {
    route: 'report',
    cycle: 0,
    openIssues: [issue('report'), issue('system')],
  });

  assert.equal(warningOnly.humanReview, true);
  assert.equal(criticalMixed.humanReview, true);
});

for (const owner of ['data', 'industry', 'company', 'report']) {
  test(`owner=${owner} invalidates only its declared route and leaves unrelated upstream calls at zero`, async (t) => {
    const fx = fixture(t, [decision(owner, 0), publishDecision(1)]);
    const result = await runFixture(fx);
    assert.equal(result.blocked, false);
    fx.runStore.completeRun(fx.runId);

    assert.equal(fx.context.calls.initialize, 1);
    assert.equal(fx.context.calls.plan, 1);
    assert.equal(fx.context.calls.research, owner === 'report' ? 1 : 2);
    assert.equal(fx.context.calls.compose, 2);
    assert.equal(fx.context.calls.simulate, owner === 'report' ? 1 : 2);
    assert.equal(fx.context.calls.review, 2);
    assert.equal(fx.context.calls.conclusion, 1);
    assert.equal(fx.context.calls.finalize, 1);
    for (const branch of ['data', 'industry', 'company']) {
      assert.equal(fx.context.branches[branch], 1 + (owner === branch ? 1 : 0));
    }

    const run = fx.runStore.load(fx.runId);
    assert.equal(run.status, RUN_STATUSES.SUCCEEDED);
    assert.equal(run.nodes.plan.attempt, 1);
    assert.equal(run.nodes.compose.attempt, 2);
    assert.equal(run.nodes.simulate.attempt, owner === 'report' ? 1 : 2);
    const invalidated = fx.runStore.eventBus.list({ runId: fx.runId })
      .filter((event) => event.eventType === DURABLE_EVENT_TYPES.NODE_INVALIDATED)
      .map((event) => event.nodeId);
    assert.deepEqual(invalidated, spec.remediationRoutes.find((route) => route.owner === owner).nodeIds);
  });
}

test('mixed system warning and report blocker complete one selective remediation cycle', async (t) => {
  const firstDecision = {
    converged: false,
    cycle: 0,
    route: 'report',
    openIssues: [
      issue('report', 'report-cycle-zero'),
      { ...issue('system', 'system-warning-cycle-zero'), severity: 'warning' },
    ],
  };
  const fx = fixture(t, [firstDecision, publishDecision(1)]);
  const result = await runFixture(fx);
  assert.equal(result.blocked, false);
  fx.runStore.completeRun(fx.runId);

  assert.equal(fx.context.calls.compose, 2);
  assert.equal(fx.context.calls.review, 2);
  assert.equal(fx.context.calls.research, 1);
  assert.equal(fx.context.calls.simulate, 1);
  assert.equal(fx.runStore.load(fx.runId).remediationHistory.length, 1);
  assert.deepEqual(fx.runStore.load(fx.runId).remediationHistory[0].owners, ['report']);
});

test('cycle two exhaustion completes publication by default without Human Review', async (t) => {
  const fx = fixture(t, [decision('report', 0), decision('report', 1), decision('report', 2, { humanReview: true })]);
  const result = await runFixture(fx);

  assert.equal(result.blocked, false);
  assert.equal(result.humanReviewBypassed, true);
  assert.equal(result.reviewDecision.route, 'human-review');
  fx.runStore.completeRun(fx.runId);
  const run = fx.runStore.load(fx.runId);
  assert.equal(run.status, RUN_STATUSES.SUCCEEDED);
  assert.equal(run.stopReason, 'final');
  assert.deepEqual(run.openIssues, []);
  assert.equal(run.nodes.conclusion.status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes.finalize.status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes.compose.attempt, 3);
  assert.equal(run.nodes.review.attempt, 3);
  assert.equal(fx.runStore.resumable(), null);

  const events = fx.runStore.eventBus.list({ runId: fx.runId });
  assert.equal(events.filter((event) => event.eventType === DURABLE_EVENT_TYPES.RUN_REMEDIATION_STARTED).length, 2);
  assert.equal(events.filter((event) => event.eventType === DURABLE_EVENT_TYPES.NODE_INVALIDATED).length, 4);
  assert.equal(events.at(-1).eventType, DURABLE_EVENT_TYPES.RUN_SUCCEEDED);
  const replay = fx.runStore.eventBus.replay({ runId: fx.runId });
  assert.equal(replay.runs[fx.runId].status, RUN_STATUSES.SUCCEEDED);
  assert.deepEqual(replay.runs[fx.runId].openIssues, []);
});
