import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fin-openai-compatible-test-'));
process.env.FIN_DATA_DIR = TEST_DATA_DIR;
process.env.AUTO_RESUME = 'false';
test.after(() => rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

const {
  applySettingsPatch,
  normalizeProviderId,
  providerStatus,
  runtime,
} = await import('../src/config.js');
const { ModelRouter } = await import('../src/core/models/ModelRouter.js');
const { app } = await import('../src/server.js');
const {
  createOpenAICompatibleProvider,
  discoverOpenAICompatibleModels,
  observeOpenAICompatiblePromptCache,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} = await import('../src/core/models/openAICompatibleProvider.js');
const { createDeterministicDemoRoute } = await import('../src/core/models/deterministicDemo.js');

test('OpenAI-compatible provider preserves the configured model id and generic display name', async () => {
  const provider = createOpenAICompatibleProvider({
    baseUrl: 'https://cli-proxy.example/v1',
    modelId: 'luna',
    modelName: 'luna',
    reasoningLevel: 'high',
    apiKey: () => 'test-key',
  });
  const [model] = provider.getModels();

  assert.equal(provider.id, OPENAI_COMPATIBLE_PROVIDER_ID);
  assert.equal(provider.id, 'openai-compatible');
  assert.equal(provider.name, 'OpenAI-compatible API');
  assert.equal(model.id, 'luna');
  assert.equal(model.name, 'luna');
  assert.equal(model.provider, 'openai-compatible');
  assert.equal(model.baseUrl, 'https://cli-proxy.example/v1');
  assert.equal(model.compat.thinkingFormat, 'openai');
  assert.equal(model.compat.maxTokensField, 'max_completion_tokens');
  assert.equal(model.thinkingLevelMap.high, 'high');

  const auth = await provider.auth.apiKey.resolve({});
  assert.equal(auth.source, 'OPENAI_COMPATIBLE_API_KEY');
  assert.equal(auth.auth.apiKey, 'test-key');
});


test('OpenAI-compatible provider sends a stable prompt cache signal and safe telemetry', async (t) => {
  const requests = [];
  const audits = [];
  const stopObserving = observeOpenAICompatiblePromptCache((event) => audits.push(event));
  t.after(stopObserving);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        headers: req.headers,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":8}}}\n\ndata: [DONE]\n\n');
    });
  });
  await listen(server);
  t.after(() => close(server));
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    modelId: 'proxy-model',
    apiKey: () => 'test-key',
  });
  const [model] = provider.getModels();
  const sessionId = 'finagent-pc-v1-0123456789abcdef0123456789abcdef0123456789abcdef';
  const context = { systemPrompt: 'Stable system prefix', messages: [{ role: 'user', content: 'Analyze', timestamp: 1 }] };

  const first = await provider.streamSimple(model, context, { apiKey: 'test-key', sessionId }).result();
  await provider.streamSimple(model, { ...context, messages: [...context.messages, { role: 'user', content: 'Continue', timestamp: 2 }] }, { apiKey: 'test-key', sessionId }).result();
  const optOut = await provider.streamSimple(model, context, { apiKey: 'test-key', sessionId, cacheRetention: 'none' }).result();

  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.prompt_cache_key, sessionId);
  assert.equal(requests[1].body.prompt_cache_key, sessionId);
  assert.equal(requests[2].body.prompt_cache_key, undefined);
  assert.equal(requests[0].headers.session_id, undefined);
  assert.equal(requests[0].headers['x-client-request-id'], undefined);
  assert.equal(requests[0].headers['x-session-affinity'], undefined);
  assert.equal(first.usage.cacheRead, 8);
  assert.equal(first.usage.input, 4);
  assert.equal(first.usage.totalTokens, 14);
  assert.equal(optOut.usage.cacheRead, 8);
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((event) => ({
    schemaVersion: event.schemaVersion,
    keysMatch: event.keysMatch,
    modelId: event.modelId,
    requestSequence: event.requestSequence,
  })), [
    { schemaVersion: 'openai-compatible-prompt-cache-audit.v1', keysMatch: true, modelId: 'proxy-model', requestSequence: 1 },
    { schemaVersion: 'openai-compatible-prompt-cache-audit.v1', keysMatch: true, modelId: 'proxy-model', requestSequence: 2 },
  ]);
  assert.match(audits[0].sessionIdDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(audits[0].sessionIdDigest, audits[0].promptCacheKeyDigest);
});

