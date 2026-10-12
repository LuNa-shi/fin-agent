import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDenyAllNetworkGuard } from './denyAllNetwork.mjs';

const PHASES = new Set(['interrupt-after-review', 'resume-persist', 'replay-complete']);
const phase = process.argv[2];
const controlDir = process.argv[3] ? path.resolve(process.argv[3]) : '';
const fixtureFileArgument = process.argv[4] || '';
const mutableInputFileArgument = process.argv[5] || '';
const fixturesRoot = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const defaultFixtureFile = fileURLToPath(new URL(
  '../../test/fixtures/m1-w3-w5/v1/scenario.json',
  import.meta.url,
));
const SENSITIVE_ENV_KEYS = Object.freeze([
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
const NODE_IDS = Object.freeze([
  'collect-market-context',
  'build-diversification-constraints',
  'generate-candidates',
  'verify-candidates',
  'review-quality',
  'persist-ideas',
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function localDigest(value) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(canonicalValue(value ?? null));
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(
    relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative),
  );
}

function resolveFixtureFile() {
  if (!fixtureFileArgument) return defaultFixtureFile;
  if (
    !path.isAbsolute(fixtureFileArgument)
    || path.normalize(fixtureFileArgument) !== fixtureFileArgument
  ) {
    throw new TypeError('M1 worker fixture path must be normalized and absolute');
  }
  const fixtureRoot = fs.realpathSync(fixturesRoot);
  const candidate = fs.realpathSync(fixtureFileArgument);
  if (!pathIsWithin(fixtureRoot, candidate)) {
    throw new TypeError('M1 worker fixture path must stay inside test fixtures');
  }
  let current = fixtureRoot;
  for (const segment of path.relative(fixtureRoot, fixtureFileArgument).split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new TypeError('M1 worker fixture path must not contain symlinks');
    }
  }
  if (!fs.lstatSync(candidate).isFile()) {
    throw new TypeError('M1 worker fixture path must be a regular file');
  }
  return candidate;
}

function resolveMutableInputFile() {
  if (!mutableInputFileArgument) return '';
  if (
    !path.isAbsolute(mutableInputFileArgument)
    || path.normalize(mutableInputFileArgument) !== mutableInputFileArgument
    || path.dirname(mutableInputFileArgument) !== controlDir
  ) {
    throw new TypeError(
      'M1 worker mutable input path must be an absolute direct child of control',
    );
  }
  const controlStat = fs.lstatSync(controlDir);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
    throw new TypeError('M1 worker control directory must be a real directory');
  }
  if (fs.existsSync(mutableInputFileArgument)) {
    const inputStat = fs.lstatSync(mutableInputFileArgument);
    if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
      throw new TypeError('M1 worker mutable input must be a regular file');
    }
    const controlRoot = fs.realpathSync(controlDir);
    const candidate = fs.realpathSync(mutableInputFileArgument);
    if (!pathIsWithin(controlRoot, candidate)) {
      throw new TypeError('M1 worker mutable input escaped the control directory');
    }
  }
  return mutableInputFileArgument;
}

function readMutableInputs(file) {
  const inputs = readJson(file);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('M1 worker mutable inputs must be an object');
  }
  const keys = Object.keys(inputs).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'mandate'
    || keys[1] !== 'positions'
    || !Array.isArray(inputs.positions)
    || !inputs.mandate
    || typeof inputs.mandate !== 'object'
    || Array.isArray(inputs.mandate)
  ) {
    throw new TypeError(
      'M1 worker mutable inputs must contain only positions and mandate',
    );
  }
  return inputs;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function assertWorkerBoundary() {
  if (!PHASES.has(phase)) {
    throw new TypeError('M1 worker phase is invalid');
  }
  if (!controlDir || !path.isAbsolute(controlDir)) {
    throw new TypeError('M1 worker control directory is required');
  }
  if (process.argv.length > 6) {
    throw new TypeError('M1 worker received unexpected arguments');
  }
  const dataDir = process.env.FIN_DATA_DIR
    ? path.resolve(process.env.FIN_DATA_DIR)
    : '';
  if (
    !dataDir
    || path.basename(controlDir) !== 'control'
    || path.basename(dataDir) !== 'data'
    || path.dirname(controlDir) !== path.dirname(dataDir)
  ) {
    throw new TypeError('M1 worker data/control roots must be isolated siblings');
  }
  return dataDir;
}

function clearExternalConfiguration() {
  for (const key of Object.keys(process.env)) {
    if (/(?:api.?key|authorization|credential|password|secret|token|proxy|base.?url|endpoint)/iu.test(key)) {
      process.env[key] = '';
    }
  }
  for (const key of SENSITIVE_ENV_KEYS) process.env[key] = '';
  Object.assign(process.env, {
    AUTO_RESUME: 'false',
    DEFAULT_PROVIDER: 'openai-compatible',
    DEMO_MODE: 'false',
    MAIN_MODEL: '',
    MAIN_PROVIDER: '',
    OPENAI_COMPATIBLE_MODEL: 'gpt-5.6-sol',
    OPENAI_COMPATIBLE_REASONING_LEVEL: 'high',
    REFLECTION_MODEL: 'gpt-5.6-sol',
    REFLECTION_PROVIDER: 'openai-compatible',
    SMALL_MODEL: '',
    SMALL_PROVIDER: '',
  });
}

function clone(value) {
  return structuredClone(value);
}

function sorted(values) {
  return [...values].sort();
}

function entriesByTypeAndId(entries) {
  return [...entries].sort((left, right) => (
    left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
  ));
}

