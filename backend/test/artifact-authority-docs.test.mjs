import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ARTIFACT_AUTHORITY_AUDIT,
  ARTIFACT_AUTHORITY_AUDIT_HASH,
  renderArtifactAuthorityMarkdown,
  validateArtifactAuthorityAudit,
} from '../scripts/support/artifactAuthorityDocs.js';
import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
} from '../src/core/contracts/ArtifactRef.js';
import {
  AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS,
  AGENT_RESULT_LOGICAL_INPUT_FIELDS,
} from '../src/core/agent-backend/AgentResultIdempotencyStore.js';
import { ARTIFACT_MANIFEST_CONTRACT } from '../src/project-space/ArtifactStore.js';
import {
  IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT,
} from '../src/workflows/idea-generation/completion/nodeArtifacts.js';
import {
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH,
} from '../src/workflows/idea-generation/workflowSpec.js';
import {
  RUN_ANALYSIS_WORKFLOW_SPEC,
  RUN_ANALYSIS_WORKFLOW_SPEC_HASH,
} from '../src/workflows/run-analysis/workflowSpec.js';
import { CANONICAL_WORLDVIEW_WORKFLOW_SPEC, CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH } from '../src/workflows/worldview/canonicalWorkflowSpec.js';

test('artifact authority audit derives every runtime contract and Workflow node', () => {
  assert.equal(validateArtifactAuthorityAudit(), true);
  assert.deepEqual(ARTIFACT_AUTHORITY_AUDIT.artifactRef.requiredFields, ARTIFACT_REF_REQUIRED_FIELDS);
  assert.deepEqual(ARTIFACT_AUTHORITY_AUDIT.artifactRef.locationFields, ARTIFACT_REF_LOCATION_FIELDS);
  assert.deepEqual(ARTIFACT_AUTHORITY_AUDIT.manifest, ARTIFACT_MANIFEST_CONTRACT);
  assert.deepEqual(ARTIFACT_AUTHORITY_AUDIT.agentResultReplay.scopeFields, AGENT_RESULT_IDEMPOTENCY_SCOPE_FIELDS);
  assert.deepEqual(ARTIFACT_AUTHORITY_AUDIT.agentResultReplay.logicalInputFields, AGENT_RESULT_LOGICAL_INPUT_FIELDS);
  assert.deepEqual(
    ARTIFACT_AUTHORITY_AUDIT.workflows.map((workflow) => workflow.id),
    [
      RUN_ANALYSIS_WORKFLOW_SPEC.id,
      IDEA_GENERATION_WORKFLOW_SPEC.id,
      CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id,
    ],
  );
  const runAnalysis = ARTIFACT_AUTHORITY_AUDIT.workflows[0];
  const ideaGeneration = ARTIFACT_AUTHORITY_AUDIT.workflows[1];
  const canonicalWorldview = ARTIFACT_AUTHORITY_AUDIT.workflows[2];
  assert.equal(runAnalysis.hash, RUN_ANALYSIS_WORKFLOW_SPEC_HASH);
  assert.equal(runAnalysis.nodes.length, RUN_ANALYSIS_WORKFLOW_SPEC.nodes.length);
  assert.equal(ideaGeneration.hash, IDEA_GENERATION_WORKFLOW_SPEC_HASH);
  assert.equal(ideaGeneration.nodes.length, IDEA_GENERATION_WORKFLOW_SPEC.nodes.length);
  assert.deepEqual(ideaGeneration.nodeOutputArtifact, IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT);
  assert.equal(ideaGeneration.manifestPath, 'idea-generation/runs/<runId>/.artifacts/manifest.json');
  assert.equal(canonicalWorldview.hash, CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH);
  assert.equal(canonicalWorldview.nodes.length, CANONICAL_WORLDVIEW_WORKFLOW_SPEC.nodes.length);
  assert.equal(canonicalWorldview.manifestPath, 'canonical-worldview/workflow-runs/<runId>/.artifacts/manifest.json');
});

