import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDenyAllNetworkGuard } from './denyAllNetwork.mjs';

const PHASES = new Set([
  'prepare-analysis-crash',
  'resume-success',
  'block-review',
  'resolve-review',
  'replay-rebuild',
]);
const phase = process.argv[2] || '';
const controlDirArgument = process.argv[3] || '';
const fixtureFileArgument = process.argv[4] || '';
const mutableInputFileArgument = process.argv[5] || '';
const dataDirArgument = process.env.FIN_DATA_DIR || '';
const controlDir = controlDirArgument ? path.resolve(controlDirArgument) : '';
const fixturesRoot = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
let fixtureFile = '';
let mutableInputFile = '';
let dataDir = '';
const statePath = path.join(controlDir, 'w8-state.json');
const crashMarkerPath = path.join(controlDir, 'analysis-crash-ready.json');
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

function localCanonical(value) {
  if (Array.isArray(value)) return value.map(localCanonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, localCanonical(value[key])]),
  );
}

function localDigest(value) {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(localCanonical(value ?? null));
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function sortedCanonical(values) {
  return [...values].sort((left, right) => (
    JSON.stringify(localCanonical(left))
      .localeCompare(JSON.stringify(localCanonical(right)))
  ));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function assertDirectFile(root, file, label) {
  const relative = path.relative(root, file);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
  ) {
    throw new Error(`${label} must be a direct child of the W8 control directory`);
  }
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
  if (
    !path.isAbsolute(fixtureFileArgument)
    || path.normalize(fixtureFileArgument) !== fixtureFileArgument
  ) {
    throw new TypeError('W8 worker fixture path must be normalized and absolute');
  }
  const fixtureRoot = fs.realpathSync(fixturesRoot);
  const candidate = fs.realpathSync(fixtureFileArgument);
  if (!pathIsWithin(fixtureRoot, candidate)) {
    throw new TypeError('W8 worker fixture path must stay inside test fixtures');
  }
  let current = fixtureRoot;
  for (const segment of path.relative(fixtureRoot, fixtureFileArgument).split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new TypeError('W8 worker fixture path must not contain symlinks');
    }
  }
  if (!fs.lstatSync(candidate).isFile()) {
    throw new TypeError('W8 worker fixture path must be a regular file');
  }
  return candidate;
}

function resolveMutableInputFile() {
  if (
    !path.isAbsolute(mutableInputFileArgument)
    || path.normalize(mutableInputFileArgument) !== mutableInputFileArgument
    || path.dirname(mutableInputFileArgument) !== controlDir
  ) {
    throw new TypeError(
      'W8 worker mutable input path must be an absolute direct child of control',
    );
  }
  if (fs.existsSync(mutableInputFileArgument)) {
    const inputStat = fs.lstatSync(mutableInputFileArgument);
    if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
      throw new TypeError('W8 worker mutable input must be a regular file');
    }
    const controlRoot = fs.realpathSync(controlDir);
    const candidate = fs.realpathSync(mutableInputFileArgument);
    if (!pathIsWithin(controlRoot, candidate)) {
      throw new TypeError('W8 worker mutable input escaped the control directory');
    }
  }
  return mutableInputFileArgument;
}

function assertWorkerBoundary() {
  if (!PHASES.has(phase)) throw new Error(`unsupported W8 worker phase: ${phase}`);
  if (
    !controlDirArgument
    || !path.isAbsolute(controlDirArgument)
    || path.normalize(controlDirArgument) !== controlDirArgument
    || !fixtureFileArgument
    || !mutableInputFileArgument
  ) {
    throw new Error('W8 worker requires phase, control directory, fixture, and mutable input');
  }
  if (process.argv.length > 6) {
    throw new TypeError('W8 worker received unexpected arguments');
  }
  if (
    !path.isAbsolute(dataDirArgument)
    || path.normalize(dataDirArgument) !== dataDirArgument
  ) {
    throw new TypeError('W8 worker data path must be normalized and absolute');
  }
  dataDir = dataDirArgument;
  if (
    path.basename(dataDir) !== 'data'
    || path.basename(controlDir) !== 'control'
    || path.dirname(dataDir) !== path.dirname(controlDir)
  ) {
    throw new Error('W8 data/control directories must be isolated siblings');
  }
  for (const [label, directory] of [
    ['data', dataDir],
    ['control', controlDir],
  ]) {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new TypeError(`W8 worker ${label} directory must be a real directory`);
    }
  }
  fixtureFile = resolveFixtureFile();
  mutableInputFile = resolveMutableInputFile();
  assertDirectFile(controlDir, mutableInputFile, 'mutable input file');
}

function clearExternalConfiguration() {
  for (const key of EXTERNAL_ENV_KEYS) {
    if (process.env[key]) {
      throw new Error(`W8 worker external configuration was not cleared: ${key}`);
    }
    process.env[key] = '';
  }
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

function phaseClock(fixture) {
  const success = Date.parse(fixture.w8.projects.success.analysisAsOf);
  const review = Date.parse(fixture.w8.projects.review.analysisAsOf);
  const byPhase = {
    'prepare-analysis-crash': success,
    'resume-success': success + 60_000,
    'block-review': review,
    'resolve-review': review + 60_000,
    'replay-rebuild': review + 120_000,
  };
  return new Date(byPhase[phase]).toISOString();
}

function installFixedClock(isoTimestamp) {
  const OriginalDate = globalThis.Date;
  const originalRandom = Math.random;
  const fixedMillis = OriginalDate.parse(isoTimestamp);
  if (!Number.isFinite(fixedMillis)) {
    throw new TypeError('W8 fixed clock must be an ISO timestamp');
  }
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedMillis]));
    }

    static now() {
      return fixedMillis;
    }
  }
  globalThis.Date = FixedDate;
  Math.random = () => 0.42424242;
  return () => {
    globalThis.Date = OriginalDate;
    Math.random = originalRandom;
  };
}

function compactRef(ref) {
  if (!ref) return null;
  return Object.fromEntries([
    'artifactId',
    'version',
    'path',
    'contentDigest',
    'schemaVersion',
    'producer',
    'contractVersion',
    'inputDigest',
    'createdAt',
    'asOf',
  ].filter((key) => ref[key] !== undefined).map((key) => [key, ref[key]]));
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

function structuralEventShape(event) {
  const payload = event.payload || {};
  const projectedPayload = Object.fromEntries([
    'status',
    'attempt',
    'nextAttempt',
    'stopReason',
    'imported',
    'cycle',
    'reviewBlockCount',
    'selectedAction',
    'humanReviewAttempt',
    'reviewRound',
  ].filter((key) => payload[key] !== undefined).map((key) => [
    key,
    payload[key],
  ]));
  for (const key of ['owners', 'nodeIds', 'rerunNodeIds', 'reopenNodeIds']) {
    if (Array.isArray(payload[key])) projectedPayload[key] = payload[key];
  }
  if (payload.artifactRef) {
    projectedPayload.artifactRef = structuralRef(payload.artifactRef);
  }
  if (Array.isArray(payload.artifactRefs)) {
    projectedPayload.artifactRefs = payload.artifactRefs.map(structuralRef);
  }
  return {
    eventType: event.eventType,
    runId: event.runId,
    nodeId: event.nodeId,
    payload: projectedPayload,
  };
}

function structuralEventSummary(events) {
  const shapes = events.map(structuralEventShape).sort((left, right) => (
    JSON.stringify(localCanonical(left))
      .localeCompare(JSON.stringify(localCanonical(right)))
  ));
  const eventTypes = Object.fromEntries(
    [...new Set(events.map((event) => event.eventType))]
      .sort()
      .map((eventType) => [
        eventType,
        events.filter((event) => event.eventType === eventType).length,
      ]),
  );
  return {
    eventTypes,
    eventShapeDigest: localDigest(shapes),
  };
}

function compactNode(node) {
  return {
    nodeId: node.nodeId,
    status: node.status,
    attempt: node.attempt,
    inputDigest: node.inputDigest,
    outputDigest: node.outputDigest,
    stopReason: node.stopReason,
    imported: node.imported,
    artifactRefs: sortedCanonical((node.artifactRefs || []).map(compactRef)),
  };
}

function compactRun(record) {
  return {
    projectId: record.projectId,
    runId: record.runId,
    workflowSpec: record.workflowSpec,
    inputDigest: record.inputDigest,
    asOf: record.asOf,
    status: record.status,
    stopReason: record.stopReason,
    resumeCount: record.resumeCount,
    remediationCycle: record.remediationCycle,
    remediationHistory: (record.remediationHistory || []).map((entry) => ({
      cycle: entry.cycle,
      owners: entry.owners,
      invalidatedNodeIds: entry.invalidatedNodeIds,
    })),
    reviewBlockCount: record.reviewBlockCount,
    blockedStateDigest: record.blockedStateDigest,
    humanReviewAttempt: record.humanReviewAttempt,
    humanReviewHistory: (record.humanReviewHistory || []).map((entry) => ({
      kind: entry.kind,
      taskId: entry.taskId,
      taskVersion: entry.taskVersion,
      decisionId: entry.decisionId,
      decisionDigest: entry.decisionDigest,
      selectedAction: entry.selectedAction,
      humanReviewAttempt: entry.humanReviewAttempt,
      reviewRound: entry.reviewRound,
      owners: entry.owners,
      rerunNodeIds: entry.rerunNodeIds,
      reopenNodeIds: entry.reopenNodeIds,
    })),
    openIssues: (record.openIssues || []).map((issue) => ({
      id: issue.id,
      owner: issue.owner,
      severity: issue.severity,
      blocking: issue.blocking,
      sourceReviewer: issue.sourceReviewer,
    })),
    nodes: Object.fromEntries(
      Object.entries(record.nodes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, node]) => [
        nodeId,
        compactNode(node),
      ]),
    ),
  };
}

function structuralRun(record) {
  return {
    projectId: record.projectId,
    runId: record.runId,
    workflowSpec: record.workflowSpec,
    inputDigest: record.inputDigest,
    asOf: record.asOf,
    status: record.status,
    stopReason: record.stopReason,
    resumeCount: record.resumeCount,
    remediationCycle: record.remediationCycle,
    remediationHistory: (record.remediationHistory || []).map((entry) => ({
      cycle: entry.cycle,
      owners: entry.owners,
      invalidatedNodeIds: entry.invalidatedNodeIds,
    })),
    reviewBlockCount: record.reviewBlockCount,
    humanReviewAttempt: record.humanReviewAttempt,
    humanReviewHistory: (record.humanReviewHistory || []).map((entry) => ({
      kind: entry.kind,
      selectedAction: entry.selectedAction,
      humanReviewAttempt: entry.humanReviewAttempt,
      reviewRound: entry.reviewRound,
      owners: entry.owners,
      rerunNodeIds: entry.rerunNodeIds,
      reopenNodeIds: entry.reopenNodeIds,
    })),
    openIssues: (record.openIssues || []).map((issue) => ({
      id: issue.id,
      owner: issue.owner,
      severity: issue.severity,
      blocking: issue.blocking,
      sourceReviewer: issue.sourceReviewer,
    })),
    nodes: Object.fromEntries(
      Object.entries(record.nodes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, node]) => [
        nodeId,
        {
          nodeId: node.nodeId,
          status: node.status,
          attempt: node.attempt,
          stopReason: node.stopReason,
          imported: node.imported,
          artifactRefs: sortedCanonical(
            (node.artifactRefs || []).map(structuralRef),
          ),
        },
      ]),
    ),
  };
}

function nodeAttempts(record) {
  return Object.fromEntries(
    Object.entries(record.nodes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, node]) => [nodeId, node.attempt]),
  );
}

