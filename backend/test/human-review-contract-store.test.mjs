import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
  HUMAN_REVIEW_TASK_SCHEMA_VERSION,
  LOCAL_HUMAN_REVIEWER,
  createHumanReviewDecision,
  createHumanReviewTask,
  humanReviewDecisionId,
  humanReviewRequestDigest,
  humanReviewTaskId,
  validateHumanReviewDecision,
  validateHumanReviewTask,
} from '../src/core/contracts/HumanReview.js';
import { canonicalSha256, createArtifactRef } from '../src/core/contracts/ArtifactRef.js';
import { DURABLE_EVENT_TYPES, FileEventBus } from '../src/project-space/EventBus.js';
import { FileHumanReviewStore } from '../src/project-space/HumanReviewStore.js';

const at = '2026-07-23T00:00:00.000Z';
const digest = (value) => canonicalSha256(value);

function artifactRef(overrides = {}) {
  return createArtifactRef({
    artifactId: 'proj_review:analysis/reviews/logic_r3.json',
    version: 1,
    path: 'analysis/reviews/logic_r3.json',
    contentDigest: digest({ review: 'logic' }),
    schemaVersion: 'review-result.v1',
    producer: 'logic-reviewer',
    contractVersion: '1.0.0',
    inputDigest: digest({ input: 'review' }),
    createdAt: at,
    asOf: at,
    ...overrides,
  });
}

function issue(overrides = {}) {
  return {
    schemaVersion: 'review-issue.v1',
    id: 'report-blocking',
    owner: 'report',
    severity: 'critical',
    location: 'valuation',
    evidence: ['evidence:1'],
    requestedAction: 'Repair the valuation bridge.',
    message: 'The valuation bridge is incomplete.',
    sourceReviewer: 'logic',
    blocking: true,
    ...overrides,
  };
}

function taskInput(overrides = {}) {
  const issues = overrides.issues || [issue()];
  const reviewRef = overrides.reviewArtifactRefs?.[0] || artifactRef();
  const identity = {
    projectId: 'proj_review',
    runId: 'artifact-run-proj_review-1',
    workflowHash: digest({ workflow: 'run-analysis.v1' }),
    reviewBlockCount: 1,
    blockedStateDigest: digest({ status: 'BLOCKED', issues }),
  };
  return {
    schemaVersion: HUMAN_REVIEW_TASK_SCHEMA_VERSION,
    taskId: humanReviewTaskId(identity),
    version: 1,
    status: 'open',
    projectId: identity.projectId,
    runId: identity.runId,
    workflow: {
      id: 'run-analysis.v1',
      version: '1.2.0',
      hash: identity.workflowHash,
    },
    blockedNodeId: 'synthesize-conclusion',
    reviewNodeId: 'review-report',
    remediationCycle: 2,
    reviewBlockCount: 1,
    blockedStateDigest: identity.blockedStateDigest,
    issues,
    issuesDigest: digest(issues),
    allowedActions: [
      'resume-remediation',
      'report-only-revision',
      'downgrade-and-publish',
      'terminate',
    ],
    requestedActions: issues.map((entry) => ({
      issueId: entry.id,
      owner: entry.owner,
      requestedAction: entry.requestedAction,
    })),
    createdAt: at,
    updatedAt: at,
    policy: {
      version: 'run-analysis-human-review.v1',
      digest: digest({ policy: 'waiver-disabled' }),
      waiveAndPublishEnabled: false,
    },
    reviewArtifactRefs: [reviewRef],
    reviewDecisionArtifactRef: reviewRef,
    previousTaskRef: null,
    producingDecisionRef: null,
    ...overrides,
  };
}

function decisionFor(task, taskRef, overrides = {}) {
  const issueDecisions = overrides.issueDecisions || [{
    issueId: task.issues[0].id,
    disposition: 'accept',
    comment: 'Address the reviewer finding.',
    targetOwner: null,
    requestedAction: task.issues[0].requestedAction,
  }];
  const selectedAction = overrides.selectedAction || 'report-only-revision';
  const downgradeInstruction = overrides.downgradeInstruction ?? null;
  const requestDigest = humanReviewRequestDigest({
    taskId: task.taskId,
    taskVersion: task.version,
    taskRef,
    reviewer: LOCAL_HUMAN_REVIEWER,
    issueDecisions,
    globalComment: overrides.globalComment || '',
    selectedAction,
    downgradeInstruction,
  });
  return createHumanReviewDecision({
    schemaVersion: HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
    decisionId: humanReviewDecisionId({
      taskId: task.taskId,
      reviewerId: LOCAL_HUMAN_REVIEWER.id,
      requestDigest,
    }),
    taskId: task.taskId,
    taskVersion: task.version,
    taskRef,
    reviewer: LOCAL_HUMAN_REVIEWER,
    decidedAt: at,
    issueDecisions,
    globalComment: overrides.globalComment || '',
    selectedAction,
    downgradeInstruction,
    policyEvaluation: {
      allowed: true,
      policyVersion: task.policy.version,
      policyDigest: task.policy.digest,
      denials: [],
    },
    requestDigest,
    previousDecisionRef: null,
  });
}

