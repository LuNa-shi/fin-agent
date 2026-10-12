import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDailyReportScorecards } from '../src/domains/reports/scorecardProjection.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const SCORECARD_DIGEST = 'sha256:' + 'c'.repeat(64);
const AS_OF = '2026-08-01T06:30:00.000Z';

function ref(lens) {
  return {
    contract: 'artifact-ref.v1',
    artifactId: `project:analysis/scorecards/${lens}_r1.json`,
    version: 1,
    path: `analysis/scorecards/${lens}_r1.json`,
    contentDigest: SCORECARD_DIGEST,
    schemaVersion: 'scorecard-evaluation.v1',
    producer: `${lens}-scoreboard-evaluator`,
    contractVersion: '2.3.0',
    inputDigest: DIGEST,
    createdAt: AS_OF,
    asOf: AS_OF,
  };
}

function lens(lensName, score = 8000) {
  return {
    lens: lensName,
    rubricVersion: 'v3.1-en',
    sourceCandidateDigest: DIGEST,
    sourceCycle: 0,
    asOf: AS_OF,
    ref: ref(lensName),
    finalScoreBps: score,
    qualityBand: score >= 9000 ? 'A' : score >= 8000 ? 'B' : score >= 7000 ? 'C' : score >= 6000 ? 'D' : 'F',
    displayResult: score >= 8000 ? 'pass' : 'fail',
    units: [{
      unitId: lensName === 'company' ? 'ALFA' : lensName,
      unitKind: 'project',
      unitStatus: 'scored',
      finalScoreBps: score,
      qualityBand: score >= 9000 ? 'A' : score >= 8000 ? 'B' : score >= 7000 ? 'C' : score >= 6000 ? 'D' : 'F',
      displayResult: score >= 8000 ? 'pass' : 'fail',
    }],
  };
}

function bundle() {
  return { data: lens('data'), industry: lens('industry', 7500), company: lens('company', 9200) };
}

test('projects a complete verified three-lens scorecard bundle without recalculating it', () => {
  const result = projectDailyReportScorecards({ scorecards: bundle(), reportDigest: DIGEST });
  assert.equal(result.scorecardStatus, 'available');
  assert.deepEqual(Object.keys(result.scorecards), ['data', 'industry', 'company']);
  assert.equal(result.scorecards.data.finalScoreBps, 8000);
  assert.equal(result.scorecards.industry.qualityBand, 'C');
  assert.equal(result.scorecards.company.units[0].unitId, 'ALFA');
  assert.equal(result.scorecards.data.rubricVersion, 'v3.1-en');
});

test('returns unavailable rather than exposing a partial or malformed scorecard bundle', () => {
  const source = bundle();
  delete source.company;
  const result = projectDailyReportScorecards({ scorecards: source, reportDigest: DIGEST });
  assert.deepEqual(result, { scorecardStatus: 'unavailable', scorecards: null });
});

test('fails closed for stale report identity, wrong producer, wrong cycle, and unsafe refs', () => {
  for (const mutate of [
    (source) => { source.data.sourceCandidateDigest = 'sha256:' + 'b'.repeat(64); },
    (source) => { source.industry.ref.producer = 'report-composer'; },
    (source) => { source.company.sourceCycle = 1; },
    (source) => { source.data.ref.path = '../../secret.json'; },
    (source) => { source.company.qualityBand = 'F'; },
  ]) {
    const source = bundle();
    mutate(source);
    assert.equal(
      projectDailyReportScorecards({ scorecards: source, reportDigest: DIGEST }).scorecardStatus,
      'unavailable',
    );
  }
});

test('strips evaluator evidence and arbitrary fields from the read-only DTO', () => {
  const source = bundle();
  source.data.rubricResults = [{ secret: 'do not expose' }];
  source.data.secret = 'do not expose';
  const result = projectDailyReportScorecards({ scorecards: source, reportDigest: DIGEST });
  assert.equal(result.scorecardStatus, 'available');
  assert.equal(Object.hasOwn(result.scorecards.data, 'secret'), false);
  assert.equal(Object.hasOwn(result.scorecards.data, 'rubricResults'), false);
  assert.deepEqual(Object.keys(result.scorecards.data.units[0]).sort(), [
    'displayResult', 'finalScoreBps', 'qualityBand', 'unitId', 'unitKind', 'unitStatus',
  ]);
});
