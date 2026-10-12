import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateDeterministicReportQuality,
  runDeterministicReportGates,
} from '../src/workflows/run-analysis/reviewers/deterministicGates.js';
import { adjudicateReviews, normalizeReviewIssue } from '../src/workflows/run-analysis/reviewers/adjudicator.js';
import { runReviewerGroup } from '../src/workflows/run-analysis/reviewers/reviewerGroup.js';

const base = {
  schemaVersion: '1.0.0', asOf: '2026-07-14T00:00:00.000Z', contractVersion: '1.0.0', inputDigest: 'sha256:draft',
  createdAt: '2026-07-14T00:00:01.000Z', evidenceRefs: ['evidence://filing'], score: 0.9, issues: [], verdict: 'pass',
};
const producerFor = (reviewerType) => reviewerType === 'requirements' ? 'requirement-reviewer' : `${reviewerType}-reviewer`;
const review = (reviewerType, overrides = {}) => ({ ...base, producer: producerFor(reviewerType), reviewerType, ...overrides });
const reviewerResult = (reviewerType, outputOverrides = {}, resultOverrides = {}) => ({
  contractId: producerFor(reviewerType),
  expectedReviewerType: reviewerType,
  status: 'succeeded',
  output: review(reviewerType, outputOverrides),
  artifacts: [],
  evidenceRefs: [],
  openQuestions: [],
  dataRequests: [],
  metrics: { turns: 1, toolCalls: 0 },
  stopReason: 'final',
  traceRef: `trace:${reviewerType}`,
  valid: true,
  errors: [],
  budgetExhausted: false,
  ...resultOverrides,
});
const passingReviewerResults = () => [
  reviewerResult('evidence'),
  reviewerResult('requirements'),
  reviewerResult('logic'),
];
const issue = (overrides = {}) => ({
  id: 'issue-1', severity: 'critical', owner: 'report', message: 'Material contradiction', location: 'Valuation',
  claim: 'Margins expand', evidenceRefs: ['evidence://filing'], remediation: 'Reconcile the margin assumptions.', ...overrides,
});
const validDraft = `# Investment Thesis

[src: filing]

## Industry Analysis

Evidence [src: industry]

## Company Analysis

Evidence [src: filing]

## Valuation

Evidence [src: model]

## Risks

Evidence [src: filing]
`;

test('deterministic report gates return structured issues without mutating the draft', () => {
  const draft = '# Investment Thesis\n\nNo citations.';
  const before = draft;
  const issues = runDeterministicReportGates({ draftReport: draft });
  assert.equal(draft, before);
  assert.ok(issues.length >= 2);
  assert.ok(issues.every((item) => item.id && item.owner === 'report' && item.remediation));
  assert.ok(issues.some((item) => /section/i.test(item.message)));
  assert.ok(issues.some((item) => /citation/i.test(item.message)));
  assert.deepEqual(runDeterministicReportGates({ draftReport: validDraft }), []);
});

test('deterministic report gates accept the required Chinese section aliases', () => {
  const chinese = `# 报告\n\n## 投资逻辑\nA [src: filing]\n\n## 行业分析\nB\n\n## 公司分析\nC\n\n## 估值\nD\n\n## 风险\nE`;
  assert.deepEqual(runDeterministicReportGates({ draftReport: chinese }), []);
});

test('deterministic report gates accept numbered and descriptive production headings', () => {
  const numbered = `# Alphabet AI Monetization\n\n## 1. Investment thesis\nA [src: filing]\n\n## 2. Industry analysis centered on key drivers\nB\n\n## 4. Company analysis — Alphabet / GOOGL\nC\n\n## 5. Valuation-implied-expectation matrix\nD\n\n### Risks and invalidation\nE`;
  const quality = evaluateDeterministicReportQuality({ draftReport: numbered });
  assert.equal(quality.requiredSectionPassRate, 1);
  assert.equal(quality.citationMarkerCount, 1);
  assert.deepEqual(quality.requiredSections.map((section) => section.matchedHeading), [
    '1. Investment thesis',
    '2. Industry analysis centered on key drivers',
    '4. Company analysis — Alphabet / GOOGL',
    '5. Valuation-implied-expectation matrix',
    'Risks and invalidation',
  ]);
  assert.deepEqual(runDeterministicReportGates({ draftReport: numbered }), []);
});

