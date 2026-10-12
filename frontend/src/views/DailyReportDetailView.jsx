import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Badge, Spinner } from '../components.jsx';
import { ratingLabel } from '../i18n.js';
import { PageHeader, Btn } from './Shell.jsx';
import {
  formatBytes,
  scorecardEntries,
  projectIssue,
  projectStatus,
  statusDotColor,
} from './dailyReportPresentation.js';

export default function DailyReportDetailView({ runId, onBack, onOpenReport }) {
  const [run, setRun] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadRun = async () => {
    setLoading(true);
    try {
      const result = await api.dailyReportRun(runId);
      setRun(result.run || null);
      setError('');
    } catch (err) {
      setRun(null);
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedProjectId('');
    loadRun();
  }, [runId]);

  const projects = run?.projects || [];

  return (
    <>
      <PageHeader title={run?.runName || '日报批次'} subtitle={run?.directoryName || runId}>
        <Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回批次</Btn>
        <Btn variant="ghost" size="sm" onClick={loadRun} disabled={loading}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>

      <div className="daily-report-detail-page flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">
            {error}
          </div>
        )}

        {loading && !run ? (
          <div className="rounded-lg border border-line bg-white p-8"><Spinner label="加载报告列表..." /></div>
        ) : run ? (
          <section className="daily-project-list overflow-hidden rounded-lg border border-line bg-white">
            <div className="daily-project-list-head grid items-center gap-4 border-b border-line bg-slate-50 px-4 py-2 text-[11px] font-medium text-sub">
              <span>报告</span>
              <span>标的与主题</span>
              <span>状态</span>
              <span>Scorecards</span>
              <span>评级</span>
              <span>大小</span>
              <span className="sr-only">打开</span>
            </div>
            {projects.length ? projects.map((project) => (
              <ReportRow
                key={project.projectId}
                project={project}
                selected={project.projectId === selectedProjectId}
                onSelect={() => setSelectedProjectId(project.projectId)}
                onOpen={() => onOpenReport(project.projectId)}
              />
            )) : (
              <div className="p-8 text-sm text-sub">该批次没有项目记录。</div>
            )}
          </section>
        ) : (
          <div className="rounded-lg border border-line bg-white p-8 text-sm text-sub">未找到该日报批次。</div>
        )}
      </div>
    </>
  );
}

function ReportRow({ project, selected, onSelect, onOpen }) {
  const status = projectStatus(project);
  const issue = projectIssue(project);
  const canOpen = Boolean(project.report?.exists);
  const scorecards = scorecardEntries(project.scorecards);
  const open = () => {
    if (canOpen) onOpen();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={open}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.key === 'Enter') open();
        if (event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`daily-project-list-row group relative grid w-full items-center gap-4 border-b border-line px-4 py-3.5 text-left transition last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${selected ? 'is-active bg-blue-50/80' : 'hover:bg-slate-50'}`}
    >
      <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${selected ? statusDotColor(status.color) : 'bg-transparent'}`} />

      <span className="min-w-0">
        <span className="flex items-start gap-2">
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">#{Number(project.index || 0) + 1}</span>
          <span className="line-clamp-2 text-sm font-medium leading-snug text-ink">{project.title || project.projectId}</span>
        </span>
        <span className="mt-1 block truncate font-mono text-[10px] text-slate-400">{project.projectId}</span>
      </span>

      <span className="min-w-0 text-[11px] text-sub">
        <span className="flex flex-wrap gap-1.5">
          {(project.tickers || []).slice(0, 4).map((ticker) => (
            <span key={ticker} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">{ticker}</span>
          ))}
        </span>
        <span className="mt-1 block truncate">{project.theme || '-'}</span>
      </span>

      <span className="min-w-0">
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(status.color)}`} />
          <Badge color={status.color}>{status.label}</Badge>
        </span>
        {issue && <span className="mt-1 block truncate text-[10px] text-red-500">{issue}</span>}
      </span>

      <span className="min-w-0 text-[11px] text-sub">
        {project.scorecardStatus === 'available' && scorecards.length
          ? scorecards.map((entry) => (
            <span key={entry.lens} className="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5">
              {entry.label} {entry.score == null ? '—' : entry.score.toFixed(1)} · {entry.band || '—'}
            </span>
          ))
          : <span>Unavailable</span>}
      </span>

      <span className="text-xs text-sub">{ratingLabel(project.conclusionRating)}</span>
      <span className="text-xs tabular-nums text-sub">{formatBytes(project.report?.bytes)}</span>

      <button
        type="button"
        aria-label={`打开报告：${project.title || project.projectId}`}
        title={canOpen ? '打开报告' : '报告不可用'}
        disabled={!canOpen}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
        className="grid h-8 w-8 place-items-center justify-self-end rounded-lg text-slate-400 transition hover:bg-blue-50 hover:text-brand disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Icon.arrowRight size={16} />
      </button>
    </div>
  );
}
