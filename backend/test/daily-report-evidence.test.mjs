import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getDailyReportContent,
  getDailyReportRun,
  listDailyReportRuns,
} from '../src/domains/reports/DailyReportEvidence.js';

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fixtureScorecards(reportContent) {
  const reportDigest = digest(reportContent);
  const scorecardDigest = digest(`${reportContent}\nscorecard`);
  const asOf = '2026-08-01T06:30:00.000Z';
  return Object.fromEntries(['data', 'industry', 'company'].map((lens, index) => {
    const score = [10000, 7500, 9200][index];
    const band = score >= 9000 ? 'A' : score >= 8000 ? 'B' : score >= 7000 ? 'C' : score >= 6000 ? 'D' : 'F';
    const pathValue = `analysis/scorecards/${lens}_r1.json`;
    return [lens, {
      lens, rubricVersion: 'v3.1-en', sourceCandidateDigest: reportDigest, sourceCycle: 0,
      asOf, ref: {
        contract: 'artifact-ref.v1', artifactId: `fixture:${pathValue}`, version: 1, path: pathValue,
        contentDigest: scorecardDigest, schemaVersion: 'scorecard-evaluation.v1', producer: `${lens}-scoreboard-evaluator`,
        contractVersion: '2.3.0', inputDigest: reportDigest, createdAt: asOf, asOf,
      }, finalScoreBps: score, qualityBand: band, displayResult: score >= 8000 ? 'pass' : 'fail',
      units: [{ unitId: lens, unitKind: 'project', unitStatus: 'scored', finalScoreBps: score, qualityBand: band, displayResult: score >= 8000 ? 'pass' : 'fail' }],
    }];
  }));
}

async function writeRun(root, runId, summaryPatch = {}) {
  const runDir = path.join(root, runId);
  const projectId = summaryPatch.projectId || `proj_${runId.replace(/[^A-Za-z0-9]/gu, '')}`;
  const reportPath = summaryPatch.reportPath || 'report/report_20260801_063000.md';
  const reportContent = summaryPatch.reportContent || '# Alpha daily report\n\nThis report has enough text for preview.';
  await mkdir(path.join(runDir, 'data/projects', projectId, 'report'), { recursive: true });
  await writeJson(path.join(runDir, 'data/projects', projectId, 'meta.json'), {
    id: projectId,
    title: summaryPatch.title || 'Alpha daily project',
    titleZh: summaryPatch.titleZh || 'Alpha 每日报告项目',
    tickers: ['ALFA'],
    theme: 'Daily reports',
    createdAt: '2026-08-01T06:30:00.000Z',
  });
  if (summaryPatch.writeReport !== false) {
    await writeFile(path.join(runDir, 'data/projects', projectId, reportPath), reportContent, 'utf8');
  }
  const summary = {
    schemaVersion: 'daily-report-gate.v1',
    ok: summaryPatch.ok ?? true,
    mode: summaryPatch.mode || 'live',
    live: summaryPatch.live ?? true,
    startedAt: summaryPatch.startedAt || '2026-08-01T06:30:00.000Z',
    completedAt: summaryPatch.completedAt || '2026-08-01T07:30:00.000Z',
    runName: summaryPatch.runName || `daily-100-report-gate-live-${runId}`,
    configuration: {
      ideaCount: 1,
      batchSize: 20,
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
      companyLocale: 'global',
      timeoutMs: 43200000,
      pollMs: 60000,
      fixedIdeasPath: '/private/input/fixed.json',
      internalNote: 'do not expose undeclared configuration fields through the read API',
    },
    provider: {
      liveLLM: true,
      activeProvider: 'gpt-gateway',
      activeModel: 'gpt-5.6-luna',
      defaultProvider: 'gpt-gateway',
      gptGateway: true,
      gptGatewayEndpointConfigured: true,
    },
    ideaGeneration: {
      source: 'fixed-ideas',
      generated: 1,
      ideas: 1,
      live: false,
    },
    batch: {
      maxConcurrent: 20,
      queuedAtStart: 0,
      maxQueuePositionAtStart: 0,
      observations: { samples: 3, maxAnalyzingObserved: 1, maxQueuedObserved: 0 },
    },
    verification: {
      ok: summaryPatch.ok ?? true,
      failures: summaryPatch.failures || [],
      ideas: 1,
      projects: 1,
      reports: summaryPatch.reports ?? 1,
      uniqueIdeaIds: 1,
      uniqueProjectIds: 1,
      uniqueRunIds: 1,
      uniqueReportIdentities: summaryPatch.reports ?? 1,
      noHumanReviewTasks: true,
      canonicalWorkflowInvocations: 1,
    },
    projects: [{
      index: 0,
      ideaId: `idea_${runId}`,
      projectId,
      sourceIdeaId: `idea_${runId}`,
      status: summaryPatch.projectStatus || 'analyzed',
      runStatus: summaryPatch.runStatus || 'SUCCEEDED',
      runId: `run_${runId}`,
      workflowId: 'run-analysis.v1',
      workflowHash: 'sha256:test',
      reportReady: summaryPatch.reportReady ?? true,
      reportPath,
      reportBytes: Buffer.byteLength(reportContent, 'utf8'),
      conclusionRating: 'hold',
      reviewTaskStatus: null,
      stopReason: 'final',
      ...(summaryPatch.scorecards ? { scorecards: summaryPatch.scorecards } : {}),
      ...(summaryPatch.scorecardCandidateDigest ? { scorecardCandidateDigest: summaryPatch.scorecardCandidateDigest } : {}),
    }],
    errors: [],
  };
  await writeJson(path.join(runDir, 'summary.json'), summary);
  return { runDir, projectId, reportPath, reportContent };
}

