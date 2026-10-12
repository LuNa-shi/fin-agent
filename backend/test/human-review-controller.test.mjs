import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-human-review-controller-'));
process.env.FIN_DATA_DIR = dataDir;

const [
  { canonicalSha256, createArtifactRef },
  { NODE_STATES },
  { ProjectSpace },
  { RUN_STATUSES },
  { RunAnalysisHumanReviewController },
  { chatModify },
  { RunAnalysisService },
  {
    RUN_ANALYSIS_WORKFLOW_SPEC,
    RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    topologicalNodeOrder,
  },
] = await Promise.all([
  import('../src/core/contracts/ArtifactRef.js'),
  import('../src/core/workflow/NodeState.js'),
  import('../src/project-space/index.js'),
  import('../src/project-space/RunStore.js'),
  import('../src/workflows/run-analysis/human-review/HumanReviewController.js'),
  import('../src/workflows/run-analysis/reportEditing.js'),
  import('../src/workflows/run-analysis/RunAnalysisService.js'),
  import('../src/workflows/run-analysis/workflowSpec.js'),
]);

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const asOf = '2026-07-23T00:00:00.000Z';
const workflow = Object.freeze({
  id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
  version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
  hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
});
const nodeOrder = topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC);

function issue(overrides = {}) {
  return {
    schemaVersion: 'review-issue.v1',
    id: 'valuation-bridge',
    owner: 'report',
    severity: 'critical',
    location: 'valuation',
    evidence: ['analysis/reviews/logic_r3.json'],
    requestedAction: 'Repair the valuation bridge.',
    message: 'The valuation bridge is incomplete.',
    sourceReviewer: 'logic',
    blocking: true,
    ...overrides,
  };
}

function nodeRef(projectId, nodeId, version) {
  const pathName = nodeId === 'review-report'
    ? `analysis/reviews/report_quality_r${version}.json`
    : `analysis/${nodeId}_v${version}.json`;
  return createArtifactRef({
    artifactId: `${projectId}:${pathName}`,
    version,
    path: pathName,
    contentDigest: canonicalSha256({ projectId, nodeId, version }),
    schemaVersion: nodeId === 'review-report'
      ? 'report-quality-audit.v1'
      : `${nodeId}.test.v1`,
    producer: nodeId,
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ projectId, input: nodeId, version }),
    createdAt: asOf,
    asOf,
  });
}

function completeNode(store, projectId, runId, nodeId, version = 1) {
  store.markReady(runId, nodeId);
  store.startNode(runId, nodeId, canonicalSha256({ projectId, nodeId, version }));
  return store.succeedNode(runId, nodeId, {
    artifactRefs: [nodeRef(projectId, nodeId, version)],
    output: { nodeId, version },
  });
}

function createBlockedProject({
  title = 'Human Review fixture',
  openIssues = [issue()],
} = {}) {
  const project = ProjectSpace.create({
    title,
    tickers: ['TEST'],
    thesis: 'Test the reviewed workflow path.',
    intensity: 'standard',
  });
  const projectId = project.id;
  const runId = `artifact-run-${projectId}-1`;
  const store = ProjectSpace.runStore(projectId);
  store.begin({
    runId,
    workflowSpec: workflow,
    inputDigest: canonicalSha256({ projectId, command: 'analyze' }),
    asOf,
    nodeIds: nodeOrder,
  });

  for (const nodeId of nodeOrder.slice(0, 6)) {
    completeNode(store, projectId, runId, nodeId, 1);
  }
  for (const cycle of [1, 2]) {
    store.invalidateNodes(runId, ['compose-report', 'review-report'], {
      cycle,
      owners: ['report'],
      openIssues,
    });
    completeNode(store, projectId, runId, 'compose-report', cycle + 1);
    completeNode(store, projectId, runId, 'review-report', cycle + 1);
  }
  const blocked = store.blockRun(runId, {
    reason: 'human-review',
    openIssues,
  });
  const nodeExecutions = Object.fromEntries(nodeOrder.map((nodeId) => [
    nodeId,
    {
      status: blocked.nodes[nodeId].status,
      artifactRefs: structuredClone(blocked.nodes[nodeId].artifactRefs),
    },
  ]));
  ProjectSpace.setCheckpoint(projectId, {
    artifactRunId: runId,
    remediationCycleApplied: 2,
    reportReviewHistory: [1, 2, 3].map((reviewRound) => ({
      reviewRound,
      decision: { cycle: reviewRound - 1 },
    })),
    reportReview: { reviewRound: 3, decision: { cycle: 2 } },
    reportDone: true,
    sim: { futures: [] },
    conclusion: null,
    done: false,
    nodeExecutions,
  });
  return {
    project,
    projectId,
    runId,
    store,
    blocked,
    automaticHistory: structuredClone(blocked.remediationHistory),
  };
}

