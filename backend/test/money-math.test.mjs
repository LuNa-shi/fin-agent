// 「钱的数学」单元测试：仓位/估值/账本/组合约束 —— 决定仓位与收益数字的纯函数必须有回归保护。
// 运行：cd backend && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capNormalize } from '../src/lib/weights.js';
import { impliedFcfGrowth, expectedReturnsFromFutures } from '../src/lib/valuation.js';
import { forwardMultiples, percentileRank } from '../src/tools/fmp.js';
import { newBook, applyRebalanceCore, markCore, maxDrawdownPct, bookValue } from '../src/domains/decision/ledger.js';
import { validate, SCHEMAS } from '../src/lib/schemas.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---------- capNormalize（water-filling 单票上限归一） ----------
test('capNormalize: 和=target 且每项≤cap', () => {
  const w = capNormalize([5, 3, 2, 1], 0.3, 1);
  approx(sum(w), 1);
  for (const x of w) assert.ok(x <= 0.3 + 1e-9);
});
test('capNormalize: 截断释放的权重迭代再分配（主导项不反弹）', () => {
  const w = capNormalize([100, 1, 1, 1], 0.4, 1);
  approx(w[0], 0.4);
  approx(sum(w.slice(1)), 0.6);
});
test('capNormalize: 名额过少时放宽 cap=1/n 保证可行', () => {
  const w = capNormalize([1, 1], 0.3, 1); // 1/n=0.5 > cap
  approx(sum(w), 1);
  approx(w[0], 0.5);
});
test('capNormalize: target<1（留现金）', () => {
  const w = capNormalize([1, 1, 1, 1], 0.3, 0.8);
  approx(sum(w), 0.8);
});
test('capNormalize: 空输入返回空；全零信念返回全零（零信念→零仓位，不编造权重）', () => {
  assert.deepEqual(capNormalize([], 0.3), []);
  const w = capNormalize([0, 0], 0.3, 1);
  approx(sum(w), 0);
});

// ---------- 反向 DCF ----------
test('impliedFcfGrowth: 已知场景数值合理（价格100/FCF5 → 隐含增速 ~6.7%）', () => {
  const g = impliedFcfGrowth({ price: 100, fcfPerShare: 5 });
  assert.ok(g > 0.05 && g < 0.09, `got ${g}`);
});
test('impliedFcfGrowth: 价格越高隐含增速越高（单调性）', () => {
  const g1 = impliedFcfGrowth({ price: 50, fcfPerShare: 5 });
  const g2 = impliedFcfGrowth({ price: 200, fcfPerShare: 5 });
  assert.ok(g2 > g1);
});
test('impliedFcfGrowth: 无效输入返回 null', () => {
  assert.equal(impliedFcfGrowth({ price: 0, fcfPerShare: 5 }), null);
  assert.equal(impliedFcfGrowth({ price: 100, fcfPerShare: -1 }), null);
  assert.equal(impliedFcfGrowth({ price: 100, fcfPerShare: 5, discountRate: 0.02, terminalGrowth: 0.025 }), null);
});

// ---------- 情景期望收益（概率 × 目标价 → 赔率） ----------
test('expectedReturnsFromFutures: E[ret]=Σp×upside，赔率=上行/|下行|', () => {
  const futures = [
    { probability: 0.5, targets: [{ ticker: 'NVDA', price: 150 }] },
    { probability: 0.3, targets: [{ ticker: 'NVDA', price: 100 }] },
    { probability: 0.2, targets: [{ ticker: 'NVDA', price: 70 }] },
  ];
  const [r] = expectedReturnsFromFutures(futures, { NVDA: 100 });
  approx(r.expectedReturnPct, 19, 0.01);   // 0.5×50 + 0.3×0 + 0.2×(−30) = 19
  approx(r.upsidePct, 25, 0.01);
  approx(r.downsidePct, -6, 0.01);
  approx(r.skew, 25 / 6, 0.01);
  approx(r.coverage, 1, 0.01);
});
test('expectedReturnsFromFutures: upsidePct 字段优先于 price；缺现价的标的被跳过', () => {
  const futures = [{ probability: 1, targets: [{ ticker: 'A', upsidePct: 10 }, { ticker: 'B', price: 50 }] }];
  const rs = expectedReturnsFromFutures(futures, { A: 100 });
  assert.equal(rs.length, 1);
  approx(rs[0].expectedReturnPct, 10, 0.01);
});

