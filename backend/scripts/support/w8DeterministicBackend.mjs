import fs from 'node:fs';
import path from 'node:path';

import { getAgentDefinition } from '../../src/agents/registry.js';
import { projectScorecardEvaluationOutput } from '../../src/domains/research/scorecards/scorecardOutputProjection.js';
import { getScorecardSpec } from '../../src/domains/research/scorecards/scorecardCatalog.js';
import { PiAgentBackend } from '../../src/core/agent-backend/PiAgentBackend.js';
import {
  canonicalSha256,
  canonicalStringify,
} from '../../src/core/contracts/ArtifactRef.js';
import { createAgentRunResult } from '../../src/core/contracts/agentContracts.js';
import { withFileLockSync } from '../../src/lib/fileLock.js';

export const W8_DETERMINISTIC_MODES = Object.freeze([
  'success',
  'review-block',
  'review-resolve',
]);
export const W8_DETERMINISTIC_AUDIT_FILE = 'w8-agent-call-audit.jsonl';

const MODE_SET = new Set(W8_DETERMINISTIC_MODES);
const REVIEWER_IDS = new Set([
  'evidence-reviewer',
  'requirement-reviewer',
  'logic-reviewer',
]);
const SCORECARD_IDS = new Set([
  'data-scoreboard-evaluator',
  'industry-scoreboard-evaluator',
  'company-scoreboard-evaluator',
]);
const MATERIAL_EVIDENCE_RE = /\b(?:valuation|price|revenue|sales|growth|margin|profit|earnings|eps|ebitda|cash flow|capex|demand|supply|backlog|market share|cost|risk)\b/iu;
const SAFE_PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
function fail(message, code = 'W8_DETERMINISTIC_BACKEND_INVALID') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function assertOwnedDirectory(controlDir) {
  if (typeof controlDir !== 'string' || !path.isAbsolute(controlDir)) {
    fail('W8 deterministic backend controlDir must be absolute');
  }
  const resolved = path.resolve(controlDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('W8 deterministic backend controlDir must be a real directory');
  }
  return resolved;
}

function assertRegularFile(file, label) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file`, 'W8_DETERMINISTIC_FILE_UNSAFE');
  }
}

function resolveCrashMarker(controlDir, crashMarkerFile) {
  if (crashMarkerFile === null || crashMarkerFile === undefined) return null;
  if (typeof crashMarkerFile !== 'string' || !path.isAbsolute(crashMarkerFile)) {
    fail('W8 deterministic crashMarkerFile must be absolute');
  }
  const resolved = path.resolve(crashMarkerFile);
  const relative = path.relative(controlDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('W8 deterministic crashMarkerFile must be inside controlDir');
  }
  assertRegularFile(resolved, 'W8 deterministic crash marker');
  return resolved;
}

function digest(value) {
  return canonicalSha256(value === undefined ? null : value);
}

function inputDigest(request) {
  return DIGEST_RE.test(request?.input?.inputDigest || '')
    ? request.input.inputDigest
    : digest(request?.input ?? null);
}

function requestIdentity(request, { mode, phase }) {
  const identity = {
    phase,
    mode,
    runId: request.runId,
    workflowId: request.workflowId,
    nodeId: request.nodeId,
    projectId: request.projectId,
    agentId: request.agentContractId,
    contractVersion: request.contractVersion,
    workspaceSnapshotId: request.workspaceSnapshotId,
    idempotencyKeyDigest: digest(request.idempotencyKey),
    inputDigest: inputDigest(request),
    inputArtifactRefsDigest: digest(request.inputArtifactRefs || []),
    priorReviewIssuesDigest: digest(request.priorReviewIssues || []),
    effectiveConfigDigest: DIGEST_RE.test(request.effectiveConfigDigest || '')
      ? request.effectiveConfigDigest
      : null,
    reviewIdentityDigest: request.input?.reviewIdentity
      ? digest(request.input.reviewIdentity)
      : null,
  };
  return {
    ...identity,
    requestDigest: digest(identity),
  };
}

function auditPath(controlDir) {
  return path.join(controlDir, W8_DETERMINISTIC_AUDIT_FILE);
}

function appendAudit(controlDir, record) {
  const file = auditPath(controlDir);
  withFileLockSync(`${file}.lock`, () => {
    assertRegularFile(file, 'W8 deterministic call audit');
    fs.appendFileSync(file, `${canonicalStringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(file, 0o600);
  });
}

