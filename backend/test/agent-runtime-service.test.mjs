import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentRuntimeService } from '../src/agents/AgentRuntimeService.js';
import { getAgentDefinition, listAgentDefinitions } from '../src/agents/registry.js';
import { toolRegistry } from '../src/tools/toolCatalog.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-runtime-catalog-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let tick = 0;
  const service = new AgentRuntimeService({
    dataDir,
    definitions: listAgentDefinitions(),
    registry: toolRegistry,
    now: () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++)).toISOString(),
  });
  return { dataDir, service };
}

function quoteSkill(overrides = {}) {
  return {
    id: 'quote-discipline',
    name: 'Quote discipline',
    description: 'Use quote data before making price-sensitive claims.',
    instruction: 'Fetch and cite the current quote before making a price-sensitive claim.',
    toolIds: ['fmp_quote'],
    visibility: 'internal',
    ...overrides,
  };
}

test('Agent runtime catalog projects immutable definitions with safe overlay and skill fields', (t) => {
  const { dataDir, service } = fixture(t);
  const checkedIn = getAgentDefinition('data-orchestrator');
  const checkedInTools = [...checkedIn.toolPolicy.allow];
  const checkedInPurpose = checkedIn.purpose;

  const skill = service.createSkill(quoteSkill());
  assert.equal(skill.version, 1);
  assert.match(skill.createdAt, /^2026-07-20T/u);

  const updated = service.updateAgent('data-orchestrator', {
    displayName: 'Evidence Desk',
    description: 'Retrieve evidence under a narrowed runtime policy.',
    catalogVisibility: 'catalog',
    systemPrompt: 'Use the approved evidence workflow only.',
    toolAllow: ['fmp_quote'],
    assignedSkillIds: [skill.id],
  });

  assert.equal(updated.id, 'data-orchestrator');
  assert.equal(updated.displayName, 'Evidence Desk');
  assert.equal(updated.purpose, 'Retrieve evidence under a narrowed runtime policy.');
  assert.equal(updated.catalogVisibility, 'catalog');
  assert.deepEqual(updated.toolPolicy.allow, ['fmp_quote']);
  assert.ok(updated.contractToolAllow.includes('fmp_quote'));
  assert.ok(updated.contractToolAllow.includes('fmp_profile'));
  assert.deepEqual(updated.assignedSkillIds, ['quote-discipline']);
  assert.ok(updated.workflowNodeBindings.some((binding) => binding.nodeId === 'run-research-rounds'));
  assert.match(updated.baselineSystemPromptPreview, /DATA ORCHESTRATOR/u);
  assert.equal(updated.editableSystemPrompt, 'Use the approved evidence workflow only.');
  assert.match(updated.effectiveSystemPrompt, /^Use the approved evidence workflow only\./u);
  assert.match(updated.effectiveSystemPrompt, /quote-discipline@1/u);
  assert.match(updated.effectiveSystemPrompt, /Fetch and cite the current quote/u);
  assert.match(updated.effectiveConfig.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(updated.effectiveConfig.revision, /overlay@1/u);

  const summary = service.listAgents({ catalogVisibility: 'catalog' }).find((agent) => agent.id === 'data-orchestrator');
  assert.deepEqual(summary.contractToolAllow, checkedInTools);
  assert.deepEqual(summary.toolPolicy.allow, ['fmp_quote']);
  assert.equal(Object.hasOwn(summary, 'editableSystemPrompt'), false);
  assert.equal(Object.hasOwn(summary, 'effectiveSystemPrompt'), false);
  assert.equal(service.listAgents().length, listAgentDefinitions().length);

  const effective = service.getEffectiveDefinition('data-orchestrator');
  assert.notEqual(effective, checkedIn);
  assert.deepEqual(effective.toolPolicy.allow, ['fmp_quote']);
  assert.match(effective.prompt({}).system, /Assigned runtime skills follow/u);
  assert.equal(Object.isFrozen(effective), true);
  assert.equal(checkedIn.purpose, checkedInPurpose);
  assert.deepEqual(checkedIn.toolPolicy.allow, checkedInTools);

  const reloaded = new AgentRuntimeService({
    dataDir,
    definitions: listAgentDefinitions(),
    registry: toolRegistry,
  }).getAgent('data-orchestrator');
  assert.equal(reloaded.displayName, 'Evidence Desk');
  assert.deepEqual(reloaded.assignedSkillIds, ['quote-discipline']);
});

test('Agent overlays never expand tools and assigned skill tools must fit the effective allow list', (t) => {
  const { service } = fixture(t);
  service.createSkill(quoteSkill());

  assert.throws(
    () => service.updateAgent('analysis-plan', { toolAllow: ['fmp_quote'] }),
    (error) => error.code === 'AGENT_TOOL_POLICY_EXPANSION',
  );
  assert.throws(
    () => service.updateAgent('data-orchestrator', {
      toolAllow: [],
      assignedSkillIds: ['quote-discipline'],
    }),
    (error) => error.code === 'SKILL_TOOL_POLICY_VIOLATION',
  );
  assert.throws(
    () => service.updateAgent('data-orchestrator', { modelPolicy: { tier: 'main' } }),
    (error) => error.code === 'IMMUTABLE_AGENT_FIELD',
  );

  service.updateAgent('data-orchestrator', {
    toolAllow: ['fmp_quote'],
    assignedSkillIds: ['quote-discipline'],
  });
  assert.throws(
    () => service.updateSkill('quote-discipline', { toolIds: ['fmp_profile'] }),
    (error) => error.code === 'SKILL_TOOL_POLICY_VIOLATION',
  );
  assert.throws(
    () => service.deleteSkill('quote-discipline'),
    (error) => error.code === 'SKILL_ASSIGNED',
  );
  service.assignSkills('data-orchestrator', []);
  assert.equal(service.deleteSkill('quote-discipline').id, 'quote-discipline');
  assert.deepEqual(service.listSkills(), []);
});

test('Skills registry validates tool ids and increments durable versions on update', (t) => {
  const { service } = fixture(t);
  const created = service.createSkill(quoteSkill());
  const updated = service.updateSkill(created.id, {
    instruction: 'Check quote freshness and record the source timestamp.',
    visibility: 'catalog',
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.visibility, 'catalog');
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(service.getSkill(created.id).instruction, 'Check quote freshness and record the source timestamp.');
  assert.throws(
    () => service.createSkill(quoteSkill({ id: 'unknown-tool-skill', toolIds: ['not_a_tool'] })),
    (error) => error.code === 'UNKNOWN_SKILL_TOOL',
  );
});
