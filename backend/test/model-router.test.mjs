import test from 'node:test';
import assert from 'node:assert/strict';

import { runtime as appRuntime } from '../src/config.js';
import { ModelRouter, ModelRoutingError } from '../src/core/models/ModelRouter.js';

const model = (provider, id) => ({ provider, id, api: 'fake', cost: { input: 0, output: 0 } });

function collection(entries) {
  const byKey = new Map(entries.map((item) => [`${item.provider}:${item.id}`, item]));
  return { getModel: (provider, id) => byKey.get(`${provider}:${id}`), streamSimple: () => 'stream' };
}

test('ModelRouter gives an explicit OpenAI-compatible route precedence and records one attempted provider', () => {
  const router = new ModelRouter({
    models: collection([model('deepseek', 'deepseek-v4-pro'), model('openai-compatible', 'luna')]),
    providerDefaults: { deepseek: 'deepseek-v4-pro', 'openai-compatible': 'luna' },
  });

  const resolved = router.resolve({
    preferredProviders: ['deepseek'], tier: 'review', reasoningLevel: 'high',
  }, { provider: 'openai-compatible', model: 'luna', reasoningLevel: 'high' });

  assert.equal(resolved.provider, 'openai-compatible');
  assert.equal(resolved.modelId, 'luna');
  assert.equal(resolved.model.provider, 'openai-compatible');
  assert.equal(resolved.reasoningLevel, 'high');
  assert.deepEqual(resolved.attemptedProviders, ['openai-compatible']);
  assert.equal(resolved.fallbackFrom, null);
  assert.equal(typeof resolved.streamFn, 'function');
});

test('ModelRouter permits DeepSeek only when it is explicitly selected', () => {
  const router = new ModelRouter({
    models: collection([model('deepseek', 'deepseek-v4-pro'), model('openai-compatible', 'luna')]),
    providerDefaults: { deepseek: 'deepseek-v4-pro', 'openai-compatible': 'luna' },
  });

  const resolved = router.resolve({
    preferredProviders: ['openai-compatible'], tier: 'main', reasoningLevel: 'standard',
  }, { provider: 'deepseek', model: 'deepseek-v4-pro' });

  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.modelId, 'deepseek-v4-pro');
  assert.deepEqual(resolved.attemptedProviders, ['deepseek']);
  assert.equal(resolved.fallbackFrom, null);
});

test('ModelRouter resolves only the single preferred provider and fails closed when its model is unavailable', () => {
  const router = new ModelRouter({
    models: collection([model('openai-compatible', 'luna')]),
    providerDefaults: { deepseek: 'deepseek-v4-pro', 'openai-compatible': 'luna' },
  });

  assert.throws(() => router.resolve({
    preferredProviders: ['deepseek'], tier: 'main', reasoningLevel: 'standard',
  }), (error) => {
    assert.ok(error instanceof ModelRoutingError);
    assert.deepEqual(error.attemptedProviders, ['deepseek']);
    assert.match(error.message, /deepseek\/deepseek-v4-pro/u);
    return true;
  });
});

test('ModelRouter fails closed instead of switching provider when credentials are unavailable', () => {
  const router = new ModelRouter({
    models: collection([model('deepseek', 'deepseek-v4-pro'), model('openai-compatible', 'luna')]),
    providerDefaults: { deepseek: 'deepseek-v4-pro', 'openai-compatible': 'luna' },
    providerAvailability: { deepseek: () => false, 'openai-compatible': () => true },
  });

  assert.throws(() => router.resolve({
    preferredProviders: ['deepseek'], tier: 'small', reasoningLevel: 'standard',
  }), (error) => {
    assert.ok(error instanceof ModelRoutingError);
    assert.deepEqual(error.attemptedProviders, ['deepseek']);
    assert.match(error.message, /provider is unavailable: deepseek/u);
    return true;
  });
});

test('ModelRouter requires one explicit or preferred provider', () => {
  const router = new ModelRouter({ models: collection([]) });
  assert.throws(() => router.resolve({ preferredProviders: [] }), (error) => {
    assert.ok(error instanceof ModelRoutingError);
    assert.deepEqual(error.attemptedProviders, []);
    assert.match(error.message, /no Pi model provider was selected/u);
    return true;
  });
});

test('an explicit non-demo runtime cannot drift to global deterministic demo', () => {
  const originalDemoMode = appRuntime.DEMO_MODE;
  appRuntime.DEMO_MODE = true;
  try {
    const router = new ModelRouter({
      openAICompatibleConfig: {
        baseUrl: '',
        modelId: 'luna',
        reasoningLevel: 'medium',
      },
    });
    assert.throws(
      () => router.resolve(
        { preferredProviders: ['openai-compatible'] },
        { provider: 'openai-compatible', model: 'luna', demo: false },
      ),
      (error) => (
        error instanceof ModelRoutingError
        && error.code === 'PI_MODEL_UNAVAILABLE'
      ),
    );
  } finally {
    appRuntime.DEMO_MODE = originalDemoMode;
  }
});
