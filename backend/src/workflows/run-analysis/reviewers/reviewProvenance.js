const REVIEW_PACKAGE_DIGEST_SCOPE = 'workflow brief + projected evidenceBundle + draftReport + deterministic reportQualityAudit';
const EVIDENCE_SET_DIGEST_SCOPE = 'citation-ledger normalized evidence set: asOf + aliases + ambiguousAliases + sources + evidenceItems';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function isoTimestamp(value, field) {
  if (value === null || value === undefined || value === '') throw new TypeError(`${field} must be a valid timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function projectGeneratedAt(value, field) {
  const source = record(value);
  if (!source) return value ?? null;
  if (!Object.prototype.hasOwnProperty.call(source, 'generatedAt')) return { ...source };
  return { ...source, generatedAt: isoTimestamp(source.generatedAt, `${field}.generatedAt`) };
}

export function projectSourceManifestForReview(sourceManifest) {
  const source = record(sourceManifest);
  if (!source) return sourceManifest ?? null;
  const projected = projectGeneratedAt(source, 'sourceManifest');
  if (!Array.isArray(source.rounds)) return projected;
  return {
    ...projected,
    rounds: source.rounds.map((round, index) => projectGeneratedAt(round, `sourceManifest.rounds[${index}]`)),
  };
}

export function buildEvidenceReviewProvenance({ sourceManifest, citationLedger, asOf } = {}) {
  const projectedSourceManifest = projectSourceManifestForReview(sourceManifest);
  const normalizedAsOf = isoTimestamp(asOf, 'asOf');
  const manifestGeneratedAt = record(projectedSourceManifest)?.generatedAt || null;
  const roundGeneratedAt = Array.isArray(record(projectedSourceManifest)?.rounds)
    ? projectedSourceManifest.rounds.map((round) => record(round)?.generatedAt).filter(Boolean)
    : [];
  const manifestTimestamps = [manifestGeneratedAt, ...roundGeneratedAt].filter(Boolean);
  const cutoffMs = Date.parse(normalizedAsOf);
  const allManifestTimestampsAtOrBeforeAsOf = manifestTimestamps.every((timestamp) => Date.parse(timestamp) <= cutoffMs);
  const ledger = record(citationLedger);

  return {
    sourceManifest: projectedSourceManifest,
    citationContract: ledger ? {
      evidenceSetDigest: ledger.inputDigest,
      ledgerInputDigest: ledger.inputDigest,
      digestScope: {
        evidenceSetDigest: EVIDENCE_SET_DIGEST_SCOPE,
        reviewPackageInputDigest: REVIEW_PACKAGE_DIGEST_SCOPE,
      },
      expectedToDifferFromReviewPackageInputDigest: true,
      digestComparisonRule: 'Do not require the evidence-set digest to equal the reviewer inputDigest; they hash different objects.',
      asOfSafety: {
        asOf: normalizedAsOf,
        generatedAtFormat: 'ISO-8601 UTC',
        generatedAtSemantics: 'sourceManifest generatedAt fields project the declared evidence cutoff, not a later source observation.',
        equalityWithAsOfIsInBounds: true,
        allManifestTimestampsAtOrBeforeAsOf,
        sourceRecencyRule: 'Post-as-of evidence safety is determined from SourceDocument/EvidenceItem publishedAt, observedAt, and fetchedAt fields; a manifest generatedAt equal to asOf is safe.',
      },
      markerContract: ledger.markerContract,
      aliases: ledger.aliases || [],
      ambiguousAliases: ledger.ambiguousAliases || [],
      navigationOnlyArtifacts: ledger.navigationOnlyArtifacts || [],
    } : null,
  };
}
