import { canonicalSha256 } from '../../../core/contracts/ArtifactRef.js';
import { gatherMarketContext } from '../nodes/marketContext.js';
import {
  runSourceDiscoveryNodes,
  selectSourceCandidates,
} from '../nodes/sourceDiscovery.js';
import {
  bindSourceCallProvenance,
  redactSourceError,
} from '../nodes/sourceProvenance.js';
import { hydrate, jsonSnapshot } from './shared.js';

function demoMarketContext() {
  return {
    top: [],
    bottom: [],
    headlines: [],
    sectorTable: [],
    research: [],
    saIdeas: [],
    sourcesUsed: ['demo'],
    domainsUsed: [],
    hasData: false,
    demoMode: true,
  };
}

function demoSourceRun() {
  return {
    runs: [
      'news-idea-agent',
      'forum-idea-agent',
      'portfolio-idea-agent',
      'research-idea-agent',
    ].map((sourceId) => ({ agent: sourceId, ideas: [], demo: true })),
    ideas: [],
  };
}

export async function execute(context) {
  const { snapshot } = context;
  const allIdeas = snapshot.inputs.existingIdeas;
  const portfolio = snapshot.inputs.positions;
  const targetPerNode = snapshot.inputs.command.targetPerNode;
  const existingTitles = allIdeas.slice(0, 40).map((idea) => idea.title);
  const currentTickers = [...new Set([
    ...portfolio.map((position) => position.ticker),
    ...allIdeas.flatMap((idea) => idea.tickers || []),
  ].filter(Boolean))].slice(0, 12);
  const demo = snapshot.inputs.settings.DEMO_MODE === true;
  const collectMarket = context.services.gatherMarketContext || gatherMarketContext;
  const discoverSources = context.services.runSourceDiscoveryNodes || runSourceDiscoveryNodes;
  const sourceNow = context.services.sourceNow || (() => new Date().toISOString());
  const marketResult = demo
    ? demoMarketContext()
    : await collectMarket({
        captureProvenance: true,
        now: sourceNow,
      });
  const {
    provenance: marketProvenance = [],
    ...market
  } = jsonSnapshot(marketResult, {});
  const sourceRun = demo
    ? demoSourceRun()
    : await discoverSources({
        tickers: currentTickers,
        portfolio,
        targetPerNode,
        captureProvenance: true,
        now: sourceNow,
      });
  const sourceCandidates = selectSourceCandidates(
    sourceRun.ideas,
    existingTitles,
    Math.max(snapshot.inputs.command.count, 20),
  );
  const sourceProvenance = [...marketProvenance];
  const sourceRuns = sourceRun.runs.map((run) => {
    const captured = jsonSnapshot(run, {});
    const {
      provenance = [],
      ...sourceResult
    } = captured;
    sourceProvenance.push(...provenance);
    const failed = Boolean(run.error);
    const redactedSourceResult = failed
      ? { ...sourceResult, error: redactSourceError(run.error) }
      : sourceResult;
    return {
      ...redactedSourceResult,
      sourceId: run.agent,
      status: failed ? 'failed' : 'succeeded',
      resultDigest: canonicalSha256(redactedSourceResult),
      runId: snapshot.runId,
      nodeId: 'collect-market-context',
      snapshotId: snapshot.snapshotId,
      asOf: snapshot.asOf,
    };
  });
  const sourceCalls = bindSourceCallProvenance(sourceProvenance, {
    runId: snapshot.runId,
    nodeId: 'collect-market-context',
    snapshotId: snapshot.snapshotId,
    asOf: snapshot.asOf,
  });
  return {
    market: jsonSnapshot(market, {}),
    currentTickers,
    sourceRuns,
    sourceCalls,
    sourceCandidates: jsonSnapshot(sourceCandidates, []),
    sourceCandidateDigest: canonicalSha256(sourceCandidates),
  };
}

export { hydrate };
