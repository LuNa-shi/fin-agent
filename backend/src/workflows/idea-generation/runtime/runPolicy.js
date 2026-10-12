import { getAgentDefinition } from '../../../agents/registry.js';
import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { IDEA_GENERATION_WORKFLOW_SPEC_HASH } from '../workflowSpec.js';

export function ideaGenerationNodeInputDigest({
  context,
  node,
  dependencyArtifactRefs,
  run,
}) {
  return canonicalSha256({
    workflowSpecHash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    runInputDigest: run.inputDigest,
    runId: run.runId,
    nodeId: node.id,
    scope: context.scope,
    snapshotId: context.snapshot.snapshotId,
    dependencyArtifactRefs: dependencyArtifactRefs.map((ref) => ({
      artifactId: ref.artifactId,
      version: ref.version,
      contentDigest: ref.contentDigest,
    })),
  });
}

export function ideaGenerationRetryPolicyForNode(node) {
  const policies = (node.agentContractIds || [])
    .map((agentId) => getAgentDefinition(agentId).runPolicy.retry)
    .filter(Boolean);
  if (policies.length === 0) return { maxAttempts: 1, retryOn: [] };
  const maxAttempts = Math.min(...policies.map((policy) => policy.maxAttempts));
  const retryOn = policies.slice(1).reduce(
    (allowed, policy) => allowed.filter((reason) => policy.retryOn.includes(reason)),
    [...policies[0].retryOn],
  );
  return { maxAttempts, retryOn };
}

export function ideaGenerationWorkspaceSnapshot({ context }) {
  return context.snapshot.snapshotId;
}
