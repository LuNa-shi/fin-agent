#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  projectDailyReportScorecards,
  SCORECARD_LENSES,
} from '../src/domains/reports/scorecardProjection.js';

const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DEFAULT_IDEA_COUNT = 100;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_RESCUE_ATTEMPTS = 1;
const LIVE_IDEA_GENERATION_CHUNK_SIZE = 20;
const ACTIVE_STATUSES = new Set(['queued', 'analyzing']);

function usage() {
  return [
    'Usage: node scripts/runDaily100ReportGate.mjs [options]',
    '',
    'Options:',
    '  --ideas <n>            Number of ideas/projects/reports to verify (default: 100)',
    '  --batch-size <n>       Run Analysis concurrency limit (default: 10)',
    '  --timeout-ms <n>       Overall wait timeout (default: 5400000)',
    '  --poll-ms <n>          Status poll interval (default: 1000)',
    '  --intensity <value>    Run Analysis intensity (default: quick)',
    '  --rescue-attempts <n>  Fresh-rerun unfinished projects after the main batch (default: 1)',
    '  --no-rescue            Disable the tail-end rescue rerun',
    '  --fixed-ideas <path>   Use a fixed idea JSON file or idea.json directory; skips Idea Generation',
    '  --mode <demo|live>     Gate mode (default: demo)',
    '  --live                 Same as --mode live',
    '  --output-dir <path>    Evidence directory (default: artifacts/local/daily-100-report-gate/<run>)',
    '  --data-dir <path>      FIN_DATA_DIR used for the gate (default: <output-dir>/data)',
    '  --report-library-dir <path> Shared Report Library authority (default: <data-dir>/report-library)',
    '  --canonical-worldview-dir <path> Shared Canonical Worldview authority (default: sibling of Report Library)',
    '  --claim-library-dir <path> Shared Claim Library authority (default: sibling of Report Library)',
    '  --quiet                Suppress progress logs',
    '  --help                 Print this help',
  ].join('\n');
}

function gateError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw gateError(`${name} requires a value`, 'INVALID_GATE_ARGUMENTS');
  }
  return value;
}

function positiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw gateError(`${name} must be a positive integer`, 'INVALID_GATE_ARGUMENTS');
  }
  return n;
}

function nonNegativeInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw gateError(`${name} must be a non-negative integer`, 'INVALID_GATE_ARGUMENTS');
  }
  return n;
}

function assertDailyCandidateBound(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw gateError('daily report producer requires between 1 and 100 candidates', 'INVALID_GATE_ARGUMENTS');
  }
}

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export function parseDailyReportGateArgs(argv = process.argv.slice(2)) {
  const config = {
    ideas: DEFAULT_IDEA_COUNT,
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    intensity: 'quick',
    analysisLanguage: 'en',
    reportLanguage: 'en',
    companyLocale: 'global',
    rescueAttempts: DEFAULT_RESCUE_ATTEMPTS,
    fixedIdeasPath: '',
    mode: 'demo',
    outputDir: '',
    dataDir: '',
    reportLibraryDir: '',
    canonicalWorldviewDir: '',
    claimLibraryDir: '',
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--ideas':
      case '--idea-count':
        config.ideas = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--batch-size':
        config.batchSize = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--timeout-ms':
        config.timeoutMs = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--poll-ms':
        config.pollMs = positiveInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--intensity':
        config.intensity = readValue(argv, i, arg);
        i += 1;
        break;
      case '--rescue-attempts':
        config.rescueAttempts = nonNegativeInteger(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--no-rescue':
        config.rescueAttempts = 0;
        break;
      case '--analysis-language':
        config.analysisLanguage = readValue(argv, i, arg);
        i += 1;
        break;
      case '--report-language':
        config.reportLanguage = readValue(argv, i, arg);
        i += 1;
        break;
      case '--company-locale':
        config.companyLocale = readValue(argv, i, arg);
        i += 1;
        break;
      case '--fixed-ideas':
        config.fixedIdeasPath = readValue(argv, i, arg);
        i += 1;
        break;
      case '--mode':
        config.mode = readValue(argv, i, arg);
        i += 1;
        break;
      case '--live':
        config.mode = 'live';
        break;
      case '--output-dir':
        config.outputDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--data-dir':
        config.dataDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--report-library-dir':
        config.reportLibraryDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--canonical-worldview-dir':
        config.canonicalWorldviewDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--claim-library-dir':
        config.claimLibraryDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--quiet':
        config.quiet = true;
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
      default:
        throw gateError(`unknown option: ${arg}`, 'INVALID_GATE_ARGUMENTS');
    }
  }

  assertDailyCandidateBound(config.ideas);
  config.mode = String(config.mode || 'demo').trim().toLowerCase();
  if (!['demo', 'live'].includes(config.mode)) {
    throw gateError('--mode must be demo or live', 'INVALID_GATE_ARGUMENTS');
  }
  if (!['quick', 'standard', 'deep'].includes(config.intensity)) {
    throw gateError('--intensity must be quick, standard, or deep', 'INVALID_GATE_ARGUMENTS');
  }
  return config;
}

