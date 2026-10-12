import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import {
  FileIdeaRunInputSnapshotStore,
  IDEA_RUN_EFFECTIVE_CONFIG_AGENTS,
  IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX,
  IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION,
  LEGACY_IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION,
} from '../src/domains/ideas/IdeaRunInputSnapshot.js';
import { capturedIdeaRoutes } from '../src/workflows/idea-generation/runtime/inputSnapshot.js';

const AS_OF = '2026-07-23T08:00:00.000Z';
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-run-snapshot-'));
  const runsDir = path.join(root, 'idea-generation', 'runs');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runsDir,
    store: new FileIdeaRunInputSnapshotStore({ runsDir }),
  };
}

function createInput({ runId = 'idea_run_20260723_1' } = {}) {
  return {
    runId,
    workflow: {
      id: 'idea-generation.v1',
      version: '1.0.0',
      hash: digest('a'),
    },
    asOf: AS_OF,
    inputs: {
      existingIdeas: [
        {
          id: 'idea_current_1',
          type: 'idea',
          status: 'new',
          title: 'Grid bottleneck beneficiaries',
          theme: 'power infrastructure',
          tickers: ['GEV', 'PWR'],
          contentRef: 'idea-generation/ideas/idea_current_1',
          contentDigest: digest('b'),
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T01:00:00.000Z',
        },
        {
          id: 'idea_legacy_1',
          type: 'idea',
          status: 'new',
          title: 'Legacy software idea',
          theme: 'software',
          tickers: ['MSFT'],
          createdAt: 1_752_000_000_000,
        },
      ],
      positions: [{
        id: 'pos_1',
        ticker: 'AAPL',
        name: 'Apple',
        theme: 'consumer hardware',
        reason: 'Installed-base resilience supports the thesis.',
        weight: 0.15,
        rank: 1,
        confidence: 0.72,
        status: 'active',
        addedAt: 1_752_000_000_000,
      }],
      mandate: {
        style: 'balanced',
        minMarketCap: 1e9,
        maxLeverage: 4,
        minCandidates: 3,
        maxCandidates: 24,
        maxHoldings: 10,
        convexityBonus: 0.15,
        horizonPref: '6-12M',
        allowDataGap: false,
        maxProjectAgeDays: 45,
      },
      settings: {
        DEFAULT_PROVIDER: 'openai-compatible',
        OPENAI_COMPATIBLE_MODEL: 'luna',
        OPENAI_COMPATIBLE_REASONING_LEVEL: 'medium',
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        SMALL_PROVIDER: '',
        SMALL_MODEL: '',
        MAIN_PROVIDER: '',
        MAIN_MODEL: '',
        REFLECTION_PROVIDER: 'openai-compatible',
        REFLECTION_MODEL: 'luna',
        UI_LANGUAGE: 'zh',
        ANALYSIS_LANGUAGE: 'en',
        REPORT_LANGUAGE: 'en',
        DEMO_MODE: false,
      },
      command: {
        count: 20,
        poolTarget: 20,
        targetPerNode: 8,
        tokenBudget: 180000,
      },
    },
    effectiveConfig: {
      agents: [
        {
          agentId: 'idea-generator',
          revision: 'definition@1.0.0;overlay@0;skills@none',
          digest: digest('c'),
        },
        {
          agentId: 'idea-quality-reviewer',
          revision: 'definition@1.0.0;overlay@0;skills@none',
          digest: digest('d'),
        },
      ],
    },
  };
}

function snapshotFile(runsDir, runId) {
  return path.join(runsDir, runId, 'input-snapshot.json');
}

function assertCode(expectedCode) {
  return (error) => error?.code === expectedCode;
}

