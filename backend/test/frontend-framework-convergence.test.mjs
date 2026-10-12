import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  acceptsProjectRequest,
  selectVisibleRunId,
} from '../../frontend/src/views/workflowRunSelection.js';

const frontend = (relative) => readFile(
  new URL(`../../frontend/src/${relative}`, import.meta.url),
  'utf8',
);

test('Idea view consumes canonical workflow metadata and renders durable quality and lineage fields', async () => {
  const [ideaView, app] = await Promise.all([
    frontend('views/IdeaView.jsx'),
    frontend('App.jsx'),
  ]);

  assert.match(ideaView, /api\.ideaWorkflowSpec\(\)/u);
  assert.match(ideaView, /workflowSpec\?\.nodes \|\| \[\]/u);
  assert.match(ideaView, /Canonical Idea Workflow（六节点）/u);
  for (const field of [
    'trace.runId',
    'trace.snapshotId',
    'trace.asOf',
    'workflowIdentity.version',
    'workflowIdentity.hash',
    'trace.configDigest',
    'state?.status',
    'state?.attempt',
    'state?.lastFailure',
    'state?.artifactRefs?.length',
  ]) {
    assert.match(ideaView, new RegExp(field.replaceAll('?', '\\?').replaceAll('.', '\\.'), 'u'), field);
  }

  for (const field of [
    'qualityScore',
    'qualityRank',
    'qualitySelected',
    'qualityReason',
    'qualityWarnings',
    'sourceIdeaRunId',
    'sourceRunInputSnapshotId',
    'sourceRunAsOf',
  ]) {
    assert.match(ideaView, new RegExp(field, 'u'), field);
  }
  assert.match(ideaView, /只排序\/注释，不决定发布/u);
  assert.match(ideaView, /无 durable lineage/u);
  assert.match(ideaView, /项目已创建但尚未分析/u);
  assert.match(ideaView, /onOpenProject\(projectId\)/u);
  assert.match(app, /onOpenProject=\{\(id\) => \{ setOpenDailyRun\(null\); setOpenProject\(id\); \}\}/u);
  assert.match(ideaView, /else goProjects\?\.\(\)/u);
});

