import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getAgentDefinition,
  listAgentDefinitions,
} from '../src/agents/registry.js';
import { ideaGeneratorAgent } from '../src/agents/definitions/idea-generation/idea-generator.agent.js';
import { ideaQualityReviewerAgent } from '../src/agents/definitions/idea-generation/idea-quality-reviewer.agent.js';
import { projectClassifierAgent } from '../src/agents/definitions/idea-generation/project-classifier.agent.js';
import { validateJsonSchema } from '../src/core/validation/OutputGate.js';
import { getAgentSchema } from '../src/core/validation/agentSchemaRegistry.js';
import { beginDirectAgentCommand } from '../src/core/contracts/AgentExecutionScope.js';
import { getIdeaSchema } from '../src/domains/ideas/contracts/schemaRegistry.js';
import { classifyProjectSeed } from '../src/workflows/idea-generation/ideaGeneration.workflow.js';

const DEFINITIONS = Object.freeze([
  ['idea-generator', ideaGeneratorAgent, 'idea-generator.agent.js', 'ideaArtifact.v1'],
  ['idea-quality-reviewer', ideaQualityReviewerAgent, 'idea-quality-reviewer.agent.js', 'ideaReview.v1'],
  ['project-classifier', projectClassifierAgent, 'project-classifier.agent.js', 'projectSeed.v1'],
]);

