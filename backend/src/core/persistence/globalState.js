// Global file-backed state for Ideas, portfolio decisions, mandate, and thesis contracts.
// Per-project persistence is deliberately excluded and owned by the project-space boundary.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MEMORY_DIR } from '../../config.js';

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
// 原子写：先写临时文件再 rename（同目录 rename 在 POSIX 上原子）。
// 防止进程在写一半时崩溃损坏 state.json/账本——这些是最有价值的数据。
// 注：Store 方法全部同步执行（单事件循环内不可分割），同步的 read-modify-write 块无交错风险；
// 但「读出副本 → await → 写回」的调用方（如 Ledger.rebalance/markToMarket）必须用
// lib/locks.js 的 withLock 串行化，否则并发分析会互相覆盖。tmp 名带序号防同刻写者互踩。
let _wseq = 0;
function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${++_wseq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
// ---------- 全局状态（ideas 池 / 决策股票池） ----------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
function loadState() {
  return readJSON(STATE_FILE, { ideas: [], portfolio: [], reflections: [] });
}
function saveState(s) { writeJSON(STATE_FILE, s); }

export const Store = {
  // ---- Ideas ----
  getIdeas() { return loadState().ideas; },
  setIdeas(ideas) { const s = loadState(); s.ideas = ideas; saveState(s); return ideas; },
  addIdeas(newOnes) {
    const s = loadState();
    const existing = new Set(s.ideas.map((i) => i.title));
    const merged = [...newOnes.filter((i) => !existing.has(i.title)).map((i) => ({
      id: 'idea_' + Math.random().toString(36).slice(2, 9),
      createdAt: Date.now(), status: 'new', ...i,
    })), ...s.ideas];
    s.ideas = merged; saveState(s); return merged;
  },
  updateIdea(id, patch) {
    const s = loadState();
    s.ideas = s.ideas.map((i) => i.id === id ? { ...i, ...patch } : i);
    saveState(s); return s.ideas.find((i) => i.id === id);
  },
  removeIdea(id) {
    const s = loadState();
    s.ideas = s.ideas.filter((i) => i.id !== id);
    saveState(s); return s.ideas;
  },

  // ---- Portfolio（决策股票池） ----
  getPortfolio() { return loadState().portfolio; },
  upsertPosition(pos) {
    const s = loadState();
    const idx = s.portfolio.findIndex((p) => p.ticker === pos.ticker);
    if (idx >= 0) s.portfolio[idx] = { ...s.portfolio[idx], ...pos };
    else s.portfolio.push({ id: 'pos_' + Math.random().toString(36).slice(2, 9), addedAt: Date.now(), ...pos });
    saveState(s); return s.portfolio;
  },
  removePosition(ticker) {
    const s = loadState();
    s.portfolio = s.portfolio.filter((p) => p.ticker !== ticker);
    saveState(s); return s.portfolio;
  },
  setPortfolio(list) { const s = loadState(); s.portfolio = list; saveState(s); return list; },

  // ---- Recommendation（最近一次组合 agent 推荐持仓 + 因子暴露） ----
  getRecommendation() { return loadState().recommendation || null; },
  setRecommendation(rec) { const s = loadState(); s.recommendation = rec; saveState(s); return rec; },

  // ---- Snapshots（虚拟盘净值快照，时间序列） ----
  getSnapshots() { return loadState().snapshots || []; },
  addSnapshot(s) {
    const st = loadState();
    st.snapshots = [...(st.snapshots || []), s].slice(-200); // 保留最近 200 个点
    saveState(st); return st.snapshots;
  },
  clearSnapshots() { const st = loadState(); st.snapshots = []; saveState(st); },

  // ---- Idea ranking（决策组合系统的 idea 排序快照） ----
  getIdeaRanking() { return loadState().ideaRanking || null; },
  setIdeaRanking(r) { const st = loadState(); st.ideaRanking = r; saveState(st); return r; },

  // ---- Reflections（反思） ----
  getReflections() { return loadState().reflections; },
  addReflection(r) {
    const s = loadState();
    s.reflections.unshift({ id: 'ref_' + Math.random().toString(36).slice(2, 9), createdAt: Date.now(), ...r });
    saveState(s); return s.reflections;
  },

  // ---- Book（虚拟盘账本：NAV/现金/份额，由 Ledger 模块维护） ----
  getBook() { return loadState().book || null; },
  setBook(b) { const s = loadState(); s.book = b; saveState(s); return b; },

  // ---- Ledger（不可变交易流水：每次调仓的成交记录，绩效可追责的事实基础） ----
  getLedger(limit = 200) { return (loadState().ledger || []).slice(-limit); },
  addLedgerEntries(entries = []) {
    const s = loadState();
    s.ledger = [...(s.ledger || []), ...entries].slice(-1000);
    saveState(s); return s.ledger;
  },

  // ---- Calibration（结论打分 ↔ 实际超额收益 配对样本，用于校准曲线） ----
  getCalibration() { return loadState().calibration || []; },
  addCalibration(rec) {
    const s = loadState();
    s.calibration = [...(s.calibration || []), rec].slice(-500);
    saveState(s); return s.calibration;
  },
};

// ---------- Mandate（组合授权：PM 的外部可调配置） ----------
// 只在两处生效：① 粗筛的安全闸/流动性/杠杆下限与候选数量区间；② 末端切片（最终持仓数）。
// 刻意与「选股逻辑」解耦——mandate 只定边界与风格倾斜，不替 agent 做判断。
const MANDATE_FILE = path.join(MEMORY_DIR, 'mandate.json');
export const MANDATE_DEFAULTS = {
  style: 'balanced',       // growth | value | quality | balanced：末端切片时的风格倾斜说明（注入 prompt）
  minMarketCap: 1e9,       // 流动性下限：市值低于此值的候选在粗筛被剔除
  maxLeverage: 4.0,        // 杠杆上限：debt/equity 超过此值需数据佐证，否则粗筛剔除
  minCandidates: 3,        // 粗筛后至少保留（不足则放宽闸门到此数）
  maxCandidates: 24,       // 粗筛后最多进入天梯（控制比对成本）
  maxHoldings: 10,         // 末端切片：最终持仓上限
  convexityBonus: 0.15,    // 赔率(skew)对天梯初始评分的加成系数（偏好高凸性）
  horizonPref: '6-12M',    // 论点契约的默认持有期
  allowDataGap: false,     // 是否允许有数据缺口的候选进入粗筛
  maxProjectAgeDays: 45,   // 候选时效闸：只纳入 N 天内完成分析的项目（老结论按当下市场可能已失效）
};
export const Mandate = {
  get() {
    const m = readJSON(MANDATE_FILE, {});
    return { ...MANDATE_DEFAULTS, ...(m && typeof m === 'object' ? m : {}) };
  },
  set(patch = {}) {
    const cur = this.get();
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in MANDATE_DEFAULTS)) continue; // 只接受已知字段
      if (typeof MANDATE_DEFAULTS[k] === 'number') { const n = Number(v); if (isFinite(n)) next[k] = n; }
      else if (typeof MANDATE_DEFAULTS[k] === 'boolean') next[k] = !!v;
      else next[k] = String(v);
    }
    ensureDir(MEMORY_DIR);
    writeJSON(MANDATE_FILE, next);
    return next;
  },
  reset() { ensureDir(MEMORY_DIR); writeJSON(MANDATE_FILE, { ...MANDATE_DEFAULTS }); return { ...MANDATE_DEFAULTS }; },
};

