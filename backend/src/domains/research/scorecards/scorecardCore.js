import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
  validateArtifactRef,
} from '../../../core/contracts/ArtifactRef.js';
import { reviewDependencyDigest } from '../contracts/reviewDependency.js';
import {
  SCORECARD_EVALUATION_CONTRACT_VERSION,
  validateScorecardEvaluationSchema,
} from '../contracts/scorecardEvaluation.js';
import {
  SCORE_BPS_MAX,
  SCORE_POINT_BPS,
  SCORECARD_LENSES,
  SCORECARD_RUBRIC_VERSION,
  getScorecardSpec,
  capEvidenceRuleFor,
} from './scorecardCatalog.js';

const CONFIDENCE = new Set(['high', 'medium', 'low']);
const RAW_CHECK_STATUS = new Set(['supported', 'contradicted', 'inconclusive', 'not-checked']);
const INDUSTRY_CLASSES = new Set(['material', 'emerging_material']);
const DEPENDENCY_GROUPS = Object.freeze(['data', 'industry', 'company']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item))
    .filter(Boolean))].sort();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compareArtifactRefs(left, right) {
  return text(left?.path).localeCompare(text(right?.path))
    || text(left?.artifactId).localeCompare(text(right?.artifactId))
    || Number(left?.version || 0) - Number(right?.version || 0)
    || text(left?.contentDigest).localeCompare(text(right?.contentDigest));
}


function dependencyPathMatchesGroup(path, group) {
  if (group === 'data') return text(path).startsWith('data/');
  if (group === 'industry') return text(path).startsWith('analysis/industry');
  return text(path).startsWith('analysis/company');
}

function normalizeEvaluationIdentity(input, errors) {
  const candidateSource = object(input.candidateIdentity);
  const candidateRef = structuredClone(object(candidateSource.candidateRef || input.candidateRef));
  const candidateDigest = text(candidateSource.candidateDigest || input.candidateDigest);
  const candidateValidation = validateArtifactRef(candidateRef);
  if (!candidateValidation.valid) errors.push(`candidateRef is invalid: ${candidateValidation.errors.join('; ')}`);
  const refFields = new Set([...ARTIFACT_REF_REQUIRED_FIELDS, ...ARTIFACT_REF_LOCATION_FIELDS]);
  for (const key of Object.keys(candidateRef)) if (!refFields.has(key)) errors.push(`candidateRef.${key} is not allowed`);
  if (candidateRef.path !== 'report/report.md') errors.push('candidateRef must identify report/report.md');
  if (candidateDigest !== candidateRef.contentDigest) errors.push('candidateDigest must match candidateRef.contentDigest');

  const dependencySource = object(input.dependencyIdentity);
  const rawDependencyRefs = object(dependencySource.dependencyRefs || input.dependencyRefs);
  const dependencyRefs = {};
  for (const group of DEPENDENCY_GROUPS) {
    const refs = Array.isArray(rawDependencyRefs[group]) ? rawDependencyRefs[group] : [];
    if (!refs.length) errors.push(`dependencyRefs.${group} must be a non-empty array`);
    dependencyRefs[group] = refs.map((ref, index) => {
      const copy = structuredClone(ref);
      const validation = validateArtifactRef(copy);
      if (!validation.valid) errors.push(`dependencyRefs.${group}[${index}] is invalid: ${validation.errors.join('; ')}`);
      for (const key of Object.keys(copy)) if (!refFields.has(key)) errors.push(`dependencyRefs.${group}[${index}].${key} is not allowed`);
      if (!dependencyPathMatchesGroup(copy.path, group)) {
        errors.push(`dependencyRefs.${group}[${index}] is assigned to the wrong dependency group`);
      }
      return copy;
    }).sort(compareArtifactRefs);
  }
  const unexpectedGroups = Object.keys(rawDependencyRefs).filter((group) => !DEPENDENCY_GROUPS.includes(group));
  if (unexpectedGroups.length) errors.push(`dependencyRefs contains unsupported groups: ${unexpectedGroups.sort().join(', ')}`);
  const dependencyDigest = text(dependencySource.dependencyDigest || input.dependencyDigest);
  const expectedDependencyDigest = reviewDependencyDigest(dependencyRefs);
  if (dependencyDigest !== expectedDependencyDigest) {
    errors.push('dependencyDigest does not match the exact Data/Industry/Company dependency closure');
  }
  const cycle = input.cycle ?? 0;
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > 2) errors.push('cycle must be an integer from 0 to 2');
  return {
    candidateIdentity: { candidateRef, candidateDigest },
    dependencyIdentity: { dependencyRefs, dependencyDigest },
    cycle: Number.isInteger(cycle) ? cycle : 0,
  };
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

