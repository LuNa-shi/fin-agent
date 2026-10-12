import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons.jsx';

const PAGE_SIZE = 25;

export default function AgentExecutionInspector({
  executions = [],
  loadTimeline,
  scopeKey,
  emptyText = '当前范围还没有可展示的 Agent 执行。',
}) {
  const [selectedAgentRunId, setSelectedAgentRunId] = useState('');
  const [timelineByRun, setTimelineByRun] = useState({});
  const requestEpoch = useRef(0);

  useEffect(() => {
    requestEpoch.current += 1;
    setSelectedAgentRunId('');
    setTimelineByRun({});
  }, [scopeKey]);

  const loadPage = async (agentRunId, { append = false } = {}) => {
    if (typeof loadTimeline !== 'function') return;
    const current = timelineByRun[agentRunId];
    if (current?.loading) return;
    const afterSequence = append ? current?.nextAfterSequence || 0 : 0;
    const epoch = requestEpoch.current;
    setTimelineByRun((all) => ({
      ...all,
      [agentRunId]: {
        ...(all[agentRunId] || {}),
        loading: true,
        error: '',
      },
    }));
    try {
      const page = await loadTimeline(agentRunId, {
        afterSequence,
        limit: PAGE_SIZE,
      });
      if (epoch !== requestEpoch.current) return;
      setTimelineByRun((all) => ({
        ...all,
        [agentRunId]: {
          items: append
            ? [...(all[agentRunId]?.items || []), ...(page?.items || [])]
            : (page?.items || []),
          nextAfterSequence: page?.nextAfterSequence || afterSequence,
          hasMore: page?.hasMore === true,
          loaded: true,
          loading: false,
          error: '',
        },
      }));
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      setTimelineByRun((all) => ({
        ...all,
        [agentRunId]: {
          ...(all[agentRunId] || {}),
          loaded: true,
          loading: false,
          error: error?.message || String(error),
        },
      }));
    }
  };

  const toggleExecution = (execution) => {
    const nextId = execution.agentRunId;
    if (selectedAgentRunId === nextId) {
      setSelectedAgentRunId('');
      return;
    }
    setSelectedAgentRunId(nextId);
    const timeline = timelineByRun[nextId];
    if (!timeline?.loaded && !timeline?.loading) {
      void loadPage(nextId);
    } else if (
      !timeline.loading
      && Number(execution.lastSequence) > Number(timeline.nextAfterSequence || 0)
    ) {
      void loadPage(nextId, { append: true });
    }
  };

  if (!executions.length) {
    return <InspectorEmpty text={emptyText} />;
  }

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2 text-[9px] leading-relaxed text-violet-800">
        <span className="font-semibold">可审计执行 / 推理摘要：</span>
        由 Agent 生命周期和工具事件归纳，不是模型隐藏思维链；不会展示 Prompt、工具参数或原始结果。
      </div>
      {executions.map((execution) => {
        const opened = selectedAgentRunId === execution.agentRunId;
        const timeline = timelineByRun[execution.agentRunId];
        return (
          <div key={execution.agentRunId} className="overflow-hidden rounded-lg border border-line bg-white">
            <button
              type="button"
              onClick={() => toggleExecution(execution)}
              aria-expanded={opened}
              aria-controls={`agent-timeline-${execution.agentRunId}`}
              className="w-full p-3 text-left transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-200"
            >
              <div className="flex items-start gap-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-700">
                  <Icon.agent size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[10px] font-semibold text-ink">{execution.agentId}</span>
                    <ExecutionStatus status={execution.status} />
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[8px] text-slate-400" title={execution.agentRunId}>
                    {execution.agentRunId}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-sub">
                    <span>attempt {execution.workflowAttempt || 1}</span>
                    <span>{execution.activityCount || 0} activities</span>
                    <span>{execution.toolCount || 0} tools</span>
                    {execution.durationMs != null && <span>{formatDuration(execution.durationMs)}</span>}
                  </div>
                </div>
                <span aria-hidden="true" className="mt-1 text-[10px] text-slate-400">{opened ? '收起' : '查看'}</span>
              </div>
              <ExecutionMetadata execution={execution} />
            </button>
            {opened && (
              <div id={`agent-timeline-${execution.agentRunId}`} className="border-t border-line bg-slate-50/40 p-3">
                <Timeline
                  timeline={timeline}
                  onRetry={() => loadPage(execution.agentRunId)}
                  onRefresh={() => loadPage(execution.agentRunId)}
                  onLoadMore={() => loadPage(execution.agentRunId, { append: true })}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ExecutionMetadata({ execution }) {
  const metrics = execution.metrics || {};
  const tokenCount = metrics.tokens ?? metrics.totalTokens;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5 text-[9px]">
      <Meta label="Provider / Model" value={[execution.provider, execution.model].filter(Boolean).join(' / ') || '—'} />
      <Meta label="Stop reason" value={execution.stopReason || (execution.status === 'RUNNING' ? 'in progress' : '—')} />
      <Meta label="Turns" value={metrics.turns ?? '—'} />
      <Meta label="Tokens" value={tokenCount ?? '—'} />
    </div>
  );
}

function Timeline({
  timeline,
  onRetry,
  onRefresh,
  onLoadMore,
}) {
  if (!timeline || (timeline.loading && !timeline.loaded)) {
    return <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-sub"><LoadingDot />加载执行明细…</div>;
  }
  if (timeline.error && !(timeline.items || []).length) {
    return (
      <div className="py-5 text-center">
        <div role="alert" className="text-[10px] text-red-600">执行明细读取失败：{timeline.error}</div>
        <button type="button" onClick={onRetry} className="mt-2 rounded border border-line bg-white px-2 py-1 text-[10px] text-brand hover:border-blue-300">重试</button>
      </div>
    );
  }
  const items = timeline.items || [];
  return (
    <div className="space-y-2">
      {!items.length && <div className="py-5 text-center text-[10px] text-sub">该执行尚无可展示的 lifecycle/activity 事件。</div>}
      {items.map((item) => <TimelineItem key={`${item.sequence}:${item.agentEventSequence || 0}`} item={item} />)}
      {timeline.error && (
        <div role="alert" className="rounded border border-red-100 bg-red-50 p-2 text-[9px] text-red-600">
          后续明细读取失败：{timeline.error}
          <button type="button" onClick={onLoadMore} className="ml-2 underline">重试</button>
        </div>
      )}
      {items.length > 0 && !timeline.error && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={timeline.loading}
          className="w-full rounded-lg border border-line bg-white px-3 py-1.5 text-[9px] text-sub transition hover:border-blue-300 hover:text-brand disabled:opacity-50"
        >
          {timeline.loading ? '刷新中…' : '刷新执行明细'}
        </button>
      )}
      {timeline.hasMore && !timeline.error && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={timeline.loading}
          className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[10px] text-brand transition hover:border-blue-300 disabled:opacity-50"
        >
          {timeline.loading ? '加载中…' : '加载更多执行事件'}
        </button>
      )}
    </div>
  );
}

function TimelineItem({ item }) {
  const metrics = item.metrics || {};
  return (
    <div className="rounded-lg border border-line bg-white p-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${timelineDot(item)}`} />
        <span className="font-mono text-[8px] uppercase text-slate-500">{activityLabel(item)}</span>
        <span className="ml-auto text-[8px] tabular-nums text-slate-400">{formatTime(item.timestamp)}</span>
      </div>
      {item.summary && <p className="mt-1.5 whitespace-pre-wrap break-words text-[10px] leading-relaxed text-slate-700">{item.summary}</p>}
      {item.tool && (
        <div className="mt-2 flex items-center gap-1.5 rounded bg-amber-50 px-2 py-1 font-mono text-[9px] text-amber-800">
          <Icon.tool size={10} />
          <span className="truncate">{item.tool.name}</span>
          <span className="ml-auto font-sans uppercase">{String(item.tool.status || 'recorded').toLowerCase()}</span>
          {item.tool.durationMs != null && <span className="font-sans text-amber-600">{formatDuration(item.tool.durationMs)}</span>}
        </div>
      )}
      {(item.provider || item.model || item.stopReason) && (
        <div className="mt-2 flex flex-wrap gap-x-2 text-[8px] text-sub">
          {(item.provider || item.model) && <span>{[item.provider, item.model].filter(Boolean).join(' / ')}</span>}
          {item.stopReason && <span>stop: {item.stopReason}</span>}
        </div>
      )}
      {Object.keys(metrics).length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-1">
          <Meta label="Turns" value={metrics.turns ?? '—'} />
          <Meta label="Tools" value={metrics.toolCalls ?? '—'} />
          <Meta label="Tokens" value={metrics.tokens ?? '—'} />
          <Meta label="Input" value={metrics.inputTokens ?? '—'} />
          <Meta label="Output" value={metrics.outputTokens ?? '—'} />
          <Meta label="Wall" value={metrics.wallMs != null ? formatDuration(metrics.wallMs) : '—'} />
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <span className="min-w-0 rounded bg-slate-50 px-1.5 py-1">
      <span className="block text-[7px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className="block truncate text-[9px] text-slate-700" title={String(value)}>{value}</span>
    </span>
  );
}

function ExecutionStatus({ status }) {
  const normalized = String(status || 'UNKNOWN').toUpperCase();
  const color = normalized === 'SUCCEEDED'
    ? 'bg-emerald-50 text-emerald-700'
    : normalized === 'RUNNING'
      ? 'bg-amber-50 text-amber-700'
      : normalized === 'PARTIAL'
        ? 'bg-orange-50 text-orange-700'
        : 'bg-red-50 text-red-700';
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] font-semibold ${color}`}>{normalized}</span>;
}

function LoadingDot() {
  return <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />;
}

function InspectorEmpty({ text }) {
  return (
    <div className="rounded-lg border border-dashed border-line py-6 text-center text-[10px] text-sub">
      <Icon.eye size={20} className="mx-auto mb-2 text-slate-300" />
      {text}
    </div>
  );
}

function activityLabel(item) {
  return String(item.activityType || item.eventType || 'agent event').replace(/^agent\.execution\./u, '');
}

function timelineDot(item) {
  const status = String(item.tool?.status || item.status || '').toUpperCase();
  if (status === 'FAILED' || status === 'PARTIAL') return 'bg-red-500';
  if (status === 'SUCCEEDED') return 'bg-emerald-500';
  if (status === 'RUNNING') return 'bg-amber-500';
  return 'bg-blue-500';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
