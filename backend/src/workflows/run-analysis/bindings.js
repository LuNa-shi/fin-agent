import {
  initializeCheckpoint,
  hydrateInitializeCheckpoint,
} from './handlers/initializeCheckpoint.js';
import { planResearch, hydratePlanResearch } from './handlers/planResearch.js';
import { selectCandidates, hydrateSelectCandidates } from './handlers/selectCandidates.js';
import { runResearchRounds, hydrateResearchRounds } from './handlers/runResearchRounds.js';
import { composeReport, hydrateComposeReport } from './handlers/composeReport.js';
import { reviewReport, hydrateReviewReport } from './handlers/reviewReport.js';
import {
  synthesizeConclusion,
  hydrateSynthesizeConclusion,
} from './handlers/synthesizeConclusion.js';
import { finalizeProject, hydrateFinalizeProject } from './handlers/finalizeProject.js';
export { RUN_ANALYSIS_CONDITION_BINDINGS } from './policies/conditions.js';

export const RUN_ANALYSIS_HANDLER_BINDINGS = Object.freeze({
  initializeCheckpoint,
  planResearch,
  selectCandidates,
  runResearchRounds,
  composeReport,
  reviewReport,
  synthesizeConclusion,
  finalizeProject,
});

export const RUN_ANALYSIS_HYDRATION_BINDINGS = Object.freeze({
  initializeCheckpoint: hydrateInitializeCheckpoint,
  planResearch: hydratePlanResearch,
  selectCandidates: hydrateSelectCandidates,
  runResearchRounds: hydrateResearchRounds,
  composeReport: hydrateComposeReport,
  reviewReport: hydrateReviewReport,
  synthesizeConclusion: hydrateSynthesizeConclusion,
  finalizeProject: hydrateFinalizeProject,
});
