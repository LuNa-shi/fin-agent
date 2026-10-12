import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { Btn, PageHeader } from './Shell.jsx';

const CLAIM_PAGE_SIZE = 100;
const CLAIM_HISTORY_PAGE_SIZE = 50;

export default function ClaimLibraryView() {
  const [claims, setClaims] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState('');
  const [error, setError] = useState('');

  const load = async ({ cursor = '', append = false } = {}) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const result = await api.claims({ limit: CLAIM_PAGE_SIZE, cursor });
      const pageClaims = Array.isArray(result?.claims) ? result.claims : [];
      setClaims((current) => append ? [...current, ...pageClaims] : pageClaims);
      setNextCursor(result?.nextCursor || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openClaim = async (summary) => {
    setSelected(summary);
    setHistory(null);
    setDetailLoading(true);
    setError('');
    try {
      const [detailResult, historyResult] = await Promise.all([
        api.claim(summary.claimId),
        api.claimHistory(summary.claimId, {
          versionsLimit: CLAIM_HISTORY_PAGE_SIZE,
          actionsLimit: CLAIM_HISTORY_PAGE_SIZE,
          rejectionsLimit: CLAIM_HISTORY_PAGE_SIZE,
        }),
      ]);
      setSelected(detailResult?.claim || summary);
      setHistory(historyResult?.history || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setDetailLoading(false);
    }
  };

  const loadMoreHistory = async (section) => {
    if (!selected?.claimId || !history || historyLoadingMore) return;
    const cursor = history.nextCursors?.[section];
    if (!cursor) return;
    setHistoryLoadingMore(section);
    setError('');
    try {
      const result = await api.claimHistory(selected.claimId, {
        versionsLimit: section === 'versions' ? CLAIM_HISTORY_PAGE_SIZE : 1,
        versionsCursor: section === 'versions' ? cursor : String(history.totalCounts?.versions || 0),
        actionsLimit: section === 'actions' ? CLAIM_HISTORY_PAGE_SIZE : 1,
        actionsCursor: section === 'actions' ? cursor : String(history.totalCounts?.actions || 0),
        rejectionsLimit: section === 'rejections' ? CLAIM_HISTORY_PAGE_SIZE : 1,
        rejectionsCursor: section === 'rejections' ? cursor : String(history.totalCounts?.rejections || 0),
      });
      const page = result?.history;
      if (!page) return;
      setHistory((current) => current ? {
        ...current,
        [section]: [...current[section], ...(page[section] || [])],
        nextCursors: {
          ...current.nextCursors,
          [section]: page.nextCursors?.[section] || null,
        },
      } : page);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setHistoryLoadingMore('');
    }
  };

  if (selected) {
    return (
      <ClaimDetail
        claim={selected}
        history={history}
        loading={detailLoading}
        historyLoadingMore={historyLoadingMore}
        error={error}
        onLoadMoreHistory={loadMoreHistory}
        onBack={() => { setSelected(null); setHistory(null); setHistoryLoadingMore(''); setError(''); }}
      />
    );
  }

  return (
    <div className="claim-library-view flex min-h-0 flex-1 flex-col">
      <PageHeader title="Claim Library" subtitle="Current Investment Claims with exact evidence and immutable version lineage">
        <Btn variant="ghost" size="sm" onClick={() => { void load(); }} disabled={loading || loadingMore}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>
      <div className="claim-library-page flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        <section className="claim-library-panel mx-auto max-w-7xl overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Current Claims</h2>
              <p className="mt-0.5 text-[11px] text-sub">Read-only Claim projection. Open a Claim for exact evidence, actions, and every immutable version.</p>
            </div>
            <Badge color="blue">{claims.length} Claims loaded</Badge>
          </div>
          {loading ? <div className="p-8"><Spinner label="加载 Claim Library…" /></div> : claims.length ? (
            <>
              <div className="divide-y divide-line">{claims.map((claim) => <ClaimRow key={claim.claimId} claim={claim} onOpen={() => openClaim(claim)} />)}</div>
              {nextCursor && (
                <div className="border-t border-line p-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void load({ cursor: nextCursor, append: true }); }} disabled={loadingMore}>
                    {loadingMore ? 'Loading more Claims…' : 'Load more Claims'}
                  </Btn>
                </div>
              )}
            </>
          ) : <div className="p-10 text-center text-sm text-sub">暂无 Claim。</div>}
        </section>
      </div>
    </div>
  );
}

function ClaimRow({ claim, onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group w-full px-4 py-3 text-left transition hover:bg-blue-50/40">
      <span className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600"><Icon.target size={15} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold leading-5 text-ink">{claim.assertion}</span>
            <Badge color="violet">v{claim.version}</Badge>
            {(claim.tickers || []).map((ticker) => <Badge key={ticker}>{ticker}</Badge>)}
          </span>
          <span className="mt-1 block text-xs text-slate-600">{claim.subject}</span>
          <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-sub">
            <span>{verificationSummary(claim.verification)}</span>
            <span>{claim.evidence?.length || 0} exact evidence reference{claim.evidence?.length === 1 ? '' : 's'}</span>
            <span>updated {formatDate(claim.updatedAt)}</span>
          </span>
        </span>
        <Icon.arrowRight size={16} className="mt-2 shrink-0 text-slate-300 group-hover:text-brand" />
      </span>
    </button>
  );
}

function ClaimDetail({ claim, history, loading, historyLoadingMore, error, onLoadMoreHistory, onBack }) {
  const versions = Array.isArray(history?.versions) ? history.versions : [];
  const actions = Array.isArray(history?.actions) ? history.actions : [];
  const rejections = Array.isArray(history?.rejections) ? history.rejections : [];
  return (
    <div className="claim-detail-view flex min-h-0 flex-1 flex-col">
      <PageHeader title="Claim detail" subtitle={claim.claimId}>
        <Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回 Claim Library</Btn>
      </PageHeader>
      <div className="claim-library-page flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        {loading ? <Spinner label="加载 Claim detail…" /> : (
          <div className="mx-auto max-w-7xl space-y-5">
            <section className="rounded-xl border border-line bg-white p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color="violet">Claim v{claim.version}</Badge>
                {(claim.tickers || []).map((ticker) => <Badge key={ticker}>{ticker}</Badge>)}
                <Badge color="green">immutable record</Badge>
              </div>
              <div className="mt-4">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Assertion</div>
                <p className="mt-1 text-base font-semibold leading-7 text-ink">{claim.assertion}</p>
                <p className="mt-3 text-sm leading-6 text-slate-700">{claim.rationale}</p>
              </div>
              <div className="mt-4 grid gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Subject" value={claim.subject} />
                <Field label="Tickers" value={claim.tickers?.join(', ') || '—'} mono />
                <Field label="Version" value={`${claim.version}${claim.previousVersion ? ` · previous v${claim.previousVersion}` : ' · first version'}`} />
                <Field label="Metric" value={claim.metric} />
                <Field label="Verification point" value={claim.verification?.pointAt ? formatDate(claim.verification.pointAt) : '—'} />
                <Field label="Verification window" value={formatVerificationWindow(claim.verification?.window)} />
                <Field label="Acceptance condition" value={claim.acceptanceCondition} />
                <Field label="Invalidation condition" value={claim.invalidationCondition} />
                <Field label="Originating run" value={claim.originatingRunId} mono />
                <Field label="Publication ID" value={claim.publicationId} mono />
                <Field label="Created" value={formatDate(claim.createdAt)} />
                <Field label="Updated" value={formatDate(claim.updatedAt)} />
                <Field label="Integrity digest" value={claim.integrityDigest} mono wide />
              </div>
            </section>

            <EvidenceSection evidence={claim.evidence} />

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Immutable Claim history</h2>
              <p className="mt-0.5 text-[11px] text-sub">Immutable versions are loaded newest first in bounded pages. Prior versions are never rewritten.</p>
              <div className="mt-3 space-y-3">
                {versions.length ? versions.map((version) => <VersionRecord key={`${version.claimId}:${version.version}`} claim={version} />) : <Empty text="No Claim versions returned." />}
              </div>
              {history?.nextCursors?.versions && (
                <div className="mt-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void onLoadMoreHistory('versions'); }} disabled={Boolean(historyLoadingMore)}>
                    {historyLoadingMore === 'versions' ? 'Loading more Claim Versions…' : 'Load more Claim Versions'}
                  </Btn>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Claim action history</h2>
              <p className="mt-0.5 text-[11px] text-sub">Accepted ADD, UPDATE, and NOOP records are loaded newest first in bounded pages.</p>
              <div className="mt-3 space-y-3">
                {actions.length ? actions.map((action) => <ActionRecord key={action.actionRecordId} action={action} />) : <Empty text="No accepted Claim actions returned." />}
              </div>
              {history?.nextCursors?.actions && (
                <div className="mt-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void onLoadMoreHistory('actions'); }} disabled={Boolean(historyLoadingMore)}>
                    {historyLoadingMore === 'actions' ? 'Loading more Claim Actions…' : 'Load more Claim Actions'}
                  </Btn>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-line bg-white p-4">
              <h2 className="text-sm font-semibold text-ink">Claim rejection history</h2>
              <p className="mt-0.5 text-[11px] text-sub">Every rejection tied to this Claim is loaded newest first in bounded pages.</p>
              <div className="mt-3 space-y-3">
                {rejections.length ? rejections.map((rejection) => <RejectionRecord key={rejection.rejectionId} rejection={rejection} />) : <Empty text="No rejected Claim actions returned." />}
              </div>
              {history?.nextCursors?.rejections && (
                <div className="mt-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void onLoadMoreHistory('rejections'); }} disabled={Boolean(historyLoadingMore)}>
                    {historyLoadingMore === 'rejections' ? 'Loading more Claim Rejections…' : 'Load more Claim Rejections'}
                  </Btn>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function EvidenceSection({ evidence = [] }) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="text-sm font-semibold text-ink">Exact evidence</h2>
      <p className="mt-0.5 text-[11px] text-sub">Digest-bound ReportVersion references used by this Claim version.</p>
      <div className="mt-3 space-y-2">
        {evidence.length ? evidence.map((reference) => (
          <div key={`${reference.reportVersionId}:${reference.contentDigest}:${reference.fingerprint}`} className="grid gap-2 rounded-lg border border-line bg-slate-50 p-3 text-[11px] lg:grid-cols-3">
            <Field label="ReportVersion ID" value={reference.reportVersionId} mono flat />
            <Field label="Content digest" value={reference.contentDigest} mono flat />
            <Field label="Fingerprint" value={reference.fingerprint} mono flat />
          </div>
        )) : <Empty text="No exact evidence returned." />}
      </div>
    </section>
  );
}

function VersionRecord({ claim }) {
  return (
    <article className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="violet">v{claim.version}</Badge>
        {(claim.tickers || []).map((ticker) => <Badge key={ticker}>{ticker}</Badge>)}
        <span className="text-xs font-semibold text-ink">{claim.assertion}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{claim.rationale}</p>
      <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-2 xl:grid-cols-4">
        <Field label="Subject" value={claim.subject} flat />
        <Field label="Tickers" value={claim.tickers?.join(', ') || '—'} mono flat />
        <Field label="Version" value={`${claim.version}${claim.previousVersion ? ` · previous v${claim.previousVersion}` : ' · first version'}`} flat />
        <Field label="Metric" value={claim.metric} flat />
        <Field label="Verification point" value={claim.verification?.pointAt ? formatDate(claim.verification.pointAt) : '—'} flat />
        <Field label="Verification window" value={formatVerificationWindow(claim.verification?.window)} flat />
        <Field label="Acceptance condition" value={claim.acceptanceCondition} flat />
        <Field label="Invalidation condition" value={claim.invalidationCondition} flat />
        <Field label="Originating run" value={claim.originatingRunId} mono flat />
        <Field label="Publication ID" value={claim.publicationId} mono flat />
        <Field label="Created" value={formatDate(claim.createdAt)} flat />
        <Field label="Updated" value={formatDate(claim.updatedAt)} flat />
        <Field label="Integrity digest" value={claim.integrityDigest} mono flat wide />
      </div>
      <EvidenceSectionInline evidence={claim.evidence} />
    </article>
  );
}

function EvidenceSectionInline({ evidence = [] }) {
  return evidence.length ? <div className="mt-2 text-[10px] text-sub">Exact evidence: {evidence.map((item) => `${item.reportVersionId} · ${item.contentDigest} · ${item.fingerprint}`).join(' | ')}</div> : null;
}

function ActionRecord({ action }) {
  return (
    <article className="rounded-lg border border-emerald-100 bg-emerald-50/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="green">accepted {action.action}</Badge>
        <span className="font-mono text-[10px] text-slate-600">{action.actionRecordId}</span>
        <span className="text-[10px] text-sub">{formatDate(action.recordedAt)}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-700">{action.rationale}</p>
      <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-2 xl:grid-cols-4">
        <Field label="Action ID" value={action.actionId} mono flat />
        <Field label="Target Claim" value={claimReference(action.target)} mono flat />
        <Field label="Result Claim" value={claimReference(action.resultClaim)} mono flat />
        <Field label="Originating run" value={action.originatingRunId} mono flat />
        <Field label="Publication ID" value={action.publicationId} mono flat />
        <Field label="Recorded" value={formatDate(action.recordedAt)} flat />
        <Field label="Integrity digest" value={action.integrityDigest} mono flat wide />
      </div>
      <EvidenceSectionInline evidence={action.evidence} />
    </article>
  );
}

function RejectionRecord({ rejection }) {
  return (
    <article className="rounded-lg border border-red-100 bg-red-50/40 p-3">
      <div className="flex flex-wrap items-center gap-2"><Badge color="red">rejected {rejection.action || 'Claim action'}</Badge><span className="font-mono text-[10px] text-red-600">{rejection.code}</span><span className="text-[10px] text-sub">{formatDate(rejection.rejectedAt)}</span></div>
      <p className="mt-2 text-xs leading-5 text-slate-700">{rejection.reason}</p>
      <div className="mt-2 grid gap-2 text-[11px] md:grid-cols-2 xl:grid-cols-4">
        <Field label="Rejection ID" value={rejection.rejectionId} mono flat />
        <Field label="Action ID" value={rejection.actionId} mono flat />
        <Field label="Target Claim" value={claimReference(rejection.target)} mono flat />
        <Field label="Originating run" value={rejection.originatingRunId} mono flat />
        <Field label="Publication ID" value={rejection.publicationId} mono flat />
        <Field label="Rejected" value={formatDate(rejection.rejectedAt)} flat />
        <Field label="Integrity digest" value={rejection.integrityDigest} mono flat wide />
      </div>
    </article>
  );
}

function Field({ label, value, mono = false, wide = false, flat = false }) {
  return <div className={`${wide ? 'xl:col-span-2' : ''} ${flat ? '' : 'rounded-lg bg-slate-50 px-2.5 py-2'}`}><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-0.5 break-all text-slate-700 ${mono ? 'font-mono text-[10px]' : ''}`}>{value ?? '—'}</div></div>;
}
function Empty({ text }) { return <div className="rounded-lg border border-dashed border-line p-3 text-xs text-sub">{text}</div>; }
function ErrorBanner({ message }) { return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">{message}</div>; }
function claimReference(value) { return value ? `${value.claimId} v${value.version ?? value.expectedVersion ?? '—'}` : '—'; }
function verificationSummary(value) { return value?.pointAt ? `verify ${formatDate(value.pointAt)}` : value?.window ? `verify ${formatVerificationWindow(value.window)}` : 'verification unavailable'; }
function formatVerificationWindow(window) { return window?.startAt && window?.endAt ? `${formatDate(window.startAt)} → ${formatDate(window.endAt)}` : '—'; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); }
