import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-w6-project-command-'));
process.env.FIN_DATA_DIR = dataDir;

const [
  { canonicalSha256 },
  { globalContentIndex },
  { IdeaStore },
  { createProjectFromIdea },
  { IDEA_TO_PROJECT_MAPPING_VERSION, mapIdeaToProjectSeed },
  { ProjectSpace },
] = await Promise.all([
  import('../src/core/contracts/ArtifactRef.js'),
  import('../src/core/persistence/GlobalContentIndex.js'),
  import('../src/domains/ideas/index.js'),
  import('../src/domains/ideas/createProjectFromIdea.js'),
  import('../src/domains/ideas/mapIdeaToProjectSeed.js'),
  import('../src/project-space/index.js'),
]);

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const W5_AS_OF = '2026-07-23T00:00:00.000Z';
const W5_CONFIG_DIGEST = canonicalSha256({ stage: 'w5', fixture: 'project-command' });

function w5Idea(overrides = {}) {
  return {
    id: 'idea_w6',
    title: 'Canonical English idea',
    titleZh: '规范中文标题',
    theme: 'power infrastructure',
    rationale: 'Grid bottlenecks may create an expectation gap.',
    tickers: ['PWR'],
    sourceRunId: 'idea_run_w6',
    sourceSnapshotId: 'idea_input_w6',
    sourceIdeaRunId: 'idea_run_w6',
    sourceRunInputSnapshotId: 'idea_input_w6',
    sourceRunAsOf: W5_AS_OF,
    sourceEffectiveConfigDigest: W5_CONFIG_DIGEST,
    sourceGeneratorTraceRef: 'trace:generator:w6',
    sourceQualityTraceRef: 'trace:quality:w6',
    ...overrides,
  };
}

function fakeDependencies({ idea = w5Idea(), writable = true, indexError = null } = {}) {
  const calls = [];
  const created = [];
  const updated = [];
  const projectStore = {
    list() { return [...created]; },
    withCreationLock(callback) {
      calls.push({ type: 'project-lock' });
      return callback();
    },
    create(meta, options) {
      calls.push({ type: 'project', options });
      const project = { ...meta, id: 'proj_w6', status: 'created' };
      created.push(project);
      return project;
    },
  };
  const ideaStore = {
    getIdea(id) {
      calls.push({ type: 'idea-read', id });
      return idea && id === idea.id ? { ...idea } : null;
    },
    isWritable() { return writable; },
    withProjectAssociationLock(id, callback) {
      calls.push({ type: 'idea-lock', id });
      return callback();
    },
    associateProject(id, projectId, options) {
      const patch = { status: 'added', associatedProjectIds: [projectId] };
      calls.push({ type: 'idea-update', id, options });
      updated.push({ id, patch });
      return { ...idea, ...patch };
    },
  };
  const index = {
    rebuild() {
      calls.push({ type: 'index' });
      if (indexError) throw indexError;
      return { entries: [] };
    },
  };
  const templateSystem = {
    get(id) { return id ? { id } : null; },
    matchIndustryTemplate() { return { template: { id: 'industry_generic' }, score: 0 }; },
    matchCompanyTemplate() { return { template: { id: 'company_generic' }, score: 0 }; },
  };
  return {
    calls,
    created,
    updated,
    projectStore,
    ideaStore,
    index,
    templateSystem,
    defaults: { ANALYSIS_LANGUAGE: 'en', REPORT_LANGUAGE: 'zh' },
  };
}

