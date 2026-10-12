import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { runPublicToolTest } from '../src/tools/index.js';

const frontend = (relative) => readFile(
  new URL(`../../frontend/src/${relative}`, import.meta.url),
  'utf8',
);
const backend = (relative) => readFile(
  new URL(`../src/${relative}`, import.meta.url),
  'utf8',
);

test('product server exposes no public Human Review commands or mutation guards', async () => {
  const [server, editing] = await Promise.all([
    backend('server.js'),
    backend('workflows/run-analysis/reportEditing.js'),
  ]);

  for (const route of [
    "app.get('/api/projects/:projectId/reviews/open'",
    "app.get('/api/reviews/:taskId'",
    "app.post('/api/reviews/:taskId/preview'",
    "app.post('/api/reviews/:taskId/decision'",
    "app.post('/api/reviews/:taskId/resume'",
  ]) {
    assert.equal(server.includes(route), false, route);
  }
  assert.doesNotMatch(server, /RunAnalysisHumanReviewController/u);
  assert.doesNotMatch(server, /humanReviewController/u);
  assert.match(
    server,
    /\/api\/projects\/:id\/report\/translate'[\s\S]*?runDefinedAgent\('report-translator'/u,
  );
  assert.match(
    server,
    /runDefinedAgent\('report-translator'[\s\S]*?setTimestampedReport/u,
  );
  assert.match(
    server,
    /\/api\/projects\/:id\/settings'[\s\S]*?ProjectFS\.updateMeta/u,
  );
  assert.match(server, /openIssues:\s*_openIssues,[\s\S]*?lastError:\s*_lastError/u);
  assert.match(server, /\.map\(safeCompatibilityEventProjection\)\s*\.filter\(Boolean\)/u);
  assert.match(
    server,
    /\/api\/projects\/:id\/files\/\*'[\s\S]*?normalizeWorkspaceContentPath\(req\.params\[0\]\)/u,
  );
  assert.doesNotMatch(editing, /assertRunAnalysisReviewMutationAllowed/u);
  assert.doesNotMatch(editing, /beforeToolExecution:\s*\(\)\s*=>/u);
  assert.match(
    server,
    /\/api\/tools\/test'[\s\S]*?runPublicToolTest\(req\.body\?\.name, req\.body\?\.args \|\| \{\}\)/u,
  );
});

test('public tool testing rejects every catalog write tool before execution', async () => {
  for (const name of [
    'project_write_current_file',
    'project_append_current_file',
    'ws_write_file',
    'ws_append_file',
    'ws_edit_file',
  ]) {
    await assert.rejects(
      runPublicToolTest(name, {
        currentProjectId: 'project-under-review',
        projectId: 'project-under-review',
        file: 'analysis/checkpoint.json',
        content: 'forbidden',
        oldText: '{}',
        newText: 'forbidden',
      }),
      (error) => error.code === 'PUBLIC_TOOL_TEST_WORKSPACE_DENIED' && error.statusCode === 403,
      name,
    );
  }
  await assert.rejects(
    runPublicToolTest('ws_read_file', {
      projectId: 'project-under-review',
      file: 'analysis/checkpoint.json',
    }),
    (error) => error.code === 'PUBLIC_TOOL_TEST_WORKSPACE_DENIED' && error.statusCode === 403,
  );
});

test('frontend exposes no Human Review API helpers', async () => {
  const source = await frontend('api.js');

  assert.doesNotMatch(source, /openReview|previewReview|decideReview|resumeReview/u);
  assert.doesNotMatch(source, /\/reviews\/open|\/api\/reviews|\/reviews\/[^`]+\/(?:preview|decision|resume)/u);
});

test('frontend Human Review panel source is removed from product views', async () => {
  await assert.rejects(access(new URL('../../frontend/src/views/HumanReviewPanel.jsx', import.meta.url)));
});

test('Project detail has no Review CTA, tab, or report mutation lock', async () => {
  const [detail, projects] = await Promise.all([
    frontend('views/ProjectDetail.jsx'),
    frontend('views/ProjectsView.jsx'),
  ]);

  assert.doesNotMatch(detail, /ACTIVE_REVIEW_STATUSES|reviewLocked|showReview|reviewVisible/u);
  assert.doesNotMatch(detail, /setTab\('review'\)|处理人工复核|<HumanReviewPanel/u);
  assert.match(
    detail,
    /disabled=\{translating \|\| !selectedIsPublished\}/u,
  );
  assert.match(
    detail,
    /const reportFeedbackAllowed = data\.reportReady === true[\s\S]*?&& hasPublishedReport[\s\S]*?&& Boolean\(data\.report\)[\s\S]*?&& !running/u,
  );
  assert.doesNotMatch(detail, /disabled=\{reviewLocked\}|if \(!text \|\| sending \|\| disabled\) return/u);
  assert.doesNotMatch(projects, /待人工复核|提交结构化决策/u);
  assert.match(projects, /历史未发布状态已退役/u);
});
