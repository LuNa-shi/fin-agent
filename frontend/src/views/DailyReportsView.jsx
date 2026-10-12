import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Badge, Spinner } from '../components.jsx';
import { PageHeader, Btn } from './Shell.jsx';
import {
  formatDate,
  formatDuration,
  progressBarColor,
  runProgress,
  stateMeta,
  statusDotColor,
} from './dailyReportPresentation.js';

export default function DailyReportsView({ onOpenRun }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadRuns = async () => {
    setLoading(true);
    try {
      const result = await api.dailyReportRuns(100);
      setRuns(result.runs || []);
      setError('');
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRuns();
    const timer = setInterval(loadRuns, 30000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <PageHeader title="每日报告" subtitle="全部日报批次">
        <Btn variant="ghost" size="sm" onClick={loadRuns} disabled={loading}>
          <Icon.refresh size={14} />刷新
        </Btn>
      </PageHeader>

      <div className="daily-reports-page flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">
            {error}
          </div>
        )}

        <section className="daily-run-list overflow-hidden rounded-lg border border-line bg-white">
          <div className="daily-run-list-head grid items-center gap-4 border-b border-line bg-slate-50 px-4 py-2 text-[11px] font-medium text-sub">
            <span>批次</span>
            <span>状态</span>
            <span>开始时间</span>
            <span>报告</span>
            <span>运行配置</span>
            <span className="sr-only">打开</span>
          </div>

          {loading && !runs.length ? (
            <div className="p-8"><Spinner label="加载日报批次..." /></div>
          ) : runs.length ? runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
          )) : (
            <div className="p-8 text-sm text-sub">暂无每日运行记录。</div>
          )}
        </section>

        <div className="mt-3 text-right text-[11px] text-sub">共 {runs.length} 个批次</div>
      </div>
    </>
  );
}

function RunRow({ run, onOpen }) {
  const state = stateMeta(run.state);
  const progress = runProgress(run);
  const reports = Number(run.verification?.reports || 0);
  const projects = Number(run.verification?.projects || 0);
  const failures = Number(run.verification?.failures?.length || 0);

  return (
    <button type="button" onClick={onOpen}
      className="daily-run-list-row group grid w-full items-center gap-4 border-b border-line px-4 py-3.5 text-left transition last:border-b-0 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink" title={run.runName || run.directoryName}>
          {run.runName || run.directoryName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400" title={run.directoryName}>
          {run.directoryName}
        </span>
      </span>

      <span className="inline-flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotColor(state.color)}`} />
        <Badge color={state.color}>{state.label}</Badge>
        {failures > 0 && <span className="truncate text-[10px] text-red-500">{failures} 项异常</span>}
      </span>

      <span className="min-w-0">
        <span className="block text-xs tabular-nums text-ink">{formatDate(run.startedAt)}</span>
        <span className="mt-0.5 block text-[10px] text-sub">耗时 {formatDuration(run.durationMs)}</span>
      </span>

      <span className="min-w-0">
        <span className="flex items-center justify-between text-xs text-ink">
          <span className="tabular-nums">{reports} / {projects}</span>
          <span className="text-[10px] text-sub">{progress}%</span>
        </span>
        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
          <span className={`block h-full rounded-full ${progressBarColor(state.color)}`} style={{ width: `${progress}%` }} />
        </span>
      </span>

      <span className="min-w-0 text-[11px] text-sub">
        <span className="block truncate">{run.live ? 'Live' : 'Demo'} · {run.configuration?.intensity || '-'}</span>
        <span className="mt-0.5 block truncate" title={`${run.provider?.activeProvider || '-'} / ${run.provider?.activeModel || '-'}`}>
          {run.provider?.activeProvider || '-'} / {run.provider?.activeModel || '-'}
        </span>
      </span>

      <span className="justify-self-end text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand">
        <Icon.arrowRight size={17} />
      </span>
    </button>
  );
}
