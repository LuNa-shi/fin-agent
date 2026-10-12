import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Btn } from './Shell.jsx';
import { Badge, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import AgentExecutionInspector from './AgentExecutionInspector.jsx';

// Idea 生成工作流阶段定义
const STAGE = {
  context: { label: '收集决策上下文', icon: 'layers', color: 'text-blue-600', bg: 'bg-blue-50' },
  memory: { label: '注入去重约束', icon: 'brain', color: 'text-violet-600', bg: 'bg-violet-50' },
  source: { label: '多来源发现', icon: 'globe', color: 'text-cyan-700', bg: 'bg-cyan-50' },
  reason: { label: '过量发散生成', icon: 'spark', color: 'text-amber-600', bg: 'bg-amber-50' },
  screen: { label: '标的校验与质量评分', icon: 'check', color: 'text-indigo-600', bg: 'bg-indigo-50' },
  output: { label: '产出并入库', icon: 'idea', color: 'text-emerald-600', bg: 'bg-emerald-50' },
};

const IDEA_NODE_LABELS = {
  'collect-market-context': '收集市场与决策上下文',
  'build-diversification-constraints': '建立分散化与去重约束',
  'generate-candidates': '生成候选 Idea',
  'verify-candidates': '校验标的并规范化',
  'review-quality': '质量评分、排序与注释',
  'persist-ideas': '持久化全部有效 Idea',
};

function traceBadge(trace) {
  if (trace?.status === 'FAILED') return { color: 'red', label: '失败' };
  if (trace?.status === 'BLOCKED') return { color: 'amber', label: '阻塞' };
  if (trace?.status === 'CANCELLED') return { color: 'slate', label: '已取消' };
  if (trace?.provider === 'demo') return { color: 'slate', label: '演示' };
  if (trace?.live === true) return { color: 'green', label: '真实' };
  return { color: 'slate', label: '非实时' };
}

function TraceBadge({ trace }) {
  const badge = traceBadge(trace);
  return <Badge color={badge.color}>{badge.label}</Badge>;
}

export default function IdeaView({ onAdded, goProjects, onOpenProject, lang = 'zh' }) {
  // 双语 idea：后端主链路是英文（title/rationale/catalyst/edge 为规范字段），
  // zh 展示字段（titleZh 等）仅供 UI 中文模式显示，缺省回退英文。
  const zh = lang === 'zh';
  const disp = (idea, key) => (zh && idea[`${key}Zh`]) || idea[key];
  const [tab, setTab] = useState('library'); // library | history
  const [ideas, setIdeas] = useState([]);
  const [traces, setTraces] = useState([]);
  const [workflowSpec, setWorkflowSpec] = useState(null);
  const [workflowSpecError, setWorkflowSpecError] = useState('');
  const [activeTrace, setActiveTrace] = useState(null);
  const [loading, setLoading] = useState(false);
  const [earningsOpen, setEarningsOpen] = useState(false);
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [earningsRows, setEarningsRows] = useState([]);
  const [selectedEarnings, setSelectedEarnings] = useState(new Set());
  const [earningsMarket, setEarningsMarket] = useState('global');
  const [addingId, setAddingId] = useState(null);
  const [createdProjects, setCreatedProjects] = useState({});
  const [progress, setProgress] = useState(null); // 实时工作流进度
  const [liveTrace, setLiveTrace] = useState(null);
  const liveTraceRefresh = useRef({ runId: '', agentExecutionCount: -1, fetchedAt: 0 });

  const loadIdeas = () => api.ideas().then((r) => setIdeas(r.ideas || []));
  const loadTraces = () => api.ideaTraces(40).then((r) => {
    setTraces(r.traces || []);
    setActiveTrace((cur) => cur || r.traces?.[0]?.id || null);
  });
  const loadWorkflowSpec = () => api.ideaWorkflowSpec()
    .then((result) => {
      setWorkflowSpec(result);
      setWorkflowSpecError('');
    })
    .catch((error) => {
      setWorkflowSpec(null);
      setWorkflowSpecError(error?.message || String(error));
    });
  useEffect(() => { loadIdeas(); loadTraces(); loadWorkflowSpec(); }, []);

  useEffect(() => {
    let stop = false;
    api.ideaProgress().then(async (r) => {
      if (stop || !r.progress) return;
      setProgress(r.progress);
      if (r.progress.running) {
        setLoading(true);
        setTab('history');
        try {
          const result = await api.ideaTrace(r.progress.runId);
          if (!stop) {
            setLiveTrace(result.trace || null);
            liveTraceRefresh.current = {
              runId: r.progress.runId,
              agentExecutionCount: r.progress.agentExecutionCount || 0,
              fetchedAt: Date.now(),
            };
          }
        } catch {}
      }
    }).catch(() => {});
    return () => { stop = true; };
  }, []);

  // 生成期间轮询实时进度，让工作流逐步点亮
  useEffect(() => {
    if (!loading && !progress?.running) return;
    let stopped = false;
    let timer;
    let latestRequest = 0;
    const poll = async () => {
      const request = ++latestRequest;
      let keepPolling = true;
      try {
        const r = await api.ideaProgress();
        if (stopped || request !== latestRequest) return;
        if (r.progress && !r.progress.running) {
          const [ideasResult, tracesResult] = await Promise.all([
            api.ideas(),
            api.ideaTraces(40),
          ]);
          if (stopped || request !== latestRequest) return;
          keepPolling = false;
          setProgress(r.progress);
          setLoading(false);
          setIdeas(ideasResult.ideas || []);
          setTraces(tracesResult.traces || []);
          setActiveTrace(r.progress.runId || tracesResult.traces?.[0]?.id || null);
          setLiveTrace(null);
        } else if (r.progress) {
          setProgress(r.progress);
          const last = liveTraceRefresh.current;
          const now = Date.now();
          const agentExecutionCount = r.progress.agentExecutionCount || 0;
          const shouldRefreshTrace = last.runId !== r.progress.runId
            || last.agentExecutionCount !== agentExecutionCount
            || now - last.fetchedAt >= 3000;
          if (shouldRefreshTrace && r.progress.runId) {
            liveTraceRefresh.current = {
              runId: r.progress.runId,
              agentExecutionCount,
              fetchedAt: now,
            };
            try {
              const result = await api.ideaTrace(r.progress.runId);
              if (stopped || request !== latestRequest) return;
              setLiveTrace(result.trace || null);
            } catch {}
          }
        }
      } catch {}
      if (!stopped && request === latestRequest && keepPolling) {
        timer = setTimeout(poll, 700);
      }
    };
    void poll();
    return () => {
      stopped = true;
      latestRequest += 1;
      clearTimeout(timer);
    };
  }, [loading, progress?.running]);

  const generate = async () => {
    setLoading(true);
    setProgress(null);
    setLiveTrace(null);
    liveTraceRefresh.current = { runId: '', agentExecutionCount: -1, fetchedAt: 0 };
    setTab('history'); // 切到工作逻辑页，实时观看生成过程
    try {
      const r = await api.genIdeas(20);
      await Promise.all([loadIdeas(), loadTraces()]);
      onAdded?.();
      if (r.traceId) { setActiveTrace(r.traceId); } // 新批次高亮
    } finally {
      setLoading(false);
      // 稍后清掉实时面板，露出已落库的完整轨迹
      setTimeout(() => setProgress((p) => p?.running ? p : null), 1200);
    }
  };
  const openEarnings = async (marketOverride = earningsMarket, forceRefresh = false) => {
    setEarningsOpen(true);
    setEarningsLoading(true);
    try {
      const r = await api.earningsIdeasPreview(7, marketOverride, forceRefresh);
      const rows = r.candidates || [];
      setEarningsRows(rows);
      setSelectedEarnings(new Set(rows.map((x) => x.symbol)));
    } finally { setEarningsLoading(false); }
  };
  const addSelectedEarnings = async () => {
    const picked = earningsRows.filter((r) => selectedEarnings.has(r.symbol));
    if (!picked.length) return;
    setEarningsLoading(true);
    try {
      await api.addEarningsIdeas(picked);
      await loadIdeas();
      onAdded?.();
      setEarningsOpen(false);
      setTab('library');
    } finally { setEarningsLoading(false); }
  };

  const addToLibrary = async (idea) => {
    setAddingId(idea.id);
    try {
      const project = await api.createProject({ title: idea.title, theme: idea.theme, rationale: idea.rationale, tickers: idea.tickers, ideaId: idea.id });
      if (project?.id) {
        setCreatedProjects((current) => ({
          ...current,
          [idea.id]: { id: project.id, status: project.status || 'created' },
        }));
      }
      await loadIdeas(); onAdded?.();
    } catch (e) {
      // 创建失败必须显式可见（曾疑似有项目静默创建失败、无任何痕迹）
      window.alert(`创建项目失败：${e?.message || e}`);
    } finally { setAddingId(null); }
  };
  const delIdea = async (idea) => {
    if (!window.confirm(`删除思路「${idea.title}」？`)) return;
    const r = await api.deleteIdea(idea.id); setIdeas(r.ideas || []);
  };

  const trace = traces.find((t) => t.id === activeTrace);

  return (
    <>
      <PageHeader title="① Idea Generation 系统" subtitle="基于历史决策与市场热点自动生成投资思路 · 工作逻辑与历史可追溯">
        <div className="flex items-center gap-2">
          <Btn variant="soft" onClick={() => openEarnings()} disabled={earningsLoading || loading}>
            <Icon.calendar size={14} />未来财报日历
          </Btn>
          <Btn onClick={generate} disabled={loading}>
            {loading ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />生成中</> : <><Icon.spark size={14} />生成新思路</>}
          </Btn>
        </div>
      </PageHeader>

      {/* tabs */}
      <div className="px-7 pt-3 bg-white border-b border-line flex gap-1">
        {[['library', '投资思路库', 'idea'], ['history', '生成历史 & 工作逻辑', 'agent']].map(([k, l, ic]) => {
          const I = Icon[ic];
          return (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition inline-flex items-center gap-1.5 ${tab === k ? 'border-brand text-brand' : 'border-transparent text-sub hover:text-ink'}`}>
              <I size={14} />{l}{k === 'history' && traces.length > 0 && <span className="text-[10px] text-slate-400">({traces.length})</span>}
            </button>
          );
        })}
      </div>

      {tab === 'library' ? (
        <div className="flex-1 overflow-auto p-7">
          {loading && !ideas.length && <div className="py-20 grid place-items-center"><Spinner label="Agent 正在结合市场热点生成投资思路…" /></div>}
          {!ideas.length && !loading && (
            <div className="py-20 text-center text-sub">
              <Icon.idea size={32} className="mx-auto text-slate-300 mb-3" />
              <p>暂无投资思路，点击右上角「生成新思路」开始。</p>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl">
            {ideas.map((idea) => (
              <div key={idea.id} className="bg-white rounded-xl border border-line p-5 hover:shadow-sm transition group">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge color="blue">{idea.theme}</Badge>
                    <HeatBar value={idea.heat} />
                    {idea.status === 'added' && <Badge color="green">已入库</Badge>}
                  </div>
                  <button onClick={() => delIdea(idea)} title="删除思路"
                    className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition shrink-0"><Icon.trash size={14} /></button>
                </div>
                <h3 className="font-semibold text-ink leading-snug mb-2">{disp(idea, 'title') || idea.sentence}</h3>
                {(idea.sourceAgents || []).length > 0 && (
                  <div className="flex gap-1 flex-wrap mb-2">
                    {(idea.sourceAgents || []).slice(0, 4).map((a) => <span key={a} className="text-[10px] px-1.5 py-0.5 bg-cyan-50 text-cyan-700 rounded">{a}</span>)}
                  </div>
                )}
                <IdeaQualityAnnotation idea={idea} />
                <IdeaLineage idea={idea} />
                <p className="text-sm text-sub leading-relaxed mb-3">{disp(idea, 'rationale')}</p>
                {(idea.catalyst || idea.edge) && (
                  <div className="space-y-1 mb-3">
                    {idea.catalyst && <div className="text-xs text-slate-500"><span className="text-amber-600 font-medium">催化剂 · </span>{disp(idea, 'catalyst')}</div>}
                    {idea.edge && <div className="text-xs text-slate-500"><span className="text-brand font-medium">预期差 · </span>{disp(idea, 'edge')}</div>}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex gap-1.5 flex-wrap">
                    {(idea.tickers || []).map((t) => (
                      <span key={t} className="font-mono text-xs px-1.5 py-0.5 bg-slate-100 rounded text-slate-600">{t}</span>
                    ))}
                  </div>
                  {idea.status === 'added' ? (
                    <Btn
                      variant="soft"
                      size="sm"
                      onClick={() => {
                        const projectId = createdProjects[idea.id]?.id
                          || idea.associatedProjectIds?.at(-1);
                        if (projectId && onOpenProject) onOpenProject(projectId);
                        else goProjects?.();
                      }}
                    >
                      精确打开项目 <Icon.arrowRight size={13} />
                    </Btn>
                  ) : (
                    <Btn size="sm" onClick={() => addToLibrary(idea)} disabled={addingId === idea.id}>
                      {addingId === idea.id ? '添加中…' : <><Icon.plus size={13} />加入分析库</>}
                    </Btn>
                  )}
                </div>
                {createdProjects[idea.id]?.id && (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                    {createdProjects[idea.id].status === 'created'
                      ? '项目已创建但尚未分析'
                      : `项目已存在 · 当前状态 ${createdProjects[idea.id].status}`}
                    {' · '}<span className="font-mono">{createdProjects[idea.id].id}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex">
          {/* 左：生成历史列表 */}
          <div className="w-72 shrink-0 border-r border-line bg-white flex flex-col">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between">
              <span className="text-sm font-medium text-ink">生成历史</span>
              <span className="text-[11px] text-sub">{traces.length} 次</span>
            </div>
            <div className="flex-1 overflow-auto">
              {!traces.length && <div className="p-6 text-center text-sub text-xs">暂无生成记录。点击右上角「生成新思路」会记录一次完整工作流。</div>}
              {traces.map((t) => (
                <button key={t.id} onClick={() => setActiveTrace(t.id)}
                  className={`w-full text-left px-4 py-3 border-b border-line/70 transition ${activeTrace === t.id ? 'bg-blue-50/70' : 'hover:bg-slate-50'}`}>
                  <div className="text-[13px] font-medium text-ink leading-snug">生成 {t.ideas?.length ?? t.count} 条思路</div>
                  <div className="text-[11px] text-sub mt-0.5 line-clamp-1">{(t.ideas || []).map((i) => i.theme).filter(Boolean).slice(0, 3).join(' · ') || '—'}</div>
                  <div className="flex items-center gap-2 mt-1.5 text-[10px] text-sub">
                    <TraceBadge trace={t} />
                    <span>{new Date(t.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="ml-auto">{(t.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右：实时工作流 / 工作逻辑详情 */}
          <div className="flex-1 min-w-0 overflow-auto p-7">
            {loading || (progress && progress.running)
              ? <LiveWorkflow progress={progress} trace={liveTrace} workflowSpec={workflowSpec} workflowSpecError={workflowSpecError} />
              : trace ? <TraceDetail trace={trace} workflowSpec={workflowSpec} workflowSpecError={workflowSpecError} /> : <div className="py-16 text-center text-sub text-sm">选择左侧一次生成记录，查看 durable Workflow、Agent 可审计执行摘要与产出。</div>}
          </div>
        </div>
      )}
      {earningsOpen && (
        <EarningsIdeaModal
          rows={earningsRows}
          loading={earningsLoading}
          selected={selectedEarnings}
          setSelected={setSelectedEarnings}
          market={earningsMarket}
          reload={(force = false) => openEarnings(earningsMarket, force)}
          onMarketChange={(m) => {
            setEarningsMarket(m);
            openEarnings(m, false);
          }}
          onClose={() => setEarningsOpen(false)}
          onAdd={addSelectedEarnings}
        />
      )}
    </>
  );
}

function formatCapNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}
function formatMarketCap(row) {
  const usd = formatCapNumber(row.marketCapUsd);
  if (usd) return `约 ${usd} 美元市值`;
  const local = formatCapNumber(row.marketCapLocal);
  if (local) return `${local} ${row.marketCapCurrency || row.currency || ''} 市值`;
  return '市值 n/a';
}

function EarningsIdeaModal({ rows, loading, selected, setSelected, market, onMarketChange, reload, onClose, onAdd }) {
  const toggle = (symbol) => {
    const next = new Set(selected);
    next.has(symbol) ? next.delete(symbol) : next.add(symbol);
    setSelected(next);
  };
  const all = () => setSelected(new Set(rows.map((r) => r.symbol)));
  const none = () => setSelected(new Set());
  return (
    <div className="fixed inset-0 z-50 bg-black/30 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[82vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-ink">未来 7 天财报日历</div>
            <div className="text-xs text-sub mt-0.5">按美元市值从大到小排序；勾选公司后批量加入 idea 库。</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-ink"><Icon.close size={18} /></button>
        </div>
        <div className="px-5 py-3 border-b border-line flex items-center gap-2">
          <Btn size="sm" variant="soft" onClick={all}>全选</Btn>
          <Btn size="sm" variant="ghost" onClick={none}>全否</Btn>
          <select
            value={market}
            onChange={(e) => onMarketChange(e.target.value)}
            className="ml-2 h-8 rounded-lg border border-line bg-white px-2 text-xs text-ink"
          >
            <option value="global">全球市场</option>
            <option value="us">仅美股/ADR</option>
          </select>
          <Btn size="sm" variant="ghost" onClick={() => reload(true)} disabled={loading}>刷新</Btn>
          <span className="text-xs text-sub ml-auto">已选 {selected.size} / {rows.length}</span>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {loading && !rows.length ? <Spinner label="正在读取财报日历和公司资料…" /> : (
            <div className="space-y-2">
              {rows.map((r) => (
                <button key={r.symbol} onClick={() => toggle(r.symbol)}
                  className={`w-full text-left border rounded-lg p-3 transition ${selected.has(r.symbol) ? 'border-brand bg-blue-50/50' : 'border-line hover:border-slate-300 bg-white'}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" readOnly checked={selected.has(r.symbol)} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-semibold text-ink">{r.symbol}</span>
                        <span className="text-sm font-medium text-ink truncate">{r.companyName}</span>
                        <span className="text-[11px] text-sub">{formatMarketCap(r)}</span>
                        {(r.exchange || r.country) && <span className="text-[11px] text-sub">{[r.exchange, r.country].filter(Boolean).join(' · ')}</span>}
                        <span className="text-[11px] text-sub">{r.date}{r.time ? ` · ${r.time}` : ''}</span>
                      </div>
                      {r.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{r.description}</p>}
                      <p className="text-sm text-sub mt-1">{r.rationale}</p>
                      <div className="flex gap-3 flex-wrap text-[11px] text-slate-500 mt-2">
                        {r.sector && <span>{r.sector}</span>}
                        {r.industry && <span>{r.industry}</span>}
                        <span>EPS est {r.epsEst ?? 'n/a'}</span>
                        <span>Revenue est {r.revenueEst ?? 'n/a'}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {!rows.length && !loading && <div className="text-sm text-sub text-center py-10">未来 7 天未读取到财报事件。</div>}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <Btn onClick={onAdd} disabled={loading || !selected.size}><Icon.plus size={13} />加入 idea 库</Btn>
        </div>
      </div>
    </div>
  );
}

function IdeaQualityAnnotation({ idea }) {
  const warnings = Array.isArray(idea.qualityWarnings)
    ? idea.qualityWarnings
    : idea.qualityWarnings ? [String(idea.qualityWarnings)] : [];
  return (
    <div className="mb-3 rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-emerald-800">质量审阅注释</span>
        <span className="text-[10px] text-emerald-700">只排序/注释，不决定发布</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px]">
        <QualityField label="qualityScore" value={idea.qualityScore} />
        <QualityField label="qualityRank" value={idea.qualityRank} />
        <QualityField
          label="qualitySelected"
          value={idea.qualitySelected == null ? null : (idea.qualitySelected ? 'true' : 'false')}
        />
      </div>
      <div className="mt-2 text-[10px] text-slate-600">
        <span className="font-mono text-slate-500">qualityReason · </span>
        {idea.qualityReason || '未记录'}
      </div>
      <div className="mt-1 text-[10px] text-slate-600">
        <span className="font-mono text-slate-500">qualityWarnings · </span>
        {warnings.length ? warnings.join('；') : '无/未记录'}
      </div>
    </div>
  );
}

function QualityField({ label, value }) {
  return (
    <div className="rounded border border-emerald-100 bg-white/80 px-2 py-1">
      <div className="font-mono text-[9px] text-slate-400">{label}</div>
      <div className="mt-0.5 font-medium text-ink">{value ?? '未记录'}</div>
    </div>
  );
}

function IdeaLineage({ idea }) {
  const hasDurableLineage = Boolean(
    idea.sourceIdeaRunId
    && idea.sourceRunInputSnapshotId
    && idea.sourceRunAsOf,
  );
  return (
    <div className="mb-3 rounded-lg border border-line bg-slate-50 px-3 py-2 text-[10px] text-slate-600">
      <div className="font-medium text-slate-700 mb-1">Durable lineage</div>
      <div className="space-y-0.5 font-mono break-all">
        <div>sourceIdeaRunId · {idea.sourceIdeaRunId || '未记录'}</div>
        <div>sourceRunInputSnapshotId · {idea.sourceRunInputSnapshotId || '未记录'}</div>
        <div>sourceRunAsOf · {idea.sourceRunAsOf || '未记录'}</div>
      </div>
      {!hasDurableLineage && (
        <div className="mt-1 font-sans">无 durable lineage（legacy/手动 Idea 或公开字段不完整）</div>
      )}
    </div>
  );
}

// 实时工作流：生成期间逐步点亮 context→memory→reason→output
function LiveWorkflow({
  progress,
  trace,
  workflowSpec,
  workflowSpecError,
}) {
  const steps = progress?.steps || ['context', 'memory', 'source', 'reason', 'screen', 'output'].map((stage) => ({ stage, label: STAGE[stage].label, status: 'pending', text: '' }));
  const running = progress?.running ?? true;
  const elapsed = progress?.startedAt ? ((Date.now() - progress.startedAt) / 1000).toFixed(0) : null;
  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-white border border-line rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            {running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-60" />}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${running ? 'bg-brand' : 'bg-emerald-500'}`} />
          </span>
          <span className="text-sm font-medium text-ink">{running ? 'Idea Agent 正在生成思路…' : '本次生成已完成'}</span>
          {elapsed && running && <span className="ml-auto text-[11px] text-sub tabular-nums">已用 {elapsed}s</span>}
        </div>
        <div className="p-5 space-y-1">
          {steps.map((s, i) => {
            const st = STAGE[s.stage] || STAGE.reason;
            const I = Icon[st.icon];
            const done = s.status === 'done';
            const active = s.status === 'running';
            return (
              <div key={s.stage} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={`w-8 h-8 rounded-full grid place-items-center shrink-0 transition ${done ? `${st.bg} ${st.color}` : active ? 'bg-brand/10 text-brand' : 'bg-slate-100 text-slate-300'}`}>
                    {active ? <span className="w-3.5 h-3.5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      : done ? <Icon.check size={15} />
                      : <I size={15} />}
                  </span>
                  {i < steps.length - 1 && <div className={`w-px flex-1 my-1 transition ${done ? 'bg-brand/30' : 'bg-line'}`} />}
                </div>
                <div className={`flex-1 pb-3 transition ${s.status === 'pending' ? 'opacity-40' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink">{s.label || st.label}</span>
                    {active && <span className="text-[10px] text-brand">进行中</span>}
                    {done && <span className="text-[10px] text-emerald-600">完成</span>}
                  </div>
                  {s.text && <p className="text-[12px] text-sub leading-relaxed mt-0.5">{s.text}</p>}
                  {/* 关键中间数据实时展示 */}
                  {done && s.data?.heavyThemes && (
                    <div className="mt-1 text-[11px] text-slate-500">过度堆积主题：{(s.data.heavyThemes || []).join('、') || '无（覆盖较均衡）'}</div>
                  )}
                  {done && s.data?.domainsUsed && (
                    <div className="mt-1 text-[11px] text-slate-500">观点流覆盖领域：{(s.data.domainsUsed || []).join(' / ') || '—'}</div>
                  )}
                  {done && s.stage === 'screen' && (s.data?.validTickers || s.data?.droppedTickers) && (
                    <div className="mt-1.5 space-y-1">
                      {!!(s.data.validTickers || []).length && (
                        <div className="text-[11px] text-slate-500">校验通过标的：{(s.data.validTickers || []).slice(0, 20).map((t) => (
                          <span key={t} className="font-mono px-1 py-0.5 mr-1 bg-emerald-50 text-emerald-700 rounded">{t}</span>
                        ))}</div>
                      )}
                      {!!(s.data.droppedTickers || []).length && (
                        <div className="text-[11px] text-slate-500">剔除查不到的代码：{(s.data.droppedTickers || []).map((t) => (
                          <span key={t} className="font-mono px-1 py-0.5 mr-1 bg-red-50 text-red-600 rounded line-through">{t}</span>
                        ))}</div>
                      )}
                    </div>
                  )}
                  {done && s.data?.ideas && (
                    <div className="mt-2 space-y-1">
                      {s.data.ideas.map((idea, k) => (
                        <div key={k} className="text-[11px] text-ink bg-slate-50 border border-line rounded px-2 py-1.5">
                          <span className="text-amber-600">●</span> {idea.sentence || idea.title}
                          {idea.theme && <span className="text-slate-400 ml-1">· {idea.theme}</span>}
                          {(idea.sourceAgents || []).length > 0 && <span className="text-cyan-700 ml-1">· {(idea.sourceAgents || []).join('+')}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <CanonicalIdeaWorkflow
        workflowSpec={workflowSpec}
        workflowSpecError={workflowSpecError}
        trace={trace || progress}
      />
      <div className="text-center text-[11px] text-sub">Agent 执行摘要会随 durable trace 更新；点击具体执行后才按需加载活动与工具明细。</div>
    </div>
  );
}

function TraceDetail({ trace, workflowSpec, workflowSpecError }) {
  const ctx = trace.context || {};
  const failed = ['FAILED', 'BLOCKED', 'CANCELLED'].includes(trace.status);
  const executionMode = trace.provider === 'demo'
    ? '演示模式'
    : trace.live === true ? '真实模型' : '未调用真实模型';
  const workflowIdentity = trace.workflowSpec || workflowSpec?.workflow || {};
  return (
    <div className="max-w-3xl space-y-6">
      <div className={`border rounded-xl px-4 py-3 flex items-center gap-3 ${failed ? 'border-red-200 bg-red-50' : 'border-line bg-white'}`}>
        <TraceBadge trace={trace} />
        <span className="text-xs text-slate-600">durable status：{trace.status || 'UNKNOWN'}</span>
        {trace.stopReason && <span className="text-xs text-slate-500">停止原因：{trace.stopReason}</span>}
      </div>
      <Section title="Durable Run 标识" icon="layers">
        <div className="space-y-2">
          <KV k="runId" v={<span className="font-mono break-all">{trace.runId || '—'}</span>} />
          <KV k="snapshotId" v={<span className="font-mono break-all">{trace.snapshotId || '—'}</span>} />
          <KV k="asOf" v={<span className="font-mono">{trace.asOf || '—'}</span>} />
          <KV
            k="Workflow"
            v={<span className="font-mono">{workflowIdentity.id || trace.workflowId || '—'}@{workflowIdentity.version || '—'}</span>}
          />
          <KV k="workflow hash" v={<span className="font-mono break-all">{workflowIdentity.hash || '—'}</span>} />
          <KV k="configDigest" v={<span className="font-mono break-all">{trace.configDigest || '—'}</span>} />
        </div>
      </Section>
      {/* 上下文输入 */}
      <Section title="① 输入：决策上下文" icon="layers">
        <div className="space-y-2 text-sm">
          <KV k="在手主题" v={(ctx.heldThemes || []).join('、') || <span className="text-slate-300">无（空仓）</span>} />
          {ctx.heavyThemes && <KV k="过度堆积主题" v={(ctx.heavyThemes || []).join('、') || <span className="text-slate-300">无（覆盖较均衡）</span>} />}
          {ctx.domainsUsed && <KV k="观点流覆盖领域" v={(ctx.domainsUsed || []).join(' / ') || '—'} />}
          {ctx.saIdeas && <KV k="SA 广域 idea 池" v={`${(ctx.saIdeas || []).length} 个专家在写标的`} />}
        </div>
      </Section>

      <CanonicalIdeaWorkflow
        workflowSpec={workflowSpec}
        workflowSpecError={workflowSpecError}
        trace={trace}
      />

      {/* trace.steps 保留为兼容叙事，不作为 canonical 拓扑来源 */}
      <Section title="③ 兼容叙事步骤（trace.steps）" icon="agent">
        <div className="space-y-2">
          {(trace.steps || []).map((s, i) => {
            const st = STAGE[s.stage] || STAGE.reason;
            const I = Icon[st.icon];
            return (
              <div key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={`w-7 h-7 rounded-full ${st.bg} ${st.color} grid place-items-center shrink-0`}><I size={14} /></span>
                  {i < trace.steps.length - 1 && <div className="w-px flex-1 bg-line my-1" />}
                </div>
                <div className="flex-1 pb-1">
                  <div className="text-[11px] font-semibold text-slate-500 mb-0.5">{st.label}</div>
                  <p className="text-sm text-ink leading-relaxed">{s.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* 产出 */}
      <Section title="④ 产出：本批投资思路" icon="idea">
        <div className="space-y-3">
          {(trace.ideas || []).map((idea, i) => (
            <div key={i} className="border border-line rounded-lg p-3.5">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                {idea.theme && <Badge color="blue">{idea.theme}</Badge>}
                {idea.heat != null && <span className="text-[11px] text-amber-600 inline-flex items-center gap-0.5"><Icon.flame size={11} />{idea.heat}</span>}
              </div>
              <div className="text-sm font-medium text-ink mb-1">{idea.title}</div>
              <IdeaQualityAnnotation idea={idea} />
              <IdeaLineage idea={idea} />
              {idea.rationale && <p className="text-xs text-slate-500 leading-relaxed mb-1.5">{idea.rationale}</p>}
              {(idea.catalyst || idea.edge) && (
                <div className="space-y-0.5 mb-1.5">
                  {idea.catalyst && <div className="text-[11px] text-slate-500"><span className="text-amber-600">催化剂 · </span>{idea.catalyst}</div>}
                  {idea.edge && <div className="text-[11px] text-slate-500"><span className="text-brand">预期差 · </span>{idea.edge}</div>}
                </div>
              )}
              <div className="flex gap-1 flex-wrap">
                {(idea.tickers || []).map((t) => <span key={t} className="font-mono text-[10px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-600">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs text-sub">provider：<span className="font-mono text-brand">{trace.provider || '—'}</span> · 耗时 {(trace.durationMs / 1000).toFixed(1)}s · {executionMode}</div>
      </Section>
    </div>
  );
}

function CanonicalIdeaWorkflow({ workflowSpec, workflowSpecError, trace }) {
  const nodes = workflowSpec?.nodes || [];
  const stateByNodeId = new Map((trace?.nodes || []).map((node) => [node.nodeId, node]));
  const agentExecutions = trace?.agentExecutions || trace?.agentRuns || [];
  const runId = trace?.runId || trace?.id;
  return (
    <Section title="② Canonical Idea Workflow（六节点）" icon="globe">
      {workflowSpecError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          Canonical Workflow 元数据读取失败：{workflowSpecError}
        </div>
      )}
      {!nodes.length ? (
        <div className="text-xs text-sub">Canonical Workflow 元数据暂不可用；不使用本地伪造拓扑。</div>
      ) : (
        <>
          <div className="mb-3 text-[10px] text-sub font-mono break-all">
            {workflowSpec.workflow?.id}@{workflowSpec.workflow?.version} · {workflowSpec.workflow?.hash}
          </div>
          <div className="space-y-2">
            {nodes.map((node, index) => {
              const state = stateByNodeId.get(node.id);
              const failure = state?.lastFailure;
              const failureText = failure?.reason || failure?.code || failure?.category || '—';
              const nodeExecutions = agentExecutions
                .filter((execution) => execution.nodeId === node.id);
              const boundAgentIds = node.agentIds || node.agentContractIds || [];
              return (
                <div key={node.id} className="rounded-lg border border-line bg-white p-3">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-blue-50 text-brand grid place-items-center text-[10px] font-semibold">{index + 1}</span>
                    <span className="text-xs font-medium text-ink">{IDEA_NODE_LABELS[node.id] || node.id}</span>
                    <span className="ml-auto font-mono text-[9px] text-slate-400">{node.kind}</span>
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-slate-500 break-all">{node.id}</div>
                  <div className="mt-2 grid grid-cols-4 gap-2 text-[9px]">
                    <NodeField label="status" value={state?.status || 'PENDING'} />
                    <NodeField label="attempt" value={state?.attempt ?? 0} />
                    <NodeField label="failure" value={failureText} title={failureText} />
                    <NodeField label="artifacts" value={state?.artifactRefs?.length || 0} />
                  </div>
                  {(boundAgentIds.length > 0 || nodeExecutions.length > 0) && (
                    <div className="mt-3 border-t border-line pt-3">
                      {boundAgentIds.length > 0 && (
                        <div className="mb-2 text-[9px] text-sub">
                          Canonical bindings：<span className="font-mono">{boundAgentIds.join(' · ')}</span>
                        </div>
                      )}
                      <AgentExecutionInspector
                        key={`idea:${runId || 'pending'}:node:${node.id}`}
                        scopeKey={`idea:${runId || 'pending'}:node:${node.id}`}
                        executions={nodeExecutions}
                        loadTimeline={(agentRunId, options) => (
                          api.ideaAgentTimeline(runId, agentRunId, options)
                        )}
                        emptyText="Agent 已绑定，但当前尚无 physical execution 可展示。"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}

function NodeField({ label, value, title }) {
  return (
    <div className="rounded bg-slate-50 px-2 py-1.5 min-w-0">
      <div className="text-slate-400">{label}</div>
      <div className="mt-0.5 text-slate-700 truncate" title={title || String(value)}>{value}</div>
    </div>
  );
}

function Section({ title, icon, children, collapsible, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const I = Icon[icon] || Icon.doc;
  return (
    <div className="bg-white border border-line rounded-xl overflow-hidden">
      <button onClick={() => collapsible && setOpen(!open)} className={`w-full px-5 py-3 border-b border-line flex items-center gap-2 ${collapsible ? 'hover:bg-slate-50' : ''}`}>
        <I size={15} className="text-slate-400" />
        <span className="text-sm font-medium text-ink">{title}</span>
        {collapsible && <span className="ml-auto text-xs text-sub">{open ? '收起' : '展开'}</span>}
      </button>
      {open && <div className="p-5">{children}</div>}
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="flex gap-3">
      <span className="text-sub w-24 shrink-0 text-xs pt-0.5">{k}</span>
      <span className="text-ink flex-1 text-[13px]">{v || <span className="text-slate-300">—</span>}</span>
    </div>
  );
}

function HeatBar({ value }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <span className="inline-flex items-center gap-1 text-xs text-sub">
      <Icon.flame size={12} className="text-amber-500" />
      <span className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <span className="block h-full bg-amber-400" style={{ width: v + '%' }} />
      </span>
      <span className="tabular-nums text-[11px]">{v}</span>
    </span>
  );
}
