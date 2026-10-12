export const RUN_ANALYSIS_CONDITION_BINDINGS = Object.freeze({
  always: () => true,
  'checkpoint-plan-missing': ({ cp }) => cp.plan == null,
  'checkpoint-scan-missing': ({ cp }) => cp.scan == null,
  'checkpoint-research-rounds-pending': ({ cp }) => cp.round < cp.targetRounds
    || cp.activeRemediation?.owners?.some((owner) => ['data', 'industry', 'company'].includes(owner)) === true,
  'checkpoint-report-missing': ({ cp }) => cp.reportDone !== true
    || cp.activeRemediation?.owners?.includes('report') === true,
  'checkpoint-report-review-missing': ({ cp }) => cp.reportReview == null,
  'checkpoint-conclusion-missing': ({ cp }) => cp.conclusion == null,
  'checkpoint-incomplete': ({ cp }) => cp.done !== true,
});
