import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { ProjectFS, ProjectSpace } from '../src/project-space/ProjectSpace.js';

test('Project Space owns the existing ProjectFS implementation behind one identity', () => {
  assert.equal(ProjectFS, ProjectSpace);
  for (const method of [
    'create', 'list', 'meta', 'updateMeta', 'checkpoint', 'setCheckpoint', 'runStore', 'workspace', 'activeRun',
    'setDataFile', 'setAnalysisFile', 'setTimestampedReport', 'appendEvent', 'files', 'fileContent',
  ]) assert.equal(typeof ProjectSpace[method], 'function', method);
});

test('global file state is separate and no longer owns project persistence', async () => {
  const [globalState, projectSpace] = await Promise.all([
    readFile(new URL('../src/core/persistence/globalState.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/project-space/ProjectSpace.js', import.meta.url), 'utf8'),
  ]);

  await assert.rejects(access(new URL('../src/store/store.js', import.meta.url)));
  assert.doesNotMatch(globalState, /ProjectFS|ProjectSpace|PROJECTS_DIR|setTimestampedReport\s*\(/u);
  assert.match(projectSpace, /export const ProjectSpace\s*=\s*\{/u);
  assert.match(projectSpace, /export const ProjectFS\s*=\s*ProjectSpace/u);
  assert.doesNotMatch(projectSpace, /\b(?:Store|Mandate|Contracts)\s*=/u);
});

test('ArtifactStore and executable RunStore remediation stay separate project-space services', async () => {
  const [projectSpace, artifactStore, runStore] = await Promise.all([
    readFile(new URL('../src/project-space/ProjectSpace.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/project-space/ArtifactStore.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/project-space/RunStore.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(projectSpace, /(?:class|const|let|var)\s+(?:WorkspaceService|ArtifactStore|RunStore)\b/u);
  assert.match(artifactStore, /export class FileArtifactStore\b/u);
  assert.match(runStore, /export class FileRunStore\b/u);
  assert.doesNotMatch(`${projectSpace}\n${artifactStore}\n${runStore}`, /(?:class|const|let|var)\s+WorkspaceService\b/u);
  assert.doesNotMatch(`${projectSpace}\n${artifactStore}`, /invalidateNodes\s*\(|blockRun\s*\(/u);
  assert.match(runStore, /invalidateNodes\s*\(/u);
  assert.match(runStore, /blockRun\s*\(/u);
});

test('production project consumers depend directly on Project Space', async () => {
  const consumers = [
    'src/server.js',
    'src/workflows/run-analysis/reportEditing.js',
    'src/workflows/run-analysis/research/dataAgent.js',
    'src/domains/decision/decisionSystem.js',
    'src/domains/decision/portfolioAgent.js',
    'src/domains/ideas/createProjectFromIdea.js',
    'src/workflows/run-analysis/RunAnalysisService.js',
    'src/workflows/run-analysis/runAnalysis.js',
  ];

  for (const filename of consumers) {
    const source = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import\s*\{[^}]*ProjectFS[^}]*\}\s*from\s*['"].*(?:store\/store|core\/persistence\/globalState)\.js['"]/u, filename);
    assert.match(source, /from\s*['"].*project-space\/(?:index|ProjectSpace)\.js['"]/u, filename);
  }
});
