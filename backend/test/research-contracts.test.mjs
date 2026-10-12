import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defineAgentContract,
  createAgentRunRequest,
  createAgentRunResult,
  createEventEnvelope,
} from '../src/core/contracts/agentContracts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, '../src/domains/research/contracts/schemas');
const schemaFiles = [
  'researchBrief.schema.json',
  'dataPlan.schema.json',
  'data-orchestrator.output.schema.json',
  'evidenceBundle.schema.json',
  'sourceDocument.schema.json',
  'evidenceItem.schema.json',
  'domainEvent.schema.json',
  'industryAnalysis.schema.json',
  'companyAnalysis.schema.json',
  'draftReportPackage.schema.json',
  'reviewResult.schema.json',
  'reviewDecision.schema.json',
];
const provenance = ['schemaVersion', 'asOf', 'producer', 'contractVersion', 'inputDigest', 'createdAt', 'evidenceRefs'];
const agentArtifactSchemas = new Set(schemaFiles.filter((file) => ![
  'sourceDocument.schema.json', 'evidenceItem.schema.json', 'domainEvent.schema.json',
].includes(file)));

test('research contracts: twelve versioned JSON schemas are loadable with the required provenance boundary', () => {
  assert.equal(schemaFiles.length, 12);
  for (const file of schemaFiles) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/finagent\.local\/schemas\/research\/.+\.v1\.schema\.json$/);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    if (agentArtifactSchemas.has(file)) {
      for (const field of provenance) assert.ok(schema.required.includes(field), `${file} must require ${field}`);
    }
    assert.equal(schema.properties.schemaVersion.const, '1.0.0');
  }
});

const baseContract = {
  id: 'industry-analyst',
  version: '1.0.0',
  purpose: 'Explain industry structure and drivers.',
  executionMode: 'tool-loop',
  inputSchema: 'industryAnalysisInput.v1',
  outputSchema: 'industryAnalysis.v1',
  contextPolicy: { mounts: ['/project'], artifactSelectors: ['data/**'], maxInlineTokens: 12000, allowPriorReview: true, allowCrossProjectRead: false },
  toolPolicy: { allow: ['project_read_file'], deny: [], externalRetrieval: 'targeted', writeScopes: ['analysis/**'] },
  modelPolicy: { tier: 'main', preferredProviders: ['deepseek'], reasoningLevel: 'standard' },
  runPolicy: { maxTurns: 10, deadlineMs: 600000, tokenBudget: 200000, toolCallBudget: 30, retry: { maxAttempts: 2, retryOn: ['transient'] } },
  completionPolicy: { requiredArtifacts: ['analysis/industry.json'], hardChecks: ['output-schema'], gracefulFinalize: true },
  prompt: () => ({ system: 'system', user: 'user' }),
};

test('defineAgentContract freezes a complete versioned contract', () => {
  const contract = defineAgentContract(baseContract);
  assert.equal(contract.id, 'industry-analyst');
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.toolPolicy.allow));
});

test('defineAgentContract rejects missing identity, policy, and prompt builder', () => {
  for (const field of ['id', 'version', 'purpose', 'contextPolicy', 'toolPolicy', 'modelPolicy', 'runPolicy', 'completionPolicy', 'prompt']) {
    const invalid = { ...baseContract };
    delete invalid[field];
    assert.throws(() => defineAgentContract(invalid), new RegExp(field));
  }
  assert.throws(() => defineAgentContract({ ...baseContract, version: 'v1' }), /semantic version/i);
});

const baseRequest = {
  runId: 'run-1', workflowId: 'report-optimization.v1', nodeId: 'industry-analysis', projectId: 'project-1',
  agentContractId: 'industry-analyst', contractVersion: '1.0.0', asOf: '2026-07-12T00:00:00.000Z',
  input: { theme: 'AI infrastructure' }, inputArtifactRefs: [], workspaceSnapshotId: 'snapshot-1', idempotencyKey: 'idem-1',
};

test('AgentRunRequest requires stable run, node, contract, time, and idempotency identity', () => {
  const request = createAgentRunRequest(baseRequest);
  assert.equal(request.agentContractId, baseRequest.agentContractId);
  assert.ok(Object.isFrozen(request));
  for (const field of ['runId', 'workflowId', 'nodeId', 'projectId', 'agentContractId', 'contractVersion', 'asOf', 'input', 'inputArtifactRefs', 'workspaceSnapshotId', 'idempotencyKey']) {
    const invalid = { ...baseRequest };
    delete invalid[field];
    assert.throws(() => createAgentRunRequest(invalid), new RegExp(field));
  }
});

test('AgentRunResult normalizes the required result envelope and rejects unknown status', () => {
  const result = createAgentRunResult({
    status: 'succeeded', output: { ok: true }, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 }, stopReason: 'final', traceRef: 'trace-1',
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(Object.isFrozen(result));
  assert.throws(() => createAgentRunResult({ ...result, status: 'done' }), /status/);
});

test('AgentRunResult freezes its envelope but preserves mutable legacy output ownership', () => {
  const output = { candidates: [] };
  const result = createAgentRunResult({
    status: 'succeeded', output, artifacts: [], evidenceRefs: [], openQuestions: [], dataRequests: [],
    metrics: { turns: 1, toolCalls: 0 }, stopReason: 'final', traceRef: 'trace-mutable-output',
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.isFrozen(result.output), false, 'backend must not take ownership of/make legacy domain output immutable');
  assert.doesNotThrow(() => result.output.candidates.push({ ticker: 'GOOGL' }));
});

test('EventEnvelope requires ordered correlation identity and payload', () => {
  const event = createEventEnvelope({
    eventId: 'evt-1', eventType: 'agent.started', schemaVersion: '1.0.0', timestamp: '2026-07-12T00:00:00.000Z',
    sequence: 1, correlationId: 'run-1', causationId: null, projectId: 'project-1', runId: 'run-1', nodeId: 'industry-analysis',
    agentId: 'industry-analyst', payload: { contractVersion: '1.0.0' },
  });
  assert.equal(event.sequence, 1);
  assert.ok(Object.isFrozen(event));
  assert.throws(() => createEventEnvelope({ ...event, sequence: -1 }), /sequence/);
  const missingPayload = { ...event };
  delete missingPayload.payload;
  assert.throws(() => createEventEnvelope(missingPayload), /payload/);
  const missingCausation = { ...event };
  delete missingCausation.causationId;
  assert.throws(() => createEventEnvelope(missingCausation), /causationId/);
});
