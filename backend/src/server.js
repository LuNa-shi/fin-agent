import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applySettingsPatch,
  CANONICAL_WORLDVIEW_DIR,
  CLAIM_LIBRARY_DIR,
  DATA_DIR,
  keyStatus,
  openAICompatibleSettingsSelection,
  previewSettingsPatch,
  PORT,
  providerStatus,
  runtime,
} from './config.js';
import { normalizeOpenAICompatibleBaseUrl } from './core/models/openAICompatible.js';
import { discoverOpenAICompatibleModels } from './core/models/openAICompatibleProvider.js';
import { agentQueueStats } from './core/agent-backend/ConcurrentAgentBackend.js';
import { modelUsage } from './core/models/modelUsageLedger.js';
import { toolFailureStats } from './core/agent-backend/toolFailureLedger.js';
import { Store, Mandate, Contracts, MANDATE_DEFAULTS } from './core/persistence/globalState.js';
import {
  ProjectSpace as ProjectFS,
  getProjectAgentExecutionTimeline,
  getProjectRunDetail,
  listProjectRuns,
  listWorkspaceFiles,
  normalizeWorkspaceContentPath,
  readWorkspaceContentPaged,
  runAnalysisWorkflowProjection,
  safeCompatibilityEventProjection,
} from './project-space/index.js';
import { IdeaSystem } from './workflows/idea-generation/ideaSystem.js';
import { DecisionSystem } from './domains/decision/decisionSystem.js';
import {
  getDailyReportContent,
  getDailyReportRun,
  listDailyReportRuns,
} from './domains/reports/DailyReportEvidence.js';
import {
  DailyReportBatchStore,
  createReportAdmissionService,
  createReportLibraryStore,
  projectDailyReportBatchCandidateAdmissions,
  projectDailyReportBatchPublicFailures,
} from './domains/reports/index.js';
import { createCanonicalWorldviewStore } from './domains/worldview/index.js';
import { createClaimStore } from './domains/claims/index.js';
import {
  createCanonicalWorldviewCoordinator,
  createWorldviewRunPublicationStore,
} from './workflows/worldview/index.js';
import { TemplateSystem } from './domains/research/templates/templateSystem.js';
import { INTENSITY } from './workflows/run-analysis/runAnalysis.workflow.js';
import { RunAnalysisService } from './workflows/run-analysis/RunAnalysisService.js';
import { chatModify } from './workflows/run-analysis/reportEditing.js';
import { agentRuntimeService } from './agents/AgentRuntimeService.js';
import { runDefinedAgent } from './agents/runDefinedAgent.js';
import { beginDirectAgentCommand } from './core/contracts/AgentExecutionScope.js';
import { createProjectFromIdea } from './domains/ideas/createProjectFromIdea.js';
import {
  agentToolTable,
  checkAllToolHealth,
  checkToolHealth,
  listTools,
  runPublicToolTest,
  toolHealth,
} from './tools/index.js';
import { ResearchSources } from './tools/research.js';
import { decisionTraces } from './domains/decision/portfolioAgent.js';

// 崩溃可观测：分析是长任务，别让单个未捕获异常/拒绝静默杀死进程。
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e?.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e?.stack || e); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    const code = e?.code || 'INTERNAL_ERROR';
    const message = String(e?.message || e);
    if (String(code).startsWith('OPENAI_COMPATIBLE_')) {
      console.error(`[api] ${code}: ${message}`);
    } else {
      console.error(e);
    }
    const requestedStatus = Number(e?.statusCode);
    const statusCode = Number.isInteger(requestedStatus)
      && requestedStatus >= 400
      && requestedStatus <= 599
      ? requestedStatus
      : 500;
    const publicError = statusCode < 500
      ? { error: message, code }
      : { error: 'Internal server error', code: 'INTERNAL_ERROR' };
    res.status(statusCode).json(publicError);
  }
};


function publicConfigurationError(error, code) {
  if (!(error instanceof TypeError)) return error;
  error.code = code;
  error.statusCode = 400;
  return error;
}
const canonicalWorldviewStore = createCanonicalWorldviewStore({ rootDir: CANONICAL_WORLDVIEW_DIR });
const worldviewPublicationStore = createWorldviewRunPublicationStore({
  rootDir: path.join(CANONICAL_WORLDVIEW_DIR, 'run-publications'),
});
canonicalWorldviewStore.bindPublicationReader(
  (publicationId) => worldviewPublicationStore.isCompleted(publicationId),
);
const reportLibrary = createReportLibraryStore({
  processedReceiptReader: () => worldviewPublicationStore.processedReceipts(),
});
const reportAdmissionService = createReportAdmissionService({ reportLibrary });
const dailyReportBatchStore = new DailyReportBatchStore({
  rootDir: reportLibrary.rootDir,
  eventStore: reportLibrary.eventStore,
});
const claimStore = createClaimStore({
  rootDir: CLAIM_LIBRARY_DIR,
  publicationReader: (publicationId) => {
    const publication = worldviewPublicationStore.get(publicationId);
    return publication ? {
      publicationId,
      claimPublicationDigest: publication.claims.publicationDigest,
    } : false;
  },
});
createCanonicalWorldviewCoordinator({
  dataDir: DATA_DIR,
  reportLibrary,
  worldviewStore: canonicalWorldviewStore,
  claimStore,
  publicationStore: worldviewPublicationStore,
});
const runAnalysisService = new RunAnalysisService({
  reportLibrary,
  reportLibraryIngest: reportAdmissionService.admit.bind(reportAdmissionService),
});
function publicRunAnalysisOptions(body = {}) {
  const options = {};
  for (const field of ['intensity', 'industryTemplate', 'companyTemplate']) {
    if (body[field] !== undefined) options[field] = body[field];
  }
  if (typeof body.resume === 'boolean') options.resume = body.resume;
  return options;
}

