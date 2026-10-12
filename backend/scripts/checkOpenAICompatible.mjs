import { runtime } from '../src/config.js';
import { ModelRouter } from '../src/core/models/ModelRouter.js';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../src/core/models/openAICompatibleProvider.js';

if (!process.argv.includes('--live')) {
  throw new Error('OpenAI-compatible inference check requires the explicit --live mode');
}

const MARKER = 'OPENAI_COMPATIBLE_OK';
const prompt = `Reply with exactly ${MARKER}`;
const tokenUsage = (usage = {}) => {
  const number = (...values) => {
    const value = values.find((candidate) => Number.isFinite(Number(candidate)));
    return value === undefined ? 0 : Math.max(0, Number(value));
  };
  const input = number(usage.input, usage.inputTokens, usage.prompt_tokens);
  const output = number(usage.output, usage.outputTokens, usage.completion_tokens);
  const reasoning = number(usage.reasoning, usage.reasoningTokens);
  const cacheRead = number(usage.cacheRead, usage.cacheReadTokens);
  const cacheWrite = number(usage.cacheWrite, usage.cacheWriteTokens);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: number(usage.totalTokens, usage.total_tokens, input + output + reasoning + cacheRead + cacheWrite),
  };
};
const summary = ({ startedAt, provider, model, text, usage }) => ({
  path: 'pi',
  status: text.includes(MARKER) ? 'ok' : 'marker-missing',
  provider,
  model,
  reasoningLevel: runtime.OPENAI_COMPATIBLE_REASONING_LEVEL,
  latencyMs: Date.now() - startedAt,
  marker: text.includes(MARKER),
  tokenUsage: tokenUsage(usage),
  costKnown: false,
  costUsd: null,
});

if (!runtime.OPENAI_COMPATIBLE_API_KEY || !runtime.OPENAI_COMPATIBLE_BASE_URL || !runtime.OPENAI_COMPATIBLE_MODEL) {
  throw new Error('OpenAI-compatible check requires OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL, and OPENAI_COMPATIBLE_MODEL');
}

const router = new ModelRouter();
const resolved = router.resolve({
  preferredProviders: [OPENAI_COMPATIBLE_PROVIDER_ID],
  reasoningLevel: 'medium',
}, {
  provider: OPENAI_COMPATIBLE_PROVIDER_ID,
  model: runtime.OPENAI_COMPATIBLE_MODEL,
  reasoningLevel: runtime.OPENAI_COMPATIBLE_REASONING_LEVEL,
});
const piStartedAt = Date.now();
const pi = await router.models.completeSimple(resolved.model, {
  systemPrompt: 'Follow the user instruction exactly.',
  messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
}, {
  reasoning: resolved.reasoningLevel,
  maxTokens: 32,
  temperature: 0,
  timeoutMs: 45_000,
  maxRetries: 0,
});
const piText = pi.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
const piSummary = summary({
  startedAt: piStartedAt,
  provider: resolved.provider,
  model: pi.model || resolved.modelId,
  text: piText,
  usage: pi.usage,
});
console.log(JSON.stringify(piSummary));
if (pi.stopReason === 'error' || !piSummary.marker) process.exitCode = 1;
