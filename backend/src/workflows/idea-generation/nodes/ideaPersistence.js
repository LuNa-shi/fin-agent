import { IdeaStore } from '../../../domains/ideas/index.js';

export function persistIdeaArtifact(ideas, {
  store = IdeaStore,
  sourceRunId,
  sourceSnapshotId,
} = {}) {
  const newlyAdded = store.addIdeas(ideas, { sourceRunId, sourceSnapshotId });
  return { saved: store.getIdeas(), newlyAdded };
}
