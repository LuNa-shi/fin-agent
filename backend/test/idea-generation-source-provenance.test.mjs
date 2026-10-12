import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalSha256 } from '../src/core/contracts/ArtifactRef.js';
import { execute as collectMarketContext } from '../src/workflows/idea-generation/handlers/collectMarketContext.js';
import { gatherMarketContext } from '../src/workflows/idea-generation/nodes/marketContext.js';
import {
  collectNewsIdeas,
  runSourceDiscoveryNodes,
} from '../src/workflows/idea-generation/nodes/sourceDiscovery.js';
import {
  bindSourceCallProvenance,
  captureSourceCall,
} from '../src/workflows/idea-generation/nodes/sourceProvenance.js';

const AS_OF = '2026-07-23T08:00:00.000Z';
const SNAPSHOT_ID = `idea-run-input-snapshot:${'a'.repeat(64)}`;
const fixedNow = () => '2026-07-23T08:00:05.000Z';

function rejectedSourceError() {
  const error = new Error(
    'request to https://private.example/v1 failed with key sk-do-not-persist',
  );
  error.code = 'ECONNRESET';
  return error;
}

test('source-call provenance keeps only redacted metadata, timestamps, and digests', async () => {
  const success = await captureSourceCall({
    callId: 'fixture.news',
    source: 'fixture-news',
    provider: 'fixture-provider',
    args: {
      query: 'grid equipment',
      limit: 10,
      endpoint: 'https://private.example/v1',
      apiKey: 'sk-do-not-persist',
    },
    execute: async () => ({
      items: [{
        title: 'Grid equipment orders',
        observedAt: '2026-07-23T07:59:00.000Z',
        publishedDate: '2026-07-22T18:30:00.000Z',
      }],
    }),
    fallback: () => ({ items: [] }),
    normalize: (value) => value.items.map((item) => item.title),
    now: fixedNow,
  });
  assert.equal(success.provenance.status, 'succeeded');
  assert.equal(success.provenance.error, null);
  assert.equal(success.provenance.query, 'grid equipment');
  assert.equal(success.provenance.observedAt, '2026-07-23T07:59:00.000Z');
  assert.equal(success.provenance.publishedAt, '2026-07-22T18:30:00.000Z');
  assert.equal(success.provenance.fetchedAt, fixedNow());
  assert.equal(success.provenance.rawDigest, canonicalSha256(success.value));
  assert.equal(
    success.provenance.normalizedDigest,
    canonicalSha256(['Grid equipment orders']),
  );

  const failure = await captureSourceCall({
    callId: 'fixture.failure',
    source: 'fixture-source',
    provider: 'fixture-provider',
    args: {
      query: 'Bearer do-not-persist',
      authorization: 'Bearer do-not-persist',
    },
    execute: async () => {
      throw rejectedSourceError();
    },
    fallback: () => ({ items: [] }),
    now: fixedNow,
  });
  assert.deepEqual(failure.value, { items: [] });
  assert.equal(failure.provenance.status, 'failed');
  assert.deepEqual(failure.provenance.error, {
    category: 'source-call-failed',
    code: 'ECONNRESET',
  });
  assert.equal(failure.provenance.query, null);
  const synchronousFailure = await captureSourceCall({
    callId: 'fixture.synchronous-failure',
    source: 'fixture-source',
    provider: 'fixture-provider',
    execute: () => {
      throw rejectedSourceError();
    },
    fallback: () => ({ items: [] }),
    now: fixedNow,
  });
  assert.deepEqual(synchronousFailure.value, { items: [] });
  assert.equal(synchronousFailure.provenance.status, 'failed');
  assert.equal(synchronousFailure.provenance.error.code, 'ECONNRESET');
  const reportedFailure = await captureSourceCall({
    callId: 'fixture.reported-failure',
    source: 'fixture-source',
    provider: 'fixture-provider',
    execute: async () => [{
      error: 'https://private.example/v1 sk-do-not-persist',
    }],
    fallback: () => [],
    now: fixedNow,
  });
  assert.equal(reportedFailure.provenance.status, 'failed');
  assert.deepEqual(reportedFailure.provenance.error, {
    category: 'source-call-failed',
    code: 'SOURCE_REPORTED_ERROR',
  });

  const [bound] = bindSourceCallProvenance([{
    ...failure.provenance,
    rawPayload: { apiKey: 'sk-do-not-persist' },
    error: {
      ...failure.provenance.error,
      message: 'https://private.example/v1 sk-do-not-persist',
    },
  }], {
    runId: 'idea_run_source_provenance',
    nodeId: 'collect-market-context',
    snapshotId: SNAPSHOT_ID,
    asOf: AS_OF,
  });
  assert.equal(bound.runId, 'idea_run_source_provenance');
  assert.equal(bound.nodeId, 'collect-market-context');
  assert.equal(Object.hasOwn(bound, 'rawPayload'), false);
  const serialized = JSON.stringify([
    success.provenance,
    reportedFailure.provenance,
    bound,
  ]);
  assert.doesNotMatch(serialized, /private\.example|sk-do-not-persist|Bearer/u);
});

