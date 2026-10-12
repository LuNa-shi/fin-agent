import {
  ProjectSpace,
  verifiedRunAnalysisReportPackage,
} from '../../project-space/index.js';
import { RUN_STATUSES } from '../../project-space/RunStore.js';
import { runAnalysisWorkflow } from './runAnalysis.js';
import { reserveWorkflowRun } from './policies/runPolicy.js';
import { createVerifiedInternalReportPackage } from '../../domains/reports/RunAnalysisReportProducer.js';
import { ReportAdmissionService } from '../../domains/reports/ReportOverviewService.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  topologicalNodeOrder,
} from './workflowSpec.js';

const PROJECT_STATUSES = new Set([
  'created',
  'queued',
  'analyzing',
  'analyzed',
  'review-required',
  'failed',
  'cancelled',
  'paused',
]);
const RESUMABLE_RUN_STATUSES = new Set([
  RUN_STATUSES.RUNNING,
  RUN_STATUSES.FAILED,
  RUN_STATUSES.CANCELLED,
]);
const NODE_ORDER = topologicalNodeOrder(RUN_ANALYSIS_WORKFLOW_SPEC);
const REVIEWED_RESUME_FIELDS = new Set([
  'runId',
  'decisionId',
  'humanReviewAttempt',
  'reviewRound',
]);

function serviceError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export {
  verifiedRunAnalysisReportPackage as verifiedReportPackage,
};

function latestRecord(projectSpace, projectId) {
  return projectSpace.runStore(projectId).list().at(-1) || null;
}

function recordIsResumable(record) {
  return Boolean(
    record
    && RESUMABLE_RUN_STATUSES.has(record.status)
    && record.stopReason !== 'human-review-terminated'
  );
}

function currentNodeId(record) {
  if (!record) return null;
  const entries = NODE_ORDER.map((nodeId) => record.nodes?.[nodeId]).filter(Boolean);
  for (const status of ['RUNNING', 'READY']) {
    const node = entries.find((candidate) => candidate.status === status);
    if (node) return node.nodeId;
  }
  const terminal = entries.find((node) => (
    node.status.startsWith('FAILED')
    || node.status === 'BLOCKED'
    || node.status === 'CANCELLED'
  ));
  if (terminal) return terminal.nodeId;
  return [...entries].reverse().find((node) => node.status === 'SUCCEEDED')?.nodeId || null;
}

function projectStatusFor({
  job,
  meta,
  record,
  reportPackage,
  reviewEnabled = false,
  legacyResumable = false,
}) {
  if (record?.status === RUN_STATUSES.BLOCKED) return reviewEnabled ? 'review-required' : 'failed';
  if (record?.status === RUN_STATUSES.FAILED) return 'failed';
  if (record?.status === RUN_STATUSES.CANCELLED) {
    if (meta.status === 'paused' || record.stopReason === 'operator-paused') return 'paused';
    if (record.stopReason?.startsWith('service-')) return 'failed';
    return 'cancelled';
  }
  if (record?.status === RUN_STATUSES.SUCCEEDED) return reportPackage ? 'analyzed' : 'failed';
  if (job?.cancelMode === 'paused') return 'paused';
  if (job?.cancelMode) return 'cancelled';
  if (job?.state === 'queued') return 'queued';
  if (job?.state === 'running') return 'analyzing';
  if (!record) {
    if (['analyzed', 'interrupted'].includes(meta.status) || legacyResumable) return 'failed';
    return PROJECT_STATUSES.has(meta.status) ? meta.status : 'created';
  }
  if (meta.status === 'paused' || meta.status === 'cancelled') return meta.status;
  // A durable RUNNING record is only actively analyzing while this service owns
  // its in-memory job. After restart (including AUTO_RESUME=false), expose the
  // interruption truth and keep the durable record explicitly resumable.
  return 'failed';
}

function workflowIdentity(record) {
  return record?.workflowSpec || {
    id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
    version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
    hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  };
}

