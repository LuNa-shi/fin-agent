import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS,
  RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST,
  RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION,
  normalizeHumanReviewDecisionRequest,
} from '../src/workflows/run-analysis/human-review/policy.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../src/workflows/run-analysis/workflowSpec.js';

function issue(id, owner = 'report') {
  return {
    schemaVersion: 'review-issue.v1',
    id,
    owner,
    severity: 'critical',
    location: 'valuation',
    evidence: [],
    requestedAction: `Repair ${id}.`,
    message: `${id} is incomplete.`,
    sourceReviewer: 'logic',
    blocking: true,
  };
}

function task(issues = [issue('report-gap')]) {
  return {
    taskId: `hrt_${'1'.repeat(64)}`,
    version: 1,
    workflow: {
      id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
      hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    },
    policy: {
      version: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION,
      digest: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST,
      waiveAndPublishEnabled: false,
    },
    allowedActions: [...RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS],
    issues,
  };
}

function decisionFor(issues, overrides = {}) {
  return {
    taskVersion: 1,
    selectedAction: 'resume-remediation',
    globalComment: '',
    issueDecisions: issues.map((entry) => ({
      issueId: entry.id,
      disposition: 'revise',
      comment: '',
      targetOwner: null,
      requestedAction: entry.requestedAction,
    })),
    downgradeInstruction: null,
    ...overrides,
  };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('Human Review policy rejects unknown and caller-owned authority fields', () => {
  const issues = [issue('report-gap')];
  const input = decisionFor(issues);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      rerunNodeIds: ['finalize-project'],
    }),
    'INVALID_HUMAN_REVIEW_REQUEST',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      issueDecisions: [{
        ...input.issueDecisions[0],
        reviewerId: 'admin',
      }],
    }),
    'INVALID_HUMAN_REVIEW_REQUEST',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      taskVersion: 2,
    }),
    'HUMAN_REVIEW_TASK_STALE',
  );
});

test('Human Review policy disables publication waivers at both action and issue levels', () => {
  const issues = [issue('report-gap')];
  const input = decisionFor(issues);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      selectedAction: 'waive-and-publish',
    }),
    'HUMAN_REVIEW_ACTION_DISABLED',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      issueDecisions: [{
        issueId: 'report-gap',
        disposition: 'waive',
        comment: 'Ignore this.',
        targetOwner: null,
        requestedAction: null,
      }],
    }),
    'HUMAN_REVIEW_WAIVER_DISABLED',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...input,
      issueDecisions: [{
        issueId: 'report-gap',
        disposition: 'reject',
        comment: '',
        targetOwner: null,
        requestedAction: null,
      }],
    }),
    'HUMAN_REVIEW_POLICY_DENIED',
  );
});

test('Human Review policy requires explicit safe reassignment for system issues', () => {
  const issues = [issue('system-gap', 'system')];
  const base = decisionFor(issues);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), base),
    'HUMAN_REVIEW_OWNER_NOT_ROUTABLE',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...base,
      issueDecisions: [{
        issueId: 'system-gap',
        disposition: 'reassign',
        comment: '',
        targetOwner: 'report',
        requestedAction: 'Repair the report.',
      }],
    }),
    'HUMAN_REVIEW_POLICY_DENIED',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...base,
      issueDecisions: [{
        issueId: 'system-gap',
        disposition: 'reassign',
        comment: 'Assign to an unknown owner.',
        targetOwner: 'operator',
        requestedAction: 'Repair the report.',
      }],
    }),
    'HUMAN_REVIEW_OWNER_NOT_ROUTABLE',
  );

  const reassigned = normalizeHumanReviewDecisionRequest(task(issues), {
    ...base,
    issueDecisions: [{
      issueId: 'system-gap',
      disposition: 'reassign',
      comment: 'The report owner can make the bounded correction.',
      targetOwner: 'report',
      requestedAction: 'Repair the report.',
    }],
  });
  assert.deepEqual(reassigned.owners, ['report']);
  assert.deepEqual(reassigned.routeNodeIds, ['compose-report', 'review-report']);
  assert.equal(reassigned.routeIssues[0].owner, 'report');

  const terminated = normalizeHumanReviewDecisionRequest(task(issues), {
    ...base,
    selectedAction: 'terminate',
    issueDecisions: [{
      issueId: 'system-gap',
      disposition: 'reject',
      comment: 'The finding cannot be repaired safely.',
      targetOwner: null,
      requestedAction: null,
    }],
  });
  assert.deepEqual(terminated.owners, []);
  assert.deepEqual(terminated.routeNodeIds, []);
});