function recursiveFiles(root) {
  if (!fs.existsSync(root)) return { directories: [], files: [] };
  const directories = [];
  const files = [];
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`M1 boundary encountered a symlink: ${child}`);
      }
      if (stat.isDirectory()) {
        directories.push(child);
        visit(absolute, child);
      } else if (stat.isFile()) {
        files.push({
          relative: child,
          digest: localDigest(fs.readFileSync(absolute)),
        });
      }
    }
  };
  visit(root);
  return { directories, files };
}

function treeDigest(root) {
  return localDigest(recursiveFiles(root));
}

function assertTextAbsent(root, values) {
  if (!fs.existsSync(root)) return;
  const needles = values.filter((value) => typeof value === 'string' && value);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error('M1 isolation scan encountered a symlink');
      }
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(absolute, 'utf8');
      for (const needle of needles) {
        assert.equal(
          content.includes(needle),
          false,
          'Idea Generation material contains Project-private identity or content',
        );
      }
    }
  };
  visit(root);
}

function auditFile() {
  return path.join(controlDir, 'call-audit.json');
}

function stateFile() {
  return path.join(controlDir, 'scenario-state.json');
}

function emptyAudit(fixture) {
  return {
    schemaVersion: 'm1-w3-w5-call-audit.v1',
    fixtureId: fixture.fixtureId,
    sourceCalls: [],
    logicalAgentCalls: [],
    physicalAgentCalls: [],
  };
}

function readAudit(fixture) {
  return fs.existsSync(auditFile()) ? readJson(auditFile()) : emptyAudit(fixture);
}

function appendAudit(fixture, field, value) {
  const audit = readAudit(fixture);
  audit[field].push(value);
  writeJson(auditFile(), audit);
  return audit;
}

function compactAudit(audit, canonicalSha256) {
  return {
    sourceCallCount: audit.sourceCalls.length,
    logicalAgentCallCount: audit.logicalAgentCalls.length,
    physicalAgentCallCount: audit.physicalAgentCalls.length,
    sourceCallDigest: canonicalSha256(audit.sourceCalls),
    logicalAgentIdentityDigest: canonicalSha256(audit.logicalAgentCalls),
    physicalAgentIdentityDigest: canonicalSha256(audit.physicalAgentCalls),
    auditDigest: canonicalSha256(audit),
  };
}

function assertExpectedAudit(audit) {
  assert.deepEqual(
    audit.sourceCalls.map((call) => call.kind),
    [
      'capture-mandate',
      'capture-portfolio',
      'collect-market-context',
      'discover-source-candidates',
      'verify-candidate-tickers',
    ],
  );
  assert.deepEqual(
    audit.logicalAgentCalls.map((call) => call.agentId),
    ['idea-generator', 'idea-quality-reviewer'],
  );
  assert.deepEqual(
    audit.physicalAgentCalls.map((call) => call.agentId),
    ['idea-generator', 'idea-quality-reviewer'],
  );
}

function runtimeServices({
  fixture,
  mutableInputFile,
  canonicalSha256,
  ideaStore,
  runStorage,
  snapshotStore,
  globalContentIndex,
  productionSourceDiscovery,
}) {
  const assertInitialPhase = (kind) => {
    if (phase !== 'interrupt-after-review') {
      appendAudit(fixture, 'sourceCalls', {
        kind,
        unexpected: true,
      });
      throw new Error(`M1 successful source/input work repeated during ${phase}`);
    }
  };
  const sourceCall = (kind, input) => {
    assertInitialPhase(kind);
    appendAudit(fixture, 'sourceCalls', {
      kind,
      inputDigest: canonicalSha256(input),
    });
  };
  return {
    runId: fixture.run.runId,
    asOf: fixture.run.asOf,
    snapshotStore,
    runStorage,
    ideaStore,
    globalContentIndex,
    runtimeSettings: clone(fixture.inputs.settings),
    sourceNow: () => fixture.run.asOf,
    getPortfolio() {
      sourceCall('capture-portfolio', { fixtureId: fixture.fixtureId });
      const inputs = mutableInputFile
        ? readMutableInputs(mutableInputFile)
        : fixture.inputs;
      return clone(inputs.positions);
    },
    getMandate() {
      sourceCall('capture-mandate', { fixtureId: fixture.fixtureId });
      const inputs = mutableInputFile
        ? readMutableInputs(mutableInputFile)
        : fixture.inputs;
      return clone(inputs.mandate);
    },
    async gatherMarketContext(options) {
      sourceCall('collect-market-context', {
        captureProvenance: options?.captureProvenance === true,
      });
      return clone(fixture.market);
    },
    async runSourceDiscoveryNodes(options) {
      sourceCall('discover-source-candidates', {
        tickers: options?.tickers || [],
        portfolio: options?.portfolio || [],
        targetPerNode: options?.targetPerNode || null,
        captureProvenance: options?.captureProvenance === true,
      });
      assert.deepEqual(options.portfolio, fixture.inputs.positions);
      const result = await productionSourceDiscovery({
        ...options,
        sourceFunctions: {
          getSectorPerformance: async () => ({ sectors: [] }),
          getMarketMovers: async () => ({ movers: [] }),
          getNews: async () => [],
          socialSentiment: async () => null,
          xSearch: async () => ({ items: [] }),
          saLatest: async () => ({ items: [] }),
          researchDigest: async () => ({ items: [] }),
        },
      });
      assert.deepEqual(
        result.runs.map((run) => run.agent),
        [
          'news-idea-agent',
          'forum-idea-agent',
          'portfolio-idea-agent',
          'research-idea-agent',
        ],
      );
      assert.deepEqual(
        result.ideas.map((idea) => idea.title),
        [fixture.expectedBaselines.sourceOnlyTitle],
      );
      return result;
    },
    async verifyCandidateTickers(tickers) {
      sourceCall('verify-candidate-tickers', {
        tickers: sorted(new Set(tickers)),
      });
      return new Set(fixture.tickerVerification.valid);
    },
  };
}

