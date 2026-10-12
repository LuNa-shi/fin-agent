import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCanonicalReportBackend } from './support/canonicalReportBackend.mjs';

test('historical checkpoint and ArtifactStore lineage import into RunStore without Agent re-execution', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-run-import-'));
  const originalDemo = process.env.DEMO_MODE;
  const originalResume = process.env.AUTO_RESUME;
  const originalDataDir = process.env.FIN_DATA_DIR;
  process.env.DEMO_MODE = 'true';
  process.env.AUTO_RESUME = 'false';
  process.env.FIN_DATA_DIR = dataDir;

  let projectId;
  let agentBackend;
  try {
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    agentBackend = await createCanonicalReportBackend(ProjectFS);
    const project = ProjectFS.create({
      title: 'Historical checkpoint import',
      theme: 'Durable resume verification',
      rationale: 'Rebuild RunStore from Gate A checkpoint and manifest.',
      tickers: ['NVDA'],
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
    });
    projectId = project.id;
    await runAnalysisWorkflow(projectId, {
      intensity: 'quick',
      resume: false,
      agentBackend,
    });

    const completed = ProjectFS.checkpoint(projectId);
    const eventsBefore = ProjectFS.events(projectId);
    const manifestVersions = ProjectFS.artifactManifest(projectId).versions.length;
    fs.rmSync(path.join(ProjectFS.dir(projectId), '.runs'), { recursive: true, force: true });
    const historical = { ...completed };
    delete historical.workflowSpec;
    delete historical.nodeExecutions;
    ProjectFS.setCheckpoint(projectId, historical);
    ProjectFS.updateMeta(projectId, { status: 'interrupted' });

    await assert.rejects(
      () => runAnalysisWorkflow(projectId, {
        intensity: 'quick',
        resume: true,
        agentBackend,
      }),
      /checkpoint workflow spec identity is missing|checkpoint workflow spec conflict/u,
    );
    assert.equal(ProjectFS.events(projectId).length, eventsBefore.length, 'legacy resume rejection must not mutate events');
    assert.equal(ProjectFS.artifactManifest(projectId).versions.length, manifestVersions, 'legacy resume rejection must not mutate artifacts');
    assert.deepEqual(Object.keys(ProjectFS.checkpoint(projectId).workflowSpec || {}), [], 'legacy checkpoint remains readable without silent migration');
  } finally {
    if (projectId) {
      const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
      ProjectFS.delete(projectId);
    }
    if (originalDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = originalDemo;
    if (originalResume === undefined) delete process.env.AUTO_RESUME; else process.env.AUTO_RESUME = originalResume;
    if (originalDataDir === undefined) delete process.env.FIN_DATA_DIR; else process.env.FIN_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
