import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDailyReportScorecards } from './scorecardProjection.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_EVIDENCE_ROOT = path.join(REPO_ROOT, 'artifacts/local/daily-100-report-gate');
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,180}$/u;

function dailyReportError(message, code = 'DAILY_REPORT_EVIDENCE_ERROR', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function evidenceRoot(options = {}) {
  return path.resolve(
    options.rootDir
      || process.env.DAILY_REPORT_EVIDENCE_DIR
      || DEFAULT_EVIDENCE_ROOT,
  );
}

function assertSafeId(value, label) {
  const id = String(value || '').trim();
  if (!SAFE_ID_RE.test(id)) {
    throw dailyReportError(`${label} is invalid`, 'INVALID_DAILY_REPORT_ID', 400);
  }
  return id;
}

function assertInside(root, target, code = 'DAILY_REPORT_PATH_OUTSIDE_ROOT') {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw dailyReportError('daily report evidence path escapes its root', code, 400);
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw dailyReportError(`${label} not found`, 'DAILY_REPORT_EVIDENCE_NOT_FOUND', 404);
    }
    throw dailyReportError(`${label} is not valid JSON`, 'INVALID_DAILY_REPORT_EVIDENCE', 500);
  }
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function durationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt || '');
  const end = Date.parse(completedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function compactProvider(provider = {}) {
  return {
    liveLLM: Boolean(provider.liveLLM),
    activeProvider: provider.activeProvider || '',
    activeModel: provider.activeModel || '',
    defaultProvider: provider.defaultProvider || '',
    openAICompatible: Boolean(provider.openAICompatible ?? provider.gptGateway),
    openAICompatibleEndpointConfigured: Boolean(
      provider.openAICompatibleEndpointConfigured ?? provider.gptGatewayEndpointConfigured
    ),
    deepseek: Boolean(provider.deepseek),
    fmp: Boolean(provider.fmp),
    perplexity: Boolean(provider.perplexity),
    tavily: Boolean(provider.tavily),
  };
}

function compactConfiguration(configuration = {}) {
  const fixedIdeasPath = String(configuration.fixedIdeasPath || '');
  return {
    ideaCount: normalizeNumber(configuration.ideaCount),
    batchSize: normalizeNumber(configuration.batchSize),
    intensity: configuration.intensity || '',
    analysisLanguage: configuration.analysisLanguage || '',
    reportLanguage: configuration.reportLanguage || '',
    companyLocale: configuration.companyLocale || '',
    timeoutMs: normalizeNumber(configuration.timeoutMs),
    pollMs: normalizeNumber(configuration.pollMs),
    fixedIdeas: Boolean(fixedIdeasPath),
    fixedIdeasLabel: fixedIdeasPath ? path.basename(fixedIdeasPath) : null,
  };
}

function compactIdeaGeneration(ideaGeneration = {}) {
  return {
    source: ideaGeneration.source || null,
    workflowId: ideaGeneration.workflowId || null,
    runId: ideaGeneration.runId || null,
    snapshotId: ideaGeneration.snapshotId || null,
    status: ideaGeneration.status || null,
    generated: normalizeNumber(ideaGeneration.generated || ideaGeneration.ideas),
    ideas: normalizeNumber(ideaGeneration.ideas || ideaGeneration.generated),
    candidateIdeas: ideaGeneration.candidateIdeas ?? null,
    selectedIdeas: ideaGeneration.selectedIdeas ?? null,
    persistedIdeas: ideaGeneration.persistedIdeas ?? null,
    live: Boolean(ideaGeneration.live),
  };
}

function compactBatch(batch = {}) {
  return {
    maxConcurrent: normalizeNumber(batch.maxConcurrent),
    queuedAtStart: normalizeNumber(batch.queuedAtStart),
    maxQueuePositionAtStart: normalizeNumber(batch.maxQueuePositionAtStart),
    observations: {
      samples: normalizeNumber(batch.observations?.samples),
      maxAnalyzingObserved: normalizeNumber(batch.observations?.maxAnalyzingObserved),
      maxQueuedObserved: normalizeNumber(batch.observations?.maxQueuedObserved),
    },
  };
}

function compactVerification(summary = {}) {
  const verification = summary.verification || {};
  const projects = Array.isArray(summary.projects) ? summary.projects : [];
  const reportCount = projects.filter((project) => (
    project.status === 'analyzed'
    && project.runStatus === 'SUCCEEDED'
    && project.reportReady
    && project.reportPath
    && normalizeNumber(project.reportBytes) > 0
  )).length;
  return {
    ok: Boolean(verification.ok),
    failures: Array.isArray(verification.failures) ? verification.failures.map(String) : [],
    ideas: normalizeNumber(verification.ideas, normalizeNumber(summary.configuration?.ideaCount)),
    projects: normalizeNumber(verification.projects, projects.length),
    reports: normalizeNumber(verification.reports, reportCount),
    uniqueIdeaIds: normalizeNumber(verification.uniqueIdeaIds),
    uniqueProjectIds: normalizeNumber(verification.uniqueProjectIds),
    uniqueRunIds: normalizeNumber(verification.uniqueRunIds),
    uniqueReportIdentities: normalizeNumber(verification.uniqueReportIdentities),
    noHumanReviewTasks: verification.noHumanReviewTasks !== false,
    canonicalWorkflowInvocations: normalizeNumber(verification.canonicalWorkflowInvocations),
  };
}

function runState(summary = {}) {
  if (!summary.completedAt) return 'running';
  if (summary.ok) return 'passed';
  const reports = compactVerification(summary).reports;
  return reports > 0 ? 'partial' : 'failed';
}

function compactErrors(errors = []) {
  return Array.isArray(errors)
    ? errors.map((error) => ({
        code: String(error?.code || 'DAILY_REPORT_ERROR'),
        message: String(error?.message || error || ''),
      })).filter((error) => error.message)
    : [];
}

function timestampFromDirectoryName(name = '') {
  const match = String(name).match(/(\d{8}T\d{6}Z)$/u);
  if (!match) return '';
  const token = match[1];
  return `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
    + `T${token.slice(9, 11)}:${token.slice(11, 13)}:${token.slice(13, 15)}.000Z`;
}

function runSortKey(run = {}) {
  return run.startedAt || timestampFromDirectoryName(run.directoryName) || '';
}

function compactRunSummary(summary, directoryName) {
  return {
    id: directoryName,
    directoryName,
    runName: summary.runName || directoryName,
    schemaVersion: summary.schemaVersion || '',
    state: runState(summary),
    ok: Boolean(summary.ok),
    mode: summary.mode || '',
    live: Boolean(summary.live),
    startedAt: summary.startedAt || null,
    completedAt: summary.completedAt || null,
    durationMs: durationMs(summary.startedAt, summary.completedAt),
    configuration: compactConfiguration(summary.configuration),
    provider: compactProvider(summary.provider),
    ideaGeneration: compactIdeaGeneration(summary.ideaGeneration),
    batch: compactBatch(summary.batch),
    verification: compactVerification(summary),
    errors: compactErrors(summary.errors),
  };
}

function runDirectory(root, runId) {
  const directoryName = assertSafeId(runId, 'run id');
  const directory = path.resolve(root, directoryName);
  assertInside(root, directory);
  return { directoryName, directory };
}

function reportTitle(content = '') {
  const lines = String(content).split(/\r?\n/u);
  const heading = lines.find((line) => /^#\s+\S/u.test(line));
  if (heading) return heading.replace(/^#\s+/u, '').trim().slice(0, 180);
  const first = lines.find((line) => line.trim());
  return first ? first.trim().slice(0, 180) : null;
}

function wordCount(content = '') {
  const text = String(content || '').trim();
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/gu) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/gu) || [];
  return latin.length + cjk.length;
}

function resolveProjectRoot(runDir, projectId) {
  const id = assertSafeId(projectId, 'project id');
  const projectsRoot = path.resolve(runDir, 'data/projects');
  const projectRoot = path.resolve(projectsRoot, id);
  assertInside(projectsRoot, projectRoot);
  return { projectId: id, projectRoot };
}

function resolveReportFile(runDir, project) {
  const reportPath = String(project?.reportPath || '').trim();
  if (!reportPath) {
    throw dailyReportError('report is not available for this project', 'DAILY_REPORT_NOT_AVAILABLE', 404);
  }
  if (path.isAbsolute(reportPath)) {
    throw dailyReportError('report path must be relative', 'INVALID_DAILY_REPORT_PATH', 400);
  }
  const { projectId, projectRoot } = resolveProjectRoot(runDir, project.projectId);
  const file = path.resolve(projectRoot, reportPath);
  assertInside(projectRoot, file, 'INVALID_DAILY_REPORT_PATH');
  return {
    projectId,
    projectRoot,
    file,
    relativePath: path.relative(projectRoot, file).split(path.sep).join('/'),
  };
}

function enrichProject(runDir, project = {}) {
  const projectId = String(project.projectId || '').trim();
  let meta = {};
  let report = {
    path: project.reportPath || null,
    exists: false,
    bytes: normalizeNumber(project.reportBytes),
    title: null,
    wordCount: null,
    error: null,
    digest: null,
  };
  try {
    const { projectRoot } = resolveProjectRoot(runDir, projectId);
    meta = readJsonIfExists(path.join(projectRoot, 'meta.json')) || {};
  } catch (error) {
    report = { ...report, error: error.code || 'DAILY_REPORT_PROJECT_META_ERROR' };
  }
  if (project.reportPath) {
    try {
      const resolved = resolveReportFile(runDir, project);
      const content = fs.readFileSync(resolved.file, 'utf8');
      report = {
        path: resolved.relativePath,
        exists: true,
        bytes: Buffer.byteLength(content, 'utf8'),
        title: reportTitle(content),
        wordCount: wordCount(content),
        digest: sha256Text(content),
        error: null,
      };
    } catch (error) {
      report = {
        ...report,
        exists: false,
        error: error.code || 'DAILY_REPORT_READ_ERROR',
      };
    }
  }
  const reportDigest = report.exists ? report.digest : null;
  const scorecardSource = project.scorecards
    || project.review?.scorecards
    || project.review?.scorecardResults
    || null;
  const scorecardReportDigest = project.scorecardCandidateDigest
    || project.review?.candidateDigest
    || project.review?.candidateIdentity?.candidateDigest
    || (() => {
      const candidates = Object.values(scorecardSource || {})
        .map((scorecard) => scorecard?.sourceCandidateDigest || scorecard?.sourceDigest)
        .filter(Boolean);
      return candidates.length && candidates.every((candidate) => candidate === candidates[0])
        ? candidates[0]
        : null;
    })();
  const scorecardProjection = reportDigest
    ? projectDailyReportScorecards({ scorecards: scorecardSource, reportDigest: scorecardReportDigest })
    : { scorecardStatus: 'unavailable', scorecards: null };

  return {
    index: normalizeNumber(project.index),
    ideaId: project.ideaId || null,
    projectId: project.projectId || null,
    title: meta.titleZh || meta.title || report.title || project.projectId || null,
    titleZh: meta.titleZh || null,
    tickers: Array.isArray(meta.tickers) ? meta.tickers : [],
    theme: meta.theme || null,
    createdAt: meta.createdAt || null,
    sourceIdeaId: project.sourceIdeaId || null,
    status: project.status || '',
    runStatus: project.runStatus || '',
    runId: project.runId || null,
    workflowId: project.workflowId || null,
    workflowHash: project.workflowHash || null,
    reportReady: Boolean(project.reportReady),
    conclusionRating: project.conclusionRating || null,
    reviewTaskStatus: project.reviewTaskStatus || null,
    stopReason: project.stopReason || null,
    scorecardStatus: scorecardProjection.scorecardStatus,
    scorecards: scorecardProjection.scorecards,
    report,
  };
}

function readSummaryAt(runDir) {
  return readJson(path.join(runDir, 'summary.json'), 'daily report summary');
}

export function listDailyReportRuns(options = {}) {
  const root = evidenceRoot(options);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID_RE.test(entry.name))
    .map((entry) => {
      const runDir = path.join(root, entry.name);
      const summaryPath = path.join(runDir, 'summary.json');
      if (!fs.existsSync(summaryPath)) return null;
      try {
        return compactRunSummary(readSummaryAt(runDir), entry.name);
      } catch (error) {
        return {
          id: entry.name,
          directoryName: entry.name,
          runName: entry.name,
          state: 'invalid',
          ok: false,
          live: false,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          configuration: compactConfiguration(),
          provider: compactProvider(),
          ideaGeneration: compactIdeaGeneration(),
          batch: compactBatch(),
          verification: compactVerification(),
          errors: [{ code: error.code || 'INVALID_DAILY_REPORT_EVIDENCE', message: error.message }],
        };
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const byTime = runSortKey(b).localeCompare(runSortKey(a));
      return byTime || b.directoryName.localeCompare(a.directoryName);
    })
    .slice(0, Math.max(1, Math.min(100, normalizeNumber(options.limit, 30))));
}

export function getDailyReportRun(runId, options = {}) {
  const root = evidenceRoot(options);
  const { directoryName, directory } = runDirectory(root, runId);
  const summary = readSummaryAt(directory);
  const projects = Array.isArray(summary.projects)
    ? summary.projects.map((project) => enrichProject(directory, project)).sort((a, b) => a.index - b.index)
    : [];
  return {
    ...compactRunSummary(summary, directoryName),
    projects,
  };
}

export function getDailyReportContent(runId, projectId, options = {}) {
  const root = evidenceRoot(options);
  const { directoryName, directory } = runDirectory(root, runId);
  const summary = readSummaryAt(directory);
  const project = (Array.isArray(summary.projects) ? summary.projects : [])
    .find((item) => item.projectId === projectId);
  if (!project) {
    throw dailyReportError('project not found in daily report run', 'DAILY_REPORT_PROJECT_NOT_FOUND', 404);
  }
  const resolved = resolveReportFile(directory, project);
  let content;
  try {
    content = fs.readFileSync(resolved.file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw dailyReportError('report file not found', 'DAILY_REPORT_FILE_NOT_FOUND', 404);
    }
    throw error;
  }
  return {
    runId: directoryName,
    project: enrichProject(directory, project),
    report: {
      path: resolved.relativePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      title: reportTitle(content),
      wordCount: wordCount(content),
      content,
    },
  };
}
