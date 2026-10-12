// 虚拟盘账本（Ledger）：交易流水 + 份额制 NAV 核算。
// 解决旧口径的根本问题：各持仓建仓日不同、调仓后权重整体重建，「当前权重 × 各自累计收益」
// 混算出的组合收益与 α 没有一致口径。这里改为：
//   - 每次调仓 = 按当时价格把目标权重换算成虚拟份额(shares)，差额记一笔不可变交易流水；
//   - NAV = 现金 + Σ 份额×现价，随时间自然演化（时间加权，与调仓时点解耦）；
//   - 基准以同口径链式核算 benchNav（SPY），α = NAV收益 − benchNav收益；
//   - 权重和可 <1，余下为现金（组合层允许留现金）。
//
// 结构：纯函数核心（applyRebalanceCore/markCore，价格作参数，可单测）+ 薄异步壳（抓价 + 落盘）。
import { Store } from '../../core/persistence/globalState.js';
import { getQuotes } from '../../tools/fmp.js';
import { withLock } from '../../lib/locks.js';

const BENCH = 'SPY';
const EPS = 1e-6;

async function fetchPrices(tickers = []) {
  const list = [...new Set([...tickers.filter(Boolean).map((t) => String(t).toUpperCase()), BENCH])];
  const quotes = await getQuotes(list).catch(() => []);
  const prices = {};
  for (const q of quotes) if (q?.price > 0) prices[String(q.symbol).toUpperCase()] = q.price;
  return { prices, bench: prices[BENCH] ?? null };
}

// ============ 纯函数核心（无 IO，可单元测试） ============

export function newBook(ts) {
  return { startedAt: ts, cash: 1, positions: {}, benchNav: 1, spyPrev: null, nav: 1 };
}

// 账本市值：现金 + Σ 份额×现价（无现价用 lastPrice 兜底；都没有则按成本计，绝不编造价格）
export function bookValue(book, prices) {
  let v = book.cash || 0;
  for (const [t, p] of Object.entries(book.positions || {})) {
    const price = prices[t] ?? p.lastPrice ?? p.avgCost ?? 0;
    v += (p.shares || 0) * price;
  }
  return v;
}

export function updateBench(book, benchNow) {
  if (benchNow > 0) {
    if (book.spyPrev > 0) book.benchNav = +(book.benchNav * (benchNow / book.spyPrev)).toFixed(6);
    book.spyPrev = benchNow;
  }
  return book;
}

/**
 * 调仓核心（纯函数）：把账本调整到目标权重。
 * @param {object} book    账本（会被原地修改后返回）
 * @param {Array}  targets [{ticker, weight}]，权重和 ≤ 1（余下为现金）
 * @param {object} prices  { TICKER: price }
 * @param {number} bench   基准现价（可 null）
 * @param {number} ts      时间戳
 * @param {string} note    流水备注
 * @returns {{book, trades, skipped, nav}}
 */
export function applyRebalanceCore(book, targets, prices, bench, ts, note = '') {
  const want = targets
    .map((t) => ({ ticker: String(t.ticker || '').toUpperCase(), weight: Math.max(0, t.weight || 0) }))
    .filter((t) => t.ticker);
  updateBench(book, bench);
  const nav = bookValue(book, prices);
  const trades = [];
  const nextPositions = {};
  let invested = 0;
  const skipped = [];

  for (const { ticker, weight } of want) {
    const price = prices[ticker];
    const cur = book.positions[ticker];
    if (!(price > 0)) {
      // 无可信价格：已有仓位原样保留（无法成交），新开仓跳过
      if (cur) { nextPositions[ticker] = cur; invested += (cur.shares || 0) * (cur.lastPrice ?? cur.avgCost ?? 0); }
      skipped.push(ticker);
      continue;
    }
    const targetVal = weight * nav;
    const curShares = cur?.shares || 0;
    const curVal = curShares * price;
    const delta = targetVal - curVal;
    const shares = targetVal / price;
    if (Math.abs(delta) > nav * 0.001) {
      trades.push({ type: 'trade', ts, ticker, side: delta > 0 ? 'buy' : 'sell', value: +delta.toFixed(5), price, shares: +(shares - curShares).toFixed(6), weightAfter: +weight.toFixed(4), note });
    }
    const avgCost = delta > 0 && shares > EPS
      ? +(((curShares * (cur?.avgCost ?? price)) + (shares - curShares) * price) / shares).toFixed(4)
      : (cur?.avgCost ?? price);
    if (shares > EPS) {
      nextPositions[ticker] = {
        shares: +shares.toFixed(6), avgCost, lastPrice: price,
        openedAt: cur?.openedAt ?? ts, benchEntry: cur?.benchEntry ?? bench ?? null,
      };
      invested += targetVal;
    }
  }
  // 不在目标中的旧仓位 → 清仓（有价则成交，无价保留并标注）
  for (const [t, pos] of Object.entries(book.positions || {})) {
    if (nextPositions[t] || want.some((w) => w.ticker === t)) continue;
    const price = prices[t];
    if (price > 0) trades.push({ type: 'trade', ts, ticker: t, side: 'sell', value: -+((pos.shares || 0) * price).toFixed(5), price, shares: -(pos.shares || 0), weightAfter: 0, note: note || 'exit' });
    else { nextPositions[t] = pos; invested += (pos.shares || 0) * (pos.lastPrice ?? pos.avgCost ?? 0); skipped.push(t); }
  }

  book.positions = nextPositions;
  book.cash = +(nav - invested).toFixed(6);
  book.nav = +nav.toFixed(6);
  book.lastRebalance = ts;
  return { book, trades, skipped, nav: book.nav };
}

