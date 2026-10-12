import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.dirname(backendRoot);
const m1WorkerFile = fileURLToPath(
  new URL('./support/m1W3W5Worker.mjs', import.meta.url),
);
const w8WorkerFile = fileURLToPath(
  new URL('./support/w8DeterministicWorker.mjs', import.meta.url),
);
const fixtureFile = fileURLToPath(
  new URL('../test/fixtures/workflow-w8/v1/scenario.json', import.meta.url),
);
const testMode = process.argv.includes('--test');
let currentStage = 'initialize';
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--test');
const WORKER_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const EVIDENCE_FILES = Object.freeze({
  summary: 'summary.json',
  runRecord: 'run-record.json',
  lineage: 'lineage.json',
  statusMatrix: 'status-matrix.json',
  validation: 'validation.txt',
});
const BYTE_STABLE_EVIDENCE_FILES = Object.freeze([
  EVIDENCE_FILES.summary,
  EVIDENCE_FILES.statusMatrix,
  EVIDENCE_FILES.validation,
]);
const EXACT_RUN_INTEGRITY_FILES = Object.freeze([
  EVIDENCE_FILES.runRecord,
  EVIDENCE_FILES.lineage,
]);
const REQUIRED_CASE_OUTCOMES = Object.freeze([
  Object.freeze({ case: 'all-valid-ideas', actual: 'passed' }),
  Object.freeze({ case: 'successful-publish', actual: 'analyzed' }),
  Object.freeze({ case: 'review-required', actual: 'review-required' }),
  Object.freeze({ case: 'human-resolution', actual: 'analyzed' }),
  Object.freeze({ case: 'snapshot-immutability', actual: 'passed' }),
  Object.freeze({ case: 'idempotent-replay', actual: 'passed' }),
  Object.freeze({ case: 'crash-resume', actual: 'passed' }),
  Object.freeze({ case: 'legacy-idea', actual: 'passed' }),
]);
const EXTERNAL_ENV_KEYS = Object.freeze([
  'ALL_PROXY',
  'DEEPSEEK_API_KEY',
  'FMP_API_KEY',
  'FRED_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'GPT_GATEWAY_API_KEY',
  'GPT_GATEWAY_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PERPLEXITY_API_KEY',
  'PPLX_PROXY',
  'TAVILY_API_KEY',
  'X_BEARER_TOKEN',
  'all_proxy',
  'http_proxy',
  'https_proxy',
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function digest(value) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(canonicalValue(value ?? null));
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function structuralRef(ref) {
  if (!ref) return null;
  return Object.fromEntries([
    'artifactId',
    'version',
    'path',
    'schemaVersion',
    'producer',
    'contractVersion',
    'asOf',
  ].filter((key) => ref[key] !== undefined).map((key) => [key, ref[key]]));
}

function structuralAgentAudit(audit) {
  return {
    recordCount: audit.recordCount,
    succeededCallCount: audit.succeededCallCount,
    uniqueIdentityCount: audit.uniqueIdentityCount,
    duplicateSucceededIdentityCount: audit.duplicateSucceededIdentityCount,
    authorizedPauseResumePairs: audit.authorizedPauseResumePairs,
    statuses: audit.statuses,
  };
}

function structuralAnalysisLineage(analysis) {
  return {
    artifactCount: analysis.artifactCount,
    artifactStructureDigest: analysis.artifactStructureDigest,
    eventCount: analysis.eventCount,
    eventTypes: analysis.eventTypes,
    eventShapeDigest: analysis.eventShapeDigest,
    replayStatus: analysis.replayStatus,
    continuousSequence: analysis.continuousSequence,
  };
}

function structuralAcceptanceRecord(evidence) {
  const successSummary = evidence.summary.success;
  const reviewSummary = evidence.summary.review;
  return {
    schemaVersion: 'workflow-w8-structural-acceptance.v1',
    fixture: evidence.summary.fixture,
    ideaGeneration: {
      summary: evidence.summary.ideaGeneration,
      run: evidence.runRecord.structural.ideaGeneration,
      snapshot: evidence.runRecord.ideaGeneration.snapshot,
      events: {
        eventCount: evidence.lineage.ideaEvents.eventCount,
        eventTypes: evidence.lineage.ideaEvents.eventTypes,
        eventShapeDigest: evidence.lineage.ideaEvents.eventShapeDigest,
        replayStatus: evidence.lineage.ideaEvents.replayStatus,
        continuousSequence: evidence.lineage.ideaEvents.continuousSequence,
      },
    },
    success: {
      summary: {
        projectId: successSummary.projectId,
        runId: successSummary.runId,
        projectStatus: successSummary.projectStatus,
        runStatus: successSummary.runStatus,
        reportReady: successSummary.reportReady,
        crashNodeId: successSummary.crashNodeId,
        crashAgentIdentityDigest: successSummary.crashAgentIdentityDigest,
        zeroRepeatedSuccessfulNodes:
          successSummary.zeroRepeatedSuccessfulNodes,
      },
      run: evidence.runRecord.structural.success,
      reportArtifact: structuralRef(evidence.lineage.success.reportArtifact),
      conclusionArtifact:
        structuralRef(evidence.lineage.success.conclusionArtifact),
      analysis: structuralAnalysisLineage(evidence.lineage.success.analysis),
      agentAudit: structuralAgentAudit(evidence.lineage.success.agentAudit),
    },
    review: {
      summary: {
        projectId: reviewSummary.projectId,
        runId: reviewSummary.runId,
        blockedStatus: reviewSummary.blockedStatus,
        blockedReportReady: reviewSummary.blockedReportReady,
        selectedAction: reviewSummary.selectedAction,
        reviewRound: reviewSummary.reviewRound,
        finalStatus: reviewSummary.finalStatus,
        finalTaskStatus: reviewSummary.finalTaskStatus,
        reportReady: reviewSummary.reportReady,
        minimalRoutePreserved: reviewSummary.minimalRoutePreserved,
        taskIssueLinkVerified: reviewSummary.taskIssueLinkVerified,
        decisionLinkVerified: reviewSummary.decisionLinkVerified,
        decisionReplayIdempotent: reviewSummary.decisionReplayIdempotent,
        resumeReplayIdempotent: reviewSummary.resumeReplayIdempotent,
      },
      blockedRun: evidence.runRecord.structural.reviewBlocked,
      resolvedRun: evidence.runRecord.structural.reviewResolved,
      reportArtifact: structuralRef(evidence.lineage.review.reportArtifact),
      conclusionArtifact:
        structuralRef(evidence.lineage.review.conclusionArtifact),
      analysis: structuralAnalysisLineage(evidence.lineage.review.analysis),
      agentAudit: structuralAgentAudit(evidence.lineage.review.agentAudit),
      issueOwners: evidence.lineage.review.humanReview.issueOwners,
    },
    index: {
      entryCount: evidence.lineage.index.entryCount,
      ideaEntryCount: evidence.lineage.index.ideaEntryCount,
      projectEntryCount: evidence.lineage.index.projectEntryCount,
      structureDigest: evidence.lineage.index.structureDigest,
      structuralEntries: evidence.lineage.index.structuralEntries,
      folderCounts: evidence.lineage.index.folderCounts,
      exactDeleteRebuild: evidence.lineage.index.exactDeleteRebuild,
      canonicalFoldersUnchanged:
        evidence.lineage.index.canonicalFoldersUnchanged,
    },
    statusMatrix: evidence.statusMatrix,
    replay: evidence.summary.replay,
    legacy: evidence.summary.legacy,
    network: {
      guardActiveInAllWorkers:
        evidence.summary.network.guardActiveInAllWorkers,
      blockedAttemptCount: evidence.summary.network.blockedAttemptCount,
      providerCalls: evidence.summary.network.providerCalls,
      live: evidence.summary.network.live,
      successSourceMode:
        evidence.summary.network.frozenResearch.success.sourceMode,
      reviewSourceMode:
        evidence.summary.network.frozenResearch.review.sourceMode,
    },
    repository: evidence.summary.repository,
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${label} did not return one JSON result`);
    error.code = 'W8_INVALID_WORKER_OUTPUT';
    throw error;
  }
}

function assertDefaultFixtureRoute(fixture) {
  const settings = fixture?.inputs?.settings;
  assert.deepEqual({
    provider: settings?.DEFAULT_PROVIDER,
    model: settings?.OPENAI_COMPATIBLE_MODEL,
    reasoningLevel: settings?.OPENAI_COMPATIBLE_REASONING_LEVEL,
    reflectionProvider: settings?.REFLECTION_PROVIDER,
    reflectionModel: settings?.REFLECTION_MODEL,
  }, {
    provider: 'openai-compatible',
    model: 'gpt-5.6-sol',
    reasoningLevel: 'high',
    reflectionProvider: 'openai-compatible',
    reflectionModel: 'gpt-5.6-sol',
  });
}

function workerEnvironment(dataDir) {
  const env = {
    AUTO_RESUME: 'false',
    DEFAULT_PROVIDER: 'openai-compatible',
    DEMO_MODE: 'false',
    FIN_DATA_DIR: dataDir,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    MAIN_MODEL: '',
    MAIN_PROVIDER: '',
    OPENAI_COMPATIBLE_MODEL: 'gpt-5.6-sol',
    OPENAI_COMPATIBLE_REASONING_LEVEL: 'high',
    PATH: process.env.PATH || '',
    REFLECTION_MODEL: 'gpt-5.6-sol',
    REFLECTION_PROVIDER: 'openai-compatible',
    SMALL_MODEL: '',
    SMALL_PROVIDER: '',
    TZ: 'UTC',
  };
  for (const key of EXTERNAL_ENV_KEYS) env[key] = '';
  return env;
}

async function runWorker({
  workerFile,
  phase,
  controlDir,
  dataDir,
  mutableInputFile,
}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [workerFile, phase, controlDir, fixtureFile, mutableInputFile],
      {
        cwd: backendRoot,
        env: workerEnvironment(dataDir),
        timeout: WORKER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
    if (stderr.trim()) {
      const error = new Error(`W8 ${phase} worker wrote to stderr`);
      error.code = 'W8_WORKER_STDERR';
      throw error;
    }
    const result = parseJson(stdout.trim(), phase);
    assert.equal(result.phase, phase);
    assert.notEqual(result.status, 'FAILED');
    return result;
  } catch (error) {
    let safe = null;
    if (error?.stdout && String(error.stdout).trim()) {
      safe = parseJson(String(error.stdout).trim(), phase);
    }
    const wrapped = new Error(`W8 worker failed during ${phase}`);
    wrapped.code = safe?.errorCode || error?.code || 'W8_WORKER_FAILED';
    wrapped.phase = phase;
    wrapped.workerLocation = safe?.errorLocation || null;
    wrapped.blockedChannels = Array.isArray(safe?.blockedChannels)
      ? safe.blockedChannels
      : [];
    wrapped.detailCode = typeof safe?.detailCode === 'string'
      ? safe.detailCode
      : null;
    wrapped.failureDigest = safe?.errorDigest
      || digest({ phase, code: wrapped.code, message: String(error?.message || error) });
    throw wrapped;
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function regularFileExists(file) {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile() && !fileStat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function activeLockDirectories(root) {
  const locks = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name.endsWith('.lock')) {
        locks.push(absolute);
      } else {
        await visit(absolute);
      }
    }
  }
  await visit(root);
  return locks;
}

async function crashTargetIsIsolated(file, dataDir, stateFile) {
  const marker = parseJson(await readFile(file, 'utf8'), 'crash marker');
  const state = parseJson(await readFile(stateFile, 'utf8'), 'W8 state');
  const workflowRunId = state.success?.runId;
  for (const [field, value] of [
    ['projectId', marker.projectId],
    ['workflowRunId', workflowRunId],
  ]) {
    if (
      typeof value !== 'string'
      || !/^[A-Za-z0-9_.:-]+$/u.test(value)
    ) {
      const error = new Error(`W8 crash marker ${field} is unsafe`);
      error.code = 'W8_CRASH_MARKER_UNSAFE';
      throw error;
    }
  }
  if (
    state.projects?.success?.id !== marker.projectId
    || !marker.runId.startsWith(`${workflowRunId}:`)
  ) {
    const error = new Error('W8 crash marker does not belong to the prepared run');
    error.code = 'W8_CRASH_MARKER_IDENTITY_MISMATCH';
    throw error;
  }
  const runDigest = crypto.createHash('sha256')
    .update(workflowRunId)
    .digest('hex');
  const runFile = path.join(
    dataDir,
    'projects',
    marker.projectId,
    '.runs',
    `run-${runDigest}.json`,
  );
  if (!(await regularFileExists(runFile))) return false;
  const run = parseJson(await readFile(runFile, 'utf8'), 'crash run record');
  return (
    run.projectId === marker.projectId
    && run.runId === workflowRunId
    && run.nodes?.['compose-report']?.status === 'RUNNING'
  );
}

async function waitForCrashMarker(
  file,
  exitPromise,
  lockRoots,
  dataDir,
  stateFile,
) {
  const startedAt = Date.now();
  let exited = null;
  let quiescentPasses = 0;
  exitPromise.then((result) => {
    exited = result;
  });
  while (Date.now() - startedAt <= WORKER_TIMEOUT_MS) {
    if (await regularFileExists(file)) {
      const lockSets = await Promise.all(
        lockRoots.map((root) => activeLockDirectories(root)),
      );
      if (
        await crashTargetIsIsolated(file, dataDir, stateFile)
        &&
        !(await pathExists(`${file}.lock`))
        && lockSets.every((locks) => locks.length === 0)
      ) {
        quiescentPasses += 1;
        if (quiescentPasses >= 2) return;
      } else {
        quiescentPasses = 0;
      }
    }
    if (exited) {
      const error = new Error('W8 crash worker exited before the durable marker');
      error.code = 'W8_CRASH_MARKER_MISSING';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const error = new Error('W8 crash marker timed out');
  error.code = 'W8_CRASH_MARKER_TIMEOUT';
  throw error;
}

async function runCrashWorker({
  controlDir,
  dataDir,
  mutableInputFile,
  crashAgentId,
}) {
  const markerFile = path.join(controlDir, 'analysis-crash-ready.json');
  const child = spawn(
    process.execPath,
    [
      w8WorkerFile,
      'prepare-analysis-crash',
      controlDir,
      fixtureFile,
      mutableInputFile,
    ],
    {
      cwd: backendRoot,
      env: workerEnvironment(dataDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES);
  });
  const exitPromise = waitForExit(child);
  try {
    await waitForCrashMarker(
      markerFile,
      exitPromise,
      [controlDir, dataDir],
      dataDir,
      path.join(controlDir, 'w8-state.json'),
    );
    const marker = parseJson(await readFile(markerFile, 'utf8'), 'crash marker');
    assert.equal(marker.status, 'paused');
    assert.equal(marker.phase, 'prepare-analysis-crash');
    assert.equal(marker.agentId, crashAgentId);
    assert.equal(child.kill('SIGKILL'), true);
    const exited = await exitPromise;
    assert.equal(exited.code, null);
    assert.equal(exited.signal, 'SIGKILL');
    assert.equal(stderr.trim(), '');
    assert.equal(stdout.trim(), '');
    return {
      status: 'INTERRUPTED',
      signal: exited.signal,
      marker: {
        phase: marker.phase,
        runId: marker.runId,
        projectId: marker.projectId,
        nodeId: marker.nodeId,
        agentId: marker.agentId,
        idempotencyKeyDigest: marker.idempotencyKeyDigest,
        requestDigest: marker.requestDigest,
        markerDigest: marker.markerDigest,
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exitPromise.catch(() => {});
    const wrapped = new Error('W8 intentional crash phase failed');
    wrapped.code = error?.code || 'W8_CRASH_PHASE_FAILED';
    wrapped.phase = 'prepare-analysis-crash';
    const location = /runW8DeterministicAcceptance\.mjs:(\d+):(\d+)/u
      .exec(String(error?.stack || ''));
    wrapped.workerLocation = location
      ? `${location[1]}:${location[2]}`
      : null;
    if (stderr.trim()) {
      wrapped.detailCode = (
        /FILE_LOCK_TIMEOUT/u.test(stderr) && 'FILE_LOCK_TIMEOUT'
      ) || (
        /MaxListenersExceededWarning/u.test(stderr)
        && 'MAX_LISTENERS_WARNING'
      ) || (
        /ExperimentalWarning/u.test(stderr) && 'EXPERIMENTAL_WARNING'
      ) || (
        /DeprecationWarning/u.test(stderr) && 'DEPRECATION_WARNING'
      ) || (
        /\b([A-Z][A-Z0-9_]{2,79})\b/u.exec(stderr)?.[1]
      ) || 'UNCLASSIFIED_STDERR';
    }
    wrapped.failureDigest = digest({
      code: wrapped.code,
      stdoutDigest: digest(stdout),
      stderrDigest: digest(stderr),
    });
    throw wrapped;
  }
}

async function exactCommit() {
  const [{ stdout: revision }, { stdout: dirty }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH || '', LANG: 'C' },
    }),
    execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH || '', LANG: 'C' },
    }),
  ]);
  const commitSha = revision.trim();
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) {
    const error = new Error('W8 could not resolve an exact Git commit');
    error.code = 'W8_COMMIT_UNAVAILABLE';
    throw error;
  }
  if (dirty.trim()) {
    const error = new Error('W8 evidence mode requires a clean non-ignored worktree');
    error.code = 'W8_WORKTREE_DIRTY';
    throw error;
  }
  return commitSha;
}

function mutationFixture(initial) {
  const changed = structuredClone(initial);
  changed.positions[0].theme = 'mutated-after-snapshot-capture';
  changed.mandate.style = 'value';
  changed.mandate.maxHoldings += 1;
  return changed;
}

async function writePrivateJson(file, value, { flag = 'w' } = {}) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag,
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

function assertIdeaComposition(fixture, results) {
  const [interrupted, resumed, replayed] = results;
  assert.equal(interrupted.status, 'RUNNING');
  assert.equal(interrupted.interruptionPoint, fixture.run.stopAfterNodeId);
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.equal(replayed.status, 'SUCCEEDED');
  assert.deepEqual(
    interrupted.identity,
    {
      ...resumed.identity,
      nodeInputDigests: interrupted.identity.nodeInputDigests,
    },
  );
  assert.deepEqual(replayed.identity, resumed.identity);
  assert.deepEqual(resumed.ideas, replayed.ideas);
  assert.equal(resumed.ideas.ideaIds.length, fixture.expectedBaselines.validGeneratedCount);
  assert.equal(resumed.index.exactRebuild, true);
  assert.deepEqual(resumed.index, replayed.index);
  assert.deepEqual(replayed.execution.executedNodeIds, []);
  assert.equal(
    results.every((result) => (
      result.networkGuardActive === true
      && result.blockedNetworkAttemptCount === 0
    )),
    true,
  );
}

function augmentEvidence({
  commitSha,
  ideaResults,
  crash,
  mutationAudit,
  workerEvidence,
}) {
  const [interrupted, resumed, replayed] = ideaResults;
  const evidence = structuredClone(workerEvidence);
  evidence.summary.commitSha = commitSha;
  evidence.summary.ideaGeneration = {
    ...evidence.summary.ideaGeneration,
    workflow: interrupted.workflow,
    runIdentityDigest: replayed.identity.identityDigest,
    snapshotContentDigest: replayed.identity.snapshotContentDigest,
    inputDigests: replayed.identity.snapshotInputDigests,
    validIdeaIds: replayed.ideas.ideaIds,
    validIdeaDigest: replayed.ideas.ideaIdDigest,
    selectedCount: interrupted.ideas.selectedIdeaIds.length,
    unselectedCount: interrupted.ideas.unselectedIdeaIds.length,
    rejectedDigest: interrupted.ideas.rejectedDigest,
    interruption: {
      nodeId: interrupted.interruptionPoint,
      initialExecutedNodeIds: interrupted.execution.executedNodeIds,
      resumeExecutedNodeIds: resumed.execution.executedNodeIds,
      resumeHydratedNodeIds: resumed.execution.hydratedNodeIds,
      replayExecutedNodeIds: replayed.execution.executedNodeIds,
      replayHydratedNodeIds: replayed.execution.hydratedNodeIds,
    },
  };
  evidence.summary.success.crashSignal = crash.signal;
  evidence.summary.success.crashAgentIdentityDigest =
    crash.marker.idempotencyKeyDigest;
  evidence.summary.snapshotMutation = mutationAudit;
  evidence.lineage.ideaGeneration = {
    runId: replayed.identity.runId,
    snapshotId: replayed.identity.snapshotId,
    asOf: replayed.identity.asOf,
    runInputDigest: replayed.identity.runInputDigest,
    snapshotContentDigest: replayed.identity.snapshotContentDigest,
    snapshotConfigDigest: replayed.identity.snapshotConfigDigest,
    snapshotInputDigests: replayed.identity.snapshotInputDigests,
    nodeInputDigests: replayed.identity.nodeInputDigests,
    ideaIds: replayed.ideas.ideaIds,
    ideaLineageDigest: replayed.ideas.lineageDigest,
    eventReplay: {
      count: replayed.events.count,
      exactDigest: replayed.events.digest,
      continuousSequence: replayed.events.continuousSequence,
      exactReplayValidated: true,
    },
  };
  evidence.validation = [
    evidence.validation,
    `Exact code commit: ${commitSha}`,
    `Idea subprocess phases: ${ideaResults.length}`,
    `Analysis crash signal: ${crash.signal}`,
    'Mutable source changed after snapshot and deleted before completed replay: true',
  ].join('\n');
  return evidence;
}

function assertRedactedValue(value, key = '') {
  const forbiddenKey = /(?:api.?key|authorization|base.?url|cookie|credential|endpoint|password|prompt|provider.?payload|raw.?payload|secret)/iu;
  if (forbiddenKey.test(key)) {
    throw new Error(`W8 evidence contains forbidden field: ${key}`);
  }
  if (['token', 'accessToken', 'refreshToken', 'sessionToken'].includes(key)) {
    throw new Error(`W8 evidence contains forbidden token field: ${key}`);
  }
  if (typeof value === 'string') {
    if (
      /^https?:\/\//iu.test(value)
      || /^file:/iu.test(value)
      || path.isAbsolute(value)
      || path.win32.isAbsolute(value)
      || value.includes('\\')
    ) {
      throw new Error(`W8 evidence contains a forbidden path or URL in ${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertRedactedValue(item, key));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      assertRedactedValue(child, childKey);
    }
  }
}

function serializeEvidence(evidence) {
  const serialized = {};
  for (const key of ['summary', 'runRecord', 'lineage', 'statusMatrix']) {
    assertRedactedValue(evidence[key], key);
    const text = `${JSON.stringify(evidence[key], null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_EVIDENCE_BYTES) {
      const error = new Error(`W8 ${EVIDENCE_FILES[key]} exceeds the size limit`);
      error.code = 'W8_EVIDENCE_TOO_LARGE';
      throw error;
    }
    serialized[EVIDENCE_FILES[key]] = text;
  }
  assert.equal(typeof evidence.validation, 'string');
  assertRedactedValue(evidence.validation, 'validation');
  const validation = `${evidence.validation.trim()}\n`;
  if (Buffer.byteLength(validation) > MAX_EVIDENCE_BYTES) {
    const error = new Error('W8 validation.txt exceeds the size limit');
    error.code = 'W8_EVIDENCE_TOO_LARGE';
    throw error;
  }
  serialized[EVIDENCE_FILES.validation] = validation;
  assert.deepEqual(
    Object.keys(serialized).sort(),
    Object.values(EVIDENCE_FILES).sort(),
  );
  return serialized;
}

function requiredCaseOutcomes(statusMatrix) {
  assert.equal(statusMatrix?.schemaVersion, 'workflow-w8-status-matrix.v1');
  const outcomes = statusMatrix.cases.map((entry) => ({
    case: entry.case,
    actual: entry.actual,
  }));
  assert.deepEqual(outcomes, REQUIRED_CASE_OUTCOMES);
  return outcomes;
}

function evidenceAlreadyExistsError() {
  const error = new Error('W8 evidence already exists');
  error.code = 'W8_EVIDENCE_ALREADY_EXISTS';
  return error;
}

async function publishEvidence(serialized, {
  localRoot = path.join(repositoryRoot, 'artifacts', 'local'),
} = {}) {
  const target = path.join(localRoot, 'workflow-w8');
  const publicationLock = path.join(localRoot, '.workflow-w8-publish.lock');
  const staging = path.join(
    localRoot,
    `.workflow-w8-staging-${process.pid}-${crypto.randomUUID()}`,
  );
  await mkdir(localRoot, { recursive: true });
  try {
    await mkdir(publicationLock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw evidenceAlreadyExistsError();
    throw error;
  }
  try {
    if (await pathExists(target)) throw evidenceAlreadyExistsError();
    await mkdir(staging, { mode: 0o700 });
    for (const [name, content] of Object.entries(serialized)) {
      const file = path.join(staging, name);
      await writeFile(file, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(file, 0o600);
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(publicationLock, { recursive: true, force: true });
  }
  return target;
}

async function verifyCreateOnlyPublication(serialized, tempRoot) {
  const localRoot = path.join(tempRoot, 'publication-race');
  const attempts = await Promise.allSettled([
    publishEvidence(serialized, { localRoot }),
    publishEvidence(serialized, { localRoot }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'W8_EVIDENCE_ALREADY_EXISTS');

  const target = fulfilled[0].value;
  assert.deepEqual(await readdir(localRoot), ['workflow-w8']);
  const targetStat = await stat(target);
  assert.equal(targetStat.isDirectory(), true);
  assert.equal(targetStat.mode & 0o777, 0o700);
  assert.deepEqual(
    (await readdir(target)).sort(),
    Object.keys(serialized).sort(),
  );
  for (const [name, expected] of Object.entries(serialized)) {
    const publishedFile = path.join(target, name);
    const publishedStat = await stat(publishedFile);
    assert.equal(publishedStat.isFile(), true);
    assert.equal(publishedStat.mode & 0o777, 0o600);
    assert.equal(await readFile(publishedFile, 'utf8'), expected);
  }
  return true;
}

async function main() {
  if (unknownArguments.length) {
    const error = new Error(`unknown W8 runner argument: ${unknownArguments[0]}`);
    error.code = 'W8_INVALID_ARGUMENT';
    throw error;
  }
  const commitSha = testMode ? 'test-mode' : await exactCommit();
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
  assertDefaultFixtureRoute(fixture);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'finagent-workflow-w8-'));
  const dataDir = path.join(tempRoot, 'data');
  const controlDir = path.join(tempRoot, 'control');
  const mutableInputFile = path.join(controlDir, 'mutable-inputs.json');
  const mutationAuditFile = path.join(controlDir, 'mutable-input-audit.json');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(controlDir, { mode: 0o700 });
  const ideaResults = [];
  try {
    currentStage = 'idea-interrupt-after-review';
    const initialInputs = structuredClone(fixture.w8.mutableInputs);
    assert.deepEqual(initialInputs.positions, fixture.inputs.positions);
    assert.deepEqual(initialInputs.mandate, fixture.inputs.mandate);
    await writePrivateJson(mutableInputFile, initialInputs);
    ideaResults.push(await runWorker({
      workerFile: m1WorkerFile,
      phase: 'interrupt-after-review',
      controlDir,
      dataDir,
      mutableInputFile,
    }));

    const mutatedInputs = mutationFixture(initialInputs);
    assert.notEqual(digest(mutatedInputs), digest(initialInputs));
    await writePrivateJson(mutableInputFile, mutatedInputs);
    currentStage = 'idea-resume-persist';
    ideaResults.push(await runWorker({
      workerFile: m1WorkerFile,
      phase: 'resume-persist',
      controlDir,
      dataDir,
      mutableInputFile,
    }));
    await unlink(mutableInputFile);
    const mutationAudit = {
      initialDigest: digest(initialInputs),
      mutatedDigest: digest(mutatedInputs),
      changedAfterSnapshotCapture: true,
      deletedBeforeCompletedReplay: true,
    };
    await writePrivateJson(mutationAuditFile, mutationAudit);
    currentStage = 'idea-replay-complete';
    ideaResults.push(await runWorker({
      workerFile: m1WorkerFile,
      phase: 'replay-complete',
      controlDir,
      dataDir,
      mutableInputFile,
    }));
    assertIdeaComposition(fixture, ideaResults);

    currentStage = 'prepare-analysis-crash';
    const crash = await runCrashWorker({
      controlDir,
      dataDir,
      mutableInputFile,
      crashAgentId: fixture.w8.crash.agentId,
    });
    const phases = {};
    for (const workerPhase of [
      'resume-success',
      'block-review',
      'resolve-review',
      'replay-rebuild',
    ]) {
      currentStage = workerPhase;
      phases[workerPhase] = await runWorker({
        workerFile: w8WorkerFile,
        phase: workerPhase,
        controlDir,
        dataDir,
        mutableInputFile,
      });
    }
    const final = phases['replay-rebuild'];
    assert.ok(final.evidence);
    const evidence = augmentEvidence({
      commitSha,
      ideaResults,
      crash,
      mutationAudit: readJsonSafe(await readFile(mutationAuditFile, 'utf8')),
      workerEvidence: final.evidence,
    });
    const structuralRecord = structuralAcceptanceRecord(evidence);
    const structuralAcceptanceDigest = digest(structuralRecord);
    evidence.summary.structuralAcceptance = {
      schemaVersion: structuralRecord.schemaVersion,
      digest: structuralAcceptanceDigest,
    };
    evidence.validation = [
      evidence.validation,
      `Structural repeatability digest: ${structuralAcceptanceDigest}`,
      'Generated prose bytes are not compared; run-record/lineage preserve exact run-specific digests while structural acceptance is the repeatability gate.',
    ].join('\n');
    currentStage = 'serialize-evidence';
    const serialized = serializeEvidence(evidence);
    const caseOutcomes = requiredCaseOutcomes(evidence.statusMatrix);
    let createOnlyPublicationVerified = false;
    if (testMode) {
      currentStage = 'verify-create-only-publication';
      createOnlyPublicationVerified = await verifyCreateOnlyPublication(
        serialized,
        tempRoot,
      );
    } else {
      currentStage = 'publish-evidence';
      assert.equal(await exactCommit(), commitSha);
      await publishEvidence(serialized);
      createOnlyPublicationVerified = true;
    }
    return {
      schemaVersion: 'workflow-w8-runner-result.v1',
      status: 'SUCCEEDED',
      mode: testMode ? 'test' : 'evidence',
      commitSha,
      fixtureId: fixture.fixtureId,
      fixtureDigest: digest(fixture),
      ideaRunId: fixture.run.runId,
      snapshotId: evidence.summary.ideaGeneration.snapshotId,
      successProjectStatus: evidence.summary.success.projectStatus,
      reviewBlockedStatus: evidence.summary.review.blockedStatus,
      reviewFinalStatus: evidence.summary.review.finalStatus,
      caseCount: caseOutcomes.length,
      caseOutcomes,
      evidenceFiles: Object.values(EVIDENCE_FILES),
      evidenceFileDigests: Object.fromEntries(
        Object.entries(serialized).map(([name, content]) => [
          name,
          digest(content),
        ]),
      ),
      structuralAcceptanceDigest,
      evidenceDigest: digest(serialized),
      repeatabilityPolicy: {
        schemaVersion: 'workflow-w8-repeatability-policy.v1',
        byteStableFiles: BYTE_STABLE_EVIDENCE_FILES,
        exactRunIntegrityFiles: EXACT_RUN_INTEGRITY_FILES,
        generatedProseBytesCompared: false,
      },
      networkGuardActive: true,
      blockedNetworkAttemptCount: 0,
      createOnlyPublicationVerified,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function readJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('W8 control record is invalid');
    error.code = 'W8_CONTROL_RECORD_INVALID';
    throw error;
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'workflow-w8-runner-failure.v1',
    status: 'FAILED',
    mode: testMode ? 'test' : 'evidence',
    errorCode: typeof error?.code === 'string' ? error.code : 'W8_RUNNER_FAILED',
    phase: typeof error?.phase === 'string' ? error.phase : currentStage,
    workerLocation: typeof error?.workerLocation === 'string'
      ? error.workerLocation
      : null,
    blockedChannels: Array.isArray(error?.blockedChannels)
      ? error.blockedChannels
      : [],
    detailCode: typeof error?.detailCode === 'string'
      ? error.detailCode
      : null,
    errorDigest: error?.failureDigest
      || digest(String(error?.message || error || 'unknown')),
  })}\n`);
  process.exitCode = 1;
}
