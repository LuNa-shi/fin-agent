import fs from 'node:fs';
import path from 'node:path';

import { PROJECTS_DIR } from '../config.js';
import {
  HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
  HUMAN_REVIEW_TASK_SCHEMA_VERSION,
  createHumanReviewDecision,
  createHumanReviewTask,
} from '../core/contracts/HumanReview.js';
import {
  canonicalSha256,
  canonicalStringify,
  createArtifactRef,
  deepFreeze,
  validateArtifactRef,
} from '../core/contracts/ArtifactRef.js';
import { atomicWriteFileSync, withFileLockSync } from '../lib/fileLock.js';
import {
  assertOwnedStorageFile,
  assertStorageLockBoundary,
  ensureOwnedStorageDirectory,
  resolveDirectStorageDirectory,
} from '../lib/storageBoundary.js';
import { FileArtifactStore } from './ArtifactStore.js';
import { DURABLE_EVENT_TYPES, FileEventBus, durableEventId } from './EventBus.js';

export const HUMAN_REVIEW_STORE_SCHEMA_VERSION = 'human-review-store.v1';
export const HUMAN_REVIEW_STORE_SCOPE = 'cross-process-single-writer';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const TASK_TERMINAL_STATUSES = new Set(['resolved', 'resume-failed', 'terminated', 'superseded']);

export class HumanReviewStoreError extends Error {
  constructor(message, code = 'HUMAN_REVIEW_STORE_ERROR', statusCode = 400) {
    super(message);
    this.name = 'HumanReviewStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, code = 'HUMAN_REVIEW_STORE_ERROR', statusCode = 400) {
  throw new HumanReviewStoreError(message, code, statusCode);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail(`${label} is unsafe`, 'UNSAFE_HUMAN_REVIEW_ID');
  }
  return value;
}

function assertIso(value, label) {
  if (
    typeof value !== 'string'
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) fail(`${label} must be an ISO timestamp`, 'INVALID_HUMAN_REVIEW_STATE');
  return value;
}

function assertRef(value, label) {
  const validation = validateArtifactRef(value);
  if (!validation.valid) fail(`${label} must be a valid ArtifactRef`, 'INVALID_HUMAN_REVIEW_STATE');
  return createArtifactRef(value);
}

function clone(value) {
  return structuredClone(value);
}

function emptyLedger(projectId) {
  return {
    schemaVersion: HUMAN_REVIEW_STORE_SCHEMA_VERSION,
    storeScope: HUMAN_REVIEW_STORE_SCOPE,
    projectId,
    tasks: {},
    pending: null,
  };
}

function taskProjection(entry) {
  if (!entry) return null;
  return deepFreeze({
    ...clone(entry.task),
    taskArtifactRef: createArtifactRef(entry.taskRef),
    decision: entry.decision ? clone(entry.decision) : null,
    decisionArtifactRef: entry.decisionRef ? createArtifactRef(entry.decisionRef) : null,
    resume: entry.resume ? clone(entry.resume) : null,
    outcome: entry.outcome ? clone(entry.outcome) : null,
  });
}

function operationId(kind, identity) {
  return `hrop_${canonicalSha256({ kind, identity }).slice('sha256:'.length)}`;
}

export class FileHumanReviewStore {
  static scope = HUMAN_REVIEW_STORE_SCOPE;

