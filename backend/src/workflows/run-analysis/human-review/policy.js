import {
  HUMAN_REVIEW_ACTIONS,
  HUMAN_REVIEW_DISPOSITIONS,
} from '../../../core/contracts/HumanReview.js';
import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  topologicalNodeOrder,
  workflowSpecHash,
} from '../workflowSpec.js';

export const RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION = 'run-analysis-human-review.v1';
export const RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS = Object.freeze([
  'resume-remediation',
  'report-only-revision',
  'downgrade-and-publish',
  'terminate',
]);
export const RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST = canonicalSha256({
  version: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION,
  allowedActions: RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS,
  dispositions: HUMAN_REVIEW_DISPOSITIONS,
  routableOwners: ['data', 'industry', 'company', 'report'],
  waiveDispositionEnabled: false,
  waiveAndPublishEnabled: false,
  criticalSystemMustReassignOrTerminate: true,
});

const INPUT_FIELDS = new Set([
  'taskVersion',
  'selectedAction',
  'globalComment',
  'issueDecisions',
  'downgradeInstruction',
]);
const ISSUE_FIELDS = new Set([
  'issueId',
  'disposition',
  'comment',
  'targetOwner',
  'requestedAction',
]);
const DOWNGRADE_FIELDS = new Set([
  'targetRating',
  'targetConfidence',
  'rationale',
]);
const DISPOSITION_SET = new Set(HUMAN_REVIEW_DISPOSITIONS);
const ACTION_SET = new Set(HUMAN_REVIEW_ACTIONS);
const ALLOWED_ACTION_SET = new Set(RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS);
const ROUTABLE_OWNER_SET = new Set(['data', 'industry', 'company', 'report']);
const SENSITIVE_INPUT = /(?:\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@|["']?(?:api[-_]?key|authorization|cookie|password|secret|session|token)["']?\s*[:=]\s*["']?[^\s"',;}]+)/iu;

export class HumanReviewPolicyError extends Error {
  constructor(message, code = 'HUMAN_REVIEW_POLICY_DENIED', statusCode = 400) {
    super(message);
    this.name = 'HumanReviewPolicyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, code = 'HUMAN_REVIEW_POLICY_DENIED', statusCode = 400) {
  throw new HumanReviewPolicyError(message, code, statusCode);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`, 'INVALID_HUMAN_REVIEW_REQUEST');
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) {
    fail(`${label} contains forbidden fields: ${unknown.join(', ')}`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
}

function text(value, label, {
  nullable = false,
  allowEmpty = false,
  maxLength = 4_000,
} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    fail(`${label} must be a string${nullable ? ' or null' : ''}`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  if (!allowEmpty && !value.trim()) fail(`${label} must be non-empty`, 'INVALID_HUMAN_REVIEW_REQUEST');
  if (value.length > maxLength || value.includes('\0')) {
    fail(`${label} is invalid or too long`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  if (SENSITIVE_INPUT.test(value)) {
    fail(`${label} contains credential-like material`, 'SENSITIVE_HUMAN_REVIEW_INPUT', 400);
  }
  return value;
}

function assertCurrentTaskAuthority(task, spec) {
  const expectedWorkflow = {
    id: spec.id,
    version: spec.version,
    hash: workflowSpecHash(spec),
  };
  if (
    task.workflow?.id !== expectedWorkflow.id
    || task.workflow?.version !== expectedWorkflow.version
    || task.workflow?.hash !== expectedWorkflow.hash
  ) {
    fail('Human Review task Workflow authority is stale', 'HUMAN_REVIEW_WORKFLOW_STALE', 409);
  }
  if (
    task.policy?.version !== RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION
    || task.policy?.digest !== RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST
    || task.policy?.waiveAndPublishEnabled !== false
    || canonicalSha256(task.allowedActions) !== canonicalSha256(
      RUN_ANALYSIS_HUMAN_REVIEW_ALLOWED_ACTIONS,
    )
  ) {
    fail('Human Review task policy authority is stale', 'HUMAN_REVIEW_POLICY_STALE', 409);
  }
}

function normalizeDowngrade(value, action) {
  if (action !== 'downgrade-and-publish') {
    if (value !== null && value !== undefined) {
      fail('downgradeInstruction is only allowed for downgrade-and-publish', 'INVALID_HUMAN_REVIEW_REQUEST');
    }
    return null;
  }
  exactFields(value, DOWNGRADE_FIELDS, 'downgradeInstruction');
  const targetRating = text(value.targetRating, 'downgradeInstruction.targetRating', { maxLength: 64 });
  const targetConfidence = value.targetConfidence ?? null;
  if (
    targetConfidence !== null
    && (
      typeof targetConfidence !== 'number'
      || !Number.isFinite(targetConfidence)
      || targetConfidence < 0
      || targetConfidence > 1
    )
  ) fail('downgradeInstruction.targetConfidence must be null or a number from 0 to 1', 'INVALID_HUMAN_REVIEW_REQUEST');
  return {
    targetRating,
    targetConfidence,
    rationale: text(value.rationale, 'downgradeInstruction.rationale'),
  };
}

function routeForOwners(owners, spec) {
  const routes = new Map((spec.remediationRoutes || []).map((route) => [route.owner, route]));
  const selected = new Set();
  for (const owner of owners) {
    const route = routes.get(owner);
    if (!route || route.terminal) fail(`owner is not routable: ${owner}`, 'HUMAN_REVIEW_OWNER_NOT_ROUTABLE', 403);
    for (const nodeId of route.nodeIds || []) selected.add(nodeId);
  }
  return topologicalNodeOrder(spec).filter((nodeId) => selected.has(nodeId));
}

export function normalizeHumanReviewDecisionRequest(task, input, {
  spec = RUN_ANALYSIS_WORKFLOW_SPEC,
} = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('HumanReviewTask is required');
  assertCurrentTaskAuthority(task, spec);
  exactFields(input, INPUT_FIELDS, 'Human Review decision');
  if (!Number.isInteger(input.taskVersion) || input.taskVersion < 1) {
    fail('taskVersion must be a positive integer', 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  if (input.taskVersion !== task.version) {
    fail('Human Review task version is stale', 'HUMAN_REVIEW_TASK_STALE', 409);
  }
  const selectedAction = input.selectedAction;
  if (!ACTION_SET.has(selectedAction)) {
    fail(`unsupported Human Review action: ${selectedAction}`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  if (!ALLOWED_ACTION_SET.has(selectedAction)) {
    fail(`Human Review action is disabled: ${selectedAction}`, 'HUMAN_REVIEW_ACTION_DISABLED', 403);
  }
  const globalComment = text(input.globalComment ?? '', 'globalComment', {
    allowEmpty: true,
    maxLength: 8_000,
  });
  if (!Array.isArray(input.issueDecisions) || input.issueDecisions.length !== task.issues.length) {
    fail('issueDecisions must contain exactly one decision for every task issue', 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  const byIssueId = new Map(task.issues.map((issue) => [issue.id, issue]));
  const seen = new Set();
  const issueDecisions = input.issueDecisions.map((entry, index) => {
    exactFields(entry, ISSUE_FIELDS, `issueDecisions[${index}]`);
    const issueId = text(entry.issueId, `issueDecisions[${index}].issueId`, { maxLength: 256 });
    const issue = byIssueId.get(issueId);
    if (!issue || seen.has(issueId)) {
      fail(`issueDecisions[${index}].issueId is missing, duplicate, or unknown`, 'INVALID_HUMAN_REVIEW_REQUEST');
    }
    seen.add(issueId);
    const disposition = entry.disposition;
    if (!DISPOSITION_SET.has(disposition)) {
      fail(`unsupported issue disposition: ${disposition}`, 'INVALID_HUMAN_REVIEW_REQUEST');
    }
    if (disposition === 'waive') {
      fail('waive disposition is disabled by Human Review policy', 'HUMAN_REVIEW_WAIVER_DISABLED', 403);
    }
    if (disposition === 'reject' && selectedAction !== 'terminate') {
      fail('reject disposition requires terminate because publication cannot bypass reviewers', 'HUMAN_REVIEW_POLICY_DENIED', 403);
    }
    const comment = text(entry.comment ?? '', `issueDecisions[${index}].comment`, {
      allowEmpty: true,
    });
    let targetOwner = entry.targetOwner ?? null;
    let requestedAction = entry.requestedAction ?? null;
    if (disposition === 'reassign') {
      targetOwner = text(targetOwner, `issueDecisions[${index}].targetOwner`, { maxLength: 64 });
      if (!ROUTABLE_OWNER_SET.has(targetOwner)) {
        fail(`reassignment owner is not routable: ${targetOwner}`, 'HUMAN_REVIEW_OWNER_NOT_ROUTABLE', 403);
      }
      if (!comment.trim()) fail('reassignment requires a comment', 'HUMAN_REVIEW_POLICY_DENIED', 403);
      requestedAction = text(
        requestedAction,
        `issueDecisions[${index}].requestedAction`,
        { maxLength: 8_000 },
      );
    } else {
      if (targetOwner !== null) {
        fail('targetOwner is only allowed for reassign disposition', 'INVALID_HUMAN_REVIEW_REQUEST');
      }
      targetOwner = null;
      if (disposition === 'revise') {
        requestedAction = text(
          requestedAction,
          `issueDecisions[${index}].requestedAction`,
          { maxLength: 8_000 },
        );
      } else {
        if (requestedAction !== null) {
          fail('requestedAction is only allowed for revise or reassign disposition', 'INVALID_HUMAN_REVIEW_REQUEST');
        }
        requestedAction = null;
      }
    }
    const resolvedOwner = disposition === 'reassign' ? targetOwner : issue.owner;
    if (selectedAction !== 'terminate' && !ROUTABLE_OWNER_SET.has(resolvedOwner)) {
      fail(
        `system/non-routable issue ${issueId} must be explicitly reassigned or terminated`,
        'HUMAN_REVIEW_OWNER_NOT_ROUTABLE',
        403,
      );
    }
    return {
      issueId,
      disposition,
      comment,
      targetOwner,
      requestedAction,
    };
  });

  const downgradeInstruction = normalizeDowngrade(
    input.downgradeInstruction ?? null,
    selectedAction,
  );
  const routeIssues = issueDecisions
    .filter((entry) => !['reject', 'waive'].includes(entry.disposition))
    .map((entry) => {
      const issue = byIssueId.get(entry.issueId);
      return {
        ...structuredClone(issue),
        owner: entry.disposition === 'reassign' ? entry.targetOwner : issue.owner,
        requestedAction: entry.requestedAction || issue.requestedAction,
        humanDisposition: entry.disposition,
      };
    });
  let owners = [...new Set(routeIssues.map((issue) => issue.owner))];
  if (selectedAction === 'terminate') owners = [];
  if (['report-only-revision', 'downgrade-and-publish'].includes(selectedAction)) {
    if (owners.some((owner) => owner !== 'report')) {
      fail(`${selectedAction} requires every routed issue to resolve to owner=report`, 'HUMAN_REVIEW_POLICY_DENIED', 403);
    }
    owners = ['report'];
  }
  if (selectedAction !== 'terminate' && owners.length === 0) {
    fail('selected action has no routable issue owner', 'HUMAN_REVIEW_POLICY_DENIED', 403);
  }
  const routeNodeIds = selectedAction === 'terminate' ? [] : routeForOwners(owners, spec);
  return deepFreeze({
    taskVersion: input.taskVersion,
    selectedAction,
    globalComment,
    issueDecisions,
    downgradeInstruction,
    owners,
    routeNodeIds,
    routeIssues,
    policyEvaluation: {
      allowed: true,
      policyVersion: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION,
      policyDigest: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST,
      denials: [],
    },
  });
}

export function runAnalysisHumanReviewPolicy() {
  return deepFreeze({
    version: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_VERSION,
    digest: RUN_ANALYSIS_HUMAN_REVIEW_POLICY_DIGEST,
    waiveAndPublishEnabled: false,
  });
}
