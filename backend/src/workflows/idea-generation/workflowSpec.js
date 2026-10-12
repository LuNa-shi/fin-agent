import { listAgentDefinitions } from '../../agents/registry.js';
import {
  canonicalWorkflowSpecJSON as canonicalWorkflowSpecJSONCore,
  validateWorkflowSpec,
  workflowSpecHash as workflowSpecHashCore,
} from '../../core/workflow/WorkflowSpec.js';
import {
  topologicalNodeOrder as topologicalNodeOrderCore,
  validateWorkflowParallelGroups,
} from '../../core/workflow/WorkflowGraph.js';

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

const nodes = [
  {
    id: 'collect-market-context',
    kind: 'deterministic',
    handlerId: 'collectMarketContext',
    dependsOn: [],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'artifact',
    outputDescription: 'captured source batch + current trace/provenance',
  },
  {
    id: 'build-diversification-constraints',
    kind: 'deterministic',
    handlerId: 'buildDiversificationConstraints',
    dependsOn: ['collect-market-context'],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'artifact',
    outputDescription: 'immutable run artifact/ref',
  },
  {
    id: 'generate-candidates',
    kind: 'agent',
    handlerId: 'generateCandidates',
    dependsOn: ['build-diversification-constraints'],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: ['idea-generator'],
    artifactPolicy: 'artifact',
    outputDescription: 'candidate Idea artifacts',
  },
  {
    id: 'verify-candidates',
    kind: 'deterministic',
    handlerId: 'verifyCandidates',
    dependsOn: ['generate-candidates'],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'artifact',
    outputDescription: 'verified candidates',
  },
  {
    id: 'review-quality',
    kind: 'agent',
    handlerId: 'reviewQuality',
    dependsOn: ['verify-candidates'],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: ['idea-quality-reviewer'],
    artifactPolicy: 'artifact',
    outputDescription: 'quality annotations/ranking',
  },
  {
    id: 'persist-ideas',
    kind: 'deterministic',
    handlerId: 'persistIdeas',
    dependsOn: ['review-quality'],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'artifact',
    outputDescription: 'Idea folder refs + index projection',
  },
];

export const IDEA_GENERATION_WORKFLOW_SPEC = deepFreeze({
  schemaVersion: 'workflow-spec.v1',
  id: 'idea-generation.v2',
  version: '2.0.0',
  description: 'Canonical durable non-Project Idea Generation topology and Agent contract bindings.',
  scope: {
    kind: 'idea-universe',
    workspaceMode: 'idea-run',
  },
  nodes,
  parallelGroups: [],
});

export function canonicalIdeaGenerationWorkflowSpecJSON(
  spec = IDEA_GENERATION_WORKFLOW_SPEC,
) {
  return canonicalWorkflowSpecJSONCore(spec);
}

export function ideaGenerationWorkflowSpecHash(spec = IDEA_GENERATION_WORKFLOW_SPEC) {
  return workflowSpecHashCore(spec);
}

export function topologicalIdeaGenerationNodeOrder(spec = IDEA_GENERATION_WORKFLOW_SPEC) {
  return topologicalNodeOrderCore(spec);
}

function visibleIdeaGenerationAgentIds(spec) {
  return listAgentDefinitions()
    .filter((definition) => (
      definition.domain === 'idea-generation'
      && definition.visibility.workflows.includes(spec.id)
    ))
    .map((definition) => definition.id)
    .sort();
}

