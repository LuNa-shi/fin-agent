import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256, createArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../src/core/workflow/NodeState.js';
import { DURABLE_EVENT_TYPES } from '../src/project-space/EventBus.js';
import { FileRunStore, RUN_STATUSES } from '../src/project-space/RunStore.js';

const at = '2026-07-23T00:00:00.000Z';
const digest = (value) => canonicalSha256(value);

function ref(nodeId, version = 1) {
  return createArtifactRef({
    artifactId: `proj_review:analysis/${nodeId}.json`,
    version,
    path: `analysis/${nodeId}.json`,
    contentDigest: digest({ nodeId, version }),
    schemaVersion: `${nodeId}.v1`,
    producer: nodeId,
    contractVersion: '1.0.0',
    inputDigest: digest({ input: nodeId, version }),
    createdAt: at,
    asOf: at,
  });
}

function completeNode(store, runId, nodeId, version = 1) {
  store.markReady(runId, nodeId);
  store.startNode(runId, nodeId, digest({ nodeId, version }));
  return store.succeedNode(runId, nodeId, {
    artifactRefs: [ref(nodeId, version)],
    output: { nodeId, version },
  });
}

function blockingIssue() {
  return {
    schemaVersion: 'review-issue.v1',
    id: 'report-blocking',
    owner: 'report',
    severity: 'critical',
    location: 'valuation',
    evidence: [],
    requestedAction: 'Repair valuation.',
    message: 'Valuation is incomplete.',
    sourceReviewer: 'logic',
    blocking: true,
  };
}

