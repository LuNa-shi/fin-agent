import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function unique(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value))];
}

function humanReviewError(message, code = 'HUMAN_REVIEW_CHECKPOINT_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPositiveInteger(value, label, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw humanReviewError(`${label} must be an integer >= ${minimum}`, 'INVALID_HUMAN_REVIEW_HISTORY');
  }
}

function priorArtifactRefs(priorNodes = {}) {
  return Object.fromEntries(Object.entries(priorNodes).map(([nodeId, node]) => [
    nodeId,
    structuredClone(Array.isArray(node?.artifactRefs) ? node.artifactRefs : []),
  ]));
}

function normalizedDecisionDigest(entry) {
  const digest = entry.decisionDigest || entry.decisionRef?.contentDigest || null;
  if (digest !== null && !DIGEST_RE.test(digest)) {
    throw humanReviewError(
      'human review decision digest must be canonical sha256',
      'INVALID_HUMAN_REVIEW_HISTORY',
    );
  }
  return digest;
}

function checkpointReviewRound(entry) {
  return Number.isInteger(entry?.reviewRound)
    ? entry.reviewRound
    : Number(entry?.reviewRound || 0);
}

function reviewRoundOf(value) {
  if (Number.isInteger(value?.reviewRound)) return value.reviewRound;
  if (Number.isInteger(value?.reviewIdentity?.reviewRound)) return value.reviewIdentity.reviewRound;
  const cycle = value?.decision?.cycle;
  return Number.isInteger(cycle) ? cycle + 1 : 0;
}

function humanHistorySnapshot(entry, activeRemediation) {
  return {
    kind: 'resume',
    fingerprint: entry.fingerprint || null,
    taskId: entry.taskId,
    taskVersion: entry.taskVersion,
    decisionId: entry.decisionId,
    decisionRef: structuredClone(entry.decisionRef),
    decisionDigest: activeRemediation.decisionDigest,
    humanReviewAttempt: entry.humanReviewAttempt,
    reviewRound: entry.reviewRound,
    automaticRemediationCycle: entry.automaticRemediationCycle || 0,
    selectedAction: activeRemediation.selectedAction,
    downgradeInstruction: structuredClone(activeRemediation.downgradeInstruction),
    owners: [...activeRemediation.owners],
    rerunNodeIds: [...activeRemediation.rerunNodeIds],
    reopenNodeIds: [...activeRemediation.reopenNodeIds],
    issues: structuredClone(activeRemediation.issues),
    blockedStateDigest: entry.blockedStateDigest || null,
    resumedAt: entry.resumedAt || null,
  };
}

export function remediationIdentityForNode(cp, nodeId) {
  const remediation = cp?.activeRemediation;
  if (!remediation?.nodeIds?.includes(nodeId)) return null;
  if (remediation.kind !== 'human-review') {
    return {
      cycle: remediation.cycle,
      owners: [...(remediation.owners || [])],
      issueIds: (remediation.issues || []).map((issue) => issue?.id).filter(Boolean),
    };
  }
  return {
    kind: 'human-review',
    automaticRemediationCycle: remediation.cycle,
    humanReviewAttempt: remediation.humanReviewAttempt,
    reviewRound: remediation.reviewRound,
    taskId: remediation.taskId,
    taskVersion: remediation.taskVersion,
    decisionId: remediation.decisionId,
    decisionDigest: remediation.decisionDigest,
    fingerprint: remediation.fingerprint,
    selectedAction: remediation.selectedAction,
    downgradeInstruction: structuredClone(remediation.downgradeInstruction),
    owners: [...(remediation.owners || [])],
    issueIds: (remediation.issues || []).map((issue) => issue?.id).filter(Boolean),
    routeIssueDigest: canonicalSha256(remediation.issues || []),
  };
}

export function remediationIdentityDigestForNode(cp, nodeId) {
  const identity = remediationIdentityForNode(cp, nodeId);
  return identity ? canonicalSha256(identity) : null;
}