function publicDailyReportBatch(batch, { detail = false } = {}) {
  if (!batch) return null;
  const safeBatch = projectDailyReportBatchPublicFailures(batch);
  if (detail) return safeBatch;
  const { items: _items, ...summary } = safeBatch;
  return summary;
}

function publicWorldviewRun(run, { detail = false } = {}) {
  const projected = structuredClone(run);
  delete projected.stateDigest;
  delete projected.attemptRecovery;
  if (Array.isArray(projected.attempts)) {
    projected.attempts = projected.attempts.map((attempt) => {
      const safeAttempt = {
        ...attempt,
        ...(attempt.failure ? { failure: { code: attempt.failure.code } } : {}),
      };
      delete safeAttempt.capabilityScopeId;
      return safeAttempt;
    });
  }
  if (!detail) {
    projected.acceptedClaimActionCount = Array.isArray(projected.acceptedClaimActions)
      ? projected.acceptedClaimActions.length
      : 0;
    projected.rejectedClaimActionCount = Array.isArray(projected.rejectedClaimActions)
      ? projected.rejectedClaimActions.length
      : 0;
    delete projected.overviewManifest;
    delete projected.approvedCapabilities;
    delete projected.claimTable;
    delete projected.processedReceipts;
    delete projected.acceptedClaimActions;
    delete projected.rejectedClaimActions;
  }
  return projected;
}

function paginatePublic(items, { limit = 100, cursor = 0 } = {}) {
  const offset = /^\d+$/u.test(String(cursor || '0')) ? Number(cursor || 0) : 0;
  const pageSize = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 100;
  const page = items.slice(offset, offset + pageSize);
  return { items: page, nextCursor: offset + page.length < items.length ? String(offset + page.length) : null };
}

const OPENAI_COMPATIBLE_SETTINGS_FIELDS = new Set([
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
  'DEFAULT_PROVIDER',
  'SMALL_PROVIDER',
  'SMALL_MODEL',
  'MAIN_PROVIDER',
  'MAIN_MODEL',
  'REFLECTION_PROVIDER',
  'REFLECTION_MODEL',
]);

function sameOriginOnly(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.get('host')) {
      return res.status(403).json({ error: 'cross-origin settings access is not allowed', code: 'CROSS_ORIGIN_FORBIDDEN' });
    }
  } catch {
    return res.status(403).json({ error: 'cross-origin settings access is not allowed', code: 'CROSS_ORIGIN_FORBIDDEN' });
  }
  return next();
}

async function validateOpenAICompatibleSettings(body) {
  if (!Object.keys(body).some((key) => OPENAI_COMPATIBLE_SETTINGS_FIELDS.has(key))) return;
  const proposed = previewSettingsPatch(body);
  const selection = openAICompatibleSettingsSelection(proposed);
  if (!selection.required) return;
  const models = await discoverOpenAICompatibleModels({
    baseUrl: selection.baseUrl,
    apiKey: selection.apiKey,
  });
  const discovered = new Set(models.map((model) => model.id));
  if (selection.modelIds.some((modelId) => !discovered.has(modelId))) {
    const error = new Error('One or more selected OpenAI-compatible models were not found in the proxy catalog');
    error.code = 'OPENAI_COMPATIBLE_MODEL_NOT_FOUND';
    error.statusCode = 400;
    throw error;
  }
}

// ---- 系统状态 / 设置 ----
app.get('/api/status', wrap(async () => ({
  providers: providerStatus(),
  counts: {
    ideas: IdeaSystem.list().length,
    projects: ProjectFS.list().length,
    positions: Store.getPortfolio().length,
    claims: claimStore.status().claimCount,
  },
})));

app.post('/api/settings', sameOriginOnly, wrap(async (req) => {
  const body = req.body || {};
  let providers;
  try {
    await validateOpenAICompatibleSettings(body);
    providers = applySettingsPatch(body);
  } catch (error) {
    throw publicConfigurationError(error, 'INVALID_SETTINGS');
  }
  return { ok: true, providers, keys: keyStatus() };
}));

app.post('/api/providers/openai-compatible/models', sameOriginOnly, wrap(async (req) => {
  const body = req.body || {};
  let baseUrl;
  try {
    baseUrl = body.baseUrl === undefined
      ? runtime.OPENAI_COMPATIBLE_BASE_URL
      : normalizeOpenAICompatibleBaseUrl(body.baseUrl);
  } catch (error) {
    throw publicConfigurationError(error, 'OPENAI_COMPATIBLE_BASE_URL_INVALID');
  }
  const submittedApiKey = String(body.apiKey || '').trim();
  if (
    baseUrl
    && baseUrl !== runtime.OPENAI_COMPATIBLE_BASE_URL
    && runtime.OPENAI_COMPATIBLE_API_KEY
    && !submittedApiKey
  ) {
    const error = new Error('a new API key is required when Base URL changes');
    error.code = 'OPENAI_COMPATIBLE_API_KEY_REQUIRED_FOR_BASE_URL_CHANGE';
    error.statusCode = 400;
    throw error;
  }
  const apiKey = submittedApiKey || runtime.OPENAI_COMPATIBLE_API_KEY;
  const models = await discoverOpenAICompatibleModels({
    baseUrl,
    apiKey,
    selectedModelId: body.modelId,
  });
  return { provider: 'openai-compatible', models };
}));

