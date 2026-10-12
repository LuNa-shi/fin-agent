import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'finagent-scorecards-'));
process.env.FIN_DATA_DIR = DATA_DIR;
process.env.DEMO_MODE = 'true';

const { ProjectSpace, verifiedRunAnalysisReportPackage } = await import('../src/project-space/index.js');
const { runAnalysisWorkflow } = await import('../src/workflows/run-analysis/runAnalysis.js');
const { RUN_ANALYSIS_WORKFLOW_SPEC } = await import('../src/workflows/run-analysis/workflowSpec.js');

function allRatings(scorecard) {
  return scorecard.units.flatMap((unit) => unit.rubricResults.map((rubric) => rubric.rating));
}

test('completed demo report commits three independent immutable scorecards bound to the exact reviewed draft', async () => {
  const project = ProjectSpace.create({
    title: 'Scorecard demo project',
    theme: 'software',
    industryTemplateName: '通用行业模板',
    rationale: 'Evaluate a deterministic report scorecard integration.',
    tickers: ['NVDA'],
    intensity: 'quick',
  });

  await runAnalysisWorkflow(project.id, { demo: true });

  const checkpoint = ProjectSpace.checkpoint(project.id);
  const reviewRound = checkpoint.reportReview.reviewRound;
  const reviewExecution = checkpoint.nodeExecutions['review-report'];
  const scorecardRefs = reviewExecution.artifactRefs.filter((ref) => ref.schemaVersion === 'scorecard-evaluation.v1');
  assert.deepEqual(scorecardRefs.map((ref) => ref.producer).sort(), [
    'company-scoreboard-evaluator',
    'data-scoreboard-evaluator',
    'industry-scoreboard-evaluator',
  ]);
  assert.deepEqual(scorecardRefs.map((ref) => ref.path).sort(), [
    `analysis/scorecards/company_r${reviewRound}.json`,
    `analysis/scorecards/data_r${reviewRound}.json`,
    `analysis/scorecards/industry_r${reviewRound}.json`,
  ]);

  const byLens = Object.fromEntries(scorecardRefs.map((ref) => {
    const scorecard = JSON.parse(ProjectSpace.readArtifact(project.id, ref));
    return [scorecard.lens, { ref, scorecard }];
  }));
  assert.deepEqual(Object.keys(byLens).sort(), ['company', 'data', 'industry']);

  for (const [lens, { ref, scorecard }] of Object.entries(byLens)) {
    assert.equal(scorecard.producer, `${lens}-scoreboard-evaluator`);
    assert.equal(scorecard.candidateIdentity.candidateDigest, scorecard.candidateIdentity.candidateRef.contentDigest);
    assert.equal(scorecard.candidateIdentity.candidateRef.path, 'report/report.md');
    assert.equal(scorecard.cycle, reviewRound - 1);
    assert.equal(scorecard.ref, undefined);
    assert.equal(ref.path, `analysis/scorecards/${lens}_r${reviewRound}.json`);
    assert.ok(allRatings(scorecard).every((rating) => rating === 4));
  }

  const dependencyDigests = new Set(Object.values(byLens).map(({ scorecard }) => scorecard.dependencyIdentity.dependencyDigest));
  assert.equal(dependencyDigests.size, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(byLens).map(([lens, { scorecard }]) => [lens, scorecard.dependencyIdentity.dependencyRefs])),
    { data: byLens.data.scorecard.dependencyIdentity.dependencyRefs, industry: byLens.data.scorecard.dependencyIdentity.dependencyRefs, company: byLens.data.scorecard.dependencyIdentity.dependencyRefs },
  );
  assert.equal(checkpoint.reportReview.decision.scorecards, undefined);
  assert.equal(checkpoint.conclusion.scorecards, undefined);
  assert.deepEqual(byLens.industry.scorecard.units.map((unit) => unit.unitId), ['software']);

  const run = ProjectSpace.runStore(project.id).load(checkpoint.artifactRunId);
  const reportPackage = verifiedRunAnalysisReportPackage(project.id, run, { projectSpace: ProjectSpace });
  assert.deepEqual(Object.keys(reportPackage.scorecards).sort(), ['company', 'data', 'industry']);
  assert.equal(reportPackage.scorecards.company.candidateIdentity.candidateDigest, byLens.company.scorecard.candidateIdentity.candidateDigest);
  assert.deepEqual(reportPackage.scorecards.industry.units.map((unit) => unit.unitId), ['software']);
  assert.equal(run.status, 'SUCCEEDED');
  const historyBefore = ProjectSpace.artifactHistory(project.id, scorecardRefs[0].artifactId).length;
  assert.equal(historyBefore, 1);
  assert.doesNotThrow(() => ProjectSpace.readArtifact(project.id, scorecardRefs[0]));
  assert.doesNotThrow(() => readFileSync(path.join(DATA_DIR, 'projects', project.id, scorecardRefs[0].path), 'utf8'));
});

test('workflow binds scorecard evaluators only to review-report and declares all three artifacts', () => {
  const review = RUN_ANALYSIS_WORKFLOW_SPEC.nodes.find((node) => node.id === 'review-report');
  assert.deepEqual(review.agentContractIds.slice(-3), [
    'data-scoreboard-evaluator',
    'industry-scoreboard-evaluator',
    'company-scoreboard-evaluator',
  ]);
  assert.deepEqual(review.artifacts.requiredArtifacts.slice(-3), [
    'analysis/scorecards/data_rN.json',
    'analysis/scorecards/industry_rN.json',
    'analysis/scorecards/company_rN.json',
  ]);
});
