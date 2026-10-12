import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Markdown, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { Btn, PageHeader } from './Shell.jsx';

const VERSION_PAGE_SIZE = 100;

export default function WorldviewVersionsView() {
  const [current, setCurrent] = useState(null);
  const [versions, setVersions] = useState([]);
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
      const result = await api.worldviewVersions({ limit: VERSION_PAGE_SIZE, cursor });
      const pageVersions = Array.isArray(result?.versions) ? result.versions : [];
      setCurrent(result?.current || null);
      setVersions((loaded) => append ? [...loaded, ...pageVersions] : pageVersions);
      setNextCursor(result?.nextCursor || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const openVersion = async (version) => {
    setDetailLoading(true);
    setError('');
    try {
      const result = await api.worldviewVersion(version.versionId);
      setSelected(result?.version || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setDetailLoading(false);
    }
  };

  if (selected) return <VersionDetail version={selected} loading={detailLoading} error={error} onBack={() => { setSelected(null); setError(''); }} />;

  return (
    <div className="worldview-versions-view flex min-h-0 flex-1 flex-col">
      <PageHeader title="Worldview Versions" subtitle="当前与历史完整 canonical-worldview-package.v1；KEEP 不会创建冗余版本">
        <Btn variant="ghost" size="sm" onClick={() => { void load(); }} disabled={loading || loadingMore}><Icon.refresh size={14} />刷新</Btn>
      </PageHeader>
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        <section className="mb-5 rounded-xl border border-blue-100 bg-blue-50/50 p-4">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-ink">Current Worldview Projection</h2><Badge color={current ? 'blue' : 'slate'}>{current ? `v${current.versionNumber}` : 'not bootstrapped'}</Badge></div>
          {current ? <div className="mt-3 grid gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4"><Field label="Version" value={current.versionId} mono /><Field label="Package digest" value={current.packageDigest} mono /><Field label="Published" value={formatDate(current.publishedAt)} /><Field label="Source run" value={current.runId} mono /></div> : <p className="mt-2 text-xs text-sub">尚无 Canonical Worldview。</p>}
        </section>
        <section className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-4 py-3"><div><h2 className="text-sm font-semibold text-ink">Canonical Worldview Version history</h2><p className="mt-0.5 text-[11px] text-sub">每个 UPDATE 是完整、自包含、可校验的 package；按稳定版本顺序分批加载。</p></div><Badge color="blue">{versions.length} Versions loaded</Badge></div>
          {loading ? <div className="p-8"><Spinner label="加载 Worldview Versions…" /></div> : versions.length ? (
            <>
              <div className="divide-y divide-line">{versions.map((version) => <VersionRow key={version.versionId} version={version} current={current?.versionId === version.versionId} onOpen={() => openVersion(version)} />)}</div>
              {nextCursor && (
                <div className="border-t border-line p-3 text-center">
                  <Btn variant="soft" size="sm" onClick={() => { void load({ cursor: nextCursor, append: true }); }} disabled={loadingMore}>
                    {loadingMore ? 'Loading more Versions…' : 'Load more Versions'}
                  </Btn>
                </div>
              )}
            </>
          ) : <div className="p-10 text-center text-sm text-sub">暂无 Canonical Worldview Version。</div>}
        </section>
      </div>
    </div>
  );
}

function VersionRow({ version, current, onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group w-full px-4 py-4 text-left transition hover:bg-blue-50/40">
      <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><Icon.layers size={17} /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-ink">v{version.versionNumber} · {version.title}</span><Badge color="blue">canonical-worldview-package.v1</Badge>{current && <Badge color="green">current</Badge>}</span><span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-sub"><span>{formatDate(version.publishedAt)}</span><span>{version.documentCount} documents</span><span>range {version.frozenRange?.startAdmissionSequence ?? '—'} → {version.frozenRange?.endAdmissionSequence ?? '—'}</span><span className="font-mono">{shortDigest(version.packageDigest)}</span></span></span><Icon.arrowRight size={16} className="mt-2 shrink-0 text-slate-300 group-hover:text-brand" /></div>
    </button>
  );
}

function VersionDetail({ version, loading, error, onBack }) {
  const [documentPath, setDocumentPath] = useState(version.documents?.[0]?.path || '');
  const document = version.documents?.find((item) => item.path === documentPath) || version.documents?.[0] || null;
  return (
    <div className="worldview-version-detail flex min-h-0 flex-1 flex-col">
      <PageHeader title={`Worldview v${version.versionNumber}`} subtitle={version.versionId}><Btn variant="ghost" size="sm" onClick={onBack}><Icon.back size={14} />返回 Versions</Btn></PageHeader>
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 p-6">
        {error && <ErrorBanner message={error} />}
        {loading ? <Spinner label="加载 Canonical Worldview package…" /> : <div className="mx-auto max-w-7xl space-y-5">
          <section className="rounded-xl border border-line bg-white p-4"><div className="flex flex-wrap items-center gap-2"><Badge color="blue">{version.contract}</Badge><Badge color={version.integrity?.valid ? 'green' : 'red'}>{version.integrity?.valid ? 'integrity verified' : 'integrity failed'}</Badge></div><div className="mt-3 grid gap-3 text-[11px] sm:grid-cols-2 xl:grid-cols-4"><Field label="Package digest" value={version.packageDigest} mono /><Field label="Base version" value={version.baseWorldviewVersionId || 'bootstrap'} mono /><Field label="Source run" value={version.runId} mono /><Field label="Overview manifest" value={version.overviewManifestDigest} mono /></div></section>
          <section className="rounded-xl border border-line bg-white p-4"><h2 className="text-sm font-semibold text-ink">Worldview Update Record</h2><p className="mt-2 text-sm text-slate-700">{version.updateRecord?.rationale}</p><div className="mt-3 grid gap-3 text-[11px] md:grid-cols-4"><ListField label="Retained" values={version.updateRecord?.retained} /><ListField label="Changed" values={version.updateRecord?.changed} /><ListField label="Added" values={version.updateRecord?.added} /><ListField label="Removed" values={version.updateRecord?.removed} /></div></section>
          <section className="overflow-hidden rounded-xl border border-line bg-white"><div className="flex flex-wrap gap-2 border-b border-line p-3">{(version.documents || []).map((item) => <button type="button" key={item.path} onClick={() => setDocumentPath(item.path)} className={`rounded-lg px-3 py-1.5 text-xs ${document?.path === item.path ? 'bg-blue-50 font-semibold text-brand' : 'bg-slate-50 text-sub hover:bg-slate-100'}`}>{item.path}</button>)}</div>{document ? <article className="p-6">{document.mediaType === 'text/markdown' ? <Markdown text={document.content} className="daily-report-markdown" /> : <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4 text-[11px] leading-5 text-slate-100">{prettyJson(document.content)}</pre>}<div className="mt-3 text-[10px] text-sub">{document.contentDigest} · {document.byteLength} exact bytes</div></article> : <div className="p-6 text-xs text-sub">No document selected.</div>}</section>
        </div>}
      </div>
    </div>
  );
}

function ListField({ label, values }) { return <div className="rounded-lg bg-slate-50 p-3"><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div><ul className="mt-2 space-y-1 text-slate-700">{values?.length ? values.map((value) => <li key={value}>• {value}</li>) : <li>—</li>}</ul></div>; }
function Field({ label, value, mono = false }) { return <div className="rounded-lg bg-white/70 px-2.5 py-2"><div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-0.5 break-words text-slate-700 ${mono ? 'font-mono text-[10px]' : ''}`}>{value || '—'}</div></div>; }
function ErrorBanner({ message }) { return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">{message}</div>; }
function shortDigest(value) { const text = String(value || ''); return text.length > 26 ? `${text.slice(0, 18)}…${text.slice(-6)}` : text; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); }
function prettyJson(value) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
