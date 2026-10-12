// Compatibility entry point for Run Analysis workflow consumers.
// Runtime composition lives in runAnalysis.js; bounded node behavior lives in handlers/.
export { RUN_ANALYSIS_WORKFLOW_SPEC as RUN_ANALYSIS_WORKFLOW } from './workflowSpec.js';
export { INTENSITY } from './policies/intensity.js';
export {
  RUN_ANALYSIS_CONDITION_BINDINGS,
  RUN_ANALYSIS_HANDLER_BINDINGS,
  RUN_ANALYSIS_HYDRATION_BINDINGS,
} from './bindings.js';
export { createRunAnalysisRuntimeMetrics } from './runtime/metrics.js';
export { emitRunAnalysisEvent } from './projection/events.js';
export { selectReportMarkdown } from './projection/reportMarkdown.js';
export { canonicalReportQualityIssues } from './handlers/reviewReport.js';
export { runAnalysisWorkflow } from './runAnalysis.js';
