import { randomUUID } from 'node:crypto';

import { getEffectiveAgentDefinition } from '../../agents/AgentRuntimeService.js';
import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import { beginDirectAgentCommand } from '../../core/contracts/AgentExecutionScope.js';
import { canonicalStringify, deepFreeze } from '../../core/contracts/ArtifactRef.js';
import { estimateTokens } from '../../lib/context.js';
import {
  normalizeInternalReportPackage,
  normalizeReportOverviewContent,
  reportVersionFingerprint,
  reportVersionId,
} from './reportContracts.js';
import {
  ReportAdmissionStore,
  REPORT_ADMISSION_CANDIDATE_STATES,
  normalizeReportAdmissionBinding,
  reportAdmissionCandidateId,
} from './ReportAdmissionStore.js';
import {
  DailyReportBatchStore,
  createDailyReportAdmissionOutcome,
} from './DailyReportBatchStore.js';
import {
  safePublicFailure,
  safePublicStopReason,
  safePublicTraceRef,
} from './safeFailure.js';

function overviewError(message, code = 'REPORT_OVERVIEW_PRODUCTION_FAILED', cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function invalidBatchAssociationError(cause = null) {
  const error = overviewError(
    'Producer admission must reference an existing Daily Report Batch item owned by the report project',
    'REPORT_ADMISSION_INVALID_BATCH_REF',
    cause,
  );
  error.statusCode = 409;
  return error;
}

function retryableAdmissionError(candidateId, cause) {
  const error = overviewError(
    `Report admission candidate remains retryable: ${candidateId}`,
    'REPORT_ADMISSION_RETRYABLE',
    cause,
  );
  error.candidateId = candidateId;
  return error;
}

function admissionInFlightError(candidateId, cause = null) {
  const error = overviewError(
    `Report admission candidate is already in progress: ${candidateId}`,
    'REPORT_ADMISSION_IN_FLIGHT',
    cause,
  );
  error.candidateId = candidateId;
  error.statusCode = 409;
  return error;
}

function committedAdmissionReplay(result) {
  const error = overviewError(
    'Report admission already has an authoritative Report Library marker',
    'REPORT_ADMISSION_ALREADY_COMMITTED',
  );
  error.admitted = result;
  return error;
}

function projectionRepairPendingError(candidateId, cause) {
  const error = overviewError(
    `Report admission projection repair remains pending: ${candidateId}`,
    'REPORT_ADMISSION_PROJECTION_REPAIR_PENDING',
    cause,
  );
  error.candidateId = candidateId;
  error.statusCode = 503;
  return error;
}

const SUPERSEDED_ADMISSION_ERROR_CODES = new Set([
  'REPORT_ADMISSION_ATTEMPT_CONFLICT',
  'REPORT_ADMISSION_OWNERSHIP_CONFLICT',
]);
const NON_TERMINAL_BATCH_ERROR_CODES = new Set([
  'FILE_LOCK_TIMEOUT',
  'REPORT_ADMISSION_IN_FLIGHT',
  'REPORT_ADMISSION_PROJECTION_REPAIR_PENDING',
]);
const RETRYABLE_RECOVERY_ERROR_CODES = new Set([
  ...NON_TERMINAL_BATCH_ERROR_CODES,
  'REPORT_ADMISSION_RETRYABLE',
]);
const CORRUPT_CANDIDATE_STORAGE_CODES = new Set([
  'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  'STORAGE_FILE_INVALID',
  'STORAGE_FILE_NOT_FOUND',
  'STORAGE_FILE_SYMLINK',
]);

function normalizeCandidateLookupError(error) {
  if (!CORRUPT_CANDIDATE_STORAGE_CODES.has(error?.code)) return error;
  return overviewError(
    'Report admission candidate state was corrupt',
    'REPORT_ADMISSION_CANDIDATE_CORRUPT',
    error,
  );
}

function hasTransientFailureSignal(value) {
  const code = String(value?.code || '').toUpperCase();
  const statusCode = Number(value?.statusCode ?? value?.status ?? 0);
  return value?.transient === true
    || /(?:TRANSIENT|TIMEOUT|TIMEDOUT|RATE_LIMIT|PROVIDER_UNAVAILABLE|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|UND_ERR)/u.test(code)
    || [408, 425, 429].includes(statusCode)
    || (statusCode >= 500 && statusCode <= 599);
}

function isRetryableOverviewError(error, retryOn) {
  if (new Set([
    'REPORT_OVERVIEW_OUTPUT_INVALID',
    'INVALID_REPORT_OVERVIEW',
  ]).has(error?.code)) return true;
  if (!hasTransientFailureSignal(error) && error?.code !== 'REPORT_OVERVIEW_PROVIDER_TRANSIENT') return false;
  const category = /PROVIDER_UNAVAILABLE|REPORT_OVERVIEW_PROVIDER_TRANSIENT/u.test(String(error?.code || ''))
    ? 'provider-unavailable'
    : 'transient';
  return retryOn.has(category);
}

const TERMINAL_COMMIT_ERROR_CODES = new Set([
  'REPORT_ADMISSION_CANDIDATE_CONFLICT',
  'REPORT_ADMISSION_CANDIDATE_CORRUPT',
  'REPORT_ADMISSION_INVALID_BATCH_REF',
  'REPORT_ADMISSION_RECEIPT_CONFLICT',
  'REPORT_EVENT_IDEMPOTENCY_CONFLICT',
  'REPORT_LIBRARY_ADMISSION_CONFLICT',
  'REPORT_LIBRARY_CONTENT_CONFLICT',
  'REPORT_LIBRARY_CONTENT_DIGEST_MISMATCH',
  'REPORT_LIBRARY_CORRUPT_ANCHOR',
  'REPORT_LIBRARY_IDEMPOTENCY_CONFLICT',
  'REPORT_OVERVIEW_BINDING_MISMATCH',
  'REPORT_OVERVIEW_CORRUPT',
  'REPORT_OVERVIEW_IDEMPOTENCY_CONFLICT',
]);

function isTerminalCommitError(error) {
  return TERMINAL_COMMIT_ERROR_CODES.has(String(error?.code || ''));
}

function safeAdmissionAttemptError(error, { retryable }) {
  const code = String(error?.code || '');
  if (/^(?:REPORT_OVERVIEW_|REPORT_ADMISSION_|INVALID_REPORT_OVERVIEW$)/u.test(code)) return error;
  const safe = overviewError(
    retryable ? 'Report Overview provider failed transiently' : 'Report Overview execution failed',
    retryable ? 'REPORT_OVERVIEW_PROVIDER_TRANSIENT' : 'REPORT_OVERVIEW_AGENT_FAILED',
  );
  safe.transient = retryable;
  return safe;
}

function attachAttemptDetails(error, definition, result = null) {
  error.provenance = result ? provenance(definition, result) : null;
  error.stopReason = error.provenance?.stopReason || null;
  return error;
}

function providerFailureIsTransient(result) {
  return hasTransientFailureSignal(result?.error)
    || result?.stopReason === 'provider-unavailable'
    || /(?:TRANSIENT|TIMEOUT|RATE_LIMIT|PROVIDER_UNAVAILABLE)/u.test(String(result?.error?.code || ''));
}

function safeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, metric]) => (
      /^[A-Za-z0-9_.:-]{1,80}$/u.test(key)
      && (typeof metric === 'boolean' || (typeof metric === 'number' && Number.isFinite(metric)))
    ))
    .slice(0, 32));
}