function prepareGateWorkspace(config, startedAt = new Date()) {
  const runName = `daily-100-report-gate-${config.mode}-${timestampToken(startedAt)}`;
  const outputDir = path.resolve(
    config.outputDir
      || path.join(REPO_ROOT, 'artifacts/local/daily-100-report-gate', runName),
  );
  const dataDir = path.resolve(config.dataDir || path.join(outputDir, 'data'));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  process.env.FIN_DATA_DIR = dataDir;
  if (String(config.reportLibraryDir || '').trim()) {
    process.env.REPORT_LIBRARY_DIR = path.resolve(config.reportLibraryDir);
  } else {
    delete process.env.REPORT_LIBRARY_DIR;
  }
  const residentReportLibraryDir = process.env.REPORT_LIBRARY_DIR || path.join(dataDir, 'report-library');
  process.env.CANONICAL_WORLDVIEW_DIR = path.resolve(
    String(config.canonicalWorldviewDir || '').trim()
      || path.join(path.dirname(residentReportLibraryDir), 'canonical-worldview'),
  );
  process.env.CLAIM_LIBRARY_DIR = path.resolve(
    String(config.claimLibraryDir || '').trim()
      || path.join(path.dirname(residentReportLibraryDir), 'claim-library'),
  );
  process.env.AUTO_RESUME = 'false';
  process.env.MAX_ANALYSES = String(config.batchSize);
  process.env.DEMO_MODE = config.mode === 'live' ? 'false' : 'true';

  return {
    outputDir,
    dataDir,
    reportLibraryDir: residentReportLibraryDir,
    canonicalWorldviewDir: process.env.CANONICAL_WORLDVIEW_DIR,
    claimLibraryDir: process.env.CLAIM_LIBRARY_DIR,
    evidencePath: path.join(outputDir, 'summary.json'),
    startedAt: startedAt.toISOString(),
    runName,
  };
}

async function loadRuntime() {
  const [
    { IdeaSystem },
    { createProjectFromIdea },
    ideasDomain,
    projectSpaceModule,
    { RunAnalysisService },
    reportsDomain,
    claimsDomain,
    worldviewDomain,
    worldviewWorkflow,
    configModule,
  ] = await Promise.all([
    import('../src/workflows/idea-generation/ideaSystem.js'),
    import('../src/domains/ideas/createProjectFromIdea.js'),
    import('../src/domains/ideas/index.js'),
    import('../src/project-space/index.js'),
    import('../src/workflows/run-analysis/RunAnalysisService.js'),
    import('../src/domains/reports/index.js'),
    import('../src/domains/claims/index.js'),
    import('../src/domains/worldview/index.js'),
    import('../src/workflows/worldview/index.js'),
    import('../src/config.js'),
  ]);
  return {
    IdeaSystem,
    createProjectFromIdea,
    IdeaStore: ideasDomain.IdeaStore,
    ProjectSpace: projectSpaceModule.ProjectSpace,
    RunAnalysisService,
    createDailyReportBatchAdmission: reportsDomain.createDailyReportBatchAdmission,
    createReportAdmissionService: reportsDomain.createReportAdmissionService,
    createReportLibraryStore: reportsDomain.createReportLibraryStore,
    createVerifiedInternalReportPackage: reportsDomain.createVerifiedInternalReportPackage,
    createClaimStore: claimsDomain.createClaimStore,
    createCanonicalWorldviewStore: worldviewDomain.createCanonicalWorldviewStore,
    createWorldviewRunPublicationStore: worldviewWorkflow.createWorldviewRunPublicationStore,
    createCanonicalWorldviewCoordinator: worldviewWorkflow.createCanonicalWorldviewCoordinator,
    providerStatus: configModule.providerStatus,
    worldviewBounds: {
      maxOverviewCountPerRun: configModule.WORLDVIEW_MAX_OVERVIEWS_PER_RUN,
      maxOverviewBytesPerRun: configModule.WORLDVIEW_MAX_OVERVIEW_BYTES_PER_RUN,
      maxContextTokensPerRun: configModule.WORLDVIEW_MAX_CONTEXT_TOKENS_PER_RUN,
      maxOutputTokensPerRun: configModule.WORLDVIEW_MAX_OUTPUT_TOKENS_PER_RUN,
      maxWallClockMsPerRun: configModule.WORLDVIEW_MAX_WALL_CLOCK_MS_PER_RUN,
      maxToolCallsPerRun: configModule.WORLDVIEW_MAX_TOOL_CALLS_PER_RUN,
    },
  };
}

function assertProviderReady(config, provider) {
  if (config.mode === 'live' && !provider.liveLLM) {
    throw gateError(
      `live gate provider is not available: selected=${provider.defaultProvider || '(none)'}`,
      'LIVE_GATE_PROVIDER_UNAVAILABLE',
    );
  }
  if (config.mode === 'demo' && provider.activeProvider !== 'demo') {
    throw gateError(
      `demo gate did not resolve the demo provider: active=${provider.activeProvider || '(none)'}`,
      'DEMO_GATE_PROVIDER_MISMATCH',
    );
  }
}

function compactProviderStatus(provider) {
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

function resolveExistingInputPath(input, label) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw gateError(`${label} requires a non-empty path`, 'INVALID_GATE_ARGUMENTS');
  }
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
        path.resolve(process.cwd(), raw),
        path.resolve(REPO_ROOT, raw),
        path.resolve(BACKEND_ROOT, raw),
      ];
  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw gateError(`${label} does not exist: ${raw}`, 'INVALID_GATE_ARGUMENTS');
}

function assertRegularInputFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw gateError(`${label} must not be a symlink: ${file}`, 'FIXED_IDEAS_SYMLINK_DENIED');
  }
  if (!stat.isFile()) {
    throw gateError(`${label} must be a file: ${file}`, 'INVALID_FIXED_IDEAS_SOURCE');
  }
}

function readJsonInput(file, label) {
  assertRegularInputFile(file, label);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw gateError(`${label} contains invalid JSON: ${file}`, 'INVALID_FIXED_IDEAS_SOURCE');
  }
}

function collectIdeaJsonFiles(directory) {
  const files = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw gateError(
        `fixed ideas source must not contain symlinks: ${current}`,
        'FIXED_IDEAS_SYMLINK_DENIED',
      );
    }
    if (stat.isFile()) {
      if (path.basename(current) === 'idea.json') files.push(current);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current).sort()) {
      visit(path.join(current, entry));
    }
  };
  visit(directory);
  return files.sort();
}

function fixedIdeaRecordsFromSource(sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw gateError(
      `fixed ideas source must not be a symlink: ${sourcePath}`,
      'FIXED_IDEAS_SYMLINK_DENIED',
    );
  }
  if (stat.isDirectory()) {
    const files = collectIdeaJsonFiles(sourcePath);
    if (!files.length) {
      throw gateError(
        `fixed ideas directory contains no idea.json files: ${sourcePath}`,
        'INVALID_FIXED_IDEAS_SOURCE',
      );
    }
    return files.map((file) => readJsonInput(file, 'fixed idea file'));
  }
  const value = readJsonInput(sourcePath, 'fixed ideas file');
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.ideas)) return value.ideas;
  if (Array.isArray(value?.generated)) return value.generated;
  return [value];
}