  constructor({
    projectId,
    projectsDir = PROJECTS_DIR,
    storageDir = null,
    artifactStore = null,
    eventBus = null,
    now = () => new Date().toISOString(),
  } = {}) {
    assertSafeId(projectId, 'projectId');
    if (typeof now !== 'function') throw new TypeError('HumanReviewStore now must be a function');
    this.projectId = projectId;
    this.projectsDir = path.resolve(projectsDir);
    this.directStorageDir = storageDir !== null;
    this.storageDir = this.directStorageDir
      ? resolveDirectStorageDirectory(storageDir, 'HumanReviewStore storageDir')
      : path.join(this.projectsDir, projectId);
    this.rootDir = path.join(this.storageDir, '.human-review');
    this.ledgerPath = path.join(this.rootDir, 'ledger.json');
    this.lockPath = path.join(this.rootDir, '.locks', 'state.lock');
    this.now = now;
    this.eventBus = eventBus || new FileEventBus({
      projectId,
      projectsDir: this.projectsDir,
      ...(this.directStorageDir ? { storageDir: this.storageDir } : {}),
      now,
    });
    this.artifactStore = artifactStore || new FileArtifactStore({
      projectId,
      projectsDir: this.projectsDir,
      ...(this.directStorageDir ? { storageDir: this.storageDir } : {}),
      eventBus: this.eventBus,
    });
  }

