// 枚举英文化统一：英文为规范存储值（后端主链路全英文），中文仅在前端展示层映射。
// 迁移策略：所有读取点 normalize*() 接受两种形态（旧 meta 的中文值读时归一），写入永远英文；
// 无需数据迁移。前端用 frontend/src/i18n.js 的 label map 渲染中文。

// —— 评级 ——
export const RATINGS = ['strong_buy', 'buy', 'hold', 'avoid', 'strong_avoid'];
const RATING_FROM_ZH = { '强烈推荐': 'strong_buy', '推荐': 'buy', '中性': 'hold', '回避': 'avoid', '强烈回避': 'strong_avoid' };
export const RATING_ZH = { strong_buy: '强烈推荐', buy: '推荐', hold: '中性', avoid: '回避', strong_avoid: '强烈回避' };
export function normalizeRating(v) {
  const s = String(v || '').trim();
  if (RATINGS.includes(s)) return s;
  if (RATING_FROM_ZH[s]) return RATING_FROM_ZH[s];
  const low = s.toLowerCase().replace(/[\s-]+/g, '_');
  if (RATINGS.includes(low)) return low;
  return 'hold';
}

// —— 行业驱动方向 ——
const DIRECTION_FROM_ZH = { '加速': 'accelerating', '减速': 'decelerating', '稳定': 'stable' };
export function normalizeDirection(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['accelerating', 'decelerating', 'stable'].includes(s)) return s;
  return DIRECTION_FROM_ZH[String(v || '').trim()] || s || 'stable';
}

// —— 粗筛闸门原因（代码化；参数放 detail） ——
export const GATE_REASONS = ['data_gap', 'low_liquidity', 'high_leverage'];

// —— 市值分层 ——
export function capBucket(mc) {
  if (!mc) return null;
  if (mc > 2e11) return 'mega';
  if (mc > 1e10) return 'large';
  if (mc > 2e9) return 'mid';
  return 'small';
}
