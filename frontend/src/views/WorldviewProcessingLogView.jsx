import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { Btn, PageHeader } from './Shell.jsx';

const RUN_PAGE_SIZE = 100;

export default function WorldviewProcessingLogView() {
  const [runs, setRuns] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async ({ cursor = '', append = false } = {}) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const result = await api.worldviewProcessingLog({ limit: RUN_PAGE_SIZE, cursor });
      const pageRuns = Array.isArray(result?.runs) ? result.runs : [];
      setRuns((current) => append ? [...current, ...pageRuns] : pageRuns);
      setNextCursor(result?.nextCursor || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openRun = async (run) => {
    setSelected(run);
    setDetailLoading(true);
    setError('');
    try {
      const result = await api.worldviewProcessingRun(run.runId);
      setSelected(result?.run || run);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setDetailLoading(false);
    }
  };

  if (selected) {
    return (
      <RunDetail
        run={selected}
        loading={detailLoading}
        error={error}
        onBack={() => { setSelected(null); setError(''); }}
      />
    );
  }

  const succeededRuns = runs.filter((run) => run.state === 'succeeded');
  const processedReceiptCount = succeededRuns.reduce(
    (total, run) => total + Number(run.processedReceiptCount ?? run.overviewCount ?? 0),
    0,
  );

  return (
    <div className="worldview-processing-log-view flex min-h-0 flex-1 flex-col">
      <PageHeader title="Worldview Processing Log" subtitle="每个有界 Core Worldview Agent Run 的冻结输入、完整读取与 KEEP / UPDATE 结果">
        <Btn variant="ghost" size="sm" onClick={() => { void load(); }} disabled={loading || loadingMore}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        <section className="mb-5 grid gap-3 sm:grid-cols-3">
          <Metric label="Processed receipts in loaded pages" value={processedReceiptCount} />
          <Metric label="Succeeded runs in loaded pages" value={succeededRuns.length} />
          <Metric label="Durable runs in loaded pages" value={runs.length} />
        </section>
        <section className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Worldview Agent Runs</h2>
            <p className="mt-0.5 text-[11px] text-sub">Run history is separate from Worldview Version history. KEEP remains here and creates no Version. Counts cover loaded pages only.</p>
          </div>
          {loading ? <div className="p-8"><Spinner label="加载 Processing Log…" /></div> : runs.length ? (
            <>
              <div className="divide-y divide-line">
                {runs.map((run) => <RunRow key={run.runId} run={run} onOpen={() => openRun(run)} />)}
              </div>
              {nextCursor && (
                <div className="border-t border-line p-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void load({ cursor: nextCursor, append: true }); }} disabled={loadingMore}>
                    {loadingMore ? 'Loading more Runs…' : 'Load more Runs'}
                  </Btn>
                </div>
              )}
            </>
          ) : <div className="p-10 text-center text-sm text-sub">暂无 Worldview Agent Run。</div>}
        </section>
      </div>
    </div>
  );
}

function RunRow({ run, onOpen }) {
  const reads = Array.isArray(run.selectedFullReads) ? run.selectedFullReads : [];
  const acceptedClaimActionCount = Number(run.acceptedClaimActionCount || 0);
  const rejectedClaimActionCount = Number(run.rejectedClaimActionCount || 0);
  return (
    <button type="button" onClick={onOpen} className="group w-full px-4 py-4 text-left transition hover:bg-blue-50/40">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-brand"><Icon.globe size={17} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-ink">{run.runId}</span>
            <Badge color={stateColor(run.state)}>{run.state}</Badge>
            {run.outcome && <Badge color={run.outcome === 'UPDATE' ? 'blue' : 'slate'}>{run.outcome}</Badge>}
          </span>
          <span className="mt-1 block text-xs text-slate-700">{run.rationale || run.failure?.message || 'Run frozen; result pending.'}</span>
          <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-sub">
            <span>{formatDate(run.startedAt)}</span>
            <span>range {run.frozenRange?.startAdmissionSequence ?? '—'} → {run.frozenRange?.endAdmissionSequence ?? '—'}</span>
            <span>{run.overviewCount || 0} Overviews</span>
            <span>{reads.length} selected full reads</span>
            <span>attempts {run.retryMetadata?.agentAttempts ?? 0}/{run.retryMetadata?.maxAttempts ?? 1}</span>
            <span>{acceptedClaimActionCount} accepted / {rejectedClaimActionCount} rejected Claim actions</span>
          </span>
        </span>
        <Icon.arrowRight size={16} className="mt-2 shrink-0 text-slate-300 group-hover:text-brand" />
      </div>
    </button>
  );
}

function RunDetail({ run, loading, error, onBack }) {
  const reads = Array.isArray(run?.selectedFullReads) ? run.selectedFullReads : [];
  const manifest = Array.isArray(run?.overviewManifest) ? run.overviewManifest : [];
  const attempts = Array.isArray(run?.attempts) ? run.attempts : [];
  const acceptedClaimActions = Array.isArray(run?.acceptedClaimActions) ? run.acceptedClaimActions : [];
  const rejectedClaimActions = Array.isArray(run?.rejectedClaimActions) ? run.rejectedClaimActions : [];
  const processedReceipts = Array.isArray(run?.processedReceipts) ? run.processedReceipts : [];
  return (
    <div className="worldview-processing-run-detail flex min-h-0 flex-1 flex-col">
      <PageHeader title="Worldview Agent Run" subtitle={run?.runId || 'Processing Log'}>
        <Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回 Processing Log</Btn>
      </PageHeader>
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        {loading ? <Spinner label="加载 Worldview Agent Run…" /> : (
          <div className="mx-auto max-w-7xl space-y-5">
            <section className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color={stateColor(run.state)}>{run.state}</Badge>
                {run.outcome && <Badge color={run.outcome === 'UPDATE' ? 'blue' : 'slate'}>{run.outcome}</Badge>}
                <span className="text-[11px] text-sub">Worldview outcome</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">{run.rationale || run.failure?.message || 'No final rationale yet.'}</p>
              <div className="mt-4 grid gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Worldview outcome" value={run.outcome || 'not published'} />
                <Field label="Publication ID" value={run.publicationId} mono />
                <Field label="Publication digest" value={run.publicationDigest} mono />
                <Field label="Resulting Worldview Version" value={run.resultingWorldviewVersionId || 'No new Version'} mono />
                <Field label="Evaluation record" value={run.evaluationRecordId || '—'} mono />
                <Field label="Started" value={formatDate(run.startedAt)} />
                <Field label="Completed" value={formatDate(run.completedAt || run.updatedAt)} />
                <Field label="Run failure code" value={run.failure?.code || '—'} mono />
              </div>
              <p className="mt-3 text-[11px] text-sub">Worldview Version history remains separate. A KEEP outcome stays in this Processing Log and does not create a Version.</p>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Frozen input and configuration</h2>
              <div className="mt-3 grid gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Frozen report range" value={`${run.frozenRange?.startAdmissionSequence ?? '—'} → ${run.frozenRange?.endAdmissionSequence ?? '—'}`} />
                <Field label="Overview count" value={run.overviewCount ?? 0} />
                <Field label="Manifest digest" value={run.overviewManifestDigest} mono />
                <Field label="Base Worldview" value={run.frozenBaseWorldviewVersionId || 'bootstrap'} mono />
                <Field label="Workspace ID" value={run.workspaceId} mono />
                <Field label="Workspace digest" value={run.workspaceDigest} mono />
                <Field label="Effective Agent config" value={run.effectiveConfig?.effectiveConfigDigest} mono />
                <Field label="Captured provider" value={run.effectiveConfig?.capturedRoute?.provider} mono />
                <Field label="Captured model" value={run.effectiveConfig?.capturedRoute?.model} mono />
                <Field label="Captured reasoning level" value={run.effectiveConfig?.capturedRoute?.reasoningLevel} />
                <Field label="Retry metadata" value={`${run.retryMetadata?.agentAttempts ?? 0}/${run.retryMetadata?.maxAttempts ?? 1}${run.retryMetadata?.resumed ? ' · resumed' : ''}`} />
                <Field label="Claim Actions" value={run.claimActionCount ?? 0} />
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Core Worldview attempts</h2>
              <p className="mt-0.5 text-[11px] text-sub">Every complete attempt uses the frozen workspace. Model API retry is the inner retry policy for that attempt.</p>
              <div className="mt-3 space-y-3">
                {attempts.length ? attempts.map((attempt) => <AttemptRecord key={attempt.attemptId || attempt.attempt} attempt={attempt} />) : <Empty text="No complete attempt record returned." />}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Accepted Claim actions</h2>
              <p className="mt-0.5 text-[11px] text-sub">Accepted actions are immutable Claim Library audit records published with this Worldview outcome.</p>
              <div className="mt-3 space-y-3">
                {acceptedClaimActions.length ? acceptedClaimActions.map((action) => <AcceptedClaimAction key={action.actionRecordId || action.actionId} action={action} />) : <Empty text="No accepted Claim actions." />}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Rejected Claim actions</h2>
              <p className="mt-0.5 text-[11px] text-sub">A rejected item does not block valid Claim actions or the Worldview publication.</p>
              <div className="mt-3 space-y-3">
                {rejectedClaimActions.length ? rejectedClaimActions.map((rejection) => <RejectedClaimAction key={rejection.rejectionId || `${rejection.actionIndex}:${rejection.code}`} rejection={rejection} />) : <Empty text="No rejected Claim actions." />}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Processed ReportVersion receipts</h2>
              <p className="mt-0.5 text-[11px] text-sub">Exact immutable receipts prove which admitted ReportVersions became Processed in this publication.</p>
              <div className="mt-3 space-y-3">
                {processedReceipts.length ? processedReceipts.map((receipt) => <ReceiptRecord key={receipt.receiptId} receipt={receipt} />) : <Empty text="No Processed receipts. Failed runs leave reports Pending." />}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Selected exact ReportVersion reads</h2>
              <div className="mt-3 space-y-2">
                {reads.length ? reads.map((read) => (
                  <div key={read.reportVersionId} className="grid gap-2 rounded-lg border border-line bg-slate-50 p-3 text-[11px] md:grid-cols-3">
                    <Field label="ReportVersion ID" value={read.reportVersionId} mono flat />
                    <Field label="Content digest" value={read.contentDigest} mono flat />
                    <Field label="Fingerprint" value={read.fingerprint} mono flat />
                  </div>
                )) : <Empty text="No full ReportVersion reads were selected." />}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Frozen ordered Overview manifest</h2>
              <div className="mt-3 divide-y divide-line rounded-lg border border-line">
                {manifest.length ? manifest.map((item) => <div key={item.overviewId} className="px-3 py-2 text-[11px]"><div className="font-mono text-slate-700">#{item.admissionSequence} · {item.reportVersionId}</div><div className="mt-1 break-all font-mono text-[10px] text-sub">{item.overviewId} · {item.overviewDigest} · {item.contentDigest} · {item.fingerprint}</div></div>) : <div className="p-3 text-xs text-sub">No Overview manifest returned.</div>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function AttemptRecord({ attempt }) {
  return (
    <article className={`rounded-lg border p-3 ${attempt.status === 'succeeded' ? 'border-emerald-100 bg-emerald-50/30' : 'border-red-100 bg-red-50/30'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={attempt.status === 'succeeded' ? 'green' : 'red'}>{attempt.status}</Badge>
        <span className="font-mono text-[10px] text-slate-600">{attempt.attemptId || `attempt-${attempt.attempt}`}</span>
        <span className="text-[10px] text-sub">{attempt.provider || '—'} · {attempt.model || '—'}{attempt.live ? ' · live' : ''}</span>
      </div>
      {attempt.failure?.message && <p className="mt-2 text-xs leading-5 text-red-600">{attempt.failure.message}</p>}
      <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Model API retry" value={formatRetry(attempt.modelApiRetry)} mono flat />
        <Field label="Model API attempts" value={attempt.modelApiAttempts ?? '—'} flat />
        <Field label="Failure code" value={attempt.failure?.code || '—'} mono flat />
        <Field label="Stop reason" value={attempt.stopReason || '—'} mono flat />
        <Field label="Workspace digest" value={attempt.workspaceDigest} mono flat wide />
        <Field label="Capability scope" value={attempt.capabilityScopeId} mono flat />
        <Field label="Selected full reads" value={attempt.selectedFullReads?.length ?? 0} flat />
      </div>
    </article>
  );
}

function AcceptedClaimAction({ action }) {
  return (
    <article className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="green">accepted {action.action}</Badge>
        <span className="font-mono text-[10px] text-slate-600">{action.actionRecordId || action.actionId}</span>
        <span className="text-[10px] text-sub">{formatDate(action.recordedAt)}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-700">{action.rationale || 'No action rationale returned.'}</p>
      <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Action ID" value={action.actionId} mono flat />
        <Field label="Target Claim" value={claimReference(action.target)} mono flat />
        <Field label="Result Claim" value={claimReference(action.resultClaim)} mono flat />
        <Field label="Originating run" value={action.originatingRunId} mono flat />
        <Field label="Publication ID" value={action.publicationId} mono flat />
        <Field label="Action integrity digest" value={action.integrityDigest} mono flat wide />
      </div>
      <ExactEvidence evidence={action.evidence} />
    </article>
  );
}

function RejectedClaimAction({ rejection }) {
  return (
    <article className="rounded-lg border border-red-100 bg-red-50/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="red">rejected {rejection.action || 'Claim action'}</Badge>
        <span className="font-mono text-[10px] text-red-600">{rejection.code}</span>
        <span className="text-[10px] text-sub">{formatDate(rejection.rejectedAt)}</span>
      </div>
      <div className="mt-2 text-[9px] uppercase tracking-wide text-slate-400">Rejection reason</div>
      <p className="mt-0.5 text-xs leading-5 text-slate-700">{rejection.reason || 'No rejection reason returned.'}</p>
      <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Rejection ID" value={rejection.rejectionId} mono flat />
        <Field label="Action ID" value={rejection.actionId} mono flat />
        <Field label="Target Claim" value={claimReference(rejection.target)} mono flat />
        <Field label="Originating run" value={rejection.originatingRunId} mono flat />
        <Field label="Publication ID" value={rejection.publicationId} mono flat />
        <Field label="Action integrity digest" value={rejection.integrityDigest} mono flat wide />
      </div>
    </article>
  );
}

function ReceiptRecord({ receipt }) {
  return (
    <article className="rounded-lg border border-blue-100 bg-blue-50/30 p-3">
      <div className="flex flex-wrap items-center gap-2"><Badge color="blue">Processed</Badge><span className="font-mono text-[10px] text-slate-600">{receipt.reportVersionId}</span><span className="text-[10px] text-sub">{formatDate(receipt.processedAt)}</span></div>
      <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Receipt ID" value={receipt.receiptId} mono flat />
        <Field label="Receipt digest" value={receipt.receiptDigest} mono flat />
        <Field label="Admission sequence" value={receipt.admissionSequence} flat />
        <Field label="Processed at" value={formatDate(receipt.processedAt)} flat />
        <Field label="Content digest" value={receipt.contentDigest} mono flat />
        <Field label="Fingerprint" value={receipt.fingerprint} mono flat />
        <Field label="Publication ID" value={receipt.publicationId} mono flat />
        <Field label="Run ID" value={receipt.runId} mono flat />
      </div>
    </article>
  );
}

function ExactEvidence({ evidence = [] }) {
  return evidence.length ? (
    <div className="mt-2 space-y-1 rounded-lg bg-white/70 p-2">
      <div className="text-[9px] uppercase tracking-wide text-slate-400">Exact action evidence</div>
      {evidence.map((item) => <div key={`${item.reportVersionId}:${item.contentDigest}`} className="break-all font-mono text-[10px] text-sub">{item.reportVersionId} · {item.contentDigest} · {item.fingerprint}</div>)}
    </div>
  ) : null;
}

function Metric({ label, value, mono = false }) {
  return <div className="rounded-xl border border-line bg-white px-4 py-3"><div className="text-[11px] text-sub">{label}</div><div className={`mt-1 break-all text-lg font-semibold text-ink ${mono ? 'font-mono text-xs' : ''}`}>{value}</div></div>;
}
function Field({ label, value, mono = false, wide = false, flat = false }) {
  return <div className={`${wide ? 'xl:col-span-2' : ''} ${flat ? '' : 'rounded-lg bg-slate-50 px-2.5 py-2'}`}><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-0.5 break-all text-slate-700 ${mono ? 'font-mono text-[10px]' : ''}`}>{value ?? '—'}</div></div>;
}
function Empty({ text }) { return <div className="rounded-lg border border-dashed border-line p-3 text-xs text-sub">{text}</div>; }
function ErrorBanner({ message }) { return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">{message}</div>; }
function stateColor(state) { const normalized = String(state || '').toLowerCase(); return normalized === 'succeeded' ? 'green' : normalized.includes('failed') ? 'red' : 'amber'; }
function claimReference(value) { return value ? `${value.claimId} v${value.version ?? value.expectedVersion ?? '—'}` : '—'; }
function formatRetry(value) { if (!value) return '—'; return Object.entries(value).map(([key, item]) => `${key}=${item}`).join(' · '); }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); }
