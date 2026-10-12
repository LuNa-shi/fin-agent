import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { ideaGenerationTrace } from '../src/workflows/idea-generation/runApiProjection.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from '../src/workflows/idea-generation/workflowSpec.js';

const RUN_ID = 'idea_run_exact_screen_projection';
const AS_OF = '2026-07-23T08:00:00.000Z';
const SNAPSHOT_ID = `idea-run-input-snapshot:${'b'.repeat(64)}`;
const OUTPUTS = {
  'verify-candidates': {
    validIdeas: [
      { id: 'idea_one', title: 'One', tickers: ['GEV'] },
      { id: 'idea_two', title: 'Two', tickers: ['ETN'] },
    ],
    rejected: [{ index: 2, reason: 'missing-title' }],
    tickerVerification: {
      requested: ['GEV', 'ETN', 'BAD'],
      valid: ['GEV', 'ETN'],
      invalid: ['BAD'],
    },
  },
  'review-quality': {
    ideas: [
      { id: 'idea_one', title: 'One', qualityRank: 1 },
      { id: 'idea_two', title: 'Two', qualityRank: 2 },
    ],
    annotations: [
      { ideaId: 'idea_one', rank: 1, selected: true },
      { ideaId: 'idea_two', rank: 2, selected: false },
    ],
    agent: { provider: 'fixture', live: false },
  },
};

function artifactRef(nodeId, output, index) {
  return {
    contract: 'artifact-ref.v1',
    artifactId: `${RUN_ID}:${nodeId}`,
    version: 1,
    path: `outputs/${nodeId}.json`,
    contentDigest: canonicalSha256({ nodeId, output }),
    schemaVersion: `${nodeId}.output.v1`,
    producer: `idea-generation.v2/${nodeId}`,
    contractVersion: '1.0.0',
    inputDigest: `sha256:${String(index + 1).repeat(64)}`,
    createdAt: AS_OF,
    asOf: AS_OF,
  };
}

function projectionStorage() {
  const artifacts = new Map();
  const nodes = Object.fromEntries(IDEA_GENERATION_WORKFLOW_SPEC.nodes.map((node, index) => {
    const output = OUTPUTS[node.id];
    const ref = output ? artifactRef(node.id, output, index) : null;
    if (ref) {
      artifacts.set(ref.artifactId, JSON.stringify({
        schemaVersion: 'idea-generation-node-output.v1',
        workflowId: IDEA_GENERATION_WORKFLOW_SPEC.id,
        runId: RUN_ID,
        nodeId: node.id,
        snapshotId: SNAPSHOT_ID,
        asOf: AS_OF,
        output,
      }));
    }
    return [node.id, {
      nodeId: node.id,
      status: 'SUCCEEDED',
      attempt: 1,
      inputDigest: ref?.inputDigest || `sha256:${String(index + 1).repeat(64)}`,
      outputDigest: output ? canonicalSha256(output) : canonicalSha256(null),
      stopReason: 'final',
      artifactRefs: ref ? [ref] : [],
      startedAt: AS_OF,
      completedAt: AS_OF,
      lastFailure: null,
      imported: false,
    }];
  }));
  const record = {
    projectId: 'idea-universe:local-user',
    runId: RUN_ID,
    workflowSpec: {
      id: IDEA_GENERATION_WORKFLOW_SPEC.id,
      version: IDEA_GENERATION_WORKFLOW_SPEC.version,
      hash: IDEA_GENERATION_WORKFLOW_SPEC_HASH,
    },
    inputDigest: `sha256:${'c'.repeat(64)}`,
    asOf: AS_OF,
    status: 'SUCCEEDED',
    stopReason: 'final',
    resumeCount: 0,
    remediationCycle: 0,
    createdAt: AS_OF,
    updatedAt: AS_OF,
    completedAt: AS_OF,
    scope: { kind: 'idea-universe', id: 'idea-universe:local-user' },
    workspaceMode: 'idea-run',
    workspaceSnapshotId: SNAPSHOT_ID,
    nodes,
  };
  return {
    list: () => [record],
    services: () => ({
      snapshot: {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        asOf: AS_OF,
        configDigest: `sha256:${'d'.repeat(64)}`,
        inputs: { command: { count: 2 } },
      },
      scope: record.scope,
      eventBus: {
        list: () => [],
        replay: () => ({ runs: {}, events: [] }),
      },
      artifactStore: {
        read(ref) {
          const artifact = artifacts.get(ref.artifactId);
          if (!artifact) throw new Error(`missing fixture artifact: ${ref.artifactId}`);
          return artifact;
        },
      },
    }),
  };
}

test('exact verify and review screen projections describe only known durable output', () => {
  const storage = projectionStorage();
  const verified = ideaGenerationTrace(RUN_ID, {
    nodeId: 'verify-candidates',
  }, { storage });
  assert.equal(verified.steps.length, 1);
  assert.equal(verified.steps[0].status, 'done');
  assert.match(verified.steps[0].text, /质量评分由 review-quality 节点单独记录/u);
  assert.doesNotMatch(verified.steps[0].text, /等待/u);
  assert.doesNotMatch(verified.steps[0].text, /质量审阅仅评分和排序/u);
  assert.deepEqual(verified.steps[0].data, {
    validTickers: ['GEV', 'ETN'],
    droppedTickers: ['BAD'],
    validIdeas: 2,
    rejected: 1,
  });

  const reviewed = ideaGenerationTrace(RUN_ID, {
    nodeId: 'review-quality',
  }, { storage });
  assert.equal(reviewed.steps.length, 1);
  assert.equal(reviewed.steps[0].status, 'done');
  assert.match(reviewed.steps[0].text, /已记录 2 条质量评分与排序注释/u);
  assert.doesNotMatch(reviewed.steps[0].text, /等待规范化/u);
  assert.deepEqual(reviewed.steps[0].data, { annotations: 2 });
  assert.equal(reviewed.nodeOutput.annotations.length, 2);
});
