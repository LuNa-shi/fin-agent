// 统一响应处理：非 2xx 一律抛错（带后端 error 信息），否则所有 500 都变成静默失败/undefined 渲染
const J = async (r) => {
  if (!r.ok) {
    let detail = '';
    try { const body = await r.json(); detail = body?.error || body?.message || JSON.stringify(body).slice(0, 200); }
    catch { try { detail = (await r.text()).slice(0, 200); } catch {} }
    throw new Error(`API ${r.status} ${r.url ? new URL(r.url).pathname : ''}${detail ? `: ${detail}` : ''}`);
  }
  if (r.status === 204 || r.status === 205) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const send = (method, url, body) => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(J);
const post = (url, body) => send('POST', url, body || {});
const patch = (url, body) => send('PATCH', url, body || {});
const del = (url) => send('DELETE', url);
const query = (values = {}) => {
  const params = new URLSearchParams(Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)]));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
};

export const api = {
  status: () => fetch('/api/status').then(J),
  saveSettings: (s) => post('/api/settings', s),
  keys: () => fetch('/api/keys').then(J),
  openAICompatibleModels: ({ baseUrl, apiKey = '', modelId = '' } = {}) => post(
    '/api/providers/openai-compatible/models',
    {
      baseUrl,
      ...(String(apiKey || '').trim() ? { apiKey: String(apiKey).trim() } : {}),
      ...(String(modelId || '').trim() ? { modelId: String(modelId).trim() } : {}),
    },
  ),

  // tools
  tools: () => fetch('/api/tools').then(J),
  toolTest: (name, args) => post('/api/tools/test', { name, args }),
  toolHealth: () => fetch('/api/tools/health').then(J),
  checkToolHealth: (name) => post('/api/tools/health/check', name ? { name } : {}),

  // Agent Studio
  agents: () => fetch('/api/agents').then(J),
  agent: (id) => fetch(`/api/agents/${encodeURIComponent(id)}`).then(J),
  saveAgent: (id, patchBody) => patch(`/api/agents/${encodeURIComponent(id)}`, {
    displayName: patchBody.displayName,
    description: patchBody.description,
    catalogVisibility: patchBody.visibility,
    systemPrompt: patchBody.systemPrompt,
    toolAllow: patchBody.toolIds,
    assignedSkillIds: patchBody.skillIds,
  }),
  skills: () => fetch('/api/skills').then(J),
  saveSkill: (skill, isNew = false) => isNew
    ? post('/api/skills', skill)
    : patch(`/api/skills/${encodeURIComponent(skill.id)}`, {
      name: skill.name,
      description: skill.description,
      instruction: skill.instruction,
      toolIds: skill.toolIds,
      visibility: skill.visibility,
    }),
  deleteSkill: (id) => del(`/api/skills/${encodeURIComponent(id)}`),

  // ideas
  ideas: () => fetch('/api/ideas').then(J),
  genIdeas: (count) => post('/api/ideas/generate', { count }),
  earningsIdeasPreview: (days = 7, market = 'global', forceRefresh = false) => post('/api/ideas/earnings/preview', { days, market, forceRefresh }),
  addEarningsIdeas: (candidates) => post('/api/ideas/earnings/add', { candidates }),
  ideaWorkflowSpec: () => fetch('/api/workflows/idea-generation').then(J),
  ideaProgress: (filters = {}) => fetch(`/api/ideas/progress${query(filters)}`).then(J),
  ideaStatus: (id, status) => post(`/api/ideas/${id}/status`, { status }),
  deleteIdea: (id) => post(`/api/ideas/${id}/delete`),
  ideaTraces: (limit, filters = {}) => fetch(`/api/ideas/traces${query({ limit, ...filters })}`).then(J),
  ideaTrace: (id, filters = {}) => fetch(`/api/ideas/traces/${encodeURIComponent(id)}${query(filters)}`).then(J),
  ideaAgentTimeline: (runId, agentRunId, options = {}) => fetch(
    `/api/ideas/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentRunId)}/timeline${query({
      afterSequence: options.afterSequence,
      limit: options.limit,
    })}`,
  ).then(J),

  // daily scheduled reports
  dailyReportRuns: (limit = 30) => fetch(`/api/daily-reports/runs${query({ limit })}`).then(J),
  dailyReportRun: (runId) => fetch(`/api/daily-reports/runs/${encodeURIComponent(runId)}`).then(J),
  dailyReportContent: (runId, projectId) => fetch(
    `/api/daily-reports/runs/${encodeURIComponent(runId)}/reports/${encodeURIComponent(projectId)}`,
  ).then(J),

  // Report Library (read-only)
  reportLibraryStatus: () => fetch('/api/report-library/status').then(J),
  reportLibraryBatches: ({ limit = 100, status = '' } = {}) => fetch(
    `/api/report-library/batches${query({ limit, status })}`,
  ).then(J),
  reportLibraryBatch: (batchId) => fetch(
    `/api/report-library/batches/${encodeURIComponent(batchId)}`,
  ).then(J),
  reportLibraryReports: ({ limit = 100, ticker = '' } = {}) => fetch(
    `/api/report-library/reports${query({ limit, ticker })}`,
  ).then(J),
  reportLibraryReport: (reportVersionId) => fetch(
    `/api/report-library/reports/${encodeURIComponent(reportVersionId)}`,
  ).then(J),
  reportLibraryReportContent: (reportVersionId) => fetch(
    `/api/report-library/reports/${encodeURIComponent(reportVersionId)}/content`,
  ).then(J),
  reportLibraryTickers: () => fetch('/api/report-library/tickers').then(J),
  reportLibraryTickerTimeline: (ticker, limit = 100) => fetch(
    `/api/report-library/tickers/${encodeURIComponent(ticker)}/timeline${query({ limit })}`,
  ).then(J),
  reportLibraryIngestions: () => fetch('/api/report-library/ingestions').then(J),
  reportLibraryIngestion: (ingestionId) => fetch(
    `/api/report-library/ingestions/${encodeURIComponent(ingestionId)}`,
  ).then(J),
  reportLibraryBackfill: (backfillRunId) => fetch(
    `/api/report-library/backfills/${encodeURIComponent(backfillRunId)}`,
  ).then(J),

  // Canonical Worldview (the sole active read-only Worldview product)
  worldviewCurrent: () => fetch('/api/worldview/current').then(J),
  worldviewProcessingLog: ({ limit = 100, cursor = '', state = '', outcome = '' } = {}) => fetch(
    `/api/worldview/processing-log${query({ limit, cursor, state, outcome })}`,
  ).then(J),
  worldviewProcessingRun: (runId) => fetch(
    `/api/worldview/processing-log/${encodeURIComponent(runId)}`,
  ).then(J),
  worldviewEvaluations: ({ limit = 100, cursor = '' } = {}) => fetch(
    `/api/worldview/evaluations${query({ limit, cursor })}`,
  ).then(J),
  worldviewVersions: ({ limit = 100, cursor = '' } = {}) => fetch(
    `/api/worldview/versions${query({ limit, cursor })}`,
  ).then(J),
  worldviewVersion: (versionId) => fetch(
    `/api/worldview/versions/${encodeURIComponent(versionId)}`,
  ).then(J),

  // Claim Library (read-only)
  claims: ({ limit = 100, cursor = '', ticker = '' } = {}) => fetch(
    `/api/claims${query({ limit, cursor, ticker })}`,
  ).then(J),
  claim: (claimId, { version = '' } = {}) => fetch(
    `/api/claims/${encodeURIComponent(claimId)}${query({ version })}`,
  ).then(J),
  claimHistory: (claimId, {
    versionsLimit = 50,
    versionsCursor = '',
    actionsLimit = 50,
    actionsCursor = '',
    rejectionsLimit = 50,
    rejectionsCursor = '',
  } = {}) => fetch(
    `/api/claims/${encodeURIComponent(claimId)}/history${query({
      versionsLimit,
      versionsCursor,
      actionsLimit,
      actionsCursor,
      rejectionsLimit,
      rejectionsCursor,
    })}`,
  ).then(J),
  claimActions: (claimId, { limit = 100, cursor = '' } = {}) => fetch(
    `/api/claims/${encodeURIComponent(claimId)}/actions${query({ limit, cursor })}`,
  ).then(J),
  claimsActions: ({ limit = 100, cursor = '', publicationId = '', action = '' } = {}) => fetch(
    `/api/claims/actions${query({ limit, cursor, publicationId, action })}`,
  ).then(J),
  claimRejections: ({ limit = 100, cursor = '', publicationId = '', code = '' } = {}) => fetch(
    `/api/claims/rejections${query({ limit, cursor, publicationId, code })}`,
  ).then(J),

  // projects
  createProject: (p) => post('/api/projects', p),
  quickProject: (text, intensity, opts = {}) => post('/api/projects/quick', { text, intensity, ...opts }),
  classify: (text) => post('/api/classify', { text }),
  projects: () => fetch('/api/projects').then(J),
  project: (id) => fetch(`/api/projects/${id}`).then(J),
  analysisStatus: (id, runId) => fetch(
    `/api/projects/${encodeURIComponent(id)}/analysis${query({ runId })}`,
  ).then(J),
  workflowSpec: () => fetch('/api/workflows/run-analysis').then(J),
  projectRuns: (id) => fetch(`/api/projects/${encodeURIComponent(id)}/runs`).then(J),
  projectRun: (id, runId) => fetch(`/api/projects/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`).then(J),
  projectAgentTimeline: (projectId, runId, agentRunId, options = {}) => fetch(
    `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentRunId)}/timeline${query({
      afterSequence: options.afterSequence,
      limit: options.limit,
    })}`,
  ).then(J),
  workspaceFiles: (id) => fetch(`/api/projects/${encodeURIComponent(id)}/workspace/files`).then(J),
  workspaceContent: (id, file, offset = 0, limit = 24000) => fetch(`/api/projects/${encodeURIComponent(id)}/workspace/content?file=${encodeURIComponent(file)}&offset=${offset}&limit=${limit}`).then(J),
  deleteProject: (id) => post(`/api/projects/${id}/delete`),
  pauseProject: (id) => post(`/api/projects/${id}/pause`),
  fileContent: (id, name) => fetch(`/api/projects/${id}/files/${name.split('/').map(encodeURIComponent).join('/')}`).then(J),
  analyze: (id, opts) => post(`/api/projects/${id}/analyze`, opts || {}),
  chat: (id, message) => post(`/api/projects/${id}/chat`, { message }),
  setTracking: (id, tracking) => post(`/api/projects/${id}/track`, { tracking }),
  updateProjectSettings: (id, settings) => post(`/api/projects/${id}/settings`, settings),
  adaptors: (id) => fetch(`/api/projects/${id}/adaptors`).then(J),
  reports: (id) => fetch(`/api/projects/${id}/reports`).then(J),
  translateReport: (id, targetLanguage = 'zh') => post(`/api/projects/${id}/report/translate`, { targetLanguage }),

  // templates
  templates: () => fetch('/api/templates').then(J),
  saveTemplate: (tpl) => post('/api/templates', tpl),
  deleteTemplate: (id) => post(`/api/templates/${id}/delete`),

  // portfolio
  portfolio: () => fetch('/api/portfolio').then(J),
  recommend: (force = false) => post('/api/portfolio/recommend', force ? { force: true } : {}),
  recommendProgress: () => fetch('/api/portfolio/recommend/progress').then(J),
  portfolioTraces: (limit = 20) => fetch(`/api/portfolio/traces?limit=${limit}`).then(J),
  ideaRanking: () => fetch('/api/ideas/ranking').then(J),
  rankIdeas: () => post('/api/ideas/rank'),
  watch: () => post('/api/portfolio/watch'),
  promote: (projectId) => post('/api/portfolio/promote', { projectId }),
  setWeight: (ticker, weight) => post('/api/portfolio/weight', { ticker, weight }),
  removePos: (ticker) => post('/api/portfolio/remove', { ticker }),
  track: () => post('/api/portfolio/track'),
  reflect: (ticker) => post('/api/portfolio/reflect', { ticker }),
  reflections: () => fetch('/api/reflections').then(J),
  portfolioLedger: (limit) => fetch(`/api/portfolio/ledger${limit ? `?limit=${limit}` : ''}`).then(J),
  portfolioCalibration: () => fetch('/api/portfolio/calibration').then(J),

  // 论点契约（ThesisContract）：粗筛→精选→末端切片冻结的可证伪单元
  contracts: () => fetch('/api/portfolio/contracts').then(J),
  contract: (ticker) => fetch(`/api/portfolio/contracts/${ticker}`).then(J),
  checkContract: (ticker, at, note) => post('/api/portfolio/contracts/check', { ticker, at, note }),

  // Mandate：粗筛底线 + 末端切片的外部可调配置
  mandate: () => fetch('/api/mandate').then(J),
  setMandate: (patch) => post('/api/mandate', patch),
  resetMandate: () => post('/api/mandate/reset'),

};
