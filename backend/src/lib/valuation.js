// 估值数学：反向 DCF（价格隐含增速）+ 情景期望收益/赔率。
// 与 LLM 叙事判断互补——这里只做确定性计算，给分析提供数字锚。

/**
 * 反向 DCF：给定现价与当前每股 FCF，解出「市场价格隐含的未来 N 年 FCF 增速」。
 * 比正向 DCF 稳健：不预测未来，只回答"当前价格计入了多少增长"，直接对照共识增速看预期差。
 * 模型：N 年按 g 增长的 FCF 现值 + 永续（terminalGrowth）终值现值 = price。对 g 二分求解。
 * @returns {number|null} 隐含年化增速（小数，如 0.18 = 18%）；无解或输入无效返回 null
 */
export function impliedFcfGrowth({ price, fcfPerShare, discountRate = 0.095, years = 10, terminalGrowth = 0.025 } = {}) {
  if (!(price > 0) || !(fcfPerShare > 0) || discountRate <= terminalGrowth) return null;
  const pv = (g) => {
    let v = 0; let fcf = fcfPerShare;
    for (let t = 1; t <= years; t++) {
      fcf *= 1 + g;
      v += fcf / Math.pow(1 + discountRate, t);
    }
    const terminal = (fcf * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
    return v + terminal / Math.pow(1 + discountRate, years);
  };
  let lo = -0.5, hi = 1.5;
  if (pv(lo) > price || pv(hi) < price) return null; // 价格超出可解区间
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) < price) lo = mid; else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(4);
}

/**
 * 情景期望收益：把推演引擎的概率分布 × 各情景目标价，折算成每个标的的
 * 期望收益 E[ret]、概率加权上行/下行与赔率(skew)。这是「概率变赔率」的关键一步。
 * @param {Array} futures  [{ probability, targets:[{ticker, price, upsidePct}] }]
 * @param {Object} priceMap { TICKER: currentPrice }
 * @returns {Array} [{ ticker, currentPrice, expectedReturnPct, upsidePct, downsidePct, skew, coverage }]
 */
export function expectedReturnsFromFutures(futures = [], priceMap = {}) {
  const acc = {}; // ticker -> { e, up, down, probCovered }
  for (const f of futures) {
    const p = typeof f?.probability === 'number' ? f.probability : 0;
    for (const t of (f?.targets || [])) {
      const ticker = String(t.ticker || '').toUpperCase();
      const cur = priceMap[ticker];
      if (!ticker || !(cur > 0)) continue;
      let ret = null;
      if (typeof t.upsidePct === 'number' && isFinite(t.upsidePct)) ret = t.upsidePct;
      else if (typeof t.price === 'number' && t.price > 0) ret = ((t.price - cur) / cur) * 100;
      if (ret == null || !isFinite(ret)) continue;
      const a = (acc[ticker] = acc[ticker] || { e: 0, up: 0, down: 0, prob: 0 });
      a.e += p * ret;
      if (ret >= 0) a.up += p * ret; else a.down += p * ret;
      a.prob += p;
    }
  }
  return Object.entries(acc).map(([ticker, a]) => {
    // 覆盖概率归一（条件期望）：部分情景未给该标的定价时，未归一的 Σp·ret 会被系统性压向 0
    // （相当于把缺定价的情景当成收益恰为 0）。除以覆盖概率 = 「已定价情景下的条件期望」，
    // coverage 字段保留供下游判断适用边界。
    const norm = a.prob > 0.05 ? a.prob : 1;
    return {
      ticker,
      currentPrice: priceMap[ticker],
      expectedReturnPct: +(a.e / norm).toFixed(1),
      upsidePct: +(a.up / norm).toFixed(1),   // 概率加权上行贡献（按覆盖归一）
      downsidePct: +(a.down / norm).toFixed(1), // 概率加权下行贡献（≤0，按覆盖归一）
      skew: a.down < -0.5 * norm ? +(a.up / Math.abs(a.down)).toFixed(2) : (a.up > 0 ? 99 : null), // 赔率：上行/|下行|（归一分子分母同除，不变）
      coverage: +a.prob.toFixed(2),           // 有目标价覆盖的概率和（<1 说明部分情景未给该标的定价）
    };
  }).sort((x, y) => (y.expectedReturnPct ?? -999) - (x.expectedReturnPct ?? -999));
}

/** 期望收益摘要行（注入结论 prompt / 事件流展示用） */
export function expectedReturnsBrief(list = []) {
  if (!list.length) return '';
  return list.map((r) =>
    `${r.ticker}: E[收益] ${r.expectedReturnPct > 0 ? '+' : ''}${r.expectedReturnPct}%｜概率加权上行 +${r.upsidePct}% / 下行 ${r.downsidePct}%｜赔率 ${r.skew ?? '—'}:1｜情景覆盖 ${Math.round((r.coverage || 0) * 100)}%`
  ).join('\n');
}
