import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  IDEA_GENERATION_WORKFLOW,
  ideaGenerationProgress,
  ideaGenerationTrace,
  ideaGenerationTraces,
  runIdeaGenerationWorkflow,
} from '../src/workflows/idea-generation/ideaGeneration.workflow.js';
import {
  collectForumIdeas,
  collectNewsIdeas,
  collectPortfolioIdeas,
  collectResearchIdeas,
  runSourceDiscoveryNodes,
  selectSourceCandidates,
} from '../src/workflows/idea-generation/nodes/sourceDiscovery.js';

test('Idea Generation workflow declares the complete deterministic/model node sequence', () => {
  assert.equal(IDEA_GENERATION_WORKFLOW.id, 'idea-generation.v2');
  assert.equal(IDEA_GENERATION_WORKFLOW.version, '2.0.0');
  assert.deepEqual(IDEA_GENERATION_WORKFLOW.nodes.map((node) => node.id), [
    'collect-market-context',
    'build-diversification-constraints',
    'generate-candidates',
    'verify-candidates',
    'review-quality',
    'persist-ideas',
  ]);
  assert.equal(Object.isFrozen(IDEA_GENERATION_WORKFLOW), true);
  assert.equal(Object.isFrozen(IDEA_GENERATION_WORKFLOW.nodes), true);
  for (const value of [runIdeaGenerationWorkflow, ideaGenerationProgress, ideaGenerationTraces, ideaGenerationTrace]) {
    assert.equal(typeof value, 'function');
  }
});

test('source collectors are deterministic workflow nodes, not Agent definitions', async () => {
  for (const value of [
    collectNewsIdeas,
    collectForumIdeas,
    collectPortfolioIdeas,
    collectResearchIdeas,
    runSourceDiscoveryNodes,
    selectSourceCandidates,
  ]) assert.equal(typeof value, 'function');

  const source = await readFile(new URL('../src/workflows/idea-generation/nodes/sourceDiscovery.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /defineAgent|runDefinedAgent|runIdeaAgent/u);
  await assert.rejects(access(new URL('../src/agents/ideaAgents.js', import.meta.url)));
});

test('source candidate selection retains deterministic deduplication and quality ordering', () => {
  const selected = selectSourceCandidates([
    { title: 'A', heat: 50, evidence: [{}] },
    { title: 'A', heat: 90, evidence: [{}, {}] },
    { title: 'B', heat: 60, evidence: [{}, {}] },
  ], [], 10);

  assert.deepEqual(selected.map((item) => item.title), ['B', 'A']);
  assert.deepEqual(selected.map((item) => item.qualityScore), [68, 54]);
});

test('portfolio source collection uses only the explicitly supplied Portfolio input', async () => {
  const result = await collectPortfolioIdeas({
    portfolio: [{
      ticker: 'PWR',
      theme: 'power infrastructure',
      reason: 'Grid investment cycle',
    }],
    target: 8,
  });

  assert.equal(result.agent, 'portfolio-idea-agent');
  assert.equal(result.ideas.length, 1);
  assert.deepEqual(result.ideas[0].tickers, ['PWR']);
  const source = await readFile(
    new URL('../src/workflows/idea-generation/nodes/sourceDiscovery.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /globalState|ProjectSpace|ProjectFS|\.getPortfolio\s*\(|\.list\s*\(/u);
});

test('IdeaSystem is the product API facade over workflow-owned generation state', async () => {
  const [systemSource, workflowSource, compositionSource, generatorSource, reviewerSource] = await Promise.all([
    readFile(new URL('../src/workflows/idea-generation/ideaSystem.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/ideaGeneration.workflow.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/runIdeaGeneration.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/handlers/generateCandidates.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/handlers/reviewQuality.js', import.meta.url), 'utf8'),
  ]);

  assert.match(systemSource, /runIdeaGenerationWorkflow/u);
  assert.match(systemSource, /ideaGenerationProgress/u);
  assert.match(systemSource, /ideaGenerationTraces/u);
  assert.doesNotMatch(systemSource, /runIdeaAgent|getAgentDefinition|runSourceDiscoveryNodes|startLive|stepBegin|appendTrace|demoGenerateIdeas/u);

  assert.match(workflowSource, /Compatibility façade/u);
  assert.doesNotMatch(workflowSource, /liveRun|idea-traces\.jsonl|appendTrace/u);
  assert.match(compositionSource, /executeWorkflowSpec\s*\(/u);
  assert.match(generatorSource, /runDefinedAgent\s*\(\s*['"]idea-generator['"]/u);
  assert.match(reviewerSource, /runDefinedAgent\s*\(\s*['"]idea-quality-reviewer['"]/u);
  assert.doesNotMatch(workflowSource, /runIdeaAgent/u);
  assert.doesNotMatch(compositionSource, /runAnalysis|startAnalysisJob|\/analyze/u);
});
