export const DICT = {
  zh: {
    ideas: '投资想法',
    projects: '研究项目',
    dailyReports: '每日报告',
    reportLibrary: '报告库',
    claimLibrary: 'Claim Library',
    worldviewProcessing: 'Worldview 处理日志',
    worldviewVersions: 'Worldview 版本',
    agents: 'Agent Studio',
    decision: '投资组合',
    templates: '分析模板',
    tools: '工具库',
    settings: '设置中心',
    demo: '确定性演示模式',
    modelUnavailable: '模型未配置或不可用（fail closed）',
    systems: '工作台',
  },
  en: {
    ideas: 'Ideas',
    projects: 'Research Projects',
    dailyReports: 'Daily Reports',
    reportLibrary: 'Report Library',
    claimLibrary: 'Claim Library',
    worldviewProcessing: 'Worldview Processing Log',
    worldviewVersions: 'Worldview Versions',
    agents: 'Agent Studio',
    decision: 'Portfolio',
    templates: 'Analysis Templates',
    tools: 'Tools',
    settings: 'Settings',
    demo: 'Deterministic demo mode',
    modelUnavailable: 'Model not configured or unavailable (fail closed)',
    systems: 'Workspace',
  },
};

export function t(lang, key) {
  const l = lang === 'en' ? 'en' : 'zh';
  return DICT[l][key] || DICT.zh[key] || key;
}

// —— 后端英文规范枚举 → 中文展示标签 ——
// 后端全链路存英文（lib/enums.js），展示层在这里翻译；对旧数据的中文值原样透传。
export const RATING_LABEL = {
  strong_buy: '强烈推荐', buy: '推荐', hold: '中性', avoid: '回避', strong_avoid: '强烈回避',
  强烈推荐: '强烈推荐', 推荐: '推荐', 中性: '中性', 回避: '回避', 强烈回避: '强烈回避',
};
export const ratingLabel = (v) => RATING_LABEL[String(v || '').trim()] || v || '—';

export const DIRECTION_LABEL = { accelerating: '加速', decelerating: '减速', stable: '稳定', 加速: '加速', 减速: '减速', 稳定: '稳定' };
export const directionLabel = (v) => DIRECTION_LABEL[String(v || '').trim()] || v || '—';

export const GATE_REASON_LABEL = { data_gap: '数据不完整', low_liquidity: '流动性不足', high_leverage: '杠杆过高' };
export const gateReasonLabel = (v) => GATE_REASON_LABEL[String(v || '').split(':')[0]] || v || '—';

export const CAP_BUCKET_LABEL = { mega: '超大盘', large: '大盘', mid: '中盘', small: '小盘', 超大盘: '超大盘', 大盘: '大盘', 中盘: '中盘', 小盘: '小盘' };
export const capBucketLabel = (v) => CAP_BUCKET_LABEL[String(v || '').trim()] || v || '';
