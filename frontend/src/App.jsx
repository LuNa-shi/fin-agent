import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon } from './icons.jsx';
import IdeaView from './views/IdeaView.jsx';
import ProjectsView from './views/ProjectsView.jsx';
import DailyReportsView from './views/DailyReportsView.jsx';
import DailyReportDetailView from './views/DailyReportDetailView.jsx';
import DailyReportContentView from './views/DailyReportContentView.jsx';
import ReportLibraryView from './views/ReportLibraryView.jsx';
import ClaimLibraryView from './views/ClaimLibraryView.jsx';
import WorldviewProcessingLogView from './views/WorldviewProcessingLogView.jsx';
import WorldviewVersionsView from './views/WorldviewVersionsView.jsx';
import DecisionView from './views/DecisionView.jsx';
import ProjectDetail from './views/ProjectDetail.jsx';
import SettingsModal from './views/SettingsModal.jsx';
import AgentsView from './views/AgentsView.jsx';
import { t } from './i18n.js';
import { providerAvailabilityMode } from './providerModels.js';

const NAV = [
  { key: 'ideas', icon: 'idea', desc: '自动生成投资思路' },
  { key: 'projects', icon: 'library', desc: '深度研究并给出结论' },
  { key: 'dailyReports', icon: 'calendar', desc: '查看每日批次报告' },
  { key: 'reportLibrary', icon: 'library', desc: '内部研究报告与标的时间线' },
  { key: 'claimLibrary', icon: 'target', desc: 'Claims · exact evidence · immutable history' },
  { key: 'worldviewProcessing', icon: 'globe', desc: '有界 Agent Runs · KEEP / UPDATE' },
  { key: 'worldviewVersions', icon: 'layers', desc: '当前与历史完整 Canonical packages' },
  { key: 'agents', icon: 'agent', desc: 'Agent 定义 · Tools · Skills' },
  { key: 'decision', icon: 'target', desc: '组合构建 · 论据跟踪 · 复盘' },
];