function normalizeFixedIdeaTitle(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/gu, '')
    .slice(0, 48);
}

function fixedIdeaBody(record) {
  if (record && typeof record === 'object' && !Array.isArray(record) && record.body) {
    return record.body;
  }
  return record;
}

function sanitizeFixedIdea(record, index) {
  const body = fixedIdeaBody(record);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw gateError(`fixed idea ${index} must be an object`, 'INVALID_FIXED_IDEAS_SOURCE');
  }
  const idea = JSON.parse(JSON.stringify(body));
  for (const field of [
    'associatedProjectIds',
    'contentRef',
    'contentDigest',
    'createdAt',
    'updatedAt',
    'sourceRunId',
    'sourceSnapshotId',
    'sourceIdeaRunId',
    'sourceRunInputSnapshotId',
    'sourceRunAsOf',
    'sourceEffectiveConfigDigest',
    'sourceGeneratorTraceRef',
    'sourceQualityTraceRef',
  ]) {
    delete idea[field];
  }
  if (typeof idea.title !== 'string' || !idea.title.trim()) {
    throw gateError(`fixed idea ${index} is missing title`, 'INVALID_FIXED_IDEAS_SOURCE');
  }
  idea.status = 'new';
  return idea;
}

function loadFixedIdeasForGate({ config, IdeaStore, logProgress }) {
  const sourcePath = resolveExistingInputPath(config.fixedIdeasPath, '--fixed-ideas');
  const records = fixedIdeaRecordsFromSource(sourcePath);
  const selected = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (let index = 0; index < records.length && selected.length < config.ideas; index += 1) {
    const idea = sanitizeFixedIdea(records[index], index);
    const titleKey = normalizeFixedIdeaTitle(idea.title);
    if (!titleKey || seenTitles.has(titleKey)) continue;
    if (idea.id && seenIds.has(idea.id)) continue;
    if (idea.id) seenIds.add(idea.id);
    seenTitles.add(titleKey);
    selected.push(idea);
  }
  if (selected.length < config.ideas) {
    throw gateError(
      `fixed ideas source provided ${selected.length} unique ideas, expected ${config.ideas}`,
      'DAILY_REPORT_GATE_FIXED_IDEA_COUNT_MISMATCH',
    );
  }
  logProgress(`loading ${config.ideas} fixed ideas from ${sourcePath}`);
  const generated = IdeaStore.addIdeas(selected);
  return {
    generated,
    runs: [],
    provider: null,
    live: false,
    source: 'fixed-ideas',
    sourcePath,
    candidates: records.length,
    selected: selected.length,
    persisted: generated.length,
  };
}

function createProjects({ ideas, config, createProjectFromIdea }) {
  return ideas.map((idea, index) => {
    const project = createProjectFromIdea({
      ideaId: idea.id,
      intensity: config.intensity,
      analysisLanguage: config.analysisLanguage,
      reportLanguage: config.reportLanguage,
      companyLocale: config.companyLocale,
    });
    return { index, idea, project };
  });
}

async function generateIdeasForGate({ IdeaSystem, config, logProgress }) {
  const runs = [];
  const generated = [];
  const seen = new Set();
  const chunkSize = config.mode === 'live'
    ? LIVE_IDEA_GENERATION_CHUNK_SIZE
    : config.ideas;
  const maxAttempts = Math.max(1, Math.ceil(config.ideas / chunkSize) + 3);

  for (let attempt = 1; generated.length < config.ideas && attempt <= maxAttempts; attempt += 1) {
    const target = Math.min(chunkSize, config.ideas - generated.length);
    logProgress(`generating idea chunk ${attempt} target=${target}`);
    const result = await IdeaSystem.generate(target, {
      services: config.mode === 'live' && config.ideaStore
        ? { ideaStore: snapshotIsolatingIdeaStore(config.ideaStore) }
        : {},
    });
    const chunk = Array.isArray(result.generated) ? result.generated : [];
    let added = 0;
    for (const idea of chunk) {
      if (!idea?.id || seen.has(idea.id) || generated.length >= config.ideas) continue;
      seen.add(idea.id);
      generated.push(idea);
      added += 1;
    }
    runs.push({
      workflowId: result.workflowId || null,
      runId: result.runId || null,
      snapshotId: result.snapshotId || null,
      status: result.status || null,
      requested: target,
      generated: chunk.length,
      acceptedUnique: added,
      provider: result.provider || null,
      live: Boolean(result.live),
    });
    if (!chunk.length && config.mode === 'live') {
      break;
    }
  }

  return {
    generated,
    runs,
    provider: runs.find((run) => run.provider)?.provider || null,
    live: runs.some((run) => run.live),
  };
}

