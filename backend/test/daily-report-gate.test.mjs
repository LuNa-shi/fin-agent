import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  parseDailyReportGateArgs,
  projectEvidence,
  projectEvidenceHasVerifiedReport,
  runDailyReportGate,
  runRescueAnalyses,
} from '../scripts/runDaily100ReportGate.mjs';

const execFileAsync = promisify(execFile);
const scriptFile = fileURLToPath(new URL('../scripts/runDaily100ReportGate.mjs', import.meta.url));
const backendRoot = fileURLToPath(new URL('..', import.meta.url));

test('daily report gate accepts a valid zero-Claim publication', async () => {
  const source = await readFile(scriptFile, 'utf8');
  assert.doesNotMatch(source, /Claim Library has no frontend-visible current Claim/u);
  assert.match(source, /summary\.verification\.claims = summary\.claimLibrary\?\.claims\?\.length \|\| 0/u);
});

test('daily report producer rejects plans above 100 before loading runtime or starting work', async () => {
  assert.equal(parseDailyReportGateArgs(['--ideas', '100']).ideas, 100);
  assert.equal(parseDailyReportGateArgs(['--live', '--ideas', '1']).mode, 'live');
  assert.throws(
    () => parseDailyReportGateArgs(['--ideas', '101']),
    (error) => error?.code === 'INVALID_GATE_ARGUMENTS',
  );
  await assert.rejects(
    runDailyReportGate({ ideas: 101, quiet: true }),
    (error) => error?.code === 'INVALID_GATE_ARGUMENTS',
  );
});

function verifiedProjectEvidence(index, projectId, ideaId, runId = `run_${projectId}`) {
  return {
    index,
    ideaId,
    projectId,
    sourceIdeaId: ideaId,
    status: 'analyzed',
    runStatus: 'SUCCEEDED',
    runId,
    workflowId: 'run-analysis.v1',
    workflowHash: 'hash',
    reportReady: true,
    reportPath: `report/report_20260803_10000${index}.md`,
    reportBytes: 1500,
    conclusionRating: 'buy',
    reviewTaskStatus: null,
    stopReason: null,
  };
}

function failedProjectEvidence(index, projectId, ideaId, runId = `run_${projectId}`) {
  return {
    index,
    ideaId,
    projectId,
    sourceIdeaId: ideaId,
    status: 'failed',
    runStatus: 'FAILED',
    runId,
    workflowId: 'run-analysis.v1',
    workflowHash: 'hash',
    reportReady: false,
    reportPath: null,
    reportBytes: 0,
    conclusionRating: null,
    reviewTaskStatus: null,
    stopReason: 'business-error',
  };
}

const SCORECARD_LENSES = ['data', 'industry', 'company'];
const REPORT_CONTENT = '# Verified report\n\nBound candidate evidence.';
const REPORT_DIGEST = `sha256:${createHash('sha256').update(REPORT_CONTENT).digest('hex')}`;
const SCORECARD_DIGEST = `sha256:${'c'.repeat(64)}`;
const SCORECARD_AS_OF = '2026-08-01T06:30:00.000Z';

function scorecardRef(lens) {
  const scorecardPath = `analysis/scorecards/${lens}_r1.json`;
  return {
    contract: 'artifact-ref.v1',
    artifactId: `fixture:${scorecardPath}`,
    version: 1,
    path: scorecardPath,
    contentDigest: SCORECARD_DIGEST,
    schemaVersion: 'scorecard-evaluation.v1',
    producer: `${lens}-scoreboard-evaluator`,
    contractVersion: '2.3.0',
    inputDigest: REPORT_DIGEST,
    createdAt: SCORECARD_AS_OF,
    asOf: SCORECARD_AS_OF,
  };
}

