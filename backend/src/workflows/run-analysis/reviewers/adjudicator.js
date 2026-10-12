// Deterministic workflow routing over read-only reviewer outputs.
import { createHash } from 'node:crypto';

import { canonicalAgentStopReason, PARTIAL_AGENT_STOP_REASONS } from '../../../core/agent-backend/agentOutcome.js';
import { getAgentSchema } from '../../../core/validation/agentSchemaRegistry.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { REVIEWER_TYPES, reviewerContractId } from './reviewerContracts.js';

const SEVERITY = { critical: 3, warning: 2, info: 1 };
const OWNER = { system: 0, data: 1, industry: 2, company: 3, report: 4 };
const VALID_SEVERITIES = new Set(Object.keys(SEVERITY));
const VALID_OWNERS = new Set(Object.keys(OWNER));
const REVIEW_RESULT_SCHEMA = getAgentSchema('reviewResult.v1');
const REQUIRED_ARTIFACT_ERROR = /^required artifact is absent:/u;

const unique = (values) => [...new Set(values.filter(Boolean))];

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function issueId(issue, sourceReviewer, index) {
  if (typeof issue?.id === 'string' && issue.id.trim()) return issue.id.trim();
  const digest = createHash('sha256').update(JSON.stringify({
    sourceReviewer,
    index,
    owner: issue?.owner,
    severity: issue?.severity,
    message: issue?.message,
    remediation: issue?.remediation,
  })).digest('hex').slice(0, 12);
  return `review-issue-${digest}`;
}

export function normalizeReviewIssue(issue, { sourceReviewer = 'deterministic', index = 0 } = {}) {
  const value = issue && typeof issue === 'object' && !Array.isArray(issue) ? issue : {};
  const severity = VALID_SEVERITIES.has(value.severity) ? value.severity : 'critical';
  const owner = VALID_OWNERS.has(value.owner) ? value.owner : 'system';
  const message = text(value.message, 'Reviewer returned an invalid or incomplete issue.');
  const evidence = unique([
    ...(Array.isArray(value.evidence) ? value.evidence : []),
    ...(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : []),
  ].map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean));
  const normalized = {
    schemaVersion: 'review-issue.v1',
    id: issueId(value, sourceReviewer, index),
    owner,
    severity,
    location: text(value.location, 'unspecified'),
    evidence,
    requestedAction: text(value.requestedAction || value.remediation, `Resolve the blocking issue: ${message}`),
    message,
    sourceReviewer,
    blocking: value.blocking === true || severity === 'critical',
  };
  if (typeof value.claim === 'string' && value.claim.trim()) normalized.claim = value.claim.trim();
  return Object.freeze(normalized);
}

function missingReviewerIssue(reviewerType) {
  return {
    id: `missing-${reviewerType}-review`, severity: 'critical', owner: 'system',
    message: `${reviewerType} reviewer did not return a result.`, evidenceRefs: [],
    remediation: `Restore the ${reviewerType} reviewer before publication.`,
  };
}

function systemIssue(id, message, remediation) {
  return {
    id,
    severity: 'critical',
    owner: 'system',
    message,
    evidenceRefs: [],
    remediation,
  };
}

function reviewEntry(value) {
  const wrapped = !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.prototype.hasOwnProperty.call(value, 'expectedReviewerType')
      || (Object.prototype.hasOwnProperty.call(value, 'status') && Object.prototype.hasOwnProperty.call(value, 'output')));
  if (!wrapped) {
    return {
      expectedReviewerType: value?.reviewerType,
      contractId: value?.reviewerType && REVIEWER_TYPES.includes(value.reviewerType)
        ? reviewerContractId(value.reviewerType)
        : null,
      output: value,
      runResult: null,
    };
  }
  return {
    expectedReviewerType: value.expectedReviewerType || value.output?.reviewerType,
    contractId: value.contractId || (value.expectedReviewerType && REVIEWER_TYPES.includes(value.expectedReviewerType)
      ? reviewerContractId(value.expectedReviewerType)
      : null),
    output: value.output,
    runResult: value,
  };
}

function deferredArtifactOnly(runResult) {
  const errors = Array.isArray(runResult?.errors) ? runResult.errors : [];
  return errors.length > 0 && errors.every((error) => REQUIRED_ARTIFACT_ERROR.test(String(error || '')));
}

