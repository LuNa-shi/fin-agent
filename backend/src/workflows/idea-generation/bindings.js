import {
  assertWorkflowConditionBindings,
  assertWorkflowHandlerBindings,
  assertWorkflowHydrationBindings,
} from '../../core/workflow/WorkflowExecutor.js';
import { execute as buildDiversificationConstraints, hydrate as hydrateBuildDiversificationConstraints } from './handlers/buildDiversificationConstraints.js';
import { execute as collectMarketContext, hydrate as hydrateCollectMarketContext } from './handlers/collectMarketContext.js';
import { execute as generateCandidates, hydrate as hydrateGenerateCandidates } from './handlers/generateCandidates.js';
import { execute as persistIdeas, hydrate as hydratePersistIdeas } from './handlers/persistIdeas.js';
import { execute as reviewQuality, hydrate as hydrateReviewQuality } from './handlers/reviewQuality.js';
import { execute as verifyCandidates, hydrate as hydrateVerifyCandidates } from './handlers/verifyCandidates.js';
import { IDEA_GENERATION_WORKFLOW_SPEC } from './workflowSpec.js';

export const IDEA_GENERATION_HANDLER_BINDINGS = Object.freeze({
  collectMarketContext,
  buildDiversificationConstraints,
  generateCandidates,
  verifyCandidates,
  reviewQuality,
  persistIdeas,
});

export const IDEA_GENERATION_HYDRATION_BINDINGS = Object.freeze({
  collectMarketContext: hydrateCollectMarketContext,
  buildDiversificationConstraints: hydrateBuildDiversificationConstraints,
  generateCandidates: hydrateGenerateCandidates,
  verifyCandidates: hydrateVerifyCandidates,
  reviewQuality: hydrateReviewQuality,
  persistIdeas: hydratePersistIdeas,
});

export const IDEA_GENERATION_CONDITION_BINDINGS = Object.freeze({
  always: () => true,
});

assertWorkflowHandlerBindings(
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_HANDLER_BINDINGS,
);
assertWorkflowHydrationBindings(
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_HYDRATION_BINDINGS,
);
assertWorkflowConditionBindings(
  IDEA_GENERATION_WORKFLOW_SPEC,
  IDEA_GENERATION_CONDITION_BINDINGS,
);
