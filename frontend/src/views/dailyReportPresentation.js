const RUN_STATES = {
  passed: { label: '完成', color: 'green' },
  partial: { label: '部分完成', color: 'amber' },
  failed: { label: '失败', color: 'red' },
  running: { label: '运行中', color: 'blue' },
  invalid: { label: 'Evidence 异常', color: 'red' },
};


export function scorecardEntries(scorecards = {}) {
  const labels = { data: 'Data', industry: 'Industry', company: 'Company' };
  return ['data', 'industry', 'company'].map((lens) => {
    const scorecard = scorecards?.[lens];
    if (!scorecard || typeof scorecard !== 'object') return null;
    const score = Number(scorecard.finalScoreBps);
    return {
      lens,
      label: labels[lens],
      score: Number.isFinite(score) ? score / 100 : null,
      band: ['A', 'B', 'C', 'D', 'F'].includes(scorecard.qualityBand) ? scorecard.qualityBand : null,
      result: ['pass', 'fail'].includes(scorecard.displayResult) ? scorecard.displayResult : null,
      cycle: Number.isInteger(scorecard.cycle) ? scorecard.cycle : null,
      asOf: scorecard.asOf || null,
    };
  }).filter(Boolean);
}

export function stateMeta(state) {
  return RUN_STATES[state] || { label: state || '未知', color: 'slate' };
}

export function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function projectStatus(project) {
  if (project.report?.exists) return { label: '报告就绪', color: 'green' };
  if (project.status === 'failed' || project.runStatus === 'FAILED') return { label: '失败', color: 'red' };
  if (project.reportReady) return { label: '缺文件', color: 'red' };
  return { label: project.status || '未完成', color: 'amber' };
}

export function projectIssue(project) {
  if (!project) return '';
  if (project.status === 'failed' || project.runStatus === 'FAILED') {
    return project.stopReason || project.runStatus || project.status || 'failed';
  }
  if (project.reportReady && !project.report?.exists) return '报告状态已就绪，但文件缺失';
  if (!project.report?.exists) return project.runStatus || project.status || '报告尚未发布';
  return '';
}

export function runProgress(run) {
  const projects = Number(run?.verification?.projects || 0);
  if (!projects) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(run?.verification?.reports || 0) / projects) * 100)));
}

export function statusDotColor(color) {
  return ({
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
    blue: 'bg-blue-500',
  })[color] || 'bg-slate-400';
}

export function progressBarColor(color) {
  return ({
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
    blue: 'bg-blue-500',
  })[color] || 'bg-slate-400';
}
