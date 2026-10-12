import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = path.dirname(backendRoot);
const workerFile = fileURLToPath(
  new URL('./support/m1W3W5Worker.mjs', import.meta.url),
);
const fixtureFile = fileURLToPath(new URL(
  '../test/fixtures/m1-w3-w5/v1/scenario.json',
  import.meta.url,
));
const PHASES = Object.freeze([
  'interrupt-after-review',
  'resume-persist',
  'replay-complete',
]);
const NODE_IDS = Object.freeze([
  'collect-market-context',
  'build-diversification-constraints',
  'generate-candidates',
  'verify-candidates',
  'review-quality',
  'persist-ideas',
]);
const WORKER_TIMEOUT_MS = 120_000;
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

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${label} did not return JSON`);
    error.code = 'M1_INVALID_WORKER_OUTPUT';
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

async function runWorker({ phase, dataDir, controlDir }) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [workerFile, phase, controlDir],
      {
        cwd: backendRoot,
        env: workerEnvironment(dataDir),
        timeout: WORKER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (stderr.trim()) {
      const error = new Error(`M1 ${phase} worker wrote to stderr`);
      error.code = 'M1_WORKER_STDERR';
      throw error;
    }
    const result = parseJson(stdout.trim(), phase);
    assert.equal(result.phase, phase);
    assert.notEqual(result.status, 'FAILED');
    return result;
  } catch (error) {
    const safe = error?.stdout
      ? parseJson(String(error.stdout).trim(), phase)
      : null;
    const wrapped = new Error(`M1 worker failed during ${phase}`);
    wrapped.code = safe?.errorCode || error?.code || 'M1_WORKER_FAILED';
    wrapped.failureDigest = safe?.errorDigest || digest(String(error?.message || error));
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
    throw new Error('M1 could not resolve an exact Git commit');
  }
  if (dirty.trim()) {
    const error = new Error('M1 requires a clean non-ignored worktree');
    error.code = 'M1_WORKTREE_DIRTY';
    throw error;
  }
  return commitSha;
}

function gateDirectory(commitSha) {
  return path.join(
    repositoryRoot,
    'artifacts',
    'local',
    `m1-w3-w5-${commitSha.slice(0, 12)}`,
  );
}

async function claimM1(commitSha) {
  const directory = gateDirectory(commitSha);
  const file = path.join(directory, 'claim.json');
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify({
      schemaVersion: 'm1-w3-w5-claim.v1',
      status: 'CLAIMED',
      commitSha,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const claimed = new Error('M1 was already claimed for this exact commit');
      claimed.code = 'M1_ALREADY_CLAIMED';
      throw claimed;
    }
    throw error;
  }
}

function coreIdentity(identity) {
  return {
    runId: identity.runId,
    snapshotId: identity.snapshotId,
    asOf: identity.asOf,
    runInputDigest: identity.runInputDigest,
    snapshotContentDigest: identity.snapshotContentDigest,
    snapshotConfigDigest: identity.snapshotConfigDigest,
    snapshotInputDigests: identity.snapshotInputDigests,
    identityDigest: identity.identityDigest,
  };
}

function assertComposition(fixture, results) {
  const [interrupted, resumed, replayed] = results;
  assert.equal(new Set(results.map((result) => result.processId)).size, 3);
  for (const result of results) {
    assert.equal(result.fixtureId, fixture.fixtureId);
    assert.equal(result.fixtureDigest, interrupted.fixtureDigest);
    assert.equal(result.networkGuardActive, true);
    assert.equal(result.blockedNetworkAttemptCount, 0);
    assert.deepEqual(result.workflow, interrupted.workflow);
  }
  assert.deepEqual(interrupted.workflow, {
    id: fixture.expectedBaselines.ideaGenerationWorkflowId,
    version: fixture.expectedBaselines.ideaGenerationWorkflowVersion,
    hash: fixture.expectedBaselines.ideaGenerationWorkflowHash,
  });
  assert.equal(interrupted.status, 'RUNNING');
  assert.equal(interrupted.interruptionPoint, fixture.run.stopAfterNodeId);
  assert.deepEqual(interrupted.execution.executedNodeIds, NODE_IDS.slice(0, 5));
  assert.deepEqual(interrupted.execution.hydratedNodeIds, []);
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.deepEqual(resumed.execution.executedNodeIds, ['persist-ideas']);
  assert.deepEqual(resumed.execution.hydratedNodeIds, NODE_IDS.slice(0, 5));
  assert.equal(replayed.status, 'SUCCEEDED');
  assert.deepEqual(replayed.execution.executedNodeIds, []);
  assert.deepEqual(replayed.execution.hydratedNodeIds, NODE_IDS);

  assert.deepEqual(coreIdentity(resumed.identity), coreIdentity(interrupted.identity));
  assert.deepEqual(coreIdentity(replayed.identity), coreIdentity(interrupted.identity));
  for (const nodeId of NODE_IDS.slice(0, 5)) {
    assert.equal(
      interrupted.identity.nodeInputDigests[nodeId],
      resumed.identity.nodeInputDigests[nodeId],
    );
  }
  assert.deepEqual(
    replayed.identity.nodeInputDigests,
    resumed.identity.nodeInputDigests,
  );

  assert.deepEqual(resumed.ideas.ideaIds, interrupted.ideas.expectedIdeaIds);
  assert.deepEqual(replayed.ideas.ideaIds, interrupted.ideas.expectedIdeaIds);
  assert.equal(
    resumed.ideas.ideaIds.length,
    fixture.expectedBaselines.validGeneratedCount,
  );
  assert.equal(resumed.ideas.ideaIdDigest, replayed.ideas.ideaIdDigest);
  assert.equal(resumed.ideas.lineageDigest, replayed.ideas.lineageDigest);
  assert.equal(resumed.index.exactRebuild, true);
  assert.equal(resumed.index.beforeDeleteDigest, resumed.index.rebuiltDigest);
  assert.deepEqual(resumed.index, replayed.index);
  assert.deepEqual(interrupted.project, resumed.project);
  assert.deepEqual(resumed.project, replayed.project);

  for (const result of results) {
    assert.equal(
      result.audit.auditDigest,
      interrupted.audit.auditDigest,
    );
    assert.equal(result.audit.sourceCallCount, 5);
    assert.equal(result.audit.logicalAgentCallCount, 2);
    assert.equal(result.audit.physicalAgentCallCount, 2);
  }
  assert.equal(
    interrupted.agents.identityDigest,
    interrupted.audit.logicalAgentIdentityDigest,
  );
  assert.equal(interrupted.agents.leastPrivilege, true);
  assert.equal(interrupted.agents.semanticRequestsValidated, true);
  assert.equal(interrupted.project.privateReadDenied, true);
  assert.equal(interrupted.project.privateWriteDenied, true);
  assert.equal(
    replayed.repository.agentCount,
    fixture.expectedBaselines.agentCount,
  );
  assert.equal(
    replayed.repository.toolCount,
    fixture.expectedBaselines.toolCount,
  );
  assert.equal(
    replayed.repository.runAnalysisWorkflowHash,
    fixture.expectedBaselines.runAnalysisWorkflowHash,
  );
}

function buildSummary({ commitSha, fixture, results }) {
  const [interrupted, resumed, replayed] = results;
  return {
    schemaVersion: 'm1-w3-w5-summary.v1',
    status: 'SUCCEEDED',
    commitSha,
    fixture: {
      id: fixture.fixtureId,
      digest: interrupted.fixtureDigest,
    },
    workflow: {
      ...interrupted.workflow,
      runAnalysisHash: replayed.repository.runAnalysisWorkflowHash,
    },
    identity: {
      runId: interrupted.identity.runId,
      runIdentityDigest: interrupted.identity.identityDigest,
      snapshotId: interrupted.identity.snapshotId,
      snapshotContentDigest: interrupted.identity.snapshotContentDigest,
      snapshotConfigDigest: interrupted.identity.snapshotConfigDigest,
      asOf: interrupted.identity.asOf,
      runInputDigest: interrupted.identity.runInputDigest,
      snapshotInputDigests: interrupted.identity.snapshotInputDigests,
      nodeInputDigests: replayed.identity.nodeInputDigests,
      agentIdentityDigest: interrupted.agents.identityDigest,
      generatorIdentityDigest: interrupted.agents.generatorIdentityDigest,
      reviewerIdentityDigest: interrupted.agents.reviewerIdentityDigest,
      leastPrivilege: interrupted.agents.leastPrivilege,
      semanticRequestsValidated: interrupted.agents.semanticRequestsValidated,
    },
    interruption: {
      nodeId: interrupted.interruptionPoint,
      initialExecutedNodeIds: interrupted.execution.executedNodeIds,
      initialHydratedNodeIds: interrupted.execution.hydratedNodeIds,
      resumeExecutedNodeIds: resumed.execution.executedNodeIds,
      resumeHydratedNodeIds: resumed.execution.hydratedNodeIds,
      replayExecutedNodeIds: replayed.execution.executedNodeIds,
      replayHydratedNodeIds: replayed.execution.hydratedNodeIds,
      distinctProcessCount: 3,
    },
    ideas: {
      validCount: resumed.ideas.ideaIds.length,
      ids: resumed.ideas.ideaIds,
      idDigest: resumed.ideas.ideaIdDigest,
      lineageDigest: resumed.ideas.lineageDigest,
      selectedCount: interrupted.ideas.selectedIdeaIds.length,
      selectedIdDigest: digest(interrupted.ideas.selectedIdeaIds),
      unselectedCount: interrupted.ideas.unselectedIdeaIds.length,
      unselectedIdDigest: digest(interrupted.ideas.unselectedIdeaIds),
      rejectedDigest: interrupted.ideas.rejectedDigest,
      allValidPersisted: true,
      lowRankPersisted: true,
      unselectedValidPersisted: true,
      sourceOnlyMaterialNotPublished: true,
    },
    index: {
      entryCount: resumed.index.entryCount,
      ideaEntryCount: resumed.index.ideaEntryCount,
      projectEntryCount: resumed.index.projectEntryCount,
      indexDigest: resumed.index.indexDigest,
      projectionDigest: resumed.index.rebuiltDigest,
      projectEntryDigest: resumed.index.projectEntryDigest,
      exactDeleteRebuild: resumed.index.exactRebuild,
    },
    replay: {
      sourceCallCount: replayed.audit.sourceCallCount,
      sourceCallDigest: replayed.audit.sourceCallDigest,
      logicalAgentCallCount: replayed.audit.logicalAgentCallCount,
      logicalAgentIdentityDigest: replayed.audit.logicalAgentIdentityDigest,
      physicalAgentCallCount: replayed.audit.physicalAgentCallCount,
      physicalAgentIdentityDigest: replayed.audit.physicalAgentIdentityDigest,
      repeatedSuccessfulNodeCount: 0,
      repeatedSourceCallCount: 0,
      repeatedLogicalAgentCallCount: 0,
      repeatedPhysicalAgentCallCount: 0,
    },
    isolation: {
      projectTreeDigest: replayed.project.treeDigest,
      projectEntryDigest: replayed.project.entryDigest,
      projectPrivateWorkspaceUnchanged: true,
      projectPrivateWorkspaceAbsentFromIdeaRun: true,
      projectPrivateReadDenied: replayed.project.privateReadDenied,
      projectPrivateWriteDenied: replayed.project.privateWriteDenied,
      networkGuardActiveInAllProcesses: true,
      blockedNetworkAttemptCount: results.reduce(
        (sum, result) => sum + result.blockedNetworkAttemptCount,
        0,
      ),
    },
    events: replayed.events,
    repository: replayed.repository,
    finalStatus: replayed.status,
  };
}

function buildFailureSummary({ commitSha, fixture, results, error }) {
  return {
    schemaVersion: 'm1-w3-w5-summary.v1',
    status: 'FAILED',
    commitSha,
    fixture: {
      id: fixture.fixtureId,
      digest: digest(fixture),
    },
    completedPhases: results.map((result) => result.phase),
    completedPhaseDigests: results.map((result) => digest(result)),
    oneShotClaimed: true,
    failure: {
      code: typeof error?.code === 'string' ? error.code : 'M1_FAILED',
      digest: error?.failureDigest || digest(String(error?.message || error)),
    },
    finalStatus: 'FAILED',
  };
}

function assertRedactedSummary(summary, fixture) {
  const forbiddenKey = /(?:api.?key|authorization|base.?url|cookie|credential|endpoint|password|prompt|raw|secret|token)/iu;
  const visit = (value, key = '') => {
    if (forbiddenKey.test(key)) {
      throw new Error(`M1 summary contains forbidden field: ${key}`);
    }
    if (typeof value === 'string') {
      if (
        /^https?:\/\//iu.test(value)
        || /^file:/iu.test(value)
        || path.isAbsolute(value)
        || path.win32.isAbsolute(value)
        || value.includes('\\')
      ) {
        throw new Error('M1 summary contains an absolute path or endpoint');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(summary);
  const text = JSON.stringify(summary);
  const fixtureContent = [
    fixture.project.privateSentinel,
    fixture.project.title,
    fixture.market.headlines[0],
    ...fixture.expectedBaselines.validGeneratedTitles,
    fixture.expectedBaselines.sourceOnlyTitle,
  ];
  for (const content of fixtureContent) {
    assert.equal(text.includes(content), false);
  }
  assert.ok(text.length < 32 * 1024);
}

async function writeSummary(commitSha, summary) {
  const relativeDirectory = path.posix.join(
    'artifacts',
    'local',
    `m1-w3-w5-${commitSha.slice(0, 12)}`,
  );
  const relative = path.posix.join(relativeDirectory, 'summary.json');
  const file = path.join(gateDirectory(commitSha), 'summary.json');
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return relative;
}

async function main() {
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
  assertDefaultFixtureRoute(fixture);
  const commitSha = await exactCommit();
  await claimM1(commitSha);
  let temporaryRoot = null;
  const results = [];
  try {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'finagent-m1-w3-w5-'),
    );
    const dataDir = path.join(temporaryRoot, 'data');
    const controlDir = path.join(temporaryRoot, 'control');
    await Promise.all([
      mkdir(dataDir),
      mkdir(controlDir),
    ]);
    for (const currentPhase of PHASES) {
      results.push(await runWorker({
        phase: currentPhase,
        dataDir,
        controlDir,
      }));
    }
    const postflightCommitSha = await exactCommit();
    if (postflightCommitSha !== commitSha) {
      const error = new Error('M1 Git commit changed during execution');
      error.code = 'M1_COMMIT_CHANGED';
      throw error;
    }
    assertComposition(fixture, results);
    const summary = buildSummary({ commitSha, fixture, results });
    assertRedactedSummary(summary, fixture);
    const relativeSummary = await writeSummary(commitSha, summary);
    process.stdout.write(`${JSON.stringify({
      status: summary.status,
      summary: relativeSummary,
    })}\n`);
  } catch (error) {
    const summary = buildFailureSummary({
      commitSha,
      fixture,
      results,
      error,
    });
    assertRedactedSummary(summary, fixture);
    error.failureSummary = await writeSummary(commitSha, summary);
    throw error;
  } finally {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'FAILED',
    errorCode: typeof error?.code === 'string' ? error.code : 'M1_FAILED',
    errorDigest: error?.failureDigest || digest(String(error?.message || error)),
    ...(typeof error?.failureSummary === 'string'
      ? { summary: error.failureSummary }
      : {}),
  })}\n`);
  process.exitCode = 1;
}
