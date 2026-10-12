import {
  ARTIFACT_REF_LOCATION_FIELDS,
  ARTIFACT_REF_REQUIRED_FIELDS,
  canonicalSha256,
  validateArtifactRef,
} from '../../../core/contracts/ArtifactRef.js';
import { getScorecardSpec, capEvidenceRuleFor } from './scorecardCatalog.js';
import { createScorecardEvaluation, validateScorecardEvaluation } from './scorecardCore.js';

const CONTRACT_LENSES = Object.freeze({
  'data-scoreboard-evaluator': 'data',
  'industry-scoreboard-evaluator': 'industry',
  'company-scoreboard-evaluator': 'company',
});
const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
const RAW_CHECK_STATUSES = new Set(['supported', 'contradicted', 'inconclusive', 'not-checked']);
const PRIOR_CHECK_STATUSES = new Set(['open', 'resolved', 'not-found', 'not-checked']);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function exactObject(value, fields, label, errors) {
  const item = object(value);
  if (!item) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(item)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of fields) if (!Object.hasOwn(item, key) && !['rating', 'notApplicableReason'].includes(key)) {
    errors.push(`${label}.${key} is required`);
  }
  return item;
}

function invalid(errors) {
  const list = [...new Set(errors)].sort();
  const error = new TypeError(`scorecard-evaluation.v1 projection rejected: ${list.join('; ')}`);
  error.code = 'SCORECARD_EVALUATION_INVALID';
  error.errors = list;
  throw error;
}

function normalizeArtifactPath(value) {
  const raw = text(value);
  if (!raw || raw.includes('\\') || raw.startsWith('/') || raw.includes('..')) return '';
  return raw.split('#', 1)[0].split('?', 1)[0];
}

function evidencePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return normalizeArtifactPath(value);
}

