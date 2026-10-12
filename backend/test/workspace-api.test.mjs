import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-workspace-api-'));
process.env.FIN_DATA_DIR = dataDir;

const { ProjectSpace } = await import('../src/project-space/ProjectSpace.js');
const {
  listWorkspaceFiles,
  normalizeWorkspaceContentPath,
  readWorkspaceContentPaged,
} = await import('../src/project-space/workspaceApi.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('workspace API lists and pages only data, analysis, and report content', () => {
  const project = ProjectSpace.create({ title: 'Workspace API' });
  try {
    ProjectSpace.setDataText(project.id, 'notes.txt', 'abcdefghij');
    ProjectSpace.setAnalysisText(project.id, 'memo.md', '# Memo');
    ProjectSpace.setCheckpoint(project.id, { privateIssue: 'do not expose' });
    ProjectSpace.setAnalysisText(
      project.id,
      'human-reviews/task-1/decision.json',
      '{"globalComment":"do not expose"}',
    );
    ProjectSpace.setReport(project.id, '# Report');
    ProjectSpace.appendEvent(project.id, { type: 'tool.completed', text: 'private event text' });

    const tree = listWorkspaceFiles({ projectId: project.id });
    assert.equal(tree.schemaVersion, 'workspace-tree.v1');
    assert.ok(tree.files.some((entry) => entry.file === 'data/notes.txt' && entry.area === 'data'));
    assert.ok(tree.files.some((entry) => entry.file === 'analysis/memo.md' && entry.extension === 'md'));
    assert.equal(tree.files.some((entry) => entry.file === 'meta.json'), false);
    assert.equal(tree.files.some((entry) => entry.file === 'events.jsonl'), false);
    assert.equal(tree.files.some((entry) => entry.file === 'analysis/checkpoint.json'), false);
    assert.equal(
      tree.files.some((entry) => entry.file.startsWith('analysis/human-reviews/')),
      false,
    );

    const page = readWorkspaceContentPaged({ projectId: project.id, file: 'data/notes.txt', offset: 2, limit: 4 });
    assert.equal(page.schemaVersion, 'workspace-content.v1');
    assert.equal(page.content, 'cdef');
    assert.equal(page.nextOffset, 6);
    assert.equal(page.truncated, true);
  } finally {
    ProjectSpace.delete(project.id);
  }
});

test('workspace content path validation rejects root files, internal state, and traversal', () => {
  for (const file of [
    'meta.json',
    'events.jsonl',
    '.runs/run.json',
    '.events/outbox/000000000001.json',
    'analysis/checkpoint.json',
    'analysis/human-reviews/task-1/task.v1.json',
    'analysis/human-reviews',
    '../data/notes.txt',
    'data/../../meta.json',
    'report',
  ]) {
    assert.throws(
      () => normalizeWorkspaceContentPath(file),
      (error) => error.code === 'WORKSPACE_PATH_DENIED',
      file,
    );
  }
  assert.equal(normalizeWorkspaceContentPath('analysis/reviews/result.json'), 'analysis/reviews/result.json');
});