function scorecardBundle() {
  return Object.fromEntries(SCORECARD_LENSES.map((lens, index) => {
    const score = [8200, 7600, 9200][index];
    const qualityBand = score >= 9000 ? 'A' : score >= 8000 ? 'B' : score >= 7000 ? 'C' : 'D';
    return [lens, {
      lens,
      rubricVersion: 'v3.1-en',
      sourceCandidateDigest: REPORT_DIGEST,
      sourceCycle: 0,
      asOf: SCORECARD_AS_OF,
      ref: scorecardRef(lens),
      finalScoreBps: score,
      qualityBand,
      displayResult: score >= 8000 ? 'pass' : 'fail',
      units: [{
        unitId: lens,
        unitKind: 'project',
        unitStatus: 'scored',
        finalScoreBps: score,
        qualityBand,
        displayResult: score >= 8000 ? 'pass' : 'fail',
      }],
      rubricResults: [{ secret: 'evaluator-internal' }],
    }];
  }));
}

function nestedScorecardStatus(overrides = {}) {
  const scorecards = scorecardBundle();
  return {
    projectStatus: 'analyzed',
    runStatus: 'SUCCEEDED',
    currentRunId: 'run_verified',
    workflow: { id: 'run-analysis.v2', hash: 'hash' },
    reportReady: true,
    reportPackage: {
      reportPath: 'report/report.md',
      conclusion: { rating: 'hold' },
      scorecardCandidateDigest: REPORT_DIGEST,
      scorecards,
      scorecardRefs: SCORECARD_LENSES.map((lens) => scorecards[lens].ref),
      ...overrides,
    },
    run: { stopReason: 'final' },
  };
}

function projectNestedEvidence(status) {
  return projectEvidence({
    projectEntry: { index: 0, idea: { id: 'idea_verified' }, project: { id: 'proj_verified' } },
    status,
    ProjectSpace: {
      meta: () => ({ sourceIdeaId: 'idea_verified' }),
      fileContent: () => REPORT_CONTENT,
    },
  });
}

test('daily report gate projects only a complete verified nested reportPackage scorecard bundle', () => {
  const complete = projectNestedEvidence({
    ...nestedScorecardStatus(),
    // A legacy-shaped partial value must not override the verified package.
    scorecards: { data: { secret: 'do-not-expose' } },
    scorecardStatus: 'available',
  });
  assert.equal(complete.scorecardStatus, 'available');
  assert.deepEqual(Object.keys(complete.scorecards), SCORECARD_LENSES);
  assert.deepEqual(
    complete.scorecardRefs.map((ref) => ref.path),
    SCORECARD_LENSES.map((lens) => `analysis/scorecards/${lens}_r1.json`),
  );
  assert.deepEqual(
    complete.scorecardRefs.map((ref) => ref.path),
    Object.values(complete.scorecards).map((scorecard) => scorecard.ref.path),
  );
  assert.equal(complete.scorecards.company.finalScoreBps, 9200);
  assert.equal(Object.hasOwn(complete.scorecards.data, 'rubricResults'), false);
  assert.equal(Object.hasOwn(complete, 'score'), false);

  const legacySource = nestedScorecardStatus().reportPackage;
  const legacy = projectNestedEvidence({
    projectStatus: 'analyzed',
    runStatus: 'SUCCEEDED',
    reportReady: true,
    reportPackage: null,
    scorecardCandidateDigest: REPORT_DIGEST,
    scorecards: legacySource.scorecards,
    scorecardRefs: legacySource.scorecardRefs,
  });
  assert.equal(legacy.scorecardStatus, 'available');
  assert.deepEqual(Object.keys(legacy.scorecards), SCORECARD_LENSES);

  for (const mutate of [
    (reportPackage) => { delete reportPackage.scorecards.company; },
    (reportPackage) => { reportPackage.scorecardRefs = reportPackage.scorecardRefs.slice(0, 2); },
    (reportPackage) => { reportPackage.scorecardCandidateDigest = `sha256:${'d'.repeat(64)}`; },
  ]) {
    const status = nestedScorecardStatus();
    mutate(status.reportPackage);
    const projected = projectNestedEvidence(status);
    assert.equal(projected.scorecardStatus, 'unavailable');
    assert.equal(projected.scorecardCandidateDigest, null);
    assert.equal(projected.scorecards, null);
    assert.deepEqual(projected.scorecardRefs, []);
  }

  const missing = projectNestedEvidence({
    projectStatus: 'analyzed',
    runStatus: 'SUCCEEDED',
    reportReady: true,
    reportPackage: null,
  });
  assert.equal(missing.scorecardStatus, 'unavailable');
});

