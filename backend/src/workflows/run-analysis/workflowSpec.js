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
    id: 'initialize-checkpoint',
    kind: 'deterministic',
    handlerId: 'initializeCheckpoint',
    dependsOn: [],
    conditionId: 'always',
    condition: 'always',
    agentContractIds: [],
    artifactPolicy: 'pure-return',
  },
  {
    id: 'plan-research',
    kind: 'agent',
    handlerId: 'planResearch',
    dependsOn: ['initialize-checkpoint'],
    conditionId: 'checkpoint-plan-missing',
    condition: 'checkpoint.plan == null',
    agentContractIds: ['analysis-plan'],
  },
  {
    id: 'select-candidates',
    kind: 'composite',
    handlerId: 'selectCandidates',
    dependsOn: ['plan-research'],
    conditionId: 'checkpoint-scan-missing',
    condition: 'checkpoint.scan == null',
    agentContractIds: ['scan-score'],
  },
  {
    id: 'run-research-rounds',
    kind: 'composite',
    handlerId: 'runResearchRounds',
    dependsOn: ['select-candidates'],
    conditionId: 'checkpoint-research-rounds-pending',
    condition: 'checkpoint.round < checkpoint.targetRounds || active remediation owns data/industry/company',
    agentContractIds: [
      'data-orchestrator',
      'industry-analyst',
      'company-analyst',
    ],
    artifactPolicy: 'artifact',
    artifacts: {
      producer: 'data-evidence-pipeline',
      schemaVersion: 'data-evidence-pipeline.output.v1',
      requiredArtifacts: [
        'data/data_plan_rN.json',
        'data/source_documents_rN.json',
        'data/evidence_bundle_rN.json',
        'data/citation_ledger.json',
        'data/domain_events_rN.json',
        'data/organized_rN.json',
        'data/data_report.md',
      ],
      outputPaths: [
        'data/data_plan_rN.json',
        'data/source_documents_rN.json',
        'data/evidence_bundle_rN.json',
        'data/citation_ledger.json',
        'data/domain_events_rN.json',
        'data/organized_rN.json',
        'data/data_report.md',
      ],
    },
    artifactSelection: {
      roundField: 'round',
      declaredRoundField: 'dataRound',
    },
  },
  {
    id: 'compose-report',
    kind: 'agent',
    handlerId: 'composeReport',
    dependsOn: ['run-research-rounds'],
    conditionId: 'checkpoint-report-missing',
    condition: 'checkpoint.reportDone != true || active remediation owns report',
    agentContractIds: ['report-composer'],
  },
  {
    id: 'review-report',
    kind: 'composite',
    handlerId: 'reviewReport',
    dependsOn: ['compose-report'],
    conditionId: 'checkpoint-report-review-missing',
    condition: 'checkpoint.reportReview == null',
    agentContractIds: [
      'evidence-reviewer',
      'requirement-reviewer',
      'logic-reviewer',
      'data-scoreboard-evaluator',
      'industry-scoreboard-evaluator',
      'company-scoreboard-evaluator',
    ],
    artifactPolicy: 'artifact',
    artifacts: {
      producer: 'report-quality-auditor',
      schemaVersion: 'report-quality-audit.v1',
      requiredArtifacts: [
        'analysis/reviews/report_quality_rN.json',
        'analysis/scorecards/data_rN.json',
        'analysis/scorecards/industry_rN.json',
        'analysis/scorecards/company_rN.json',
      ],
      outputPaths: [
        'analysis/reviews/report_quality_rN.json',
        'analysis/scorecards/data_rN.json',
        'analysis/scorecards/industry_rN.json',
        'analysis/scorecards/company_rN.json',
      ],
      pathContracts: [
        { pattern: 'analysis/scorecards/data_rN.json', producer: 'data-scoreboard-evaluator', schemaVersion: 'scorecard-evaluation.v1' },
        { pattern: 'analysis/scorecards/industry_rN.json', producer: 'industry-scoreboard-evaluator', schemaVersion: 'scorecard-evaluation.v1' },
        { pattern: 'analysis/scorecards/company_rN.json', producer: 'company-scoreboard-evaluator', schemaVersion: 'scorecard-evaluation.v1' },
      ],
    },
    artifactSelection: { roundField: 'reviewRound' },
  },
  {
    id: 'synthesize-conclusion',
    kind: 'agent',
    handlerId: 'synthesizeConclusion',
    dependsOn: ['review-report'],
    conditionId: 'checkpoint-conclusion-missing',
    condition: 'checkpoint.conclusion == null',
    agentContractIds: ['conclusion-synthesizer'],
  },
  {
    id: 'finalize-project',
    kind: 'composite',
    handlerId: 'finalizeProject',
    dependsOn: ['synthesize-conclusion'],
    conditionId: 'checkpoint-incomplete',
    condition: 'checkpoint.done != true',
    agentContractIds: [],
    artifactPolicy: 'artifact',
    artifacts: {
      producer: 'run-analysis-finalizer',
      schemaVersion: 'run-analysis-finalization.output.v1',
      requiredArtifacts: ['report/report_*.md'],
      outputPaths: ['report/report_*.md'],
    },
    artifactSelection: {
      resultPaths: [{ field: 'finalReport.path', pattern: 'report/report_*.md', required: true }],
    },
  },
];