function boundedRouteText(value, fallback, max) {
  const text = String(value ?? fallback).replaceAll('\u0000', '').slice(0, max);
  if (/\bhttps?:\/\/|\bfile:\/\/|^[A-Za-z]:\\|^\/|\b(?:api[_-]?key|password|token)\s*[:=]|\bBearer\s+/iu.test(text)) {
    return fallback;
  }
  return text || fallback;
}

function provenance(definition, result = {}) {
  return {
    agentId: definition.id,
    agentVersion: definition.version,
    effectiveConfigDigest: definition.effectiveConfig.digest,
    provider: boundedRouteText(result.provider, 'unreported', 120),
    model: boundedRouteText(result.model, 'unreported', 160),
    live: Boolean(result.live),
    traceRef: safePublicTraceRef(result.traceRef, { fallback: 'unreported', maxLength: 300 }),
    stopReason: result.stopReason == null ? null : safePublicStopReason(result.stopReason),
    metrics: safeMetrics(result.metrics),
  };
}

function publicMetadata(report) {
  return {
    title: report.title,
    tickers: Array.isArray(report.tickers) ? [...report.tickers] : [],
    theme: report.theme,
    searchTags: Array.isArray(report.searchTags) ? [...report.searchTags] : [],
    asOf: report.asOf,
    generatedAt: report.generatedAt,
    producer: report.producer,
    lineage: report.lineage,
  };
}

function stagedReport(packageInput, stagedAt) {
  const reportPackage = normalizeInternalReportPackage(packageInput);
  const id = reportVersionId(reportPackage);
  return {
    reportPackage,
    report: {
      id,
      reportVersionId: id,
      contentDigest: reportPackage.report.contentDigest,
      fingerprint: reportVersionFingerprint(reportPackage),
      title: reportPackage.metadata.title,
      tickers: [...reportPackage.metadata.tickers],
      theme: reportPackage.metadata.theme,
      searchTags: [...reportPackage.metadata.searchTags],
      asOf: reportPackage.metadata.asOf,
      generatedAt: reportPackage.metadata.generatedAt,
      producer: structuredClone(reportPackage.producer),
      lineage: structuredClone(reportPackage.lineage),
      ingestion: { admittedAt: stagedAt },
    },
  };
}

export class ReportOverviewService {
  constructor({
    agentRunner = runDefinedAgent,
    agentBackend = undefined,
    definitionResolver = getEffectiveAgentDefinition,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof agentRunner !== 'function') throw new TypeError('ReportOverviewService agentRunner is required');
    if (typeof definitionResolver !== 'function') throw new TypeError('ReportOverviewService definitionResolver is required');
    if (typeof now !== 'function') throw new TypeError('ReportOverviewService now must be a function');
    this.agentRunner = agentRunner;
    this.agentBackend = agentBackend;
    this.definitionResolver = definitionResolver;
    this.now = now;
  }

  effectiveDefinition() {
    return this.definitionResolver('report-overview');
  }

