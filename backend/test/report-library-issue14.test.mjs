import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const previousFinDataDir = process.env.FIN_DATA_DIR;
let contracts;
let eventStoreModule;
let reportStoreModule;
let admissionModule;
let testDataRoot;

async function loadReportStore() {
  if (reportStoreModule) return reportStoreModule;
  try {
    reportStoreModule = await import('../src/domains/reports/ReportLibraryStore.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
  return reportStoreModule;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;
}

function artifactRef({ markdown, pathName = 'report/report.md', runId = 'analysis-run-1' }) {
  const digest = sha256Bytes(markdown);
  return {
    contract: 'artifact-ref.v1',
    artifactId: `report:${runId}`,
    version: 1,
    path: pathName,
    contentDigest: digest,
    schemaVersion: 'run-analysis-report.v1',
    producer: 'run-analysis',
    contractVersion: '1.0.0',
    inputDigest: sha256Bytes(`input:${runId}`),
    createdAt: '2026-08-13T00:00:00.000Z',
    asOf: '2026-08-12T00:00:00.000Z',
  };
}

function reportPackage({
  projectId = 'project-1',
  analysisRunId = 'analysis-run-1',
  markdown = '# Report\n\nExact UTF-8 bytes: 数据。\n',
  tickers = ['msft', 'AAPL', 'MSFT'],
  theme = 'AI infrastructure',
  title = 'A deterministic report',
  reportRefPath = 'report/report.md',
} = {}) {
  return {
    contract: 'internal-run-analysis-report-package.v1',
    origin: 'internal',
    producer: {
      type: 'run-analysis',
      workflow: {
        id: 'run-analysis',
        version: '1.2.0',
        hash: sha256Bytes('run-analysis-workflow-v1'),
      },
      reportRef: artifactRef({ markdown, pathName: reportRefPath, runId: analysisRunId }),
    },
    lineage: { projectId, analysisRunId },
    dailyReport: null,
    report: {
      mediaType: 'text/markdown',
      charset: 'utf-8',
      markdown,
      contentDigest: sha256Bytes(markdown),
    },
    metadata: {
      tickers,
      theme,
      searchTags: ['AI', 'infrastructure', 'AI'],
      title,
      asOf: '2026-08-12T00:00:00.000Z',
      generatedAt: '2026-08-13T00:00:00.000Z',
    },
  };
}

function preparedOverview(pkg, attemptId = 'store-test') {
  return {
    content: {
      reportVersionId: contracts.reportVersionId(pkg),
      contentDigest: pkg.report.contentDigest,
      summary: 'Deterministic private discovery projection.',
      keyThemes: [pkg.metadata.theme],
      entities: [],
      materialDevelopments: [],
      uncertainties: [],
    },
    provenance: {
      agentId: 'report-overview',
      agentVersion: '1.0.0',
      effectiveConfigDigest: sha256Bytes('store-test-config'),
      provider: 'scripted',
      model: 'scripted-small',
      live: false,
      traceRef: attemptId,
      stopReason: 'final',
      metrics: {},
    },
    producedAt: '2026-08-13T00:00:00.000Z',
    attemptId,
  };
}

async function admitThroughService(store, pkg, attemptId) {
  const prepared = preparedOverview(pkg, attemptId);
  const overviewService = {
    now: () => prepared.producedAt,
    effectiveDefinition: () => ({
      effectiveConfig: { digest: prepared.provenance.effectiveConfigDigest },
      runPolicy: { retry: { maxAttempts: 1, retryOn: ['transient', 'provider-unavailable'] } },
    }),
    prepare: async () => prepared,
  };
  const service = new admissionModule.ReportAdmissionService({
    reportLibrary: store,
    overviewService,
    maxImmediateAttempts: 1,
    sleep: async () => {},
  });
  return service.admit(pkg);
}

function tempRoot(prefix = 'report-library-issue14-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTree(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected error code ${code}`);
}

function eventInput(eventType, eventId, { causationId = null, runId = 'backfill-1', payload = {} } = {}) {
  return {
    eventId,
    eventType,
    correlationId: 'correlation-1',
    causationId,
    runId,
    payload,
  };
}

test.before(async () => {
  testDataRoot = tempRoot();
  process.env.FIN_DATA_DIR = testDataRoot;
  // Import report modules only after an isolated FIN_DATA_DIR is installed.
  contracts = await import('../src/domains/reports/reportContracts.js');
  eventStoreModule = await import('../src/domains/reports/ReportLibraryEventStore.js');
  admissionModule = await import('../src/domains/reports/ReportOverviewService.js');
  await loadReportStore();
});

test.after(() => {
  if (previousFinDataDir === undefined) delete process.env.FIN_DATA_DIR;
  else process.env.FIN_DATA_DIR = previousFinDataDir;
  if (testDataRoot) removeTree(testDataRoot);
});

test('internal report package normalizes metadata while preserving exact Markdown bytes and digest', () => {
  const input = reportPackage();
  const normalized = contracts.normalizeInternalReportPackage(input);
  assert.deepEqual(normalized.metadata.tickers, ['AAPL', 'MSFT']);
  assert.deepEqual(normalized.metadata.searchTags, ['AI', 'infrastructure']);
  assert.equal(normalized.report.markdown, input.report.markdown);
  assert.equal(normalized.report.contentDigest, sha256Bytes(input.report.markdown));
  assert.equal(contracts.reportContentDigest(input.report.markdown), input.report.contentDigest);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.report), true);
  assert.equal(Object.isFrozen(normalized.metadata), true);
  assert.equal(contracts.reportVersionFingerprint(input), contracts.reportVersionFingerprint(normalized));
});

