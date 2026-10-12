import { listCanonicalWorldviewAgentDefinitions } from '../../agents/registry.js';
import { deepFreeze } from '../../core/contracts/ArtifactRef.js';
import { topologicalNodeOrder } from '../../core/workflow/WorkflowGraph.js';
import { canonicalWorkflowSpecJSON, validateWorkflowSpec, workflowSpecHash } from '../../core/workflow/WorkflowSpec.js';

const artifact = (nodeId, handlerId, { agentContractIds = [], kind = 'deterministic' } = {}) => ({
  id: nodeId,
  kind,
  handlerId,
  dependsOn: [],
  conditionId: 'always',
  condition: 'always',
  agentContractIds,
  artifactPolicy: 'artifact',
  artifacts: {
    producer: 'canonical-worldview-workflow',
    authority: 'artifact',
    requiredArtifacts: [`outputs/${nodeId}.json`],
    outputPaths: [`outputs/${nodeId}.json`],
  },
});

const freeze = artifact('freeze-worldview-run', 'freezeWorldviewRun');
const execute = { ...artifact('execute-core-worldview-attempts', 'executeCoreWorldviewAttempts', { agentContractIds: ['core-worldview'], kind: 'agent' }), dependsOn: [freeze.id] };
const validate = { ...artifact('validate-worldview-and-claim-actions', 'validateWorldviewAndClaimActions'), dependsOn: [execute.id] };
const publish = { ...artifact('stage-run-publication', 'stageRunPublication'), dependsOn: [validate.id] };
const advance = { ...artifact('commit-run-publication', 'commitRunPublication'), dependsOn: [publish.id] };

export const CANONICAL_WORLDVIEW_WORKFLOW_SPEC = deepFreeze({
  schemaVersion: 'workflow-spec.v1',
  id: 'canonical-worldview-processing.v1',
  version: '1.0.0',
  description: 'One bounded frozen Report Library range to one governed Core Worldview Agent KEEP or UPDATE result.',
  scope: { kind: 'worldview-universe', workspaceMode: 'none' },
  nodes: [freeze, execute, validate, publish, advance],
  parallelGroups: [],
});

export const CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH = workflowSpecHash(CANONICAL_WORLDVIEW_WORKFLOW_SPEC);

export function validateCanonicalWorldviewWorkflowSpec(spec = CANONICAL_WORLDVIEW_WORKFLOW_SPEC) {
  validateWorkflowSpec(spec);
  if (spec.scope?.kind !== 'worldview-universe' || spec.scope?.workspaceMode !== 'none') {
    throw new TypeError('Canonical Worldview WorkflowSpec requires worldview-universe/none scope');
  }
  const bound = spec.nodes.flatMap((node) => node.agentContractIds).sort();
  const expected = listCanonicalWorldviewAgentDefinitions()
    .map((definition) => definition.id)
    .sort();
  if (JSON.stringify(bound) !== JSON.stringify(expected)) {
    throw new Error(`Canonical Worldview Agent bindings mismatch: expected ${expected.join(', ')}, got ${bound.join(', ')}`);
  }
  topologicalNodeOrder(spec);
  return true;
}

export function canonicalCanonicalWorldviewWorkflowSpecJSON(spec = CANONICAL_WORLDVIEW_WORKFLOW_SPEC) {
  return canonicalWorkflowSpecJSON(spec);
}

const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', '<br>');
const mermaidId = (id) => id.replace(/[^A-Za-z0-9_]/gu, '_');

export function renderCanonicalWorldviewWorkflowMarkdown(spec = CANONICAL_WORLDVIEW_WORKFLOW_SPEC) {
  validateCanonicalWorldviewWorkflowSpec(spec);
  const lines = [
    '<!-- GENERATED FILE: run `cd backend && node scripts/generateWorkflowDocs.mjs` to refresh. -->', '',
    '# Canonical Worldview Processing WorkflowSpec', '',
    `- Spec: \`${spec.id}@${spec.version}\``,
    `- Schema: \`${spec.schemaVersion}\``,
    `- Deterministic hash: \`${workflowSpecHash(spec)}\``,
    '- Source: `backend/src/workflows/worldview/canonicalWorkflowSpec.js`',
    '- Scope: `worldview-universe` with `workspaceMode=none`.',
    '- Run rule: one frozen contiguous Report Library range and one logical Core Worldview Agent execution with up to 3 complete Agent attempts.', '',
    '```mermaid', 'flowchart TD',
  ];
  for (const node of spec.nodes) lines.push(`  ${mermaidId(node.id)}["${node.id}"]`);
  for (const node of spec.nodes) for (const dependency of node.dependsOn) lines.push(`  ${mermaidId(dependency)} --> ${mermaidId(node.id)}`);
  lines.push('```', '', '## Nodes', '', '| Node | Kind | Handler | Dependencies | Agent contracts |', '|---|---|---|---|---|');
  for (const node of spec.nodes) lines.push(`| ${cell(node.id)} | ${cell(node.kind)} | ${cell(node.handlerId)} | ${cell(node.dependsOn.join(', ') || '—')} | ${cell(node.agentContractIds.join(', ') || '—')} |`);
  return `${lines.join('\n')}\n`;
}

validateCanonicalWorldviewWorkflowSpec();
