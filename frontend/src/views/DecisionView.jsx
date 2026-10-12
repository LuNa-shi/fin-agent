import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Btn } from './Shell.jsx';
import { Badge, Confidence, Spinner } from '../components.jsx';
import { Icon } from '../icons.jsx';
import { gateReasonLabel, ratingLabel, capBucketLabel } from '../i18n.js';

export default function DecisionView({ onChanged, openProject }) {
  const [portfolio, setPortfolio] = useState([]);
  const [reflections, setReflections] = useState([]);
  const [recommendation, setRecommendation] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [recommending, setRecommending] = useState(false);
  const [buildSteps, setBuildSteps] = useState([]);   // 构建过程实时步骤（PM 思考轨迹）
  const [summary, setSummary] = useState(null);
  const [reflectingId, setReflectingId] = useState(null);
  const [ranking, setRanking] = useState(null);
  const [rankingBusy, setRankingBusy] = useState(false);
  const [watched, setWatched] = useState(false);
  const [contracts, setContracts] = useState({});     // { ticker: contract } —— 冻结的论点契约
  const [mandate, setMandate] = useState(null);         // { mandate, defaults }
  const [calibration, setCalibration] = useState(null); // { bins, recent, samples }
  const [expanded, setExpanded] = useState(null);       // 展开契约详情的 ticker

  const load = () => Promise.all([
    api.portfolio(), api.reflections(), api.ideaRanking(),
    api.contracts().catch(() => ({})), api.mandate().catch(() => null), api.portfolioCalibration().catch(() => null),
  ]).then(([p, r, rk, ct, md, cal]) => {
    setPortfolio(p.portfolio || []); setReflections(r.reflections || []); setRecommendation(p.recommendation || null); setRanking(rk.ranking || null);
    setWatched(!!p.recommendation?.watchedAt);
    // Contracts.open() 返回契约数组 → 按 ticker 建索引供持仓行展开查用
    const openArr = Array.isArray(ct?.open) ? ct.open : (ct?.open ? Object.values(ct.open) : []);
    setContracts(Object.fromEntries(openArr.map((c) => [String(c.ticker).toUpperCase(), c])));
    setMandate(md || null); setCalibration(cal?.calibration || cal || null);
  });
  useEffect(() => { load(); }, []);

  const doRank = async () => { setRankingBusy(true); try { const r = await api.rankIdeas(); setRanking(r.ranking || null); } finally { setRankingBusy(false); } };
  const doWatch = async () => {
    if (!window.confirm('将当前推荐组合加入观察系统？将以现价为基准建仓，之后持续跟踪该组合表现（会重置历史净值）。')) return;
    const r = await api.watch(); setPortfolio(r.portfolio || []); setSummary(r.tracking || null); setWatched(true); onChanged?.();
  };

  const totalWeight = portfolio.reduce((s, p) => s + (p.weight || 0), 0);
  const cash = Math.max(0, 1 - totalWeight);

  // 统一入口：从已完成的研究项目中选出候选 → 基础筛选 → 逐组对比排序 → 分配仓位并记录投资论据。
  // 轮询 progress 实时展示对比过程（每组排名+理由）。有项目仍在分析时后端返回 409，提示等待或强行继续。
  const doRecommend = async (force = false) => {
    if (!force && !window.confirm('根据所有已完成的研究结论构建新的投资组合：先做基础筛选（流动性、杠杆、数据完整性），再逐组对比选出最优持仓并分配仓位。每只持仓会记录完整的买入理由与验证条件。当前组合将被替换，继续？')) return;
    setRecommending(true); setBuildSteps([]);
    const poll = setInterval(async () => {
      try { const { progress } = await api.recommendProgress(); if (progress?.steps) setBuildSteps([...progress.steps]); } catch {}
    }, 2000);
    try { const r = await api.recommend(force); setPortfolio(r.portfolio || []); setRecommendation(r.recommendation || null); await load(); onChanged?.(); }
    catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('仍在分析')) {
        clearInterval(poll); setRecommending(false);
        if (window.confirm(`${msg.replace(/^API \d+ [^:]*: /, '')}。\n\n仍要现在构建吗？（等待分析完成后再构建可纳入它们的结论）`)) return doRecommend(true);
        return;
      }
      window.alert(`构建失败：${msg}`);
    }
    finally { clearInterval(poll); setRecommending(false); }
  };
  const doTrack = async () => {
    setTracking(true);
    try { const r = await api.track(); setPortfolio(r.portfolio || []); setSummary(r.tracking || null); } finally { setTracking(false); }
  };
  const doReflect = async (ticker) => {
    setReflectingId(ticker);
    try { await api.reflect(ticker); await load(); onChanged?.(); } finally { setReflectingId(null); }
  };
  const remove = async (ticker) => { const r = await api.removePos(ticker); setPortfolio(r.portfolio || []); onChanged?.(); };

  return (
    <>
      <PageHeader title="投资组合" subtitle="从已完成的研究中选出最优组合 · 每只持仓记录买入理由、验证条件与人工复盘检查点">
        <Btn size="sm" onClick={() => doRecommend()} disabled={recommending}>
          {recommending ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />构建中…</> : <><Icon.chart size={13} />构建投资组合</>}
        </Btn>
        {recommendation && !watched && <Btn variant="ghost" size="sm" onClick={doWatch}><Icon.eye size={13} />加入观察系统</Btn>}
        <Btn variant="ghost" size="sm" onClick={doTrack} disabled={tracking || !portfolio.length}>
          {tracking ? '抓取中…' : <><Icon.refresh size={13} />{watched ? '跟踪表现' : '跟踪收益'}</>}
        </Btn>
      </PageHeader>

      <div className="flex-1 overflow-auto p-7 space-y-6">
        {/* 构建过程：PM 思考轨迹实时展示（构建中 + 构建刚结束保留） */}
        {(recommending || buildSteps.length > 0) && <BuildProgress steps={buildSteps} running={recommending} onDismiss={() => setBuildSteps([])} />}

        {/* 概览 */}
        <div className="grid grid-cols-4 gap-4">
          <OverviewCard label="持仓数量" value={portfolio.length} unit="只" />
          <OverviewCard label="已配置仓位" value={(totalWeight * 100).toFixed(1)} unit="%" />
          <OverviewCard label="现金仓位" value={(cash * 100).toFixed(1)} unit="%" />
          <OverviewCard label="绩效复盘" value={reflections.length} unit="条" />
        </div>

        {/* Mandate（外部可调）+ 推荐分绩效校准 */}
        <div className="grid grid-cols-2 gap-4">
          <MandatePanel data={mandate} onSaved={(m) => setMandate((prev) => ({ ...prev, mandate: m }))} />
          <CalibrationPanel cal={calibration} />
        </div>

        {/* 组合因子暴露度（组合 agent 量化分析） */}
        {recommendation?.factors && (
          <div className="bg-white rounded-xl border border-line px-5 py-4">
            <div className="flex items-center gap-1.5 mb-3 text-sm font-semibold text-ink">
              <Icon.chart size={15} className="text-brand" />组合风险画像（beta / 波动 / 行业与主题集中度）
              <span className="ml-auto text-[11px] font-normal text-sub">{recommendation.candidates} 候选 → {recommendation.holdings} 持仓 · {new Date(recommendation.ts).toLocaleDateString('zh-CN')}</span>
            </div>
            <div className="grid grid-cols-6 gap-3 mb-3">
              <FactorCell label="组合 Beta" value={recommendation.factors.weightedBeta} hot={recommendation.factors.weightedBeta > 1.3} />
              <FactorCell label="组合波动率(含相关性)" value={recommendation.factors.portfolioVol ?? recommendation.factors.weightedVol} unit="%" hot={(recommendation.factors.portfolioVol ?? recommendation.factors.weightedVol) > 40} />
              <FactorCell label="加权 PEG" value={recommendation.factors.weightedPEG} />
              <FactorCell label="营收增速" value={recommendation.factors.weightedRevGrowth} unit="%" />
              <FactorCell label="加权 ROE" value={recommendation.factors.weightedROE} unit="%" />
              <FactorCell label="3M 动量" value={recommendation.factors.weightedMomentum3m} unit="%" />
            </div>
            {(recommendation.cashWeight > 0.005 || recommendation.factors.topCorrelation) && (
              <div className="mb-2 text-[11px] text-sub flex gap-3 flex-wrap">
                {recommendation.cashWeight > 0.005 && <span>现金保留 {(recommendation.cashWeight * 100).toFixed(1)}%</span>}
                {recommendation.factors.topCorrelation && (
                  <span className={Math.abs(recommendation.factors.topCorrelation.rho) > 0.7 ? 'text-amber-600' : ''}>
                    相关性最高持仓对：{recommendation.factors.topCorrelation.pair.join(' × ')} ρ={recommendation.factors.topCorrelation.rho}
                  </span>
                )}
              </div>
            )}
            {recommendation.factors.thesisExposure?.length > 0 && (
              <div className="mb-2">
                <div className="text-[11px] text-sub mb-1">Thesis 暴露度</div>
                <div className="flex gap-1.5 flex-wrap">
                  {recommendation.factors.thesisExposure.map((t, i) => (
                    <span key={i} className={`text-[11px] px-2 py-0.5 rounded ${t.weight > 0.35 ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-600'}`}>{t.thesis} {(t.weight * 100).toFixed(0)}%</span>
                  ))}
                </div>
              </div>
            )}
            {recommendation.factors.sectorBreakdown?.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mb-2">
                <span className="text-[11px] text-sub mr-1">行业:</span>
                {recommendation.factors.sectorBreakdown.map((s) => (
                  <span key={s.sector} className="text-[11px] px-2 py-0.5 bg-slate-100 text-slate-600 rounded">{s.sector} {(s.weight * 100).toFixed(0)}%</span>
                ))}
              </div>
            )}
            {recommendation.portfolioView?.styleTilt && <p className="text-xs text-slate-600 mb-1"><span className="text-slate-400">风格画像：</span>{recommendation.portfolioView.styleTilt}</p>}
            {recommendation.portfolioView?.betaComment && <p className="text-xs text-slate-600 mb-1"><span className="text-slate-400">Beta 解读：</span>{recommendation.portfolioView.betaComment}</p>}
            {recommendation.portfolioView?.keyRisks?.length > 0 && (
              <div className="mt-2 text-xs text-slate-500 bg-amber-50/60 border border-amber-100 rounded-lg p-2.5">
                <span className="font-medium text-amber-700">组合风险：</span>{recommendation.portfolioView.keyRisks.join('；')}
              </div>
            )}
            {recommendation.excluded?.length > 0 && (
              <div className="mt-2 text-[11px] text-sub">未通过筛选：{recommendation.excluded.map((e) => `${e.ticker}（${(e.reason || '').split('、').map(gateReasonLabel).join('/')}）`).join('、')}</div>
            )}
          </div>
        )}

        {/* 虚拟盘净值 vs 基准 */}
        {summary && (
          <div className="bg-white rounded-xl border border-line px-5 py-4">
            <div className="flex items-center gap-1.5 mb-3 text-sm font-semibold text-ink"><Icon.gauge size={15} className="text-brand" />虚拟盘表现（vs {summary.benchmark}）<span className="ml-auto text-[11px] font-normal text-sub">更新于 {new Date(summary.asOf).toLocaleString('zh-CN', { hour12: false })}</span></div>
            <div className="grid grid-cols-4 gap-4">
              <PerfCell label="组合收益（NAV 口径）" pct={summary.portReturn} />
              <PerfCell label={`${summary.benchmark} 同期`} pct={summary.benchReturn} />
              <PerfCell label="超额收益 α" pct={summary.alpha} strong />
              <div>
                <div className="text-[11px] text-sub mb-1">盈亏分布（vs 基准）</div>
                <div className="text-sm"><span className="text-up font-semibold">{summary.winners} 赢</span> <span className="text-slate-300">/</span> <span className="text-down font-semibold">{summary.losers} 输</span></div>
              </div>
            </div>
            {(summary.nav != null || summary.maxDrawdownPct != null) && (
              <div className="mt-2 text-[11px] text-sub flex gap-4 flex-wrap">
                {summary.nav != null && <span>净值 {Number(summary.nav).toFixed(4)}（基准 {Number(summary.benchNav ?? 1).toFixed(4)}）</span>}
                {summary.maxDrawdownPct != null && <span className={summary.maxDrawdownPct > 15 ? 'text-amber-600' : ''}>最大回撤 {summary.maxDrawdownPct}%</span>}
                {summary.cashWeight != null && <span>现金 {(summary.cashWeight * 100).toFixed(1)}%</span>}
              </div>
            )}
          </div>
        )}

        {/* idea 多维排序 */}
        <div className="bg-white rounded-xl border border-line">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between">
            <span className="font-semibold text-ink text-sm inline-flex items-center gap-1.5"><Icon.idea size={15} className="text-brand" />项目库 idea 排序（多维度）{ranking && <span className="text-[11px] font-normal text-sub">· {ranking.count} 条 · {new Date(ranking.ts).toLocaleDateString('zh-CN')}</span>}</span>
            <Btn variant="ghost" size="sm" onClick={doRank} disabled={rankingBusy}>{rankingBusy ? '排序中…' : <><Icon.refresh size={12} />重新排序</>}</Btn>
          </div>
          {!ranking?.rankings?.length ? (
            <div className="py-10 text-center text-sub text-sm">点击「重新排序」，agent 会对项目库所有 idea 按催化/预期差/确定性/估值/时效/独特性多维打分排序。</div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-sub border-b border-line">
                <th className="text-left font-medium px-5 py-2">#</th><th className="text-left font-medium py-2">idea</th>
                <th className="text-center font-medium py-2">催化</th><th className="text-center font-medium py-2">预期差</th><th className="text-center font-medium py-2">确定性</th><th className="text-center font-medium py-2">估值</th><th className="text-center font-medium py-2">时效</th><th className="text-center font-medium py-2">独特性</th>
                <th className="text-right font-medium px-5 py-2">综合</th>
              </tr></thead>
              <tbody>
                {ranking.rankings.slice(0, 15).map((r, i) => (
                  <tr key={i} className="border-b border-line last:border-0 hover:bg-slate-50/50">
                    <td className="px-5 py-2 text-slate-400 font-mono">{i + 1}</td>
                    <td className="py-2 max-w-sm"><div className="text-ink truncate">{r.title}</div><div className="text-[11px] text-sub truncate">{r.theme} · {(Array.isArray(r.tickers) ? r.tickers : String(r.tickers || '').split(/[,，]/)).filter(Boolean).slice(0, 4).join(',')}{r.note ? ` — ${r.note}` : ''}</div></td>
                    <RankScore v={r.catalyst} /><RankScore v={r.edge} /><RankScore v={r.conviction} /><RankScore v={r.valuation} /><RankScore v={r.timeliness} /><RankScore v={r.uniqueness} />
                    <td className="px-5 py-2 text-right"><span className="font-bold tabular-nums text-brand">{r.overall}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 股票池 */}
        <div className="bg-white rounded-xl border border-line">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between">
            <span className="font-semibold text-ink text-sm inline-flex items-center gap-1.5"><Icon.chart size={15} className="text-brand" />推荐持仓 & 组合风控</span>
            <span className="text-xs text-sub">涨跌色：<span className="text-up">红涨</span> / <span className="text-down">绿跌</span></span>
          </div>
          {!portfolio.length ? (
            <div className="py-16 text-center text-sub">
              <Icon.target size={28} className="mx-auto text-slate-300 mb-2" />
              <p className="text-sm">暂无持仓。点击「构建投资组合」，系统会从所有已完成的研究结论中选出最优组合；也可在项目详情页手动「纳入股票池」。</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-sub border-b border-line">
                  <th className="text-left font-medium px-5 py-2.5">标的</th>
                  <th className="text-center font-medium py-2.5">对比排名</th>
                  <th className="text-center font-medium py-2.5">预期收益 / 观点支持</th>
                  <th className="text-left font-medium py-2.5">来源主题 / 理由</th>
                  <th className="text-right font-medium py-2.5">仓位</th>
                  <th className="text-right font-medium py-2.5">收益率</th>
                  <th className="text-right font-medium px-5 py-2.5">操作</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.map((p) => {
                  const open = expanded === p.ticker;
                  return (
                  <React.Fragment key={p.ticker}>
                  <tr className="border-b border-line last:border-0 hover:bg-slate-50/50 cursor-pointer" onClick={() => setExpanded(open ? null : p.ticker)}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        <Icon.arrowRight size={11} className={`text-slate-300 transition-transform ${open ? 'rotate-90' : ''}`} />
                        <span className="font-mono font-semibold text-ink">{p.ticker}</span>
                        {p.factors?.beta != null && <span className={`text-[10px] px-1 py-0.5 rounded ${p.factors.beta > 1.3 ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-500'}`}>β{p.factors.beta}</span>}
                        {p.contractId && <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-600" title="已记录投资论据（买入理由/验证条件，建仓时定格）">论据</span>}
                      </div>
                      <div className="text-[11px] text-sub pl-4">{p.name}{p.factors?.capBucket ? ` · ${capBucketLabel(p.factors.capBucket)}` : ''}</div>
                    </td>
                    <td className="py-3 text-center whitespace-nowrap">
                      {p.rank != null ? (
                        <>
                          <span className="font-mono font-semibold text-brand">#{p.rank}</span>
                          {p.rating != null && <div className="text-[10px] text-sub" title="对比评分（保守值 = 评分 - 2×不确定度）">评分{Math.round(p.rating)}{p.conservative != null ? ` · 保守${Math.round(p.conservative)}` : ''}</div>}
                        </>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-3 text-center whitespace-nowrap">
                      {p.odds ? (
                        <span className="font-mono text-xs text-ink" title="期望收益 · 赔率(概率加权上行/下行)">
                          {p.odds.expectedReturnPct != null ? `E ${p.odds.expectedReturnPct > 0 ? '+' : ''}${p.odds.expectedReturnPct}%` : '—'}
                          {p.odds.skew != null && <span className="text-indigo-600"> · {p.odds.skew}:1</span>}
                        </span>
                      ) : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                    <td className="py-3 max-w-xs">
                      <button onClick={(e) => { e.stopPropagation(); p.projectId && openProject(p.projectId); }} className="text-xs text-brand hover:underline block truncate text-left">{p.theme}</button>
                      <div className="text-[11px] text-sub truncate">{p.factorNote || p.reason}</div>
                    </td>
                    <td className="py-3 text-right">
                      <span className="font-mono text-ink">{((p.weight || 0) * 100).toFixed(1)}%</span>
                    </td>
                    <td className="py-3 text-right font-mono">
                      {p.returnPct != null ? (
                        <span className={p.returnPct >= 0 ? 'text-up' : 'text-down'}>{p.returnPct >= 0 ? '+' : ''}{p.returnPct}%</span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button onClick={(e) => { e.stopPropagation(); doReflect(p.ticker); }} disabled={reflectingId === p.ticker}
                        className="text-xs text-purple-600 hover:underline mr-3 inline-flex items-center gap-1">{reflectingId === p.ticker ? '复盘中…' : <><Icon.refresh size={12} />复盘</>}</button>
                      <button onClick={(e) => { e.stopPropagation(); remove(p.ticker); }} className="text-xs text-slate-400 hover:text-red-500">移除</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50/60"><td colSpan={7} className="px-5 py-4"><ContractDetail pos={p} contract={contracts[String(p.ticker).toUpperCase()]} /></td></tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 绩效复盘记录 */}
        <div className="bg-white rounded-xl border border-line">
          <div className="px-5 py-3 border-b border-line">
            <span className="font-semibold text-ink text-sm inline-flex items-center gap-1.5"><Icon.brain size={15} className="text-purple-500" />平仓绩效复盘 · 双轴检查</span>
            <span className="text-xs text-sub ml-2">按「判断对错 × 是否赚钱」两个维度记录本次持仓结果，供人工回看</span>
          </div>
          {!reflections.length ? (
            <div className="py-10 text-center text-sub text-sm">暂无绩效复盘记录。对持仓点击「复盘」即可记录结果。</div>
          ) : (
            <div className="divide-y divide-line">
              {reflections.map((r) => (
                <div key={r.id} className="px-5 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs font-semibold text-ink">{r.ticker}</span>
                    {r.quadrant && <QuadBadge quad={r.quadrant} />}
                    {r.biasType && <Badge color="amber">{r.biasType}</Badge>}
                    {r.returnPct != null && <span className={`text-xs font-mono ${r.returnPct >= 0 ? 'text-up' : 'text-down'}`}>{r.returnPct >= 0 ? '+' : ''}{r.returnPct}%</span>}
                    <span className="text-[11px] text-slate-400 ml-auto">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                  </div>
                  {(r.quadNote || (r.thesisRight != null && r.madeMoney != null)) && (
                    <div className="text-[11px] text-sub mb-1">
                      {r.thesisRight != null && <span className="mr-2">论点 {r.thesisRight ? '✓对' : '✗错'} · 收益 {r.madeMoney ? '✓赚' : '✗亏'}</span>}
                      {r.quadNote && <span className="text-slate-400">{r.quadNote}</span>}
                    </div>
                  )}
                  <p className="text-sm text-slate-700 leading-relaxed">{r.lesson}</p>
                  {r.adjustment && <p className="text-xs text-purple-600 mt-1">调整建议：{r.adjustment}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// 组合构建过程面板：五个大步骤清单（做了什么/正在做什么/还有什么/用时），对比明细折叠在步骤内。
const BUILD_STEPS = [
  { key: 'candidates', label: '整理候选', desc: '从已完成的研究结论中收集候选股票', match: (s) => s.stage === 'candidates' },
  { key: 'gated', label: '基础筛选', desc: '流动性 · 杠杆 · 数据完整性检查', match: (s) => s.stage === 'gated' },
  { key: 'screen', label: '逐组对比', desc: '候选分组两两对比，按风险调整后收益排序', match: (s) => s.stage.startsWith('ladder:screen') },
  { key: 'fine', label: '决选排序', desc: '入围者再次对比，确定最终名次', match: (s) => s.stage.startsWith('ladder:fine') || s.stage === 'ladder:done' },
  { key: 'done', label: '分配仓位', desc: '计算权重，记录每只持仓的投资论据', match: (s) => s.stage === 'done' },
];
function BuildProgress({ steps, running, onDismiss }) {
  const [showDetail, setShowDetail] = React.useState(false);
  const cand = steps.find((s) => s.stage === 'candidates');
  const gated = steps.find((s) => s.stage === 'gated');
  const done = steps.find((s) => s.stage === 'done');
  const compares = steps.filter((s) => (s.stage === 'ladder:screen' || s.stage === 'ladder:fine') && s.order?.length);
  const t0 = steps[0]?.ts;
  // 每个大步骤的状态：其后有更晚阶段的事件 → 完成；有本阶段事件 → 进行中；否则待办
  const stepStates = BUILD_STEPS.map((bs, i) => {
    const mine = steps.filter(bs.match);
    const laterHas = BUILD_STEPS.slice(i + 1).some((later) => steps.some(later.match));
    const status = mine.length ? (laterHas || (!running && bs.key === 'done') ? 'done' : (running ? 'active' : 'done')) : 'todo';
    const start = mine[0]?.ts, end = laterHas ? steps.filter(BUILD_STEPS[i + 1].match)[0]?.ts : (running ? Date.now() : steps[steps.length - 1]?.ts);
    return { ...bs, status, secs: (start && end) ? Math.max(0, Math.round((end - start) / 1000)) : null };
  });
  const summaryBits = [
    cand && `候选 ${cand.count} 只`,
    cand?.excludedStale?.length ? `${cand.excludedStale.length} 个过期项目未纳入` : null,
    gated && `通过筛选 ${gated.survivors} 只${gated.blocked ? `（${gated.blocked} 只未通过）` : ''}`,
    done && `落定 ${done.holdings?.length} 只持仓 · 现金 ${(done.cashWeight * 100).toFixed(0)}%`,
  ].filter(Boolean);
  return (
    <div className="bg-white rounded-xl border border-indigo-200 px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        {running && <span className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />}
        <span className="text-sm font-semibold text-ink">{running ? '正在构建投资组合' : '本次构建过程'}</span>
        {t0 && <span className="text-[11px] text-sub">已用 {Math.round(((running ? Date.now() : steps[steps.length - 1]?.ts || t0) - t0) / 60000)} 分钟{running ? ' · 通常约 3-8 分钟' : ''}</span>}
        {!running && <button onClick={onDismiss} className="ml-auto text-[11px] text-slate-400 hover:text-slate-600">收起</button>}
      </div>
      <div className="flex items-stretch gap-1 mb-3">
        {stepStates.map((s, i) => (
          <React.Fragment key={s.key}>
            {i > 0 && <div className={`self-center w-4 h-px ${s.status !== 'todo' ? 'bg-indigo-300' : 'bg-slate-200'}`} />}
            <div className={`flex-1 rounded-lg border px-2.5 py-2 ${s.status === 'active' ? 'border-indigo-300 bg-indigo-50/60' : s.status === 'done' ? 'border-emerald-200 bg-emerald-50/40' : 'border-line bg-slate-50/50'}`}>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                {s.status === 'done' ? <span className="text-emerald-600">✓</span> : s.status === 'active' ? <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" /> : <span className="w-2 h-2 rounded-full bg-slate-300" />}
                <span className={s.status === 'todo' ? 'text-slate-400' : 'text-ink'}>{s.label}</span>
                {s.secs != null && s.status !== 'todo' && <span className="ml-auto text-[10px] text-slate-400 tabular-nums">{s.secs >= 60 ? `${Math.round(s.secs / 60)}m` : `${s.secs}s`}</span>}
              </div>
              <div className="text-[10px] text-sub mt-0.5 leading-snug">{s.desc}</div>
            </div>
          </React.Fragment>
        ))}
      </div>
      {summaryBits.length > 0 && <div className="text-[11px] text-sub mb-1">{summaryBits.join(' · ')}</div>}
      {compares.length > 0 && (
        <div className="border-t border-line pt-2">
          <button onClick={() => setShowDetail(!showDetail)} className="text-[11px] text-indigo-600 hover:underline">
            {showDetail ? '收起对比明细' : `查看对比明细（${compares.length} 组，含每组排序理由）`}
          </button>
          {showDetail && (
            <div className="max-h-52 overflow-auto space-y-1.5 mt-2">
              {compares.slice(-20).map((s, i) => (
                <div key={i} className="text-[11px] leading-relaxed">
                  <span className="text-slate-400">[{s.stage === 'ladder:fine' ? '决选' : '对比'} 第{s.pass}轮·组{s.group}]</span>{' '}
                  <span className="font-mono text-ink">{(s.order || []).join(' > ')}</span>
                  {s.notes && Object.entries(s.notes).filter(([, n]) => n).slice(0, 2).map(([t, n]) => (
                    <div key={t} className="pl-4 text-slate-500 truncate" title={n}>· {t}: {n}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverviewCard({ label, value, unit }) {
  return (
    <div className="bg-white rounded-xl border border-line p-4">
      <div className="text-xs text-sub mb-1">{label}</div>
      <div className="text-2xl font-bold text-ink tabular-nums">{value}<span className="text-sm text-sub font-normal ml-1">{unit}</span></div>
    </div>
  );
}

function RankScore({ v }) {
  const n = typeof v === 'number' ? v : null;
  const cls = n == null ? 'text-slate-300' : n >= 80 ? 'text-up font-semibold' : n >= 60 ? 'text-ink' : 'text-slate-400';
  return <td className={`py-2 text-center tabular-nums text-xs ${cls}`}>{n ?? '—'}</td>;
}

function FactorCell({ label, value, unit, hot }) {
  return (
    <div>
      <div className="text-[11px] text-sub mb-1">{label}</div>
      <div className={`text-base font-bold tabular-nums ${hot ? 'text-up' : 'text-ink'}`}>{value ?? '—'}{value != null && unit ? unit : ''}</div>
    </div>
  );
}

// 涨红跌绿（中国市场约定）：正收益红、负收益绿。
function PerfCell({ label, pct, strong }) {
  const v = pct ?? 0;
  const cls = v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-slate-400';
  return (
    <div>
      <div className="text-[11px] text-sub mb-1">{label}</div>
      <div className={`${strong ? 'text-xl' : 'text-lg'} font-bold tabular-nums ${cls}`}>{v >= 0 ? '+' : ''}{v}%</div>
    </div>
  );
}

// 双轴复盘四象限徽章：验证(对且赚) / 对而未赚(对但亏) / 蒙对(错但赚) / 证伪(错且亏)
const QUAD_STYLE = {
  '验证': 'bg-emerald-50 text-emerald-600 border-emerald-200',
  '对而未赚': 'bg-amber-50 text-amber-600 border-amber-200',
  '蒙对': 'bg-slate-100 text-slate-500 border-slate-200',
  '证伪': 'bg-red-50 text-red-600 border-red-200',
};
function QuadBadge({ quad }) {
  const cls = QUAD_STYLE[quad] || 'bg-slate-100 text-slate-500 border-slate-200';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cls}`}>{quad}</span>;
}

// 展开行：冻结的论点契约明细（为什么买/赔率/持有期/先行信号/关键分歧/离场条件/检查点/建仓快照）
function ContractDetail({ pos, contract }) {
  const c = contract || null;
  if (!c) {
    return (
      <div className="text-xs text-sub">
        暂无投资论据记录。{pos.reason ? <span className="text-slate-500">当前理由：{pos.reason}</span> : '该持仓在论据记录机制上线前建立，或来自手动添加。'}
      </div>
    );
  }
  const snap = c.entrySnapshot || {};
  const list = (arr) => (Array.isArray(arr) && arr.length ? arr : null);
  return (
    <div className="space-y-3 text-xs">
      <div className="text-[11px] text-slate-400 bg-indigo-50/50 border border-indigo-100 rounded-lg px-2.5 py-1.5">
        <b className="text-indigo-600">投资论据记录</b>：买入这只股票的完整理由——为什么买、看什么信号验证、多久内见分晓、出现什么情况就离场。
        建仓时定格、不可事后修改；验证信号与检查点保留在论据记录中，由投资人员按需核对。
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-sub">
        {c.horizon && <span>持有期 <b className="text-ink">{c.horizon}</b></span>}
        {c.odds?.expectedReturnPct != null && <span>期望 <b className={c.odds.expectedReturnPct >= 0 ? 'text-up' : 'text-down'}>{c.odds.expectedReturnPct > 0 ? '+' : ''}{c.odds.expectedReturnPct}%</b></span>}
        {c.odds?.skew != null && <span>赔率 <b className="text-indigo-600">{c.odds.skew}:1</b></span>}
        {(c.odds?.upsidePct != null || c.odds?.downsidePct != null) && <span>上行/下行 <b className="text-up">+{c.odds.upsidePct ?? '—'}%</b> / <b className="text-down">{c.odds.downsidePct ?? '—'}%</b></span>}
        {c.rating != null && <span>对比评分 <b className="text-brand">{Math.round(c.rating)}{c.ladderRank ? ` · 第${c.ladderRank}名` : ''}</b></span>}
        {c.createdAt && <span className="text-slate-400">记录于 {new Date(c.createdAt).toLocaleDateString('zh-CN')}</span>}
      </div>
      {c.why && <div><span className="text-slate-400">为什么买：</span><span className="text-slate-700">{c.why}</span></div>}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {list(c.signposts) && (
          <div>
            <div className="text-slate-400 mb-1">验证信号（看什么确认论点成立）</div>
            <ul className="list-disc list-inside space-y-0.5 text-slate-600">{c.signposts.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
        {list(c.cruxes) && (
          <div>
            <div className="text-slate-400 mb-1">关键待验证问题</div>
            <ul className="list-disc list-inside space-y-0.5 text-slate-600">{c.cruxes.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}
      </div>
      {c.invalidation && <div><span className="text-red-400">离场条件（出现即退出）：</span><span className="text-slate-700">{c.invalidation}</span></div>}
      {list(c.checkpoints) && (
        <div>
          <div className="text-slate-400 mb-1">检查点</div>
          <div className="flex flex-wrap gap-2">
            {c.checkpoints.map((cp, i) => (
              <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border ${cp.done ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-white text-slate-500 border-line'}`}>
                {cp.label}{cp.done ? ' ✓' : ` · ${new Date(cp.at).toLocaleDateString('zh-CN')}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {(snap.price != null || snap.pe != null) && (
        <div className="text-[11px] text-slate-400">
          建仓快照：{snap.price != null ? `价 $${snap.price}` : ''}{snap.pe != null ? ` · PE ${snap.pe}` : ''}{snap.peg != null ? ` · PEG ${snap.peg}` : ''}{snap.beta != null ? ` · β ${snap.beta}` : ''}{snap.sector ? ` · ${snap.sector}` : ''}
        </div>
      )}
    </div>
  );
}

// Mandate 面板：PM 的外部可调授权（只在粗筛底线与末端切片处生效）。改动即时保存。
const MANDATE_FIELDS = [
  { key: 'style', label: '风格', type: 'select', opts: ['balanced', 'growth', 'value', 'quality'] },
  { key: 'horizonPref', label: '默认持有期', type: 'text' },
  { key: 'minMarketCap', label: '市值下限', type: 'number', step: 1e8 },
  { key: 'maxLeverage', label: '杠杆上限', type: 'number', step: 0.5 },
  { key: 'minCandidates', label: '筛选保底数', type: 'number', step: 1 },
  { key: 'maxCandidates', label: '进入对比上限', type: 'number', step: 1 },
  { key: 'maxHoldings', label: '持仓上限', type: 'number', step: 1 },
  { key: 'convexityBonus', label: '高赔率偏好', type: 'number', step: 0.05 },
  { key: 'allowDataGap', label: '允许数据缺口', type: 'bool' },
];
function MandatePanel({ data, onSaved }) {
  const m = data?.mandate || null;
  const defaults = data?.defaults || null;
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState({});
  useEffect(() => { setDraft(m || {}); }, [data]);
  if (!m) return <div className="bg-white rounded-xl border border-line p-4 text-sm text-sub">Mandate 加载中…</div>;

  const commit = async (key, value) => {
    setBusy(key);
    try { const res = await api.setMandate({ [key]: value }); onSaved && onSaved(res.mandate || res); setDraft(res.mandate || res); }
    finally { setBusy(null); }
  };
  const reset = async () => { setBusy('__reset'); try { const res = await api.resetMandate(); onSaved && onSaved(res.mandate || res); setDraft(res.mandate || res); } finally { setBusy(null); } };
  const changed = defaults && JSON.stringify({ ...defaults, ...m }) !== JSON.stringify(defaults);

  return (
    <div className="bg-white rounded-xl border border-line p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-ink text-sm inline-flex items-center gap-1.5"><Icon.sliders size={14} className="text-brand" />组合规则 · Mandate</span>
        {changed && <button onClick={reset} disabled={busy === '__reset'} className="text-[11px] text-slate-400 hover:text-red-500">{busy === '__reset' ? '重置中…' : '恢复默认'}</button>}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        {MANDATE_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-sub whitespace-nowrap" title={f.key}>{f.label}</label>
            {f.type === 'bool' ? (
              <input type="checkbox" checked={!!draft[f.key]} disabled={busy === f.key} onChange={(e) => commit(f.key, e.target.checked)} className="accent-brand" />
            ) : f.type === 'select' ? (
              <select value={draft[f.key] ?? ''} disabled={busy === f.key} onChange={(e) => commit(f.key, e.target.value)}
                className="text-xs border border-line rounded px-1.5 py-1 bg-white text-ink w-28">
                {f.opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input type={f.type} step={f.step} value={draft[f.key] ?? ''} disabled={busy === f.key}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={(e) => { const v = f.type === 'number' ? Number(e.target.value) : e.target.value; if (v !== m[f.key]) commit(f.key, v); }}
                onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                className="text-xs border border-line rounded px-1.5 py-1 bg-white text-ink w-28 tabular-nums" />
            )}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-slate-400 mt-3">改动在下一次构建组合时生效；不影响已记录的投资论据。</p>
    </div>
  );
}

// 绩效校准面板：推荐分档可靠度 + 近期样本四象限
function CalibrationPanel({ cal }) {
  if (!cal) return <div className="bg-white rounded-xl border border-line p-4 text-sm text-sub">校准数据加载中…</div>;
  const bins = cal.bins || [];
  const recent = cal.recent || [];
  return (
    <div className="bg-white rounded-xl border border-line p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-ink text-sm inline-flex items-center gap-1.5"><Icon.target size={14} className="text-purple-500" />推荐分绩效校准</span>
        <span className="text-[11px] text-sub">{cal.samples ?? 0} 个平仓样本</span>
      </div>
      {bins.some((b) => b.n > 0) ? (
        <div className="space-y-1.5 mb-3">
          {bins.map((b) => (
            <div key={b.bin} className="flex items-center gap-2 text-[11px]">
              <span className="w-14 text-sub tabular-nums">{b.bin}</span>
              <span className="w-8 text-slate-400 tabular-nums">n{b.n}</span>
              {b.winRate != null ? (
                <>
                  <div className="flex-1 h-2 bg-slate-100 rounded overflow-hidden"><div className="h-full bg-brand" style={{ width: `${Math.round(b.winRate * 100)}%` }} /></div>
                  <span className="w-9 text-right tabular-nums text-ink">{Math.round(b.winRate * 100)}%</span>
                  <span className={`w-12 text-right tabular-nums ${b.avgExcessPct >= 0 ? 'text-up' : 'text-down'}`}>{b.avgExcessPct >= 0 ? '+' : ''}{b.avgExcessPct}pp</span>
                </>
              ) : <span className="flex-1 text-slate-300">—</span>}
            </div>
          ))}
        </div>
      ) : <div className="text-xs text-sub mb-3">暂无足够样本分档（需先跟踪并复盘若干持仓）。</div>}
      {recent.length > 0 && (
        <div>
          <div className="text-[11px] text-slate-400 mb-1">近期样本</div>
          <div className="flex flex-wrap gap-1.5">
            {recent.slice(0, 12).map((r, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-line bg-slate-50" title={`推荐度${r.recScore ?? '—'} · 超额${r.excessPct ?? '—'}pp`}>
                <span className="font-mono text-slate-600">{r.ticker}</span>
                {r.quadrant && <QuadBadge quad={r.quadrant} />}
                {r.excessPct != null && <span className={r.excessPct >= 0 ? 'text-up' : 'text-down'}>{r.excessPct >= 0 ? '+' : ''}{r.excessPct}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