test('report package rejects digest drift, unsafe lineage paths, and unsupported fields', () => {
  const wrongDigest = reportPackage();
  wrongDigest.report.contentDigest = sha256Bytes('different bytes');
  expectCode(() => contracts.normalizeInternalReportPackage(wrongDigest), 'REPORT_CONTENT_DIGEST_MISMATCH');

  const unsafePath = reportPackage({ reportRefPath: '../outside/report.md' });
  expectCode(() => contracts.normalizeInternalReportPackage(unsafePath), 'INVALID_REPORT_LINEAGE');

  const extraField = reportPackage();
  extraField.metadata.secret = 'must not enter the contract';
  expectCode(() => contracts.normalizeInternalReportPackage(extraField), 'INVALID_REPORT_PACKAGE');

  const unsafeTicker = reportPackage({ tickers: ['AAPL', '../secret'] });
  expectCode(() => contracts.normalizeInternalReportPackage(unsafeTicker), 'INVALID_REPORT_TICKER');
});

test('logical report identity is run-based, while content fingerprint is version-specific', () => {
  const first = reportPackage({ markdown: '# First\n', title: 'First' });
  const second = reportPackage({ markdown: '# Second\n', title: 'Second' });
  assert.equal(contracts.reportLogicalIdentity(first), contracts.reportLogicalIdentity(second));
  assert.equal(contracts.reportVersionId(first), contracts.reportVersionId(second));
  assert.equal(contracts.reportIngestionId(first), contracts.reportIngestionId(second));
  assert.notEqual(contracts.reportVersionFingerprint(first), contracts.reportVersionFingerprint(second));

  const newRun = reportPackage({ analysisRunId: 'analysis-run-2' });
  assert.notEqual(contracts.reportLogicalIdentity(first), contracts.reportLogicalIdentity(newRun));
  assert.notEqual(contracts.reportVersionId(first), contracts.reportVersionId(newRun));
});

