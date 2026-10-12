import assert from 'node:assert/strict';
import test from 'node:test';

import { validateJsonSchema } from '../src/core/validation/OutputGate.js';
import { getResearchSchema } from '../src/domains/research/contracts/schemaRegistry.js';
import {
  assertPointInTimeSafe,
  auditEvidence,
  buildCitationLedger,
  buildDataPlan,
  collectEvidence,
  createDomainEvent,
  createEvidenceItem,
  createSourceDocument,
} from '../src/domains/research/evidence/index.js';

const asOf = '2026-07-16T00:00:00.000Z';

test('versioned SourceDocument, EvidenceItem, and DomainEvent contracts preserve point-in-time fields', () => {
  const source = createSourceDocument({
    provider: 'edgar', uri: 'edgar://filing/1', title: '10-Q', content: 'Revenue was $10B.',
    publishedAt: '2026-07-15T00:00:00.000Z', observedAt: asOf, fetchedAt: asOf,
    mimeType: 'text/plain', entityIds: ['ticker:ACME'], asOfSafe: true,
  });
  const item = createEvidenceItem({
    sourceId: source.sourceId, entityIds: ['ticker:ACME'], statement: 'Revenue was $10B.', value: 10,
    unit: 'USD bn', period: '2026Q2', publishedAt: source.publishedAt, observedAt: asOf,
    locator: { section: 'Income statement' }, evidenceType: 'fact', confidence: 0.95,
  });
  const event = createDomainEvent({
    eventType: 'earnings-release', entityIds: ['ticker:ACME'], occurredAt: source.publishedAt,
    publishedAt: source.publishedAt, observedAt: asOf, evidenceRefs: [item.evidenceId],
    summary: 'ACME released earnings.', significance: 'high', status: 'confirmed',
  });
  assert.deepEqual(validateJsonSchema(source, getResearchSchema('sourceDocument.v1')), []);
  assert.deepEqual(validateJsonSchema(item, getResearchSchema('evidenceItem.v1')), []);
  assert.deepEqual(validateJsonSchema(event, getResearchSchema('domainEvent.v1')), []);
  assert.equal(source.asOfSafe, true);
  assert.equal(item.sourceId, source.sourceId);
  assert.deepEqual(event.evidenceRefs, [item.evidenceId]);
  assert.equal(assertPointInTimeSafe([source, item, event], asOf), true);
});

test('Data Planner emits executable questions, entities, time windows, and source strategies', () => {
  const plan = buildDataPlan({
    brief: 'Assess ACME demand and valuation.', theme: 'AI infrastructure', tickers: ['ACME'], round: 1,
    focus: {}, cfg: { fundamentals: true, transcript: true, research: true },
    autoTools: [{ tool: 'fred_series' }], asOf,
  });
  assert.deepEqual(validateJsonSchema(plan, getResearchSchema('dataPlan.v1')), []);
  assert.equal(plan.entities.some((item) => item.entityId === 'ticker:ACME'), true);
  assert.equal(plan.questions.every((question) => plan.sourceStrategies.some((strategy) => strategy.questionId === question.questionId)), true);
  assert.equal(plan.freshnessPolicy.rejectPublishedAfterAsOf, true);
  assert.ok(plan.expectedArtifacts.includes('data/evidence_bundle_r1.json'));
  assert.ok(plan.expectedArtifacts.includes('data/citation_ledger.json'));
});

test('Data Planner canonicalizes an optional undefined focus rationale', () => {
  const input = {
    brief: 'Assess ACME demand and valuation.',
    theme: 'AI infrastructure',
    tickers: ['ACME'],
    round: 2,
    cfg: { fundamentals: true, transcript: true, research: true },
    autoTools: [{ tool: 'fred_series' }],
    asOf,
  };
  const withoutRationale = buildDataPlan({
    ...input,
    focus: { questions: ['Resolve the key dispute.'], tickers: ['ACME'], tools: ['edgar_filings'] },
  });
  const withUndefinedRationale = buildDataPlan({
    ...input,
    focus: { questions: ['Resolve the key dispute.'], tickers: ['ACME'], tools: ['edgar_filings'], rationale: undefined },
  });
  assert.equal(withUndefinedRationale.inputDigest, withoutRationale.inputDigest);
});

