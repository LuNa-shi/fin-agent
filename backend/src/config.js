// 极简 .env 加载器 + 运行期配置（不依赖 dotenv 包）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeOpenAICompatibleBaseUrl,
  normalizeOpenAICompatibleReasoningLevel,
} from './core/models/openAICompatible.js';
import { normalizeModelId } from './core/models/modelMetadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

function boundedIntegerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

// FIN_DATA_DIR：测试/评测用临时数据目录覆盖（单测不得污染真实 data/）。
// 所有持久化 root 都必须从这一处派生，避免配置或运行数据泄漏到仓库默认 data/。
export const DATA_DIR = process.env.FIN_DATA_DIR ? path.resolve(process.env.FIN_DATA_DIR) : path.join(ROOT, 'data');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const GLOBAL_DIR = path.join(DATA_DIR, 'global');
export const IDEA_GENERATION_DIR = path.join(DATA_DIR, 'idea-generation');
export const IDEAS_DIR = path.join(IDEA_GENERATION_DIR, 'ideas');
export const IDEA_RUNS_DIR = path.join(IDEA_GENERATION_DIR, 'runs');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const MEMORY_DIR = path.join(DATA_DIR, 'memory');
export const WORLDVIEW_DIR = path.join(DATA_DIR, 'worldview');
export const CANONICAL_WORLDVIEW_DIR = process.env.CANONICAL_WORLDVIEW_DIR
  ? path.resolve(process.env.CANONICAL_WORLDVIEW_DIR)
  : path.join(DATA_DIR, 'canonical-worldview');
export const CLAIM_LIBRARY_DIR = process.env.CLAIM_LIBRARY_DIR
  ? path.resolve(process.env.CLAIM_LIBRARY_DIR)
  : path.join(DATA_DIR, 'claim-library');
// Temporary compatibility export for callers migrating to the Claim Library name.
export const CLAIMS_DIR = CLAIM_LIBRARY_DIR;
export const WORLDVIEW_MAX_OVERVIEWS_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_OVERVIEWS_PER_RUN', 100, { max: 100 });
export const WORLDVIEW_MAX_OVERVIEW_BYTES_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_OVERVIEW_BYTES_PER_RUN', 96_000, { min: 1_000 });
export const WORLDVIEW_MAX_CONTEXT_TOKENS_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_CONTEXT_TOKENS_PER_RUN', 32_000, { min: 1_000, max: 400_000 });
export const WORLDVIEW_MAX_OUTPUT_TOKENS_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_OUTPUT_TOKENS_PER_RUN', 32_768, { min: 1_000, max: 400_000 });
export const WORLDVIEW_MAX_WALL_CLOCK_MS_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_WALL_CLOCK_MS_PER_RUN', 600_000, { min: 1_000, max: 3_600_000 });
export const WORLDVIEW_MAX_TOOL_CALLS_PER_RUN = boundedIntegerEnv('WORLDVIEW_MAX_TOOL_CALLS_PER_RUN', 256, { min: 4, max: 10_000 });

const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
const LEGACY_GPT_GATEWAY_PROVIDER_ID = 'gpt-gateway';
const PROVIDER_IDS = new Set(['deepseek', OPENAI_COMPATIBLE_PROVIDER_ID]);
const PROVIDER_SETTING_KEYS = new Set(['DEFAULT_PROVIDER', 'SMALL_PROVIDER', 'MAIN_PROVIDER', 'REFLECTION_PROVIDER']);

function migrateLegacyProviderId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === LEGACY_GPT_GATEWAY_PROVIDER_ID
    ? OPENAI_COMPATIBLE_PROVIDER_ID
    : value;
}

export function normalizeProviderId(value, { allowEmpty = false, fallback = '' } = {}) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!normalized && allowEmpty) return '';
  if (!PROVIDER_IDS.has(normalized)) {
    throw new TypeError(`unsupported LLM provider: ${normalized || '(empty)'}`);
  }
  return normalized;
}

