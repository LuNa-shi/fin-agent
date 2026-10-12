import { createHash } from 'node:crypto';
import {
  contractArtifactPathAllowed,
  contractEnforcer,
} from '../../../core/validation/ContractEnforcer.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { ProjectSpace as ProjectFS } from '../../../project-space/index.js';
import { getAgentDefinition } from '../../../agents/registry.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../workflowSpec.js';
import {
  remediationIdentityDigestForNode,
  remediationIdentityForNode,
} from '../human-review/checkpoint.js';

function artifactPathMatches(pathValue, pattern) {
  return contractArtifactPathAllowed(pathValue, [pattern]).allowed;
}

function projectArtifactFiles(projectId) {
  return ProjectFS.files(projectId).filter((file) => !file.dir).map((file) => file.name);
}

export function assertContractArtifactsCommitted(projectId, contractId, paths = projectArtifactFiles(projectId)) {
  contractEnforcer.assertArtifactsCommitted({
    contract: getAgentDefinition(contractId),
    artifacts: paths,
  });
}

function dependencyArtifactRefs(context, node) {
  const executions = context.cp?.nodeExecutions || {};
  return (node.dependsOn || []).flatMap((nodeId) => executions[nodeId]?.artifactRefs || []);
}

function formalArtifactCommit({ context, node, path: relPath, producer, schemaVersion, contractVersion, inputArtifactRefs }) {
  const { cp } = context;
  const remediationIdentity = remediationIdentityForNode(cp, node.id);
  const humanReviewIdentity = remediationIdentity?.kind === 'human-review'
    ? remediationIdentity
    : null;
  const remediationCycle = humanReviewIdentity
    ? humanReviewIdentity.automaticRemediationCycle
    : (remediationIdentity?.cycle || 0);
  const identityDigest = humanReviewIdentity
    ? remediationIdentityDigestForNode(cp, node.id)
    : null;
  const inputDigest = canonicalSha256({
    workflowSpecHash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
    artifactRunId: cp.artifactRunId,
    artifactAsOf: cp.artifactAsOf,
    nodeId: node.id,
    path: relPath,
    remediationCycle,
    ...(humanReviewIdentity ? { humanReviewIdentity } : {}),
    inputArtifactRefs: inputArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      version: ref.version,
      contentDigest: ref.contentDigest,
    })),
  });
  const remediationSuffix = humanReviewIdentity
    ? `:human-review:${humanReviewIdentity.humanReviewAttempt}:${identityDigest.slice('sha256:'.length)}`
    : (remediationCycle ? `:remediation:${remediationCycle}` : '');
  return {
    path: relPath,
    metadata: {
      runId: cp.artifactRunId,
      nodeId: node.id,
      idempotencyKey: `${cp.artifactRunId}:${node.id}:${producer}:${relPath}${remediationSuffix}`,
      schemaVersion,
      producer,
      contractVersion,
      inputDigest,
      asOf: cp.artifactAsOf,
      inputArtifactRefs,
    },
  };
}

function roundPatternsForNode(pattern, node, result, selectedRoundField = null) {
  const roundField = selectedRoundField || node.artifactSelection?.roundField;
  const declaredRounds = node.artifactSelection?.rounds;
  if ((!roundField && !declaredRounds) || !/(?:_rN\b|rN\b|_N\b)/u.test(pattern)) return [pattern];
  const rounds = (declaredRounds || (Array.isArray(result) ? result : [result])
    .map((item) => Number(item?.[roundField])))
    .filter((round) => Number.isInteger(round) && round > 0);
  return [...new Set(rounds)].map((round) => String(pattern)
    .replace(/_rN\b/gu, `_r${round}`)
    .replace(/rN\b/gu, `r${round}`)
    .replace(/_N\b/gu, `_${round}`));
}

function resolveContractArtifactPaths(projectId, contract, node, result, paths = projectArtifactFiles(projectId)) {
  const outputPaths = contract.outputPaths || [];
  const selectedPatterns = outputPaths.flatMap((pattern) => roundPatternsForNode(pattern, node, result));
  const formal = paths.filter((file) => selectedPatterns.some((pattern) => artifactPathMatches(file, pattern)));
  return [...new Set(formal)].sort();
}

function contractArtifactCommits({ context, node, contractId, inputArtifactRefs, paths, result }) {
  const contract = getAgentDefinition(contractId);
  const selectedPaths = resolveContractArtifactPaths(context.id, contract, node, result, paths);
  assertContractArtifactsCommitted(context.id, contractId, selectedPaths);
  return selectedPaths.map((relPath) => formalArtifactCommit({
    context,
    node,
    path: relPath,
    producer: contract.id,
    schemaVersion: contract.outputSchema,
    contractVersion: contract.version,
    inputArtifactRefs,
  }));
}

