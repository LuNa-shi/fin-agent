import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  validateArtifactRef,
} from '../../core/contracts/ArtifactRef.js';

export const SCORECARD_LENSES = Object.freeze(['data', 'industry', 'company']);
export const SCORECARD_RUBRIC_VERSION = 'v3.1-en';
export const SCORECARD_SCHEMA_VERSION = 'scorecard-evaluation.v1';
export const SCORECARD_STATUS = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
});

const SCORECARD_PRODUCERS = Object.freeze({
  data: 'data-scoreboard-evaluator',
  industry: 'industry-scoreboard-evaluator',
  company: 'company-scoreboard-evaluator',
});
const SCORECARD_PATH_RE = /^analysis\/scorecards\/(data|industry|company)_r([1-9]\d*)\.json$/u;
const SCORECARD_BANDS = Object.freeze([
  ['A', 9000],
  ['B', 8000],
  ['C', 7000],
  ['D', 6000],
  ['F', 0],
]);
const SAFE_UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,180}$/u;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REF_FIELDS = new Set([...ARTIFACT_REF_REQUIRED_FIELDS, ...ARTIFACT_REF_LOCATION_FIELDS]);
const UNIT_STATUSES = new Set(['scored', 'missing']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validScore(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10000;
}

function expectedBand(scoreBps) {
  return SCORECARD_BANDS.find(([, minimum]) => scoreBps >= minimum)[0];
}

function safeRef(value, lens, cycle) {
  const ref = object(value);
  if (!ref || Object.keys(ref).some((key) => !REF_FIELDS.has(key))) return null;
  const validation = validateArtifactRef(ref);
  if (!validation.valid || ref.uri !== undefined) return null;
  const pathMatch = SCORECARD_PATH_RE.exec(ref.path || '');
  if (!pathMatch || pathMatch[1] !== lens || Number(pathMatch[2]) !== cycle + 1) return null;
  if (ref.producer !== SCORECARD_PRODUCERS[lens] || ref.schemaVersion !== SCORECARD_SCHEMA_VERSION) return null;
  return structuredClone(ref);
}

function safeUnits(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const units = [];
  for (const raw of value) {
    const unit = object(raw);
    const unitId = text(unit?.unitId);
    if (!unit || !SAFE_UNIT_ID_RE.test(unitId) || seen.has(unitId)) return null;
    if (!UNIT_STATUSES.has(unit.unitStatus) || !validScore(unit.finalScoreBps)) return null;
    if (!['A', 'B', 'C', 'D', 'F'].includes(unit.qualityBand)
      || unit.qualityBand !== expectedBand(unit.finalScoreBps)) return null;
    if (!['pass', 'fail'].includes(unit.displayResult)) return null;
    seen.add(unitId);
    units.push({
      unitId,
      unitKind: text(unit.unitKind) || null,
      unitStatus: unit.unitStatus,
      finalScoreBps: unit.finalScoreBps,
      qualityBand: unit.qualityBand,
      displayResult: unit.displayResult,
    });
  }
  return units.sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function projectLens(lens, raw, reportDigest) {
  const scorecard = object(raw);
  if (!scorecard || scorecard.lens !== lens) return null;
  if (scorecard.rubricVersion !== undefined && scorecard.rubricVersion !== SCORECARD_RUBRIC_VERSION) return null;
  if (!validScore(scorecard.finalScoreBps)
    || scorecard.qualityBand !== expectedBand(scorecard.finalScoreBps)
    || !['pass', 'fail'].includes(scorecard.displayResult)) return null;
  const cycle = scorecard.sourceCycle ?? scorecard.cycle;
  if (!Number.isSafeInteger(cycle) || cycle < 0 || cycle > 2) return null;
  const asOf = text(scorecard.asOf);
  if (asOf && (!ISO_TIMESTAMP_RE.test(asOf) || !Number.isFinite(Date.parse(asOf)))) return null;
  const sourceDigest = text(scorecard.sourceCandidateDigest || scorecard.sourceDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceDigest) || sourceDigest !== reportDigest) return null;
  const ref = safeRef(scorecard.ref || scorecard.sourceRef, lens, cycle);
  if (!ref || (asOf && ref.asOf !== asOf)) return null;
  const normalizedAsOf = asOf || ref.asOf;
  const units = safeUnits(scorecard.units);
  if (units === null || units.length === 0) return null;
  return {
    lens,
    finalScoreBps: scorecard.finalScoreBps,
    qualityBand: scorecard.qualityBand,
    displayResult: scorecard.displayResult,
    rubricVersion: SCORECARD_RUBRIC_VERSION,
    ref,
    sourceDigest,
    cycle,
    asOf: normalizedAsOf,
    units,
  };
}

/**
 * Project scorecard values already carried by a trusted Daily Report summary.
 * This helper never calculates a score and never reads a project file. Any
 * missing, stale, ambiguous, or malformed lens invalidates the complete bundle.
 */
export function projectDailyReportScorecards({ scorecards, reportDigest } = {}) {
  const unavailable = Object.freeze({
    scorecardStatus: SCORECARD_STATUS.UNAVAILABLE,
    scorecards: null,
  });
  const digest = text(reportDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) return unavailable;
  const source = object(scorecards);
  if (!source || Object.keys(source).some((key) => !SCORECARD_LENSES.includes(key))) return unavailable;
  const projected = {};
  for (const lens of SCORECARD_LENSES) {
    const value = projectLens(lens, source[lens], digest);
    if (!value) return unavailable;
    projected[lens] = value;
  }
  return {
    scorecardStatus: SCORECARD_STATUS.AVAILABLE,
    scorecards: structuredClone(projected),
  };
}
