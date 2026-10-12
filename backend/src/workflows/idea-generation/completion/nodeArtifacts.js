import {
  canonicalSha256,
  deepFreeze,
} from '../../../core/contracts/ArtifactRef.js';
import { NODE_STATES } from '../../../core/workflow/NodeState.js';

export const IDEA_NODE_OUTPUT_SCHEMA_VERSION = 'idea-generation-node-output.v1';
export const IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT = deepFreeze({
  authority: 'artifact',
  artifactCount: 1,
  artifactIdTemplate: '<runId>:<nodeId>',
  pathTemplate: 'outputs/<nodeId>.json',
  producerTemplate: 'idea-generation.v2/<handlerId>',
  contractVersion: '1.0.0',
  envelopeSchemaVersion: IDEA_NODE_OUTPUT_SCHEMA_VERSION,
});

function artifactId(runId, nodeId) {
  return IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.artifactIdTemplate
    .replace('<runId>', runId)
    .replace('<nodeId>', nodeId);
}

function artifactPath(nodeId) {
  return IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.pathTemplate.replace('<nodeId>', nodeId);
}

export function ideaNodeOutputArtifactDeclaration(node) {
  if (
    !node
    || typeof node.id !== 'string'
    || !node.id
    || typeof node.handlerId !== 'string'
    || !node.handlerId
  ) {
    throw new TypeError('canonical Idea Generation node identity is required');
  }
  const outputPath = artifactPath(node.id);
  return deepFreeze({
    producer: IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.producerTemplate
      .replace('<handlerId>', node.handlerId),
    authority: IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.authority,
    requiredArtifacts: [outputPath],
    outputPaths: [outputPath],
    schemaVersion: `${node.id}.output.v1`,
    contractVersion: IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.contractVersion,
  });
}

function outputEnvelope({ context, node, output }) {
  return {
    schemaVersion: IDEA_NODE_OUTPUT_SCHEMA_VERSION,
    workflowId: context.spec.id,
    runId: context.runId,
    nodeId: node.id,
    snapshotId: context.snapshot.snapshotId,
    asOf: context.snapshot.asOf,
    output,
  };
}

function parseEnvelope(text, { context, node }) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Idea Generation node artifact is unreadable: ${node.id}`);
  }
  const expected = {
    schemaVersion: IDEA_NODE_OUTPUT_SCHEMA_VERSION,
    workflowId: context.spec.id,
    runId: context.runId,
    nodeId: node.id,
    snapshotId: context.snapshot.snapshotId,
    asOf: context.snapshot.asOf,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value?.[field] !== expectedValue) {
      const error = new Error(`Idea Generation node artifact ${field} mismatch: ${node.id}`);
      error.code = 'IDEA_NODE_ARTIFACT_IDENTITY_MISMATCH';
      throw error;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'output')) {
    const error = new Error(`Idea Generation node artifact output is missing: ${node.id}`);
    error.code = 'IDEA_NODE_ARTIFACT_INVALID';
    throw error;
  }
  return value.output;
}

export function commitIdeaNodeOutput({
  context,
  node,
  result,
  dependencyArtifactRefs = null,
}) {
  const declaration = ideaNodeOutputArtifactDeclaration(node);
  const record = context.runStore.load(context.runId)?.nodes?.[node.id];
  if (!record?.inputDigest) {
    throw new Error(`Idea Generation node input digest is missing: ${node.id}`);
  }
  const inputArtifactRefs = Array.isArray(dependencyArtifactRefs)
    ? dependencyArtifactRefs
    : (node.dependsOn || [])
        .flatMap((dependencyId) => (
          context.nodeExecutions?.[dependencyId]?.artifactRefs || []
        ));
  const [ref] = context.artifactStore.commitMany([{
    artifactId: artifactId(context.runId, node.id),
    path: artifactPath(node.id),
    schemaVersion: declaration.schemaVersion,
    producer: declaration.producer,
    contractVersion: declaration.contractVersion,
    content: outputEnvelope({ context, node, output: result }),
    runId: context.runId,
    nodeId: node.id,
    idempotencyKey: `${context.runId}:${node.id}:completion`,
    inputDigest: record.inputDigest,
    inputArtifactRefs,
    asOf: context.snapshot.asOf,
  }]);
  return { artifacts: [ref], output: result };
}

export function hydrateIdeaNodeOutput(context, node, { record } = {}) {
  if (!record || record.status !== NODE_STATES.SUCCEEDED) {
    throw new Error(`Idea Generation node is not durably succeeded: ${node.id}`);
  }
  if (!Array.isArray(record.artifactRefs) || record.artifactRefs.length !== 1) {
    throw new Error(`Idea Generation node requires exactly one ArtifactRef: ${node.id}`);
  }
  const [ref] = record.artifactRefs;
  if (
    ref.artifactId !== artifactId(context.runId, node.id)
    || ref.path !== artifactPath(node.id)
    || ref.inputDigest !== record.inputDigest
  ) {
    const error = new Error(`Idea Generation node ArtifactRef conflicts with durable state: ${node.id}`);
    error.code = 'IDEA_NODE_ARTIFACT_IDENTITY_MISMATCH';
    throw error;
  }
  const output = parseEnvelope(context.artifactStore.read(ref), { context, node });
  if (canonicalSha256(output) !== record.outputDigest) {
    const error = new Error(`Idea Generation node output digest mismatch: ${node.id}`);
    error.code = 'IDEA_NODE_OUTPUT_DIGEST_MISMATCH';
    throw error;
  }
  return output;
}

export function reconcileCommittedIdeaNodeOutputs(context) {
  let run = context.runStore.load(context.runId);
  for (const node of context.spec.nodes) {
    const record = run?.nodes?.[node.id];
    if (
      !record
      || record.status === NODE_STATES.SUCCEEDED
      || typeof record.inputDigest !== 'string'
    ) continue;
    const matches = context.artifactStore.history(artifactId(context.runId, node.id))
      .filter((ref) => (
        ref.path === artifactPath(node.id)
        && ref.inputDigest === record.inputDigest
      ));
    if (matches.length === 0) continue;
    if (matches.length !== 1) {
      const error = new Error(`Idea Generation node has ambiguous committed artifacts: ${node.id}`);
      error.code = 'IDEA_NODE_ARTIFACT_CONFLICT';
      throw error;
    }
    const output = parseEnvelope(
      context.artifactStore.read(matches[0]),
      { context, node },
    );
    context.artifactStore.reconcileCommittedEvent(matches[0]);
    context.runStore.reconcileSucceededNode(context.runId, node.id, {
      artifactRefs: matches,
      output,
      attempt: Math.max(record.attempt, 1),
    });
    run = context.runStore.load(context.runId);
  }
  return run;
}