// 运行期可被 Settings 页面覆盖的配置（内存态）—— 所有 key 集中在此统一管理
export const runtime = {
  DEMO_MODE,
  // —— LLM Provider ——
  // Legacy GPT_GATEWAY_* values are read once at startup into this single active authority.
  OPENAI_COMPATIBLE_API_KEY: DEMO_MODE ? '' : (
    process.env.OPENAI_COMPATIBLE_API_KEY
    || process.env.GPT_GATEWAY_API_KEY
    || ''
  ),
  OPENAI_COMPATIBLE_BASE_URL: normalizeOpenAICompatibleBaseUrl(
    process.env.OPENAI_COMPATIBLE_BASE_URL
    || process.env.GPT_GATEWAY_BASE_URL
    || '',
  ),
  OPENAI_COMPATIBLE_MODEL: process.env.OPENAI_COMPATIBLE_MODEL
    || process.env.GPT_GATEWAY_MODEL
    || 'gpt-5.6-sol',
  OPENAI_COMPATIBLE_REASONING_LEVEL: normalizeOpenAICompatibleReasoningLevel(
    process.env.OPENAI_COMPATIBLE_REASONING_LEVEL
    || process.env.GPT_GATEWAY_REASONING_LEVEL
    || 'high',
  ),
  DEEPSEEK_API_KEY: DEMO_MODE ? '' : (process.env.DEEPSEEK_API_KEY || ''),
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  // 每次调用只使用明确选定的 Provider；缺少凭证时 fail closed，不跨 Provider 回退。
  DEFAULT_PROVIDER: normalizeProviderId(migrateLegacyProviderId(process.env.DEFAULT_PROVIDER), { fallback: OPENAI_COMPATIBLE_PROVIDER_ID }),
  // —— 数据 / 工具 API ——
  FMP_API_KEY: DEMO_MODE ? '' : (process.env.FMP_API_KEY || ''),                 // 行情/基本面/财报/新闻/可比公司
  PERPLEXITY_API_KEY: DEMO_MODE ? '' : (process.env.PERPLEXITY_API_KEY || ''),   // 联网检索 / 金融问答（sonar）
  TAVILY_API_KEY: DEMO_MODE ? '' : (process.env.TAVILY_API_KEY || ''),           // 网页搜索 + 网页抓取
  X_BEARER_TOKEN: DEMO_MODE ? '' : (process.env.X_BEARER_TOKEN || ''),           // X/Twitter API（可选；缺省回退 Perplexity 社交检索）
  FRED_API_KEY: DEMO_MODE ? '' : (process.env.FRED_API_KEY || ''),               // FRED 宏观/行业高频序列（可选，免费注册）
  // —— 三层模型分层（small / main / reflection）——
  // main：主分析层（data/industry/company/report…），默认跟随 DEFAULT_PROVIDER 及其模型；
  // small：轻量层（分类/整理/翻译/初筛等），默认跟随 main；
  // reflection：反思/评审层，默认跟随 main，也可显式选择异构路由。
  // small/main/reflection 留空表示跟随生效主路由，不表示失败后切换 Provider。
  SMALL_PROVIDER: normalizeProviderId(migrateLegacyProviderId(process.env.SMALL_PROVIDER), { allowEmpty: true }),
  SMALL_MODEL: process.env.SMALL_MODEL || '',
  MAIN_PROVIDER: normalizeProviderId(migrateLegacyProviderId(process.env.MAIN_PROVIDER), { allowEmpty: true }),
  MAIN_MODEL: process.env.MAIN_MODEL || '',
  // —— 反思层：留空时跟随主分析层；显式 provider/model 仍可覆盖。——
  REFLECTION_PROVIDER: normalizeProviderId(migrateLegacyProviderId(process.env.REFLECTION_PROVIDER), { allowEmpty: true }),
  REFLECTION_MODEL: process.env.REFLECTION_MODEL || '',
  // —— 语言设置 ——
  UI_LANGUAGE: process.env.UI_LANGUAGE || 'zh',
  ANALYSIS_LANGUAGE: process.env.ANALYSIS_LANGUAGE || 'en',
  REPORT_LANGUAGE: process.env.REPORT_LANGUAGE || 'en',
};

function defaultModelForProvider(provider, settings = runtime) {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return settings.OPENAI_COMPATIBLE_MODEL;
  if (provider === 'deepseek') return settings.DEEPSEEK_MODEL;
  throw new TypeError(`unsupported LLM provider: ${provider || '(empty)'}`);
}