test('reviewed resume atomically preserves automatic history and reopens only the authorized subgraph', (t) => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-run-review-'));
  fs.mkdirSync(path.join(projectsDir, 'proj_review'), { recursive: true });
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  let tick = 0;
  const store = new FileRunStore({
    projectId: 'proj_review',
    projectsDir,
    now: () => new Date(Date.UTC(2026, 6, 23, 0, 0, tick++)).toISOString(),
  });
  const runId = 'artifact-run-proj_review-1';
  store.begin({
    runId,
    workflowSpec: {
      id: 'run-analysis.v1',
      version: '1.2.0',
      hash: digest({ workflow: 'run-analysis.v1' }),
    },
    inputDigest: digest({ project: 'review' }),
    asOf: at,
    nodeIds: [
      'plan-research',
      'compose-report',
      'review-report',
      'synthesize-conclusion',
      'finalize-project',
    ],
  });
  completeNode(store, runId, 'plan-research');
  completeNode(store, runId, 'compose-report');
  completeNode(store, runId, 'review-report');

  for (const cycle of [1, 2]) {
    store.invalidateNodes(runId, ['compose-report', 'review-report'], {
      cycle,
      owners: ['report'],
      openIssues: [blockingIssue()],
    });
    completeNode(store, runId, 'compose-report', cycle + 1);
    completeNode(store, runId, 'review-report', cycle + 1);
  }
  const blocked = store.blockRun(runId, {
    reason: 'human-review',
    openIssues: [blockingIssue()],
  });
  assert.equal(blocked.status, RUN_STATUSES.BLOCKED);
  assert.equal(blocked.reviewBlockCount, 1);
  assert.match(blocked.blockedStateDigest, /^sha256:[a-f0-9]{64}$/u);
  const automaticHistory = structuredClone(blocked.remediationHistory);
  const upstream = structuredClone(blocked.nodes['plan-research']);
  const decisionRef = ref('human-review-decision');

  const transition = {
    expectedBlockedStateDigest: blocked.blockedStateDigest,
    taskId: 'hrt_'.concat('1'.repeat(64)),
    taskVersion: 1,
    decisionId: 'hrd_'.concat('2'.repeat(64)),
    decisionRef,
    decisionDigest: digest({ decision: 'resume' }),
    selectedAction: 'report-only-revision',
    humanReviewAttempt: 1,
    reviewRound: 4,
    owners: ['report'],
    rerunNodeIds: ['compose-report', 'review-report'],
    reopenNodeIds: ['synthesize-conclusion', 'finalize-project'],
    openIssues: [blockingIssue()],
  };
  const resumed = store.resumeFromHumanReview(runId, transition);
  assert.equal(resumed.status, RUN_STATUSES.RUNNING);
  assert.equal(resumed.remediationCycle, 2);
  assert.deepEqual(resumed.remediationHistory, automaticHistory);
  assert.deepEqual(resumed.nodes['plan-research'], upstream);
  assert.equal(resumed.nodes['compose-report'].status, NODE_STATES.PENDING);
  assert.equal(resumed.nodes['review-report'].status, NODE_STATES.PENDING);
  assert.equal(resumed.nodes['synthesize-conclusion'].status, NODE_STATES.PENDING);
  assert.equal(resumed.nodes['finalize-project'].status, NODE_STATES.PENDING);
  assert.equal(resumed.humanReviewAttempt, 1);
  assert.equal(resumed.humanReviewHistory.length, 1);
  assert.equal(resumed.humanReviewHistory[0].reviewRound, 4);
  assert.equal(resumed.humanReviewHistory[0].automaticRemediationCycle, 2);
  assert.deepEqual(store.resumeFromHumanReview(runId, transition), resumed);

  assert.throws(
    () => store.resumeFromHumanReview(runId, {
      ...transition,
      owners: ['data'],
    }),
    (error) => error?.code === 'HUMAN_REVIEW_TRANSITION_CONFLICT',
  );

  const events = store.eventBus.list({ runId });
  assert.equal(events.filter((event) => event.eventType === DURABLE_EVENT_TYPES.RUN_REMEDIATION_STARTED).length, 2);
  assert.equal(events.filter((event) => event.eventType === DURABLE_EVENT_TYPES.NODE_INVALIDATED).length, 4);
  assert.equal(events.filter((event) => event.eventType === DURABLE_EVENT_TYPES.NODE_HUMAN_REVIEW_INVALIDATED).length, 4);
  const replay = store.eventBus.replay({ runId }).runs[runId];
  assert.equal(replay.status, RUN_STATUSES.RUNNING);
  assert.equal(replay.remediationCycle, 2);
  assert.equal(replay.nodes['compose-report'].status, NODE_STATES.PENDING);
  assert.equal(replay.nodes['finalize-project'].status, NODE_STATES.PENDING);

  completeNode(store, runId, 'compose-report', 4);
  completeNode(store, runId, 'review-report', 4);
  const reblocked = store.blockRun(runId, {
    reason: 'human-review',
    openIssues: [blockingIssue()],
  });
  assert.equal(reblocked.reviewBlockCount, 2);
  assert.notEqual(reblocked.blockedStateDigest, blocked.blockedStateDigest);
  assert.equal(
    store.eventBus.list({ runId }).filter((event) => event.eventType === DURABLE_EVENT_TYPES.RUN_BLOCKED).length,
    2,
  );

  const termination = {
    expectedBlockedStateDigest: reblocked.blockedStateDigest,
    taskId: 'hrt_'.concat('3'.repeat(64)),
    taskVersion: 1,
    decisionId: 'hrd_'.concat('4'.repeat(64)),
    decisionRef: ref('human-review-termination'),
    decisionDigest: digest({ decision: 'terminate' }),
    selectedAction: 'terminate',
  };
  const terminated = store.terminateFromHumanReview(runId, termination);
  assert.equal(terminated.status, RUN_STATUSES.CANCELLED);
  assert.equal(terminated.stopReason, 'human-review-terminated');
  assert.equal(terminated.nodes['synthesize-conclusion'].status, NODE_STATES.CANCELLED);
  assert.equal(terminated.nodes['finalize-project'].status, NODE_STATES.CANCELLED);
  assert.deepEqual(store.terminateFromHumanReview(runId, termination), terminated);
  assert.equal(store.eventBus.replay({ runId }).runs[runId].status, RUN_STATUSES.CANCELLED);
});