  createTask(input) {
    const task = createHumanReviewTask(input);
    if (task.projectId !== this.projectId) {
      fail('task projectId does not match store', 'HUMAN_REVIEW_PROJECT_CONFLICT', 409);
    }
    return this.#withLedger((ledger) => {
      const existing = ledger.tasks[task.taskId];
      if (existing) {
        if (existing.task.contentDigest !== task.contentDigest) {
          fail(`task identity conflict: ${task.taskId}`, 'HUMAN_REVIEW_TASK_CONFLICT', 409);
        }
        return taskProjection(existing);
      }
      if (ledger.pending) this.#reconcilePending(ledger);
      ledger.pending = {
        schemaVersion: 'human-review-operation.v1',
        operationId: operationId('create-task', {
          taskId: task.taskId,
          taskVersion: task.version,
          contentDigest: task.contentDigest,
        }),
        kind: 'create-task',
        task,
        taskRef: null,
        eventPublished: false,
      };
      this.#writeLedger(ledger);
      this.#reconcilePending(ledger);
      return taskProjection(ledger.tasks[task.taskId]);
    });
  }

  get(taskId) {
    assertSafeId(taskId, 'taskId');
    return this.#withLedger((ledger) => taskProjection(ledger.tasks[taskId] || null));
  }

  list() {
    return this.#withLedger((ledger) => Object.values(ledger.tasks)
      .sort((left, right) => Date.parse(left.task.createdAt) - Date.parse(right.task.createdAt))
      .map(taskProjection));
  }

  open() {
    return this.#withLedger((ledger) => {
      const entry = Object.values(ledger.tasks)
        .filter((candidate) => !TASK_TERMINAL_STATUSES.has(candidate.task.status))
        .sort((left, right) => (
          Date.parse(right.task.createdAt) - Date.parse(left.task.createdAt)
          || right.task.reviewBlockCount - left.task.reviewBlockCount
        ))[0] || null;
      return taskProjection(entry);
    });
  }

  recordDecision(taskId, input) {
    assertSafeId(taskId, 'taskId');
    const decision = createHumanReviewDecision(input);
    if (decision.taskId !== taskId) {
      fail('decision taskId mismatch', 'HUMAN_REVIEW_TASK_CONFLICT', 409);
    }
    return this.#withLedger((ledger) => {
      const entry = ledger.tasks[taskId];
      if (!entry) fail(`human review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);
      if (entry.decision) {
        if (
          entry.decision.decisionId === decision.decisionId
          && entry.decision.requestDigest === decision.requestDigest
          && entry.decision.contentDigest === decision.contentDigest
        ) return taskProjection(entry);
        fail(`human review task already has a different decision: ${taskId}`, 'HUMAN_REVIEW_DECISION_CONFLICT', 409);
      }
      if (entry.task.status !== 'open') {
        fail(`human review task is stale: ${taskId}`, 'HUMAN_REVIEW_TASK_STALE', 409);
      }
      if (
        decision.taskVersion !== entry.task.version
        || canonicalSha256(decision.taskRef) !== canonicalSha256(entry.taskRef)
      ) fail(`human review task version is stale: ${taskId}`, 'HUMAN_REVIEW_TASK_STALE', 409);
      ledger.pending = {
        schemaVersion: 'human-review-operation.v1',
        operationId: operationId('record-decision', {
          taskId,
          decisionId: decision.decisionId,
          contentDigest: decision.contentDigest,
        }),
        kind: 'record-decision',
        taskId,
        decision,
        decisionRef: null,
        nextTask: null,
        nextTaskRef: null,
        eventPublished: false,
      };
      this.#writeLedger(ledger);
      this.#reconcilePending(ledger);
      return taskProjection(ledger.tasks[taskId]);
    });
  }

  markResuming(taskId, {
    decisionId,
    humanReviewAttempt,
    reviewRound,
    owners,
    rerunNodeIds,
    reopenNodeIds,
    resumedAt = this.now(),
  }) {
    assertSafeId(taskId, 'taskId');
    assertSafeId(decisionId, 'decisionId');
    assertIso(resumedAt, 'resumedAt');
    if (!Number.isInteger(humanReviewAttempt) || humanReviewAttempt < 1) {
      fail('humanReviewAttempt must be a positive integer');
    }
    if (!Number.isInteger(reviewRound) || reviewRound < 1) fail('reviewRound must be a positive integer');
    for (const [label, values] of Object.entries({ owners, rerunNodeIds, reopenNodeIds })) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
        fail(`${label} must be a string array`);
      }
    }
    return this.#withLedger((ledger) => {
      const entry = ledger.tasks[taskId];
      if (!entry) fail(`human review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);
      if (!entry.decision || entry.decision.decisionId !== decisionId) {
        fail('accepted decision is required before resume', 'HUMAN_REVIEW_DECISION_REQUIRED', 409);
      }
      const resume = {
        decisionId,
        humanReviewAttempt,
        reviewRound,
        owners: [...owners],
        rerunNodeIds: [...rerunNodeIds],
        reopenNodeIds: [...reopenNodeIds],
        resumedAt,
      };
      if (entry.resume) {
        if (canonicalSha256(entry.resume) === canonicalSha256(resume)) return taskProjection(entry);
        fail('human review resume conflicts with the accepted transition', 'HUMAN_REVIEW_RESUME_CONFLICT', 409);
      }
      if (entry.task.status !== 'decided') {
        fail(`human review task cannot resume from ${entry.task.status}`, 'HUMAN_REVIEW_TASK_STALE', 409);
      }
      ledger.pending = {
        schemaVersion: 'human-review-operation.v1',
        operationId: operationId('resume-task', { taskId, ...resume }),
        kind: 'resume-task',
        taskId,
        resume,
        nextTask: null,
        nextTaskRef: null,
        eventPublished: false,
      };
      this.#writeLedger(ledger);
      this.#reconcilePending(ledger);
      return taskProjection(ledger.tasks[taskId]);
    });
  }

  markOutcome(taskId, {
    status,
    resultingRunStatus,
    completedAt = this.now(),
  }) {
    assertSafeId(taskId, 'taskId');
    if (!TASK_TERMINAL_STATUSES.has(status)) fail(`invalid terminal task status: ${status}`);
    if (typeof resultingRunStatus !== 'string' || !resultingRunStatus) {
      fail('resultingRunStatus is required');
    }
    assertIso(completedAt, 'completedAt');
    return this.#withLedger((ledger) => {
      const entry = ledger.tasks[taskId];
      if (!entry) fail(`human review task not found: ${taskId}`, 'HUMAN_REVIEW_TASK_NOT_FOUND', 404);
      const outcome = { status, resultingRunStatus, completedAt };
      if (entry.outcome) {
        if (canonicalSha256(entry.outcome) === canonicalSha256(outcome)) return taskProjection(entry);
        fail('human review outcome conflicts with existing outcome', 'HUMAN_REVIEW_OUTCOME_CONFLICT', 409);
      }
      if (!entry.decision) fail('accepted decision is required before task outcome', 'HUMAN_REVIEW_DECISION_REQUIRED', 409);
      ledger.pending = {
        schemaVersion: 'human-review-operation.v1',
        operationId: operationId('task-outcome', { taskId, ...outcome }),
        kind: 'task-outcome',
        taskId,
        outcome,
        nextTask: null,
        nextTaskRef: null,
        eventPublished: false,
      };
      this.#writeLedger(ledger);
      this.#reconcilePending(ledger);
      return taskProjection(ledger.tasks[taskId]);
    });
  }

  #withLedger(callback) {
    if (typeof callback !== 'function') throw new TypeError('HumanReviewStore callback is required');
    this.#ensureStorageTree({ create: true });
    return withFileLockSync(this.lockPath, () => {
      const ledger = this.#loadLedger();
      if (ledger.pending) this.#reconcilePending(ledger);
      return callback(ledger);
    });
  }

  #reconcilePending(ledger) {
    const operation = ledger.pending;
    if (!operation) return;
    if (operation.kind === 'create-task') {
      if (!operation.taskRef) {
        operation.taskRef = this.#commitTask(operation.task, []);
        this.#writeLedger(ledger);
      } else {
        this.artifactStore.reconcileCommittedEvent(operation.taskRef);
      }
      if (!operation.eventPublished) {
        this.#publishTaskCreated(operation.task, operation.taskRef);
        operation.eventPublished = true;
        this.#writeLedger(ledger);
      }
      ledger.tasks[operation.task.taskId] = {
        task: operation.task,
        taskRef: operation.taskRef,
        decision: null,
        decisionRef: null,
        resume: null,
        outcome: null,
      };
      ledger.pending = null;
      this.#writeLedger(ledger);
      return;
    }

    const entry = ledger.tasks[operation.taskId];
    if (!entry) fail('pending operation references a missing task', 'CORRUPT_HUMAN_REVIEW_STORE');
    if (operation.kind === 'record-decision') {
      if (!operation.decisionRef) {
        operation.decisionRef = this.#commitDecision(operation.decision, entry.taskRef);
        this.#writeLedger(ledger);
      } else {
        this.artifactStore.reconcileCommittedEvent(operation.decisionRef);
      }
      if (!operation.nextTask) {
        operation.nextTask = createHumanReviewTask({
          ...entry.task,
          version: entry.task.version + 1,
          status: 'decided',
          updatedAt: operation.decision.decidedAt,
          previousTaskRef: entry.taskRef,
          producingDecisionRef: operation.decisionRef,
          contentDigest: undefined,
        });
        this.#writeLedger(ledger);
      }
      if (!operation.nextTaskRef) {
        operation.nextTaskRef = this.#commitTask(operation.nextTask, [
          entry.taskRef,
          operation.decisionRef,
        ]);
        this.#writeLedger(ledger);
      } else {
        this.artifactStore.reconcileCommittedEvent(operation.nextTaskRef);
      }
      if (!operation.eventPublished) {
        this.#publishDecisionRecorded(operation.decision, operation.decisionRef);
        operation.eventPublished = true;
        this.#writeLedger(ledger);
      }
      Object.assign(entry, {
        task: operation.nextTask,
        taskRef: operation.nextTaskRef,
        decision: operation.decision,
        decisionRef: operation.decisionRef,
      });
      ledger.pending = null;
      this.#writeLedger(ledger);
      return;
    }

    if (operation.kind === 'resume-task') {
      if (!operation.nextTask) {
        operation.nextTask = createHumanReviewTask({
          ...entry.task,
          version: entry.task.version + 1,
          status: 'resuming',
          updatedAt: operation.resume.resumedAt,
          previousTaskRef: entry.taskRef,
          producingDecisionRef: entry.decisionRef,
          contentDigest: undefined,
        });
        this.#writeLedger(ledger);
      }
      if (!operation.nextTaskRef) {
        operation.nextTaskRef = this.#commitTask(operation.nextTask, [
          entry.taskRef,
          entry.decisionRef,
        ]);
        this.#writeLedger(ledger);
      } else {
        this.artifactStore.reconcileCommittedEvent(operation.nextTaskRef);
      }
      if (!operation.eventPublished) {
        this.#publishResumeStarted(entry, operation.resume);
        operation.eventPublished = true;
        this.#writeLedger(ledger);
      }
      Object.assign(entry, {
        task: operation.nextTask,
        taskRef: operation.nextTaskRef,
        resume: operation.resume,
      });
      ledger.pending = null;
      this.#writeLedger(ledger);
      return;
    }

    if (operation.kind === 'task-outcome') {
      if (!operation.nextTask) {
        operation.nextTask = createHumanReviewTask({
          ...entry.task,
          version: entry.task.version + 1,
          status: operation.outcome.status,
          updatedAt: operation.outcome.completedAt,
          previousTaskRef: entry.taskRef,
          producingDecisionRef: entry.decisionRef,
          contentDigest: undefined,
        });
        this.#writeLedger(ledger);
      }
      if (!operation.nextTaskRef) {
        operation.nextTaskRef = this.#commitTask(operation.nextTask, [
          entry.taskRef,
          entry.decisionRef,
        ]);
        this.#writeLedger(ledger);
      } else {
        this.artifactStore.reconcileCommittedEvent(operation.nextTaskRef);
      }
      if (!operation.eventPublished) {
        this.#publishOutcome(entry, operation.outcome);
        operation.eventPublished = true;
        this.#writeLedger(ledger);
      }
      Object.assign(entry, {
        task: operation.nextTask,
        taskRef: operation.nextTaskRef,
        outcome: operation.outcome,
      });
      ledger.pending = null;
      this.#writeLedger(ledger);
      return;
    }
    fail(`unknown pending Human Review operation: ${operation.kind}`, 'CORRUPT_HUMAN_REVIEW_STORE');
  }

  #commitTask(task, inputArtifactRefs) {
    const inputDigest = canonicalSha256({
      blockedStateDigest: task.blockedStateDigest,
      issuesDigest: task.issuesDigest,
      policyDigest: task.policy.digest,
      previousTaskRef: task.previousTaskRef,
      producingDecisionRef: task.producingDecisionRef,
      inputArtifactRefs,
    });
    return this.artifactStore.commit({
      artifactId: `${this.projectId}:human-review-task:${task.taskId}`,
      path: `analysis/human-reviews/${task.taskId}/task.v${task.version}.json`,
      content: task,
      runId: task.runId,
      nodeId: 'human-review',
      idempotencyKey: `${task.taskId}:task:v${task.version}:${task.contentDigest}`,
      schemaVersion: HUMAN_REVIEW_TASK_SCHEMA_VERSION,
      producer: 'human-review-controller',
      contractVersion: '1.0.0',
      inputDigest,
      asOf: task.updatedAt,
      inputArtifactRefs,
    });
  }

  #commitDecision(decision, taskRef) {
    return this.artifactStore.commit({
      artifactId: `${this.projectId}:human-review-decision:${decision.decisionId}`,
      path: `analysis/human-reviews/${decision.taskId}/decision.${decision.decisionId}.json`,
      content: decision,
      runId: this.#taskRunId(decision.taskId),
      nodeId: 'human-review',
      idempotencyKey: `${decision.decisionId}:${decision.contentDigest}`,
      schemaVersion: HUMAN_REVIEW_DECISION_SCHEMA_VERSION,
      producer: 'human-review-controller',
      contractVersion: '1.0.0',
      inputDigest: decision.requestDigest,
      asOf: decision.decidedAt,
      inputArtifactRefs: [taskRef],
    });
  }

  #taskRunId(taskId) {
    const ledger = this.#loadLedger();
    return ledger.tasks[taskId]?.task?.runId
      || ledger.pending?.task?.runId
      || fail(`run identity is missing for task: ${taskId}`, 'CORRUPT_HUMAN_REVIEW_STORE');
  }

  #publishTaskCreated(task, taskRef) {
    const eventType = DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_CREATED;
    const eventId = durableEventId(eventType, {
      projectId: this.projectId,
      runId: task.runId,
      taskId: task.taskId,
      taskVersion: task.version,
      contentDigest: task.contentDigest,
    });
    const causation = this.eventBus.latest({
      runId: task.runId,
      eventTypes: [DURABLE_EVENT_TYPES.RUN_BLOCKED],
    });
    this.eventBus.publish({
      eventId,
      eventType,
      correlationId: task.runId,
      causationId: causation?.eventId || null,
      runId: task.runId,
      nodeId: null,
      payload: {
        status: 'open',
        taskId: task.taskId,
        taskVersion: task.version,
        taskRef,
        issuesDigest: task.issuesDigest,
        blockedStateDigest: task.blockedStateDigest,
        reviewBlockCount: task.reviewBlockCount,
        policyDigest: task.policy.digest,
      },
    });
  }

  #publishDecisionRecorded(decision, decisionRef) {
    const eventType = DURABLE_EVENT_TYPES.HUMAN_REVIEW_DECISION_RECORDED;
    const eventId = durableEventId(eventType, {
      projectId: this.projectId,
      taskId: decision.taskId,
      decisionId: decision.decisionId,
      contentDigest: decision.contentDigest,
    });
    const runId = this.#taskRunId(decision.taskId);
    const causation = this.eventBus.latest({
      runId,
      eventTypes: [DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_CREATED],
    });
    this.eventBus.publish({
      eventId,
      eventType,
      correlationId: runId,
      causationId: causation?.eventId || null,
      runId,
      nodeId: null,
      payload: {
        status: 'decided',
        taskId: decision.taskId,
        taskVersion: decision.taskVersion,
        decisionId: decision.decisionId,
        decisionRef,
        requestDigest: decision.requestDigest,
        decisionDigest: decision.contentDigest,
        reviewerId: decision.reviewer.id,
        selectedAction: decision.selectedAction,
        policyAllowed: decision.policyEvaluation.allowed,
      },
    });
  }

  #publishResumeStarted(entry, resume) {
    const eventType = DURABLE_EVENT_TYPES.HUMAN_REVIEW_RESUME_STARTED;
    const eventId = durableEventId(eventType, {
      projectId: this.projectId,
      taskId: entry.task.taskId,
      decisionId: entry.decision.decisionId,
      humanReviewAttempt: resume.humanReviewAttempt,
    });
    const causation = this.eventBus.latest({
      runId: entry.task.runId,
      eventTypes: [DURABLE_EVENT_TYPES.HUMAN_REVIEW_DECISION_RECORDED],
    });
    this.eventBus.publish({
      eventId,
      eventType,
      correlationId: entry.task.runId,
      causationId: causation?.eventId || null,
      runId: entry.task.runId,
      nodeId: null,
      payload: {
        status: 'resuming',
        taskId: entry.task.taskId,
        decisionId: entry.decision.decisionId,
        decisionRef: entry.decisionRef,
        humanReviewAttempt: resume.humanReviewAttempt,
        reviewRound: resume.reviewRound,
        owners: [...resume.owners],
        rerunNodeIds: [...resume.rerunNodeIds],
        reopenNodeIds: [...resume.reopenNodeIds],
      },
    });
  }

  #publishOutcome(entry, outcome) {
    const terminated = outcome.status === 'terminated';
    const eventType = terminated
      ? DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_TERMINATED
      : DURABLE_EVENT_TYPES.HUMAN_REVIEW_TASK_RESOLVED;
    const eventId = durableEventId(eventType, {
      projectId: this.projectId,
      taskId: entry.task.taskId,
      decisionId: entry.decision.decisionId,
      status: outcome.status,
    });
    const causation = this.eventBus.latest({ runId: entry.task.runId });
    this.eventBus.publish({
      eventId,
      eventType,
      correlationId: entry.task.runId,
      causationId: causation?.eventId || null,
      runId: entry.task.runId,
      nodeId: null,
      payload: {
        status: outcome.status,
        taskId: entry.task.taskId,
        decisionId: entry.decision.decisionId,
        decisionRef: entry.decisionRef,
        resultingRunStatus: outcome.resultingRunStatus,
      },
    });
  }

  #loadLedger() {
    this.#ensureStorageTree({ create: false });
    if (!assertOwnedStorageFile(this.ledgerPath, 'HumanReviewStore ledger')) {
      return emptyLedger(this.projectId);
    }
    let ledger;
    try {
      ledger = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
    } catch {
      fail('Human Review ledger is unreadable', 'CORRUPT_HUMAN_REVIEW_STORE');
    }
    if (
      !ledger
      || ledger.schemaVersion !== HUMAN_REVIEW_STORE_SCHEMA_VERSION
      || ledger.storeScope !== HUMAN_REVIEW_STORE_SCOPE
      || ledger.projectId !== this.projectId
      || !ledger.tasks
      || typeof ledger.tasks !== 'object'
      || Array.isArray(ledger.tasks)
      || !Object.prototype.hasOwnProperty.call(ledger, 'pending')
    ) fail('Human Review ledger identity is invalid', 'CORRUPT_HUMAN_REVIEW_STORE');
    for (const [taskId, entry] of Object.entries(ledger.tasks)) {
      if (taskId !== entry?.task?.taskId) fail('Human Review task identity is invalid', 'CORRUPT_HUMAN_REVIEW_STORE');
      createHumanReviewTask(entry.task);
      assertRef(entry.taskRef, `${taskId}.taskRef`);
      if (entry.decision !== null) {
        createHumanReviewDecision(entry.decision);
        assertRef(entry.decisionRef, `${taskId}.decisionRef`);
      } else if (entry.decisionRef !== null) {
        fail('Human Review decision ref has no decision', 'CORRUPT_HUMAN_REVIEW_STORE');
      }
      this.#assertStoredArtifact(entry.taskRef, entry.task, `${taskId}.task`);
      if (entry.decisionRef) this.#assertStoredArtifact(entry.decisionRef, entry.decision, `${taskId}.decision`);
    }
    return ledger;
  }

  #assertStoredArtifact(ref, content, label) {
    let stored;
    try {
      stored = JSON.parse(this.artifactStore.read(ref));
    } catch {
      fail(`${label} artifact is missing or invalid`, 'CORRUPT_HUMAN_REVIEW_STORE');
    }
    if (canonicalStringify(stored) !== canonicalStringify(content)) {
      fail(`${label} artifact conflicts with the ledger`, 'CORRUPT_HUMAN_REVIEW_STORE');
    }
  }

  #writeLedger(ledger) {
    this.#ensureStorageTree({ create: true });
    atomicWriteFileSync(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  #ensureStorageTree({ create }) {
    if (this.directStorageDir) {
      resolveDirectStorageDirectory(this.storageDir, 'HumanReviewStore storageDir');
    } else if (!ensureOwnedStorageDirectory(this.storageDir, 'HumanReviewStore storage directory', {
      create,
      recursive: true,
    })) {
      return false;
    }
    if (!ensureOwnedStorageDirectory(this.rootDir, 'HumanReviewStore hidden root', { create })) {
      return false;
    }
    ensureOwnedStorageDirectory(path.dirname(this.lockPath), 'HumanReviewStore lock root', { create });
    assertStorageLockBoundary(this.lockPath, 'HumanReviewStore state lock');
    return true;
  }
}