function createInjectedBackend({
  fixture,
  canonicalSha256,
  createAgentRunResult,
  IdempotentAgentBackend,
  AgentResultIdempotencyStore,
  snapshotStore,
}) {
  const assertRequestBoundary = (request, runtimeOptions) => {
    const contract = runtimeOptions.contractOverride;
    const snapshot = snapshotStore.load(fixture.run.runId);
    const expectedNode = request.agentContractId === 'idea-generator'
      ? 'generate-candidates'
      : 'review-quality';
    const effectiveConfig = snapshot?.effectiveConfig?.agents?.find(
      (agent) => agent.agentId === request.agentContractId,
    );
    assert.equal(runtimeOptions.workspaceMode, 'idea-run');
    assert.equal(runtimeOptions.demo, false);
    assert.equal(runtimeOptions.artifactCommitOwner, 'workflow');
    assert.equal(runtimeOptions.workflowAttempt, 1);
    assert.equal(runtimeOptions.provider, 'openai-compatible');
    assert.equal(runtimeOptions.model, 'gpt-5.6-sol');
    assert.equal(snapshot.inputs.settings.OPENAI_COMPATIBLE_MODEL, 'gpt-5.6-sol');
    assert.equal(snapshot.inputs.settings.OPENAI_COMPATIBLE_REASONING_LEVEL, 'high');
    assert.equal(snapshot.inputs.settings.REFLECTION_PROVIDER, 'openai-compatible');
    assert.equal(snapshot.inputs.settings.REFLECTION_MODEL, 'gpt-5.6-sol');
    assert.ok(contract);
    assert.equal(contract.id, request.agentContractId);
    assert.deepEqual(contract.contextPolicy?.mounts, []);
    assert.deepEqual(contract.toolPolicy?.allow, []);
    assert.deepEqual(contract.toolPolicy?.writeScopes, []);
    assert.deepEqual(request.inputArtifactRefs, []);
    assert.ok(snapshot);
    assert.ok(effectiveConfig);
    assert.equal(
      request.workflowId,
      fixture.expectedBaselines.ideaGenerationWorkflowId,
    );
    assert.equal(request.nodeId, expectedNode);
    assert.equal(request.projectId, fixture.expectedBaselines.ideaScopeId);
    assert.equal(request.runId, request.idempotencyKey);
    assert.ok(request.runId.startsWith(`${fixture.run.runId}:${expectedNode}:`));
    assert.equal(request.workspaceSnapshotId, snapshot.snapshotId);
    assert.equal(request.asOf, fixture.run.asOf);
    assert.equal(request.effectiveConfigDigest, effectiveConfig.digest);

    if (request.agentContractId === 'idea-generator') {
      assert.equal(runtimeOptions.kind, 'idea');
      assert.equal(runtimeOptions.count, fixture.expectedBaselines.generatorPoolTarget);
      assert.equal(runtimeOptions.temperature, 0.9);
      assert.equal(
        request.input.poolTarget,
        fixture.expectedBaselines.generatorPoolTarget,
      );
      assert.deepEqual(request.input.market, fixture.market);
      assert.deepEqual(request.input.heldThemes, fixture.expectedBaselines.heldThemes);
      assert.deepEqual(request.input.heavyThemes, fixture.expectedBaselines.heavyThemes);
      assert.deepEqual(request.input.existingTitles, []);
      assert.deepEqual(
        request.input.sourceCandidates.map((candidate) => candidate.title),
        [fixture.expectedBaselines.sourceOnlyTitle],
      );
    } else {
      assert.equal(request.agentContractId, 'idea-quality-reviewer');
      assert.equal(runtimeOptions.kind, 'idea-screen');
      assert.equal(runtimeOptions.temperature, 0.3);
      assert.equal(request.input.count, fixture.run.requestedCount);
      assert.deepEqual(
        request.input.pool.map((candidate) => candidate.title),
        fixture.expectedBaselines.validGeneratedTitles,
      );
      assert.equal(
        request.input.pool.some(
          (candidate) => candidate.title === fixture.expectedBaselines.sourceOnlyTitle,
        ),
        false,
      );
    }
    return {
      leastPrivilege: true,
      semanticRequestValidated: true,
    };
  };
  const compactCall = (request, runtimeOptions) => {
    const boundary = assertRequestBoundary(request, runtimeOptions);
    return {
      agentId: request.agentContractId,
      workflowId: request.workflowId,
      nodeId: request.nodeId,
      runIdentityDigest: canonicalSha256(request.runId),
      idempotencyIdentityDigest: canonicalSha256(request.idempotencyKey),
      requestInputDigest: canonicalSha256(request.input),
      effectiveConfigDigest: request.effectiveConfigDigest,
      snapshotId: request.workspaceSnapshotId,
      asOf: request.asOf,
      workspaceMode: runtimeOptions.workspaceMode,
      workflowAttempt: runtimeOptions.workflowAttempt,
      ...boundary,
    };
  };
  const physical = {
    async run(request, runtimeOptions = {}) {
      appendAudit(
        fixture,
        'physicalAgentCalls',
        compactCall(request, runtimeOptions),
      );
      let output;
      if (request.agentContractId === 'idea-generator') {
        output = clone(fixture.generator);
      } else if (request.agentContractId === 'idea-quality-reviewer') {
        output = clone(fixture.reviewer);
      } else {
        throw new Error(`unexpected M1 Agent contract: ${request.agentContractId}`);
      }
      return createAgentRunResult({
        status: 'succeeded',
        output,
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: {
          turns: 1,
          toolCalls: 0,
          tokens: 0,
          costKnown: true,
          costUsd: 0,
        },
        stopReason: 'final',
        traceRef: request.runId,
        valid: true,
        provider: 'deterministic-m1',
        model: 'fixture-v1',
        live: false,
      });
    },
  };
  const idempotent = new IdempotentAgentBackend({
    backend: physical,
    store: new AgentResultIdempotencyStore({
      rootDir: path.join(controlDir, 'agent-idempotency'),
    }),
  });
  return {
    async run(request, runtimeOptions = {}) {
      const call = compactCall(request, runtimeOptions);
      appendAudit(fixture, 'logicalAgentCalls', call);
      if (phase !== 'interrupt-after-review') {
        throw new Error(`M1 successful Agent work repeated during ${phase}`);
      }
      return idempotent.run(request, runtimeOptions);
    },
    async cancel() {
      return false;
    },
  };
}

