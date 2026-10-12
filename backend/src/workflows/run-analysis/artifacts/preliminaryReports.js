const markdownValue = (value, fallback = '—') => {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')
      : fallback;
  }
  if (typeof value === 'object') return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  return String(value);
};

const field = (label, value) => `### ${label}\n${markdownValue(value)}\n`;

export function renderIndustryPrelimReport({ round, theme, industry, dataContext }) {
  const gaps = [...(industry?.evidenceGaps || []), ...(dataContext?.gaps || [])].filter(Boolean);
  return `# 行业初步分析报告 · 第 ${round} 轮

主题：${theme}

${field('结构性判断', industry?.structuralView)}
${field('市场规模与增速', industry?.marketSize)}
${field('关键外部驱动矩阵', industry?.keyExternalDrivers || industry?.aiCapexMap)}
${field('需求/供给/价值链归属矩阵', industry?.demandSupplyMap || industry?.customerOrderMap)}
${field('估值隐含预期矩阵', industry?.valuationExpectationMatrix)}
${field('竞争格局', industry?.competition)}
${field('关键驱动', industry?.drivers)}
${field('跨行业影响', industry?.crossIndustry)}
${field('拐点与证伪信号', industry?.inflection)}
${(industry?.segments || []).length ? `${field('分部分析', industry.segments)}` : ''}
${field('证据缺口', gaps)}

## 数据覆盖
${dataContext?.coverage ? `覆盖度 ${Math.round((dataContext.coverage.score || 0) * 100)}%：${(dataContext.coverage.dims || []).map((dimension) => `${dimension.name} ${Math.round(dimension.score * 100)}%`).join('｜')}` : '—'}
`;
}

export function renderCompanyPrelimReport({ round, theme, companies, dataContext }) {
  const body = (companies || []).map((company) => `## ${company.ticker || '未知标的'}

${field('结论', company.verdict)}
${field('业务卡位', company.positioning)}
${field('成长性', company.growth)}
${field('盈利质量', company.quality)}
${field('估值', company.valuation)}
${field('估值隐含预期矩阵', company.impliedExpectations)}
${field('客户/需求/价值链归属', company.customerMap)}
${field('客户切换/替代/需求迁移风险', company.orderSwitching)}
${field('护城河威胁', company.moatThreat)}
${field('催化剂', company.catalysts)}
${field('风险/证伪', company.risks)}
${field('证据缺口', company.evidenceGaps)}
${company.sotp ? field('SOTP', company.sotp) : ''}
置信度：${company.conviction ?? '—'}
`).join('\n');
  return `# 公司初步分析报告 · 第 ${round} 轮

主题：${theme}

${body || '—'}

## 数据覆盖
${dataContext?.coverage ? `覆盖度 ${Math.round((dataContext.coverage.score || 0) * 100)}%：${(dataContext.coverage.dims || []).map((dimension) => `${dimension.name} ${Math.round(dimension.score * 100)}%`).join('｜')}` : '—'}
`;
}