test('Project views expose canonical status, lineage, run identity, and visible analysis failures', async () => {
  const [projectsView, detailView] = await Promise.all([
    frontend('views/ProjectsView.jsx'),
    frontend('views/ProjectDetail.jsx'),
  ]);
  const combined = `${projectsView}\n${detailView}`;

  assert.doesNotMatch(combined, /Agent Loop/u);
  assert.match(projectsView, /canonical Run Analysis Workflow/u);
  assert.match(detailView, /meta\.status === 'created'/u);
  assert.match(detailView, /meta\.status === 'analyzed'/u);
  assert.match(combined, /queuePosition/u);
  for (const field of [
    'sourceIdeaId',
    'sourceIdeaRunId',
    'sourceRunInputSnapshotId',
    'analysisRunId',
    'reportReady',
  ]) {
    assert.match(projectsView, new RegExp(field, 'u'), field);
    assert.match(detailView, new RegExp(field, 'u'), field);
  }
  assert.match(detailView, /分析启动\/恢复失败/u);
  assert.match(detailView, /分析已启动，但状态刷新失败/u);
  assert.match(detailView, /role="alert"/u);
  assert.match(projectsView, /interrupted: '分析已中断/u);
});

test('Project file view is public-only, fail-visible, and labels only the verified report path as published', async () => {
  const detailView = await frontend('views/ProjectDetail.jsx');

  assert.match(detailView, /Workspace · 公开项目视图/u);
  assert.match(detailView, /不是 runtime mount、snapshot 或 capability 全景/u);
  assert.match(detailView, /Data · 输入数据/u);
  assert.match(detailView, /Analysis · 中间产物/u);
  assert.match(detailView, /Report · 报告文件/u);
  assert.match(detailView, /草稿\/历史文件，非当前发布/u);
  assert.match(detailView, /file\?\.name === publishedReportPath/u);
  assert.match(detailView, /data\.analysis\?\.reportPackage\?\.reportPath/u);
  assert.match(detailView, /\? '已验证发布'/u);
  assert.match(detailView, /项目文件 API 读取失败/u);
  assert.match(detailView, /onClick=\{loadWorkspaceFiles\}>重试/u);
  assert.match(detailView, /项目文件内容读取失败/u);
  assert.match(detailView, /当前已验证发布/u);
  assert.match(detailView, /历史\/草稿，非当前发布/u);
  assert.match(detailView, /workspaceRequest\.current \+= 1/u);
  assert.match(detailView, /fileRequest\.current \+= 1/u);
  assert.match(detailView, /setActiveFile\(null\)/u);
  assert.doesNotMatch(detailView, /data\.files/u);
  assert.doesNotMatch(detailView, /已同步/u);
  assert.doesNotMatch(detailView, /内部运行产物/u);
});

test('run selection keeps an old run, follows a newly active run, and respects a manual history pin', () => {
  const oldRun = { runId: 'run-old', status: 'SUCCEEDED' };
  const activeRun = { runId: 'run-active', status: 'RUNNING' };

  assert.equal(selectVisibleRunId({
    runs: [oldRun],
    currentRunId: 'run-old',
  }), 'run-old');
  assert.equal(selectVisibleRunId({
    runs: [activeRun, oldRun],
    currentRunId: 'run-old',
    activeRunId: 'run-active',
  }), 'run-active');
  assert.equal(selectVisibleRunId({
    runs: [activeRun, oldRun],
    currentRunId: 'run-active',
    activeRunId: 'run-active',
    manualRunId: 'run-old',
  }), 'run-old');
});

test('project request guard rejects stale sequence numbers and cross-project responses', () => {
  assert.equal(acceptsProjectRequest({
    requestId: 4,
    latestRequestId: 4,
    requestedProjectId: 'project-a',
    currentProjectId: 'project-a',
  }), true);
  assert.equal(acceptsProjectRequest({
    requestId: 3,
    latestRequestId: 4,
    requestedProjectId: 'project-a',
    currentProjectId: 'project-a',
  }), false);
  assert.equal(acceptsProjectRequest({
    requestId: 4,
    latestRequestId: 4,
    requestedProjectId: 'project-a',
    currentProjectId: 'project-b',
  }), false);
});

test('Workflow run view refreshes the run list while analyzing and applies pure selection', async () => {
  const source = await frontend('views/WorkflowRunView.jsx');

  assert.match(source, /acceptsProjectRequest\(\{/u);
  assert.match(source, /runsRequest\.current \+= 1/u);
  assert.match(source, /detailRequest\.current \+= 1/u);
  assert.match(source, /projectIdRef\.current !== requestedProjectId/u);
  assert.match(source, /wasAnalyzingRef/u);
  assert.match(source, /else void refresh\(\)/u);
  assert.match(source, /selectVisibleRunId\(\{/u);
  assert.match(source, /const visibleRunId = await loadRuns\(\)/u);
  assert.match(source, /setManualRunId/u);
  assert.match(source, /\[projectId, runId, manualRunId, analyzing\]/u);
});

test('report feedback is verified-only, collapsed by default, and locally scroll-contained', async () => {
  const source = await frontend('views/ProjectDetail.jsx');

  assert.match(source, /const \[chatOpen, setChatOpen\] = useState\(false\)/u);
  assert.match(
    source,
    /const reportFeedbackAllowed = data\.reportReady === true[\s\S]*?&& hasPublishedReport[\s\S]*?&& Boolean\(data\.report\)[\s\S]*?&& !running/u,
  );
  assert.match(
    source,
    /\{reportFeedbackAllowed && \([\s\S]*?aria-expanded=\{chatOpen\}[\s\S]*?\{chatOpen && \([\s\S]*?<ChatPanel/u,
  );
  assert.match(source, /setData\(null\);\s*setChatOpen\(false\)/u);
  assert.match(
    source,
    /data\?\.reportReady !== true[\s\S]*?\|\| !data\?\.report[\s\S]*?\|\| !meta\?\.conclusion[\s\S]*?\|\| running[\s\S]*?setChatOpen\(false\)/u,
  );
  assert.match(
    source,
    /setShowOpts\(false\);\s*setChatOpen\(false\);\s*setAnalyzing\(true\)/u,
  );
  assert.match(source, /Report Feedback（受限）/u);
  assert.match(source, /正式修订闭环将在后续实现/u);

  assert.doesNotMatch(source, /scrollIntoView/u);
  assert.doesNotMatch(source, /behavior:\s*['"]smooth['"]/u);
  assert.match(source, /const scrollContainerRef = useRef\(null\)/u);
  assert.match(source, /ref=\{scrollContainerRef\}/u);
  assert.match(source, /scrollContainer\.scrollTop = scrollContainer\.scrollHeight/u);
  assert.match(source, /nearBottomRef\.current/u);
  assert.match(source, /CHAT_BOTTOM_THRESHOLD_PX/u);
  assert.match(source, /syncedInitialSignatureRef\.current === initialSignature/u);
  assert.match(source, /hasAppendedAssistantMessage\(current, next\) && nearBottomRef\.current/u);
});

test('Project and Idea polling are lightweight, stale-guarded, and single-flight', async () => {
  const [project, idea, workflow] = await Promise.all([
    frontend('views/ProjectDetail.jsx'),
    frontend('views/IdeaView.jsx'),
    frontend('views/WorkflowRunView.jsx'),
  ]);

  assert.doesNotMatch(project, /setInterval/u);
  assert.doesNotMatch(idea, /setInterval/u);
  assert.match(project, /const status = await api\.analysisStatus\(requestedProjectId\)/u);
  assert.match(project, /if \(stopped \|\| request !== analysisStatusRequest\.current\) return/u);
  assert.match(project, /\} else \{\s*await load\(\);\s*return;/u);
  assert.match(
    project,
    /await api\.analysisStatus\(requestedProjectId\)[\s\S]*?timer = setTimeout\(poll, 1500\)/u,
  );
  assert.doesNotMatch(
    project,
    /setData\(\(current\)[\s\S]*?reportReady:\s*status\.reportReady/u,
  );

  assert.match(idea, /const r = await api\.ideaProgress\(\)/u);
  assert.match(idea, /if \(stopped \|\| request !== latestRequest\) return/u);
  assert.match(
    idea,
    /const r = await api\.ideaProgress\(\)[\s\S]*?timer = setTimeout\(poll, 700\)/u,
  );
  assert.match(idea, /latestRequest \+= 1;\s*clearTimeout\(timer\)/u);

  assert.doesNotMatch(workflow, /setInterval/u);
  assert.match(workflow, /const visibleRunId = await loadRuns\(\)/u);
  assert.match(workflow, /if \(visibleRunId\) await loadDetail\(visibleRunId, \{ preserve: true \}\)/u);
  assert.match(workflow, /await refresh\(\);[\s\S]*?timer = setTimeout\(poll, 1500\)/u);
});

test('Idea and Run Analysis expose per-physical-Agent paginated execution drilldowns without raw chain-of-thought claims', async () => {
  const [api, inspector, idea, workflow] = await Promise.all([
    frontend('api.js'),
    frontend('views/AgentExecutionInspector.jsx'),
    frontend('views/IdeaView.jsx'),
    frontend('views/WorkflowRunView.jsx'),
  ]);

  assert.match(
    api,
    /ideaAgentTimeline:[\s\S]*?\/api\/ideas\/runs\/\$\{encodeURIComponent\(runId\)\}\/agents\/\$\{encodeURIComponent\(agentRunId\)\}\/timeline/u,
  );
  assert.match(
    api,
    /projectAgentTimeline:[\s\S]*?\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/runs\/\$\{encodeURIComponent\(runId\)\}\/agents\/\$\{encodeURIComponent\(agentRunId\)\}\/timeline/u,
  );
  assert.match(api, /afterSequence:\s*options\.afterSequence/u);
  assert.match(api, /limit:\s*options\.limit/u);

  assert.match(inspector, /key=\{execution\.agentRunId\}/u);
  assert.match(inspector, /aria-expanded=\{opened\}/u);
  assert.match(inspector, /loadTimeline\(agentRunId,\s*\{/u);
  assert.match(inspector, /afterSequence/u);
  assert.match(inspector, /加载更多执行事件/u);
  assert.match(inspector, /执行明细读取失败/u);
  assert.match(inspector, /可审计执行 \/ 推理摘要/u);
  assert.match(inspector, /不是模型隐藏思维链/u);
  assert.match(inspector, /不会展示 Prompt、工具参数或原始结果/u);
  assert.match(inspector, /item\.tool\.name/u);
  assert.match(inspector, /item\.tool\.status/u);
  assert.match(inspector, /item\.tool\.durationMs/u);
  assert.doesNotMatch(inspector, /\.args\b/u);
  assert.doesNotMatch(inspector, /\.result\b/u);
  assert.doesNotMatch(inspector, /\.thinking\b/u);

  assert.match(idea, /api\.ideaTrace\(r\.progress\.runId\)/u);
  assert.match(idea, /trace\?\.agentExecutions \|\| trace\?\.agentRuns \|\| \[\]/u);
  assert.match(idea, /execution\.nodeId === node\.id/u);
  assert.match(idea, /api\.ideaAgentTimeline\(runId, agentRunId, options\)/u);
  assert.doesNotMatch(idea, /trace\.systemPrompt/u);
  assert.doesNotMatch(idea, /trace\.userPrompt/u);

  assert.match(workflow, /detail\?\.agentExecutions \|\| detail\?\.agentRuns \|\| \[\]/u);
  assert.match(workflow, /execution\.nodeId === node\.id/u);
  assert.match(workflow, /api\.projectAgentTimeline\(projectId, runId, agentRunId, options\)/u);
  assert.doesNotMatch(workflow, /new Map\(runs\.map\(\(run\) => \[run\.agentId/u);
});
