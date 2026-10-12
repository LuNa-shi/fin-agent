import { listAgentDefinitions } from '../../src/agents/registry.js';
import {
  AGENT_RESULT_CACHEABLE_STATUSES,
  AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS,
  AGENT_RESULT_IDEMPOTENCY_STORE_VERSION,
  AGENT_RESULT_LOGICAL_INPUT_FIELDS,
} from '../../src/core/agent-backend/AgentResultIdempotencyStore.js';
import { AGENT_IDEMPOTENCY_KEY_MODES } from '../../src/core/contracts/agentContracts.js';
import {
  ARTIFACT_REF_CONTRACT_VERSION,
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  deepFreeze,
} from '../../src/core/contracts/ArtifactRef.js';
import { ARTIFACT_MANIFEST_CONTRACT } from '../../src/project-space/ArtifactStore.js';
import {
  IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT,
  ideaNodeOutputArtifactDeclaration,
} from '../../src/workflows/idea-generation/completion/nodeArtifacts.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
  validateIdeaGenerationWorkflowSpec,
} from '../../src/workflows/idea-generation/workflowSpec.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
  validateRunAnalysisWorkflowSpec,
} from '../../src/workflows/run-analysis/workflowSpec.js';
import {
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
  CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
  validateCanonicalWorldviewWorkflowSpec,
} from '../../src/workflows/worldview/canonicalWorkflowSpec.js';

const definitionsById = new Map(listAgentDefinitions().map((definition) => [definition.id, definition]));
const unique = (values) => [...new Set(values)];

function nodeArtifactAuthority(node, {
  completionArtifacts = node.artifacts || null,
  artifactCommitOwner = 'workflow',
} = {}) {
  const definitions = node.agentContractIds.map((id) => definitionsById.get(id));
  const missing = node.agentContractIds.filter((id, index) => !definitions[index]);
  if (missing.length) throw new Error(`Artifact authority audit references unknown Agents: ${missing.join(', ')}`);

  const declared = completionArtifacts ? [{
    producer: completionArtifacts.producer,
    authority: completionArtifacts.authority || 'artifact',
    requiredArtifacts: completionArtifacts.requiredArtifacts,
    outputPaths: completionArtifacts.outputPaths,
  }] : [];
  const agentPolicies = definitions.map((definition) => ({
    producer: definition.id,
    authority: definition.artifactAuthority,
    requiredArtifacts: definition.completionPolicy.requiredArtifacts,
    outputPaths: definition.outputPaths,
  }));
  const policies = [...agentPolicies, ...declared];

  return {
    id: node.id,
    kind: node.kind,
    artifactPolicy: node.artifactPolicy || 'agent-contracts',
    artifactCommitOwner,
    agentContractIds: [...node.agentContractIds],
    producers: unique(policies.map((policy) => policy.producer)),
    authorities: unique(policies.map((policy) => `${policy.producer}:${policy.authority}`)),
    requiredArtifacts: unique(policies.flatMap((policy) => policy.requiredArtifacts)),
    outputPaths: unique(policies.flatMap((policy) => policy.outputPaths)),
    artifactSelection: node.artifactSelection || null,
  };
}

function runAnalysisAuthority() {
  return {
    id: RUN_ANALYSIS_WORKFLOW_SPEC.id,
    version: RUN_ANALYSIS_WORKFLOW_SPEC.version,
    hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    scope: 'project',
    workspaceMode: 'project',
    authorityRoot: 'projects/<projectId>/',
    manifestPath: 'projects/<projectId>/.artifacts/manifest.json',
    nodes: RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => nodeArtifactAuthority(node)),
  };
}

function canonicalWorldviewAuthority() {
  return {
    id: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id,
    version: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.version,
    hash: CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
    scope: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.scope.kind,
    workspaceMode: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.scope.workspaceMode,
    authorityRoot: 'canonical-worldview/workflow-runs/<runId>/',
    manifestPath: 'canonical-worldview/workflow-runs/<runId>/.artifacts/manifest.json',
    nodes: CANONICAL_WORLDVIEW_WORKFLOW_SPEC.nodes.map((node) => nodeArtifactAuthority(node)),
  };
}

function ideaGenerationAuthority() {
  return {
    id: IDEA_GENERATION_WORKFLOW_SPEC.id,
    version: IDEA_GENERATION_WORKFLOW_SPEC.version,
    hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    scope: IDEA_GENERATION_WORKFLOW_SPEC.scope.kind,
    workspaceMode: IDEA_GENERATION_WORKFLOW_SPEC.scope.workspaceMode,
    authorityRoot: 'idea-generation/runs/<runId>/',
    manifestPath: 'idea-generation/runs/<runId>/.artifacts/manifest.json',
    nodeOutputArtifact: IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT,
    nodes: IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node) => nodeArtifactAuthority(node, {
      completionArtifacts: ideaNodeOutputArtifactDeclaration(node),
    })),
  };
}