export function divideRoundHalfUp(numerator, denominator) {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator', 1);
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  return quotient + (remainder * 2 >= denominator ? 1 : 0);
}

export function scoreRubricBps(weightPoints, rating) {
  assertSafeInteger(weightPoints, 'weightPoints', 1);
  assertSafeInteger(rating, 'rating');
  if (rating > 4) throw new TypeError('rating must be <= 4');
  const score = weightPoints * rating * 25;
  assertSafeInteger(score, 'weightedScoreBps');
  return score;
}

export function renormalizeApplicableScoreBps(rawApplicableScoreBps, applicableWeightPoints) {
  assertSafeInteger(rawApplicableScoreBps, 'rawApplicableScoreBps');
  assertSafeInteger(applicableWeightPoints, 'applicableWeightPoints', 1);
  const numerator = rawApplicableScoreBps * SCORE_POINT_BPS;
  assertSafeInteger(numerator, 'renormalized score numerator');
  return Math.min(SCORE_BPS_MAX, divideRoundHalfUp(numerator, applicableWeightPoints));
}

export function qualityBandForScoreBps(scoreBps) {
  assertSafeInteger(scoreBps, 'scoreBps');
  if (scoreBps > SCORE_BPS_MAX) throw new TypeError('scoreBps must be <= 10000');
  if (scoreBps >= 9000) return 'A';
  if (scoreBps >= 8000) return 'B';
  if (scoreBps >= 7000) return 'C';
  if (scoreBps >= 6000) return 'D';
  return 'F';
}

export function displayScoreFromBps(scoreBps) {
  assertSafeInteger(scoreBps, 'scoreBps');
  return (scoreBps / SCORE_POINT_BPS).toFixed(2);
}

function invalid(errors) {
  const list = [...new Set(errors)].sort();
  const error = new TypeError(`scorecard-evaluation.v1 validation failed: ${list.join('; ')}`);
  error.code = 'SCORECARD_EVALUATION_INVALID';
  error.errors = list;
  return error;
}

function normalizeCapTriggers(value, caps, path, errors, { lens = null, rubricResults = [], requireEvidence = false } = {}) {
  const catalog = new Map(caps.map((cap) => [cap.id, cap]));
  const ids = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const capId = text(typeof entry === 'string' ? entry : entry?.capId || entry?.id);
    if (!capId || !catalog.has(capId)) errors.push(`${path} contains unknown cap ${capId || '(missing)'}`);
    else {
      const rule = lens ? capEvidenceRuleFor(lens, capId) : null;
      if (lens && !rule) errors.push(`${path} contains a cap with no known rubric relationship: ${capId}`);
      if (rule && !rubricResults.some((result) => rule.rubricIds.includes(result.rubricId)
        && (!requireEvidence || rule.tags.some((tag) => result.errorTags.includes(tag)) || result.rating <= 1))) {
        errors.push(`${path} ${capId} has no applicable evidence or known rubric relationship`);
      }
      ids.push(capId);
    }
  }
  if (new Set(ids).size !== ids.length) errors.push(`${path} contains duplicate cap IDs`);
  return caps.filter((cap) => ids.includes(cap.id)).map((cap) => ({
    capId: cap.id,
    maximumScoreBps: cap.maximumScoreBps,
    condition: cap.condition,
  }));
}

