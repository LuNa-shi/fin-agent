import {
  deriveStableIdeaId,
  normalizeGeneratorOutputs,
  verifyCandidateTickers,
} from '../nodes/candidateSelection.js';
import { tickerShapeOk } from '../nodes/marketContext.js';
import { hydrate } from './shared.js';

export async function execute(context) {
  const generated = context.nodeResults['generate-candidates'];
  const constraints = context.nodeResults['build-diversification-constraints'];
  const rawCandidates = generated.rawCandidates;
  const allTickers = rawCandidates
    .flatMap((idea) => (Array.isArray(idea?.tickers) ? idea.tickers : []))
    .map((ticker) => String(ticker).toUpperCase().trim());
  const demo = context.snapshot.inputs.settings.DEMO_MODE === true;
  const verifyTickers = context.services.verifyCandidateTickers || verifyCandidateTickers;
  const validSet = demo
    ? new Set(allTickers.filter(tickerShapeOk))
    : await verifyTickers(allTickers);
  const normalized = normalizeGeneratorOutputs(
    rawCandidates,
    validSet,
    constraints.existingTitles,
  );
  const workflow = {
    id: context.spec.id,
    version: context.spec.version,
    hash: context.specHash,
  };
  const validIdeas = normalized.valid.map((idea) => ({
    ...idea,
    id: deriveStableIdeaId({
      workflow,
      runId: context.runId,
      snapshotId: context.snapshot.snapshotId,
      candidate: idea,
    }),
    sentence: idea.title,
    ...(demo ? { qualityScore: 50 } : {}),
    sourceAgents: demo
      ? ['demo-idea-agent', 'backfill-idea-agent']
      : ['llm-idea-agent'],
    timeHorizon: 'next 2-4 quarters',
    status: 'new',
  }));
  const shapedTickers = new Set(allTickers.filter(tickerShapeOk));
  return {
    validIdeas,
    rejected: normalized.rejected,
    tickerVerification: {
      requested: [...new Set(allTickers)],
      valid: [...validSet],
      invalid: [...shapedTickers].filter((ticker) => !validSet.has(ticker)),
    },
  };
}

export { hydrate };
