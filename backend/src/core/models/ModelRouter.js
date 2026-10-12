import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import { runtime as appRuntime, tierConfig } from '../../config.js';
import { createDeterministicDemoRoute } from './deterministicDemo.js';
import {
  createOpenAICompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from './openAICompatibleProvider.js';

function tierName(value = '') {
  if (value === 'small' || value === 'fast') return 'small';
  if (value === 'review' || value === 'reflection') return 'reflection';
  return 'main';
}

function configuredTier(modelPolicy = {}) {
  const tiers = tierConfig();
  return tiers[tierName(modelPolicy.tier)] || tiers.main;
}

export class ModelRoutingError extends Error {
  constructor(message, { attemptedProviders = [] } = {}) {
    super(message);
    this.name = 'ModelRoutingError';
    this.code = 'PI_MODEL_UNAVAILABLE';
    this.attemptedProviders = [...attemptedProviders];
  }
}

export class ModelRouter {
  constructor({ models = null, providerDefaults = {}, providerAvailability = {}, openAICompatibleConfig = {} } = {}) {
    this.useAppConfig = models === null;
    this.models = models || builtinModels();
    this.openAICompatibleConfig = { ...openAICompatibleConfig };
    this.providerAvailability = Object.freeze({ ...providerAvailability });
    this.providerDefaults = Object.freeze({ ...providerDefaults });
    if (this.useAppConfig) this.syncOpenAICompatibleProvider();
  }

  currentOpenAICompatibleConfig() {
    const modelId = this.openAICompatibleConfig.modelId ?? appRuntime.OPENAI_COMPATIBLE_MODEL;
    const configuredCatalog = this.openAICompatibleConfig.modelCatalog;
    const modelCatalog = configuredCatalog || (
      this.useAppConfig && !Object.prototype.hasOwnProperty.call(this.openAICompatibleConfig, 'modelId')
      ? Object.values(tierConfig())
        .filter((route) => route.provider === OPENAI_COMPATIBLE_PROVIDER_ID)
        .map((route) => ({ id: route.model, name: route.model }))
      : []);
    return {
      baseUrl: this.openAICompatibleConfig.baseUrl ?? appRuntime.OPENAI_COMPATIBLE_BASE_URL,
      modelId,
      modelCatalog,
      reasoningLevel: this.openAICompatibleConfig.reasoningLevel ?? appRuntime.OPENAI_COMPATIBLE_REASONING_LEVEL,
      apiKey: this.openAICompatibleConfig.apiKey || (() => appRuntime.OPENAI_COMPATIBLE_API_KEY),
    };
  }

  syncOpenAICompatibleProvider() {
    const compatible = this.currentOpenAICompatibleConfig();
    this.models.deleteProvider('openrouter');
    this.models.deleteProvider('gpt-gateway');
    this.models.deleteProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
    if (compatible.baseUrl && compatible.modelId) {
      this.models.setProvider(createOpenAICompatibleProvider(compatible));
    }
  }

  available(provider) {
    const custom = this.providerAvailability[provider];
    if (custom) return !!custom();
    if (!this.useAppConfig) return true;
    if (provider === 'deepseek') return !!appRuntime.DEEPSEEK_API_KEY;
    if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const compatible = this.currentOpenAICompatibleConfig();
      let key = '';
      try { key = String(compatible.apiKey?.() || '').trim(); } catch { key = ''; }
      return !!compatible.baseUrl && !!compatible.modelId && !!key;
    }
    return false;
  }

  defaultModel(provider, configured = {}) {
    if (this.providerDefaults[provider]) return this.providerDefaults[provider];
    if (configured.provider === provider && configured.model) return configured.model;
    if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return this.currentOpenAICompatibleConfig().modelId || '';
    if (provider === 'deepseek') return appRuntime.DEEPSEEK_MODEL || 'deepseek-v4-pro';
    return '';
  }

  resolve(modelPolicy = {}, runtime = {}) {
    const demo = runtime.demo === undefined
      ? (this.useAppConfig && appRuntime.DEMO_MODE)
      : runtime.demo === true;
    if (demo) {
      return createDeterministicDemoRoute({
        runtime,
        contractId: runtime.agentContractId,
        reasoningLevel: runtime.reasoningLevel || 'off',
      });
    }

    if (this.useAppConfig) this.syncOpenAICompatibleProvider();
    const configured = this.useAppConfig ? configuredTier(modelPolicy) : {};
    const provider = String(runtime.provider || configured.provider || modelPolicy.preferredProviders?.[0] || '').trim();
    const attemptedProviders = provider ? [provider] : [];
    if (!provider) {
      throw new ModelRoutingError('no Pi model provider was selected', { attemptedProviders });
    }
    if (!this.available(provider)) {
      throw new ModelRoutingError(`Pi model provider is unavailable: ${provider}`, { attemptedProviders });
    }

    const modelId = String(runtime.model || this.defaultModel(provider, configured) || '').trim();
    if (!modelId) {
      throw new ModelRoutingError(`no model configured for Pi provider: ${provider}`, { attemptedProviders });
    }
    let model = null;
    try { model = this.models.getModel(provider, modelId); } catch { model = null; }
    if (!model) {
      throw new ModelRoutingError(`Pi model is unavailable: ${provider}/${modelId}`, { attemptedProviders });
    }

    const compatible = this.currentOpenAICompatibleConfig();
    return Object.freeze({
      model,
      streamFn: this.models.streamSimple.bind(this.models),
      provider,
      modelId,
      reasoningLevel: runtime.reasoningLevel
        || (provider === OPENAI_COMPATIBLE_PROVIDER_ID ? compatible.reasoningLevel : '')
        || modelPolicy.reasoningLevel
        || 'standard',
      attemptedProviders: Object.freeze(attemptedProviders),
      fallbackFrom: null,
    });
  }
}
