import {
  HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
  LOCAL_HUMAN_REVIEWER,
  createHumanReviewDecision,
  humanReviewDecisionId,
  humanReviewRequestDigest,
} from '../../../core/contracts/HumanReview.js';
import { NODE_STATES } from '../../../core/workflow/NodeState.js';
import {
  ProjectSpace,
  verifiedRunAnalysisReportPackage,
} from '../../../project-space/index.js';
import { RUN_STATUSES } from '../../../project-space/RunStore.js';
import { applyHumanReviewEntryToCheckpoint } from './checkpoint.js';
import { assertRunAnalysisReviewMutationAllowed } from './guard.js';
import { normalizeHumanReviewDecisionRequest } from './policy.js';
import { ensureRunAnalysisHumanReviewTask } from './taskFactory.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  topologicalNodeOrder,
} from '../workflowSpec.js';

const RESUME_FIELDS = new Set(['taskVersion', 'decisionId']);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TERMINAL_TASK_STATUSES = new Set([
  'resolved',
  'resume-failed',
  'terminated',
  'superseded',
]);
const SAFE_REF_FIELDS = [
  'artifactId',
  'version',
  'path',
  'contentDigest',
  'schemaVersion',
  'producer',
  'contractVersion',
  'inputDigest',
  'createdAt',
  'asOf',
];
const SENSITIVE_ASSIGNMENT_RE = /(?<![A-Za-z0-9_])((["']?)(?:(?:[A-Za-z0-9]+[-_])*(?:api[-_ ]?key|authorization|password|secret|token)|aws[-_]?secret[-_]?access[-_]?key)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;

export class HumanReviewControllerError extends Error {
  constructor(message, code = 'HUMAN_REVIEW_CONTROLLER_ERROR', statusCode = 400) {
    super(message);
    this.name = 'HumanReviewControllerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, code = 'HUMAN_REVIEW_CONTROLLER_ERROR', statusCode = 400) {
  throw new HumanReviewControllerError(message, code, statusCode);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail(`${label} is invalid`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  return value;
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length) {
    fail(`${label} contains forbidden fields: ${unknown.join(', ')}`, 'INVALID_HUMAN_REVIEW_REQUEST');
  }
}

function redactText(value, maxLength = 8_000) {
  if (typeof value !== 'string') return value;
  return value
    .replace(
      /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gu,
      '$1[redacted-credentials]@',
    )
    .replace(/https?:\/\/[^\s<>"']+/giu, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[redacted-key]')
    .replace(
      SENSITIVE_ASSIGNMENT_RE,
      (_match, prefix, _keyQuote, sensitiveValue) => {
        const quote = sensitiveValue[0];
        const quoted = (quote === '"' || quote === "'")
          && sensitiveValue.at(-1) === quote;
        return `${prefix}${quoted ? `${quote}[redacted]${quote}` : '[redacted]'}`;
      },
    )
    .slice(0, maxLength);
}

function safeRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  return Object.fromEntries(SAFE_REF_FIELDS
    .filter((field) => ref[field] !== undefined)
    .map((field) => [field, ref[field]]));
}

function safeIssue(issue) {
  return {
    id: issue.id,
    severity: issue.severity,
    owner: issue.owner,
    location: redactText(issue.location, 1_000),
    message: redactText(issue.message),
    requestedAction: redactText(issue.requestedAction),
    evidence: Array.isArray(issue.evidence)
      ? issue.evidence.map((item) => redactText(item, 4_000))
      : [],
    sourceReviewer: issue.sourceReviewer || null,
    claim: issue.claim ? redactText(issue.claim) : null,
    blocking: issue.blocking !== false,
  };
}

function safeDecision(decision) {
  if (!decision) return null;
  return {
    schemaVersion: decision.schemaVersion,
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    taskVersion: decision.taskVersion,
    reviewer: structuredClone(decision.reviewer),
    decidedAt: decision.decidedAt,
    issueDecisions: decision.issueDecisions.map((entry) => ({
      issueId: entry.issueId,
      disposition: entry.disposition,
      comment: redactText(entry.comment, 4_000),
      targetOwner: entry.targetOwner,
      requestedAction: entry.requestedAction
        ? redactText(entry.requestedAction)
        : null,
    })),
    globalComment: redactText(decision.globalComment),
    selectedAction: decision.selectedAction,
    downgradeInstruction: decision.downgradeInstruction
      ? {
          ...structuredClone(decision.downgradeInstruction),
          rationale: redactText(decision.downgradeInstruction.rationale, 4_000),
        }
      : null,
    policyEvaluation: structuredClone(decision.policyEvaluation),
    requestDigest: decision.requestDigest,
    contentDigest: decision.contentDigest,
  };
}

export function safeHumanReviewTaskProjection(entry, { detail = true } = {}) {
  if (!entry) return null;
  const projected = {
    schemaVersion: entry.schemaVersion,
    taskId: entry.taskId,
    version: entry.version,
    status: entry.status,
    projectId: entry.projectId,
    runId: entry.runId,
    workflow: structuredClone(entry.workflow),
    blockedNodeId: entry.blockedNodeId,
    reviewNodeId: entry.reviewNodeId,
    remediationCycle: entry.remediationCycle,
    reviewBlockCount: entry.reviewBlockCount,
    allowedActions: [...entry.allowedActions],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    policy: structuredClone(entry.policy),
    issueCount: entry.issues.length,
    issuesDigest: entry.issuesDigest,
    contentDigest: entry.contentDigest,
    decision: detail
      ? safeDecision(entry.decision)
      : (entry.decision ? {
          decisionId: entry.decision.decisionId,
          reviewer: structuredClone(entry.decision.reviewer),
          decidedAt: entry.decision.decidedAt,
          selectedAction: entry.decision.selectedAction,
        } : null),
    resume: entry.resume ? structuredClone(entry.resume) : null,
    outcome: entry.outcome ? structuredClone(entry.outcome) : null,
  };
  if (detail) {
    projected.issues = entry.issues.map(safeIssue);
    projected.requestedActions = entry.requestedActions.map((item) => ({
      issueId: item.issueId,
      owner: item.owner,
      requestedAction: redactText(item.requestedAction),
    }));
    projected.taskArtifactRef = safeRef(entry.taskArtifactRef);
    projected.decisionArtifactRef = safeRef(entry.decisionArtifactRef);
    projected.reviewArtifactRefs = entry.reviewArtifactRefs.map(safeRef).filter(Boolean);
    projected.reviewDecisionArtifactRef = safeRef(entry.reviewDecisionArtifactRef);
  }
  return projected;
}

function sourceTaskForDecision(projectSpace, projectId, entry) {
  if (!entry.decision) return entry;
  let source;
  try {
    source = JSON.parse(projectSpace.artifactStore(projectId).read(entry.decision.taskRef));
  } catch {
    fail('accepted decision source task is unavailable', 'HUMAN_REVIEW_AUDIT_ARTIFACT_MISSING', 409);
  }
  if (source.taskId !== entry.taskId || source.version !== entry.decision.taskVersion) {
    fail('accepted decision source task identity is invalid', 'HUMAN_REVIEW_AUDIT_ARTIFACT_CONFLICT', 409);
  }
  return source;
}

function decisionRequest(decision) {
  return {
    taskVersion: decision.taskVersion,
    selectedAction: decision.selectedAction,
    globalComment: decision.globalComment,
    issueDecisions: structuredClone(decision.issueDecisions),
    downgradeInstruction: decision.downgradeInstruction
      ? structuredClone(decision.downgradeInstruction)
      : null,
  };
}

function requestDigest(task, normalized) {
  return humanReviewRequestDigest({
    taskId: task.taskId,
    taskVersion: normalized.taskVersion,
    taskRef: task.taskArtifactRef,
    reviewer: LOCAL_HUMAN_REVIEWER,
    issueDecisions: normalized.issueDecisions,
    globalComment: normalized.globalComment,
    selectedAction: normalized.selectedAction,
    downgradeInstruction: normalized.downgradeInstruction,
  });
}

function withTaskRef(task, ref) {
  return {
    ...task,
    taskArtifactRef: ref,
  };
}

function descendantsOf(nodeIds, spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  const affected = new Set(nodeIds);
  for (const nodeId of topologicalNodeOrder(spec)) {
    const node = spec.nodes.find((candidate) => candidate.id === nodeId);
    if ((node.dependsOn || []).some((dependency) => affected.has(dependency))) {
      affected.add(nodeId);
    }
  }
  return affected;
}

function transitionPreview(run, routeNodeIds) {
  const ordered = topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC);
  const route = new Set(routeNodeIds);
  const affected = descendantsOf(routeNodeIds);
  const rerunNodeIds = ordered.filter((nodeId) => {
    if (!route.has(nodeId)) return false;
    const node = run.nodes?.[nodeId];
    return node && (
      node.status !== NODE_STATES.BLOCKED
      || (node.artifactRefs || []).length > 0
    );
  });
  const rerun = new Set(rerunNodeIds);
  const reopenNodeIds = ordered.filter((nodeId) => {
    if (!affected.has(nodeId) || rerun.has(nodeId)) return false;
    const node = run.nodes?.[nodeId];
    return node?.status === NODE_STATES.BLOCKED && (node.artifactRefs || []).length === 0;
  });
  if (!rerunNodeIds.length) {
    fail('review decision has no completed authorized node to rerun', 'HUMAN_REVIEW_ROUTE_EMPTY', 409);
  }
  return {
    rerunNodeIds,
    reopenNodeIds,
    affectedNodeIds: ordered.filter((nodeId) => rerun.has(nodeId) || reopenNodeIds.includes(nodeId)),
    preservedNodeIds: ordered.filter((nodeId) => !rerun.has(nodeId) && !reopenNodeIds.includes(nodeId)),
  };
}

function nextReviewRound(task, run) {
  const artifactRounds = (task.reviewArtifactRefs || [])
    .map((ref) => /report_quality_r(\d+)\.json$/u.exec(ref.path || '')?.[1])
    .filter(Boolean)
    .map(Number);
  const humanRounds = (run.humanReviewHistory || [])
    .filter((entry) => entry.kind === 'resume' && Number.isInteger(entry.reviewRound))
    .map((entry) => entry.reviewRound);
  return Math.max(
    3,
    (run.remediationCycle || 0) + 1,
    ...artifactRounds,
    ...humanRounds,
  ) + 1;
}

function latestRun(projectSpace, projectId) {
  return projectSpace.runStore(projectId).list().at(-1) || null;
}

export class RunAnalysisHumanReviewController {
  constructor({
    projectSpace = ProjectSpace,
    analysisService = null,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!projectSpace || typeof projectSpace.humanReviewStore !== 'function') {
      throw new TypeError('Human Review projectSpace is required');
    }
    if (typeof now !== 'function') throw new TypeError('Human Review clock is required');
    this.projectSpace = projectSpace;
    this.analysisService = analysisService;
    this.now = now;
  }

  bindAnalysisService(service) {
    if (!service || typeof service.resumeReviewed !== 'function') {
      throw new TypeError('Human Review analysis service must support resumeReviewed');
    }
    if (this.analysisService && this.analysisService !== service) {
      throw new TypeError('Human Review analysis service is already bound');
    }
    this.analysisService = service;
    return this;
  }

  open(projectId, { detail = true } = {}) {
    assertSafeId(projectId, 'projectId');
    if (!this.projectSpace.meta(projectId)) {
      fail(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    }
    this.#reconcileProject(projectId);
    return safeHumanReviewTaskProjection(
      this.projectSpace.humanReviewStore(projectId).open(),
      { detail },
    );
  }

  get(taskId) {
    const located = this.#locate(taskId);
    this.#reconcileProject(located.projectId);
    const current = located.store.get(taskId);
    if (!current) fail(`Human Review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);
    return safeHumanReviewTaskProjection(current);
  }

  preview(taskId, input) {
    const located = this.#locate(taskId);
    this.#reconcileProject(located.projectId);
    const task = located.store.get(taskId);
    if (!task || task.status !== 'open') {
      fail(`Human Review task is not open: ${taskId}`, 'HUMAN_REVIEW_TASK_STALE', 409);
    }
    const run = this.#assertBlockedTask(task);
    const normalized = normalizeHumanReviewDecisionRequest(task, input);
    const transition = normalized.selectedAction === 'terminate'
      ? {
          rerunNodeIds: [],
          reopenNodeIds: [],
          affectedNodeIds: [],
          preservedNodeIds: topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC),
        }
      : transitionPreview(run, normalized.routeNodeIds);
    return {
      taskId: task.taskId,
      taskVersion: task.version,
      selectedAction: normalized.selectedAction,
      owners: [...normalized.owners],
      routeNodeIds: [...normalized.routeNodeIds],
      ...transition,
      preservedSuccessfulNodeIds: transition.preservedNodeIds.filter(
        (nodeId) => run.nodes?.[nodeId]?.status === NODE_STATES.SUCCEEDED,
      ),
      issueRoutes: normalized.routeIssues.map((issue) => ({
        issueId: issue.id,
        owner: issue.owner,
        disposition: issue.humanDisposition,
      })),
      humanReviewAttempt: normalized.selectedAction === 'terminate'
        ? null
        : (run.humanReviewAttempt || 0) + 1,
      reviewRound: normalized.selectedAction === 'terminate'
        ? null
        : nextReviewRound(task, run),
      normalReviewRequired: normalized.selectedAction !== 'terminate',
      publishesDirectly: false,
      policyEvaluation: structuredClone(normalized.policyEvaluation),
    };
  }

  decide(taskId, input) {
    const located = this.#locate(taskId);
    this.#reconcileProject(located.projectId);
    let task = located.store.get(taskId);
    if (!task) fail(`Human Review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);

    if (task.decision) {
      const source = sourceTaskForDecision(this.projectSpace, located.projectId, task);
      const normalized = normalizeHumanReviewDecisionRequest(
        withTaskRef(source, task.decision.taskRef),
        input,
      );
      const digest = requestDigest(withTaskRef(source, task.decision.taskRef), normalized);
      if (digest !== task.decision.requestDigest) {
        fail('Human Review task already has a different decision', 'HUMAN_REVIEW_DECISION_CONFLICT', 409);
      }
      return {
        task: safeHumanReviewTaskProjection(task),
        preview: this.#previewAccepted(located.projectId, task, normalized),
        replayed: true,
      };
    }
    if (task.status !== 'open') {
      fail(`Human Review task is stale: ${taskId}`, 'HUMAN_REVIEW_TASK_STALE', 409);
    }
    this.#assertBlockedTask(task);
    const normalized = normalizeHumanReviewDecisionRequest(task, input);
    const digest = requestDigest(task, normalized);
    const decision = createHumanReviewDecision({
      schemaVersion: HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
      decisionId: humanReviewDecisionId({
        taskId: task.taskId,
        reviewerId: LOCAL_HUMAN_REVIEWER.id,
        requestDigest: digest,
      }),
      taskId: task.taskId,
      taskVersion: task.version,
      taskRef: task.taskArtifactRef,
      reviewer: LOCAL_HUMAN_REVIEWER,
      decidedAt: this.now(),
      issueDecisions: normalized.issueDecisions,
      globalComment: normalized.globalComment,
      selectedAction: normalized.selectedAction,
      downgradeInstruction: normalized.downgradeInstruction,
      policyEvaluation: normalized.policyEvaluation,
      requestDigest: digest,
      previousDecisionRef: null,
    });
    let replayed = false;
    try {
      task = located.store.recordDecision(task.taskId, decision);
    } catch (error) {
      const accepted = located.store.get(task.taskId);
      if (
        error?.code !== 'HUMAN_REVIEW_DECISION_CONFLICT'
        || accepted?.decision?.decisionId !== decision.decisionId
        || accepted.decision.requestDigest !== decision.requestDigest
      ) throw error;
      task = accepted;
      replayed = true;
    }
    return {
      task: safeHumanReviewTaskProjection(task),
      preview: this.#previewAccepted(located.projectId, task, normalized),
      replayed,
    };
  }

  resume(taskId, input) {
    exactFields(input, RESUME_FIELDS, 'Human Review resume');
    if (!Number.isInteger(input.taskVersion) || input.taskVersion < 1) {
      fail('taskVersion must be a positive integer', 'INVALID_HUMAN_REVIEW_REQUEST');
    }
    assertSafeId(input.decisionId, 'decisionId');
    const located = this.#locate(taskId);
    this.#reconcileProject(located.projectId);
    let task = located.store.get(taskId);
    if (!task?.decision || task.decision.decisionId !== input.decisionId) {
      fail('accepted Human Review decision is required', 'HUMAN_REVIEW_DECISION_REQUIRED', 409);
    }
    const runStore = this.projectSpace.runStore(located.projectId);
    let run = runStore.load(task.runId);
    if (!run) fail(`run not found: ${task.runId}`, 'RUN_NOT_FOUND', 404);
    const priorTransition = (run.humanReviewHistory || [])
      .find((entry) => entry.decisionId === task.decision.decisionId);
    if (priorTransition) {
      if (priorTransition.taskVersion !== input.taskVersion) {
        fail('Human Review resume task version is stale', 'HUMAN_REVIEW_TASK_STALE', 409);
      }
      task = this.#reconcileAcceptedTransition(located.projectId, task, run, priorTransition);
      if (priorTransition.kind === 'terminate' || run.status !== RUN_STATUSES.RUNNING) {
        return {
          task: safeHumanReviewTaskProjection(task),
          analysis: this.analysisService?.status?.(located.projectId) || {
            projectId: located.projectId,
            runId: run.runId,
            runStatus: run.status,
          },
          replayed: true,
        };
      }
      const analysis = this.#enqueueReviewed(located.projectId, run, priorTransition);
      return {
        task: safeHumanReviewTaskProjection(located.store.get(taskId)),
        analysis,
        replayed: true,
      };
    }

    if (task.status !== 'decided' || task.version !== input.taskVersion) {
      fail('Human Review resume task version is stale', 'HUMAN_REVIEW_TASK_STALE', 409);
    }
    const source = sourceTaskForDecision(this.projectSpace, located.projectId, task);
    const normalized = normalizeHumanReviewDecisionRequest(
      withTaskRef(source, task.decision.taskRef),
      decisionRequest(task.decision),
    );
    this.#assertBlockedTask(task, run);

    if (normalized.selectedAction === 'terminate') {
      run = runStore.terminateFromHumanReview(run.runId, {
        expectedBlockedStateDigest: task.blockedStateDigest,
        taskId: task.taskId,
        taskVersion: task.version,
        decisionId: task.decision.decisionId,
        decisionRef: task.decisionArtifactRef,
        decisionDigest: task.decision.contentDigest,
        selectedAction: normalized.selectedAction,
      });
      this.projectSpace.updateMeta(located.projectId, {
        status: 'cancelled',
        lastError: null,
        openIssues: [],
      });
      task = located.store.markOutcome(task.taskId, {
        status: 'terminated',
        resultingRunStatus: run.status,
        completedAt: run.completedAt,
      });
      return {
        task: safeHumanReviewTaskProjection(task),
        analysis: this.analysisService?.status?.(located.projectId) || {
          projectId: located.projectId,
          runId: run.runId,
          runStatus: run.status,
        },
        replayed: false,
      };
    }

    if (!this.analysisService || typeof this.analysisService.resumeReviewed !== 'function') {
      fail('reviewed analysis resume service is unavailable', 'HUMAN_REVIEW_RESUME_UNAVAILABLE', 503);
    }
    const transition = transitionPreview(run, normalized.routeNodeIds);
    const checkpoint = this.#checkpointForRun(located.projectId, run.runId);
    const humanReviewAttempt = (run.humanReviewAttempt || 0) + 1;
    const reviewRound = nextReviewRound(source, run);
    run = runStore.resumeFromHumanReview(run.runId, {
      expectedBlockedStateDigest: task.blockedStateDigest,
      taskId: task.taskId,
      taskVersion: task.version,
      decisionId: task.decision.decisionId,
      decisionRef: task.decisionArtifactRef,
      decisionDigest: task.decision.contentDigest,
      selectedAction: normalized.selectedAction,
      downgradeInstruction: normalized.downgradeInstruction,
      humanReviewAttempt,
      reviewRound,
      owners: normalized.owners,
      rerunNodeIds: transition.rerunNodeIds,
      reopenNodeIds: transition.reopenNodeIds,
      openIssues: normalized.routeIssues,
    });
    const history = run.humanReviewHistory.find(
      (entry) => entry.decisionId === task.decision.decisionId,
    );
    applyHumanReviewEntryToCheckpoint(checkpoint, history);
    this.projectSpace.setCheckpoint(located.projectId, checkpoint);
    task = located.store.markResuming(task.taskId, {
      decisionId: task.decision.decisionId,
      humanReviewAttempt,
      reviewRound,
      owners: normalized.owners,
      rerunNodeIds: transition.rerunNodeIds,
      reopenNodeIds: transition.reopenNodeIds,
      resumedAt: history.resumedAt,
    });
    const analysis = this.#enqueueReviewed(located.projectId, run, history);
    return {
      task: safeHumanReviewTaskProjection(task),
      analysis,
      replayed: false,
    };
  }

  assertProjectMutationAllowed(projectId, operation = 'project mutation') {
    return assertRunAnalysisReviewMutationAllowed(projectId, {
      projectSpace: this.projectSpace,
      operation,
    });
  }

  #locate(taskId) {
    assertSafeId(taskId, 'taskId');
    let match = null;
    for (const project of this.projectSpace.list()) {
      const store = this.projectSpace.humanReviewStore(project.id);
      const task = store.get(taskId);
      if (!task) continue;
      if (match) {
        fail('Human Review task identity is ambiguous', 'HUMAN_REVIEW_TASK_AMBIGUOUS', 409);
      }
      match = { projectId: project.id, store, task };
    }
    if (match) return match;
    fail(`Human Review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);
  }

  #assertBlockedTask(task, suppliedRun = null) {
    const run = suppliedRun || this.projectSpace.runStore(task.projectId).load(task.runId);
    if (
      !run
      || run.status !== RUN_STATUSES.BLOCKED
      || run.stopReason !== 'human-review'
      || run.blockedStateDigest !== task.blockedStateDigest
      || run.reviewBlockCount !== task.reviewBlockCount
    ) {
      fail('Human Review task no longer matches the blocked run', 'HUMAN_REVIEW_TASK_STALE', 409);
    }
    return run;
  }

  #previewAccepted(projectId, task, normalized) {
    const run = this.projectSpace.runStore(projectId).load(task.runId);
    if (!run || run.status !== RUN_STATUSES.BLOCKED) {
      return {
        selectedAction: normalized.selectedAction,
        owners: [...normalized.owners],
        routeNodeIds: [...normalized.routeNodeIds],
        rerunNodeIds: [],
        reopenNodeIds: [],
        affectedNodeIds: [],
        preservedNodeIds: [],
        stale: true,
      };
    }
    const transition = normalized.selectedAction === 'terminate'
      ? {
          rerunNodeIds: [],
          reopenNodeIds: [],
          affectedNodeIds: [],
          preservedNodeIds: topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC),
        }
      : transitionPreview(run, normalized.routeNodeIds);
    return {
      selectedAction: normalized.selectedAction,
      owners: [...normalized.owners],
      routeNodeIds: [...normalized.routeNodeIds],
      ...transition,
      preservedSuccessfulNodeIds: transition.preservedNodeIds.filter(
        (nodeId) => run.nodes?.[nodeId]?.status === NODE_STATES.SUCCEEDED,
      ),
      issueRoutes: normalized.routeIssues.map((issue) => ({
        issueId: issue.id,
        owner: issue.owner,
        disposition: issue.humanDisposition,
      })),
      humanReviewAttempt: normalized.selectedAction === 'terminate'
        ? null
        : (run.humanReviewAttempt || 0) + 1,
      reviewRound: normalized.selectedAction === 'terminate'
        ? null
        : nextReviewRound(task, run),
      normalReviewRequired: normalized.selectedAction !== 'terminate',
      publishesDirectly: false,
      stale: false,
    };
  }

  #checkpointForRun(projectId, runId) {
    const checkpoint = this.projectSpace.checkpoint(projectId);
    if (!checkpoint || checkpoint.artifactRunId !== runId) {
      fail('blocked run checkpoint identity is unavailable', 'HUMAN_REVIEW_CHECKPOINT_MISSING', 409);
    }
    return checkpoint;
  }

  #enqueueReviewed(projectId, run, history) {
    return this.analysisService.resumeReviewed(projectId, {
      runId: run.runId,
      decisionId: history.decisionId,
      humanReviewAttempt: history.humanReviewAttempt,
      reviewRound: history.reviewRound,
    });
  }

  #reconcileAcceptedTransition(projectId, task, run, history) {
    const store = this.projectSpace.humanReviewStore(projectId);
    let current = task;
    if (history.kind === 'terminate') {
      if (current.status !== 'terminated') {
        current = store.markOutcome(current.taskId, {
          status: 'terminated',
          resultingRunStatus: run.status,
          completedAt: history.terminatedAt,
        });
      }
      return current;
    }
    if (history.kind !== 'resume') {
      fail('Human Review durable transition is invalid', 'HUMAN_REVIEW_TRANSITION_CONFLICT', 409);
    }
    const checkpoint = this.#checkpointForRun(projectId, run.runId);
    applyHumanReviewEntryToCheckpoint(checkpoint, history);
    this.projectSpace.setCheckpoint(projectId, checkpoint);
    if (current.status === 'decided') {
      current = store.markResuming(current.taskId, {
        decisionId: history.decisionId,
        humanReviewAttempt: history.humanReviewAttempt,
        reviewRound: history.reviewRound,
        owners: history.owners,
        rerunNodeIds: history.rerunNodeIds,
        reopenNodeIds: history.reopenNodeIds,
        resumedAt: history.resumedAt,
      });
    }
    return current;
  }

  #reconcileProject(projectId) {
    const store = this.projectSpace.humanReviewStore(projectId);
    let run = latestRun(this.projectSpace, projectId);
    if (run?.status === RUN_STATUSES.BLOCKED && run.stopReason === 'human-review') {
      ensureRunAnalysisHumanReviewTask(projectId, {
        runId: run.runId,
        projectSpace: this.projectSpace,
      });
    }
    for (const snapshot of store.list()) {
      if (TERMINAL_TASK_STATUSES.has(snapshot.status) || !snapshot.decision) continue;
      run = this.projectSpace.runStore(projectId).load(snapshot.runId);
      if (!run) continue;
      const history = (run.humanReviewHistory || [])
        .find((entry) => entry.decisionId === snapshot.decision.decisionId);
      let current = snapshot;
      if (history && snapshot.status === 'decided') {
        current = this.#reconcileAcceptedTransition(projectId, snapshot, run, history);
      }
      if (current.status !== 'resuming') continue;
      if (
        run.status === RUN_STATUSES.SUCCEEDED
        && verifiedRunAnalysisReportPackage(projectId, run, {
          projectSpace: this.projectSpace,
        })
      ) {
        store.markOutcome(current.taskId, {
          status: 'resolved',
          resultingRunStatus: run.status,
          completedAt: run.completedAt,
        });
      } else if (
        run.status === RUN_STATUSES.FAILED
        || (
          run.status === RUN_STATUSES.CANCELLED
          && run.stopReason !== 'human-review-terminated'
        )
      ) {
        store.markOutcome(current.taskId, {
          status: 'resume-failed',
          resultingRunStatus: run.status,
          completedAt: run.completedAt,
        });
      }
    }
    run = latestRun(this.projectSpace, projectId);
    if (run?.status === RUN_STATUSES.BLOCKED && run.stopReason === 'human-review') {
      ensureRunAnalysisHumanReviewTask(projectId, {
        runId: run.runId,
        projectSpace: this.projectSpace,
      });
    }
  }
}
