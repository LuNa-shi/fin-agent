import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Btn } from './Shell.jsx';
import { Icon } from '../icons.jsx';
import { Badge, Confidence } from '../components.jsx';
import { ratingLabel } from '../i18n.js';

const STATUS_MAP = {
  created: { label: '待分析', color: 'slate' },
  queued: { label: '排队中', color: 'amber' },
  analyzing: { label: '分析中', color: 'amber' },
  paused: { label: '已暂停', color: 'amber' },
  interrupted: { label: '已中断', color: 'amber' },
  'review-required': { label: '未发布', color: 'red' },
  failed: { label: '分析失败', color: 'red' },
  cancelled: { label: '已取消', color: 'slate' },
  analyzed: { label: '已出结论', color: 'green' },
};
const analysisInFlight = (status) => ['queued', 'analyzing'].includes(status);
const REPORT_PENDING_COPY = {
  queued: '分析已排队，报告尚未就绪。',
  analyzing: '分析进行中，报告尚未就绪。',
  paused: '分析已暂停，报告尚未就绪。',
  interrupted: '分析已中断；如状态允许，可进入项目从断点继续。报告尚未就绪。',
  'review-required': '历史未发布状态已退役；请重新运行分析生成最终报告。',
  failed: '本次分析失败，尚无已验证报告。',
  cancelled: '分析已取消，尚无已验证报告。',
};

