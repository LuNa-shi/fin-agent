import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Btn } from './Shell.jsx';
import { Icon } from '../icons.jsx';
import {
  buildProviderSettingsForm,
  buildTierModelOptions,
  DEEPSEEK_MODELS,
  discoveredModelLabel,
  normalizeDiscoveredModels,
  optionsWithCurrent,
} from '../providerModels.js';
const TIER_META = [
  { key: 'small', title: '轻量层 · small', desc: '分类 / 初筛 / 排序等轻量调用；默认跟随主分析层' },
  { key: 'main', title: '主分析层 · main', desc: '数据 / 行业 / 公司 / 报告 / 翻译等核心推理；默认跟随默认路由' },
  { key: 'reflection', title: '反思层 · reflection', desc: '反思与评审调用；默认跟随主分析层，可显式选择异构模型' },
];

const PAGES = [
  { key: 'providers', label: '模型与 Provider', icon: 'brain', desc: 'LLM 路由与模型' },
  { key: 'keys', label: 'API Keys', icon: 'settings', desc: '所有密钥集中管理' },
  { key: 'tools', label: '工具库', icon: 'tool', desc: 'Agent 可用工具 · 试运行' },
  { key: 'templates', label: '分析模板', icon: 'doc', desc: '行业/公司/数据模板' },
];