export function validateIdeaGenerationWorkflowSpec(spec = IDEA_GENERATION_WORKFLOW_SPEC) {
  validateWorkflowSpec(spec);
  if (
    spec.scope?.kind !== 'idea-universe'
    || spec.scope?.workspaceMode !== 'idea-run'
  ) {
    throw new TypeError('Idea Generation WorkflowSpec requires idea-universe/idea-run scope');
  }
  if (!Array.isArray(spec.parallelGroups) || spec.parallelGroups.length !== 0) {
    throw new TypeError('Idea Generation WorkflowSpec does not declare parallel node groups');
  }

  const boundAgentIds = [];
  for (const node of spec.nodes) {
    if (!['deterministic', 'agent'].includes(node.kind)) {
      throw new TypeError(`invalid Idea Generation node kind for ${node.id}`);
    }
    if (node.artifactPolicy !== 'artifact') {
      throw new TypeError(`Idea Generation node must durably publish an artifact: ${node.id}`);
    }
    if (typeof node.outputDescription !== 'string' || !node.outputDescription) {
      throw new TypeError(`Idea Generation node outputDescription is required: ${node.id}`);
    }
    if (node.kind === 'agent' && node.agentContractIds.length !== 1) {
      throw new TypeError(`Idea Generation Agent node must bind exactly one contract: ${node.id}`);
    }
    if (node.kind === 'deterministic' && node.agentContractIds.length !== 0) {
      throw new TypeError(`deterministic Idea Generation node cannot bind an Agent: ${node.id}`);
    }
    boundAgentIds.push(...node.agentContractIds);
  }

  topologicalNodeOrderCore(spec);
  validateWorkflowParallelGroups(spec);
  if (new Set(boundAgentIds).size !== boundAgentIds.length) {
    throw new Error('Idea Generation Agent contract binding must be unique');
  }
  const visibleAgentIds = visibleIdeaGenerationAgentIds(spec);
  const actualAgentIds = [...boundAgentIds].sort();
  if (JSON.stringify(actualAgentIds) !== JSON.stringify(visibleAgentIds)) {
    throw new Error(
      `Idea Generation WorkflowSpec Agent bindings do not match active registry: expected ${visibleAgentIds.join(', ')}, got ${actualAgentIds.join(', ')}`,
    );
  }
  return true;
}

const mermaidId = (id) => id.replace(/[^A-Za-z0-9_]/gu, '_');
const cell = (value) => String(value ?? '—')
  .replaceAll('|', '\\|')
  .replaceAll('\n', '<br>');

export function renderIdeaGenerationWorkflowMarkdown(
  spec = IDEA_GENERATION_WORKFLOW_SPEC,
) {
  validateIdeaGenerationWorkflowSpec(spec);
  const hash = ideaGenerationWorkflowSpecHash(spec);
  const lines = [
    '<!-- GENERATED FILE: run `cd backend && node scripts/generateWorkflowDocs.mjs` to refresh. -->',
    '',
    '# Idea Generation WorkflowSpec',
    '',
    `- Spec: \`${spec.id}@${spec.version}\``,
    `- Schema: \`${spec.schemaVersion}\``,
    `- Deterministic hash: \`${hash}\``,
    '- Source: `backend/src/workflows/idea-generation/workflowSpec.js`',
    '- Durable scope: `idea-universe` with a run-owned `idea-run` input snapshot.',
    '- Publication rule: source material remains run input; every valid normalized/deduplicated generated Idea is persisted, while quality review supplies annotations/ranking only.',
    '',
    '```mermaid',
    'flowchart TD',
  ];
  for (const node of spec.nodes) lines.push(`  ${mermaidId(node.id)}["${node.id}"]`);
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) {
      lines.push(`  ${mermaidId(dependency)} --> ${mermaidId(node.id)}`);
    }
  }
  lines.push(
    '```',
    '',
    '## Nodes',
    '',
    '| Node | Kind | Handler binding | Dependencies | Condition binding | Agent contracts | Artifact policy | Formal output |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const node of spec.nodes) {
    lines.push(`| ${cell(node.id)} | ${cell(node.kind)} | ${cell(node.handlerId)} | ${cell(node.dependsOn.join(', ') || '—')} | ${cell(node.conditionId)} | ${cell(node.agentContractIds.join(', ') || '—')} | ${cell(node.artifactPolicy)} | ${cell(node.outputDescription)} |`);
  }
  return `${lines.join('\n')}\n`;
}

validateIdeaGenerationWorkflowSpec(IDEA_GENERATION_WORKFLOW_SPEC);
export const IDEA_GENERATION_WORKFLOW_SPEC_HASH = ideaGenerationWorkflowSpecHash(
  IDEA_GENERATION_WORKFLOW_SPEC,
);
