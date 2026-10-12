import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCanonicalReportBackend } from './support/canonicalReportBackend.mjs';

test('targeted scan commits analysis/scan.json and resume cannot skip a missing required artifact', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-output-contract-'));
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
    const { validateArtifactRef } = await import('../src/core/contracts/ArtifactRef.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    agentBackend = await createCanonicalReportBackend(ProjectFS);
    const project = ProjectFS.create({
      title: 'Targeted scan checkpoint contract',
      theme: 'Google advertising and cloud verification',
      rationale: 'Exercise targeted scan path.',
      tickers: ['GOOGL'],
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
      companyLocale: 'global',
    });
    projectId = project.id;

    ProjectFS.setReportText(projectId, 'report_19990101_000000.md', '# stale report from a prior run\n');
    ProjectFS.setDataFile(projectId, 'organized_r99.json', { stale: true });
    ProjectFS.setAnalysisText(projectId, 'industry_report_r99.md', '# stale round\n');
    ProjectFS.setAnalysisFile(projectId, 'reviews/evidence_r99.json', { stale: true });

    await runAnalysisWorkflow(projectId, {
      intensity: 'quick',
      resume: false,
      agentBackend,
    });
    const checkpoint = ProjectFS.checkpoint(projectId);
    const scanFile = ProjectFS.fileContent(projectId, 'analysis/scan.json');
    const manifest = ProjectFS.artifactManifest(projectId);
    const lineage = ProjectFS.artifactLineage(projectId, checkpoint.artifactRunId);

    assert.ok(checkpoint?.scan, 'checkpoint must include scan state');
    assert.match(checkpoint.artifactRunId, /^artifact-run-[A-Za-z0-9_-]+$/u);
    assert.match(checkpoint.artifactAsOf, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(scanFile, 'scan state must also exist as analysis/scan.json');
    assert.deepEqual(JSON.parse(scanFile), checkpoint.scan);
    assert.equal(manifest.versions.length > 0, true);
    assert.equal(lineage.length, manifest.versions.length);
    assert.ok(lineage.every((entry) => entry.runId === checkpoint.artifactRunId));
    assert.ok(checkpoint.nodeExecutions['select-candidates'].artifactRefs.some((ref) => ref.path === 'analysis/scan.json'));
    assert.deepEqual(checkpoint.nodeExecutions['initialize-checkpoint'].artifactPolicy, 'pure-return');
    for (const [nodeId, execution] of Object.entries(checkpoint.nodeExecutions)) {
      assert.equal(execution.status, 'succeeded', nodeId);
      if (nodeId === 'initialize-checkpoint') {
        assert.deepEqual(execution.artifactRefs, []);
        continue;
      }
      assert.ok(execution.artifactRefs.length > 0, `${nodeId} must expose at least one ArtifactRef`);
      for (const ref of execution.artifactRefs) {
        assert.equal(validateArtifactRef(ref).valid, true, `${nodeId} has an invalid ArtifactRef`);
      }
    }
    const finalPaths = checkpoint.nodeExecutions['finalize-project'].artifactRefs.map((ref) => ref.path).sort();
    assert.equal(finalPaths.includes('analysis/forecast.json'), false);
    assert.equal(finalPaths.includes('report/forecast_report.md'), false);
    assert.ok(finalPaths.some((item) => /^report\/report_\d{8}_\d{6}\.md$/u.test(item)));
    assert.equal(finalPaths.includes('report/report_19990101_000000.md'), false, 'prior-run reports are not current-run lineage');
    const roundPaths = checkpoint.nodeExecutions['run-research-rounds'].artifactRefs.map((ref) => ref.path);
    for (const required of [
      'data/data_plan_r1.json',
      'data/source_documents_r1.json',
      'data/evidence_bundle_r1.json',
      'data/citation_ledger.json',
      'data/domain_events_r1.json',
      'data/organized_r1.json',
      'data/data_report.md',
    ]) assert.ok(roundPaths.includes(required), `missing formal Data/Evidence artifact ${required}`);
    const evidenceBundle = JSON.parse(ProjectFS.fileContent(projectId, 'data/evidence_bundle_r1.json'));
    assert.equal(evidenceBundle.schemaVersion, '1.0.0');
    assert.ok(evidenceBundle.claimAudit.materialClaims > 0);
    assert.equal(evidenceBundle.claimAudit.classificationRate, 1);
    assert.ok(evidenceBundle.claimAudit.citationCoverage > 0);
    assert.ok(evidenceBundle.claimAudit.citationCoverage < 1);
    assert.ok(evidenceBundle.openIssues.some((issue) => (
      issue.owner === 'data'
      && issue.severity === 'warning'
      && issue.claim.includes('used atomic EvidenceItems')
    )));
    assert.ok(evidenceBundle.items.every((item) => item.sourceId && item.locator && item.publishedAt && item.observedAt && item.evidenceType));
    assert.equal(roundPaths.includes('data/organized_r99.json'), false, 'prior-run round data is not current-run lineage');
    assert.equal(roundPaths.includes('analysis/industry_report_r99.md'), false, 'prior-run analysis is not current-run lineage');
    const reviewPaths = checkpoint.nodeExecutions['review-report'].artifactRefs.map((ref) => ref.path);
    assert.equal(reviewPaths.includes('analysis/reviews/evidence_r99.json'), false, 'prior-run reviews are not current-run lineage');
    assert.equal(finalPaths.includes('analysis/fidelity.json'), false);

    fs.unlinkSync(path.join(ProjectFS.sub(projectId, 'analysis'), 'scan.json'));
    ProjectFS.setCheckpoint(projectId, { ...checkpoint, done: false });

    await assert.rejects(
      () => runAnalysisWorkflow(projectId, {
        intensity: 'quick',
        resume: true,
        agentBackend,
      }),
      (error) => error.code === 'CONTRACT_COMPLETION_REJECTED'
        && error.errors.some((item) => item.includes('analysis/scan.json')),
    );
    assert.equal(ProjectFS.fileContent(projectId, 'analysis/scan.json'), null);
    assert.ok(ProjectFS.checkpoint(projectId)?.scan, 'failed resume must not erase the prior checkpoint payload');

    ProjectFS.setAnalysisFile(projectId, 'scan.json', checkpoint.scan);
    const beforeResumeVersions = ProjectFS.artifactManifest(projectId).versions.length;
    await runAnalysisWorkflow(projectId, {
      intensity: 'quick',
      resume: true,
      agentBackend,
    });
    const resumed = ProjectFS.checkpoint(projectId);
    assert.equal(resumed.artifactRunId, checkpoint.artifactRunId);
    assert.equal(resumed.artifactAsOf, checkpoint.artifactAsOf);
    assert.deepEqual(resumed.nodeExecutions['select-candidates'].artifactRefs, checkpoint.nodeExecutions['select-candidates'].artifactRefs);
    assert.equal(ProjectFS.artifactManifest(projectId).versions.length, beforeResumeVersions);
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

test('finalization does not publish SUCCEEDED state before the artifact batch commits', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-output-finalize-'));
  const originalDemo = process.env.DEMO_MODE;
  const originalResume = process.env.AUTO_RESUME;
  const originalDataDir = process.env.FIN_DATA_DIR;
  process.env.DEMO_MODE = 'true';
  process.env.AUTO_RESUME = 'false';
  process.env.FIN_DATA_DIR = dataDir;

  let projectId;
  let originalCommitMany;
  let agentBackend;
  try {
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    agentBackend = await createCanonicalReportBackend(ProjectFS);
    const project = ProjectFS.create({
      title: 'Finalization artifact boundary',
      theme: 'Artifact commit failure injection',
      rationale: 'A final node must remain incomplete when its atomic commit fails.',
      tickers: ['GOOGL'],
      intensity: 'quick',
      analysisLanguage: 'en',
      reportLanguage: 'en',
      companyLocale: 'global',
    });
    projectId = project.id;
    originalCommitMany = ProjectFS.commitArtifactFiles;
    ProjectFS.commitArtifactFiles = function failFinalBatch(id, items) {
      if (items.some((item) => item.metadata?.nodeId === 'finalize-project')) {
        const error = new Error('injected final artifact batch failure');
        error.code = 'INJECTED_ARTIFACT_COMMIT_FAILURE';
        throw error;
      }
      return originalCommitMany.call(this, id, items);
    };

    await assert.rejects(
      () => runAnalysisWorkflow(projectId, {
        intensity: 'quick',
        resume: false,
        agentBackend,
      }),
      (error) => error.code === 'INJECTED_ARTIFACT_COMMIT_FAILURE',
    );
    const checkpoint = ProjectFS.checkpoint(projectId);
    assert.notEqual(checkpoint.done, true);
    assert.equal(checkpoint.nodeExecutions?.['finalize-project'], undefined);
    assert.notEqual(ProjectFS.meta(projectId).status, 'analyzed');
    assert.equal(
      ProjectFS.artifactLineage(projectId, checkpoint.artifactRunId).some((entry) => entry.nodeId === 'finalize-project'),
      false,
      'a rejected node batch must publish no partial finalizer lineage',
    );
  } finally {
    const { ProjectSpace: ProjectFS } = await import('../src/project-space/index.js');
    if (originalCommitMany) ProjectFS.commitArtifactFiles = originalCommitMany;
    if (projectId) ProjectFS.delete(projectId);
    if (originalDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = originalDemo;
    if (originalResume === undefined) delete process.env.AUTO_RESUME; else process.env.AUTO_RESUME = originalResume;
    if (originalDataDir === undefined) delete process.env.FIN_DATA_DIR; else process.env.FIN_DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