export const ARTIFACT_AUTHORITY_AUDIT = deepFreeze({
  schemaVersion: 'artifact-authority-audit.v2',
  artifactRef: {
    contractVersion: ARTIFACT_REF_CONTRACT_VERSION,
    requiredFields: ARTIFACT_REF_REQUIRED_FIELDS,
    locationFields: ARTIFACT_REF_LOCATION_FIELDS,
    locationRule: 'at-least-one',
  },
  manifest: ARTIFACT_MANIFEST_CONTRACT,
  workflows: [
    runAnalysisAuthority(),
    ideaGenerationAuthority(),
    canonicalWorldviewAuthority(),
  ],
  agentResultReplay: {
    storeVersion: AGENT_RESULT_IDEMPOTENCY_STORE_VERSION,
    modes: AGENT_IDEMPOTENCY_KEY_MODES,
    durableMode: 'explicit',
    scopeFields: AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS,
    logicalInputFields: AGENT_RESULT_LOGICAL_INPUT_FIELDS,
    excludedLogicalFields: ['runId', 'asOf'],
    cacheableStatuses: AGENT_RESULT_CACHEABLE_STATUSES,
    pathLayout: 'agent-result-idempotency/<scope-sha256-prefix>/<scope-sha256>.json',
  },
});

export const ARTIFACT_AUTHORITY_AUDIT_HASH = canonicalSha256(ARTIFACT_AUTHORITY_AUDIT);

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateArtifactAuthorityAudit() {
  validateRunAnalysisWorkflowSpec();
  validateIdeaGenerationWorkflowSpec();
  validateCanonicalWorldviewWorkflowSpec();
  if (!same(ARTIFACT_AUTHORITY_AUDIT.artifactRef.requiredFields, ARTIFACT_REF_REQUIRED_FIELDS)) {
    throw new Error('ArtifactRef required-field audit drift');
  }
  if (!same(ARTIFACT_AUTHORITY_AUDIT.artifactRef.locationFields, ARTIFACT_REF_LOCATION_FIELDS)) {
    throw new Error('ArtifactRef location-field audit drift');
  }
  if (!same(ARTIFACT_AUTHORITY_AUDIT.manifest, ARTIFACT_MANIFEST_CONTRACT)) {
    throw new Error('Artifact manifest contract audit drift');
  }
  if (!same(ARTIFACT_AUTHORITY_AUDIT.agentResultReplay.scopeFields, AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS)
    || !same(ARTIFACT_AUTHORITY_AUDIT.agentResultReplay.logicalInputFields, AGENT_RESULT_LOGICAL_INPUT_FIELDS)) {
    throw new Error('Agent result idempotency audit drift');
  }

  const expectedWorkflows = [
    {
      spec: RUN_ANALYSIS_WORKFLOW_SPEC,
      hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
      pureReturnNodes: ['initialize-checkpoint'],
    },
    {
      spec: IDEA_GENERATION_WORKFLOW_SPEC,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
      pureReturnNodes: [],
    },
    {
      spec: CANONICAL_WORLDVIEW_WORKFLOW_SPEC,
      hash: CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH,
      pureReturnNodes: [],
    },
  ];
  if (!same(
    ARTIFACT_AUTHORITY_AUDIT.workflows.map((workflow) => workflow.id),
    expectedWorkflows.map(({ spec }) => spec.id),
  )) {
    throw new Error('Artifact authority Workflow list drift');
  }
  for (const expected of expectedWorkflows) {
    const workflow = ARTIFACT_AUTHORITY_AUDIT.workflows.find(
      (candidate) => candidate.id === expected.spec.id,
    );
    if (!workflow || workflow.hash !== expected.hash) {
      throw new Error(`WorkflowSpec hash audit drift: ${expected.spec.id}`);
    }
    if (!same(workflow.nodes.map((node) => node.id), expected.spec.nodes.map((node) => node.id))) {
      throw new Error(`Artifact authority Workflow node audit drift: ${expected.spec.id}`);
    }
    const pureReturnNodes = [];
    for (const node of workflow.nodes) {
      if (node.artifactPolicy === 'pure-return') {
        pureReturnNodes.push(node.id);
        if (node.requiredArtifacts.length || node.outputPaths.length || node.producers.length) {
          throw new Error(`pure-return node declares artifact authority: ${node.id}`);
        }
        continue;
      }
      if (node.artifactCommitOwner !== 'workflow') {
        throw new Error(`canonical node artifact commit owner drift: ${workflow.id}/${node.id}`);
      }
      if (!node.requiredArtifacts.length) throw new Error(`successful node lacks required artifacts: ${node.id}`);
      if (!node.producers.length) throw new Error(`successful node lacks artifact producers: ${node.id}`);
      for (const pattern of node.requiredArtifacts) {
        if (!node.outputPaths.includes(pattern)) throw new Error(`required artifact is outside output paths for ${node.id}: ${pattern}`);
      }
    }
    if (!same(pureReturnNodes, expected.pureReturnNodes)) {
      throw new Error(`pure-return node audit drift: ${expected.spec.id}`);
    }
  }

  const ideaWorkflow = ARTIFACT_AUTHORITY_AUDIT.workflows.find(
    (workflow) => workflow.id === IDEA_GENERATION_WORKFLOW_SPEC.id,
  );
  if (!same(ideaWorkflow.nodeOutputArtifact, IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT)) {
    throw new Error('Idea Generation node output artifact contract audit drift');
  }
  for (const node of ideaWorkflow.nodes) {
    const expectedPath = IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.pathTemplate
      .replace('<nodeId>', node.id);
    if (
      !same(node.requiredArtifacts, [expectedPath])
      || !same(node.outputPaths, [expectedPath])
    ) {
      throw new Error(`Idea Generation node output artifact audit drift: ${node.id}`);
    }
  }
  return true;
}

