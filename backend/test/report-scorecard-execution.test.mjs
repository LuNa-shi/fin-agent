import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'finagent-scorecard-execution-'));
process.env.FIN_DATA_DIR = DATA_DIR;
process.env.DEMO_MODE = 'true';

const { ProjectSpace } = await import('../src/project-space/index.js');
const { runReportScorecards } = await import('../src/workflows/run-analysis/reviewers/reportScorecards.js');

function context() {
  const project = ProjectSpace.create({
    title: 'Scorecard evaluator execution test',
    theme: 'test-theme',
    rationale: 'Test stable scorecard evaluator execution.',
    tickers: ['AAA'],
  });
  const digest = 'sha256:' + 'a'.repeat(64);
  const ref = (file) => ({
    artifactId: `test:${file}`,
    version: 1,
    path: file,
    contentDigest: digest,
    schemaVersion: 'test.v1',
    producer: 'test',
    contractVersion: '1.0.0',
    inputDigest: digest,
    asOf: '2026-08-14T06:50:52.048Z',
  });
  return {
    id: project.id,
    meta: { tickers: ['AAA'], theme: 'test-theme' },
    theme: 'test-theme',
    tickers: ['AAA'],
    deepTickers: ['AAA'],
    cp: {
      artifactAsOf: '2026-08-14T06:50:52.048Z',
      nodeExecutions: {
        'compose-report': {
          artifactRefs: [ref('report/report.md')],
        },
        'run-research-rounds': {
          artifactRefs: [
            ref('data/data_report.md'),
            ref('analysis/industry.json'),
            ref('analysis/company.json'),
          ],
        },
      },
    },
  };
}

function evaluatorOutput(contractId) {
  return {
    status: 'succeeded',
    valid: true,
    output: { contractId },
  };
}

function lensOf(contractId) {
  return contractId.replace('-scoreboard-evaluator', '');
}

test('scorecard evaluators execute sequentially in stable data, industry, company order', async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const result = await runReportScorecards(context(), {
    reviewRound: 1,
    cycle: 0,
    draftReport: 'draft',
    researchBrief: {},
    evidenceBundle: {},
    runEvaluator: async (contractId) => {
      const lens = lensOf(contractId);
      events.push(`start:${lens}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      events.push(`end:${lens}`);
      active -= 1;
      return { status: 'failed', valid: false, stopReason: 'error' };
    },
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    'start:data', 'end:data',
    'start:industry', 'end:industry',
    'start:company', 'end:company',
  ]);
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.outputs, {});
});

test('evaluator material industry authority follows the API projection precedence', async () => {
  const contextValue = context();
  contextValue.meta = {
    ...contextValue.meta,
    theme: 'software',
    industryTemplateName: '通用行业模板',
  };
  contextValue.theme = 'fallback-theme';
  let industryInput;
  await runReportScorecards(contextValue, {
    reviewRound: 1,
    cycle: 0,
    draftReport: 'draft',
    researchBrief: {},
    evidenceBundle: {},
    runEvaluator: async (contractId, input) => {
      if (contractId === 'industry-scoreboard-evaluator') industryInput = input.materialIndustries;
      return evaluatorOutput(contractId);
    },
  });
  assert.deepEqual(industryInput, [{
    industryId: 'software',
    classification: 'material',
    materialityWeightBps: 10000,
  }]);
});

test('a failed scorecard remains fail-closed without preventing independent evaluators', async () => {
  const calls = [];
  const contextValue = context();
  const result = await runReportScorecards(contextValue, {
    reviewRound: 2,
    cycle: 1,
    draftReport: 'draft',
    researchBrief: {},
    evidenceBundle: {},
    runEvaluator: async (contractId) => {
      const lens = lensOf(contractId);
      calls.push(lens);
      if (lens === 'data') {
        const error = new Error('provider unavailable');
        error.code = 'PROVIDER_UNAVAILABLE';
        error.stopReason = 'error';
        throw error;
      }
      return evaluatorOutput(contractId);
    },
  });

  assert.deepEqual(calls, ['data', 'industry', 'company']);
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.outputs, {});
  assert.deepEqual(result.failures, [{ contractId: 'data-scoreboard-evaluator', status: 'failed', stopReason: 'error' }]);
  assert.equal(ProjectSpace.fileContent(contextValue.id, 'analysis/scorecards/data_r2.json'), null);
  assert.equal(ProjectSpace.fileContent(contextValue.id, 'analysis/scorecards/industry_r2.json'), null);
  assert.equal(ProjectSpace.fileContent(contextValue.id, 'analysis/scorecards/company_r2.json'), null);
  assert.equal(result.results.find((item) => item.contractId === 'industry-scoreboard-evaluator').valid, true);
  assert.equal(result.results.find((item) => item.contractId === 'company-scoreboard-evaluator').valid, true);
});
