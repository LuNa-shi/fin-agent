import fs from 'node:fs';
import path from 'node:path';

import { getEffectiveAgentDefinition } from '../../agents/AgentRuntimeService.js';
import { agentExecutionRuntime } from '../../agents/AgentExecutionRuntime.js';
import { runDefinedAgent } from '../../agents/runDefinedAgent.js';
import { AgentResultIdempotencyStore } from '../../core/agent-backend/AgentResultIdempotencyStore.js';
import { withAgentResultIdempotency } from '../../core/agent-backend/IdempotentAgentBackend.js';
import { canonicalSha256 } from '../../core/contracts/ArtifactRef.js';
import { executeWorkflowSpec } from '../../core/workflow/WorkflowExecutor.js';
import { runtime as runtimeSettings } from '../../config.js';
import {
  CanonicalWorldviewStore,
  WORLDVIEW_CAPABILITY_TOOLS,
  WorldviewCapabilityScope,
  WorldviewRunWorkspaceStore,
  normalizeWorldviewAgentResult,
  worldviewOverviewManifest,
} from '../../domains/worldview/canonical/index.js';
import { ReportLibraryStore } from '../../domains/reports/ReportLibraryStore.js';
import { ClaimStore } from '../../domains/claims/ClaimStore.js';
import { FileArtifactStore, FileEventBus, FileRunStore } from '../../project-space/index.js';
import {
  CANONICAL_WORLDVIEW_CONDITION_BINDINGS,
  CANONICAL_WORLDVIEW_HANDLER_BINDINGS,
  CANONICAL_WORLDVIEW_HYDRATION_BINDINGS,
} from './canonicalBindings.js';
import {
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
} from './canonicalWorkflowSpec.js';
import { WorldviewRunPublicationStore } from './WorldviewRunPublicationStore.js';
import { acquireCanonicalWorldviewActiveSequenceGuard } from './worldviewActiveSequenceGuard.js';

const WORLDVIEW_SCOPE = Object.freeze({ kind: 'worldview-universe', id: 'worldview-universe:canonical' });
const NODE_IDS = CANONICAL_WORLDVIEW_WORKFLOW_SPEC.nodes.map((node) => node.id);

