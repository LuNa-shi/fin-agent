import { randomUUID } from 'node:crypto';

export function createArtifactRunId(projectId) {
  return `artifact-run-${projectId}-${randomUUID()}`;
}
