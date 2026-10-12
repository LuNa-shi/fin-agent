import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import AgentExecutionInspector from './AgentExecutionInspector.jsx';
import {
  acceptsProjectRequest,
  selectVisibleRunId,
} from './workflowRunSelection.js';

const FALLBACK_NODES = [
  { id: 'initialize-checkpoint', dependsOn: [], kind: 'deterministic', agentContractIds: [] },
  { id: 'plan-research', dependsOn: ['initialize-checkpoint'], kind: 'agent', agentContractIds: ['analysis-plan'] },
  { id: 'select-candidates', dependsOn: ['plan-research'], kind: 'composite', agentContractIds: ['scan-score'] },
  { id: 'run-research-rounds', dependsOn: ['select-candidates'], kind: 'composite', agentContractIds: ['data-orchestrator', 'industry-analyst', 'company-analyst'] },
  { id: 'compose-report', dependsOn: ['run-research-rounds'], kind: 'agent', agentContractIds: ['report-composer'] },
  { id: 'review-report', dependsOn: ['compose-report'], kind: 'review', agentContractIds: ['evidence-reviewer', 'requirement-reviewer', 'logic-reviewer'] },
  { id: 'synthesize-conclusion', dependsOn: ['review-report'], kind: 'agent', agentContractIds: ['conclusion-synthesizer'] },
  { id: 'finalize-project', dependsOn: ['synthesize-conclusion'], kind: 'deterministic', agentContractIds: [] },
];

const NODE_LABELS = {
  'initialize-checkpoint': ['初始化', '建立 checkpoint 与运行上下文'],
  'plan-research': ['研究规划', '拆解问题、定义证据需求'],
  'select-candidates': ['候选筛选', '扫描并选择研究对象'],
  'run-research-rounds': ['研究循环', '固定轮次：Data closure 后并行执行行业与公司分析'],
  'compose-report': ['撰写报告', '组合证据并形成报告草稿'],
  'review-report': ['交叉复核', '证据、需求与逻辑三方只读复核'],
  'synthesize-conclusion': ['综合结论', '输出评级、置信度与风险'],
  'finalize-project': ['项目收尾', '发布产物并完成运行'],
};