function reportOnlyDecision(taskVersion = 1, overrides = {}) {
  return {
    taskVersion,
    selectedAction: 'report-only-revision',
    globalComment: 'Apply the bounded report correction.',
    issueDecisions: [{
      issueId: 'valuation-bridge',
      disposition: 'revise',
      comment: 'Preserve the underlying evidence and repair the bridge.',
      targetOwner: null,
      requestedAction: 'Repair the valuation bridge.',
    }],
    downgradeInstruction: null,
    ...overrides,
  };
}

function terminateDecision(taskVersion = 1) {
  return {
    taskVersion,
    selectedAction: 'terminate',
    globalComment: 'The blocking issue cannot be repaired safely.',
    issueDecisions: [{
      issueId: 'valuation-bridge',
      disposition: 'reject',
      comment: 'Stop without publishing.',
      targetOwner: null,
      requestedAction: null,
    }],
    downgradeInstruction: null,
  };
}

function serviceStub() {
  const calls = [];
  return {
    calls,
    resumeReviewed(projectId, input) {
      const result = {
        projectId,
        runId: input.runId,
        status: 'queued',
        reviewed: structuredClone(input),
      };
      calls.push(result);
      return result;
    },
    status(projectId) {
      const run = ProjectSpace.runStore(projectId).list().at(-1);
      return {
        projectId,
        runId: run?.runId || null,
        runStatus: run?.status || null,
      };
    },
  };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('controller materializes one deterministic task and derives an exact report-only preview', () => {
  const fixture = createBlockedProject();
  const service = serviceStub();
  const controller = new RunAnalysisHumanReviewController({
    analysisService: service,
  });

  const opened = controller.open(fixture.projectId);
  assert.equal(opened.status, 'open');
  assert.equal(opened.version, 1);
  assert.equal(opened.runId, fixture.runId);
  assert.equal(opened.remediationCycle, 2);
  assert.deepEqual(opened.allowedActions, [
    'resume-remediation',
    'report-only-revision',
    'downgrade-and-publish',
    'terminate',
  ]);
  assert.equal(opened.reviewArtifactRefs[0].path, 'analysis/reviews/report_quality_r3.json');
  assert.deepEqual(controller.open(fixture.projectId), opened);
  throwsCode(
    () => controller.assertProjectMutationAllowed(fixture.projectId, 'report editing'),
    'HUMAN_REVIEW_MUTATION_BLOCKED',
  );
  const restartedController = new RunAnalysisHumanReviewController({
    analysisService: service,
  });
  assert.deepEqual(
    restartedController.open(fixture.projectId),
    opened,
    'restart reconciliation must recover the same deterministic task identity',
  );
  assert.equal(ProjectSpace.humanReviewStore(fixture.projectId).list().length, 1);

  const preview = controller.preview(opened.taskId, reportOnlyDecision());
  assert.deepEqual(preview.routeNodeIds, ['compose-report', 'review-report']);
  assert.deepEqual(preview.rerunNodeIds, ['compose-report', 'review-report']);
  assert.deepEqual(preview.reopenNodeIds, ['synthesize-conclusion', 'finalize-project']);
  assert.deepEqual(preview.affectedNodeIds, [
    'compose-report',
    'review-report',
    'synthesize-conclusion',
    'finalize-project',
  ]);
  assert.deepEqual(preview.preservedNodeIds, [
    'initialize-checkpoint',
    'plan-research',
    'select-candidates',
    'run-research-rounds',
  ]);

  throwsCode(
    () => controller.preview(opened.taskId, {
      ...reportOnlyDecision(),
      reopenNodeIds: ['finalize-project'],
    }),
    'INVALID_HUMAN_REVIEW_REQUEST',
  );
});

test('safe task projection redacts credential-like issue text', () => {
  const secrets = {
    jsonApiKey: 'json-api-value-123',
    jsonToken: 'json-token-value-456',
    password: 'assignment-password-789',
    secret: 'assignment-secret-012',
    githubToken: `ghp_${'A'.repeat(36)}`,
    awsAccessKey: `AKIA${'B'.repeat(16)}`,
    credentialUri: 'postgresql://reviewer:private-password@db.internal/reviews',
  };
  const fixture = createBlockedProject({
    title: 'Safe projection fixture',
    openIssues: [issue({
      location: `{"apiKey":"${secrets.jsonApiKey}"}`,
      message: `"token" = "${secrets.jsonToken}"`,
      requestedAction: `password=${secrets.password}; secret: '${secrets.secret}'`,
      evidence: [
        `GitHub ${secrets.githubToken}`,
        `AWS ${secrets.awsAccessKey}`,
        `Database ${secrets.credentialUri}`,
      ],
      claim: 'The non-sensitive investment claim remains visible.',
    })],
  });

  const projected = new RunAnalysisHumanReviewController().open(fixture.projectId);
  const serialized = JSON.stringify(projected);

  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(projected.issues[0].location, '{"apiKey":"[redacted]"}');
  assert.equal(projected.issues[0].message, '"token" = "[redacted]"');
  assert.equal(
    projected.issues[0].requestedAction,
    "password=[redacted]; secret: '[redacted]'",
  );
  assert.deepEqual(projected.issues[0].evidence, [
    'GitHub [redacted-key]',
    'AWS [redacted-key]',
    'Database postgresql://[redacted-credentials]@db.internal/reviews',
  ]);
  assert.equal(
    projected.issues[0].claim,
    'The non-sensitive investment claim remains visible.',
  );
  assert.equal(
    projected.requestedActions[0].requestedAction,
    projected.issues[0].requestedAction,
  );
});

test('direct report chat editing requires verified publication before any chat, report, or Agent mutation', async () => {
  const fixture = createBlockedProject({ title: 'Report edit guard fixture' });
  const controller = new RunAnalysisHumanReviewController({
    analysisService: serviceStub(),
  });
  controller.open(fixture.projectId);
  const beforeChat = ProjectSpace.chat(fixture.projectId);
  const beforeReport = ProjectSpace.report(fixture.projectId);

  await assert.rejects(
    chatModify(fixture.projectId, 'Change the rating.'),
    (error) => error?.code === 'REPORT_FEEDBACK_NOT_READY',
  );
  assert.deepEqual(ProjectSpace.chat(fixture.projectId), beforeChat);
  assert.equal(ProjectSpace.report(fixture.projectId), beforeReport);
});

test('controller records v1→v2 once, rejects conflicting double-submit, and resumes v2→v3 at r4', () => {
  const fixture = createBlockedProject({ title: 'Reviewed resume fixture' });
  const service = serviceStub();
  const controller = new RunAnalysisHumanReviewController({
    analysisService: service,
  });
  const opened = controller.open(fixture.projectId);
  const request = reportOnlyDecision(opened.version);

  const decided = controller.decide(opened.taskId, request);
  assert.equal(decided.replayed, false);
  assert.equal(decided.task.status, 'decided');
  assert.equal(decided.task.version, 2);
  assert.equal(decided.task.decision.taskVersion, 1);
  assert.equal(decided.task.decision.reviewer.id, 'local-user');
  assert.deepEqual(decided.preview.rerunNodeIds, ['compose-report', 'review-report']);

  const replay = controller.decide(opened.taskId, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.decision.decisionId, decided.task.decision.decisionId);
  assert.equal(
    ProjectSpace.humanReviewStore(fixture.projectId).list()[0].version,
    2,
    'idempotent decision replay must not create another task revision',
  );
  throwsCode(
    () => controller.decide(opened.taskId, {
      ...request,
      globalComment: 'A conflicting second decision.',
    }),
    'HUMAN_REVIEW_DECISION_CONFLICT',
  );

  const resumed = controller.resume(opened.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.task.status, 'resuming');
  assert.equal(resumed.task.version, 3);
  assert.equal(resumed.task.resume.humanReviewAttempt, 1);
  assert.equal(resumed.task.resume.reviewRound, 4);
  assert.equal(service.calls.length, 1);
  assert.deepEqual(service.calls[0].reviewed, {
    runId: fixture.runId,
    decisionId: decided.task.decision.decisionId,
    humanReviewAttempt: 1,
    reviewRound: 4,
  });

  const run = fixture.store.load(fixture.runId);
  assert.equal(run.status, RUN_STATUSES.RUNNING);
  assert.equal(run.remediationCycle, 2);
  assert.deepEqual(run.remediationHistory, fixture.automaticHistory);
  assert.equal(run.humanReviewAttempt, 1);
  assert.equal(run.humanReviewHistory.length, 1);
  assert.equal(run.humanReviewHistory[0].reviewRound, 4);
  assert.equal(run.nodes['compose-report'].status, NODE_STATES.PENDING);
  assert.equal(run.nodes['review-report'].status, NODE_STATES.PENDING);
  assert.equal(run.nodes['synthesize-conclusion'].status, NODE_STATES.PENDING);
  assert.equal(run.nodes['finalize-project'].status, NODE_STATES.PENDING);
  assert.equal(run.nodes['run-research-rounds'].status, NODE_STATES.SUCCEEDED);

  const checkpoint = ProjectSpace.checkpoint(fixture.projectId);
  assert.equal(checkpoint.remediationCycleApplied, 2);
  assert.equal(checkpoint.humanReviewAttemptApplied, 1);
  assert.equal(checkpoint.activeRemediation.kind, 'human-review');
  assert.equal(checkpoint.activeRemediation.reviewRound, 4);
  assert.equal(checkpoint.activeRemediation.decisionId, decided.task.decision.decisionId);
  assert.deepEqual(checkpoint.reportReviewHistory.map((entry) => entry.reviewRound), [1, 2, 3]);

  const doubleResume = controller.resume(opened.taskId, {
    taskVersion: 2,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(doubleResume.replayed, true);
  assert.equal(fixture.store.load(fixture.runId).humanReviewHistory.length, 1);
  assert.equal(ProjectSpace.humanReviewStore(fixture.projectId).get(opened.taskId).version, 3);
  assert.deepEqual(service.calls[1].reviewed, service.calls[0].reviewed);

  throwsCode(
    () => controller.resume(opened.taskId, {
      taskVersion: 3,
      decisionId: decided.task.decision.decisionId,
    }),
    'HUMAN_REVIEW_TASK_STALE',
  );
  throwsCode(
    () => controller.resume(opened.taskId, {
      taskVersion: 2,
      decisionId: decided.task.decision.decisionId,
      force: true,
    }),
    'INVALID_HUMAN_REVIEW_REQUEST',
  );
});

test('resume-remediation and downgrade actions preserve their exact server-derived identity', () => {
  const dataIssue = issue({
    id: 'data-gap',
    owner: 'data',
    location: 'evidence',
    requestedAction: 'Collect the missing atomic evidence.',
    message: 'A material claim lacks atomic evidence.',
  });
  const dataFixture = createBlockedProject({
    title: 'Data remediation fixture',
    openIssues: [dataIssue],
  });
  const dataService = serviceStub();
  const dataController = new RunAnalysisHumanReviewController({
    analysisService: dataService,
  });
  const dataTask = dataController.open(dataFixture.projectId);
  const dataRequest = {
    taskVersion: dataTask.version,
    selectedAction: 'resume-remediation',
    globalComment: 'Repair only the server-routed evidence subgraph.',
    issueDecisions: [{
      issueId: dataIssue.id,
      disposition: 'revise',
      comment: 'Use the existing evidence collection authority.',
      targetOwner: null,
      requestedAction: dataIssue.requestedAction,
    }],
    downgradeInstruction: null,
  };
  const dataPreview = dataController.preview(dataTask.taskId, dataRequest);
  assert.deepEqual(dataPreview.rerunNodeIds, [
    'run-research-rounds',
    'compose-report',
    'review-report',
  ]);
  assert.deepEqual(dataPreview.reopenNodeIds, [
    'synthesize-conclusion',
    'finalize-project',
  ]);
  const dataDecision = dataController.decide(dataTask.taskId, dataRequest);
  dataController.resume(dataTask.taskId, {
    taskVersion: dataDecision.task.version,
    decisionId: dataDecision.task.decision.decisionId,
  });
  assert.equal(
    dataFixture.store.load(dataFixture.runId).humanReviewHistory[0].selectedAction,
    'resume-remediation',
  );

  const downgradeFixture = createBlockedProject({
    title: 'Downgrade fixture',
  });
  const downgradeService = serviceStub();
  const downgradeController = new RunAnalysisHumanReviewController({
    analysisService: downgradeService,
  });
  const downgradeTask = downgradeController.open(downgradeFixture.projectId);
  const downgradeInstruction = {
    targetRating: 'hold',
    targetConfidence: 0.45,
    rationale: 'The unresolved uncertainty requires a conservative conclusion.',
  };
  const downgradeRequest = {
    ...reportOnlyDecision(downgradeTask.version),
    selectedAction: 'downgrade-and-publish',
    downgradeInstruction,
  };
  const downgradeDecision = downgradeController.decide(
    downgradeTask.taskId,
    downgradeRequest,
  );
  assert.equal(downgradeDecision.preview.publishesDirectly, false);
  assert.equal(downgradeDecision.preview.normalReviewRequired, true);
  downgradeController.resume(downgradeTask.taskId, {
    taskVersion: downgradeDecision.task.version,
    decisionId: downgradeDecision.task.decision.decisionId,
  });
  const downgradeRun = downgradeFixture.store.load(downgradeFixture.runId);
  assert.equal(
    downgradeRun.humanReviewHistory[0].selectedAction,
    'downgrade-and-publish',
  );
  assert.deepEqual(
    downgradeRun.humanReviewHistory[0].downgradeInstruction,
    downgradeInstruction,
  );
  assert.deepEqual(
    ProjectSpace.checkpoint(downgradeFixture.projectId)
      .activeRemediation.downgradeInstruction,
    downgradeInstruction,
  );
});

test('reviewed service execution can re-block at r4 and creates a new versioned task', async () => {
  const fixture = createBlockedProject({ title: 'Reviewed re-block fixture' });
  const controller = new RunAnalysisHumanReviewController();
  const service = new RunAnalysisService({
    humanReviewController: controller,
    reserveRun() {
      throw new Error('reviewed resume must not use generic reservation');
    },
    runner: async () => {
      completeNode(fixture.store, fixture.projectId, fixture.runId, 'compose-report', 4);
      completeNode(fixture.store, fixture.projectId, fixture.runId, 'review-report', 4);
      fixture.store.blockRun(fixture.runId, {
        reason: 'human-review',
        openIssues: [issue()],
      });
    },
    logger: { error() {} },
  });
  controller.bindAnalysisService(service);
  const first = controller.open(fixture.projectId);
  const decided = controller.decide(
    first.taskId,
    reportOnlyDecision(first.version),
  );
  controller.resume(first.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  await eventually(
    () => service.inFlightProjectIds().length === 0,
    'reviewed service run did not settle',
  );

  const second = controller.open(fixture.projectId);
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(second.status, 'open');
  assert.equal(second.reviewBlockCount, 2);
  assert.equal(second.reviewArtifactRefs[0].path, 'analysis/reviews/report_quality_r4.json');
  assert.equal(
    ProjectSpace.humanReviewStore(fixture.projectId).get(first.taskId).status,
    'superseded',
  );
  assert.equal(fixture.store.load(fixture.runId).humanReviewHistory.length, 1);
  assert.equal(fixture.store.load(fixture.runId).reviewBlockCount, 2);
});

test('a succeeded run without a verified published package cannot resolve or unlock review', () => {
  const fixture = createBlockedProject({ title: 'Unverified reviewed success fixture' });
  const service = serviceStub();
  const controller = new RunAnalysisHumanReviewController({
    analysisService: service,
  });
  const opened = controller.open(fixture.projectId);
  const decided = controller.decide(
    opened.taskId,
    reportOnlyDecision(opened.version),
  );
  controller.resume(opened.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  for (const nodeId of [
    'compose-report',
    'review-report',
    'synthesize-conclusion',
    'finalize-project',
  ]) {
    completeNode(fixture.store, fixture.projectId, fixture.runId, nodeId, 4);
  }
  fixture.store.completeRun(fixture.runId);

  const stillOpen = controller.open(fixture.projectId);
  assert.equal(stillOpen.status, 'resuming');
  assert.equal(stillOpen.outcome, null);
  throwsCode(
    () => controller.assertProjectMutationAllowed(fixture.projectId, 'report editing'),
    'HUMAN_REVIEW_MUTATION_BLOCKED',
  );
});

test('terminate records the accepted decision, cancels blocked nodes, and never publishes a report', () => {
  const fixture = createBlockedProject({ title: 'Termination fixture' });
  const service = serviceStub();
  const controller = new RunAnalysisHumanReviewController({
    analysisService: service,
  });
  const beforeMeta = ProjectSpace.meta(fixture.projectId);
  const beforeReport = ProjectSpace.report(fixture.projectId);
  const opened = controller.open(fixture.projectId);
  const decided = controller.decide(opened.taskId, terminateDecision(opened.version));
  assert.equal(decided.task.status, 'decided');
  assert.deepEqual(decided.preview.rerunNodeIds, []);
  assert.deepEqual(decided.preview.reopenNodeIds, []);

  const terminated = controller.resume(opened.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(terminated.replayed, false);
  assert.equal(terminated.task.status, 'terminated');
  assert.equal(terminated.task.version, 3);
  assert.equal(service.calls.length, 0);

  const run = fixture.store.load(fixture.runId);
  assert.equal(run.status, RUN_STATUSES.CANCELLED);
  assert.equal(run.stopReason, 'human-review-terminated');
  assert.equal(run.nodes['synthesize-conclusion'].status, NODE_STATES.CANCELLED);
  assert.equal(run.nodes['finalize-project'].status, NODE_STATES.CANCELLED);
  assert.equal(run.nodes['compose-report'].status, NODE_STATES.SUCCEEDED);
  assert.equal(run.nodes['review-report'].status, NODE_STATES.SUCCEEDED);
  assert.equal(run.humanReviewHistory.length, 1);
  assert.equal(run.humanReviewHistory[0].kind, 'terminate');

  const afterMeta = ProjectSpace.meta(fixture.projectId);
  assert.equal(afterMeta.status, 'cancelled');
  assert.equal(afterMeta.latestReport, beforeMeta.latestReport);
  assert.equal(afterMeta.reportGeneratedAt, beforeMeta.reportGeneratedAt);
  assert.equal(ProjectSpace.report(fixture.projectId), beforeReport);
  assert.equal(ProjectSpace.humanReviewStore(fixture.projectId).open(), null);
  assert.equal(
    controller.assertProjectMutationAllowed(fixture.projectId, 'report editing'),
    true,
  );

  const replay = controller.resume(opened.taskId, {
    taskVersion: 2,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(replay.replayed, true);
  assert.equal(fixture.store.load(fixture.runId).humanReviewHistory.length, 1);
  throwsCode(
    () => controller.resume(opened.taskId, {
      taskVersion: 1,
      decisionId: decided.task.decision.decisionId,
    }),
    'HUMAN_REVIEW_TASK_STALE',
  );
});
