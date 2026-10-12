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

test('Claim Library API clients cover only the read-only Claim projections', async () => {
  const mock = mockFetch({});
  try {
    await api.claims({ ticker: 'BRK/B', limit: 25, cursor: '10' });
    await api.claim('claim/1');
    await api.claim('claim/1', { version: 2 });
    await api.claimHistory('claim/1', {
      versionsLimit: 10, versionsCursor: '2',
      actionsLimit: 20, actionsCursor: '4',
      rejectionsLimit: 30, rejectionsCursor: '6',
    });
    await api.claimActions('claim/1', { limit: 20, cursor: '5' });
    await api.claimsActions({ publicationId: 'publication/1', action: 'UPDATE', limit: 30, cursor: '15' });
    await api.claimRejections({ publicationId: 'publication/1', code: 'CLAIM_INVALID_TEXT', limit: 40, cursor: '20' });

    assert.deepEqual(mock.requests.map(({ url }) => url), [
      '/api/claims?limit=25&cursor=10&ticker=BRK%2FB',
      '/api/claims/claim%2F1',
      '/api/claims/claim%2F1?version=2',
      '/api/claims/claim%2F1/history?versionsLimit=10&versionsCursor=2&actionsLimit=20&actionsCursor=4&rejectionsLimit=30&rejectionsCursor=6',
      '/api/claims/claim%2F1/actions?limit=20&cursor=5',
      '/api/claims/actions?limit=30&cursor=15&publicationId=publication%2F1&action=UPDATE',
      '/api/claims/rejections?limit=40&cursor=20&publicationId=publication%2F1&code=CLAIM_INVALID_TEXT',
    ]);
    assert.ok(mock.requests.every(({ options }) => !options.method || options.method === 'GET'));
  } finally {
    mock.restore();
  }
});

test('Claim Library is a separate compact read-only frontend surface with immutable detail history', async () => {
  const [app, i18n, claims, versions] = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/ClaimLibraryView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/WorldviewVersionsView.jsx', import.meta.url), 'utf8'),
  ]);

  for (const token of ['ClaimLibraryView', 'claimLibrary']) assert.match(app, new RegExp(token, 'u'));
  assert.match(i18n, /claimLibrary:\s*'Claim Library'/u);
  for (const token of [
    'Claim Library', 'Claim detail', 'Immutable Claim history', 'Claim action history',
    'Assertion', 'Subject', 'Tickers', 'Version', 'Verification point', 'Verification window',
    'Metric', 'Acceptance condition', 'Invalidation condition', 'Exact evidence',
    'ReportVersion ID', 'Content digest', 'Fingerprint', 'Originating run', 'Publication ID',
    'Created', 'Updated', 'Integrity digest', 'api.claims', 'api.claim', 'api.claimHistory',
  ]) {
    assert.match(claims, new RegExp(token.replaceAll('.', '\\.'), 'iu'), token);
  }
  assert.doesNotMatch(claims, /Canonical\s+Claims/iu);
  assert.doesNotMatch(claims, /\bPOST\b|\bPATCH\b|\bDELETE\b/u);
  assert.doesNotMatch(versions, /Claim Library|Claim detail|Claim action history/u);
});


test('each immutable Claim history version exposes the complete falsifiable Claim record', async () => {
  const claims = await readFile(new URL('../src/views/ClaimLibraryView.jsx', import.meta.url), 'utf8');
  const start = claims.indexOf('function VersionRecord');
  const end = claims.indexOf('function EvidenceSectionInline');
  assert.ok(start >= 0 && end > start);
  const versionRecord = claims.slice(start, end);
  for (const expression of [
    /claim\.assertion/u,
    /claim\.subject/u,
    /claim\.tickers/u,
    /claim\.version/u,
    /claim\.verification/u,
    /claim\.metric/u,
    /claim\.acceptanceCondition/u,
    /claim\.invalidationCondition/u,
    /claim\.originatingRunId/u,
    /claim\.publicationId/u,
    /claim\.createdAt/u,
    /claim\.updatedAt/u,
    /claim\.integrityDigest/u,
    /claim\.evidence/u,
  ]) assert.match(versionRecord, expression);
});


test('Claim action history exposes accepted targets/results and exact rejection reasons', async () => {
  const claims = await readFile(new URL('../src/views/ClaimLibraryView.jsx', import.meta.url), 'utf8');
  for (const expression of [
    /action\.target/u,
    /action\.resultClaim/u,
    /action\.recordedAt/u,
    /action\.evidence/u,
    /rejection\.code/u,
    /rejection\.reason/u,
    /rejection\.target/u,
    /rejection\.originatingRunId/u,
    /rejection\.publicationId/u,
    /rejection\.integrityDigest/u,
  ]) assert.match(claims, expression);
});


test('Claim Library paginates current Claims and each bounded immutable history stream', async () => {
  const claims = await readFile(new URL('../src/views/ClaimLibraryView.jsx', import.meta.url), 'utf8');

  for (const expression of [
    /const \[nextCursor, setNextCursor\] = useState\(null\)/u,
    /api\.claims\(\{ limit: CLAIM_PAGE_SIZE, cursor \}\)/u,
    /append \? \[\.\.\.current, \.\.\.pageClaims\] : pageClaims/u,
    /setNextCursor\(result\?\.nextCursor \|\| null\)/u,
    /Load more Claims/u,
    /CLAIM_HISTORY_PAGE_SIZE = 50/u,
    /history\.nextCursors\?\.\[section\]/u,
    /\[section\]: \[\.\.\.current\[section\], \.\.\.\(page\[section\] \|\| \[\]\)\]/u,
    /Load more Claim Versions/u,
    /Load more Claim Actions/u,
    /Load more Claim Rejections/u,
    /Array\.isArray\(history\?\.actions\)/u,
    /Array\.isArray\(history\?\.rejections\)/u,
  ]) assert.match(claims, expression);

  assert.doesNotMatch(claims, /limit:\s*500/u);
  assert.doesNotMatch(claims, /api\.claimActions\(/u);
});
