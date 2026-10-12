import {
  ProjectSpace,
  verifiedRunAnalysisReportPackage,
} from '../../../project-space/index.js';
import { RUN_STATUSES } from '../../../project-space/RunStore.js';
import { ensureRunAnalysisHumanReviewTask } from './taskFactory.js';

const ACTIVE_REVIEW_STATUSES = new Set(['open', 'decided', 'resuming']);

export function assertRunAnalysisReviewMutationAllowed(projectId, {
  projectSpace = ProjectSpace,
  operation = 'project mutation',
} = {}) {
  if (!projectSpace.meta(projectId)) {
    const error = new Error(`project not found: ${projectId}`);
    error.code = 'PROJECT_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  const latest = projectSpace.runStore(projectId).list().at(-1) || null;
  if (latest?.status === RUN_STATUSES.BLOCKED && latest.stopReason === 'human-review') {
    ensureRunAnalysisHumanReviewTask(projectId, {
      runId: latest.runId,
      projectSpace,
    });
  }
  const store = projectSpace.humanReviewStore(projectId);
  let task = store.open();
  if (task?.status === 'resuming') {
    const run = projectSpace.runStore(projectId).load(task.runId);
    if (
      run?.status === RUN_STATUSES.SUCCEEDED
      && verifiedRunAnalysisReportPackage(projectId, run, { projectSpace })
    ) {
      store.markOutcome(task.taskId, {
        status: 'resolved',
        resultingRunStatus: run.status,
        completedAt: run.completedAt,
      });
      task = store.open();
    } else if (
      run?.status === RUN_STATUSES.FAILED
      || (
        run?.status === RUN_STATUSES.CANCELLED
        && run.stopReason !== 'human-review-terminated'
      )
    ) {
      store.markOutcome(task.taskId, {
        status: 'resume-failed',
        resultingRunStatus: run.status,
        completedAt: run.completedAt,
      });
      task = store.open();
    }
  }
  if (task && ACTIVE_REVIEW_STATUSES.has(task.status)) {
    const error = new Error(`${operation} is blocked while Human Review is ${task.status}`);
    error.code = 'HUMAN_REVIEW_MUTATION_BLOCKED';
    error.statusCode = 409;
    throw error;
  }
  return true;
}