export class RunAnalysisService {
  constructor({
    projectSpace = ProjectSpace,
    runner = runAnalysisWorkflow,
    reserveRun = reserveWorkflowRun,
    humanReviewController = null,
    reportLibrary = null,
    reportLibraryIngest = null,
    maxConcurrent = Math.max(1, Number(process.env.MAX_ANALYSES) || 10),
    logger = console,
  } = {}) {
    if (!projectSpace || typeof projectSpace.meta !== 'function') {
      throw new TypeError('RunAnalysisService projectSpace is required');
    }
    if (typeof runner !== 'function') throw new TypeError('RunAnalysisService runner is required');
    if (typeof reserveRun !== 'function') throw new TypeError('RunAnalysisService reserveRun is required');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError('RunAnalysisService maxConcurrent must be a positive integer');
    }
    this.projectSpace = projectSpace;
    this.runner = runner;
    this.reserveRun = reserveRun;
    this.humanReviewController = humanReviewController;
    this.reportLibrary = reportLibrary;
    this.reportAdmissionService = !reportLibraryIngest && reportLibrary
      ? new ReportAdmissionService({ reportLibrary })
      : null;
    this.reportLibraryIngest = reportLibraryIngest
      || this.reportAdmissionService?.admit.bind(this.reportAdmissionService)
      || null;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
  }

  #appendEvent(projectId, event) {
    try {
      this.projectSpace.appendEvent?.(projectId, event);
    } catch {
      // Compatibility projection events must never change durable run truth.
    }
  }

  start(projectId, options = {}) {
    return this.#enqueue(projectId, options, { requireResume: false });
  }

  resume(projectId, options = {}) {
    return this.#enqueue(projectId, { ...options, resume: true }, { requireResume: true });
  }

  resumeReviewed(projectId, identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw serviceError('reviewed resume identity is required', 'INVALID_REVIEWED_RESUME');
    }
    const unknown = Object.keys(identity).filter((field) => !REVIEWED_RESUME_FIELDS.has(field));
    if (unknown.length) {
      throw serviceError(
        `reviewed resume contains forbidden fields: ${unknown.join(', ')}`,
        'INVALID_REVIEWED_RESUME',
      );
    }
    if (
      typeof identity.runId !== 'string'
      || typeof identity.decisionId !== 'string'
      || !Number.isInteger(identity.humanReviewAttempt)
      || identity.humanReviewAttempt < 1
      || !Number.isInteger(identity.reviewRound)
      || identity.reviewRound < 1
    ) {
      throw serviceError('reviewed resume identity is invalid', 'INVALID_REVIEWED_RESUME');
    }
    const meta = this.projectSpace.meta(projectId);
    if (!meta) throw serviceError(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    const record = this.projectSpace.runStore(projectId).load(identity.runId);
    const latest = latestRecord(this.projectSpace, projectId);
    const transition = (record?.humanReviewHistory || []).find((entry) => (
      entry.kind === 'resume'
      && entry.decisionId === identity.decisionId
      && entry.humanReviewAttempt === identity.humanReviewAttempt
      && entry.reviewRound === identity.reviewRound
    ));
    const checkpoint = this.projectSpace.checkpoint(projectId);
    if (
      !record
      || record.status !== RUN_STATUSES.RUNNING
      || latest?.runId !== record.runId
      || !transition
      || checkpoint?.artifactRunId !== record.runId
      || checkpoint?.activeRemediation?.kind !== 'human-review'
      || checkpoint.activeRemediation.decisionId !== identity.decisionId
      || checkpoint.activeRemediation.humanReviewAttempt !== identity.humanReviewAttempt
      || checkpoint.activeRemediation.reviewRound !== identity.reviewRound
    ) {
      throw serviceError(
        'reviewed resume is not backed by the current durable transition',
        'REVIEWED_RESUME_NOT_AUTHORIZED',
        409,
      );
    }
    const existing = this.jobs.get(projectId);
    if (existing) {
      if (existing.runId !== record.runId || existing.reviewDecisionId !== identity.decisionId) {
        throw serviceError(
          'a different analysis job is already active',
          'REVIEWED_RESUME_CONFLICT',
          409,
        );
      }
      return {
        ...this.status(projectId, { runId: existing.runId }),
        started: false,
        reason: 'already-running',
        resume: true,
        mode: existing.mode,
      };
    }
    this.projectSpace.updateMeta(projectId, {
      status: 'queued',
      lastError: null,
    });
    const job = {
      projectId,
      runId: record.runId,
      resume: true,
      mode: 'human-review-resume',
      reviewDecisionId: identity.decisionId,
      options: { resume: true, humanReviewEnabled: Boolean(this.humanReviewController) },
      state: 'queued',
      cancelMode: null,
      initialQueuePosition: this.running.size >= this.maxConcurrent ? this.queue.length + 1 : 0,
    };
    this.jobs.set(projectId, job);
    this.queue.push(job);
    this.#emitQueued(job);
    this.#pump();
    return {
      ...this.status(projectId, { runId: job.runId }),
      started: true,
      queuePosition: job.initialQueuePosition,
      resume: true,
      mode: job.mode,
    };
  }

  status(projectId, { runId = null } = {}) {
    const meta = this.projectSpace.meta(projectId);
    if (!meta) throw serviceError(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    const job = this.jobs.get(projectId) || null;
    const checkpoint = this.projectSpace.checkpoint(projectId);
    const currentRecord = job
      ? this.projectSpace.runStore(projectId).load(job.runId)
      : latestRecord(this.projectSpace, projectId);
    const selectedRecord = runId
      ? this.projectSpace.runStore(projectId).load(runId)
      : currentRecord;
    if (runId && !selectedRecord) throw serviceError(`run not found: ${runId}`, 'RUN_NOT_FOUND', 404);
    const reportPackage = verifiedRunAnalysisReportPackage(projectId, currentRecord, {
      projectSpace: this.projectSpace,
    });
    const selectedReportPackage = selectedRecord === currentRecord
      ? reportPackage
      : verifiedRunAnalysisReportPackage(projectId, selectedRecord, {
          projectSpace: this.projectSpace,
          requirePublishedMeta: false,
        });
    const legacyResumable = !currentRecord && Boolean(checkpoint && !checkpoint.done);
    const reviewTask = this.humanReviewController
      ? this.humanReviewController.open(projectId, { detail: false })
      : null;
    const reviewDetached = Boolean(
      reviewTask
      && (
        ['open', 'decided'].includes(reviewTask.status)
        || (
          reviewTask.status === 'resuming'
          && !job
        )
      )
    );
    const projectStatus = reviewDetached
      ? 'review-required'
      : projectStatusFor({
          job,
          meta,
          record: currentRecord,
          reportPackage,
          reviewEnabled: Boolean(this.humanReviewController),
          legacyResumable,
        });
    const queuePosition = job?.state === 'queued'
      ? this.queue.findIndex((candidate) => candidate.projectId === projectId) + 1
      : 0;
    const runStatus = selectedRecord?.status || null;
    return {
      id: projectId,
      projectId,
      runId: selectedRecord?.runId || null,
      currentRunId: currentRecord?.runId || null,
      workflow: workflowIdentity(selectedRecord),
      status: projectStatus,
      projectStatus,
      runStatus,
      currentNodeId: currentNodeId(selectedRecord),
      resumable: Boolean(
        !reviewTask
        && (recordIsResumable(selectedRecord) || legacyResumable)
      ),
      queuePosition: Math.max(0, queuePosition),
      reportReady: Boolean(reportPackage),
      reportPackage,
      run: selectedRecord ? {
        runId: selectedRecord.runId,
        status: selectedRecord.status,
        stopReason: selectedRecord.stopReason,
        currentNodeId: currentNodeId(selectedRecord),
        resumable: !reviewTask && recordIsResumable(selectedRecord),
        reportReady: Boolean(selectedReportPackage),
        reportPackage: selectedReportPackage,
      } : null,
      reviewTask,
    };
  }

  pause(projectId) {
    return this.#cancel(projectId, 'paused');
  }

  cancel(projectId, { reason = 'operator-cancelled' } = {}) {
    return this.#cancel(projectId, reason === 'paused' ? 'paused' : reason);
  }

  inFlightProjectIds() {
    return [...this.jobs.keys()];
  }

  recoverInterrupted() {
    const outcomes = [];
    for (const project of this.projectSpace.list()) {
      try {
        if (project.status === 'paused' || project.status === 'cancelled') continue;
        const record = latestRecord(this.projectSpace, project.id);
        const checkpoint = this.projectSpace.checkpoint(project.id);
        const reviewTask = this.humanReviewController
          ? this.humanReviewController.open(project.id, { detail: false })
          : null;
        if (reviewTask?.status === 'resuming' && record?.status === RUN_STATUSES.RUNNING) {
          const result = this.resumeReviewed(project.id, {
            runId: record.runId,
            decisionId: reviewTask.decision?.decisionId,
            humanReviewAttempt: reviewTask.resume?.humanReviewAttempt,
            reviewRound: reviewTask.resume?.reviewRound,
          });
          outcomes.push({
            projectId: project.id,
            runId: result.runId,
            recovered: result.started,
            result,
          });
          continue;
        }
        if (record?.status === RUN_STATUSES.BLOCKED || record?.status === RUN_STATUSES.SUCCEEDED) continue;
        if (['operator-cancelled', 'operator-paused'].includes(record?.stopReason)) continue;
        if (!recordIsResumable(record) && !(!record && checkpoint && !checkpoint.done)) continue;
        const result = this.resume(project.id);
        outcomes.push({
          projectId: project.id,
          runId: result.runId,
          recovered: result.started,
          result,
        });
      } catch (error) {
        outcomes.push({
          projectId: project.id,
          runId: null,
          recovered: false,
          error: {
            code: error?.code || 'RUN_RECOVERY_FAILED',
            message: String(error?.message || error).slice(0, 300),
          },
        });
        this.logger.error?.('[analysis-recovery]', project.id, error?.stack || error);
      }
    }
    return outcomes;
  }

  #enqueue(projectId, options, { requireResume }) {
    const meta = this.projectSpace.meta(projectId);
    if (!meta) throw serviceError(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    const existing = this.jobs.get(projectId);
    if (existing) {
      return {
        ...this.status(projectId, { runId: existing.runId }),
        started: false,
        reason: 'already-running',
        resume: existing.resume,
        mode: existing.mode,
      };
    }

    const prior = latestRecord(this.projectSpace, projectId);
    const reviewTask = this.humanReviewController?.open(projectId, { detail: false }) || null;
    if (reviewTask && ['open', 'decided', 'resuming'].includes(reviewTask.status)) {
      return {
        ...this.status(projectId, { runId: prior?.runId || null }),
        started: false,
        reason: 'review-required',
        resume: false,
        mode: 'blocked',
      };
    }
    if (prior?.status === RUN_STATUSES.BLOCKED && this.humanReviewController) {
      return {
        ...this.status(projectId, { runId: prior.runId }),
        started: false,
        reason: 'review-required',
        resume: false,
        mode: 'blocked',
      };
    }
    const checkpoint = this.projectSpace.checkpoint(projectId);
    const resumable = recordIsResumable(prior);
    const resume = options.resume !== false && Boolean(
      resumable
      || (!prior && checkpoint && !checkpoint.done)
    );
    if (requireResume && !resume) {
      throw serviceError(`project has no resumable analysis: ${projectId}`, 'RUN_NOT_RESUMABLE', 409);
    }
    const mode = resume ? 'resume' : 'fresh';
    const prepared = this.reserveRun(projectId, { ...options, resume });
    const job = {
      projectId,
      runId: prepared.record.runId,
      resume,
      mode,
      options: { ...options, resume, humanReviewEnabled: Boolean(this.humanReviewController) },
      state: 'queued',
      cancelMode: null,
      initialQueuePosition: this.running.size >= this.maxConcurrent ? this.queue.length + 1 : 0,
    };
    this.jobs.set(projectId, job);
    this.queue.push(job);
    this.#emitQueued(job);
    this.#pump();
    return {
      ...this.status(projectId, { runId: job.runId }),
      started: true,
      queuePosition: job.initialQueuePosition,
      resume,
      mode,
    };
  }

  #emitQueued(job) {
    if (job.initialQueuePosition <= 0) return;
    this.#appendEvent(job.projectId, {
      type: 'plan',
      stage: 'system',
      agent: 'analysis-coordinator',
      round: null,
      artifact: null,
      text: `已进入分析队列（第 ${job.initialQueuePosition} 位，当前并发上限 ${this.maxConcurrent}），排到后自动开始。`,
    });
  }

  #cancel(projectId, mode) {
    const meta = this.projectSpace.meta(projectId);
    if (!meta) throw serviceError(`project not found: ${projectId}`, 'PROJECT_NOT_FOUND', 404);
    const job = this.jobs.get(projectId) || null;
    const currentRecord = job
      ? this.projectSpace.runStore(projectId).load(job.runId)
      : latestRecord(this.projectSpace, projectId);
    if (currentRecord?.status && currentRecord.status !== RUN_STATUSES.RUNNING) {
      return {
        ok: false,
        reason: 'not-active',
        project: meta,
        removedQueued: false,
        running: false,
        ...this.status(projectId),
      };
    }
    if (!job && !currentRecord) {
      return {
        ok: false,
        reason: 'not-active',
        project: meta,
        removedQueued: false,
        running: false,
        ...this.status(projectId),
      };
    }
    let removedQueued = false;
    if (job?.state === 'queued') {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      removedQueued = true;
      job.cancelMode = mode;
      this.projectSpace.runStore(projectId).cancelRun(
        job.runId,
        mode === 'paused' ? 'operator-paused' : mode,
      );
      this.jobs.delete(projectId);
    } else if (job) {
      job.cancelMode = mode;
    } else {
      this.projectSpace.runStore(projectId).cancelRun(
        currentRecord.runId,
        mode === 'paused' ? 'operator-paused' : mode,
      );
    }
    const status = mode === 'paused' ? 'paused' : 'cancelled';
    const project = this.projectSpace.updateMeta(projectId, { status, lastError: null });
    this.#appendEvent(projectId, {
      type: 'done',
      stage: 'system',
      agent: 'analysis-coordinator',
      round: null,
      artifact: null,
      text: status === 'paused'
        ? (job?.state === 'running' ? '已请求暂停，当前步骤结束后停止。' : '分析已暂停。')
        : '分析已取消。',
    });
    return {
      ok: true,
      project,
      removedQueued,
      running: Boolean(job?.state === 'running'),
      ...this.status(projectId),
    };
  }

  #pump() {
    while (this.running.size < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (!this.jobs.has(job.projectId) || job.cancelMode) continue;
      job.state = 'running';
      this.running.add(job.projectId);
      Promise.resolve()
        .then(() => this.runner(job.projectId, {
          ...job.options,
          preparedRunId: job.runId,
          cancelled: () => (
            Boolean(job.cancelMode)
            || (
              typeof job.options.cancelled === 'function'
              && Boolean(job.options.cancelled())
            )
          ),
        }))
        .catch((error) => {
          job.error = error;
          this.logger.error?.('[analysis]', job.projectId, error?.stack || error);
        })
        .finally(() => this.#finish(job))
        .catch((error) => {
          this.logger.error?.('[analysis-finalize]', job.projectId, error?.stack || error);
        });
    }
  }

  async #finish(job) {
    this.running.delete(job.projectId);
    this.jobs.delete(job.projectId);
    // Analysis queue ownership ends before the lower-cost Report Overview call;
    // Overview latency must not consume a Run Analysis concurrency slot.
    this.#pump();
    let record = null;
    let durableError = null;
    try {
      record = this.projectSpace.runStore(job.projectId).load(job.runId);
      if (record?.status === RUN_STATUSES.RUNNING && job.cancelMode) {
        const stopReason = job.cancelMode === 'paused'
          ? 'operator-paused'
          : job.cancelMode;
        record = this.projectSpace.runStore(job.projectId).cancelRun(job.runId, stopReason);
      } else if (job.error && record?.status === RUN_STATUSES.RUNNING) {
        record = this.projectSpace.runStore(job.projectId).cancelRun(job.runId, 'service-error');
      } else if (record?.status === RUN_STATUSES.RUNNING) {
        record = this.projectSpace.runStore(job.projectId).cancelRun(
          job.runId,
          'service-runner-returned-nonterminal',
        );
      }
    } catch (error) {
      durableError = error;
      // Project deletion may remove the durable run before the cooperative
      // cancellation reaches this finalizer.
    }
    const meta = this.projectSpace.meta(job.projectId);
    if (meta) {
      const reportPackage = verifiedRunAnalysisReportPackage(job.projectId, record, {
        projectSpace: this.projectSpace,
      });
      if (reportPackage && this.reportLibraryIngest) {
        try {
          const packageInput = createVerifiedInternalReportPackage({
            projectId: job.projectId,
            runId: record.runId,
            projectSpace: this.projectSpace,
          });
          await this.reportLibraryIngest(packageInput, { source: 'producer' });
        } catch (error) {
          try {
            this.reportLibrary?.recordFailure?.({
              projectId: job.projectId,
              analysisRunId: record.runId,
              source: 'producer',
              error,
            });
          } catch (recordingError) {
            this.logger.error?.('[report-library-failure-record]', job.projectId, recordingError?.stack || recordingError);
          }
          this.logger.error?.('[report-library]', job.projectId, error?.stack || error);
        }
      }
      const status = record
        ? projectStatusFor({
          job: null,
          meta,
          record,
          reportPackage,
          reviewEnabled: Boolean(this.humanReviewController),
        })
        : 'failed';
      this.projectSpace.updateMeta(job.projectId, {
        status,
        lastError: status === 'failed'
          ? String(
              job.error?.message
              || durableError?.message
              || record?.stopReason
              || 'durable run record missing',
            ).slice(0, 300)
          : null,
      });
      if (status === 'failed') {
        this.#appendEvent(job.projectId, {
          type: 'error',
          stage: 'system',
          agent: 'analysis-coordinator',
          round: null,
          artifact: null,
          text: `分析中断：${String(
            job.error?.message
            || durableError?.message
            || record?.stopReason
            || 'durable run record missing',
          ).slice(0, 120)}。可点「继续分析」断点续跑。`,
        });
      }
      if (job.reviewDecisionId && this.humanReviewController) {
        try {
          this.humanReviewController.open(job.projectId, { detail: false });
        } catch (error) {
          this.logger.error?.(
            '[human-review-reconcile]',
            job.projectId,
            error?.stack || error,
          );
        }
      }
    }
    this.#pump();
  }
}