export default function SettingsModal({ onClose, status, initialTab = 'providers' }) {
  const [page, setPage] = useState(initialTab);
  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-xl h-[82vh] flex overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* 左侧页面导航 */}
        <div className="w-52 shrink-0 bg-slate-50 border-r border-line flex flex-col">
          <div className="px-4 py-4 border-b border-line">
            <div className="font-semibold text-ink text-sm">设置中心</div>
            <div className="text-[11px] text-sub mt-0.5">配置与工具管理</div>
          </div>
          <nav className="flex-1 p-2 space-y-0.5">
            {PAGES.map((pg) => {
              const I = Icon[pg.icon];
              const active = page === pg.key;
              return (
                <button key={pg.key} onClick={() => setPage(pg.key)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition flex items-start gap-2.5 ${active ? 'bg-white shadow-sm text-brand' : 'hover:bg-white/60 text-ink'}`}>
                  <span className={`mt-0.5 ${active ? 'text-brand' : 'text-slate-400'}`}><I size={16} /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-tight">{pg.label}</span>
                    <span className="block text-[10px] text-sub mt-0.5">{pg.desc}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
        {/* 右侧内容 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-6 py-4 border-b border-line flex items-center justify-between">
            <h2 className="font-semibold text-ink">{PAGES.find((p) => p.key === page)?.label}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-ink"><Icon.close size={18} /></button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {page === 'providers' && <ProvidersTab status={status} onClose={onClose} />}
            {page === 'keys' && <KeysTab status={status} />}
            {page === 'tools' && <ToolsTab />}
            {page === 'templates' && <TemplatesTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 模型与 Provider ---------------- */
function ProvidersTab({ status, onClose }) {
  const p = status?.providers || {};
  const tiers = p.tiers || {};
  const initialForm = buildProviderSettingsForm(p);
  const initialModel = initialForm.OPENAI_COMPATIBLE_MODEL;
  const [form, setForm] = useState(initialForm);
  const [models, setModels] = useState(() => normalizeDiscoveredModels(
    initialModel ? [{ id: initialModel, name: initialModel }] : [],
  ));
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogStale, setCatalogStale] = useState(false);
  const [connection, setConnection] = useState({ loading: false, type: '', message: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const discoverModels = async ({ validateSelection = false, quiet = false } = {}) => {
    if (!form.OPENAI_COMPATIBLE_BASE_URL.trim()) {
      setConnection({ loading: false, type: 'error', message: '请先填写 OpenAI-compatible Base URL。' });
      return null;
    }
    if (validateSelection && !form.OPENAI_COMPATIBLE_MODEL) {
      setConnection({ loading: false, type: 'error', message: '请先选择要测试的模型。' });
      return null;
    }
    setConnection({ loading: true, type: '', message: '' });
    try {
      const result = await api.openAICompatibleModels({
        baseUrl: form.OPENAI_COMPATIBLE_BASE_URL,
        apiKey: form.OPENAI_COMPATIBLE_API_KEY,
        modelId: validateSelection ? form.OPENAI_COMPATIBLE_MODEL : '',
      });
      const discovered = normalizeDiscoveredModels(result?.models);
      setModels(discovered);
      setCatalogLoaded(true);
      setCatalogStale(false);
      setConnection({
        loading: false,
        type: 'success',
        message: validateSelection
          ? `连接成功，模型 ${form.OPENAI_COMPATIBLE_MODEL} 可用。`
          : `已刷新 ${discovered.length} 个模型。`,
      });
      return discovered;
    } catch (error) {
      setConnection({
        loading: false,
        type: 'error',
        message: quiet ? String(error?.message || error) : `连接失败：${String(error?.message || error)}`,
      });
      return null;
    }
  };

  useEffect(() => {
    if (form.OPENAI_COMPATIBLE_BASE_URL && p.openAICompatibleKeyConfigured) {
      void discoverModels({ quiet: true });
    }
  }, []);

  const setConnectionField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setCatalogStale(true);
    setConnection({ loading: false, type: '', message: '' });
  };

  const save = async () => {
    setSaveError('');
    const usesOpenAICompatible = form.DEFAULT_PROVIDER === 'openai-compatible'
      || ['SMALL', 'MAIN', 'REFLECTION'].some((key) => (
        form[`${key}_PROVIDER`] === 'openai-compatible'
      ));
    if (usesOpenAICompatible && !form.OPENAI_COMPATIBLE_BASE_URL.trim()) {
      setSaveError('OpenAI-compatible 路由需要有效的 Base URL。');
      return;
    }
    if (usesOpenAICompatible && (!catalogLoaded || catalogStale)) {
      setSaveError('请先刷新模型列表并确认所选 model id。');
      return;
    }
    if (catalogLoaded && !catalogStale) {
      const availableIds = new Set(models.map((model) => model.id));
      const routes = [
        form.DEFAULT_PROVIDER === 'openai-compatible'
          ? { label: '默认路由', provider: 'openai-compatible', model: form.OPENAI_COMPATIBLE_MODEL }
          : null,
        ...['SMALL', 'MAIN', 'REFLECTION'].map((key) => ({
          label: `${key.toLowerCase()} 路由`,
          provider: form[`${key}_PROVIDER`],
          model: form[`${key}_MODEL`],
        })),
      ].filter(Boolean);
      const missing = routes.find((route) => (
        route.provider === 'openai-compatible'
        && route.model
        && !availableIds.has(route.model)
      ));
      if (missing) {
        setSaveError(`${missing.label}选择的模型不存在：${missing.model}。请刷新列表后重新选择。`);
        return;
      }
    }
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.OPENAI_COMPATIBLE_API_KEY.trim()) delete payload.OPENAI_COMPATIBLE_API_KEY;
      await api.saveSettings(payload);
      onClose();
    } catch (error) {
      setSaveError(String(error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  // Tier selection uses provider|model; empty main follows default and empty small follows main.
  const setTier = (key, value) => {
    const [provider, ...modelParts] = value ? value.split('|') : ['', ''];
    const model = modelParts.join('|');
    setForm((current) => ({
      ...current,
      [`${key.toUpperCase()}_PROVIDER`]: provider,
      [`${key.toUpperCase()}_MODEL`]: model,
    }));
  };
  const tierValue = (key) => {
    const provider = form[`${key.toUpperCase()}_PROVIDER`];
    const model = form[`${key.toUpperCase()}_MODEL`];
    return provider && model ? `${provider}|${model}` : '';
  };

  const availableModels = models.some((model) => model.id === form.OPENAI_COMPATIBLE_MODEL)
    || !form.OPENAI_COMPATIBLE_MODEL
    ? models
    : [{
        id: form.OPENAI_COMPATIBLE_MODEL,
        name: form.OPENAI_COMPATIBLE_MODEL,
        unavailable: catalogLoaded && !catalogStale,
      }, ...models];
  const tierOptions = buildTierModelOptions(models);
  const effectiveLabel = (key) => {
    const route = tiers[key];
    if (!route) return '—';
    const found = tierOptions.find((option) => (
      option.provider === route.provider && option.model === route.model
    ));
    return found ? found.label : `${route.provider} · ${route.model}`;
  };

  return (
    <>
      <div className="p-6 space-y-5">
        <div className="text-xs text-sub">
          当前生效：<span className="font-mono text-brand">{p.activeProvider || '不可用'} · {p.activeModel || '未连接'}</span>。
          {!p.liveLLM && !p.demoMode && <span className="ml-1 text-amber-700">当前为 fail closed，不会切换 Provider 或自动进入演示模式。</span>}
        </div>

        <div className="rounded-xl border border-line p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink">OpenAI-compatible API / CLI Proxy API</div>
              <div className="text-[11px] text-sub mt-0.5">直接连接服务端的 OpenAI-compatible `/models` 与推理接口。</div>
            </div>
            <span className={`text-[11px] px-2 py-0.5 rounded ${p.openAICompatibleKeyConfigured ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
              {p.openAICompatibleKeyConfigured ? 'Key 已配置' : 'Key 未配置'}
            </span>
          </div>
          <div>
            <label className="text-xs font-medium text-sub block mb-1">Base URL</label>
            <input value={form.OPENAI_COMPATIBLE_BASE_URL}
              onChange={(event) => setConnectionField('OPENAI_COMPATIBLE_BASE_URL', event.target.value)}
              placeholder="http://127.0.0.1:<port>/v1"
              className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand font-mono" />
          </div>
          <div>
            <label className="text-xs font-medium text-sub block mb-1">API key</label>
            <input type="password" value={form.OPENAI_COMPATIBLE_API_KEY}
              onChange={(event) => setConnectionField('OPENAI_COMPATIBLE_API_KEY', event.target.value)}
              placeholder={p.openAICompatibleKeyConfigured ? '已配置（留空保持不变）' : 'Bearer API key'}
              className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand font-mono" />
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
            <div>
              <label className="text-xs font-medium text-sub block mb-1">当前模型</label>
              <select value={form.OPENAI_COMPATIBLE_MODEL}
                onChange={(event) => setForm((current) => ({ ...current, OPENAI_COMPATIBLE_MODEL: event.target.value }))}
                disabled={!availableModels.length}
                className="w-full text-sm border border-line rounded-lg px-2 py-2 focus:outline-none focus:border-brand disabled:bg-slate-50">
                {!availableModels.length && <option value="">请先刷新模型列表</option>}
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id} disabled={model.unavailable}>
                    {discoveredModelLabel(model)}{model.unavailable ? '（当前不可用）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <Btn variant="soft" size="sm" onClick={() => discoverModels()} disabled={connection.loading}>
              {connection.loading ? '刷新中…' : '刷新模型'}
            </Btn>
            <Btn size="sm" onClick={() => discoverModels({ validateSelection: true })} disabled={connection.loading}>
              测试连接
            </Btn>
          </div>
          {catalogStale && <div className="text-[11px] text-amber-700">Base URL 或 key 已变化，当前模型列表已过期，请重新刷新。</div>}
          {connection.message && (
            <div className={`text-[11px] ${connection.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
              {connection.message}
            </div>
          )}
        </div>

        <div>
          <label className="text-sm font-medium text-ink block mb-2">默认 Provider</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['openai-compatible', 'OpenAI-compatible API'],
              ['deepseek', 'DeepSeek 直连'],
            ].map(([value, label]) => (
              <button key={value} onClick={() => setForm((current) => ({ ...current, DEFAULT_PROVIDER: value }))}
                className={`text-sm rounded-lg border px-3 py-2 transition ${form.DEFAULT_PROVIDER === value ? 'border-brand bg-brand/5 text-brand font-medium' : 'border-line text-sub hover:border-slate-300'}`}>{label}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-sub block mb-1">DeepSeek 模型</label>
            <select value={form.DEEPSEEK_MODEL} onChange={(event) => setForm((current) => ({ ...current, DEEPSEEK_MODEL: event.target.value }))}
              className="w-full text-sm border border-line rounded-lg px-2 py-2 focus:outline-none focus:border-brand">
              {DEEPSEEK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-sub block mb-1">OpenAI-compatible reasoning effort</label>
            <select value={form.OPENAI_COMPATIBLE_REASONING_LEVEL}
              onChange={(event) => setForm((current) => ({ ...current, OPENAI_COMPATIBLE_REASONING_LEVEL: event.target.value }))}
              className="w-full text-sm border border-line rounded-lg px-2 py-2 focus:outline-none focus:border-brand">
              {['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </div>
        </div>

        <div className="rounded-lg bg-slate-50 border border-line p-3 text-xs text-sub leading-relaxed">
          路由规则：只使用明确选中的 Provider；不可用时 fail closed，不会跨 Provider 重放。确定性演示仅在后端显式启用 DEMO_MODE 时生效。
        </div>

        <div>
          <label className="text-sm font-medium text-ink block mb-1">模型分层</label>
          <div className="text-[11px] text-sub mb-2">主分析层默认跟随默认路由；轻量层与反思层默认跟随主分析层；每层都可显式覆盖。</div>
          <div className="space-y-2">
            {TIER_META.map((tier) => {
              const current = {
                provider: form[`${tier.key.toUpperCase()}_PROVIDER`],
                model: form[`${tier.key.toUpperCase()}_MODEL`],
              };
              const options = optionsWithCurrent(tierOptions, current);
              return (
                <div key={tier.key} className="rounded-lg border border-line p-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink">{tier.title}</div>
                    <div className="text-[11px] text-sub mt-0.5">{tier.desc}</div>
                    {!tierValue(tier.key) && (
                      <div className="text-[11px] text-brand mt-0.5">跟随 → {effectiveLabel(tier.key)}</div>
                    )}
                  </div>
                  <select value={tierValue(tier.key)} onChange={(event) => setTier(tier.key, event.target.value)}
                    className="shrink-0 text-sm border border-line rounded-lg px-2 py-2 focus:outline-none focus:border-brand max-w-[260px]">
                    <option value="">{tier.key === 'main' ? '跟随默认路由' : '跟随主分析层'}</option>
                    {options.map((option) => (
                      <option key={`${option.provider}|${option.model}`} value={`${option.provider}|${option.model}`} disabled={option.unavailable}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-ink block mb-2">语言设置</label>
          <div className="grid grid-cols-3 gap-3">
            <LangSelect label="UI" value={form.UI_LANGUAGE} onChange={(value) => setForm((current) => ({ ...current, UI_LANGUAGE: value }))} />
            <LangSelect label="分析 harness" value={form.ANALYSIS_LANGUAGE} onChange={(value) => setForm((current) => ({ ...current, ANALYSIS_LANGUAGE: value }))} />
            <LangSelect label="默认报告" value={form.REPORT_LANGUAGE} onChange={(value) => setForm((current) => ({ ...current, REPORT_LANGUAGE: value }))} />
          </div>
          <div className="mt-2 text-[11px] text-sub">内部分析默认英文；中文公司或中文材料项目可在项目级覆盖为中文，报告可单独翻译。</div>
        </div>
        {saveError && <div className="text-xs text-red-600 rounded-lg border border-red-100 bg-red-50 px-3 py-2">{saveError}</div>}
      </div>
      <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Btn>
      </div>
    </>
  );
}
function LangSelect({ label, value, onChange }) {
  return (
    <div>
      <label className="text-xs font-medium text-sub block mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm border border-line rounded-lg px-2 py-2 focus:outline-none focus:border-brand">
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="auto">Auto</option>
      </select>
    </div>
  );
}

/* ---------------- API Keys 集中管理 ---------------- */
function KeysTab() {
  const [keys, setKeys] = useState([]);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  const load = () => api.keys().then((r) => setKeys(r.keys || []));
  useEffect(() => { load(); }, []);

  const save = async () => {
    const payload = {};
    for (const [k, v] of Object.entries(form)) { if (v && v.trim()) payload[k] = v.trim(); }
    if (!Object.keys(payload).length) return;
    setSaving(true);
    try { await api.saveSettings(payload); setForm({}); await load(); setSavedAt(Date.now()); }
    finally { setSaving(false); }
  };

  const visibleKeys = keys.filter((key) => key.id !== 'OPENAI_COMPATIBLE_API_KEY');
  const groups = [...new Set(visibleKeys.map((key) => key.group))];
  return (
    <>
      <div className="p-6 space-y-6">
        <div className="text-xs text-sub">DeepSeek 与数据工具密钥在此管理；OpenAI-compatible API key 与 Base URL 在「模型与 Provider」页配置。密钥仅保存在后端运行内存（重启后从 .env 读取）。</div>
        {groups.map((g) => (
          <div key={g}>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">{g}</div>
            <div className="space-y-4">
              {visibleKeys.filter((k) => k.group === g).map((k) => (
                <div key={k.id}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-ink">
                      {k.label} <span className="text-xs text-sub font-normal">· {k.hint}</span>
                    </label>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${k.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>{k.connected ? '已连接' : '未配置'}</span>
                  </div>
                  <input type="password" value={form[k.id] || ''} onChange={(e) => setForm({ ...form, [k.id]: e.target.value })}
                    placeholder={k.connected ? '已配置（如需更换可填入新值）' : k.placeholder}
                    className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand font-mono" />
                  {k.docs && <a href={k.docs} target="_blank" rel="noreferrer" className="text-[11px] text-brand hover:underline mt-1 inline-block">查看文档 ↗</a>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-6 py-4 border-t border-line flex justify-end items-center gap-3">
        {savedAt > 0 && <span className="text-xs text-emerald-600">已保存</span>}
        <Btn onClick={save} disabled={saving}>{saving ? '保存中…' : '保存密钥'}</Btn>
      </div>
    </>
  );
}

/* ---------------- 工具库（展示 + 试运行） ---------------- */
const PROVIDER_TAG = {
  fmp: { label: 'FMP', cls: 'bg-blue-50 text-blue-600' },
  perplexity: { label: 'Perplexity', cls: 'bg-purple-50 text-purple-600' },
  tavily: { label: 'Tavily', cls: 'bg-teal-50 text-teal-600' },
};
function ToolsTab() {
  const [tools, setTools] = useState([]);
  const [agentTools, setAgentTools] = useState(null);
  const [active, setActive] = useState(null);
  const [args, setArgs] = useState({});
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);

  const load = () => api.tools().then((r) => { setTools(r.tools || []); setAgentTools(r.agentTools || null); });
  useEffect(() => { load(); }, []);

  const open = (t) => {
    setActive(t); setResult(null);
    const init = {}; (t.params || []).forEach((p) => { init[p.name] = p.default || ''; });
    setArgs(init);
  };
  const run = async () => {
    setRunning(true); setResult(null);
    try { const r = await api.toolTest(active.name, args); setResult(r); }
    catch (e) { setResult({ error: String(e) }); }
    finally { setRunning(false); load(); }
  };
  const checkHealth = async (name) => {
    setChecking(true); setResult(null);
    try { const r = await api.checkToolHealth(name); setResult(r); }
    catch (e) { setResult({ error: String(e) }); }
    finally { setChecking(false); load(); }
  };

  const byProvider = tools.reduce((m, t) => { (m[t.provider] = m[t.provider] || []).push(t); return m; }, {});

  return (
    <div className="flex h-full">
      <div className="w-[46%] shrink-0 border-r border-line overflow-auto p-4 space-y-4">
        {agentTools && (
          <div className="text-[11px] text-sub bg-slate-50 border border-line rounded-lg px-3 py-2 leading-relaxed">
            <div className="flex items-center justify-between gap-2">
              <span><span className="font-medium text-ink">agent 工具注册表</span>：data-orchestrator <b className="text-brand">{agentTools['data-orchestrator']?.length || agentTools.data?.length || 0}</b> 个；company-orchestrator <b className="text-emerald-600">{agentTools['company-orchestrator']?.length || 0}</b> 个；forecast-agent <b className="text-violet-600">{agentTools['forecast-agent']?.length || 0}</b> 个。</span>
              <button onClick={() => checkHealth()} disabled={checking} className="shrink-0 text-[11px] text-brand hover:underline">{checking ? '检查中…' : '批量健康检查'}</button>
            </div>
          </div>
        )}
        {Object.entries(byProvider).map(([prov, list]) => {
          const tag = PROVIDER_TAG[prov] || { label: prov, cls: 'bg-slate-100 text-slate-500' };
          const connected = list[0]?.connected;
          return (
            <div key={prov}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${tag.cls}`}>{tag.label}</span>
                <span className={`text-[10px] ${connected ? 'text-emerald-600' : 'text-slate-400'}`}>{connected ? '已连接' : '未配置'}</span>
                <span className="text-[10px] text-slate-400">· {list.length} 个工具</span>
              </div>
              <div className="space-y-1">
                {list.map((t) => (
                  <button key={t.name} onClick={() => open(t)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition ${active?.name === t.name ? 'border-brand bg-brand/5' : 'border-line hover:border-slate-300'}`}>
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-mono text-ink">{t.name}</code>
                      <span className="text-[10px] text-slate-400">{t.group}</span>
                      <HealthBadge status={t.health?.status} />
                    </div>
                    <div className="text-[11px] text-sub mt-0.5 leading-snug">{t.desc}</div>
                    <div className="text-[10px] text-slate-400 mt-1 truncate">agents: {(t.agents || []).slice(0, 5).join(', ')}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        {!active ? (
          <div className="flex-1 grid place-items-center text-sub text-sm px-6 text-center">选择左侧任一工具，可在此查看参数并「试运行」验证连通性。</div>
        ) : (
          <>
            <div className="p-5 space-y-3 border-b border-line">
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono font-medium text-ink">{active.name}</code>
                <span className="text-[11px] text-sub">{active.desc}</span>
                <HealthBadge status={tools.find((t) => t.name === active.name)?.health?.status || active.health?.status} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px] text-sub">
                <div className="rounded bg-slate-50 border border-line px-2 py-1">cost: {active.costClass || 'low'}</div>
                <div className="rounded bg-slate-50 border border-line px-2 py-1">latency: {active.latencyClass || 'normal'}</div>
                <div className="rounded bg-slate-50 border border-line px-2 py-1">freshness: {active.freshness?.expectedMaxAgeHours ?? 'n/a'}h</div>
              </div>
              {(active.params || []).map((pm) => (
                <div key={pm.name}>
                  <label className="text-xs font-medium text-sub block mb-1">{pm.label || pm.name}</label>
                  <input value={args[pm.name] || ''} onChange={(e) => setArgs({ ...args, [pm.name]: e.target.value })}
                    className="w-full text-sm border border-line rounded-lg px-3 py-1.5 focus:outline-none focus:border-brand font-mono" />
                </div>
              ))}
              <div className="flex gap-2">
                <Btn size="sm" onClick={run} disabled={running || checking}><Icon.play size={13} />{running ? '调用中…' : '试运行'}</Btn>
                <Btn variant="soft" size="sm" onClick={() => checkHealth(active.name)} disabled={running || checking}><Icon.gauge size={13} />{checking ? '检查中…' : '健康检查'}</Btn>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {result ? (
                <>
                  {result.durationMs != null && <div className="text-[11px] text-slate-400 mb-2">耗时 {result.durationMs}ms · provider: {result.provider}</div>}
                  <pre className="text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 overflow-auto leading-relaxed whitespace-pre-wrap break-words max-h-[44vh]">{JSON.stringify(result.result ?? result, null, 2)}</pre>
                </>
              ) : <div className="text-sm text-sub">点击「试运行」查看真实返回。</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HealthBadge({ status }) {
  const map = {
    healthy: 'bg-emerald-50 text-emerald-600',
    degraded: 'bg-amber-50 text-amber-700',
    'rate-limited': 'bg-orange-50 text-orange-700',
    'missing-key': 'bg-slate-100 text-slate-500',
    untested: 'bg-blue-50 text-blue-600',
    unknown: 'bg-slate-100 text-slate-500',
  };
  const label = status || 'unknown';
  return <span className={`ml-auto text-[9px] px-1 py-0.5 rounded ${map[label] || map.unknown}`}>{label}</span>;
}

/* ---------------- 分析模板 ---------------- */
function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.templates().then((r) => { setTemplates(r.templates || []); });
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!activeId && templates[0]) selectTpl(templates[0]); }, [templates]);

  const selectTpl = (t) => { setActiveId(t.id); setDraft(JSON.parse(JSON.stringify(t))); };
  const newTpl = (kind) => {
    setActiveId(null);
    const base = kind === 'data'
      ? { name: '新数据模板', kind: 'data', scope: '', keywords: [], guidance: '数据获取重点：\n- 需重点获取：\n- 数据源补充：\n- 准备量：' }
      : kind === 'industry'
        ? { name: '新行业模板', kind: 'industry', scope: '', guidance: '行业分析模板：\n1. \n2. \n\n关键分歧：\n观察指标：\n证伪条件：' }
        : { name: '新公司模板', kind: 'company', scope: '', guidance: '公司分析模板：\n1. \n2. \n\n估值框架：\n关键指标：\n证伪条件：' };
    setDraft(base);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveTemplate(draft);
      setTemplates(r.templates || []);
      if (!activeId && r.templates) { const found = r.templates.find((t) => t.name === draft.name); if (found) setActiveId(found.id); }
    }
    finally { setSaving(false); }
  };
  const del = async () => { if (!activeId || !confirm('删除该模板？')) return; const r = await api.deleteTemplate(activeId); setTemplates(r.templates || []); setActiveId(null); setDraft(null); };

  const industryTpls = templates.filter((t) => t.kind === 'industry');
  const companyTpls = templates.filter((t) => t.kind === 'company');
  const dataTpls = templates.filter((t) => t.kind === 'data');
  const isData = draft?.kind === 'data';
  const isIndustry = draft?.kind === 'industry';
  const kindLabel = isData ? '数据获取模板' : isIndustry ? '行业分析模板' : '公司分析模板';

  const TplItem = (t) => (
    <button key={t.id} onClick={() => selectTpl(t)}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${activeId === t.id ? 'bg-blue-50 text-brand' : 'hover:bg-slate-50 text-ink'}`}>
      <div className="font-medium leading-tight">{t.name}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">{t.builtin ? '内置' : '自定义'}</div>
    </button>
  );

  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 border-r border-line flex flex-col">
        <div className="flex-1 overflow-auto p-2 space-y-1">
          <button onClick={() => { setActiveId('__how__'); setDraft(null); }}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${activeId === '__how__' ? 'bg-blue-50 text-brand' : 'hover:bg-slate-50 text-ink'}`}>
            <div className="font-medium leading-tight">这些如何生效？</div>
            <div className="text-[10px] text-slate-400 mt-0.5">模板指引的注入机制</div>
          </button>
          <div className="flex items-center justify-between px-2 pt-3 pb-0.5">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">行业分析模板</span>
            <button onClick={() => newTpl('industry')} className="text-slate-400 hover:text-brand"><Icon.plus size={13} /></button>
          </div>
          {industryTpls.map(TplItem)}
          <div className="flex items-center justify-between px-2 pt-3 pb-0.5">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">公司分析模板</span>
            <button onClick={() => newTpl('company')} className="text-slate-400 hover:text-brand"><Icon.plus size={13} /></button>
          </div>
          {companyTpls.map(TplItem)}
          <div className="flex items-center justify-between px-2 pt-3 pb-0.5">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">数据获取模板</span>
            <button onClick={() => newTpl('data')} className="text-slate-400 hover:text-brand"><Icon.plus size={13} /></button>
          </div>
          {dataTpls.map(TplItem)}
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        {activeId === '__how__' ? <InjectionExplainer /> :
        !draft ? <div className="flex-1 grid place-items-center text-sub text-sm">选择或新建一个模板</div> : (
          <>
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] px-2 py-0.5 rounded ${isData ? 'bg-violet-50 text-violet-600' : isIndustry ? 'bg-blue-50 text-brand' : 'bg-emerald-50 text-emerald-700'}`}>{kindLabel}</span>
                <span className="text-[11px] text-sub">「分析指引」按模板匹配结果注入对应分析环节。见左侧「这些如何生效？」</span>
              </div>
              <TField label="模板名称" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
              <TField label="适用场景" value={draft.scope} onChange={(v) => setDraft({ ...draft, scope: v })} textarea />
              {isData && (
                <TField label="命中关键词（逗号分隔；主题命中则叠加该专有数据模板。通用模板留空）" value={(draft.keywords || []).join(', ')} onChange={(v) => setDraft({ ...draft, keywords: v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
              )}
              {isData ? (
                <TField label="数据获取指引（数据源优先级 / 该行业重点数据 / 准备量）" value={draft.guidance} onChange={(v) => setDraft({ ...draft, guidance: v })} textarea rows={12} />
              ) : (
                <TField
                  label={isIndustry ? '行业分析指引（匹配到本模板时，全文注入行业分析的提示词）' : '公司分析指引（匹配到本模板时，全文注入公司分析的提示词）'}
                  value={draft.guidance || ''}
                  onChange={(v) => setDraft({ ...draft, guidance: v })}
                  textarea
                  rows={16}
                />
              )}
            </div>
            <div className="px-5 py-3 border-t border-line flex justify-between">
              {activeId && !draft.builtin ? <Btn variant="danger" size="sm" onClick={del}><Icon.trash size={13} />删除</Btn> : <span />}
              <Btn size="sm" onClick={save} disabled={saving}><Icon.check size={13} />{saving ? '保存中…' : '保存模板'}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 分析模板是投资专家可直接维护的领域指引；此处只说明确定性的模板匹配与注入。
function InjectionExplainer() {
  return (
    <div className="flex-1 overflow-auto p-5 space-y-4">
      <div>
        <div className="text-sm font-semibold text-ink">分析模板如何生效</div>
        <div className="text-xs text-sub mt-1">项目按主题自动匹配，也可以在创建项目时手动指定。</div>
      </div>
      <div className="border border-line rounded-xl p-4 bg-white">
        <div className="text-sm font-medium text-ink mb-1.5">适用场景 + 分析指引</div>
        <p className="text-xs text-slate-600 leading-relaxed">匹配后的行业、公司或数据模板会把其分析指引交给对应分析环节；保存模板不会改写任何 Agent 自有的 System Prompt 或 Tool Use。</p>
        <p className="text-[11px] text-slate-400 mt-1.5">例：半导体行业模板只在命中半导体主题、或被项目显式选择时生效。</p>
      </div>
      <p className="text-[11px] text-sub">每轮分析仍会运行只读质量评审，检查模板要求是否被覆盖并指出缺口。</p>
    </div>
  );
}

function TField({ label, value, onChange, textarea, rows }) {
  return (
    <div>
      <label className="text-xs font-medium text-sub block mb-1">{label}</label>
      {textarea
        ? <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} rows={rows || 2} className="w-full text-sm border border-line rounded-lg px-3 py-2 resize-y focus:outline-none focus:border-brand font-mono leading-relaxed" />
        : <input value={value || ''} onChange={(e) => onChange(e.target.value)} className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand" />}
    </div>
  );
}
