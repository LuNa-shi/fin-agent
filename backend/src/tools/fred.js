// FRED（圣路易斯联储）行业高频/宏观时间序列。免费但需注册 key（FRED_API_KEY，可选）。
// 数据模板通过 autoTools 按行业挂载具体 series（如半导体工业产出、WTI 油价、10Y 利率），
// 让「高频景气指标」从模板指引落为真实数据。无 key 时优雅降级（返回 error，不编造）。
import { runtime } from '../config.js';
import { fetchJSON } from '../lib/http.js';

// 常用 series 速查（供模板/agent 引用）：
//   IPG3344S  工业产出:半导体及电子元件    DCOILWTICO WTI 原油现货
//   DGS10     10 年期美债收益率            CPIAUCSL   CPI
//   PAYEMS    非农就业                     HOUST      新屋开工
//   TOTALSA   汽车销量                     RSXFS      零售销售
export async function fredSeries(seriesId, { limit = 12 } = {}) {
  const key = runtime.FRED_API_KEY;
  if (!key) return { seriesId, observations: [], error: '未配置 FRED_API_KEY（免费注册：fred.stlouisfed.org）' };
  try {
    const qs = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: 'json', sort_order: 'desc', limit: String(limit) });
    const data = await fetchJSON(`https://api.stlouisfed.org/fred/series/observations?${qs}`, { timeoutMs: 12000, retries: 1 });
    const obs = (data.observations || []).map((o) => ({ date: o.date, value: o.value === '.' ? null : +o.value })).filter((o) => o.value != null);
    const latest = obs[0], prior = obs[1], yearAgo = obs.find((o) => o.date <= new Date(Date.now() - 360 * 86400000).toISOString().slice(0, 10));
    return {
      seriesId, observations: obs,
      latest: latest || null,
      momChange: latest && prior ? +(((latest.value - prior.value) / Math.abs(prior.value)) * 100).toFixed(2) : null,
      yoyChange: latest && yearAgo ? +(((latest.value - yearAgo.value) / Math.abs(yearAgo.value)) * 100).toFixed(2) : null,
    };
  } catch (e) { return { seriesId, observations: [], error: String(e.message || e) }; }
}

export const FRED_TOOLS = [
  { name: 'fred_series', provider: 'fred', desc: 'FRED 宏观/行业高频序列（利率/CPI/半导体产出/油价等，需免费 key）' },
];
