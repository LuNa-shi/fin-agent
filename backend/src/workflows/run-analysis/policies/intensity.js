// 力度 = 迭代分析轮次 + 各 Agent 的 wall-clock deadline。
// turn/tool-call 只由 Agent definition 的高位异常熔断保护，不参与产品力度分档。
export const INTENSITY = Object.freeze({
  quick: {
    label: '快速', rounds: 1, maxRounds: 2, fundamentals: true, research: false, transcript: false,
    horizon: '未来 1-2 个季度', note: '单轮：数据+行业/公司分析→报告复核→结论',
    depth: { dataMin: 5, analystMin: 5, composerMin: 10, conclusionMin: 5 },
  },
  standard: {
    label: '标准', rounds: 2, maxRounds: 3, fundamentals: true, research: true, transcript: true,
    horizon: '未来 2-3 个季度', note: '两轮起步；Data closure 缺口驱动后续固定轮次。目标墙钟 ~30min',
    depth: { dataMin: 11, analystMin: 8, composerMin: 10, conclusionMin: 7 },
  },
  deep: {
    label: '深度', rounds: 2, maxRounds: 3, fundamentals: true, research: true, transcript: true,
    horizon: '未来 3-4 个季度', note: '两轮起步但单轮更深；审阅 blocking 缺口未闭合时最多加 1 轮。目标墙钟 ~60min',
    depth: { dataMin: 18, analystMin: 11, composerMin: 14, conclusionMin: 8 },
  },
});
