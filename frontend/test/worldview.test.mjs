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

test('Canonical Worldview API clients preserve separate read-only Processing Log and Versions boundaries', async () => {
  const mock = mockFetch({});
  try {
    await api.worldviewCurrent();
    await api.worldviewProcessingLog({ limit: 25, cursor: '10', state: 'succeeded', outcome: 'KEEP' });
    await api.worldviewProcessingRun('run/1');
    await api.worldviewEvaluations({ limit: 20, cursor: '5' });
    await api.worldviewVersions({ limit: 30, cursor: '15' });
    await api.worldviewVersion('version/1');
    assert.deepEqual(mock.requests.map(({ url }) => url), [
      '/api/worldview/current',
      '/api/worldview/processing-log?limit=25&cursor=10&state=succeeded&outcome=KEEP',
      '/api/worldview/processing-log/run%2F1',
      '/api/worldview/evaluations?limit=20&cursor=5',
      '/api/worldview/versions?limit=30&cursor=15',
      '/api/worldview/versions/version%2F1',
    ]);
    assert.ok(mock.requests.every(({ options }) => !options.method || options.method === 'GET'));
  } finally {
    mock.restore();
  }
});

test('Worldview frontend keeps Processing Log and Canonical Versions as separate read-only surfaces', async () => {
  const [app, processing, versions] = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/WorldviewProcessingLogView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/WorldviewVersionsView.jsx', import.meta.url), 'utf8'),
  ]);
  for (const token of ['WorldviewProcessingLogView', 'WorldviewVersionsView', 'worldviewProcessing', 'worldviewVersions']) {
    assert.match(app, new RegExp(token, 'u'));
  }
  for (const token of ['Frozen report range', 'selected full reads', 'retry metadata', 'KEEP', 'UPDATE', 'api.worldviewProcessingLog']) {
    assert.match(processing, new RegExp(token.replaceAll('.', '\\.'), 'iu'), token);
  }
  for (const token of ['canonical-worldview-package.v1', 'Worldview Update Record', 'integrity verified', 'api.worldviewVersions']) {
    assert.match(versions, new RegExp(token.replaceAll('.', '\\.'), 'iu'), token);
  }
  assert.match(processing, /KEEP remains here and creates no Version/u);
  assert.match(versions, /KEEP[^\n]+不会创建冗余版本/u);
  assert.doesNotMatch(`${processing}\n${versions}`, /\bPOST\b|\bPATCH\b|\bDELETE\b/u);
});


test('Worldview Processing Log detail exposes the exact publication, attempt, Claim action, and receipt outcome', async () => {
  const processing = await readFile(new URL('../src/views/WorldviewProcessingLogView.jsx', import.meta.url), 'utf8');
  for (const token of [
    'Worldview outcome', 'Publication ID', 'Publication digest', 'Resulting Worldview Version', 'Evaluation record',
    'Core Worldview attempts', 'Model API retry', 'Model API attempts', 'Failure code', 'Workspace digest',
    'Accepted Claim actions', 'Rejected Claim actions', 'Rejection reason', 'Action integrity digest',
    'Processed ReportVersion receipts', 'Receipt ID', 'Receipt digest', 'Admission sequence',
    'Content digest', 'Fingerprint', 'Processed at',
    'Captured provider', 'Captured model', 'Captured reasoning level',
  ]) {
    assert.match(processing, new RegExp(token, 'iu'), token);
  }
  for (const expression of [
    /run\.publicationId/u,
    /run\.publicationDigest/u,
    /run\.attempts/u,
    /attempt\.modelApiRetry/u,
    /attempt\.modelApiAttempts/u,
    /attempt\.failure/u,
    /run\.acceptedClaimActions/u,
    /run\.rejectedClaimActions/u,
    /run\.processedReceipts/u,
    /run\.effectiveConfig\?\.capturedRoute\?\.provider/u,
    /run\.effectiveConfig\?\.capturedRoute\?\.model/u,
    /run\.effectiveConfig\?\.capturedRoute\?\.reasoningLevel/u,
  ]) assert.match(processing, expression);
  assert.match(processing, /Worldview Version history remains separate/u);
  for (const token of ['Processed receipts', 'Succeeded runs', 'Durable runs']) {
    assert.match(processing, new RegExp(token, 'iu'), token);
  }
  assert.doesNotMatch(processing, /processingPosition|lastProcessedAdmissionSequence|Processed through admission|Processing Position/iu);
  assert.doesNotMatch(processing, /Canonical\s+Claims/iu);
  assert.doesNotMatch(processing, /\bPOST\b|\bPATCH\b|\bDELETE\b/u);
});


test('Worldview Processing Log paginates Runs and labels metrics as loaded-page counts', async () => {
  const processing = await readFile(new URL('../src/views/WorldviewProcessingLogView.jsx', import.meta.url), 'utf8');

  for (const expression of [
    /const \[nextCursor, setNextCursor\] = useState\(null\)/u,
    /api\.worldviewProcessingLog\(\{ limit: RUN_PAGE_SIZE, cursor \}\)/u,
    /append \? \[\.\.\.current, \.\.\.pageRuns\] : pageRuns/u,
    /setNextCursor\(result\?\.nextCursor \|\| null\)/u,
    /Load more Runs/u,
    /Metric label="Processed receipts in loaded pages"/u,
    /Metric label="Succeeded runs in loaded pages"/u,
    /Metric label="Durable runs in loaded pages"/u,
    /run\.acceptedClaimActionCount/u,
    /run\.rejectedClaimActionCount/u,
  ]) assert.match(processing, expression);

  assert.doesNotMatch(processing, /limit:\s*200/u);
  assert.doesNotMatch(processing, /modelPolicy\?\.tier/u);
});


test('Worldview Versions uses nextCursor and explicit bounded Load more Versions behavior', async () => {
  const versions = await readFile(new URL('../src/views/WorldviewVersionsView.jsx', import.meta.url), 'utf8');

  for (const expression of [
    /const VERSION_PAGE_SIZE = 100/u,
    /const \[nextCursor, setNextCursor\] = useState\(null\)/u,
    /api\.worldviewVersions\(\{ limit: VERSION_PAGE_SIZE, cursor \}\)/u,
    /append \? \[\.\.\.loaded, \.\.\.pageVersions\] : pageVersions/u,
    /setNextCursor\(result\?\.nextCursor \|\| null\)/u,
    /Load more Versions/u,
  ]) assert.match(versions, expression);

  assert.doesNotMatch(versions, /limit:\s*200/u);
});
