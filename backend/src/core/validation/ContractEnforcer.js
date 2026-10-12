import { matchesAnyPathPattern, normalizeSafeRelativePath } from '../policy/pathPolicy.js';
import { adaptAgentOutput, adapterValidationErrors } from './AgentOutputAdapter.js';
import { getAgentSchema } from './agentSchemaRegistry.js';
import { OutputGate } from './OutputGate.js';

const DEFAULT_OUTPUT_GATE = new OutputGate({ schemaResolver: getAgentSchema });

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactPath(artifact) {
  if (typeof artifact === 'string') return artifact;
  if (!artifact || typeof artifact !== 'object') return null;
  return artifact.path || artifact.name || artifact.uri || artifact.file || null;
}

export function concreteArtifactPattern(pattern) {
  return String(pattern || '')
    .replace(/_rN\b/gu, '_r*')
    .replace(/rN\b/gu, 'r*')
    .replace(/_N\b/gu, '_*');
}

export function contractArtifactPathAllowed(path, patterns) {
  const safe = normalizeSafeRelativePath(path);
  if (!safe) return { safe: null, allowed: false };
  const expanded = asArray(patterns).flatMap((pattern) => [pattern, concreteArtifactPattern(pattern)]);
  return { safe, allowed: matchesAnyPathPattern(safe, expanded) };
}

function requireObject(output, check, errors) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    errors.push(`${check} requires an object output`);
    return false;
  }
  return true;
}

function checkField(output, check, field, errors) {
  if (!requireObject(output, check, errors)) return;
  if (output[field] === undefined || output[field] === null || output[field] === '') {
    errors.push(`${check} requires $.${field}`);
  }
}

const HARD_CHECKS = Object.freeze({
  'output-schema': () => {},
  'non-empty-report': () => {},
  'plan-shape': (output, errors) => {
    if (!requireObject(output, 'plan-shape', errors)) return;
    if (!Array.isArray(output.candidates)) errors.push('plan-shape requires $.candidates array');
  },
  'bounded-pool': (output, errors) => {
    if (!requireObject(output, 'bounded-pool', errors)) return;
    if (Array.isArray(output.scores) && output.scores.length > 30) errors.push('bounded-pool allows at most 30 scores');
  },
  'screen-shape': (output, errors) => {
    if (!requireObject(output, 'screen-shape', errors)) return;
    if (!Array.isArray(output.scores)) errors.push('screen-shape requires $.scores array');
  },
  'data-organize-schema': (output, errors) => {
    if (!requireObject(output, 'data-organize-schema', errors)) return;
    if (!Array.isArray(output.organized) && !Array.isArray(output.excerpts)) {
      errors.push('data-organize-schema requires $.organized or $.excerpts array');
    }
  },
  coverage: (output, errors) => {
    if (!requireObject(output, 'coverage', errors)) return;
    if (output.coverage === undefined && output.gaps === undefined && output.nextDataFocus === undefined) {
      errors.push('coverage requires $.coverage, $.gaps, or $.nextDataFocus');
    }
  },
  'structural-view': (output, errors) => checkField(output, 'structural-view', 'structuralView', errors),
  ticker: (output, errors) => checkField(output, 'ticker', 'ticker', errors),
  valuation: (output, errors) => checkField(output, 'valuation', 'valuation', errors),
  invalidation: (output, errors) => {
    if (!requireObject(output, 'invalidation', errors)) return;
    if (output.invalidation === undefined && output.risks === undefined) {
      errors.push('invalidation requires $.invalidation or $.risks');
    }
  },
  'review-shape': (output, errors) => { requireObject(output, 'review-shape', errors); },
  'reflection-shape': (output, errors) => { requireObject(output, 'reflection-shape', errors); },
  'crux-shape': (output, errors) => {
    if (!requireObject(output, 'crux-shape', errors)) return;
    if (!Array.isArray(output.cruxes)) errors.push('crux-shape requires $.cruxes array');
  },
  'scenario-schema': (output, errors) => {
    if (!requireObject(output, 'scenario-schema', errors)) return;
    if (!Array.isArray(output.futures)) errors.push('scenario-schema requires $.futures array');
  },
  'probability-sum': (output, errors) => {
    if (!Array.isArray(output?.futures) || !output.futures.length) return;
    const sum = output.futures.reduce((acc, item) => acc + Number(item?.probability || 0), 0);
    if (Math.abs(sum - 1) > 0.03) errors.push(`probability-sum must be approximately 1, got ${sum.toFixed(4)}`);
  },
  'conclusion-schema': (output, errors) => {
    if (!requireObject(output, 'conclusion-schema', errors)) return;
    if (!output.rating) errors.push('conclusion-schema requires $.rating');
    if (typeof output.recommendationScore !== 'number') errors.push('conclusion-schema requires numeric $.recommendationScore');
  },
  'expected-return-score-clamp': (output, errors) => {
    if (output?.recommendationScore === undefined) return;
    const score = Number(output.recommendationScore);
    if (!Number.isFinite(score) || score < 0 || score > 100) errors.push('expected-return-score-clamp requires recommendationScore between 0 and 100');
  },
  'claims-shape': (output, errors) => { requireObject(output, 'claims-shape', errors); },
  'rankings-shape': (output, errors) => { requireObject(output, 'rankings-shape', errors); },
  'ladder-compare-schema': (output, errors) => { requireObject(output, 'ladder-compare-schema', errors); },
});

