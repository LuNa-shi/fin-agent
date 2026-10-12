// 通用异步工具。withTimeout 原先埋在 dataAgent 里，多个调用点各自复制——统一提升到 lib。
// 语义：超时不抛错，返回 fallback（带 _timeout: true 标记），让流程带着部分结果继续走，
// 调用方自行决定降级方式。要「部分失败容忍」时应对每个子任务分别包 withTimeout，
// 而不是包住聚合体（否则一个慢子任务拖垮全部结果——研究检索曾因此整体丢弃）。
export async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ...(fallback ?? {}), _timeout: true }), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally { clearTimeout(timer); }
}