  async prepare(packageInput, {
    candidateId,
    overviewConfigDigest,
    attemptId,
    stagedAt = this.now(),
  } = {}) {
    const { reportPackage, report } = stagedReport(packageInput, stagedAt);
    const markdown = reportPackage.report.markdown;
    const definition = this.effectiveDefinition();
    if (definition.effectiveConfig.digest !== overviewConfigDigest) {
      throw overviewError(
        'Staged Report Overview configuration no longer matches the effective Agent configuration',
        'REPORT_OVERVIEW_CONFIG_MISMATCH',
      );
    }
    const estimatedInlineTokens = estimateTokens(`${JSON.stringify(publicMetadata(report))}\n${markdown}`);
    if (estimatedInlineTokens > definition.contextPolicy.maxInlineTokens) {
      throw overviewError(
        `Report candidate exceeds Report Overview inline context limit: ${estimatedInlineTokens} > ${definition.contextPolicy.maxInlineTokens}`,
        'REPORT_OVERVIEW_CONTEXT_TOO_LARGE',
      );
    }
    const idempotencyKey = [
      'report-overview',
      candidateId,
      report.fingerprint,
      overviewConfigDigest,
      attemptId,
    ].join(':');
    const scope = beginDirectAgentCommand({
      commandId: `report-overview:${candidateId}:${attemptId}`,
      runId: `report-overview:${candidateId}:${attemptId}`,
      workflowId: 'report-library-admission.v1',
      nodeId: 'produce-report-overview',
      projectId: 'report-library',
      asOf: stagedAt,
      workspaceMode: 'none',
      idempotencyKey,
    });
    const result = await this.agentRunner('report-overview', {
      reportVersionId: report.reportVersionId,
      contentDigest: report.contentDigest,
      fingerprint: report.fingerprint,
      metadata: publicMetadata(report),
      markdown,
    }, {
      scope,
      callId: `report-overview:${candidateId}:${attemptId}`,
      expectedEffectiveConfigDigest: definition.effectiveConfig.digest,
      ...(this.agentBackend === undefined ? {} : { backend: this.agentBackend }),
      kind: 'report-overview',
      throwOnFailure: false,
      maxTurns: definition.runPolicy.maxTurns,
      modelApiRetry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    if (result?.status !== 'succeeded' || result.valid === false || !result.output?.overview) {
      if (providerFailureIsTransient(result)) {
        const error = attachAttemptDetails(overviewError(
          `Report Overview provider failed transiently: ${result?.stopReason || 'provider unavailable'}`,
          'REPORT_OVERVIEW_PROVIDER_TRANSIENT',
          result?.error || null,
        ), definition, result);
        error.transient = true;
        throw error;
      }
      const invalid = result?.valid === false || result?.stopReason === 'schema-invalid' || result?.status === 'succeeded';
      throw attachAttemptDetails(overviewError(
        `Report Overview Agent failed: ${result?.stopReason || 'invalid output'}`,
        invalid ? 'REPORT_OVERVIEW_OUTPUT_INVALID' : 'REPORT_OVERVIEW_AGENT_FAILED',
        result?.error || null,
      ), definition, result);
    }
    let content;
    try {
      content = normalizeReportOverviewContent(result.output.overview);
    } catch (error) {
      throw attachAttemptDetails(
        overviewError('Report Overview Agent returned invalid output', 'REPORT_OVERVIEW_OUTPUT_INVALID', error),
        definition,
        result,
      );
    }
    if (content.reportVersionId !== report.reportVersionId || content.contentDigest !== report.contentDigest) {
      throw attachAttemptDetails(overviewError(
        'Report Overview output does not match the staged ReportVersion binding',
        'REPORT_OVERVIEW_BINDING_MISMATCH',
      ), definition, result);
    }
    return {
      content,
      provenance: provenance(definition, result),
      producedAt: this.now(),
      attemptId,
    };
  }
}

export class ReportAdmissionService {
  constructor({
    reportLibrary,
    overviewService = null,
    candidateStore = null,
    batchStore = null,
    now = null,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    maxImmediateAttempts = null,
    baseRetryDelayMs = 250,
    maxRetryDelayMs = 5_000,
    leaseMs = 10 * 60_000,
    ownerToken = `admission-owner-${process.pid}-${randomUUID()}`,
  } = {}) {
    if (!reportLibrary || typeof reportLibrary.commitPreparedAdmission !== 'function') {
      throw new TypeError('ReportAdmissionService reportLibrary is required');
    }
    if (typeof sleep !== 'function') throw new TypeError('ReportAdmissionService sleep is required');
    this.reportLibrary = reportLibrary;
    this.overviewService = overviewService || new ReportOverviewService();
    this.now = now || this.overviewService.now || (() => new Date().toISOString());
    if (typeof this.now !== 'function') throw new TypeError('ReportAdmissionService now must be a function');
    this.maxImmediateAttempts = maxImmediateAttempts === null ? null : Number(maxImmediateAttempts);
    if (this.maxImmediateAttempts !== null
      && (!Number.isInteger(this.maxImmediateAttempts) || this.maxImmediateAttempts < 1)) {
      throw new TypeError('ReportAdmissionService maxImmediateAttempts must be a positive integer');
    }
    if (!Number.isInteger(baseRetryDelayMs) || baseRetryDelayMs < 0) throw new TypeError('ReportAdmissionService baseRetryDelayMs must be non-negative');
    if (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs) throw new TypeError('ReportAdmissionService maxRetryDelayMs is invalid');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new TypeError('ReportAdmissionService leaseMs must be at least 1000');
    this.sleep = sleep;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.leaseMs = leaseMs;
    this.ownerToken = ownerToken;
    this.candidateStore = candidateStore || new ReportAdmissionStore({ rootDir: reportLibrary.rootDir, now: this.now });
    if (batchStore !== null && (
      typeof batchStore?.inspectItem !== 'function'
      || typeof batchStore?.findAdmissionCandidate !== 'function'
      || typeof batchStore?.listPendingAdmissionCandidates !== 'function'
      || typeof batchStore?.createAdmissionCandidate !== 'function'
    )) {
      throw new TypeError('ReportAdmissionService batchStore must expose admission candidate coordination');
    }
    this.batchStore = batchStore || new DailyReportBatchStore({
      rootDir: reportLibrary.rootDir,
      eventStore: reportLibrary.eventStore,
      now: this.now,
    });
    this.inFlight = new Map();
  }

  async admit(packageInput, {
    source = 'producer',
    batchId = null,
    itemId = null,
    admissionAttemptId = 'admission-initial',
    productionAttempts = [],
  } = {}) {
    const reportPackage = normalizeInternalReportPackage(packageInput);
    const requestedBinding = normalizeReportAdmissionBinding(reportPackage, { source, batchId, itemId });
    const markerReplay = this.#markerFirstAdmissionResult(reportPackage, requestedBinding);
    if (markerReplay) return markerReplay;
    const binding = this.#assertBatchAssociation(reportPackage, { source, batchId, itemId });
    const definition = this.overviewService.effectiveDefinition();
    const immediateAttemptBudget = this.#immediateAttemptBudget(definition);
    const candidateIdentity = {
      candidateId: reportAdmissionCandidateId(reportPackage),
      reportVersionId: reportVersionId(reportPackage),
      contentDigest: reportPackage.report.contentDigest,
      fingerprint: reportVersionFingerprint(reportPackage),
      analysisRunId: reportPackage.lineage.analysisRunId,
      overviewConfigDigest: definition.effectiveConfig.digest,
      immediateAttemptBudget,
    };
    const committed = this.#checkpointedAdmissionResult(reportPackage, binding, candidateIdentity);
    if (committed) return committed;
    let staged;
    try {
      staged = this.candidateStore.stage(reportPackage, {
        source,
        batchId,
        itemId,
        overviewConfigDigest: definition.effectiveConfig.digest,
        immediateAttemptBudget,
        stagedAt: this.now(),
        beforeCreate: (identity, createCandidate) => {
          const racedCommit = this.#markerFirstAdmissionResult(reportPackage, binding);
          if (racedCommit) throw committedAdmissionReplay(racedCommit);
          this.#assertCandidateCreationAllowed(binding, identity);
          if (binding.batch !== null) {
            this.batchStore.createAdmissionCandidate(
              binding.batch.batchId,
              binding.batch.itemId,
              this.#batchCandidateCheckpoint(identity, { admissionAttemptId, productionAttempts }),
              createCandidate,
            );
          }
        },
      });
    } catch (error) {
      if (error?.code === 'REPORT_ADMISSION_ALREADY_COMMITTED' && error.admitted) {
        return error.admitted;
      }
      throw error;
    }
    try {
      this.#checkpointBatchCandidate(staged.candidate, { admissionAttemptId, productionAttempts });
    } catch (error) {
      if (error && typeof error === 'object' && !error.candidateId) {
        error.candidateId = staged.candidate.candidateId;
      }
      throw error;
    }
    if (!staged.created && staged.candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE) {
      return Promise.reject(retryableAdmissionError(staged.candidate.candidateId, null));
    }
    return this.#process(staged.candidate.candidateId);
  }

  verifyCandidate(packageInput, {
    source = 'producer',
    batchId = null,
    itemId = null,
    expectedCandidateId = null,
  } = {}) {
    const reportPackage = normalizeInternalReportPackage(packageInput);
    const requestedBinding = normalizeReportAdmissionBinding(reportPackage, { source, batchId, itemId });
    const candidateId = reportAdmissionCandidateId(reportPackage);
    if (expectedCandidateId !== null && candidateId !== expectedCandidateId) {
      throw overviewError('Report admission candidate identity conflict', 'REPORT_ADMISSION_CANDIDATE_CONFLICT');
    }
    const committed = this.#markerFirstAdmissionResult(reportPackage, requestedBinding);
    if (committed) {
      return deepFreeze({
        candidateId: committed.candidateId,
        reportVersionId: committed.reportVersionId,
        contentDigest: committed.contentDigest,
        fingerprint: reportVersionFingerprint(reportPackage),
        analysisRunId: reportPackage.lineage.analysisRunId,
      });
    }
    const binding = this.#assertBatchAssociation(reportPackage, { source, batchId, itemId });
    let existing = null;
    let candidateReadError = null;
    try {
      existing = this.candidateStore.get(candidateId);
    } catch (error) {
      candidateReadError = normalizeCandidateLookupError(error);
    }
    if (!existing) {
      return this.#verifyCheckpointCandidate(reportPackage, binding, candidateId, candidateReadError);
    }
    let staged;
    try {
      staged = this.candidateStore.stage(reportPackage, {
        source,
        batchId,
        itemId,
        overviewConfigDigest: existing.overviewConfigDigest,
        immediateAttemptBudget: existing.immediateAttemptBudget,
        stagedAt: existing.stagedAt,
      }).candidate;
    } catch (error) {
      if (error?.code === 'REPORT_ADMISSION_ALREADY_COMMITTED' && error.admitted) {
        return deepFreeze({
          candidateId: error.admitted.candidateId,
          reportVersionId: error.admitted.reportVersionId,
          contentDigest: error.admitted.contentDigest,
          fingerprint: reportVersionFingerprint(reportPackage),
          analysisRunId: reportPackage.lineage.analysisRunId,
        });
      }
      throw error;
    }
    this.#checkpointBatchCandidate(staged);
    return deepFreeze({
      candidateId: staged.candidateId,
      reportVersionId: staged.reportVersionId,
      contentDigest: staged.contentDigest,
      fingerprint: staged.fingerprint,
      analysisRunId: staged.package.lineage.analysisRunId,
    });
  }

  async recover() {
    const recoveryScan = this.candidateStore.scanRecoverable({ at: this.now() });
    const results = [];
    const reportedScanFailures = new Set();
    const reconcileScanFailures = (failures) => {
      for (const failure of failures) {
        const failureKey = canonicalStringify(failure);
        if (reportedScanFailures.has(failureKey)) continue;
        reportedScanFailures.add(failureKey);
        let reportedError = failure.error;
        try {
          const fenced = failure.candidateId
            ? this.candidateStore.reconcileUnavailable(
              failure.candidateId,
              () => this.#reconcileBatchFailure(failure.candidateId, failure.error),
            )
            : null;
          if (fenced?.available) continue;
          const reconciliation = fenced?.reconciliation
            || this.#reconcileBatchFailure(failure.candidateId, failure.error);
          if (reconciliation?.admitted) {
            results.push(reconciliation.admitted);
            continue;
          }
          if (reconciliation?.settled) continue;
          reportedError = reconciliation?.error || reportedError;
        } catch (reconciliationError) {
          reportedError = reconciliationError;
        }
        results.push({
          status: RETRYABLE_RECOVERY_ERROR_CODES.has(reportedError?.code) ? 'retryable' : 'failed',
          candidateId: failure.candidateId,
          reportVersionId: null,
          error: safePublicFailure(reportedError, {
            fallbackCode: 'REPORT_ADMISSION_FAILED',
            fallbackMessage: 'Report admission failed',
          }),
        });
      }
    };
    reconcileScanFailures(recoveryScan.failures);
    const processedCandidateIds = new Set();
    for (const candidate of recoveryScan.candidates) {
      processedCandidateIds.add(candidate.candidateId);
      try {
        this.#assertBatchAssociation(candidate.package, {
          source: candidate.source,
          batchId: candidate.batch?.batchId || null,
          itemId: candidate.batch?.itemId || null,
        });
        this.#checkpointBatchCandidate(candidate);
        const result = await this.#process(candidate.candidateId);
        const latest = this.candidateStore.get(candidate.candidateId);
        this.#reconcileBatchCandidate(latest, { admitted: result });
        results.push(result);
      } catch (error) {
        const latest = this.candidateStore.get(candidate.candidateId);
        let reportedError = error;
        if (!NON_TERMINAL_BATCH_ERROR_CODES.has(error?.code)) {
          try {
            this.#reconcileBatchCandidate(latest || candidate, { error });
          } catch (reconciliationError) {
            reportedError = reconciliationError;
          }
        }
        results.push({
          status: RETRYABLE_RECOVERY_ERROR_CODES.has(reportedError?.code) ? 'retryable' : 'failed',
          candidateId: candidate.candidateId,
          reportVersionId: null,
          error: safePublicFailure(reportedError, {
            fallbackCode: 'REPORT_ADMISSION_FAILED',
            fallbackMessage: 'Report admission failed',
          }),
        });
      }
    }
    const allCandidates = this.candidateStore.scanAll();
    reconcileScanFailures(allCandidates.failures);
    for (const candidate of allCandidates.candidates) {
      if (candidate.batch === null || processedCandidateIds.has(candidate.candidateId)) continue;
      try {
        const current = this.batchStore.inspectItem(candidate.batch.batchId, candidate.batch.itemId);
        if (current.item.status !== 'pending') continue;
        this.#assertBatchAssociation(candidate.package, {
          source: candidate.source,
          batchId: candidate.batch.batchId,
          itemId: candidate.batch.itemId,
        });
        this.#checkpointBatchCandidate(candidate);
        if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) {
          const admitted = this.#admittedResult(candidate);
          this.#reconcileBatchCandidate(candidate, { admitted });
          results.push(admitted);
        } else if ([
          REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE,
          REPORT_ADMISSION_CANDIDATE_STATES.BLOCKED,
        ].includes(candidate.state)) {
          const error = candidate.lastError || overviewError(
            'Report admission did not complete',
            'REPORT_ADMISSION_FAILED',
          );
          this.#reconcileBatchCandidate(candidate, { error });
          results.push({
            status: candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.RETRYABLE ? 'retryable' : 'failed',
            candidateId: candidate.candidateId,
            reportVersionId: null,
            error: safePublicFailure(error, {
              fallbackCode: 'REPORT_ADMISSION_FAILED',
              fallbackMessage: 'Report admission failed',
            }),
          });
        }
      } catch (error) {
        results.push({
          status: RETRYABLE_RECOVERY_ERROR_CODES.has(error?.code) ? 'retryable' : 'failed',
          candidateId: candidate.candidateId,
          reportVersionId: null,
          error: safePublicFailure(error, {
            fallbackCode: 'REPORT_ADMISSION_FAILED',
            fallbackMessage: 'Report admission failed',
          }),
        });
      }
    }
    for (const checkpoint of this.batchStore.listPendingAdmissionCandidates().items) {
      try {
        const fenced = this.candidateStore.reconcileUnavailable(
          checkpoint.admissionCandidate.candidateId,
          ({ error: candidateError }) => this.#reconcileBatchCheckpoint(
            checkpoint,
            candidateError
              ? normalizeCandidateLookupError(candidateError)
              : overviewError(
                'Daily Report Batch admission checkpoint has no durable candidate',
                'REPORT_ADMISSION_CANDIDATE_NOT_FOUND',
              ),
          ),
        );
        if (fenced.available || !fenced.reconciliation) continue;
        if (fenced.reconciliation.admitted) {
          results.push(fenced.reconciliation.admitted);
          continue;
        }
        if (fenced.reconciliation.settled) continue;
        const error = fenced.reconciliation.error;
        results.push({
          status: RETRYABLE_RECOVERY_ERROR_CODES.has(error?.code) ? 'retryable' : 'failed',
          candidateId: checkpoint.admissionCandidate.candidateId,
          reportVersionId: null,
          error: safePublicFailure(error, {
            fallbackCode: 'REPORT_ADMISSION_FAILED',
            fallbackMessage: 'Report admission failed',
          }),
        });
      } catch (error) {
        results.push({
          status: RETRYABLE_RECOVERY_ERROR_CODES.has(error?.code) ? 'retryable' : 'failed',
          candidateId: checkpoint.admissionCandidate.candidateId,
          reportVersionId: null,
          error: safePublicFailure(error, {
            fallbackCode: 'REPORT_ADMISSION_FAILED',
            fallbackMessage: 'Report admission failed',
          }),
        });
      }
    }
    return results;
  }

  async #process(candidateId) {
    const active = this.inFlight.get(candidateId);
    if (active) return active;
    const promise = this.#processOwned(candidateId);
    this.inFlight.set(candidateId, promise);
    try {
      return await promise;
    } catch (error) {
      if (error?.code === 'FILE_LOCK_TIMEOUT') {
        throw admissionInFlightError(candidateId, error);
      }
      if (SUPERSEDED_ADMISSION_ERROR_CODES.has(error?.code)) {
        throw admissionInFlightError(candidateId, error);
      }
      if (error && typeof error === 'object' && !error.candidateId) error.candidateId = candidateId;
      throw error;
    } finally {
      if (this.inFlight.get(candidateId) === promise) this.inFlight.delete(candidateId);
    }
  }

  #immediateAttemptBudget(definition) {
    const governedAttempts = definition?.runPolicy?.retry?.maxAttempts;
    if (!Number.isInteger(governedAttempts) || governedAttempts < 1) {
      throw new TypeError('Report Overview Agent governed retry policy is invalid');
    }
    const configuredAttempts = this.maxImmediateAttempts === null
      ? governedAttempts
      : this.maxImmediateAttempts;
    if (configuredAttempts > governedAttempts) {
      throw new TypeError(`ReportAdmissionService maxImmediateAttempts cannot exceed the Report Overview Agent governed maximum of ${governedAttempts}`);
    }
    return configuredAttempts;
  }

  async #processOwned(candidateId) {
    let candidate = this.candidateStore.get(candidateId);
    if (!candidate) throw overviewError(`Report admission candidate not found: ${candidateId}`, 'REPORT_ADMISSION_CANDIDATE_NOT_FOUND');
    if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) return this.#admittedResult(candidate);
    if (candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.PREPARED) {
      return this.#commit(candidate);
    }
    const definition = this.overviewService.effectiveDefinition();
    const retryPolicy = definition.runPolicy.retry;
    const currentGovernedAttempts = retryPolicy.maxAttempts;
    const retryOn = new Set(retryPolicy.retryOn || []);
    const configurationMatches = candidate.overviewConfigDigest === definition.effectiveConfig.digest
      && candidate.immediateAttemptBudget <= currentGovernedAttempts;
    const resumingRunningAttempt = candidate.state === REPORT_ADMISSION_CANDIDATE_STATES.ATTEMPTING;
    const initialAttemptsRemaining = Math.max(0, candidate.immediateAttemptBudget - candidate.attempts.length);
    // A restart inside the initial immediate window consumes only its durable
    // remainder. Once that window is exhausted, each later explicitly started
    // worker grants exactly one new governed attempt. Reclaiming an interrupted
    // logical attempt includes that same attempt without allocating another.
    const maxAttempts = initialAttemptsRemaining > 0
      ? initialAttemptsRemaining + (resumingRunningAttempt ? 1 : 0)
      : 1;

    let latestError = null;
    for (let localAttempt = 0; localAttempt < maxAttempts; localAttempt += 1) {
      const claim = this.candidateStore.claim(candidateId, {
        ownerToken: this.ownerToken,
        claimedAt: this.now(),
        leaseMs: this.leaseMs,
        ignoreEligibility: localAttempt > 0,
      });
      candidate = claim.candidate;
      if (!claim.claimed) {
        if (claim.reason === 'admitted') return this.#admittedResult(candidate);
        if (claim.reason === 'prepared') return this.#commit(candidate);
        if (claim.reason === 'blocked') {
          throw overviewError(`Report admission candidate is blocked: ${candidateId}`, 'REPORT_ADMISSION_BLOCKED');
        }
        if (claim.reason === 'owned') throw admissionInFlightError(candidateId);
        throw retryableAdmissionError(candidateId, latestError);
      }
      let preparedOverview;
      try {
        if (!configurationMatches) {
          throw overviewError(
            'Staged Report Overview configuration no longer matches the effective Agent configuration',
            'REPORT_OVERVIEW_CONFIG_MISMATCH',
          );
        }
        this.#assertBatchAssociation(candidate.package, {
          source: candidate.source,
          batchId: candidate.batch?.batchId || null,
          itemId: candidate.batch?.itemId || null,
        });
        this.#assertAdmissionTarget(candidate);
        preparedOverview = await this.#prepareWithHeartbeat(candidate, claim);
      } catch (error) {
        const retryable = isRetryableOverviewError(error, retryOn);
        const attemptError = safeAdmissionAttemptError(error, { retryable });
        latestError = attemptError;
        const failedAt = this.now();
        const delayMs = retryable
          ? Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** Math.max(0, candidate.attempts.length - 1)))
          : 0;
        const nextEligibleAt = new Date(Date.parse(failedAt) + delayMs).toISOString();
        candidate = this.candidateStore.markFailure(candidateId, {
          ownerToken: this.ownerToken,
          attemptId: claim.attemptId,
          error: attemptError,
          retryable,
          provenance: error?.provenance || null,
          stopReason: error?.stopReason || null,
          failedAt,
          nextEligibleAt,
        });
        if (!retryable) throw attemptError;
        if (localAttempt + 1 < maxAttempts) {
          if (delayMs > 0) await this.sleep(delayMs);
        }
        continue;
      }
      candidate = this.candidateStore.markPrepared(candidateId, {
        ownerToken: this.ownerToken,
        attemptId: claim.attemptId,
        preparedOverview,
        preparedAt: this.now(),
      });
      return this.#commit(candidate);
    }
    throw retryableAdmissionError(candidateId, latestError);
  }

  #assertAdmissionTarget(candidate) {
    const existing = this.reportLibrary.getForProcessing(candidate.reportVersionId);
    if (!existing) return;
    const expectedAdmission = {
      candidateId: candidate.candidateId,
      batch: candidate.batch,
    };
    if (
      existing.contentDigest !== candidate.contentDigest
      || existing.fingerprint !== candidate.fingerprint
      || existing.ingestion?.source !== candidate.source
      || canonicalStringify(existing.admission || null) !== canonicalStringify(expectedAdmission)
    ) {
      const error = overviewError(
        'Report admission candidate conflicts with an existing ReportVersion',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
      error.statusCode = 409;
      throw error;
    }
  }

  #assertBatchAssociation(reportPackage, { source = 'producer', batchId = null, itemId = null } = {}) {
    const binding = normalizeReportAdmissionBinding(reportPackage, { source, batchId, itemId });
    if (binding.batch === null) return binding;
    let association;
    try {
      association = this.batchStore.inspectItem(binding.batch.batchId, binding.batch.itemId);
    } catch (cause) {
      if (cause?.code === 'FILE_LOCK_TIMEOUT') {
        throw admissionInFlightError(reportAdmissionCandidateId(reportPackage), cause);
      }
      throw invalidBatchAssociationError(cause);
    }
    if (
      association.batch.batchId !== binding.batch.batchId
      || association.item.itemId !== binding.batch.itemId
      || association.item.projectId !== reportPackage.lineage.projectId
    ) {
      throw invalidBatchAssociationError();
    }
    return binding;
  }

  #assertCheckpointIdentity(checkpoint, candidateIdentity) {
    if ([
      'candidateId',
      'reportVersionId',
      'contentDigest',
      'fingerprint',
      'analysisRunId',
      'overviewConfigDigest',
    ].some((field) => checkpoint[field] !== candidateIdentity[field])) {
      const error = overviewError(
        'Report admission candidate conflicts with the durable Daily Report Batch checkpoint',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
      error.statusCode = 409;
      throw error;
    }
  }

  #markerFirstAdmissionResult(reportPackage, binding) {
    const candidate = {
      candidateId: reportAdmissionCandidateId(reportPackage),
      reportVersionId: reportVersionId(reportPackage),
      contentDigest: reportPackage.report.contentDigest,
      fingerprint: reportVersionFingerprint(reportPackage),
      analysisRunId: reportPackage.lineage.analysisRunId,
      source: binding.source,
      batch: binding.batch,
      package: reportPackage,
    };
    let admitted = this.#committedCandidateResult(candidate);
    if (!admitted) return null;
    let stored = null;
    try {
      stored = this.candidateStore.get(candidate.candidateId);
    } catch {
      // A missing or structurally corrupt diagnostic candidate cannot revoke
      // an exact authoritative Report Library marker.
    }
    if (stored?.state === REPORT_ADMISSION_CANDIDATE_STATES.ADMITTED) {
      // An intact candidate remains immutable audit evidence. The marker is
      // authoritative when that file is unavailable, but a well-formed
      // receipt that contradicts the immutable pair must still fail closed.
      admitted = this.#admittedResult(stored);
    }
    if (binding.batch !== null) {
      let current;
      try {
        current = this.batchStore.inspectItem(binding.batch.batchId, binding.batch.itemId);
      } catch (error) {
        if (error?.code === 'FILE_LOCK_TIMEOUT') {
          throw admissionInFlightError(candidate.candidateId, error);
        }
        throw error;
      }
      const checkpoint = current.item.admissionCandidate;
      if (!checkpoint) {
        const error = overviewError(
          'Authoritative Daily Report admission is missing its durable batch checkpoint',
          'REPORT_ADMISSION_CANDIDATE_CORRUPT',
        );
        error.statusCode = 409;
        throw error;
      }
      if (['candidateId', 'reportVersionId', 'contentDigest', 'fingerprint', 'analysisRunId']
        .some((field) => checkpoint[field] !== candidate[field])) {
        const error = overviewError(
          'Authoritative Daily Report admission conflicts with its durable batch checkpoint',
          'REPORT_ADMISSION_CANDIDATE_CONFLICT',
        );
        error.statusCode = 409;
        throw error;
      }
    }
    this.#repairCommittedProjections(candidate.candidateId);
    return admitted;
  }

  #checkpointedAdmissionResult(reportPackage, binding, candidateIdentity) {
    const admitted = this.#markerFirstAdmissionResult(reportPackage, binding);
    if (admitted || binding.batch === null) return admitted;
    let current;
    try {
      current = this.batchStore.inspectItem(binding.batch.batchId, binding.batch.itemId);
    } catch (error) {
      if (error?.code === 'FILE_LOCK_TIMEOUT') {
        throw admissionInFlightError(candidateIdentity.candidateId, error);
      }
      throw error;
    }
    const checkpoint = current.item.admissionCandidate;
    if (!checkpoint) return null;
    this.#assertCheckpointIdentity(checkpoint, candidateIdentity);
    return null;
  }

  #assertCandidateCreationAllowed(binding, candidateIdentity) {
    if (binding.batch === null) return;
    const current = this.batchStore.inspectItem(binding.batch.batchId, binding.batch.itemId);
    const checkpoint = current.item.admissionCandidate;
    if (checkpoint) {
      this.#assertCheckpointIdentity(checkpoint, candidateIdentity);
      const error = overviewError(
        'A checkpointed Daily Report Batch admission candidate cannot be recreated from incomplete audit state',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
      error.statusCode = 409;
      throw error;
    }
    if (current.batch.status !== 'open' || current.item.status !== 'pending') {
      const error = overviewError(
        'Daily Report Batch item cannot recreate an unavailable admission candidate after completion',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
      error.statusCode = 409;
      throw error;
    }
    return null;
  }

  #batchCandidateCheckpoint(candidateIdentity, {
    admissionAttemptId = 'admission-recovery',
    productionAttempts = [],
  } = {}) {
    return {
      candidateId: candidateIdentity.candidateId,
      analysisRunId: candidateIdentity.analysisRunId,
      reportVersionId: candidateIdentity.reportVersionId,
      contentDigest: candidateIdentity.contentDigest,
      fingerprint: candidateIdentity.fingerprint,
      overviewConfigDigest: candidateIdentity.overviewConfigDigest,
      admissionAttemptId,
      productionAttempts,
    };
  }

  #verifyCheckpointCandidate(reportPackage, binding, candidateId, readError = null) {
    const committed = this.#markerFirstAdmissionResult(reportPackage, binding);
    if (committed) {
      return deepFreeze({
        candidateId: committed.candidateId,
        reportVersionId: committed.reportVersionId,
        contentDigest: committed.contentDigest,
        fingerprint: reportVersionFingerprint(reportPackage),
        analysisRunId: reportPackage.lineage.analysisRunId,
      });
    }
    if (binding.batch === null) {
      throw readError || overviewError(
        'Report admission replay has no durable candidate',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
    }
    const current = this.batchStore.inspectItem(binding.batch.batchId, binding.batch.itemId);
    const association = current.item.admissionCandidate;
    const expected = {
      candidateId,
      reportVersionId: reportVersionId(reportPackage),
      contentDigest: reportPackage.report.contentDigest,
      fingerprint: reportVersionFingerprint(reportPackage),
      analysisRunId: reportPackage.lineage.analysisRunId,
    };
    if (!association || Object.entries(expected).some(([field, value]) => association[field] !== value)) {
      throw overviewError(
        'Report admission replay does not match its durable batch checkpoint',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
    }
    if (current.item.status === 'pending') {
      throw readError || overviewError(
        'Report admission replay has no durable candidate',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
    }
    if (current.item.status === 'succeeded' && !this.#admittedCheckpointResult(current)) {
      throw overviewError(
        'Successful Daily Report Batch admission is missing its authoritative Report Library marker',
        'REPORT_ADMISSION_CANDIDATE_CORRUPT',
      );
    }
    return deepFreeze(expected);
  }

  #checkpointBatchCandidate(candidate, {
    admissionAttemptId = 'admission-recovery',
    productionAttempts = [],
  } = {}) {
    if (candidate.batch === null) return null;
    try {
      return this.batchStore.linkAdmissionCandidate(
        candidate.batch.batchId,
        candidate.batch.itemId,
        this.#batchCandidateCheckpoint({
          candidateId: candidate.candidateId,
          analysisRunId: candidate.package.lineage.analysisRunId,
          reportVersionId: candidate.reportVersionId,
          contentDigest: candidate.contentDigest,
          fingerprint: candidate.fingerprint,
          overviewConfigDigest: candidate.overviewConfigDigest,
        }, { admissionAttemptId, productionAttempts }),
      );
    } catch (error) {
      if (error?.code === 'FILE_LOCK_TIMEOUT') {
        throw admissionInFlightError(candidate.candidateId, error);
      }
      throw error;
    }
  }

  #reconcileBatchCandidate(candidate, { admitted = null, error = null } = {}) {
    if (!candidate || candidate.batch === null) return null;
    const current = this.batchStore.inspectItem(candidate.batch.batchId, candidate.batch.itemId);
    if (current.item.status !== 'pending') return current;
    const association = current.item.admissionCandidate;
    if (!association || association.candidateId !== candidate.candidateId) {
      throw invalidBatchAssociationError();
    }
    if (admitted) {
      return this.batchStore.recordOutcome(
        candidate.batch.batchId,
        candidate.batch.itemId,
        createDailyReportAdmissionOutcome({ association, admitted }),
      );
    }
    if (!error) return current;
    return this.batchStore.recordOutcome(
      candidate.batch.batchId,
      candidate.batch.itemId,
      createDailyReportAdmissionOutcome({ association, error }),
    );
  }

  #reconcileBatchFailure(candidateId, error) {
    if (!candidateId) return { admitted: null, error };
    const current = this.batchStore.findAdmissionCandidate(candidateId);
    if (!current) return { admitted: null, error };
    if (current.item.status !== 'pending') return { admitted: null, error: null, settled: true };
    return this.#reconcileBatchCheckpoint({
      batchId: current.batch.batchId,
      itemId: current.item.itemId,
      admissionCandidate: current.item.admissionCandidate,
    }, error);
  }

  #reconcileBatchCheckpoint(checkpoint, error) {
    const current = this.batchStore.inspectItem(checkpoint.batchId, checkpoint.itemId);
    const association = current.item.admissionCandidate;
    if (!association || canonicalStringify(association) !== canonicalStringify(checkpoint.admissionCandidate)) {
      throw invalidBatchAssociationError();
    }
    let admitted = null;
    let terminalError = error;
    try {
      admitted = this.#admittedCheckpointResult(current);
    } catch (markerError) {
      terminalError = markerError;
    }
    if (current.item.status !== 'pending') {
      return { admitted: null, error: null, settled: true };
    }
    if (admitted) {
      try {
        this.#repairCommittedProjections(association.candidateId);
      } catch (repairError) {
        return { admitted: null, error: repairError, retryable: true };
      }
      this.batchStore.recordOutcome(
        current.batch.batchId,
        current.item.itemId,
        createDailyReportAdmissionOutcome({ association, admitted }),
      );
      return { admitted, error: null };
    }
    this.batchStore.recordOutcome(
      current.batch.batchId,
      current.item.itemId,
      createDailyReportAdmissionOutcome({ association, error: terminalError }),
    );
    return { admitted: null, error: terminalError };
  }

  #repairCommittedProjections(candidateId) {
    try {
      return this.reportLibrary.reconcile();
    } catch (cause) {
      throw projectionRepairPendingError(candidateId, cause);
    }
  }

  #admittedCheckpointResult(checkpoint) {
    const { batch, item } = checkpoint;
    const association = item.admissionCandidate;
    if (!association) return null;
    return this.#committedCandidateResult({
      candidateId: association.candidateId,
      reportVersionId: association.reportVersionId,
      contentDigest: association.contentDigest,
      fingerprint: association.fingerprint,
      source: 'producer',
      batch: { batchId: batch.batchId, itemId: item.itemId },
      package: {
        lineage: { projectId: item.projectId, analysisRunId: association.analysisRunId },
        dailyReport: { runId: batch.batchId },
      },
    });
  }

  #committedCandidateResult(candidate) {
    const reportVersion = this.reportLibrary.get(candidate.reportVersionId);
    if (!reportVersion) return null;
    const expectedAdmission = { candidateId: candidate.candidateId, batch: candidate.batch };
    if (
      reportVersion.reportVersionId !== candidate.reportVersionId
      || reportVersion.contentDigest !== candidate.contentDigest
      || reportVersion.fingerprint !== candidate.fingerprint
      || canonicalStringify(reportVersion.lineage) !== canonicalStringify(candidate.package.lineage)
      || canonicalStringify(reportVersion.dailyReport) !== canonicalStringify(candidate.package.dailyReport)
      || reportVersion.ingestion?.source !== candidate.source
      || canonicalStringify(reportVersion.admission) !== canonicalStringify(expectedAdmission)
    ) {
      throw overviewError(
        'Authoritative Report Library admission conflicts with its Daily Report Batch checkpoint',
        'REPORT_ADMISSION_CANDIDATE_CONFLICT',
      );
    }
    const overviewRecord = this.reportLibrary.getOverview(candidate.reportVersionId);
    const overviewStatus = this.reportLibrary.overviewStatus(candidate.reportVersionId);
    if (
      !overviewRecord
      || overviewStatus?.status !== 'ready'
      || overviewRecord.reportVersion?.reportVersionId !== candidate.reportVersionId
      || overviewRecord.reportVersion?.contentDigest !== candidate.contentDigest
      || overviewRecord.reportVersion?.fingerprint !== candidate.fingerprint
    ) {
      throw overviewError(
        'Authoritative Report Library admission has an invalid Overview binding',
        'REPORT_ADMISSION_CANDIDATE_CORRUPT',
      );
    }
    return deepFreeze({
      status: 'admitted',
      created: false,
      replayed: true,
      candidateId: candidate.candidateId,
      reportVersionId: candidate.reportVersionId,
      contentDigest: candidate.contentDigest,
      reportVersion,
      overview: {
        ...overviewStatus,
        overview: overviewRecord,
        created: false,
        replayed: true,
      },
    });
  }

  async #prepareWithHeartbeat(candidate, claim) {
    const heartbeatMs = Math.max(250, Math.floor(this.leaseMs / 3));
    let heartbeatError = null;
    const timer = setInterval(() => {
      try {
        this.candidateStore.renew(candidate.candidateId, {
          ownerToken: this.ownerToken,
          attemptId: claim.attemptId,
          renewedAt: this.now(),
          leaseMs: this.leaseMs,
        });
        heartbeatError = null;
      } catch (error) {
        heartbeatError = error;
      }
    }, heartbeatMs);
    timer.unref?.();
    try {
      const prepared = await this.overviewService.prepare(candidate.package, {
          candidateId: candidate.candidateId,
          overviewConfigDigest: candidate.overviewConfigDigest,
          attemptId: claim.attemptId,
          stagedAt: candidate.stagedAt,
        });
      if (heartbeatError) throw heartbeatError;
      return prepared;
    } finally {
      clearInterval(timer);
    }
  }

  #commit(candidate) {
    try {
      return this.candidateStore.withCandidateLock(candidate.candidateId, (lockedCandidate) => (
        this.#commitLocked(lockedCandidate)
      ));
    } catch (error) {
      let committed = null;
      try {
        committed = this.#committedCandidateResult(candidate);
      } catch {
        // Preserve the original commit failure when no exact marker can prove success.
      }
      if (committed) {
        this.#repairCommittedProjections(candidate.candidateId);
        return committed;
      }
      if (isTerminalCommitError(error)) {
        this.candidateStore.blockPrepared(candidate.candidateId, {
          error,
          blockedAt: this.now(),
        });
      }
      throw error;
    }
  }

  #commitLocked(candidate) {
    this.#assertBatchAssociation(candidate.package, {
      source: candidate.source,
      batchId: candidate.batch?.batchId || null,
      itemId: candidate.batch?.itemId || null,
    });
    this.#assertAdmissionTarget(candidate);
    const admission = this.reportLibrary.commitPreparedAdmission(candidate.candidateId);
    const overview = admission.overview;
    const receipt = {
      contract: 'report-admission-receipt.v1',
      candidateId: candidate.candidateId,
      reportVersionId: admission.reportVersionId,
      contentDigest: admission.contentDigest,
      fingerprint: candidate.fingerprint,
      overviewId: overview.overviewId,
      overviewDigest: overview.overviewDigest,
      source: candidate.source,
      batch: candidate.batch,
      admittedAt: admission.reportVersion.ingestion.admittedAt,
      admissionSequence: admission.reportVersion.admissionSequence,
      initialProcessingStatus: 'Pending',
    };
    try {
      this.candidateStore.markAdmitted(candidate.candidateId, receipt);
    } catch {
      // The immutable Report Library marker is authoritative once commit returns.
      // Candidate diagnostics can be repaired or omitted without reversing admission.
    }
    return { ...admission, candidateId: candidate.candidateId, overview };
  }

  #admittedResult(candidate) {
    const reportVersion = this.reportLibrary.get(candidate.reportVersionId);
    const overviewRecord = this.reportLibrary.getOverview(candidate.reportVersionId);
    if (!reportVersion || !overviewRecord) {
      throw overviewError('Admitted candidate is missing its ReportVersion or Overview', 'REPORT_ADMISSION_CORRUPT');
    }
    const receipt = candidate.admission;
    if (
      receipt?.candidateId !== candidate.candidateId
      || receipt.reportVersionId !== reportVersion.reportVersionId
      || receipt.contentDigest !== reportVersion.contentDigest
      || receipt.fingerprint !== reportVersion.fingerprint
      || receipt.overviewId !== overviewRecord.overviewId
      || receipt.overviewDigest !== overviewRecord.overviewDigest
      || receipt.source !== candidate.source
      || receipt.initialProcessingStatus !== 'Pending'
      || receipt.admittedAt !== reportVersion.ingestion?.admittedAt
      || receipt.admissionSequence !== reportVersion.admissionSequence
      || reportVersion.admission?.candidateId !== candidate.candidateId
      || canonicalStringify(receipt.batch) !== canonicalStringify(reportVersion.admission?.batch || null)
    ) {
      throw overviewError('Admitted candidate receipt does not match the immutable admission', 'REPORT_ADMISSION_CORRUPT');
    }
    return {
      status: 'admitted',
      created: false,
      replayed: true,
      candidateId: candidate.candidateId,
      reportVersionId: candidate.reportVersionId,
      contentDigest: candidate.contentDigest,
      reportVersion,
      overview: {
        ...this.reportLibrary.overviewStatus(candidate.reportVersionId),
        overview: overviewRecord,
        created: false,
        replayed: true,
      },
    };
  }
}

export const createReportOverviewService = (options = {}) => new ReportOverviewService(options);
export const createReportAdmissionService = (options = {}) => new ReportAdmissionService(options);