test('market and news provenance is additive without changing source content or fallbacks', async () => {
  const sourceFunctions = {
    getSectorPerformance: async () => {
      throw rejectedSourceError();
    },
    getMarketMovers: async () => ({
      movers: [{
        symbol: 'GEV',
        name: 'GE Vernova',
        changePct: 4.2,
      }],
    }),
    getNews: async () => [{
      symbol: 'GEV',
      title: 'Grid orders accelerate',
      site: 'Fixture Wire',
      publishedDate: '2026-07-22T18:30:00.000Z',
    }],
    researchDigest: async () => ({
      items: [{
        source: 'Fixture Research',
        title: 'Transformer backlog',
        summary: 'Backlog remains elevated.',
        tickers: ['GEV'],
        url: 'https://public.example/research',
        publishedAt: '2026-07-21T10:00:00.000Z',
      }],
      sourcesUsed: ['Fixture Research'],
      domainsUsed: ['industrials'],
    }),
    saAssembleIdeas: async () => ({
      ideas: [{ ticker: 'GEV', title: 'Grid capex', source: 'Fixture SA' }],
    }),
  };

  const marketWithout = await gatherMarketContext({
    sourceFunctions,
    now: fixedNow,
  });
  const marketWith = await gatherMarketContext({
    captureProvenance: true,
    sourceFunctions,
    now: fixedNow,
  });
  const {
    provenance: marketProvenance,
    ...marketContent
  } = marketWith;
  assert.deepEqual(marketContent, marketWithout);
  assert.equal(marketProvenance.length, 4);
  assert.equal(marketProvenance[0].status, 'failed');
  assert.equal(marketProvenance[0].error.code, 'ECONNRESET');
  assert.equal(
    marketProvenance.find((call) => call.callId === 'market-context.news').publishedAt,
    '2026-07-22T18:30:00.000Z',
  );

  const newsWithout = await collectNewsIdeas({
    target: 8,
    sourceFunctions,
    now: fixedNow,
  });
  const newsWith = await collectNewsIdeas({
    target: 8,
    captureProvenance: true,
    sourceFunctions,
    now: fixedNow,
  });
  const {
    provenance: newsProvenance,
    ...newsContent
  } = newsWith;
  assert.deepEqual(newsContent, newsWithout);
  assert.equal(newsProvenance.length, 3);
  assert.equal(newsProvenance[0].status, 'failed');
  assert.ok(newsProvenance.every((call) => /^sha256:[a-f0-9]{64}$/u.test(call.rawDigest)));
  assert.doesNotMatch(
    JSON.stringify([...marketProvenance, ...newsProvenance]),
    /private\.example|sk-do-not-persist/u,
  );
});