function nodeRefDigests(record) {
  return Object.fromEntries(
    Object.entries(record.nodes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, node]) => [
        nodeId,
        localDigest(sortedCanonical((node.artifactRefs || []).map(compactRef))),
      ]),
  );
}

function withFixedProjectEntropy(projectFixture, callback) {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => projectFixture.createdAt;
  Math.random = () => projectFixture.randomValue;
  try {
    return callback();
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
}

function projectInput(projectFixture, ideaId) {
  return {
    ideaId,
    intensity: projectFixture.intensity || 'quick',
    analysisLanguage: 'en',
    reportLanguage: 'en',
    companyLocale: 'global',
  };
}

async function waitForService(service, label, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (service.inFlightProjectIds().length) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label} did not settle`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function exactProjectLink(project, idea, fixture) {
  assert.equal(project.sourceIdeaId, idea.id);
  assert.equal(project.sourceIdeaRunId, fixture.run.runId);
  assert.equal(project.sourceRunInputSnapshotId, idea.sourceRunInputSnapshotId);
  assert.equal(project.status, 'created');
}

function continuous(events) {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence !== events[index - 1].sequence + 1) return false;
  }
  return true;
}

function replayableArtifactIdentity(lineage) {
  return lineage.map((entry) => ({
    runId: entry.runId,
    nodeId: entry.nodeId,
    ref: compactRef(entry.ref),
    inputArtifactRefCount: (entry.inputArtifactRefs || []).length,
    inputArtifactRefsDigest: localDigest(
      (entry.inputArtifactRefs || []).map(compactRef),
    ),
  })).sort((left, right) => (
    JSON.stringify(localCanonical(left))
      .localeCompare(JSON.stringify(localCanonical(right)))
  ));
}

function exactArtifactEvidence(lineage) {
  return lineage.map((entry) => {
    const inputArtifactRefs = sortedCanonical(
      (entry.inputArtifactRefs || []).map(compactRef),
    );
    return {
      runId: entry.runId,
      nodeId: entry.nodeId,
      idempotencyKeyDigest: localDigest(entry.idempotencyKey),
      ref: compactRef(entry.ref),
      inputArtifactRefCount: inputArtifactRefs.length,
      inputArtifactRefsDigest: localDigest(inputArtifactRefs),
    };
  }).sort((left, right) => (
    JSON.stringify(localCanonical(left))
      .localeCompare(JSON.stringify(localCanonical(right)))
  ));
}

function structuralArtifactIdentity(lineage) {
  return lineage.map((entry) => ({
    runId: entry.runId,
    nodeId: entry.nodeId,
    ref: structuralRef(entry.ref),
    inputArtifactRefs: (entry.inputArtifactRefs || []).map(structuralRef),
  })).sort((left, right) => (
    JSON.stringify(localCanonical(left))
      .localeCompare(JSON.stringify(localCanonical(right)))
  ));
}

function assertFormalLineage(lineage, validateArtifactRef) {
  assert.ok(lineage.length > 0, 'formal artifact lineage is required');
  for (const entry of lineage) {
    assert.equal(validateArtifactRef(entry.ref).valid, true);
    assert.equal(typeof entry.runId, 'string');
    assert.equal(typeof entry.nodeId, 'string');
    for (const input of entry.inputArtifactRefs || []) {
      assert.equal(validateArtifactRef(input).valid, true);
    }
  }
}

function sameArtifactRef(left, right) {
  return localDigest(compactRef(left)) === localDigest(compactRef(right));
}

function issueIdentity(issues) {
  return sortedCanonical((issues || []).map((issue) => ({
    id: issue.id,
    owner: issue.owner,
    severity: issue.severity,
    blocking: issue.blocking !== false,
    sourceReviewer: issue.sourceReviewer || null,
  })));
}

function runLifecycle(record, refProjector = compactRef) {
  return {
    projectId: record.projectId,
    runId: record.runId,
    workflowSpec: record.workflowSpec,
    inputDigest: record.inputDigest,
    asOf: record.asOf,
    status: record.status,
    stopReason: record.stopReason,
    remediationCycle: record.remediationCycle || 0,
    nodes: Object.fromEntries(
      Object.entries(record.nodes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, node]) => [
          nodeId,
          {
            status: node.status,
            attempt: node.attempt,
            stopReason: node.stopReason,
            imported: node.imported === true,
            artifactRefs: sortedCanonical(
              (node.artifactRefs || []).map(refProjector),
            ),
          },
        ]),
    ),
  };
}

function assertReplayLifecycle(record, replayRun, canonicalSha256) {
  assert.ok(replayRun, `event replay is missing run ${record.runId}`);
  const stored = runLifecycle(record);
  const replayed = runLifecycle(replayRun);
  assert.deepEqual(replayed, stored);
  return {
    lifecycleMatchesRunStore: true,
    lifecycleStructureDigest: canonicalSha256(
      runLifecycle(record, structuralRef),
    ),
  };
}

function compactHumanReviewReplay(humanReviews) {
  const tasks = Object.fromEntries(
    Object.entries(humanReviews?.tasks || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, task]) => [
        taskId,
        {
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          status: task.status,
          taskRef: structuralRef(task.taskRef),
          issuesDigestPresent: Boolean(task.issuesDigest),
          blockedStateDigestPresent: Boolean(task.blockedStateDigest),
          reviewBlockCount: task.reviewBlockCount,
          policyDigestPresent: Boolean(task.policyDigest),
          decisionId: task.decisionId || null,
          decisionRef: structuralRef(task.decisionRef),
          resultingRunStatus: task.resultingRunStatus || null,
        },
      ]),
  );
  const decisions = Object.fromEntries(
    Object.entries(humanReviews?.decisions || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([decisionId, decision]) => [
        decisionId,
        {
          decisionId: decision.decisionId,
          taskId: decision.taskId,
          taskVersion: decision.taskVersion,
          status: decision.status,
          decisionRef: structuralRef(decision.decisionRef),
          requestDigestPresent: Boolean(decision.requestDigest),
          decisionDigestPresent: Boolean(decision.decisionDigest),
          reviewerId: decision.reviewerId,
          selectedAction: decision.selectedAction,
          policyAllowed: decision.policyAllowed,
        },
      ]),
  );
  const resumes = sortedCanonical((humanReviews?.resumes || []).map((resume) => ({
    status: resume.status,
    taskId: resume.taskId,
    taskVersion: resume.taskVersion,
    decisionId: resume.decisionId,
    decisionRef: structuralRef(resume.decisionRef),
    selectedAction: resume.selectedAction,
    humanReviewAttempt: resume.humanReviewAttempt,
    reviewRound: resume.reviewRound,
    owners: [...(resume.owners || [])].sort(),
    rerunNodeIds: [...(resume.rerunNodeIds || [])].sort(),
    reopenNodeIds: [...(resume.reopenNodeIds || [])].sort(),
  })));
  return { tasks, decisions, resumes };
}

function artifactKeyAudit(manifest, canonicalSha256) {
  const logicalKeys = manifest.versions.map((entry) => ({
    runId: entry.runId,
    nodeId: entry.nodeId,
    idempotencyKeyDigest: canonicalSha256(entry.idempotencyKey),
    artifactId: entry.ref.artifactId,
    path: entry.ref.path,
  }));
  const versionKeys = manifest.versions.map(
    (entry) => `${entry.ref.artifactId}@${entry.ref.version}`,
  );
  assert.equal(
    new Set(logicalKeys.map((entry) => canonicalSha256(entry))).size,
    logicalKeys.length,
    'W8 artifact logical keys must not duplicate',
  );
  assert.equal(
    new Set(versionKeys).size,
    versionKeys.length,
    'W8 artifact version keys must not duplicate',
  );
  assert.equal(
    Object.keys(manifest.successfulCommits).length,
    manifest.versions.length,
    'every W8 artifact version must have one successful commit key',
  );
  return {
    artifactCount: manifest.versions.length,
    logicalKeyCount: logicalKeys.length,
    successfulCommitKeyCount: Object.keys(manifest.successfulCommits).length,
    duplicateLogicalKeyCount: 0,
    duplicateVersionKeyCount: 0,
    structuralKeyDigest: canonicalSha256(sortedCanonical(logicalKeys.map((entry) => ({
      runId: entry.runId,
      nodeId: entry.nodeId,
      artifactId: entry.artifactId,
      path: entry.path,
    })))),
  };
}

function manifestEntryForRef(manifest, ref) {
  const matches = manifest.versions.filter((entry) => (
    sameArtifactRef(entry.ref, ref)
  ));
  assert.equal(matches.length, 1, `artifact manifest join is ambiguous: ${ref.artifactId}`);
  return matches[0];
}

function reportProducerJoin(runtime, {
  projectId,
  reportRef,
  lineage,
  audit,
}) {
  const reportEntries = lineage.filter((entry) => sameArtifactRef(entry.ref, reportRef));
  assert.equal(reportEntries.length, 1, 'report ArtifactRef must have one lineage entry');
  const finalReportEntry = reportEntries[0];
  assert.equal(finalReportEntry.nodeId, 'finalize-project');
  assert.equal(finalReportEntry.ref.producer, 'run-analysis-finalizer');
  const lineageByRef = new Map(
    lineage.map((entry) => [localDigest(compactRef(entry.ref)), entry]),
  );
  const queue = [{ entry: finalReportEntry, hopCount: 0 }];
  const visited = new Set();
  let composerEntry = null;
  let composerHopCount = null;
  while (queue.length) {
    const current = queue.shift();
    const identity = localDigest(compactRef(current.entry.ref));
    if (visited.has(identity)) continue;
    visited.add(identity);
    if (
      current.entry.nodeId === 'compose-report'
      && current.entry.ref.producer === 'report-composer'
    ) {
      composerEntry = current.entry;
      composerHopCount = current.hopCount;
      break;
    }
    for (const inputRef of current.entry.inputArtifactRefs || []) {
      const parent = lineageByRef.get(localDigest(compactRef(inputRef)));
      if (parent) {
        queue.push({ entry: parent, hopCount: current.hopCount + 1 });
      }
    }
  }
  assert.ok(composerEntry, 'final report lineage must reach report-composer');
  const effective = runtime.getEffectiveAgentDefinition('report-composer');
  const composerCalls = sortedAuditRecords(audit, projectId).filter((entry) => (
    entry.nodeId === 'compose-report'
    && entry.agentId === 'report-composer'
    && entry.status === 'succeeded'
  ));
  assert.ok(composerCalls.length > 0, 'report Artifact requires a successful composer call');
  assert.equal(
    composerCalls.every((entry) => (
      entry.effectiveConfigDigest === effective.effectiveConfig.digest
    )),
    true,
    'report-composer effective configuration must join the report Artifact',
  );
  return {
    artifactRef: compactRef(reportRef),
    artifactProducingNodeId: finalReportEntry.nodeId,
    artifactProducer: finalReportEntry.ref.producer,
    composerArtifactRef: compactRef(composerEntry.ref),
    composerNodeId: composerEntry.nodeId,
    producingAgentId: composerEntry.ref.producer,
    composerLineageHopCount: composerHopCount,
    effectiveConfigDigest: effective.effectiveConfig.digest,
    successfulCallCount: composerCalls.length,
    successfulCallIdentities: composerCalls.map((entry) => ({
      phase: entry.phase,
      runId: entry.runId,
      nodeId: entry.nodeId,
      agentId: entry.agentId,
      idempotencyKeyDigest: entry.idempotencyKeyDigest,
      requestDigest: entry.requestDigest,
      outputDigest: entry.outputDigest,
      effectiveConfigDigest: entry.effectiveConfigDigest,
    })),
    exactCallIdentitiesValidated: true,
    joined: true,
  };
}

function sortedAuditRecords(audit, projectId) {
  return audit
    .filter((entry) => entry.projectId === projectId)
    .sort((left, right) => (
      JSON.stringify(localCanonical(left))
        .localeCompare(JSON.stringify(localCanonical(right)))
    ));
}

function assertAgentIdentityPolicy(audit, projectId, {
  crashAgentId = null,
} = {}) {
  const records = sortedAuditRecords(audit, projectId);
  assert.equal(
    records.every((entry) => entry.live === false),
    true,
    'W8 deterministic Agent calls must never be live',
  );
  assert.equal(
    records.every((entry) => (
      entry.status === 'paused'
        ? entry.valid === false
        : entry.valid === true
    )),
    true,
    'W8 succeeded Agent calls must be valid and only the crash pause may be invalid',
  );
  const failedRecords = records.filter((entry) => entry.status === 'failed');
  const partialRecords = records.filter((entry) => entry.status === 'partial');
  if (failedRecords.length || partialRecords.length) {
    const error = new Error('W8 physical Agent calls must be succeeded or paused');
    error.code = 'W8_AGENT_PHYSICAL_CALL_INVALID';
    error.detailCode = sortedCanonical([
      ...failedRecords.map((entry) => `${entry.agentId}:failed`),
      ...partialRecords.map((entry) => `${entry.agentId}:partial`),
    ]).join('+').slice(0, 240);
    throw error;
  }
  const byIdentity = new Map();
  for (const entry of records) {
    const grouped = byIdentity.get(entry.idempotencyKeyDigest) || [];
    grouped.push(entry);
    byIdentity.set(entry.idempotencyKeyDigest, grouped);
  }
  let authorizedPauseResumePairs = 0;
  for (const grouped of byIdentity.values()) {
    const statuses = grouped.map((entry) => entry.status).sort();
    const succeededCount = statuses.filter((status) => status === 'succeeded').length;
    if (succeededCount > 1) {
      const error = new Error('W8 Agent identity produced more than one success');
      error.code = 'W8_AGENT_IDENTITY_CONFLICT';
      error.detailCode = [
        grouped[0].agentId,
        grouped[0].nodeId,
        statuses.join('+'),
      ].join(':');
      throw error;
    }
    if (grouped.length === 1) {
      assert.equal(statuses[0], 'succeeded');
      continue;
    }
    assert.equal(grouped.length, 2);
    assert.equal(crashAgentId === null, false);
    assert.deepEqual(statuses, ['paused', 'succeeded']);
    assert.equal(
      grouped.every((entry) => entry.agentId === crashAgentId),
      true,
    );
    authorizedPauseResumePairs += 1;
  }
  assert.equal(authorizedPauseResumePairs, crashAgentId ? 1 : 0);
  return {
    recordCount: records.length,
    succeededCallCount: records
      .filter((entry) => entry.status === 'succeeded').length,
    uniqueIdentityCount: byIdentity.size,
    duplicateSucceededIdentityCount: 0,
    failedCallCount: 0,
    partialCallCount: 0,
    liveCallCount: 0,
    invalidSucceededCallCount: 0,
    authorizedPauseResumePairs,
    statuses: Object.fromEntries(
      [...new Set(records.map((entry) => entry.status))]
        .sort()
        .map((status) => [
          status,
          records.filter((entry) => entry.status === status).length,
        ]),
    ),
    identityStructureDigest: localDigest(records.map((entry) => ({
      agentId: entry.agentId,
      nodeId: entry.nodeId,
      status: entry.status,
      effectiveConfigDigest: entry.effectiveConfigDigest,
    }))),
  };
}

function assertNoNetworkAttempts(networkGuard) {
  if (networkGuard.blockedAttempts.length === 0) return;
  const error = new Error('the deterministic W8 network guard observed an attempt');
  error.code = 'W8_NETWORK_ATTEMPT';
  error.blockedChannels = [
    ...new Set(networkGuard.blockedAttempts.map((entry) => entry.channel)),
  ].sort();
  throw error;
}

function assertFrozenResearch(runtime, projectId) {
  const sourceDocumentSet = JSON.parse(
    runtime.ProjectSpace.fileContent(projectId, 'data/source_documents_r1.json'),
  );
  assert.ok(sourceDocumentSet.documents.length > 0);
  assert.equal(
    sourceDocumentSet.documents.every(
      (document) => (
        document.metadata?.sourceMode === 'frozen-snapshot-replay'
      ),
    ),
    true,
  );
  const sourceManifest = runtime.ProjectSpace.sourceManifest(projectId);
  assert.ok(sourceManifest.rounds.length > 0);
  assert.equal(
    sourceManifest.rounds.every(
      (round) => round.sourceMode === 'frozen-snapshot-replay',
    ),
    true,
  );
  const toolCoverage = runtime.ProjectSpace.toolCoverage(projectId);
  assert.ok(toolCoverage.rounds.length > 0);
  assert.equal(
    toolCoverage.rounds.every(
      (round) => round.sourceMode === 'frozen-snapshot-replay',
    ),
    true,
  );
  assert.match(
    runtime.ProjectSpace.dataReport(projectId),
    /Evidence mode: frozen-snapshot-replay/u,
  );
  return {
    sourceDocumentCount: sourceDocumentSet.documents.length,
    sourceDocumentDigest: localDigest(sourceDocumentSet),
    sourceManifestDigest: localDigest(sourceManifest),
    toolCoverageDigest: localDigest(toolCoverage),
    sourceMode: 'frozen-snapshot-replay',
  };
}

async function loadRuntime(fixture, networkGuard) {
  const [
    config,
    artifactContracts,
    ideas,
    ideaStorageModule,
    globalStateModule,
    indexModule,
    projectSpaceModule,
    projectCommandModule,
    serviceModule,
    analysisModule,
    controllerModule,
    runStoreModule,
    workflowSpecModule,
    ideaWorkflowSpecModule,
    agentRuntimeModule,
    registryModule,
    toolCatalogModule,
    idempotencyModule,
    backendModule,
  ] = await Promise.all([
    import('../../src/config.js'),
    import('../../src/core/contracts/ArtifactRef.js'),
    import('../../src/domains/ideas/index.js'),
    import('../../src/workflows/idea-generation/runtime/IdeaGenerationRunStorage.js'),
    import('../../src/core/persistence/globalState.js'),
    import('../../src/core/persistence/GlobalContentIndex.js'),
    import('../../src/project-space/index.js'),
    import('../../src/domains/ideas/createProjectFromIdea.js'),
    import('../../src/workflows/run-analysis/RunAnalysisService.js'),
    import('../../src/workflows/run-analysis/runAnalysis.js'),
    import('../../src/workflows/run-analysis/human-review/HumanReviewController.js'),
    import('../../src/project-space/RunStore.js'),
    import('../../src/workflows/run-analysis/workflowSpec.js'),
    import('../../src/workflows/idea-generation/workflowSpec.js'),
    import('../../src/agents/AgentRuntimeService.js'),
    import('../../src/agents/registry.js'),
    import('../../src/tools/toolCatalog.js'),
    import('../../src/core/agent-backend/IdempotentAgentBackend.js'),
    import('./w8DeterministicBackend.mjs'),
  ]);
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
  assertNoNetworkAttempts(networkGuard);
  const projectSpace = projectSpaceModule.ProjectSpace;

  function frozenDataForProject(projectFixture) {
    const ticker = projectFixture.ticker;
    if (typeof ticker !== 'string' || !/^[A-Z][A-Z0-9.-]{0,14}$/u.test(ticker)) {
      throw new TypeError('W8 analysis fixture ticker is invalid');
    }
    const data = structuredClone(fixture.w8.analysisFrozenData);
    data.quotes = data.quotes.filter((entry) => entry.symbol === ticker);
    data.fundamentals = Object.fromEntries(
      Object.entries(data.fundamentals)
        .filter(([symbol]) => symbol === ticker),
    );
    data.transcripts = data.transcripts
      .filter((entry) => entry.symbol === ticker);
    data.detail = Object.fromEntries(
      Object.entries(data.detail)
        .filter(([symbol]) => symbol === ticker),
    );
    data.industry = {
      ...data.industry,
      peers: data.industry.peers.filter((symbol) => symbol !== ticker),
      comps: data.industry.comps.filter(
        (entry) => entry.ticker === ticker || entry.isTarget !== true,
      ),
    };
    assert.equal(data.quotes.length, 1);
    assert.deepEqual(Object.keys(data.fundamentals), [ticker]);
    assert.deepEqual(Object.keys(data.detail), [ticker]);
    assert.equal(
      data.industry.comps.filter((entry) => entry.isTarget === true).length,
      1,
    );
    return data;
  }

  function frozenDataByRound(projectFixture) {
    const data = frozenDataForProject(projectFixture);
    return { 1: data, 2: structuredClone(data) };
  }

  function projectAnalysisFixture(projectId) {
    const meta = projectSpace.meta(projectId);
    const idea = meta?.sourceIdeaId
      ? ideas.IdeaStore.getIdea(meta.sourceIdeaId)
      : null;
    const match = [
      fixture.w8.projects.success,
      fixture.w8.projects.review,
    ].find((candidate) => candidate.sourceIdeaTitle === idea?.title);
    if (!match) {
      throw new Error(`W8 analysis fixture is unavailable for project: ${projectId}`);
    }
    return match;
  }

  function analysisRunId(projectId, analysisFixture) {
    if (
      typeof analysisFixture.analysisRunIdSuffix !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(analysisFixture.analysisRunIdSuffix)
    ) {
      throw new TypeError('W8 analysis run id suffix is invalid');
    }
    return `artifact-run-${projectId}-${analysisFixture.analysisRunIdSuffix}`;
  }

  function deterministicReserveRun(projectId, options = {}) {
    if (options.resume) {
      const runStore = projectSpace.runStore(projectId);
      const current = runStore.list().at(-1);
      if (!current) throw new Error(`W8 prepared run is missing: ${projectId}`);
      return { runStore, record: runStore.prepareResume(current.runId) };
    }
    const meta = projectSpace.meta(projectId);
    const analysisFixture = projectAnalysisFixture(projectId);
    const asOf = new Date(options.asOf).toISOString();
    assert.equal(asOf, analysisFixture.analysisAsOf);
    assert.deepEqual(
      options.frozenDataByRound,
      frozenDataByRound(analysisFixture),
    );
    const runStore = projectSpace.runStore(projectId);
    const runId = analysisRunId(projectId, analysisFixture);
    const inputDigest = artifactContracts.canonicalSha256({
      workflowSpecHash: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
      projectId,
      projectCreatedAt: meta.createdAt,
      intensity: options.intensity || meta.intensity || 'standard',
      industryTemplate: options.industryTemplate || meta.industryTemplate || null,
      companyTemplate: options.companyTemplate || meta.companyTemplate || null,
      asOf,
      frozenDataDigest: artifactContracts.canonicalSha256(
        frozenDataByRound(analysisFixture),
      ),
    });
    const record = runStore.begin({
      runId,
      workflowSpec: {
        id: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC.id,
        version: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC.version,
        hash: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
      },
      inputDigest,
      asOf,
      nodeIds: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC.nodes
        .map((node) => node.id),
      allowSupersede: true,
    });
    projectSpace.updateMeta(projectId, {
      status: 'queued',
      lastError: null,
    });
    return { runStore, record };
  }

  function analysisOptions(projectFixture) {
    return {
      intensity: projectFixture.intensity,
      asOf: projectFixture.analysisAsOf,
      frozenDataByRound: frozenDataByRound(projectFixture),
    };
  }

  function createService(mode) {
    const crashEnabled = mode === 'success-crash';
    const backendMode = crashEnabled ? 'success' : mode;
    const physicalAgentBackend = backendModule.createW8DeterministicBackend({
      ProjectSpace: projectSpace,
      mode: backendMode,
      controlDir,
      phase,
      crashMarkerFile: crashEnabled ? crashMarkerPath : null,
      crashAgentId: fixture.w8.crash.agentId,
      beforeCrash: crashEnabled
        ? () => assertNoNetworkAttempts(networkGuard)
        : null,
    });
    const agentBackend = idempotencyModule.withAgentResultIdempotency(
      physicalAgentBackend,
    );
    const controller = new controllerModule.RunAnalysisHumanReviewController({
      projectSpace,
      now: () => new Date(
        Date.parse(fixture.w8.projects.review.analysisAsOf) + 1000,
      ).toISOString(),
    });
    const service = new serviceModule.RunAnalysisService({
      projectSpace,
      humanReviewController: controller,
      reserveRun: deterministicReserveRun,
      runner: (projectId, options) => analysisModule.runAnalysisWorkflow(
        projectId,
        {
          ...options,
          frozenDataByRound: frozenDataByRound(
            projectAnalysisFixture(projectId),
          ),
          agentBackend,
        },
      ),
      logger: { error() {} },
    });
    controller.bindAnalysisService(service);
    return { service, controller, agentBackend };
  }

  return {
    config,
    ...artifactContracts,
    ideas,
    IdeaGenerationRunStorage: ideaStorageModule.IdeaGenerationRunStorage,
    Store: globalStateModule.Store,
    globalContentIndex: indexModule.globalContentIndex,
    ProjectSpace: projectSpace,
    isAgentExecutionEventType: projectSpaceModule.isAgentExecutionEventType,
    createProjectFromIdea: projectCommandModule.createProjectFromIdea,
    verifiedRunAnalysisReportPackage:
      projectSpaceModule.verifiedRunAnalysisReportPackage,
    RUN_STATUSES: runStoreModule.RUN_STATUSES,
    RUN_ANALYSIS_WORKFLOW_SPEC: workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC,
    RUN_ANALYSIS_WORKFLOW_SPEC_HASH:
      workflowSpecModule.RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    IDEA_GENERATION_WORKFLOW_SPEC:
      ideaWorkflowSpecModule.IDEA_GENERATION_WORKFLOW_SPEC,
    IDEA_GENERATION_WORKFLOW_SPEC_HASH:
      ideaWorkflowSpecModule.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    getEffectiveAgentDefinition:
      agentRuntimeModule.getEffectiveAgentDefinition,
    listAgentDefinitions: registryModule.listAgentDefinitions,
    toolRegistry: toolCatalogModule.toolRegistry,
    readW8AgentAudit: backendModule.readW8AgentAudit,
    analysisOptions,
    analysisRunId,
    createService,
  };
}

function prepareProjects(runtime, fixture) {
  const allIdeas = runtime.ideas.IdeaStore.getIdeas();
  const successIdea = allIdeas.find(
    (idea) => idea.title === fixture.w8.projects.success.sourceIdeaTitle,
  );
  const reviewIdea = allIdeas.find(
    (idea) => idea.title === fixture.w8.projects.review.sourceIdeaTitle,
  );
  assert.ok(successIdea);
  assert.ok(reviewIdea);
  assert.notEqual(successIdea.id, reviewIdea.id);

  const successInput = projectInput(fixture.w8.projects.success, successIdea.id);
  const successProject = withFixedProjectEntropy(
    fixture.w8.projects.success,
    () => runtime.createProjectFromIdea(successInput),
  );
  exactProjectLink(successProject, successIdea, fixture);
  assert.equal(runtime.ProjectSpace.runStore(successProject.id).list().length, 0);
  const successReplay = withFixedProjectEntropy(
    fixture.w8.projects.success,
    () => runtime.createProjectFromIdea(successInput),
  );
  assert.equal(successReplay.id, successProject.id);

  const reviewInput = projectInput(fixture.w8.projects.review, reviewIdea.id);
  const reviewProject = withFixedProjectEntropy(
    fixture.w8.projects.review,
    () => runtime.createProjectFromIdea(reviewInput),
  );
  exactProjectLink(reviewProject, reviewIdea, fixture);
  assert.equal(runtime.ProjectSpace.runStore(reviewProject.id).list().length, 0);
  const reviewReplay = withFixedProjectEntropy(
    fixture.w8.projects.review,
    () => runtime.createProjectFromIdea(reviewInput),
  );
  assert.equal(reviewReplay.id, reviewProject.id);

  runtime.Store.setIdeas([structuredClone(fixture.w8.projects.legacy.idea)]);
  const legacyInput = projectInput(
    fixture.w8.projects.legacy,
    fixture.w8.projects.legacy.idea.id,
  );
  const legacyProject = withFixedProjectEntropy(
    fixture.w8.projects.legacy,
    () => runtime.createProjectFromIdea(legacyInput),
  );
  assert.equal(legacyProject.sourceIdeaId, fixture.w8.projects.legacy.idea.id);
  assert.equal(legacyProject.sourceIdeaRunId, null);
  assert.equal(legacyProject.sourceRunInputSnapshotId, null);
  assert.equal(runtime.ProjectSpace.runStore(legacyProject.id).list().length, 0);
  const legacyReplay = withFixedProjectEntropy(
    fixture.w8.projects.legacy,
    () => runtime.createProjectFromIdea(legacyInput),
  );
  assert.equal(legacyReplay.id, legacyProject.id);

  return {
    successIdea,
    reviewIdea,
    successInput,
    reviewInput,
    legacyInput,
    successProject,
    reviewProject,
    legacyProject,
  };
}

async function prepareAnalysisCrash(runtime, fixture, fixtureDigest) {
  assert.equal(fs.existsSync(statePath), false);
  const prepared = prepareProjects(runtime, fixture);
  assert.deepEqual(
    runtime.readW8AgentAudit(controlDir),
    [],
    'explicit Project creation must not execute an Agent',
  );
  const { service } = runtime.createService('success-crash');
  const start = service.start(
    prepared.successProject.id,
    runtime.analysisOptions(fixture.w8.projects.success),
  );
  const duplicate = service.start(
    prepared.successProject.id,
    runtime.analysisOptions(fixture.w8.projects.success),
  );
  assert.equal(start.started, true);
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'already-running');
  assert.equal(duplicate.runId, start.runId);
  assert.equal(
    start.runId,
    runtime.analysisRunId(
      prepared.successProject.id,
      fixture.w8.projects.success,
    ),
  );

  writeJson(statePath, {
    schemaVersion: 'workflow-w8-state.v1',
    fixtureId: fixture.fixtureId,
    fixtureDigest,
    identity: {
      ideaRunId: fixture.run.runId,
      snapshotId: prepared.successIdea.sourceRunInputSnapshotId,
    },
    ideas: {
      successId: prepared.successIdea.id,
      reviewId: prepared.reviewIdea.id,
    },
    projects: {
      success: {
        id: prepared.successProject.id,
        creationKey: prepared.successProject.projectCreationKey,
        input: prepared.successInput,
      },
      review: {
        id: prepared.reviewProject.id,
        creationKey: prepared.reviewProject.projectCreationKey,
        input: prepared.reviewInput,
      },
      legacy: {
        id: prepared.legacyProject.id,
        creationKey: prepared.legacyProject.projectCreationKey,
        input: prepared.legacyInput,
      },
    },
    success: {
      runId: start.runId,
      duplicateRunId: duplicate.runId,
      duplicateStartDeduplicated: true,
    },
  });

  // The backend writes crashMarkerPath only after report-composer has been
  // reached. The parent process then sends SIGKILL to simulate a real crash.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(keepAlive);
  }
}

async function resumeSuccess(runtime, fixture, state) {
  const projectId = state.projects.success.id;
  const before = runtime.ProjectSpace.runStore(projectId).load(state.success.runId);
  assert.ok(before);
  assert.equal(before.status, runtime.RUN_STATUSES.RUNNING);
  assert.equal(before.nodes['compose-report'].status, 'RUNNING');
  const succeededBefore = Object.values(before.nodes)
    .filter((node) => node.status === 'SUCCEEDED')
    .map((node) => node.nodeId);
  assert.ok(succeededBefore.length >= 4);
  const attemptsBefore = nodeAttempts(before);
  const refsBefore = nodeRefDigests(before);
  const auditBefore = runtime.readW8AgentAudit(controlDir);

  const { service } = runtime.createService('success');
  const recovered = service.recoverInterrupted();
  const exact = recovered.find((entry) => entry.projectId === projectId);
  assert.ok(exact);
  if (exact.runId !== state.success.runId) {
    const error = new Error('W8 recovery did not preserve the prepared run id');
    error.code = 'W8_RECOVERY_IDENTITY_MISMATCH';
    error.detailCode = exact.error?.code || 'W8_RECOVERY_RUN_ID_MISSING';
    throw error;
  }
  assert.equal(exact.recovered, true);
  await waitForService(service, 'W8 success recovery');

  const status = service.status(projectId);
  const completed = runtime.ProjectSpace.runStore(projectId).load(state.success.runId);
  assert.equal(status.projectStatus, 'analyzed');
  assert.equal(status.reportReady, true);
  assert.equal(completed.status, runtime.RUN_STATUSES.SUCCEEDED);
  assert.equal(runtime.ProjectSpace.runStore(projectId).list().length, 1);
  for (const nodeId of succeededBefore) {
    assert.equal(completed.nodes[nodeId].attempt, attemptsBefore[nodeId]);
    assert.equal(nodeRefDigests(completed)[nodeId], refsBefore[nodeId]);
  }
  const reportPackage = runtime.verifiedRunAnalysisReportPackage(projectId, completed, {
    projectSpace: runtime.ProjectSpace,
  });
  assert.ok(reportPackage);
  const frozenResearch = assertFrozenResearch(runtime, projectId);
  const auditAfter = runtime.readW8AgentAudit(controlDir);
  const successfulAudit = assertAgentIdentityPolicy(auditAfter, projectId, {
    crashAgentId: fixture.w8.crash.agentId,
  });
  const priorSuccessKeys = new Set(auditBefore
    .filter((entry) => entry.projectId === projectId && entry.status === 'succeeded')
    .map((entry) => entry.idempotencyKeyDigest));
  for (const key of priorSuccessKeys) {
    assert.equal(
      auditAfter.filter((entry) => (
        entry.projectId === projectId
        && entry.status === 'succeeded'
        && entry.idempotencyKeyDigest === key
      )).length,
      1,
    );
  }

  state.success = {
    ...state.success,
    statusBeforeResume: before.status,
    crashedNodeId: 'compose-report',
    succeededBefore,
    attemptsBefore,
    finalStatus: status.projectStatus,
    runStatus: completed.status,
    reportReady: status.reportReady,
    reportPackage: {
      reportRef: compactRef(reportPackage.reportRef),
      conclusionRef: compactRef(reportPackage.conclusionRef),
      scenariosRef: compactRef(reportPackage.scenariosRef),
    },
    run: compactRun(completed),
    agentAudit: successfulAudit,
    frozenResearch,
    zeroRepeatedSuccessfulNodes: true,
  };
  writeJson(statePath, state);
  return {
    schemaVersion: 'workflow-w8-worker-result.v1',
    phase,
    status: 'SUCCEEDED',
    projectId,
    runId: completed.runId,
    projectStatus: status.projectStatus,
    succeededBefore,
    networkGuardActive: true,
  };
}

async function blockReview(runtime, fixture, state) {
  const projectId = state.projects.review.id;
  const { service, controller } = runtime.createService('review-block');
  const start = service.start(
    projectId,
    runtime.analysisOptions(fixture.w8.projects.review),
  );
  const duplicate = service.start(
    projectId,
    runtime.analysisOptions(fixture.w8.projects.review),
  );
  assert.equal(start.started, true);
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.runId, start.runId);
  assert.equal(
    start.runId,
    runtime.analysisRunId(projectId, fixture.w8.projects.review),
  );
  await waitForService(service, 'W8 review-required run');

  const status = service.status(projectId);
  const run = runtime.ProjectSpace.runStore(projectId).load(start.runId);
  const task = controller.open(projectId);
  const durableTask = runtime.ProjectSpace.humanReviewStore(projectId)
    .get(task?.taskId);
  const project = runtime.ProjectSpace.meta(projectId);
  const checkpoint = runtime.ProjectSpace.checkpoint(projectId);
  assert.equal(status.projectStatus, 'review-required');
  assert.equal(status.status, 'review-required');
  assert.equal(status.reportReady, false);
  assert.equal(project.status, 'review-required');
  assert.equal(project.lastError, null);
  assert.equal(run.status, runtime.RUN_STATUSES.BLOCKED);
  assert.equal(run.stopReason, 'human-review');
  assert.equal(status.runStatus, run.status);
  assert.equal(status.run.status, run.status);
  assert.equal(status.run.stopReason, run.stopReason);
  assert.equal(run.nodes['synthesize-conclusion'].status, 'BLOCKED');
  assert.equal(run.nodes['finalize-project'].status, 'BLOCKED');
  assert.equal(run.nodes['synthesize-conclusion'].artifactRefs.length, 0);
  assert.equal(run.nodes['finalize-project'].artifactRefs.length, 0);
  assert.equal(
    runtime.verifiedRunAnalysisReportPackage(projectId, run, {
      projectSpace: runtime.ProjectSpace,
    }),
    null,
  );
  assert.ok(task);
  assert.ok(durableTask);
  assert.equal(task.status, 'open');
  assert.equal(status.reviewTask.status, task.status);
  assert.equal(status.reviewTask.taskId, task.taskId);
  assert.equal(task.runId, run.runId);
  assert.equal(task.blockedNodeId, status.currentNodeId);
  assert.equal(task.remediationCycle, 2);
  assert.equal(task.remediationCycle, run.remediationCycle);
  assert.equal(task.reviewBlockCount, run.reviewBlockCount);
  assert.equal(durableTask.blockedStateDigest, run.blockedStateDigest);
  assert.equal(checkpoint.reportReview.decision.route, 'human-review');
  assert.equal(checkpoint.reportReview.decision.cycle, run.remediationCycle);
  const runIssueDigest = runtime.canonicalSha256(run.openIssues);
  assert.equal(runtime.canonicalSha256(project.openIssues), runIssueDigest);
  assert.equal(runtime.canonicalSha256(checkpoint.openIssues), runIssueDigest);
  assert.equal(runtime.canonicalSha256(durableTask.issues), runIssueDigest);
  assert.deepEqual(issueIdentity(run.openIssues), [{
    id: 'w8-report-blocking',
    owner: 'report',
    severity: 'critical',
    blocking: true,
    sourceReviewer: 'logic',
  }]);
  assert.deepEqual(issueIdentity(task.issues), issueIdentity(run.openIssues));
  assert.deepEqual(
    task.requestedActions.map((entry) => entry.owner),
    run.openIssues.map((issue) => issue.owner),
  );
  const blockedAgreement = {
    projectStatus: project.status,
    serviceStatus: status.projectStatus,
    runStatus: run.status,
    stopReason: run.stopReason,
    taskStatus: task.status,
    blockedNodeId: task.blockedNodeId,
    remediationCycle: run.remediationCycle,
    reviewBlockCount: run.reviewBlockCount,
    issueIdentity: issueIdentity(run.openIssues),
    issueDigest: runIssueDigest,
    projectRunTaskIssuesAgree: true,
  };
  const frozenResearch = assertFrozenResearch(runtime, projectId);

  state.review = {
    runId: run.runId,
    duplicateRunId: duplicate.runId,
    duplicateStartDeduplicated: true,
    blockedStatus: status.projectStatus,
    blockedRunStatus: run.status,
    reportReadyWhileBlocked: status.reportReady,
    taskId: task.taskId,
    taskVersion: task.version,
    taskArtifactRef: compactRef(task.taskArtifactRef),
    issueIds: task.issues.map((issue) => issue.id),
    issueOwners: task.issues.map((issue) => issue.owner),
    blockedAgreement,
    attemptsBeforeHuman: nodeAttempts(run),
    refsBeforeHuman: nodeRefDigests(run),
    runBeforeHuman: compactRun(run),
    eventCountBeforeHuman: runtime.ProjectSpace.durableEvents(
      projectId,
      { runId: run.runId },
    ).length,
    frozenResearch,
  };
  writeJson(statePath, state);
  return {
    schemaVersion: 'workflow-w8-worker-result.v1',
    phase,
    status: 'SUCCEEDED',
    projectId,
    runId: run.runId,
    projectStatus: status.projectStatus,
    taskId: task.taskId,
    networkGuardActive: true,
  };
}

function reviewDecisionRequest(task, fixture) {
  return {
    taskVersion: task.version,
    selectedAction: fixture.w8.humanReview.selectedAction,
    globalComment: fixture.w8.humanReview.globalComment,
    issueDecisions: task.issues.map((issue) => ({
      issueId: issue.id,
      disposition: 'revise',
      comment: fixture.w8.humanReview.issueComment,
      targetOwner: null,
      requestedAction: issue.requestedAction,
    })),
    downgradeInstruction: null,
  };
}

async function resolveReview(runtime, fixture, state) {
  const projectId = state.projects.review.id;
  const { service, controller } = runtime.createService('review-resolve');
  const task = controller.open(projectId);
  assert.ok(task);
  assert.equal(task.taskId, state.review.taskId);
  const request = reviewDecisionRequest(task, fixture);
  const preview = controller.preview(task.taskId, request);
  assert.deepEqual(preview.rerunNodeIds, ['compose-report', 'review-report']);
  assert.deepEqual(preview.reopenNodeIds, [
    'synthesize-conclusion',
    'finalize-project',
  ]);
  const decided = controller.decide(task.taskId, request);
  assert.equal(decided.replayed, false);
  const durableDecisionTask = runtime.ProjectSpace.humanReviewStore(projectId)
    .get(task.taskId);
  assert.ok(durableDecisionTask?.decision);
  const decisionIssueIds = durableDecisionTask.decision.issueDecisions
    .map((entry) => entry.issueId)
    .sort();
  assert.deepEqual(decisionIssueIds, [...state.review.issueIds].sort());
  assert.deepEqual(
    request.issueDecisions.map((entry) => entry.issueId).sort(),
    decisionIssueIds,
  );
  assert.equal(durableDecisionTask.decision.taskId, task.taskId);
  assert.equal(durableDecisionTask.decision.taskVersion, state.review.taskVersion);
  assert.equal(
    sameArtifactRef(
      durableDecisionTask.decision.taskRef,
      state.review.taskArtifactRef,
    ),
    true,
  );
  const decisionManifestEntry = manifestEntryForRef(
    runtime.ProjectSpace.artifactManifest(projectId),
    decided.task.decisionArtifactRef,
  );
  assert.equal(decisionManifestEntry.nodeId, 'human-review');
  assert.equal(decisionManifestEntry.ref.producer, 'human-review-controller');
  assert.deepEqual(
    decisionManifestEntry.inputArtifactRefs.map(compactRef),
    [state.review.taskArtifactRef],
  );
  const decisionTaskEdge = {
    decisionId: durableDecisionTask.decision.decisionId,
    decisionArtifactRef: compactRef(decided.task.decisionArtifactRef),
    taskId: task.taskId,
    taskVersion: durableDecisionTask.decision.taskVersion,
    taskArtifactRef: state.review.taskArtifactRef,
    issueIds: decisionIssueIds,
    inputEdgeVerified: true,
  };
  const decisionReplay = controller.decide(task.taskId, request);
  assert.equal(decisionReplay.replayed, true);
  assert.equal(
    decisionReplay.task.decision.decisionId,
    decided.task.decision.decisionId,
  );
  const resumed = controller.resume(task.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(resumed.replayed, false);
  assert.equal(resumed.task.resume.reviewRound, 4);
  assert.equal(resumed.task.resume.humanReviewAttempt, 1);
  const resumeReplay = controller.resume(task.taskId, {
    taskVersion: decided.task.version,
    decisionId: decided.task.decision.decisionId,
  });
  assert.equal(resumeReplay.replayed, true);
  await waitForService(service, 'W8 reviewed resolution');

  const finalTask = controller.get(task.taskId);
  const status = service.status(projectId);
  const run = runtime.ProjectSpace.runStore(projectId).load(state.review.runId);
  assert.equal(run.runId, state.review.runId);
  assert.equal(run.status, runtime.RUN_STATUSES.SUCCEEDED);
  assert.equal(status.projectStatus, 'analyzed');
  assert.equal(status.reportReady, true);
  assert.equal(finalTask.status, 'resolved');
  assert.equal(finalTask.decision.decisionId, decided.task.decision.decisionId);
  assert.equal(run.humanReviewAttempt, 1);
  assert.equal(run.humanReviewHistory.length, 1);
  assert.equal(run.humanReviewHistory[0].selectedAction, 'report-only-revision');
  assert.equal(run.humanReviewHistory[0].reviewRound, 4);

  const preserved = preview.preservedSuccessfulNodeIds;
  for (const nodeId of preserved) {
    assert.equal(
      run.nodes[nodeId].attempt,
      state.review.attemptsBeforeHuman[nodeId],
    );
    assert.equal(
      nodeRefDigests(run)[nodeId],
      state.review.refsBeforeHuman[nodeId],
    );
  }
  for (const nodeId of preview.rerunNodeIds) {
    assert.equal(
      run.nodes[nodeId].attempt,
      state.review.attemptsBeforeHuman[nodeId] + 1,
    );
  }
  for (const nodeId of preview.reopenNodeIds) {
    assert.equal(run.nodes[nodeId].attempt, 1);
  }
  const reportPackage = runtime.verifiedRunAnalysisReportPackage(projectId, run, {
    projectSpace: runtime.ProjectSpace,
  });
  assert.ok(reportPackage);
  const audit = runtime.readW8AgentAudit(controlDir);
  const successfulAudit = assertAgentIdentityPolicy(audit, projectId);
  const replay = runtime.ProjectSpace.replayEvents(projectId, { runId: run.runId });
  const replayedRun = replay.runs[run.runId];
  assert.equal(replayedRun.status, runtime.RUN_STATUSES.SUCCEEDED);
  assert.equal(
    replayedRun.humanReviews.decisions[decided.task.decision.decisionId].taskId,
    task.taskId,
  );
  assert.equal(replayedRun.humanReviews.resumes.length, 1);

  state.review = {
    ...state.review,
    selectedAction: request.selectedAction,
    preview: {
      rerunNodeIds: preview.rerunNodeIds,
      reopenNodeIds: preview.reopenNodeIds,
      preservedNodeIds: preview.preservedNodeIds,
      preservedSuccessfulNodeIds: preview.preservedSuccessfulNodeIds,
      reviewRound: preview.reviewRound,
      humanReviewAttempt: preview.humanReviewAttempt,
    },
    decisionId: decided.task.decision.decisionId,
    decisionArtifactRef: compactRef(decided.task.decisionArtifactRef),
    decisionIssueIds,
    decisionTaskEdge,
    decisionReplayIdempotent: true,
    resumeReplayIdempotent: true,
    finalTaskStatus: finalTask.status,
    finalStatus: status.projectStatus,
    finalRunStatus: run.status,
    reportReady: status.reportReady,
    reportPackage: {
      reportRef: compactRef(reportPackage.reportRef),
      conclusionRef: compactRef(reportPackage.conclusionRef),
      scenariosRef: compactRef(reportPackage.scenariosRef),
    },
    run: compactRun(run),
    agentAudit: successfulAudit,
    minimalRoutePreserved: true,
    eventCountAfterHuman: runtime.ProjectSpace.durableEvents(
      projectId,
      { runId: run.runId },
    ).length,
  };
  writeJson(statePath, state);
  return {
    schemaVersion: 'workflow-w8-worker-result.v1',
    phase,
    status: 'SUCCEEDED',
    projectId,
    runId: run.runId,
    projectStatus: status.projectStatus,
    taskStatus: finalTask.status,
    networkGuardActive: true,
  };
}

function replayProjectCommands(runtime, fixture, state) {
  const beforeCount = runtime.ProjectSpace.list().length;
  const success = withFixedProjectEntropy(
    fixture.w8.projects.success,
    () => runtime.createProjectFromIdea(state.projects.success.input),
  );
  const review = withFixedProjectEntropy(
    fixture.w8.projects.review,
    () => runtime.createProjectFromIdea(state.projects.review.input),
  );
  const legacy = withFixedProjectEntropy(
    fixture.w8.projects.legacy,
    () => runtime.createProjectFromIdea(state.projects.legacy.input),
  );
  assert.equal(success.id, state.projects.success.id);
  assert.equal(review.id, state.projects.review.id);
  assert.equal(legacy.id, state.projects.legacy.id);
  assert.equal(runtime.ProjectSpace.list().length, beforeCount);
  assert.equal(legacy.sourceIdeaRunId, null);
  assert.equal(legacy.sourceRunInputSnapshotId, null);
  return {
    projectCount: beforeCount,
    sameProjectIds: true,
    noDuplicateProjects: true,
    legacyMissingLinkageExplicit: true,
  };
}

function snapshotReplay(runtime, fixture, state) {
  assert.equal(fs.existsSync(mutableInputFile), false);
  const snapshotCountBefore = runtime.ideas.ideaRunInputSnapshotStore.list()
    .filter((entry) => entry.runId === fixture.run.runId).length;
  assert.equal(snapshotCountBefore, 1);
  const snapshot = runtime.ideas.ideaRunInputSnapshotStore.resolve(
    fixture.run.runId,
    state.identity.snapshotId,
  );
  assert.equal(snapshot.runId, fixture.run.runId);
  assert.equal(snapshot.asOf, fixture.run.asOf);
  assert.deepEqual(snapshot.inputs.positions, fixture.inputs.positions);
  assert.deepEqual(snapshot.inputs.mandate, fixture.inputs.mandate);
  assert.equal(snapshot.inputs.settings.DEFAULT_PROVIDER, 'openai-compatible');
  assert.equal(snapshot.inputs.settings.OPENAI_COMPATIBLE_MODEL, 'gpt-5.6-sol');
  assert.equal(snapshot.inputs.settings.OPENAI_COMPATIBLE_REASONING_LEVEL, 'high');
  assert.equal(snapshot.inputs.settings.REFLECTION_PROVIDER, 'openai-compatible');
  assert.equal(snapshot.inputs.settings.REFLECTION_MODEL, 'gpt-5.6-sol');
  const identicalReplay = runtime.ideas.ideaRunInputSnapshotStore.create({
    runId: snapshot.runId,
    workflow: structuredClone(snapshot.workflow),
    asOf: snapshot.asOf,
    inputs: structuredClone(snapshot.inputs),
    effectiveConfig: structuredClone(snapshot.effectiveConfig),
  });
  assert.equal(identicalReplay.snapshotId, snapshot.snapshotId);
  const snapshotCountAfter = runtime.ideas.ideaRunInputSnapshotStore.list()
    .filter((entry) => entry.runId === fixture.run.runId).length;
  assert.equal(snapshotCountAfter, snapshotCountBefore);
  const conflicting = {
    runId: snapshot.runId,
    workflow: structuredClone(snapshot.workflow),
    asOf: snapshot.asOf,
    inputs: structuredClone(snapshot.inputs),
    effectiveConfig: structuredClone(snapshot.effectiveConfig),
  };
  conflicting.inputs.positions[0].theme = 'changed-after-capture';
  assert.throws(
    () => runtime.ideas.ideaRunInputSnapshotStore.create(conflicting),
    (error) => error?.code === 'IDEA_RUN_INPUT_SNAPSHOT_CONFLICT',
  );
  return {
    runId: snapshot.runId,
    snapshotId: snapshot.snapshotId,
    workflow: snapshot.workflow,
    asOf: snapshot.asOf,
    contentDigest: snapshot.contentDigest,
    configDigest: snapshot.configDigest,
    policyDigest: snapshot.policyDigest,
    inputDigests: snapshot.inputDigests,
    mutableInputDeleted: true,
    capturedValuesRecovered: true,
    changedSameRunFailsClosed: true,
    identicalReplayDeduplicated: true,
    snapshotCountForRun: snapshotCountAfter,
    duplicateSnapshotCount: 0,
  };
}

function indexReplay(runtime, state) {
  const before = runtime.globalContentIndex.read();
  const canonicalBefore = runtime.canonicalStringify(before);
  const ideaRootBefore = directoryDigest(runtime.config.IDEAS_DIR);
  const projectRootBefore = directoryDigest(runtime.config.PROJECTS_DIR);
  const canonicalCounts = {
    ideaFolders: fs.readdirSync(runtime.config.IDEAS_DIR, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory()).length,
    projectFolders: runtime.ProjectSpace.list().length,
  };
  fs.unlinkSync(runtime.globalContentIndex.indexPath);
  const rebuilt = runtime.globalContentIndex.rebuild();
  assert.equal(runtime.canonicalStringify(rebuilt), canonicalBefore);
  assert.equal(directoryDigest(runtime.config.IDEAS_DIR), ideaRootBefore);
  assert.equal(directoryDigest(runtime.config.PROJECTS_DIR), projectRootBefore);
  for (const [type, id] of [
    ['idea', state.ideas.successId],
    ['idea', state.ideas.reviewId],
    ['project', state.projects.success.id],
    ['project', state.projects.review.id],
    ['project', state.projects.legacy.id],
  ]) {
    assert.ok(rebuilt.entries.some((entry) => entry.type === type && entry.id === id));
  }
  const structuralEntries = rebuilt.entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    contentRef: entry.contentRef,
    contentRefDigest: runtime.canonicalSha256(entry.contentRef),
    contentIdentityDigest: runtime.canonicalSha256({
      id: entry.id,
      type: entry.type,
      status: entry.status,
      title: entry.title,
      contentRef: entry.contentRef,
      createdAt: entry.createdAt,
    }),
    contentDigestFormat: /^sha256:[a-f0-9]{64}$/u.test(entry.contentDigest)
      ? 'sha256'
      : 'invalid',
    contentDigestVerifiedAgainstFolder: true,
    createdAt: entry.createdAt,
  }));
  const exactEntries = rebuilt.entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    contentRef: entry.contentRef,
    contentDigest: entry.contentDigest,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
  return {
    entryCount: rebuilt.entries.length,
    ideaEntryCount: rebuilt.entries.filter((entry) => entry.type === 'idea').length,
    projectEntryCount: rebuilt.entries.filter((entry) => entry.type === 'project').length,
    exactIndexDigest: rebuilt.indexDigest,
    exactProjectionDigest: runtime.canonicalSha256(rebuilt),
    exactEntries,
    structureDigest: runtime.canonicalSha256(structuralEntries),
    structuralEntries,
    folderCounts: canonicalCounts,
    exactDeleteRebuild: true,
    canonicalFoldersUnchanged: true,
  };
}

function recursiveFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('W8 canonical tree contains a symlink');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  };
  walk(root);
  return output.sort();
}

function directoryDigest(root) {
  return localDigest(recursiveFiles(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    contentDigest: localDigest(fs.readFileSync(file)),
  })));
}

function projectLineage(runtime, projectId, runId) {
  const lineage = runtime.ProjectSpace.artifactLineage(projectId, runId);
  assertFormalLineage(lineage, runtime.validateArtifactRef);
  const replay = runtime.ProjectSpace.replayEvents(projectId, { runId });
  const runRecord = runtime.ProjectSpace.runStore(projectId).load(runId);
  const events = runtime.ProjectSpace.durableEvents(projectId, { runId });
  const structuralEvents = events.filter(
    (event) => !runtime.isAgentExecutionEventType(event.eventType),
  );
  const eventStructure = structuralEventSummary(structuralEvents);
  assert.equal(continuous(events), true);
  assert.equal(replay.runs[runId].runId, runId);
  const lifecycle = assertReplayLifecycle(
    runRecord,
    replay.runs[runId],
    runtime.canonicalSha256,
  );
  assert.equal(
    runtime.canonicalSha256(replayableArtifactIdentity(replay.artifactLineage)),
    runtime.canonicalSha256(replayableArtifactIdentity(lineage)),
  );
  const exactArtifacts = exactArtifactEvidence(lineage);
  return {
    artifactCount: lineage.length,
    exactArtifactDigest: runtime.canonicalSha256(exactArtifacts),
    exactArtifacts,
    artifactStructureDigest: runtime.canonicalSha256(
      structuralArtifactIdentity(lineage),
    ),
    // Agent execution records are auxiliary observability. Exact lineage keeps
    // them, while the W8 workflow-structure digest excludes timer-driven batch
    // interleaving that cannot change workflow truth.
    eventCount: structuralEvents.length,
    exactEventDigest: runtime.canonicalSha256(events),
    ...eventStructure,
    replayStatus: replay.runs[runId].status,
    exactReplayArtifactDigest: runtime.canonicalSha256(
      replayableArtifactIdentity(replay.artifactLineage),
    ),
    continuousSequence: true,
    exactArtifactRefsValidated: true,
    eventReplayArtifactLineageMatches: true,
    humanReviews: compactHumanReviewReplay(
      replay.runs[runId].humanReviews,
    ),
    ...lifecycle,
  };
}

async function replayRebuild(runtime, fixture, state) {
  const projectReplay = replayProjectCommands(runtime, fixture, state);
  const snapshot = snapshotReplay(runtime, fixture, state);
  const ideaStorage = new runtime.IdeaGenerationRunStorage({
    runsDir: runtime.config.IDEA_RUNS_DIR,
    snapshotStore: runtime.ideas.ideaRunInputSnapshotStore,
    now: () => fixture.run.asOf,
  });
  const ideaServices = ideaStorage.services(fixture.run.runId);
  const ideaRun = ideaServices.runStore.load(fixture.run.runId);
  const successRun = runtime.ProjectSpace.runStore(state.projects.success.id)
    .load(state.success.runId);
  const reviewRun = runtime.ProjectSpace.runStore(state.projects.review.id)
    .load(state.review.runId);
  const ideaManifestBefore = ideaServices.artifactStore.manifest();
  const successManifestBefore = runtime.ProjectSpace.artifactManifest(
    state.projects.success.id,
  );
  const reviewManifestBefore = runtime.ProjectSpace.artifactManifest(
    state.projects.review.id,
  );
  const survivalBefore = {
    snapshot: runtime.canonicalSha256(
      runtime.ideas.ideaRunInputSnapshotStore.resolve(
        fixture.run.runId,
        snapshot.snapshotId,
      ),
    ),
    ideaRun: localDigest(compactRun(ideaRun)),
    successRun: localDigest(compactRun(successRun)),
    reviewRun: localDigest(compactRun(reviewRun)),
    ideaManifest: runtime.canonicalSha256(ideaManifestBefore),
    successManifest: runtime.canonicalSha256(successManifestBefore),
    reviewManifest: runtime.canonicalSha256(reviewManifestBefore),
    ideaEvents: runtime.canonicalSha256(
      ideaServices.eventBus.list({ runId: fixture.run.runId }),
    ),
    successEvents: runtime.canonicalSha256(
      runtime.ProjectSpace.durableEvents(
        state.projects.success.id,
        { runId: state.success.runId },
      ),
    ),
    reviewEvents: runtime.canonicalSha256(
      runtime.ProjectSpace.durableEvents(
        state.projects.review.id,
        { runId: state.review.runId },
      ),
    ),
  };
  const index = indexReplay(runtime, state);
  const survivalAfter = {
    snapshot: runtime.canonicalSha256(
      runtime.ideas.ideaRunInputSnapshotStore.resolve(
        fixture.run.runId,
        snapshot.snapshotId,
      ),
    ),
    ideaRun: localDigest(
      compactRun(ideaServices.runStore.load(fixture.run.runId)),
    ),
    successRun: localDigest(
      compactRun(
        runtime.ProjectSpace.runStore(state.projects.success.id)
          .load(state.success.runId),
      ),
    ),
    reviewRun: localDigest(
      compactRun(
        runtime.ProjectSpace.runStore(state.projects.review.id)
          .load(state.review.runId),
      ),
    ),
    ideaManifest: runtime.canonicalSha256(
      ideaServices.artifactStore.manifest(),
    ),
    successManifest: runtime.canonicalSha256(
      runtime.ProjectSpace.artifactManifest(state.projects.success.id),
    ),
    reviewManifest: runtime.canonicalSha256(
      runtime.ProjectSpace.artifactManifest(state.projects.review.id),
    ),
    ideaEvents: runtime.canonicalSha256(
      ideaServices.eventBus.list({ runId: fixture.run.runId }),
    ),
    successEvents: runtime.canonicalSha256(
      runtime.ProjectSpace.durableEvents(
        state.projects.success.id,
        { runId: state.success.runId },
      ),
    ),
    reviewEvents: runtime.canonicalSha256(
      runtime.ProjectSpace.durableEvents(
        state.projects.review.id,
        { runId: state.review.runId },
      ),
    ),
  };
  assert.deepEqual(survivalAfter, survivalBefore);
  const artifactKeys = {
    ideaGeneration: artifactKeyAudit(
      ideaServices.artifactStore.manifest(),
      runtime.canonicalSha256,
    ),
    success: artifactKeyAudit(
      runtime.ProjectSpace.artifactManifest(state.projects.success.id),
      runtime.canonicalSha256,
    ),
    review: artifactKeyAudit(
      runtime.ProjectSpace.artifactManifest(state.projects.review.id),
      runtime.canonicalSha256,
    ),
  };

  const successLineage = projectLineage(
    runtime,
    state.projects.success.id,
    state.success.runId,
  );
  const reviewLineage = projectLineage(
    runtime,
    state.projects.review.id,
    state.review.runId,
  );
  assert.equal(successLineage.replayStatus, runtime.RUN_STATUSES.SUCCEEDED);
  assert.equal(reviewLineage.replayStatus, runtime.RUN_STATUSES.SUCCEEDED);
  assert.ok(runtime.ProjectSpace.artifactLineage(
    state.projects.success.id,
    state.success.runId,
  ).some((entry) => (
    entry.ref.artifactId === state.success.reportPackage.reportRef.artifactId
  )));
  assert.ok(runtime.ProjectSpace.artifactLineage(
    state.projects.review.id,
    state.review.runId,
  ).some((entry) => (
    entry.ref.artifactId === state.review.reportPackage.reportRef.artifactId
  )));

  const ideaEvents = ideaServices.eventBus.list({ runId: fixture.run.runId });
  const ideaReplay = ideaServices.eventBus.replay({ runId: fixture.run.runId });
  const structuralIdeaEvents = ideaEvents.filter(
    (event) => !runtime.isAgentExecutionEventType(event.eventType),
  );
  const ideaEventStructure = structuralEventSummary(structuralIdeaEvents);
  assert.equal(continuous(ideaEvents), true);
  assert.equal(
    ideaReplay.runs[fixture.run.runId].status,
    runtime.RUN_STATUSES.SUCCEEDED,
  );
  const ideaLifecycle = assertReplayLifecycle(
    ideaRun,
    ideaReplay.runs[fixture.run.runId],
    runtime.canonicalSha256,
  );

  const successMeta = runtime.ProjectSpace.meta(state.projects.success.id);
  const reviewMeta = runtime.ProjectSpace.meta(state.projects.review.id);
  const successIdea = runtime.ideas.IdeaStore.getIdea(state.ideas.successId);
  const reviewIdea = runtime.ideas.IdeaStore.getIdea(state.ideas.reviewId);
  for (const [meta, idea] of [
    [successMeta, successIdea],
    [reviewMeta, reviewIdea],
  ]) {
    assert.equal(meta.sourceIdeaId, idea.id);
    assert.equal(meta.sourceIdeaRunId, fixture.run.runId);
    assert.equal(meta.sourceRunInputSnapshotId, snapshot.snapshotId);
    assert.equal(idea.sourceIdeaRunId, fixture.run.runId);
    assert.equal(idea.sourceRunInputSnapshotId, snapshot.snapshotId);
  }

  const successPackage = runtime.verifiedRunAnalysisReportPackage(
    state.projects.success.id,
    successRun,
    { projectSpace: runtime.ProjectSpace },
  );
  const reviewPackage = runtime.verifiedRunAnalysisReportPackage(
    state.projects.review.id,
    reviewRun,
    { projectSpace: runtime.ProjectSpace },
  );
  assert.ok(successPackage);
  assert.ok(reviewPackage);

  const { service } = runtime.createService('success');
  assert.deepEqual(service.recoverInterrupted(), []);
  assert.equal(
    runtime.ProjectSpace.runStore(state.projects.success.id).list().length,
    1,
  );
  assert.equal(
    runtime.ProjectSpace.runStore(state.projects.review.id).list().length,
    1,
  );

  const audit = runtime.readW8AgentAudit(controlDir);
  const sortedAudit = [...audit].sort((left, right) => (
    runtime.canonicalStringify(left)
      .localeCompare(runtime.canonicalStringify(right))
  ));
  const successAgentIdentity = assertAgentIdentityPolicy(
    sortedAudit,
    state.projects.success.id,
    { crashAgentId: fixture.w8.crash.agentId },
  );
  const reviewAgentIdentity = assertAgentIdentityPolicy(
    sortedAudit,
    state.projects.review.id,
  );
  const successReportProducer = reportProducerJoin(runtime, {
    projectId: state.projects.success.id,
    reportRef: successPackage.reportRef,
    lineage: runtime.ProjectSpace.artifactLineage(
      state.projects.success.id,
      state.success.runId,
    ),
    audit: sortedAudit,
  });
  const reviewReportProducer = reportProducerJoin(runtime, {
    projectId: state.projects.review.id,
    reportRef: reviewPackage.reportRef,
    lineage: runtime.ProjectSpace.artifactLineage(
      state.projects.review.id,
      state.review.runId,
    ),
    audit: sortedAudit,
  });
  const reviewManifest = runtime.ProjectSpace.artifactManifest(
    state.projects.review.id,
  );
  const persistedDecisionEntry = manifestEntryForRef(
    reviewManifest,
    state.review.decisionArtifactRef,
  );
  assert.deepEqual(
    persistedDecisionEntry.inputArtifactRefs.map(compactRef),
    [state.review.taskArtifactRef],
  );
  assert.deepEqual(
    [...state.review.decisionIssueIds].sort(),
    [...state.review.issueIds].sort(),
  );
  assert.equal(ideaRun.workflowSpec.id, runtime.IDEA_GENERATION_WORKFLOW_SPEC.id);
  assert.equal(
    ideaRun.workflowSpec.version,
    runtime.IDEA_GENERATION_WORKFLOW_SPEC.version,
  );
  assert.equal(
    ideaRun.workflowSpec.hash,
    runtime.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  );
  assert.equal(
    snapshot.workflow.hash,
    runtime.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  );
  assert.equal(
    runtime.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    fixture.expectedBaselines.ideaGenerationWorkflowHash,
  );
  const repository = {
    agentCount: runtime.listAgentDefinitions().filter((definition) => !['worldview', 'report-library'].includes(definition.domain)).length,
    toolCount: runtime.toolRegistry.ids().length,
    runAnalysisWorkflowHash: runtime.RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    ideaGenerationWorkflowHash:
      runtime.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    ideaGenerationWorkflow: {
      id: runtime.IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: runtime.IDEA_GENERATION_WORKFLOW_SPEC.version,
      productionHash: runtime.IDEA_GENERATION_WORKFLOW_SPEC_HASH,
      durableRunHash: ideaRun.workflowSpec.hash,
      snapshotHash: snapshot.workflow.hash,
      productionDurableSnapshotAgreement: true,
    },
  };
  assert.equal(repository.agentCount, fixture.expectedBaselines.agentCount);
  assert.equal(repository.toolCount, fixture.expectedBaselines.toolCount);
  assert.equal(
    repository.runAnalysisWorkflowHash,
    fixture.expectedBaselines.runAnalysisWorkflowHash,
  );
  assert.equal(
    repository.ideaGenerationWorkflowHash,
    fixture.expectedBaselines.ideaGenerationWorkflowHash,
  );

  const summary = {
    schemaVersion: 'workflow-w8-summary.v1',
    status: 'SUCCEEDED',
    fixture: {
      id: fixture.fixtureId,
      digest: state.fixtureDigest,
    },
    ideaGeneration: {
      runId: fixture.run.runId,
      snapshotId: snapshot.snapshotId,
      validIdeaCount: fixture.expectedBaselines.validGeneratedCount,
      allValidIdeasPersisted: true,
      rejectedMaterialConfinedToRun: true,
      sourceMutationAfterCapture: true,
      completedReplayExecutedNodeCount: 0,
    },
    success: {
      projectId: state.projects.success.id,
      runId: state.success.runId,
      projectStatus: state.success.finalStatus,
      runStatus: state.success.runStatus,
      reportReady: state.success.reportReady,
      crashNodeId: state.success.crashedNodeId,
      zeroRepeatedSuccessfulNodes: state.success.zeroRepeatedSuccessfulNodes,
      reportProducerJoinVerified: successReportProducer.joined,
    },
    review: {
      projectId: state.projects.review.id,
      runId: state.review.runId,
      blockedStatus: state.review.blockedStatus,
      blockedReportReady: state.review.reportReadyWhileBlocked,
      taskId: state.review.taskId,
      decisionId: state.review.decisionId,
      selectedAction: state.review.selectedAction,
      reviewRound: state.review.preview.reviewRound,
      finalStatus: state.review.finalStatus,
      finalTaskStatus: state.review.finalTaskStatus,
      reportReady: state.review.reportReady,
      minimalRoutePreserved: state.review.minimalRoutePreserved,
      taskIssueLinkVerified: true,
      decisionLinkVerified: true,
      decisionReplayIdempotent: state.review.decisionReplayIdempotent,
      resumeReplayIdempotent: state.review.resumeReplayIdempotent,
      blockedAgreement: state.review.blockedAgreement,
      decisionIssueSetVerified: true,
      decisionTaskInputEdgeVerified:
        state.review.decisionTaskEdge.inputEdgeVerified,
      reportProducerJoinVerified: reviewReportProducer.joined,
    },
    replay: {
      sameIdeaRunAndSnapshot: true,
      duplicateActiveStartsDeduplicated: true,
      duplicateProjects: 0,
      duplicateSuccessfulAgentKeys:
        successAgentIdentity.duplicateSucceededIdentityCount
        + reviewAgentIdentity.duplicateSucceededIdentityCount,
      authorizedCrashPauseResumePairs:
        successAgentIdentity.authorizedPauseResumePairs,
      failedPhysicalAgentCalls:
        successAgentIdentity.failedCallCount
        + reviewAgentIdentity.failedCallCount,
      partialPhysicalAgentCalls:
        successAgentIdentity.partialCallCount
        + reviewAgentIdentity.partialCallCount,
      duplicateSnapshots: snapshot.duplicateSnapshotCount,
      duplicateArtifactLogicalKeys:
        artifactKeys.ideaGeneration.duplicateLogicalKeyCount
        + artifactKeys.success.duplicateLogicalKeyCount
        + artifactKeys.review.duplicateLogicalKeyCount,
      indexExactDeleteRebuild: index.exactDeleteRebuild,
      canonicalFoldersUnchanged: index.canonicalFoldersUnchanged,
      postRebuildCanonicalStateRetained: true,
      runStoreEventReplayLifecycleMatches: true,
      interruptedRecoveryCount: 0,
    },
    legacy: {
      projectId: state.projects.legacy.id,
      sourceIdeaRunId: null,
      sourceRunInputSnapshotId: null,
      missingLinkageExplicit: true,
    },
    network: {
      guardActiveInAllWorkers: true,
      blockedAttemptCount: 0,
      providerCalls: 0,
      frozenResearch: {
        success: state.success.frozenResearch,
        review: state.review.frozenResearch,
      },
      live: false,
    },
    repository,
  };

  const runRecord = {
    schemaVersion: 'workflow-w8-run-record.v1',
    repeatabilityClass: 'exact-run-integrity',
    ideaGeneration: {
      run: compactRun(ideaRun),
      snapshot,
    },
    success: compactRun(successRun),
    review: {
      blocked: compactRun(state.review.runBeforeHuman),
      resolved: compactRun(reviewRun),
    },
    structural: {
      ideaGeneration: structuralRun(ideaRun),
      success: structuralRun(successRun),
      reviewBlocked: structuralRun(state.review.runBeforeHuman),
      reviewResolved: structuralRun(reviewRun),
    },
  };

  const lineage = {
    schemaVersion: 'workflow-w8-lineage.v1',
    repeatabilityClass: 'exact-run-integrity',
    success: {
      reportArtifact: compactRef(successPackage.reportRef),
      conclusionArtifact: compactRef(successPackage.conclusionRef),
      project: {
        id: successMeta.id,
        sourceIdeaId: successMeta.sourceIdeaId,
        sourceIdeaRunId: successMeta.sourceIdeaRunId,
        sourceRunInputSnapshotId: successMeta.sourceRunInputSnapshotId,
        projectCreationKey: successMeta.projectCreationKey,
      },
      idea: {
        id: successIdea.id,
        sourceIdeaRunId: successIdea.sourceIdeaRunId,
        sourceRunInputSnapshotId: successIdea.sourceRunInputSnapshotId,
        contentDigest: successIdea.contentDigest,
      },
      snapshot,
      analysis: successLineage,
      agentAudit: state.success.agentAudit,
      reportProducer: successReportProducer,
    },
    review: {
      reportArtifact: compactRef(reviewPackage.reportRef),
      conclusionArtifact: compactRef(reviewPackage.conclusionRef),
      project: {
        id: reviewMeta.id,
        sourceIdeaId: reviewMeta.sourceIdeaId,
        sourceIdeaRunId: reviewMeta.sourceIdeaRunId,
        sourceRunInputSnapshotId: reviewMeta.sourceRunInputSnapshotId,
        projectCreationKey: reviewMeta.projectCreationKey,
      },
      idea: {
        id: reviewIdea.id,
        sourceIdeaRunId: reviewIdea.sourceIdeaRunId,
        sourceRunInputSnapshotId: reviewIdea.sourceRunInputSnapshotId,
        contentDigest: reviewIdea.contentDigest,
      },
      humanReview: {
        taskId: state.review.taskId,
        taskArtifactRef: compactRef(state.review.taskArtifactRef),
        issueIds: state.review.issueIds,
        issueOwners: state.review.issueOwners,
        decisionId: state.review.decisionId,
        decisionArtifactRef: compactRef(state.review.decisionArtifactRef),
        decisionIssueIds: state.review.decisionIssueIds,
        decisionTaskEdge: {
          decisionId: state.review.decisionTaskEdge.decisionId,
          decisionArtifactRef: compactRef(
            state.review.decisionTaskEdge.decisionArtifactRef,
          ),
          taskId: state.review.decisionTaskEdge.taskId,
          taskVersion: state.review.decisionTaskEdge.taskVersion,
          taskArtifactRef: compactRef(
            state.review.decisionTaskEdge.taskArtifactRef,
          ),
          issueIds: state.review.decisionTaskEdge.issueIds,
          inputEdgeVerified: state.review.decisionTaskEdge.inputEdgeVerified,
          exactArtifactRefsValidated: true,
        },
        selectedAction: state.review.selectedAction,
        blockedAgreement: state.review.blockedAgreement,
      },
      snapshot,
      analysis: reviewLineage,
      agentAudit: state.review.agentAudit,
      reportProducer: reviewReportProducer,
    },
    ideaEvents: {
      eventCount: structuralIdeaEvents.length,
      ...ideaEventStructure,
      replayStatus: ideaReplay.runs[fixture.run.runId].status,
      continuousSequence: true,
      ...ideaLifecycle,
    },
    index,
    projectionRebuildSurvival: {
      snapshotId: snapshot.snapshotId,
      snapshotContentDigest: snapshot.contentDigest,
      ideaRunId: ideaRun.runId,
      successRunId: successRun.runId,
      reviewRunId: reviewRun.runId,
      ideaRunStatus: ideaRun.status,
      successRunStatus: successRun.status,
      reviewRunStatus: reviewRun.status,
      artifactKeys,
      exactStateDigests: survivalBefore,
      exactStateDigestsVerifiedAfterRebuild: true,
      snapshotRunArtifactEventStateRetained: true,
      eventReplayMatchesRunStore: true,
    },
    agentCallAudit: {
      entryCount: sortedAudit.length,
      exactDigest: runtime.canonicalSha256(sortedAudit),
      structuralDigest: runtime.canonicalSha256(sortedCanonical(sortedAudit.map((entry) => ({
        projectId: entry.projectId,
        nodeId: entry.nodeId,
        agentId: entry.agentId,
        status: entry.status,
        valid: entry.valid,
        live: entry.live,
        effectiveConfigDigest: entry.effectiveConfigDigest,
      })))),
      exactPhysicalCallRecordsValidated: true,
      success: successAgentIdentity,
      review: reviewAgentIdentity,
    },
  };

  const statusMatrix = {
    schemaVersion: 'workflow-w8-status-matrix.v1',
    cases: [
      {
        case: 'all-valid-ideas',
        expected: 'all valid normalized Ideas persisted and indexed',
        actual: 'passed',
      },
      {
        case: 'successful-publish',
        expected: 'analyzed with verified report and conclusion',
        actual: state.success.finalStatus,
      },
      {
        case: 'review-required',
        expected: 'review-required without a verified final package',
        actual: state.review.blockedStatus,
      },
      {
        case: 'human-resolution',
        expected: 'report-only r4 then normal verified publication',
        actual: state.review.finalStatus,
      },
      {
        case: 'snapshot-immutability',
        expected: 'original captured input after mutable source deletion',
        actual: snapshot.capturedValuesRecovered ? 'passed' : 'failed',
      },
      {
        case: 'idempotent-replay',
        expected: 'no duplicate snapshot, Project, Agent-success, or artifact keys; one authorized crash pause/resume pair',
        actual: (
          projectReplay.noDuplicateProjects
          && snapshot.duplicateSnapshotCount === 0
          && successAgentIdentity.duplicateSucceededIdentityCount === 0
          && reviewAgentIdentity.duplicateSucceededIdentityCount === 0
          && successAgentIdentity.authorizedPauseResumePairs === 1
          && artifactKeys.ideaGeneration.duplicateLogicalKeyCount === 0
          && artifactKeys.success.duplicateLogicalKeyCount === 0
          && artifactKeys.review.duplicateLogicalKeyCount === 0
        ) ? 'passed' : 'failed',
      },
      {
        case: 'crash-resume',
        expected: 'zero repeated successful nodes',
        actual: state.success.zeroRepeatedSuccessfulNodes ? 'passed' : 'failed',
      },
      {
        case: 'legacy-idea',
        expected: 'Project with explicit null run/snapshot linkage',
        actual: projectReplay.legacyMissingLinkageExplicit ? 'passed' : 'failed',
      },
    ],
  };

  const validation = [
    'W8 deterministic production-composition acceptance: PASSED',
    'External network/provider access: blocked by worker guard; attempts=0',
    `Idea Generation: ${fixture.run.runId} -> ${snapshot.snapshotId}`,
    `Success: analyzed=true reportReady=${state.success.reportReady}`,
    `Review: blocked=${state.review.blockedStatus} -> resolved=${state.review.finalStatus}`,
    'Crash/resume: previously successful canonical nodes re-executed=0',
    'Projection rebuild: global index exact; canonical folders/runs/artifacts/events retained',
    `Protected invariants: agents=${repository.agentCount} tools=${repository.toolCount}`,
  ].join('\n');

  return {
    schemaVersion: 'workflow-w8-worker-result.v1',
    phase,
    status: 'SUCCEEDED',
    networkGuardActive: true,
    blockedNetworkAttemptCount: 0,
    evidence: {
      summary,
      runRecord,
      lineage,
      statusMatrix,
      validation,
    },
  };
}

async function main() {
  assertWorkerBoundary();
  clearExternalConfiguration();
  const fixture = readJson(fixtureFile);
  const fixtureDigest = localDigest(fixture);
  const restoreClock = installFixedClock(phaseClock(fixture));
  const networkGuard = installDenyAllNetworkGuard({
    label: 'deterministic W8',
    errorCode: 'W8_NETWORK_BLOCKED',
  });
  try {
    const runtime = await loadRuntime(fixture, networkGuard);
    if (phase === 'prepare-analysis-crash') {
      return prepareAnalysisCrash(runtime, fixture, fixtureDigest);
    }
    const state = readJson(statePath);
    assert.equal(state.fixtureId, fixture.fixtureId);
    assert.equal(state.fixtureDigest, fixtureDigest);
    let result;
    if (phase === 'resume-success') {
      result = await resumeSuccess(runtime, fixture, state);
    } else if (phase === 'block-review') {
      result = await blockReview(runtime, fixture, state);
    } else if (phase === 'resolve-review') {
      result = await resolveReview(runtime, fixture, state);
    } else {
      result = await replayRebuild(runtime, fixture, state);
    }
    assertNoNetworkAttempts(networkGuard);
    return result;
  } finally {
    networkGuard.restore();
    restoreClock();
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const location = /w8DeterministicWorker\.mjs:(\d+):(\d+)/u
    .exec(String(error?.stack || ''));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'workflow-w8-worker-failure.v1',
    phase: PHASES.has(phase) ? phase : 'invalid',
    status: 'FAILED',
    errorCode: typeof error?.code === 'string'
      ? error.code
      : 'W8_WORKER_FAILED',
    errorLocation: location ? `${location[1]}:${location[2]}` : null,
    blockedChannels: Array.isArray(error?.blockedChannels)
      ? error.blockedChannels
      : [],
    detailCode: typeof error?.detailCode === 'string'
      ? error.detailCode
      : null,
    errorDigest: localDigest(String(error?.stack || error?.message || error)),
  })}\n`);
  process.exitCode = 1;
}
