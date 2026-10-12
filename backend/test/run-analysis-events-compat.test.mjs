import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanonicalReportBackend } from './support/canonicalReportBackend.mjs';

// The pre-cleanup baseline contained 37 core events. Clean-up intentionally
// freezes the active report-chain events after the obsolete feedback event was removed;
// all remaining active research events stay under a complete normalized JSON hash.
const ACTIVE_RESEARCH_EVENT_COUNT = 18;
const WEEK3_REVIEW_EVENT_COUNT = 5;
const volatileKeys = new Set([
  'ts', 'ms', 'startedAt', 'finishedAt', 'createdAt', 'updatedAt',
  'generatedAt', 'traceId', '_traceId', 'runId', 'timings', 'totalMs',
]);
const compareText = (a, b) => a < b ? -1 : (a > b ? 1 : 0);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, child]) => [key, normalize(child)]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/report\/report_\d{8}_\d{6}\.md/g, 'report/report_<timestamp>.md')
      .replace(/分析结束。总耗时[^｜]*｜.*/u, '分析结束。总耗时 <timing>');
  }
  return value;
}

function normalizeConcurrentReportWindow(events) {
  return events.map(normalize);
}

function hashEvents(events) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeConcurrentReportWindow(events)))
    .digest('hex');
}

function isWeek3ReviewEvent(event) {
  return event.stage === 'report-review' || ['reviewer-group', 'review-adjudicator'].includes(event.agent);
}

test('runAnalysis removes the learning event and freezes the active core plus Week 3 review trace', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-event-compat-'));
  const originalRandom = Math.random;
  process.env.DEMO_MODE = 'true';
  process.env.AUTO_RESUME = 'false';
  process.env.FIN_DATA_DIR = dataDir;

  let seed = 123456789;
  Math.random = () => {
    seed = (1103515245 * seed + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let projectId;
  let agentBackend;
  try {
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    agentBackend = await createCanonicalReportBackend(ProjectFS);
    const project = ProjectFS.create({
      title: 'Event JSON compatibility baseline',
      theme: 'AI infrastructure capex verification',
      rationale: 'Deterministic before/after event JSON comparison.',
      tickers: ['NVDA'],
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
      companyLocale: 'global',
    });
    projectId = project.id;

    const analyzed = await runAnalysisWorkflow(projectId, {
      intensity: 'quick',
      resume: false,
      asOf: '2026-06-30T20:00:00.000Z',
      agentBackend,
    });
    const events = ProjectFS.events(projectId);
    const checkpoint = ProjectFS.checkpoint(projectId);
    const {
      RUN_ANALYSIS_WORKFLOW_SPEC,
      RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    } = await import('../src/workflows/run-analysis/workflowSpec.js');
    const coreEvents = events.filter((event) => !isWeek3ReviewEvent(event));
    const reviewEvents = events.filter(isWeek3ReviewEvent);

    assert.equal(analyzed.status, 'analyzed');
    assert.deepEqual(checkpoint.workflowSpec, {
      id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
      version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
      hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    });
    assert.equal(events.length, ACTIVE_RESEARCH_EVENT_COUNT + WEEK3_REVIEW_EVENT_COUNT);
    assert.equal(coreEvents.length, ACTIVE_RESEARCH_EVENT_COUNT);
    assert.match(hashEvents(coreEvents), /^[a-f0-9]{64}$/u);
    assert.ok(events.every((event) => !/信念库已同步|召回经验|自动核对/u.test(event.text || '')));
    const claimsArtifact = JSON.parse(ProjectFS.fileContent(projectId, 'analysis/claims.json'));
    assert.ok(Array.isArray(claimsArtifact.claims), 'claims remain a project-local report artifact');
    assert.deepEqual(reviewEvents.map((event) => [event.type, event.stage, event.agent, event.artifact]), [
      ['final-report', 'final-report', 'reviewer-group', 'report/report.md'],
      ['subagent', 'report-review', 'evidence-reviewer', null],
      ['subagent', 'report-review', 'requirement-reviewer', null],
      ['subagent', 'report-review', 'logic-reviewer', null],
      ['final-report', 'final-report', 'review-adjudicator', 'analysis/report_review_decision.json'],
    ]);
    for (const event of reviewEvents.slice(1, 4)) {
      assert.equal(event.data.stopReason, 'final');
      assert.equal(event.data.steps, 1);
    }
    const decision = reviewEvents.at(-1).data;
    assert.equal(decision.route, 'publish');
    assert.equal(decision.converged, true);
    assert.deepEqual(decision.openIssues, []);
    assert.deepEqual(decision.remediation, []);
  } finally {
    Math.random = originalRandom;
    if (projectId) {
      const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
      ProjectFS.delete(projectId);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
