import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Btn } from './Shell.jsx';
import { Icon } from '../icons.jsx';
import { Markdown, Badge, Confidence, Spinner } from '../components.jsx';
import { ratingLabel } from '../i18n.js';
import WorkflowRunView from './WorkflowRunView.jsx';

// 与后端 Run Analysis workflow 的 INTENSITY 保持一致：力度只表达轮次与 wall-clock 范围。
const INTENSITY_OPTS = [
  { key: 'quick', label: '快速 ~15min', desc: '1 轮起步：数据+行业/公司分析+反思+推演 · 最多 2 轮' },
  { key: 'standard', label: '标准 ~30min', desc: '2 轮起步（blocking 缺口自动加轮）· 含 transcript/联网研究 · 最多 3 轮' },
  { key: 'deep', label: '深度 ~60min', desc: '2 轮起步，单轮 wall-clock 更充足 · 跨产业链 transcript · 最多 3 轮' },
];
const WORKSPACE_AREAS = {
  data: { folderLabel: 'Data · 输入数据', statusLabel: '输入数据', dot: 'bg-blue-400' },
  analysis: { folderLabel: 'Analysis · 中间产物', statusLabel: '中间产物', dot: 'bg-violet-500' },
  report: { folderLabel: 'Report · 报告文件', statusLabel: '草稿/历史文件，非当前发布', dot: 'bg-slate-400' },
};
const ACTIVE_ANALYSIS_STATUSES = new Set(['queued', 'analyzing']);
const CHAT_BOTTOM_THRESHOLD_PX = 48;

function messageSignature(message) {
  return [
    message?.role || '',
    message?.content || '',
    message?.createdAt || message?.timestamp || '',
  ].join('\u0000');
}

function messagesSignature(messages = []) {
  return messages.map(messageSignature).join('\u0001');
}

function hasAppendedAssistantMessage(current, next) {
  const currentAssistants = current.filter((message) => message?.role === 'assistant');
  const nextAssistants = next.filter((message) => message?.role === 'assistant');
  return nextAssistants.length > currentAssistants.length
    && currentAssistants.every(
      (message, index) => messageSignature(message) === messageSignature(nextAssistants[index]),
    );
}

