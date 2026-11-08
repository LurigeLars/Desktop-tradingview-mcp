import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchRun } from '../src/core/batch.js';

function harness({ stale = false, wrongData = false } = {}) {
  let symbol = 'BATS:MSFT', resolution = '1D';
  const calls = [];
  const deps = {
    setSymbol: async ({ symbol: next }) => { symbol = 'BATS:' + next.split(':').at(-1); calls.push('symbol'); },
    setTimeframe: async ({ timeframe }) => { resolution = timeframe === 'D' ? '1D' : timeframe; calls.push('timeframe'); },
    getState: async () => ({ symbol, resolution }),
    evaluate: async () => ({ symbol: stale ? 'BATS:OTHER' : symbol, count: 100 }),
    getOhlcv: async ({ count }) => ({
      success: true, symbol: wrongData ? 'BATS:OTHER' : symbol, resolution,
      bars: [{ time: 1793975400, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
      bar_count: 1, total_available: 100, truncated: count > 1,
    }),
    sleep: async () => {},
  };
  return { deps, calls };
}

describe('batch OHLCV identity and failure gates', () => {
  it('uses direct series reader and returns the verified last bar', async () => {
    const { deps, calls } = harness();
    const result = await batchRun({
      symbols: ['NASDAQ:NVDA', 'NASDAQ:MSFT'], timeframes: ['D'],
      action: 'get_ohlcv', ohlcv_count: 100, delay_ms: 0, _deps: deps,
    });
    assert.equal(result.successful, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].result.symbol, 'BATS:NVDA');
    assert.equal(result.results[1].result.last_bar.close, 2);
    assert.equal(calls.filter(x => x === 'symbol').length, 2);
  });

  it('fails closed when the underlying series remains stale', async () => {
    const { deps } = harness({ stale: true });
    const result = await batchRun({
      symbols: ['NASDAQ:NVDA'], timeframes: ['D'],
      action: 'get_ohlcv', delay_ms: 0, _deps: deps,
    });
    assert.equal(result.successful, 0);
    assert.match(result.results[0].error, /not ready/);
  });

  it('rejects mismatched OHLCV identity', async () => {
    const { deps } = harness({ wrongData: true });
    const result = await batchRun({
      symbols: ['NASDAQ:NVDA'], timeframes: ['D'],
      action: 'get_ohlcv', delay_ms: 0, _deps: deps,
    });
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /identity mismatch/);
  });

  it('rejects unknown actions instead of reporting success', async () => {
    await assert.rejects(batchRun({ symbols: ['NVDA'], action: 'export_data' }), /Unsupported batch action/);
  });
});
