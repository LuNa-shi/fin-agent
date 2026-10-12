import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DIRECT_AGENT_ASSET_CASES,
  RESEARCH_AGENT_ASSET_CASES,
} from '../scripts/support/expertAssetCases.js';
import {
  captureDirectAgentAssets,
  captureResearchAgentAssets,
  captureWorldviewAgentAssets,
} from '../scripts/agentAssetSnapshot.mjs';
import { listRunAnalysisAgentDefinitions } from '../src/agents/registry.js';

const fixtureUrl = (name) => new URL(`./fixtures/agent-assets/v1/${name}`, import.meta.url);
const readFixture = async (name) => JSON.parse(await readFile(fixtureUrl(name), 'utf8'));


const DIRECT_AGENT_IDS = Object.freeze([
  'report-overview',
  'idea-generator',
  'idea-quality-reviewer',
  'project-classifier',
  'report-editor',
  'deal-ladder-ranking',
  'idea-ranking',
  'report-translator',
]);

test('expert asset cases cover every active Run Analysis definition and direct model role', () => {
  const contractIds = listRunAnalysisAgentDefinitions().map((contract) => contract.id).sort();
  const coveredResearchIds = [...new Set(RESEARCH_AGENT_ASSET_CASES.map((item) => item.agentId))].sort();
  const coveredDirectIds = [...new Set(DIRECT_AGENT_ASSET_CASES.map((item) => item.agentId))].sort();

  assert.deepEqual(coveredResearchIds, contractIds);
  assert.deepEqual(coveredDirectIds, [...DIRECT_AGENT_IDS].sort());

  const caseKeys = [
    ...RESEARCH_AGENT_ASSET_CASES.map((item) => `${item.agentId}/${item.caseId}`),
    ...DIRECT_AGENT_ASSET_CASES.map((item) => `${item.agentId}/${item.caseId}`),
  ];
  assert.equal(new Set(caseKeys).size, caseKeys.length, 'agent asset case ids must be unique');
});

test('research Agent System Prompts and Tool Use match the approved Golden', async () => {
  const expected = await readFixture('research-agents.json');
  const actual = await captureResearchAgentAssets();

  assert.equal(actual.schemaVersion, 1);
  assert.deepEqual(actual, expected);
  for (const asset of Object.values(actual.assets)) {
    assert.ok(asset.systemPrompt.length > 0);
    assert.ok(Array.isArray(asset.toolUse.allow));
  }
});

test('direct Agent System Prompts and Tool Use match the approved Golden', async () => {
  const expected = await readFixture('direct-agents.json');
  const actual = await captureDirectAgentAssets();

  assert.equal(actual.schemaVersion, 1);
  assert.deepEqual(actual, expected);
  for (const asset of Object.values(actual.assets)) {
    assert.ok(asset.systemPrompt.length > 0);
    assert.ok(Array.isArray(asset.toolUse.allow));
  }
});

test('Worldview Agent System Prompts and Tool Use match their dedicated Golden', async () => {
  const expected = await readFixture('worldview-agents.json');
  const actual = await captureWorldviewAgentAssets();
  assert.equal(actual.schemaVersion, 1);
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual.assets).map((key) => actual.assets[key].agentId), ['core-worldview']);
});

test('Tool Registry remains separate from investment-expert Tool Use policy', async () => {
  const [registrySource, catalogSource] = await Promise.all([
    readFile(new URL('../src/core/tools/ToolRegistry.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/tools/toolCatalog.js', import.meta.url), 'utf8'),
  ]);

  for (const source of [registrySource, catalogSource]) {
    assert.doesNotMatch(source, /AGENT_TOOLSETS|ANALYSIS_TOOLS|agentToolTable|toolsForAgent/u);
  }
});