export default function WorkflowRunView({ projectId, analyzing, fallbackEvents = [], progress }) {
  const [spec, setSpec] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [manualRunId, setManualRunId] = useState('');
  const [detail, setDetail] = useState(null);
  const [selectedNode, setSelectedNode] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const detailRequest = useRef(0);
  const runsRequest = useRef(0);
  const runIdRef = useRef('');
  const manualRunIdRef = useRef('');
  const projectIdRef = useRef(projectId);
  const wasAnalyzingRef = useRef(analyzing);
  projectIdRef.current = projectId;

  const loadSpec = async () => {
    try {
      const result = await api.workflowSpec();
      setSpec({ ...result.workflow, nodes: result.nodes || [], edges: result.edges || [] });
    } catch { setSpec({ id: 'run-analysis.v2', version: '2.0.0', nodes: FALLBACK_NODES }); }
  };
  const loadRuns = async () => {
    const requestedProjectId = projectId;
    const requestId = ++runsRequest.current;
    const current = () => acceptsProjectRequest({
      requestId,
      latestRequestId: runsRequest.current,
      requestedProjectId,
      currentProjectId: projectIdRef.current,
    });
    try {
      const result = await api.projectRuns(requestedProjectId);
      if (!current()) return '';
      const next = result.runs || [];
      const nextActiveRunId = result.activeRunId
        || next.find((run) => ['running', 'analyzing', 'queued'].includes(String(run.status || '').toLowerCase()))?.runId
        || '';
      setRuns(next);
      setActiveRunId(nextActiveRunId);
      if (
        manualRunIdRef.current
        && !next.some((run) => run.runId === manualRunIdRef.current)
      ) {
        manualRunIdRef.current = '';
        setManualRunId('');
      }
      const visibleRunId = selectVisibleRunId({
        runs: next,
        currentRunId: runIdRef.current,
        activeRunId: nextActiveRunId,
        manualRunId: manualRunIdRef.current,
      });
      runIdRef.current = visibleRunId;
      setRunId(visibleRunId);
      setError('');
      return visibleRunId;
    } catch (e) {
      if (!current()) return '';
      setError(e.message);
      setRuns([]);
      return '';
    }
  };
  const loadDetail = async (id, { preserve = false } = {}) => {
    const requestedProjectId = projectId;
    const requestId = ++detailRequest.current;
    const current = () => acceptsProjectRequest({
      requestId,
      latestRequestId: detailRequest.current,
      requestedProjectId,
      currentProjectId: projectIdRef.current,
    });
    if (!id) {
      if (current()) {
        setDetail(null);
        setDetailLoading(false);
      }
      return;
    }
    if (!preserve) setDetail(null);
    setDetailLoading(true);
    try {
      const result = await api.projectRun(requestedProjectId, id);
      if (current() && result.runId === id) { setDetail(result); setError(''); }
    } catch (e) {
      if (current()) { setDetail(null); setError(e.message); }
    } finally {
      if (current()) setDetailLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    runsRequest.current += 1;
    detailRequest.current += 1;
    runIdRef.current = '';
    manualRunIdRef.current = '';
    setLoading(true);
    setRuns([]);
    setRunId('');
    setActiveRunId('');
    setManualRunId('');
    setDetail(null);
    setDetailLoading(false);
    setSelectedNode('');
    setError('');
    Promise.all([loadSpec(), loadRuns()]).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => { loadDetail(runId); }, [projectId, runId]);
  useEffect(() => {
    const wasAnalyzing = wasAnalyzingRef.current;
    wasAnalyzingRef.current = analyzing;
    if (!analyzing && !wasAnalyzing) return;
    let stopped = false;
    let timer;
    const requestedProjectId = projectId;
    const refresh = async () => {
      const visibleRunId = await loadRuns();
      if (stopped || projectIdRef.current !== requestedProjectId) return;
      if (visibleRunId) await loadDetail(visibleRunId, { preserve: true });
    };
    const poll = async () => {
      await refresh();
      if (!stopped && projectIdRef.current === requestedProjectId) {
        timer = setTimeout(poll, 1500);
      }
    };
    if (analyzing) timer = setTimeout(poll, 1500);
    else void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [projectId, runId, manualRunId, analyzing]);

  const nodes = useMemo(() => normalizeNodes(spec?.nodes || FALLBACK_NODES), [spec]);
  const states = useMemo(() => nodeStateMap(detail), [detail]);
  const hasDurableStates = Object.keys(states).length > 0;
  const completedNodes = hasDurableStates
    ? Object.values(states).filter((state) => normalizeStatus(state.status) === 'succeeded').length
    : (!analyzing && fallbackEvents.length ? nodes.length : 0);
  const selected = selectedNode || activeNodeId(nodes, states) || nodes[0]?.id;
  const selectedSpec = nodes.find((node) => node.id === selected);
  const selectedState = states[selected] || { status: 'PENDING' };
  const normalizedEvents = useMemo(() => traceEvents(detail, fallbackEvents), [detail, fallbackEvents]);
  const trace = useMemo(() => {
    const selectedAgentIds = new Set([...(selectedSpec?.agentContractIds || selectedSpec?.agentIds || []), ...(selectedState.agentIds || [])]);
    return normalizedEvents.filter((event) => {
      const nodeId = eventNodeId(event);
      if (nodeId) return nodeId === selected;
      const agentIds = eventAgentIds(event);
      return agentIds.some((agentId) => selectedAgentIds.has(agentId));
    });
  }, [normalizedEvents, selected, selectedSpec, selectedState]);

  if (loading) return <div className="py-20 grid place-items-center"><Spinner label="加载 Workflow 运行状态…" /></div>;

  return (
    <div className="min-w-[900px] space-y-4">
      <div className="bg-white border border-line rounded-xl p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Icon.layers size={17} className="text-brand" /><h2 className="text-sm font-semibold text-ink">Run Analysis Workflow</h2><Badge color="blue">{spec?.version || 'v1'}</Badge></div>
            <p className="text-[11px] text-sub mt-1">外层展示状态机进度；点击 Node 查看 Agent、工具调用、可审计推理摘要与产物。不会展示模型隐藏思维链。</p>
          </div>
          <div className="flex items-center gap-2">
            {runs.length > 0 && <select value={runId} onChange={(e) => {
              const selectedRunId = e.target.value;
              const pinnedRunId = selectedRunId !== activeRunId ? selectedRunId : '';
              manualRunIdRef.current = pinnedRunId;
              runIdRef.current = selectedRunId;
              setManualRunId(pinnedRunId);
              setRunId(selectedRunId);
            }} className="studio-input w-auto text-xs px-2 py-2 max-w-xs">
              {runs.map((run) => <option key={run.runId} value={run.runId}>{runLabel(run)}</option>)}
            </select>}
            <WorkflowStatus status={detail?.run?.status || detail?.status || (analyzing ? 'RUNNING' : fallbackEvents.length ? 'SUCCEEDED' : 'PENDING')} />
          </div>
        </div>
        {analyzing && progress && (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-brand transition-all" style={{ width: `${progress.pct || 0}%` }} /></div>
            <span className="text-[10px] text-sub tabular-nums">{progress.stage} · {progress.pct || 0}%</span>
          </div>
        )}
        {error && <div className="mt-3 text-[10px] text-amber-600">Durable run API 暂不可用，当前显示兼容事件投影：{error}</div>}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4 min-h-[520px]">
        <div className="bg-white border border-line rounded-xl p-4 shadow-sm overflow-auto">
          <div className="flex items-center justify-between mb-4"><div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Workflow Graph</div><StatusLegend /></div>
          <WorkflowGraph nodes={nodes} states={states} hasDurableStates={hasDurableStates} selected={selected} onSelect={setSelectedNode} analyzing={analyzing} hasFallbackEvents={fallbackEvents.length > 0} />
          <div className="mt-5 pt-4 border-t border-line grid grid-cols-3 gap-3">
            <RunMetric label="Completed Nodes" value={completedNodes} total={nodes.length} />
            <RunMetric label="Current Attempt" value={Math.max(0, ...Object.values(states).map((state) => Number(state.attempt || 0)))} />
            <RunMetric label="Artifacts" value={artifactRefs(detail).length} />
          </div>
        </div>
        {detailLoading && !detail ? <aside className="bg-white border border-line rounded-xl grid place-items-center"><Spinner label="加载 Run Trace…" /></aside> : (
          <NodeInspector
            projectId={projectId}
            runId={detail?.runId || runId}
            node={selectedSpec}
            state={selectedState}
            events={trace}
            detail={detail}
          />
        )}
      </div>
    </div>
  );
}

function WorkflowGraph({ nodes, states, hasDurableStates, selected, onSelect, analyzing, hasFallbackEvents }) {
  const columns = layoutColumns(nodes);
  return (
    <>
      <div className="min-w-[760px] flex items-stretch gap-2 py-4" role="group" aria-label="Workflow node graph">
        {columns.map((column, index) => (
          <React.Fragment key={index}>
            <div className="flex-1 min-w-[132px] flex flex-col justify-center gap-3">
              {column.map((node) => {
                const state = resolveNodeState(node, nodes, states, hasDurableStates, analyzing, hasFallbackEvents);
                return <WorkflowNode key={node.id} node={node} state={state} selected={selected === node.id} onClick={() => onSelect(node.id)} />;
              })}
            </div>
            {index < columns.length - 1 && <div className="w-6 shrink-0 grid place-items-center text-slate-300" aria-hidden="true"><Icon.arrowRight size={18} /></div>}
          </React.Fragment>
        ))}
      </div>
      <table className="sr-only">
        <caption>Workflow node status table</caption>
        <thead><tr><th>Node</th><th>Status</th><th>Attempt</th><th>Dependencies</th></tr></thead>
        <tbody>{nodes.map((node) => { const state = resolveNodeState(node, nodes, states, hasDurableStates, analyzing, hasFallbackEvents); return <tr key={node.id}><td>{NODE_LABELS[node.id]?.[0] || node.id}</td><td>{normalizeStatus(state.status)}</td><td>{state.attempt || 0}</td><td>{(node.dependsOn || []).join(', ') || 'none'}</td></tr>; })}</tbody>
      </table>
    </>
  );
}

function WorkflowNode({ node, state, selected, onClick }) {
  const status = normalizeStatus(state.status);
  const [title, desc] = NODE_LABELS[node.id] || [node.id, node.kind];
  const style = statusStyle(status);
  return (
    <button onClick={onClick} aria-pressed={selected} aria-label={`${title}: ${status}`} title={`${title} · ${status}`}
      className={`relative w-full text-left border rounded-xl p-3 transition focus:outline-none focus:ring-2 focus:ring-blue-200 ${selected ? 'ring-2 ring-blue-100 border-brand shadow-md' : `${style.border} hover:border-blue-300 hover:shadow-sm`} ${style.bg}`}>
      {node.parallelGroup && <span className="absolute -top-2 left-2 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded px-1.5 py-0.5 text-[8px] uppercase">parallel</span>}
      <div className="flex items-start gap-2">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-ink leading-tight">{title}</div><div className="font-mono text-[8px] text-slate-400 mt-0.5 truncate">{node.id}</div></div>
      </div>
      <p className="text-[9px] text-sub mt-2 leading-relaxed line-clamp-2">{desc}</p>
      <div className="mt-2 flex items-center justify-between text-[8px]"><span className={`font-semibold uppercase ${style.text}`}>{status}</span>{state.attempt > 0 && <span className="text-slate-400">attempt {state.attempt}</span>}</div>
    </button>
  );
}

function NodeInspector({
  projectId,
  runId,
  node,
  state,
  events,
  detail,
}) {
  const [tab, setTab] = useState('trace');
  if (!node) return <div className="bg-white border border-line rounded-xl grid place-items-center text-sm text-sub">选择一个 Node</div>;
  const agentExecutions = (detail?.agentExecutions || detail?.agentRuns || [])
    .filter((execution) => execution.nodeId === node.id);
  const boundAgentIds = [...new Set([
    ...(node.agentContractIds || node.agentIds || []),
    ...(state.agentIds || []),
    ...events.flatMap((event) => eventAgentIds(event)),
    ...agentExecutions.map((execution) => execution.agentId),
  ])];
  const refs = [...(state.artifactRefs || []), ...artifactRefs(detail).filter((ref) => ref.nodeId === node.id || ref.producerNodeId === node.id)];
  const toolEvents = events.filter((event) => eventToolName(event));
  return (
    <aside className="bg-white border border-line rounded-xl shadow-sm flex flex-col min-h-0 overflow-hidden">
      <div className="p-4 border-b border-line">
        <div className="flex items-start gap-3"><StatusIcon status={normalizeStatus(state.status)} size="lg" /><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-ink">{NODE_LABELS[node.id]?.[0] || node.id}</h3><div className="font-mono text-[9px] text-slate-400 mt-0.5 break-all">{node.id}</div></div><WorkflowStatus status={state.status || 'PENDING'} /></div>
        <p className="text-[11px] text-sub mt-3 leading-relaxed">{NODE_LABELS[node.id]?.[1] || node.kind}</p>
        <div className="grid grid-cols-2 gap-2 mt-3"><MiniMeta label="Attempt" value={state.attempt ?? 0} /><MiniMeta label="Duration" value={durationLabel(state.startedAt, state.completedAt)} /><MiniMeta label="Kind" value={node.kind || 'node'} /><MiniMeta label="Tools" value={toolEvents.length} /></div>
      </div>
      <div className="flex border-b border-line px-2">
        {[['trace', '执行轨迹'], ['agents', `Agent 执行 ${agentExecutions.length}`], ['artifacts', `产物 ${refs.length}`]].map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`px-3 py-2 text-[11px] border-b-2 -mb-px ${tab === key ? 'border-brand text-brand font-medium' : 'border-transparent text-sub'}`}>{label}</button>)}
      </div>
      <div className="flex-1 overflow-auto p-3">
        {tab === 'trace' && <TraceList events={events} state={state} />}
        {tab === 'agents' && (
          <div className="space-y-2">
            {boundAgentIds.length > 0 && (
              <div className="text-[9px] text-sub">
                Canonical bindings：<span className="font-mono">{boundAgentIds.join(' · ')}</span>
              </div>
            )}
            <AgentExecutionInspector
              key={`project:${projectId}:run:${runId}:node:${node.id}`}
              scopeKey={`project:${projectId}:run:${runId}:node:${node.id}`}
              executions={agentExecutions}
              loadTimeline={(agentRunId, options) => (
                api.projectAgentTimeline(projectId, runId, agentRunId, options)
              )}
              emptyText={boundAgentIds.length
                ? '这个 Node 已绑定 Agent，但当前尚无 physical execution 可展示。'
                : '这是确定性 Node，没有直接调用 Agent。'}
            />
          </div>
        )}
        {tab === 'artifacts' && <ArtifactList refs={refs} />}
      </div>
    </aside>
  );
}

