import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.FIN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-worldview-issue32-api-'));
process.env.CANONICAL_WORLDVIEW_DIR = path.join(process.env.FIN_DATA_DIR, 'canonical-worldview');
process.env.CLAIM_LIBRARY_DIR = path.join(process.env.FIN_DATA_DIR, 'claim-library');
process.env.AUTO_RESUME = 'false';
process.env.DEMO_MODE = 'true';

const {
  ReportAdmissionService,
  ReportLibraryStore,
  ReportOverviewService,
} = await import('../src/domains/reports/index.js');
const {
  CanonicalWorldviewStore,
  WORLDVIEW_AGENT_RESULT_CONTRACT,
} = await import('../src/domains/worldview/canonical/index.js');
const { ClaimStore } = await import('../src/domains/claims/index.js');
const { CanonicalWorldviewCoordinator } = await import('../src/workflows/worldview/canonicalWorldviewCoordinator.js');
const { ToolGateway } = await import('../src/core/tools/ToolGateway.js');
const { getAgentDefinition } = await import('../src/agents/registry.js');
const { runTool } = await import('../src/tools/index.js');
const { toolRegistry } = await import('../src/tools/toolCatalog.js');

const NOW = '2026-08-23T00:00:00.000Z';
const sha256 = (value) => `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
const markdown = '# Canonical API report\n\nExact content.\n';
const packageInput = {
  contract: 'internal-run-analysis-report-package.v1', origin: 'internal',
  producer: {
    type: 'run-analysis', workflow: { id: 'run-analysis.v2', version: '2.0.0', hash: sha256('workflow') },
    reportRef: {
      contract: 'artifact-ref.v1', artifactId: 'canonical-api-artifact', version: 1, path: 'report/report.md',
      contentDigest: sha256(markdown), schemaVersion: 'run-analysis-report.v1', producer: 'run-analysis',
      contractVersion: '1.0.0', inputDigest: sha256('input'), createdAt: NOW, asOf: NOW,
    },
  },
  lineage: { projectId: 'canonical-api-project', analysisRunId: 'canonical-api-analysis' },
  dailyReport: null,
  report: { mediaType: 'text/markdown', charset: 'utf-8', markdown, contentDigest: sha256(markdown) },
  metadata: { tickers: ['API'], theme: 'Canonical API', searchTags: ['canonical'], title: 'Canonical API report', asOf: NOW, generatedAt: NOW },
};

const reportLibrary = new ReportLibraryStore({ now: () => NOW });
const admissionService = new ReportAdmissionService({
  reportLibrary,
  overviewService: new ReportOverviewService({
    now: () => NOW,
    agentBackend: {
      async run(request) {
        return {
          status: 'succeeded', valid: true, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
          provider: 'scripted', model: 'scripted-small', live: false, metrics: {}, stopReason: 'final', traceRef: 'trace:overview',
          output: { overview: {
            reportVersionId: request.input.reportVersionId,
            contentDigest: request.input.contentDigest,
            summary: 'Canonical API discovery.', keyThemes: ['canonical'],
            entities: [{ name: 'API', type: 'ticker', tickers: ['API'] }],
            materialDevelopments: ['Canonical API development.'], uncertainties: ['Exact read required.'],
          } },
        };
      },
    },
  }),
  maxImmediateAttempts: 1,
  sleep: async () => {},
});
const admitted = await admissionService.admit(packageInput);
const overview = admitted.overview;
const worldviewStore = new CanonicalWorldviewStore({ rootDir: process.env.CANONICAL_WORLDVIEW_DIR, now: () => NOW });
const backend = {
  async run(request, runtime = {}) {
    await runtime.onModelApiAttempt({
      phase: 'started', attempt: 1, maxAttempts: 5, message: 'raw API request must not persist',
    });
    await runtime.onModelApiAttempt({
      phase: 'completed', attempt: 1, maxAttempts: 5, status: 'failed',
      code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 429, message: 'raw API failure must not persist',
    });
    await runtime.onModelApiAttempt({ phase: 'started', attempt: 2, maxAttempts: 5 });
    const gateway = new ToolGateway({
      request,
      contract: getAgentDefinition('core-worldview'),
      registry: toolRegistry,
      executeTool: async (name, args, options) => (await runTool(name, args, options)).result,
      beforeExecute: runtime.beforeToolExecution,
      toolCallBudget: runtime.toolCallBudget,
    });
    const overviews = await gateway.execute('worldview_enumerate_overviews', {
      scopeId: request.input.capabilityScopeId,
    });
    const report = await gateway.execute('worldview_read_report_version', {
      scopeId: request.input.capabilityScopeId,
      reportVersionId: overviews[0].reportVersionId,
    });
    await runtime.onModelApiAttempt({
      phase: 'completed', attempt: 2, maxAttempts: 5,
      status: 'succeeded', code: null, statusCode: null, message: 'raw API response must not persist',
    });
    return {
      status: 'succeeded', valid: true, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
      provider: 'scripted', model: 'scripted-high', live: false,
      metrics: { providerAttempts: 0, modelApiAttempts: 2, networkAttempts: 0, liveModelAttempts: 0 },
      stopReason: 'final', traceRef: 'trace:core',
      output: {
        contract: WORLDVIEW_AGENT_RESULT_CONTRACT,
        worldview: {
          action: 'UPDATE', baseWorldviewVersionId: null, rationale: 'Initial API Worldview.',
          package: {
            title: 'API Worldview', asOf: NOW, narrativeMarkdown: '# API Worldview\n\nComplete canonical narrative.\n',
            causalRelationships: [{ relationshipId: 'api-cause', cause: 'Evidence', effect: 'View', mechanism: 'Exact evidence updates the view.', confidence: 'medium', evidence: [{ reportVersionId: report.reportVersionId, contentDigest: report.contentDigest }], counterEvidence: [] }],
            evidence: [{ reportVersionId: report.reportVersionId, contentDigest: report.contentDigest, kind: 'supporting', summary: 'Supporting exact evidence.' }],
            counterEvidence: [],
            investmentImplications: [{ theme: 'API', implication: 'Inspect the exact package.', horizon: '12 months', confidence: 'medium' }],
            coverage: { overviewIds: [overview.overview.overviewId], reportVersionIds: [report.reportVersionId], selectedFullReadReportVersionIds: [report.reportVersionId] },
            updateSummary: { retained: [], changed: [], added: ['Initial API view'], removed: [] },
          },
        },
        claimActions: [{
          actionId: 'api-claim-add',
          action: 'ADD',
          rationale: 'The exact report supports one API-visible Claim.',
          claim: {
            assertion: 'API demand will exceed the current baseline by 2027-03-31.',
            subject: 'API demand',
            tickers: ['API'],
            rationale: 'The full report identifies a time-bound demand catalyst.',
            verification: { pointAt: '2027-03-31T00:00:00.000Z' },
            metric: 'Reported API demand index',
            acceptanceCondition: 'The reported index is above the current baseline.',
            invalidationCondition: 'The reported index is at or below the current baseline.',
            evidence: [{
              reportVersionId: report.reportVersionId,
              contentDigest: report.contentDigest,
              fingerprint: report.fingerprint,
            }],
          },
        }],
      },
    };
  },
};
const claimStore = new ClaimStore({ rootDir: process.env.CLAIM_LIBRARY_DIR, now: () => NOW });
const coordinator = new CanonicalWorldviewCoordinator({
  dataDir: process.env.FIN_DATA_DIR, reportLibrary, worldviewStore, claimStore, agentBackend: backend, now: () => NOW,
});
await coordinator.processTrigger({
  contract: 'worldview-processing-trigger.v1', triggerId: 'worldview_trigger_api', batchId: 'daily_batch_api', publishedAt: NOW,
  status: 'requested', pendingReportVersionIds: [admitted.reportVersionId], pendingReportCount: 1, coreWorldviewAgentCalls: 0,
});

const { startServer } = await import('../src/server.js');

test('Canonical Worldview read APIs expose only the canonical Processing Log and Versions product', async () => {
  const server = startServer({ port: 0 });
  try {
    const port = server.address().port;
    const get = async (route) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, route);
      return response.json();
    };
    const current = await get('/api/worldview/current');
    const log = await get('/api/worldview/processing-log');
    const run = await get(`/api/worldview/processing-log/${log.runs[0].runId}`);
    const versions = await get('/api/worldview/versions');
    const version = await get(`/api/worldview/versions/${versions.versions[0].versionId}`);
    const evaluations = await get('/api/worldview/evaluations');
    const claims = await get('/api/claims');
    const claim = await get(`/api/claims/${claims.claims[0].claimId}`);
    const claimHistory = await get(`/api/claims/${claims.claims[0].claimId}/history`);
    const claimActions = await get(`/api/claims/${claims.claims[0].claimId}/actions`);
    const claimRejections = await get('/api/claims/rejections');
    const reportStatus = await get('/api/report-library/status');

    assert.equal(current.current.contract, 'current-worldview.v1');
    assert.equal(log.runs.length, 1);
    assert.equal(log.runs[0].outcome, 'UPDATE');
    assert.equal(log.runs[0].acceptedClaimActionCount, 1);
    assert.equal(log.runs[0].rejectedClaimActionCount, 0);
    assert.equal(Object.hasOwn(log.runs[0], 'acceptedClaimActions'), false);
    assert.equal(Object.hasOwn(log.runs[0], 'rejectedClaimActions'), false);
    assert.deepEqual(log.runs[0].execution.attemptEvidence, {
      providerAttempts: 0,
      networkAttempts: 0,
      liveModelAttempts: 0,
      modelApiAttempts: 2,
    });
    assert.equal(run.run.overviewManifest.length, 1);
    assert.deepEqual(run.run.effectiveConfig.capturedRoute, {
      provider: 'demo',
      model: 'deterministic-demo',
      reasoningLevel: 'high',
    });
    assert.equal(Object.hasOwn(run.run, 'attemptRecovery'), false);
    const expectedModelApiAudit = [
      { sequence: 1, phase: 'started', attempt: 1, maxAttempts: 5, status: null, code: null, statusCode: null, recordedAt: NOW },
      { sequence: 2, phase: 'completed', attempt: 1, maxAttempts: 5, status: 'failed', code: 'MODEL_PROVIDER_TRANSIENT', statusCode: 429, recordedAt: NOW },
      { sequence: 3, phase: 'started', attempt: 2, maxAttempts: 5, status: null, code: null, statusCode: null, recordedAt: NOW },
      { sequence: 4, phase: 'completed', attempt: 2, maxAttempts: 5, status: 'succeeded', code: null, statusCode: null, recordedAt: NOW },
    ];
    assert.deepEqual(log.runs[0].attempts[0].modelApiAttemptAudit, expectedModelApiAudit);
    assert.deepEqual(run.run.attempts[0].modelApiAttemptAudit, expectedModelApiAudit);
    assert.doesNotMatch(JSON.stringify(run.run.attempts[0].modelApiAttemptAudit), /raw API/u);
    assert.equal(run.run.selectedFullReads[0].reportVersionId, admitted.reportVersionId);
    assert.equal(versions.versions.length, 1);
    assert.equal(version.version.contract, 'canonical-worldview-package.v1');
    assert.equal(version.version.documents.length, 7);
    assert.equal(version.version.integrity.valid, true);
    assert.equal(evaluations.evaluations.length, 0);
    assert.equal(claims.claims.length, 1);
    assert.equal(claim.claim.assertion, 'API demand will exceed the current baseline by 2027-03-31.');
    assert.deepEqual(claim.claim.verification, { pointAt: '2027-03-31T00:00:00.000Z' });
    assert.equal(claim.claim.acceptanceCondition, 'The reported index is above the current baseline.');
    assert.equal(claim.claim.invalidationCondition, 'The reported index is at or below the current baseline.');
    assert.equal(claim.claim.originatingRunId, run.run.runId);
    assert.equal(claim.claim.publicationId, run.run.publicationId);
    assert.equal(claimHistory.history.versions.length, 1);
    assert.deepEqual(claimHistory.history.totalCounts, { versions: 1, actions: 1, rejections: 0 });
    assert.deepEqual(claimHistory.history.nextCursors, { versions: null, actions: null, rejections: null });
    assert.equal(claimActions.actions.length, 1);
    assert.equal(claimRejections.rejections.length, 0);
    assert.equal(run.run.processedReceipts.length, 1);
    assert.equal(run.run.acceptedClaimActions.length, 1);
    assert.equal(run.run.rejectedClaimActions.length, 0);
    assert.equal(reportStatus.status.processedReportCount, 1);
    assert.equal(reportStatus.status.pendingReportCount, 0);

    const serialized = JSON.stringify({ current, log, run, versions, version, claims, claim, claimHistory, claimActions });
    assert.doesNotMatch(serialized, /providerPayload|api[_-]?key|password|capabilityScopeId|\/private\//iu);
    const mutation = await fetch(`http://127.0.0.1:${port}/api/worldview/versions`, { method: 'POST' });
    assert.equal(mutation.status, 404);
    const removedLegacyRoute = await fetch(`http://127.0.0.1:${port}/api/worldview/daily/packages`);
    assert.equal(removedLegacyRoute.status, 404);
    const exhaustedHistory = await get(
      `/api/claims/${claims.claims[0].claimId}/history?versionsLimit=1&versionsCursor=1&actionsLimit=1&actionsCursor=${encodeURIComponent(claimHistory.history.actions[0].actionRecordId)}&rejectionsLimit=1`,
    );
    assert.deepEqual(exhaustedHistory.history.versions, []);
    assert.deepEqual(exhaustedHistory.history.actions, []);
    assert.equal(exhaustedHistory.history.totalCounts.versions, 1);
    const invalidHistoryLimit = await fetch(
      `http://127.0.0.1:${port}/api/claims/${claims.claims[0].claimId}/history?versionsLimit=101`,
    );
    assert.equal(invalidHistoryLimit.status, 400);
    assert.deepEqual(await invalidHistoryLimit.json(), {
      error: 'versionsLimit must be an integer between 1 and 100',
      code: 'CLAIM_INVALID_LIMIT',
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/claims/related`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/claims/resolutions`)).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
