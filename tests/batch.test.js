import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchRun } from '../src/core/batch.js';
import { getOhlcv } from '../src/core/data.js';

function harness({ stale = false, wrongData = false } = {}) {
  let symbol = 'BATS:MSFT', resolution = '1D';
  const calls = [];
  const deps = {
    setSymbol: async ({ symbol: next }) => { symbol = 'BATS:' + next.split(':').at(-1); calls.push('symbol'); },
    setTimeframe: async ({ timeframe }) => { resolution = timeframe === 'D' ? '1D' : timeframe; calls.push('timeframe'); },
    getState: async () => ({ symbol, resolution }),
    evaluate: async () => ({ symbol: stale ? 'BATS:OTHER' : symbol, count: 100 }),
    getOhlcv: async ({ count }) => ({
      success: true, symbol: wrongData ? 'BATS:OTHER' : symbol,
      source_symbol: wrongData ? 'BATS:OTHER' : symbol, resolution,
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


describe('economic OHLCV fail-closed regressions', () => {
  const fakeBar = { time: 1793975400, open: 60.9, high: 63.8,
    low: 60.8, close: 62.88, volume: 9732959 };
  function fakeOhlcv({ chartSymbol, sourceSymbol }) {
    return getOhlcv({ count: 1, _deps: {
      evaluate: async js => {
        if (js.includes('var more = true')) return { size: 1, more: false };
        if (js.includes('var result = []')) return {
          bars: [fakeBar], total_bars: 1, symbol: chartSymbol,
          source_symbol: sourceSymbol, resolution: '1D', source: 'direct_bars',
        };
        throw new Error('Unexpected script in OHLCV mock');
      },
      delay: async () => {},
    } });
  }
  it('rejects Fiserv bars mislabelled as CPI', async () => {
    await assert.rejects(
      fakeOhlcv({ chartSymbol: 'ECONOMICS:USCPI', sourceSymbol: 'BATS:FISV' }),
      /OHLCV_SOURCE_MISMATCH/
    );
  });
  it('accepts actual economic series with source identity and bar-date semantics', async () => {
    const data = await fakeOhlcv({
      chartSymbol: 'ECONOMICS:USCPI', sourceSymbol: 'ECONOMICS:USCPI',
    });
    assert.equal(data.source_symbol_verified, true);
    assert.equal(data.observation_time_semantics, 'chart_bar_time_not_release_time');
    assert.equal(data.observation_time, fakeBar.time);
  });
  it('rejects mixed source during a batch even when chart state looks ready', async () => {
    const { deps } = harness();
    deps.getOhlcv = async () => ({
      success: true, symbol: 'ECONOMICS:USCPI', source_symbol: 'BATS:FISV',
      resolution: '1D', bars: [fakeBar],
    });
    deps.setSymbol = async () => {};
    deps.getState = async () => ({ symbol: 'ECONOMICS:USCPI', resolution: '1D' });
    deps.evaluate = async () => ({ symbol: 'ECONOMICS:USCPI', count: 3 });
    const result = await batchRun({
      symbols: ['ECONOMICS:USCPI'], timeframes: ['1D'], action: 'get_ohlcv',
      delay_ms: 0, _deps: deps,
    });
    assert.equal(result.success, false);
    assert.equal(result.failed, 1);
    assert.match(result.results[0].error, /identity mismatch/);
  });
});