test('Idea run snapshot captures the exact logical inputs with canonical stable identity', (t) => {
  const { runsDir, store } = fixture(t);
  const input = createInput();
  const first = store.create(input);

  assert.equal(first.schemaVersion, IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(first.runId, input.runId);
  assert.deepEqual(first.workflow, input.workflow);
  assert.equal(first.asOf, AS_OF);
  assert.deepEqual(first.inputs, input.inputs);
  assert.deepEqual(
    first.effectiveConfig.agents.map((agent) => agent.agentId),
    IDEA_RUN_EFFECTIVE_CONFIG_AGENTS,
  );
  for (const [name, value] of Object.entries(first.inputs)) {
    assert.equal(first.inputDigests[name], canonicalSha256(value));
  }
  assert.equal(first.configDigest, canonicalSha256(first.effectiveConfig));
  assert.equal(first.policyDigest, canonicalSha256({
    workflow: first.workflow,
    commandDigest: first.inputDigests.command,
  }));
  const {
    contentDigest: _contentDigest,
    snapshotId: _snapshotId,
    ...logicalRecord
  } = first;
  assert.equal(first.contentDigest, canonicalSha256(logicalRecord));
  assert.equal(
    first.snapshotId,
    `${IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX}${first.contentDigest.slice('sha256:'.length)}`,
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.inputs.positions[0]), true);
  assert.equal(fs.existsSync(snapshotFile(runsDir, input.runId)), true);
  assert.deepEqual(fs.readdirSync(path.join(runsDir, input.runId)), ['input-snapshot.json']);

  const reordered = structuredClone(input);
  reordered.workflow = {
    hash: input.workflow.hash,
    version: input.workflow.version,
    id: input.workflow.id,
  };
  reordered.inputs.settings = Object.fromEntries(
    Object.entries(input.inputs.settings).reverse(),
  );
  reordered.inputs.mandate = Object.fromEntries(
    Object.entries(input.inputs.mandate).reverse(),
  );
  reordered.effectiveConfig.agents.reverse();
  const replay = store.create(reordered);
  assert.deepEqual(replay, first);
});

test('same-run replay is idempotent and different logical content conflicts', (t) => {
  const { store } = fixture(t);
  const input = createInput();
  const first = store.create(input);
  assert.deepEqual(store.create(structuredClone(input)), first);

  const changedInput = structuredClone(input);
  changedInput.inputs.command.count = 12;
  assert.throws(
    () => store.create(changedInput),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_CONFLICT'),
  );

  const changedConfig = structuredClone(input);
  changedConfig.effectiveConfig.agents[0].digest = digest('e');
  assert.throws(
    () => store.create(changedConfig),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_CONFLICT'),
  );
});

test('restart resolution returns captured values after mutable sources change or disappear', (t) => {
  const { root, runsDir, store } = fixture(t);
  const input = createInput();
  const mutableIdeaDir = path.join(
    root,
    'idea-generation',
    'ideas',
    input.inputs.existingIdeas[0].id,
  );
  fs.mkdirSync(mutableIdeaDir, { recursive: true });
  const mutableIdeaAnchor = path.join(mutableIdeaDir, 'idea.json');
  fs.writeFileSync(mutableIdeaAnchor, JSON.stringify({
    body: input.inputs.existingIdeas[0],
  }));
  input.inputs.existingIdeas[0] = JSON.parse(
    fs.readFileSync(mutableIdeaAnchor, 'utf8'),
  ).body;
  const created = store.create(input);

  input.inputs.existingIdeas[0].title = 'MUTATED AFTER CAPTURE';
  input.inputs.positions[0].theme = 'MUTATED AFTER CAPTURE';
  input.inputs.settings.DEFAULT_PROVIDER = 'deepseek';
  fs.writeFileSync(mutableIdeaAnchor, JSON.stringify({
    body: input.inputs.existingIdeas[0],
  }));
  fs.rmSync(mutableIdeaDir, { recursive: true });

  const restarted = new FileIdeaRunInputSnapshotStore({ runsDir });
  const loaded = restarted.load(created.runId);
  const resolved = restarted.resolve(created.runId, created.snapshotId);
  assert.deepEqual(loaded, created);
  assert.deepEqual(resolved, created);
  assert.equal(resolved.inputs.existingIdeas[0].title, 'Grid bottleneck beneficiaries');
  assert.equal(resolved.inputs.positions[0].theme, 'consumer hardware');
  assert.equal(resolved.inputs.settings.DEFAULT_PROVIDER, 'openai-compatible');
  assert.throws(
    () => restarted.resolve(created.runId, `${IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX}${'f'.repeat(64)}`),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_IDENTITY_MISMATCH'),
  );
  assert.equal(restarted.load('missing_run'), null);
  assert.throws(
    () => restarted.resolve('missing_run', created.snapshotId),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_NOT_FOUND'),
  );
});