function snapshotIsolatingIdeaStore(realStore) {
  let committed = false;
  return new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === 'getIdeas') {
        return () => (committed ? target.getIdeas() : []);
      }
      if (property === 'addIdeas') {
        return (...args) => {
          committed = true;
          return target.addIdeas(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function terminal(status) {
  return !ACTIVE_STATUSES.has(status.projectStatus);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAnalyses({ service, projects, config, logProgress }) {
  const deadline = Date.now() + config.timeoutMs;
  const observations = {
    samples: 0,
    maxAnalyzingObserved: 0,
    maxQueuedObserved: 0,
  };
  let nextLogAt = Date.now() + 30_000;
  let latestStatuses = [];

  while (Date.now() < deadline) {
    latestStatuses = projects.map(({ project }) => service.status(project.id));
    observations.samples += 1;
    const analyzing = latestStatuses.filter((status) => status.projectStatus === 'analyzing').length;
    const queued = latestStatuses.filter((status) => status.projectStatus === 'queued').length;
    observations.maxAnalyzingObserved = Math.max(observations.maxAnalyzingObserved, analyzing);
    observations.maxQueuedObserved = Math.max(observations.maxQueuedObserved, queued);
    const completed = latestStatuses.filter(terminal).length;
    const failed = latestStatuses.filter((status) => status.projectStatus === 'failed').length;
    if (completed === projects.length) {
      return { statuses: latestStatuses, observations };
    }
    if (Date.now() >= nextLogAt) {
      logProgress(`progress ${completed}/${projects.length}; analyzing=${analyzing}; queued=${queued}; failed=${failed}`);
      nextLogAt = Date.now() + 30_000;
    }
    await sleep(config.pollMs);
  }

  const error = gateError(
    `daily report gate timed out after ${config.timeoutMs}ms`,
    'DAILY_REPORT_GATE_TIMEOUT',
  );
  error.statuses = latestStatuses;
  error.observations = observations;
  throw error;
}

const SCORECARD_REF_PATH_RE = /^analysis\/scorecards\/(data|industry|company)_r[1-9]\d*\.json$/u;
const SCORECARD_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function reportContent(ProjectSpace, projectId, reportPath) {
  if (!reportPath) return '';
  return String(ProjectSpace.fileContent(projectId, reportPath) || '');
}

function reportContentBytes(ProjectSpace, projectId, reportPath) {
  return Buffer.byteLength(reportContent(ProjectSpace, projectId, reportPath), 'utf8');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function commonScorecardCandidateDigest(scorecards) {
  const source = object(scorecards);
  if (!source || SCORECARD_LENSES.some((lens) => !object(source[lens]))) return null;
  const digests = SCORECARD_LENSES.map((lens) => (
    text(source[lens].sourceCandidateDigest || source[lens].sourceDigest)
  ));
  return digests.every((digest) => SCORECARD_DIGEST_RE.test(digest) && digest === digests[0])
    ? digests[0]
    : null;
}

function verifiedScorecardRefs(rawRefs, projectedScorecards) {
  if (!Array.isArray(rawRefs) || rawRefs.length !== SCORECARD_LENSES.length) return null;
  const byLens = new Map();
  for (const rawRef of rawRefs) {
    const ref = object(rawRef);
    if (!ref || !SCORECARD_REF_PATH_RE.test(text(ref.path))) return null;
    const lens = SCORECARD_LENSES.find((candidate) => (
      projectedScorecards[candidate]?.ref?.path === ref.path
    ));
    if (!lens || byLens.has(lens)) return null;
    const expected = projectedScorecards[lens].ref;
    if (
      ref.artifactId !== expected.artifactId
      || ref.version !== expected.version
      || ref.contentDigest !== expected.contentDigest
      || ref.schemaVersion !== expected.schemaVersion
      || ref.producer !== expected.producer
    ) return null;
    byLens.set(lens, expected);
  }
  return SCORECARD_LENSES.every((lens) => byLens.has(lens))
    ? SCORECARD_LENSES.map((lens) => structuredClone(byLens.get(lens)))
    : null;
}

function legacyScorecardPackage(status) {
  if (!status || object(status.reportPackage)) return null;
  if (!Object.hasOwn(status, 'scorecards')
    && !Object.hasOwn(status, 'scorecardCandidateDigest')
    && !Object.hasOwn(status, 'scorecardRefs')) return null;
  return {
    scorecardCandidateDigest: status.scorecardCandidateDigest,
    scorecards: status.scorecards,
    scorecardRefs: status.scorecardRefs,
  };
}

function projectVerifiedScorecardBundle({ reportPackage }) {
  const source = object(reportPackage);
  if (!source) {
    return { scorecardStatus: 'unavailable', scorecardCandidateDigest: null, scorecards: null, scorecardRefs: [] };
  }
  const scorecardCandidateDigest = source.scorecardCandidateDigest === undefined
    ? commonScorecardCandidateDigest(source.scorecards)
    : text(source.scorecardCandidateDigest);
  if (!SCORECARD_DIGEST_RE.test(scorecardCandidateDigest)) {
    return { scorecardStatus: 'unavailable', scorecardCandidateDigest: null, scorecards: null, scorecardRefs: [] };
  }
  const projection = projectDailyReportScorecards({
    scorecards: source.scorecards,
    reportDigest: scorecardCandidateDigest,
  });
  if (projection.scorecardStatus !== 'available') {
    return { scorecardStatus: 'unavailable', scorecardCandidateDigest: null, scorecards: null, scorecardRefs: [] };
  }
  const scorecardRefs = verifiedScorecardRefs(source.scorecardRefs, projection.scorecards);
  if (!scorecardRefs) {
    return { scorecardStatus: 'unavailable', scorecardCandidateDigest: null, scorecards: null, scorecardRefs: [] };
  }
  return {
    scorecardStatus: 'available',
    scorecardCandidateDigest,
    scorecards: projection.scorecards,
    scorecardRefs,
  };
}

export function projectEvidence({ projectEntry, status, ProjectSpace }) {
  const meta = ProjectSpace.meta(projectEntry.project.id);
  const reportPackage = object(status.reportPackage) || legacyScorecardPackage(status);
  const reportPath = object(status.reportPackage)?.reportPath || null;
  const scorecardProjection = projectVerifiedScorecardBundle({ reportPackage });
  return {
    index: projectEntry.index,
    ideaId: projectEntry.idea.id,
    projectId: projectEntry.project.id,
    sourceIdeaId: meta?.sourceIdeaId || null,
    status: status.projectStatus,
    runStatus: status.runStatus,
    runId: status.currentRunId || status.runId || null,
    workflowId: status.workflow?.id || null,
    workflowHash: status.workflow?.hash || null,
    reportReady: Boolean(status.reportReady),
    reportPath,
    reportBytes: reportContentBytes(ProjectSpace, projectEntry.project.id, reportPath),
    conclusionRating: object(status.reportPackage)?.conclusion?.rating || null,
    reviewTaskStatus: status.reviewTask?.status || null,
    stopReason: status.run?.stopReason || null,
    scorecardCandidateDigest: scorecardProjection.scorecardCandidateDigest,
    scorecardStatus: scorecardProjection.scorecardStatus,
    scorecards: scorecardProjection.scorecards,
    scorecardRefs: scorecardProjection.scorecardRefs,
  };
}

export function projectEvidenceHasVerifiedReport(project) {
  return Boolean(
    project
    && project.status === 'analyzed'
    && project.runStatus === 'SUCCEEDED'
    && project.reportReady
    && project.reportPath
    && project.reportBytes > 0
  );
}

function uniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function batchProductionAttempts(project, initialProjects, rescue) {
  const initial = initialProjects.find((candidate) => candidate.index === project.index);
  const attempts = initial ? [{
    attemptId: 'initial',
    analysisRunId: initial.runId,
    status: projectEvidenceHasVerifiedReport(initial) ? 'succeeded' : 'failed',
    error: projectEvidenceHasVerifiedReport(initial) ? null : {
      code: 'INITIAL_REPORT_PRODUCTION_FAILED',
      message: initial.stopReason || initial.status || 'initial report production failed',
    },
  }] : [];
  for (const rescueAttempt of rescue.attempts || []) {
    const started = rescueAttempt.startResults?.find((candidate) => candidate.index === project.index);
    if (!started) continue;
    const incomplete = rescueAttempt.stillIncomplete?.find((candidate) => candidate.index === project.index);
    attempts.push({
      attemptId: `rescue-${rescueAttempt.attempt}`,
      analysisRunId: started.runId || incomplete?.runId || null,
      status: incomplete ? 'failed' : 'succeeded',
      error: incomplete ? {
        code: 'RESCUE_REPORT_PRODUCTION_FAILED',
        message: incomplete.stopReason || incomplete.status || 'rescue report production failed',
      } : null,
    });
  }
  return attempts;
}

function mergeAnalysisObservations(observationsList) {
  return observationsList.reduce((merged, item) => ({
    samples: merged.samples + Number(item?.samples || 0),
    maxAnalyzingObserved: Math.max(
      merged.maxAnalyzingObserved,
      Number(item?.maxAnalyzingObserved || 0),
    ),
    maxQueuedObserved: Math.max(
      merged.maxQueuedObserved,
      Number(item?.maxQueuedObserved || 0),
    ),
  }), {
    samples: 0,
    maxAnalyzingObserved: 0,
    maxQueuedObserved: 0,
  });
}

export async function runRescueAnalyses({
  service,
  projectEntries,
  initialProjects,
  config,
  logProgress,
  ProjectSpace,
}) {
  const attempts = [];
  let projects = initialProjects;
  const byIndex = new Map(projectEntries.map((entry) => [entry.index, entry]));

  for (let attempt = 1; attempt <= config.rescueAttempts; attempt += 1) {
    const incomplete = projects.filter((project) => !projectEvidenceHasVerifiedReport(project));
    if (!incomplete.length) break;
    const rescueEntries = incomplete
      .map((project) => byIndex.get(project.index))
      .filter(Boolean);
    if (!rescueEntries.length) break;

    logProgress(`rescue attempt ${attempt}: fresh-rerunning ${rescueEntries.length} unfinished projects`);
    const startResults = rescueEntries.map(({ project }) => service.start(project.id, {
      intensity: config.intensity,
      resume: false,
    }));
    const { statuses, observations } = await waitForAnalyses({
      service,
      projects: rescueEntries,
      config,
      logProgress: (message) => logProgress(`rescue attempt ${attempt}: ${message}`),
    });
    const after = rescueEntries.map((entry, index) => projectEvidence({
      projectEntry: entry,
      status: statuses[index],
      ProjectSpace,
    }));
    const afterByProjectId = new Map(after.map((project) => [project.projectId, project]));
    projects = projects.map((project) => afterByProjectId.get(project.projectId) || project);
    const stillIncomplete = after.filter((project) => !projectEvidenceHasVerifiedReport(project));
    attempts.push({
      attempt,
      projectCount: rescueEntries.length,
      projectIds: rescueEntries.map((entry) => entry.project.id),
      startResults: startResults.map((result, index) => ({
        index: rescueEntries[index].index,
        projectId: rescueEntries[index].project.id,
        started: Boolean(result.started),
        queuePosition: Number(result.queuePosition || 0),
        mode: result.mode || null,
        runId: result.currentRunId || result.runId || null,
      })),
      observations,
      recovered: after.length - stillIncomplete.length,
      stillIncomplete: stillIncomplete.map((project) => ({
        index: project.index,
        projectId: project.projectId,
        runId: project.runId,
        status: project.status,
        runStatus: project.runStatus,
        stopReason: project.stopReason,
      })),
    });
  }

  const finalIncomplete = projects.filter((project) => !projectEvidenceHasVerifiedReport(project));
  return {
    attempts,
    projects,
    observations: mergeAnalysisObservations(attempts.map((attempt) => attempt.observations)),
    totalProjectsRetried: attempts.reduce((sum, attempt) => sum + attempt.projectCount, 0),
    recoveredProjects: attempts.reduce((sum, attempt) => sum + attempt.recovered, 0),
    finalIncompleteProjectIds: finalIncomplete.map((project) => project.projectId),
  };
}

function buildVerification({ config, ideaResult, startResults, projects, observations }) {
  const failures = [];
  const projectIds = projects.map((project) => project.projectId);
  const ideaIds = projects.map((project) => project.ideaId);
  const runIds = projects.map((project) => project.runId);
  const reportIds = projects.map((project) => (
    project.reportPath ? `${project.projectId}:${project.reportPath}` : ''
  ));
  const reportCount = projects.filter(projectEvidenceHasVerifiedReport).length;
  const queuedAtStart = startResults.filter((result) => Number(result.queuePosition || 0) > 0).length;
  const expectedQueuedAtStart = Math.max(0, config.ideas - config.batchSize);

  if ((ideaResult.generated || []).length !== config.ideas) {
    failures.push(`expected ${config.ideas} generated ideas, got ${(ideaResult.generated || []).length}`);
  }
  if (projects.length !== config.ideas) {
    failures.push(`expected ${config.ideas} projects, got ${projects.length}`);
  }
  if (uniqueCount(projectIds) !== config.ideas) failures.push('project ids are not unique');
  if (uniqueCount(ideaIds) !== config.ideas) failures.push('idea ids are not unique');
  if (uniqueCount(runIds) !== config.ideas) failures.push('run ids are not unique');
  if (reportCount !== config.ideas) {
    failures.push(`expected ${config.ideas} verified reports, got ${reportCount}`);
  }
  if (projects.some((project) => project.sourceIdeaId !== project.ideaId)) {
    failures.push('at least one project is not linked to its source idea');
  }
  if (projects.some((project) => project.workflowId !== 'run-analysis.v2')) {
    failures.push('at least one project did not invoke the canonical Run Analysis workflow');
  }
  if (projects.some((project) => project.reviewTaskStatus)) {
    failures.push('at least one project exposed a Human Review task');
  }
  if (observations.maxAnalyzingObserved > config.batchSize) {
    failures.push(`observed ${observations.maxAnalyzingObserved} concurrent analyses, limit is ${config.batchSize}`);
  }
  if (queuedAtStart !== expectedQueuedAtStart) {
    failures.push(`expected ${expectedQueuedAtStart} queued projects after initial start, got ${queuedAtStart}`);
  }
  if (uniqueCount(reportIds) !== config.ideas) {
    failures.push('report identities are not unique across projects');
  }

  return {
    ok: failures.length === 0,
    failures,
    ideas: (ideaResult.generated || []).length,
    projects: projects.length,
    reports: reportCount,
    uniqueIdeaIds: uniqueCount(ideaIds),
    uniqueProjectIds: uniqueCount(projectIds),
    uniqueRunIds: uniqueCount(runIds),
    uniqueReportIdentities: uniqueCount(reportIds),
    noHumanReviewTasks: projects.every((project) => !project.reviewTaskStatus),
    canonicalWorkflowInvocations: projects.filter((project) => project.workflowId === 'run-analysis.v2').length,
  };
}

function writeEvidence(evidencePath, summary) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2));
}

export async function runDailyReportGate(rawConfig = {}) {
  const config = {
    ...parseDailyReportGateArgs([]),
    ...rawConfig,
  };
  assertDailyCandidateBound(config.ideas);
  config.mode = String(config.mode || 'demo').trim().toLowerCase();
  const workspace = prepareGateWorkspace(config);
  const logProgress = config.quiet
    ? () => {}
    : (message) => console.error(`[daily-report-gate] ${message}`);

  const summary = {
    schemaVersion: 'daily-report-gate.v1',
    ok: false,
    mode: config.mode,
    live: config.mode === 'live',
    startedAt: workspace.startedAt,
    completedAt: null,
    runName: workspace.runName,
    outputDir: workspace.outputDir,
    dataDir: workspace.dataDir,
    evidencePath: workspace.evidencePath,
    configuration: {
      ideaCount: config.ideas,
      batchSize: config.batchSize,
      intensity: config.intensity,
      analysisLanguage: config.analysisLanguage,
      reportLanguage: config.reportLanguage,
      companyLocale: config.companyLocale,
      rescueAttempts: config.rescueAttempts,
      timeoutMs: config.timeoutMs,
      pollMs: config.pollMs,
      fixedIdeasPath: config.fixedIdeasPath || null,
      reportLibraryDir: workspace.reportLibraryDir,
      canonicalWorldviewDir: workspace.canonicalWorldviewDir,
      claimLibraryDir: workspace.claimLibraryDir,
    },
    provider: null,
    ideaGeneration: null,
    batch: null,
    dailyReportBatch: null,
    reportAdmissionRecovery: null,
    worldviewProcessing: null,
    claimLibrary: null,
    rescue: {
      enabled: config.rescueAttempts > 0,
      attemptsConfigured: config.rescueAttempts,
      attempts: [],
      totalProjectsRetried: 0,
      recoveredProjects: 0,
      finalIncompleteProjectIds: [],
    },
    verification: null,
    projects: [],
    errors: [],
  };
  let projectEntries = [];
  let analysisService = null;
  let dailyReportBatchAdmission = null;
  let createdDailyReportBatch = null;

  try {
    const runtime = await loadRuntime();
    const provider = compactProviderStatus(runtime.providerStatus());
    assertProviderReady(config, provider);
    summary.provider = provider;

    const canonicalWorldviewStore = runtime.createCanonicalWorldviewStore({
      rootDir: workspace.canonicalWorldviewDir,
    });
    const worldviewPublicationStore = runtime.createWorldviewRunPublicationStore({
      rootDir: path.join(workspace.canonicalWorldviewDir, 'run-publications'),
    });
    canonicalWorldviewStore.bindPublicationReader(
      (publicationId) => worldviewPublicationStore.isCompleted(publicationId),
    );
    const reportLibrary = runtime.createReportLibraryStore({
      processedReceiptReader: () => worldviewPublicationStore.processedReceipts(),
    });
    const claimStore = runtime.createClaimStore({
      rootDir: workspace.claimLibraryDir,
      publicationReader: (publicationId) => {
        const publication = worldviewPublicationStore.get(publicationId);
        return publication ? {
          publicationId,
          claimPublicationDigest: publication.claims.publicationDigest,
        } : false;
      },
    });
    const reportAdmissionService = runtime.createReportAdmissionService({ reportLibrary });
    const recoveredAdmissions = await reportAdmissionService.recover();
    summary.reportAdmissionRecovery = {
      candidateCount: recoveredAdmissions.length,
      admittedCount: recoveredAdmissions.filter((result) => result.status === 'admitted').length,
      retryableCount: recoveredAdmissions.filter((result) => result.status === 'retryable').length,
      failedCount: recoveredAdmissions.filter((result) => result.status === 'failed').length,
    };

    const ideaResult = config.fixedIdeasPath
      ? loadFixedIdeasForGate({
          config,
          IdeaStore: runtime.IdeaStore,
          logProgress,
        })
      : await generateIdeasForGate({
          IdeaSystem: runtime.IdeaSystem,
          config: { ...config, ideaStore: runtime.IdeaStore },
          logProgress,
        });
    summary.ideaGeneration = {
      source: ideaResult.source || 'workflow',
      sourcePath: ideaResult.sourcePath || null,
      workflowId: ideaResult.runs.length === 1
        ? ideaResult.runs[0].workflowId
        : (ideaResult.source === 'fixed-ideas' ? null : 'idea-generation.v2'),
      runId: ideaResult.runs.length === 1 ? ideaResult.runs[0].runId : null,
      snapshotId: ideaResult.runs.length === 1 ? ideaResult.runs[0].snapshotId : null,
      status: ideaResult.generated.length === config.ideas
        && ideaResult.runs.every((run) => run.status === 'SUCCEEDED')
        ? 'SUCCEEDED'
        : 'INCOMPLETE',
      generated: (ideaResult.generated || []).length,
      ideas: (ideaResult.generated || []).length,
      candidateIdeas: ideaResult.candidates || null,
      selectedIdeas: ideaResult.selected || null,
      persistedIdeas: ideaResult.persisted || null,
      provider: ideaResult.provider || null,
      live: Boolean(ideaResult.live),
      runs: ideaResult.runs,
    };
    if ((ideaResult.generated || []).length !== config.ideas) {
      throw gateError(
        `Idea Generation produced ${(ideaResult.generated || []).length} ideas, expected ${config.ideas}`,
        'DAILY_REPORT_GATE_IDEA_COUNT_MISMATCH',
      );
    }

    logProgress(`creating ${config.ideas} independent projects`);
    projectEntries = createProjects({
      ideas: ideaResult.generated,
      config,
      createProjectFromIdea: runtime.createProjectFromIdea,
    });
    const worldviewCoordinator = runtime.createCanonicalWorldviewCoordinator({
      dataDir: workspace.dataDir,
      reportLibrary,
      worldviewStore: canonicalWorldviewStore,
      claimStore,
      publicationStore: worldviewPublicationStore,
      ...runtime.worldviewBounds,
    });
    dailyReportBatchAdmission = runtime.createDailyReportBatchAdmission({
      reportLibrary,
      admissionService: reportAdmissionService,
      worldviewCoordinator,
    });
    await dailyReportBatchAdmission.recoveryPromise;
    createdDailyReportBatch = dailyReportBatchAdmission.createBatch({
      contract: 'daily-report-batch.v1',
      productionDate: workspace.startedAt.slice(0, 10),
      producer: { id: 'scheduled-daily-report' },
      productionRunId: workspace.runName,
      items: projectEntries.map((entry) => ({
        itemId: `daily-item-${String(entry.index + 1).padStart(6, '0')}`,
        projectId: entry.project.id,
        sourceIdeaId: entry.idea.id,
      })),
    });
    summary.dailyReportBatch = createdDailyReportBatch.batch;
    analysisService = new runtime.RunAnalysisService({
      maxConcurrent: config.batchSize,
    });
    const service = analysisService;
    logProgress(`starting Run Analysis for ${config.ideas} projects with concurrency ${config.batchSize}`);
    const startResults = projectEntries.map(({ project }) => service.start(project.id, {
      intensity: config.intensity,
      resume: false,
    }));
    const { statuses: initialStatuses, observations: initialObservations } = await waitForAnalyses({
      service,
      projects: projectEntries,
      config,
      logProgress,
    });
    const initialProjects = projectEntries.map((entry, index) => projectEvidence({
      projectEntry: entry,
      status: initialStatuses[index],
      ProjectSpace: runtime.ProjectSpace,
    }));
    const rescue = config.rescueAttempts > 0
      ? await runRescueAnalyses({
          service,
          projectEntries,
          initialProjects,
          config,
          logProgress,
          ProjectSpace: runtime.ProjectSpace,
        })
      : {
          attempts: [],
          projects: initialProjects,
          observations: mergeAnalysisObservations([]),
          totalProjectsRetried: 0,
          recoveredProjects: 0,
          finalIncompleteProjectIds: initialProjects
            .filter((project) => !projectEvidenceHasVerifiedReport(project))
            .map((project) => project.projectId),
        };
    summary.projects = rescue.projects;
    summary.rescue = {
      enabled: config.rescueAttempts > 0,
      attemptsConfigured: config.rescueAttempts,
      attempts: rescue.attempts,
      totalProjectsRetried: rescue.totalProjectsRetried,
      recoveredProjects: rescue.recoveredProjects,
      finalIncompleteProjectIds: rescue.finalIncompleteProjectIds,
    };
    await Promise.all(summary.projects.map(async (project) => {
      const itemId = `daily-item-${String(project.index + 1).padStart(6, '0')}`;
      const productionAttempts = batchProductionAttempts(project, initialProjects, rescue);
      if (!projectEvidenceHasVerifiedReport(project)) {
        dailyReportBatchAdmission.failItem({
          batchId: createdDailyReportBatch.batchId,
          itemId,
          analysisRunId: project.runId,
          stage: 'production',
          error: {
            code: 'DAILY_REPORT_PRODUCTION_FAILED',
            message: project.stopReason || project.status || 'Run Analysis did not publish a verified report',
          },
          productionAttempts,
        });
        return;
      }
      let packageInput;
      try {
        packageInput = runtime.createVerifiedInternalReportPackage({
          projectId: project.projectId,
          runId: project.runId,
          dailyReportRunId: createdDailyReportBatch.batchId,
          projectSpace: runtime.ProjectSpace,
        });
      } catch (error) {
        dailyReportBatchAdmission.failItem({
          batchId: createdDailyReportBatch.batchId,
          itemId,
          analysisRunId: project.runId,
          stage: 'production',
          error,
          productionAttempts,
        });
        return;
      }
      await dailyReportBatchAdmission.completeItem({
        batchId: createdDailyReportBatch.batchId,
        itemId,
        packageInput,
        admissionAttemptId: 'initial',
        productionAttempts,
      });
    }));
    const closedDailyReportBatch = dailyReportBatchAdmission.close(createdDailyReportBatch.batchId);
    summary.dailyReportBatch = closedDailyReportBatch.batch;
    summary.worldviewProcessing = closedDailyReportBatch.processingPromise
      ? await closedDailyReportBatch.processingPromise
      : { status: 'no-work', runs: [] };
    const visibleClaims = claimStore.list({ limit: 10_000 }).claims;
    summary.claimLibrary = {
      status: claimStore.status(),
      claims: visibleClaims,
    };
    const observations = mergeAnalysisObservations([
      initialObservations,
      rescue.observations,
    ]);
    summary.batch = {
      maxConcurrent: service.maxConcurrent,
      queuedAtStart: startResults.filter((result) => Number(result.queuePosition || 0) > 0).length,
      maxQueuePositionAtStart: Math.max(0, ...startResults.map((result) => Number(result.queuePosition || 0))),
      startResults: startResults.map((result, index) => ({
        index,
        projectId: projectEntries[index].project.id,
        started: Boolean(result.started),
        queuePosition: Number(result.queuePosition || 0),
        mode: result.mode || null,
        runId: result.currentRunId || result.runId || null,
      })),
      initialObservations,
      observations,
    };
    summary.verification = buildVerification({
      config,
      ideaResult,
      startResults,
      projects: summary.projects,
      observations,
    });
    if (summary.worldviewProcessing?.status !== 'succeeded') {
      summary.verification.failures.push('Worldview processing did not succeed');
    }
    const publicationRuns = summary.worldviewProcessing?.runs || [];
    if (!publicationRuns.length || publicationRuns.some((run) => !run.publicationId)) {
      summary.verification.failures.push('Worldview processing did not commit a run publication marker');
    }
    const processedReceiptCount = publicationRuns.reduce(
      (count, run) => count + (run.processedReceipts?.length || 0),
      0,
    );
    if (processedReceiptCount !== summary.verification.reports) {
      summary.verification.failures.push(
        `expected ${summary.verification.reports} exact Processed receipts, got ${processedReceiptCount}`,
      );
    }
    summary.verification.worldviewPublications = publicationRuns.length;
    summary.verification.processedReceipts = processedReceiptCount;
    summary.verification.claims = summary.claimLibrary?.claims?.length || 0;
    summary.verification.ok = summary.verification.failures.length === 0;
    summary.ok = summary.verification.ok;
    summary.completedAt = new Date().toISOString();
    writeEvidence(workspace.evidencePath, summary);
    if (!summary.ok) {
      const error = gateError(
        `daily report gate failed: ${summary.verification.failures.join('; ')}`,
        'DAILY_REPORT_GATE_FAILED',
      );
      error.evidencePath = workspace.evidencePath;
      throw error;
    }
    return summary;
  } catch (error) {
    if (analysisService && projectEntries.length > 0) {
      await Promise.allSettled(projectEntries.map(({ project }) => analysisService.pause(project.id)));
      const settleDeadline = Date.now() + 5_000;
      while (analysisService.inFlightProjectIds().length > 0 && Date.now() < settleDeadline) {
        await sleep(10);
      }
    }
    if (dailyReportBatchAdmission && createdDailyReportBatch) {
      try {
        const currentBatch = dailyReportBatchAdmission.get(createdDailyReportBatch.batchId);
        if (currentBatch?.status === 'open') {
          for (const item of currentBatch.items.filter((candidate) => candidate.status === 'pending')) {
            dailyReportBatchAdmission.failItem({
              batchId: currentBatch.batchId,
              itemId: item.itemId,
              analysisRunId: null,
              stage: 'production',
              error: {
                code: error?.code || 'DAILY_REPORT_GATE_ABORTED',
                message: String(error?.message || error),
              },
            });
          }
          const closedAfterFailure = dailyReportBatchAdmission.close(currentBatch.batchId);
          summary.dailyReportBatch = closedAfterFailure.batch;
          if (closedAfterFailure.processingPromise) {
            summary.worldviewProcessing = await closedAfterFailure.processingPromise;
          }
        } else if (currentBatch) {
          summary.dailyReportBatch = currentBatch;
        }
      } catch (batchError) {
        summary.errors.push({
          code: batchError?.code || 'DAILY_REPORT_BATCH_FINALIZATION_FAILED',
          message: String(batchError?.message || batchError),
        });
      }
    }
    summary.completedAt = summary.completedAt || new Date().toISOString();
    summary.errors.push({
      code: error?.code || 'DAILY_REPORT_GATE_ERROR',
      message: String(error?.message || error),
    });
    writeEvidence(workspace.evidencePath, summary);
    error.evidencePath = error.evidencePath || workspace.evidencePath;
    throw error;
  }
}

async function main() {
  let config;
  try {
    config = parseDailyReportGateArgs();
    if (config.help) {
      console.log(usage());
      return;
    }
    const summary = await runDailyReportGate(config);
    console.log(JSON.stringify({
      ok: summary.ok,
      mode: summary.mode,
      live: summary.live,
      ideas: summary.verification.ideas,
      projects: summary.verification.projects,
      reports: summary.verification.reports,
      ideaSource: summary.ideaGeneration.source,
      batchSize: summary.configuration.batchSize,
      maxAnalyzingObserved: summary.batch.observations.maxAnalyzingObserved,
      rescueAttempts: summary.rescue.attempts.length,
      rescuedReports: summary.rescue.recoveredProjects,
      dailyReportBatchId: summary.dailyReportBatch?.batchId || null,
      evidencePath: summary.evidencePath,
      dataDir: summary.dataDir,
    }, null, 2));
  } catch (error) {
    console.error(`[daily-report-gate] ${error?.code || 'ERROR'}: ${error?.message || error}`);
    if (error?.evidencePath) {
      console.error(`[daily-report-gate] evidence: ${error.evidencePath}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