// ---------- 前瞻倍数 ----------
test('forwardMultiples: fwdPE/fwdPS/共识增速/PEG', () => {
  const m = forwardMultiples(
    { price: 100, marketCap: 1000e9 },
    { fy1: { eps: 5, revenue: 100e9, fy: '2026' }, fy2: { eps: 6.5, revenue: 120e9, fy: '2027' } },
  );
  approx(m.fwdPE1, 20);
  approx(m.fwdPS1, 10);
  approx(m.estRevGrowthFwd, 20);
  approx(m.estEpsGrowthFwd, 30);
  approx(m.fwdPEG, +(20 / 30).toFixed(2), 0.01);
});
test('forwardMultiples: ≥3 年时 PEG 用 EPS CAGR 而非单年增速', () => {
  const years = [{ eps: 5 }, { eps: 6.5 }, { eps: 8.45 }]; // 30% CAGR
  const m = forwardMultiples({ price: 100 }, { fy1: { eps: 5 }, fy2: { eps: 6.5 }, years });
  approx(m.estEpsCagrFwd, 30, 0.2);
  approx(m.fwdPEG, +(20 / 30).toFixed(2), 0.02);
});
test('forwardMultiples: eps=0/缺失不产生 Infinity', () => {
  const m = forwardMultiples({ price: 100 }, { fy1: { eps: 0, revenue: 0 } });
  assert.equal(m.fwdPE1, null);
});

// ---------- 历史估值分位 ----------
test('percentileRank: 分位正确、样本不足返回 null', () => {
  const arr = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(percentileRank(10, arr), 50);
  assert.equal(percentileRank(20, arr), 100);
  assert.equal(percentileRank(5, [1, 2, 3]), null);       // <8 样本
  assert.equal(percentileRank(null, arr), null);
});

// ---------- Ledger 账本核心 ----------
test('ledger: 建仓 → 份额/现金/流水正确', () => {
  const book = newBook(1000);
  const { trades, nav } = applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }, { ticker: 'B', weight: 0.3 }], { A: 100, B: 50 }, 500, 1000, 'test');
  approx(nav, 1);
  approx(book.positions.A.shares, 0.005);
  approx(book.positions.B.shares, 0.006);
  approx(book.cash, 0.2);
  assert.equal(trades.length, 2);
  assert.equal(book.positions.A.benchEntry, 500);
});
test('ledger: 价格变动后 NAV 时间加权正确（与调仓解耦）', () => {
  const book = newBook(0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 1 }], { A: 100 }, 500, 0);
  const { mark } = markCore(book, { A: 110 }, 550, 1);
  approx(mark.nav, 1.1);
  approx(mark.portReturn, 10, 0.01);
  approx(mark.benchReturn, 10, 0.01); // SPY 500→550
  approx(mark.alpha, 0, 0.01);
  approx(mark.positions.A.excessPct, 0, 0.01);
});
test('ledger: 调仓不重置收益基准（旧口径的核心 bug）', () => {
  const book = newBook(0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 1 }], { A: 100 }, 500, 0);
  // A 涨 20% 后调成 50/50
  applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }, { ticker: 'B', weight: 0.5 }], { A: 120, B: 60 }, 500, 1);
  const { mark } = markCore(book, { A: 120, B: 60 }, 500, 2);
  approx(mark.nav, 1.2, 1e-4); // 前段涨幅保留在 NAV 里
});
test('ledger: 无现价的标的不按编造价格成交', () => {
  const book = newBook(0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }], { A: 100 }, 500, 0);
  const { skipped, trades } = applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }, { ticker: 'X', weight: 0.3 }], { A: 100 }, 500, 1, 't');
  assert.ok(skipped.includes('X'));
  assert.ok(!trades.some((t) => t.ticker === 'X'));
  assert.ok(!book.positions.X);
});
test('ledger: 加仓更新平均成本，减仓不动成本', () => {
  const book = newBook(0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }], { A: 100 }, null, 0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 1 }], { A: 200 }, null, 1); // 高位加仓
  assert.ok(book.positions.A.avgCost > 100 && book.positions.A.avgCost < 200);
  const costAfterAdd = book.positions.A.avgCost;
  applyRebalanceCore(book, [{ ticker: 'A', weight: 0.5 }], { A: 200 }, null, 2); // 减仓
  approx(book.positions.A.avgCost, costAfterAdd);
});
test('ledger: bookValue 无价时用 lastPrice→avgCost 兜底', () => {
  const book = newBook(0);
  applyRebalanceCore(book, [{ ticker: 'A', weight: 1 }], { A: 100 }, null, 0);
  approx(bookValue(book, {}), 1, 1e-4); // 无现价 → lastPrice=100
});
test('maxDrawdownPct: 峰值回撤', () => {
  const dd = maxDrawdownPct([{ nav: 1 }, { nav: 1.2 }, { nav: 0.9 }, { nav: 1.1 }]);
  approx(dd, 25, 0.01); // (1.2-0.9)/1.2
});