function TraceList({ events, state }) {
  const items = events.length ? events : state.lastFailure ? [{ type: 'failure', summary: state.lastFailure.reason || state.lastFailure.code || state.lastFailure.category, ts: state.completedAt }] : [];
  if (!items.length) return <InspectorEmpty text="这个 Node 还没有可展示的 durable trace。" />;
  return <div className="space-y-2">{items.map((event, index) => {
    const tool = eventToolName(event);
    const summary = eventSummary(event);
    return <div key={event.eventId || event.id || index} className="border border-line rounded-lg p-3"><div className="flex items-center gap-2"><TraceType event={event} /><span className="text-[9px] text-slate-400 ml-auto">{formatTime(event.ts || event.createdAt || event.timestamp)}</span></div>{summary && <p className="text-[11px] text-slate-700 mt-2 leading-relaxed whitespace-pre-wrap break-words">{summary}</p>}{tool && <div className="mt-2 flex items-center gap-1.5 font-mono text-[9px] text-amber-700 bg-amber-50 rounded px-2 py-1"><Icon.tool size={11} />{tool}<span className="ml-auto font-sans text-amber-600">{eventToolStatus(event)}</span></div>}{event.reasoningSummary && <div className="mt-2 bg-violet-50 border border-violet-100 rounded p-2 text-[10px] text-violet-800"><span className="font-semibold">推理摘要：</span>{event.reasoningSummary}</div>}</div>;
  })}</div>;
}