test('Evidence Collector deduplicates atomic evidence and rejects sources published after asOf', () => {
  const plan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], cfg: { fundamentals: true, transcript: true, research: true }, asOf });
  const collection = collectEvidence({ plan, raw: {
    quotes: [{ symbol: 'ACME', price: 100, changesPercentage: 1 }],
    fundamentals: { ACME: { revenueGrowth: 0.2, fwdPE1: 20 } },
    industry: { sector: 'Technology', peerMedianForwardPE: 18 },
    transcripts: [
      { symbol: 'ACME', year: 2026, quarter: 2, date: '2026-07-15', excerpt: 'Demand increased 20%. Demand increased 20%.' },
      { symbol: 'ACME', year: 2026, quarter: 3, date: '2026-07-17', excerpt: 'Future leaked statement.' },
    ],
    research: {
      news: [
        { symbol: 'ACME', title: 'ACME ships product', publishedDate: '2026-07-15', url: 'https://example.invalid/before' },
        { symbol: 'ACME', title: 'Post-cutoff news', publishedDate: '2026-07-17', url: 'https://example.invalid/after' },
      ],
    },
  } });
  assert.equal(collection.sourceDocuments.every((source) => source.publishedAt <= asOf && source.observedAt <= asOf), true);
  assert.equal(collection.sourceDocuments.some((source) => source.content.includes('Future leaked statement')), false);
  assert.equal(collection.sourceDocuments.some((source) => source.title === 'Post-cutoff news'), false);
  assert.equal(collection.excluded.length, 2);
  assert.equal(new Set(collection.evidenceItems.map((item) => item.evidenceId)).size, collection.evidenceItems.length);
  assert.ok(collection.evidenceItems.every((item) => item.sourceId && item.locator.section && item.publishedAt && item.observedAt && item.evidenceType));
  assert.ok(collection.sourceDocuments.find((source) => source.uri === 'fmp://fundamentals/ACME')
    ?.metadata.citationLabels.includes('fmp_fundamentals:ACME'));
  const industryContext = collection.sourceDocuments.find((source) => source.uri === 'fmp://industry/context');
  assert.ok(industryContext?.metadata.citationLabels.includes('fmp_comps'));
  assert.ok(industryContext?.metadata.citationLabels.includes('fmp_peers'));
  assert.ok(industryContext?.metadata.citationLabels.includes('fmp_sector'));
});

test('Citation Ledger exposes unique atomic labels and rejects ambiguous generic aliases', () => {
  const plan = buildDataPlan({ theme: 'Pair', tickers: ['LEFT', 'RIGHT'], cfg: { fundamentals: true }, asOf });
  const collection = collectEvidence({ plan, raw: {
    quotes: [{ symbol: 'LEFT', price: 100 }, { symbol: 'RIGHT', price: 200 }],
    fundamentals: {
      LEFT: { revenueGrowth: 0.1 },
      RIGHT: { revenueGrowth: 0.2 },
    },
  } });
  const ledger = buildCitationLedger({
    round: 1,
    asOf,
    sourceDocuments: collection.sourceDocuments,
    evidenceItems: collection.evidenceItems,
  });

  assert.deepEqual(validateJsonSchema(ledger, getResearchSchema('citationLedger.v1')), []);
  assert.ok(ledger.ambiguousAliases.some((entry) => entry.alias === 'fmp_fundamentals'));
  assert.ok(ledger.ambiguousAliases.some((entry) => entry.alias === 'fmp_quote'));
  assert.ok(ledger.aliases.every((entry) => entry.alias !== 'fmp_fundamentals'));
  assert.ok(ledger.aliases.some((entry) => entry.alias === 'fmp_fundamentals:LEFT'));
  assert.equal(ledger.markerContract.navigationArtifactsAreAtomicEvidence, false);
  assert.ok(ledger.navigationOnlyArtifacts.some((entry) => entry.labels.includes('data_report')));
  assert.ok(ledger.evidenceItems.every((item) => item.marker === `[src: ${item.evidenceId}]`));
});