function fail(message, code = 'CANONICAL_WORLDVIEW_PROCESSING_FAILED', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function capturedMainRoute(modelRuntime = runtimeSettings) {
  if (modelRuntime.DEMO_MODE) {
    return { provider: 'demo', model: 'deterministic-demo', reasoningLevel: 'high' };
  }
  const provider = modelRuntime.MAIN_PROVIDER || modelRuntime.DEFAULT_PROVIDER;
  const model = modelRuntime.MAIN_MODEL || (
    provider === 'deepseek'
      ? modelRuntime.DEEPSEEK_MODEL
      : modelRuntime.OPENAI_COMPATIBLE_MODEL
  );
  const reasoningLevel = provider === 'openai-compatible'
    ? (modelRuntime.OPENAI_COMPATIBLE_REASONING_LEVEL || 'high')
    : 'high';
  return { provider, model, reasoningLevel };
}

function effectiveConfigSnapshot(definition, modelRuntime = runtimeSettings) {
  const content = {
    agentId: definition.id,
    agentVersion: definition.version,
    effectiveConfigRevision: definition.effectiveConfig.revision,
    effectiveConfigDigest: definition.effectiveConfig.digest,
    modelPolicy: clone(definition.modelPolicy),
    runPolicy: clone(definition.runPolicy),
    toolPolicy: clone(definition.toolPolicy),
    capturedRoute: capturedMainRoute(modelRuntime),
    promptIdentity: {
      systemPromptDigest: canonicalSha256(definition.prompt({}).system),
      agentVersion: definition.version,
    },
    workflow: {
      id: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id,
      version: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.version,
      hash: CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
    },
  };
  return { ...content, executionConfigDigest: canonicalSha256(content) };
}

function successfulAgentOutput(result) {
  if (!result || result.status !== 'succeeded' || result.valid === false || !result.output) {
    const error = new Error(`Core Worldview Agent failed: ${result?.stopReason || result?.error?.code || 'invalid result'}`);
    error.code = result?.error?.code || 'CORE_WORLDVIEW_AGENT_FAILED';
    error.agentRunResult = result;
    throw error;
  }
  return result.output;
}

const MODEL_API_AUDIT_PHASES = new Set(['started', 'completed']);
const MODEL_API_AUDIT_STATUSES = new Set(['succeeded', 'failed', 'interrupted']);
const MODEL_API_AUDIT_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

const NON_RETRYABLE_WHOLE_AGENT_CODES = new Set([
  'EACCES',
  'EPERM',
  'CONTEXT_PERMISSION_DENIED',
  'EFFECTIVE_AGENT_CONFIG_MISMATCH',
  'MODEL_UNAVAILABLE',
  'MODEL_ROUTE_INVALID',
  'MODEL_PROVIDER_PERMANENT',
  'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_EXHAUSTED',
  'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID',
  'PI_MODEL_UNAVAILABLE',
  'PROVIDER_CREDENTIALS_MISSING',
  'RUNTIME_TOOL_POLICY_EXPANSION',
  'TOOL_PERMISSION_DENIED',
  'WORLDVIEW_COMPLETE_CLAIM_CONTEXT_TOO_LARGE',
  'WORLDVIEW_REPORT_ADMISSION_CORRUPT',
  'WORLDVIEW_REPORT_CONTENT_MISMATCH',
  'WORLDVIEW_REPORT_IDENTITY_MISMATCH',
  'WORLDVIEW_WORKSPACE_CONFLICT',
  'WORLDVIEW_WORKSPACE_CORRUPT',
]);

function retryableWholeAgentFailure(error) {
  const code = String(error?.code || '');
  return !NON_RETRYABLE_WHOLE_AGENT_CODES.has(code)
    && !code.startsWith('WORLDVIEW_WORKSPACE_')
    && !code.startsWith('CLAIM_STORAGE_')
    && !code.startsWith('WORLDVIEW_PUBLICATION_');
}

function safeAttemptFailure(error) {
  return {
    code: String(error?.code || 'CORE_WORLDVIEW_AGENT_FAILED'),
    message: String(error?.message || error || 'Core Worldview Agent failed').slice(0, 500),
  };
}

function appendModelApiAttemptAudit(currentAudit, event, { maxAttempts, recordedAt }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    fail('Frozen model API attempt bound is invalid', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
  }
  const audit = clone(Array.isArray(currentAudit) ? currentAudit : []);
  if (audit.length >= maxAttempts * 2) {
    fail('Model API attempt audit event bound was exceeded', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_EXHAUSTED', 409);
  }
  const phase = String(event?.phase || '');
  const attempt = Number(event?.attempt);
  const reportedMaxAttempts = event?.maxAttempts === undefined ? maxAttempts : Number(event.maxAttempts);
  if (
    !MODEL_API_AUDIT_PHASES.has(phase)
    || !Number.isInteger(attempt)
    || attempt < 1
    || attempt > maxAttempts
    || !Number.isInteger(reportedMaxAttempts)
    || reportedMaxAttempts !== maxAttempts
  ) {
    fail('Model API attempt audit event is invalid', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
  }
  const previous = audit.at(-1) || null;
  if (phase === 'started') {
    const expectedAttempt = Math.floor(audit.length / 2) + 1;
    if (
      audit.length % 2 !== 0
      || attempt !== expectedAttempt
      || (event?.status !== null && event?.status !== undefined)
      || (event?.code !== null && event?.code !== undefined)
      || (event?.statusCode !== null && event?.statusCode !== undefined)
    ) {
      fail('Model API attempt audit transition is invalid', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
    }
  } else if (
    audit.length % 2 !== 1
    || previous?.phase !== 'started'
    || previous.attempt !== attempt
    || !MODEL_API_AUDIT_STATUSES.has(event?.status)
  ) {
    fail('Model API attempt audit transition is invalid', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
  }
  const status = phase === 'completed' ? event.status : null;
  const rawCode = event?.code === null || event?.code === undefined ? null : String(event.code).trim();
  const rawStatusCode = event?.statusCode === null || event?.statusCode === undefined
    ? null
    : Number(event.statusCode);
  if (status === 'succeeded' && (rawCode !== null || rawStatusCode !== null)) {
    fail('Succeeded model API attempts cannot include failure metadata', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
  }
  audit.push({
    sequence: audit.length + 1,
    phase,
    attempt,
    maxAttempts,
    status,
    code: rawCode === null ? null : (MODEL_API_AUDIT_CODE.test(rawCode) ? rawCode : 'MODEL_API_ERROR'),
    statusCode: Number.isInteger(rawStatusCode) && rawStatusCode >= 100 && rawStatusCode <= 599
      ? rawStatusCode
      : null,
    recordedAt,
  });
  return audit;
}

function assertSuccessfulModelApiAttemptAudit(audit, reportedAttempts) {
  const events = Array.isArray(audit) ? audit : [];
  const pairedAttempts = events.length / 2;
  if (
    events.length % 2 !== 0
    || (events.length > 0 && events.at(-1)?.phase !== 'completed')
    || (Number.isInteger(reportedAttempts) && reportedAttempts !== pairedAttempts)
  ) {
    fail('Successful model execution has incomplete attempt audit', 'WORLDVIEW_MODEL_API_ATTEMPT_AUDIT_INVALID', 409);
  }
}

function manifestItem(reportLibrary, report, ordinal) {
  const detail = reportLibrary.getForProcessing(report.reportVersionId);
  const overview = reportLibrary.getOverview(report.reportVersionId);
  if (!detail || !overview) {
    fail(`Admitted ReportVersion ${report.reportVersionId} is incomplete`, 'WORLDVIEW_REPORT_ADMISSION_CORRUPT', 409);
  }
  return {
    ordinal,
    admissionSequence: detail.admissionSequence,
    reportVersionId: detail.reportVersionId,
    contentDigest: detail.contentDigest,
    fingerprint: detail.fingerprint,
    overviewId: overview.overviewId,
    overviewDigest: overview.overviewDigest,
    overviewContentDigest: overview.contentDigest,
    overview: clone(overview.content),
  };
}

function chunkByBounds(items, {
  maxCount,
  maxBytes,
  maxContextTokens,
  maxOutputTokens,
  maxWallClockMs,
  maxToolCalls,
}) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  let contextTokens = 0;
  let estimatedOutputTokens = 0;
  let estimatedWallClockMs = 0;
  const maxSelectableReports = maxToolCalls - 3;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.overview), 'utf8');
    const itemContextTokens = Math.ceil(itemBytes / 4);
    const itemOutputTokens = Math.max(128, Math.ceil(itemContextTokens * 0.75));
    const itemWallClockMs = 1_000;
    if (itemBytes > maxBytes) {
      fail(`Report Overview ${item.overviewId} exceeds the configured per-run byte bound`, 'WORLDVIEW_OVERVIEW_TOO_LARGE', 409);
    }
    if (itemContextTokens > maxContextTokens) {
      fail(`Report Overview ${item.overviewId} exceeds the configured per-run context bound`, 'WORLDVIEW_OVERVIEW_CONTEXT_TOO_LARGE', 409);
    }
    if (current.length && (
      current.length >= maxCount
      || current.length >= maxSelectableReports
      || bytes + itemBytes > maxBytes
      || contextTokens + itemContextTokens > maxContextTokens
      || estimatedOutputTokens + itemOutputTokens > maxOutputTokens
      || estimatedWallClockMs + itemWallClockMs > maxWallClockMs
    )) {
      chunks.push(current);
      current = [];
      bytes = 0;
      contextTokens = 0;
      estimatedOutputTokens = 0;
      estimatedWallClockMs = 0;
    }
    current.push(item);
    bytes += itemBytes;
    contextTokens += itemContextTokens;
    estimatedOutputTokens += itemOutputTokens;
    estimatedWallClockMs += itemWallClockMs;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export class CanonicalWorldviewCoordinator {
  constructor({
    dataDir,
    reportLibrary = null,
    worldviewStore = null,
    agentBackend = null,
    modelRuntime = runtimeSettings,
    now = () => new Date().toISOString(),
    maxOverviewCountPerRun = 100,
    maxOverviewBytesPerRun = 96_000,
    maxContextTokensPerRun = 32_000,
    maxOutputTokensPerRun = 32_768,
    maxWallClockMsPerRun = 600_000,
    maxToolCallsPerRun = 256,
    claimReader = null,
    claimStore = null,
    workspaceStore = null,
    publicationStore = null,
  } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('CanonicalWorldviewCoordinator dataDir is required');
    if (!modelRuntime || typeof modelRuntime !== 'object') throw new TypeError('CanonicalWorldviewCoordinator modelRuntime is required');
    if (typeof now !== 'function') throw new TypeError('CanonicalWorldviewCoordinator now must be a function');
    if (!Number.isInteger(maxOverviewCountPerRun) || maxOverviewCountPerRun < 1 || maxOverviewCountPerRun > 100) {
      throw new TypeError('maxOverviewCountPerRun must be between 1 and 100');
    }
    if (!Number.isInteger(maxOverviewBytesPerRun) || maxOverviewBytesPerRun < 1_000) {
      throw new TypeError('maxOverviewBytesPerRun must be at least 1000');
    }
    if (!Number.isInteger(maxContextTokensPerRun) || maxContextTokensPerRun < 1_000 || maxContextTokensPerRun > 400_000) {
      throw new TypeError('maxContextTokensPerRun must be between 1000 and 400000');
    }
    if (!Number.isInteger(maxOutputTokensPerRun) || maxOutputTokensPerRun < 1_000 || maxOutputTokensPerRun > 400_000) {
      throw new TypeError('maxOutputTokensPerRun must be between 1000 and 400000');
    }
    if (!Number.isInteger(maxWallClockMsPerRun) || maxWallClockMsPerRun < 1_000 || maxWallClockMsPerRun > 3_600_000) {
      throw new TypeError('maxWallClockMsPerRun must be between 1000 and 3600000');
    }
    if (!Number.isInteger(maxToolCallsPerRun) || maxToolCallsPerRun < 4 || maxToolCallsPerRun > 10_000) {
      throw new TypeError('maxToolCallsPerRun must be between 4 and 10000');
    }
    this.dataDir = path.resolve(dataDir);
    this.reportLibrary = reportLibrary || new ReportLibraryStore({ rootDir: path.join(this.dataDir, 'report-library') });
    this.worldviewStore = worldviewStore || new CanonicalWorldviewStore({ rootDir: path.join(this.dataDir, 'canonical-worldview'), now });
    this.agentBackend = agentBackend === null ? agentExecutionRuntime.resolveBackend() : agentExecutionRuntime.resolveBackend(agentBackend);
    this.modelRuntime = modelRuntime;
    this.now = now;
    this.maxOverviewCountPerRun = maxOverviewCountPerRun;
    this.maxOverviewBytesPerRun = maxOverviewBytesPerRun;
    this.maxContextTokensPerRun = maxContextTokensPerRun;
    this.maxOutputTokensPerRun = maxOutputTokensPerRun;
    this.maxWallClockMsPerRun = maxWallClockMsPerRun;
    this.maxToolCallsPerRun = maxToolCallsPerRun;
    this.claimReader = claimReader;
    this.claimStore = claimStore || new ClaimStore({
      rootDir: path.join(this.dataDir, 'claim-library'),
      now,
    });
    for (const method of ['snapshot', 'stageActions', 'publication', 'bindPublicationReader']) {
      if (typeof this.claimStore?.[method] !== 'function') {
        throw new TypeError(`CanonicalWorldviewCoordinator claimStore must expose ${method}`);
      }
    }
    this.workspaceStore = workspaceStore || new WorldviewRunWorkspaceStore({
      rootDir: path.join(this.worldviewStore.rootDir, 'run-workspaces'),
    });
    this.publicationStore = publicationStore || new WorldviewRunPublicationStore({
      rootDir: path.join(this.worldviewStore.rootDir, 'run-publications'),
      now,
    });
    this.worldviewStore.bindPublicationReader((publicationId) => this.publicationStore.isCompleted(publicationId));
    this.reportLibrary.bindProcessedReceiptReader(() => this.publicationStore.processedReceipts());
    this.claimStore.bindPublicationReader((publicationId) => {
      const publication = this.publicationStore.get(publicationId);
      return publication ? {
        publicationId,
        claimPublicationDigest: publication.claims.publicationDigest,
      } : false;
    });
    this.inFlight = new Map();
    this.sequenceTail = Promise.resolve();
    this.#recoverOrphanWorkspaces();
    this.#recoverCompletedPublications();
  }

  #recoverOrphanWorkspaces() {
    const referencedWorkspaceIds = new Set(
      this.worldviewStore.listProcessingRuns().runs.map((run) => run.workspaceId).filter(Boolean),
    );
    for (const workspaceId of this.workspaceStore.listIds()) {
      if (referencedWorkspaceIds.has(workspaceId)) continue;
      const workspace = this.workspaceStore.load(workspaceId);
      const content = workspace.content;
      this.worldviewStore.createProcessingRun({
        runId: content.runId,
        triggerId: content.triggerId,
        batchId: content.batchId,
        cycleOrdinal: content.cycleOrdinal,
        frozenBaseWorldviewVersionId: content.currentWorldview?.versionId || null,
        frozenRange: content.frozenRange,
        manifest: content.manifest,
        effectiveConfig: content.effectiveConfig,
        approvedCapabilities: content.approvedCapabilities,
        bounds: content.bounds,
        retryPolicies: content.retryPolicies,
        workspaceId: workspace.workspaceId,
        workspaceDigest: workspace.workspaceDigest,
        claimTable: content.claimTable,
        maxAttempts: content.retryPolicies.wholeAgent.maxAttempts,
        startedAt: content.createdAt,
      });
      referencedWorkspaceIds.add(workspace.workspaceId);
    }
  }

  #recoverCompletedPublications() {
    const publications = this.publicationStore.list().publications;
    if (!publications.length) return;
    this.worldviewStore.rebuildCurrent();
    this.reportLibrary.rebuildProjections();
    for (const publication of publications) {
      const run = this.worldviewStore.getProcessingRun(publication.runId);
      if (!run || run.state === 'succeeded') continue;
      const successfulAttempt = [...publication.attempts].reverse()
        .find((attempt) => attempt?.status === 'succeeded') || null;
      const claimPublication = this.claimStore.publication(publication.publicationId);
      if (!claimPublication || claimPublication.publicationDigest !== publication.claims.publicationDigest) {
        fail('Completed Worldview publication is missing its marker-bound Claim publication', 'WORLDVIEW_CLAIM_PUBLICATION_MISSING', 409);
      }
      let rationale = null;
      if (publication.worldview.outcome === 'UPDATE') {
        const version = this.worldviewStore.getVersion(publication.worldview.versionId);
        rationale = version?.updateRecord?.rationale || null;
      } else {
        const evaluation = this.worldviewStore.listEvaluations().evaluations
          .find((record) => record.evaluationId === publication.worldview.evaluationRecordId);
        rationale = evaluation?.rationale || null;
      }
      this.worldviewStore.updateProcessingRun(publication.runId, {
        state: 'succeeded',
        completedAt: publication.committedAt,
        execution: successfulAttempt ? {
          provider: successfulAttempt.provider || null,
          model: successfulAttempt.model || null,
          live: Boolean(successfulAttempt.live),
          stopReason: successfulAttempt.stopReason || null,
          attemptEvidence: {
            providerAttempts: successfulAttempt.providerAttempts ?? null,
            networkAttempts: successfulAttempt.networkAttempts ?? null,
            liveModelAttempts: successfulAttempt.liveModelAttempts ?? null,
            modelApiAttempts: successfulAttempt.modelApiAttempts ?? null,
          },
        } : run.execution,
        selectedFullReads: clone(successfulAttempt?.selectedFullReads || run.selectedFullReads || []),
        capabilityTraceCount: successfulAttempt?.capabilityTraceCount || run.capabilityTraceCount || 0,
        attempts: clone(publication.attempts),
        retryMetadata: {
          agentAttempts: publication.attempts.length,
          maxAttempts: run.retryPolicies?.wholeAgent?.maxAttempts || run.retryMetadata?.maxAttempts || 3,
          resumed: true,
        },
        outcome: publication.worldview.outcome,
        rationale,
        publicationId: publication.publicationId,
        publicationDigest: publication.publicationDigest,
        evaluationRecordId: publication.worldview.evaluationRecordId || null,
        resultingWorldviewVersionId: publication.worldview.versionId || null,
        acceptedClaimActions: clone(claimPublication.actions),
        rejectedClaimActions: clone(claimPublication.rejections),
        processedReceipts: clone(publication.receipts),
        claimActionCount: claimPublication.actions.length + claimPublication.rejections.length,
        failure: null,
      }, { at: publication.committedAt });
    }
  }

  processTrigger(trigger) {
    if (!trigger || trigger.contract !== 'worldview-processing-trigger.v1') {
      return Promise.reject(Object.assign(new TypeError('worldview-processing-trigger.v1 is required'), { code: 'INVALID_WORLDVIEW_TRIGGER' }));
    }
    if (trigger.status === 'no-work') {
      return Promise.resolve({ triggerId: trigger.triggerId, batchId: trigger.batchId, status: 'no-work', runs: [] });
    }
    if (trigger.status !== 'requested') {
      return Promise.reject(Object.assign(new TypeError('Worldview trigger status must be requested or no-work'), { code: 'INVALID_WORLDVIEW_TRIGGER' }));
    }
    if (this.inFlight.has(trigger.triggerId)) return this.inFlight.get(trigger.triggerId);
    const promise = this.sequenceTail.catch(() => {}).then(() => this.#processTrigger(trigger));
    this.sequenceTail = promise;
    this.inFlight.set(trigger.triggerId, promise);
    promise.finally(() => {
      if (this.inFlight.get(trigger.triggerId) === promise) this.inFlight.delete(trigger.triggerId);
    }).catch(() => {});
    return promise;
  }

  async resumeTriggers(triggers = []) {
    if (!Array.isArray(triggers)) throw new TypeError('resumeTriggers requires an array');
    const ordered = [...triggers].sort((left, right) => String(left?.publishedAt || '').localeCompare(String(right?.publishedAt || '')));
    const outcomes = [];
    for (const trigger of ordered) {
      const priorRuns = this.worldviewStore.listProcessingRuns().runs
        .filter((run) => run.triggerId === trigger?.triggerId);
      if (priorRuns.some((run) => ['FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(run.state))) {
        outcomes.push({ triggerId: trigger.triggerId, status: 'failed-awaiting-later-trigger' });
        continue;
      }
      try {
        outcomes.push(await this.processTrigger(trigger));
      } catch (error) {
        outcomes.push({
          triggerId: trigger?.triggerId || null,
          status: 'failed',
          failure: { code: error?.code || 'WORLDVIEW_TRIGGER_RECOVERY_FAILED' },
        });
      }
    }
    return outcomes;
  }

  async #processTrigger(trigger) {
    const release = this.#acquireSequence(trigger.triggerId);
    try {
      this.reportLibrary.rebuildProjections();
      const priorRuns = this.worldviewStore.listProcessingRuns().runs;
      const completedRun = priorRuns.find((run) => (
        run.triggerId === trigger.triggerId
        && run.batchId === trigger.batchId
        && run.state === 'succeeded'
      ));
      if (completedRun) {
        return {
          triggerId: trigger.triggerId,
          batchId: trigger.batchId,
          status: 'succeeded',
          runs: [this.#runSummary(completedRun)],
          processedReceiptCount: this.publicationStore.processedReceipts().length,
        };
      }
      const blockingRun = priorRuns
        .find((run) => ['FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(run.state));
      if (blockingRun) {
        fail(
          `Worldview processing is blocked by frozen workspace ${blockingRun.workspaceId}`,
          'WORLDVIEW_FROZEN_WORKSPACE_BLOCKED',
          409,
        );
      }
      const resumableRun = priorRuns.find((run) => (
        run.triggerId === trigger.triggerId
        && run.batchId === trigger.batchId
        && !['succeeded', 'FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(run.state)
      ));
      const oldestUnfinishedRun = priorRuns.find((run) => (
        !['succeeded', 'FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(run.state)
      ));
      if (oldestUnfinishedRun && oldestUnfinishedRun.runId !== resumableRun?.runId) {
        fail(
          `Worldview processing is blocked by frozen workspace ${oldestUnfinishedRun.workspaceId}`,
          'WORLDVIEW_FROZEN_WORKSPACE_BLOCKED',
          409,
        );
      }
      const resumableWorkspace = resumableRun ? this.workspaceStore.load(resumableRun.workspaceId) : null;
      let selectedItems = resumableWorkspace?.content?.manifest?.items || null;
      if (!selectedItems) {
        const frozenCandidates = this.reportLibrary.listPendingReports().reports
          .sort((left, right) => left.admissionSequence - right.admissionSequence)
          .slice(0, 100);
        if (!frozenCandidates.length) {
          return {
            triggerId: trigger.triggerId,
            batchId: trigger.batchId,
            status: 'no-work',
            runs: [],
            processedReceiptCount: this.publicationStore.processedReceipts().length,
          };
        }
        const items = frozenCandidates.map((report, index) => manifestItem(this.reportLibrary, report, index));
        [selectedItems] = chunkByBounds(items, {
          maxCount: this.maxOverviewCountPerRun,
          maxBytes: this.maxOverviewBytesPerRun,
          maxContextTokens: this.maxContextTokensPerRun,
          maxOutputTokens: this.maxOutputTokensPerRun,
          maxWallClockMs: this.maxWallClockMsPerRun,
          maxToolCalls: this.maxToolCallsPerRun,
        });
      }
      const completedRunCount = this.worldviewStore.listProcessingRuns().runs
        .filter((run) => run.triggerId === trigger.triggerId && run.state === 'succeeded')
        .length;
      const runs = [await this.#processRun({
        trigger,
        cycleOrdinal: resumableRun?.cycleOrdinal ?? completedRunCount,
        items: selectedItems,
        existingLog: resumableRun || null,
      })];
      return {
        triggerId: trigger.triggerId,
        batchId: trigger.batchId,
        status: 'succeeded',
        runs,
        processedReceiptCount: this.publicationStore.processedReceipts().length,
      };
    } finally {
      release();
    }
  }

  async #processRun({ trigger, cycleOrdinal, items, existingLog: suppliedExistingLog = null }) {
    let manifest = worldviewOverviewManifest(items.map((item, ordinal) => ({ ...item, ordinal })));
    let currentProjection = this.worldviewStore.current();
    let frozenCurrent = currentProjection ? this.worldviewStore.getVersion(currentProjection.versionId) : null;
    let frozenRange = {
      priorProcessedReceiptCount: this.publicationStore.processedReceipts().length,
      startAdmissionSequence: manifest.items[0].admissionSequence,
      endAdmissionSequence: manifest.items.at(-1).admissionSequence,
    };
    const definition = getEffectiveAgentDefinition('core-worldview');
    let effectiveConfig = effectiveConfigSnapshot(definition, this.modelRuntime);
    const runId = suppliedExistingLog?.runId || `worldview_run_${canonicalSha256({
      triggerId: trigger.triggerId,
      cycleOrdinal,
      baseWorldviewVersionId: currentProjection?.versionId || null,
      frozenRange,
      manifestDigest: manifest.manifestDigest,
      effectiveConfigDigest: effectiveConfig.effectiveConfigDigest,
    }).slice('sha256:'.length)}`;
    const existingLog = suppliedExistingLog || this.worldviewStore.getProcessingRun(runId);
    if (existingLog?.state === 'succeeded') return this.#runSummary(existingLog);
    if (['FAILED_EXHAUSTED', 'FAILED_CLOSED'].includes(existingLog?.state)) {
      fail(
        `Worldview Agent Run already failed and requires a later Daily Report Batch trigger: ${existingLog.failure?.code || runId}`,
        'WORLDVIEW_RUN_REQUIRES_NEW_TRIGGER',
        409,
      );
    }

    const runRoot = this.worldviewStore.workflowRunDir(runId);
    fs.mkdirSync(runRoot, { recursive: true });
    let frozenAt;
    let capabilityScopeId;
    let frozenClaims;
    let claimTable;
    let bounds;
    let retryPolicies;
    let workspace;
    if (existingLog) {
      workspace = this.workspaceStore.load(existingLog.workspaceId);
      if (!workspace || workspace.workspaceDigest !== existingLog.workspaceDigest) {
        fail('Frozen Worldview workspace is missing or changed during restart', 'WORLDVIEW_WORKSPACE_CORRUPT', 409);
      }
      if (
        workspace.content.runId !== runId
        || workspace.content.triggerId !== trigger.triggerId
        || workspace.content.batchId !== trigger.batchId
        || workspace.content.manifest.manifestDigest !== manifest.manifestDigest
      ) {
        fail('Frozen Worldview workspace conflicts with the resumed trigger', 'WORLDVIEW_WORKSPACE_CONFLICT', 409);
      }
      ({ manifest, currentWorldview: frozenCurrent, frozenRange, effectiveConfig, capabilityScopeId,
        claims: frozenClaims, claimTable, bounds, retryPolicies } = workspace.content);
      manifest = clone(manifest);
      frozenCurrent = frozenCurrent === null ? null : clone(frozenCurrent);
      frozenRange = clone(frozenRange);
      effectiveConfig = clone(effectiveConfig);
      frozenClaims = clone(frozenClaims);
      claimTable = clone(claimTable);
      bounds = clone(bounds);
      retryPolicies = clone(retryPolicies);
      frozenAt = workspace.content.createdAt;
      currentProjection = frozenCurrent ? { versionId: frozenCurrent.versionId } : null;
    } else {
      frozenAt = this.now();
      capabilityScopeId = `worldview_scope_${canonicalSha256({ runId, manifestDigest: manifest.manifestDigest }).slice('sha256:'.length)}`;
      const claimSnapshot = this.claimStore.snapshot();
      frozenClaims = clone(claimSnapshot.claims);
      claimTable = clone(claimSnapshot.table);
      bounds = {
        maxOverviewCountPerRun: this.maxOverviewCountPerRun,
        maxOverviewBytesPerRun: this.maxOverviewBytesPerRun,
        maxContextTokensPerRun: this.maxContextTokensPerRun,
        maxOutputTokensPerRun: this.maxOutputTokensPerRun,
        maxWallClockMsPerRun: this.maxWallClockMsPerRun,
        maxToolCallsPerRun: this.maxToolCallsPerRun,
        estimatedOutputTokensPerOverviewFloor: 128,
        estimatedWallClockMsPerOverview: 1_000,
      };
      retryPolicies = {
        wholeAgent: { maxAttempts: 3 },
        modelApi: { maxAttempts: 5 },
      };
      const overviewContextTokens = manifest.items.reduce(
        (total, item) => total + Math.ceil(Buffer.byteLength(JSON.stringify(item.overview), 'utf8') / 4),
        0,
      );
      const claimTableContextTokens = Math.ceil(Buffer.byteLength(JSON.stringify(claimTable), 'utf8') / 4);
      if (overviewContextTokens + claimTableContextTokens > bounds.maxContextTokensPerRun) {
        fail(
          `Frozen Overview and complete Claim table context exceeds ${bounds.maxContextTokensPerRun} tokens`,
          'WORLDVIEW_COMPLETE_CLAIM_CONTEXT_TOO_LARGE',
          409,
        );
      }
      workspace = this.workspaceStore.freeze({
        runId,
        triggerId: trigger.triggerId,
        batchId: trigger.batchId,
        cycleOrdinal,
        createdAt: frozenAt,
        asOf: frozenAt,
        frozenRange,
        manifest,
        currentWorldview: frozenCurrent,
        claims: frozenClaims,
        claimTable,
        effectiveConfig,
        promptIdentity: effectiveConfig.promptIdentity,
        retryPolicies,
        bounds,
        capabilityScopeId,
        approvedCapabilities: [...WORLDVIEW_CAPABILITY_TOOLS],
      });
    }
    const frozenInput = {
      runId,
      triggerId: trigger.triggerId,
      batchId: trigger.batchId,
      cycleOrdinal,
      frozenBaseWorldviewVersionId: frozenCurrent?.versionId || null,
      frozenRange,
      manifest,
      effectiveConfig,
      capabilityScopeId,
      approvedCapabilities: clone(workspace.content.approvedCapabilities),
      bounds,
      retryPolicies,
      workspaceId: workspace.workspaceId,
      workspaceDigest: workspace.workspaceDigest,
      claimTable,
    };
    this.worldviewStore.createProcessingRun({
      ...frozenInput,
      maxAttempts: retryPolicies.wholeAgent.maxAttempts,
      startedAt: frozenAt,
    });
    this.worldviewStore.updateProcessingRun(runId, { state: 'running' });

    const eventBus = new FileEventBus({ projectId: WORLDVIEW_SCOPE.id, storageDir: runRoot, now: this.now });
    const runStore = new FileRunStore({ projectId: WORLDVIEW_SCOPE.id, storageDir: runRoot, eventBus, now: this.now });
    const artifactStore = new FileArtifactStore({ projectId: WORLDVIEW_SCOPE.id, storageDir: runRoot, eventBus, now: this.now });
    const runAgentBackend = withAgentResultIdempotency(this.agentBackend, {
      store: new AgentResultIdempotencyStore({ rootDir: path.join(runRoot, '.agent-result-idempotency') }),
    });
    const inputDigest = canonicalSha256(frozenInput);
    const existingRun = runStore.load(runId);
    const runRecord = runStore.begin({
      runId,
      workflowSpec: {
        id: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id,
        version: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.version,
        hash: CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
      },
      inputDigest,
      asOf: frozenAt,
      nodeIds: NODE_IDS,
      scope: WORLDVIEW_SCOPE,
      workspaceMode: 'none',
      workspaceSnapshotId: `none:${runId}`,
    });
    if (existingRun && existingRun.status !== 'SUCCEEDED' && existingRun.status !== 'BLOCKED') runStore.prepareResume(runId);

    const context = {
      spec: CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
      runId,
      asOf: runRecord.asOf,
      trigger,
      frozenInput,
      workspace,
      manifest,
      frozenCurrent,
      capabilities: null,
      selectedFullReads: [],
      capabilityTraceCount: 0,
      effectiveConfig,
      frozenRange,
      services: this.#services(),
      runStore,
      eventBus,
      artifactStore,
      worldviewStore: this.worldviewStore,
      reportLibrary: this.reportLibrary,
      resumed: Boolean(existingLog),
    };
    try {
      await executeWorkflowSpec({
        spec: CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
        handlers: CANONICAL_WORLDVIEW_HANDLER_BINDINGS,
        hydrators: CANONICAL_WORLDVIEW_HYDRATION_BINDINGS,
        conditions: CANONICAL_WORLDVIEW_CONDITION_BINDINGS,
        context,
        runStore,
        runId,
        agentRuntime: agentExecutionRuntime,
        agentBackend: runAgentBackend,
        nodeInputDigest: ({ node }) => canonicalSha256({ runId, nodeId: node.id, inputDigest }),
        retryPolicyForNode: () => ({ maxAttempts: 1, retryOn: [] }),
        workspaceSnapshotForNode: () => `none:${runId}`,
        onNodeComplete: ({ context: current, node, result, dependencyArtifactRefs }) => {
          const nodeRecord = current.runStore.load(runId).nodes[node.id];
          const ref = current.artifactStore.commit({
            artifactId: `${runId}:${node.id}`,
            path: `outputs/${node.id}.json`,
            schemaVersion: `${node.id}.output.v1`,
            producer: `${CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id}/${node.handlerId}`,
            contractVersion: '1.0.0',
            content: result,
            runId,
            nodeId: node.id,
            idempotencyKey: `${runId}:${node.id}:completion:${nodeRecord.attempt}`,
            inputDigest: nodeRecord.inputDigest,
            inputArtifactRefs: dependencyArtifactRefs,
            asOf: runRecord.asOf,
          });
          return { output: result, artifacts: [ref] };
        },
      });
      runStore.completeRun(runId);
      this.reportLibrary.rebuildProjections();
      const executionNode = runStore.load(runId).nodes['execute-core-worldview-attempts'];
      const publication = context.publication || {};
      const completed = this.worldviewStore.updateProcessingRun(runId, {
        state: 'succeeded',
        execution: clone(context.agentExecution || null),
        selectedFullReads: clone(context.selectedFullReads),
        capabilityTraceCount: context.capabilityTraceCount,
        attempts: clone(context.attempts || []),
        retryMetadata: {
          agentAttempts: context.attempts?.length || executionNode?.attempt || 1,
          maxAttempts: context.frozenInput.retryPolicies.wholeAgent.maxAttempts,
          resumed: Boolean(existingRun),
        },
        outcome: context.validatedResult.worldview.action,
        rationale: context.validatedResult.worldview.rationale,
        publicationId: publication.publicationId || null,
        publicationDigest: publication.publicationDigest || null,
        evaluationRecordId: publication.worldview?.evaluationRecordId || null,
        resultingWorldviewVersionId: publication.worldview?.versionId || null,
        acceptedClaimActions: clone(publication.acceptedClaimActions || []),
        rejectedClaimActions: clone(publication.rejectedClaimActions || []),
        processedReceipts: clone(publication.processedReceipts || []),
        claimActionCount: context.validatedResult.claimActions.length,
        failure: null,
      });
      return this.#runSummary(completed);
    } catch (error) {
      const executionNode = runStore.load(runId)?.nodes?.['execute-core-worldview-attempts'];
      if (context.stagedPublicationId && this.publicationStore.isCompleted(context.stagedPublicationId)) {
        const committed = this.publicationStore.get(context.stagedPublicationId);
        this.worldviewStore.rebuildCurrent();
        this.reportLibrary.rebuildProjections();
        const claimPublication = this.claimStore.publication(context.stagedPublicationId);
        if (!claimPublication || claimPublication.publicationDigest !== committed.claims.publicationDigest) {
          fail('Completed Worldview publication is missing its marker-bound Claim publication', 'WORLDVIEW_CLAIM_PUBLICATION_MISSING', 409);
        }
        const recoveredPublication = {
          publicationId: committed.publicationId,
          publicationDigest: committed.publicationDigest,
          worldview: clone(committed.worldview),
          acceptedClaimActions: clone(claimPublication.actions),
          rejectedClaimActions: clone(claimPublication.rejections),
          claimVersions: clone(claimPublication.claims),
          processedReceipts: clone(committed.receipts),
        };
        const recovered = this.worldviewStore.updateProcessingRun(runId, {
          state: 'succeeded',
          execution: clone(context.agentExecution || null),
          selectedFullReads: clone(context.selectedFullReads || []),
          capabilityTraceCount: context.capabilityTraceCount || 0,
          attempts: clone(context.attempts || []),
          retryMetadata: {
            agentAttempts: context.attempts?.length || executionNode?.attempt || 1,
            maxAttempts: context.frozenInput.retryPolicies.wholeAgent.maxAttempts,
            resumed: true,
          },
          outcome: context.validatedResult.worldview.action,
          rationale: context.validatedResult.worldview.rationale,
          publicationId: recoveredPublication.publicationId,
          publicationDigest: recoveredPublication.publicationDigest,
          evaluationRecordId: recoveredPublication.worldview?.evaluationRecordId || null,
          resultingWorldviewVersionId: recoveredPublication.worldview?.versionId || null,
          acceptedClaimActions: recoveredPublication.acceptedClaimActions,
          rejectedClaimActions: recoveredPublication.rejectedClaimActions,
          processedReceipts: recoveredPublication.processedReceipts,
          claimActionCount: context.validatedResult.claimActions.length,
          failure: null,
        });
        return this.#runSummary(recovered);
      }
      this.worldviewStore.updateProcessingRun(runId, {
        state: error?.code === 'WORLDVIEW_AGENT_ATTEMPTS_EXHAUSTED' ? 'FAILED_EXHAUSTED' : 'FAILED_CLOSED',
        selectedFullReads: clone(context.selectedFullReads || []),
        capabilityTraceCount: context.capabilityTraceCount || 0,
        attempts: clone(context.attempts || []),
        retryMetadata: {
          agentAttempts: context.attempts?.length || executionNode?.attempt || 0,
          maxAttempts: context.frozenInput.retryPolicies.wholeAgent.maxAttempts,
          resumed: Boolean(existingRun),
        },
        outcome: null,
        rationale: null,
        failure: error,
      });
      throw error;
    }
  }

  #services() {
    return {
      freezeWorldviewRun: async (context) => clone(context.frozenInput),
      executeCoreWorldviewAttempts: async (context) => {
        const overviews = context.manifest.items.map((item) => ({
          ordinal: item.ordinal,
          admissionSequence: item.admissionSequence,
          reportVersionId: item.reportVersionId,
          contentDigest: item.contentDigest,
          fingerprint: item.fingerprint,
          overviewId: item.overviewId,
          overviewDigest: item.overviewDigest,
          overviewContentDigest: item.overviewContentDigest,
          overview: clone(item.overview),
        }));
        const maxAttempts = context.frozenInput.retryPolicies.wholeAgent.maxAttempts;
        const persistedRun = this.worldviewStore.getProcessingRun(context.runId);
        context.attempts = clone(persistedRun?.attempts || []);
        const persistedSuccess = [...context.attempts].reverse().find((attempt) => attempt.status === 'succeeded');
        if (persistedSuccess) {
          const recovery = persistedRun?.attemptRecovery;
          if (!recovery?.agentResult || !recovery?.validatedResult || !recovery?.execution) {
            fail('Succeeded Core attempt recovery payload is missing', 'WORLDVIEW_ATTEMPT_RECOVERY_MISSING', 409);
          }
          context.agentResult = clone(recovery.agentResult);
          context.validatedResult = clone(recovery.validatedResult);
          context.agentExecution = clone(recovery.execution);
          context.selectedFullReads = clone(persistedSuccess.selectedFullReads || []);
          context.capabilityTraceCount = persistedSuccess.capabilityTraceCount || 0;
          return {
            agentResult: clone(context.agentResult),
            validatedResult: clone(context.validatedResult),
            execution: clone(context.agentExecution),
            attempts: clone(context.attempts),
          };
        }
        const interruptedAttemptIndex = context.attempts.findIndex((attempt) => attempt.status === 'running');
        if (interruptedAttemptIndex !== -1) {
          const interruptedAttempt = context.attempts[interruptedAttemptIndex];
          context.attempts[interruptedAttemptIndex] = {
            ...interruptedAttempt,
            status: 'failed',
            stopReason: 'process-interrupted',
            failure: { code: 'WORLDVIEW_PROCESS_INTERRUPTED', message: 'Complete Agent attempt was interrupted by process restart' },
          };
          this.worldviewStore.updateProcessingRun(context.runId, {
            state: 'running',
            attempts: clone(context.attempts),
            retryMetadata: { agentAttempts: context.attempts.length, maxAttempts, resumed: true },
          });
        }
        let lastError = null;
        for (let attempt = context.attempts.length + 1; attempt <= maxAttempts; attempt += 1) {
          const verifiedWorkspace = this.workspaceStore.load(context.workspace.workspaceId);
          if (!verifiedWorkspace || verifiedWorkspace.workspaceDigest !== context.workspace.workspaceDigest) {
            fail('Frozen Worldview workspace changed before Agent execution', 'WORLDVIEW_WORKSPACE_CORRUPT', 409);
          }
          context.workspace = verifiedWorkspace;
          const attemptId = `attempt-${attempt}`;
          const attemptScopeId = `worldview_scope_${canonicalSha256({
            workspaceId: context.workspace.workspaceId,
            attemptId,
          }).slice('sha256:'.length)}`;
          const capabilities = new WorldviewCapabilityScope({
            scopeId: attemptScopeId,
            runId: context.runId,
            manifest: context.workspace.content.manifest,
            frozenCurrent: context.workspace.content.currentWorldview,
            reportLibrary: this.reportLibrary,
            tracePath: path.join(
              this.worldviewStore.workflowRunDir(context.runId),
              'attempts',
              attemptId,
              'capability-trace.jsonl',
            ),
            now: this.now,
            claimReader: () => clone(context.workspace.content.claimTable),
          });
          const release = capabilities.activate();
          let result = null;
          context.attempts.push({
            attemptId,
            attempt,
            status: 'running',
            workspaceId: context.workspace.workspaceId,
            workspaceDigest: context.workspace.workspaceDigest,
            capabilityScopeId: attemptScopeId,
            provider: null,
            model: null,
            live: false,
            stopReason: null,
            modelApiRetry: clone(context.frozenInput.retryPolicies.modelApi),
            providerAttempts: null,
            networkAttempts: null,
            liveModelAttempts: null,
            modelApiAttempts: null,
            modelApiAttemptAudit: [],
            selectedFullReads: [],
            capabilityTraceCount: 0,
            failure: null,
          });
          this.worldviewStore.updateProcessingRun(context.runId, {
            state: 'running',
            attempts: clone(context.attempts),
            retryMetadata: { agentAttempts: attempt, maxAttempts, resumed: Boolean(context.resumed) },
          });
          try {
            result = await runDefinedAgent('core-worldview', {
              runId: context.runId,
              asOf: context.asOf,
              capabilityScopeId: attemptScopeId,
              baseWorldviewVersionId: context.frozenInput.frozenBaseWorldviewVersionId,
              frozenRange: context.frozenRange,
              overviewManifestDigest: context.manifest.manifestDigest,
              overviews,
              approvedCapabilities: context.frozenInput.approvedCapabilities,
              currentClaims: context.frozenInput.claimTable,
            }, {
              callId: `core-worldview:${context.workspace.workspaceDigest}:${attemptId}`,
              expectedEffectiveConfigDigest: context.effectiveConfig.effectiveConfigDigest,
              worldviewCapabilities: capabilities,
              beforeToolExecution: (request) => capabilities.authorizeTool(request),
              deadlineMs: context.frozenInput.bounds.maxWallClockMsPerRun,
              tokenBudget: context.frozenInput.bounds.maxContextTokensPerRun + context.frozenInput.bounds.maxOutputTokensPerRun,
              toolCallBudget: context.frozenInput.bounds.maxToolCallsPerRun,
              kind: 'canonical-worldview',
              modelApiRetry: clone(context.frozenInput.retryPolicies.modelApi),
              onModelApiAttempt: (modelAttempt) => {
                const currentAttempt = context.attempts[attempt - 1];
                if (!currentAttempt || currentAttempt.attemptId !== attemptId) {
                  fail('Whole-Agent attempt audit changed during model execution', 'WORLDVIEW_ATTEMPT_AUDIT_CONFLICT', 409);
                }
                const modelApiAttemptAudit = appendModelApiAttemptAudit(
                  currentAttempt.modelApiAttemptAudit,
                  modelAttempt,
                  {
                    maxAttempts: context.frozenInput.retryPolicies.modelApi.maxAttempts,
                    recordedAt: this.now(),
                  },
                );
                const latestModelApiEvent = modelApiAttemptAudit.at(-1);
                context.attempts[attempt - 1] = {
                  ...currentAttempt,
                  modelApiAttempts: Math.max(
                    Number(currentAttempt.modelApiAttempts) || 0,
                    latestModelApiEvent.attempt,
                  ),
                  modelApiLastStatus: latestModelApiEvent.status || latestModelApiEvent.phase,
                  modelApiLastCode: latestModelApiEvent.code,
                  modelApiLastStatusCode: latestModelApiEvent.statusCode,
                  modelApiAttemptAudit,
                };
                this.worldviewStore.updateProcessingRun(context.runId, {
                  state: 'running',
                  attempts: clone(context.attempts),
                  retryMetadata: { agentAttempts: attempt, maxAttempts, resumed: Boolean(context.resumed) },
                });
              },
              ...(context.effectiveConfig.capturedRoute.provider === 'demo' ? {} : {
                provider: context.effectiveConfig.capturedRoute.provider,
                model: context.effectiveConfig.capturedRoute.model,
                reasoningLevel: context.effectiveConfig.capturedRoute.reasoningLevel,
              }),
              throwOnFailure: false,
            });
            const agentResult = successfulAgentOutput(result);
            if (!capabilities.overviewEnumerationComplete()) {
              fail('Core Worldview Agent did not enumerate every frozen Overview', 'WORLDVIEW_OVERVIEW_ENUMERATION_INCOMPLETE', 409);
            }
            if (context.frozenCurrent && !capabilities.currentWorldviewRead()) {
              fail('Core Worldview Agent did not read the complete frozen current Worldview', 'WORLDVIEW_CURRENT_READ_REQUIRED', 409);
            }
            const validatedResult = normalizeWorldviewAgentResult(agentResult, {
              baseWorldviewVersionId: context.frozenInput.frozenBaseWorldviewVersionId,
              manifest: context.manifest,
              selectedFullReads: capabilities.selectedFullReads(),
            });
            const metrics = clone(result.metrics || {});
            const auditedAttempt = context.attempts[attempt - 1];
            const reportedModelApiAttempts = Number.isInteger(metrics.modelApiAttempts)
              ? metrics.modelApiAttempts
              : (Number.isInteger(metrics.providerAttempts) ? metrics.providerAttempts : null);
            assertSuccessfulModelApiAttemptAudit(
              auditedAttempt?.modelApiAttemptAudit,
              reportedModelApiAttempts,
            );
            const modelApiAttempts = Math.max(
              reportedModelApiAttempts ?? 0,
              Number(auditedAttempt?.modelApiAttempts) || 0,
            );
            const execution = {
              provider: result.provider || null,
              model: result.model || null,
              live: Boolean(result.live),
              stopReason: result.stopReason || null,
              attemptEvidence: {
                providerAttempts: Number.isInteger(metrics.providerAttempts)
                  ? metrics.providerAttempts
                  : (result.provider === 'demo' ? 0 : null),
                networkAttempts: Number.isInteger(metrics.networkAttempts)
                  ? metrics.networkAttempts
                  : (result.provider === 'demo' ? 0 : null),
                liveModelAttempts: Number.isInteger(metrics.liveModelAttempts)
                  ? metrics.liveModelAttempts
                  : (result.live ? 1 : 0),
                modelApiAttempts,
              },
            };
            context.attempts[attempt - 1] = {
              ...auditedAttempt,
              attemptId,
              attempt,
              status: 'succeeded',
              workspaceId: context.workspace.workspaceId,
              workspaceDigest: context.workspace.workspaceDigest,
              capabilityScopeId: attemptScopeId,
              provider: execution.provider,
              model: execution.model,
              live: execution.live,
              stopReason: execution.stopReason,
              modelApiRetry: clone(context.frozenInput.retryPolicies.modelApi),
              providerAttempts: execution.attemptEvidence.providerAttempts,
              networkAttempts: execution.attemptEvidence.networkAttempts,
              liveModelAttempts: execution.attemptEvidence.liveModelAttempts,
              modelApiAttempts: execution.attemptEvidence.modelApiAttempts,
              selectedFullReads: capabilities.selectedFullReads(),
              capabilityTraceCount: capabilities.trace().length,
              failure: null,
            };
            context.agentRunResult = result;
            context.agentResult = agentResult;
            context.validatedResult = validatedResult;
            context.agentExecution = execution;
            context.capabilities = capabilities;
            context.selectedFullReads = capabilities.selectedFullReads();
            context.capabilityTraceCount = capabilities.trace().length;
            this.worldviewStore.updateProcessingRun(context.runId, {
              state: 'running',
              attempts: clone(context.attempts),
              attemptRecovery: {
                agentResult: clone(agentResult),
                validatedResult: clone(validatedResult),
                execution: clone(execution),
              },
              retryMetadata: { agentAttempts: attempt, maxAttempts, resumed: Boolean(context.resumed) },
            });
            return {
              agentResult: clone(agentResult),
              validatedResult: clone(validatedResult),
              execution: clone(execution),
              attempts: clone(context.attempts),
            };
          } catch (error) {
            lastError = error;
            const metrics = clone(result?.metrics || {});
            const auditedAttempt = context.attempts[attempt - 1];
            context.attempts[attempt - 1] = {
              ...auditedAttempt,
              attemptId,
              attempt,
              status: 'failed',
              workspaceId: context.workspace.workspaceId,
              workspaceDigest: context.workspace.workspaceDigest,
              capabilityScopeId: attemptScopeId,
              provider: result?.provider || null,
              model: result?.model || null,
              live: Boolean(result?.live),
              stopReason: result?.stopReason || error?.stopReason || 'error',
              modelApiRetry: clone(context.frozenInput.retryPolicies.modelApi),
              providerAttempts: Number.isInteger(metrics.providerAttempts) ? metrics.providerAttempts : null,
              networkAttempts: Number.isInteger(metrics.networkAttempts) ? metrics.networkAttempts : null,
              liveModelAttempts: Number.isInteger(metrics.liveModelAttempts)
                ? metrics.liveModelAttempts
                : (auditedAttempt?.liveModelAttempts ?? null),
              modelApiAttempts: Number.isInteger(metrics.modelApiAttempts)
                ? Math.max(metrics.modelApiAttempts, Number(auditedAttempt?.modelApiAttempts) || 0)
                : (Number.isInteger(metrics.providerAttempts)
                  ? Math.max(metrics.providerAttempts, Number(auditedAttempt?.modelApiAttempts) || 0)
                  : (auditedAttempt?.modelApiAttempts ?? null)),
              selectedFullReads: capabilities.selectedFullReads(),
              capabilityTraceCount: capabilities.trace().length,
              failure: safeAttemptFailure(error),
            };
            this.worldviewStore.updateProcessingRun(context.runId, {
              state: 'running',
              attempts: clone(context.attempts),
              retryMetadata: { agentAttempts: attempt, maxAttempts, resumed: Boolean(context.resumed) },
            });
            if (!retryableWholeAgentFailure(error)) throw error;
          } finally {
            release();
          }
        }
        const exhausted = new Error(`Core Worldview Agent exhausted ${maxAttempts} complete attempts`);
        exhausted.code = 'WORLDVIEW_AGENT_ATTEMPTS_EXHAUSTED';
        exhausted.cause = lastError;
        throw exhausted;
      },
      validateWorldviewAndClaimActions: async (context) => {
        if (!context.validatedResult) {
          fail('Core Worldview Agent result was not mechanically validated', 'WORLDVIEW_RESULT_NOT_VALIDATED', 409);
        }
        return { validatedResult: clone(context.validatedResult) };
      },
      stageRunPublication: async (context) => {
        context.publicationIntent = {
          action: context.validatedResult.worldview.action,
          rationale: context.validatedResult.worldview.rationale,
        };
        return clone(context.publicationIntent);
      },
      commitRunPublication: async (context) => {
        const publicationId = this.publicationStore.publicationId({
          runId: context.runId,
          workspaceDigest: context.workspace.workspaceDigest,
        });
        const common = {
          publicationId,
          runId: context.runId,
          triggerId: context.trigger.triggerId,
          batchId: context.trigger.batchId,
          frozenRange: context.frozenRange,
          selectedFullReads: context.selectedFullReads,
          effectiveConfig: context.effectiveConfig,
        };
        const worldviewPublication = context.validatedResult.worldview.action === 'UPDATE'
          ? context.worldviewStore.publishUpdate({
            ...common,
            manifest: context.manifest,
            agentResult: context.validatedResult,
            publishedAt: context.asOf,
            updateCurrent: false,
          })
          : context.worldviewStore.recordEvaluation({
            ...common,
            baseWorldviewVersionId: context.frozenInput.frozenBaseWorldviewVersionId,
            manifestDigest: context.manifest.manifestDigest,
            rationale: context.validatedResult.worldview.rationale,
            createdAt: context.asOf,
          });
        const eligibleEvidence = context.selectedFullReads.map((read) => {
          const item = context.manifest.items.find((candidate) => candidate.reportVersionId === read.reportVersionId);
          return {
            reportVersionId: read.reportVersionId,
            contentDigest: read.contentDigest,
            fingerprint: item?.fingerprint,
          };
        });
        const claimPublication = this.claimStore.stageActions({
          originatingRunId: context.runId,
          publicationId,
          actions: context.validatedResult.claimActions,
          eligibleEvidence,
          publishedAt: context.asOf,
          expectedClaimSnapshotDigest: canonicalSha256(context.workspace.content.claims),
        });
        const receipts = context.manifest.items.map((item) => ({
          reportVersionId: item.reportVersionId,
          admissionSequence: item.admissionSequence,
          contentDigest: item.contentDigest,
          fingerprint: item.fingerprint,
        }));
        context.stagedPublicationId = publicationId;
        this.publicationStore.stage({
          publicationId,
          runId: context.runId,
          triggerId: context.trigger.triggerId,
          batchId: context.trigger.batchId,
          workspaceId: context.workspace.workspaceId,
          workspaceDigest: context.workspace.workspaceDigest,
          committedAt: context.asOf,
          worldview: context.validatedResult.worldview.action === 'UPDATE'
            ? {
              outcome: 'UPDATE',
              versionId: worldviewPublication.versionId,
              packageDigest: worldviewPublication.packageDigest,
              updateRecordId: worldviewPublication.updateRecord.updateRecordId,
              updateRecordDigest: worldviewPublication.updateRecord.recordDigest,
            }
            : {
              outcome: 'KEEP',
              evaluationRecordId: worldviewPublication.evaluationId,
              evaluationRecordDigest: worldviewPublication.recordDigest,
            },
          claims: {
            publicationId,
            publicationDigest: claimPublication.publicationDigest,
            acceptedActionCount: claimPublication.acceptedActions.length,
            rejectedActionCount: claimPublication.rejectedActions.length,
            claimVersionCount: claimPublication.claims.length,
          },
          attempts: context.attempts,
          receipts,
        });
        const committed = this.publicationStore.commit(publicationId);
        context.worldviewStore.rebuildCurrent();
        context.reportLibrary.rebuildProjections();
        context.publication = {
          publicationId,
          publicationDigest: committed.publicationDigest,
          worldview: clone(committed.worldview),
          acceptedClaimActions: clone(claimPublication.acceptedActions),
          rejectedClaimActions: clone(claimPublication.rejectedActions),
          claimVersions: clone(claimPublication.claims),
          processedReceipts: clone(committed.receipts),
        };
        return { publication: clone(context.publication) };
      },
      hydrateNode: async (context, handlerId, node, details = {}) => {
        const record = details.record || context.runStore.load(context.runId)?.nodes?.[node.id];
        const ref = record?.artifactRefs?.[0];
        if (!ref) fail(`Canonical Worldview hydrated node artifact is missing: ${handlerId}`, 'WORLDVIEW_HYDRATION_MISSING');
        const value = JSON.parse(context.artifactStore.read(ref));
        if (handlerId === 'executeCoreWorldviewAttempts') {
          context.agentResult = value.agentResult;
          context.validatedResult = value.validatedResult;
          context.agentExecution = value.execution;
          context.attempts = clone(value.attempts || (value.attempt ? [value.attempt] : []));
          const successfulAttempt = [...context.attempts].reverse().find((attempt) => attempt.status === 'succeeded') || null;
          context.selectedFullReads = successfulAttempt?.selectedFullReads || [];
          context.capabilityTraceCount = successfulAttempt?.capabilityTraceCount || 0;
        }
        if (handlerId === 'validateWorldviewAndClaimActions') context.validatedResult = value.validatedResult;
        if (handlerId === 'stageRunPublication') context.publicationIntent = value;
        if (handlerId === 'commitRunPublication') context.publication = value.publication;
        return value;
      },
    };
  }

  #runSummary(run) {
    return {
      runId: run.runId,
      triggerId: run.triggerId,
      batchId: run.batchId,
      cycleOrdinal: run.cycleOrdinal,
      state: run.state,
      outcome: run.outcome,
      rationale: run.rationale,
      frozenRange: clone(run.frozenRange),
      overviewCount: run.overviewCount,
      workspaceId: run.workspaceId,
      workspaceDigest: run.workspaceDigest,
      selectedFullReads: clone(run.selectedFullReads),
      publicationId: run.publicationId || null,
      publicationDigest: run.publicationDigest || null,
      evaluationRecordId: run.evaluationRecordId,
      resultingWorldviewVersionId: run.resultingWorldviewVersionId,
      acceptedClaimActions: clone(run.acceptedClaimActions || []),
      rejectedClaimActions: clone(run.rejectedClaimActions || []),
      processedReceipts: clone(run.processedReceipts || []),
    };
  }

  #acquireSequence(triggerId) {
    return acquireCanonicalWorldviewActiveSequenceGuard({
      worldviewRoot: this.worldviewStore.rootDir,
      ownerId: triggerId,
      now: this.now,
    });
  }
}

export function createCanonicalWorldviewCoordinator(options = {}) {
  return new CanonicalWorldviewCoordinator(options);
}
