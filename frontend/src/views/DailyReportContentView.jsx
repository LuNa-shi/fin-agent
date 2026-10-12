import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Badge, Markdown, Spinner } from '../components.jsx';
import { ratingLabel } from '../i18n.js';
import { PageHeader, Btn } from './Shell.jsx';
import { formatBytes, projectStatus, scorecardEntries } from './dailyReportPresentation.js';

export default function DailyReportContentView({ runId, projectId, onBack }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadReport = async () => {
    setLoading(true);
    try {
      const next = await api.dailyReportContent(runId, projectId);
      setResult(next);
      setError('');
    } catch (err) {
      setResult(null);
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [runId, projectId]);

  const project = result?.project || null;
  const report = result?.report || null;
  const status = project ? projectStatus(project) : null;

  return (
    <>
      <PageHeader title={project?.title || report?.title || '日报'} subtitle={project?.projectId || projectId}>
        <Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回报告列表</Btn>
        <Btn variant="ghost" size="sm" onClick={loadReport} disabled={loading}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>

      <div className="daily-report-content-page flex-1 min-h-0 overflow-hidden bg-slate-50 p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">
            {error}
          </div>
        )}

        {loading && !report ? (
          <div className="rounded-lg border border-line bg-white p-8"><Spinner label="加载报告..." /></div>
        ) : report?.content ? (
          <section className="daily-report-panel flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-white">
            <div className="daily-report-toolbar border-b border-line px-6 py-4">
              <div className="flex flex-wrap items-center gap-2">
                {status && <Badge color={status.color}>{status.label}</Badge>}
                <Badge color="blue">{formatBytes(report.bytes)}</Badge>
                {project?.conclusionRating && <Badge color="slate">{ratingLabel(project.conclusionRating)}</Badge>}
              </div>
              <DailyScorecards status={project?.scorecardStatus} scorecards={project?.scorecards} />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-sub">
                {(project?.tickers || []).slice(0, 6).map((ticker) => (
                  <span key={ticker} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">{ticker}</span>
                ))}
                {report.wordCount ? <span>{report.wordCount.toLocaleString('zh-CN')} 字词</span> : null}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-slate-50/50">
              <article className="daily-report-reader mx-auto min-h-full max-w-6xl bg-white px-10 py-9">
                <Markdown text={report.content} className="daily-report-markdown" />
              </article>
            </div>
          </section>
        ) : !error ? (
          <div className="rounded-lg border border-line bg-white p-8 text-sm text-sub">该报告没有可读取的正文。</div>
        ) : null}
      </div>
    </>
  );
}

function DailyScorecards({ status, scorecards }) {
  const entries = scorecardEntries(scorecards);
  return (
    <section className="mt-3 rounded-lg border border-line bg-slate-50 px-3 py-2" aria-label="Report scorecards">
      <div className="text-xs font-medium text-ink">Scorecards · 仅展示</div>
      {status !== 'available' || !entries.length ? (
        <p className="mt-1 text-[11px] text-sub">当前报告未提供可验证的 Scorecard 结果。</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {entries.map((entry) => (
            <span key={entry.lens} className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-slate-700">
              {entry.label} · {entry.score == null ? '—' : entry.score.toFixed(2)} · {entry.band || '—'}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