test('daily report rescue fresh-reruns unfinished projects once and updates final evidence', async () => {
  const projectEntries = [
    { index: 0, idea: { id: 'idea_a' }, project: { id: 'proj_a' } },
    { index: 1, idea: { id: 'idea_b' }, project: { id: 'proj_b' } },
  ];
  const initialProjects = [
    verifiedProjectEvidence(0, 'proj_a', 'idea_a', 'run_a1'),
    failedProjectEvidence(1, 'proj_b', 'idea_b', 'run_b1'),
  ];
  const statusByProject = new Map();
  const starts = [];
  const service = {
    start(projectId, options) {
      starts.push({ projectId, options });
      statusByProject.set(projectId, {
        projectStatus: 'analyzed',
        runStatus: 'SUCCEEDED',
        currentRunId: 'run_b2',
        workflow: { id: 'run-analysis.v1', hash: 'hash' },
        reportReady: true,
        reportPackage: {
          reportPath: 'report/report_20260803_101010.md',
          conclusion: { rating: 'buy' },
        },
        run: { stopReason: null },
      });
      return {
        started: true,
        queuePosition: 0,
        mode: 'fresh',
        currentRunId: 'run_b2',
      };
    },
    status(projectId) {
      return statusByProject.get(projectId);
    },
  };
  const ProjectSpace = {
    meta(projectId) {
      return { sourceIdeaId: projectId === 'proj_a' ? 'idea_a' : 'idea_b' };
    },
    fileContent() {
      return `# Recovered report\n\n${'A'.repeat(1500)}`;
    },
  };

  const rescue = await runRescueAnalyses({
    service,
    projectEntries,
    initialProjects,
    config: {
      rescueAttempts: 1,
      intensity: 'quick',
      timeoutMs: 1000,
      pollMs: 1,
    },
    logProgress() {},
    ProjectSpace,
  });

  assert.deepEqual(starts, [{
    projectId: 'proj_b',
    options: { intensity: 'quick', resume: false },
  }]);
  assert.equal(rescue.attempts.length, 1);
  assert.equal(rescue.totalProjectsRetried, 1);
  assert.equal(rescue.recoveredProjects, 1);
  assert.deepEqual(rescue.finalIncompleteProjectIds, []);
  assert.equal(rescue.projects[0].runId, 'run_a1');
  assert.equal(rescue.projects[1].runId, 'run_b2');
  assert.equal(projectEvidenceHasVerifiedReport(rescue.projects[1]), true);
});

