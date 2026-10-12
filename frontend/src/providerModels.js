export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = 'gpt-5.6-sol';
export const DEFAULT_OPENAI_COMPATIBLE_REASONING_LEVEL = 'high';

export function buildProviderSettingsForm(providers = {}) {
  const tierOverrides = providers.tierOverrides || {};
  return {
    DEFAULT_PROVIDER: providers.defaultProvider || OPENAI_COMPATIBLE_PROVIDER_ID,
    OPENAI_COMPATIBLE_BASE_URL: providers.openAICompatibleBaseUrl || '',
    OPENAI_COMPATIBLE_API_KEY: '',
    OPENAI_COMPATIBLE_MODEL: providers.openAICompatibleModel || DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
    OPENAI_COMPATIBLE_REASONING_LEVEL: providers.openAICompatibleReasoningLevel
      || DEFAULT_OPENAI_COMPATIBLE_REASONING_LEVEL,
    DEEPSEEK_MODEL: providers.deepseekModel || 'deepseek-v4-pro',
    SMALL_PROVIDER: tierOverrides.small?.provider || '',
    SMALL_MODEL: tierOverrides.small?.model || '',
    MAIN_PROVIDER: tierOverrides.main?.provider || '',
    MAIN_MODEL: tierOverrides.main?.model || '',
    REFLECTION_PROVIDER: tierOverrides.reflection?.provider || '',
    REFLECTION_MODEL: tierOverrides.reflection?.model || '',
    UI_LANGUAGE: providers.uiLanguage || 'zh',
    ANALYSIS_LANGUAGE: providers.analysisLanguage || 'en',
    REPORT_LANGUAGE: providers.reportLanguage || 'en',
  };
}

export const DEEPSEEK_MODELS = Object.freeze([
  Object.freeze({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }),
  Object.freeze({ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }),
]);

function safeModel(value) {
  const id = typeof value?.id === 'string' ? value.id : '';
  if (!id || id !== id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) return null;
  const rawName = typeof value?.name === 'string' ? value.name : '';
  if (rawName && (rawName !== rawName.trim() || /[\u0000-\u001f\u007f]/u.test(rawName))) return null;
  return { id, name: rawName || id };
}

export function normalizeDiscoveredModels(values = []) {
  const models = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const model = safeModel(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

export function discoveredModelLabel(model) {
  return model.name && model.name !== model.id
    ? `${model.name} — ${model.id}`
    : model.id;
}

export function buildTierModelOptions(openAICompatibleModels = []) {
  return [
    ...DEEPSEEK_MODELS.map((model) => ({
      provider: 'deepseek',
      model: model.id,
      label: `DeepSeek · ${model.name}`,
    })),
    ...normalizeDiscoveredModels(openAICompatibleModels).map((model) => ({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      model: model.id,
      label: `OpenAI-compatible · ${discoveredModelLabel(model)}`,
    })),
  ];
}

export function optionsWithCurrent(options, { provider, model } = {}) {
  if (!provider || !model || options.some((option) => (
    option.provider === provider && option.model === model
  ))) return options;
  return [{
    provider,
    model,
    label: `${provider} · ${model}（当前不可用）`,
    unavailable: true,
  }, ...options];
}

export function providerAvailabilityMode({ statusOnline, providers } = {}) {
  if (!statusOnline) return 'offline';
  if (providers?.liveLLM) return 'live';
  if (providers?.demoMode) return 'demo';
  return 'unavailable';
}
