import {
  assertWorkflowConditionBindings,
  assertWorkflowHandlerBindings,
  assertWorkflowHydrationBindings,
} from '../../core/workflow/WorkflowExecutor.js';
import { CANONICAL_WORLDVIEW_WORKFLOW_SPEC } from './canonicalWorkflowSpec.js';

export const CANONICAL_WORLDVIEW_HANDLER_BINDINGS = Object.freeze({
  freezeWorldviewRun: async (context) => context.services.freezeWorldviewRun(context),
  executeCoreWorldviewAttempts: async (context) => context.services.executeCoreWorldviewAttempts(context),
  validateWorldviewAndClaimActions: async (context) => context.services.validateWorldviewAndClaimActions(context),
  stageRunPublication: async (context) => context.services.stageRunPublication(context),
  commitRunPublication: async (context) => context.services.commitRunPublication(context),
});

export const CANONICAL_WORLDVIEW_HYDRATION_BINDINGS = Object.fromEntries(
  Object.keys(CANONICAL_WORLDVIEW_HANDLER_BINDINGS).map((handlerId) => [
    handlerId,
    async (context, node, details) => context.services.hydrateNode(context, handlerId, node, details),
  ]),
);

export const CANONICAL_WORLDVIEW_CONDITION_BINDINGS = Object.freeze({ always: () => true });

assertWorkflowHandlerBindings(CANONICAL_WORLDVIEW_WORKFLOW_SPEC, CANONICAL_WORLDVIEW_HANDLER_BINDINGS);
assertWorkflowHydrationBindings(CANONICAL_WORLDVIEW_WORKFLOW_SPEC, CANONICAL_WORLDVIEW_HYDRATION_BINDINGS);
assertWorkflowConditionBindings(CANONICAL_WORLDVIEW_WORKFLOW_SPEC, CANONICAL_WORLDVIEW_CONDITION_BINDINGS);
