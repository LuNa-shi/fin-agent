import { runDefinedAgent } from '../../../agents/runDefinedAgent.js';
import { companyAssumptionConflictIssues } from '../../../domains/research/contracts/outputProjections.js';
import { adjudicateReviews } from './adjudicator.js';
import { runDeterministicReportGates } from './deterministicGates.js';
import { REVIEWER_TYPES, reviewerContractId } from './reviewerContracts.js';

function compactReviewerResult(contractId, expectedReviewerType, value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasOutput = Object.prototype.hasOwnProperty.call(result, 'output');
  return {
    contractId,
    expectedReviewerType,
    output: hasOutput ? result.output : value,
    status: result.status,
    stopReason: result.stopReason,
    valid: result.valid,
    errors: Array.isArray(result.errors) ? result.errors.map((error) => String(error)) : [],
    budgetExhausted: result.budgetExhausted === true,
    live: result.live,
    provider: result.provider,
    model: result.model,
    metrics: result.metrics && typeof result.metrics === 'object' ? { ...result.metrics } : {},
  };
}

export async function runReviewerGroup(input = {}, { runReviewer = runDefinedAgent, reviewerRuntime = {} } = {}) {
  if (typeof runReviewer !== 'function') throw new TypeError('runReviewer must be a function');
  const reviewerResults = await Promise.all(REVIEWER_TYPES.map(async (reviewerType) => {
    const contractId = reviewerContractId(reviewerType);
    const result = await runReviewer(contractId, { ...input, reviewerType }, {
      ...reviewerRuntime,
      throwOnFailure: false,
    });
    return compactReviewerResult(contractId, reviewerType, result);
  }));
  const reviews = reviewerResults.map((result) => result.output);
  const deterministicIssues = [
    ...runDeterministicReportGates({ draftReport: input.draftReport }),
    ...companyAssumptionConflictIssues(input.companies),
    ...(Array.isArray(input.deterministicIssues) ? input.deterministicIssues : []),
  ];
  const decision = adjudicateReviews({
    reviews: reviewerResults,
    deterministicIssues,
    cycle: input.cycle ?? 0,
    asOf: input.asOf,
    inputDigest: input.inputDigest,
    createdAt: input.createdAt || input.asOf,
  });
  return { reviews, reviewerResults, deterministicIssues, decision };
}