test('Idea model roles own independent registered definitions and versioned schemas', async () => {
  const registrySource = await readFile(new URL('../src/agents/registry.js', import.meta.url), 'utf8');

  for (const [id, definition, filename, schemaId] of DEFINITIONS) {
    assert.equal(definition.id, id);
    assert.equal(definition.domain, 'idea-generation');
    assert.equal(definition.executionMode, 'json');
    assert.equal(definition.outputSchema, schemaId);
    assert.equal(getAgentDefinition(id), definition);
    assert.deepEqual(definition.toolPolicy.allow, []);
    assert.deepEqual(definition.toolPolicy.writeScopes, []);
    assert.ok(definition.visibility.catalog);
    assert.ok(definition.visibility.workflows.length > 0);
    assert.equal(getIdeaSchema(schemaId), getAgentSchema(schemaId));
    assert.match(registrySource, new RegExp(`from ['"].*${filename.replace('.', '\\.')}['"]`, 'u'));

    const source = await readFile(new URL(`../src/agents/definitions/idea-generation/${filename}`, import.meta.url), 'utf8');
    assert.match(source, /defineAgent\s*\(/u);
    assert.match(source, /system\s*:/u);
    assert.match(source, /toolPolicy\s*:/u);
    assert.match(source, /outputSchema\s*:/u);
    assert.match(source, /visibility\s*:/u);
  }
});

test('Idea schemas accept the current expert outputs and reject malformed boundaries', () => {
  const ideaArtifact = {
    ideas: [{
      title: 'A differentiated idea', theme: 'industrials', heat: 80,
      rationale: 'Reason', tickers: ['GEV'], catalyst: 'Event', edge: 'Variant view',
      titleZh: '差异化机会', rationaleZh: '逻辑', catalystZh: '催化剂', edgeZh: '预期差',
    }],
  };
  const ideaReview = { selected: [{ index: 0, score: 88, reason: 'Strong catalyst and differentiated edge.' }] };
  const projectSeed = {
    title: 'Grid bottleneck beneficiaries', theme: 'power', industryTemplate: 'industry_generic',
    companyTemplate: 'company_generic', rationale: 'A structural supply-demand gap.', tickers: ['GEV'], titleZh: '电网瓶颈受益者',
  };

  assert.deepEqual(validateJsonSchema(ideaArtifact, getIdeaSchema('ideaArtifact.v1')), []);
  assert.deepEqual(validateJsonSchema(ideaReview, getIdeaSchema('ideaReview.v1')), []);
  assert.deepEqual(validateJsonSchema(projectSeed, getIdeaSchema('projectSeed.v1')), []);
  assert.ok(validateJsonSchema({ ideas: [{ title: 'missing fields' }] }, getIdeaSchema('ideaArtifact.v1')).length > 0);
  assert.ok(validateJsonSchema({ selected: [{ index: -1, score: 101, reason: '' }] }, getIdeaSchema('ideaReview.v1')).length > 0);
  assert.ok(validateJsonSchema({ title: 'missing seed fields' }, getIdeaSchema('projectSeed.v1')).length > 0);
});

test('all three Idea roles are projected from the unified Agent registry', () => {
  const registeredIdeaIds = listAgentDefinitions()
    .filter((definition) => definition.domain === 'idea-generation')
    .map((definition) => definition.id)
    .sort();
  assert.deepEqual(registeredIdeaIds, DEFINITIONS.map(([id]) => id).sort());
});

test('canonical Idea Generation Agents pin the versioned 15-minute hard deadline', () => {
  for (const definition of [ideaGeneratorAgent, ideaQualityReviewerAgent]) {
    assert.equal(definition.version, '1.0.1');
    assert.equal(definition.runPolicy.deadlineMs, 900000);
  }
});

test('Idea classification constructs its request through the direct execution scope', async () => {
  const calls = [];
  const backend = {
    async run(request, runtime) {
      calls.push({ request, runtime });
      return {
        status: 'succeeded',
        output: {
          title: 'Grid bottleneck beneficiaries',
          theme: 'power',
          industryTemplate: 'industry_generic',
          companyTemplate: 'company_generic',
          rationale: 'A structural supply-demand gap.',
          tickers: ['GEV'],
          titleZh: '电网瓶颈受益者',
        },
        artifacts: [],
        evidenceRefs: [],
        openQuestions: [],
        dataRequests: [],
        metrics: {},
        stopReason: 'final',
        traceRef: request.runId,
        valid: true,
      };
    },
  };
  const scope = beginDirectAgentCommand({
    commandId: 'classify-command-1',
    workflowId: 'quick-project.v1',
    nodeId: 'classify-project-seed',
    projectId: 'global',
    asOf: '2026-07-16T00:00:00.000Z',
    workspaceMode: 'none',
  });

  await classifyProjectSeed('grid bottleneck', {
    agentBackend: backend,
    executionScope: scope,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.agentContractId, 'project-classifier');
  assert.equal(calls[0].request.contractVersion, projectClassifierAgent.version);
  assert.equal(calls[0].request.workflowId, scope.workflowId);
  assert.equal(calls[0].request.asOf, scope.asOf);
  assert.equal(calls[0].request.workspaceSnapshotId, scope.workspaceSnapshotId);
  assert.equal(calls[0].request.idempotencyKeyMode, 'explicit');
  assert.equal(calls[0].runtime.temperature, 0.4);
  assert.equal(calls[0].runtime.artifactCommitOwner, 'agent');
  assert.equal(calls[0].runtime.workspaceMode, 'none');
});

test('Idea workflow no longer owns model-client calls or expert prompts', async () => {
  const [
    systemSource,
    workflowSource,
    classifierSource,
    generatorSource,
    reviewerSource,
  ] = await Promise.all([
    readFile(new URL('../src/workflows/idea-generation/ideaSystem.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/ideaGeneration.workflow.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/classifyProjectSeed.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/handlers/generateCandidates.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workflows/idea-generation/handlers/reviewQuality.js', import.meta.url), 'utf8'),
  ]);
  assert.match(generatorSource, /runDefinedAgent\s*\(\s*['"]idea-generator['"]/u);
  assert.match(reviewerSource, /runDefinedAgent\s*\(\s*['"]idea-quality-reviewer['"]/u);
  assert.match(classifierSource, /runDefinedAgent\s*\(\s*['"]project-classifier['"]/u);
  assert.match(classifierSource, /beginDirectAgentCommand\s*\(/u);
  assert.match(workflowSource, /Compatibility façade/u);
  assert.doesNotMatch(workflowSource, /runIdeaAgent/u);
  for (const source of [
    systemSource,
    workflowSource,
    classifierSource,
    generatorSource,
    reviewerSource,
  ]) {
    assert.doesNotMatch(source, /models\/client\.js|\bchatJSON\s*\(|\bchat\s*\(/u);
    assert.doesNotMatch(source, /You are the investment-idea generation agent|You are the investment-idea QC agent|You are the research-topic classification agent/u);
  }
});