function nodeInputDigests(result) {
  return Object.fromEntries(NODE_IDS
    .filter((nodeId) => result.nodeExecutions[nodeId]?.inputDigest)
    .map((nodeId) => [
      nodeId,
      result.nodeExecutions[nodeId].inputDigest,
    ]));
}

function durableIdentity({
  fixture,
  result,
  runStorage,
  snapshotStore,
  canonicalSha256,
}) {
  const snapshot = snapshotStore.load(fixture.run.runId);
  const record = runStorage.services(fixture.run.runId).runStore.load(
    fixture.run.runId,
  );
  assert.equal(result.runId, fixture.run.runId);
  assert.equal(result.snapshotId, snapshot.snapshotId);
  assert.equal(result.asOf, fixture.run.asOf);
  assert.equal(record.runId, fixture.run.runId);
  assert.equal(record.workspaceSnapshotId, snapshot.snapshotId);
  assert.equal(record.asOf, fixture.run.asOf);
  assert.equal(snapshot.inputs.settings.DEMO_MODE, false);
  assert.deepEqual(snapshot.inputs.positions, fixture.inputs.positions);
  assert.deepEqual(snapshot.inputs.mandate, fixture.inputs.mandate);
  return {
    runId: result.runId,
    snapshotId: result.snapshotId,
    asOf: result.asOf,
    runInputDigest: record.inputDigest,
    snapshotContentDigest: snapshot.contentDigest,
    snapshotConfigDigest: snapshot.configDigest,
    snapshotInputDigests: snapshot.inputDigests,
    nodeInputDigests: nodeInputDigests(result),
    identityDigest: canonicalSha256({
      runId: result.runId,
      snapshotId: result.snapshotId,
      asOf: result.asOf,
      runInputDigest: record.inputDigest,
    }),
  };
}

function expectedIndexFromFolders({
  config,
  canonicalSha256,
  indexSchemaVersion,
}) {
  const entries = [];
  const projectFolders = fs.existsSync(config.PROJECTS_DIR)
    ? fs.readdirSync(config.PROJECTS_DIR, { withFileTypes: true })
    : [];
  for (const entry of projectFolders) {
    if (!entry.isDirectory()) continue;
    const anchorFile = path.join(config.PROJECTS_DIR, entry.name, 'meta.json');
    if (!fs.existsSync(anchorFile)) continue;
    const anchor = readJson(anchorFile);
    entries.push({
      id: anchor.id,
      type: 'project',
      status: anchor.status,
      title: anchor.title,
      contentRef: `projects/${anchor.id}`,
      contentDigest: canonicalSha256(anchor),
      createdAt: anchor.createdAt,
      updatedAt: anchor.updatedAt,
    });
  }
  const ideaFolders = fs.existsSync(config.IDEAS_DIR)
    ? fs.readdirSync(config.IDEAS_DIR, { withFileTypes: true })
    : [];
  for (const entry of ideaFolders) {
    if (!entry.isDirectory()) continue;
    const anchorFile = path.join(config.IDEAS_DIR, entry.name, 'idea.json');
    if (!fs.existsSync(anchorFile)) continue;
    const anchor = readJson(anchorFile);
    entries.push({
      id: anchor.id,
      type: 'idea',
      status: anchor.status,
      title: anchor.title,
      contentRef: `idea-generation/ideas/${anchor.id}`,
      contentDigest: canonicalSha256(anchor),
      createdAt: anchor.createdAt,
      updatedAt: anchor.updatedAt,
    });
  }
  const ordered = entriesByTypeAndId(entries);
  return {
    schemaVersion: indexSchemaVersion,
    indexDigest: canonicalSha256({
      schemaVersion: indexSchemaVersion,
      entries: ordered,
    }),
    entries: ordered,
  };
}

function assertProjectIsolation({
  fixture,
  state,
  config,
  projectSpace,
}) {
  assert.equal(projectSpace.meta(state.project.id)?.id, state.project.id);
  assert.equal(treeDigest(projectSpace.dir(state.project.id)), state.project.treeDigest);
  assertTextAbsent(config.IDEA_GENERATION_DIR, [
    state.project.id,
    fixture.project.privateSentinel,
  ]);
}

function assertProjectPrivateAccessDenied({
  fixture,
  projectId,
  projectsDir,
  FileWorkspaceService,
}) {
  const service = new FileWorkspaceService({ projectId, projectsDir });
  const deny = (operation) => {
    let denied = null;
    try {
      operation();
    } catch (error) {
      denied = error;
    }
    assert.equal(denied?.code, 'WORKSPACE_PERMISSION_DENIED');
    assert.equal(denied?.reason, 'mount-not-allowed');
  };
  const before = treeDigest(service.projectDir);
  deny(() => service.readText(
    '/project/analysis/private/m1-sentinel.txt',
    { allowedMounts: [], runId: fixture.run.runId },
  ));
  deny(() => service.writeText(
    '/project/analysis/private/m1-unauthorized-write.txt',
    'denied',
    { allowedMounts: [], runId: fixture.run.runId },
  ));
  assert.equal(treeDigest(service.projectDir), before);
  return {
    privateReadDenied: true,
    privateWriteDenied: true,
  };
}