test('deterministic demo does not receive prompt-cache identity or emit cache telemetry', async () => {
  const audits = [];
  const stopObserving = observeOpenAICompatiblePromptCache((event) => audits.push(event));
  try {
    const route = createDeterministicDemoRoute({ contractId: 'demo-test' });
    const message = await route.streamFn(route.model, { systemPrompt: 'system', messages: [] }, {
      sessionId: 'must-not-forward',
    }).result();
    assert.equal(message.provider, 'demo');
    assert.equal(message.usage.cacheRead, 0);
    assert.equal(message.usage.cacheWrite, 0);
    assert.deepEqual(audits, []);
  } finally {
    stopObserving();
  }
});

test('model discovery uses Bearer auth and preserves proxy model ids and names', async () => {
  const requests = [];
  const models = await discoverOpenAICompatibleModels({
    baseUrl: 'https://cli-proxy.example/v1/',
    apiKey: 'proxy-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new globalThis.Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'luna', name: 'luna' },
          { id: 'token/model', name: 'Secret Model' },
          { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.deepEqual(models, [
    { id: 'luna', name: 'luna' },
    { id: 'token/model', name: 'Secret Model' },
    { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://cli-proxy.example/v1/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer proxy-secret');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.timeoutMs, 10_000);
  assert.equal(requests[0].options.retries, 0);
});


test('model discovery fails clearly without leaking the API key or upstream response body', async () => {
  const apiKey = 'super-secret-proxy-key';
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'https://cli-proxy.example/v1',
      apiKey,
      fetchImpl: async () => new globalThis.Response(`invalid key ${apiKey}`, { status: 401 }),
    }),
    (error) => {
      assert.equal(error.code, 'OPENAI_COMPATIBLE_AUTH_FAILED');
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /rejected the configured API key/u);
      assert.doesNotMatch(error.message, new RegExp(apiKey, 'u'));
      assert.doesNotMatch(error.stack, new RegExp(apiKey, 'u'));
      return true;
    },
  );
});

test('model discovery reports an absent selected model without exposing credentials', async () => {
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'https://cli-proxy.example/v1',
      apiKey: 'hidden-key',
      selectedModelId: 'missing-model',
      fetchImpl: async () => new globalThis.Response(JSON.stringify({ data: [{ id: 'luna' }] }), { status: 200 }),
    }),
    (error) => {
      assert.equal(error.code, 'OPENAI_COMPATIBLE_MODEL_NOT_FOUND');
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /not found in the proxy catalog/u);
      assert.doesNotMatch(error.message, /missing-model|hidden-key/u);
      return true;
    },
  );
});


test('active provider ids use openai-compatible and reject the removed gateway name', () => {
  assert.equal(normalizeProviderId('OPENAI-COMPATIBLE'), 'openai-compatible');
  assert.equal(normalizeProviderId('deepseek'), 'deepseek');
  assert.throws(() => normalizeProviderId('gpt-gateway'), /unsupported LLM provider: gpt-gateway/u);
});

test('provider status remains fail closed when OpenAI-compatible credentials are unavailable', () => {
  const keys = [
    'DEMO_MODE',
    'DEFAULT_PROVIDER',
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'DEEPSEEK_API_KEY',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, runtime[key]]));
  try {
    Object.assign(runtime, {
      DEMO_MODE: false,
      DEFAULT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: '',
      OPENAI_COMPATIBLE_BASE_URL: 'https://cli-proxy.example/v1',
      OPENAI_COMPATIBLE_MODEL: 'luna',
      DEEPSEEK_API_KEY: 'configured-but-not-selected',
    });
    const unavailable = providerStatus();
    assert.equal(unavailable.deepseek, true);
    assert.equal(unavailable.openAICompatible, false);
    assert.equal(unavailable.liveLLM, false);
    assert.equal(unavailable.activeProvider, '');
    assert.equal(unavailable.activeModel, '');
    assert.equal(unavailable.openAICompatibleBaseUrl, 'https://cli-proxy.example/v1');
    assert.equal(Object.hasOwn(unavailable, 'apiKey'), false);

    runtime.OPENAI_COMPATIBLE_API_KEY = 'selected-provider-key';
    const available = providerStatus();
    assert.equal(available.openAICompatible, true);
    assert.equal(available.liveLLM, true);
    assert.equal(available.activeProvider, 'openai-compatible');
    assert.equal(available.activeModel, 'luna');
  } finally {
    Object.assign(runtime, before);
  }
});