test('load and resolve recompute every digest and reject stored-record tampering', (t) => {
  const { runsDir, store } = fixture(t);
  const input = createInput();
  const original = store.create(input);
  const file = snapshotFile(runsDir, input.runId);
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tamperCases = [
    (record) => { record.inputs.positions[0].theme = 'tampered'; },
    (record) => { record.inputDigests.positions = digest('f'); },
    (record) => { record.policyDigest = digest('f'); },
    (record) => { record.configDigest = digest('f'); },
    (record) => { record.contentDigest = digest('f'); },
    (record) => { record.snapshotId = `${IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX}${'f'.repeat(64)}`; },
    (record) => { record.unexpected = true; },
    (record) => { record.runId = 'other_run'; },
  ];

  for (const tamper of tamperCases) {
    const record = structuredClone(valid);
    tamper(record);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    assert.throws(
      () => store.load(input.runId),
      assertCode('IDEA_RUN_INPUT_SNAPSHOT_CORRUPT'),
    );
  }

  fs.writeFileSync(file, '{not-json');
  assert.throws(
    () => store.load(input.runId),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_CORRUPT'),
  );

  fs.writeFileSync(file, JSON.stringify(valid, null, 2));
  assert.deepEqual(store.resolve(input.runId, original.snapshotId), original);
});

test('captured-value contracts reject unknown, sensitive, Project, path, and provider inputs', (t) => {
  const { store } = fixture(t);
  const cases = [
    (value) => { value.projectPath = '../projects/proj_1'; },
    (value) => { value.inputs.extra = {}; },
    (value) => { value.inputs.existingIdeas[0].evidence = []; },
    (value) => { value.inputs.positions[0].sources = [{ projectId: 'proj_1' }]; },
    (value) => { value.inputs.mandate.credentials = { apiKey: 'secret' }; },
    (value) => { value.inputs.settings.OPENAI_COMPATIBLE_API_KEY = 'sk-private-secret'; },
    (value) => { value.inputs.settings.OPENAI_COMPATIBLE_BASE_URL = 'https://private.invalid/v1'; },
    (value) => { value.inputs.command.messages = []; },
    (value) => { value.effectiveConfig.agents[0].providerPayload = { choices: [] }; },
    (value) => { value.inputs.existingIdeas[0].title = '../../.env'; },
    (value) => { value.inputs.positions[0].reason = 'Bearer private-session-token'; },
    (value) => { value.inputs.settings.OPENAI_COMPATIBLE_MODEL = 'https://private.invalid/model'; },
    (value) => { value.inputs.existingIdeas[0].contentRef = 'projects/proj_1/meta.json'; },
    (value) => { value.inputs.existingIdeas[0].contentRef = 'idea-generation/ideas/other_idea'; },
    (value) => { value.inputs.existingIdeas[0].contentRef = '/tmp/idea.json'; },
    (value) => { value.inputs.existingIdeas[0].contentRef = 'idea-generation\\ideas\\idea_current_1'; },
    (value) => { value.inputs.existingIdeas[0].contentRef = 'idea-generation/ideas/../idea_current_1'; },
    (value) => { value.inputs.existingIdeas[0].contentDigest = undefined; },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const input = createInput({ runId: `rejected_run_${index}` });
    cases[index](input);
    assert.throws(() => store.create(input), /IdeaRunInputSnapshot/u);
  }

  const accepted = store.create(createInput({ runId: 'token_budget_is_policy' }));
  assert.equal(accepted.inputs.command.tokenBudget, 180000);
  assert.equal(accepted.inputs.mandate.maxProjectAgeDays, 45);
});

