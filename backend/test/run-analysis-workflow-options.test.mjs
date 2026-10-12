import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('canonical Run Analysis pins options.asOf and accepts a workflow-local Agent backend', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-run-analysis-options-'));
  process.env.FIN_DATA_DIR = dataDir;
  process.env.AUTO_RESUME = 'false';
  process.env.DEMO_MODE = 'false';
  const asOf = '2026-06-30T20:00:00.000Z';
  let projectId;
  try {
    const { ProjectSpace } = await import('../src/project-space/index.js');
    const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.workflow.js');
    const project = ProjectSpace.create({
      title: 'Pinned run',
      theme: 'Workflow option test',
      rationale: 'Stop after proving the workflow-local backend and fixed asOf reached the canonical executor.',
      tickers: ['ACME'],
      intensity: 'quick',
      createdAt: Date.parse(asOf),
    });
    projectId = project.id;
    const requests = [];
    const runtimes = [];
    const signal = new AbortController().signal;
    const agentBackend = {
      async run(request, runtime) {
        requests.push(request);
        runtimes.push(runtime);
        return {
          status: 'failed',
          output: null,
          artifacts: [],
          evidenceRefs: [],
          openQuestions: [],
          dataRequests: [],
          metrics: { turns: 1, toolCalls: 0 },
          stopReason: 'test-stop',
          traceRef: request.runId,
        };
      },
    };

    await assert.rejects(
      runAnalysisWorkflow(project.id, { agentBackend: undefined }),
      /agent backend must implement run/u,
    );
    assert.equal(ProjectSpace.runStore(project.id).list().length, 0);

    await assert.rejects(runAnalysisWorkflow(project.id, {
      intensity: 'quick',
      resume: false,
      asOf,
      agentBackend,
      signal,
      frozenDataByRound: {
        1: {
          quotes: [], fundamentals: {}, transcripts: [], research: {},
          industry: { sectors: [], peers: [], comps: [] }, detail: {}, highFreq: [],
        },
      },
    }), /analysis-plan failed: test-stop/u);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].agentContractId, 'analysis-plan');
    assert.equal(requests[0].asOf, asOf);
    assert.equal(runtimes[0].signal, signal);
    assert.equal(runtimes[0].artifactCommitOwner, 'workflow');
    const runs = ProjectSpace.runStore(project.id).list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].asOf, asOf);
    assert.equal(ProjectSpace.checkpoint(project.id).artifactAsOf, asOf);
    await assert.rejects(runAnalysisWorkflow(project.id, { asOf: 'not-a-date' }), /asOf must be an ISO timestamp/u);
    assert.equal(ProjectSpace.runStore(project.id).list().length, 1);
  } finally {
    if (projectId) {
      const { ProjectSpace } = await import('../src/project-space/index.js');
      ProjectSpace.delete(projectId);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