function normalizeRubricResults(value, spec, unitId, errors) {
  const raw = Array.isArray(value) ? value : [];
  const byId = new Map();
  for (const entry of raw) {
    const result = object(entry);
    const rubricId = text(result.rubricId);
    if (!rubricId) {
      errors.push(`${unitId}.rubricResults contains a missing rubricId`);
      continue;
    }
    if (byId.has(rubricId)) errors.push(`${unitId}.rubricResults contains duplicate ${rubricId}`);
    byId.set(rubricId, result);
  }
  const known = new Set(spec.rubrics.map((rubric) => rubric.id));
  for (const rubricId of byId.keys()) {
    if (!known.has(rubricId)) errors.push(`${unitId}.rubricResults contains unknown ${rubricId}`);
  }

  const normalized = [];
  for (const rubric of spec.rubrics) {
    const result = byId.get(rubric.id);
    if (!result) {
      errors.push(`${unitId}.${rubric.id} is required`);
      continue;
    }
    if (result.weight !== rubric.weight) errors.push(`${unitId}.${rubric.id}.weight must equal ${rubric.weight}`);
    const status = result.status;
    if (status !== 'scored' && status !== 'not-applicable') errors.push(`${unitId}.${rubric.id}.status is invalid`);
    const decisiveEvidence = strings(result.decisiveEvidence);
    const whyNotHigher = text(result.whyNotHigher);
    const confidence = text(result.confidence).toLowerCase();
    const errorTags = strings(result.errorTags);
    if (!decisiveEvidence.length) errors.push(`${unitId}.${rubric.id}.decisiveEvidence is required`);
    if (!whyNotHigher) errors.push(`${unitId}.${rubric.id}.whyNotHigher is required`);
    if (!CONFIDENCE.has(confidence)) errors.push(`${unitId}.${rubric.id}.confidence is invalid`);
    for (const tag of errorTags) {
      if (!spec.errorTags.includes(tag)) errors.push(`${unitId}.${rubric.id}.errorTags contains unknown ${tag}`);
    }

    if (status === 'not-applicable') {
      const reason = text(result.notApplicableReason);
      if (!spec.allowNotApplicable) errors.push(`${unitId}.${rubric.id} cannot be not-applicable for ${spec.lens}`);
      if (!reason) errors.push(`${unitId}.${rubric.id}.notApplicableReason is required`);
      if (result.rating !== undefined && result.rating !== null) errors.push(`${unitId}.${rubric.id}.rating must be omitted when N/A`);
      normalized.push({
        rubricId: rubric.id,
        weight: rubric.weight,
        status,
        notApplicableReason: reason,
        weightedScoreBps: 0,
        decisiveEvidence,
        whyNotHigher,
        errorTags,
        confidence,
      });
      continue;
    }

    if (!Number.isInteger(result.rating) || result.rating < 0 || result.rating > 4) {
      errors.push(`${unitId}.${rubric.id}.rating must be an integer from 0 to 4`);
    }
    const rating = Number.isInteger(result.rating) && result.rating >= 0 && result.rating <= 4
      ? result.rating
      : 0;
    normalized.push({
      rubricId: rubric.id,
      weight: rubric.weight,
      status,
      rating,
      weightedScoreBps: scoreRubricBps(rubric.weight, rating),
      decisiveEvidence,
      whyNotHigher,
      errorTags,
      confidence,
    });
  }
  return normalized;
}

function displayResultForUnit(spec, unitStatus, rubricResults, finalScoreBps) {
  if (unitStatus !== 'scored' || finalScoreBps < 8000) return 'fail';
  const ratings = new Map(rubricResults
    .filter((result) => result.status === 'scored')
    .map((result) => [result.rubricId, result.rating]));
  if (spec.requiredPassRubricIds.some((id) => (ratings.get(id) ?? -1) < 3)) return 'fail';
  if (spec.nonZeroPassRubricIds.some((id) => (ratings.get(id) ?? 0) === 0)) return 'fail';
  return 'pass';
}

