import { canonicalSha256, deepFreeze } from '../../../core/contracts/ArtifactRef.js';
import { validateJsonSchema } from '../../../core/validation/OutputGate.js';
import { getResearchSchema } from '../contracts/schemaRegistry.js';

export const EVIDENCE_BUNDLE_ARTIFACT_PATTERN = 'data/evidence_bundle_rN.json';

const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function strings(value) {
  return [...new Set(array(value).map((item) => String(item || '').trim()).filter(Boolean))];
}

function tokens(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._%+-]*/gu) || [])]
    .filter((token) => token.length > 1);
}

function numericTokens(value) {
  return new Set(String(value || '').match(/-?\d+(?:\.\d+)?%?/gu) || []);
}

function sourceHintScore(source, provider) {
  const normalized = String(source || '').toLowerCase();
  const hints = {
    fmp: ['fmp', '行情', '财务', '共识', 'comps'], edgar: ['edgar', 'sec', 'filing', '备案'],
    fred: ['fred', 'macro', '宏观'], perplexity: ['perplexity', '联网', 'research'], demo: ['demo', '演示'],
  };
  return (hints[provider] || [provider]).some((hint) => normalized.includes(hint)) ? 1 : 0;
}

function matchEvidence(point, collection, sourceById) {
  const claim = String(point.fact || point.point || point.claim || '').trim();
  const claimTokens = tokens(claim);
  const claimNumbers = numericTokens(claim);
  const ticker = String(point.ticker || '').trim().toUpperCase();
  return collection.evidenceItems.map((item) => {
    const statementTokens = new Set(tokens(item.statement));
    const overlap = claimTokens.length ? claimTokens.filter((token) => statementTokens.has(token)).length / claimTokens.length : 0;
    const statementNumbers = numericTokens(item.statement);
    const numericMatch = claimNumbers.size ? [...claimNumbers].some((token) => statementNumbers.has(token)) : false;
    const entityMatch = ticker && item.entityIds.includes(`ticker:${ticker}`) ? 1 : 0;
    const provider = sourceById.get(item.sourceId)?.provider || '';
    const hintMatch = sourceHintScore(point.source, provider);
    const score = overlap * 0.45 + (numericMatch ? 0.3 : 0) + entityMatch * 0.15 + hintMatch * 0.1;
    return { item, score };
  }).filter((entry) => entry.score >= 0.2).sort((a, b) => b.score - a.score || a.item.evidenceId.localeCompare(b.item.evidenceId)).slice(0, 3);
}

function estimateLike(point) {
  return /(estimate|opinion|forecast|target|implied|假设|估计|观点|预测|目标价)/iu.test(`${point.type || ''} ${point.credibility || ''} ${point.fact || point.point || ''}`);
}

