import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-project-artifacts-'));
process.env.FIN_DATA_DIR = dataDir;

const { canonicalSha256 } = await import('../src/core/contracts/ArtifactRef.js');
const { ProjectSpace } = await import('../src/project-space/index.js');

function commitMeta(overrides = {}) {
  return {
    runId: 'artifact-run-1',
    nodeId: 'plan-research',
    idempotencyKey: 'artifact-run-1:plan-research:analysis/plan.json',
    schemaVersion: 'analysis-plan.output.v1',
    producer: 'analysis-plan',
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ nodeId: 'plan-research', seed: 'AAPL' }),
    asOf: '2026-07-15T00:00:00.000Z',
    inputArtifactRefs: [],
    ...overrides,
  };
}

test('Project Space commits existing canonical files into immutable ArtifactStore and hides .artifacts', () => {
  const project = ProjectSpace.create({
    title: 'Project artifact integration',
    theme: 'Artifact authority',
    tickers: ['AAPL'],
    intensity: 'quick',
  });
  try {
    ProjectSpace.setAnalysisFile(project.id, 'plan.json', { candidates: [{ ticker: 'AAPL' }] });

    const first = ProjectSpace.commitArtifactFile(project.id, 'analysis/plan.json', commitMeta());
    const replay = ProjectSpace.commitArtifactFile(project.id, 'analysis/plan.json', commitMeta());
    const canonicalBytes = ProjectSpace.fileContent(project.id, 'analysis/plan.json');

    assert.equal(first.artifactId, `${project.id}:analysis/plan.json`);
    assert.deepEqual(replay, first);
    assert.equal(ProjectSpace.artifactHistory(project.id, first.artifactId).length, 1);
    assert.equal(ProjectSpace.readArtifact(project.id, first), canonicalBytes);
    assert.deepEqual(
      ProjectSpace.artifactLineage(project.id, 'artifact-run-1').map((entry) => entry.ref),
      [first],
    );

    ProjectSpace.setAnalysisFile(project.id, 'plan.json', { candidates: [{ ticker: 'MSFT' }] });
    const second = ProjectSpace.commitArtifactFile(project.id, 'analysis/plan.json', commitMeta({
      runId: 'artifact-run-2',
      idempotencyKey: 'artifact-run-2:plan-research:analysis/plan.json',
      inputDigest: canonicalSha256({ nodeId: 'plan-research', seed: 'MSFT' }),
    }));

    assert.equal(second.artifactId, first.artifactId);
    assert.equal(second.version, 2);
    assert.notEqual(second.contentDigest, first.contentDigest);
    assert.equal(ProjectSpace.artifactHistory(project.id, first.artifactId).length, 2);
    assert.deepEqual(ProjectSpace.artifactManifest(project.id).versions.map((entry) => entry.ref.version), [1, 2]);

    const visibleNames = ProjectSpace.files(project.id).map((file) => file.name);
    assert.equal(visibleNames.some((name) => name === '.artifacts' || name.startsWith('.artifacts/')), false);
    assert.equal(ProjectSpace.fileContent(project.id, '.artifacts/manifest.json'), null);
    assert.equal(ProjectSpace.fileContent(project.id, '../meta.json'), null);
    assert.throws(
      () => ProjectSpace.commitArtifactFile(project.id, '../meta.json', commitMeta()),
      /unsafe artifact path/u,
    );
    assert.equal(ProjectSpace.reportVersions(project.id).some((report) => report.path.startsWith('.artifacts/')), false);
  } finally {
    ProjectSpace.delete(project.id);
  }
});
