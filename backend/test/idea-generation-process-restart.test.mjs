import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workerFile = fileURLToPath(
  new URL('./support/ideaGenerationProcessWorker.mjs', import.meta.url),
);
const nodeIds = [
  'collect-market-context',
  'build-diversification-constraints',
  'generate-candidates',
  'verify-candidates',
  'review-quality',
  'persist-ideas',
];

async function runWorker(dataDir, args) {
  const { stdout } = await execFileAsync(process.execPath, [
    workerFile,
    ...args,
  ], {
    env: {
      ...process.env,
      FIN_DATA_DIR: dataDir,
      DEMO_MODE: 'true',
      AUTO_RESUME: 'false',
    },
  });
  return JSON.parse(stdout.trim());
}

test('each durable node boundary resumes in a fresh process without repeating its prefix', async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), 'finagent-idea-process-restart-'),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  for (let index = 0; index < nodeIds.length; index += 1) {
    const stopAfterNodeId = nodeIds[index];
    const runId = `idea_run_process_restart_${index + 1}`;
    const asOf = `2026-07-23T16:${String(index).padStart(2, '0')}:00.000Z`;
    const stopped = await runWorker(dataDir, [
      'start',
      runId,
      asOf,
      stopAfterNodeId,
    ]);
    assert.equal(stopped.status, 'RUNNING');
    assert.deepEqual(stopped.executedNodeIds, nodeIds.slice(0, index + 1));
    assert.deepEqual(stopped.hydratedNodeIds, []);

    const resumed = await runWorker(dataDir, ['resume', runId, asOf]);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal(resumed.runId, runId);
    assert.equal(resumed.snapshotId, stopped.snapshotId);
    assert.equal(resumed.asOf, asOf);
    assert.deepEqual(resumed.hydratedNodeIds, nodeIds.slice(0, index + 1));
    assert.deepEqual(resumed.executedNodeIds, nodeIds.slice(index + 1));
    assert.equal(resumed.generatedIdeaIds.length, 1);
  }
});