test('default ModelRouter registers and resolves only the configured OpenAI-compatible model', () => {
  const router = new ModelRouter({
    openAICompatibleConfig: {
      baseUrl: 'https://cli-proxy.example/v1',
      modelId: 'vendor/custom-model',
      reasoningLevel: 'medium',
      apiKey: () => 'test-key',
    },
  });

  assert.equal(router.models.getProvider('openrouter'), undefined);
  assert.equal(router.models.getProvider('gpt-gateway'), undefined);
  assert.equal(router.models.getModels('openai-compatible').length, 1);
  assert.equal(router.models.getModel('openai-compatible', 'vendor/custom-model').id, 'vendor/custom-model');

  const resolved = router.resolve(
    { preferredProviders: ['deepseek'], reasoningLevel: 'standard' },
    { provider: 'openai-compatible', model: 'vendor/custom-model' },
  );
  assert.equal(resolved.provider, 'openai-compatible');
  assert.equal(resolved.modelId, 'vendor/custom-model');
  assert.equal(resolved.reasoningLevel, 'medium');
  assert.deepEqual(resolved.attemptedProviders, ['openai-compatible']);
  assert.equal(resolved.fallbackFrom, null);
});


test('legacy GPT_GATEWAY environment values migrate once into the new runtime authority', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'finagent-openai-compatible-env-'));
  try {
    const env = { ...process.env };
    for (const key of [
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPATIBLE_BASE_URL',
      'OPENAI_COMPATIBLE_MODEL',
      'OPENAI_COMPATIBLE_REASONING_LEVEL',
    ]) delete env[key];
    Object.assign(env, {
      FIN_DATA_DIR: dataDir,
      GPT_GATEWAY_API_KEY: 'legacy-key',
      GPT_GATEWAY_BASE_URL: 'https://legacy-proxy.example/v1/',
      GPT_GATEWAY_MODEL: 'legacy-luna',
      GPT_GATEWAY_REASONING_LEVEL: 'high',
      DEFAULT_PROVIDER: 'gpt-gateway',
      REFLECTION_PROVIDER: 'gpt-gateway',
    });
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { runtime } from './src/config.js'; console.log(JSON.stringify({
        apiKey: runtime.OPENAI_COMPATIBLE_API_KEY,
        baseUrl: runtime.OPENAI_COMPATIBLE_BASE_URL,
        model: runtime.OPENAI_COMPATIBLE_MODEL,
        reasoning: runtime.OPENAI_COMPATIBLE_REASONING_LEVEL,
        defaultProvider: runtime.DEFAULT_PROVIDER,
        reflectionProvider: runtime.REFLECTION_PROVIDER,
        hasLegacyRuntimeKey: Object.hasOwn(runtime, 'GPT_GATEWAY_API_KEY'),
      }));`,
    ], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      apiKey: 'legacy-key',
      baseUrl: 'https://legacy-proxy.example/v1',
      model: 'legacy-luna',
      reasoning: 'high',
      defaultProvider: 'openai-compatible',
      reflectionProvider: 'openai-compatible',
      hasLegacyRuntimeKey: false,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});


test('settings patches validate atomically before updating runtime', () => {
  const before = {
    DEFAULT_PROVIDER: runtime.DEFAULT_PROVIDER,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_MODEL: runtime.OPENAI_COMPATIBLE_MODEL,
  };
  assert.throws(() => applySettingsPatch({
    DEFAULT_PROVIDER: 'deepseek',
    OPENAI_COMPATIBLE_BASE_URL: 'not a URL',
    OPENAI_COMPATIBLE_MODEL: 'new-model',
  }, { persist: false }), /valid URL/u);
  assert.deepEqual({
    DEFAULT_PROVIDER: runtime.DEFAULT_PROVIDER,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_MODEL: runtime.OPENAI_COMPATIBLE_MODEL,
  }, before);
  assert.throws(() => applySettingsPatch({
    OPENAI_COMPATIBLE_API_KEY: 'opaque-credential-value',
    OPENAI_COMPATIBLE_MODEL: 'model-opaque-credential-value-suffix',
  }, { persist: false }), /must not contain a configured API key/u);
  assert.deepEqual({
    DEFAULT_PROVIDER: runtime.DEFAULT_PROVIDER,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_MODEL: runtime.OPENAI_COMPATIBLE_MODEL,
  }, before);
});

test('settings persistence includes the Base URL and model but never the API key', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'finagent-openai-compatible-settings-'));
  try {
    const env = { ...process.env, FIN_DATA_DIR: dataDir };
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';
       import { applySettingsPatch, SETTINGS_FILE } from './src/config.js';
       applySettingsPatch({
         OPENAI_COMPATIBLE_BASE_URL: 'https://cli-proxy.example/v1/',
         OPENAI_COMPATIBLE_API_KEY: 'must-not-persist',
         OPENAI_COMPATIBLE_MODEL: 'luna',
         DEFAULT_PROVIDER: 'openai-compatible',
       });
       console.log(fs.readFileSync(SETTINGS_FILE, 'utf8'));`,
    ], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(child.stdout);
    assert.equal(saved.OPENAI_COMPATIBLE_BASE_URL, 'https://cli-proxy.example/v1');
    assert.equal(saved.OPENAI_COMPATIBLE_MODEL, 'luna');
    assert.equal(saved.DEFAULT_PROVIDER, 'openai-compatible');
    assert.equal(Object.hasOwn(saved, 'OPENAI_COMPATIBLE_API_KEY'), false);
    assert.doesNotMatch(child.stdout, /must-not-persist/u);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});


