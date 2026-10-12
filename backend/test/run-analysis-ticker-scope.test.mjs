import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authoritativeCompanyTickers,
  tickerPromotions,
  tickerScopeMode,
} from '../src/workflows/run-analysis/research/tickerScope.js';

test('targeted ticker scope excludes plan, reflection, and data-focus peers from company runs', () => {
  const meta = { mode: 'targeted', tickers: ['googl'] };
  const cp = {
    scan: {
      mode: 'targeted',
      pool: ['GOOGL', 'MSFT', 'AMZN', 'META'],
      deepTickers: ['GOOGL', 'MSFT'],
    },
    deepPromoted: ['MSFT', 'AMZN'],
  };

  assert.equal(tickerScopeMode({ meta, cp }), 'targeted');
  assert.deepEqual(authoritativeCompanyTickers({
    meta,
    cp,
    fallbackTickers: cp.scan.pool,
    maxTickers: 4,
  }), ['GOOGL']);
  assert.deepEqual(tickerPromotions({
    meta,
    cp,
    currentTickers: ['GOOGL'],
    namedTickers: ['MSFT', 'AMZN', 'META'],
    maxTickers: 4,
  }), []);
});

test('discovery ticker scope preserves bounded dynamic promotion', () => {
  const meta = { mode: 'discovery', tickers: [] };
  const cp = {
    scan: { mode: 'discovery', deepTickers: ['NVDA', 'AVGO'] },
    deepPromoted: ['ARM'],
  };

  assert.equal(tickerScopeMode({ meta, cp }), 'discovery');
  assert.deepEqual(authoritativeCompanyTickers({ meta, cp, maxTickers: 4 }), ['NVDA', 'AVGO', 'ARM']);
  assert.deepEqual(tickerPromotions({
    meta,
    cp,
    currentTickers: ['NVDA', 'AVGO', 'ARM'],
    namedTickers: ['ARM', 'TSM', 'MU'],
    maxTickers: 4,
  }), ['TSM']);
});
