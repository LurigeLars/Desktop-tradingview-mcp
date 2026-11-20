import { withTopologyMutationLock } from '../core/topology-lock.js';
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run sequential watchlist/top-50 or multi-timeframe actions on a research chart. Keep worker and personal charts untouched; explicitly restore symbol, timeframe and visible range. OHLCV output is counts and last_bar, not full candle history.', {
    symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.string().describe('Supported actions: screenshot, get_ohlcv (counts + last_bar only), get_strategy_results'),
    delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
    ohlcv_count: z.coerce.number().optional().describe('Bars inspected for get_ohlcv (default 100, max 500).'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count }) => {
    try { return jsonResult(await withTopologyMutationLock('batch_run', () => core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