async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('model discovery API returns the proxy catalog and can reuse the configured server-side key', async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'luna', name: 'luna' },
      { id: 'vendor/model-two', name: 'Model Two' },
    ] }));
  });
  const upstreamPort = await listen(upstream);
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const before = {
    OPENAI_COMPATIBLE_API_KEY: runtime.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
  };
  runtime.OPENAI_COMPATIBLE_API_KEY = 'configured-server-key';
  runtime.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
  try {
    const forbidden = await fetch(`http://127.0.0.1:${apiPort}/api/providers/openai-compatible/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://cross-origin.invalid' },
      body: JSON.stringify({ baseUrl: runtime.OPENAI_COMPATIBLE_BASE_URL }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(requests.length, 0);

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/providers/openai-compatible/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: runtime.OPENAI_COMPATIBLE_BASE_URL }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      provider: 'openai-compatible',
      models: [
        { id: 'luna', name: 'luna' },
        { id: 'vendor/model-two', name: 'Model Two' },
      ],
    });
    assert.deepEqual(requests, [{
      url: '/v1/models',
      authorization: 'Bearer configured-server-key',
    }]);
  } finally {
    Object.assign(runtime, before);
    await Promise.all([close(apiServer), close(upstream)]);
  }
});


test('ModelRouter can route distinct configured models through one OpenAI-compatible provider', () => {
  const router = new ModelRouter({
    openAICompatibleConfig: {
      baseUrl: 'https://cli-proxy.example/v1',
      modelId: 'model-main',
      modelCatalog: [
        { id: 'model-main', name: 'Main Model' },
        { id: 'model-small', name: 'Small Model' },
        { id: 'vendor/model-review', name: 'Review Model' },
      ],
      apiKey: () => 'test-key',
    },
  });

  for (const modelId of ['model-main', 'model-small', 'vendor/model-review']) {
    const resolved = router.resolve(
      { preferredProviders: ['openai-compatible'] },
      { provider: 'openai-compatible', model: modelId },
    );
    assert.equal(resolved.provider, 'openai-compatible');
    assert.equal(resolved.modelId, modelId);
    assert.equal(resolved.model.id, modelId);
  }
});


test('changing the Base URL cannot reuse an existing key for a new origin', () => {
  const before = {
    OPENAI_COMPATIBLE_API_KEY: runtime.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
  };
  Object.assign(runtime, {
    OPENAI_COMPATIBLE_API_KEY: 'existing-secret',
    OPENAI_COMPATIBLE_BASE_URL: 'https://old-proxy.example/v1',
  });
  try {
    assert.throws(() => applySettingsPatch({
      OPENAI_COMPATIBLE_BASE_URL: 'https://new-proxy.example/v1',
    }, { persist: false }), /new API key is required when Base URL changes/u);
    assert.equal(runtime.OPENAI_COMPATIBLE_BASE_URL, 'https://old-proxy.example/v1');
    assert.equal(runtime.OPENAI_COMPATIBLE_API_KEY, 'existing-secret');
  } finally {
    Object.assign(runtime, before);
  }
});


test('model discovery API requires a replacement key before sending credentials to a changed Base URL', async () => {
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const before = {
    OPENAI_COMPATIBLE_API_KEY: runtime.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: runtime.OPENAI_COMPATIBLE_BASE_URL,
  };
  Object.assign(runtime, {
    OPENAI_COMPATIBLE_API_KEY: 'existing-secret',
    OPENAI_COMPATIBLE_BASE_URL: 'https://old-proxy.example/v1',
  });
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/providers/openai-compatible/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://new-proxy.example/v1' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'OPENAI_COMPATIBLE_API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
    assert.doesNotMatch(JSON.stringify({ body, logs }), /existing-secret/u);
  } finally {
    console.error = originalConsoleError;
    Object.assign(runtime, before);
    await close(apiServer);
  }
});


test('discovery API auth failures redact submitted keys and upstream bodies from HTTP and console output', async () => {
  const apiKey = 'submitted-super-secret';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end(`upstream echoed ${apiKey}`);
  });
  const upstreamPort = await listen(upstream);
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/providers/openai-compatible/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey,
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
    const publicText = JSON.stringify({ body, logs });
    assert.doesNotMatch(publicText, new RegExp(apiKey, 'u'));
    assert.doesNotMatch(publicText, /upstream echoed/u);
  } finally {
    console.error = originalConsoleError;
    await Promise.all([close(apiServer), close(upstream)]);
  }
});


test('invalid Base URLs fail with an explicit discovery error', async () => {
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'not a URL',
      apiKey: 'hidden-key',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    (error) => {
      assert.equal(error.code, 'OPENAI_COMPATIBLE_BASE_URL_INVALID');
      assert.equal(error.statusCode, 400);
      assert.doesNotMatch(error.message, /hidden-key/u);
      return true;
    },
  );
});

test('settings HTTP API persists only non-secrets and rolls back invalid patches', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'finagent-openai-compatible-api-'));
  const apiKey = 'api-http-secret';
  try {
    const env = { ...process.env, FIN_DATA_DIR: dataDir, AUTO_RESUME: 'false' };
    for (const key of [
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPATIBLE_BASE_URL',
      'OPENAI_COMPATIBLE_MODEL',
      'GPT_GATEWAY_API_KEY',
      'GPT_GATEWAY_BASE_URL',
      'GPT_GATEWAY_MODEL',
    ]) delete env[key];
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';
       import http from 'node:http';
       import { once } from 'node:events';
       import { app } from './src/server.js';
       import { SETTINGS_FILE } from './src/config.js';
       const upstream = http.createServer((req, res) => {
         res.writeHead(200, { 'content-type': 'application/json' });
         res.end(JSON.stringify({ data: [{ id: 'vendor/model-two', name: 'Model Two' }] }));
       });
       upstream.listen(0, '127.0.0.1');
       await once(upstream, 'listening');
       const proxyBaseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
       const server = app.listen(0, '127.0.0.1');
       await once(server, 'listening');
       const base = 'http://127.0.0.1:' + server.address().port;
       const validResponse = await fetch(base + '/api/settings', {
         method: 'POST', headers: { 'content-type': 'application/json' },
         body: JSON.stringify({
           OPENAI_COMPATIBLE_BASE_URL: proxyBaseUrl,
           OPENAI_COMPATIBLE_API_KEY: '${apiKey}',
           OPENAI_COMPATIBLE_MODEL: 'vendor/model-two',
           DEFAULT_PROVIDER: 'openai-compatible',
           REFLECTION_PROVIDER: 'openai-compatible',
           REFLECTION_MODEL: 'vendor/model-two'
         })
       });
       const validBody = await validResponse.json();
       const statusBody = await (await fetch(base + '/api/status')).json();
       const keysBody = await (await fetch(base + '/api/keys')).json();
       const savedBefore = fs.readFileSync(SETTINGS_FILE, 'utf8');
       const invalidResponse = await fetch(base + '/api/settings', {
         method: 'POST', headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ OPENAI_COMPATIBLE_MODEL: 'missing/model', REFLECTION_MODEL: 'missing/model' })
       });
       const invalidBody = await invalidResponse.json();
       const savedAfter = fs.readFileSync(SETTINGS_FILE, 'utf8');
       server.close();
       upstream.close();
       await Promise.all([once(server, 'close'), once(upstream, 'close')]);
       console.log(JSON.stringify({
         validStatus: validResponse.status,
         validBody,
         statusBody,
         keysBody,
         saved: JSON.parse(savedBefore),
         invalidStatus: invalidResponse.status,
         invalidBody,
         fileUnchanged: savedBefore === savedAfter
       }));`,
    ], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.validStatus, 200);
    assert.equal(result.validBody.providers.openAICompatibleKeyConfigured, true);
    assert.equal(result.statusBody.providers.openAICompatibleModel, 'vendor/model-two');
    assert.equal(result.keysBody.keys.find((key) => key.id === 'OPENAI_COMPATIBLE_API_KEY').connected, true);
    assert.match(result.saved.OPENAI_COMPATIBLE_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    assert.equal(result.saved.OPENAI_COMPATIBLE_MODEL, 'vendor/model-two');
    assert.equal(Object.hasOwn(result.saved, 'OPENAI_COMPATIBLE_API_KEY'), false);
    assert.equal(result.invalidStatus, 400);
    assert.equal(result.invalidBody.code, 'OPENAI_COMPATIBLE_MODEL_NOT_FOUND');
    assert.equal(result.fileUnchanged, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey, 'u'));
    assert.doesNotMatch(child.stderr, new RegExp(apiKey, 'u'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});