export default function ProjectDetail({ id, onBack, onChanged }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('report');
  const [analyzing, setAnalyzing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [filePage, setFilePage] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [workspaceFiles, setWorkspaceFiles] = useState([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [intensity, setIntensity] = useState('standard');
  const [industryTemplateId, setIndustryTemplateId] = useState('');
  const [companyTemplateId, setCompanyTemplateId] = useState('');
  const [showOpts, setShowOpts] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [reportText, setReportText] = useState('');
  const [selectedReport, setSelectedReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const fileRequest = useRef(0);
  const reportRequest = useRef(0);
  const projectRequest = useRef(0);
  const workspaceRequest = useRef(0);
  const analysisStatusRequest = useRef(0);

  const load = async () => {
    const request = ++projectRequest.current;
    const d = await api.project(id);
    if (request !== projectRequest.current) return null;
    setData(d);
    setIntensity(d.meta?.intensity || 'standard');
    setIndustryTemplateId(d.meta?.industryTemplate || '');
    setCompanyTemplateId(d.meta?.companyTemplate || '');
    setAnalysisError('');
    return d;
  };
  const loadWorkspaceFiles = async () => {
    const request = ++workspaceRequest.current;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    try {
      const result = await api.workspaceFiles(id);
      if (request !== workspaceRequest.current) return;
      setWorkspaceFiles((result.files || []).map((file) => ({
        name: file.file,
        size: file.bytes,
        mtime: file.modified,
        area: file.area,
        extension: file.extension,
      })));
    } catch (error) {
      if (request !== workspaceRequest.current) return;
      setWorkspaceFiles([]);
      setWorkspaceError(error?.message || String(error));
    } finally {
      if (request === workspaceRequest.current) setWorkspaceLoading(false);
    }
  };
  useEffect(() => {
    projectRequest.current += 1;
    workspaceRequest.current += 1;
    fileRequest.current += 1;
    reportRequest.current += 1;
    analysisStatusRequest.current += 1;
    setData(null);
    setChatOpen(false);
    setWorkspaceFiles([]);
    setWorkspaceLoading(false);
    setWorkspaceError('');
    setActiveFile(null);
    setFileContent('');
    setFilePage(null);
    setFileLoading(false);
    setFileError('');
    setReportText('');
    setSelectedReport('');
    setReportLoading(false);
    setReportError('');
    setAnalysisError('');
    load();
    api.templates().then((r) => setTemplates(r.templates || []));
  }, [id]);
  useEffect(() => {
    if (tab !== 'files') return;
    loadWorkspaceFiles();
  }, [id, tab, data?.meta?.status]);
  useEffect(() => {
    reportRequest.current += 1;
    setReportLoading(false);
    setReportError('');
    setReportText(data?.report || '');
    setSelectedReport(
      data?.analysis?.reportPackage?.reportPath
      || data?.reports?.[0]?.path
      || '',
    );
  }, [data?.analysis?.reportPackage?.reportPath, data?.report]);

  const meta = data?.meta;
  const events = data?.events || [];
  // 分析在后台运行；以 meta.status 驱动轮询（断线/刷新后也能续上进度显示）
  const running = analyzing || ACTIVE_ANALYSIS_STATUSES.has(meta?.status);
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer;
    const requestedProjectId = id;

    const poll = async () => {
      const request = ++analysisStatusRequest.current;
      try {
        const status = await api.analysisStatus(requestedProjectId);
        if (stopped || request !== analysisStatusRequest.current) return;
        const nextStatus = status.projectStatus || status.status;
        if (ACTIVE_ANALYSIS_STATUSES.has(nextStatus)) {
          setData((current) => {
            if (!current) return current;
            const safeAnalysisStatus = {
              status: nextStatus,
              projectStatus: nextStatus,
              runStatus: status.runStatus,
              currentNodeId: status.currentNodeId,
              queuePosition: status.queuePosition,
              currentRunId: status.currentRunId,
              runId: status.runId,
            };
            const statusUnchanged = current.meta?.status === nextStatus
              && Object.entries(safeAnalysisStatus).every(
                ([key, value]) => current.analysis?.[key] === value,
              );
            if (statusUnchanged) return current;
            return {
              ...current,
              meta: { ...current.meta, status: nextStatus },
              analysis: {
                ...current.analysis,
                ...safeAnalysisStatus,
              },
            };
          });
        } else {
          await load();
          return;
        }
      } catch {
        // A transient status failure must not create a second in-flight request.
      }
      if (!stopped && request === analysisStatusRequest.current) {
        timer = setTimeout(poll, 1500);
      }
    };

    timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      analysisStatusRequest.current += 1;
      clearTimeout(timer);
    };
  }, [id, running, meta?.status]);
  useEffect(() => {
    if (meta && !ACTIVE_ANALYSIS_STATUSES.has(meta.status)) setAnalyzing(false);
  }, [meta?.status]);
  useEffect(() => {
    if (
      data?.reportReady !== true
      || !data?.report
      || !meta?.conclusion
      || running
    ) {
      setChatOpen(false);
    }
  }, [id, data?.reportReady, data?.report, meta?.conclusion, running]);

  // resume: undefined→后端按 checkpoint 自动续跑；false→从头重跑
  const analyze = async (resume) => {
    setShowOpts(false);
    setChatOpen(false);
    setAnalyzing(true);
    setAnalysisError('');
    setTab('process');
    try {
      await api.analyze(id, {
        intensity,
        industryTemplate: industryTemplateId || undefined,
        companyTemplate: companyTemplateId || undefined,
        resume,
      });
    } catch (error) {
      setAnalysisError(`分析启动/恢复失败：${error?.message || error}`);
      setAnalyzing(false);
      return;
    }
    try {
      await load();
      onChanged?.();
    } catch (error) {
      setAnalysisError(`分析已启动，但状态刷新失败（后台任务不受影响，将继续轮询）：${error?.message || error}`);
    }
  };

  const promote = async () => { await api.promote(id); onChanged?.(); };
  const toggleTrack = async () => { await api.setTracking(id, !meta.tracking); load(); };
  const updateLanguage = async (patch) => { await api.updateProjectSettings(id, patch); await load(); };
  const translateReport = async () => {
    setTranslating(true);
    try { await api.translateReport(id, 'zh'); await load(); }
    finally { setTranslating(false); }
  };
  const switchReport = async (path) => {
    const request = ++reportRequest.current;
    setSelectedReport(path);
    setReportError('');
    if (!path || path === data?.analysis?.reportPackage?.reportPath) {
      setReportLoading(false);
      setReportText(data?.report || '');
      return;
    }
    setReportLoading(true);
    setReportText('');
    try {
      const r = await api.workspaceContent(id, path);
      if (r.error) throw new Error(r.error);
      if (request === reportRequest.current) setReportText(r.content || '');
    } catch (e) {
      if (request === reportRequest.current) setReportError(e.message);
    } finally {
      if (request === reportRequest.current) setReportLoading(false);
    }
  };

  const openFile = async (name) => {
    const request = ++fileRequest.current;
    setActiveFile(name);
    setFileContent('');
    setFilePage(null);
    setFileError('');
    setFileLoading(true);
    try {
      const r = await api.workspaceContent(id, name);
      if (r.error) throw new Error(r.error);
      if (request === fileRequest.current && r.file === name) {
        setFileContent(r.content || '');
        setFilePage(r);
      }
    } catch (e) {
      if (request === fileRequest.current) setFileError(e.message);
    } finally {
      if (request === fileRequest.current) setFileLoading(false);
    }
  };

  const loadMoreFile = async () => {
    if (!activeFile || !filePage?.truncated || fileLoading) return;
    const request = fileRequest.current;
    setFileLoading(true); setFileError('');
    try {
      const r = await api.workspaceContent(id, activeFile, filePage.nextOffset);
      if (r.error) throw new Error(r.error);
      if (request === fileRequest.current && r.file === activeFile) {
        setFileContent((current) => current + (r.content || ''));
        setFilePage(r);
      }
    } catch (e) {
      if (request === fileRequest.current) setFileError(e.message);
    } finally {
      if (request === fileRequest.current) setFileLoading(false);
    }
  };

  if (!data) return <div className="flex-1 grid place-items-center"><Spinner label="加载项目…" /></div>;
  const industryTemplates = templates.filter((t) => t.kind === 'industry');
  const companyTemplates = templates.filter((t) => t.kind === 'company');
  const hasPublishedReport = data.reportReady && Boolean(meta.conclusion);
  const reportFeedbackAllowed = data.reportReady === true
    && hasPublishedReport
    && Boolean(data.report)
    && !running;
  const resumable = Boolean(data.analysis?.resumable);

  return (
    <>
      {/* 头部 */}
      <div className="px-7 py-4 border-b border-line bg-white">
        <button onClick={onBack} className="text-sm text-sub hover:text-brand mb-2 flex items-center gap-1"><Icon.back size={14} />返回项目库</button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {/* 头部只保留三类信息：评级 / 状态 / 主题——其余元数据收进「项目信息」弹层，正式金融系统不堆徽章 */}
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {hasPublishedReport && <Badge color="purple">{ratingLabel(meta.conclusion.rating)}</Badge>}
              {meta.status === 'created' && <Badge color="slate">已创建 · 尚未分析</Badge>}
              {meta.status === 'queued' && <Badge color="amber">排队中</Badge>}
              {meta.status === 'analyzing' && <Badge color="amber">分析中</Badge>}
              {meta.status === 'analyzed' && <Badge color="green">已分析 · 报告已验证发布</Badge>}
              {meta.status === 'interrupted' && <Badge color="amber">{resumable ? '已中断 · 可续跑' : '已中断'}</Badge>}
              {meta.status === 'paused' && <Badge color="amber">{resumable ? '已暂停 · 可续跑' : '已暂停'}</Badge>}
              {meta.status === 'review-required' && <Badge color="red">历史未发布 · 请重新分析</Badge>}
              {meta.status === 'failed' && <Badge color="red">{resumable ? '分析失败 · 可续跑' : '分析失败'}</Badge>}
              {meta.status === 'cancelled' && <Badge color="slate">{resumable ? '已取消 · 可续跑' : '已取消'}</Badge>}
              {meta.live === false && <Badge color="slate">演示数据</Badge>}
              <Badge color="blue">{meta.theme}</Badge>
              <ProjectInfoPopover meta={meta} intensityLabel={INTENSITY_OPTS.find((o) => o.key === meta.intensity)?.label || meta.intensity} />
            </div>
            <h1 className="text-lg font-bold text-ink truncate" title={meta.title}>{meta.titleZh || meta.title}</h1>
            <ProjectRuntimeSummary
              meta={meta}
              analysis={data.analysis}
              reportReady={data.reportReady}
            />
            {data.progress && ['queued', 'analyzing'].includes(meta.status) && (
              <div className="mt-2 flex items-center gap-3 max-w-xl">
                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-brand rounded-full transition-all duration-700" style={{ width: `${data.progress.pct}%` }} />
                </div>
                <span className="text-[11px] text-sub whitespace-nowrap tabular-nums">
                  {data.progress.stage}
                  {meta.status === 'queued' && data.analysis?.queuePosition > 0
                    ? ` · 队列第 ${data.analysis.queuePosition} 位`
                    : ''}
                  {data.progress.currentRound ? ` · 第 ${data.progress.currentRound}/${data.progress.rounds || '?'} 轮` : ''}
                  {' · '}{data.progress.pct}%
                  {data.progress.elapsedMin != null ? ` · 已用 ${data.progress.elapsedMin} 分钟` : ''}
                  {data.progress.etaMin ? ` · 预计还需 ~${data.progress.etaMin} 分钟` : ''}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 relative">
            <Btn variant="ghost" size="sm" onClick={toggleTrack}><Icon.pin size={13} />{meta.tracking ? '取消跟踪' : '跟踪'}</Btn>
            {hasPublishedReport && <Btn variant="soft" size="sm" onClick={promote}>纳入股票池<Icon.arrowRight size={13} /></Btn>}
            {running && (
              <Btn variant="soft" size="sm" onClick={async () => { await api.pauseProject(id); await load(); onChanged?.(); }}>
                <Icon.pause size={13} />暂停
              </Btn>
            )}
            {resumable && (['interrupted', 'paused', 'failed', 'cancelled'].includes(meta.status)) && !running && (
              <Btn variant="soft" size="sm" onClick={() => analyze(true)}><Icon.play size={13} />继续分析（断点续跑）</Btn>
            )}
            <div className="relative">
              <Btn size="sm" onClick={() => hasPublishedReport ? setShowOpts(!showOpts) : analyze(meta.status === 'interrupted' ? undefined : false)} disabled={running}>
                {running ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />分析中</> : (hasPublishedReport ? <><Icon.refresh size={13} />重新分析</> : <><Icon.play size={13} />运行分析</>)}
              </Btn>
              {!hasPublishedReport && !running && (
                <button onClick={() => setShowOpts(!showOpts)} className="ml-1 text-xs text-sub hover:text-brand">选项</button>
              )}
              {showOpts && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-line rounded-xl shadow-lg p-4 z-20">
                  <div className="text-xs font-medium text-ink mb-2">分析力度</div>
                  <div className="space-y-1.5 mb-3">
                    {INTENSITY_OPTS.map((o) => (
                      <button key={o.key} onClick={() => setIntensity(o.key)}
                        className={`w-full text-left px-3 py-2 rounded-lg border transition ${intensity === o.key ? 'border-brand bg-brand/5' : 'border-line hover:border-slate-300'}`}>
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${intensity === o.key ? 'text-brand' : 'text-ink'}`}>{o.label}</span>
                          {intensity === o.key && <Icon.check size={14} className="text-brand" />}
                        </div>
                        <div className="text-[11px] text-sub">{o.desc}</div>
                      </button>
                    ))}
                  </div>
                  <div className="text-xs font-medium text-ink mb-1">行业模板（industry-adaptor）</div>
                  <select value={industryTemplateId} onChange={(e) => setIndustryTemplateId(e.target.value)}
                    className="w-full text-sm border border-line rounded-lg px-2 py-2 mb-3 focus:outline-none focus:border-brand">
                    <option value="">自动匹配</option>
                    {industryTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <div className="text-xs font-medium text-ink mb-1">公司模板（company-adaptor）</div>
                  <select value={companyTemplateId} onChange={(e) => setCompanyTemplateId(e.target.value)}
                    className="w-full text-sm border border-line rounded-lg px-2 py-2 mb-3 focus:outline-none focus:border-brand">
                    <option value="">自动匹配</option>
                    {companyTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <div className="text-xs font-medium text-ink mb-1">语言</div>
                  <div className="flex gap-2 mb-3">
                    <select value={meta.analysisLanguage || 'en'} onChange={(e) => updateLanguage({ analysisLanguage: e.target.value })}
                      className="flex-1 text-xs border border-line rounded-lg px-2 py-1.5 text-sub" title="分析工作语言（海外公司建议 EN）">
                      <option value="en">分析 EN</option>
                      <option value="zh">分析 中文</option>
                    </select>
                    <select value={meta.reportLanguage || 'en'} onChange={(e) => updateLanguage({ reportLanguage: e.target.value })}
                      className="flex-1 text-xs border border-line rounded-lg px-2 py-1.5 text-sub" title="最终报告语言">
                      <option value="en">报告 EN</option>
                      <option value="zh">报告 中文</option>
                    </select>
                  </div>
                  <Btn size="sm" onClick={() => analyze(false)} disabled={running}><Icon.play size={13} />开始分析</Btn>
                </div>
              )}
            </div>
          </div>
        </div>
        {analysisError && (
          <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            <span>{analysisError}</span>
            <button onClick={() => setAnalysisError('')} className="text-red-500 hover:text-red-700">关闭</button>
          </div>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 左：主内容 tabs */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-7 pt-3 flex gap-1 border-b border-line bg-white">
            {[
              ['report', '报告', 'doc'],
              ['conclusion', '结论', 'target'],
              ['process', 'Workflow', 'globe'],
              ['files', '项目文件', 'folder'],
            ].map(([k, l, ic]) => {
              const I = Icon[ic];
              return (
                <button key={k} onClick={() => setTab(k)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition flex items-center gap-1.5 ${tab === k ? 'border-brand text-brand' : 'border-transparent text-sub hover:text-ink'}`}><I size={14} />{l}</button>
              );
            })}
          </div>

          <div className="flex-1 overflow-auto p-7">
            {tab === 'report' && (
              data.reportReady ? <div className="max-w-3xl space-y-4">
                <ReportToolbar
                  reports={data.reports || []}
                  selected={selectedReport}
                  publishedReportPath={data.analysis?.reportPackage?.reportPath || ''}
                  translating={translating}
                  onTranslate={translateReport}
                  onSelect={switchReport}
                />
                {reportLoading ? <div className="py-12"><Spinner label="加载报告版本…" /></div> : reportError ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-600">{reportError}</div> : <Markdown text={reportText} />}
              </div>
                : <EmptyHint icon="doc" text="尚未生成报告，点击右上角「运行分析」。" />
            )}

            {tab === 'process' && <WorkflowRunView projectId={id} fallbackEvents={events} analyzing={running} progress={data.progress} />}

            {tab === 'conclusion' && (
              hasPublishedReport ? (
                <div className="space-y-5">
                  <ConclusionPanel c={meta.conclusion} valuation={data.analysis?.valuation} crossref={data.analysis?.crossref} />
                </div>
              ) : <EmptyHint icon="target" text="尚无结论。运行分析后将产出评级、置信度与标的。" />
            )}

            {tab === 'files' && (
              <div className="space-y-3">
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-blue-800">
                  Workspace · 公开项目视图：这里只展示公开的 data / analysis / report 项目文件，不代表 runtime mount、snapshot 或 capability 全景。
                </div>
                {workspaceError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
                    <div>项目文件 API 读取失败：{workspaceError}</div>
                    <Btn variant="soft" size="sm" onClick={loadWorkspaceFiles}>重试</Btn>
                  </div>
                ) : workspaceLoading && !workspaceFiles.length ? (
                  <div className="py-16 grid place-items-center"><Spinner label="读取公开项目文件…" /></div>
                ) : (
                  <FileBrowser
                    files={workspaceFiles}
                    activeFile={activeFile}
                    content={fileContent}
                    page={filePage}
                    loading={fileLoading}
                    error={fileError}
                    reportReady={data.reportReady}
                    publishedReportPath={data.analysis?.reportPackage?.reportPath || null}
                    onOpen={openFile}
                    onLoadMore={loadMoreFile}
                    onRetry={() => activeFile && openFile(activeFile)}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {reportFeedbackAllowed && (
          <aside className={`shrink-0 border-l border-line bg-white ${chatOpen ? 'w-80 flex flex-col' : 'p-3'}`}>
            <button
              type="button"
              aria-expanded={chatOpen}
              aria-controls="report-feedback-panel"
              onClick={() => setChatOpen((open) => !open)}
              className="w-full rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-ink hover:border-brand hover:text-brand flex items-center justify-center gap-1.5"
            >
              <Icon.chat size={14} />
              Report Feedback
            </button>
            {chatOpen && (
              <ChatPanel
                id={id}
                initial={data.chat}
                onReport={load}
              />
            )}
          </aside>
        )}
      </div>
    </>
  );
}

function ProjectRuntimeSummary({ meta, analysis, reportReady }) {
  const hasDurableLineage = Boolean(
    meta.sourceIdeaId
    && meta.sourceIdeaRunId
    && meta.sourceRunInputSnapshotId,
  );
  const analysisRunId = analysis?.runId || meta.analysisRunId || null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-sub">
      <span className="font-mono" title={meta.sourceIdeaId || ''}>sourceIdeaId · {meta.sourceIdeaId || '未记录'}</span>
      <span className="font-mono" title={meta.sourceIdeaRunId || ''}>sourceIdeaRunId · {meta.sourceIdeaRunId || '未记录'}</span>
      <span className="font-mono" title={meta.sourceRunInputSnapshotId || ''}>sourceRunInputSnapshotId · {meta.sourceRunInputSnapshotId || '未记录'}</span>
      {!hasDurableLineage && <span>Idea lineage · 无 durable lineage</span>}
      <span className="font-mono" title={analysisRunId || ''}>当前 analysis run id · {analysisRunId || '尚未创建'}</span>
      <span>reportReady · {reportReady ? 'true（已验证发布）' : 'false（未发布）'}</span>
    </div>
  );
}

function ReportToolbar({
  reports,
  selected,
  publishedReportPath,
  translating,
  onTranslate,
  onSelect,
}) {
  const reportOptions = (
    publishedReportPath
    && !reports.some((report) => report.path === publishedReportPath)
  )
    ? [{
        path: publishedReportPath,
        name: publishedReportPath.split('/').at(-1),
        language: 'default',
      }, ...reports]
    : reports;
  const selectedIsPublished = Boolean(
    publishedReportPath
    && selected === publishedReportPath,
  );
  return (
    <div className="bg-white border border-line rounded-lg p-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium text-ink">
          <span>报告版本</span>
          <Badge color={selectedIsPublished ? 'green' : 'slate'}>
            {selectedIsPublished ? '当前已验证发布' : '历史/草稿，非当前发布'}
          </Badge>
        </div>
        {reportOptions.length ? (
          <select value={selected || reportOptions[0]?.path || ''} onChange={(e) => onSelect(e.target.value)}
            className="mt-1 text-xs border border-line rounded px-2 py-1 max-w-full">
            {reportOptions.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
                {r.language && r.language !== 'default' ? ` · ${r.language}` : ''}
                {r.path === publishedReportPath ? ' · 当前已验证发布' : ' · 历史/草稿'}
              </option>
            ))}
          </select>
        ) : <div className="text-[11px] text-sub truncate">当前草稿报告</div>}
      </div>
      <Btn variant="soft" size="sm" onClick={onTranslate} disabled={translating || !selectedIsPublished}>
        {!selectedIsPublished
          ? '切回当前发布报告后可翻译'
          : translating ? '翻译中…' : '翻译当前发布报告'}
      </Btn>
    </div>
  );
}

function FileBrowser({
  files,
  activeFile,
  content,
  page,
  loading,
  error,
  reportReady,
  publishedReportPath,
  onOpen,
  onLoadMore,
  onRetry,
}) {
  const [query, setQuery] = useState('');
  const [previewMode, setPreviewMode] = useState('rendered');
  const { publicFiles, tree } = useMemo(() => {
    const publicItems = files.filter((file) => !file.dir);
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? publicItems.filter((file) => file.name.toLowerCase().includes(normalizedQuery))
      : publicItems;
    return { publicFiles: publicItems, tree: buildWorkspaceTree(filtered) };
  }, [files, query]);
  const activeMeta = useMemo(() => files.find((file) => file.name === activeFile), [files, activeFile]);

  useEffect(() => { setPreviewMode('rendered'); }, [activeFile]);

  return (
    <div className="h-full min-h-[560px] flex bg-white border border-line rounded-xl overflow-hidden shadow-sm">
      <aside className="w-72 shrink-0 border-r border-line bg-slate-50/60 flex flex-col">
        <div className="p-3 border-b border-line bg-white">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-semibold text-ink flex items-center gap-1.5"><Icon.folder size={15} className="text-brand" />Workspace · 公开项目视图</div>
              <div className="text-[10px] text-sub mt-0.5">{publicFiles.length} 个项目文件 · data / analysis / report</div>
            </div>
          </div>
          <div className="relative">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件…"
              className="studio-input text-xs pl-3 pr-8 py-2 bg-slate-50 focus:bg-white" />
            {query && <button onClick={() => setQuery('')} className="absolute right-2 top-1.5 text-slate-400 hover:text-ink"><Icon.close size={14} /></button>}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {tree.length ? tree.map((node) => (
            <WorkspaceTreeNode
              key={node.path}
              node={node}
              activeFile={activeFile}
              reportReady={reportReady}
              publishedReportPath={publishedReportPath}
              onOpen={onOpen}
              forceOpen={Boolean(query.trim())}
            />
          )) : <div className="px-3 py-8 text-center text-xs text-sub">没有匹配的文件。</div>}
        </div>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col bg-white">
        {activeFile ? (
          <>
            <div className="px-4 py-3 border-b border-line flex items-center gap-3 bg-white">
              <span className="text-slate-400">{fileIcon(activeFile)}</span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-ink truncate" title={activeFile}>{activeFile}</div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-sub">
                  <FileStatus
                    file={activeMeta}
                    reportReady={reportReady}
                    publishedReportPath={publishedReportPath}
                  />
                  {activeMeta?.size != null && <span>{formatBytes(activeMeta.size)}</span>}
                  {activeMeta?.mtime && <span>更新于 {formatDate(activeMeta.mtime)}</span>}
                  {activeMeta?.artifact?.version && <span>artifact v{activeMeta.artifact.version}</span>}
                </div>
              </div>
              {isMarkdownFile(activeFile) && (
                <div className="flex rounded-lg border border-line p-0.5 bg-slate-50">
                  <button onClick={() => setPreviewMode('rendered')}
                    className={`px-2.5 py-1 text-[11px] rounded-md ${previewMode === 'rendered' ? 'bg-white text-brand shadow-sm' : 'text-sub'}`}>预览</button>
                  <button onClick={() => setPreviewMode('raw')}
                    className={`px-2.5 py-1 text-[11px] rounded-md ${previewMode === 'raw' ? 'bg-white text-brand shadow-sm' : 'text-sub'}`}>源码</button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto p-5 bg-slate-50/40">
              <div className="max-w-5xl mx-auto bg-white border border-line rounded-xl min-h-full p-6 shadow-sm overflow-auto">
                {loading && !content ? <div className="py-16 grid place-items-center"><Spinner label="读取文件…" /></div> : error ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-600" role="alert">
                    <div>项目文件内容读取失败：{error}</div>
                    <Btn variant="soft" size="sm" onClick={onRetry}>重试</Btn>
                  </div>
                ) : <FilePreview name={activeFile} content={content} mode={previewMode} />}
                {page?.truncated && !error && (
                  <div className="mt-5 pt-4 border-t border-line flex items-center justify-between">
                    <span className="text-[10px] text-sub">已加载 {content.length.toLocaleString()} / {Number(page.totalChars || 0).toLocaleString()} 字符</span>
                    <Btn variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>{loading ? '加载中…' : '继续加载'}</Btn>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 grid place-items-center p-10">
            <div className="text-center max-w-sm">
              <div className="w-12 h-12 rounded-xl bg-blue-50 text-brand grid place-items-center mx-auto mb-3"><Icon.folder size={24} /></div>
              <h3 className="text-sm font-semibold text-ink">选择文件查看内容</h3>
              <p className="text-xs text-sub mt-1 leading-relaxed">公开项目视图区分输入数据、中间产物和报告文件；它不是 runtime mount、snapshot 或 capability 全景。Markdown 文件默认使用 GitHub 风格渲染。</p>
              <div className="grid grid-cols-3 gap-2 mt-4 text-[10px] text-sub">
                <WorkspaceStat label="输入数据" value={publicFiles.filter((f) => f.name.startsWith('data/')).length} />
                <WorkspaceStat label="中间产物" value={publicFiles.filter((f) => f.name.startsWith('analysis/')).length} />
                <WorkspaceStat label="报告文件" value={publicFiles.filter((f) => f.name.startsWith('report/')).length} />
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function WorkspaceTreeNode({
  node,
  activeFile,
  reportReady,
  publishedReportPath,
  onOpen,
  forceOpen = false,
  depth = 0,
}) {
  const [open, setOpen] = useState(depth < 1);
  const expanded = forceOpen || open;
  if (node.type === 'file') {
    const active = activeFile === node.path;
    return (
      <button onClick={() => onOpen(node.path)} title={node.path}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left ${active ? 'bg-blue-50 text-brand' : 'text-slate-700 hover:bg-white'}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}>
        <span className={active ? 'text-brand' : 'text-slate-400'}>{fileIcon(node.path)}</span>
        <span className="flex-1 min-w-0 truncate font-mono text-[11px]">{node.name}</span>
        <span
          className={`w-1.5 h-1.5 rounded-full ${fileStatusDot(node.file, { reportReady, publishedReportPath })}`}
          title={fileStatusLabel(node.file, { reportReady, publishedReportPath })}
        />
      </button>
    );
  }
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-slate-600 hover:bg-white"
        style={{ paddingLeft: `${8 + depth * 14}px` }}>
        <span className="text-[10px] text-slate-400 w-3">{expanded ? '▾' : '▸'}</span>
        <Icon.folder size={13} className={depth === 0 ? 'text-brand' : 'text-slate-400'} />
        <span className="font-medium text-xs flex-1 truncate">{workspaceFolderLabel(node.name, depth)}</span>
        <span className="text-[9px] text-slate-400 font-mono">{node.count}</span>
      </button>
      {expanded && node.children.map((child) => (
        <WorkspaceTreeNode
          key={child.path}
          node={child}
          activeFile={activeFile}
          reportReady={reportReady}
          publishedReportPath={publishedReportPath}
          onOpen={onOpen}
          forceOpen={forceOpen}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

const FilePreview = React.memo(function FilePreview({ name, content, mode }) {
  if (isMarkdownFile(name) && mode !== 'raw') return <Markdown text={content} />;
  let displayContent = content;
  if (name.endsWith('.json')) {
    try { displayContent = JSON.stringify(JSON.parse(content), null, 2); } catch {}
  }
  return <pre className="text-xs font-mono whitespace-pre-wrap break-words text-slate-700 leading-relaxed">{displayContent}</pre>;
});

function FileStatus({ file, reportReady, publishedReportPath }) {
  const publication = { reportReady, publishedReportPath };
  return <span className="inline-flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${fileStatusDot(file, publication)}`} />{fileStatusLabel(file, publication)}</span>;
}

function WorkspaceStat({ label, value }) {
  return <div className="border border-line rounded-lg bg-white px-2 py-2"><div className="text-sm font-semibold text-ink">{value}</div><div>{label}</div></div>;
}

function buildWorkspaceTree(files) {
  const root = { children: new Map() };
  files.forEach((file) => {
    const parts = file.name.split('/').filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (!cursor.children.has(part)) {
        cursor.children.set(part, index === parts.length - 1
          ? { type: 'file', name: part, path, file }
          : { type: 'folder', name: part, path, children: new Map() });
      }
      const next = cursor.children.get(part);
      if (next.type === 'folder') cursor = next;
    });
  });
  const normalize = (children) => [...children.values()]
    .map((node) => {
      if (node.type === 'file') return node;
      const normalizedChildren = normalize(node.children);
      return {
        ...node,
        children: normalizedChildren,
        count: normalizedChildren.reduce((sum, child) => sum + (child.type === 'file' ? 1 : child.count), 0),
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  return normalize(root.children);
}

function workspaceFolderLabel(name, depth) {
  if (depth > 0) return name;
  return WORKSPACE_AREAS[name]?.folderLabel || name;
}

function workspaceArea(file) { return file?.area || file?.name?.split('/')[0]; }
function isVerifiedPublishedReport(file, { reportReady, publishedReportPath } = {}) {
  return Boolean(
    reportReady
    && publishedReportPath
    && file?.name === publishedReportPath,
  );
}
function fileStatusLabel(file, publication) {
  if (workspaceArea(file) === 'report') {
    return isVerifiedPublishedReport(file, publication)
      ? '已验证发布'
      : '草稿/历史文件，非当前发布';
  }
  if (file?.status) return file.status;
  if (file?.artifact?.status) return file.artifact.status;
  return WORKSPACE_AREAS[workspaceArea(file)]?.statusLabel || '项目文件';
}

function fileStatusDot(file, publication) {
  if (workspaceArea(file) === 'report') {
    return isVerifiedPublishedReport(file, publication) ? 'bg-emerald-500' : 'bg-slate-400';
  }
  if (file?.status === 'failed' || file?.status === 'stale') return 'bg-red-500';
  if (file?.status === 'running' || file?.status === 'writing') return 'bg-amber-500 animate-pulse';
  return WORKSPACE_AREAS[workspaceArea(file)]?.dot || 'bg-blue-400';
}

function isMarkdownFile(name = '') { return /\.mdx?$/i.test(name); }
function formatBytes(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

// 头部元数据弹层：力度/模板/语言/framework/跟踪等收进来，头部保持干净
function ProjectInfoPopover({ meta, intensityLabel }) {
  const [open, setOpen] = useState(false);
  const rows = [
    ['分析力度', intensityLabel || '—'],
    ['行业模板', meta.industryTemplateName || '自动匹配'],
    ['公司模板', meta.companyTemplateName || '自动匹配'],
    ['工作语言 / 报告语言', `${meta.analysisLanguage || 'en'} / ${meta.reportLanguage || 'en'}`],
    ['跟踪', meta.tracking ? '跟踪中' : '未跟踪'],
    ['框架版本', meta.frameworkVersion || '—'],
    ['创建时间', meta.createdAt ? new Date(meta.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'],
    ['分析完成', meta.analyzedAt ? new Date(meta.analyzedAt).toLocaleString('zh-CN', { hour12: false }) : '—'],
  ];
  return (
    <span className="relative">
      <button onClick={() => setOpen(!open)} className="text-[11px] text-slate-400 hover:text-brand border border-line rounded px-1.5 py-0.5">项目信息</button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white border border-line rounded-xl shadow-lg p-3 z-30" onMouseLeave={() => setOpen(false)}>
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-1 text-xs border-b border-line/60 last:border-0">
              <span className="text-sub whitespace-nowrap">{k}</span>
              <span className="text-ink text-right truncate" title={String(v)}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

function ConclusionPanel({ c, valuation, crossref }) {
  return (
    <div className="max-w-3xl space-y-5">
      <div className="bg-white rounded-xl border border-line p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-ink">综合结论</span>
          <Badge color="purple">{ratingLabel(c.rating)}</Badge>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs text-sub">整体置信度</span>
          <div className="flex-1 max-w-xs"><Confidence value={c.confidence} /></div>
        </div>
        <p className="text-sm text-slate-700 leading-relaxed">{c.summary}</p>
      </div>

      <div className="bg-white rounded-xl border border-line p-5">
        <div className="text-sm font-semibold text-ink mb-3">推荐标的（交付决策系统）</div>
        <div className="space-y-2">
          {(c.stocks || []).map((s) => (
            <div key={s.ticker} className="flex items-center gap-3 py-2 border-b border-line last:border-0">
              <span className="font-mono text-sm font-semibold text-ink w-16">{s.ticker}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ink">{s.name} <span className="text-xs text-sub">· {s.role}</span></div>
                <div className="text-xs text-sub truncate">{s.reason}</div>
              </div>
              <div className="w-28"><Confidence value={s.confidence} /></div>
            </div>
          ))}
        </div>
      </div>

      {valuation?.models?.length > 0 && (
        <div className="bg-white rounded-xl border border-line p-5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-3"><Icon.gauge size={15} className="text-cyan-600" />估值建模子 Agent</div>
          <p className="text-xs text-sub mb-3">{valuation.method}</p>
          <div className="space-y-2">
            {valuation.models.map((m) => (
              <div key={m.ticker} className="flex items-center gap-3 text-sm py-1.5 border-b border-line last:border-0">
                <span className="font-mono font-semibold text-ink w-16">{m.ticker}</span>
                <span className="text-xs text-sub">现价 ${m.currentPrice}</span>
                <span className="text-xs text-slate-500">区间 ${m.valuationRange?.low}~${m.valuationRange?.high}</span>
                <span className="text-xs text-up ml-auto">{m.upside}</span>
                <Badge color={m.rating === '低估' ? 'red' : m.rating === '高估' ? 'green' : 'slate'}>{m.rating}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {crossref?.analogies?.length > 0 && (
        <div className="bg-white rounded-xl border border-line p-5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-3"><Icon.layers size={15} className="text-cyan-600" />跨行业参考子 Agent</div>
          <div className="space-y-2.5">
            {crossref.analogies.map((a, i) => (
              <div key={i} className="border border-line rounded-lg p-3">
                <div className="text-sm font-medium text-ink">{a.case} <span className="text-xs text-sub font-normal">· {a.industry}</span></div>
                <p className="text-xs text-slate-600 mt-1">启示：{a.lesson}</p>
                {a.caution && <p className="text-[11px] text-amber-600 mt-0.5">注意：{a.caution}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {c.risks?.length > 0 && (
        <div className="bg-red-50/50 rounded-xl border border-red-100 p-5">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-red-700 mb-2"><Icon.warn size={15} />风险提示</div>
          <ul className="text-sm text-slate-600 space-y-1">
            {c.risks.map((r, i) => <li key={i}>· {r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function ChatPanel({ id, initial, onReport }) {
  const [msgs, setMsgs] = useState(initial || []);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollContainerRef = useRef(null);
  const nearBottomRef = useRef(true);
  const scrollAfterRenderRef = useRef(false);
  const initialMessagesRef = useRef(initial || []);
  const initialSignature = messagesSignature(initial || []);
  const syncedInitialSignatureRef = useRef(initialSignature);
  initialMessagesRef.current = initial || [];

  const scrollLocalToBottom = () => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    nearBottomRef.current = true;
  };

  useEffect(() => {
    scrollLocalToBottom();
  }, []);
  useEffect(() => {
    if (syncedInitialSignatureRef.current === initialSignature) return;
    syncedInitialSignatureRef.current = initialSignature;
    const next = initialMessagesRef.current;
    setMsgs((current) => {
      if (messagesSignature(current) === initialSignature) return current;
      if (hasAppendedAssistantMessage(current, next) && nearBottomRef.current) {
        scrollAfterRenderRef.current = true;
      }
      return next;
    });
  }, [initialSignature]);
  useEffect(() => {
    if (!scrollAfterRenderRef.current) return;
    scrollAfterRenderRef.current = false;
    scrollLocalToBottom();
  }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    scrollAfterRenderRef.current = true;
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    setSending(true);
    try {
      const r = await api.chat(id, text);
      if (nearBottomRef.current) scrollAfterRenderRef.current = true;
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply }]);
      onReport?.();
    } finally { setSending(false); }
  };

  return (
    <div id="report-feedback-panel" className="min-h-0 flex-1 flex flex-col">
      <div className="px-4 py-3 border-b border-line">
        <div className="text-sm font-semibold text-ink flex items-center gap-1.5"><Icon.chat size={15} className="text-brand" />Report Feedback（受限）</div>
        <div className="text-[11px] text-sub mt-0.5">
          当前仅提供有限的已发布报告反馈；反馈驱动的正式修订闭环将在后续实现。
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        onScroll={(event) => {
          const scrollContainer = event.currentTarget;
          nearBottomRef.current = (
            scrollContainer.scrollHeight
            - scrollContainer.scrollTop
            - scrollContainer.clientHeight
          ) <= CHAT_BOTTOM_THRESHOLD_PX;
        }}
        className="flex-1 overflow-auto p-4 space-y-3"
      >
        {!msgs.length && (
          <div className="text-xs text-sub bg-slate-50 rounded-lg p-3 leading-relaxed">
            试试：<br />· “把估值风险展开讲讲”<br />· “补充上游设备环节的标的”<br />· “降低对需求弹性的乐观假设”
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${m.role === 'user' ? 'bg-brand text-white rounded-br-sm' : 'bg-slate-100 text-ink rounded-bl-sm'}`}>{m.content}</div>
          </div>
        ))}
        {sending && <div className="flex justify-start"><div className="bg-slate-100 px-3 py-2 rounded-2xl rounded-bl-sm"><Spinner label="Agent 思考中…" /></div></div>}
      </div>
      <div className="p-3 border-t border-line">
        <div className="flex items-end gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={2} placeholder="输入对当前已发布报告的反馈…" className="flex-1 resize-none text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand disabled:bg-slate-50 disabled:text-slate-400" />
          <Btn size="sm" onClick={send} disabled={sending || !input.trim()}><Icon.send size={14} /></Btn>
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ icon, text }) {
  const I = Icon[icon] || Icon.doc;
  return <div className="py-20 text-center text-sub"><I size={34} className="mx-auto text-slate-300 mb-3" /><p className="text-sm">{text}</p></div>;
}
function fileIcon(n) {
  if (n.endsWith('.md')) return <Icon.doc size={14} />;
  if (n.endsWith('.json')) return <Icon.chart size={14} />;
  if (n.endsWith('.jsonl')) return <Icon.layers size={14} />;
  return <Icon.file size={14} />;
}