function safeFailureCode(error) {
  const value = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z0-9_-]{1,80}$/u.test(value) ? value : 'W8_DETERMINISTIC_CALL_FAILED';
}

function auditResult(identity, result) {
  return {
    schemaVersion: 'w8-deterministic-agent-call.v1',
    ...identity,
    status: result.status,
    stopReason: result.stopReason,
    valid: result.valid === true,
    live: result.live === true,
    outputDigest: digest(result.output ?? result.text ?? null),
    artifactRefsDigest: digest(result.artifacts || []),
    evidenceRefsDigest: digest(result.evidenceRefs || []),
  };
}

function auditFailure(identity, error) {
  return {
    schemaVersion: 'w8-deterministic-agent-call.v1',
    ...identity,
    status: 'failed',
    stopReason: 'error',
    valid: false,
    live: false,
    failureCode: safeFailureCode(error),
    failureDigest: digest({
      name: typeof error?.name === 'string' ? error.name : 'Error',
      code: safeFailureCode(error),
    }),
  };
}

function canonicalPassingReport(ProjectSpace, projectId) {
  let citationLedger;
  try {
    citationLedger = JSON.parse(
      ProjectSpace.fileContent(projectId, 'data/citation_ledger.json') || 'null',
    );
  } catch {
    fail(
      'W8 canonical report requires a readable citation ledger',
      'W8_CITATION_LEDGER_INVALID',
    );
  }
  const evidence = (citationLedger?.evidenceItems || [])
    .find((item) => MATERIAL_EVIDENCE_RE.test(item.statement || ''));
  if (!evidence?.evidenceId) {
    fail(
      'W8 canonical report requires material atomic evidence',
      'W8_MATERIAL_EVIDENCE_MISSING',
    );
  }
  const statement = String(evidence.statement || '')
    .replace(/\s+/gu, ' ')
    .replaceAll('[', '/')
    .replaceAll(']', '/')
    .replaceAll('|', '/');
  return {
    evidenceId: evidence.evidenceId,
    markdown: `# Deterministic W8 acceptance report

## Investment thesis
The canonical atomic record states: ${statement} [src: ${evidence.evidenceId}]

## Industry analysis
No additional factual industry assertion is introduced by this deterministic fixture.

## Company analysis
No additional factual company assertion is introduced by this deterministic fixture.

## Demand / supply / value chain
Ownership mapping is withheld until additional atomic evidence is available.

## Valuation
Quantitative modeling is outside this deterministic structural fixture.

## Risks and invalidation
No additional failure threshold is asserted beyond the cited atomic record.

## Reflection / open questions / summary
The evidence boundary is explicit and no unsupported conclusion is added.`,
  };
}

function reviewerType(agentId) {
  return agentId === 'requirement-reviewer'
    ? 'requirements'
    : agentId.replace('-reviewer', '');
}

function shouldBlockReview(mode, request) {
  if (mode === 'success') return false;
  if (mode === 'review-block') return true;
  return request.input?.reviewIdentity?.kind !== 'human-review';
}

function scriptedReviewOutput(request, mode) {
  const blocking = (
    request.agentContractId === 'logic-reviewer'
    && shouldBlockReview(mode, request)
  );
  return {
    schemaVersion: '1.0.0',
    asOf: request.asOf,
    producer: request.agentContractId,
    contractVersion: request.contractVersion,
    inputDigest: request.input.inputDigest,
    createdAt: request.asOf,
    evidenceRefs: [],
    reviewerType: reviewerType(request.agentContractId),
    score: blocking ? 0.4 : 0.95,
    issues: blocking ? [{
      id: 'w8-report-blocking',
      severity: 'critical',
      owner: 'report',
      message: 'The deterministic W8 report requires bounded remediation.',
      location: 'Valuation',
      claim: 'The report must re-enter the canonical review gate.',
      evidenceRefs: ['evidence://w8/report-review'],
      remediation: 'Revise only the report and run the canonical reviewer group again.',
    }] : [],
    verdict: blocking ? 'remediate' : 'pass',
  };
}

