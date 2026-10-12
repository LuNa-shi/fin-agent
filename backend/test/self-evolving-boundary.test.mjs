import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = async (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const RESEARCH_FLOW_FILES = Object.freeze([
  'src/workflows/run-analysis/runAnalysis.workflow.js',
  'src/workflows/run-analysis/research/dataRound.js',
  'src/workflows/run-analysis/research/industryRound.js',
  'src/workflows/run-analysis/research/companyRound.js',
  'src/domains/research/templates/templateSystem.js',
]);

const REMOVED_SELF_EVOLVING_FILES = Object.freeze([
  'src/agents/adaptors/adaptorMemory.js',
  'src/agents/experience.js',
  'src/agents/beliefStore.js',
  'src/agents/attribution.js',
  'src/agents/verifier.js',
  'src/systems/claimsSystem.js',
  'src/systems/scheduler.js',
  'src/lib/calibration.js',
]);

test('Run Analysis has no active Self-evolving dependency edge', async () => {
  for (const filename of RESEARCH_FLOW_FILES) {
    const text = await source(filename);
    assert.doesNotMatch(text, /from ['"].*(?:experience|beliefStore|claimsSystem|adaptorMemory)\.js['"]/u, filename);
  }

  const activeWorkflow = (await Promise.all([
    source('src/workflows/run-analysis/runAnalysis.js'),
    source('src/workflows/run-analysis/handlers/synthesizeConclusion.js'),
  ])).join('\n');
  assert.doesNotMatch(activeWorkflow, /\bexperienceFor\s*\(/u);
  assert.doesNotMatch(activeWorkflow, /\bClaims\.add\s*\(/u);
  assert.doesNotMatch(activeWorkflow, /\bBeliefStore\.ingestProject\s*\(/u);
  assert.match(activeWorkflow, /setAnalysisFile\(id, ['"]claims\.json['"]/u,
    'falsifiable conclusion claims remain a project-local report artifact');
});



test('expert-owned prompt and Tool Use Golden remains a mandatory companion gate', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/agent-assets/v1/research-agents.json', import.meta.url), 'utf8'));
  assert.ok(fixture.assets['conclusion-synthesizer/default'].systemPrompt.includes('falsifiable claims'));
});

test('Idea and Decision product flows have no active learning-store dependency', async () => {
  for (const filename of [
    'src/workflows/idea-generation/ideaSystem.js',
    'src/domains/decision/decisionSystem.js',
    'src/domains/decision/portfolioAgent.js',
    'src/domains/decision/thesisContract.js',
  ]) {
    const text = await source(filename);
    assert.doesNotMatch(text, /from ['"].*(?:beliefStore|claimsSystem|attribution|calibration)\.js['"]/u, filename);
    assert.doesNotMatch(text, /\b(?:BeliefStore|Claims)\./u, filename);
  }

  const idea = await source('src/workflows/idea-generation/ideaSystem.js');
  assert.doesNotMatch(idea, /\bStore\.getReflections\s*\(|\bWorldEngine\./u);

  const portfolio = await source('src/domains/decision/portfolioAgent.js');
  assert.doesNotMatch(portfolio, /\boptimismDiscount\s*\(|\bshrinkOdds\s*\(|\bbeliefSupport\b/u);
});

test('Deal Ladder ignores obsolete belief support while its expert System Prompt stays frozen', async () => {
  const { _internal } = await import('../src/domains/decision/dealLadder.js');
  const base = { recommendationScore: 75, odds: { skew: 2, expectedReturnPct: 20 } };
  const positive = _internal.seedPlayer({ ...base, beliefSupport: 2 }, {});
  const negative = _internal.seedPlayer({ ...base, beliefSupport: -2 }, {});

  assert.deepEqual(positive, negative);

  const fixture = JSON.parse(await readFile(new URL('./fixtures/agent-assets/v1/direct-agents.json', import.meta.url), 'utf8'));
  assert.ok(fixture.assets['deal-ladder-ranking/five-candidates'].systemPrompt.includes('belief support'));
});

test('server exposes no Self-evolving route, status projection, or startup hook', async () => {
  const server = await source('src/server.js');
  const store = await source('src/core/persistence/globalState.js');

  assert.doesNotMatch(server, /from ['"].*(?:adaptorMemory|claimsSystem|scheduler|attribution)\.js['"]/u);
  assert.doesNotMatch(server, /\/api\/(?:learning|scheduler|engine\/review|adaptors\/(?:memory|:scope\/memory|:scope\/human))/u);
  assert.doesNotMatch(server, /\bScheduler\.(?:start|status|setEnabled|runDailyNow|runWeeklyNow)\s*\(/u);
  assert.doesNotMatch(server, /\bWorldEngine\.reviewForecast\s*\(/u);
  assert.doesNotMatch(server, /\b(?:brier|beliefs|recentBeliefs|beliefsByScope)\b/u);
  assert.match(server, /\/api\/projects\/:id\/files/u, 'generic access to historical project artifacts remains');

  assert.doesNotMatch(store, /memorySnapshot|_memory_snapshot/u);
});

test('frontend exposes no Self-evolving navigation, API, or feedback controls', async () => {
  const frontend = async (relativePath) => source(`../frontend/${relativePath}`);
  const app = await frontend('src/App.jsx');
  const api = await frontend('src/api.js');
  const idea = await frontend('src/views/IdeaView.jsx');
  const decision = await frontend('src/views/DecisionView.jsx');
  const settings = await frontend('src/views/SettingsModal.jsx');

  for (const deletedView of ['src/views/EngineView.jsx', 'src/views/LearningView.jsx']) {
    await assert.rejects(() => frontend(deletedView), (error) => error?.code === 'ENOENT');
  }
  assert.doesNotMatch(app, /LearningView|view === ['"]learning['"]|学习回顾|研究观点|能力进化/u);
  assert.match(api, /\/api\/claims/u, 'the read-only Claim Library is an active product surface');
  assert.doesNotMatch(api, /\/api\/(?:learning|scheduler|engine\/review|adaptors\/)|reviewForecast|adaptorMemory|saveAdaptorHumanMemory/u);
  assert.doesNotMatch(idea, /ctx\.(?:reflections|engine)|历史反思|观点库/u);
  assert.doesNotMatch(decision, /beliefSupport|beliefsTouched|claimIds|学习回顾|自动核对|注入后续分析|观点库与经验库/u);
  assert.doesNotMatch(settings, /GlobalExperiencePanel|TemplateAdaptorLibrary|adaptorMemory|saveAdaptorHumanMemory|系统自学习|长期研究观点/u);
});

test('Self-evolving implementation is deleted from the current tree with no compatibility shell', async () => {
  for (const filename of REMOVED_SELF_EVOLVING_FILES) {
    await assert.rejects(() => source(filename), (error) => error?.code === 'ENOENT', filename);
  }

  const schemas = await source('src/lib/schemas.js');
  const templates = await source('src/domains/research/templates/templateSystem.js');
  const decision = await source('src/domains/decision/decisionSystem.js');
  await assert.rejects(() => source('src/core/agent-backend/legacy/runtime.js'), (error) => error?.code === 'ENOENT');
  const dataAgent = await source('src/workflows/run-analysis/research/dataAgent.js');
  const analysisAgents = await source('src/workflows/run-analysis/research/analysisSubAgents.js');
  const idea = await source('src/workflows/idea-generation/ideaSystem.js');
  const config = await source('src/config.js');
  const decisionView = await source('../frontend/src/views/DecisionView.jsx');

  assert.doesNotMatch(schemas, /belief-sync/u);
  assert.doesNotMatch(templates, /adaptorGuidance|humanMemory/u);
  assert.doesNotMatch(decision, /\bsignal\s*:|强化相关信念|最强学习|回灌逆向证据/u);
  assert.doesNotMatch(dataAgent, /\bexperience\s*=/u);
  assert.doesNotMatch(analysisAgents, /\bexperience\s*=/u);
  assert.doesNotMatch(idea, /\breflections\s*:|\bengine\s*:|Belief store:/u);
  assert.doesNotMatch(config, /experienceFor|Brier|Claims 可验证|appendSelfLesson|学习看板/u);
  assert.doesNotMatch(decisionView, /optimismDiscount|乐观折价|期望收益收缩系数/u);
});
