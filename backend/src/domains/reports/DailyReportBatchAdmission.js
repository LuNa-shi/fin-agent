import {
  DailyReportBatchStore,
  createDailyReportAdmissionOutcome,
} from './DailyReportBatchStore.js';
import { ReportAdmissionService } from './ReportOverviewService.js';
import {
  DAILY_REPORT_BATCH_CONTRACT,
  WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
  normalizeInternalReportPackage,
} from './reportContracts.js';
import { safePublicFailure, safePublicStopReason } from './safeFailure.js';

export const CANONICAL_WORLDVIEW_PROCESSING_TARGET = 'canonical-worldview-processing.v1';
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const UNAVAILABLE_CANDIDATE_ERROR_CODES = new Set([
  'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  'STORAGE_FILE_INVALID',
  'STORAGE_FILE_NOT_FOUND',
  'STORAGE_FILE_SYMLINK',
]);

function batchAdmissionError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function publicBatchValue(value, field, pattern = SAFE_ID_RE, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw batchAdmissionError(`Daily Report Batch ${field} is invalid`, 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  return value;
}

function publicBatchCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw batchAdmissionError(`Daily Report Batch ${field} is invalid`, 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  return value;
}

function publicBatchEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw batchAdmissionError(`Daily Report Batch ${field} is invalid`, 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  return value;
}

function publicBatchArray(value, field) {
  if (!Array.isArray(value)) {
    throw batchAdmissionError(`Daily Report Batch ${field} is invalid`, 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  return value;
}

function projectCandidateDiagnostic(value) {
  if (!value) return null;
  const status = publicBatchEnum(
    value.status,
    'candidate status',
    ['admitted', 'blocked', 'retryable', 'preparing'],
  );
  const lastAttempt = value.lastAttempt ? {
    attemptId: publicBatchValue(value.lastAttempt.attemptId, 'candidate attemptId'),
    status: publicBatchEnum(
      value.lastAttempt.status,
      'candidate attempt status',
      ['running', 'failed', 'succeeded'],
    ),
    stopReason: value.lastAttempt.stopReason ? safePublicStopReason(value.lastAttempt.stopReason) : null,
    error: value.lastAttempt.error ? safePublicFailure(value.lastAttempt.error, {
      fallbackCode: 'REPORT_ADMISSION_FAILED',
      fallbackMessage: 'Report admission failed',
    }) : null,
    startedAt: publicBatchValue(value.lastAttempt.startedAt, 'candidate startedAt', ISO_RE),
    completedAt: publicBatchValue(value.lastAttempt.completedAt, 'candidate completedAt', ISO_RE, { nullable: true }),
  } : null;
  return {
    contract: 'report-admission-diagnostic.v1',
    candidateId: publicBatchValue(value.candidateId, 'candidateId'),
    status,
    attemptCount: publicBatchCount(value.attemptCount, 'candidate attemptCount'),
    error: value.error ? safePublicFailure(value.error, {
      fallbackCode: 'REPORT_ADMISSION_FAILED',
      fallbackMessage: 'Report admission failed',
    }) : null,
    lastAttempt,
    nextEligibleAt: publicBatchValue(value.nextEligibleAt, 'candidate nextEligibleAt', ISO_RE, { nullable: true }),
    reportVersionId: publicBatchValue(value.reportVersionId, 'candidate reportVersionId', SAFE_ID_RE, { nullable: true }),
    admittedAt: publicBatchValue(value.admittedAt, 'candidate admittedAt', ISO_RE, { nullable: true }),
    admissionSequence: value.admissionSequence === null || value.admissionSequence === undefined
      ? null
      : publicBatchCount(value.admissionSequence, 'candidate admissionSequence'),
  };
}

function candidateDiagnostic(candidate) {
  const latest = candidate.attempts.at(-1) || null;
  const stopReason = latest?.stopReason ? safePublicStopReason(latest.stopReason) : null;
  const lastError = candidate.lastError ? safePublicFailure(candidate.lastError, {
    fallbackCode: 'REPORT_ADMISSION_FAILED',
    fallbackMessage: 'Report admission failed',
  }) : null;
  const status = candidate.state === 'admitted'
    ? 'admitted'
    : candidate.state === 'blocked'
      ? 'blocked'
      : candidate.state === 'retryable'
        ? 'retryable'
        : 'preparing';
  return projectCandidateDiagnostic({
    contract: 'report-admission-diagnostic.v1',
    candidateId: candidate.candidateId,
    status,
    attemptCount: candidate.attempts.length,
    error: lastError,
    lastAttempt: latest ? {
      attemptId: latest.attemptId,
      status: latest.status,
      stopReason,
      error: latest.error ? safePublicFailure(latest.error, {
        fallbackCode: 'REPORT_ADMISSION_FAILED',
        fallbackMessage: 'Report admission failed',
      }) : null,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
    } : null,
    nextEligibleAt: candidate.nextEligibleAt || null,
    reportVersionId: candidate.admission?.reportVersionId || null,
    admittedAt: candidate.admission?.admittedAt || null,
    admissionSequence: candidate.admission?.admissionSequence || null,
  });
}

function projectAttempt(attempt, { referenceField, fallbackCode, fallbackMessage }) {
  const status = publicBatchEnum(attempt?.status, 'attempt status', ['succeeded', 'failed']);
  return {
    attemptId: publicBatchValue(attempt?.attemptId, 'attemptId'),
    [referenceField]: publicBatchValue(attempt?.[referenceField], referenceField, SAFE_ID_RE, { nullable: true }),
    status,
    error: status === 'failed'
      ? safePublicFailure(attempt?.error, { fallbackCode, fallbackMessage })
      : null,
  };
}

function projectOutcome(outcome) {
  if (!outcome) return null;
  const status = publicBatchEnum(outcome.status, 'outcome status', ['succeeded', 'failed']);
  const stage = publicBatchEnum(outcome.stage, 'outcome stage', ['production', 'admission']);
  if (status === 'succeeded' && stage !== 'admission') {
    throw batchAdmissionError('Daily Report Batch successful outcome stage is invalid', 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  const common = {
    status,
    stage,
    analysisRunId: publicBatchValue(outcome.analysisRunId, 'outcome analysisRunId', SAFE_ID_RE, { nullable: true }),
    candidateId: publicBatchValue(outcome.candidateId, 'outcome candidateId', SAFE_ID_RE, { nullable: true }),
    productionAttempts: publicBatchArray(outcome.productionAttempts || [], 'productionAttempts')
      .map((attempt) => projectAttempt(attempt, {
      referenceField: 'analysisRunId',
      fallbackCode: 'REPORT_PRODUCTION_FAILED',
      fallbackMessage: 'Report production failed',
      })),
    admissionAttempts: publicBatchArray(outcome.admissionAttempts || [], 'admissionAttempts')
      .map((attempt) => projectAttempt(attempt, {
      referenceField: 'reportVersionId',
      fallbackCode: 'REPORT_ADMISSION_FAILED',
      fallbackMessage: 'Report admission failed',
      })),
    candidateAdmission: projectCandidateDiagnostic(outcome.candidateAdmission),
  };
  if (status === 'succeeded') {
    return {
      ...common,
      reportVersionId: publicBatchValue(outcome.reportVersionId, 'outcome reportVersionId'),
      contentDigest: publicBatchValue(outcome.contentDigest, 'outcome contentDigest', DIGEST_RE),
      fingerprint: publicBatchValue(outcome.fingerprint, 'outcome fingerprint', DIGEST_RE),
    };
  }
  const productionFailure = stage === 'production';
  return {
    ...common,
    error: safePublicFailure(outcome.error, {
      fallbackCode: productionFailure ? 'REPORT_PRODUCTION_FAILED' : 'REPORT_ADMISSION_FAILED',
      fallbackMessage: productionFailure ? 'Report production failed' : 'Report admission failed',
    }),
  };
}

function projectProcessingTrigger(trigger) {
  if (!trigger) return null;
  if (trigger.contract !== WORLDVIEW_PROCESSING_TRIGGER_CONTRACT) {
    throw batchAdmissionError('Daily Report Batch processing trigger contract is invalid', 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  const pendingReportVersionIds = publicBatchArray(
    trigger.pendingReportVersionIds || [],
    'pendingReportVersionIds',
  ).map((id) => publicBatchValue(id, 'pending reportVersionId'));
  const coreWorldviewAgentCalls = trigger.coreWorldviewAgentCalls == null
    ? 0
    : publicBatchCount(trigger.coreWorldviewAgentCalls, 'coreWorldviewAgentCalls');
  return {
    contract: WORLDVIEW_PROCESSING_TRIGGER_CONTRACT,
    triggerId: publicBatchValue(trigger.triggerId, 'processing triggerId'),
    batchId: publicBatchValue(trigger.batchId, 'processing batchId'),
    publishedAt: publicBatchValue(trigger.publishedAt, 'processing publishedAt', ISO_RE),
    status: publicBatchEnum(trigger.status, 'processing status', ['requested', 'no-work']),
    pendingReportVersionIds,
    pendingReportCount: pendingReportVersionIds.length,
    coreWorldviewAgentCalls,
    ...(trigger.processingTarget
      ? { processingTarget: publicBatchValue(trigger.processingTarget, 'processingTarget') }
      : {}),
  };
}

function projectSummary(batch) {
  if (batch.completion?.summary) {
    return {
      total: publicBatchCount(batch.completion.summary.total, 'summary total'),
      succeeded: publicBatchCount(batch.completion.summary.succeeded, 'summary succeeded'),
      failed: publicBatchCount(batch.completion.summary.failed, 'summary failed'),
    };
  }
  return (batch.items || []).reduce((summary, item) => {
    summary.total += 1;
    if (item.status === 'succeeded') summary.succeeded += 1;
    else if (item.status === 'failed') summary.failed += 1;
    else summary.pending += 1;
    return summary;
  }, { total: 0, pending: 0, succeeded: 0, failed: 0 });
}

function durableAdmissionContext(batchStore, batchId, itemId, candidateId) {
  const association = batchStore.inspectItem(batchId, itemId).item.admissionCandidate;
  if (!association || association.candidateId !== candidateId) {
    throw batchAdmissionError(
      'Daily Report Batch item does not match its admission candidate checkpoint',
      'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT',
    );
  }
  return association;
}

export function projectDailyReportBatchPublicFailures(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw batchAdmissionError('Daily Report Batch is invalid', 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  if (batch.contract !== DAILY_REPORT_BATCH_CONTRACT) {
    throw batchAdmissionError('Daily Report Batch contract is invalid', 'DAILY_REPORT_BATCH_CORRUPT', 500);
  }
  const items = publicBatchArray(batch.items || [], 'items').map((item) => ({
    itemId: publicBatchValue(item.itemId, 'itemId'),
    projectId: publicBatchValue(item.projectId, 'projectId'),
    sourceIdeaId: publicBatchValue(item.sourceIdeaId, 'sourceIdeaId', SAFE_ID_RE, { nullable: true }),
    status: publicBatchEnum(item.status, 'item status', ['pending', 'succeeded', 'failed']),
    outcome: projectOutcome(item.outcome),
    completedAt: publicBatchValue(item.completedAt, 'item completedAt', ISO_RE, { nullable: true }),
  }));
  const completion = batch.completion ? {
    closedAt: publicBatchValue(batch.completion.closedAt, 'completion closedAt', ISO_RE),
    summary: {
      total: publicBatchCount(batch.completion.summary?.total, 'completion total'),
      succeeded: publicBatchCount(batch.completion.summary?.succeeded, 'completion succeeded'),
      failed: publicBatchCount(batch.completion.summary?.failed, 'completion failed'),
    },
    processingTrigger: projectProcessingTrigger(batch.completion.processingTrigger),
    completionDigest: publicBatchValue(batch.completion.completionDigest, 'completion digest', DIGEST_RE),
  } : null;
  return {
    contract: DAILY_REPORT_BATCH_CONTRACT,
    batchId: publicBatchValue(batch.batchId, 'batchId'),
    productionDate: publicBatchValue(batch.productionDate, 'productionDate', /^\d{4}-\d{2}-\d{2}$/u),
    producer: { id: publicBatchValue(batch.producer?.id, 'producer id') },
    productionRunId: publicBatchValue(batch.productionRunId, 'productionRunId'),
    status: publicBatchEnum(batch.status, 'status', ['open', 'closed']),
    createdAt: publicBatchValue(batch.createdAt, 'createdAt', ISO_RE),
    summary: projectSummary({ ...batch, items }),
    completion,
    items,
  };
}

export function projectDailyReportBatchCandidateAdmissions(batch, candidateStore) {
  const projected = projectDailyReportBatchPublicFailures(batch);
  projected.items = projected.items.map((item) => {
    if (!item.outcome) return item;
    const candidateId = item.outcome.candidateId;
    let candidate = null;
    try {
      candidate = candidateId ? candidateStore.get(candidateId) : null;
    } catch (error) {
      if (!UNAVAILABLE_CANDIDATE_ERROR_CODES.has(error?.code)) throw error;
    }
    item.outcome.candidateAdmission = candidate ? candidateDiagnostic(candidate) : null;
    return item;
  });
  return projected;
}

export class DailyReportBatchAdmission {
  constructor({
    reportLibrary,
    admissionService = null,
    batchStore = null,
    worldviewCoordinator = null,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!reportLibrary || typeof reportLibrary.listPendingReports !== 'function') {
      throw new TypeError('DailyReportBatchAdmission reportLibrary is required');
    }
    this.reportLibrary = reportLibrary;
    this.batchStore = batchStore || admissionService?.batchStore || new DailyReportBatchStore({
      rootDir: reportLibrary.rootDir,
      eventStore: reportLibrary.eventStore,
      now,
    });
    this.admissionService = admissionService || new ReportAdmissionService({
      reportLibrary,
      batchStore: this.batchStore,
    });
    if (worldviewCoordinator !== null && typeof worldviewCoordinator?.processTrigger !== 'function') {
      throw new TypeError('DailyReportBatchAdmission worldviewCoordinator must expose processTrigger');
    }
    this.worldviewCoordinator = worldviewCoordinator;
    this.processingPromises = new Map();
    const recoverableTriggers = this.batchStore.list({ status: 'closed', limit: 1000 }).batches
      .map((batch) => batch.completion?.processingTrigger)
      .filter((trigger) => (
        trigger?.status === 'requested'
        && trigger.processingTarget === CANONICAL_WORLDVIEW_PROCESSING_TARGET
      ));
    this.recoveryPromise = worldviewCoordinator && typeof worldviewCoordinator.resumeTriggers === 'function'
      ? worldviewCoordinator.resumeTriggers(recoverableTriggers)
      : Promise.resolve([]);
  }

  createBatch(plan) {
    return this.batchStore.create(plan);
  }

  async completeItem({ batchId, itemId, packageInput, source = 'producer', admissionAttemptId = 'initial', productionAttempts = [] } = {}) {
    const current = this.batchStore.inspectItem(batchId, itemId);
    let reportPackage;
    try {
      reportPackage = normalizeInternalReportPackage(packageInput);
      if (
        reportPackage.lineage.projectId !== current.item.projectId
        || reportPackage.dailyReport?.runId !== batchId
      ) {
        throw batchAdmissionError(
          'Report package lineage does not match the pre-registered Daily Report Batch item',
          'DAILY_REPORT_BATCH_PACKAGE_MISMATCH',
        );
      }
    } catch (error) {
      if (current.item.status !== 'pending') throw error;
      return this.batchStore.recordOutcome(batchId, itemId, {
        status: 'failed',
        stage: 'admission',
        analysisRunId: packageInput?.lineage?.analysisRunId || null,
        candidateId: error?.candidateId || null,
        error,
        productionAttempts,
        admissionAttempts: [{
          attemptId: `admission-${admissionAttemptId}`,
          status: 'failed',
          reportVersionId: null,
          error,
        }],
      });
    }
    if (current.item.status !== 'pending') {
      const outcome = current.item.outcome;
      if (outcome?.stage === 'admission' && outcome.candidateId) {
        const candidate = this.admissionService.verifyCandidate(reportPackage, {
          source,
          batchId,
          itemId,
          expectedCandidateId: outcome.candidateId,
        });
        if (outcome.status === 'succeeded' && (
          candidate.reportVersionId !== outcome.reportVersionId
          || candidate.contentDigest !== outcome.contentDigest
          || candidate.fingerprint !== outcome.fingerprint
          || candidate.analysisRunId !== outcome.analysisRunId
        )) {
          throw batchAdmissionError(
            'Daily Report Batch replay does not match its historical admission outcome',
            'DAILY_REPORT_BATCH_OUTCOME_CONFLICT',
          );
        }
      }
      return { ...current, replayed: true };
    }
    let activeCandidateId = null;
    try {
      const admitted = await this.admissionService.admit(reportPackage, {
        source,
        batchId,
        itemId,
        admissionAttemptId: `admission-${admissionAttemptId}`,
        productionAttempts,
      });
      activeCandidateId = admitted.candidateId;
      const admissionContext = durableAdmissionContext(
        this.batchStore,
        batchId,
        itemId,
        admitted.candidateId,
      );
      return this.batchStore.recordOutcome(
        batchId,
        itemId,
        createDailyReportAdmissionOutcome({ association: admissionContext, admitted }),
      );
    } catch (error) {
      if ([
        'FILE_LOCK_TIMEOUT',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
        'REPORT_ADMISSION_ATTEMPT_CONFLICT',
        'REPORT_ADMISSION_OWNERSHIP_CONFLICT',
        'REPORT_ADMISSION_PROJECTION_REPAIR_PENDING',
        'DAILY_REPORT_BATCH_CANDIDATE_CONFLICT',
        'REPORT_ADMISSION_IN_FLIGHT',
      ].includes(error?.code)) {
        throw error;
      }
      const candidateId = error?.candidateId || activeCandidateId;
      const latest = this.batchStore.inspectItem(batchId, itemId).item;
      if (candidateId && !latest.admissionCandidate) throw error;
      const admissionContext = candidateId
        ? durableAdmissionContext(this.batchStore, batchId, itemId, candidateId)
        : null;
      const outcome = admissionContext
        ? createDailyReportAdmissionOutcome({ association: admissionContext, error })
        : {
          status: 'failed',
          stage: 'admission',
          analysisRunId: packageInput?.lineage?.analysisRunId || null,
          candidateId: null,
          error,
          productionAttempts,
          admissionAttempts: [{
            attemptId: `admission-${admissionAttemptId}`,
            status: 'failed',
            reportVersionId: null,
            error,
          }],
        };
      return this.batchStore.recordOutcome(batchId, itemId, outcome);
    }
  }

  failItem({ batchId, itemId, analysisRunId = null, stage = 'production', error, productionAttempts = [], admissionAttempts = [] } = {}) {
    return this.batchStore.recordOutcome(batchId, itemId, {
      status: 'failed',
      stage,
      analysisRunId,
      error,
      productionAttempts,
      admissionAttempts,
    });
  }

  close(batchId) {
    const existing = this.batchStore.get(batchId);
    const closed = existing?.status === 'closed'
      ? this.batchStore.close(batchId, {
        pendingReportVersionIds: existing.completion.processingTrigger.pendingReportVersionIds,
        processingTarget: CANONICAL_WORLDVIEW_PROCESSING_TARGET,
      })
      : this.batchStore.close(batchId, {
        pendingReportVersionIds: this.reportLibrary.listPendingReports().reports
          .map((report) => report.reportVersionId),
        processingTarget: CANONICAL_WORLDVIEW_PROCESSING_TARGET,
      });
    const projectedClosed = {
      ...closed,
      batch: projectDailyReportBatchCandidateAdmissions(closed.batch, this.admissionService.candidateStore),
      processingTrigger: projectProcessingTrigger(closed.processingTrigger),
    };
    if (!this.worldviewCoordinator || closed.processingTrigger.status !== 'requested') return projectedClosed;
    let processingPromise = this.processingPromises.get(closed.processingTrigger.triggerId);
    if (!processingPromise) {
      processingPromise = this.recoveryPromise
        .then(() => this.worldviewCoordinator.processTrigger(closed.processingTrigger));
      this.processingPromises.set(closed.processingTrigger.triggerId, processingPromise);
      processingPromise.finally(() => {
        if (this.processingPromises.get(closed.processingTrigger.triggerId) === processingPromise) {
          this.processingPromises.delete(closed.processingTrigger.triggerId);
        }
      }).catch(() => {});
    }
    return { ...projectedClosed, processingPromise };
  }

  get(batchId) {
    const batch = this.batchStore.get(batchId);
    return batch ? projectDailyReportBatchCandidateAdmissions(batch, this.admissionService.candidateStore) : null;
  }

  list(options = {}) {
    const result = this.batchStore.list(options);
    return {
      ...result,
      batches: result.batches.map((batch) => (
        projectDailyReportBatchCandidateAdmissions(batch, this.admissionService.candidateStore)
      )),
    };
  }
}

export const createDailyReportBatchAdmission = (options = {}) => new DailyReportBatchAdmission(options);