// ---------- Contracts（论点契约：每只入选标的的可证伪冻结论点，供后续复盘对账） ----------
// 落盘：data/memory/contracts.json = { open: { ticker: Contract }, archive: [Contract...] }
// Contract = { id, ticker, name, why, odds, horizon, signposts[], cruxes[], invalidation,
//              entrySnapshot, checkpoints[], status, createdAt, closedAt, outcome }
const CONTRACTS_FILE = path.join(MEMORY_DIR, 'contracts.json');
function loadContracts() {
  const d = readJSON(CONTRACTS_FILE, null);
  return { open: (d && d.open) || {}, archive: (d && Array.isArray(d.archive)) ? d.archive : [] };
}
function saveContracts(db) { ensureDir(MEMORY_DIR); writeJSON(CONTRACTS_FILE, db); }
export const Contracts = {
  // 冻结/覆盖某标的的开放契约（同一标的重新入选 → 旧契约归档，新契约生效）
  freeze(contract) {
    if (!contract?.ticker) return null;
    const t = String(contract.ticker).toUpperCase();
    const db = loadContracts();
    const prev = db.open[t];
    if (prev && prev.id !== contract.id) db.archive = [{ ...prev, status: 'superseded', closedAt: Date.now() }, ...db.archive].slice(0, 500);
    db.open[t] = { ...contract, ticker: t, status: 'open' };
    saveContracts(db);
    return db.open[t];
  },
  get(ticker) { return loadContracts().open[String(ticker).toUpperCase()] || null; },
  open() { return Object.values(loadContracts().open); },
  archive(limit = 200) { return loadContracts().archive.slice(0, limit); },
  all() { return loadContracts(); },
  // 到期需复核的契约（任一 checkpoint 到点且未完成）
  due(now = Date.now()) {
    return this.open().filter((c) => (c.checkpoints || []).some((cp) => !cp.done && cp.at <= now));
  },
  // 标记某 checkpoint 已复核
  markChecked(ticker, at, note = '') {
    const t = String(ticker).toUpperCase();
    const db = loadContracts();
    const c = db.open[t]; if (!c) return null;
    c.checkpoints = (c.checkpoints || []).map((cp) => cp.at === at ? { ...cp, done: true, note, checkedAt: Date.now() } : cp);
    saveContracts(db);
    return c;
  },
  // 平仓归档（复盘时调用）：把开放契约移入 archive 并记录结局
  close(ticker, outcome = {}) {
    const t = String(ticker).toUpperCase();
    const db = loadContracts();
    const c = db.open[t]; if (!c) return null;
    delete db.open[t];
    const closed = { ...c, status: 'closed', closedAt: Date.now(), outcome };
    db.archive = [closed, ...db.archive].slice(0, 500);
    saveContracts(db);
    return closed;
  },
  remove(ticker) {
    const t = String(ticker).toUpperCase();
    const db = loadContracts();
    if (db.open[t]) { delete db.open[t]; saveContracts(db); return true; }
    return false;
  },
};