test('every successful canonical Workflow node declares formal artifacts or explicit pure-return policy', () => {
  const pureReturnByWorkflow = {};
  for (const workflow of ARTIFACT_AUTHORITY_AUDIT.workflows) {
    const pureReturn = [];
    for (const node of workflow.nodes) {
      if (node.artifactPolicy === 'pure-return') {
        pureReturn.push(node.id);
        assert.deepEqual(node.requiredArtifacts, []);
        continue;
      }
      assert.equal(node.artifactCommitOwner, 'workflow');
      assert.ok(node.requiredArtifacts.length > 0, `${workflow.id}/${node.id} must declare required artifacts`);
      assert.ok(node.producers.length > 0, `${workflow.id}/${node.id} must declare artifact producers`);
      for (const required of node.requiredArtifacts) {
        assert.ok(node.outputPaths.includes(required), `${workflow.id}/${node.id} required path must be output-authorized: ${required}`);
      }
    }
    pureReturnByWorkflow[workflow.id] = pureReturn;
  }
  assert.deepEqual(pureReturnByWorkflow, {
    [RUN_ANALYSIS_WORKFLOW_SPEC.id]: ['initialize-checkpoint'],
    [IDEA_GENERATION_WORKFLOW_SPEC.id]: [],
    [CANONICAL_WORLDVIEW_WORKFLOW_SPEC.id]: [],
  });
});

test('Idea Generation keeps Agent return authority separate from its one Workflow-owned node artifact', () => {
  const workflow = ARTIFACT_AUTHORITY_AUDIT.workflows.find(
    (candidate) => candidate.id === IDEA_GENERATION_WORKFLOW_SPEC.id,
  );
  for (const node of workflow.nodes) {
    const expectedPath = IDEA_NODE_OUTPUT_ARTIFACT_CONTRACT.pathTemplate.replace('<nodeId>', node.id);
    assert.deepEqual(node.requiredArtifacts, [expectedPath]);
    assert.deepEqual(node.outputPaths, [expectedPath]);
    assert.ok(
      node.authorities.includes(`idea-generation.v2/${IDEA_GENERATION_WORKFLOW_SPEC.nodes.find((candidate) => candidate.id === node.id).handlerId}:artifact`),
    );
  }
  assert.ok(
    workflow.nodes.find((node) => node.id === 'generate-candidates').authorities.includes('idea-generator:return'),
  );
  assert.ok(
    workflow.nodes.find((node) => node.id === 'review-quality').authorities.includes('idea-quality-reviewer:return'),
  );
});

test('checked-in Artifact Authority Markdown is generated without drift', async () => {
  const checkedIn = await readFile(new URL('../../documents/generated/artifact-authority.md', import.meta.url), 'utf8');
  assert.equal(checkedIn, renderArtifactAuthorityMarkdown());
  assert.ok(checkedIn.includes(ARTIFACT_AUTHORITY_AUDIT_HASH));
  assert.ok(checkedIn.includes(RUN_ANALYSIS_WORKFLOW_SPEC_HASH));
  assert.ok(checkedIn.includes(IDEA_GENERATION_WORKFLOW_SPEC_HASH));
  assert.ok(checkedIn.includes(CANONICAL_WORLDVIEW_WORKFLOW_SPEC_HASH));
  assert.match(checkedIn, /projects\/<projectId>\/\.artifacts\/manifest\.json/u);
  assert.match(checkedIn, /idea-generation\/runs\/<runId>\/\.artifacts\/manifest\.json/u);
  assert.match(checkedIn, /canonical-worldview\/workflow-runs\/<runId>\/\.artifacts\/manifest\.json/u);
  assert.match(checkedIn, /runId[\s\S]*inputArtifactRefs[\s\S]*ref/u);
  assert.match(checkedIn, /explicit[\s\S]*zero backend\/model calls/u);
  assert.match(checkedIn, /artifactCommitOwner=workflow[\s\S]*no dual artifact authority/u);
  assert.match(checkedIn, /WS-01/u);
});