export default function ProjectsView({ onOpen, onChanged, onManageTemplates }) {
  const [projects, setProjects] = useState([]);
  const [quickText, setQuickText] = useState('');
  const [intensity, setIntensity] = useState('standard');
  const [analysisLanguage, setAnalysisLanguage] = useState('en');
  const [reportLanguage, setReportLanguage] = useState('en');
  const [companyLocale, setCompanyLocale] = useState('global');
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState(null);

  const load = () => api.projects().then((r) => setProjects(r.projects || []));
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  const del = async (e, p) => {
    e.stopPropagation();
    if (!window.confirm(`删除项目「${p.title}」？该操作不可撤销（含数据/分析/报告）。`)) return;
    const r = await api.deleteProject(p.id); setProjects(r.projects || []); onChanged?.();
  };
  const pause = async (e, p) => {
    e.stopPropagation();
    await api.pauseProject(p.id);
    await load();
    onChanged?.();
  };

  const quickCreate = async () => {
    const text = quickText.trim();
    if (!text || creating) return;
    setCreating(true); setPreview(null);
    try {
      const r = await api.quickProject(text, intensity, { analysisLanguage, reportLanguage, companyLocale });
      setPreview(r.classify);
      setQuickText('');
      await load(); onChanged?.();
      // 短暂展示归类结果后进入项目
      setTimeout(() => { onOpen(r.project.id); }, 700);
    } finally { setCreating(false); }
  };

  return (
    <>
      <PageHeader title="金融项目分析库" subtitle="每个题目对应 data / analysis / report 三层公开项目文件；canonical Run Analysis Workflow 产出分析与报告">
        <Btn variant="ghost" size="sm" onClick={onManageTemplates}><Icon.edit size={14} />分析模板</Btn>
      </PageHeader>

      <div className="flex-1 overflow-auto p-7">
        {/* 一句话快速建项目 */}
        <div className="bg-white rounded-xl border border-line p-4 mb-6">
          <div className="flex items-center gap-1.5 mb-2.5 text-ink">
            <Icon.spark size={15} className="text-brand" />
            <span className="text-sm font-medium">一句话快速建项目</span>
            <span className="text-[11px] text-sub">输入一句话，自动归类主题、匹配分析模板与候选标的</span>
          </div>
          <div className="flex gap-2">
            <input value={quickText} onChange={(e) => setQuickText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') quickCreate(); }}
              placeholder="如：金刚石散热有投资机会 / 半导体供给瓶颈值得研究"
              className="flex-1 text-sm border border-line rounded-lg px-3.5 py-2.5 focus:outline-none focus:border-brand" />
            <select value={intensity} onChange={(e) => setIntensity(e.target.value)}
              title="快速≈15min：1轮起步、最多2轮；标准≈30min：2轮起步、最多3轮并含 transcript/联网研究；深度≈60min：2轮起步、最多3轮且单轮 wall-clock 更充足"
              className="text-sm border border-line rounded-lg px-2.5 focus:outline-none focus:border-brand text-sub">
              <option value="quick">快速 ~15min</option>
              <option value="standard">标准 ~30min</option>
              <option value="deep">深度 ~60min</option>
            </select>
            <select value={analysisLanguage} onChange={(e) => setAnalysisLanguage(e.target.value)}
              className="text-sm border border-line rounded-lg px-2.5 focus:outline-none focus:border-brand text-sub">
              <option value="en">分析 EN</option>
              <option value="zh">分析 中文</option>
              <option value="auto">分析 Auto</option>
            </select>
            <select value={reportLanguage} onChange={(e) => setReportLanguage(e.target.value)}
              className="text-sm border border-line rounded-lg px-2.5 focus:outline-none focus:border-brand text-sub">
              <option value="en">报告 EN</option>
              <option value="zh">报告 中文</option>
              <option value="auto">报告 Auto</option>
            </select>
            <select value={companyLocale} onChange={(e) => setCompanyLocale(e.target.value)}
              className="text-sm border border-line rounded-lg px-2.5 focus:outline-none focus:border-brand text-sub">
              <option value="global">Global</option>
              <option value="cn">中国公司</option>
              <option value="us">美股公司</option>
            </select>
            <Btn onClick={quickCreate} disabled={creating || !quickText.trim()}>
              {creating ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />归类中…</> : <><Icon.plus size={14} />创建</>}
            </Btn>
          </div>
          {preview && (
            <div className="mt-3 flex items-center gap-2 text-xs text-sub bg-slate-50 rounded-lg px-3 py-2">
              <Icon.check size={13} className="text-emerald-600" />
              已归类为 <Badge color="blue">{preview.theme}</Badge>
              <span>· 行业</span><Badge color="purple">{preview.industryTemplate || 'auto'}</Badge>
              <span>· 公司</span><Badge color="purple">{preview.companyTemplate || 'auto'}</Badge>
              <span>· 标的 {(preview.tickers || []).join(', ') || '—'}，正在进入项目…</span>
            </div>
          )}
        </div>

        {!projects.length && (
          <div className="py-16 text-center text-sub">
            <Icon.library size={36} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm">暂无项目。用上方「一句话快速建项目」，或到「Idea 生成」选中思路加入分析库。</p>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {projects.map((p) => {
            const st = STATUS_MAP[p.status] || STATUS_MAP.created;
            return (
              <div key={p.id} onClick={() => onOpen(p.id)}
                className="bg-white rounded-xl border border-line p-5 hover:shadow-md hover:border-blue-200 transition cursor-pointer group">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge color="blue">{p.theme || '主题'}</Badge>
                    <Badge color={st.color}>
                      {p.status === 'analyzing' && <span className="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse mr-1" />}
                      {st.label}
                      {p.status === 'queued' && p.analysis?.queuePosition > 0
                        ? ` · 第 ${p.analysis.queuePosition} 位`
                        : ''}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.tracking && <Icon.pin size={14} className="text-amber-500" />}
                    {analysisInFlight(p.status) && (
                      <button onClick={(e) => pause(e, p)} title="暂停分析"
                        className="text-slate-400 hover:text-amber-600 transition"><Icon.pause size={14} /></button>
                    )}
                    <button onClick={(e) => del(e, p)} title="删除项目"
                      className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"><Icon.trash size={14} /></button>
                  </div>
                </div>
                <h3 className="font-semibold text-ink leading-snug mb-3 group-hover:text-brand transition line-clamp-2">{p.titleZh || p.title}</h3>
                <ProjectRuntimeSummary project={p} />
                {analysisInFlight(p.status) && p.progress && (
                  <div className="mb-3 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full transition-all duration-700" style={{ width: `${p.progress.pct}%` }} />
                    </div>
                    <span className="text-[10px] text-sub whitespace-nowrap tabular-nums">{p.progress.stage} {p.progress.pct}%{p.progress.etaMin ? ` · ~${p.progress.etaMin}min` : ''}</span>
                  </div>
                )}

                {p.reportReady && p.conclusion ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-sub">评级</span>
                      <Badge color="purple">{ratingLabel(p.conclusion.rating)}</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-sub shrink-0">置信度</span>
                      <Confidence value={p.conclusion.confidence} />
                    </div>
                    <div className="flex gap-1 flex-wrap pt-1">
                      {(p.conclusion.stocks || []).slice(0, 4).map((s) => (
                        <span key={s.ticker} className="font-mono text-[11px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-600">{s.ticker}</span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-sub">
                    {REPORT_PENDING_COPY[p.status] || '尚未运行分析，点击进入并启动 Workflow。'}
                  </p>
                )}
                <div className="mt-3 pt-3 border-t border-line flex items-center justify-between text-[11px] text-sub">
                  <span className="flex items-center gap-2">
                    <span>{new Date(p.createdAt).toLocaleDateString('zh-CN')}</span>
                    {p.industryTemplateName && <span className="text-slate-400">· 行业 {p.industryTemplateName}</span>}
                    {p.companyTemplateName && <span className="text-slate-400">· 公司 {p.companyTemplateName}</span>}
                    {p.frameworkVersion && <span className="text-slate-400 font-mono">· fw {p.frameworkVersion}</span>}
                  </span>
                  <span className="text-brand opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5">详情<Icon.arrowRight size={12} /></span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function ProjectRuntimeSummary({ project }) {
  const hasDurableLineage = Boolean(
    project.sourceIdeaId
    && project.sourceIdeaRunId
    && project.sourceRunInputSnapshotId,
  );
  return (
    <div className="mb-3 rounded-lg border border-line bg-slate-50 px-3 py-2 text-[10px] text-slate-600 space-y-0.5">
      <div className="font-mono truncate" title={project.sourceIdeaId || ''}>sourceIdeaId · {project.sourceIdeaId || '未记录'}</div>
      <div className="font-mono truncate" title={project.sourceIdeaRunId || ''}>sourceIdeaRunId · {project.sourceIdeaRunId || '未记录'}</div>
      <div className="font-mono truncate" title={project.sourceRunInputSnapshotId || ''}>sourceRunInputSnapshotId · {project.sourceRunInputSnapshotId || '未记录'}</div>
      {!hasDurableLineage && <div>Idea lineage · 无 durable lineage</div>}
      <div className="font-mono truncate" title={project.analysisRunId || ''}>
        当前 analysis run id · {project.analysisRunId || '尚未创建'}
      </div>
      <div>reportReady · {project.reportReady ? 'true（已验证发布）' : 'false（未发布）'}</div>
    </div>
  );
}