export function computeScorecardUnit(input = {}) {
  const errors = [];
  const spec = getScorecardSpec(input.lens);
  const unitId = text(input.unitId);
  if (!unitId) errors.push('unitId is required');
  const unitStatus = input.unitStatus === 'missing' || input.missing === true ? 'missing' : 'scored';
  const materialityWeightBps = input.materialityWeightBps ?? SCORE_BPS_MAX;
  if (!Number.isSafeInteger(materialityWeightBps) || materialityWeightBps < 0 || materialityWeightBps > SCORE_BPS_MAX) {
    errors.push(`${unitId || 'unit'}.materialityWeightBps must be an integer from 0 to 10000`);
  }
  const unitClass = text(input.unitClass || input.classification || (
    spec.lens === 'data' ? 'project' : (spec.lens === 'company' ? 'ticker' : 'material')
  ));
  if (spec.lens === 'industry' && !INDUSTRY_CLASSES.has(unitClass)) errors.push(`${unitId}.unitClass is invalid`);
  if (spec.lens === 'data' && unitClass !== 'project') errors.push(`${unitId}.unitClass must be project`);
  if (spec.lens === 'company' && unitClass !== 'ticker') errors.push(`${unitId}.unitClass must be ticker`);
  if (spec.lens !== 'industry' && materialityWeightBps !== SCORE_BPS_MAX) {
    errors.push(`${unitId}.materialityWeightBps must equal 10000 for ${spec.lens}`);
  }

  let rubricResults = [];
  let applicableWeightPoints = 0;
  let notApplicableWeightPoints = 0;
  let rawScoreBps = 0;
  let appliedCaps = [];
  if (unitStatus === 'missing') {
    if (spec.lens !== 'industry') errors.push(`${unitId}.unitStatus missing is only valid for industry`);
    if (Array.isArray(input.rubricResults) && input.rubricResults.length) errors.push(`${unitId}.missing unit must not contain rubricResults`);
  } else {
    rubricResults = normalizeRubricResults(input.rubricResults, spec, unitId, errors);
    applicableWeightPoints = rubricResults
      .filter((result) => result.status === 'scored')
      .reduce((sum, result) => sum + result.weight, 0);
    notApplicableWeightPoints = 100 - applicableWeightPoints;
    const rawApplicableScoreBps = rubricResults.reduce((sum, result) => sum + result.weightedScoreBps, 0);
    if (applicableWeightPoints === 0) errors.push(`${unitId} cannot mark every rubric not-applicable`);
    else rawScoreBps = spec.allowNotApplicable && notApplicableWeightPoints > 0
      ? renormalizeApplicableScoreBps(rawApplicableScoreBps, applicableWeightPoints)
      : rawApplicableScoreBps;
    appliedCaps = normalizeCapTriggers(input.capTriggers, spec.caps, `${unitId}.capTriggers`, errors, {
      lens: spec.lens,
      rubricResults,
      requireEvidence: true,
    });
  }

  const finalScoreBps = appliedCaps.reduce(
    (score, cap) => Math.min(score, cap.maximumScoreBps),
    rawScoreBps,
  );
  const output = {
    unitId,
    unitKind: spec.unitKind,
    unitStatus,
    unitClass,
    materialityWeightBps: Number.isSafeInteger(materialityWeightBps) ? materialityWeightBps : 0,
    rubricResults,
    applicableWeightPoints,
    notApplicableWeightPoints,
    rawScoreBps,
    appliedCaps,
    finalScoreBps,
    qualityBand: qualityBandForScoreBps(finalScoreBps),
    displayResult: displayResultForUnit(spec, unitStatus, rubricResults, finalScoreBps),
  };
  if (errors.length) throw invalid(errors);
  return deepFreeze(output);
}