function runCreationWorker(title) {
  const worker = fileURLToPath(
    new URL('./helpers/create-project-command-worker.mjs', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, dataDir, title], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`creation worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

test('mapIdeaToProjectSeed is a pure canonical mapping with Idea precedence', () => {
  const idea = w5Idea();
  const seed = mapIdeaToProjectSeed({
    idea,
    title: 'Caller title must not win',
    rationale: 'Caller rationale must not win',
    tickers: ['WRONG'],
    industryTemplate: 'industry_supply_bottleneck',
    companyTemplate: 'company_supply_bottleneck',
  });

  assert.deepEqual(seed, {
    title: idea.title,
    theme: idea.theme,
    industryTemplate: 'industry_supply_bottleneck',
    companyTemplate: 'company_supply_bottleneck',
    rationale: idea.rationale,
    tickers: idea.tickers,
    titleZh: idea.titleZh,
  });
});

test('createProjectFromIdea commits exact W5 linkage and Idea association before one index rebuild', () => {
  const deps = fakeDependencies();
  const project = createProjectFromIdea({
    ideaId: 'idea_w6',
    sourceIdeaRunId: 'forged-run',
    sourceRunInputSnapshotId: 'forged-snapshot',
  }, deps);

  assert.equal(project.status, 'created');
  assert.equal(project.sourceIdeaId, 'idea_w6');
  assert.equal(project.sourceIdeaRunId, 'idea_run_w6');
  assert.equal(project.sourceRunInputSnapshotId, 'idea_input_w6');
  assert.equal(project.projectSeedMappingVersion, IDEA_TO_PROJECT_MAPPING_VERSION);
  assert.match(project.projectCreationKey, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(deps.updated, [{
    id: 'idea_w6',
    patch: { status: 'added', associatedProjectIds: ['proj_w6'] },
  }]);
  assert.deepEqual(
    deps.calls.filter((call) => ['project', 'idea-update', 'index'].includes(call.type)),
    [
      { type: 'project', options: { refreshIndex: false } },
      { type: 'idea-update', id: 'idea_w6', options: { refreshIndex: false } },
      { type: 'index' },
    ],
  );
});

test('missing requested Idea fails exact lookup even when fallback title exists', () => {
  const deps = fakeDependencies({ idea: null });
  assert.throws(
    () => createProjectFromIdea({ ideaId: 'missing', title: 'Must not degrade' }, deps),
    (error) => error?.code === 'IDEA_NOT_FOUND' && error?.statusCode === 404,
  );
  assert.equal(deps.created.length, 0);
});

test('legacy and free-text Projects record unavailable lineage honestly', () => {
  const legacyDeps = fakeDependencies({
    idea: w5Idea({
      sourceRunId: undefined,
      sourceSnapshotId: undefined,
      sourceIdeaRunId: undefined,
      sourceRunInputSnapshotId: undefined,
    }),
    writable: false,
  });
  const legacy = createProjectFromIdea({ ideaId: 'idea_w6' }, legacyDeps);
  assert.equal(legacy.sourceIdeaId, 'idea_w6');
  assert.equal(legacy.sourceIdeaRunId, null);
  assert.equal(legacy.sourceRunInputSnapshotId, null);
  assert.deepEqual(legacyDeps.updated, []);

  const freeTextDeps = fakeDependencies({ idea: null });
  const freeText = createProjectFromIdea({
    title: 'Manual Project',
    tickers: [],
    source: 'idea',
    sourceText: 'manual input',
  }, freeTextDeps);
  assert.equal(freeText.source, 'manual');
  assert.equal(freeText.sourceIdeaId, null);
  assert.equal(freeText.sourceIdeaRunId, null);
  assert.equal(freeText.sourceRunInputSnapshotId, null);
  assert.equal(freeText.status, 'created');
});

test('projection failure cannot roll back a committed Project or Idea association', () => {
  const deps = fakeDependencies({ indexError: new Error('index unavailable') });
  const project = createProjectFromIdea({ ideaId: 'idea_w6' }, deps);
  assert.equal(project.id, 'proj_w6');
  assert.equal(deps.created.length, 1);
  assert.equal(deps.updated.length, 1);
});

test('association failure exposes the committed Project and retry reuses it', () => {
  const deps = fakeDependencies();
  const associate = deps.ideaStore.associateProject.bind(deps.ideaStore);
  let attempts = 0;
  deps.ideaStore.associateProject = (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('association unavailable');
    return associate(...args);
  };

  assert.throws(
    () => createProjectFromIdea({ ideaId: 'idea_w6' }, deps),
    (error) => (
      error?.code === 'IDEA_PROJECT_ASSOCIATION_FAILED'
      && error?.projectId === 'proj_w6'
      && /^sha256:[a-f0-9]{64}$/u.test(error?.projectCreationKey)
    ),
  );
  const recovered = createProjectFromIdea({ ideaId: 'idea_w6' }, deps);

  assert.equal(recovered.id, 'proj_w6');
  assert.equal(deps.created.length, 1);
  assert.equal(deps.updated.length, 1);
  assert.equal(deps.calls.filter((call) => call.type === 'index').length, 2);
});

test('cross-process same-key free-text creation commits exactly one Project', async () => {
  const title = 'Concurrent deterministic free-text command';
  const [left, right] = await Promise.all([
    runCreationWorker(title),
    runCreationWorker(title),
  ]);

  assert.equal(left.id, right.id);
  assert.equal(left.projectCreationKey, right.projectCreationKey);
  assert.equal(
    ProjectSpace.list().filter((project) => project.title === title).length,
    1,
  );
});

test('real folder commits preserve lineage when the global index is lost and rebuilt', () => {
  const [idea] = IdeaStore.addIdeas([w5Idea()], {
    sourceRunId: 'idea_run_w6',
    sourceSnapshotId: 'idea_input_w6',
  });
  const project = createProjectFromIdea({ ideaId: idea.id });
  const associated = IdeaStore.getIdea(idea.id);

  assert.equal(project.status, 'created');
  assert.equal(project.sourceIdeaId, idea.id);
  assert.equal(project.sourceIdeaRunId, idea.sourceIdeaRunId);
  assert.equal(project.sourceRunInputSnapshotId, idea.sourceRunInputSnapshotId);
  assert.deepEqual(associated.associatedProjectIds, [project.id]);
  IdeaStore.associateProject(idea.id, 'proj_second', { refreshIndex: false });
  assert.deepEqual(
    IdeaStore.getIdea(idea.id).associatedProjectIds,
    [project.id, 'proj_second'],
  );

  fs.rmSync(path.join(dataDir, 'global', 'index.json'), { force: true });
  const repaired = globalContentIndex.read();
  const repairedIdentities = repaired.entries.map(({ type, id }) => `${type}:${id}`);
  assert.equal(repairedIdentities.includes(`idea:${idea.id}`), true);
  assert.equal(repairedIdentities.includes(`project:${project.id}`), true);
  assert.equal(ProjectSpace.meta(project.id).sourceIdeaRunId, 'idea_run_w6');
});

test('Project creation command has no Run Analysis, Agent, or provider execution edge', () => {
  const commandSource = fs.readFileSync(
    new URL('../src/domains/ideas/createProjectFromIdea.js', import.meta.url),
    'utf8',
  );
  const mapperSource = fs.readFileSync(
    new URL('../src/domains/ideas/mapIdeaToProjectSeed.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(commandSource, /run-analysis|runAnalysis|runDefinedAgent|provider/iu);
  assert.doesNotMatch(commandSource, /project-space\/index\.js/iu);
  assert.doesNotMatch(mapperSource, /^import\s/mu);
});