/**
 * 盯市核心（纯函数）：NAV/基准链/逐仓收益与相对基准超额。
 * @returns {{book, mark}} mark 不含 snapshots 相关统计（由壳层补）
 */
export function markCore(book, prices, bench, ts) {
  updateBench(book, bench);
  let nav = book.cash || 0;
  const positions = {};
  for (const [t, p] of Object.entries(book.positions || {})) {
    const price = prices[t] ?? p.lastPrice ?? p.avgCost ?? 0;
    if (prices[t] > 0) p.lastPrice = prices[t];
    const value = (p.shares || 0) * price;
    nav += value;
    const retPct = p.avgCost > 0 ? +(((price - p.avgCost) / p.avgCost) * 100).toFixed(2) : null;
    const benchRet = (p.benchEntry > 0 && bench > 0) ? +(((bench - p.benchEntry) / p.benchEntry) * 100).toFixed(2) : null;
    positions[t] = {
      price: prices[t] ?? null, lastPrice: price, value: +value.toFixed(6),
      weight: null,
      avgCost: p.avgCost, openedAt: p.openedAt,
      returnPct: retPct, benchReturnPct: benchRet,
      excessPct: (retPct != null && benchRet != null) ? +(retPct - benchRet).toFixed(2) : null,
      priceLive: prices[t] > 0,
    };
  }
  for (const v of Object.values(positions)) v.weight = nav > 0 ? +(v.value / nav).toFixed(4) : 0;
  book.nav = +nav.toFixed(6);
  book.lastMark = ts;
  const portReturn = +((book.nav - 1) * 100).toFixed(2);
  const benchReturn = +((book.benchNav - 1) * 100).toFixed(2);
  return {
    book,
    mark: {
      ts, nav: book.nav, benchNav: book.benchNav, benchNow: bench,
      cashWeight: nav > 0 ? +((book.cash || 0) / nav).toFixed(4) : 0,
      portReturn, benchReturn, alpha: +(portReturn - benchReturn).toFixed(2),
      positions,
    },
  };
}

// NAV 序列最大回撤(%)
export function maxDrawdownPct(snaps = []) {
  let peak = -Infinity, maxDD = 0;
  for (const s of snaps) {
    const n = s.nav ?? (1 + (s.portReturn || 0) / 100);
    peak = Math.max(peak, n);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - n) / peak);
  }
  return +(maxDD * 100).toFixed(2);
}

// ============ 异步壳（抓价 + 落盘） ============

export const Ledger = {
  book() { return Store.getBook(); },
  ledger(limit = 200) { return Store.getLedger(limit); },

  // 重置账本（「加入观察系统」= 以当前时点为基准重新起算；流水保留并记一条 epoch 分界）
  reset(note = 'watch') {
    Store.addLedgerEntries([{ type: 'epoch', ts: Date.now(), note }]);
    Store.setBook(null);
    Store.clearSnapshots();
  },

  /** 调仓到目标权重（无现价的标的跳过交易并如实标注，绝不按编造价格成交）。
   * withLock('ledger-book')：读 book → await 抓价 → 写 book 跨异步边界，并发的
   * rebalance/盯市与手动跟踪同时触发时可能互相覆盖账本。 */
  async rebalance(targets = [], { note = '' } = {}) {
    return withLock('ledger-book', async () => {
      const ts = Date.now();
      const book = Store.getBook() || newBook(ts);
      const { prices, bench } = await fetchPrices([...targets.map((t) => t.ticker), ...Object.keys(book.positions || {})]);
      const r = applyRebalanceCore(book, targets, prices, bench, ts, note);
      Store.setBook(r.book);
      if (r.trades.length) Store.addLedgerEntries(r.trades);
      return { nav: r.nav, trades: r.trades.length, skipped: r.skipped };
    });
  },

  /** 盯市：落净值快照，返回组合与逐仓收益（含相对基准超额、最大回撤）。 */
  async markToMarket() {
    return withLock('ledger-book', async () => {
      const book = Store.getBook();
      if (!book) return null;
      const ts = Date.now();
      const { prices, bench } = await fetchPrices(Object.keys(book.positions || {}));
      const { book: b2, mark } = markCore(book, prices, bench, ts);
      Store.setBook(b2);
      Store.addSnapshot({ ts, nav: mark.nav, benchNav: mark.benchNav, portReturn: mark.portReturn, benchReturn: mark.benchReturn, alpha: mark.alpha });
      return { ...mark, maxDrawdownPct: maxDrawdownPct(Store.getSnapshots()) };
    });
  },
};
