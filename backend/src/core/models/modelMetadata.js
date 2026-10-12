export const MAX_MODEL_ID_LENGTH = 256;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export function isSafeModelId(value) {
  return typeof value === 'string'
    && value.length <= MAX_MODEL_ID_LENGTH
    && MODEL_ID_PATTERN.test(value);
}

export function normalizeModelId(value, field = 'model id', { allowEmpty = false } = {}) {
  const modelId = String(value ?? '').trim();
  if (!modelId && allowEmpty) return '';
  if (!modelId) throw new TypeError(`${field} must be a non-empty model id`);
  if (!isSafeModelId(modelId)) throw new TypeError(`${field} must be a safe model id`);
  return modelId;
}