const parallelGroups = [
  {
    id: 'round-analysis',
    scope: 'agent-contracts',
    strategy: 'parallel-all',
    nodeId: 'run-research-rounds',
    agentContractIds: ['industry-analyst', 'company-analyst'],
  },
  {
    id: 'report-reviewers',
    scope: 'agent-contracts',
    strategy: 'parallel-all',
    nodeId: 'review-report',
    agentContractIds: ['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer'],
  },
];

const remediationRoutes = [
  {
    owner: 'data',
    nodeIds: [
      'run-research-rounds',
      'compose-report',
      'review-report',
      'synthesize-conclusion',
      'finalize-project',
    ],
  },
  {
    owner: 'industry',
    nodeIds: [
      'run-research-rounds',
      'compose-report',
      'review-report',
      'synthesize-conclusion',
      'finalize-project',
    ],
  },
  {
    owner: 'company',
    nodeIds: [
      'run-research-rounds',
      'compose-report',
      'review-report',
      'synthesize-conclusion',
      'finalize-project',
    ],
  },
  { owner: 'report', nodeIds: ['compose-report', 'review-report'] },
  { owner: 'system', nodeIds: [], terminal: 'human-review' },
];

export const RUN_ANALYSIS_WORKFLOW_SPEC = deepFreeze({
  schemaVersion: 'workflow-spec.v1',
  id: 'run-analysis.v2',
  version: '2.0.0',
  description: 'Canonical Analysis-first Run Analysis topology and Agent contract bindings.',
  maxRemediationCycles: 2,
  nodes,
  parallelGroups,
  remediationRoutes,
});

export function canonicalWorkflowSpecJSON(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  return canonicalWorkflowSpecJSONCore(spec);
}

export function workflowSpecHash(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  return workflowSpecHashCore(spec);
}

export function topologicalNodeOrder(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  return topologicalNodeOrderCore(spec);
}

const activeRunAnalysisAgentIds = () => listAgentDefinitions()
  .filter((definition) => definition.domain === 'run-analysis' && definition.inRunAnalysis)
  .map((definition) => definition.id);