test('source-node aggregation redacts Promise.allSettled failure prose', async () => {
  let clockCalls = 0;
  const result = await runSourceDiscoveryNodes({
    captureProvenance: true,
    now: () => {
      clockCalls += 1;
      if (clockCalls === 1) throw rejectedSourceError();
      return fixedNow();
    },
    sourceFunctions: {
      getSectorPerformance: async () => ({ sectors: [] }),
      getMarketMovers: async () => ({ movers: [] }),
      getNews: async () => [],
      socialSentiment: async () => null,
      xSearch: async () => ({ items: [] }),
      saLatest: async () => ({ items: [] }),
      researchDigest: async () => ({ items: [] }),
    },
  });
  const failed = result.runs.find((run) => run.agent === 'news-idea-agent');
  assert.deepEqual(failed.error, {
    category: 'source-call-failed',
    code: 'ECONNRESET',
  });
  assert.equal(failed.provenance[0].status, 'failed');
  const xCall = result.runs
    .flatMap((run) => run.provenance || [])
    .find((call) => call.callId === 'forum-source.x-search');
  assert.equal(xCall.query, 'stocks earnings catalyst retail sentiment');
  assert.doesNotMatch(
    JSON.stringify(failed),
    /private\.example|sk-do-not-persist/u,
  );
});

test('collect-market-context publishes identity-bound calls separately from generator content', async () => {
  const marketCall = await captureSourceCall({
    callId: 'fixture.market',
    source: 'fixture-market',
    provider: 'fixture',
    args: { query: 'market' },
    execute: async () => ({ items: [] }),
    fallback: () => ({ items: [] }),
    now: fixedNow,
  });
  const discoveryCall = await captureSourceCall({
    callId: 'fixture.discovery',
    source: 'fixture-discovery',
    provider: 'fixture',
    args: { query: 'ideas' },
    execute: async () => {
      throw rejectedSourceError();
    },
    fallback: () => [],
    now: fixedNow,
  });
  const market = {
    top: [],
    bottom: [],
    headlines: [],
    sectorTable: [],
    research: [],
    saIdeas: [],
    sourcesUsed: [],
    domainsUsed: [],
    hasData: false,
    provenance: [marketCall.provenance],
  };
  const sourceResult = {
    agent: 'news-idea-agent',
    ideas: [],
    count: 0,
    error: 'https://private.example/v1 sk-do-not-persist',
    provenance: [discoveryCall.provenance],
  };
  const result = await collectMarketContext({
    snapshot: {
      runId: 'idea_run_source_provenance',
      snapshotId: SNAPSHOT_ID,
      asOf: AS_OF,
      inputs: {
        existingIdeas: [],
        positions: [],
        settings: { DEMO_MODE: false },
        command: { count: 1, targetPerNode: 8 },
      },
    },
    services: {
      sourceNow: fixedNow,
      gatherMarketContext: async () => market,
      runSourceDiscoveryNodes: async () => ({
        runs: [sourceResult],
        ideas: [],
      }),
    },
  });

  assert.deepEqual(result.market, {
    top: [],
    bottom: [],
    headlines: [],
    sectorTable: [],
    research: [],
    saIdeas: [],
    sourcesUsed: [],
    domainsUsed: [],
    hasData: false,
  });
  assert.equal(Object.hasOwn(result.sourceRuns[0], 'provenance'), false);
  assert.equal(result.sourceRuns[0].status, 'failed');
  assert.deepEqual(result.sourceRuns[0].error, {
    category: 'source-call-failed',
    code: 'SOURCE_CALL_FAILED',
  });
  assert.equal(
    result.sourceRuns[0].resultDigest,
    canonicalSha256({
      agent: 'news-idea-agent',
      ideas: [],
      count: 0,
      error: {
        category: 'source-call-failed',
        code: 'SOURCE_CALL_FAILED',
      },
    }),
  );
  assert.equal(result.sourceCalls.length, 2);
  assert.ok(result.sourceCalls.every((call) => (
    call.runId === 'idea_run_source_provenance'
    && call.nodeId === 'collect-market-context'
    && call.snapshotId === SNAPSHOT_ID
    && call.asOf === AS_OF
  )));
  assert.doesNotMatch(
    JSON.stringify(result.sourceCalls),
    /private\.example|sk-do-not-persist/u,
  );
});
