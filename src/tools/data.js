import { withTopologyMutationLock } from '../core/topology-lock.js';
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';
import { getOhlcvHistory } from '../core/history.js';
import { getTargetInfo } from '../connection.js';
import * as tabCore from '../core/tab.js';
/** History paging is bound to one uniquely identified chart target. */
export function verifyHistoryResearchTarget(info, snapshot) {
  if(!info?.id || !Array.isArray(snapshot?.tabs))
    throw new Error('HISTORY_TARGET_UNVERIFIED: attach a chart first');
  const matches=snapshot.tabs.filter(tab=>tab.is_chart && tab.id===info.id);
  if(matches.length!==1)
    throw new Error('HISTORY_TARGET_UNVERIFIED: current chart target not uniquely identified');
  return matches[0];
}


const historySchema = z.object({
  expected_symbol: z.string().min(1).describe('Exact symbol from chart_get_state.'),
  expected_resolution: z.string().min(1).describe('Exact resolution from chart_get_state, e.g. 1 or 5.'),
  before_time: z.coerce.number().int().optional().describe('Exclusive Unix UTC seconds; use the previous first_time. Excludes cursor.'),
  cursor: z.string().optional().describe('Previous next_cursor, bound to the same chart target and instrument. Excludes before_time.'),
  count: z.coerce.number().int().min(1).max(8000).optional().describe('Bars per page; default 500, max 5000 for rows or 8000 for columns.'),
  format: z.enum(['rows', 'columns']).optional().describe('Default rows. Columns returns compact bars:{t,o,h,l,c,v} arrays; for large backtests.'),
}).strict();

// Keep large opt-in responses compact; do not change the legacy JSON envelope.
const MAX_COMPACT_HISTORY_BYTES = 512 * 1024;
export function historyResult(result) {
  if (result.format !== 'columns' && result.requested <= 1000) return jsonResult(result);
  if (result.format !== 'columns' && result.requested === undefined) return jsonResult(result);
  const payload = JSON.stringify(result);
  if (Buffer.byteLength(payload, 'utf8') > MAX_COMPACT_HISTORY_BYTES)
    throw new Error('HISTORY_OUTPUT_TOO_LARGE: retry the same cursor or before_time with a smaller count');
  return { content: [{ type:'text', text:payload }] };
}

async function readVerifiedHistory(args) {
  const attached=await getTargetInfo();
  verifyHistoryResearchTarget(attached,await tabCore.list());
  return getOhlcvHistory(args);
}

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Primary TradingView Desktop candles for intraday analysis and backtests when the selected feed covers the symbol and session. Standard reads return up to 500 bars. For deeper history, use history.count up to 5000 (rows) or up to 8000 with history.format=columns on a verified chart with exact expected_symbol and expected_resolution. Continue with next_cursor. Verify chart identity and coverage. Use summary=true for compact stats.', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    history: historySchema.optional().describe('Page older bars. Omit top-level count/summary. While has_more, pass cursor or before_time.'),
  }, async ({ count, summary, history }) => {
    try {
      if (history) {
        if (count !== undefined || summary !== undefined)
          throw new Error('History mode cannot be combined with normal count/summary; set history.count instead.');
        return historyResult(await readVerifiedHistory(history));
      }
      return jsonResult(await core.getOhlcv({ count, summary }));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_ohlcv_history', 'Page older candles on an attached chart; equivalent to data_get_ohlcv(history=...). Up to 5000 rows or 8000 compact columns. Repeat while has_more=true.', historySchema.shape, async (args) => {
    try {
      return historyResult(await readVerifiedHistory(args));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy (TradingView never computes reports for hidden strategies); result includes unhidden_strategies when that happened.', {}, async () => {
    try { return jsonResult(await core.getStrategyResults()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get trade list from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy.', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get resident TradingView quote state for the active symbol, including last/bid/ask, timestamps, session and realtime/delay status when exposed. Source age is measured when DTV reads the quote; gateway/tool turnaround is not included. A differing symbol uses active-chart switch + verified restore; load or restoration failure is explicit. Use realtime_snapshot for other resident panes.', {
    symbol: z.string().optional().describe('Symbol/expression to quote. Blank reads active resident state; a differing non-blank value uses chart switch + restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await withTopologyMutationLock('quote_get', () => core.getQuote({ symbol }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