function normalizeIndustryAuthorities(value, errors) {
  const authorities = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const item = object(entry);
    const unitId = text(item.unitId || item.industryId);
    const unitClass = text(item.unitClass || item.classification || 'material');
    const materialityWeightBps = item.materialityWeightBps ?? item.materialityBps;
    if (!unitId) errors.push('materialIndustries contains a missing industryId');
    else if (seen.has(unitId)) errors.push(`materialIndustries contains duplicate ${unitId}`);
    seen.add(unitId);
    if (!INDUSTRY_CLASSES.has(unitClass)) errors.push(`${unitId}.classification is invalid`);
    if (!Number.isSafeInteger(materialityWeightBps) || materialityWeightBps < 0 || materialityWeightBps > SCORE_BPS_MAX) {
      errors.push(`${unitId}.materialityWeightBps must be an integer from 0 to 10000`);
    }
    authorities.push({ unitId, unitClass, materialityWeightBps });
  }
  return authorities.sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function authoritativeUnitInputs(lens, rawUnits, context, errors) {
  const units = Array.isArray(rawUnits) ? rawUnits.map((entry) => object(entry)) : [];
  const byId = new Map();
  for (const unit of units) {
    const unitId = text(unit.unitId);
    if (!unitId) errors.push('units contains a missing unitId');
    else if (byId.has(unitId)) errors.push(`units contains duplicate ${unitId}`);
    byId.set(unitId, unit);
  }

  if (lens === 'data') {
    const expectedId = text(context.projectId);
    if (!expectedId) errors.push('Data Scorecard requires authoritative context.projectId');
    if (units.length !== 1) errors.push('Data Scorecard requires exactly one project unit');
    if (expectedId && units[0] && text(units[0].unitId) !== expectedId) errors.push(`Data unitId must equal ${expectedId}`);
    return units;
  }

  if (lens === 'company') {
    const tickers = strings(context.authoritativeTickers);
    if (!tickers.length) {
      errors.push('Company Scorecard requires authoritative context.authoritativeTickers');
      return units.sort((left, right) => text(left.unitId).localeCompare(text(right.unitId)));
    }
    const extras = [...byId.keys()].filter((unitId) => !tickers.includes(unitId));
    const missing = tickers.filter((ticker) => !byId.has(ticker));
    if (extras.length) errors.push(`Company units contain non-authoritative tickers: ${extras.sort().join(', ')}`);
    if (missing.length) errors.push(`Company units missing authoritative tickers: ${missing.join(', ')}`);
    return tickers.map((ticker) => byId.get(ticker)).filter(Boolean);
  }

  const authorities = normalizeIndustryAuthorities(context.materialIndustries, errors);
  if (!authorities.length) {
    errors.push('Industry Scorecard requires authoritative context.materialIndustries');
    return units.sort((left, right) => text(left.unitId).localeCompare(text(right.unitId)));
  }
  const authorityIds = authorities.map((entry) => entry.unitId);
  const extras = [...byId.keys()].filter((unitId) => !authorityIds.includes(unitId));
  if (extras.length) errors.push(`Industry units contain non-authoritative industries: ${extras.sort().join(', ')}`);
  return authorities.map((authority) => {
    const raw = byId.get(authority.unitId);
    if (!raw) {
      return {
        lens,
        ...authority,
        unitStatus: 'missing',
        rubricResults: [],
        capTriggers: [],
      };
    }
    if (raw.materialityWeightBps !== undefined && raw.materialityWeightBps !== authority.materialityWeightBps) {
      errors.push(`${authority.unitId}.materialityWeightBps conflicts with authoritative weight`);
    }
    return { ...raw, ...authority, lens };
  });
}

function aggregateIndustry(units, spec, { weightsAuditable = true, projectCapTriggers = [] } = {}, errors) {
  const weightTotal = units.reduce((sum, unit) => sum + unit.materialityWeightBps, 0);
  if (weightTotal !== SCORE_BPS_MAX) errors.push(`Industry materiality weights must total 10000, received ${weightTotal}`);
  let numerator = 0;
  for (const unit of units) {
    const product = unit.finalScoreBps * unit.materialityWeightBps;
    if (!Number.isSafeInteger(product)) errors.push(`${unit.unitId} materiality product exceeds safe integer range`);
    else numerator += product;
  }
  if (!Number.isSafeInteger(numerator)) errors.push('Industry aggregation exceeds safe integer range');
  const rawScoreBps = weightTotal === SCORE_BPS_MAX && Number.isSafeInteger(numerator)
    ? divideRoundHalfUp(numerator, SCORE_BPS_MAX)
    : 0;
  const missingMaterialityWeightBps = units
    .filter((unit) => unit.unitStatus === 'missing')
    .reduce((sum, unit) => sum + unit.materialityWeightBps, 0);
  const automaticCaps = [];
  if (missingMaterialityWeightBps >= 2500) automaticCaps.push('I-PROJECT-CAP-MISSING-GTE-25');
  else if (missingMaterialityWeightBps >= 1000) automaticCaps.push('I-PROJECT-CAP-MISSING-GTE-10');
  if (weightsAuditable !== true) automaticCaps.push('I-PROJECT-CAP-OPAQUE-WEIGHTS');
  const appliedCaps = normalizeCapTriggers(
    [...automaticCaps, ...(Array.isArray(projectCapTriggers) ? projectCapTriggers : [])],
    spec.projectCaps,
    'aggregation.projectCapTriggers',
    errors,
    { lens: spec.lens, rubricResults: units.flatMap((unit) => unit.rubricResults) },
  );
  const finalScoreBps = appliedCaps.reduce(
    (score, cap) => Math.min(score, cap.maximumScoreBps),
    rawScoreBps,
  );
  const materialUnitsPass = units
    .filter((unit) => unit.unitClass === 'material')
    .every((unit) => unit.displayResult === 'pass');
  return {
    method: 'materiality-weighted',
    weightsAuditable: weightsAuditable === true,
    missingMaterialityWeightBps,
    rawScoreBps,
    appliedCaps,
    finalScoreBps,
    qualityBand: qualityBandForScoreBps(finalScoreBps),
    displayResult: finalScoreBps >= 8000 && materialUnitsPass ? 'pass' : 'fail',
  };
}