test('the exact allowlists validate Idea refs, positions, mandate, settings, command, and config manifest', (t) => {
  const { store } = fixture(t);
  const cases = [
    (value) => { delete value.inputs.existingIdeas; },
    (value) => { value.inputs.existingIdeas[0].type = 'project'; },
    (value) => { delete value.inputs.existingIdeas[0].contentDigest; },
    (value) => { value.inputs.positions[0].weight = Number.NaN; },
    (value) => { value.inputs.mandate.allowDataGap = 'false'; },
    (value) => { value.inputs.settings.DEMO_MODE = 'false'; },
    (value) => { value.inputs.command.count = 0; },
    (value) => { value.workflow.version = 'v1'; },
    (value) => { value.workflow.hash = 'not-a-digest'; },
    (value) => { value.asOf = '2026-07-23'; },
    (value) => { value.effectiveConfig.agents.pop(); },
    (value) => { value.effectiveConfig.agents[1].agentId = 'idea-generator'; },
    (value) => { value.effectiveConfig.agents[1].agentId = 'project-classifier'; },
    (value) => { value.effectiveConfig.agents[0].digest = 'not-a-digest'; },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const input = createInput({ runId: `invalid_contract_${index}` });
    cases[index](input);
    assert.throws(() => store.create(input), /IdeaRunInputSnapshot/u);
  }
});

test('run identity is a strict direct child and cannot escape or alias the runs root', (t) => {
  const { runsDir, store } = fixture(t);
  const invalid = [
    '.',
    '..',
    '../escape',
    'nested/run',
    'nested\\run',
    '/tmp/absolute',
    'C:\\absolute',
    'nul\0run',
    'direct:idea-generation.v1:command',
    '-leading-dash',
    `r${'x'.repeat(128)}`,
  ];
  for (const runId of invalid) {
    assert.throws(() => store.create(createInput({ runId })));
  }
  assert.equal(fs.existsSync(runsDir), false);
});

test('runs root, run directory, snapshot file, and lock reject symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-idea-snapshot-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);

  const linkedRuns = path.join(root, 'linked-runs');
  fs.symlinkSync(outside, linkedRuns);
  assert.throws(
    () => new FileIdeaRunInputSnapshotStore({ runsDir: linkedRuns }).create(createInput()),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );

  const configuredData = path.join(root, 'configured-data');
  fs.mkdirSync(configuredData);
  const outsideGeneration = path.join(root, 'outside-generation');
  fs.mkdirSync(outsideGeneration);
  const linkedGeneration = path.join(configuredData, 'idea-generation');
  fs.symlinkSync(outsideGeneration, linkedGeneration, 'dir');
  assert.throws(
    () => new FileIdeaRunInputSnapshotStore({
      runsDir: path.join(linkedGeneration, 'runs'),
    }).create(createInput({ runId: 'idea_run_parent_symlink' })),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );
  assert.equal(fs.existsSync(path.join(outsideGeneration, 'runs')), false);

  const outsideData = path.join(root, 'outside-data');
  fs.mkdirSync(outsideData);
  const linkedData = path.join(root, 'linked-data');
  fs.symlinkSync(outsideData, linkedData, 'dir');
  assert.throws(
    () => new FileIdeaRunInputSnapshotStore({
      runsDir: path.join(linkedData, 'idea-generation', 'runs'),
    }).create(createInput({ runId: 'idea_run_data_symlink' })),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );
  assert.equal(fs.existsSync(path.join(outsideData, 'idea-generation')), false);

  const runsDir = path.join(root, 'runs');
  fs.mkdirSync(runsDir);
  fs.symlinkSync(outside, path.join(runsDir, 'idea_run_symlink'));
  const store = new FileIdeaRunInputSnapshotStore({ runsDir });
  assert.throws(
    () => store.create(createInput({ runId: 'idea_run_symlink' })),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );

  const fileRun = 'idea_run_file_symlink';
  fs.mkdirSync(path.join(runsDir, fileRun));
  const outsideFile = path.join(outside, 'snapshot.json');
  fs.writeFileSync(outsideFile, '{}');
  fs.symlinkSync(outsideFile, snapshotFile(runsDir, fileRun));
  assert.throws(
    () => store.load(fileRun),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );

  const brokenFileRun = 'idea_run_broken_file_symlink';
  fs.mkdirSync(path.join(runsDir, brokenFileRun));
  fs.symlinkSync(
    path.join(outside, 'missing-snapshot.json'),
    snapshotFile(runsDir, brokenFileRun),
  );
  assert.throws(
    () => store.load(brokenFileRun),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );

  const lockRun = 'idea_run_lock_symlink';
  fs.mkdirSync(path.join(runsDir, lockRun));
  fs.symlinkSync(outsideFile, path.join(runsDir, lockRun, '.input-snapshot.lock'));
  assert.throws(
    () => store.create(createInput({ runId: lockRun })),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );

  const brokenLockRun = 'idea_run_broken_lock_symlink';
  fs.mkdirSync(path.join(runsDir, brokenLockRun));
  fs.symlinkSync(
    path.join(outside, 'missing-lock'),
    path.join(runsDir, brokenLockRun, '.input-snapshot.lock'),
  );
  assert.throws(
    () => store.create(createInput({ runId: brokenLockRun })),
    assertCode('IDEA_RUN_INPUT_SNAPSHOT_SYMLINK'),
  );
});

