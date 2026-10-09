import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuoteSourceIdentity } from '../src/core/quote-identity.js';

test('quote-get uses actual resident series source, never echoes requested NASDAQ alias', () => {
  const proof = resolveQuoteSourceIdentity({
    series_symbol: 'BATS:NVDA',
    info_full_name: 'NASDAQ:NVDA',
    info_pro_name: 'NASDAQ:NVDA',
    chart_symbol: 'NASDAQ:NVDA',
  });
  assert.deepEqual(proof, {
    symbol: 'BATS:NVDA',
    source_symbol_verified: true,
    source_symbol_origin: 'series.symbol',
  });
});

test('reactive chart symbol object cannot be serialized as source identity', () => {
  const proof = resolveQuoteSourceIdentity({
    series_symbol: null,
    info_full_name: null,
    info_pro_name: null,
    chart_symbol: { subscribe: {}, unsubscribe: {}, value: {} },
  });
  assert.equal(proof.symbol, null);
  assert.equal(proof.source_symbol_verified, false);
  assert.equal(proof.source_symbol_origin, null);
});

test('chart symbolInfo full_name is a fallback when the resident series identifier is missing', () => {
  const proof = resolveQuoteSourceIdentity({
    series_symbol: { value: {} },
    info_full_name: 'NYSE:VLO',
    info_pro_name: 'NYSE:VLO',
  });
  assert.equal(proof.symbol, 'NYSE:VLO');
  assert.equal(proof.source_symbol_origin, 'series.symbolInfo.full_name');
  assert.equal(proof.source_symbol_verified, true);
});

test('unqualified ticker, reactive and chart API-only values fail closed', () => {
  const missing = [
    { chart_symbol: 'NVDA' },
    { chart_symbol: 'NASDAQ:NVDA' },
    { series_symbol: 'NVDA' },
    { series_symbol: { value: () => 'NASDAQ:NVDA' } },
    { series_symbol: 'NASDAQ:NVDA\nmalicious' },
    { info_full_name: 'BATS:SPY/AMEX:SPY' },
    null, [], 'NASDAQ:NVDA',
  ];
  for (const value of missing) {
    const result = resolveQuoteSourceIdentity(value);
    assert.equal(result.source_symbol_verified, false);
    assert.equal(result.symbol, null);
  }
});

test('first exact quote series symbol has precedence over fallback TradingView metadata', () => {
  assert.equal(resolveQuoteSourceIdentity({
    series_symbol: 'BATS:SPY',
    info_full_name: 'AMEX:SPY',
  }).symbol, 'BATS:SPY');
  assert.equal(resolveQuoteSourceIdentity({
    series_symbol: 'AMEX:SPY',
    info_full_name: 'BATS:SPY',
  }).symbol, 'AMEX:SPY');
});
