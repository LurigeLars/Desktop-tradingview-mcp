import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBareSymbolRequest,
  matchWatchlistSymbol,
} from '../src/core/watchlist.js';

test('bare symbol fallback is limited to unqualified simple tickers', () => {
  assert.equal(isBareSymbolRequest('ABC'), true);
  assert.equal(isBareSymbolRequest('ABC1!'), true);
  assert.equal(isBareSymbolRequest('ABC.DEF'), true);

  assert.equal(isBareSymbolRequest('EX:ABC'), false);
  assert.equal(isBareSymbolRequest('EX1:AAA/EX2:BBB'), false);
  assert.equal(isBareSymbolRequest('EX1:AAA-EX2:BBB'), false);
  assert.equal(isBareSymbolRequest('1/(EX1:AAA/EX2:BBB)*EX3:CCC'), false);
});

test('bare ticker may verify against one unique exchange-qualified row', () => {
  assert.deepEqual(
    matchWatchlistSymbol('ABC', ['EX:ABC']),
    { matched: 'EX:ABC', verification: 'unique_bare_ticker' },
  );
});

test('exchange-qualified symbols never verify against the wrong exchange', () => {
  assert.deepEqual(
    matchWatchlistSymbol('EX1:ABC', ['EX2:ABC']),
    { matched: null, verification: 'exact_required' },
  );
});

test('ratio expressions cannot collapse to one component', () => {
  assert.deepEqual(
    matchWatchlistSymbol('EX1:AAA/EX2:BBB', ['EX2:BBB']),
    { matched: null, verification: 'exact_required' },
  );
});

test('spread expressions cannot collapse to one component', () => {
  assert.deepEqual(
    matchWatchlistSymbol('EX1:AAA-EX2:BBB', ['EX2:BBB']),
    { matched: null, verification: 'exact_required' },
  );
});

test('nested formulas are treated as opaque and require exact verification', () => {
  const formula = '1/(EX1:AAA/EX2:BBB)*EX3:CCC/EX4:DDD';
  assert.deepEqual(
    matchWatchlistSymbol(formula, ['EX4:DDD']),
    { matched: null, verification: 'exact_required' },
  );
  assert.deepEqual(
    matchWatchlistSymbol(formula, [formula]),
    { matched: formula, verification: 'exact' },
  );
});

test('ambiguous bare tickers fail verification instead of guessing', () => {
  assert.deepEqual(
    matchWatchlistSymbol('ABC', ['EX1:ABC', 'EX2:ABC']),
    { matched: null, verification: 'ambiguous_bare_ticker' },
  );
});


test('bare tickers never suffix-match a formula row', () => {
  assert.deepEqual(
    matchWatchlistSymbol('BBB', ['EX1:AAA/EX2:BBB']),
    { matched: null, verification: 'not_found' },
  );
});

test('Trade Alert watchlist is refused unless the user explicitly allows it', async () => {
  const { tradeAlertWatchlistId, refuseTradeAlertWatchlist } = await import('../src/core/watchlist.js');
  assert.equal(tradeAlertWatchlistId({ readConfig: () => '﻿{"dtv_watchlist_id": 100000001}' }), '100000001');
  assert.equal(tradeAlertWatchlistId({ readConfig: () => '{"dtv_watchlist_id": null}' }), null);
  assert.equal(tradeAlertWatchlistId({ readConfig: () => { throw new Error('missing'); } }), null);
  const list = { id: 100000001, name: 'Alerts' };
  assert.throws(() => refuseTradeAlertWatchlist(list, false, '100000001'), /TRADE_ALERT_WATCHLIST/);
  assert.doesNotThrow(() => refuseTradeAlertWatchlist(list, true, '100000001'));
  assert.doesNotThrow(() => refuseTradeAlertWatchlist({ id: 1, name: 'Other' }, false, '100000001'));
  assert.throws(() => refuseTradeAlertWatchlist(null, false, '100000001'), /cannot tell which watchlist/);
  assert.doesNotThrow(() => refuseTradeAlertWatchlist(null, true, '100000001'));
  assert.doesNotThrow(() => refuseTradeAlertWatchlist(null, false, null));
});

test('watchlist symbols come from list state when rows are not rendered', async () => {
  const { symbolsFromListState } = await import('../src/core/watchlist.js');
  assert.deepEqual(symbolsFromListState({ symbols: ['###Energy', 'NYMEX:CL1!', '', 'NASDAQ:NVDA'] }).map(s => s.symbol),
    ['NYMEX:CL1!', 'NASDAQ:NVDA']);
  assert.deepEqual(symbolsFromListState(null), []);
});
