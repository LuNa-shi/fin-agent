const ALLOWED_REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeOpenAICompatibleBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new TypeError('OPENAI_COMPATIBLE_BASE_URL must be a valid URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('OPENAI_COMPATIBLE_BASE_URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('OPENAI_COMPATIBLE_BASE_URL must not include credentials, query, or fragment');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.toString().replace(/\/$/u, '');
}

export function openAICompatibleModelsUrl(baseUrl) {
  const normalized = normalizeOpenAICompatibleBaseUrl(baseUrl);
  if (!normalized) throw new TypeError('OPENAI_COMPATIBLE_BASE_URL is required');
  return `${normalized}/models`;
}

export function normalizeOpenAICompatibleReasoningLevel(value = '', fallback = 'high') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!ALLOWED_REASONING_LEVELS.has(normalized)) {
    throw new TypeError(`unsupported OpenAI-compatible reasoning level: ${normalized || '(empty)'}`);
  }
  return normalized;
}