test('Human Review action matrix derives routes only from normalized issue ownership', () => {
  const issues = [
    issue('data-gap', 'data'),
    issue('company-gap', 'company'),
  ];
  const base = decisionFor(issues);
  const remediation = normalizeHumanReviewDecisionRequest(task(issues), base);
  assert.deepEqual(remediation.owners, ['data', 'company']);
  assert.deepEqual(remediation.routeNodeIds, [
    'run-research-rounds',
    'compose-report',
    'review-report',
    'synthesize-conclusion',
    'finalize-project',
  ]);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(issues), {
      ...base,
      selectedAction: 'report-only-revision',
    }),
    'HUMAN_REVIEW_POLICY_DENIED',
  );

  const reportIssues = [issue('report-gap')];
  const reportOnly = normalizeHumanReviewDecisionRequest(
    task(reportIssues),
    decisionFor(reportIssues, { selectedAction: 'report-only-revision' }),
  );
  assert.deepEqual(reportOnly.owners, ['report']);
  assert.deepEqual(reportOnly.routeNodeIds, ['compose-report', 'review-report']);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest(task(reportIssues), decisionFor(reportIssues, {
      selectedAction: 'downgrade-and-publish',
    })),
    'INVALID_HUMAN_REVIEW_REQUEST',
  );
  const downgraded = normalizeHumanReviewDecisionRequest(
    task(reportIssues),
    decisionFor(reportIssues, {
      selectedAction: 'downgrade-and-publish',
      downgradeInstruction: {
        targetRating: 'hold',
        targetConfidence: 0.45,
        rationale: 'The remaining uncertainty requires a conservative conclusion.',
      },
    }),
  );
  assert.equal(downgraded.downgradeInstruction.targetRating, 'hold');
  assert.deepEqual(downgraded.routeNodeIds, ['compose-report', 'review-report']);
});

test('Human Review policy fails closed on stale Workflow, policy, and action authority', () => {
  const issues = [issue('report-gap')];
  const input = decisionFor(issues);
  const current = task(issues);

  throwsCode(
    () => normalizeHumanReviewDecisionRequest({
      ...current,
      workflow: { ...current.workflow, hash: `sha256:${'0'.repeat(64)}` },
    }, input),
    'HUMAN_REVIEW_WORKFLOW_STALE',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest({
      ...current,
      policy: { ...current.policy, digest: `sha256:${'0'.repeat(64)}` },
    }, input),
    'HUMAN_REVIEW_POLICY_STALE',
  );
  throwsCode(
    () => normalizeHumanReviewDecisionRequest({
      ...current,
      allowedActions: ['resume-remediation', 'terminate'],
    }, input),
    'HUMAN_REVIEW_POLICY_STALE',
  );
});

test('Human Review input rejects credential-like material before audit persistence', () => {
  const issues = [issue('report-gap')];
  const base = decisionFor(issues);

  for (const patch of [
    { globalComment: 'authorization: Bearer private-value' },
    {
      issueDecisions: [{
        ...base.issueDecisions[0],
        comment: '"api_key": "private-value"',
      }],
    },
    {
      selectedAction: 'downgrade-and-publish',
      downgradeInstruction: {
        targetRating: 'hold',
        targetConfidence: 0.4,
        rationale: 'Use ghp_abcdefghijklmnopqrstuvwxyz123456 as evidence.',
      },
    },
  ]) {
    throwsCode(
      () => normalizeHumanReviewDecisionRequest(task(issues), {
        ...base,
        ...patch,
      }),
      'SENSITIVE_HUMAN_REVIEW_INPUT',
    );
  }
});
