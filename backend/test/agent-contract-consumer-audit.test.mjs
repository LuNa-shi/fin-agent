import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { listAgentDefinitions } from '../src/agents/registry.js';
import {
  ACTIVE_AGENT_DEFINITION_TOP_LEVEL_FIELDS,
  AGENT_CONTRACT_CONSUMER_AUDIT_HASH,
  AGENT_CONTRACT_FIELD_CATALOG,
  OUTPUT_SCHEMA_AUDIT,
  renderAgentContractConsumerAuditMarkdown,
  validateAgentContractConsumerAudit,
} from '../src/agents/contractConsumerAudit.js';
import { AGENT_DEFINITION_REQUIRED_FIELDS } from '../src/agents/defineAgent.js';
import { getAgentSchema } from '../src/core/validation/agentSchemaRegistry.js';

const allowedCategories = new Set(['runtime', 'workflow', 'documentationOnly']);
const expectedContractFields = [
  ...AGENT_DEFINITION_REQUIRED_FIELDS,
  ...ACTIVE_AGENT_DEFINITION_TOP_LEVEL_FIELDS,
  'visibility.catalog',
  'visibility.workflows',
  'contextPolicy.mounts',
  'contextPolicy.artifactSelectors',
  'contextPolicy.maxInlineTokens',
  'contextPolicy.allowPriorReview',
  'contextPolicy.allowCrossProjectRead',
  'toolPolicy.allow',
  'toolPolicy.deny',
  'toolPolicy.externalRetrieval',
  'toolPolicy.writeScopes',
  'modelPolicy.tier',
  'modelPolicy.preferredProviders',
  'modelPolicy.reasoningLevel',
  'runPolicy.maxTurns',
  'runPolicy.deadlineMs',
  'runPolicy.tokenBudget',
  'runPolicy.toolCallBudget',
  'runPolicy.retry',
  'runPolicy.retry.maxAttempts',
  'runPolicy.retry.retryOn',
  'completionPolicy.requiredArtifacts',
  'completionPolicy.hardChecks',
  'completionPolicy.gracefulFinalize',
];

test('contract field consumer catalog covers every required active Agent definition field', () => {
  assert.deepEqual(
    AGENT_CONTRACT_FIELD_CATALOG.map((entry) => entry.field).sort(),
    [...new Set(expectedContractFields)].sort(),
  );

  const topLevelDefinitionFields = [...new Set(listAgentDefinitions().flatMap((definition) => Object.keys(definition)))].sort();
  const topLevelCatalogFields = AGENT_CONTRACT_FIELD_CATALOG
    .filter((entry) => !entry.field.includes('.'))
    .map((entry) => entry.field)
    .sort();
  assert.deepEqual(topLevelCatalogFields, topLevelDefinitionFields);

  for (const entry of AGENT_CONTRACT_FIELD_CATALOG) {
    assert.ok(allowedCategories.has(entry.category), `${entry.field} has invalid category ${entry.category}`);
    assert.ok(entry.consumer && typeof entry.consumer === 'string', `${entry.field} must name a concrete consumer`);
    if (entry.category === 'documentationOnly') {
      assert.ok(entry.justification && typeof entry.justification === 'string', `${entry.field} documentationOnly needs justification`);
    }
  }

  const knownGapFields = AGENT_CONTRACT_FIELD_CATALOG.filter((entry) => entry.knownGap === true).map((entry) => entry.field).sort();
  assert.deepEqual(knownGapFields, ['inputSchema']);
  assert.equal(AGENT_CONTRACT_FIELD_CATALOG.some((entry) => entry.category === 'compatibility'), false);
  assert.equal(AGENT_CONTRACT_FIELD_CATALOG.some((entry) => /legacy|fallback backend/iu.test(entry.consumer)), false);
  assert.equal(validateAgentContractConsumerAudit(), true);
});

test('outputSchema audit is exhaustive and honest about central resolver coverage', () => {
  const definitions = listAgentDefinitions();
  const auditedIds = OUTPUT_SCHEMA_AUDIT.map((entry) => entry.agentId).sort();
  assert.deepEqual(auditedIds, definitions.map((definition) => definition.id).sort());

  const central = OUTPUT_SCHEMA_AUDIT.filter((entry) => entry.centralResolver === true);
  const nonCentral = OUTPUT_SCHEMA_AUDIT.filter((entry) => entry.centralResolver === false);
  assert.equal(central.length + nonCentral.length, definitions.length);
  assert.equal(central.length, 16);

  for (const definition of definitions) {
    const entry = OUTPUT_SCHEMA_AUDIT.find((candidate) => candidate.agentId === definition.id);
    assert.equal(entry.outputSchema, definition.outputSchema);
    assert.equal(entry.centralResolver, !!getAgentSchema(definition.outputSchema));
    if (!entry.centralResolver) {
      assert.equal(entry.category, 'documentationOnly', `${entry.agentId} non-central schema must be documentationOnly`);
      assert.ok(entry.alternateEnforcement && typeof entry.alternateEnforcement === 'string', `${entry.agentId} needs alternate enforcement or known gap`);
      assert.ok(entry.justification && typeof entry.justification === 'string', `${entry.agentId} needs documentationOnly justification`);
    }
  }
});

test('checked-in Agent Contract consumer audit Markdown is generated without drift', async () => {
  const checkedIn = await readFile(new URL('../../documents/generated/agent-contract-consumers.md', import.meta.url), 'utf8');
  assert.equal(checkedIn, renderAgentContractConsumerAuditMarkdown());
  assert.ok(checkedIn.includes(AGENT_CONTRACT_CONSUMER_AUDIT_HASH));
  assert.match(checkedIn, /inputSchema[\s\S]*not currently runtime-consumed/u);
  const retry = AGENT_CONTRACT_FIELD_CATALOG.find((entry) => entry.field === 'runPolicy.retry');
  const maxAttempts = AGENT_CONTRACT_FIELD_CATALOG.find(
    (entry) => entry.field === 'runPolicy.retry.maxAttempts',
  );
  const retryOn = AGENT_CONTRACT_FIELD_CATALOG.find(
    (entry) => entry.field === 'runPolicy.retry.retryOn',
  );
  assert.match(retry.consumer, /Run Analysis and Idea Generation[\s\S]*Core single node retry owner/u);
  assert.match(retry.consumer, /ReportAdmissionService[\s\S]*sole direct retry owner/u);
  assert.match(maxAttempts.consumer, /deterministic nodes default to one attempt/u);
  assert.match(maxAttempts.consumer, /ReportAdmissionService[\s\S]*immediate report-overview physical calls/u);
  assert.match(retryOn.consumer, /Core FailurePolicy/u);
  assert.match(retryOn.consumer, /ReportAdmissionService[\s\S]*repairable-output/u);
  assert.match(
    checkedIn,
    /Direct Agent calls generally add no retry loop; the explicit exception is Report Library admission/u,
  );
});