// 反思 Agent 的生效单一 provider/model 路由。
export function reflectionModelOpts() {
  return tierConfig().reflection;
}

// ---- 三层模型分层解析 ----
// 主层的默认 provider/model：跟随 DEFAULT_PROVIDER 及该 provider 的模型（未显式配置 MAIN_* 时）。
function mainTier(settings = runtime) {
  const provider = normalizeProviderId(settings.MAIN_PROVIDER || settings.DEFAULT_PROVIDER, { fallback: OPENAI_COMPATIBLE_PROVIDER_ID });
  const model = settings.MAIN_MODEL || defaultModelForProvider(provider, settings);
  return { provider, model };
}
// 三层配置：small/reflection 未配置则跟随 main；每层的显式 route 仍可覆盖。
export function tierConfigFor(settings = runtime) {
  const main = mainTier(settings);
  const resolveOptionalTier = (providerOverride, modelOverride) => {
    if (!providerOverride && !modelOverride) return { ...main };
    const provider = normalizeProviderId(providerOverride || main.provider);
    return { provider, model: modelOverride || defaultModelForProvider(provider, settings) };
  };
  const small = resolveOptionalTier(settings.SMALL_PROVIDER, settings.SMALL_MODEL);
  const reflection = resolveOptionalTier(settings.REFLECTION_PROVIDER, settings.REFLECTION_MODEL);
  return { small, main, reflection };
}

export function tierConfig() {
  return tierConfigFor(runtime);
}
// kind → 层。轻量类工作走 small，反思走 reflection，其余主分析走 main。
const SMALL_KINDS = new Set(['classify', 'data-organize', 'report-translate', 'screen', 'idea-screen', 'idea-rank', 'adaptor-critique']);
const REFLECTION_KINDS = new Set(['reflect', 'reflect-analysis', 'forecast-review', 'review']);
export function tierForKind(kind) {
  if (REFLECTION_KINDS.has(kind)) return 'reflection';
  if (SMALL_KINDS.has(kind)) return 'small';
  return 'main';
}
// 给定 kind 返回该层的单一 { provider, model } 路由。
export function tierOpts(kind) {
  return tierConfig()[tierForKind(kind)];
}