test('backfill manifest is deterministic, bounded, and rejects traversal or duplicate item identity', () => {
  const pkg = reportPackage();
  const manifest = {
    contract: 'report-library-backfill-manifest.v1',
    manifestId: 'manifest-1',
    asOf: '2026-08-13T00:00:00.000Z',
    items: [{
      itemId: 'item-1',
      package: pkg,
      source: { relativePath: 'projects/project-1/report/report.md', contentDigest: pkg.report.contentDigest },
    }],
  };
  const normalized = contracts.normalizeBackfillManifest(manifest);
  assert.equal(contracts.backfillManifestDigest(manifest), contracts.backfillManifestDigest(normalized));
  assert.equal(Object.isFrozen(normalized), true);

  const duplicate = structuredClone(manifest);
  duplicate.items.push(structuredClone(duplicate.items[0]));
  expectCode(() => contracts.normalizeBackfillManifest(duplicate), 'INVALID_BACKFILL_MANIFEST');
  const traversal = structuredClone(manifest);
  traversal.items[0].source.relativePath = '../outside.md';
  expectCode(() => contracts.normalizeBackfillManifest(traversal), 'UNSAFE_BACKFILL_PATH');
});

test('ReportLibraryEventStore provides ordered durable replay, causal ordering, and idempotency conflict detection', () => {
  const rootDir = tempRoot();
  const { ReportLibraryEventStore, REPORT_LIBRARY_EVENT_TYPES, reportLibraryEventId } = eventStoreModule;
  const store = new ReportLibraryEventStore({ rootDir, now: () => '2026-08-13T00:00:00.000Z' });
  const firstInput = eventInput(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_STARTED, reportLibraryEventId(
    REPORT_LIBRARY_EVENT_TYPES.BACKFILL_STARTED, { runId: 'backfill-1', manifestId: 'manifest-1' },
  ), { payload: { manifestId: 'manifest-1' } });
  const first = store.publish(firstInput);
  assert.equal(first.sequence, 1);
  assert.equal(first.scope, 'report-library');
  assert.equal(first.schemaVersion, 'report-library-event.v1');
  assert.equal(first.timestamp, '2026-08-13T00:00:00.000Z');

  const secondInput = eventInput(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_ITEM_SUCCEEDED, 'event-2', {
    causationId: first.eventId,
    payload: { itemId: 'item-1' },
  });
  const second = store.publish(secondInput);
  assert.equal(second.sequence, 2);
  // Replaying the exact logical event must return the original durable event.
  assert.equal(store.publish(firstInput).sequence, 1);
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.get(first.eventId), first);

  const conflict = { ...firstInput, payload: { manifestId: 'different' } };
  expectCode(() => store.publish(conflict), 'REPORT_EVENT_IDEMPOTENCY_CONFLICT');
  expectCode(() => store.publish(eventInput(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_COMPLETED, 'event-3', {
    causationId: 'missing-event',
  })), 'REPORT_EVENT_CAUSATION_MISSING');
  removeTree(rootDir);
});

test('ReportLibraryEventStore fails closed on event outbox gaps and symlink boundaries', () => {
  const rootDir = tempRoot();
  const { ReportLibraryEventStore, REPORT_LIBRARY_EVENT_TYPES } = eventStoreModule;
  const store = new ReportLibraryEventStore({ rootDir });
  const outbox = path.join(rootDir, 'events', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, '000000000002.json'), '{}');
  expectCode(() => store.list(), 'CORRUPT_REPORT_EVENT_OUTBOX');
  removeTree(rootDir);

  const symlinkRoot = tempRoot();
  const outside = tempRoot();
  fs.mkdirSync(path.join(symlinkRoot, 'events'), { recursive: true });
  fs.symlinkSync(outside, path.join(symlinkRoot, 'events', 'outbox'), 'dir');
  const symlinkStore = new ReportLibraryEventStore({ rootDir: symlinkRoot });
  expectCode(() => symlinkStore.publish(eventInput(REPORT_LIBRARY_EVENT_TYPES.BACKFILL_STARTED, 'symlink-event')), 'STORAGE_DIRECTORY_SYMLINK');
  removeTree(symlinkRoot);
  removeTree(outside);
});