test('model discovery rejects an upstream catalog that echoes the credential', async () => {
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'https://cli-proxy.example/v1',
      apiKey: 'opaque-credential-value',
      fetchImpl: async () => new globalThis.Response(JSON.stringify({
        data: [{ id: 'safe-model', name: 'Echoed opaque-credential-value metadata' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => (
      error.code === 'OPENAI_COMPATIBLE_MODELS_INVALID'
      && !error.message.includes('opaque-credential-value')
    ),
  );
});

test('network and malformed model discovery failures remain explicit and sanitized', async () => {
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'https://cli-proxy.example/v1',
      apiKey: 'network-secret',
      fetchImpl: async () => { throw new Error('socket failed with network-secret'); },
    }),
    (error) => (
      error.code === 'OPENAI_COMPATIBLE_MODELS_UNAVAILABLE'
      && !error.message.includes('network-secret')
    ),
  );
  await assert.rejects(
    discoverOpenAICompatibleModels({
      baseUrl: 'https://cli-proxy.example/v1',
      apiKey: 'json-secret',
      fetchImpl: async () => new globalThis.Response('not-json json-secret', { status: 200 }),
    }),
    (error) => (
      error.code === 'OPENAI_COMPATIBLE_MODELS_INVALID'
      && !error.message.includes('json-secret')
    ),
  );
});
