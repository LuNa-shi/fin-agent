import crypto from 'node:crypto';

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { fetchWithRetry } from '../../lib/http.js';
import { isSafeModelId, normalizeModelId } from './modelMetadata.js';

import {
  normalizeOpenAICompatibleBaseUrl,
  normalizeOpenAICompatibleReasoningLevel,
  openAICompatibleModelsUrl,
} from './openAICompatible.js';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
const PROMPT_CACHE_AUDIT_SCHEMA_VERSION = 'openai-compatible-prompt-cache-audit.v1';
const promptCacheObservers = new Set();
const promptCacheRequestSequences = new Map();

function promptCacheDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

export function observeOpenAICompatiblePromptCache(observer) {
  if (typeof observer !== 'function') {
    throw new TypeError('OpenAI-compatible prompt cache observer must be a function');
  }
  const subscription = Object.freeze({ observer });
  promptCacheObservers.add(subscription);
  let active = true;
  return () => {
    if (!active) return false;
    active = false;
    const removed = promptCacheObservers.delete(subscription);
    if (promptCacheObservers.size === 0) promptCacheRequestSequences.clear();
    return removed;
  };
}

function publishPromptCacheAudit(sessionId, promptCacheKey, model) {
  if (promptCacheObservers.size === 0) return;
  const requestSequence = (promptCacheRequestSequences.get(sessionId) || 0) + 1;
  promptCacheRequestSequences.set(sessionId, requestSequence);
  const event = Object.freeze({
    schemaVersion: PROMPT_CACHE_AUDIT_SCHEMA_VERSION,
    sessionIdDigest: promptCacheDigest(sessionId),
    promptCacheKeyDigest: promptCacheDigest(promptCacheKey),
    keysMatch: promptCacheKey === sessionId,
    modelId: String(model?.id || '').trim() || 'unreported',
    requestSequence,
  });
  for (const subscription of [...promptCacheObservers]) {
    try {
      const outcome = subscription.observer(event);
      if (outcome && typeof outcome.then === 'function') outcome.catch(() => {});
    } catch {}
  }
}

function promptCacheOptions(options = {}) {
  const sessionId = String(options?.sessionId || '').trim();
  if (!sessionId || options.cacheRetention === 'none') return options;
  const callerOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const replacement = await callerOnPayload?.(payload, model);
      const resolved = replacement === undefined ? payload : replacement;
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return resolved;
      const nextPayload = { ...resolved, prompt_cache_key: sessionId };
      publishPromptCacheAudit(sessionId, nextPayload.prompt_cache_key, model);
      return nextPayload;
    },
  };
}
const MAX_MODEL_METADATA_LENGTH = 256;
const MAX_DISCOVERED_MODELS = 1_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 1_000_000;

function discoveryError(message, code, statusCode = 502) {
  const error = new Error(message);
  error.name = 'OpenAICompatibleDiscoveryError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function modelEntry(value) {
  const id = typeof value?.id === 'string' ? value.id : '';
  if (!isSafeModelId(id)) return null;
  const rawName = typeof value?.name === 'string' ? value.name : '';
  if (
    rawName
    && (
      rawName !== rawName.trim()
      || rawName.length > MAX_MODEL_METADATA_LENGTH
      || /[\u0000-\u001f\u007f]/u.test(rawName)
    )
  ) return null;
  return { id, name: rawName || id };
}