function credibility(confidence) {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function deterministicEvidenceGroup(collection, sourceById) {
  const points = collection.evidenceItems.slice(0, 80).map((item) => ({
    fact: item.statement,
    ticker: item.entityIds.find((entityId) => entityId.startsWith('ticker:'))?.slice('ticker:'.length) || '',
    source: sourceById.get(item.sourceId)?.sourceId || item.sourceId,
    credibility: credibility(item.confidence),
    type: item.evidenceType,
    material: true,
    evidenceRefs: [item.evidenceId],
    note: 'Deterministic EvidenceItem fallback because the Data Agent produced no organized claims.',
  }));
  return points.length ? [{ dimension: 'deterministic-evidence-baseline', points }] : [];
}

function coverageFor(plan, collection) {
  const sources = collection.sourceDocuments;
  const questions = plan.questions.map((question) => {
    const strategies = plan.sourceStrategies.filter((strategy) => strategy.questionId === question.questionId);
    const strategySources = sources.filter((source) => strategies.some((strategy) => (
      strategy.providers.includes(source.provider)
      || (source.provider === 'demo' && strategy.providers.includes('fmp'))
    )));
    const matchedSources = strategySources.filter((source) => source.provider !== 'demo');
    const estimateSources = strategySources.filter((source) => source.provider === 'demo');
    return {
      questionId: question.questionId,
      material: question.material,
      sourceCount: matchedSources.length,
      evidenceCount: collection.evidenceItems.filter((item) => matchedSources.some((source) => source.sourceId === item.sourceId)).length,
      estimateSourceCount: estimateSources.length,
      status: matchedSources.length ? 'covered' : (estimateSources.length ? 'estimate-only' : 'gap'),
    };
  });
  const covered = questions.filter((item) => item.status === 'covered').length;
  return {
    score: questions.length ? +(covered / questions.length).toFixed(4) : 0,
    coveredQuestions: covered,
    totalQuestions: questions.length,
    questions,
  };
}

export function auditEvidence({ plan, collection, organizedOutput = {} } = {}) {
  if (!plan || !collection) throw new TypeError('EvidenceAuditor requires DataPlan and EvidenceCollection');
  const sourceById = new Map(collection.sourceDocuments.map((source) => [source.sourceId, source]));
  const evidenceById = new Map(collection.evidenceItems.map((item) => [item.evidenceId, item]));
  const openIssues = [];
  const agentOrganized = array(organizedOutput.organized);
  const agentPointCount = agentOrganized.reduce((sum, group) => sum + array(group?.points).length, 0);
  const usedDeterministicFallback = agentPointCount === 0 && collection.evidenceItems.length > 0;
  const organizedInput = usedDeterministicFallback ? deterministicEvidenceGroup(collection, sourceById) : agentOrganized;
  if (usedDeterministicFallback) {
    openIssues.push({
      issueId: `data-open:${canonicalSha256({ planDigest: plan.inputDigest, reason: 'deterministic-claim-fallback' }).slice('sha256:'.length)}`,
      owner: 'data',
      severity: 'warning',
      claim: 'The Data Agent produced no organized claims; the Evidence Auditor used atomic EvidenceItems as the claim baseline.',
      evidenceRefs: collection.evidenceItems.slice(0, 80).map((item) => item.evidenceId),
      requestedAction: 'Review why the Data Agent omitted organized claims and retain the deterministic EvidenceItem claim set until a stronger live output is available.',
    });
  }
  const organized = organizedInput.map((group, groupIndex) => ({
    ...object(group),
    dimension: String(group?.dimension || `dimension-${groupIndex + 1}`),
    points: array(group?.points).map((rawPoint, pointIndex) => {
      const point = object(rawPoint);
      const claim = String(point.fact || point.point || point.claim || '').trim();
      const matches = matchEvidence(point, collection, sourceById);
      const evidenceRefs = strings([...array(point.evidenceRefs), ...matches.map((entry) => entry.item.evidenceId)]);
      const referencedEvidence = evidenceRefs.map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean);
      const hasSupportingEvidence = referencedEvidence.some((item) => ['fact', 'management_statement'].includes(item.evidenceType));
      const hasEstimateEvidence = referencedEvidence.some((item) => ['estimate', 'opinion'].includes(item.evidenceType));
      const claimId = `claim:${canonicalSha256({ group: groupIndex, point: pointIndex, claim }).slice('sha256:'.length)}`;
      let claimStatus = 'supported';
      if (!hasSupportingEvidence && (hasEstimateEvidence || estimateLike(point))) claimStatus = 'estimate';
      else if (!hasSupportingEvidence) {
        claimStatus = 'open-issue';
        openIssues.push({
          issueId: `data-open:${canonicalSha256({ claimId, claim }).slice('sha256:'.length)}`,
          owner: 'data',
          severity: 'warning',
          claim,
          evidenceRefs: [],
          requestedAction: `Collect a point-in-time-safe source for: ${claim || 'unnamed material claim'}`,
        });
      }
      return { ...point, claimId, fact: claim, material: point.material !== false, evidenceRefs, claimStatus };
    }),
  }));
  const materialPoints = organized.flatMap((group) => group.points).filter((point) => point.material);
  const supportedClaims = materialPoints.filter((point) => point.claimStatus === 'supported').length;
  const estimateClaims = materialPoints.filter((point) => point.claimStatus === 'estimate').length;
  const openIssueClaims = materialPoints.filter((point) => point.claimStatus === 'open-issue').length;
  const classifiedClaims = supportedClaims + estimateClaims + openIssueClaims;
  const collectedCoverage = coverageFor(plan, collection);
  const noMaterialClaims = materialPoints.length === 0;
  const coverage = noMaterialClaims ? {
    ...collectedCoverage,
    score: 0,
    coveredQuestions: 0,
    questions: collectedCoverage.questions.map((question) => ({
      ...question,
      status: 'unassessed-no-material-claims',
    })),
  } : collectedCoverage;
  const planGaps = coverage.questions.filter((item) => item.status !== 'covered').map((item) => (
    item.status === 'estimate-only'
      ? `Only demo/estimate sources were collected for ${item.questionId}.`
      : (item.status === 'unassessed-no-material-claims'
        ? `No material claim was produced for ${item.questionId}; claim-level coverage is unassessed.`
        : `No point-in-time-safe source collected for ${item.questionId}.`)
  ));
  const gaps = strings([
    ...array(organizedOutput.gaps),
    ...plan.gaps,
    ...planGaps,
    ...(usedDeterministicFallback ? ['Data Agent produced no organized claims; deterministic EvidenceItems were used as the material-claim baseline.'] : []),
    ...(noMaterialClaims ? ['No material claims were produced; claim-level traceability cannot pass.'] : []),
  ]);
  if (noMaterialClaims) {
    openIssues.push({
      issueId: `data-open:${canonicalSha256({ planDigest: plan.inputDigest, reason: 'no-material-claims' }).slice('sha256:'.length)}`,
      owner: 'data',
      severity: 'critical',
      claim: 'No material claims were produced for evidence audit.',
      evidenceRefs: [],
      requestedAction: 'Produce at least one material claim linked to point-in-time-safe evidence, or block downstream analysis as an evidence-gap memo.',
    });
  }
  const nextFocus = object(organizedOutput.nextDataFocus);
  const nextRequests = strings(nextFocus.questions).map((question, index) => ({
    requestId: `data-request:${canonicalSha256({ question, index }).slice('sha256:'.length)}`,
    question,
    entityIds: plan.entities.filter((item) => item.entityType === 'company').map((item) => item.entityId),
    preferredTools: strings(nextFocus.tools),
    status: 'open',
  }));
  for (const question of coverage.questions.filter((item) => item.status !== 'covered')) {
    const planQuestion = plan.questions.find((item) => item.questionId === question.questionId);
    nextRequests.push({
      requestId: `data-request:${canonicalSha256(question).slice('sha256:'.length)}`,
      question: planQuestion?.question || question.questionId,
      entityIds: planQuestion?.entityIds || [],
      preferredTools: plan.sourceStrategies.filter((item) => item.questionId === question.questionId).flatMap((item) => item.tools),
      status: 'open',
    });
  }
  const claimAudit = {
    materialClaims: materialPoints.length,
    supportedClaims,
    estimateClaims,
    openIssueClaims,
    classifiedClaims,
    classificationRate: materialPoints.length ? +(classifiedClaims / materialPoints.length).toFixed(4) : 0,
    citationCoverage: materialPoints.length ? +(supportedClaims / materialPoints.length).toFixed(4) : 0,
  };
  const evidenceRefs = collection.evidenceItems.map((item) => item.evidenceId);
  const bundle = {
    schemaVersion: '1.0.0',
    asOf: plan.asOf,
    producer: 'evidence-auditor',
    contractVersion: '1.0.0',
    inputDigest: canonicalSha256({ planDigest: plan.inputDigest, collection: collection.stats, organized }),
    createdAt: plan.asOf,
    evidenceRefs,
    sourceRefs: collection.sourceDocuments.map((source) => source.sourceId),
    items: collection.evidenceItems,
    events: collection.domainEvents,
    coverage,
    contradictions: array(organizedOutput.contradictions),
    gaps,
    nextRequests,
    claimAudit,
    openIssues,
  };
  const errors = validateJsonSchema(bundle, getResearchSchema('evidenceBundle.v1'));
  if (errors.length) throw new TypeError(`EvidenceBundle validation failed: ${errors.join('; ')}`);
  return deepFreeze({ bundle, organized, openIssues, nextRequests });
}