test('Human Review contracts bind exact content, strict fields, and canonical request identity', () => {
  const task = createHumanReviewTask(taskInput());
  assert.equal(validateHumanReviewTask(task).valid, true);
  assert.match(task.taskId, /^hrt_[a-f0-9]{64}$/u);
  assert.equal(task.contentDigest, digest(Object.fromEntries(
    Object.entries(task).filter(([field]) => field !== 'contentDigest'),
  )));

  const taskRef = artifactRef({
    artifactId: `${task.projectId}:human-review-task:${task.taskId}`,
    path: `analysis/human-reviews/${task.taskId}/task.v1.json`,
    contentDigest: digest(task),
    schemaVersion: HUMAN_REVIEW_TASK_SCHEMA_VERSION,
    producer: 'human-review-controller',
    inputDigest: task.blockedStateDigest,
  });
  const decision = decisionFor(task, taskRef);
  assert.equal(validateHumanReviewDecision(decision).valid, true);
  assert.match(decision.decisionId, /^hrd_[a-f0-9]{64}$/u);
  assert.equal(
    decisionFor(task, taskRef).decisionId,
    decision.decisionId,
    'the same normalized request must keep one logical decision identity',
  );

  assert.equal(validateHumanReviewTask({ ...task, arbitraryNodeIds: ['finalize-project'] }).valid, false);
  assert.equal(validateHumanReviewDecision({
    ...decision,
    issueDecisions: [{ ...decision.issueDecisions[0], file: 'analysis/checkpoint.json' }],
  }).valid, false);
  assert.equal(validateHumanReviewTask({ ...task, issuesDigest: digest({ changed: true }) }).valid, false);
  assert.equal(validateHumanReviewDecision({ ...decision, contentDigest: digest({ changed: true }) }).valid, false);
});

test('FileHumanReviewStore journals immutable Task/Decision revisions with typed replay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-human-review-store-'));
  const storageDir = path.join(root, 'project');
  fs.mkdirSync(storageDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 6, 23, 0, 0, tick++)).toISOString();
  const eventBus = new FileEventBus({
    projectId: 'proj_review',
    storageDir,
    now,
  });
  const store = new FileHumanReviewStore({
    projectId: 'proj_review',
    storageDir,
    eventBus,
    now,
  });

  const created = store.createTask(taskInput());
  assert.equal(created.status, 'open');
  assert.equal(created.version, 1);
  assert.equal(created.taskArtifactRef.version, 1);
  assert.deepEqual(store.createTask(taskInput()), created, 'task creation replay is idempotent');

  const decision = decisionFor(created, created.taskArtifactRef);
  const decided = store.recordDecision(created.taskId, decision);
  assert.equal(decided.status, 'decided');
  assert.equal(decided.version, 2);
  assert.equal(decided.decision.decisionId, decision.decisionId);
  assert.equal(decided.decisionArtifactRef.version, 1);
  assert.deepEqual(store.recordDecision(created.taskId, decision), decided);

  const conflicting = createHumanReviewDecision({
    ...decision,
    globalComment: 'different',
    requestDigest: digest({ different: true }),
    decisionId: humanReviewDecisionId({
      taskId: decision.taskId,
      reviewerId: decision.reviewer.id,
      requestDigest: digest({ different: true }),
    }),
    contentDigest: undefined,
  });
  assert.throws(
    () => store.recordDecision(created.taskId, conflicting),
    (error) => error?.code === 'HUMAN_REVIEW_DECISION_CONFLICT',
  );

  const resuming = store.markResuming(created.taskId, {
    decisionId: decision.decisionId,
    humanReviewAttempt: 1,
    reviewRound: 4,
    owners: ['report'],
    rerunNodeIds: ['compose-report', 'review-report'],
    reopenNodeIds: ['synthesize-conclusion', 'finalize-project'],
    resumedAt: '2026-07-23T00:00:10.000Z',
  });
  assert.equal(resuming.status, 'resuming');
  assert.equal(resuming.version, 3);

  const resolved = store.markOutcome(created.taskId, {
    status: 'resolved',
    resultingRunStatus: 'SUCCEEDED',
    completedAt: '2026-07-23T00:00:20.000Z',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.version, 4);
  assert.equal(store.open(), null);

  const types = eventBus.list({ runId: created.runId }).map((event) => event.eventType);
  assert.ok(types.includes(DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_CREATED));
  assert.ok(types.includes(DURABLE_EVENT_TYPES.HUMAN_REVIEW_DECISION_RECORDED));
  assert.ok(types.includes(DURABLE_EVENT_TYPES.HUMAN_REVIEW_RESUME_STARTED));
  assert.ok(types.includes(DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_RESOLVED));
  const replay = eventBus.replay({ runId: created.runId }).runs[created.runId];
  assert.equal(replay.humanReviews.tasks[created.taskId].status, 'resolved');
  assert.equal(replay.humanReviews.decisions[decision.decisionId].selectedAction, 'report-only-revision');
  assert.equal(replay.humanReviews.resumes[0].reviewRound, 4);

  const manifest = store.artifactStore.manifest();
  assert.equal(manifest.versions.filter((entry) => (
    entry.runId === created.runId
    && entry.nodeId === 'human-review'
  )).length, 5);
});