test('snapshot storage reads only its exact run-owned record and never crawls global state or Projects', async (t) => {
  const { root, store } = fixture(t);
  fs.mkdirSync(path.join(root, 'projects', 'proj_private'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=must-not-be-read');
  fs.writeFileSync(
    path.join(root, 'projects', 'proj_private', 'meta.json'),
    JSON.stringify({ privatePayload: 'must-not-be-read' }),
  );

  const snapshot = store.create(createInput());
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /must-not-be-read/u);

  const source = await fs.promises.readFile(
    new URL('../src/domains/ideas/IdeaRunInputSnapshot.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /globalState|ProjectSpace|ProjectFS|Store\.|readdirSync/u);
});


test('legacy v1 gateway snapshots remain byte-valid and route through the canonical provider', (t) => {
  const { runsDir, store } = fixture(t);
  const input = createInput({ runId: 'legacy_gateway_snapshot' });
  input.inputs.settings = {
    ...input.inputs.settings,
    DEFAULT_PROVIDER: 'gpt-gateway',
    GPT_GATEWAY_MODEL: input.inputs.settings.OPENAI_COMPATIBLE_MODEL,
    GPT_GATEWAY_REASONING_LEVEL: input.inputs.settings.OPENAI_COMPATIBLE_REASONING_LEVEL,
    REFLECTION_PROVIDER: 'gpt-gateway',
  };
  delete input.inputs.settings.OPENAI_COMPATIBLE_MODEL;
  delete input.inputs.settings.OPENAI_COMPATIBLE_REASONING_LEVEL;
  const inputDigests = Object.fromEntries(Object.entries(input.inputs).map(([key, value]) => [key, canonicalSha256(value)]));
  const policyDigest = canonicalSha256({
    workflow: input.workflow,
    commandDigest: inputDigests.command,
  });
  const configDigest = canonicalSha256(input.effectiveConfig);
  const logicalRecord = {
    schemaVersion: LEGACY_IDEA_RUN_INPUT_SNAPSHOT_SCHEMA_VERSION,
    runId: input.runId,
    workflow: input.workflow,
    asOf: input.asOf,
    inputs: input.inputs,
    effectiveConfig: input.effectiveConfig,
    inputDigests,
    policyDigest,
    configDigest,
  };
  const contentDigest = canonicalSha256(logicalRecord);
  const snapshot = {
    ...logicalRecord,
    contentDigest,
    snapshotId: `${IDEA_RUN_INPUT_SNAPSHOT_ID_PREFIX}${contentDigest.slice('sha256:'.length)}`,
  };
  const file = snapshotFile(runsDir, input.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));

  const loaded = store.load(input.runId);
  assert.deepEqual(loaded, snapshot);
  assert.deepEqual(capturedIdeaRoutes(loaded), {
    generator: { provider: 'openai-compatible', model: 'luna' },
    reviewer: { provider: 'openai-compatible', model: 'luna' },
  });
});