export function applyHumanReviewEntryToCheckpoint(cp, entry) {
  if (!cp || typeof cp !== 'object' || entry?.kind !== 'resume') return cp;
  assertPositiveInteger(entry.humanReviewAttempt, 'humanReviewAttempt');
  assertPositiveInteger(entry.reviewRound, 'reviewRound', 4);
  assertPositiveInteger(entry.taskVersion, 'taskVersion');
  if (typeof entry.taskId !== 'string' || !entry.taskId) {
    throw humanReviewError('taskId is required', 'INVALID_HUMAN_REVIEW_HISTORY');
  }
  if (typeof entry.decisionId !== 'string' || !entry.decisionId) {
    throw humanReviewError('decisionId is required', 'INVALID_HUMAN_REVIEW_HISTORY');
  }
  if (!entry.decisionRef || typeof entry.decisionRef !== 'object') {
    throw humanReviewError('decisionRef is required', 'INVALID_HUMAN_REVIEW_HISTORY');
  }
  if (typeof entry.selectedAction !== 'string' || !entry.selectedAction) {
    throw humanReviewError('selectedAction is required', 'INVALID_HUMAN_REVIEW_HISTORY');
  }
  if (
    entry.selectedAction === 'downgrade-and-publish'
    && (
      !entry.downgradeInstruction
      || typeof entry.downgradeInstruction !== 'object'
      || Array.isArray(entry.downgradeInstruction)
    )
  ) {
    throw humanReviewError(
      'downgrade-and-publish requires a structured downgradeInstruction',
      'INVALID_HUMAN_REVIEW_HISTORY',
    );
  }

  cp.humanReviewHistory = Array.isArray(cp.humanReviewHistory) ? cp.humanReviewHistory : [];
  const entryDecisionDigest = normalizedDecisionDigest(entry);
  const replay = cp.humanReviewHistory.find((item) => item?.decisionId === entry.decisionId);
  if (replay) {
    const matches = (
      replay.kind === 'resume'
      && replay.humanReviewAttempt === entry.humanReviewAttempt
      && replay.reviewRound === entry.reviewRound
      && replay.fingerprint === (entry.fingerprint || null)
      && replay.decisionDigest === entryDecisionDigest
    );
    if (!matches) {
      throw humanReviewError('human review checkpoint replay conflicts with applied history');
    }
    cp.humanReviewAttemptApplied = Math.max(
      cp.humanReviewAttemptApplied || 0,
      entry.humanReviewAttempt,
    );
    return cp;
  }

  const appliedAttempt = cp.humanReviewAttemptApplied || 0;
  if (entry.humanReviewAttempt !== appliedAttempt + 1) {
    throw humanReviewError(
      `human review checkpoint attempt must follow ${appliedAttempt}`,
      'HUMAN_REVIEW_CHECKPOINT_SEQUENCE_CONFLICT',
    );
  }
  const priorReviewRound = Math.max(
    3,
    ...cp.humanReviewHistory.map(reviewRoundOf),
    ...(cp.reportReviewHistory || []).map(reviewRoundOf),
  );
  if (entry.reviewRound <= priorReviewRound) {
    throw humanReviewError(
      `human review round ${entry.reviewRound} must be greater than ${priorReviewRound}`,
      'HUMAN_REVIEW_REVIEW_ROUND_CONFLICT',
    );
  }

  const rerunNodeIds = unique(entry.rerunNodeIds);
  const reopenNodeIds = unique(entry.reopenNodeIds);
  const nodeIds = unique([...rerunNodeIds, ...reopenNodeIds]);
  if (rerunNodeIds.length === 0 || nodeIds.length !== rerunNodeIds.length + reopenNodeIds.length) {
    throw humanReviewError(
      'human review rerun/reopen nodes must be non-empty, unique, and disjoint',
      'INVALID_HUMAN_REVIEW_HISTORY',
    );
  }
  const activeRemediation = {
    kind: 'human-review',
    cycle: entry.automaticRemediationCycle || 0,
    humanReviewAttempt: entry.humanReviewAttempt,
    reviewRound: checkpointReviewRound(entry),
    taskId: entry.taskId,
    taskVersion: entry.taskVersion,
    decisionId: entry.decisionId,
    decisionRef: structuredClone(entry.decisionRef),
    decisionDigest: entryDecisionDigest,
    fingerprint: entry.fingerprint || null,
    selectedAction: entry.selectedAction,
    downgradeInstruction: structuredClone(entry.downgradeInstruction || null),
    owners: unique(entry.owners),
    nodeIds,
    rerunNodeIds,
    reopenNodeIds,
    issues: structuredClone(entry.openIssues || entry.routeIssues || []),
    priorNodeArtifactRefs: priorArtifactRefs(entry.priorNodes),
    requestedAt: entry.resumedAt || null,
  };
  cp.activeRemediation = activeRemediation;
  cp.humanReviewAttemptApplied = entry.humanReviewAttempt;
  cp.humanReviewHistory.push(humanHistorySnapshot(entry, activeRemediation));
  cp.openIssues = structuredClone(activeRemediation.issues);
  cp.nodeExecutions = cp.nodeExecutions || {};
  for (const nodeId of nodeIds) delete cp.nodeExecutions[nodeId];
  if (nodeIds.includes('compose-report')) cp.reportDone = false;
  if (nodeIds.includes('review-report')) cp.reportReview = null;
  if (nodeIds.includes('synthesize-conclusion')) cp.conclusion = null;
  if (nodeIds.includes('finalize-project')) cp.done = false;
  return cp;
}