test('adjudicator publishes only when all reviewer dimensions and hard gates converge', () => {
  const decision = adjudicateReviews({
    reviews: [review('evidence'), review('requirements'), review('logic')], deterministicIssues: [], cycle: 0,
    asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(decision.converged, true);
  assert.equal(decision.route, 'publish');
  assert.deepEqual(decision.remediation, []);
  assert.deepEqual(decision.openIssues, []);
});

test('critical issues produce owner-routed remediation and never rewrite the draft', () => {
  const draft = { markdown: validDraft };
  const before = structuredClone(draft);
  const decision = adjudicateReviews({
    reviews: [review('evidence'), review('requirements'), review('logic', { issues: [issue()], verdict: 'remediate' })],
    deterministicIssues: [], cycle: 1, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.deepEqual(draft, before);
  assert.equal(decision.converged, false);
  assert.equal(decision.route, 'report');
  assert.equal(decision.remediation.length, 1);
  assert.deepEqual(decision.openIssues[0], {
    schemaVersion: 'review-issue.v1',
    id: 'issue-1',
    owner: 'report',
    severity: 'critical',
    location: 'Valuation',
    evidence: ['evidence://filing'],
    requestedAction: 'Reconcile the margin assumptions.',
    message: 'Material contradiction',
    sourceReviewer: 'logic',
    blocking: true,
    claim: 'Margins expand',
  });
  assert.deepEqual(decision.remediation[0], {
    issueId: 'issue-1', owner: 'report', action: 'Reconcile the margin assumptions.', requiresNewData: false,
  });
});

test('adjudicator normalizes malformed issues and requires pass even for warning-only observations', () => {
  assert.deepEqual(normalizeReviewIssue({ message: 'Malformed' }, { sourceReviewer: 'logic', index: 2 }), {
    schemaVersion: 'review-issue.v1',
    id: normalizeReviewIssue({ message: 'Malformed' }, { sourceReviewer: 'logic', index: 2 }).id,
    owner: 'system',
    severity: 'critical',
    location: 'unspecified',
    evidence: [],
    requestedAction: 'Resolve the blocking issue: Malformed',
    message: 'Malformed',
    sourceReviewer: 'logic',
    blocking: true,
  });
  const warning = issue({ id: 'warning-1', severity: 'warning' });
  const decision = adjudicateReviews({
    reviews: [review('evidence'), review('requirements'), review('logic', { issues: [warning], verdict: 'remediate' })],
    deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(decision.converged, false);
  assert.equal(decision.route, 'report');
  assert.deepEqual(decision.openIssues.map((item) => item.id), ['warning-1']);
  assert.equal(decision.openIssues[0].severity, 'warning');
  assert.equal(decision.openIssues[0].blocking, true);
});

test('warning-only remediate verdicts preserve concrete mixed-owner issues for selective routing', () => {
  const decision = adjudicateReviews({
    reviews: [
      review('evidence', {
        verdict: 'remediate',
        issues: [
          issue({ id: 'data-warning', severity: 'warning', owner: 'data', remediation: 'Collect the missing filing.' }),
          issue({ id: 'report-warning', severity: 'warning', owner: 'report', remediation: 'Replace the artifact-only citation.' }),
        ],
      }),
      review('requirements'),
      review('logic'),
    ],
    deterministicIssues: [],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  });

  assert.equal(decision.converged, false);
  assert.equal(decision.route, 'data');
  assert.deepEqual(decision.openIssues.map((item) => item.id), ['data-warning', 'report-warning']);
  assert.deepEqual(decision.openIssues.map((item) => item.owner), ['data', 'report']);
  assert.ok(decision.openIssues.every((item) => item.blocking === true && item.severity === 'warning'));
  assert.deepEqual(decision.remediation.map((item) => item.owner), ['data', 'report']);
});

test('remediate verdicts keep info findings non-blocking while warning and critical findings route by owner', () => {
  const decision = adjudicateReviews({
    reviews: [
      review('evidence', {
        verdict: 'remediate',
        issues: [
          issue({ id: 'system-info', severity: 'info', owner: 'system' }),
          issue({ id: 'data-warning', severity: 'warning', owner: 'data' }),
          issue({ id: 'report-critical', severity: 'critical', owner: 'report' }),
        ],
      }),
      review('requirements'),
      review('logic'),
    ],
    deterministicIssues: [],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  });

  assert.equal(decision.route, 'report');
  assert.deepEqual(decision.openIssues.map((item) => item.id), ['report-critical', 'data-warning']);
  assert.deepEqual(decision.remediation.map((item) => item.owner), ['report', 'data']);
  assert.equal(decision.openIssues.some((item) => item.id === 'system-info'), false);
});

test('system warning and critical findings remain eligible for forced human review', () => {
  for (const severity of ['warning', 'critical']) {
    const decision = adjudicateReviews({
      reviews: [
        review('evidence', {
          verdict: 'remediate',
          issues: [issue({ id: `system-${severity}`, severity, owner: 'system' })],
        }),
        review('requirements'),
        review('logic'),
      ],
      deterministicIssues: [],
      cycle: 0,
      asOf: base.asOf,
      inputDigest: base.inputDigest,
    });
    assert.equal(decision.route, 'human-review', severity);
    assert.deepEqual(decision.openIssues.map((item) => item.id), [`system-${severity}`], severity);
  }
});

test('a duplicate non-critical system warning does not pre-empt an owner-routed deterministic remediation', () => {
  const decision = adjudicateReviews({
    reviews: [
      review('evidence'),
      review('requirements', {
        verdict: 'remediate',
        issues: [issue({
          id: 'quality-audit-system-warning',
          severity: 'warning',
          owner: 'system',
          message: 'The deterministic report quality audit did not pass.',
          remediation: 'Resolve the report traceability gaps.',
        })],
      }),
      review('logic'),
    ],
    deterministicIssues: [issue({
      id: 'gate-material-claim-traceability',
      severity: 'critical',
      owner: 'report',
      message: 'Material claim traceability is below the required value.',
      remediation: 'Attach an atomic marker or an explicit estimate/open-issue marker.',
    })],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  });

  assert.equal(decision.route, 'report');
  assert.deepEqual(decision.openIssues.map((item) => item.id), [
    'gate-material-claim-traceability',
    'quality-audit-system-warning',
  ]);
  assert.deepEqual(decision.remediation.map((item) => item.issueId), ['gate-material-claim-traceability']);
});

test('cycle two exhaustion and system issues route to human review with open issues', () => {
  const critical = review('logic', { issues: [issue()], verdict: 'remediate' });
  const exhausted = adjudicateReviews({ reviews: [review('evidence'), review('requirements'), critical], deterministicIssues: [], cycle: 2, asOf: base.asOf, inputDigest: base.inputDigest });
  assert.equal(exhausted.route, 'human-review');
  assert.equal(exhausted.openIssues.length, 1);

  const system = adjudicateReviews({
    reviews: [review('evidence'), review('requirements'), review('logic', { issues: [issue({ owner: 'system' })], verdict: 'human-review' })],
    deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(system.route, 'human-review');
});

test('human-review with only owner-routable warnings enters remediation before escalation', () => {
  const decision = adjudicateReviews({
    reviews: [
      review('evidence', {
        verdict: 'human-review',
        issues: [
          issue({ id: 'data-warning', severity: 'warning', owner: 'data' }),
          issue({ id: 'report-info', severity: 'info', owner: 'report' }),
          issue({ id: 'system-info', severity: 'info', owner: 'system' }),
        ],
      }),
      review('requirements'),
      review('logic'),
    ],
    deterministicIssues: [],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  });

  assert.equal(decision.route, 'data');
  assert.equal(decision.converged, false);
  assert.deepEqual(decision.openIssues.map((item) => item.id), ['data-warning']);
  assert.deepEqual(decision.remediation.map((item) => item.issueId), ['data-warning']);
});

test('human-review with a routable warning and a duplicate system warning enters remediation', () => {
  const decision = adjudicateReviews({
    reviews: [
      review('evidence', {
        verdict: 'human-review',
        issues: [
          issue({ id: 'report-warning', severity: 'warning', owner: 'report' }),
          issue({ id: 'system-warning', severity: 'warning', owner: 'system' }),
        ],
      }),
      review('requirements'),
      review('logic'),
    ],
    deterministicIssues: [],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  });

  assert.equal(decision.route, 'report');
  assert.deepEqual(decision.openIssues.map((item) => item.id), ['system-warning', 'report-warning']);
  assert.deepEqual(decision.remediation.map((item) => item.issueId), ['report-warning']);
});

test('human-review with a critical or system warning still escalates immediately', () => {
  for (const reviewIssue of [
    issue({ id: 'report-critical', severity: 'critical', owner: 'report' }),
    issue({ id: 'system-warning', severity: 'warning', owner: 'system' }),
  ]) {
    const decision = adjudicateReviews({
      reviews: [
        review('evidence', { verdict: 'human-review', issues: [reviewIssue] }),
        review('requirements'),
        review('logic'),
      ],
      deterministicIssues: [],
      cycle: 0,
      asOf: base.asOf,
      inputDigest: base.inputDigest,
    });
    assert.equal(decision.route, 'human-review');
    assert.ok(decision.openIssues.some((item) => item.id === 'evidence-review-human-review'));
  }
});

test('Reviewer Group executes three read-only dimensions concurrently and returns adjudication', async () => {
  let active = 0;
  let maxActive = 0;
  const seenDrafts = [];
  const seenContractIds = [];
  const seenOptions = [];
  const runReviewer = async (contractId, input, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seenDrafts.push(input.draftReport);
    seenContractIds.push(contractId);
    seenOptions.push(options);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return {
      ...reviewerResult(input.reviewerType),
      trace: { toolCalls: [{ args: { private: true } }] },
      events: [{ payload: { providerRaw: true } }],
      rawProviderPayload: { private: true },
    };
  };
  const result = await runReviewerGroup({
    draftReport: validDraft, researchBrief: { question: 'Is the thesis supported?' }, evidenceBundle: {}, cycle: 0,
    asOf: base.asOf, inputDigest: base.inputDigest,
  }, { runReviewer });
  assert.equal(maxActive, 3);
  assert.equal(result.reviews.length, 3);
  assert.equal(result.reviewerResults.length, 3);
  assert.ok(result.reviewerResults.every((item) => item.status === 'succeeded' && item.stopReason === 'final'));
  assert.ok(result.reviewerResults.every((item) => !('trace' in item) && !('events' in item) && !('rawProviderPayload' in item)));
  assert.deepEqual(seenContractIds, ['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer']);
  assert.ok(seenDrafts.every((draft) => draft === validDraft));
  assert.ok(seenOptions.every((options) => options.throwOnFailure === false));
  for (const options of seenOptions) {
    for (const field of [
      'projectId',
      'workflowId',
      'nodeId',
      'runId',
      'asOf',
      'inputArtifactRefs',
      'priorReviewIssues',
      'idempotencyKey',
    ]) {
      assert.equal(Object.hasOwn(options, field), false, field);
    }
  }
  assert.equal(result.decision.route, 'publish');
  assert.deepEqual(result.deterministicIssues, []);
});

test('Reviewer Group routes explicit Industry/Company assumption conflicts to company remediation', async () => {
  const runReviewer = async (_contractId, input) => reviewerResult(input.reviewerType);
  const result = await runReviewerGroup({
    draftReport: validDraft,
    researchBrief: { question: 'Is the thesis supported?' },
    evidenceBundle: {},
    companies: [{
      ticker: 'NVDA',
      assumptionConflicts: [{
        id: 'NVDA-margin-conflict',
        message: 'Industry supply normalization conflicts with persistent scarcity pricing.',
        evidenceRefs: ['evidence://industry'],
        severity: 'critical',
      }],
    }],
    cycle: 0,
    asOf: base.asOf,
    inputDigest: base.inputDigest,
  }, { runReviewer });
  assert.equal(result.decision.route, 'company');
  assert.equal(result.decision.openIssues.length, 1);
  assert.deepEqual(result.decision.openIssues[0], {
    schemaVersion: 'review-issue.v1',
    id: 'NVDA-margin-conflict',
    owner: 'company',
    severity: 'critical',
    location: 'analysis/company.json:NVDA',
    evidence: ['evidence://industry'],
    requestedAction: 'Resolve the Industry/Company assumption conflict for NVDA and update DriverBridge evidence.',
    message: 'Industry supply normalization conflicts with persistent scarcity pricing.',
    sourceReviewer: 'deterministic-gate',
    blocking: true,
  });
});

test('publish gate accepts output-valid reviewer runs while Workflow-owned artifacts are still pending', () => {
  const reviews = passingReviewerResults();
  reviews[0] = reviewerResult('evidence', {}, {
    status: 'partial',
    valid: false,
    errors: ['required artifact is absent: analysis/reviews/evidence_rN.json'],
  });
  const decision = adjudicateReviews({
    reviews, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(decision.route, 'publish');
  assert.equal(decision.converged, true);
});

test('publish gate rejects incomplete, budget-stopped, schema-invalid, and failed live reviewer runs', () => {
  const cases = [
    ['deadline', { status: 'partial', stopReason: 'deadline', valid: true }],
    ['tool budget', { status: 'partial', stopReason: 'tool-budget', valid: true, budgetExhausted: true }],
    ['schema invalid', { status: 'partial', stopReason: 'schema-invalid', valid: false, errors: ['$.score must be <= 1'] }],
    ['live failure', { status: 'failed', stopReason: 'error', live: true, valid: false, errors: ['provider failed'] }],
  ];
  for (const [label, overrides] of cases) {
    const reviews = passingReviewerResults();
    reviews[0] = reviewerResult('evidence', {}, overrides);
    const decision = adjudicateReviews({
      reviews, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
    });
    assert.equal(decision.route, 'human-review', label);
    assert.equal(decision.converged, false, label);
    assert.ok(decision.openIssues.some((item) => item.id === 'invalid-evidence-review' && item.owner === 'system'), label);
  }
});

test('publish gate rejects missing, duplicate, unknown, and malformed reviewer identities', () => {
  const malformed = reviewerResult('evidence', { producer: 'logic-reviewer' });
  const cases = [
    ['missing', passingReviewerResults().slice(0, 2), 'missing-logic-review'],
    ['duplicate', [...passingReviewerResults(), reviewerResult('logic')], 'duplicate-logic-review'],
    ['unknown', [...passingReviewerResults(), review('evidence', { reviewerType: 'style', producer: 'style-reviewer' })], 'unknown-reviewer-4'],
    ['malformed', [malformed, reviewerResult('requirements'), reviewerResult('logic')], 'invalid-evidence-review'],
  ];
  for (const [label, reviews, issueId] of cases) {
    const decision = adjudicateReviews({
      reviews, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
    });
    assert.equal(decision.route, 'human-review', label);
    assert.ok(decision.openIssues.some((item) => item.id === issueId && item.owner === 'system'), label);
  }
});

test('publish gate rejects schema-invalid output and routes explicit non-pass verdicts', () => {
  const schemaInvalid = passingReviewerResults();
  schemaInvalid[0] = reviewerResult('evidence', { score: 2 });
  const invalidDecision = adjudicateReviews({
    reviews: schemaInvalid, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(invalidDecision.route, 'human-review');
  assert.ok(invalidDecision.openIssues.some((item) => item.id === 'invalid-evidence-review'));

  const remediation = passingReviewerResults();
  remediation[2] = reviewerResult('logic', {
    verdict: 'remediate',
    issues: [issue({ severity: 'warning', owner: 'company' })],
  });
  const remediationDecision = adjudicateReviews({
    reviews: remediation, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(remediationDecision.route, 'company');
  assert.deepEqual(remediationDecision.openIssues.map((item) => item.id), ['issue-1']);

  const human = passingReviewerResults();
  human[1] = reviewerResult('requirements', { verdict: 'human-review', issues: [issue({ owner: 'report' })] });
  const humanDecision = adjudicateReviews({
    reviews: human, deterministicIssues: [], cycle: 0, asOf: base.asOf, inputDigest: base.inputDigest,
  });
  assert.equal(humanDecision.route, 'human-review');
  assert.ok(humanDecision.openIssues.some((item) => item.id === 'requirements-review-human-review'));
});