// 统一 Agent/Pi 调用账本：wall-clock、完整 token、tool/turn 与已知/未知成本语义。
app.get('/api/llm/usage', wrap(async (req) => ({
  ...modelUsage({ sinceMs: Number(req.query?.sinceMs) || 0 }),
  queue: agentQueueStats(),
  toolFailures: toolFailureStats({ sinceMs: Number(req.query?.sinceMs) || 0 }),
})));

// 集中式 API Key 管理（只读状态，不回传明文）
app.get('/api/keys', wrap(async () => ({ keys: keyStatus() })));

// 工具库：列出全部 agent 可用工具 + 连接态
app.get('/api/tools', wrap(async () => ({ tools: listTools(), agentTools: agentToolTable() })));
// 单工具测试调用（设置中心工具库页的「试运行」）
app.post('/api/tools/test', wrap(async (req) => (
  runPublicToolTest(req.body?.name, req.body?.args || {})
)));
app.get('/api/tools/health', wrap(async () => toolHealth()));
app.post('/api/tools/health/check', wrap(async (req) => {
  const name = req.body?.name;
  if (name) return checkToolHealth(name);
  return checkAllToolHealth({ limit: Number(req.body?.limit) || 12 });
}));

// Runtime Agent catalog overlays and versioned skill registry. Checked-in definitions remain immutable.
app.get('/api/agents', wrap(async (req) => ({
  agents: agentRuntimeService.listAgents({ catalogVisibility: req.query?.visibility || null }),
})));
app.get('/api/agents/:id', wrap(async (req) => ({ agent: agentRuntimeService.getAgent(req.params.id) })));
app.patch('/api/agents/:id', wrap(async (req) => ({ agent: agentRuntimeService.updateAgent(req.params.id, req.body || {}) })));
app.post('/api/agents/:id/skills', wrap(async (req) => ({
  agent: agentRuntimeService.assignSkills(req.params.id, req.body?.skillIds || []),
})));
app.get('/api/skills', wrap(async (req) => ({
  skills: agentRuntimeService.listSkills({ visibility: req.query?.visibility || null }),
})));
app.get('/api/skills/:id', wrap(async (req) => ({ skill: agentRuntimeService.getSkill(req.params.id) })));
app.post('/api/skills', wrap(async (req) => ({ skill: agentRuntimeService.createSkill(req.body || {}) })));
app.patch('/api/skills/:id', wrap(async (req) => ({ skill: agentRuntimeService.updateSkill(req.params.id, req.body || {}) })));
app.delete('/api/skills/:id', wrap(async (req) => ({ deleted: agentRuntimeService.deleteSkill(req.params.id) })));
app.post('/api/skills/:id/delete', wrap(async (req) => ({ deleted: agentRuntimeService.deleteSkill(req.params.id) })));

// Canonical, serializable Run Analysis graph. No imperative handler functions are exposed.
app.get('/api/workflows/run-analysis', wrap(async () => runAnalysisWorkflowProjection()));
app.get('/api/workflows/idea-generation', wrap(async () => IdeaSystem.workflow()));

// Daily scheduled report evidence. The scheduler runs out-of-process with an isolated FIN_DATA_DIR;
// the resident server only reads completed evidence artifacts.
app.get('/api/daily-reports/runs', wrap(async (req) => ({
  runs: listDailyReportRuns({ limit: Number(req.query?.limit) || 30 }),
})));
app.get('/api/daily-reports/runs/:runId', wrap(async (req) => ({
  run: getDailyReportRun(req.params.runId),
})));
app.get('/api/daily-reports/runs/:runId/reports/:projectId', wrap(async (req) => (
  getDailyReportContent(req.params.runId, req.params.projectId)
)));