function assertArtifactRef(value, label, errors, { pathPrefix = null } = {}) {
  const ref = object(value);
  if (!ref) {
    errors.push(`${label} is required`);
    return null;
  }
  const validation = validateArtifactRef(ref);
  if (!validation.valid) errors.push(`${label} is invalid: ${validation.errors.join('; ')}`);
  const allowed = new Set([...ARTIFACT_REF_REQUIRED_FIELDS, ...ARTIFACT_REF_LOCATION_FIELDS]);
  for (const key of Object.keys(ref)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  if (Object.hasOwn(ref, 'uri')) errors.push(`${label}.uri is not permitted for a project closure`);
  if (!text(ref.path)) errors.push(`${label}.path is required`);
  if (pathPrefix && !text(ref.path).startsWith(pathPrefix)) errors.push(`${label}.path is outside ${pathPrefix}`);
  return structuredClone(ref);
}

function identityFromInput(input, errors) {
  const source = object(input.candidateIdentity || input.reviewCandidate);
  if (!source) errors.push('candidateIdentity is required');
  const candidateRef = assertArtifactRef(source?.candidateRef, 'candidateIdentity.candidateRef', errors);
  const candidateDigest = text(source?.candidateDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(candidateDigest)) errors.push('candidateIdentity.candidateDigest is invalid');
  if (candidateRef && candidateDigest !== candidateRef.contentDigest) {
    errors.push('candidateIdentity.candidateDigest must match candidateRef.contentDigest');
  }
  if (candidateRef?.path !== 'report/report.md') errors.push('candidateIdentity.candidateRef must identify report/report.md');
  if (candidateRef && candidateRef.asOf !== input.asOf) errors.push('candidateIdentity.candidateRef.asOf must equal request asOf');

  const dependencySource = object(input.dependencyIdentity || input.reviewCandidate);
  if (!dependencySource) errors.push('dependencyIdentity is required');
  const dependencyRefs = {};
  for (const group of ['data', 'industry', 'company']) {
    const refs = dependencySource?.dependencyRefs?.[group];
    if (!Array.isArray(refs) || refs.length === 0) {
      errors.push(`dependencyIdentity.dependencyRefs.${group} must be a non-empty array`);
      dependencyRefs[group] = [];
      continue;
    }
    dependencyRefs[group] = refs.map((ref, index) => assertArtifactRef(
      ref,
      `dependencyIdentity.dependencyRefs.${group}[${index}]`,
      errors,
      { pathPrefix: group === 'data' ? 'data/' : `analysis/${group}` },
    )).filter(Boolean);
    for (const ref of dependencyRefs[group]) if (ref.asOf !== input.asOf) errors.push(`dependencyIdentity.dependencyRefs.${group} refs must match request asOf`);
  }
  const dependencyDigest = text(dependencySource?.dependencyDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(dependencyDigest)) errors.push('dependencyIdentity.dependencyDigest is invalid');
  return {
    candidateIdentity: { candidateRef, candidateDigest },
    dependencyIdentity: { dependencyRefs, dependencyDigest },
  };
}

function authoritativeTickers(input) {
  const scope = object(input.scope) || {};
  const direct = input.authoritativeTickers || input.tickers || scope.authoritativeTickers;
  return Array.isArray(direct) ? direct : [];
}

function materialIndustries(input) {
  const scope = object(input.scope) || {};
  const direct = input.materialIndustries || input.industryMateriality || scope.industries;
  return Array.isArray(direct) ? direct : [];
}

function authoritativeUnits(lens, input, projectId, errors) {
  if (!projectId) errors.push('scorecard scope.projectId is required');
  if (lens === 'data') return [{ unitId: projectId, unitClass: 'project', materialityWeightBps: 10000 }];
  if (lens === 'company') {
    const tickers = [...new Set(authoritativeTickers(input).map(text).filter(Boolean))].sort();
    if (!tickers.length) errors.push('company authoritativeTickers are required');
    return tickers.map((unitId) => ({ unitId, unitClass: 'ticker', materialityWeightBps: 10000 }));
  }
  const industries = materialIndustries(input).map((entry) => {
    const item = object(entry) || {};
    return {
      unitId: text(item.unitId || item.industryId),
      unitClass: text(item.unitClass || item.classification),
      materialityWeightBps: item.materialityWeightBps ?? item.materialityBps,
    };
  });
  const seen = new Set();
  for (const unit of industries) {
    if (!unit.unitId) errors.push('materialIndustries contains a missing industryId');
    if (seen.has(unit.unitId)) errors.push(`materialIndustries contains duplicate ${unit.unitId}`);
    seen.add(unit.unitId);
    if (!['material', 'emerging_material'].includes(unit.unitClass)) errors.push(`${unit.unitId}.unitClass is invalid`);
    if (!Number.isSafeInteger(unit.materialityWeightBps)) errors.push(`${unit.unitId}.materialityWeightBps is invalid`);
  }
  if (!industries.length) errors.push('industry materialIndustries are required');
  return industries.sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function closurePaths(identity, errors) {
  const paths = [identity.candidateIdentity.candidateRef?.path];
  for (const refs of Object.values(identity.dependencyIdentity.dependencyRefs)) {
    for (const ref of refs) paths.push(ref?.path);
  }
  const result = [...new Set(paths.filter(Boolean))].sort();
  if (!result.length) errors.push('immutable artifact/dependency closure is empty');
  return result;
}

function assertEvidenceList(value, label, closure, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must contain at least one closure reference`);
    return [];
  }
  const normalized = [];
  for (const [index, item] of value.entries()) {
    const path = evidencePath(item);
    if (!path || !closure.includes(path)) errors.push(`${label}[${index}] is outside the immutable closure`);
    else normalized.push(item.trim());
  }
  return [...new Set(normalized)].sort();
}

function assertRawSourceChecks(value, closure, errors) {
  if (!Array.isArray(value)) {
    errors.push('rawSourceChecks must be an array');
    return [];
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const item = exactObject(entry, ['checkId', 'artifactRef', 'location', 'status', 'evidenceRefs', 'notes'], `rawSourceChecks[${index}]`, errors);
    if (!item) return null;
    const checkId = text(item.checkId);
    if (!checkId || seen.has(checkId)) errors.push(`rawSourceChecks[${index}].checkId must be unique and non-empty`);
    seen.add(checkId);
    const artifactRef = evidencePath(item.artifactRef);
    if (!artifactRef || !closure.includes(artifactRef)) errors.push(`rawSourceChecks[${index}].artifactRef is outside the immutable closure`);
    const evidenceRefs = assertEvidenceList(item.evidenceRefs, `rawSourceChecks[${index}].evidenceRefs`, closure, errors);
    const status = text(item.status);
    if (!RAW_CHECK_STATUSES.has(status)) errors.push(`rawSourceChecks[${index}].status is invalid`);
    if (!text(item.location)) errors.push(`rawSourceChecks[${index}].location is required`);
    if (typeof item.notes !== 'string') errors.push(`rawSourceChecks[${index}].notes is required`);
    return { checkId, artifactRef, location: item.location.trim(), status, evidenceRefs, notes: item.notes.trim() };
  }).filter(Boolean);
}

function assertPriorIssueChecks(value, input, closure, errors) {
  if (!Array.isArray(value)) {
    errors.push('priorIssueChecks must be an array');
    return [];
  }
  const prior = Array.isArray(input.priorOpenIssues) ? input.priorOpenIssues : [];
  const expected = new Set(prior.map((issue) => text(issue?.issueKey || issue?.id)).filter(Boolean));
  const seen = new Set();
  const output = value.map((entry, index) => {
    const item = exactObject(entry, ['issueKey', 'status', 'evidenceRefs', 'notes'], `priorIssueChecks[${index}]`, errors);
    if (!item) return null;
    const issueKey = text(item.issueKey);
    if (!issueKey || seen.has(issueKey)) errors.push(`priorIssueChecks[${index}].issueKey must be unique and non-empty`);
    if (expected.size && !expected.has(issueKey)) errors.push(`priorIssueChecks[${index}] references an unknown prior Issue`);
    seen.add(issueKey);
    if (!PRIOR_CHECK_STATUSES.has(item.status)) errors.push(`priorIssueChecks[${index}].status is invalid`);
    const evidenceRefs = assertEvidenceList(item.evidenceRefs, `priorIssueChecks[${index}].evidenceRefs`, closure, errors);
    if (typeof item.notes !== 'string') errors.push(`priorIssueChecks[${index}].notes is required`);
    return { issueKey, status: item.status, evidenceRefs, notes: item.notes.trim() };
  }).filter(Boolean);
  if (expected.size && expected.size !== seen.size) errors.push('priorIssueChecks must contain exactly one entry per supplied prior open Issue');
  return output;
}

function assertRubricResults(rawUnit, spec, unit, closure, errors) {
  const rubricResults = rawUnit.rubricResults;
  if (!Array.isArray(rubricResults)) {
    errors.push(`${unit.unitId}.rubricResults must be an array`);
    return [];
  }
  const expected = new Set(spec.rubrics.map((rubric) => rubric.id));
  const seen = new Set();
  for (const [index, result] of rubricResults.entries()) {
    const item = exactObject(
      result,
      ['rubricId', 'status', 'rating', 'decisiveEvidence', 'whyNotHigher', 'errorTags', 'confidence', 'notApplicableReason'],
      `${unit.unitId}.rubricResults[${index}]`,
      errors,
    );
    if (!item) continue;
    const rubricId = text(item.rubricId);
    if (!expected.has(rubricId)) errors.push(`${unit.unitId}.rubricResults contains unknown ${rubricId || '(missing)'}`);
    if (seen.has(rubricId)) errors.push(`${unit.unitId}.rubricResults contains duplicate ${rubricId}`);
    seen.add(rubricId);
    const status = item.status;
    if (!['scored', 'not-applicable'].includes(status)) errors.push(`${unit.unitId}.${rubricId}.status is invalid`);
    if (status === 'not-applicable') {
      if (spec.lens !== 'data') errors.push(`${unit.unitId}.${rubricId} cannot be not-applicable for ${spec.lens}`);
      if (Object.hasOwn(item, 'rating')) errors.push(`${unit.unitId}.${rubricId}.rating must be omitted when N/A`);
      if (!text(item.notApplicableReason)) errors.push(`${unit.unitId}.${rubricId}.notApplicableReason is required`);
    } else if (Object.hasOwn(item, 'notApplicableReason')) {
      errors.push(`${unit.unitId}.${rubricId}.notApplicableReason is only allowed for N/A`);
    } else if (!Number.isInteger(item.rating) || item.rating < 0 || item.rating > 4) {
      errors.push(`${unit.unitId}.${rubricId}.rating must be an integer from 0 to 4`);
    }
    assertEvidenceList(item.decisiveEvidence, `${unit.unitId}.${rubricId}.decisiveEvidence`, closure, errors);
    if (!text(item.whyNotHigher)) errors.push(`${unit.unitId}.${rubricId}.whyNotHigher is required`);
    if (!Array.isArray(item.errorTags) || item.errorTags.some((tag) => !text(tag) || !spec.errorTags.includes(text(tag)))) {
      errors.push(`${unit.unitId}.${rubricId}.errorTags contains an invalid tag`);
    }
    if (!CONFIDENCE_VALUES.has(item.confidence)) errors.push(`${unit.unitId}.${rubricId}.confidence is invalid`);
  }
  for (const rubric of spec.rubrics) if (!seen.has(rubric.id)) errors.push(`${unit.unitId}.${rubric.id} is required`);
  if (seen.size !== spec.rubrics.length) errors.push(`${unit.unitId} must contain exactly ${spec.rubrics.length} rubric results`);
  return rubricResults;
}

function assertUnits(raw, lens, input, projectId, spec, closure, errors) {
  if (!Array.isArray(raw.units)) {
    errors.push('units must be an array');
    return [];
  }
  const authorities = authoritativeUnits(lens, input, projectId, errors);
  const byId = new Map();
  for (const [index, entry] of raw.units.entries()) {
    const unit = exactObject(entry, ['unitId', 'rubricResults', 'capTriggers'], `units[${index}]`, errors);
    if (!unit) continue;
    const unitId = text(unit.unitId);
    if (!unitId || byId.has(unitId)) errors.push(`units contains duplicate or missing unitId: ${unitId || '(missing)'}`);
    byId.set(unitId, unit);
  }
  const expected = new Set(authorities.map((unit) => unit.unitId));
  for (const unitId of byId.keys()) if (!expected.has(unitId)) errors.push(`units contains non-authoritative unit ${unitId}`);
  for (const authority of authorities) if (!byId.has(authority.unitId)) errors.push(`units is missing authoritative unit ${authority.unitId}`);
  if (byId.size !== expected.size) errors.push(`units must contain exactly ${expected.size} authoritative units`);
  for (const authority of authorities) {
    const unit = byId.get(authority.unitId);
    if (!unit) continue;
    assertRubricResults(unit, spec, authority, closure, errors);
    if (!Array.isArray(unit.capTriggers) || unit.capTriggers.some((cap) => typeof cap !== 'string' || !spec.caps.concat(spec.projectCaps).some((item) => item.id === cap))) {
      errors.push(`${authority.unitId}.capTriggers contains an unknown or malformed cap`);
    }
    if (new Set(unit.capTriggers || []).size !== (unit.capTriggers || []).length) errors.push(`${authority.unitId}.capTriggers contains duplicate cap IDs`);
    for (const capId of unit.capTriggers || []) {
      const rule = capEvidenceRuleFor(lens, capId);
      if (!rule) errors.push(`${authority.unitId}.capTriggers contains a cap with no known rubric relationship: ${capId}`);
      const matching = (unit.rubricResults || []).filter((result) => rule?.rubricIds?.includes(result.rubricId)
        && (rule.tags?.some((tag) => (result.errorTags || []).includes(tag)) || result.rating <= 1));
      if (rule && matching.length === 0) errors.push(`${authority.unitId}.${capId} has no applicable evidence or known rubric relationship`);
    }
  }
  return authorities.map((authority) => ({ ...authority, ...byId.get(authority.unitId) }));
}

export function scorecardLensForContract(contractId) {
  const lens = CONTRACT_LENSES[String(contractId || '')];
  if (!lens) throw new TypeError(`Unsupported Scorecard evaluator: ${contractId || '(missing)'}`);
  return lens;
}

export function projectScorecardEvaluationOutput(rawOutput, { request, contract } = {}) {
  if (!request || typeof request !== 'object') throw new TypeError('Scorecard output projection requires AgentRunRequest');
  if (!contract || typeof contract !== 'object') throw new TypeError('Scorecard output projection requires AgentContract');
  const lens = scorecardLensForContract(contract.id);
  const raw = object(rawOutput);
  const errors = [];
  if (!raw) invalid(['evaluator output must be an object']);
  const rootFields = ['rawSourceChecks', 'units', 'priorIssueChecks'];
  for (const key of Object.keys(raw)) if (!rootFields.includes(key)) errors.push(`root.${key} is not allowed`);
  for (const key of rootFields) if (!Object.hasOwn(raw, key)) errors.push(`root.${key} is required`);
  const input = object(request.input) || {};
  const projectId = text(object(input.scope)?.projectId || input.projectId || request.projectId);
  // ContractEnforcer can invoke outputAdapter on an already adapted value. Treat
  // that internal canonical form as a value to revalidate, never as raw evaluator
  // input, so malformed model output still fails closed on the first pass.
  if (Object.hasOwn(raw, 'schemaVersion')) {
    const canonicalErrors = validateScorecardEvaluation(raw, {
      projectId,
      authoritativeTickers: authoritativeTickers(input),
      materialIndustries: materialIndustries(input),
      weightsAuditable: true,
    });
    if (canonicalErrors.length) invalid(canonicalErrors);
    return raw;
  }
  const identity = identityFromInput(input, errors);
  const closure = closurePaths(identity, errors);
  const spec = getScorecardSpec(lens);
  const units = assertUnits(raw, lens, input, projectId, spec, closure, errors);
  const rawSourceChecks = assertRawSourceChecks(raw.rawSourceChecks, closure, errors);
  assertPriorIssueChecks(raw.priorIssueChecks, input, closure, errors);
  if (identity.dependencyIdentity.dependencyDigest) {
    const expectedDigest = canonicalSha256(Object.fromEntries(['data', 'industry', 'company'].map((group) => [
      group,
      identity.dependencyIdentity.dependencyRefs[group].map((ref) => ({
        artifactId: ref.artifactId, version: ref.version, path: ref.path, contentDigest: ref.contentDigest,
        schemaVersion: ref.schemaVersion, producer: ref.producer, contractVersion: ref.contractVersion,
        inputDigest: ref.inputDigest, asOf: ref.asOf,
      })),
    ])));
    if (identity.dependencyIdentity.dependencyDigest !== expectedDigest) errors.push('dependencyIdentity.dependencyDigest does not match the exact closure');
  }
  if (errors.length) invalid(errors);
  const inputDigest = text(input.inputDigest);
  if (!/^sha256:[a-f0-9]{64}$/u.test(inputDigest)) invalid(['input.inputDigest is required and must be a canonical digest']);
  const cycle = input.cycle;
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > 2) invalid(['input.cycle must be an integer from 0 to 2']);
  const canonicalUnits = units.map((unit) => ({
    ...unit,
    capTriggers: [...(unit.capTriggers || [])],
    rubricResults: unit.rubricResults.map((result) => ({
      ...result,
      weight: spec.rubrics.find((rubric) => rubric.id === result.rubricId)?.weight,
    })),
  }));
  const output = createScorecardEvaluation({
    asOf: request.asOf,
    producer: contract.id,
    contractVersion: contract.version,
    inputDigest,
    createdAt: request.asOf,
    evidenceRefs: closure,
    lens,
    rubricVersion: spec.rubricVersion,
    candidateIdentity: identity.candidateIdentity,
    dependencyIdentity: identity.dependencyIdentity,
    cycle,
    artifactsScored: closure,
    rawSourceChecks,
    units: canonicalUnits,
  }, {
    projectId,
    authoritativeTickers: authoritativeTickers(input),
    materialIndustries: materialIndustries(input),
    requireCapEvidence: true,
    enforceEvidenceClosure: true,
  });
  return output;
}
