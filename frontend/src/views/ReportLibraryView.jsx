import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Markdown, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { Btn, PageHeader } from './Shell.jsx';

const EMPTY_STATUS = {
  reportCount: 0, tickerCount: 0, ingestionCount: 0, backfillCount: 0,
  batchCount: 0, pendingReportCount: 0, processedReportCount: 0,
};

export default function ReportLibraryView() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [tickers, setTickers] = useState([]);
  const [reports, setReports] = useState([]);
  const [selectedTicker, setSelectedTicker] = useState('');
  const [timeline, setTimeline] = useState([]);
  const [selectedReportId, setSelectedReportId] = useState('');
  const [selectedReport, setSelectedReport] = useState(null);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const loadLibraryDashboard = async () => {
    setLoading(true);
    setError('');
    try {
      const [statusResult, batchResult, tickerResult, reportResult] = await Promise.all([
        api.reportLibraryStatus(),
        api.reportLibraryBatches({ limit: 30 }),
        api.reportLibraryTickers(),
        api.reportLibraryReports({ limit: 100 }),
      ]);
      setStatus(statusResult?.status || EMPTY_STATUS);
      setBatches(Array.isArray(batchResult?.batches) ? batchResult.batches : []);
      setTickers(Array.isArray(tickerResult?.tickers) ? tickerResult.tickers : []);
      setReports(Array.isArray(reportResult?.reports) ? reportResult.reports : []);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadLibraryDashboard(); }, []);

  const chooseBatch = async (batch) => {
    const id = batch?.batchId;
    if (!id) return;
    if (selectedBatchId === id) {
      setSelectedBatchId('');
      setSelectedBatch(null);
      return;
    }
    setSelectedBatchId(id);
    setSelectedBatch(null);
    setError('');
    try {
      const result = await api.reportLibraryBatch(id);
      setSelectedBatch(result?.batch || batch);
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  const chooseTicker = async (ticker) => {
    setSelectedTicker(ticker);
    setTimeline([]);
    if (!ticker) return;
    setTimelineLoading(true);
    setError('');
    try {
      const result = await api.reportLibraryTickerTimeline(ticker, 100);
      setTimeline(Array.isArray(result?.reports) ? result.reports : []);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setTimelineLoading(false);
    }
  };

  const chooseReport = async (report) => {
    const id = report?.reportVersionId || report?.id;
    if (!id) return;
    setSelectedReportId(id);
    setSelectedReport(null);
    setContent(null);
    setDetailLoading(true);
    setError('');
    try {
      const [detailResult, contentResult] = await Promise.all([
        api.reportLibraryReport(id),
        api.reportLibraryReportContent(id),
      ]);
      setSelectedReport(detailResult?.report || report);
      setContent(contentResult || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setDetailLoading(false);
    }
  };

  const visibleReports = useMemo(() => selectedTicker ? timeline : reports, [reports, selectedTicker, timeline]);

  if (selectedReportId) {
    return (
      <ReportReader
        report={selectedReport}
        content={content}
        loading={detailLoading}
        error={error}
        onBack={() => { setSelectedReportId(''); setSelectedReport(null); setContent(null); setError(''); }}
        onRetry={() => {
          const report = selectedReport || reports.find((item) => item.reportVersionId === selectedReportId);
          if (report) void chooseReport(report);
        }}
      />
    );
  }

  return (
    <div className="report-library-view flex min-h-0 flex-1 flex-col">
      <PageHeader title="报告库" subtitle="内部研究报告 · 按标的查看不可变报告版本与时间线">
        <Btn variant="ghost" size="sm" onClick={loadLibraryDashboard} disabled={loading}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>
      <div className="report-library-page flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        <StatusOverview status={status} loading={loading} />
        <BatchPanel
          batches={batches}
          selectedBatchId={selectedBatchId}
          selectedBatch={selectedBatch}
          onSelect={chooseBatch}
          loading={loading}
        />
        <div className="mt-5 grid min-h-[520px] grid-cols-1 gap-5 xl:grid-cols-[250px_minmax(0,1fr)]">
          <TickerPanel
            tickers={tickers}
            selectedTicker={selectedTicker}
            onSelect={chooseTicker}
            loading={loading}
          />
          <section className="report-library-panel min-w-0 overflow-hidden rounded-xl border border-line bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">{selectedTicker ? `${selectedTicker} · 报告时间线` : '全部报告'}</h2>
                <p className="mt-0.5 text-[11px] text-sub">{selectedTicker ? '按 as-of 时间查看该标的的历史报告版本' : '每条记录均指向一个独立、不可变的 Markdown 报告版本'}</p>
              </div>
              {selectedTicker && <Btn variant="ghost" size="sm" onClick={() => chooseTicker('')}><Icon.close size={13} />清除标的</Btn>}
            </div>
            {timelineLoading ? <div className="p-8"><Spinner label="加载标的时间线…" /></div> : (
              <ReportList reports={visibleReports} loading={loading} onOpen={chooseReport} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function StatusOverview({ status, loading }) {
  const values = [
    ['Daily Report Batch', status?.batchCount],
    ['报告版本', status?.reportCount],
    ['Pending', status?.pendingReportCount],
    ['Processed', status?.processedReportCount],
    ['覆盖标的', status?.tickerCount],
  ];
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      {values.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-line bg-white px-4 py-3 shadow-sm">
          <div className="text-[11px] text-sub">{label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{loading ? '—' : Number(value || 0).toLocaleString('zh-CN')}</div>
        </div>
      ))}
    </section>
  );
}

function BatchPanel({ batches, selectedBatchId, selectedBatch, onSelect, loading }) {
  return (
    <section className="report-library-panel mt-5 overflow-hidden rounded-xl border border-line bg-white">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Daily Report Batch</h2>
        <p className="mt-0.5 text-[11px] text-sub">显式日级关闭、terminal item outcomes 与 Worldview processing trigger</p>
      </div>
      {loading ? <div className="p-4"><Spinner label="加载 Daily Report Batches…" /></div> : batches.length ? (
        <div>
          <div className="flex gap-2 overflow-x-auto p-3">
            {batches.map((batch) => {
              const summary = batch.summary || batch.completion?.summary || {};
              const selected = selectedBatchId === batch.batchId;
              return (
                <button type="button" key={batch.batchId} onClick={() => onSelect(batch)} className={`min-w-[230px] rounded-lg border px-3 py-2 text-left transition ${selected ? 'border-blue-300 bg-blue-50' : 'border-line hover:bg-slate-50'}`}>
                  <span className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-ink">{batch.productionDate}</span><Badge color={batch.status === 'closed' ? 'green' : 'amber'}>{batch.status}</Badge></span>
                  <span className="mt-1 block text-[10px] text-sub">success {summary.succeeded || 0} · failure {summary.failed || 0}</span>
                  <span className="mt-1 block truncate font-mono text-[9px] text-slate-400">{batch.batchId}</span>
                </button>
              );
            })}
          </div>
          {selectedBatch && (
            <div className="border-t border-line bg-slate-50/60 p-4">
              <div className="grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-4">
                <MetaField label="Batch identity" value={selectedBatch.batchId} mono />
                <MetaField label="Producer lineage" value={`${selectedBatch.producer?.id || '—'} / ${selectedBatch.productionRunId || '—'}`} mono />
                <MetaField label="Closed" value={formatDate(selectedBatch.completion?.closedAt)} />
                <MetaField label="Processing trigger" value={selectedBatch.completion?.processingTrigger?.status || '—'} />
              </div>
              <div className="mt-3 divide-y divide-line rounded-lg border border-line bg-white">
                {(selectedBatch.items || []).map((item) => <BatchItem key={item.itemId} item={item} />)}
              </div>
            </div>
          )}
        </div>
      ) : <div className="p-5 text-xs text-sub">暂无 Daily Report Batch。</div>}
    </section>
  );
}

function BatchItem({ item }) {
  const candidateAdmission = item.outcome?.candidateAdmission || null;
  const admissionColor = candidateAdmission?.status === 'admitted'
    ? 'green'
    : candidateAdmission?.status === 'blocked'
      ? 'red'
      : 'amber';
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-[10px]">
      <div>
        <div className="font-mono text-slate-700">{item.itemId}</div>
        <div className="mt-0.5 text-sub">{item.projectId} · {item.outcome?.analysisRunId || 'no analysis run'}</div>
        {item.outcome?.error && <div className="mt-1 text-red-600">{item.outcome.error.code}: {item.outcome.error.message}</div>}
        {candidateAdmission?.lastAttempt?.error && (
          <div className="mt-1 text-amber-700">Admission retry: {candidateAdmission.lastAttempt.error.code}: {candidateAdmission.lastAttempt.error.message}</div>
        )}
        {candidateAdmission?.nextEligibleAt && <div className="mt-1 text-sub">Next eligible: {formatDate(candidateAdmission.nextEligibleAt)}</div>}
        {item.outcome?.productionAttempts?.length ? <div className="mt-1 flex flex-wrap gap-1">{item.outcome.productionAttempts.map((attempt) => <span key={attempt.attemptId} className={`rounded px-1.5 py-0.5 ${attempt.status === 'succeeded' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>{attempt.attemptId}: {attempt.status}</span>)}</div> : null}
        {item.outcome?.admissionAttempts?.length ? <div className="mt-1 flex flex-wrap gap-1">{item.outcome.admissionAttempts.map((attempt) => <span key={attempt.attemptId} className={`rounded px-1.5 py-0.5 ${attempt.status === 'succeeded' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-600'}`}>{attempt.attemptId}: {attempt.status}</span>)}</div> : null}
      </div>
      <div className="flex gap-1">
        <Badge color={item.status === 'succeeded' ? 'green' : 'red'}>{item.status}</Badge>
        {candidateAdmission && <Badge color={admissionColor}>Admission {candidateAdmission.status}</Badge>}
      </div>
    </div>
  );
}

function TickerPanel({ tickers, selectedTicker, onSelect, loading }) {
  return (
    <aside className="report-library-panel overflow-hidden rounded-xl border border-line bg-white">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">标的时间线</h2>
        <p className="mt-0.5 text-[11px] text-sub">选择一个 ticker 查看历史版本</p>
      </div>
      <div className="max-h-[620px] overflow-auto p-2">
        <button type="button" onClick={() => onSelect('')} className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${!selectedTicker ? 'bg-blue-50 font-semibold text-brand' : 'text-sub hover:bg-slate-50'}`}>
          <span className="flex items-center gap-2"><Icon.layers size={14} />全部报告</span>
        </button>
        {loading ? <div className="p-3"><Spinner label="加载标的…" /></div> : tickers.length ? tickers.map((item) => {
          const ticker = item.ticker || item.symbol;
          return (
            <button type="button" key={ticker} onClick={() => onSelect(ticker)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition ${selectedTicker === ticker ? 'bg-blue-50 text-brand' : 'text-ink hover:bg-slate-50'}`}>
              <span className="flex min-w-0 items-center gap-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-slate-100 font-mono text-[9px] text-slate-500">$</span><span className="truncate font-mono text-xs font-semibold">{ticker}</span></span>
              <span className="ml-2 shrink-0 text-[10px] tabular-nums text-sub">{item.reportCount ?? 0}</span>
            </button>
          );
        }) : <div className="p-4 text-center text-xs text-sub">暂无标的记录。</div>}
      </div>
    </aside>
  );
}

function ReportList({ reports, loading, onOpen }) {
  if (loading && !reports.length) return <div className="p-8"><Spinner label="加载报告…" /></div>;
  if (!reports.length) return <div className="p-10 text-center text-sm text-sub"><Icon.doc size={24} className="mx-auto mb-2 text-slate-300" />暂无报告记录。</div>;
  return (
    <div className="divide-y divide-line">
      {reports.map((report) => <ReportRow key={report.reportVersionId || report.id} report={report} onOpen={() => onOpen(report)} />)}
    </div>
  );
}

function ReportRow({ report, onOpen }) {
  const id = report.reportVersionId || report.id;
  const tickers = Array.isArray(report.tickers) ? report.tickers : [];
  const processingStatus = report.processingStatus === 'Processed' ? 'Processed' : 'Pending';
  return (
    <button type="button" onClick={onOpen} className="group w-full px-4 py-4 text-left transition hover:bg-blue-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-brand"><Icon.doc size={17} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold text-ink">{report.title || '未命名报告'}</span><Badge color="blue">{report.origin || 'internal'}</Badge><Badge color={processingStatus === 'Processed' ? 'green' : 'amber'}>{processingStatus}</Badge></span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-sub">
            {tickers.map((ticker) => <span key={ticker} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">{ticker}</span>)}
            {report.theme && <span>{report.theme}</span>}
          </span>
          <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-sub"><span>as of {formatDate(report.asOf)}</span><span>生成 {formatDate(report.generatedAt)}</span><span className="font-mono text-slate-400">{shortDigest(report.contentDigest)}</span></span>
        </span>
        <Icon.arrowRight size={16} className="mt-2 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand" />
      </div>
      <span className="sr-only">打开报告 {id}</span>
    </button>
  );
}

function ReportReader({ report, content, loading, error, onBack, onRetry }) {
  return (
    <div className="report-library-reader-page flex min-h-0 flex-1 flex-col">
      <PageHeader title={report?.title || '报告详情'} subtitle={report?.reportVersionId || report?.id || '报告库'}>
        <Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回报告库</Btn>
        {error && <Btn variant="ghost" size="sm" onClick={onRetry} disabled={loading}><Icon.refresh size={13} />重试</Btn>}
      </PageHeader>
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        {loading ? <div className="rounded-xl border border-line bg-white p-8"><Spinner label="加载报告详情…" /></div> : report && content ? (
          <div className="mx-auto max-w-7xl space-y-5">
            <ReportMetadata report={report} content={content} />
            <article className="report-library-reader rounded-xl border border-line bg-white px-6 py-7 shadow-sm sm:px-10">
              <Markdown text={content.content} className="daily-report-markdown" />
            </article>
          </div>
        ) : !error ? <div className="rounded-xl border border-line bg-white p-8 text-sm text-sub">报告正文不可用。</div> : null}
      </div>
    </div>
  );
}

function ReportMetadata({ report, content }) {
  const producer = report.producer || {};
  const workflow = producer.workflow || {};
  const lineage = report.lineage || {};
  const daily = report.dailyReport;
  const ingestion = report.ingestion || {};
  return (
    <section className="rounded-xl border border-line bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2"><Badge color="green">不可变版本</Badge><Badge color="blue">{report.origin || 'internal'}</Badge>{report.theme && <Badge color="slate">{report.theme}</Badge>}</div>
      <div className="mt-3 grid grid-cols-1 gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
        <MetaField label="Report Version" value={report.reportVersionId || report.id} mono />
        <MetaField label="内容摘要" value={report.contentDigest} mono />
        <MetaField label="媒体类型" value={`${content.mediaType || report.mediaType || 'text/markdown'} · ${content.charset || report.charset || 'utf-8'}`} />
        <MetaField label="字节数" value={content.byteLength ?? report.byteLength ?? '—'} />
        <MetaField label="Producer" value={producer.type || '—'} />
        <MetaField label="Workflow" value={[workflow.id, workflow.version].filter(Boolean).join(' · ') || '—'} mono />
        <MetaField label="Project / Analysis Run" value={[lineage.projectId, lineage.analysisRunId].filter(Boolean).join(' / ') || '—'} mono />
        <MetaField label="Daily Report" value={daily?.runId || '—'} mono />
        <MetaField label="Admission sequence" value={report.admissionSequence ?? ingestion.admissionSequence ?? '—'} />
        <MetaField label="Processing status" value={report.processingStatus || 'Pending'} />
        <MetaField label="摄入" value={`${ingestion.source || '—'} · ${ingestion.ingestionId || ingestion.id || '—'}`} />
        <MetaField label="As of" value={formatDate(report.asOf)} />
        <MetaField label="Generated" value={formatDate(report.generatedAt)} />
        {report.searchTags?.length ? <MetaField label="Search tags" value={report.searchTags.join(', ')} /> : null}
      </div>
      {Array.isArray(report.tickers) && report.tickers.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{report.tickers.map((ticker) => <span key={ticker} className="rounded bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600">{ticker}</span>)}</div>}
    </section>
  );
}

function MetaField({ label, value, mono = false }) {
  return <div className="min-w-0 rounded-lg bg-slate-50 px-2.5 py-2"><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-0.5 break-words text-slate-700 ${mono ? 'font-mono text-[10px]' : ''}`} title={String(value ?? '')}>{value || '—'}</div></div>;
}

function ErrorBanner({ message }) {
  return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">{message}</div>;
}

function shortDigest(value) {
  const text = String(value || '');
  return text.length > 25 ? `${text.slice(0, 18)}…${text.slice(-6)}` : text || 'digest unavailable';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