function esc(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function codeList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '—';
}

export function renderArtifactAuthorityMarkdown() {
  validateArtifactAuthorityAudit();
  const {
    artifactRef,
    manifest,
    workflows,
    agentResultReplay,
  } = ARTIFACT_AUTHORITY_AUDIT;
  const runAnalysis = workflows.find((workflow) => workflow.id === RUN_ANALYSIS_WORKFLOW_SPEC.id);
  const ideaGeneration = workflows.find((workflow) => workflow.id === IDEA_GENERATION_WORKFLOW_SPEC.id);
  const canonicalWorldview = workflows.find((workflow) => workflow.id === CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id);
  const renderNodeRows = (workflow) => workflow.nodes.map((node) => `| \`${node.id}\` | ${esc(node.artifactPolicy)} | ${esc(node.artifactCommitOwner)} | ${esc(codeList(node.authorities))} | ${esc(codeList(node.requiredArtifacts))} | ${esc(codeList(node.outputPaths))} | ${esc(node.artifactSelection ? `\`${JSON.stringify(node.artifactSelection)}\`` : 'current-run declared paths')} |`);
  const lines = [
    '# Artifact Authority and Lineage Audit',
    '',
    '- Generated by: `backend/scripts/generateArtifactAuthorityDocs.mjs`',
    `- Audit hash: \`${ARTIFACT_AUTHORITY_AUDIT_HASH}\``,
    ...workflows.flatMap((workflow) => [
      `- WorkflowSpec: \`${workflow.id}@${workflow.version}\``,
      `- WorkflowSpec hash: \`${workflow.hash}\``,
    ]),
    '',
    '## ArtifactRef Contract',
    '',
    `Contract: \`${artifactRef.contractVersion}\`. Every reference requires ${codeList(artifactRef.requiredFields)} and at least one location field: ${codeList(artifactRef.locationFields)}.`,
    '',
    '| Property | Runtime rule |',
    '|---|---|',
    '| `artifactId` + `version` | Stable logical identity; edits create a new positive version. |',
    '| `path` / `uri` | At least one non-empty location is required. |',
    '| `contentDigest` | SHA-256 of immutable object bytes. |',
    '| `schemaVersion` + `producer` + `contractVersion` | Declares the producing schema and authority. |',
    '| `inputDigest` | Canonical digest of the node input and upstream references. |',
    '| `createdAt` + `asOf` | Exact creation and point-in-time timestamps. |',
    '',
    '## Manifest and Run Lineage',
    '',
    `Each durable authority root uses \`${manifest.schemaVersion}\` at \`.artifacts/manifest.json\`; immutable bytes live below \`.artifacts/objects/sha256/\`. Store scope is \`${manifest.storeScope}\`.`,
    '',
    `- Run Analysis: \`${runAnalysis.manifestPath}\` under the Project authority root \`${runAnalysis.authorityRoot}\`.`,
    `- Idea Generation: \`${ideaGeneration.manifestPath}\` under the non-Project run authority root \`${ideaGeneration.authorityRoot}\`. Its manifest \`projectId\` stores the legacy contract compatibility identity \`idea-universe:local-user\`; it does not select or imply a physical Project path.`,
    `- Canonical Worldview: \`${canonicalWorldview.manifestPath}\` under the globally serialized run authority root \`${canonicalWorldview.authorityRoot}\`.`,
    '',
    `Manifest fields: ${codeList(manifest.fields)}.`,
    '',
    `Version-entry fields: ${codeList(manifest.versionEntryFields)}.`,
    '',
    `Successful-commit fields: ${codeList(manifest.successfulCommitFields)}.`,
    '',
    `Lineage projection fields: ${codeList(manifest.lineageEntryFields)}.`,
    '',
    'To reconstruct a run, select manifest version entries by `runId`, group them by `nodeId`, follow each entry’s `inputArtifactRefs`, and verify every terminal `ref` against its content-addressed object digest. RunStore node records persist the same formal refs for exact resume; Run Analysis additionally maintains its compatibility checkpoint `nodeExecutions` projection.',
    '',
    '## Run Analysis Node Authority',
    '',
    '| Node | Policy | Commit owner | Producers / authorities | Required artifacts | Authorized outputs | Selection |',
    '|---|---|---|---|---|---|---|',
    ...renderNodeRows(runAnalysis),
    '',
    'A node reaches `SUCCEEDED` only after its required files pass Contract enforcement and the complete node batch publishes to the manifest. Canonical Agent calls use `artifactCommitOwner=workflow`; Agent completion policies declare the required outputs, while the Workflow owns durable publication. `initialize-checkpoint` is the sole explicit `pure-return` exception.',
    '',
    '## Idea Generation Node Authority',
    '',
    '| Node | Policy | Commit owner | Producers / authorities | Required artifacts | Authorized outputs | Selection |',
    '|---|---|---|---|---|---|---|',
    ...renderNodeRows(ideaGeneration),
    '',
    `Every Idea Generation node publishes exactly one formal ArtifactRef at \`${ideaGeneration.nodeOutputArtifact.pathTemplate}\` with logical id \`${ideaGeneration.nodeOutputArtifact.artifactIdTemplate}\`. Generator and reviewer Agents retain \`return\` authority for their model output; the Workflow completion wrapper alone owns the \`artifact\` authority and manifest commit through \`artifactCommitOwner=workflow\`, so there is no dual artifact authority.`,
    '',
    '## Canonical Worldview Processing Node Authority',
    '',
    '| Node | Policy | Commit owner | Producers / authorities | Required artifacts | Authorized outputs | Selection |',
    '|---|---|---|---|---|---|---|',
    ...renderNodeRows(canonicalWorldview),
    '',
    'Canonical Worldview Processing publishes run-owned checkpoint artifacts under `canonical-worldview/workflow-runs/<runId>/`; the Core Agent has return-only authority. Deterministic domain authorities own immutable run workspaces, Evaluation Records or complete Worldview packages/Update Records, Claim Library versions/actions/rejections, exact per-ReportVersion Processed receipts, and rebuildable projections. Worldview and Claims remain semantically separate and share only run/publication lineage.',
    '',
    'The active composition stages all of those domain objects, then commits one authoritative `worldview-run-publication-marker.v1`. Its digest binds the Worldview outcome, Claim publication digest, complete Agent/model-API attempt audit, Processed receipts, and workspace lineage. Claim Library completion is read from that same marker; no second Claim marker or global processing cursor is active publication authority.',
    '',
    '## Successful Agent Result Replay',
    '',
    `Durable mode: \`${agentResultReplay.durableMode}\`; modes: ${codeList(agentResultReplay.modes)}. Only explicit caller keys are cached. Reusing the same explicit key and logical input returns the persisted successful result with zero backend/model calls.`,
    '',
    `Scope fields: ${codeList(agentResultReplay.scopeFields)}.`,
    '',
    `Logical-input fingerprint fields: ${codeList(agentResultReplay.logicalInputFields)}. Excluded automatic execution fields: ${codeList(agentResultReplay.excludedLogicalFields)}.`,
    '',
    `Cacheable statuses: ${codeList(agentResultReplay.cacheableStatuses)}. Partial and failed results are never cached. Entries use \`${agentResultReplay.pathLayout}\`, content/result digests, and atomic completed-file publication.`,
    '',
    '## Atomicity and Deferred Boundary',
    '',
    '- Artifact object bytes are content-addressed and immutable; a node batch becomes authoritative through one manifest publication. Canonical Worldview domain outputs become active only through the single completed run-publication marker described above.',
    `- ArtifactStore scope is \`${manifest.storeScope}\`; a cross-process single-writer lock serializes publication within each configured authority root without lost updates.`,
    '- Project WorkspaceService rejects traversal, absolute host paths, unauthorized mounts, and symlink escape. Idea-run execution additionally denies exact or nested Project mounts, Project tools, and Project write scopes. The durable typed event outbox remains the final WS-01 boundary.',
    '- The Agent success cache atomically publishes immutable entries and coalesces concurrent identical requests inside one backend wrapper; distributed locking is not claimed.',
    '',
  ];
  return lines.join('\n');
}
