const PUBLIC_IDEA_FIELDS = Object.freeze([
  'id',
  'type',
  'status',
  'title',
  'sentence',
  'theme',
  'heat',
  'rationale',
  'tickers',
  'droppedTickers',
  'catalyst',
  'edge',
  'titleZh',
  'rationaleZh',
  'catalystZh',
  'edgeZh',
  'qualityScore',
  'qualityRank',
  'qualityReason',
  'qualitySelected',
  'qualitySource',
  'qualityWarnings',
  'sourceAgents',
  'timeHorizon',
  'sourceIdeaRunId',
  'sourceRunInputSnapshotId',
  'sourceRunAsOf',
  'sourceEffectiveConfigDigest',
  'sourceGeneratorTraceRef',
  'sourceQualityTraceRef',
  'sourceRunId',
  'sourceSnapshotId',
  'contentRef',
  'contentDigest',
  'createdAt',
  'updatedAt',
  'associatedProjectIds',
]);

const PUBLIC_AGENT_METRIC_FIELDS = Object.freeze([
  'turns',
  'toolCalls',
  'toolAttempts',
  'toolDenied',
  'tokens',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'wallMs',
  'deadlineMs',
  'finalizeReserveMs',
  'toolCallSafetyLimit',
  'costKnown',
  'costUsd',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function pick(source, fields) {
  if (!isObject(source)) return {};
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
    .map((field) => [field, clone(source[field])]));
}

function publicIdea(value) {
  return pick(value, PUBLIC_IDEA_FIELDS);
}

function publicIdeas(value) {
  return Array.isArray(value) ? value.map(publicIdea) : [];
}

function publicAgent(value) {
  if (!isObject(value)) return null;
  return {
    ...pick(value, [
      'status',
      'valid',
      'provider',
      'model',
      'live',
      'stopReason',
      'traceRef',
    ]),
    metrics: pick(value.metrics, PUBLIC_AGENT_METRIC_FIELDS),
  };
}

function publicAnnotation(value) {
  return pick(value, [
    'ideaId',
    'selected',
    'score',
    'rank',
    'reason',
    'source',
    'warnings',
  ]);
}

function publicRejection(value) {
  const projected = pick(value, [
    'index',
    'stage',
    'reason',
    'ideaId',
    'title',
    'normalizedTitle',
  ]);
  if (isObject(value?.existingIdeaRef)) {
    projected.existingIdeaRef = pick(value.existingIdeaRef, [
      'id',
      'contentRef',
      'contentDigest',
      'sourceIdeaRunId',
      'sourceRunInputSnapshotId',
    ]);
  }
  return projected;
}

function publicRejections(value) {
  return Array.isArray(value) ? value.map(publicRejection) : [];
}

function publicSourceRun(value) {
  return pick(value, [
    'sourceId',
    'status',
    'resultDigest',
    'runId',
    'nodeId',
    'snapshotId',
    'asOf',
  ]);
}

function publicTickerVerification(value) {
  return pick(value, ['requested', 'valid', 'invalid']);
}

function publicIdeaRef(value) {
  return pick(value, ['id', 'contentRef', 'contentDigest']);
}

function publicCollectionOutput(output) {
  const market = isObject(output?.market) ? output.market : {};
  return {
    market: {
      ...pick(market, ['domainsUsed', 'sourcesUsed', 'hasData', 'demoMode']),
      topCount: Array.isArray(market.top) ? market.top.length : 0,
      bottomCount: Array.isArray(market.bottom) ? market.bottom.length : 0,
      headlineCount: Array.isArray(market.headlines) ? market.headlines.length : 0,
      sectorRowCount: Array.isArray(market.sectorTable) ? market.sectorTable.length : 0,
      researchCount: Array.isArray(market.research) ? market.research.length : 0,
      saIdeaCount: Array.isArray(market.saIdeas) ? market.saIdeas.length : 0,
    },
    currentTickers: Array.isArray(output?.currentTickers)
      ? clone(output.currentTickers)
      : [],
    sourceRuns: Array.isArray(output?.sourceRuns)
      ? output.sourceRuns.map(publicSourceRun)
      : [],
    sourceCallCount: Array.isArray(output?.sourceCalls)
      ? output.sourceCalls.length
      : 0,
    sourceCandidateCount: Array.isArray(output?.sourceCandidates)
      ? output.sourceCandidates.length
      : 0,
    sourceCandidateDigest: output?.sourceCandidateDigest ?? null,
  };
}

const PUBLIC_NODE_OUTPUT_PROJECTORS = Object.freeze({
  'collect-market-context': publicCollectionOutput,
  'build-diversification-constraints': (output) => ({
    heldThemes: Array.isArray(output?.heldThemes) ? clone(output.heldThemes) : [],
    heavyThemes: Array.isArray(output?.heavyThemes) ? clone(output.heavyThemes) : [],
    concentration: {
      sorted: Array.isArray(output?.concentration?.sorted)
        ? clone(output.concentration.sorted)
        : [],
      total: Number.isFinite(Number(output?.concentration?.total))
        ? Number(output.concentration.total)
        : 0,
    },
  }),
  'generate-candidates': (output) => ({
    generatorInputDigest: output?.generatorInputDigest ?? null,
    rawCandidates: publicIdeas(output?.rawCandidates),
    agent: publicAgent(output?.agent),
  }),
  'verify-candidates': (output) => ({
    validIdeas: publicIdeas(output?.validIdeas),
    rejected: publicRejections(output?.rejected),
    tickerVerification: publicTickerVerification(output?.tickerVerification),
  }),
  'review-quality': (output) => ({
    ideas: publicIdeas(output?.ideas),
    annotations: Array.isArray(output?.annotations)
      ? output.annotations.map(publicAnnotation)
      : [],
    agent: publicAgent(output?.agent),
  }),
  'persist-ideas': (output) => ({
    committed: publicIdeas(output?.committed),
    ideaRefs: Array.isArray(output?.ideaRefs)
      ? output.ideaRefs.map(publicIdeaRef)
      : [],
    indexDigest: output?.indexDigest ?? null,
    persistenceRejections: publicRejections(output?.persistenceRejections),
    rejected: publicRejections(output?.rejected),
  }),
});

export function publicIdeaGenerationNodeOutput(nodeId, output) {
  if (output === null || output === undefined) return null;
  const project = PUBLIC_NODE_OUTPUT_PROJECTORS[nodeId];
  if (!project) {
    const error = new Error(`Idea Generation node has no public projection: ${nodeId}`);
    error.code = 'IDEA_NODE_PUBLIC_PROJECTION_MISSING';
    throw error;
  }
  return project(output);
}

export function publicIdeaGenerationResult(result) {
  if (!isObject(result)) throw new TypeError('Idea Generation result must be an object');
  return {
    ...pick(result, [
      'workflowId',
      'runId',
      'snapshotId',
      'asOf',
      'status',
      'stopReason',
      'provider',
      'live',
      'traceId',
    ]),
    ideas: publicIdeas(result.ideas),
    generated: publicIdeas(result.generated),
    rejected: publicRejections(result.rejected),
    execution: {
      executedNodeIds: Array.isArray(result.execution?.executedNodeIds)
        ? clone(result.execution.executedNodeIds)
        : [],
      hydratedNodeIds: Array.isArray(result.execution?.hydratedNodeIds)
        ? clone(result.execution.hydratedNodeIds)
        : [],
      stoppedAt: result.execution?.stoppedAt ?? null,
    },
  };
}
