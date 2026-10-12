const normalizedStatus = (value) => String(value || '').toLowerCase();

const isActiveRun = (run) => {
  const status = normalizedStatus(run?.status);
  return status === 'running' || status === 'analyzing' || status === 'queued';
};

export function selectVisibleRunId({
  runs = [],
  currentRunId = '',
  activeRunId = '',
  manualRunId = '',
} = {}) {
  const knownRunIds = new Set(runs.map((run) => run?.runId).filter(Boolean));
  if (manualRunId && knownRunIds.has(manualRunId)) return manualRunId;

  const active = (
    (activeRunId && knownRunIds.has(activeRunId) ? activeRunId : '')
    || runs.find(isActiveRun)?.runId
    || ''
  );
  if (active) return active;
  if (currentRunId && knownRunIds.has(currentRunId)) return currentRunId;
  return runs[0]?.runId || '';
}

export function acceptsProjectRequest({
  requestId,
  latestRequestId,
  requestedProjectId,
  currentProjectId,
} = {}) {
  return requestId === latestRequestId
    && Boolean(requestedProjectId)
    && requestedProjectId === currentProjectId;
}
