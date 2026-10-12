function substantiveReportMarkdown(value) {
  const markdown = typeof value === 'string' ? value.trim() : '';
  const headings = markdown.match(/^#{1,6}\s+\S.+$/gmu) || [];
  return markdown.length >= 500 && headings.length >= 7;
}

export function selectReportMarkdown({ returnedText, writtenReport, priorReport = '', live = false } = {}) {
  const returned = typeof returnedText === 'string' ? returnedText.trim() : '';
  const written = typeof writtenReport === 'string' ? writtenReport.trim() : '';
  const prior = typeof priorReport === 'string' ? priorReport.trim() : '';
  if (written !== prior && substantiveReportMarkdown(written)) return written;
  if (substantiveReportMarkdown(returned)) return returned;
  if (!live) return returned || written;
  throw new Error('报告 Agent 未产出实质性 Markdown（仅返回回执或未完成写入），已拒绝覆盖 report/report.md');
}
