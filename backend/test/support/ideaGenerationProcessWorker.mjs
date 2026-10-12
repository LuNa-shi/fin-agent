const [action, runId, asOf, stopAfterNodeId = ''] = process.argv.slice(2);

if (!['start', 'resume'].includes(action)) {
  throw new TypeError('Idea Generation process worker action must be start or resume');
}
if (!runId) throw new TypeError('Idea Generation process worker runId is required');

const {
  resumeIdeaGenerationWorkflow,
  runIdeaGenerationWorkflow,
} = await import('../../src/workflows/idea-generation/runIdeaGeneration.js');

const result = action === 'start'
  ? await runIdeaGenerationWorkflow(1, {
      ...(stopAfterNodeId ? { stopAfterNodeId } : {}),
      services: {
        runId,
        asOf,
      },
    })
  : await resumeIdeaGenerationWorkflow(runId);

console.log(JSON.stringify({
  runId: result.runId,
  snapshotId: result.snapshotId,
  asOf: result.asOf,
  status: result.status,
  generatedIdeaIds: result.generated.map((idea) => idea.id),
  executedNodeIds: result.execution.executedNodeIds,
  hydratedNodeIds: result.execution.hydratedNodeIds,
}));
