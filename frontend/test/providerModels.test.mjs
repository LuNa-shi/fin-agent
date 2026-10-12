import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { api } from '../src/api.js';
import {
  buildProviderSettingsForm,
  buildTierModelOptions,
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID,
  DEFAULT_OPENAI_COMPATIBLE_REASONING_LEVEL,
  normalizeDiscoveredModels,
  optionsWithCurrent,
  providerAvailabilityMode,
} from '../src/providerModels.js';


test('Settings UI starts from the repository default route without implicit tier overrides', () => {
  assert.equal(DEFAULT_OPENAI_COMPATIBLE_MODEL_ID, 'gpt-5.6-sol');
  assert.equal(DEFAULT_OPENAI_COMPATIBLE_REASONING_LEVEL, 'high');
  assert.deepEqual(buildProviderSettingsForm({}), {
    DEFAULT_PROVIDER: 'openai-compatible',
    OPENAI_COMPATIBLE_BASE_URL: '',
    OPENAI_COMPATIBLE_API_KEY: '',
    OPENAI_COMPATIBLE_MODEL: 'gpt-5.6-sol',
    OPENAI_COMPATIBLE_REASONING_LEVEL: 'high',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
    SMALL_PROVIDER: '',
    SMALL_MODEL: '',
    MAIN_PROVIDER: '',
    MAIN_MODEL: '',
    REFLECTION_PROVIDER: '',
    REFLECTION_MODEL: '',
    UI_LANGUAGE: 'zh',
    ANALYSIS_LANGUAGE: 'en',
    REPORT_LANGUAGE: 'en',
  });
});

test('frontend preserves discovered model names and ids for every routing selector', () => {
  const models = normalizeDiscoveredModels([
    { id: 'luna', name: 'luna' },
    { id: 'vendor/model-two', name: 'Model Two' },
  ]);
  assert.deepEqual(models, [
    { id: 'luna', name: 'luna' },
    { id: 'vendor/model-two', name: 'Model Two' },
  ]);

  const options = buildTierModelOptions(models);
  assert.ok(options.some((option) => (
    option.provider === 'openai-compatible'
    && option.model === 'luna'
    && option.label === 'OpenAI-compatible · luna'
  )));
  assert.ok(options.some((option) => (
    option.provider === 'openai-compatible'
    && option.model === 'vendor/model-two'
    && option.label === 'OpenAI-compatible · Model Two — vendor/model-two'
  )));
});

test('a removed selected model remains visible as unavailable and is not auto-replaced', () => {
  const options = buildTierModelOptions([{ id: 'luna', name: 'luna' }]);
  const preserved = optionsWithCurrent(options, {
    provider: 'openai-compatible',
    model: 'removed-model',
  });
  assert.deepEqual(preserved[0], {
    provider: 'openai-compatible',
    model: 'removed-model',
    label: 'openai-compatible · removed-model（当前不可用）',
    unavailable: true,
  });
  assert.equal(preserved.some((option) => option.model === 'luna'), true);
});

test('frontend model discovery omits a blank key and sends an exact selected model id', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      provider: 'openai-compatible',
      models: [{ id: 'vendor/model-two', name: 'Model Two' }],
    }), { status: 200 });
  };
  try {
    const result = await api.openAICompatibleModels({
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKey: '   ',
      modelId: 'vendor/model-two',
    });
    assert.deepEqual(result.models, [{ id: 'vendor/model-two', name: 'Model Two' }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/providers/openai-compatible/models');
    assert.deepEqual(requests[0].body, {
      baseUrl: 'http://127.0.0.1:8317/v1',
      modelId: 'vendor/model-two',
    });
    assert.equal(requests[0].options.method, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('provider availability distinguishes explicit demo from fail-closed unavailability', () => {
  assert.equal(providerAvailabilityMode({ statusOnline: false }), 'offline');
  assert.equal(providerAvailabilityMode({
    statusOnline: true,
    providers: { liveLLM: true, demoMode: false },
  }), 'live');
  assert.equal(providerAvailabilityMode({
    statusOnline: true,
    providers: { liveLLM: false, demoMode: true },
  }), 'demo');
  assert.equal(providerAvailabilityMode({
    statusOnline: true,
    providers: { liveLLM: false, demoMode: false },
  }), 'unavailable');
});

test('Settings UI uses discovery instead of a hard-coded gateway or Luna catalog', async () => {
  const source = await readFile(new URL('../src/views/SettingsModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /api\.openAICompatibleModels\s*\(/u);
  assert.match(source, /OPENAI_COMPATIBLE_BASE_URL/u);
  assert.match(source, /OPENAI_COMPATIBLE_API_KEY/u);
  assert.match(source, /刷新模型/u);
  assert.match(source, /测试连接/u);
  assert.doesNotMatch(source, /GPT_GATEWAY_MODELS|私有 GPT 网关|Luna · medium/u);
});