// 集中式 key 清单：供「API Keys 集中管理」页面统一渲染/校验
export const KEY_REGISTRY = [
  { id: 'DEEPSEEK_API_KEY', label: 'DeepSeek', group: 'LLM', hint: '直连 DeepSeek（可显式选用）', placeholder: 'sk-...', docs: 'https://platform.deepseek.com' },
  { id: 'OPENAI_COMPATIBLE_API_KEY', label: 'OpenAI-compatible API', group: 'LLM', hint: 'CLI Proxy API（Bearer key）', placeholder: 'API key', docs: '' },
  { id: 'FMP_API_KEY', label: 'Financial Modeling Prep', group: '数据/工具', hint: '行情·基本面·财报电话会·可比公司·新闻', placeholder: 'FMP key', docs: 'https://site.financialmodelingprep.com/developer/docs' },
  { id: 'PERPLEXITY_API_KEY', label: 'Perplexity', group: '数据/工具', hint: '联网检索·金融问答（sonar / sonar-pro）', placeholder: 'pplx-...', docs: 'https://docs.perplexity.ai' },
  { id: 'TAVILY_API_KEY', label: 'Tavily', group: '数据/工具', hint: '网页搜索 + 网页正文抓取', placeholder: 'tvly-...', docs: 'https://docs.tavily.com' },
  { id: 'X_BEARER_TOKEN', label: 'X / Twitter', group: '数据/工具', hint: '社交观点流（可选；缺省回退 Perplexity）。Seeking Alpha 与 Substack 无需 key。', placeholder: 'AAAA... (Bearer)', docs: 'https://developer.x.com' },
  { id: 'FRED_API_KEY', label: 'FRED（圣路易斯联储）', group: '数据/工具', hint: '行业高频/宏观序列（半导体产出/油价/利率等，免费注册，可选）。SEC/EDGAR 无需 key。', placeholder: 'fred key', docs: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
];

// ---- 设置持久化：非密钥设置（Provider/模型选择）落 data/settings.json，重启不丢；密钥仍只走 .env/内存 ----
const PERSISTED_KEYS = ['DEFAULT_PROVIDER', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPATIBLE_MODEL', 'OPENAI_COMPATIBLE_REASONING_LEVEL', 'DEEPSEEK_MODEL', 'SMALL_PROVIDER', 'SMALL_MODEL', 'MAIN_PROVIDER', 'MAIN_MODEL', 'REFLECTION_PROVIDER', 'REFLECTION_MODEL', 'UI_LANGUAGE', 'ANALYSIS_LANGUAGE', 'REPORT_LANGUAGE'];
const LEGACY_PERSISTED_KEYS = Object.freeze({
  OPENAI_COMPATIBLE_MODEL: 'GPT_GATEWAY_MODEL',
  OPENAI_COMPATIBLE_REASONING_LEVEL: 'GPT_GATEWAY_REASONING_LEVEL',
});
export function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const obj = Object.fromEntries(PERSISTED_KEYS.map((k) => [k, runtime[k]]));
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) { console.error('[settings] persist failed:', e?.message || e); }
}
(function loadPersistedSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const k of PERSISTED_KEYS) {
      const legacyKey = LEGACY_PERSISTED_KEYS[k];
      const hasCurrent = Object.prototype.hasOwnProperty.call(saved, k);
      const hasLegacy = legacyKey && Object.prototype.hasOwnProperty.call(saved, legacyKey);
      if (!hasCurrent && !hasLegacy) continue;
      const value = hasCurrent ? saved[k] : saved[legacyKey];
      runtime[k] = k === 'OPENAI_COMPATIBLE_BASE_URL'
        ? normalizeOpenAICompatibleBaseUrl(value)
        : k === 'OPENAI_COMPATIBLE_REASONING_LEVEL'
          ? normalizeOpenAICompatibleReasoningLevel(value)
          : PROVIDER_SETTING_KEYS.has(k)
            ? normalizeProviderId(migrateLegacyProviderId(value), { allowEmpty: k !== 'DEFAULT_PROVIDER' })
            : value;
    }
  } catch { /* 首次运行无文件 */ }
})();

function normalizeSettingString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function assertSecretsAbsentFromModelMetadata(settings) {
  const configuredSecrets = KEY_REGISTRY
    .map((entry) => settings[entry.id])
    .filter(Boolean);
  for (const key of ['OPENAI_COMPATIBLE_MODEL', 'DEEPSEEK_MODEL', 'SMALL_MODEL', 'MAIN_MODEL', 'REFLECTION_MODEL']) {
    if (settings[key] && configuredSecrets.some((secret) => settings[key].includes(secret))) {
      throw new TypeError(`${key} must not contain a configured API key`);
    }
  }
}

assertSecretsAbsentFromModelMetadata(runtime);