function normalizeRawSourceChecks(value) {
  return (Array.isArray(value) ? value : []).map((entry, index) => {
    const item = object(entry);
    const status = text(item.status);
    return {
      checkId: text(item.checkId) || `raw-check-${index + 1}`,
      artifactRef: text(item.artifactRef),
      location: text(item.location),
      status: RAW_CHECK_STATUS.has(status) ? status : status,
      evidenceRefs: strings(item.evidenceRefs),
      notes: text(item.notes),
    };
  }).sort((left, right) => left.checkId.localeCompare(right.checkId));
}


export function validateScorecardEvaluation(value, context = {}) {
  try {
    const canonicalInput = {
      ...structuredClone(value),
      units: (Array.isArray(value?.units) ? value.units : []).map((unit) => ({
        ...structuredClone(unit),
        capTriggers: (Array.isArray(unit?.appliedCaps) ? unit.appliedCaps : [])
          .map((cap) => cap?.capId),
      })),
    };
    const normalized = createScorecardEvaluation(canonicalInput, {
      ...context,
      validateOnly: true,
    });
    return canonicalStringify(normalized) === canonicalStringify(value)
      ? []
      : ['committed Scorecard does not match deterministic rubric inventory, arithmetic, caps, bands, or Issue normalization'];
  } catch (error) {
    return Array.isArray(error?.errors) ? [...error.errors] : [String(error?.message || error)];
  }
}

export function createScorecardEvaluation(input = {}, context = {}) {
  const errors = [];
  const lens = text(input.lens);
  if (!SCORECARD_LENSES.includes(lens)) throw invalid([`lens must be one of ${SCORECARD_LENSES.join(', ')}`]);
  const spec = getScorecardSpec(lens);
  const evaluationIdentity = normalizeEvaluationIdentity(input, errors);
  const unitInputs = authoritativeUnitInputs(lens, input.units, context, errors);
  const units = [];
  for (const unitInput of unitInputs) {
    try {
      units.push(computeScorecardUnit({ ...unitInput, lens }));
    } catch (error) {
      errors.push(...(error.errors || [error.message]));
    }
  }
  units.sort((left, right) => left.unitId.localeCompare(right.unitId));
  let aggregation = null;
  if (lens === 'industry') {
    aggregation = aggregateIndustry(units, spec, context, errors);
  }
  if (lens === 'company' && aggregation !== null) errors.push('Company aggregation must be null');

  const output = {
    schemaVersion: SCORECARD_EVALUATION_CONTRACT_VERSION,
    asOf: text(input.asOf),
    producer: text(input.producer),
    contractVersion: text(input.contractVersion),
    inputDigest: text(input.inputDigest),
    createdAt: text(input.createdAt),
    evidenceRefs: strings(input.evidenceRefs),
    lens,
    rubricVersion: SCORECARD_RUBRIC_VERSION,
    candidateIdentity: evaluationIdentity.candidateIdentity,
    dependencyIdentity: evaluationIdentity.dependencyIdentity,
    cycle: evaluationIdentity.cycle,
    artifactsScored: strings(input.artifactsScored),
    rawSourceChecks: normalizeRawSourceChecks(input.rawSourceChecks),
    units,
    aggregation,
  };
  errors.push(...validateScorecardEvaluationSchema(output));
  if (errors.length) throw invalid(errors);
  return deepFreeze(output);
}

export function canonicalScorecardDigest(value) {
  return canonicalSha256(value);
}
