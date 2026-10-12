const RUNTIME_METRICS_SCHEMA_VERSION = 'run-analysis-runtime-metrics.v1';
const TOKEN_USAGE_FIELDS = Object.freeze([
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['reasoning', 'reasoningTokens'],
  ['cacheRead', 'cacheReadTokens'],
  ['cacheWrite', 'cacheWriteTokens'],
  ['total', 'tokens'],
]);

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function validNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validNonnegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function initialRuntimeMetrics(initial) {
  const prior = initial && typeof initial === 'object' && !Array.isArray(initial) ? initial : null;
  const priorTokenUsage = prior?.tokenUsage && typeof prior.tokenUsage === 'object' ? prior.tokenUsage : {};
  const recordedRunIds = Array.isArray(prior?.recordedRunIds)
    ? [...new Set(prior.recordedRunIds.filter((value) => typeof value === 'string' && value))]
    : [];
  const priorCostValid = prior?.costKnown === true
    ? validNonnegativeNumber(prior.costUsd)
    : (prior?.costKnown === false && prior.costUsd === null);
  const complete = prior == null || (
    prior.schemaVersion === RUNTIME_METRICS_SCHEMA_VERSION
    && prior.complete === true
    && validNonnegativeInteger(prior.agentRuns)
    && prior.agentRuns === recordedRunIds.length
    && validNonnegativeNumber(prior.wallMs)
    && ['turns', 'toolCalls', 'toolAttempts', 'toolDenied'].every((field) => validNonnegativeInteger(prior[field]))
    && prior.toolAttempts === prior.toolCalls + prior.toolDenied
    && TOKEN_USAGE_FIELDS.every(([field]) => validNonnegativeInteger(priorTokenUsage[field]))
    && priorCostValid
    && Array.isArray(prior.recordedRunIds)
  );
  const costKnown = prior == null || (prior.costKnown === true && validNonnegativeNumber(prior.costUsd));
  return {
    schemaVersion: RUNTIME_METRICS_SCHEMA_VERSION,
    complete,
    agentRuns: nonnegativeInteger(prior?.agentRuns),
    wallMs: nonnegativeNumber(prior?.wallMs),
    turns: nonnegativeInteger(prior?.turns),
    toolCalls: nonnegativeInteger(prior?.toolCalls),
    toolAttempts: nonnegativeInteger(prior?.toolAttempts),
    toolDenied: nonnegativeInteger(prior?.toolDenied),
    tokenUsage: Object.fromEntries(TOKEN_USAGE_FIELDS.map(([field]) => [
      field,
      nonnegativeInteger(priorTokenUsage[field]),
    ])),
    costKnown,
    costUsd: costKnown ? nonnegativeNumber(prior?.costUsd) : null,
    recordedRunIds,
  };
}

export function createRunAnalysisRuntimeMetrics(initial = null) {
  const metrics = initialRuntimeMetrics(initial);
  const recordedRunIds = new Set(metrics.recordedRunIds);

  const snapshot = () => ({
    ...metrics,
    tokenUsage: { ...metrics.tokenUsage },
    recordedRunIds: [...recordedRunIds].sort(),
  });

  const record = ({ request, result, provenance = 'physical' }) => {
    const runId = typeof request?.runId === 'string' && request.runId
      ? request.runId
      : (typeof result?.traceRef === 'string' && result.traceRef ? result.traceRef : null);
    if (provenance === 'coalesced') return snapshot();
    const alreadyRecorded = runId && recordedRunIds.has(runId);
    if (alreadyRecorded && provenance === 'cache-hit') return snapshot();
    if (runId && !alreadyRecorded) {
      recordedRunIds.add(runId);
      metrics.agentRuns += 1;
    }

    const resultMetrics = result?.metrics && typeof result.metrics === 'object' ? result.metrics : {};
    const costMetricComplete = resultMetrics.costKnown === true
      ? validNonnegativeNumber(resultMetrics.costUsd)
      : (resultMetrics.costKnown === false && resultMetrics.costUsd === null);
    const complete = validNonnegativeNumber(resultMetrics.wallMs)
      && ['turns', 'toolCalls', 'toolAttempts', 'toolDenied'].every((field) => validNonnegativeInteger(resultMetrics[field]))
      && resultMetrics.toolAttempts === resultMetrics.toolCalls + resultMetrics.toolDenied
      && TOKEN_USAGE_FIELDS.every(([, source]) => validNonnegativeInteger(resultMetrics[source]))
      && costMetricComplete;
    metrics.complete = metrics.complete && complete;
    metrics.wallMs += nonnegativeNumber(resultMetrics.wallMs);
    metrics.turns += nonnegativeInteger(resultMetrics.turns);
    metrics.toolCalls += nonnegativeInteger(resultMetrics.toolCalls);
    metrics.toolAttempts += nonnegativeInteger(resultMetrics.toolAttempts);
    metrics.toolDenied += nonnegativeInteger(resultMetrics.toolDenied);
    for (const [field, source] of TOKEN_USAGE_FIELDS) {
      metrics.tokenUsage[field] += nonnegativeInteger(resultMetrics[source]);
    }

    const resultCostKnown = resultMetrics.costKnown === true && validNonnegativeNumber(resultMetrics.costUsd);
    if (metrics.costKnown && resultCostKnown) metrics.costUsd = +(metrics.costUsd + resultMetrics.costUsd).toFixed(8);
    else {
      metrics.costKnown = false;
      metrics.costUsd = null;
    }
    return snapshot();
  };

  return Object.freeze({ record, snapshot });
}