function runtimeUsabilityErrors(runResult) {
  if (!runResult) return [];
  const errors = [];
  const stopReason = canonicalAgentStopReason(runResult.stopReason, { budgetExhausted: runResult.budgetExhausted === true });
  const artifactPending = deferredArtifactOnly(runResult);
  if (!['succeeded', 'partial', 'failed'].includes(runResult.status)) {
    errors.push('AgentRunResult.status is missing or invalid');
  } else if (runResult.status === 'failed') {
    errors.push(runResult.live === true ? 'live reviewer run failed' : 'reviewer run failed');
  }
  if (!Object.prototype.hasOwnProperty.call(runResult, 'stopReason') || !runResult.stopReason) {
    errors.push('AgentRunResult.stopReason is missing');
  } else if (runResult.budgetExhausted === true || stopReason.endsWith('budget')) {
    errors.push(`reviewer exhausted its runtime budget (${stopReason})`);
  } else if (PARTIAL_AGENT_STOP_REASONS.has(stopReason)) {
    errors.push(`reviewer stopped before a complete result (${stopReason})`);
  } else if (stopReason !== 'final') {
    errors.push(`reviewer returned an unsupported stop reason (${stopReason})`);
  }
  if (runResult.valid === false && !artifactPending) {
    errors.push('reviewer output failed runtime validation');
  }
  if (runResult.status === 'partial' && !(stopReason === 'final' && artifactPending)) {
    errors.push('reviewer returned a partial AgentRunResult');
  }
  if (runResult.error) errors.push('reviewer returned an execution error');
  return unique(errors);
}

function outputUsabilityErrors(output, { reviewerType, declaredContractId, inputDigest }) {
  if (!REVIEW_RESULT_SCHEMA) return ['reviewResult.v1 schema is unavailable'];
  const errors = validateJsonSchema(output, REVIEW_RESULT_SCHEMA);
  const contractId = reviewerContractId(reviewerType);
  if (declaredContractId && declaredContractId !== contractId) {
    errors.push(`review result contractId must be ${contractId}`);
  }
  if (output?.reviewerType !== reviewerType) {
    errors.push(`reviewerType must be ${reviewerType}`);
  }
  if (output?.producer !== contractId) {
    errors.push(`producer must be ${contractId}`);
  }
  if (inputDigest !== 'unknown' && output?.inputDigest !== inputDigest) {
    errors.push('inputDigest does not match the reviewed report package');
  }
  return unique(errors);
}

function humanReviewCanRemediate(normalizedReviewIssues) {
  const actionableWarnings = normalizedReviewIssues.filter((issue) => (
    issue.severity === 'warning' && issue.owner !== 'system'
  ));
  const immediateEscalation = normalizedReviewIssues.some((issue) => issue.severity === 'critical');
  return actionableWarnings.length > 0 && !immediateEscalation;
}

function nonPassIssue(review, reviewerType, normalizedReviewIssues) {
  if (review.verdict === 'pass') return null;
  if (review.verdict === 'human-review' && !humanReviewCanRemediate(normalizedReviewIssues)) {
    return systemIssue(
      `${reviewerType}-review-human-review`,
      `${reviewerType} reviewer explicitly requires human review.`,
      `Resolve the ${reviewerType} review outside automatic publication.`,
    );
  }
  if (normalizedReviewIssues.length > 0) return null;
  return systemIssue(
    `${reviewerType}-review-non-pass-without-issues`,
    `${reviewerType} reviewer returned verdict=${review.verdict} without an actionable issue.`,
    `Rerun the ${reviewerType} reviewer and require concrete owner-routed remediation findings.`,
  );
}

function blockingIssuesForVerdict(review, normalizedReviewIssues) {
  const ownerRouted = review.verdict === 'remediate'
    || (review.verdict === 'human-review' && humanReviewCanRemediate(normalizedReviewIssues));
  if (!ownerRouted) return normalizedReviewIssues;
  return normalizedReviewIssues.map((issue) => (
    issue.severity === 'info' || issue.blocking
      ? issue
      : Object.freeze({ ...issue, blocking: true })
  ));
}

