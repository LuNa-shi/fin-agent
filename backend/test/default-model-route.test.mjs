import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fin-default-model-route-'));
for (const key of [
  'DEMO_MODE',
  'DEFAULT_PROVIDER',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENAI_COMPATIBLE_REASONING_LEVEL',
  'GPT_GATEWAY_API_KEY',
  'GPT_GATEWAY_BASE_URL',
  'GPT_GATEWAY_MODEL',
  'GPT_GATEWAY_REASONING_LEVEL',
  'SMALL_PROVIDER',
  'SMALL_MODEL',
  'MAIN_PROVIDER',
  'MAIN_MODEL',
  'REFLECTION_PROVIDER',
  'REFLECTION_MODEL',
]) process.env[key] = '';
process.env.FIN_DATA_DIR = TEST_DATA_DIR;
process.env.AUTO_RESUME = 'false';
test.after(() => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

const {
  previewSettingsPatch,
  providerStatus,
  runtime,
  tierConfig,
  tierConfigFor,
} = await import('../src/config.js');
const { ModelRouter } = await import('../src/core/models/ModelRouter.js');
const { normalizeOpenAICompatibleReasoningLevel } = await import('../src/core/models/openAICompatible.js');

test('repository defaults resolve every unoverridden tier to openai-compatible/gpt-5.6-sol with high reasoning', () => {
  assert.equal(normalizeOpenAICompatibleReasoningLevel(), 'high');
  assert.equal(runtime.DEFAULT_PROVIDER, 'openai-compatible');
  assert.equal(runtime.OPENAI_COMPATIBLE_MODEL, 'gpt-5.6-sol');
  assert.equal(runtime.OPENAI_COMPATIBLE_REASONING_LEVEL, 'high');
  assert.deepEqual({
    smallProvider: runtime.SMALL_PROVIDER,
    smallModel: runtime.SMALL_MODEL,
    mainProvider: runtime.MAIN_PROVIDER,
    mainModel: runtime.MAIN_MODEL,
    reflectionProvider: runtime.REFLECTION_PROVIDER,
    reflectionModel: runtime.REFLECTION_MODEL,
  }, {
    smallProvider: '',
    smallModel: '',
    mainProvider: '',
    mainModel: '',
    reflectionProvider: '',
    reflectionModel: '',
  });

  const expectedRoute = { provider: 'openai-compatible', model: 'gpt-5.6-sol' };
  assert.deepEqual(tierConfig(), {
    small: expectedRoute,
    main: expectedRoute,
    reflection: expectedRoute,
  });

  const before = {
    OPENAI_COMPATIBLE_API_KEY: runtime.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
  };
  Object.assign(runtime, {
    OPENAI_COMPATIBLE_API_KEY: 'test-key',
    OPENAI_COMPATIBLE_BASE_URL: 'https://cli-proxy.example/v1',
  });
  try {
    const router = new ModelRouter();
    for (const tier of ['small', 'main', 'reflection']) {
      const resolved = router.resolve({
        tier,
        preferredProviders: ['deepseek'],
        reasoningLevel: 'low',
      });
      assert.equal(resolved.provider, 'openai-compatible');
      assert.equal(resolved.modelId, 'gpt-5.6-sol');
      assert.equal(resolved.reasoningLevel, 'high');
      assert.deepEqual(resolved.attemptedProviders, ['openai-compatible']);
      assert.equal(resolved.fallbackFrom, null);
    }
  } finally {
    Object.assign(runtime, before);
  }
});


test('.env.example advertises the active default route and leaves tier overrides empty', () => {
  const values = Object.fromEntries(readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  assert.deepEqual({
    provider: values.DEFAULT_PROVIDER,
    model: values.OPENAI_COMPATIBLE_MODEL,
    reasoning: values.OPENAI_COMPATIBLE_REASONING_LEVEL,
  }, {
    provider: 'openai-compatible',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
  });
  assert.deepEqual({
    smallProvider: values.SMALL_PROVIDER,
    smallModel: values.SMALL_MODEL,
    mainProvider: values.MAIN_PROVIDER,
    mainModel: values.MAIN_MODEL,
    reflectionProvider: values.REFLECTION_PROVIDER,
    reflectionModel: values.REFLECTION_MODEL,
  }, {
    smallProvider: '',
    smallModel: '',
    mainProvider: '',
    mainModel: '',
    reflectionProvider: '',
    reflectionModel: '',
  });
});

test('explicit user route and reasoning overrides remain effective', () => {
  const settings = previewSettingsPatch({
    DEFAULT_PROVIDER: 'deepseek',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
    OPENAI_COMPATIBLE_REASONING_LEVEL: 'xhigh',
    SMALL_PROVIDER: '',
    SMALL_MODEL: '',
    MAIN_PROVIDER: '',
    MAIN_MODEL: '',
    REFLECTION_PROVIDER: '',
    REFLECTION_MODEL: '',
  });

  const expectedRoute = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  assert.equal(settings.OPENAI_COMPATIBLE_REASONING_LEVEL, 'xhigh');
  assert.deepEqual(tierConfigFor(settings), {
    small: expectedRoute,
    main: expectedRoute,
    reflection: expectedRoute,
  });

  assert.deepEqual(tierConfigFor({
    ...settings,
    SMALL_PROVIDER: 'openai-compatible',
    SMALL_MODEL: 'custom-small',
    MAIN_PROVIDER: 'openai-compatible',
    MAIN_MODEL: 'custom-main',
    REFLECTION_PROVIDER: 'openai-compatible',
    REFLECTION_MODEL: 'custom-reflection',
  }), {
    small: { provider: 'openai-compatible', model: 'custom-small' },
    main: { provider: 'openai-compatible', model: 'custom-main' },
    reflection: { provider: 'openai-compatible', model: 'custom-reflection' },
  });
});

test('the unavailable default route fails closed without using configured DeepSeek or demo', () => {
  const keys = [
    'DEMO_MODE',
    'DEFAULT_PROVIDER',
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'DEEPSEEK_API_KEY',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, runtime[key]]));
  Object.assign(runtime, {
    DEMO_MODE: false,
    DEFAULT_PROVIDER: 'openai-compatible',
    OPENAI_COMPATIBLE_API_KEY: '',
    OPENAI_COMPATIBLE_BASE_URL: 'https://cli-proxy.example/v1',
    OPENAI_COMPATIBLE_MODEL: 'gpt-5.6-sol',
    DEEPSEEK_API_KEY: 'configured-but-not-selected',
  });
  try {
    const status = providerStatus();
    assert.equal(status.defaultProvider, 'openai-compatible');
    assert.equal(status.openAICompatibleModel, 'gpt-5.6-sol');
    assert.equal(status.openAICompatibleReasoningLevel, 'high');
    assert.equal(status.activeProvider, '');
    assert.equal(status.activeModel, '');
    assert.equal(status.liveLLM, false);
    assert.equal(status.demoMode, false);
    assert.throws(
      () => new ModelRouter().resolve({ tier: 'main', preferredProviders: ['deepseek'] }, { demo: false }),
      (error) => {
        assert.equal(error.code, 'PI_MODEL_UNAVAILABLE');
        assert.deepEqual(error.attemptedProviders, ['openai-compatible']);
        assert.match(error.message, /provider is unavailable: openai-compatible/u);
        return true;
      },
    );
  } finally {
    Object.assign(runtime, before);
  }
});