export async function discoverOpenAICompatibleModels({
  baseUrl,
  apiKey,
  selectedModelId = '',
  fetchImpl = fetchWithRetry,
  timeoutMs = 10_000,
} = {}) {
  let normalizedBaseUrl;
  try { normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl); }
  catch {
    throw discoveryError(
      'OpenAI-compatible Base URL is invalid',
      'OPENAI_COMPATIBLE_BASE_URL_INVALID',
      400,
    );
  }
  const normalizedApiKey = String(apiKey || '').trim();
  if (!normalizedBaseUrl) {
    throw discoveryError('OpenAI-compatible Base URL is required', 'OPENAI_COMPATIBLE_BASE_URL_REQUIRED', 400);
  }
  if (!normalizedApiKey) {
    throw discoveryError('OpenAI-compatible API key is required', 'OPENAI_COMPATIBLE_API_KEY_REQUIRED', 400);
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('model discovery requires fetchImpl');

  let response;
  try {
    response = await fetchImpl(openAICompatibleModelsUrl(normalizedBaseUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${normalizedApiKey}`,
      },
      redirect: 'error',
      timeoutMs,
      retries: 0,
    });
  } catch {
    throw discoveryError(
      'OpenAI-compatible model discovery request failed',
      'OPENAI_COMPATIBLE_MODELS_UNAVAILABLE',
    );
  }

  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    if (status === 401 || status === 403) {
      throw discoveryError(
        'OpenAI-compatible API rejected the configured API key',
        'OPENAI_COMPATIBLE_AUTH_FAILED',
      );
    }
    throw discoveryError(
      `OpenAI-compatible model discovery failed with upstream status ${status || 'unknown'}`,
      'OPENAI_COMPATIBLE_MODELS_UNAVAILABLE',
    );
  }

  let responseText;
  try { responseText = await response.text(); }
  catch {
    throw discoveryError(
      'OpenAI-compatible model discovery response could not be read',
      'OPENAI_COMPATIBLE_MODELS_INVALID',
    );
  }
  if (Buffer.byteLength(responseText, 'utf8') > MAX_DISCOVERY_RESPONSE_BYTES) {
    throw discoveryError(
      'OpenAI-compatible model discovery response is too large',
      'OPENAI_COMPATIBLE_MODELS_INVALID',
    );
  }
  let payload;
  try { payload = JSON.parse(responseText); }
  catch {
    throw discoveryError(
      'OpenAI-compatible model discovery returned invalid JSON',
      'OPENAI_COMPATIBLE_MODELS_INVALID',
    );
  }
  if (!Array.isArray(payload?.data)) {
    throw discoveryError(
      'OpenAI-compatible model discovery response must contain data[]',
      'OPENAI_COMPATIBLE_MODELS_INVALID',
    );
  }

  const models = [];
  const seen = new Set();
  for (const value of payload.data.slice(0, MAX_DISCOVERED_MODELS)) {
    const model = modelEntry(value);
    if (!model || seen.has(model.id)) continue;
    if (model.id.includes(normalizedApiKey) || model.name.includes(normalizedApiKey)) {
      throw discoveryError(
        'OpenAI-compatible model catalog contains unsafe credential metadata',
        'OPENAI_COMPATIBLE_MODELS_INVALID',
      );
    }
    seen.add(model.id);
    models.push(model);
  }
  if (!models.length) {
    throw discoveryError(
      'OpenAI-compatible model discovery returned no usable models',
      'OPENAI_COMPATIBLE_MODELS_EMPTY',
    );
  }
  const normalizedSelectedModelId = String(selectedModelId || '').trim();
  if (normalizedSelectedModelId && !seen.has(normalizedSelectedModelId)) {
    throw discoveryError(
      'Selected OpenAI-compatible model was not found in the proxy catalog',
      'OPENAI_COMPATIBLE_MODEL_NOT_FOUND',
      400,
    );
  }
  return models;
}

export function createOpenAICompatibleProvider({
  baseUrl,
  modelId,
  modelName = modelId,
  modelCatalog = [],
  reasoningLevel = 'high',
  apiKey = () => '',
  contextWindow = 128_000,
  maxTokens = 32_768,
} = {}) {
  const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl);
  let normalizedModelId;
  try { normalizedModelId = normalizeModelId(modelId, 'OpenAI-compatible modelId'); }
  catch { throw new TypeError('OpenAI-compatible provider requires a safe modelId'); }
  const normalizedModelName = String(modelName || normalizedModelId).trim();
  normalizeOpenAICompatibleReasoningLevel(reasoningLevel);
  if (!normalizedBaseUrl) throw new TypeError('OpenAI-compatible provider requires baseUrl');
  if (!normalizedModelId) throw new TypeError('OpenAI-compatible provider requires modelId');
  if (typeof apiKey !== 'function') throw new TypeError('OpenAI-compatible apiKey must be a function');

  const catalog = [];
  const seen = new Set();
  for (const entry of [
    { id: normalizedModelId, name: normalizedModelName || normalizedModelId },
    ...(Array.isArray(modelCatalog) ? modelCatalog : []),
  ]) {
    const normalized = modelEntry(entry);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    catalog.push(normalized);
  }
  if (!seen.has(normalizedModelId)) {
    throw new TypeError('OpenAI-compatible provider requires the configured modelId in its catalog');
  }
  const models = catalog.map((entry) => Object.freeze({
    id: entry.id,
    name: entry.name,
    api: 'openai-completions',
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: normalizedBaseUrl,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'xhigh',
    },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_completion_tokens',
      thinkingFormat: 'openai',
      supportsStrictMode: false,
      sendSessionAffinityHeaders: false,
    },
  }));

  const upstreamApi = openAICompletionsApi();
  const api = Object.freeze({
    ...upstreamApi,
    stream: (sourceModel, context, options) => (
      upstreamApi.stream(sourceModel, context, promptCacheOptions(options))
    ),
    streamSimple: (sourceModel, context, options) => (
      upstreamApi.streamSimple(sourceModel, context, promptCacheOptions(options))
    ),
  });

  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: 'OpenAI-compatible API',
    baseUrl: normalizedBaseUrl,
    auth: {
      apiKey: {
        name: 'OpenAI-compatible API key',
        resolve: async () => {
          const key = String(apiKey() || '').trim();
          return key ? { auth: { apiKey: key }, source: 'OPENAI_COMPATIBLE_API_KEY' } : undefined;
        },
      },
    },
    models,
    api,
  });
}