function ArtifactList({ refs }) {
  if (!refs.length) return <InspectorEmpty text="这个 Node 尚未发布 ArtifactRef。" />;
  const unique = [...new Map(refs.map((ref) => [typeof ref === 'string' ? ref : ref.artifactId || ref.path || JSON.stringify(ref), ref])).values()];
  return <div className="space-y-2">{unique.map((ref, index) => {
    const item = typeof ref === 'string' ? { path: ref } : ref;
    return <div key={item.artifactId || item.path || index} className="border border-line rounded-lg p-3"><div className="flex items-center gap-2 text-xs text-ink"><Icon.doc size={13} className="text-emerald-600" /><span className="font-mono truncate">{item.path || item.artifactId || 'artifact'}</span></div><div className="mt-1 text-[9px] text-sub font-mono">{item.version ? `v${item.version}` : ''}{item.contentDigest ? ` · ${String(item.contentDigest).slice(0, 12)}` : ''}</div></div>;
  })}</div>;
}

function StatusLegend() { return <div className="flex items-center gap-2 text-[8px] text-sub">{['running', 'succeeded', 'failed', 'pending'].map((status) => <span key={status} className="flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${statusStyle(status).dot}`} />{status}</span>)}</div>; }
function StatusIcon({ status, size }) { const normalized = normalizeStatus(status); const style = statusStyle(normalized); return <span className={`${size === 'lg' ? 'w-9 h-9' : 'w-6 h-6'} rounded-lg grid place-items-center shrink-0 ${style.bg} ${style.text}`}>{normalized === 'running' ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : normalized === 'succeeded' ? <Icon.check size={size === 'lg' ? 17 : 13} /> : normalized === 'failed' || normalized === 'blocked' ? <Icon.warn size={size === 'lg' ? 17 : 13} /> : <span className={`w-2 h-2 rounded-full ${style.dot}`} />}</span>; }
function WorkflowStatus({ status }) { const normalized = normalizeStatus(status); const colors = { running: 'amber', succeeded: 'green', failed: 'red', blocked: 'red', pending: 'slate', ready: 'blue', cancelled: 'slate' }; return <Badge color={colors[normalized] || 'slate'}>{normalized}</Badge>; }
function TraceType({ event }) { const tool = eventToolName(event); const type = tool ? 'tool' : String(event.type || event.eventType || event.kind || 'event').replace(/^workflow\./, ''); return <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-slate-600 uppercase"><span className={`w-1.5 h-1.5 rounded-full ${tool ? 'bg-amber-500' : type.includes('fail') ? 'bg-red-500' : type.includes('complete') || type.includes('succeed') ? 'bg-emerald-500' : 'bg-blue-500'}`} />{type}</span>; }
function MiniMeta({ label, value }) { return <div className="bg-slate-50 border border-line rounded-lg p-2"><div className="text-[8px] uppercase tracking-wide text-slate-400">{label}</div><div className="text-[10px] text-ink mt-0.5 truncate" title={String(value)}>{value || '—'}</div></div>; }
function RunMetric({ label, value, total }) { return <div><div className="text-lg font-semibold text-ink tabular-nums">{value}{total != null && <span className="text-xs text-sub font-normal"> / {total}</span>}</div><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div></div>; }
function InspectorEmpty({ text }) { return <div className="py-12 text-center text-xs text-sub"><Icon.eye size={24} className="mx-auto text-slate-300 mb-2" />{text}</div>; }

function normalizeNodes(nodes) { return Array.isArray(nodes) ? nodes : Object.entries(nodes || {}).map(([id, value]) => ({ id, ...value })); }
function nodeStateMap(detail) { return Object.fromEntries((detail?.nodes || []).map((node) => [node.nodeId, node])); }
function traceEvents(detail, fallback) {
  const durable = [...(detail?.lifecycle || []), ...(detail?.runtimeEvents || [])];
  if (!durable.length) return fallback || [];
  const unique = [...new Map(durable.map((event, index) => [event.eventId || `${event.eventType || event.type}-${event.sequence ?? index}-${event.timestamp || event.ts || ''}`, event])).values()];
  return unique.sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
}
function artifactRefs(detail) { return detail?.artifacts || []; }
function eventNodeId(event) { return event.nodeId || event.payload?.nodeId || event.data?.nodeId || event.metadata?.nodeId; }
function eventAgentIds(event) { const ids = event.agentIds || event.payload?.agentIds || event.data?.agentIds || (event.agentId || event.agent ? [event.agentId || event.agent] : []); return Array.isArray(ids) ? ids.filter(Boolean) : [ids].filter(Boolean); }
function eventToolName(event) { return event.toolName || (typeof event.tool === 'string' ? event.tool : event.tool?.name) || event.payload?.toolName || event.data?.tool || event.metadata?.toolName; }
function eventToolStatus(event) { const value = event.toolStatus || event.status || event.payload?.status || event.data?.ok; return value === false ? 'failed' : value === true ? 'succeeded' : value || 'recorded'; }
function eventSummary(event) { return event.summary || event.text || event.message || event.payload?.summary || event.data?.summary || event.reason || event.stopReason || event.eventType || event.type || ''; }
function formatTime(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false }); }
function formatDuration(ms) { const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function durationLabel(startedAt, completedAt) { if (!startedAt) return '—'; const start = new Date(startedAt).getTime(); const end = completedAt ? new Date(completedAt).getTime() : Date.now(); return !Number.isFinite(start) || !Number.isFinite(end) ? '—' : formatDuration(end - start); }
function runLabel(run) { const startedAt = run.startedAt || run.timestamps?.createdAt || run.timestamps?.updatedAt; return `${String(run.runId || '').slice(0, 12)} · ${normalizeStatus(run.status)}${startedAt ? ` · ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`; }
function normalizeStatus(value) { const status = String(value || 'PENDING').toLowerCase(); if (status.includes('succeed') || status === 'completed' || status === 'done') return 'succeeded'; if (status.includes('running') || status === 'analyzing') return 'running'; if (status.includes('ready')) return 'ready'; if (status.includes('blocked')) return 'blocked'; if (status.includes('cancel')) return 'cancelled'; if (status.includes('fail') || status.includes('error')) return 'failed'; return 'pending'; }
function statusStyle(status) { return ({ running: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' }, succeeded: { bg: 'bg-emerald-50/60', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' }, failed: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-600', dot: 'bg-red-500' }, blocked: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-600', dot: 'bg-red-500' }, ready: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-brand', dot: 'bg-blue-500' }, cancelled: { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-500', dot: 'bg-slate-400' }, pending: { bg: 'bg-white', border: 'border-line', text: 'text-slate-400', dot: 'bg-slate-300' } })[status] || { bg: 'bg-white', border: 'border-line', text: 'text-slate-400', dot: 'bg-slate-300' }; }
function layoutColumns(nodes) { const byId = new Map(nodes.map((node) => [node.id, node])); const cache = new Map(); const level = (node) => { if (cache.has(node.id)) return cache.get(node.id); const deps = node.dependsOn || []; const result = deps.length ? Math.max(...deps.map((id) => byId.has(id) ? level(byId.get(id)) + 1 : 0)) : 0; cache.set(node.id, result); return result; }; const columns = []; nodes.forEach((node) => { const index = level(node); if (!columns[index]) columns[index] = []; columns[index].push(node); }); return columns.filter(Boolean); }
function activeNodeId(nodes, states) { return nodes.find((node) => normalizeStatus(states[node.id]?.status) === 'running')?.id || [...nodes].reverse().find((node) => normalizeStatus(states[node.id]?.status) === 'succeeded')?.id; }
function resolveNodeState(node, nodes, states, hasDurableStates, analyzing, hasEvents) { return states[node.id] || (hasDurableStates ? { status: 'PENDING', attempt: 0 } : fallbackNodeState(node, nodes, analyzing, hasEvents)); }
function fallbackNodeState(node, nodes, analyzing, hasEvents) { if (!hasEvents) return { status: node.id === nodes[0]?.id && analyzing ? 'RUNNING' : 'PENDING' }; if (!analyzing) return { status: 'SUCCEEDED', attempt: 1 }; const index = nodes.findIndex((item) => item.id === node.id); const activeIndex = Math.max(0, Math.min(nodes.length - 1, Math.floor(nodes.length * 0.45))); return { status: index < activeIndex ? 'SUCCEEDED' : index === activeIndex ? 'RUNNING' : 'PENDING', attempt: index <= activeIndex ? 1 : 0 }; }