export const COMPLETION_HARD_CHECKS = Object.freeze(Object.keys(HARD_CHECKS));

export class ContractEnforcer {
  constructor({ outputGate = DEFAULT_OUTPUT_GATE } = {}) {
    if (!outputGate || typeof outputGate.evaluate !== 'function') throw new TypeError('ContractEnforcer requires an OutputGate');
    this.outputGate = outputGate;
  }

  evaluate({
    contract,
    request = null,
    output,
    text = '',
    artifacts = [],
    priorValid = true,
    priorErrors = [],
    artifactCommitOwner = 'agent',
  } = {}) {
    if (!contract || typeof contract !== 'object') throw new TypeError('ContractEnforcer requires a contract');
    const hardChecks = asArray(contract.completionPolicy?.hardChecks);
    const schemaId = hardChecks.includes('output-schema') ? contract.outputSchema : null;
    let adaptedOutput;
    let adaptationErrors = [];
    try {
      adaptedOutput = adaptAgentOutput({ contract, request, output, text });
    } catch (error) {
      const structured = contract.executionMode === 'json'
        || typeof contract.outputAdapter === 'function'
        || hardChecks.includes('output-schema');
      if (contract.completionPolicy?.gracefulFinalize !== true || !structured) throw error;
      adaptationErrors = adapterValidationErrors(error);
    }
    const gated = this.outputGate.evaluate({ output: adaptedOutput, text, schemaId, hardChecks });
    const errors = [...asArray(priorErrors), ...adaptationErrors, ...gated.errors];
    if (!['agent', 'workflow'].includes(artifactCommitOwner)) {
      errors.push(`invalid artifact commit owner: ${artifactCommitOwner}`);
    }

    for (const check of hardChecks) {
      const validate = HARD_CHECKS[check];
      if (!validate) {
        errors.push(`unknown completion hard check: ${check}`);
        continue;
      }
      validate(gated.output, errors);
    }

    const paths = asArray(artifacts).map(artifactPath).filter(Boolean);
    const outputPaths = asArray(contract.outputPaths);
    const authority = contract.artifactAuthority || 'return';
    if (authority === 'return' && paths.length) {
      errors.push(`artifact authority return does not allow artifact paths: ${paths.join(', ')}`);
    }
    if (!['return', 'artifact', 'return+artifact'].includes(authority)) {
      errors.push(`invalid artifact authority: ${authority}`);
    }
    if (authority === 'artifact' && gated.output !== undefined && gated.output !== null && gated.output !== '') {
      errors.push('artifact authority artifact does not allow return output');
    }
    for (const pattern of outputPaths) {
      if (!normalizeSafeRelativePath(pattern)) errors.push(`unsafe output path pattern: ${pattern}`);
    }
    for (const path of paths) {
      const { safe, allowed } = contractArtifactPathAllowed(path, outputPaths);
      if (!safe) errors.push(`unsafe artifact path: ${path}`);
      else if (!allowed) errors.push(`unauthorized artifact path: ${safe}`);
    }
    const requiredArtifacts = asArray(contract.completionPolicy?.requiredArtifacts);
    if (artifactCommitOwner === 'agent') {
      for (const required of requiredArtifacts) {
        const matched = paths.some((path) => contractArtifactPathAllowed(path, [required]).allowed);
        if (!matched) errors.push(`required artifact is absent: ${required}`);
      }
    }

    return Object.freeze({
      valid: priorValid !== false && errors.length === 0,
      output: adaptationErrors.length ? undefined : gated.output,
      errors: Object.freeze(errors),
      artifactCommitOwner,
      delegatedRequiredArtifacts: Object.freeze(artifactCommitOwner === 'workflow' ? [...requiredArtifacts] : []),
    });
  }

  assertArtifactsCommitted({ contract, artifacts = [], artifactExists = null } = {}) {
    if (!contract || typeof contract !== 'object') throw new TypeError('ContractEnforcer requires a contract');
    if (artifactExists !== null && typeof artifactExists !== 'function') throw new TypeError('artifactExists must be a function');
    const paths = asArray(artifacts).map(artifactPath).filter(Boolean);
    const exists = artifactExists || ((pattern) => paths.some((path) => contractArtifactPathAllowed(path, [pattern]).allowed));
    const errors = [];
    for (const pattern of asArray(contract.outputPaths)) {
      if (!contractArtifactPathAllowed(pattern, [pattern]).safe) errors.push(`unsafe output path pattern: ${pattern}`);
    }
    for (const required of asArray(contract.completionPolicy?.requiredArtifacts)) {
      if (!exists(required)) errors.push(`required artifact is absent: ${required}`);
    }
    if (errors.length) {
      const error = new Error(`Contract completion rejected for ${contract.id}: ${errors.join('; ')}`);
      error.code = 'CONTRACT_COMPLETION_REJECTED';
      error.errors = errors;
      throw error;
    }
    return true;
  }
}

export const contractEnforcer = new ContractEnforcer();