test('Citation Ledger is order-stable, cross-round cumulative, and content-sensitive', () => {
  const firstPlan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], round: 1, cfg: { fundamentals: true }, asOf });
  const secondPlan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], round: 2, cfg: { fundamentals: true }, asOf });
  const first = collectEvidence({ plan: firstPlan, raw: { fundamentals: { ACME: { revenueGrowth: 0.1 } } } });
  const second = collectEvidence({ plan: secondPlan, raw: { fundamentals: { ACME: { revenueGrowth: 0.2 } } } });
  const sourceDocuments = [...first.sourceDocuments, ...second.sourceDocuments];
  const evidenceItems = [...first.evidenceItems, ...second.evidenceItems];
  const sourceRounds = Object.fromEntries([
    ...first.sourceDocuments.map((source) => [source.sourceId, 1]),
    ...second.sourceDocuments.map((source) => [source.sourceId, 2]),
  ]);
  const cumulative = buildCitationLedger({ round: 2, asOf, sourceDocuments, evidenceItems, sourceRounds });
  const reordered = buildCitationLedger({
    round: 9,
    asOf,
    sourceDocuments: [...sourceDocuments].reverse(),
    evidenceItems: [...evidenceItems].reverse(),
    sourceRounds,
  });

  assert.equal(cumulative.inputDigest, reordered.inputDigest);
  assert.equal(cumulative.sources.length, new Set(sourceDocuments.map((source) => source.sourceId)).size);
  assert.equal(cumulative.evidenceItems.length, new Set(evidenceItems.map((item) => item.evidenceId)).size);
  const latestFundamentals = second.sourceDocuments.find((source) => source.uri === 'fmp://fundamentals/ACME');
  assert.equal(cumulative.aliases.find((entry) => entry.alias === 'fmp_fundamentals')?.sourceId, latestFundamentals.sourceId);

  const renamedLatest = { ...latestFundamentals, title: `${latestFundamentals.title} renamed` };
  const renamed = buildCitationLedger({
    round: 2,
    asOf,
    sourceDocuments: sourceDocuments.map((source) => source.sourceId === latestFundamentals.sourceId ? renamedLatest : source),
    evidenceItems,
    sourceRounds,
  });
  assert.notEqual(renamed.inputDigest, cumulative.inputDigest);
});

test('Citation Ledger normalizes aliases, isolates navigation labels, and fails closed on indistinguishable URI versions', () => {
  const source = ({ uri, title, content, labels }) => createSourceDocument({
    provider: 'fmp', uri, title, content,
    publishedAt: asOf, observedAt: asOf, fetchedAt: asOf,
    entityIds: [], asOfSafe: true, metadata: { citationLabels: labels },
  });
  const left = source({
    uri: 'fmp://fundamentals/LEFT', title: 'LEFT fundamentals', content: 'Left revenue grew 10%.',
    labels: ['Shared Alias', 'data_report'],
  });
  const right = source({
    uri: 'fmp://fundamentals/RIGHT', title: 'RIGHT fundamentals', content: 'Right revenue grew 20%.',
    labels: ['shared   alias'],
  });
  const oldVersion = source({
    uri: 'fmp://fundamentals/TIED', title: 'TIED fundamentals', content: 'Old revenue grew 5%.',
    labels: ['tied fundamentals'],
  });
  const newVersion = source({
    uri: 'fmp://fundamentals/TIED', title: 'TIED fundamentals', content: 'New revenue grew 15%.',
    labels: ['tied fundamentals'],
  });
  const ledger = buildCitationLedger({
    round: 2, asOf, sourceDocuments: [left, right, oldVersion, newVersion], evidenceItems: [],
  });
  const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
  const shared = ledger.ambiguousAliases.find((entry) => normalize(entry.alias) === 'shared alias');
  const tied = ledger.ambiguousAliases.find((entry) => normalize(entry.alias) === 'tied fundamentals');

  assert.deepEqual(shared.sourceIds, [left.sourceId, right.sourceId].sort());
  assert.deepEqual(tied.sourceIds, [oldVersion.sourceId, newVersion.sourceId].sort());
  assert.equal(ledger.aliases.some((entry) => normalize(entry.alias) === 'shared alias'), false);
  assert.equal(ledger.aliases.some((entry) => normalize(entry.alias) === 'data_report'), false);

  const latest = buildCitationLedger({
    round: 2,
    asOf,
    sourceDocuments: [oldVersion, newVersion],
    evidenceItems: [],
    sourceRounds: { [oldVersion.sourceId]: 1, [newVersion.sourceId]: 2 },
  });
  assert.equal(latest.aliases.find((entry) => normalize(entry.alias) === 'tied fundamentals')?.sourceId, newVersion.sourceId);
  assert.equal(latest.ambiguousAliases.some((entry) => normalize(entry.alias) === 'tied fundamentals'), false);
});