export function previewSettingsPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('settings patch must be an object');
  }
  const next = { ...runtime };
  const hasBaseUrlPatch = body.OPENAI_COMPATIBLE_BASE_URL !== undefined;
  const proposedBaseUrl = hasBaseUrlPatch
    ? normalizeOpenAICompatibleBaseUrl(body.OPENAI_COMPATIBLE_BASE_URL)
    : runtime.OPENAI_COMPATIBLE_BASE_URL;
  const replacementKey = body.OPENAI_COMPATIBLE_API_KEY === undefined
    ? ''
    : String(body.OPENAI_COMPATIBLE_API_KEY ?? '').trim();
  if (
    hasBaseUrlPatch
    && proposedBaseUrl
    && proposedBaseUrl !== runtime.OPENAI_COMPATIBLE_BASE_URL
    && runtime.OPENAI_COMPATIBLE_API_KEY
    && !replacementKey
  ) {
    throw new TypeError('a new API key is required when Base URL changes');
  }

  for (const key of KEY_REGISTRY) {
    if (body[key.id] !== undefined) next[key.id] = String(body[key.id] ?? '').trim();
  }
  if (body.OPENAI_COMPATIBLE_BASE_URL !== undefined) {
    next.OPENAI_COMPATIBLE_BASE_URL = proposedBaseUrl;
  }
  if (body.OPENAI_COMPATIBLE_MODEL !== undefined) {
    next.OPENAI_COMPATIBLE_MODEL = normalizeModelId(body.OPENAI_COMPATIBLE_MODEL, 'OPENAI_COMPATIBLE_MODEL');
  }
  if (body.OPENAI_COMPATIBLE_REASONING_LEVEL !== undefined) {
    next.OPENAI_COMPATIBLE_REASONING_LEVEL = normalizeOpenAICompatibleReasoningLevel(
      body.OPENAI_COMPATIBLE_REASONING_LEVEL,
    );
  }
  if (body.DEEPSEEK_MODEL !== undefined) {
    next.DEEPSEEK_MODEL = normalizeModelId(body.DEEPSEEK_MODEL, 'DEEPSEEK_MODEL');
  }
  if (body.DEFAULT_PROVIDER !== undefined) {
    next.DEFAULT_PROVIDER = normalizeProviderId(body.DEFAULT_PROVIDER);
  }
  for (const key of ['SMALL_PROVIDER', 'MAIN_PROVIDER', 'REFLECTION_PROVIDER']) {
    if (body[key] !== undefined) {
      next[key] = normalizeProviderId(body[key], { allowEmpty: true });
    }
  }
  for (const key of ['SMALL_MODEL', 'MAIN_MODEL', 'REFLECTION_MODEL']) {
    if (body[key] !== undefined) {
      next[key] = normalizeModelId(body[key], key, { allowEmpty: true });
    }
  }
  for (const key of ['UI_LANGUAGE', 'ANALYSIS_LANGUAGE', 'REPORT_LANGUAGE']) {
    if (body[key] !== undefined) next[key] = normalizeSettingString(body[key], key);
  }

  assertSecretsAbsentFromModelMetadata(next);
  return next;
}

export function applySettingsPatch(body = {}, { persist = true } = {}) {
  Object.assign(runtime, previewSettingsPatch(body));
  if (persist) persistSettings();
  return providerStatus();
}

export function openAICompatibleSettingsSelection(settings = runtime) {
  const routes = [
    { provider: normalizeProviderId(settings.DEFAULT_PROVIDER), model: settings.OPENAI_COMPATIBLE_MODEL },
    ...Object.values(tierConfigFor(settings)),
  ];
  const modelIds = [...new Set(routes
    .filter((route) => route.provider === OPENAI_COMPATIBLE_PROVIDER_ID)
    .map((route) => route.model))];
  return {
    required: modelIds.length > 0,
    baseUrl: settings.OPENAI_COMPATIBLE_BASE_URL,
    apiKey: settings.OPENAI_COMPATIBLE_API_KEY,
    modelIds,
  };
}

// 分析 agent 框架版本：标记在项目上，表明"这是第几版 framework 做的分析"。升级分析架构时递增。
// 0.2：情景定价→期望收益/赔率闭环、估值多锚(历史分位/comps/反向DCF)、基本面简报补三张表、
//      Ledger 账本绩效、行业上限+现金、情景推演轨迹、分析模板。
// 0.3：SEC/EDGAR 一手材料注入、财报/宏观日历、模板挂载行业高频数据(autoTools)、
//      数据覆盖度打分(<60% 封顶 confidence 0.6)、LLM schema 校验+质量门、步骤计时遥测。
// 0.4：分部化行业分析+SOTP、结论前 crux 研判(五维穷举对抗显著性偏差)、每轮独立竞争视角检索、
//      累积式数据报告(data_report.md)、跨项目结论复用、异构反思候选链、期望收益适用边界。
// 0.5：AI/半导体 capex 账本、客户/订单归属矩阵、估值隐含预期矩阵，行业/公司初步报告落盘。
// 0.6：关键缺口自动加轮、AI capex FMP现金流账本、Perplexity curl兜底、累计数据报告进最终报告。
// 0.7：撤销 0.6 的 AI capex 硬编码兜底，改为通用「关键外部驱动识别→证据计划→定向补数」闭环。
// 0.8：行业↔公司第2轮起并行（各吃上一轮对方结论），综合 review 交叉综合并给 data/industry/company 三方定向意见前馈下一轮；
//      LLM 调用级全局并发闸、FMP 磁盘缓存、三层模型分层（small/main/reflection）。
// 0.9：Agentic 统一框架（M1-M2）——所有分析角色跑在统一 AgentRuntime（function calling tool loop）上；
//      运行边界、真实 token/成本记账；
//      workspace 文件工具（ws_read_file 分页 ≈ 无上限上下文，反思/报告/结论读全量产物）；
//      data agent 自主补数+竞对建档（删 COMPETITOR_ALIASES 硬编码）；adaptor 升级 LLM 内容评审（blocking 加轮判据）；
//      E[ret] 覆盖归一、评分锚定程序化 clamp、多 crux 推演；AgentTrace 落 analysis/traces/。
// 1.0：AgentContract/AgentBackend 分层、报告主链声明式 contract、Pi 后端与三类只读报告 reviewer；
//      情景定价、论据记录、Ledger/NAV、组合风险和推荐分绩效校准保留为确定性产品能力。
export const FRAMEWORK_VERSION = '1.0';