function exactIdeaFolderIds(config) {
  const ideasDir = config.IDEAS_DIR || config.ideasDir;
  if (!fs.existsSync(ideasDir)) return [];
  return fs.readdirSync(ideasDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function validateReviewedBoundary({ fixture, result, canonicalSha256 }) {
  const collected = result.nodeExecutions['collect-market-context'].output;
  const generated = result.nodeExecutions['generate-candidates'].output;
  const verified = result.nodeExecutions['verify-candidates'].output;
  const reviewed = result.nodeExecutions['review-quality'].output;
  assert.equal(generated.rawCandidates.length, fixture.expectedBaselines.rawGeneratedCount);
  assert.deepEqual(
    verified.validIdeas.map((idea) => idea.title),
    fixture.expectedBaselines.validGeneratedTitles,
  );
  assert.deepEqual(
    sorted(verified.rejected.map((item) => item.reason)),
    sorted(fixture.expectedBaselines.rejectionReasons),
  );
  assert.equal(
    collected.sourceCandidates.some(
      (candidate) => candidate.title === fixture.expectedBaselines.sourceOnlyTitle,
    ),
    true,
  );
  assert.equal(
    verified.validIdeas.some(
      (candidate) => candidate.title === fixture.expectedBaselines.sourceOnlyTitle,
    ),
    false,
  );
  const selected = reviewed.ideas.filter((idea) => idea.qualitySelected === true);
  const unselected = reviewed.ideas.filter((idea) => idea.qualitySelected === false);
  assert.deepEqual(
    selected.map((idea) => idea.title),
    fixture.expectedBaselines.selectedValidTitles,
  );
  assert.deepEqual(
    unselected.map((idea) => idea.title),
    fixture.expectedBaselines.unselectedValidTitles,
  );
  const lowRank = reviewed.ideas.find(
    (idea) => idea.title === fixture.expectedBaselines.lowRankSelectedTitle,
  );
  assert.equal(lowRank.qualitySelected, true);
  assert.equal(lowRank.qualityRank, 2);
  assert.equal(lowRank.qualityScore, 41);
  return {
    expectedIdeaIds: reviewed.ideas.map((idea) => idea.id),
    selectedIdeaIds: selected.map((idea) => idea.id),
    unselectedIdeaIds: unselected.map((idea) => idea.id),
    validIdeaDigest: canonicalSha256(reviewed.ideas.map((idea) => ({
      id: idea.id,
      title: idea.title,
      qualitySelected: idea.qualitySelected,
      qualityRank: idea.qualityRank,
      qualityScore: idea.qualityScore,
    }))),
    rejectedDigest: canonicalSha256(verified.rejected),
  };
}

function assertPersistedIdeas({
  fixture,
  state,
  result,
  ideaStore,
  canonicalSha256,
}) {
  assert.deepEqual(
    result.generated.map((idea) => idea.id),
    state.ideas.expectedIdeaIds,
  );
  assert.equal(
    result.generated.length,
    fixture.expectedBaselines.validGeneratedCount,
  );
  assert.equal(
    result.generated.some(
      (idea) => idea.title === fixture.expectedBaselines.sourceOnlyTitle,
    ),
    false,
  );
  assert.deepEqual(
    sorted(exactIdeaFolderIds(state.config)),
    sorted(state.ideas.expectedIdeaIds),
  );
  const ideas = state.ideas.expectedIdeaIds.map((ideaId) => ideaStore.getIdea(ideaId));
  assert.equal(ideas.every(Boolean), true);
  for (const idea of ideas) {
    assert.equal(idea.sourceIdeaRunId, fixture.run.runId);
    assert.equal(idea.sourceRunInputSnapshotId, state.identity.snapshotId);
    assert.equal(idea.sourceRunAsOf, fixture.run.asOf);
    assert.equal(idea.sourceEffectiveConfigDigest, state.identity.snapshotConfigDigest);
    assert.equal(idea.sourceGeneratorTraceRef, state.agents.generatorTraceRef);
    assert.equal(idea.sourceQualityTraceRef, state.agents.reviewerTraceRef);
  }
  const lowRank = ideas.find(
    (idea) => idea.title === fixture.expectedBaselines.lowRankSelectedTitle,
  );
  assert.equal(lowRank.qualitySelected, true);
  assert.equal(lowRank.qualityRank, 2);
  const unselectedIds = ideas
    .filter((idea) => idea.qualitySelected === false)
    .map((idea) => idea.id);
  assert.deepEqual(unselectedIds, state.ideas.unselectedIdeaIds);
  return {
    ideaIds: ideas.map((idea) => idea.id),
    ideaIdDigest: canonicalSha256(ideas.map((idea) => idea.id)),
    lineageDigest: canonicalSha256(ideas.map((idea) => ({
      id: idea.id,
      sourceIdeaRunId: idea.sourceIdeaRunId,
      sourceRunInputSnapshotId: idea.sourceRunInputSnapshotId,
      sourceRunAsOf: idea.sourceRunAsOf,
      sourceEffectiveConfigDigest: idea.sourceEffectiveConfigDigest,
      sourceGeneratorTraceRef: idea.sourceGeneratorTraceRef,
      sourceQualityTraceRef: idea.sourceQualityTraceRef,
    }))),
  };
}

async function main() {
  const dataDir = assertWorkerBoundary();
  clearExternalConfiguration();
  fs.mkdirSync(controlDir, { recursive: true });
  const fixtureFile = resolveFixtureFile();
  const mutableInputFile = resolveMutableInputFile();
  const fixture = readJson(fixtureFile);
  const fixtureDigest = localDigest(fixture);
  const networkGuard = installDenyAllNetworkGuard();

  try {
    const [
      config,
      artifactContracts,
      agentContracts,
      idempotentBackendModule,
      idempotencyStoreModule,
      ideasDomain,
      indexModule,
      projectSpaceModule,
      workspaceServiceModule,
      sourceDiscoveryModule,
      ideaComposition,
      ideaStorageModule,
      agentRegistry,
      toolCatalog,
      runAnalysisSpec,
      ideaSpec,
    ] = await Promise.all([
      import('../../src/config.js'),
      import('../../src/core/contracts/ArtifactRef.js'),
      import('../../src/core/contracts/agentContracts.js'),
      import('../../src/core/agent-backend/IdempotentAgentBackend.js'),
      import('../../src/core/agent-backend/AgentResultIdempotencyStore.js'),
      import('../../src/domains/ideas/index.js'),
      import('../../src/core/persistence/GlobalContentIndex.js'),
      import('../../src/project-space/ProjectSpace.js'),
      import('../../src/project-space/WorkspaceService.js'),
      import('../../src/workflows/idea-generation/nodes/sourceDiscovery.js'),
      import('../../src/workflows/idea-generation/runIdeaGeneration.js'),
      import('../../src/workflows/idea-generation/runtime/IdeaGenerationRunStorage.js'),
      import('../../src/agents/registry.js'),
      import('../../src/tools/toolCatalog.js'),
      import('../../src/workflows/run-analysis/workflowSpec.js'),
      import('../../src/workflows/idea-generation/workflowSpec.js'),
    ]);
    const { canonicalSha256, canonicalStringify } = artifactContracts;
    assert.equal(path.resolve(config.DATA_DIR), dataDir);
    assert.equal(config.runtime.DEMO_MODE, false);
    assert.equal(config.runtime.DEFAULT_PROVIDER, 'openai-compatible');
    assert.equal(config.runtime.OPENAI_COMPATIBLE_API_KEY, '');
    assert.equal(config.runtime.OPENAI_COMPATIBLE_BASE_URL, '');
    assert.equal(config.runtime.OPENAI_COMPATIBLE_MODEL, 'gpt-5.6-sol');
    assert.equal(config.runtime.OPENAI_COMPATIBLE_REASONING_LEVEL, 'high');
    assert.equal(config.runtime.REFLECTION_PROVIDER, 'openai-compatible');
    assert.equal(config.runtime.REFLECTION_MODEL, 'gpt-5.6-sol');
    assert.deepEqual(config.tierConfig(), {
      small: { provider: 'openai-compatible', model: 'gpt-5.6-sol' },
      main: { provider: 'openai-compatible', model: 'gpt-5.6-sol' },
      reflection: { provider: 'openai-compatible', model: 'gpt-5.6-sol' },
    });
    assert.equal(config.runtime.DEEPSEEK_API_KEY, '');
    assert.equal(config.runtime.FMP_API_KEY, '');
    assert.equal(config.runtime.PERPLEXITY_API_KEY, '');
    assert.equal(config.runtime.TAVILY_API_KEY, '');
    assert.equal(config.runtime.FRED_API_KEY, '');

    const runStorage = new ideaStorageModule.IdeaGenerationRunStorage({
      runsDir: config.IDEA_RUNS_DIR,
      snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
      now: () => fixture.run.asOf,
    });
    const ideaStore = new ideasDomain.FileIdeaStore({
      ideasDir: config.IDEAS_DIR,
      legacyStore: { getIdeas: () => [] },
      index: indexModule.globalContentIndex,
      now: () => Date.parse(fixture.run.asOf) + 1000,
    });
    const services = runtimeServices({
      fixture,
      mutableInputFile,
      canonicalSha256,
      ideaStore,
      runStorage,
      snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
      globalContentIndex: indexModule.globalContentIndex,
      productionSourceDiscovery: sourceDiscoveryModule.runSourceDiscoveryNodes,
    });
    const agentBackend = createInjectedBackend({
      fixture,
      canonicalSha256,
      createAgentRunResult: agentContracts.createAgentRunResult,
      IdempotentAgentBackend: idempotentBackendModule.IdempotentAgentBackend,
      AgentResultIdempotencyStore: idempotencyStoreModule.AgentResultIdempotencyStore,
      snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
    });

    if (phase === 'interrupt-after-review') {
      assert.equal(fs.existsSync(stateFile()), false);
      const originalNow = Date.now;
      const originalRandom = Math.random;
      Date.now = () => Date.parse(fixture.run.asOf) - 1000;
      Math.random = () => fixture.project.randomValue;
      let project;
      try {
        project = projectSpaceModule.ProjectSpace.create({
          title: fixture.project.title,
          tickers: [fixture.project.ticker],
          theme: 'existing-project',
        });
      } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
      }
      projectSpaceModule.ProjectSpace.setAnalysisText(
        project.id,
        'private/m1-sentinel.txt',
        fixture.project.privateSentinel,
      );
      const projectEntry = indexModule.globalContentIndex.read().entries.find(
        (entry) => entry.type === 'project' && entry.id === project.id,
      );
      assert.ok(projectEntry);
      const deniedAccess = assertProjectPrivateAccessDenied({
        fixture,
        projectId: project.id,
        projectsDir: config.PROJECTS_DIR,
        FileWorkspaceService: workspaceServiceModule.FileWorkspaceService,
      });
      const projectState = {
        id: project.id,
        entryDigest: canonicalSha256(projectEntry),
        treeDigest: treeDigest(projectSpaceModule.ProjectSpace.dir(project.id)),
        ...deniedAccess,
      };

      const result = await ideaComposition.runIdeaGenerationWorkflow(
        fixture.run.requestedCount,
        {
          agentBackend,
          services,
          stopAfterNodeId: fixture.run.stopAfterNodeId,
        },
      );
      assert.equal(result.status, 'RUNNING');
      assert.equal(result.execution.stoppedAt, fixture.run.stopAfterNodeId);
      assert.deepEqual(result.execution.executedNodeIds, NODE_IDS.slice(0, 5));
      assert.deepEqual(result.execution.hydratedNodeIds, []);
      assert.equal(ideaStore.getIdeas().length, 0);
      const reviewed = validateReviewedBoundary({
        fixture,
        result,
        canonicalSha256,
      });
      const identity = durableIdentity({
        fixture,
        result,
        runStorage,
        snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
        canonicalSha256,
      });
      const audit = readAudit(fixture);
      assertExpectedAudit(audit);
      const compactedAudit = compactAudit(audit, canonicalSha256);
      const generator = audit.logicalAgentCalls.find(
        (call) => call.agentId === 'idea-generator',
      );
      const reviewer = audit.logicalAgentCalls.find(
        (call) => call.agentId === 'idea-quality-reviewer',
      );
      const generatedOutput = result.nodeExecutions['generate-candidates'].output;
      const reviewedOutput = result.nodeExecutions['review-quality'].output;
      const state = {
        schemaVersion: 'm1-w3-w5-scenario-state.v1',
        fixtureId: fixture.fixtureId,
        fixtureDigest,
        config: {
          ideaGenerationDir: config.IDEA_GENERATION_DIR,
          ideasDir: config.IDEAS_DIR,
        },
        workflow: {
          id: ideaSpec.IDEA_GENERATION_WORKFLOW_SPEC.id,
          version: ideaSpec.IDEA_GENERATION_WORKFLOW_SPEC.version,
          hash: ideaSpec.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
        },
        identity,
        project: projectState,
        ideas: reviewed,
        agents: {
          identityDigest: compactedAudit.logicalAgentIdentityDigest,
          generatorIdentityDigest: canonicalSha256(generator),
          reviewerIdentityDigest: canonicalSha256(reviewer),
          generatorTraceRef: generatedOutput.agent.traceRef,
          reviewerTraceRef: reviewedOutput.agent.traceRef,
          leastPrivilege: audit.logicalAgentCalls.every(
            (call) => call.leastPrivilege === true,
          ),
          semanticRequestsValidated: audit.logicalAgentCalls.every(
            (call) => call.semanticRequestValidated === true,
          ),
        },
        initialAuditDigest: compactedAudit.auditDigest,
      };
      writeJson(stateFile(), state);
      assertProjectIsolation({
        fixture,
        state,
        config,
        projectSpace: projectSpaceModule.ProjectSpace,
      });
      assert.equal(networkGuard.blockedAttempts.length, 0);
      return {
        schemaVersion: 'm1-w3-w5-worker-result.v1',
        phase,
        processId: process.pid,
        fixtureId: fixture.fixtureId,
        fixtureDigest,
        workflow: state.workflow,
        status: result.status,
        interruptionPoint: result.execution.stoppedAt,
        identity,
        ideas: reviewed,
        agents: state.agents,
        audit: compactedAudit,
        execution: result.execution,
        project: projectState,
        networkGuardActive: true,
        blockedNetworkAttemptCount: 0,
      };
    }

    const state = readJson(stateFile());
    assert.equal(state.fixtureId, fixture.fixtureId);
    assert.equal(state.fixtureDigest, fixtureDigest);
    assert.equal(state.identity.runId, fixture.run.runId);
    const beforeAudit = readAudit(fixture);
    assertExpectedAudit(beforeAudit);
    const beforeAuditDigest = canonicalSha256(beforeAudit);
    assert.equal(beforeAuditDigest, state.initialAuditDigest);

    if (phase === 'resume-persist') {
      const result = await ideaComposition.resumeIdeaGenerationWorkflow(
        fixture.run.runId,
        { agentBackend, services },
      );
      assert.equal(result.status, 'SUCCEEDED');
      assert.deepEqual(result.execution.hydratedNodeIds, NODE_IDS.slice(0, 5));
      assert.deepEqual(result.execution.executedNodeIds, ['persist-ideas']);
      const identity = durableIdentity({
        fixture,
        result,
        runStorage,
        snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
        canonicalSha256,
      });
      assert.deepEqual(
        Object.fromEntries(Object.entries(identity).filter(([key]) => (
          key !== 'nodeInputDigests'
        ))),
        Object.fromEntries(Object.entries(state.identity).filter(([key]) => (
          key !== 'nodeInputDigests'
        ))),
      );
      for (const nodeId of NODE_IDS.slice(0, 5)) {
        assert.equal(
          identity.nodeInputDigests[nodeId],
          state.identity.nodeInputDigests[nodeId],
        );
      }
      const persisted = assertPersistedIdeas({
        fixture,
        state,
        result,
        ideaStore,
        canonicalSha256,
      });
      const expectedProjection = expectedIndexFromFolders({
        config,
        canonicalSha256,
        indexSchemaVersion: indexModule.GLOBAL_CONTENT_INDEX_SCHEMA_VERSION,
      });
      const beforeDelete = indexModule.globalContentIndex.read();
      assert.equal(
        canonicalStringify(beforeDelete),
        canonicalStringify(expectedProjection),
      );
      assert.equal(
        beforeDelete.entries.filter((entry) => entry.type === 'project').length,
        1,
      );
      assert.equal(
        beforeDelete.entries.filter((entry) => entry.type === 'idea').length,
        fixture.expectedBaselines.validGeneratedCount,
      );
      fs.unlinkSync(indexModule.globalContentIndex.indexPath);
      assert.equal(fs.existsSync(indexModule.globalContentIndex.indexPath), false);
      const rebuilt = indexModule.globalContentIndex.rebuild();
      assert.equal(
        canonicalStringify(rebuilt),
        canonicalStringify(expectedProjection),
      );
      assert.equal(canonicalStringify(rebuilt), canonicalStringify(beforeDelete));
      const projectEntry = rebuilt.entries.find(
        (entry) => entry.type === 'project' && entry.id === state.project.id,
      );
      assert.equal(canonicalSha256(projectEntry), state.project.entryDigest);
      const afterAudit = readAudit(fixture);
      assert.equal(canonicalSha256(afterAudit), beforeAuditDigest);
      assertProjectIsolation({
        fixture,
        state,
        config,
        projectSpace: projectSpaceModule.ProjectSpace,
      });
      state.completed = {
        identity,
        persisted,
        index: {
          entryCount: rebuilt.entries.length,
          ideaEntryCount: rebuilt.entries.filter(
            (entry) => entry.type === 'idea',
          ).length,
          projectEntryCount: rebuilt.entries.filter(
            (entry) => entry.type === 'project',
          ).length,
          beforeDeleteDigest: canonicalSha256(beforeDelete),
          rebuiltDigest: canonicalSha256(rebuilt),
          indexDigest: rebuilt.indexDigest,
          projectEntryDigest: canonicalSha256(projectEntry),
          exactRebuild: true,
        },
        execution: result.execution,
      };
      writeJson(stateFile(), state);
      assert.equal(networkGuard.blockedAttempts.length, 0);
      return {
        schemaVersion: 'm1-w3-w5-worker-result.v1',
        phase,
        processId: process.pid,
        fixtureId: fixture.fixtureId,
        fixtureDigest,
        workflow: state.workflow,
        status: result.status,
        identity,
        ideas: persisted,
        index: state.completed.index,
        audit: compactAudit(afterAudit, canonicalSha256),
        execution: result.execution,
        project: state.project,
        networkGuardActive: true,
        blockedNetworkAttemptCount: 0,
      };
    }

    assert.ok(state.completed);
    const result = await ideaComposition.resumeIdeaGenerationWorkflow(
      fixture.run.runId,
      { agentBackend, services },
    );
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(result.execution.executedNodeIds, []);
    assert.deepEqual(result.execution.hydratedNodeIds, NODE_IDS);
    const identity = durableIdentity({
      fixture,
      result,
      runStorage,
      snapshotStore: ideasDomain.ideaRunInputSnapshotStore,
      canonicalSha256,
    });
    assert.deepEqual(identity, state.completed.identity);
    const persisted = assertPersistedIdeas({
      fixture,
      state,
      result,
      ideaStore,
      canonicalSha256,
    });
    assert.deepEqual(persisted, state.completed.persisted);
    const projection = indexModule.globalContentIndex.read();
    assert.equal(canonicalSha256(projection), state.completed.index.rebuiltDigest);
    assert.equal(projection.indexDigest, state.completed.index.indexDigest);
    const afterAudit = readAudit(fixture);
    assert.equal(canonicalSha256(afterAudit), beforeAuditDigest);
    assertProjectIsolation({
      fixture,
      state,
      config,
      projectSpace: projectSpaceModule.ProjectSpace,
    });
    const durable = runStorage.services(fixture.run.runId);
    const events = durable.eventBus.list({ runId: fixture.run.runId });
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index].sequence, events[index - 1].sequence + 1);
    }
    const repository = {
      agentCount: agentRegistry.listAgentDefinitions().filter((definition) => !['worldview', 'report-library'].includes(definition.domain)).length,
      toolCount: toolCatalog.toolRegistry.ids().length,
      runAnalysisWorkflowHash: runAnalysisSpec.RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    };
    assert.equal(repository.agentCount, fixture.expectedBaselines.agentCount);
    assert.equal(repository.toolCount, fixture.expectedBaselines.toolCount);
    assert.equal(
      repository.runAnalysisWorkflowHash,
      fixture.expectedBaselines.runAnalysisWorkflowHash,
    );
    assert.equal(networkGuard.blockedAttempts.length, 0);
    return {
      schemaVersion: 'm1-w3-w5-worker-result.v1',
      phase,
      processId: process.pid,
      fixtureId: fixture.fixtureId,
      fixtureDigest,
      workflow: state.workflow,
      status: result.status,
      identity,
      ideas: persisted,
      index: state.completed.index,
      audit: compactAudit(afterAudit, canonicalSha256),
      execution: result.execution,
      project: state.project,
      events: {
        count: events.length,
        digest: canonicalSha256(events),
        continuousSequence: true,
      },
      repository,
      networkGuardActive: true,
      blockedNetworkAttemptCount: 0,
    };
  } finally {
    networkGuard.restore();
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'm1-w3-w5-worker-failure.v1',
    phase: PHASES.has(phase) ? phase : 'invalid',
    status: 'FAILED',
    errorCode: typeof error?.code === 'string' ? error.code : 'M1_WORKER_FAILED',
    errorDigest: localDigest(String(error?.message || error || 'unknown')),
  })}\n`);
  process.exitCode = 1;
}