export default function App() {
  const [view, setView] = useState('ideas');
  const [openProject, setOpenProject] = useState(null);
  const [openDailyRun, setOpenDailyRun] = useState(null);
  const [openDailyReport, setOpenDailyReport] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusOnline, setStatusOnline] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState('providers');

  const refreshStatus = () => api.status().then((next) => { setStatus(next); setStatusOnline(true); }).catch(() => setStatusOnline(false));
  useEffect(() => { refreshStatus(); const t = setInterval(refreshStatus, 8000); return () => clearInterval(t); }, []);

  const providerMode = providerAvailabilityMode({ statusOnline, providers: status?.providers });
  const live = providerMode === 'live';
  const lang = status?.providers?.uiLanguage || 'zh';
  const openSettings = (tab = 'providers') => { setSettingsTab(tab); setShowSettings(true); };

  return (
    <div className="app-shell h-full flex">
      {/* 侧边栏 */}
      <aside className="app-sidebar w-60 shrink-0 bg-white border-r border-line flex flex-col">
        <div className="px-5 py-5 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand text-white grid place-items-center font-bold text-[13px] tracking-tight">FA</div>
            <div>
              <div className="font-semibold text-ink leading-tight tracking-tight">Fin agent</div>
              <div className="text-[11px] text-sub">金融分析智能体</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          <div className="px-2 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">{t(lang, 'systems')}</div>
          {NAV.map((n, i) => {
            const I = Icon[n.icon];
            const active = view === n.key && !openProject;
            return (
              <button key={n.key}
                onClick={() => { setView(n.key); setOpenProject(null); setOpenDailyRun(null); setOpenDailyReport(null); }}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition flex items-start gap-3 ${active ? 'bg-blue-50 text-brand' : 'hover:bg-slate-50 text-ink'}`}>
                <span className={`mt-0.5 ${active ? 'text-brand' : 'text-slate-400'}`}><I size={18} /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 font-mono tabular-nums">{i + 1}</span>
                    <span className="font-medium text-sm">{t(lang, n.key)}</span>
                  </span>
                  <span className="block text-[11px] text-sub mt-0.5">{n.desc}</span>
                </span>
              </button>
            );
          })}

          <div className="px-2 pt-3 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">{t(lang, 'settings')}</div>
          <button onClick={() => openSettings('templates')}
            className="w-full text-left px-3 py-2.5 rounded-lg transition flex items-start gap-3 hover:bg-slate-50 text-ink">
            <span className="mt-0.5 text-slate-400"><Icon.layers size={18} /></span>
            <span className="flex-1 min-w-0">
              <span className="font-medium text-sm">{t(lang, 'templates')}</span>
              <span className="block text-[11px] text-sub mt-0.5">查看与修改研究模板</span>
            </span>
          </button>
        </nav>

        {/* 底部状态 */}
        <div className="p-3 border-t border-line space-y-1">
          <button onClick={() => openSettings('tools')}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 text-sm text-ink">
            <span className="flex items-center gap-2 text-slate-500"><Icon.tool size={16} /> {t(lang, 'tools')}</span>
            <span className="text-[10px] text-slate-400 tabular-nums">FMP · Perplexity · Tavily</span>
          </button>
          <button onClick={() => openSettings('providers')}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 text-sm text-ink">
            <span className="flex items-center gap-2 text-slate-500"><Icon.settings size={16} /> {t(lang, 'settings')}</span>
            <span className={`live-dot w-2 h-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-400'}`} />
          </button>
          <div className="px-3 mt-1 text-[10px] text-sub leading-snug">
            {providerMode === 'offline'
              ? '后端连接中断'
              : providerMode === 'live'
                ? `真实模型 · ${status?.providers?.activeProvider || ''} / ${status?.providers?.activeModel || ''}`
                : providerMode === 'demo'
                  ? t(lang, 'demo')
                  : t(lang, 'modelUnavailable')}
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="app-main flex-1 min-w-0 overflow-hidden flex flex-col">
        {openProject ? (
          <ProjectDetail id={openProject} onBack={() => setOpenProject(null)} onChanged={refreshStatus} />
        ) : openDailyRun && openDailyReport ? (
          <DailyReportContentView runId={openDailyRun} projectId={openDailyReport} onBack={() => setOpenDailyReport(null)} />
        ) : openDailyRun ? (
          <DailyReportDetailView
            runId={openDailyRun}
            onBack={() => { setOpenDailyRun(null); setOpenDailyReport(null); }}
            onOpenReport={setOpenDailyReport}
          />
        ) : view === 'ideas' ? (
          <IdeaView
            onAdded={refreshStatus}
            goProjects={() => setView('projects')}
            onOpenProject={(id) => { setOpenDailyRun(null); setOpenProject(id); }}
            lang={lang}
          />
        ) : view === 'projects' ? (
          <ProjectsView onOpen={(id) => setOpenProject(id)} onChanged={refreshStatus} onManageTemplates={() => openSettings('templates')} />
        ) : view === 'dailyReports' ? (
          <DailyReportsView onOpenRun={(runId) => { setOpenDailyRun(runId); setOpenDailyReport(null); }} />
        ) : view === 'reportLibrary' ? (
          <ReportLibraryView />
        ) : view === 'claimLibrary' ? (
          <ClaimLibraryView />
        ) : view === 'worldviewProcessing' ? (
          <WorldviewProcessingLogView />
        ) : view === 'worldviewVersions' ? (
          <WorldviewVersionsView />
        ) : view === 'agents' ? (
          <AgentsView />
        ) : (
          <DecisionView onChanged={refreshStatus} openProject={(id) => setOpenProject(id)} />
        )}
      </main>

      {showSettings && <SettingsModal onClose={() => { setShowSettings(false); refreshStatus(); }} status={status} initialTab={settingsTab} />}
    </div>
  );
}
