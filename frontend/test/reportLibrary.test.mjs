import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { api } from '../src/api.js';

function mockFetch(response = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('Report Library API methods preserve read-only endpoint boundaries and query encoding', async () => {
  const mock = mockFetch({ reports: [] });
  try {
    await api.reportLibraryStatus();
    await api.reportLibraryBatches({ limit: 25, status: 'closed' });
    await api.reportLibraryBatch('batch/1');
    await api.reportLibraryReports({ limit: 25, ticker: 'BRK/B' });
    await api.reportLibraryReport('report/v1');
    await api.reportLibraryReportContent('report/v1');
    await api.reportLibraryTickers();
    await api.reportLibraryTickerTimeline('BRK/B', 10);
    await api.reportLibraryIngestions();
    await api.reportLibraryIngestion('ingest/1');
    await api.reportLibraryBackfill('backfill/1');

    assert.deepEqual(mock.requests.map(({ url }) => url), [
      '/api/report-library/status',
      '/api/report-library/batches?limit=25&status=closed',
      '/api/report-library/batches/batch%2F1',
      '/api/report-library/reports?limit=25&ticker=BRK%2FB',
      '/api/report-library/reports/report%2Fv1',
      '/api/report-library/reports/report%2Fv1/content',
      '/api/report-library/tickers',
      '/api/report-library/tickers/BRK%2FB/timeline?limit=10',
      '/api/report-library/ingestions',
      '/api/report-library/ingestions/ingest%2F1',
      '/api/report-library/backfills/backfill%2F1',
    ]);
    assert.ok(mock.requests.every(({ options }) => !options.method || options.method === 'GET'));
  } finally {
    mock.restore();
  }
});


test('Report Library view exposes Daily Report Batches, lineage, and the two-state processing vocabulary', async () => {
  const source = await readFile(new URL('../src/views/ReportLibraryView.jsx', import.meta.url), 'utf8');
  for (const token of [
    'api.reportLibraryBatches',
    'api.reportLibraryBatch',
    'Daily Report Batch',
    'processingStatus',
    'Pending',
    'Processed',
    'lineage',
    'candidateAdmission',
    'Admission retry',
  ]) {
    assert.match(source, new RegExp(token.replaceAll('.', '\\.'), 'u'), token);
  }
  assert.doesNotMatch(source, /reportLibraryReportOverview|Overview readiness|not-ready|overview\?\.status/u);
  assert.doesNotMatch(source, /POST|PATCH|DELETE/u);
});