test('Evidence Auditor classifies every material claim as supported, estimate, or open issue', () => {
  const plan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], cfg: { fundamentals: true, transcript: false, research: false }, asOf });
  const collection = collectEvidence({ plan, raw: {
    quotes: [{ symbol: 'ACME', price: 100 }],
    fundamentals: { ACME: { revenueGrowth: 0.2, fwdPE1: 20 } },
  } });
  const audited = auditEvidence({ plan, collection, organizedOutput: {
    organized: [{ dimension: 'valuation', points: [
      { fact: 'ACME price = 100', ticker: 'ACME', source: 'FMP行情', type: 'fact' },
      { fact: 'Fair value could be 140', ticker: 'ACME', source: 'analyst judgment', type: 'estimate' },
      { fact: 'A private competitor has 80% share', ticker: 'ACME', source: 'unknown', type: 'fact' },
    ] }],
    gaps: [], contradictions: [], nextDataFocus: { questions: [], tickers: [], tools: [] },
  } });
  assert.deepEqual(validateJsonSchema(audited.bundle, getResearchSchema('evidenceBundle.v1')), []);
  assert.equal(audited.bundle.claimAudit.materialClaims, 3);
  assert.equal(audited.bundle.claimAudit.classifiedClaims, 3);
  assert.equal(audited.bundle.claimAudit.classificationRate, 1);
  assert.deepEqual(audited.organized[0].points.map((point) => point.claimStatus), ['supported', 'estimate', 'open-issue']);
  assert.equal(audited.organized[0].points[0].evidenceRefs.length > 0, true);
  assert.equal(audited.openIssues.length, 1);
});

test('Evidence Auditor never upgrades demo or opinion evidence into factual support', () => {
  const plan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], cfg: { fundamentals: true }, asOf });
  const collection = collectEvidence({ plan, raw: {
    quotes: [{ symbol: 'ACME', price: 100, _demo: true }],
    research: { finance: { answer: 'ACME may reach 140 based on an analyst scenario.', _demo: true } },
  } });
  const audited = auditEvidence({ plan, collection, organizedOutput: {
    organized: [{ dimension: 'valuation', points: [
      { fact: 'ACME price = 100', ticker: 'ACME', source: 'demo FMP quote', type: 'fact' },
      { fact: 'ACME may reach 140', ticker: 'ACME', source: 'analyst opinion', type: 'estimate' },
    ] }],
    gaps: [], contradictions: [], nextDataFocus: { questions: [], tickers: [], tools: [] },
  } });
  assert.deepEqual(audited.organized[0].points.map((point) => point.claimStatus), ['estimate', 'estimate']);
  assert.equal(audited.bundle.claimAudit.supportedClaims, 0);
  assert.equal(audited.bundle.claimAudit.estimateClaims, 2);
  assert.equal(audited.bundle.coverage.score, 0);
  assert.ok(audited.bundle.coverage.questions.some((question) => question.status === 'estimate-only'));
  assert.ok(audited.bundle.gaps.some((gap) => gap.includes('demo/estimate')));
});

test('Evidence Auditor deterministically salvages EvidenceItems when the Data Agent produces no claims', () => {
  const plan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], cfg: { fundamentals: true }, asOf });
  const collection = collectEvidence({ plan, raw: {
    quotes: [{ symbol: 'ACME', price: 100 }],
    fundamentals: { ACME: { revenueGrowth: 0.2 } },
  } });
  const audited = auditEvidence({ plan, collection, organizedOutput: {
    organized: [], gaps: [], contradictions: [], nextDataFocus: { questions: [], tickers: [], tools: [] },
  } });

  assert.ok(audited.bundle.claimAudit.materialClaims > 0);
  assert.equal(audited.bundle.claimAudit.classificationRate, 1);
  assert.ok(audited.organized[0].points.every((point) => point.evidenceRefs.length > 0));
  assert.ok(audited.bundle.gaps.some((gap) => gap.includes('deterministic EvidenceItems')));
  assert.ok(audited.openIssues.some((issue) => issue.severity === 'warning' && issue.owner === 'data'));
});

test('Evidence Auditor fails claim-level coverage closed when neither Agent claims nor EvidenceItems exist', () => {
  const plan = buildDataPlan({ theme: 'ACME', tickers: ['ACME'], cfg: { fundamentals: false, research: false }, asOf });
  const collection = collectEvidence({ plan, raw: {} });
  const audited = auditEvidence({ plan, collection, organizedOutput: {
    organized: [], gaps: [], contradictions: [], nextDataFocus: { questions: [], tickers: [], tools: [] },
  } });

  assert.equal(audited.bundle.claimAudit.materialClaims, 0);
  assert.equal(audited.bundle.claimAudit.classificationRate, 0);
  assert.equal(audited.bundle.claimAudit.citationCoverage, 0);
  assert.equal(audited.bundle.coverage.score, 0);
  assert.ok(audited.bundle.coverage.questions.every((question) => question.status === 'unassessed-no-material-claims'));
  assert.ok(audited.bundle.gaps.some((gap) => gap.includes('claim-level traceability cannot pass')));
  assert.ok(audited.openIssues.some((issue) => issue.severity === 'critical' && issue.owner === 'data'));
});