test('daily report rescue stops after configured attempts when a project still fails', async () => {
  const projectEntries = [
    { index: 0, idea: { id: 'idea_a' }, project: { id: 'proj_a' } },
  ];
  const initialProjects = [
    failedProjectEvidence(0, 'proj_a', 'idea_a', 'run_a1'),
  ];
  let starts = 0;
  const service = {
    start() {
      starts += 1;
      return {
        started: true,
        queuePosition: 0,
        mode: 'fresh',
        currentRunId: 'run_a2',
      };
    },
    status() {
      return {
        projectStatus: 'failed',
        runStatus: 'FAILED',
        currentRunId: 'run_a2',
        workflow: { id: 'run-analysis.v1', hash: 'hash' },
        reportReady: false,
        reportPackage: null,
        run: { stopReason: 'business-error' },
      };
    },
  };
  const ProjectSpace = {
    meta() {
      return { sourceIdeaId: 'idea_a' };
    },
    fileContent() {
      return '';
    },
  };

  const rescue = await runRescueAnalyses({
    service,
    projectEntries,
    initialProjects,
    config: {
      rescueAttempts: 1,
      intensity: 'quick',
      timeoutMs: 1000,
      pollMs: 1,
    },
    logProgress() {},
    ProjectSpace,
  });

  assert.equal(starts, 1);
  assert.equal(rescue.attempts.length, 1);
  assert.equal(rescue.recoveredProjects, 0);
  assert.deepEqual(rescue.finalIncompleteProjectIds, ['proj_a']);
  assert.equal(projectEvidenceHasVerifiedReport(rescue.projects[0]), false);
});