function scriptedScorecardOutput(request) {
  const lens = request.agentContractId.replace('-scoreboard-evaluator', '');
  const spec = getScorecardSpec(lens);
  const input = request.input || {};
  const scope = input.scope || {};
  const units = lens === 'data'
    ? [{ unitId: scope.projectId || request.projectId }]
    : lens === 'company'
      ? (scope.authoritativeTickers || input.authoritativeTickers || ['W8']).map((unitId) => ({ unitId }))
      : (scope.industries || input.materialIndustries || [{ industryId: 'w8-industry', classification: 'material', materialityWeightBps: 10000 }]).map((entry) => ({ unitId: entry.unitId || entry.industryId }));
  return {
    rawSourceChecks: [],
    units: units.map((unit) => ({
      unitId: unit.unitId,
      rubricResults: spec.rubrics.map((rubric) => ({
        rubricId: rubric.id,
        status: 'scored',
        rating: 4,
        decisiveEvidence: ['report/report.md'],
        whyNotHigher: 'No higher rating exists on the fixed scale.',
        errorTags: [],
        confidence: 'high',
      })),
      capTriggers: [],
    })),
    priorIssueChecks: [],
  };
}

function scriptedConclusionOutput(request) {
  return {
    rating: 'hold',
    recommendationScore: 55,
    confidence: 0.6,
    summary: 'The deterministic fixture proves Workflow structure, not live investment quality.',
    stocks: [],
    vsConsensus: 'No live consensus comparison is asserted.',
    conflictAdjudication: 'No unresolved deterministic conflict remains.',
    killTest: 'No live-quality kill test is asserted by this structural fixture.',
    portfolioFit: 'No portfolio allocation is authorized by this fixture.',
    risks: ['Deterministic structural acceptance does not establish live report quality.'],
    claims: [],
    asOf: request.asOf,
  };
}

function scriptedResult(baseResult, {
  output,
  text,
  evidenceRefs,
  traceRef,
}) {
  const {
    error: _error,
    errors: _errors,
    ...base
  } = baseResult;
  return createAgentRunResult({
    ...base,
    status: 'succeeded',
    output,
    text,
    evidenceRefs,
    stopReason: 'final',
    traceRef,
    live: false,
    valid: true,
    errors: [],
    budgetExhausted: false,
  });
}