test('daily report evidence API lists runs and reads report content without leaking local input paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finagent-daily-report-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRun(root, 'run-old', { startedAt: '2026-07-31T06:30:00.000Z' });
  const latest = await writeRun(root, 'run-new', {
    ok: false,
    reports: 1,
    failures: ['one provider transient recovered into partial evidence'],
    startedAt: '2026-08-01T06:30:00.000Z',
  });

  const runs = listDailyReportRuns({ rootDir: root, limit: 10 });
  assert.deepEqual(runs.map((run) => run.id), ['run-new', 'run-old']);
  assert.equal(runs[0].state, 'partial');
  assert.equal(runs[0].configuration.fixedIdeas, true);
  assert.equal(runs[0].configuration.fixedIdeasLabel, 'fixed.json');
  assert.equal(Object.hasOwn(runs[0].configuration, 'internalNote'), false);
  assert.equal(runs[0].provider.activeProvider, 'gpt-gateway');
  assert.equal(runs[0].verification.reports, 1);

  const summaryPath = path.join(latest.runDir, 'summary.json');
  const summaryWithScorecards = JSON.parse(await (await import('node:fs/promises')).readFile(summaryPath, 'utf8'));
  summaryWithScorecards.projects[0].scorecards = fixtureScorecards(latest.reportContent);
  summaryWithScorecards.projects[0].scorecardCandidateDigest = digest(latest.reportContent);
  summaryWithScorecards.projects[0].scorecardStatus = 'available';
  await writeJson(summaryPath, summaryWithScorecards);

  const detail = getDailyReportRun('run-new', { rootDir: root });
  assert.equal(detail.projects.length, 1);
  assert.equal(detail.projects[0].title, 'Alpha 每日报告项目');
  assert.equal(detail.projects[0].report.exists, true);
  assert.equal(detail.projects[0].report.title, 'Alpha daily report');
  assert.equal(detail.projects[0].report.bytes, Buffer.byteLength(latest.reportContent, 'utf8'));
  assert.equal(detail.projects[0].scorecardStatus, 'available');
  assert.equal(detail.projects[0].scorecards.data.finalScoreBps, 10000);
  assert.equal(detail.projects[0].scorecards.industry.qualityBand, 'C');

  const report = getDailyReportContent('run-new', latest.projectId, { rootDir: root });
  assert.equal(report.runId, 'run-new');
  assert.equal(report.project.projectId, latest.projectId);
  assert.equal(report.report.path, latest.reportPath);
  assert.equal(report.report.content, latest.reportContent);
});

test('daily report evidence API rejects unsafe run and report paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finagent-daily-report-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await writeRun(root, 'run-safe', {
    reportPath: '../../outside.md',
    writeReport: false,
  });

  assert.throws(
    () => getDailyReportRun('../outside', { rootDir: root }),
    (error) => error.code === 'INVALID_DAILY_REPORT_ID' && error.statusCode === 400,
  );
  assert.throws(
    () => getDailyReportContent('run-safe', run.projectId, { rootDir: root }),
    (error) => error.code === 'INVALID_DAILY_REPORT_PATH' && error.statusCode === 400,
  );
  const detail = getDailyReportRun('run-safe', { rootDir: root });
  assert.equal(detail.projects[0].report.exists, false);
  assert.equal(detail.projects[0].report.error, 'INVALID_DAILY_REPORT_PATH');
});
