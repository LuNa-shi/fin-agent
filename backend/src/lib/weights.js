// 仓位权重数学：带单票上限的归一化（water-filling）。
// 被分析层（项目内标的权重）与决策层（组合级跨项目权重）共用，保证口径一致。

/**
 * 带单票上限的归一化：返回和≈target、每项≤cap*target 的权重数组。
 * 名额过少导致 1/n>cap 时自动放宽 cap=1/n 以保证可行。
 * 关键：被钉到 cap 的名字需「永久固定」，否则后续轮次会把它当自由项再次放大（震荡不收敛）。
 * @param {number[]} raw   原始（非负）权重/信念值
 * @param {number} cap     单项占比上限（0-1）
 * @param {number} target  归一化目标总和（默认 1）
 */
export function capNormalize(raw, cap, target = 1) {
  const n = raw.length;
  if (!n) return [];
  const effCap = Math.max(cap, 1 / n + 1e-9);
  let w = raw.map((x) => Math.max(0, x || 0));
  const sum0 = w.reduce((a, b) => a + b, 0) || 1;
  w = w.map((x) => x / sum0);
  const fixed = new Array(n).fill(false);
  for (let iter = 0; iter < n + 2; iter++) {
    let fixedTotal = 0, freeSum = 0;
    w.forEach((x, i) => { if (fixed[i]) fixedTotal += x; else freeSum += x; });
    const budget = Math.max(0, 1 - fixedTotal);
    if (freeSum > 0) w = w.map((x, i) => (fixed[i] ? x : x / freeSum * budget));
    let any = false;
    w.forEach((x, i) => { if (!fixed[i] && x > effCap + 1e-9) { w[i] = effCap; fixed[i] = true; any = true; } });
    if (!any) break;
  }
  return w.map((x) => x * target);
}
