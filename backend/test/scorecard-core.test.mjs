import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewDependencyDigest } from '../src/domains/research/contracts/reviewDependency.js';
import {
  SCORECARD_SPECS,
  createScorecardEvaluation,
  divideRoundHalfUp,
  getScorecardSpec,
  renormalizeApplicableScoreBps,
  scoreRubricBps,
} from '../src/domains/research/scorecards/index.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const AS_OF = '2026-08-06T00:00:00.000Z';

function artifactRef(path, { digest = DIGEST_A, producer = 'fixture-producer' } = {}) {
  return {
    contract: 'artifact-ref.v1',
    artifactId: path.replace(/[^a-z0-9]+/giu, '-'),
    version: 1,
    path,
    contentDigest: digest,
    schemaVersion: 'fixture.v1',
    producer,
    contractVersion: '1.0.0',
    inputDigest: DIGEST_A,
    createdAt: AS_OF,
    asOf: AS_OF,
  };
}

function rubricResults(lens, overrides = {}) {
  return getScorecardSpec(lens).rubrics.map((rubric) => ({
    rubricId: rubric.id,
    weight: rubric.weight,
    status: 'scored',
    rating: 4,
    decisiveEvidence: [`analysis/${lens}.json#${rubric.id}`],
    whyNotHigher: 'No higher rating exists on the fixed scale.',
    errorTags: [],
    confidence: 'high',
    ...overrides[rubric.id],
  }));
}

function issue(sourceCheckId, entity, overrides = {}) {
  return {
    sourceCheckId,
    description: `Concrete defect for ${sourceCheckId}`,
    severity: 'major',
    materiality: 'high',
    owner: 'data',
    area: 'data',
    affectedArtifact: 'report/report.md',
    entity,
    claim: `${sourceCheckId}-claim`,
    location: `report/report.md#${sourceCheckId}`,
    evidenceRefs: [`evidence:${sourceCheckId}`],
    remediationInstructions: `Repair ${sourceCheckId} using the cited source and update the affected artifact.`,
    acceptanceCriteria: [`An independent reread confirms ${sourceCheckId} is repaired.`],
    ...overrides,
  };
}

function evaluationInput(lens, units, newIssueCandidates = []) {
  const candidateRef = artifactRef('report/report.md', {
    digest: DIGEST_B,
    producer: 'report-composer',
  });
  const dependencyRefs = {
    data: [artifactRef('data/data_report.md')],
    industry: [artifactRef('analysis/industry.json', { producer: 'industry-analyst' })],
    company: [artifactRef('analysis/company.json', { producer: 'company-analyst' })],
  };
  return {
    asOf: AS_OF,
    producer: `${lens}-scoreboard-evaluator`,
    contractVersion: '1.0.0',
    inputDigest: DIGEST_A,
    createdAt: AS_OF,
    evidenceRefs: ['evidence:index'],
    lens,
    candidateIdentity: { candidateRef, candidateDigest: DIGEST_B },
    dependencyIdentity: {
      dependencyRefs,
      dependencyDigest: reviewDependencyDigest(dependencyRefs),
    },
    cycle: 0,
    artifactsScored: ['report/report.md'],
    rawSourceChecks: [],
    units,
    priorIssueChecks: [],
    newIssueCandidates,
  };
}

test('Scorecard v3.1 inventories are fixed at 24 Data, 24 Industry, and 28 Company items', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SCORECARD_SPECS).map(([lens, spec]) => [lens, spec.rubrics.length])),
    { data: 24, industry: 24, company: 28 },
  );
  for (const spec of Object.values(SCORECARD_SPECS)) {
    assert.equal(spec.rubrics.reduce((sum, rubric) => sum + rubric.weight, 0), 100);
    assert.equal(new Set(spec.rubrics.map((rubric) => rubric.id)).size, spec.rubrics.length);
  }
});

test('basis-point helpers use integer round-half-up arithmetic', () => {
  assert.equal(scoreRubricBps(5, 3), 375);
  assert.equal(divideRoundHalfUp(1, 2), 1);
  assert.equal(divideRoundHalfUp(4, 3), 1);
  assert.equal(divideRoundHalfUp(5, 3), 2);
  assert.equal(renormalizeApplicableScoreBps(9475, 96), 9870);
  assert.throws(() => divideRoundHalfUp(Number.MAX_SAFE_INTEGER + 1, 2), /safe integer/u);
});

test('Data permits objective N/A and renormalizes only the applicable denominator', () => {
  const results = rubricResults('data', {
    'D-COV-01': {
      status: 'not-applicable',
      rating: undefined,
      notApplicableReason: 'No offering or listing event exists for this private project.',
    },
    'D-COV-02': { rating: 3 },
  });
  const output = createScorecardEvaluation(
    evaluationInput('data', [{
      unitId: 'project-1',
      unitClass: 'project',
      materialityWeightBps: 10000,
      rubricResults: results,
      capTriggers: [],
    }], [issue('D-COV-02', 'project-1', { severity: 'minor' })]),
    { projectId: 'project-1' },
  );

  assert.equal(output.units[0].applicableWeightPoints, 96);
  assert.equal(output.units[0].notApplicableWeightPoints, 4);
  assert.equal(output.units[0].rawScoreBps, 9870);
  assert.equal(output.units[0].finalScoreBps, 9870);
  assert.equal(output.units[0].qualityBand, 'A');
});

test('Industry synthesizes missing authoritative units at zero and applies materiality caps', () => {
  const output = createScorecardEvaluation(
    evaluationInput('industry', [{
      unitId: 'software',
      unitClass: 'material',
      materialityWeightBps: 7500,
      rubricResults: rubricResults('industry'),
      capTriggers: [],
    }], [issue('I-PROJECT-CAP-MISSING-GTE-25', 'industry-project', {
      owner: 'industry', area: 'industry',
    })]),
    {
      materialIndustries: [
        { industryId: 'software', classification: 'material', materialityWeightBps: 7500 },
        { industryId: 'services', classification: 'emerging_material', materialityWeightBps: 2500 },
      ],
      weightsAuditable: true,
    },
  );

  assert.deepEqual(output.units.map((unit) => [unit.unitId, unit.unitStatus, unit.finalScoreBps]), [
    ['services', 'missing', 0],
    ['software', 'scored', 10000],
  ]);
  assert.equal(output.aggregation.rawScoreBps, 7500);
  assert.equal(output.aggregation.missingMaterialityWeightBps, 2500);
  assert.equal(output.aggregation.appliedCaps[0].capId, 'I-PROJECT-CAP-MISSING-GTE-25');
  assert.equal(output.aggregation.finalScoreBps, 5900);
});

test('Company requires every authoritative ticker and never creates project aggregation', () => {
  const units = ['AAA', 'BBB'].map((ticker) => ({
    unitId: ticker,
    unitClass: 'ticker',
    materialityWeightBps: 10000,
    rubricResults: rubricResults('company'),
    capTriggers: [],
  }));
  const output = createScorecardEvaluation(
    evaluationInput('company', units),
    { authoritativeTickers: ['BBB', 'AAA'] },
  );
  assert.deepEqual(output.units.map((unit) => unit.unitId), ['AAA', 'BBB']);
  assert.equal(output.aggregation, null);

  assert.throws(
    () => createScorecardEvaluation(evaluationInput('company', units.slice(0, 1)), {
      authoritativeTickers: ['AAA', 'BBB'],
    }),
    /missing authoritative tickers: BBB/u,
  );
});