// Report Library is a separate, read-only authority. Mutation remains internal
// to the verified producer/backfill seams; no filesystem path is accepted here.
app.get('/api/report-library/status', wrap(async () => {
  const current = reportLibrary.status();
  const backfills = reportLibrary.listBackfills({ limit: 500 }).backfills;
  const batches = dailyReportBatchStore.list({ limit: 1000 }).batches;
  return {
    status: {
      schemaVersion: current.schemaVersion,
      reportCount: current.reportVersionCount,
      tickerCount: current.tickerCount,
      ingestionCount: current.ingestionCount,
      backfillCount: backfills.length,
      failedBackfillItems: backfills.reduce((total, backfill) => total + Number(backfill.summary?.failed || 0), 0),
      batchCount: batches.length,
      openBatchCount: batches.filter((batch) => batch.status === 'open').length,
      closedBatchCount: batches.filter((batch) => batch.status === 'closed').length,
      pendingReportCount: current.pendingReportCount,
      processedReportCount: current.processedReportCount,
    },
  };
}));
app.get('/api/report-library/batches', wrap(async (req) => {
  const result = dailyReportBatchStore.list({
    limit: req.query?.limit,
    status: req.query?.status || null,
  });
  return {
    schemaVersion: result.schemaVersion,
    batches: result.batches.map((batch) => publicDailyReportBatch(batch)),
  };
}));
app.get('/api/report-library/batches/:batchId', wrap(async (req) => {
  const storedBatch = dailyReportBatchStore.get(req.params.batchId);
  const batch = storedBatch
    ? projectDailyReportBatchCandidateAdmissions(storedBatch, reportAdmissionService.candidateStore)
    : null;
  if (!batch) {
    const error = new Error('Daily Report Batch not found');
    error.code = 'DAILY_REPORT_BATCH_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { batch: publicDailyReportBatch(batch, { detail: true }) };
}));
app.get('/api/report-library/reports', wrap(async (req) => reportLibrary.list({
  limit: req.query?.limit,
  cursor: req.query?.cursor,
  ticker: req.query?.ticker || null,
  theme: req.query?.theme || null,
  from: req.query?.from || null,
  to: req.query?.to || null,
})));
app.get('/api/report-library/reports/:reportVersionId', wrap(async (req) => {
  const report = reportLibrary.get(req.params.reportVersionId);
  if (!report) {
    const error = new Error('ReportVersion not found');
    error.code = 'REPORT_VERSION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { report };
}));
app.get('/api/report-library/reports/:reportVersionId/content', wrap(async (req) => {
  const detail = reportLibrary.get(req.params.reportVersionId);
  if (!detail) {
    const error = new Error('ReportVersion not found');
    error.code = 'REPORT_VERSION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  const content = reportLibrary.readContent(req.params.reportVersionId);
  return {
    reportVersionId: detail.reportVersionId,
    contentDigest: detail.contentDigest,
    mediaType: detail.mediaType,
    charset: detail.charset,
    byteLength: Buffer.byteLength(content || '', 'utf8'),
    content,
  };
}));
app.get('/api/report-library/tickers', wrap(async () => {
  const tickers = reportLibrary.tickers();
  return {
    tickers: tickers.map((ticker) => {
      const timeline = reportLibrary.tickerTimeline(ticker, { limit: 500 });
      return { ticker, reportCount: timeline.reports.length, latestAsOf: timeline.reports.at(-1)?.asOf || null };
    }),
  };
}));
app.get('/api/report-library/tickers/:ticker/timeline', wrap(async (req) => reportLibrary.tickerTimeline(req.params.ticker, {
  limit: req.query?.limit,
  cursor: req.query?.cursor,
})));
app.get('/api/report-library/ingestions', wrap(async (req) => reportLibrary.listIngestions({
  limit: req.query?.limit,
  cursor: req.query?.cursor,
  status: req.query?.status || null,
})));
app.get('/api/report-library/ingestions/:ingestionId', wrap(async (req) => {
  const ingestion = reportLibrary.getIngestion(req.params.ingestionId);
  if (!ingestion) {
    const error = new Error('Report ingestion not found');
    error.code = 'REPORT_INGESTION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { ingestion };
}));
app.get('/api/report-library/backfills/:backfillRunId', wrap(async (req) => {
  const backfill = reportLibrary.getBackfillStatus(req.params.backfillRunId);
  if (!backfill) {
    const error = new Error('Report backfill not found');
    error.code = 'REPORT_BACKFILL_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { backfill };
}));

// Canonical Worldview is the continuing, read-only product. Processing Log and
// Version history remain separate; KEEP evaluations never become Versions.
app.get('/api/worldview/current', wrap(async () => ({ current: canonicalWorldviewStore.current() })));
app.get('/api/worldview/processing-log', wrap(async (req) => {
  const result = canonicalWorldviewStore.listProcessingRuns();
  const filtered = result.runs
    .filter((run) => !req.query?.state || run.state === req.query.state)
    .filter((run) => !req.query?.outcome || run.outcome === req.query.outcome);
  const page = paginatePublic(filtered, { limit: req.query?.limit, cursor: req.query?.cursor });
  return {
    schemaVersion: result.schemaVersion,
    runs: page.items.map((run) => publicWorldviewRun(run)),
    nextCursor: page.nextCursor,
  };
}));
app.get('/api/worldview/processing-log/:runId', wrap(async (req) => {
  const run = canonicalWorldviewStore.getProcessingRun(req.params.runId);
  if (!run) {
    const error = new Error('Worldview Agent Run not found');
    error.code = 'WORLDVIEW_RUN_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { run: publicWorldviewRun(run, { detail: true }) };
}));
app.get('/api/worldview/evaluations', wrap(async (req) => {
  const result = canonicalWorldviewStore.listEvaluations();
  const page = paginatePublic(result.evaluations, { limit: req.query?.limit, cursor: req.query?.cursor });
  return { schemaVersion: result.schemaVersion, evaluations: page.items, nextCursor: page.nextCursor };
}));
app.get('/api/worldview/versions', wrap(async (req) => {
  const result = canonicalWorldviewStore.listVersions();
  const page = paginatePublic(result.versions, { limit: req.query?.limit, cursor: req.query?.cursor });
  return {
    schemaVersion: result.schemaVersion,
    current: canonicalWorldviewStore.current(),
    versions: page.items,
    nextCursor: page.nextCursor,
  };
}));
app.get('/api/worldview/versions/:versionId', wrap(async (req) => {
  const version = canonicalWorldviewStore.getVersion(req.params.versionId);
  if (!version) {
    const error = new Error('Canonical Worldview Version not found');
    error.code = 'CANONICAL_WORLDVIEW_VERSION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { version };
}));

// Claim Library is a separate read-only product projection. Claims share only
// run/publication lineage with Worldview outcomes and expose no mutation API.
app.get('/api/claims', wrap(async (req) => claimStore.list({
  ticker: req.query?.ticker || null,
  limit: req.query?.limit,
  cursor: req.query?.cursor,
})));
app.get('/api/claims/actions', wrap(async (req) => claimStore.actions({
  publicationId: req.query?.publicationId || null,
  action: req.query?.action || null,
  limit: req.query?.limit,
  cursor: req.query?.cursor,
})));
app.get('/api/claims/rejections', wrap(async (req) => claimStore.rejections({
  publicationId: req.query?.publicationId || null,
  code: req.query?.code || null,
  limit: req.query?.limit,
  cursor: req.query?.cursor,
})));
app.get('/api/claims/:claimId/history', wrap(async (req) => {
  const history = claimStore.history(req.params.claimId, {
    versionsLimit: req.query?.versionsLimit,
    versionsCursor: req.query?.versionsCursor,
    actionsLimit: req.query?.actionsLimit,
    actionsCursor: req.query?.actionsCursor,
    rejectionsLimit: req.query?.rejectionsLimit,
    rejectionsCursor: req.query?.rejectionsCursor,
  });
  if (history.totalCounts.versions === 0) {
    const error = new Error('Claim not found');
    error.code = 'CLAIM_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { history };
}));
app.get('/api/claims/:claimId/actions', wrap(async (req) => claimStore.actions({
  claimId: req.params.claimId,
  limit: req.query?.limit,
  cursor: req.query?.cursor,
})));
app.get('/api/claims/:claimId', wrap(async (req) => {
  const claim = claimStore.get(req.params.claimId, { version: req.query?.version ?? null });
  if (!claim) {
    const error = new Error('Claim not found');
    error.code = 'CLAIM_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return { claim };
}));

// 研究来源注册表（curate 分析师/博主观点流来源）
app.get('/api/research/sources', wrap(async () => ({ sources: ResearchSources.list() })));
app.post('/api/research/sources', wrap(async (req) => ({ sources: ResearchSources.upsert(req.body || {}) })));
app.post('/api/research/sources/:id/delete', wrap(async (req) => ({ sources: ResearchSources.remove(req.params.id) })));

// ---- 系统①：Idea Generation ----
app.get('/api/ideas', wrap(async () => ({ ideas: IdeaSystem.list() })));
app.get('/api/ideas/progress', wrap(async (req) => ({
  progress: IdeaSystem.progress({
    workflowId: req.query?.workflowId,
    runId: req.query?.runId,
    nodeId: req.query?.nodeId,
  }),
})));
app.get('/api/ideas/traces', wrap(async (req) => ({
  traces: IdeaSystem.traces(Number(req.query?.limit) || 40, {
    workflowId: req.query?.workflowId,
    runId: req.query?.runId,
    nodeId: req.query?.nodeId,
  }),
})));
app.get('/api/ideas/traces/:id', wrap(async (req) => ({
  trace: IdeaSystem.trace(req.params.id, {
    workflowId: req.query?.workflowId,
    runId: req.query?.runId,
    nodeId: req.query?.nodeId,
  }),
})));
app.get('/api/ideas/runs/:runId/agents/:agentRunId/timeline', wrap(async (req) => (
  IdeaSystem.agentTimeline(req.params.runId, req.params.agentRunId, {
    afterSequence: req.query?.afterSequence,
    limit: req.query?.limit,
  })
)));
app.post('/api/ideas/generate', wrap(async (req) => IdeaSystem.generate(req.body?.count || 20)));
app.post('/api/ideas/runs/:runId/resume', wrap(async (req) => IdeaSystem.resume(req.params.runId)));
app.post('/api/ideas/earnings/preview', wrap(async (req) => IdeaSystem.earningsPreview({ days: Number(req.body?.days) || 7, limit: Number(req.body?.limit) || 120, market: req.body?.market || 'global', forceRefresh: !!req.body?.forceRefresh })));
app.post('/api/ideas/earnings/add', wrap(async (req) => IdeaSystem.addEarningsIdeas(req.body?.candidates || [])));
app.post('/api/ideas/:id/status', wrap(async (req) => IdeaSystem.updateStatus(req.params.id, req.body?.status)));
app.post('/api/ideas/:id/delete', wrap(async (req) => ({ ideas: IdeaSystem.remove(req.params.id) })));

// 从 idea 创建项目（人工选中添加进项目库）
// ideaId 存在时以 idea 库中的英文规范字段为准（前端可能展示/传入中文版本；后端主链路必须英文），
// 中文展示字段保存在 meta.titleZh 供前端选用。
app.post('/api/projects', wrap(async (req) => {
  const { title, tickers, ideaId } = req.body || {};
  // 防御性日志：曾有用户报告「创建了 4 个项目只落盘 3 个」且无任何痕迹——每次创建请求先记日志
  console.log(`[create-project] title="${String(title || '').slice(0, 60)}" ideaId=${ideaId || '-'} tickers=${(tickers || []).join(',') || '-'}`);
  return createProjectFromIdea(req.body || {});
}));

// 一句话快速建项目：先归类（主题/模板/标的）再落地为项目
app.post('/api/projects/quick', wrap(async (req) => {
  const text = (req.body?.text || '').trim();
  if (!text) throw new Error('text required');
  const c = await IdeaSystem.classify(text);
  const project = createProjectFromIdea({
    ...c,
    intensity: req.body?.intensity || 'standard',
    analysisLanguage: req.body?.analysisLanguage || runtime.ANALYSIS_LANGUAGE,
    reportLanguage: req.body?.reportLanguage || runtime.REPORT_LANGUAGE,
    companyLocale: req.body?.companyLocale || 'global',
    source: 'quick', sourceText: text,
  });
  return { project, classify: c };
}));

// 仅归类预览（不落地）
app.post('/api/classify', wrap(async (req) => IdeaSystem.classify((req.body?.text || '').trim())));

// ---- 分析模板系统 ----
app.get('/api/templates', wrap(async () => ({ templates: TemplateSystem.list(), intensity: INTENSITY })));
app.post('/api/templates', wrap(async (req) => ({ templates: TemplateSystem.upsert(req.body || {}) })));
app.post('/api/templates/:id/delete', wrap(async (req) => ({ templates: TemplateSystem.remove(req.params.id) })));

// ---- 系统②：项目分析库 ----
// 列表带进度：分析中的项目附 {stage,pct,etaMin,currentRound}，列表页即可看到进展（此前只有脉冲小点）。
function projectAnalysisProjection(meta) {
  const analysis = runAnalysisService.status(meta.id);
  const {
    openIssues: _openIssues,
    lastError: _lastError,
    ...safeMeta
  } = meta;
  const projected = {
    ...safeMeta,
    status: analysis.projectStatus,
    reportReady: analysis.reportReady,
    analysisRunId: analysis.runId,
    conclusion: analysis.reportPackage?.conclusion || null,
    scenarios: analysis.reportPackage?.scenarios || null,
    scorecards: analysis.reportPackage?.scorecards || null,
    scorecardRefs: analysis.reportPackage?.scorecardRefs || [],
  };
  return {
    ...projected,
    analysis,
    ...(['queued', 'analyzing'].includes(projected.status)
      ? { progress: projectProgress(projected.id, projected) }
      : {}),
  };
}

app.get('/api/projects', wrap(async () => ({
  projects: ProjectFS.list().map(projectAnalysisProjection),
})));
app.post('/api/projects/:id/delete', wrap(async (req) => {
  runAnalysisService.cancel(req.params.id, { reason: 'deleted' });
  const ok = ProjectFS.delete(req.params.id);
  return { ok, projects: ProjectFS.list().map(projectAnalysisProjection) };
}));
// 大框架进度：从 checkpoint 推导「阶段/百分比/预计剩余」——给用户控制感（现在到哪了、还有多久），
// 细粒度过程留在 Agent 流程页折叠查看。
function projectProgress(id, meta) {
  if (meta.status === 'analyzed') return { stage: '已完成', pct: 100, etaMin: 0 };
  if (meta.status === 'queued') return { stage: '分析队列中', pct: 1, etaMin: null };
  if (meta.status !== 'analyzing') return null;
  const cp = ProjectFS.checkpoint(id);
  const TARGET_MIN = { quick: 15, standard: 30, deep: 60 };
  const target = TARGET_MIN[meta.intensity] || 30;
  if (!cp) return { stage: '准备中', pct: 2, etaMin: target };
  const rounds = cp.targetRounds || 1;
  // 权重：plan+scan 8% → 各轮均分 62% → 报告/复核 20% → 结论 10%。
  // v2 的活动阶段来自 canonical checkpoint fields only; legacy crux/simulation/
  // reflection fields remain readable elsewhere for historical compatibility but do
  // not drive the active server progress projection.
  let pct = 4, stage = '规划与扫描';
  if (cp.plan) pct = 8;
  if (cp.round > 0 || cp.rounds?.length) {
    const done = cp.round || 0;
    const roundPct = 62 / rounds;
    pct = 8 + Math.min(done, rounds) * roundPct;
    stage = done >= rounds ? '撰写报告与复核' : `第 ${done + 1}/${rounds} 轮 Data closure→行业/公司`;
  }
  if (cp.reportDone) { pct = Math.max(pct, 78); stage = '报告复核与结论'; }
  if (cp.conclusion) { pct = Math.max(pct, 95); stage = '收尾（结论与忠实度检查）'; }
  const elapsedMin = cp.timings ? Object.values(cp.timings).reduce((a, b) => a + b, 0) / 60000 : 0;
  const etaMin = Math.max(1, Math.round(target * (1 - pct / 100)));
  return { stage, pct: Math.round(pct), etaMin, elapsedMin: Math.round(elapsedMin), rounds, currentRound: Math.min((cp.round || 0) + 1, rounds) };
}

app.get('/api/projects/:id', wrap(async (req) => {
  const storedMeta = ProjectFS.meta(req.params.id);
  if (!storedMeta) throw new Error('not found');
  const projected = projectAnalysisProjection(storedMeta);
  const { analysis, progress, ...meta } = projected;
  return {
    meta,
    analysis,
    reportReady: analysis.reportReady,
    progress: progress || projectProgress(req.params.id, meta),
    report: analysis.reportReady
      ? ProjectFS.fileContent(req.params.id, analysis.reportPackage.reportPath)
      : null,
    reports: ProjectFS.reportVersions(req.params.id),
    forecast: ProjectFS.forecast(req.params.id),
    adaptors: ProjectFS.adaptorState(req.params.id),
    events: ProjectFS.events(req.params.id)
      .map(safeCompatibilityEventProjection)
      .filter(Boolean),
    chat: ProjectFS.chat(req.params.id),
    data: ProjectFS.data(req.params.id),
    files: ProjectFS.files(req.params.id),
  };
}));
app.get('/api/projects/:id/analysis', wrap(async (req) => (
  runAnalysisService.status(req.params.id, { runId: req.query?.runId || null })
)));
app.get('/api/projects/:id/adaptors', wrap(async (req) => ({ adaptors: ProjectFS.adaptorState(req.params.id) })));
app.get('/api/projects/:id/forecast', wrap(async (req) => ({ forecast: ProjectFS.forecast(req.params.id) })));
app.get('/api/projects/:id/reports', wrap(async (req) => ({ reports: ProjectFS.reportVersions(req.params.id), latestReport: ProjectFS.latestReportPath(req.params.id) })));
app.post('/api/projects/:id/report/translate', wrap(async (req) => {
  const targetLanguage = req.body?.targetLanguage || 'zh';
  const source = ProjectFS.report(req.params.id);
  if (!source) throw new Error('report not found');
  const scope = beginDirectAgentCommand({
    workflowId: 'report-translation.v1',
    nodeId: 'translate-report',
    projectId: req.params.id,
    asOf: new Date().toISOString(),
    workspaceMode: 'project',
  });
  const r = await runDefinedAgent('report-translator', { targetLanguage, source }, {
    scope,
    callId: 'translate-report',
    kind: 'report-translate',
    temperature: 0.2,
    maxTokens: 12000,
  });
  const rec = ProjectFS.setTimestampedReport(req.params.id, r.text || source, {
    language: targetLanguage,
    translatedFrom: ProjectFS.latestReportPath(req.params.id),
  });
  return { report: rec, live: r.live, provider: r.provider, reports: ProjectFS.reportVersions(req.params.id) };
}));
app.get('/api/projects/:id/events', wrap(async (req) => ({
  events: ProjectFS.events(req.params.id)
    .map(safeCompatibilityEventProjection)
    .filter(Boolean),
})));
app.get('/api/projects/:id/runs', wrap(async (req) => listProjectRuns(req.params.id)));
app.get('/api/projects/:id/runs/:runId', wrap(async (req) => getProjectRunDetail(req.params.id, req.params.runId)));
app.get('/api/projects/:id/runs/:runId/agents/:agentRunId/timeline', wrap(async (req) => (
  getProjectAgentExecutionTimeline(
    req.params.id,
    req.params.runId,
    req.params.agentRunId,
    {
      afterSequence: req.query?.afterSequence,
      limit: req.query?.limit,
    },
  )
)));
app.get('/api/projects/:id/workspace/files', wrap(async (req) => listWorkspaceFiles({ projectId: req.params.id })));
app.get('/api/projects/:id/workspace/content', wrap(async (req) => readWorkspaceContentPaged({
  projectId: req.params.id,
  file: req.query?.file,
  offset: req.query?.offset,
  limit: req.query?.limit,
})));
app.get('/api/projects/:id/files/*', wrap(async (req) => {
  const name = normalizeWorkspaceContentPath(req.params[0]);
  return { name, content: ProjectFS.fileContent(req.params.id, name) };
}));
app.post('/api/projects/:id/analyze', wrap(async (req) => {
  return runAnalysisService.start(
    req.params.id,
    publicRunAnalysisOptions(req.body || {}),
  );
}));
app.post('/api/projects/:id/pause', wrap(async (req) => {
  return runAnalysisService.pause(req.params.id);
}));
app.post('/api/projects/:id/chat', wrap(async (req) => chatModify(req.params.id, req.body?.message || '')));
app.post('/api/projects/:id/track', wrap(async (req) => ProjectFS.updateMeta(req.params.id, { tracking: !!req.body?.tracking })));
app.post('/api/projects/:id/settings', wrap(async (req) => {
  const allowed = ['analysisLanguage', 'reportLanguage', 'companyLocale', 'industryTemplate', 'companyTemplate'];
  const patch = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  return ProjectFS.updateMeta(req.params.id, patch);
}));

// ---- 系统③：决策、跟踪、反思 ----
app.get('/api/portfolio', wrap(async () => ({ portfolio: DecisionSystem.portfolio(), recommendation: DecisionSystem.recommendation() })));
// 更新推荐持仓（统一入口）：项目库海选候选 → 标准闸 → 天梯比对 → 权重 + 契约冻结。
// 长任务，带实时进度（前端轮询 progress 展示 PM 思考过程）；轨迹持久化 decision-traces.jsonl。
let recommendRun = null; // { running, startedAt, steps:[], result, error }
app.get('/api/portfolio/recommend/progress', wrap(async () => ({ progress: recommendRun })));
app.post('/api/portfolio/recommend', wrap(async (req, res) => {
  // 与在跑分析互斥：分析未完成时构建，其标的会缺席候选池（曾发生构建抢跑、最新项目 0 候选）。
  // 默认 409 提示等待；body.force=true 可强行继续（明确接受不含在跑项目）。
  const inFlight = runAnalysisService.inFlightProjectIds();
  if (inFlight.length && !req.body?.force) {
    res.status(409);
    return { blocked: true, analyzing: inFlight, message: `有 ${inFlight.length} 个项目仍在分析中，现在构建将不包含它们的结论` };
  }
  if (recommendRun?.running) { res.status(409); return { blocked: true, running: true, message: '已有一次组合构建在进行中' }; }
  recommendRun = { running: true, startedAt: Date.now(), steps: [], result: null };
  try {
    const r = await DecisionSystem.recommend({ onProgress: (stage, data) => recommendRun.steps.push({ stage, ts: Date.now(), ...data }) });
    recommendRun.result = { holdings: r.positions.length, traceId: r.traceId };
    recommendRun.running = false; recommendRun.endedAt = Date.now();
    return { portfolio: r.positions, recommendation: r.recommendation, traceId: r.traceId };
  } catch (e) { recommendRun.running = false; recommendRun.error = String(e.message || e); throw e; }
}));
// 决策轨迹（组合构建全过程回放：候选来源→闸门→天梯逐轮理由→权重→契约）
app.get('/api/portfolio/traces', wrap(async (req) => ({ traces: decisionTraces(Number(req.query?.limit) || 20) })));
app.post('/api/portfolio/promote', wrap(async (req) => ({ portfolio: DecisionSystem.promoteFromProject(req.body?.projectId) })));
app.post('/api/portfolio/weight', wrap(async (req) => ({ portfolio: DecisionSystem.setWeight(req.body?.ticker, req.body?.weight) })));
app.post('/api/portfolio/remove', wrap(async (req) => ({ portfolio: DecisionSystem.remove(req.body?.ticker) })));
app.post('/api/portfolio/track', wrap(async () => {
  const r = await DecisionSystem.track();
  return { portfolio: r.positions, tracking: r.summary, snapshots: r.snapshots };
}));
app.get('/api/portfolio/snapshots', wrap(async () => ({ snapshots: DecisionSystem.snapshots() })));
// idea 排序（多维度）
app.get('/api/ideas/ranking', wrap(async () => ({ ranking: DecisionSystem.ideaRanking() })));
app.post('/api/ideas/rank', wrap(async () => ({ ranking: await DecisionSystem.rankIdeas() })));
// 加入观察系统（以当前组合建基准，之后持续跟踪）
app.post('/api/portfolio/watch', wrap(async () => {
  const r = await DecisionSystem.watch();
  return { portfolio: r.positions, tracking: r.summary, snapshots: r.snapshots, watched: true };
}));

// （已移除）SA idea 海选直通组合的第二入口：决策组合的候选统一从项目库海选
// （/api/portfolio/recommend）；SA 广域池仍作为 idea 生成的种子（ideaSystem 内部使用）。
app.post('/api/ideas/screen', wrap(async () => { throw new Error('SA 海选入口已合并到「构建组合」（/api/portfolio/recommend）：候选统一来自项目库'); }));
app.get('/api/ideas/screen/progress', wrap(async () => ({ progress: recommendRun })));
app.post('/api/portfolio/reflect', wrap(async (req) => DecisionSystem.reflectPosition(req.body?.ticker)));
app.get('/api/reflections', wrap(async () => ({ reflections: DecisionSystem.reflections() })));
// 交易流水（虚拟盘账本的不可变调仓记录）与 校准曲线（recommendationScore ↔ 实际超额）
app.get('/api/portfolio/ledger', wrap(async (req) => ({ ledger: DecisionSystem.ledger(Number(req.query?.limit) || 200) })));
app.get('/api/portfolio/calibration', wrap(async () => ({ calibration: DecisionSystem.calibration() })));
// 论点契约（每只入选标的的冻结论点 + 检查点）与到期复核清单
app.get('/api/portfolio/contracts', wrap(async () => ({ open: Contracts.open(), due: Contracts.due(), archive: Contracts.archive(50) })));
app.get('/api/portfolio/contracts/:ticker', wrap(async (req) => ({ contract: Contracts.get(req.params.ticker) })));
app.post('/api/portfolio/contracts/check', wrap(async (req) => ({ contract: Contracts.markChecked(req.body?.ticker, Number(req.body?.at), req.body?.note || '') })));
// Mandate（组合授权：PM 的外部可调配置——只在粗筛底线与末端切片处生效）
app.get('/api/mandate', wrap(async () => ({ mandate: Mandate.get(), defaults: MANDATE_DEFAULTS })));
app.post('/api/mandate', wrap(async (req) => ({ mandate: Mandate.set(req.body || {}) })));
app.post('/api/mandate/reset', wrap(async () => ({ mandate: Mandate.reset() })));

// Unknown API routes must remain API failures even when the SPA build exists.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found', code: 'API_ROUTE_NOT_FOUND' });
});

// ---- 静态前端 ----
const FRONT = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(FRONT)) {
  app.use(express.static(FRONT));
  app.get('*', (req, res) => res.sendFile(path.join(FRONT, 'index.html')));
}

// 启动恢复只负责产品级开关和历史 frameworkVersion 回填；
// durable fresh/resume 解析、去重与队列归 RunAnalysisService。
function recoverInterruptedAnalyses() {
  if (String(process.env.AUTO_RESUME || 'true').toLowerCase() === 'false') {
    console.log('  断点恢复：AUTO_RESUME=false，已跳过自动续跑。');
    return;
  }
  let projects = [];
  try { projects = ProjectFS.list(); } catch { return; }
  // 回填：既有项目未标框架版本的，标为 0.1（无版本号的项目均产自 0.2 之前的框架，不可标为当前版本）
  for (const p of projects) {
    if (!p.frameworkVersion) { try { ProjectFS.updateMeta(p.id, { frameworkVersion: '0.1' }); } catch {} }
  }
  const outcomes = runAnalysisService.recoverInterrupted();
  const recoveredCount = outcomes.filter((outcome) => outcome.recovered).length;
  const failedCount = outcomes.length - recoveredCount;
  if (!outcomes.length) return;
  console.log(
    `  断点恢复：${recoveredCount}/${outcomes.length} 个 durable run 已由 RunAnalysisService 入队`
    + `（并发上限 ${runAnalysisService.maxConcurrent}）`
    + (failedCount ? `，${failedCount} 个准确保留失败状态。` : '。'),
  );
}

async function recoverInterruptedIdeaGeneration() {
  if (String(process.env.AUTO_RESUME || 'true').toLowerCase() === 'false') return;
  try {
    const summary = await IdeaSystem.recoverInterrupted();
    if (!summary.candidateCount) return;
    console.log(
      `  Idea 断点恢复：${summary.recoveredCount}/${summary.candidateCount} 个 durable run 已串行恢复`
      + (summary.failedCount ? `，${summary.failedCount} 个准确保留失败状态。` : '。'),
    );
  } catch (error) {
    console.error(
      '  Idea 断点恢复失败：',
      error?.code || error?.message || error,
    );
  }
}

export function startServer({ port = PORT } = {}) {
  return app.listen(port, () => {
    const s = providerStatus();
    const address = port === 0 ? 'an ephemeral test port' : `http://localhost:${port}`;
    console.log(`\n  金融分析 Agent 后端已启动: ${address}`);
    console.log(`  Providers → OpenAI-compatible:${s.openAICompatible} DeepSeek:${s.deepseek} | 工具 → FMP:${s.fmp} Perplexity:${s.perplexity} Tavily:${s.tavily} | LiveLLM:${s.liveLLM}\n`);
    setTimeout(recoverInterruptedAnalyses, 1500);
    setTimeout(() => { void recoverInterruptedIdeaGeneration(); }, 1500);
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) startServer();