export function validateRunAnalysisWorkflowSpec(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  validateWorkflowSpec(spec);

  const nodeIds = new Set(spec.nodes.map((node) => node.id));
  const boundAgentIds = [];
  for (const node of spec.nodes) {
    if (node.artifactPolicy && !['pure-return', 'artifact'].includes(node.artifactPolicy)) throw new TypeError(`invalid artifactPolicy for ${node.id}`);
    if (node.artifacts) {
      if (node.artifactPolicy !== 'artifact') throw new TypeError(`artifacts require artifactPolicy=artifact for ${node.id}`);
      for (const key of ['producer', 'schemaVersion']) {
        if (typeof node.artifacts[key] !== 'string' || !node.artifacts[key]) throw new TypeError(`artifacts.${key} is required for ${node.id}`);
      }
      if (!Array.isArray(node.artifacts.requiredArtifacts) || !Array.isArray(node.artifacts.outputPaths)) {
        throw new TypeError(`artifacts paths must be arrays for ${node.id}`);
      }
      if (node.artifacts.pathContracts !== undefined) {
        if (!Array.isArray(node.artifacts.pathContracts)) throw new TypeError(`artifacts.pathContracts must be an array for ${node.id}`);
        for (const contract of node.artifacts.pathContracts) {
          if (!contract || typeof contract.pattern !== 'string' || !contract.pattern
            || typeof contract.producer !== 'string' || !contract.producer
            || typeof contract.schemaVersion !== 'string' || !contract.schemaVersion) {
            throw new TypeError(`artifacts.pathContracts entries require pattern, producer, and schemaVersion for ${node.id}`);
          }
          if (!node.artifacts.outputPaths.includes(contract.pattern)) {
            throw new TypeError(`artifacts.pathContracts pattern must be declared in outputPaths for ${node.id}`);
          }
        }
      }
    }
    if (node.artifactSelection) {
      if (typeof node.artifactSelection !== 'object' || Array.isArray(node.artifactSelection)) {
        throw new TypeError(`artifactSelection must be an object for ${node.id}`);
      }
      if (node.artifactSelection.roundField !== undefined
        && (typeof node.artifactSelection.roundField !== 'string' || !node.artifactSelection.roundField)) {
        throw new TypeError(`artifactSelection.roundField must be a non-empty string for ${node.id}`);
      }
      if (node.artifactSelection.rounds !== undefined
        && (!Array.isArray(node.artifactSelection.rounds)
          || node.artifactSelection.rounds.some((round) => !Number.isInteger(round) || round <= 0))) {
        throw new TypeError(`artifactSelection.rounds must contain positive integers for ${node.id}`);
      }
      if (node.artifactSelection.resultPaths !== undefined) {
        if (!node.artifacts || !Array.isArray(node.artifactSelection.resultPaths)) {
          throw new TypeError(`artifactSelection.resultPaths requires declared artifacts for ${node.id}`);
        }
        for (const selector of node.artifactSelection.resultPaths) {
          if (!selector || typeof selector.field !== 'string' || !selector.field
            || typeof selector.pattern !== 'string' || !selector.pattern) {
            throw new TypeError(`artifactSelection.resultPaths entries require field and pattern for ${node.id}`);
          }
          if (!node.artifacts.outputPaths.includes(selector.pattern)) {
            throw new TypeError(`artifactSelection pattern must be declared in outputPaths for ${node.id}`);
          }
          if (selector.required !== undefined && typeof selector.required !== 'boolean') {
            throw new TypeError(`artifactSelection.required must be boolean for ${node.id}`);
          }
        }
      }
    }
    boundAgentIds.push(...node.agentContractIds);
  }
  topologicalNodeOrder(spec);

  if (new Set(boundAgentIds).size !== boundAgentIds.length) throw new Error('Agent contract binding must be unique across WorkflowSpec nodes');
  const expectedAgentIds = activeRunAnalysisAgentIds().sort();
  const actualAgentIds = [...boundAgentIds].sort();
  if (JSON.stringify(actualAgentIds) !== JSON.stringify(expectedAgentIds)) {
    throw new Error(`WorkflowSpec Agent bindings do not match active registry: expected ${expectedAgentIds.join(', ')}, got ${actualAgentIds.join(', ')}`);
  }

  validateWorkflowParallelGroups(spec);

  const remediationOwners = new Set();
  for (const route of spec.remediationRoutes || []) {
    if (!route?.owner || remediationOwners.has(route.owner)) throw new Error(route?.owner ? `duplicate remediation owner: ${route.owner}` : 'remediation owner is required');
    remediationOwners.add(route.owner);
    for (const nodeId of route.nodeIds || []) {
      if (!nodeIds.has(nodeId)) throw new Error(`unknown remediation node ${nodeId} for ${route.owner}`);
    }
  }
  return true;
}