test('daily report gate terminalizes and closes its batch after a producer timeout', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'finagent-aborted-daily-gate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const fixedIdeasFile = path.join(temp, 'fixed-ideas.json');
  await writeFile(fixedIdeasFile, JSON.stringify({
    ideas: [{
      id: 'idea_timeout_alpha',
      title: 'Timeout Alpha deterministic failure case',
      sentence: 'Timeout Alpha verifies terminal batch finalization after the producer aborts.',
      tickers: ['MSFT'],
      theme: 'Software infrastructure',
      associatedProjectIds: [],
    }],
  }), 'utf8');

  let failure;
  try {
    await runDailyReportGate({
      fixedIdeasPath: fixedIdeasFile,
      ideas: 1,
      batchSize: 1,
      timeoutMs: 1,
      pollMs: 100,
      outputDir: path.join(temp, 'evidence'),
      quiet: true,
      rescueAttempts: 0,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the deterministic timeout must reject');
  const evidence = JSON.parse(await readFile(failure.evidencePath, 'utf8'));
  assert.equal(evidence.dailyReportBatch.status, 'closed');
  assert.deepEqual(evidence.dailyReportBatch.completion.summary, { total: 1, succeeded: 0, failed: 1 });
  assert.equal(evidence.dailyReportBatch.items[0].status, 'failed');
  assert.equal(evidence.dailyReportBatch.items[0].outcome.stage, 'production');
  assert.equal(evidence.dailyReportBatch.completion.processingTrigger.status, 'no-work');
});

test('daily report gate runs independent project workflows and publishes reports in demo mode', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'finagent-daily-gate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputDir = path.join(temp, 'evidence');
  const inheritedDataDir = path.join(temp, 'must-not-use');

  const { stdout } = await execFileAsync(process.execPath, [
    scriptFile,
    '--ideas', '4',
    '--batch-size', '2',
    '--timeout-ms', '180000',
    '--poll-ms', '100',
    '--output-dir', outputDir,
    '--quiet',
  ], {
    cwd: backendRoot,
    env: {
      ...process.env,
      FIN_DATA_DIR: inheritedDataDir,
      DEMO_MODE: 'false',
      AUTO_RESUME: 'true',
    },
    maxBuffer: 1024 * 1024,
    timeout: 240_000,
  });

  const cli = JSON.parse(stdout);
  assert.equal(cli.ok, true);
  assert.equal(cli.live, false);
  assert.equal(cli.ideas, 4);
  assert.equal(cli.projects, 4);
  assert.equal(cli.reports, 4);
  assert.equal(cli.batchSize, 2);
  assert.equal(cli.maxAnalyzingObserved, 2);

  const evidence = JSON.parse(await readFile(cli.evidencePath, 'utf8'));
  assert.equal(evidence.ok, true);
  assert.equal(evidence.dataDir, path.join(outputDir, 'data'));
  assert.equal(evidence.provider.activeProvider, 'demo');
  assert.deepEqual(evidence.reportAdmissionRecovery, {
    candidateCount: 0,
    admittedCount: 0,
    retryableCount: 0,
    failedCount: 0,
  });
  assert.equal(evidence.provider.liveLLM, false);
  assert.equal(evidence.ideaGeneration.generated, 4);
  assert.equal(evidence.ideaGeneration.live, false);
  assert.equal(evidence.batch.maxConcurrent, 2);
  assert.equal(evidence.batch.queuedAtStart, 2);
  assert.equal(evidence.batch.observations.maxAnalyzingObserved, 2);
  assert.equal(evidence.rescue.enabled, true);
  assert.equal(evidence.rescue.attemptsConfigured, 1);
  assert.deepEqual(evidence.rescue.attempts, []);
  assert.equal(evidence.verification.ok, true);
  assert.equal(evidence.verification.noHumanReviewTasks, true);
  assert.equal(evidence.verification.canonicalWorkflowInvocations, 4);
  assert.equal(evidence.verification.reports, 4);
  assert.equal(evidence.dailyReportBatch.status, 'closed');
  assert.deepEqual(evidence.dailyReportBatch.completion.summary, { total: 4, succeeded: 4, failed: 0 });
  assert.equal(evidence.dailyReportBatch.completion.processingTrigger.status, 'requested');
  assert.equal(evidence.dailyReportBatch.completion.processingTrigger.processingTarget, 'canonical-worldview-processing.v1');
  assert.equal(evidence.dailyReportBatch.completion.processingTrigger.pendingReportCount, 4);
  assert.equal(evidence.projects.length, 4);
  assert.equal(new Set(evidence.projects.map((project) => project.projectId)).size, 4);
  assert.equal(new Set(evidence.projects.map((project) => project.ideaId)).size, 4);
  assert.equal(new Set(evidence.projects.map((project) => project.runId)).size, 4);
  for (const project of evidence.projects) {
    assert.equal(project.status, 'analyzed');
    assert.equal(project.runStatus, 'SUCCEEDED');
    assert.equal(project.workflowId, 'run-analysis.v2');
    assert.equal(project.sourceIdeaId, project.ideaId);
    assert.equal(project.reportReady, true);
    assert.match(project.reportPath, /^report\/report_\d{8}_\d{6}\.md$/u);
    assert.ok(project.reportBytes > 1000);
    assert.equal(project.reviewTaskStatus, null);
  }
  const reportProjection = JSON.parse(await readFile(path.join(evidence.dataDir, 'report-library/projections/reports.json'), 'utf8'));
  assert.equal(reportProjection.entries.length, 4);
  assert.ok(reportProjection.entries.every((report) => report.overview.status === 'ready'));
  assert.ok(reportProjection.entries.every((report) => report.worldview.status === 'processed'));
  assert.equal(evidence.worldviewProcessing.status, 'succeeded');
  assert.equal(evidence.worldviewProcessing.runs.length, 1);
  assert.equal(evidence.worldviewProcessing.runs[0].outcome, 'UPDATE');
  assert.ok(evidence.worldviewProcessing.runs[0].publicationId);
  assert.equal(evidence.worldviewProcessing.runs[0].processedReceipts.length, 4);
  assert.equal(evidence.claimLibrary.claims.length, 1);
  assert.equal(evidence.claimLibrary.claims[0].assertion, 'The demo demand signal will remain observable through 2027-03-31.');
  const processingRunDir = path.join(evidence.dataDir, 'canonical-worldview', 'processing-runs');
  const processingRunFiles = (await readdir(processingRunDir)).filter((name) => name.endsWith('.json'));
  assert.equal(processingRunFiles.length, 1);
  const processingRun = JSON.parse(await readFile(path.join(processingRunDir, processingRunFiles[0]), 'utf8'));
  assert.deepEqual(processingRun.execution.attemptEvidence, {
    providerAttempts: 0,
    networkAttempts: 0,
    liveModelAttempts: 0,
    modelApiAttempts: 1,
  });
  assert.ok(processingRun.capabilityTraceCount >= 2, 'demo Core Agent must use governed capabilities before returning');
});

test('daily report gate can skip Idea Generation and use a fixed idea batch', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'finagent-fixed-idea-gate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputDir = path.join(temp, 'evidence');
  const fixedIdeasFile = path.join(temp, 'fixed-ideas.json');
  await writeFile(fixedIdeasFile, JSON.stringify({
    ideas: [
      {
        id: 'idea_fixed_alpha',
        title: 'Fixed Alpha cloud margin expansion',
        sentence: 'Fixed Alpha tests the Project workflow with a clean large-cap software thesis.',
        tickers: ['MSFT'],
        theme: 'Software infrastructure',
        associatedProjectIds: ['proj_old_alpha'],
        sourceRunId: 'idea_run_old',
        sourceSnapshotId: 'idea-run-input-snapshot:old',
        sourceIdeaRunId: 'idea_run_old',
        sourceRunInputSnapshotId: 'idea-run-input-snapshot:old',
        sourceRunAsOf: '2026-07-31T00:00:00.000Z',
        sourceEffectiveConfigDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sourceGeneratorTraceRef: 'old-generator',
        sourceQualityTraceRef: 'old-quality',
      },
      {
        id: 'idea_fixed_beta',
        title: 'Fixed Beta industrial automation recovery',
        sentence: 'Fixed Beta tests another independent Project workflow.',
        tickers: ['HON'],
        theme: 'Industrial automation',
        associatedProjectIds: ['proj_old_beta'],
      },
    ],
  }), 'utf8');

  const { stdout } = await execFileAsync(process.execPath, [
    scriptFile,
    '--fixed-ideas', fixedIdeasFile,
    '--ideas', '2',
    '--batch-size', '1',
    '--timeout-ms', '180000',
    '--poll-ms', '100',
    '--output-dir', outputDir,
    '--quiet',
  ], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DEMO_MODE: 'false',
      AUTO_RESUME: 'true',
    },
    maxBuffer: 1024 * 1024,
    timeout: 240_000,
  });

  const cli = JSON.parse(stdout);
  assert.equal(cli.ok, true);
  assert.equal(cli.ideaSource, 'fixed-ideas');
  assert.equal(cli.ideas, 2);
  assert.equal(cli.projects, 2);
  assert.equal(cli.reports, 2);

  const evidence = JSON.parse(await readFile(cli.evidencePath, 'utf8'));
  assert.equal(evidence.ideaGeneration.source, 'fixed-ideas');
  assert.equal(evidence.ideaGeneration.workflowId, null);
  assert.equal(evidence.ideaGeneration.live, false);
  assert.equal(evidence.ideaGeneration.candidateIdeas, 2);
  assert.equal(evidence.ideaGeneration.persistedIdeas, 2);
  assert.equal(evidence.verification.ok, true);
  assert.equal(evidence.batch.queuedAtStart, 1);
  assert.equal(evidence.projects.length, 2);

  const firstProject = evidence.projects[0];
  const firstIdea = JSON.parse(await readFile(
    path.join(evidence.dataDir, 'idea-generation/ideas', firstProject.ideaId, 'idea.json'),
    'utf8',
  ));
  assert.deepEqual(firstIdea.body.associatedProjectIds, [firstProject.projectId]);
  assert.equal(firstIdea.body.sourceIdeaRunId, undefined);
  assert.equal(firstIdea.body.sourceRunId, undefined);

  const firstProjectMeta = JSON.parse(await readFile(
    path.join(evidence.dataDir, 'projects', firstProject.projectId, 'meta.json'),
    'utf8',
  ));
  assert.equal(firstProjectMeta.sourceIdeaRunId, null);
  assert.equal(firstProjectMeta.sourceRunInputSnapshotId, null);
});