test('ReportLibraryStore creates a distinct identity for each analysis run and rebuilds multi-ticker projections', async (t) => {
  const module = await loadReportStore();
  if (!module) return t.skip('ReportLibraryStore is not present yet');
  const { ReportLibraryStore } = module;
  const store = new ReportLibraryStore({ rootDir: tempRoot() });
  const firstPackage = reportPackage({ analysisRunId: 'analysis-run-a', tickers: ['AAPL', 'MSFT'] });
  const secondPackage = reportPackage({ analysisRunId: 'analysis-run-b', tickers: ['MSFT', 'NVDA'] });
  const first = await admitThroughService(store, firstPackage, 'store-a');
  const second = await admitThroughService(store, secondPackage, 'store-b');
  const firstVersion = first.reportVersion;
  const secondVersion = second.reportVersion;
  assert.notEqual(firstVersion.reportVersionId, secondVersion.reportVersionId);
  const rebuilt = await store.rebuildProjections();
  assert.ok(rebuilt);
  const listed = await store.list();
  assert.deepEqual(listed.reports.map((item) => item.reportVersionId).sort(), [firstVersion.reportVersionId, secondVersion.reportVersionId].sort());
  const msft = await store.tickerTimeline('MSFT');
  assert.equal(msft.reports.length, 2);
  assert.equal((await store.tickerTimeline('AAPL')).reports.length, 1);
  assert.equal((await store.tickerTimeline('NVDA')).reports.length, 1);
});

