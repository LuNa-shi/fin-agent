import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { globalContentIndex } from '../../../core/persistence/GlobalContentIndex.js';
import { IdeaStore } from '../../../domains/ideas/index.js';
import {
  GENERATOR_OUTPUT_REJECTION_REASONS,
  normalizeIdeaTitle,
} from '../nodes/candidateSelection.js';
import { hydrate } from './shared.js';

const EXECUTION_FIELDS = Object.freeze([
  'sourceIdeaRunId',
  'sourceRunInputSnapshotId',
  'sourceRunAsOf',
  'sourceEffectiveConfigDigest',
  'sourceGeneratorTraceRef',
  'sourceQualityTraceRef',
]);

function expectedIdea(context, idea) {
  const generated = context.nodeResults['generate-candidates'];
  const reviewed = context.nodeResults['review-quality'];
  return {
    ...idea,
    sourceIdeaRunId: context.runId,
    sourceRunInputSnapshotId: context.snapshot.snapshotId,
    sourceRunAsOf: context.snapshot.asOf,
    sourceEffectiveConfigDigest: context.snapshot.configDigest,
    sourceGeneratorTraceRef: generated.agent?.traceRef || null,
    sourceQualityTraceRef: reviewed.agent?.traceRef || null,
  };
}

function comparableIdea(idea) {
  const ignored = new Set([
    'contentRef',
    'contentDigest',
    'createdAt',
    'updatedAt',
    'sourceRunId',
    'sourceSnapshotId',
  ]);
  return Object.fromEntries(
    Object.entries(idea).filter(([field]) => !ignored.has(field)),
  );
}

function assertSameCommittedIdea(existing, expected) {
  if (canonicalSha256(comparableIdea(existing)) !== canonicalSha256(expected)) {
    const error = new Error(`Idea persistence conflict for stable id: ${expected.id}`);
    error.code = 'IDEA_PERSISTENCE_CONFLICT';
    throw error;
  }
  for (const field of EXECUTION_FIELDS) {
    if (existing[field] !== expected[field]) {
      const error = new Error(`Idea execution lineage conflict for ${expected.id}: ${field}`);
      error.code = 'IDEA_PERSISTENCE_CONFLICT';
      throw error;
    }
  }
  return existing;
}

function persistenceDuplicate(expected, existing, verifiedIndex) {
  return {
    index: verifiedIndex,
    stage: 'persist-ideas',
    reason: GENERATOR_OUTPUT_REJECTION_REASONS.DUPLICATE_EXISTING_TITLE,
    ideaId: expected.id,
    title: expected.title,
    normalizedTitle: normalizeIdeaTitle(expected.title),
    existingIdeaRef: {
      id: existing.id,
      contentRef: existing.contentRef || null,
      contentDigest: existing.contentDigest || null,
      sourceIdeaRunId: existing.sourceIdeaRunId || null,
      sourceRunInputSnapshotId: existing.sourceRunInputSnapshotId || null,
    },
  };
}

export async function execute(context) {
  const store = context.services.ideaStore || IdeaStore;
  const index = context.services.globalContentIndex || globalContentIndex;
  const reviewed = context.nodeResults['review-quality'];
  const committed = [];
  const persistenceRejections = [];

  for (let verifiedIndex = 0; verifiedIndex < reviewed.ideas.length; verifiedIndex += 1) {
    const reviewedIdea = reviewed.ideas[verifiedIndex];
    const expected = expectedIdea(context, reviewedIdea);
    const existing = store.getIdea(expected.id);
    if (existing) {
      committed.push(assertSameCommittedIdea(existing, expected));
      continue;
    }
    const [created] = store.addIdeas([expected], {
      sourceRunId: context.runId,
      sourceSnapshotId: context.snapshot.snapshotId,
    });
    if (!created) {
      const collision = store.getIdeas().find((idea) => (
        normalizeIdeaTitle(idea.title) === normalizeIdeaTitle(expected.title)
      ));
      if (!collision) {
        const error = new Error(`Idea was not committed: ${expected.id}`);
        error.code = 'IDEA_PERSISTENCE_CONFLICT';
        throw error;
      }
      if (collision.id === expected.id) {
        committed.push(assertSameCommittedIdea(collision, expected));
        continue;
      }
      persistenceRejections.push(
        persistenceDuplicate(expected, collision, verifiedIndex),
      );
      continue;
    }
    committed.push(created);
  }

  const projection = index.read();
  const ideaRefs = committed.map((idea) => {
    const entry = projection.entries.find((candidate) => (
      candidate.type === 'idea' && candidate.id === idea.id
    ));
    if (
      !entry
      || entry.contentRef !== idea.contentRef
      || entry.contentDigest !== idea.contentDigest
    ) {
      const error = new Error(`global index is missing committed Idea: ${idea.id}`);
      error.code = 'IDEA_INDEX_PROJECTION_MISMATCH';
      throw error;
    }
    return {
      id: idea.id,
      contentRef: idea.contentRef,
      contentDigest: idea.contentDigest,
    };
  });
  return {
    committed,
    ideaRefs,
    indexDigest: projection.indexDigest,
    persistenceRejections,
    rejected: [
      ...context.nodeResults['verify-candidates'].rejected,
      ...persistenceRejections,
    ],
  };
}

export { hydrate };
