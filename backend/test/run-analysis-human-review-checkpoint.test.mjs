import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';

function reviewIssue(id = 'valuation-bridge') {
  return {
    schemaVersion: 'review-issue.v1',
    id,
    owner: 'report',
    severity: 'critical',
    location: 'valuation',
    evidence: [],
    requestedAction: 'Repair the valuation bridge.',
    message: 'The valuation bridge is incomplete.',
    sourceReviewer: 'logic',
    blocking: true,
  };
}

test('human review checkpoint keeps automatic cycles and gives r4+ work a decision-bound identity', async (t) => {
  const dataDir = fs.mkdtempSync(`${os.tmpdir()}/finagent-review-checkpoint-`);
  const originalDataDir = process.env.FIN_DATA_DIR;
  process.env.FIN_DATA_DIR = dataDir;
  t.after(() => {
    if (originalDataDir === undefined) delete process.env.FIN_DATA_DIR;
    else process.env.FIN_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const {
    canonicalSha256,
    createArtifactRef,
  } = await import('../src/core/contracts/ArtifactRef.js');
  const {
    applyHumanReviewEntryToCheckpoint,
    remediationIdentityForNode,
  } = await import('../src/workflows/run-analysis/human-review/checkpoint.js');
  const {
    reconcileCheckpointRemediation,
  } = await import('../src/workflows/run-analysis/policies/remediation.js');
  const {
    workflowNodeInputDigest,
  } = await import('../src/workflows/run-analysis/policies/runPolicy.js');
  const {
    assertWorkflowNodeCompletion,
  } = await import('../src/workflows/run-analysis/completion/workflowCompletion.js');
  const {
    RUN_ANALYSIS_WORKFLOW_SPEC,
    RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  } = await import('../src/workflows/run-analysis/workflowSpec.js');
  const {
    runWithWorkflowNodeContext,
  } = await import('../src/core/workflow/WorkflowRunContext.js');
  const {
    agentExecutionRuntime,
  } = await import('../src/agents/AgentExecutionRuntime.js');
  const {
    composeReport,
  } = await import('../src/workflows/run-analysis/handlers/composeReport.js');
  const {
    reviewReport,
  } = await import('../src/workflows/run-analysis/handlers/reviewReport.js');
  const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');

  const at = '2026-07-23T00:00:00.000Z';
  const decisionRef = createArtifactRef({
    artifactId: 'proj_review:human-review/decision.json',
    version: 1,
    path: 'human-review/decision.json',
    contentDigest: canonicalSha256({ decision: 1 }),
    schemaVersion: 'human-review-decision.v1',
    producer: 'human-review-controller',
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ task: 1 }),
    createdAt: at,
    asOf: at,
  });
  const entry = {
    kind: 'resume',
    fingerprint: canonicalSha256({ transition: 1 }),
    taskId: `hrt_${'1'.repeat(64)}`,
    taskVersion: 2,
    decisionId: `hrd_${'2'.repeat(64)}`,
    decisionRef,
    decisionDigest: decisionRef.contentDigest,
    humanReviewAttempt: 1,
    reviewRound: 4,
    selectedAction: 'downgrade-and-publish',
    downgradeInstruction: {
      targetRating: 'hold',
      targetConfidence: 0.45,
      rationale: 'The evidence supports a more conservative conclusion.',
    },
    owners: ['report'],
    rerunNodeIds: ['compose-report', 'review-report'],
    reopenNodeIds: ['synthesize-conclusion', 'finalize-project'],
    openIssues: [reviewIssue()],
    priorNodes: {
      'compose-report': { artifactRefs: [] },
      'review-report': { artifactRefs: [] },
    },
    automaticRemediationCycle: 2,
    blockedStateDigest: canonicalSha256({ blocked: 1 }),
    resumedAt: '2026-07-23T00:01:00.000Z',
  };
  const reportReviewHistory = [0, 1, 2].map((cycle) => ({
    reviewRound: cycle + 1,
    decision: { cycle },
  }));
  const checkpoint = {
    remediationCycleApplied: 2,
    reportReviewHistory: structuredClone(reportReviewHistory),
    reportReview: { decision: { cycle: 2 } },
    reportDone: true,
    sim: { futures: [] },
    conclusion: { rating: 'buy' },
    done: true,
    nodeExecutions: Object.fromEntries(RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => [
      node.id,
      { status: 'succeeded', artifactRefs: [] },
    ])),
  };

  applyHumanReviewEntryToCheckpoint(checkpoint, entry);
  assert.equal(checkpoint.remediationCycleApplied, 2);
  assert.deepEqual(checkpoint.reportReviewHistory, reportReviewHistory);
  assert.equal(checkpoint.humanReviewAttemptApplied, 1);
  assert.equal(checkpoint.humanReviewHistory.length, 1);
  assert.equal(checkpoint.activeRemediation.kind, 'human-review');
  assert.equal(checkpoint.activeRemediation.cycle, 2);
  assert.equal(checkpoint.activeRemediation.reviewRound, 4);
  assert.equal(checkpoint.activeRemediation.selectedAction, 'downgrade-and-publish');
  assert.deepEqual(checkpoint.activeRemediation.downgradeInstruction, entry.downgradeInstruction);
  assert.deepEqual(checkpoint.activeRemediation.nodeIds, [
    'compose-report',
    'review-report',
    'synthesize-conclusion',
    'finalize-project',
  ]);
  assert.ok(checkpoint.nodeExecutions['plan-research']);
  for (const nodeId of checkpoint.activeRemediation.nodeIds) {
    assert.equal(checkpoint.nodeExecutions[nodeId], undefined);
  }
  assert.equal(checkpoint.reportDone, false);
  assert.equal(checkpoint.reportReview, null);
  assert.equal(checkpoint.conclusion, null);
  assert.equal(checkpoint.done, false);
  assert.equal(checkpoint.sim.futures.length, 0);

  const composeIdentity = remediationIdentityForNode(checkpoint, 'compose-report');
  assert.equal(composeIdentity.humanReviewAttempt, 1);
  assert.equal(composeIdentity.reviewRound, 4);
  assert.equal(composeIdentity.decisionId, entry.decisionId);
  assert.equal(composeIdentity.selectedAction, 'downgrade-and-publish');
  assert.deepEqual(composeIdentity.downgradeInstruction, entry.downgradeInstruction);
  assert.equal(remediationIdentityForNode(checkpoint, 'plan-research'), null);

  applyHumanReviewEntryToCheckpoint(checkpoint, entry);
  assert.equal(checkpoint.humanReviewHistory.length, 1, 'same durable entry replays idempotently');
  assert.throws(
    () => applyHumanReviewEntryToCheckpoint(structuredClone(checkpoint), {
      ...entry,
      fingerprint: canonicalSha256({ transition: 'changed' }),
    }),
    (error) => error?.code === 'HUMAN_REVIEW_CHECKPOINT_CONFLICT',
  );

  const fresh = {
    remediationCycleApplied: 0,
    reportReviewHistory: structuredClone(reportReviewHistory),
    nodeExecutions: {},
  };
  reconcileCheckpointRemediation(fresh, {
    remediationHistory: [
      {
        cycle: 1,
        owners: ['report'],
        nodeIds: ['compose-report', 'review-report'],
        openIssues: [reviewIssue('automatic-1')],
        priorNodes: {},
        invalidatedAt: at,
      },
      {
        cycle: 2,
        owners: ['report'],
        nodeIds: ['compose-report', 'review-report'],
        openIssues: [reviewIssue('automatic-2')],
        priorNodes: {},
        invalidatedAt: at,
      },
    ],
    humanReviewHistory: [entry],
  });
  assert.equal(fresh.remediationCycleApplied, 2);
  assert.equal(fresh.activeRemediation.kind, 'human-review');
  assert.equal(fresh.activeRemediation.reviewRound, 4);

  const node = RUN_ANALYSIS_WORKFLOW_SPEC.nodes.find((candidate) => candidate.id === 'compose-report');
  const run = {
    runId: 'artifact-run-proj_review-1',
    inputDigest: canonicalSha256({ run: 1 }),
  };
  const digestA = workflowNodeInputDigest({
    context: { cp: checkpoint },
    node,
    dependencyArtifactRefs: [],
    run,
  });
  const changedCheckpoint = structuredClone(checkpoint);
  changedCheckpoint.activeRemediation.decisionId = `hrd_${'3'.repeat(64)}`;
  changedCheckpoint.activeRemediation.selectedAction = 'report-only-revision';
  changedCheckpoint.activeRemediation.downgradeInstruction = null;
  const digestB = workflowNodeInputDigest({
    context: { cp: changedCheckpoint },
    node,
    dependencyArtifactRefs: [],
    run,
  });
  assert.notEqual(digestA, digestB, 'node identity binds decision, action, and instruction');

  const project = ProjectFS.create({
    title: 'Human review artifact identity',
    theme: 'Human review artifact identity',
    rationale: 'Verify r4 artifact commits.',
    tickers: ['TEST'],
  });
  t.after(() => ProjectFS.delete(project.id));
  for (const reviewer of ['evidence', 'requirements', 'logic']) {
    ProjectFS.setAnalysisFile(project.id, `reviews/${reviewer}_r4.json`, { reviewer });
  }
  ProjectFS.setAnalysisFile(project.id, 'reviews/report_quality_r4.json', { passed: true });
  const reviewNode = RUN_ANALYSIS_WORKFLOW_SPEC.nodes
    .find((candidate) => candidate.id === 'review-report');
  const originalCommit = ProjectFS.commitArtifactFiles;
  const captured = [];
  ProjectFS.commitArtifactFiles = (_projectId, items) => {
    captured.push(structuredClone(items));
    return [];
  };
  t.after(() => {
    ProjectFS.commitArtifactFiles = originalCommit;
  });
  const artifactCheckpoint = {
    artifactRunId: run.runId,
    artifactAsOf: at,
    activeRemediation: structuredClone(checkpoint.activeRemediation),
    nodeExecutions: {},
  };
  assertWorkflowNodeCompletion({
    node: reviewNode,
    context: {
      id: project.id,
      cp: artifactCheckpoint,
      saveCp() {},
    },
    result: { reviewRound: 4 },
  });
  const humanCommits = captured.at(-1);
  assert.ok(humanCommits.some((item) => item.path === 'analysis/reviews/report_quality_r4.json'));
  assert.ok(humanCommits.every((item) => (
    /:human-review:1:[a-f0-9]{64}$/u.test(item.metadata.idempotencyKey)
  )));
  const firstArtifactInputDigest = humanCommits[0].metadata.inputDigest;

  artifactCheckpoint.activeRemediation = structuredClone(changedCheckpoint.activeRemediation);
  assertWorkflowNodeCompletion({
    node: reviewNode,
    context: {
      id: project.id,
      cp: artifactCheckpoint,
      saveCp() {},
    },
    result: { reviewRound: 4 },
  });
  assert.notEqual(captured.at(-1)[0].metadata.inputDigest, firstArtifactInputDigest);
  assert.notEqual(
    captured.at(-1)[0].metadata.idempotencyKey,
    humanCommits[0].metadata.idempotencyKey,
  );

  const agentRequests = [];
  const agentBackend = {
    async run(request) {
      agentRequests.push(request);
      return {
        status: 'succeeded',
        stopReason: 'final',
        valid: true,
        live: false,
        text: '# Revised report\n\nConservative evidence-based conclusion.',
        metrics: { toolCalls: 0 },
      };
    },
    async cancel() {
      return false;
    },
  };
  const workflowContext = {
    workflow: {
      id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
      hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    },
    run: {
      runId: run.runId,
      projectId: project.id,
      scope: { kind: 'project', id: project.id },
      workspaceMode: 'project',
      asOf: at,
    },
    node: {
      nodeId: 'compose-report',
      attempt: 1,
    },
    inputs: {
      artifactRefs: [],
      priorReviewIssues: structuredClone(entry.openIssues),
      workspaceSnapshotId: `${project.id}:human-review`,
    },
    services: {
      agentRuntime: agentExecutionRuntime,
      agentBackend,
    },
    signal: null,
  };
  const composeContext = (activeRemediation) => ({
    id: project.id,
    meta: { reportLanguage: 'en' },
    theme: 'Human review identity',
    brief: '<research_brief>Reassess the valuation.</research_brief>',
    cp: {
      ...artifactCheckpoint,
      activeRemediation,
      rounds: [],
    },
    cfg: { depth: {} },
    saveCp() {},
    tstep: (_key, fn) => fn(),
    industry: {},
    companies: [],
    briefs: { fundamentals: '' },
  });
  await runWithWorkflowNodeContext(workflowContext, () => composeReport(
    composeContext(structuredClone(checkpoint.activeRemediation)),
    { id: 'compose-report' },
    { shouldRun: true },
  ));
  assert.equal(agentRequests[0].input.files.some((file) => file.includes('reflection_r')), false);
  for (const field of ['cruxes', 'futures', 'reflections']) assert.equal(Object.hasOwn(agentRequests[0].input, field), false, `${field} is not an active v2 report input`);
  await runWithWorkflowNodeContext(workflowContext, () => composeReport(
    composeContext(structuredClone(changedCheckpoint.activeRemediation)),
    { id: 'compose-report' },
    { shouldRun: true },
  ));
  assert.equal(agentRequests.length, 2);
  assert.match(agentRequests[0].input.brief, /downgrade-and-publish/u);
  assert.match(agentRequests[0].input.brief, /canonical-review-required/u);
  assert.match(agentRequests[0].input.brief, /more conservative conclusion/u);
  assert.notEqual(
    agentRequests[0].idempotencyKey,
    agentRequests[1].idempotencyKey,
    'Agent identity binds the reviewed decision/action/instruction',
  );

  const reviewerRequests = [];
  const reviewerBackend = {
    async run(request) {
      reviewerRequests.push(request);
      const reviewerType = request.agentContractId === 'requirement-reviewer'
        ? 'requirements'
        : request.agentContractId.replace('-reviewer', '');
      return {
        status: 'succeeded',
        stopReason: 'final',
        valid: true,
        live: false,
        errors: [],
        metrics: { turns: 1, toolCalls: 0 },
        output: {
          schemaVersion: '1.0.0',
          asOf: at,
          producer: request.agentContractId,
          contractVersion: '1.0.0',
          inputDigest: request.input.inputDigest,
          createdAt: at,
          evidenceRefs: [],
          score: 0.9,
          issues: [],
          verdict: 'pass',
          reviewerType,
        },
      };
    },
    async cancel() {
      return false;
    },
  };
  const reviewWorkflowContext = {
    ...workflowContext,
    node: {
      nodeId: 'review-report',
      attempt: 1,
    },
    services: {
      agentRuntime: agentExecutionRuntime,
      agentBackend: reviewerBackend,
    },
  };
  const reviewCheckpoint = {
    artifactAsOf: at,
    activeRemediation: structuredClone(checkpoint.activeRemediation),
    rounds: [],
    reportReview: null,
    reportReviewHistory: structuredClone(reportReviewHistory),
  };
  await runWithWorkflowNodeContext(reviewWorkflowContext, () => reviewReport({
    id: project.id,
    meta: {
      title: 'Human review identity',
      theme: 'Human review identity',
      rationale: 'Reassess the valuation.',
      tickers: ['TEST'],
    },
    theme: 'Human review identity',
    brief: '<research_brief>Reassess the valuation.</research_brief>',
    cp: reviewCheckpoint,
    last: { coverage: null, contradictions: [] },
    tickers: ['TEST'],
    deepTickers: ['TEST'],
    companies: [],
    saveCp() {},
    tstep: (_key, fn) => fn(),
  }, { id: 'review-report' }, { shouldRun: true }));
  assert.equal(reviewCheckpoint.reportReview.reviewRound, 4);
  assert.equal(reviewCheckpoint.reportReview.reviewIdentity.kind, 'human-review');
  assert.equal(reviewCheckpoint.reportReview.decision.cycle, 2);
  assert.equal(reviewCheckpoint.reportReview.decision.reviewIdentity.reviewRound, 4);
  assert.deepEqual(
    reviewCheckpoint.reportReviewHistory.map((item) => item.reviewRound),
    [1, 2, 3, 4],
  );
  for (const relPath of [
    'analysis/reviews/evidence_r4.json',
    'analysis/reviews/requirements_r4.json',
    'analysis/reviews/logic_r4.json',
    'analysis/reviews/report_quality_r4.json',
  ]) assert.ok(ProjectFS.fileContent(project.id, relPath), relPath);
  assert.equal(reviewerRequests.length, 3);
  assert.ok(reviewerRequests.every((request) => (
    request.input.reviewIdentity.reviewRound === 4
    && request.input.humanReviewDecision.selectedAction === 'downgrade-and-publish'
    && request.input.humanReviewDecision.downgradeInstruction.targetRating === 'hold'
  )));
});
