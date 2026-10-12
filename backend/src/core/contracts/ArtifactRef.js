import crypto from 'node:crypto';

export const ARTIFACT_REF_CONTRACT_VERSION = 'artifact-ref.v1';
export const ARTIFACT_REF_REQUIRED_FIELDS = Object.freeze([
  'contract',
  'artifactId',
  'version',
  'contentDigest',
  'schemaVersion',
  'producer',
  'contractVersion',
  'inputDigest',
  'createdAt',
  'asOf',
]);
export const ARTIFACT_REF_LOCATION_FIELDS = Object.freeze(['path', 'uri']);

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const SEMVER_RE = /^\d+\.\d+\.\d+$/u;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pathForKey(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function canonicalError(reason, location, detail = '') {
  return new TypeError(`canonical digest rejects ${reason} at ${location}${detail ? ` (${detail})` : ''}`);
}

function canonicalize(value, seen = new Map(), location = '$') {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw canonicalError('non-finite number', location);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw canonicalError('circular value', location, `first seen at ${seen.get(value)}`);
    seen.set(value, location);
    const next = value.map((item, index) => canonicalize(item, seen, `${location}[${index}]`));
    seen.delete(value);
    return next;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw canonicalError('circular value', location, `first seen at ${seen.get(value)}`);
    seen.set(value, location);
    const next = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      const childLocation = pathForKey(location, key);
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw canonicalError('unsupported value', childLocation, typeof item);
      }
      next[key] = canonicalize(item, seen, childLocation);
    }
    seen.delete(value);
    return next;
  }
  throw canonicalError('unsupported value', location, typeof value);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  const next = {};
  for (const key of Object.keys(value)) next[key] = deepClone(value[key]);
  return next;
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !value) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

export function validateArtifactRef(ref) {
  const errors = [];
  if (!isPlainObject(ref)) return { valid: false, errors: ['ArtifactRef must be an object'] };

  if (ref.contract !== ARTIFACT_REF_CONTRACT_VERSION) {
    errors.push(`unsupported ArtifactRef contract: ${ref.contract}`);
  }
  if (typeof ref.artifactId !== 'string' || !ref.artifactId.trim()) errors.push('artifactId is required');
  if (!Number.isInteger(ref.version) || ref.version <= 0) errors.push('ArtifactRef requires a positive version');
  if (Object.prototype.hasOwnProperty.call(ref, 'path') && typeof ref.path !== 'string') errors.push('path must be a string when present');
  if (Object.prototype.hasOwnProperty.call(ref, 'uri') && typeof ref.uri !== 'string') errors.push('uri must be a string when present');
  if (typeof ref.path !== 'string' && typeof ref.uri !== 'string') errors.push('ArtifactRef requires path or uri');
  if (typeof ref.path === 'string' && !ref.path.trim()) errors.push('path must be non-empty when present');
  if (typeof ref.uri === 'string' && !ref.uri.trim()) errors.push('uri must be non-empty when present');
  if (typeof ref.contentDigest !== 'string' || !DIGEST_RE.test(ref.contentDigest)) errors.push('contentDigest must be sha256:<hex>');
  if (typeof ref.schemaVersion !== 'string' || !ref.schemaVersion.trim()) errors.push('schemaVersion is required');
  if (typeof ref.producer !== 'string' || !ref.producer.trim()) errors.push('producer is required');
  if (typeof ref.contractVersion !== 'string' || !SEMVER_RE.test(ref.contractVersion)) errors.push('contractVersion must be a semantic version');
  if (typeof ref.inputDigest !== 'string' || !DIGEST_RE.test(ref.inputDigest)) errors.push('inputDigest must be sha256:<hex>');
  if (!isIsoDate(ref.createdAt)) errors.push('createdAt must be an ISO timestamp');
  if (!isIsoDate(ref.asOf)) errors.push('asOf must be an ISO timestamp');

  return { valid: errors.length === 0, errors };
}

export function assertValidArtifactRef(ref) {
  const result = validateArtifactRef(ref);
  if (!result.valid) {
    const error = new Error(`invalid ArtifactRef: ${result.errors.join('; ')}`);
    error.code = 'INVALID_ARTIFACT_REF';
    error.errors = result.errors;
    throw error;
  }
  return true;
}

export function createArtifactRef(input) {
  const ref = {
    contract: ARTIFACT_REF_CONTRACT_VERSION,
    ...deepClone(input),
  };
  assertValidArtifactRef(ref);
  return deepFreeze(ref);
}