export function remediationNodesFor(owner, spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  const route = spec.remediationRoutes.find((item) => item.owner === owner);
  if (!route) throw new Error(`unknown remediation owner: ${owner}`);
  return [...route.nodeIds, ...(route.terminal ? [route.terminal] : [])];
}

const mermaidId = (id) => id.replace(/[^A-Za-z0-9_]/gu, '_');
const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', '<br>');

export function renderRunAnalysisWorkflowMarkdown(spec = RUN_ANALYSIS_WORKFLOW_SPEC) {
  validateRunAnalysisWorkflowSpec(spec);
  const hash = workflowSpecHash(spec);
  const lines = [
    '<!-- GENERATED FILE: run `cd backend && node scripts/generateWorkflowDocs.mjs` to refresh. -->',
    '',
    '# Run Analysis WorkflowSpec',
    '',
    `- Spec: \`${spec.id}@${spec.version}\``,
    `- Schema: \`${spec.schemaVersion}\``,
    `- Deterministic hash: \`${hash}\``,
    '- Source: `backend/src/workflows/run-analysis/workflowSpec.js`',
    '- Execution status: production resolves all eight bounded handlers through the canonical dependency graph and declared parallel groups.',
    '',
    '```mermaid',
    'flowchart TD',
  ];
  for (const node of spec.nodes) lines.push(`  ${mermaidId(node.id)}["${node.id}"]`);
  for (const node of spec.nodes) {
    for (const dependency of node.dependsOn) lines.push(`  ${mermaidId(dependency)} --> ${mermaidId(node.id)}`);
  }
  lines.push('```', '', '## Nodes', '', '| Node | Kind | Handler binding | Dependencies | Condition binding | Condition description | Agent contracts | Parallel group | Artifact policy | Declared artifacts | Artifact selection |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const node of spec.nodes) {
    const declaredArtifacts = node.artifacts?.outputPaths?.join(', ') || '—';
    const artifactSelection = node.artifactSelection ? JSON.stringify(node.artifactSelection) : '—';
    lines.push(`| ${cell(node.id)} | ${cell(node.kind)} | ${cell(node.handlerId)} | ${cell(node.dependsOn.join(', ') || '—')} | ${cell(node.conditionId)} | ${cell(node.condition)} | ${cell(node.agentContractIds.join(', ') || '—')} | ${cell(node.parallelGroup || '—')} | ${cell(node.artifactPolicy || 'contract-derived')} | ${cell(declaredArtifacts)} | ${cell(artifactSelection)} |`);
  }
  lines.push('', '## Parallel groups', '', '| Group | Scope | Owner/members | Join |', '|---|---|---|---|');
  for (const group of spec.parallelGroups) {
    const members = group.nodeIds?.join(', ') || group.agentContractIds?.join(', ') || '—';
    lines.push(`| ${cell(group.id)} | ${cell(group.scope)} | ${cell(`${group.nodeId ? `${group.nodeId}: ` : ''}${members}`)} | ${cell(group.joinBefore || group.strategy)} |`);
  }
  lines.push('', '## Remediation routes', '', '> RV-01 executes these routes after read-only review adjudication, invalidating only the route union and stopping after two remediation cycles.', '', '| Owner | Affected nodes / terminal |', '|---|---|');
  for (const route of spec.remediationRoutes) {
    const destinations = [...route.nodeIds, ...(route.terminal ? [route.terminal] : [])];
    lines.push(`| ${cell(route.owner)} | ${cell(destinations.join(' → '))} |`);
  }
  lines.push('', '## Research rounds', '', 'The `run-research-rounds` composite executes the configured fixed Data-first rounds, then runs Industry and Company from the same committed Data closure.', '');
  return `${lines.join('\n')}\n`;
}

validateRunAnalysisWorkflowSpec(RUN_ANALYSIS_WORKFLOW_SPEC);
export const RUN_ANALYSIS_WORKFLOW_SPEC_HASH = workflowSpecHash(RUN_ANALYSIS_WORKFLOW_SPEC);