function persistCrashPause(controlDir, markerFile, record) {
  let created = false;
  withFileLockSync(`${markerFile}.lock`, () => {
    assertRegularFile(markerFile, 'W8 deterministic crash marker');
    if (fs.existsSync(markerFile)) return;
    appendAudit(controlDir, record);
    fs.writeFileSync(markerFile, `${JSON.stringify({
      schemaVersion: 'w8-deterministic-crash-marker.v1',
      status: 'paused',
      phase: record.phase,
      mode: record.mode,
      runId: record.runId,
      workflowId: record.workflowId,
      nodeId: record.nodeId,
      projectId: record.projectId,
      agentId: record.agentId,
      idempotencyKeyDigest: record.idempotencyKeyDigest,
      requestDigest: record.requestDigest,
      markerDigest: digest(record),
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    created = true;
  });
  return created;
}

function crashAuditRecord(identity) {
  return {
    schemaVersion: 'w8-deterministic-agent-call.v1',
    ...identity,
    status: 'paused',
    stopReason: 'crash-fixture',
    valid: false,
    live: false,
    outputDigest: digest(null),
    artifactRefsDigest: digest([]),
    evidenceRefsDigest: digest([]),
  };
}

function neverResolve() {
  return new Promise(() => {});
}

export function readW8DeterministicCallAudit({ controlDir } = {}) {
  const directory = assertOwnedDirectory(controlDir);
  const file = auditPath(directory);
  assertRegularFile(file, 'W8 deterministic call audit');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readW8AgentAudit(controlDir) {
  return readW8DeterministicCallAudit({ controlDir });
}

export function summarizeW8DeterministicCallAudit({ controlDir } = {}) {
  const records = readW8DeterministicCallAudit({ controlDir });
  const sorted = [...records].sort((left, right) => (
    canonicalStringify(left).localeCompare(canonicalStringify(right))
  ));
  const countBy = (field) => Object.fromEntries(
    [...new Set(sorted.map((record) => record[field]))]
      .sort()
      .map((value) => [
        value,
        sorted.filter((record) => record[field] === value).length,
      ]),
  );
  return Object.freeze({
    schemaVersion: 'w8-deterministic-agent-call-summary.v1',
    callCount: sorted.length,
    callDigest: digest(sorted),
    agents: countBy('agentId'),
    modes: countBy('mode'),
    phases: countBy('phase'),
    statuses: countBy('status'),
    liveCallCount: sorted.filter((record) => record.live === true).length,
  });
}

export function createW8DeterministicBackend({
  ProjectSpace,
  mode,
  controlDir,
  phase,
  crashMarkerFile = null,
  crashAgentId = 'report-composer',
  beforeCrash = null,
} = {}) {
  if (!ProjectSpace || typeof ProjectSpace.fileContent !== 'function') {
    fail('W8 deterministic backend requires ProjectSpace.fileContent');
  }
  if (!MODE_SET.has(mode)) {
    fail(`W8 deterministic backend mode is invalid: ${mode}`);
  }
  if (typeof phase !== 'string' || !SAFE_PHASE_RE.test(phase)) {
    fail('W8 deterministic backend phase is invalid');
  }
  if (typeof crashAgentId !== 'string' || !SAFE_PHASE_RE.test(crashAgentId)) {
    fail('W8 deterministic backend crashAgentId is invalid');
  }
  if (beforeCrash !== null && typeof beforeCrash !== 'function') {
    fail('W8 deterministic backend beforeCrash must be a function or null');
  }
  const directory = assertOwnedDirectory(controlDir);
  const markerFile = resolveCrashMarker(directory, crashMarkerFile);
  const pi = new PiAgentBackend({
    contractResolver: getAgentDefinition,
    usageRecorder: null,
  });

  return Object.freeze({
    async run(request, runtime = {}) {
      const identity = requestIdentity(request, { mode, phase });
      if (request.agentContractId === crashAgentId && markerFile) {
        beforeCrash?.(identity);
        const paused = crashAuditRecord(identity);
        if (persistCrashPause(directory, markerFile, paused)) {
          return neverResolve();
        }
      }

      try {
        const baseResult = await pi.run(request, {
          ...runtime,
          demo: true,
          live: false,
        });
        if (baseResult.live !== false) {
          fail(
            'W8 deterministic backend resolved a live route',
            'W8_LIVE_ROUTE_FORBIDDEN',
          );
        }

        let result = baseResult;
        if (request.agentContractId === 'report-composer') {
          const report = canonicalPassingReport(ProjectSpace, request.projectId);
          result = scriptedResult(baseResult, {
            output: report.markdown,
            text: report.markdown,
            evidenceRefs: [report.evidenceId],
            traceRef: `${request.runId}:w8:canonical-report`,
          });
        } else if (SCORECARD_IDS.has(request.agentContractId)) {
          const output = projectScorecardEvaluationOutput(scriptedScorecardOutput(request), {
            request,
            contract: getAgentDefinition(request.agentContractId),
          });
          result = scriptedResult(baseResult, {
            output,
            text: JSON.stringify(output),
            evidenceRefs: [],
            traceRef: `${request.runId}:w8:${request.agentContractId}`,
          });
        } else if (REVIEWER_IDS.has(request.agentContractId)) {
          const output = scriptedReviewOutput(request, mode);
          result = scriptedResult(baseResult, {
            output,
            text: JSON.stringify(output),
            evidenceRefs: [],
            traceRef: `${request.runId}:w8:${request.agentContractId}`,
          });
        } else if (request.agentContractId === 'conclusion-synthesizer') {
          const output = scriptedConclusionOutput(request);
          result = scriptedResult(baseResult, {
            output,
            text: JSON.stringify(output),
            evidenceRefs: [],
            traceRef: `${request.runId}:w8:${request.agentContractId}`,
          });
        }
        appendAudit(directory, auditResult(identity, result));
        return result;
      } catch (error) {
        appendAudit(directory, auditFailure(identity, error));
        throw error;
      }
    },

    cancel(runId, nodeId) {
      return pi.cancel(runId, nodeId);
    },
  });
}
