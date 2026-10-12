import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('Project creation and Run Analysis are separate explicit API commands', async () => {
  const server = await source('src/server.js');
  const creationRoute = server.match(
    /app\.post\('\/api\/projects',[\s\S]*?(?=\/\/ 一句话快速建项目)/u,
  )?.[0] || '';

  assert.match(server, /import \{ createProjectFromIdea \} from '\.\/domains\/ideas\/createProjectFromIdea\.js';/u);
  assert.match(server, /import \{ RunAnalysisService \} from '\.\/workflows\/run-analysis\/RunAnalysisService\.js';/u);
  assert.match(creationRoute, /createProjectFromIdea\(req\.body \|\| \{\}\)/u);
  assert.doesNotMatch(creationRoute, /runAnalysisService|runAnalysisWorkflow|\/analyze/u);
  assert.match(
    server,
    /app\.post\('\/api\/projects\/:id\/analyze'[\s\S]*?runAnalysisService\.start\([\s\S]*?publicRunAnalysisOptions\(req\.body \|\| \{\}\)/u,
  );
  assert.match(
    server,
    /app\.get\('\/api\/projects\/:id\/analysis'[\s\S]*?runAnalysisService\.status/u,
  );
});

test('HTTP analysis input is restricted to the public run controls', async () => {
  const server = await source('src/server.js');
  const allowlist = server.match(
    /function publicRunAnalysisOptions\(body = \{\}\) \{[\s\S]*?\n\}/u,
  )?.[0] || '';

  assert.match(allowlist, /\['intensity', 'industryTemplate', 'companyTemplate'\]/u);
  assert.match(allowlist, /typeof body\.resume === 'boolean'/u);
  for (const internal of [
    'preparedRunId',
    'agentBackend',
    'frozenDataByRound',
    'cancelled',
    'signal',
    'demo',
    'asOf',
  ]) {
    assert.doesNotMatch(allowlist, new RegExp(`\\b${internal}\\b`, 'u'), internal);
  }
});

test('server owns no hidden Project analysis queue or direct Workflow runner', async () => {
  const server = await source('src/server.js');

  assert.doesNotMatch(server, /\b(?:analysisJobs|analysisQueue|analysisCancels|startAnalysisJob|requestRunAnalysis)\b/u);
  assert.doesNotMatch(server, /import\s*\{[^}]*\brunAnalysisWorkflow\b[^}]*\}/u);
  assert.match(server, /runAnalysisService\.recoverInterrupted\(\)/u);
  assert.match(server, /runAnalysisService\.inFlightProjectIds\(\)/u);
});

test('v2 server progress ignores retired reflection/crux/simulation checkpoint fields', async () => {
  const server = await source('src/server.js');
  assert.doesNotMatch(server, /cp\.(?:cruxes|sim)\b/u);
  assert.doesNotMatch(server, /数据→行业\/公司→反思/u);
  assert.doesNotMatch(server, /情景推演与定价/u);
});

test('public Project projections and frontend consumers gate output on verified report readiness', async () => {
  const [server, api, projectsView, detailView] = await Promise.all([
    source('src/server.js'),
    source('../frontend/src/api.js'),
    source('../frontend/src/views/ProjectsView.jsx'),
    source('../frontend/src/views/ProjectDetail.jsx'),
  ]);

  for (const status of [
    'queued',
    'analyzing',
    'analyzed',
    'review-required',
    'failed',
    'cancelled',
    'paused',
  ]) {
    assert.match(
      `${server}\n${projectsView}\n${detailView}`,
      new RegExp(`['"]${status}['"]`, 'u'),
      status,
    );
  }
  assert.match(server, /reportReady:\s*analysis\.reportReady/u);
  assert.match(server, /conclusion:\s*analysis\.reportPackage\?\.conclusion \|\| null/u);
  assert.match(api, /analysisStatus:\s*\(id, runId\)/u);
  assert.match(projectsView, /p\.reportReady && p\.conclusion/u);
  assert.match(detailView, /const hasPublishedReport = data\.reportReady && Boolean\(meta\.conclusion\)/u);
  assert.match(detailView, /const resumable = Boolean\(data\.analysis\?\.resumable\)/u);
  assert.match(detailView, /resumable && \(\['interrupted', 'paused', 'failed', 'cancelled'\]/u);
});

test('the retired Idea-to-Report pseudo Workflow has no executable source surface', async () => {
  await assert.rejects(access(new URL('../src/workflows/report-generation/index.js', import.meta.url)));
  await assert.rejects(access(new URL('../src/workflows/report-generation/ideaToReport.workflow.js', import.meta.url)));

  const [server, command, mapper] = await Promise.all([
    source('src/server.js'),
    source('src/domains/ideas/createProjectFromIdea.js'),
    source('src/domains/ideas/mapIdeaToProjectSeed.js'),
  ]);
  const active = `${server}\n${command}\n${mapper}`;
  assert.doesNotMatch(
    active,
    /runIdeaToReportWorkflow|createReportProject|IDEA_TO_REPORT_WORKFLOW|idea-to-report\.v1/u,
  );
  assert.doesNotMatch(command, /workflows\/run-analysis|runAnalysisWorkflow|RunAnalysisService/u);
});

test('downstream research and decision consumers require the same verified report package', async () => {
  const consumers = await Promise.all([
    source('src/domains/decision/portfolioAgent.js'),
    source('src/domains/decision/decisionSystem.js'),
    source('src/workflows/run-analysis/handlers/selectCandidates.js'),
  ]);

  for (const consumer of consumers) {
    assert.match(consumer, /latestVerifiedRunAnalysisReportPackage/u);
    assert.doesNotMatch(consumer, /status === 'analyzed' && [A-Za-z.]+\.conclusion/u);
  }
  assert.match(
    consumers[1],
    /const conclusion = reportPackage\.conclusion/u,
  );
});

test('non-server product harnesses use RunAnalysisService instead of bypassing it', async () => {
  const [demo, dailyReportGate] = await Promise.all([
    source('scripts/smokeDemoE2E.mjs'),
    source('scripts/runDaily100ReportGate.mjs'),
  ]);

  for (const harness of [demo, dailyReportGate]) {
    assert.match(harness, /RunAnalysisService/u);
    assert.doesNotMatch(harness, /\bawait runAnalysisWorkflow\s*\(/u);
  }
});
