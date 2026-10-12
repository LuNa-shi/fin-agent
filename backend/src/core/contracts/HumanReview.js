import {
  canonicalSha256,
  createArtifactRef,
  deepFreeze,
  validateArtifactRef,
} from './ArtifactRef.js';

export const HUMAN_REVIEW_TASK_SCHEMA_VERSION = 'human-review-task.v1';
export const HUMAN_REVIEW_DECISION_SCHEMA_VERSION = 'human-review-decision.v1';

export const HUMAN_REVIEW_TASK_STATUSES = Object.freeze([
  'open',
  'decided',
  'resuming',
  'resolved',
  'resume-failed',
  'terminated',
  'superseded',
]);

export const HUMAN_REVIEW_DISPOSITIONS = Object.freeze([
  'accept',
  'reject',
  'waive',
  'revise',
  'reassign',
]);

export const HUMAN_REVIEW_ACTIONS = Object.freeze([
  'resume-remediation',
  'report-only-revision',
  'downgrade-and-publish',
  'waive-and-publish',
  'terminate',
]);

export const LOCAL_HUMAN_REVIEWER = deepFreeze({
  id: 'local-user',
  kind: 'local-single-user',
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TASK_STATUS_SET = new Set(HUMAN_REVIEW_TASK_STATUSES);
const DISPOSITION_SET = new Set(HUMAN_REVIEW_DISPOSITIONS);
const ACTION_SET = new Set(HUMAN_REVIEW_ACTIONS);
const TASK_FIELDS = new Set([
  'schemaVersion',
  'taskId',
  'version',
  'status',
  'projectId',
  'runId',
  'workflow',
  'blockedNodeId',
  'reviewNodeId',
  'remediationCycle',
  'reviewBlockCount',
  'blockedStateDigest',
  'issues',
  'issuesDigest',
  'allowedActions',
  'requestedActions',
  'createdAt',
  'updatedAt',
  'policy',
  'reviewArtifactRefs',
  'reviewDecisionArtifactRef',
  'previousTaskRef',
  'producingDecisionRef',
  'contentDigest',
]);
const DECISION_FIELDS = new Set([
  'schemaVersion',
  'decisionId',
  'taskId',
  'taskVersion',
  'taskRef',
  'reviewer',
  'decidedAt',
  'issueDecisions',
  'globalComment',
  'selectedAction',
  'downgradeInstruction',
  'policyEvaluation',
  'requestDigest',
  'previousDecisionRef',
  'contentDigest',
]);
const ISSUE_DECISION_FIELDS = new Set([
  'issueId',
  'disposition',
  'comment',
  'targetOwner',
  'requestedAction',
]);
const WORKFLOW_FIELDS = new Set(['id', 'version', 'hash']);
const POLICY_FIELDS = new Set(['version', 'digest', 'waiveAndPublishEnabled']);
const REVIEWER_FIELDS = new Set(['id', 'kind']);
const POLICY_EVALUATION_FIELDS = new Set([
  'allowed',
  'policyVersion',
  'policyDigest',
  'denials',
]);
const DOWNGRADE_FIELDS = new Set([
  'targetRating',
  'targetConfidence',
  'rationale',
]);

export class HumanReviewContractError extends Error {
  constructor(message, code = 'INVALID_HUMAN_REVIEW_CONTRACT') {
    super(message);
    this.name = 'HumanReviewContractError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(message, code = 'INVALID_HUMAN_REVIEW_CONTRACT') {
  throw new HumanReviewContractError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactFields(value, allowed, label) {
  assertObject(value, label);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) fail(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function assertText(value, label, {
  maxLength = 1_000,
  nullable = false,
  allowEmpty = false,
} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string${nullable ? ' or null' : ''}`);
  if (!allowEmpty && !value.trim()) fail(`${label} must be non-empty`);
  if (value.length > maxLength) fail(`${label} exceeds ${maxLength} characters`);
  if (value.includes('\0')) fail(`${label} contains a forbidden null byte`);
  return value;
}

function assertSafeId(value, label) {
  assertText(value, label, { maxLength: 256 });
  if (!SAFE_ID_RE.test(value)) fail(`${label} is unsafe`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function assertTimestamp(value, label) {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail(`${label} must be an ISO timestamp`);
  return value;
}

function cloneJson(value, label) {
  try {
    return structuredClone(value);
  } catch {
    fail(`${label} must be JSON-compatible`);
  }
}

function assertArtifactRefOrNull(value, label) {
  if (value === null) return null;
  const checked = validateArtifactRef(value);
  if (!checked.valid) fail(`${label} must be a valid ArtifactRef`);
  return createArtifactRef(value);
}

function assertArtifactRefs(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > 256) fail(`${label} exceeds 256 entries`);
  return value.map((ref, index) => assertArtifactRefOrNull(ref, `${label}[${index}]`));
}

function assertWorkflow(value) {
  assertExactFields(value, WORKFLOW_FIELDS, 'workflow');
  assertSafeId(value.id, 'workflow.id');
  assertText(value.version, 'workflow.version', { maxLength: 64 });
  assertDigest(value.hash, 'workflow.hash');
  return cloneJson(value, 'workflow');
}

function assertIssue(issue, index) {
  assertObject(issue, `issues[${index}]`);
  assertSafeId(issue.id, `issues[${index}].id`);
  assertText(issue.owner, `issues[${index}].owner`, { maxLength: 64 });
  assertText(issue.severity, `issues[${index}].severity`, { maxLength: 32 });
  assertText(issue.location, `issues[${index}].location`, { maxLength: 1_000 });
  assertText(issue.message, `issues[${index}].message`, { maxLength: 8_000 });
  assertText(issue.requestedAction, `issues[${index}].requestedAction`, { maxLength: 8_000 });
  if (issue.evidence !== undefined) {
    if (!Array.isArray(issue.evidence) || issue.evidence.length > 256) {
      fail(`issues[${index}].evidence must be an array with at most 256 entries`);
    }
    issue.evidence.forEach((entry, evidenceIndex) => {
      assertText(entry, `issues[${index}].evidence[${evidenceIndex}]`, { maxLength: 4_000 });
    });
  }
  if (issue.sourceReviewer !== undefined) {
    assertText(issue.sourceReviewer, `issues[${index}].sourceReviewer`, { maxLength: 128 });
  }
  if (issue.claim !== undefined) {
    assertText(issue.claim, `issues[${index}].claim`, { maxLength: 8_000 });
  }
  if (typeof issue.blocking !== 'boolean') fail(`issues[${index}].blocking must be boolean`);
  return cloneJson(issue, `issues[${index}]`);
}

function assertIssues(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    fail('issues must contain between 1 and 256 entries');
  }
  const issues = value.map(assertIssue);
  const ids = issues.map((issue) => issue.id);
  if (new Set(ids).size !== ids.length) fail('issues must have unique ids');
  return issues;
}

function assertPolicy(value) {
  assertExactFields(value, POLICY_FIELDS, 'policy');
  assertText(value.version, 'policy.version', { maxLength: 128 });
  assertDigest(value.digest, 'policy.digest');
  if (typeof value.waiveAndPublishEnabled !== 'boolean') {
    fail('policy.waiveAndPublishEnabled must be boolean');
  }
  return cloneJson(value, 'policy');
}

function assertTaskWithoutDigest(input) {
  assertExactFields(input, TASK_FIELDS, 'HumanReviewTask');
  if (input.schemaVersion !== HUMAN_REVIEW_TASK_SCHEMA_VERSION) {
    fail(`unsupported HumanReviewTask schemaVersion: ${input.schemaVersion}`);
  }
  assertSafeId(input.taskId, 'taskId');
  if (!Number.isInteger(input.version) || input.version < 1) fail('task version must be a positive integer');
  if (!TASK_STATUS_SET.has(input.status)) fail(`unsupported task status: ${input.status}`);
  assertSafeId(input.projectId, 'projectId');
  assertSafeId(input.runId, 'runId');
  const workflow = assertWorkflow(input.workflow);
  assertSafeId(input.blockedNodeId, 'blockedNodeId');
  assertSafeId(input.reviewNodeId, 'reviewNodeId');
  if (!Number.isInteger(input.remediationCycle) || input.remediationCycle < 0) {
    fail('remediationCycle must be a non-negative integer');
  }
  if (!Number.isInteger(input.reviewBlockCount) || input.reviewBlockCount < 1) {
    fail('reviewBlockCount must be a positive integer');
  }
  assertDigest(input.blockedStateDigest, 'blockedStateDigest');
  const issues = assertIssues(input.issues);
  assertDigest(input.issuesDigest, 'issuesDigest');
  if (canonicalSha256(issues) !== input.issuesDigest) fail('issuesDigest does not match issues');
  if (
    !Array.isArray(input.allowedActions)
    || input.allowedActions.length === 0
    || input.allowedActions.some((action) => !ACTION_SET.has(action))
    || new Set(input.allowedActions).size !== input.allowedActions.length
  ) fail('allowedActions must be a unique non-empty Human Review action array');
  if (!Array.isArray(input.requestedActions) || input.requestedActions.length !== issues.length) {
    fail('requestedActions must contain one entry per issue');
  }
  const requestedActions = input.requestedActions.map((entry, index) => {
    assertObject(entry, `requestedActions[${index}]`);
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== 'issueId,owner,requestedAction') {
      fail(`requestedActions[${index}] must contain issueId, owner, requestedAction`);
    }
    assertSafeId(entry.issueId, `requestedActions[${index}].issueId`);
    assertText(entry.owner, `requestedActions[${index}].owner`, { maxLength: 64 });
    assertText(entry.requestedAction, `requestedActions[${index}].requestedAction`, { maxLength: 8_000 });
    if (entry.issueId !== issues[index].id) fail('requestedActions order must match issues');
    return cloneJson(entry, `requestedActions[${index}]`);
  });
  assertTimestamp(input.createdAt, 'createdAt');
  assertTimestamp(input.updatedAt, 'updatedAt');
  if (Date.parse(input.updatedAt) < Date.parse(input.createdAt)) fail('updatedAt precedes createdAt');
  const policy = assertPolicy(input.policy);
  const reviewArtifactRefs = assertArtifactRefs(input.reviewArtifactRefs, 'reviewArtifactRefs');
  if (reviewArtifactRefs.length === 0) fail('reviewArtifactRefs must not be empty');
  const reviewDecisionArtifactRef = assertArtifactRefOrNull(
    input.reviewDecisionArtifactRef,
    'reviewDecisionArtifactRef',
  );
  if (reviewDecisionArtifactRef === null) fail('reviewDecisionArtifactRef is required');
  const previousTaskRef = assertArtifactRefOrNull(input.previousTaskRef, 'previousTaskRef');
  const producingDecisionRef = assertArtifactRefOrNull(
    input.producingDecisionRef,
    'producingDecisionRef',
  );
  return {
    schemaVersion: input.schemaVersion,
    taskId: input.taskId,
    version: input.version,
    status: input.status,
    projectId: input.projectId,
    runId: input.runId,
    workflow,
    blockedNodeId: input.blockedNodeId,
    reviewNodeId: input.reviewNodeId,
    remediationCycle: input.remediationCycle,
    reviewBlockCount: input.reviewBlockCount,
    blockedStateDigest: input.blockedStateDigest,
    issues,
    issuesDigest: input.issuesDigest,
    allowedActions: [...input.allowedActions],
    requestedActions,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    policy,
    reviewArtifactRefs,
    reviewDecisionArtifactRef,
    previousTaskRef,
    producingDecisionRef,
  };
}

export function humanReviewTaskSemanticValue(task) {
  const { contentDigest: _contentDigest, ...semantic } = task;
  return semantic;
}

export function createHumanReviewTask(input) {
  const normalized = assertTaskWithoutDigest({
    ...input,
    contentDigest: input?.contentDigest || canonicalSha256(
      humanReviewTaskSemanticValue(input || {}),
    ),
  });
  const contentDigest = canonicalSha256(normalized);
  if (input?.contentDigest !== undefined && input.contentDigest !== contentDigest) {
    fail('HumanReviewTask contentDigest does not match content');
  }
  return deepFreeze({ ...normalized, contentDigest });
}

export function validateHumanReviewTask(input) {
  try {
    createHumanReviewTask(input);
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [String(error?.message || error)] };
  }
}

function assertReviewer(value) {
  assertExactFields(value, REVIEWER_FIELDS, 'reviewer');
  assertSafeId(value.id, 'reviewer.id');
  assertText(value.kind, 'reviewer.kind', { maxLength: 64 });
  return cloneJson(value, 'reviewer');
}

function assertIssueDecision(value, index) {
  assertExactFields(value, ISSUE_DECISION_FIELDS, `issueDecisions[${index}]`);
  assertSafeId(value.issueId, `issueDecisions[${index}].issueId`);
  if (!DISPOSITION_SET.has(value.disposition)) {
    fail(`issueDecisions[${index}].disposition is unsupported`);
  }
  assertText(value.comment, `issueDecisions[${index}].comment`, {
    maxLength: 4_000,
    allowEmpty: true,
  });
  assertText(value.targetOwner, `issueDecisions[${index}].targetOwner`, {
    maxLength: 64,
    nullable: true,
  });
  assertText(value.requestedAction, `issueDecisions[${index}].requestedAction`, {
    maxLength: 8_000,
    nullable: true,
  });
  return cloneJson(value, `issueDecisions[${index}]`);
}

function assertDowngradeInstruction(value) {
  if (value === null) return null;
  assertExactFields(value, DOWNGRADE_FIELDS, 'downgradeInstruction');
  assertText(value.targetRating, 'downgradeInstruction.targetRating', { maxLength: 64 });
  if (
    value.targetConfidence !== null
    && (
      typeof value.targetConfidence !== 'number'
      || !Number.isFinite(value.targetConfidence)
      || value.targetConfidence < 0
      || value.targetConfidence > 1
    )
  ) fail('downgradeInstruction.targetConfidence must be null or a number from 0 to 1');
  assertText(value.rationale, 'downgradeInstruction.rationale', { maxLength: 4_000 });
  return cloneJson(value, 'downgradeInstruction');
}

function assertPolicyEvaluation(value) {
  assertExactFields(value, POLICY_EVALUATION_FIELDS, 'policyEvaluation');
  if (typeof value.allowed !== 'boolean') fail('policyEvaluation.allowed must be boolean');
  assertText(value.policyVersion, 'policyEvaluation.policyVersion', { maxLength: 128 });
  assertDigest(value.policyDigest, 'policyEvaluation.policyDigest');
  if (
    !Array.isArray(value.denials)
    || value.denials.length > 32
    || value.denials.some((denial) => typeof denial !== 'string' || denial.length > 1_000)
  ) fail('policyEvaluation.denials must be a bounded string array');
  return cloneJson(value, 'policyEvaluation');
}

function assertDecisionWithoutDigest(input) {
  assertExactFields(input, DECISION_FIELDS, 'HumanReviewDecision');
  if (input.schemaVersion !== HUMAN_REVIEW_DECISION_SCHEMA_VERSION) {
    fail(`unsupported HumanReviewDecision schemaVersion: ${input.schemaVersion}`);
  }
  assertSafeId(input.decisionId, 'decisionId');
  assertSafeId(input.taskId, 'taskId');
  if (!Number.isInteger(input.taskVersion) || input.taskVersion < 1) {
    fail('taskVersion must be a positive integer');
  }
  const taskRef = assertArtifactRefOrNull(input.taskRef, 'taskRef');
  if (taskRef === null) fail('taskRef is required');
  const reviewer = assertReviewer(input.reviewer);
  assertTimestamp(input.decidedAt, 'decidedAt');
  if (!Array.isArray(input.issueDecisions) || input.issueDecisions.length === 0 || input.issueDecisions.length > 256) {
    fail('issueDecisions must contain between 1 and 256 entries');
  }
  const issueDecisions = input.issueDecisions.map(assertIssueDecision);
  if (new Set(issueDecisions.map((entry) => entry.issueId)).size !== issueDecisions.length) {
    fail('issueDecisions must have unique issueId values');
  }
  assertText(input.globalComment, 'globalComment', { maxLength: 8_000, allowEmpty: true });
  if (!ACTION_SET.has(input.selectedAction)) fail(`unsupported selectedAction: ${input.selectedAction}`);
  const downgradeInstruction = assertDowngradeInstruction(input.downgradeInstruction);
  const policyEvaluation = assertPolicyEvaluation(input.policyEvaluation);
  assertDigest(input.requestDigest, 'requestDigest');
  const previousDecisionRef = assertArtifactRefOrNull(
    input.previousDecisionRef,
    'previousDecisionRef',
  );
  return {
    schemaVersion: input.schemaVersion,
    decisionId: input.decisionId,
    taskId: input.taskId,
    taskVersion: input.taskVersion,
    taskRef,
    reviewer,
    decidedAt: input.decidedAt,
    issueDecisions,
    globalComment: input.globalComment,
    selectedAction: input.selectedAction,
    downgradeInstruction,
    policyEvaluation,
    requestDigest: input.requestDigest,
    previousDecisionRef,
  };
}

export function humanReviewDecisionSemanticValue(decision) {
  const { contentDigest: _contentDigest, ...semantic } = decision;
  return semantic;
}

export function createHumanReviewDecision(input) {
  const normalized = assertDecisionWithoutDigest({
    ...input,
    contentDigest: input?.contentDigest || canonicalSha256(
      humanReviewDecisionSemanticValue(input || {}),
    ),
  });
  const contentDigest = canonicalSha256(normalized);
  if (input?.contentDigest !== undefined && input.contentDigest !== contentDigest) {
    fail('HumanReviewDecision contentDigest does not match content');
  }
  return deepFreeze({ ...normalized, contentDigest });
}

export function validateHumanReviewDecision(input) {
  try {
    createHumanReviewDecision(input);
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [String(error?.message || error)] };
  }
}

export function humanReviewRequestDigest({
  taskId,
  taskVersion,
  taskRef,
  reviewer,
  issueDecisions,
  globalComment,
  selectedAction,
  downgradeInstruction,
}) {
  assertSafeId(taskId, 'taskId');
  if (!Number.isInteger(taskVersion) || taskVersion < 1) fail('taskVersion must be a positive integer');
  const normalizedTaskRef = assertArtifactRefOrNull(taskRef, 'taskRef');
  if (normalizedTaskRef === null) fail('taskRef is required');
  return canonicalSha256({
    taskId,
    taskVersion,
    taskRef: normalizedTaskRef,
    reviewer: assertReviewer(reviewer),
    issueDecisions: issueDecisions.map(assertIssueDecision),
    globalComment: assertText(globalComment, 'globalComment', {
      maxLength: 8_000,
      allowEmpty: true,
    }),
    selectedAction,
    downgradeInstruction: assertDowngradeInstruction(downgradeInstruction),
  });
}

export function humanReviewTaskId(identity) {
  return `hrt_${canonicalSha256(identity).slice('sha256:'.length)}`;
}

export function humanReviewDecisionId({ taskId, reviewerId, requestDigest }) {
  return `hrd_${canonicalSha256({ taskId, reviewerId, requestDigest }).slice('sha256:'.length)}`;
}