function normalizedIssues(reviews, deterministicIssues, inputDigest) {
  const entries = (reviews || []).map(reviewEntry);
  const byType = new Map(REVIEWER_TYPES.map((reviewerType) => [reviewerType, []]));
  const issues = (deterministicIssues || []).map((issue, index) => (
    normalizeReviewIssue(issue, { sourceReviewer: 'deterministic-gate', index })
  ));
  const usableReviews = [];

  for (const [index, entry] of entries.entries()) {
    if (!REVIEWER_TYPES.includes(entry.expectedReviewerType)) {
      issues.push(normalizeReviewIssue(systemIssue(
        `unknown-reviewer-${index + 1}`,
        `Reviewer Group returned an unknown reviewer identity: ${entry.expectedReviewerType || 'missing'}.`,
        'Restore the canonical Evidence / Requirements / Logic reviewer set before publication.',
      ), { sourceReviewer: 'reviewer-group', index }));
      continue;
    }
    byType.get(entry.expectedReviewerType).push(entry);
  }

  for (const reviewerType of REVIEWER_TYPES) {
    const candidates = byType.get(reviewerType);
    if (candidates.length === 0) {
      issues.push(normalizeReviewIssue(missingReviewerIssue(reviewerType), { sourceReviewer: reviewerType, index: 0 }));
      continue;
    }
    if (candidates.length !== 1) {
      issues.push(normalizeReviewIssue(systemIssue(
        `duplicate-${reviewerType}-review`,
        `${reviewerType} reviewer returned ${candidates.length} results; exactly one is required.`,
        `Discard duplicate ${reviewerType} results and rerun the canonical reviewer once.`,
      ), { sourceReviewer: 'reviewer-group', index: 0 }));
      continue;
    }

    const entry = candidates[0];
    const outputErrors = outputUsabilityErrors(entry.output, {
      reviewerType,
      declaredContractId: entry.contractId,
      inputDigest,
    });
    const runtimeErrors = runtimeUsabilityErrors(entry.runResult);
    if (outputErrors.length || runtimeErrors.length) {
      const detail = [...outputErrors, ...runtimeErrors].slice(0, 6).join('; ');
      issues.push(normalizeReviewIssue(systemIssue(
        `invalid-${reviewerType}-review`,
        `${reviewerType} reviewer result is not safe to publish: ${detail}.`,
        `Rerun the canonical ${reviewerType} reviewer to a complete schema-valid result.`,
      ), { sourceReviewer: reviewerType, index: 0 }));
      continue;
    }

    usableReviews.push(entry.output);
    const normalizedReviewIssues = (entry.output.issues || []).map((issue, index) => (
      normalizeReviewIssue(issue, { sourceReviewer: reviewerType, index })
    ));
    const reviewIssues = blockingIssuesForVerdict(entry.output, normalizedReviewIssues);
    issues.push(...reviewIssues);
    const synthetic = nonPassIssue(entry.output, reviewerType, reviewIssues);
    if (synthetic) issues.push(normalizeReviewIssue(synthetic, { sourceReviewer: reviewerType, index: reviewIssues.length }));
  }

  return { issues: issues.sort((a, b) => {
    const severity = (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0);
    return severity || (OWNER[a.owner] ?? 99) - (OWNER[b.owner] ?? 99) || String(a.id).localeCompare(String(b.id));
  }), usableReviews };
}

export function adjudicateReviews({
  reviews = [], deterministicIssues = [], cycle = 0, asOf = new Date().toISOString(), inputDigest = 'unknown', createdAt = asOf,
} = {}) {
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > 2) throw new RangeError('review cycle must be an integer from 0 to 2');
  const normalized = normalizedIssues(reviews, deterministicIssues, inputDigest);
  const { issues, usableReviews } = normalized;
  const openIssues = issues.filter((item) => item.blocking);
  const routableIssues = openIssues.filter((item) => item.owner !== 'system');
  const forcedHuman = openIssues.some((item) => item.owner === 'system' && item.severity === 'critical')
    || (openIssues.length > 0 && routableIssues.length === 0)
    || (cycle >= 2 && openIssues.length > 0);
  const converged = openIssues.length === 0 && !forcedHuman;
  const route = converged ? 'publish' : (forcedHuman ? 'human-review' : routableIssues[0].owner);
  const remediation = converged || forcedHuman ? [] : routableIssues.map((item) => ({
    issueId: item.id,
    owner: item.owner,
    action: item.requestedAction,
    requiresNewData: item.owner === 'data',
  }));
  const evidenceRefs = unique([
    ...usableReviews.flatMap((review) => review?.evidenceRefs || []),
    ...openIssues.flatMap((item) => item.evidence || []),
  ]);

  return {
    schemaVersion: '1.0.0',
    asOf,
    producer: 'review-adjudicator',
    contractVersion: '1.0.0',
    inputDigest,
    createdAt,
    evidenceRefs,
    converged,
    cycle,
    route,
    remediation,
    openIssues,
  };
}
