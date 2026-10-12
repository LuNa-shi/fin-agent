// LLM 结构化输出的声明式 schema 校验：加固每个 agent 边界。
// 结构化模型输出使用：解析成功但结构非法 → 带错误重试一次 → 仍非法则标 valid:false 交由调用方归一。
// 只做「必填/类型/数值范围/数组元素」+ 自定义整体检查（如概率和≈1），刻意保持轻量无依赖。

/**
 * @param {*} obj
 * @param {object} schema { required:[], fields:{name:{type,min,max,minLen,maxLen,enum,item}}, check(obj)=>string|null }
 * @param {string} path   内部递归用
 * @returns {string[]} 错误列表（空 = 合法）
 */
export function validate(obj, schema, path = '') {
  const errs = [];
  if (!schema) return errs;
  if (obj == null || typeof obj !== 'object') return [`${path || '根'} 应为对象`];
  for (const k of schema.required || []) {
    if (obj[k] == null || obj[k] === '') errs.push(`缺少必填字段 ${path}${k}`);
  }
  for (const [k, rule] of Object.entries(schema.fields || {})) {
    const v = obj[k];
    if (v == null) continue; // 缺失由 required 管
    const p = `${path}${k}`;
    if (rule.type === 'number') {
      if (typeof v !== 'number' || !isFinite(v)) errs.push(`${p} 应为数字，得到 ${typeof v}`);
      else {
        if (rule.min != null && v < rule.min) errs.push(`${p}=${v} 低于下限 ${rule.min}`);
        if (rule.max != null && v > rule.max) errs.push(`${p}=${v} 高于上限 ${rule.max}`);
      }
    } else if (rule.type === 'string') {
      if (typeof v !== 'string') errs.push(`${p} 应为字符串`);
      else if (rule.enum && !rule.enum.includes(v)) errs.push(`${p}="${v}" 不在允许值 [${rule.enum.join('|')}]`);
    } else if (rule.type === 'array') {
      if (!Array.isArray(v)) errs.push(`${p} 应为数组`);
      else {
        if (rule.minLen != null && v.length < rule.minLen) errs.push(`${p} 至少 ${rule.minLen} 项，得到 ${v.length}`);
        if (rule.maxLen != null && v.length > rule.maxLen) errs.push(`${p} 至多 ${rule.maxLen} 项，得到 ${v.length}`);
        if (rule.item) v.forEach((it, i) => errs.push(...validate(it, rule.item, `${p}[${i}].`)));
      }
    } else if (rule.type === 'object' && rule.item) {
      errs.push(...validate(v, rule.item, `${p}.`));
    }
  }
  if (schema.check) {
    const e = schema.check(obj);
    if (e) errs.push(e);
  }
  return errs;
}

// 概率和 ≈ 1 的通用检查
const probSum = (arr, label) => {
  const s = (arr || []).reduce((a, x) => a + (x?.probability || 0), 0);
  return Math.abs(s - 1) > 0.15 ? `${label} 概率和=${s.toFixed(2)}，应≈1` : null;
};

// —— 关键 kind 的 schema（钱和概率所到之处必须校验） ——
export const SCHEMAS = {
  conclusion: {
    required: ['rating', 'recommendationScore', 'confidence', 'stocks'],
    fields: {
      recommendationScore: { type: 'number', min: 0, max: 100 },
      confidence: { type: 'number', min: 0, max: 1 },
      stocks: {
        type: 'array', minLen: 1,
        item: { required: ['ticker'], fields: { suggestedWeight: { type: 'number', min: 0, max: 1 }, confidence: { type: 'number', min: 0, max: 1 } } },
      },
    },
  },
  scenario: {
    required: ['futures'],
    fields: {
      confidence: { type: 'number', min: 0, max: 1 },
      futures: {
        type: 'array', minLen: 2, maxLen: 6,
        item: { required: ['name', 'probability'], fields: { probability: { type: 'number', min: 0, max: 1 } } },
      },
    },
    check: (o) => probSum(o.futures, 'futures'),
  },
  company: {
    required: ['ticker', 'verdict', 'valuation', 'impliedExpectations', 'customerMap', 'orderSwitching'],
    fields: {
      valuation: { type: 'string' },
      impliedExpectations: { type: 'string' },
      customerMap: { type: 'string' },
      orderSwitching: { type: 'string' },
      evidenceGaps: { type: 'array' },
      conviction: { type: 'number', min: 0, max: 1 },
    },
  },
  portfolio: {
    required: ['holdings'],
    fields: {
      cashWeight: { type: 'number', min: 0, max: 0.5 },
      holdings: {
        type: 'array', minLen: 1,
        item: { required: ['ticker'], fields: { targetWeight: { type: 'number', min: 0, max: 1 }, rank: { type: 'number', min: 1 } } },
      },
    },
  },
  'data-organize': {
    required: ['organized'],
    fields: {
      organized: { type: 'array' },
      contradictions: { type: 'array' },
      gaps: { type: 'array' },
    },
  },
  'reflect-analysis': {
    required: ['critique'],
    fields: { depthScore: { type: 'number', min: 0, max: 1 } },
  },
  screen: {
    required: ['scores'],
    fields: { scores: { type: 'array', minLen: 1, item: { required: ['ticker'], fields: { score: { type: 'number', min: 0, max: 100 } } } } },
  },
  // Idea 生成：过量候选池
  idea: {
    required: ['ideas'],
    fields: {
      ideas: {
        type: 'array', minLen: 1,
        item: {
          required: ['title', 'theme'],
          fields: {
            title: { type: 'string' },
            theme: { type: 'string' },
            heat: { type: 'number', min: 0, max: 100 },
            tickers: { type: 'array' },
          },
        },
      },
    },
  },
  // 天梯比对（DealLadder）：对一组候选按「赚钱确定性/赔率」从优到劣排名（组内序）
  'ladder-compare': {
    required: ['ranking'],
    fields: {
      ranking: {
        type: 'array', minLen: 1,
        item: { required: ['ticker'], fields: { ticker: { type: 'string' }, rank: { type: 'number', min: 1 }, note: { type: 'string' } } },
      },
    },
  },
  // Idea 质检筛选：从候选池选出最终若干条
  'idea-screen': {
    required: ['selected'],
    fields: {
      selected: {
        type: 'array', minLen: 1,
        item: { required: ['index'], fields: { index: { type: 'number', min: 0 }, score: { type: 'number', min: 0, max: 100 } } },
      },
    },
  },
};
