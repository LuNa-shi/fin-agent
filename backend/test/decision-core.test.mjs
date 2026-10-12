// 决策核心单元测试：DealLadder Glicko、论据契约、绩效校准与双轴复盘。
// 运行：cd backend && npm test
// 注意：先把 FIN_DATA_DIR 指向临时目录，避免污染真实 data/。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FIN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finagent-decision-test-'));
process.env.DEMO_MODE = 'true';

const { _internal: ladder } = await import('../src/domains/decision/dealLadder.js');
const { Contracts, Store } = await import('../src/core/persistence/globalState.js');
const { classifyQuadrant, DecisionSystem } = await import('../src/domains/decision/decisionSystem.js');

test('updatePlayer: 胜者升分、败者降分、RD 收敛且有下限', () => {
  const A = { R: 1500, RD: 350 }, B = { R: 1500, RD: 350 };
  const a2 = ladder.updatePlayer(A.R, A.RD, [{ rj: B.R, rdj: B.RD, s: 1 }]);
  const b2 = ladder.updatePlayer(B.R, B.RD, [{ rj: A.R, rdj: A.RD, s: 0 }]);
  assert.ok(a2.R > 1500 && b2.R < 1500);
  assert.ok(a2.RD < 350 && a2.RD >= 30);
});

test('updatePlayer: 空对局不变；爆冷（低分胜高分）位移大于正常胜', () => {
  const same = ladder.updatePlayer(1600, 200, []);
  assert.deepEqual(same, { R: 1600, RD: 200 });
  const upset = ladder.updatePlayer(1300, 200, [{ rj: 1700, rdj: 100, s: 1 }]).R - 1300;
  const normal = ladder.updatePlayer(1700, 200, [{ rj: 1300, rdj: 100, s: 1 }]).R - 1700;
  assert.ok(upset > normal, '爆冷的信息量应大于符合预期的胜利');
});

test('seedPlayer: 推荐分和赔率抬升先验 R，RD 保持中性', () => {
  const base = ladder.seedPlayer({ recommendationScore: 50 }, {});
  const strong = ladder.seedPlayer({ recommendationScore: 80, odds: { skew: 3, expectedReturnPct: 30 } }, {});
  assert.ok(strong.R > base.R);
  assert.equal(strong.RD, base.RD);
});

test('accretePairs: 排序转成前胜后的成对结果', () => {
  const players = { A: { R: 1500, RD: 300 }, B: { R: 1500, RD: 300 }, C: { R: 1500, RD: 300 } };
  const results = {};
  ladder.accretePairs(['A', 'B', 'C'], players, results);
  assert.equal(results.A.length, 2);
  assert.ok(results.A.every((x) => x.s === 1));
  assert.ok(results.C.every((x) => x.s === 0));
  assert.equal(results.B.filter((x) => x.s === 1).length, 1);
});

test('makeGroups: 全员分组、落单并入上组、不同 pass 产生不同分组', () => {
  const tickers = Array.from({ length: 11 }, (_, i) => `T${i}`);
  const players = Object.fromEntries(tickers.map((t, i) => [t, { R: 1500 + i * 10, RD: 300 }]));
  const g0 = ladder.makeGroups(tickers, players, 0);
  assert.equal(g0.flat().length, 11);
  assert.ok(g0.every((g) => g.length >= 2), '不允许单人组');
  const g1 = ladder.makeGroups(tickers, players, 1);
  assert.notDeepEqual(g0, g1, '换 pass 应错位分组');
});

test('Contracts: freeze→get→due→markChecked→close 全生命周期', () => {
  const past = Date.now() - 1000, future = Date.now() + 86400000;
  Contracts.freeze({ id: 'c1', ticker: 'nvda', why: 'AI capex', checkpoints: [{ at: past, done: false }, { at: future, done: false }] });
  const c = Contracts.get('NVDA');
  assert.equal(c.status, 'open');
  assert.equal(Contracts.due().length, 1, '过期未复核 checkpoint 应出现在 due');
  Contracts.markChecked('NVDA', past, 'ok');
  assert.equal(Contracts.due().length, 0);
  Contracts.freeze({ id: 'c2', ticker: 'NVDA', why: 'updated thesis', checkpoints: [] });
  assert.equal(Contracts.get('NVDA').id, 'c2');
  assert.equal(Contracts.archive()[0].status, 'superseded');
  const closed = Contracts.close('NVDA', { ret: 10 });
  assert.equal(closed.status, 'closed');
  assert.equal(Contracts.get('NVDA'), null);
});

test('performance calibration: recommendation bins report count, win rate, and average excess', () => {
  Store.addCalibration({ ts: 1, ticker: 'A', recScore: 80, excessPct: 10 });
  Store.addCalibration({ ts: 2, ticker: 'B', recScore: 80, excessPct: -4 });
  Store.addCalibration({ ts: 3, ticker: 'C', recScore: 55, excessPct: 3 });

  const result = DecisionSystem.calibration();
  assert.equal(result.samples, 3);
  const high = result.bins.find((b) => b.bin === '75-100');
  assert.deepEqual(high, { bin: '75-100', n: 2, avgExcessPct: 3, winRate: 0.5 });
  assert.deepEqual(result.recent.map((r) => r.ticker), ['C', 'B', 'A']);
});

test('classifyQuadrant: 四个象限各归其位', () => {
  const up = { odds: { expectedReturnPct: 20 } };
  assert.equal(classifyQuadrant({ ret: 15, excess: 5, contract: up }).quad.key, '验证');
  assert.equal(classifyQuadrant({ ret: 15, excess: -3, contract: up }).quad.key, '对而未赚');
  assert.equal(classifyQuadrant({ ret: -10, excess: 2, contract: up }).quad.key, '蒙对');
  assert.equal(classifyQuadrant({ ret: -10, excess: -8, contract: up }).quad.key, '证伪');
});

test('classifyQuadrant: |ret|<2% 未决时借用赚钱轴判断论点', () => {
  const q = classifyQuadrant({ ret: 1, excess: 3, contract: { odds: { expectedReturnPct: -10 } } });
  assert.equal(q.inconclusive, true);
  assert.equal(q.thesisRight, true);
  assert.equal(q.quad.key, '验证');
});
