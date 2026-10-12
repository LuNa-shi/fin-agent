const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function cloneReportValue(value) {
  return structuredClone(value);
}

export function createReportValidators({
  fail,
  unsafeIdCode,
  invalidDigestCode,
  invalidTimestampCode,
}) {
  if (typeof fail !== 'function') throw new TypeError('report validator fail callback is required');
  return Object.freeze({
    safeId(value, field) {
      if (typeof value !== 'string' || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
        fail(`${field} is unsafe`, unsafeIdCode, 400);
      }
      return value;
    },
    digest(value, field) {
      if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
        fail(`${field} must be a sha256 digest`, invalidDigestCode, 400);
      }
      return value;
    },
    iso(value, field) {
      if (typeof value !== 'string' || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value))) {
        fail(`${field} must be a canonical ISO timestamp`, invalidTimestampCode, 400);
      }
      return value;
    },
  });
}
