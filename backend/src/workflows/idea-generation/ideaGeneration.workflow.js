// Compatibility façade. The executable topology, durable composition, and
// read models are owned by dedicated Idea Generation v2 modules.
export { classifyProjectSeed } from './classifyProjectSeed.js';
export {
  ideaGenerationAgentTimeline,
  ideaGenerationProgress,
  ideaGenerationTrace,
  ideaGenerationTraces,
} from './runApiProjection.js';
export {
  recoverInterruptedIdeaGenerationRuns,
  resumeIdeaGenerationWorkflow,
  runIdeaGenerationWorkflow,
} from './runIdeaGeneration.js';
export {
  IDEA_GENERATION_WORKFLOW_SPEC as IDEA_GENERATION_WORKFLOW,
  IDEA_GENERATION_WORKFLOW_SPEC_HASH as IDEA_GENERATION_WORKFLOW_HASH,
} from './workflowSpec.js';
