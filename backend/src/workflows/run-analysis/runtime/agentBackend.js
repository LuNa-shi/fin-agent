import { withAgentResultObserver } from '../../../agents/AgentExecutionRuntime.js';
import { withAgentExecutionObserver } from '../../../core/agent-backend/AgentExecutionObserver.js';
import {
  ProjectSpace,
  createDurableAgentExecutionObserver,
} from '../../../project-space/index.js';

export function observeRunAnalysisAgentBackend({
  backend,
  projectId,
  workflowRunId,
  recordMetrics,
}) {
  return withAgentExecutionObserver(
    withAgentResultObserver(backend, recordMetrics),
    {
      workflowRunId,
      observer: createDurableAgentExecutionObserver({
        eventBus: ProjectSpace.eventBus(projectId),
        workflowRunId,
      }),
    },
  );
}