export const PORT = Number(process.env.PORT || 8787);

export function providerStatus() {
  const openAICompatible = !!(
    runtime.OPENAI_COMPATIBLE_API_KEY
    && runtime.OPENAI_COMPATIBLE_BASE_URL
    && runtime.OPENAI_COMPATIBLE_MODEL
  );
  const deepseek = !!runtime.DEEPSEEK_API_KEY;
  // Provider 选择 fail closed：不得因为 key 缺失而静默切换到另一家模型。
  const selected = normalizeProviderId(runtime.DEFAULT_PROVIDER, { fallback: OPENAI_COMPATIBLE_PROVIDER_ID });
  const selectedAvailable = selected === OPENAI_COMPATIBLE_PROVIDER_ID ? openAICompatible : deepseek;
  const activeProvider = runtime.DEMO_MODE ? 'demo' : (selectedAvailable ? selected : '');
  const activeModel = runtime.DEMO_MODE
    ? 'deterministic-demo'
    : selectedAvailable ? defaultModelForProvider(selected) : '';
  return {
    openAICompatible,
    openAICompatibleEndpointConfigured: !!runtime.OPENAI_COMPATIBLE_BASE_URL,
    openAICompatibleKeyConfigured: !!runtime.OPENAI_COMPATIBLE_API_KEY,
    openAICompatibleBaseUrl: runtime.OPENAI_COMPATIBLE_BASE_URL,
    deepseek,
    fmp: !!runtime.FMP_API_KEY,
    perplexity: !!runtime.PERPLEXITY_API_KEY,
    tavily: !!runtime.TAVILY_API_KEY,
    liveLLM: !runtime.DEMO_MODE && selectedAvailable,
    defaultProvider: selected,
    activeProvider,
    activeModel,
    openAICompatibleModel: runtime.OPENAI_COMPATIBLE_MODEL,
    openAICompatibleReasoningLevel: runtime.OPENAI_COMPATIBLE_REASONING_LEVEL,
    deepseekModel: runtime.DEEPSEEK_MODEL,
    // 三层模型分层：解析后的生效值 + 各层是否显式覆盖（供设置页回填与展示）
    tiers: tierConfig(),
    tierOverrides: {
      small: { provider: runtime.SMALL_PROVIDER, model: runtime.SMALL_MODEL },
      main: { provider: runtime.MAIN_PROVIDER, model: runtime.MAIN_MODEL },
      reflection: { provider: runtime.REFLECTION_PROVIDER, model: runtime.REFLECTION_MODEL },
    },
    uiLanguage: runtime.UI_LANGUAGE,
    analysisLanguage: runtime.ANALYSIS_LANGUAGE,
    reportLanguage: runtime.REPORT_LANGUAGE,
    demoMode: runtime.DEMO_MODE,
  };
}

// 各 key 的连接状态（供集中管理页渲染；不回传 key 明文）
export function keyStatus() {
  return KEY_REGISTRY.map((k) => ({ ...k, connected: !!runtime[k.id] }));
}