// ---------- 行业集中度上限 ----------
test('applySectorCap: 超限行业压缩、释放权重分给其他行业', async () => {
  const { applySectorCap } = await import('../src/domains/decision/portfolioAgent.js');
  const w = applySectorCap([0.3, 0.3, 0.2, 0.2], ['Tech', 'Tech', 'Energy', 'Health'], 0.45, 1);
  const tech = w[0] + w[1];
  assert.ok(tech <= 0.45 + 1e-6, `Tech=${tech}`);
  approx(sum(w), 1, 1e-6); // 有接收方时总仓位不变
});
test('applySectorCap: 全组合单一行业 → 压缩到 cap，余量落现金', async () => {
  const { applySectorCap } = await import('../src/domains/decision/portfolioAgent.js');
  const w = applySectorCap([0.6, 0.4], ['Tech', 'Tech'], 0.45, 1);
  approx(sum(w), 0.45, 1e-6);
});

// ---------- schema 校验 ----------
test('schemas: conclusion 合法通过、越界报错', () => {
  const ok = validate({ rating: '推荐', recommendationScore: 70, confidence: 0.7, stocks: [{ ticker: 'A', suggestedWeight: 0.5 }] }, SCHEMAS.conclusion);
  assert.equal(ok.length, 0);
  const bad = validate({ rating: '推荐', recommendationScore: 170, confidence: 0.7, stocks: [] }, SCHEMAS.conclusion);
  assert.ok(bad.length >= 2); // score 越界 + stocks 空
});
test('schemas: scenario 概率和≈1 检查', () => {
  const bad = validate({ futures: [{ name: 'a', probability: 0.5 }, { name: 'b', probability: 0.2 }] }, SCHEMAS.scenario);
  assert.ok(bad.some((e) => e.includes('概率和')));
  const ok = validate({ futures: [{ name: 'a', probability: 0.6 }, { name: 'b', probability: 0.4 }] }, SCHEMAS.scenario);
  assert.equal(ok.length, 0);
});

// ---------- expectedReturnsFromFutures：覆盖概率归一（条件期望） ----------
test('expectedReturnsFromFutures: coverage<1 时按覆盖概率归一，不再把缺定价情景当 0 收益', () => {
  // 只有 50% 概率的情景给了定价（+20%），另 50% 未定价 → 条件期望应为 +20%，而非被稀释成 +10%
  const futures = [
    { probability: 0.5, targets: [{ ticker: 'AAA', upsidePct: 20 }] },
    { probability: 0.5, targets: [] },
  ];
  const [r] = expectedReturnsFromFutures(futures, { AAA: 100 });
  approx(r.expectedReturnPct, 20, 0.11);
  approx(r.coverage, 0.5, 0.01);
});
test('expectedReturnsFromFutures: 全覆盖时行为不变', () => {
  const futures = [
    { probability: 0.6, targets: [{ ticker: 'BBB', upsidePct: 30 }] },
    { probability: 0.4, targets: [{ ticker: 'BBB', upsidePct: -10 }] },
  ];
  const [r] = expectedReturnsFromFutures(futures, { BBB: 50 });
  approx(r.expectedReturnPct, 14, 0.11); // 0.6*30 - 0.4*10
  approx(r.coverage, 1, 0.01);
});