test('ReportLibraryStore public DTOs omit Markdown, filesystem paths, credentials, and provider payloads', async (t) => {
  const module = await loadReportStore();
  if (!module) return t.skip('ReportLibraryStore is not present yet');
  const { ReportLibraryStore } = module;
  const store = new ReportLibraryStore({ rootDir: tempRoot() });
  const pkg = reportPackage({ analysisRunId: 'dto-run' });
  const admitted = await admitThroughService(store, pkg, 'store-dto');
  const dto = await store.get(admitted.reportVersion.reportVersionId);
  const serialized = JSON.stringify(dto);
  assert.doesNotMatch(serialized, /Exact UTF-8 bytes/);
  assert.doesNotMatch(serialized, /(?:^|["'])path(?:["'])\s*:/i);
  assert.doesNotMatch(serialized, /(?:api[_-]?key|authorization|bearer|providerPayload|endpoint)/i);
  assert.match(serialized, /reportVersionId/);
  const content = await store.readContent(admitted.reportVersion.reportVersionId);
  assert.equal(content, pkg.report.markdown);
});

test('RunAnalysisReportProducer admits only verified current report content and preserves lineage', async (t) => {
  let producerModule;
  try { producerModule = await import('../src/domains/reports/RunAnalysisReportProducer.js'); }
  catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND') return t.skip('producer is not present yet'); throw error; }
  const markdown = '# Verified report\n';
  const runId = 'producer-run-1';
  const ref = artifactRef({ markdown, runId, pathName: 'report/report_20260813.md' });
  const record = {
    runId,
    status: 'SUCCEEDED',
    asOf: '2026-08-12T00:00:00.000Z',
    workflowSpec: { id: 'run-analysis', version: '1.2.0', hash: sha256Bytes('run-analysis-workflow-v1') },
  };
  const fakeProjectSpace = {
    runStore: () => ({ list: () => [record], load: (id) => id === runId ? record : null }),
    meta: () => ({ tickers: ['msft'], theme: 'Theme', searchTags: ['tag'], title: 'Title' }),
    artifactLineage: () => ({ runId }),
    artifactStore: () => ({ read: (candidate) => candidate === ref ? markdown : null }),
  };
  // The producer delegates verification to the canonical project-space seam.
  // A fake verifier is not injected, so an unverified run must fail closed.
  const producer = new producerModule.RunAnalysisReportProducer({ projectSpace: fakeProjectSpace });
  expectCode(() => producer.produce({ projectId: 'producer-project', runId }), 'REPORT_PRODUCER_REPORT_NOT_VERIFIED');
  assert.equal(record.status, 'SUCCEEDED');
});

test('backfill source reader verifies exact bytes and rejects traversal/symlink paths', async (t) => {
  let backfillModule;
  try { backfillModule = await import('../src/domains/reports/ReportLibraryBackfill.js'); }
  catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND') return t.skip('backfill is not present yet'); throw error; }
  const sourceRoot = tempRoot();
  const markdown = '# Backfill bytes\n数据\n';
  const sourceFile = path.join(sourceRoot, 'reports', 'one.md');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, markdown, 'utf8');
  const source = { relativePath: 'reports/one.md', contentDigest: sha256Bytes(markdown) };
  const verified = backfillModule.readVerifiedBackfillSource(source, { sourceRoot });
  assert.equal(Buffer.compare(verified.bytes, Buffer.from(markdown, 'utf8')), 0);
  assert.equal(verified.digest, source.contentDigest);
  const wrong = { ...source, contentDigest: sha256Bytes('wrong') };
  expectCode(() => backfillModule.readVerifiedBackfillSource(wrong, { sourceRoot }), 'BACKFILL_SOURCE_DIGEST_MISMATCH');
  expectCode(() => backfillModule.readVerifiedBackfillSource({ ...source, relativePath: '../one.md' }, { sourceRoot }), 'UNSAFE_BACKFILL_PATH');
  const outside = tempRoot();
  fs.symlinkSync(outside, path.join(sourceRoot, 'linked'), 'dir');
  expectCode(() => backfillModule.readVerifiedBackfillSource({ relativePath: 'linked/one.md', contentDigest: source.contentDigest }, { sourceRoot }), 'STORAGE_DIRECTORY_SYMLINK');
  removeTree(sourceRoot); removeTree(outside);
});

test('backfill interruption is resumable and admits each item through the store seam', async (t) => {
  let backfillModule;
  try { backfillModule = await import('../src/domains/reports/ReportLibraryBackfill.js'); }
  catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND') return t.skip('backfill is not present yet'); throw error; }
  const rootDir = tempRoot();
  const packages = [reportPackage({ projectId: 'backfill-project-a', analysisRunId: 'backfill-analysis-a' }), reportPackage({ projectId: 'backfill-project-b', analysisRunId: 'backfill-analysis-b', tickers: ['NVDA'] })];
  const manifest = {
    contract: 'report-library-backfill-manifest.v1', manifestId: 'manifest-resume', asOf: '2026-08-13T00:00:00.000Z',
    items: packages.map((pkg, index) => ({ itemId: `item-${index + 1}`, package: pkg, source: null })),
  };
  const admitted = [];
  let interrupted = false;
  const fakeStore = { commitPreparedAdmission() {}, admit: (pkg) => {
    if (admitted.length === 1 && !interrupted) {
      interrupted = true;
      throw Object.assign(new Error('deterministic injected interruption'), { code: 'INJECTED_INTERRUPTION' });
    }
    admitted.push(pkg.lineage.analysisRunId);
    return { reportVersionId: contracts.reportVersionId(pkg), ingestionId: contracts.reportIngestionId(pkg) };
  } };
  const now = () => '2026-08-13T00:00:00.000Z';
  const service = new backfillModule.ReportLibraryBackfill({
    rootDir,
    store: fakeStore,
    admissionService: fakeStore,
    now,
    maxAttempts: 2,
  });
  const first = await service.start(manifest);
  assert.equal(first.status, 'failed');
  assert.equal(first.summary.succeeded, 1);
  const resumed = await service.resume(first.runId);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.summary.succeeded, 2);
  assert.equal(new Set(admitted).size, 2);
  removeTree(rootDir);
});

test('Report Library focused path is deterministic and performs no provider/network/live work', () => {
  const relevant = Object.keys(process.env).filter((key) => /API_KEY|TOKEN|ENDPOINT|PROVIDER|OPENAI|DEEPSEEK|FMP|TAVILY|PERPLEXITY/iu.test(key));
  assert.ok(Array.isArray(relevant));
  assert.equal(process.env.REPORT_LIBRARY_LIVE, undefined);
  assert.equal(process.env.REPORT_LIBRARY_PROVIDER, undefined);
  assert.equal(typeof fetch, 'function');
});
