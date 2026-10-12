import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';

export const REVIEW_DEPENDENCY_GROUPS = Object.freeze(['data', 'industry', 'company']);

function compareArtifactRef(left, right) {
  return String(left?.path || left?.artifactId || '').localeCompare(String(right?.path || right?.artifactId || ''))
    || String(left?.artifactId || '').localeCompare(String(right?.artifactId || ''))
    || Number(left?.version || 0) - Number(right?.version || 0)
    || String(left?.contentDigest || '').localeCompare(String(right?.contentDigest || ''));
}

function artifactIdentity(ref) {
  return {
    artifactId: ref.artifactId,
    version: ref.version,
    path: ref.path,
    contentDigest: ref.contentDigest,
    schemaVersion: ref.schemaVersion,
    producer: ref.producer,
    contractVersion: ref.contractVersion,
    inputDigest: ref.inputDigest,
    asOf: ref.asOf,
  };
}

export function sortReviewDependencyRefs(refs = {}) {
  return Object.fromEntries(REVIEW_DEPENDENCY_GROUPS.map((group) => [
    group,
    (Array.isArray(refs[group]) ? refs[group] : [])
      .map((ref) => structuredClone(ref))
      .sort(compareArtifactRef),
  ]));
}

export function reviewDependencyDigest(dependencyRefs = {}) {
  const sorted = sortReviewDependencyRefs(dependencyRefs);
  return canonicalSha256(Object.fromEntries(REVIEW_DEPENDENCY_GROUPS.map((group) => [
    group,
    sorted[group].map(artifactIdentity),
  ])));
}
