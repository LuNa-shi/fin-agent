import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a conflicting checkpoint WorkflowSpec identity fails before events or project state change', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workflow-conflict-'));
  process.env.DEMO_MODE = 'true';
  process.env.AUTO_RESUME = 'false';
  process.env.FIN_DATA_DIR = dataDir;

  let projectId;
  try {
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    const project = ProjectFS.create({
      title: 'Workflow identity conflict',
      theme: 'Fail closed before analysis',
      rationale: 'Checkpoint compatibility test.',
      tickers: ['NVDA'],
      intensity: 'quick',
    });
    projectId = project.id;
    const conflicting = {
      v: 2,
      done: false,
      workflowSpec: { id: 'other-workflow', version: '9.9.9', hash: 'sha256:conflict' },
    };
    ProjectFS.setCheckpoint(projectId, conflicting);
    ProjectFS.appendEvent(projectId, { type: 'sentinel', text: 'must survive conflict' });
    const beforeMeta = ProjectFS.meta(projectId);
    const beforeEvents = ProjectFS.events(projectId);

    await assert.rejects(
      runAnalysisWorkflow(projectId, { resume: true, intensity: 'quick' }),
      /checkpoint workflow spec conflict/i,
    );

    assert.deepEqual(ProjectFS.checkpoint(projectId), conflicting);
    assert.deepEqual(ProjectFS.events(projectId), beforeEvents);
    assert.deepEqual(ProjectFS.meta(projectId), beforeMeta);
  } finally {
    if (projectId) {
      const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
      ProjectFS.delete(projectId);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});


test('legacy checkpoint identity is rejected before RunStore reservation or project meta mutation', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workflow-legacy-resume-'));
  const originalDataDir = process.env.FIN_DATA_DIR;
  process.env.FIN_DATA_DIR = dataDir;
  t.after(() => {
    if (originalDataDir === undefined) delete process.env.FIN_DATA_DIR; else process.env.FIN_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
  const { reserveWorkflowRun } = await import('../src/workflows/run-analysis/policies/runPolicy.js');
  const { canonicalSha256 } = await import('../src/core/contracts/ArtifactRef.js');
  const { RUN_ANALYSIS_WORKFLOW_SPEC, RUN_ANALYSIS_WORKFLOW_SPEC_HASH } = await import('../src/workflows/run-analysis/workflowSpec.js');
  const project = ProjectFS.create({ title: 'Legacy checkpoint identity', theme: 'Fail closed', rationale: 'Reserve regression.', tickers: ['NVDA'], intensity: 'quick' });
  t.after(() => ProjectFS.delete(project.id));
  const runStore = ProjectFS.runStore(project.id);
  const asOf = '2026-08-14T00:00:00.000Z';
  const durableRun = runStore.begin({
    runId: 'artifact-run-existing',
    workflowSpec: { id: RUN_ANALYSIS_WORKFLOW_SPEC.id, version: RUN_ANALYSIS_WORKFLOW_SPEC.version, hash: RUN_ANALYSIS_WORKFLOW_SPEC_HASH },
    inputDigest: canonicalSha256({ legacyResume: true }),
    asOf,
    nodeIds: RUN_ANALYSIS_WORKFLOW_SPEC.nodes.map((node) => node.id),
  });
  const checkpoint = { v: 1, done: false, artifactRunId: durableRun.runId, round: 1, targetRounds: 1 };
  ProjectFS.setCheckpoint(project.id, checkpoint);
  const beforeMeta = ProjectFS.meta(project.id);
  const beforeRuns = runStore.list();
  assert.throws(
    () => reserveWorkflowRun(project.id, { resume: true, intensity: 'quick' }),
    /checkpoint workflow spec identity is missing/i,
  );
  assert.deepEqual(ProjectFS.meta(project.id), beforeMeta);
  assert.deepEqual(ProjectFS.runStore(project.id).list(), beforeRuns);
  assert.deepEqual(ProjectFS.checkpoint(project.id), checkpoint);
});
