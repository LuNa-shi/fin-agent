import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import {
  createW8DeterministicBackend,
  readW8AgentAudit,
  readW8DeterministicCallAudit,
  summarizeW8DeterministicCallAudit,
  W8_DETERMINISTIC_AUDIT_FILE,
} from '../scripts/support/w8DeterministicBackend.mjs';

const asOf = '2026-07-23T00:00:00.000Z';
const rawFixturePayload = 'raw-fixture-payload-sk-secret';

const ProjectSpace = {
  fileContent(_projectId, relativePath) {
    if (relativePath !== 'data/citation_ledger.json') return null;
    return JSON.stringify({
      evidenceItems: [{
        evidenceId: 'evidence-w8-material-1',
        statement: 'Revenue growth and cash flow remain the material evidence boundary.',
      }],
    });
  },
};

function requestFor(agentContractId, {
  reviewIdentity = { kind: 'automatic', cycle: 0, reviewRound: 1 },
} = {}) {
  const reviewer = agentContractId.endsWith('-reviewer');
  const input = reviewer ? {
    asOf,
    inputDigest: canonicalSha256({
      report: 'w8',
      reviewIdentity,
    }),
    researchBrief: { title: 'W8 deterministic fixture' },
    evidenceBundle: {},
    draftReport: '# W8 fixture report',
    priorReviewIssues: [],
    cycle: reviewIdentity.kind === 'automatic' ? reviewIdentity.cycle : 2,
    reviewIdentity,
    sensitiveFixtureValue: rawFixturePayload,
  } : {
    language: 'English',
    brief: 'W8 deterministic fixture',
    theme: 'W8',
    files: [],
    preview: rawFixturePayload,
  };
  return {
    runId: `run-w8-${agentContractId}`,
    workflowId: 'run-analysis.v1',
    nodeId: reviewer ? 'review-report' : 'compose-report',
    projectId: 'project-w8',
    agentContractId,
    contractVersion: '1.0.0',
    asOf,
    input,
    inputArtifactRefs: [],
    priorReviewIssues: [],
    workspaceSnapshotId: 'project-w8:snapshot',
    idempotencyKey: `w8:${agentContractId}:${canonicalSha256(reviewIdentity)}`,
  };
}

test('W8 deterministic backend scripts report/reviewer modes and persists only safe audit fields', async (t) => {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-w8-backend-'));
  t.after(() => fs.rmSync(controlDir, { recursive: true, force: true }));

  const success = createW8DeterministicBackend({
    ProjectSpace,
    mode: 'success',
    controlDir,
    phase: 'success',
  });
  const successReview = await success.run(requestFor('logic-reviewer'));
  assert.equal(successReview.live, false);
  assert.equal(successReview.output.verdict, 'pass');
  assert.deepEqual(successReview.output.issues, []);

  const report = await success.run(requestFor('report-composer'));
  assert.equal(report.live, false);
  assert.match(report.text, /\[src: evidence-w8-material-1\]/u);
  assert.deepEqual(report.evidenceRefs, ['evidence-w8-material-1']);

  const blocked = createW8DeterministicBackend({
    ProjectSpace,
    mode: 'review-block',
    controlDir,
    phase: 'review-block',
  });
  const blockedReview = await blocked.run(requestFor('logic-reviewer'));
  assert.equal(blockedReview.output.verdict, 'remediate');
  assert.deepEqual(
    blockedReview.output.issues.map((issue) => issue.id),
    ['w8-report-blocking'],
  );

  const resolving = createW8DeterministicBackend({
    ProjectSpace,
    mode: 'review-resolve',
    controlDir,
    phase: 'review-resolve',
  });
  const automaticReview = await resolving.run(requestFor('logic-reviewer'));
  assert.equal(automaticReview.output.verdict, 'remediate');
  const humanReview = await resolving.run(requestFor('logic-reviewer', {
    reviewIdentity: {
      kind: 'human-review',
      decisionId: `hrd_${'1'.repeat(64)}`,
      reviewRound: 4,
      humanReviewAttempt: 1,
    },
  }));
  assert.equal(humanReview.output.verdict, 'pass');

  const audit = readW8DeterministicCallAudit({ controlDir });
  assert.equal(audit.length, 5);
  assert.deepEqual(readW8AgentAudit(controlDir), audit);
  assert.ok(audit.every((record) => record.live === false));
  const summary = summarizeW8DeterministicCallAudit({ controlDir });
  assert.equal(summary.callCount, 5);
  assert.equal(summary.liveCallCount, 0);
  assert.deepEqual(summary.statuses, { succeeded: 5 });

  const auditText = fs.readFileSync(
    path.join(controlDir, W8_DETERMINISTIC_AUDIT_FILE),
    'utf8',
  );
  assert.equal(auditText.includes(rawFixturePayload), false);
  assert.doesNotMatch(
    auditText,
    /(?:prompt|provider|model|credential|authorization|endpoint)/iu,
  );
});

test('W8 crash marker pauses exactly the first report-composer call', async (t) => {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-w8-crash-'));
  const crashMarkerFile = path.join(controlDir, 'report-composer.paused.json');
  let beforeCrashCalls = 0;
  t.after(() => fs.rmSync(controlDir, { recursive: true, force: true }));

  const crashing = createW8DeterministicBackend({
    ProjectSpace,
    mode: 'success',
    controlDir,
    phase: 'crash',
    crashMarkerFile,
    crashAgentId: 'report-composer',
    beforeCrash(identity) {
      beforeCrashCalls += 1;
      assert.equal(identity.agentId, 'report-composer');
    },
  });
  void crashing.run(requestFor('report-composer'));
  assert.equal(beforeCrashCalls, 1);
  assert.equal(fs.existsSync(crashMarkerFile), true);
  assert.equal(readW8DeterministicCallAudit({ controlDir }).length, 1);
  assert.equal(readW8DeterministicCallAudit({ controlDir })[0].status, 'paused');

  const resumed = createW8DeterministicBackend({
    ProjectSpace,
    mode: 'success',
    controlDir,
    phase: 'resume',
    crashMarkerFile,
  });
  const result = await resumed.run(requestFor('report-composer'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.live, false);
  assert.deepEqual(
    readW8DeterministicCallAudit({ controlDir }).map((record) => record.status),
    ['paused', 'succeeded'],
  );
});
