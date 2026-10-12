const PUBLIC_FAILURE_MESSAGES = new Map([
  ['DAILY_REPORT_BATCH_OUTCOME_CONFLICT', 'Daily Report Batch outcome conflicted with its durable record'],
  ['DAILY_REPORT_BATCH_PACKAGE_MISMATCH', 'Report package did not match its Daily Report Batch item'],
  ['DAILY_REPORT_PRODUCTION_FAILED', 'Daily report production failed'],
  ['INVALID_REPORT_OVERVIEW', 'Report Overview output was invalid'],
  ['REPORT_ADMISSION_ATTEMPT_CONFLICT', 'Report admission attempt conflicted with its durable record'],
  ['REPORT_ADMISSION_BLOCKED', 'Report admission candidate is blocked'],
  ['REPORT_ADMISSION_CANDIDATE_CONFLICT', 'Report admission candidate conflicted with its durable input'],
  ['REPORT_ADMISSION_CANDIDATE_CORRUPT', 'Report admission candidate state was corrupt'],
  ['REPORT_ADMISSION_CANDIDATE_NOT_FOUND', 'Report admission candidate was not found'],
  ['REPORT_ADMISSION_CORRUPT', 'Report admission state was corrupt'],
  ['REPORT_ADMISSION_FAILED', 'Report admission failed'],
  ['REPORT_ADMISSION_INVALID_BATCH_REF', 'Report admission batch lineage was invalid'],
  ['REPORT_ADMISSION_IN_FLIGHT', 'Report admission candidate is already in progress'],
  ['REPORT_ADMISSION_INVALID_STATE', 'Report admission candidate state was invalid'],
  ['REPORT_ADMISSION_OWNERSHIP_CONFLICT', 'Report admission ownership conflicted with its durable record'],
  ['REPORT_ADMISSION_PROJECTION_REPAIR_PENDING', 'Report admission projection repair remains pending'],
  ['REPORT_ADMISSION_RECEIPT_CONFLICT', 'Report admission receipt conflicted with its durable record'],
  ['REPORT_ADMISSION_RETRYABLE', 'Report admission candidate remains retryable'],
  ['REPORT_ADMISSION_STOP_REASON', 'Admission attempt stopped'],
  ['REPORT_EVENT_IDEMPOTENCY_CONFLICT', 'Report admission event conflicted with its durable record'],
  ['REPORT_LIBRARY_ADMISSION_CONFLICT', 'Report Library admission conflicted with its durable record'],
  ['REPORT_LIBRARY_BACKFILL_FAILED', 'Report Library backfill failed'],
  ['REPORT_LIBRARY_CONTENT_CONFLICT', 'Report Library content conflicted with its immutable object'],
  ['REPORT_LIBRARY_CONTENT_DIGEST_MISMATCH', 'Report Library content digest did not match'],
  ['REPORT_LIBRARY_CORRUPT_ANCHOR', 'Report Library admission anchor was corrupt'],
  ['REPORT_LIBRARY_IDEMPOTENCY_CONFLICT', 'Report Library identity conflicted with its durable record'],
  ['REPORT_LIBRARY_INGESTION_FAILED', 'Report Library ingestion failed'],
  ['REPORT_OVERVIEW_AGENT_FAILED', 'Report Overview execution failed'],
  ['REPORT_OVERVIEW_BINDING_MISMATCH', 'Report Overview did not match the staged ReportVersion'],
  ['REPORT_OVERVIEW_CONFIG_MISMATCH', 'Report Overview configuration changed after staging'],
  ['REPORT_OVERVIEW_CORRUPT', 'Report Overview state was corrupt'],
  ['REPORT_OVERVIEW_CONTEXT_TOO_LARGE', 'Report candidate exceeded the Report Overview context limit'],
  ['REPORT_OVERVIEW_OUTPUT_INVALID', 'Report Overview output was invalid'],
  ['REPORT_OVERVIEW_IDEMPOTENCY_CONFLICT', 'Report Overview conflicted with its immutable record'],
  ['REPORT_OVERVIEW_PRODUCTION_FAILED', 'Report Overview production failed'],
  ['REPORT_OVERVIEW_PROVIDER_TRANSIENT', 'Report Overview provider was temporarily unavailable'],
  ['REPORT_PRODUCTION_FAILED', 'Report production failed'],
  ['RUN_ANALYSIS_FAILED', 'Run Analysis failed'],
]);

const PUBLIC_STOP_REASONS = new Set([
  'aborted',
  'cancelled',
  'completed',
  'cost-budget',
  'deadline',
  'error',
  'fatal',
  'final',
  'human-review',
  'length',
  'maxTurns',
  'model-length',
  'process-interrupted',
  'provider-unavailable',
  'runtime-budget',
  'schema-invalid',
  'stop',
  'token-budget',
  'tool-budget',
  'toolUse',
  'unknown',
]);

const SAFE_TRACE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

export function safePublicFailure(error, {
  fallbackCode = 'REPORT_OPERATION_FAILED',
  fallbackMessage = 'Report operation failed',
} = {}) {
  const requestedCode = String(error?.code || '');
  const trustedCode = PUBLIC_FAILURE_MESSAGES.has(requestedCode) ? requestedCode : String(fallbackCode);
  const code = trustedCode
    .replace(/[^A-Za-z0-9_.:-]/gu, '_')
    .slice(0, 120) || fallbackCode;
  const message = String(PUBLIC_FAILURE_MESSAGES.get(code) || fallbackMessage).slice(0, 300);
  return { code, message };
}

export function safePublicStopReason(value, { fallback = 'unknown' } = {}) {
  const stopReason = String(value || '').trim();
  return PUBLIC_STOP_REASONS.has(stopReason) ? stopReason : fallback;
}

export function safePublicTraceRef(value, { fallback = null, maxLength = 300 } = {}) {
  if (value === null || value === undefined) return null;
  const traceRef = String(value).trim();
  return traceRef.length > 0 && traceRef.length <= maxLength && SAFE_TRACE_REF_RE.test(traceRef)
    ? traceRef
    : fallback;
}