function resultField(value, field) {
  return String(field || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function declaredArtifactPaths({ context, node, paths, result }) {
  if (!node.artifacts?.outputPaths?.length) return [];
  const declaredRoundField = node.artifactSelection?.declaredRoundField;
  const resultSelectors = node.artifactSelection?.resultPaths || [];
  const resultPatterns = new Set(resultSelectors.map((selector) => selector.pattern));
  const filePatterns = node.artifacts.outputPaths
    .filter((pattern) => !resultPatterns.has(pattern))
    .flatMap((pattern) => roundPatternsForNode(pattern, node, result, declaredRoundField));
  const formal = paths.filter((file) => filePatterns.some((pattern) => artifactPathMatches(file, pattern)));

  for (const selector of resultSelectors) {
    const priorRef = context.cp?.nodeExecutions?.[node.id]?.artifactRefs
      ?.find((ref) => artifactPathMatches(ref.path, selector.pattern));
    const candidate = resultField(result, selector.field) || priorRef?.path;
    const { safe, allowed } = contractArtifactPathAllowed(candidate, [selector.pattern]);
    if (!safe || !allowed || !paths.includes(safe)) {
      if (selector.required) {
        const error = new Error(`Node completion rejected for ${node.id}: result artifact is absent: ${selector.field}`);
        error.code = 'CONTRACT_COMPLETION_REJECTED';
        error.errors = [`result artifact is absent: ${selector.field}`];
        throw error;
      }
      continue;
    }
    formal.push(safe);
  }

  const unique = [...new Set(formal)].sort();
  // Scorecards are independent observational artifacts. Their evaluator can
  // fail closed without invalidating the three-reviewer node or requiring a
  // partial/current scorecard set here.
  const required = (node.artifacts.requiredArtifacts || [])
    .filter((pattern) => !pattern.startsWith('analysis/scorecards/'))
    .flatMap((pattern) => roundPatternsForNode(pattern, node, result, declaredRoundField));
  for (const pattern of required) {
    if (!unique.some((file) => artifactPathMatches(file, pattern))) {
      const error = new Error(`Node completion rejected for ${node.id}: required artifact is absent: ${pattern}`);
      error.code = 'CONTRACT_COMPLETION_REJECTED';
      error.errors = [`required artifact is absent: ${pattern}`];
      throw error;
    }
  }
  return unique;
}

function declaredPathContract(node, relPath) {
  return (node.artifacts?.pathContracts || []).find((contract) => (
    artifactPathMatches(relPath, contract.pattern)
  )) || null;
}

function declaredArtifactCommits({ context, node, inputArtifactRefs, paths, result }) {
  const remediationOwners = context.cp?.activeRemediation?.owners || [];
  if (
    node.artifacts?.producer === 'data-evidence-pipeline'
    && context.cp?.activeRemediation
    && !remediationOwners.includes('data')
  ) return [];
  return declaredArtifactPaths({ context, node, paths, result }).map((relPath) => {
    const contract = declaredPathContract(node, relPath);
    return formalArtifactCommit({
      context,
      node,
      path: relPath,
      producer: contract?.producer || node.artifacts.producer,
      schemaVersion: contract?.schemaVersion || node.artifacts.schemaVersion,
      contractVersion: contract ? getAgentDefinition(contract.producer).version : RUN_ANALYSIS_WORKFLOW_SPEC.version,
      inputArtifactRefs,
    });
  });
}

const RESEARCH_REMEDIATION_CONTRACTS = Object.freeze({
  data: ['data-orchestrator'],
  industry: ['industry-analyst'],
  company: ['company-analyst'],
});

function completionContractIds(context, node) {
  if (node.id !== 'run-research-rounds' || !context.cp?.activeRemediation) return node.agentContractIds || [];
  const selected = new Set();
  for (const owner of context.cp.activeRemediation.owners || []) {
    for (const contractId of RESEARCH_REMEDIATION_CONTRACTS[owner] || []) selected.add(contractId);
  }
  return (node.agentContractIds || []).filter((contractId) => selected.has(contractId));
}

function mergeArtifactRefs(...groups) {
  const byIdentity = new Map();
  for (const ref of groups.flat()) {
    if (!ref?.artifactId || !Number.isInteger(ref.version)) continue;
    byIdentity.set(ref.path || ref.artifactId, ref);
  }
  return [...byIdentity.values()];
}

function recordCheckpointNodeExecution({ context, node, result, refs }) {
  if (!context.cp) return;
  context.cp.nodeExecutions = context.cp.nodeExecutions || {};
  const checkpointOutput = result === context.cp
    ? { checkpointInitialized: true, artifactRunId: context.cp.artifactRunId }
    : result;
  const entry = {
    status: 'succeeded',
    output: checkpointOutput,
    artifactRefs: refs,
  };
  const durable = context.runStore?.load(context.runId)?.nodes?.[node.id];
  if (durable) {
    entry.attempt = durable.attempt;
    entry.inputDigest = durable.inputDigest;
    entry.stopReason = 'final';
  }
  if (refs.length === 0 && node.artifactPolicy === 'pure-return') entry.artifactPolicy = 'pure-return';
  context.cp.nodeExecutions[node.id] = entry;
  context.cp.nodeExecutions = Object.fromEntries(
    RUN_ANALYSIS_WORKFLOW_SPEC.nodes
      .map((workflowNode) => [workflowNode.id, context.cp.nodeExecutions[workflowNode.id]])
      .filter(([, execution]) => execution !== undefined),
  );
  context.saveCp?.();
}

export function assertWorkflowNodeCompletion({ node, context, result }) {
  const paths = projectArtifactFiles(context.id);
  const inputArtifactRefs = dependencyArtifactRefs(context, node);
  const commits = [];
  for (const contractId of completionContractIds(context, node)) {
    commits.push(...contractArtifactCommits({ context, node, contractId, inputArtifactRefs, paths, result }));
  }
  commits.push(...declaredArtifactCommits({ context, node, inputArtifactRefs, paths, result }));

  const uniqueCommits = [];
  const authorityByPath = new Map();
  for (const commit of commits) {
    const prior = authorityByPath.get(commit.path);
    if (prior && prior !== commit.metadata.producer) {
      const error = new Error(`Artifact authority conflict for ${commit.path}: ${prior} vs ${commit.metadata.producer}`);
      error.code = 'ARTIFACT_AUTHORITY_CONFLICT';
      throw error;
    }
    if (!prior) uniqueCommits.push(commit);
    authorityByPath.set(commit.path, commit.metadata.producer);
  }

  const committedRefs = uniqueCommits.length ? ProjectFS.commitArtifactFiles(context.id, uniqueCommits) : [];
  const carriedRefs = node.id === 'run-research-rounds'
    ? (context.cp?.activeRemediation?.priorNodeArtifactRefs?.[node.id] || [])
    : [];
  const refs = mergeArtifactRefs(carriedRefs, committedRefs);
  let output = result;
  if (node.id === 'finalize-project' && result?.metaPatch) {
    output = ProjectFS.updateMeta(context.id, result.metaPatch);
    context.cp.done = true;
  }
  recordCheckpointNodeExecution({ context, node, result: output, refs });
  return { artifacts: refs, output };
}

function hydrationError(nodeId, message) {
  const error = new Error(`Node hydration rejected for ${nodeId}: ${message}`);
  error.code = 'CONTRACT_COMPLETION_REJECTED';
  error.errors = [message];
  return error;
}

export function validateWorkflowNodeHydration({ context, node, record }) {
  const refs = (record?.artifactRefs || []).map((ref) => ({ ...ref }));
  if (node.artifactPolicy === 'pure-return' && refs.length === 0) return true;
  if (refs.length === 0) throw hydrationError(node.id, 'durable ArtifactRefs are absent');
  const currentPaths = new Set(projectArtifactFiles(context.id));
  const artifactStore = ProjectFS.artifactStore(context.id);
  for (const ref of refs) {
    if (!currentPaths.has(ref.path)) throw hydrationError(node.id, `artifact file is absent: ${ref.path}`);
    artifactStore.read(ref);
    const content = ProjectFS.fileContent(context.id, ref.path);
    const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (contentDigest !== ref.contentDigest) throw hydrationError(node.id, `artifact file digest changed: ${ref.path}`);
  }
  const paths = refs.map((ref) => ref.path);
  for (const contractId of node.agentContractIds || []) assertContractArtifactsCommitted(context.id, contractId, paths);
  for (const required of node.artifacts?.requiredArtifacts || []) {
    if (required.startsWith('analysis/scorecards/')) continue;
    if (!paths.some((relPath) => artifactPathMatches(relPath, required))) {
      throw hydrationError(node.id, `required artifact is absent: ${required}`);
    }
  }
  return true;
}
