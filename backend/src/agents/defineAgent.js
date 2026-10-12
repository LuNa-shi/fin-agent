// Declarative Agent definition built on the existing AgentContract boundary.
// This adds catalog/domain visibility without creating a competing execution contract.
import { defineAgentContract } from '../core/contracts/agentContracts.js';
import { toolRegistry } from '../tools/toolCatalog.js';

const REQUIRED_FIELDS = Object.freeze([
  'id', 'version', 'domain', 'purpose', 'visibility', 'executionMode', 'prompt',
  'inputSchema', 'outputSchema', 'contextPolicy', 'toolPolicy', 'modelPolicy',
  'runPolicy', 'completionPolicy', 'artifactAuthority', 'outputPaths',
]);
const ARTIFACT_AUTHORITIES = new Set(['return', 'artifact', 'return+artifact']);
const DEFINED_AGENTS = new WeakSet();

function fail(message) {
  throw new TypeError(message);
}

function requireDefinitionFields(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('AgentDefinition must be an object');
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(spec, field) || spec[field] === undefined || spec[field] === null || spec[field] === '') {
      fail(`AgentDefinition.${field} is required`);
    }
  }
}

export function defineAgent(spec, { registry = toolRegistry } = {}) {
  requireDefinitionFields(spec);
  if (typeof spec.domain !== 'string' || !spec.domain.trim()) fail('AgentDefinition.domain must be a non-empty string');
  if (!spec.visibility || typeof spec.visibility !== 'object' || Array.isArray(spec.visibility)) {
    fail('AgentDefinition.visibility must be an object');
  }
  if (typeof spec.visibility.catalog !== 'string' || !spec.visibility.catalog.trim()) {
    fail('AgentDefinition.visibility.catalog is required');
  }
  if (!Array.isArray(spec.visibility.workflows)) fail('AgentDefinition.visibility.workflows must be an array');
  if (!Array.isArray(spec.outputPaths)) fail('AgentDefinition.outputPaths must be an array');
  if (!ARTIFACT_AUTHORITIES.has(spec.artifactAuthority)) {
    fail(`AgentDefinition.artifactAuthority is invalid: ${spec.artifactAuthority}`);
  }

  if (Array.isArray(spec.toolPolicy?.allow)) {
    for (const toolId of spec.toolPolicy.allow) {
      if (!registry.has(toolId)) fail(`unknown tool in ${spec.id} Tool Use: ${toolId}`);
    }
  }

  const definition = defineAgentContract({
    ...spec,
    domain: spec.domain.trim(),
    visibility: { ...spec.visibility, workflows: [...spec.visibility.workflows] },
    outputPaths: [...spec.outputPaths],
  });
  DEFINED_AGENTS.add(definition);
  return definition;
}

export function assertAgentDefinition(value) {
  if (!value || typeof value !== 'object' || !DEFINED_AGENTS.has(value)) {
    throw new TypeError(`Agent definition must be created with defineAgent: ${value?.id || '(unknown)'}`);
  }
  return value;
}

export const AGENT_DEFINITION_REQUIRED_FIELDS = REQUIRED_FIELDS;
