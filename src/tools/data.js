import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';
import { getOhlcvHistory } from '../core/history.js';
import { getTargetInfo } from '../connection.js';
import * as tabCore from '../core/tab.js';
import { isWorkerOwnedTab, status as workerStatus } from '../core/worker.js';

/** Read-only history collection is permitted only on a verified non-worker
 * chart. Unlike a normal OHLCV read, history loading changes the chart's
 * in-memory cache, so never run it against resident market worker targets.
 */
export function verifyHistoryResearchTarget(info, snapshot, state) {
  if(!info?.id || !Array.isArray(snapshot?.tabs))
    throw new Error('HISTORY_TARGET_UNVERIFIED: attach a dedicated non-worker chart');
  const matches=snapshot.tabs.filter(tab=>tab.is_chart && tab.id===info.id);
  if(matches.length!==1)
    throw new Error('HISTORY_TARGET_UNVERIFIED: current chart target not uniquely identified');
  const target=matches[0];
  if(isWorkerOwnedTab(target,state) ||
    /DTV (?:Market|Worker)\b/i.test(String(target.title||'')))
    throw new Error('WORKER_TARGET_FORBIDDEN: attach an isolated research chart');
  return target;
}


const historySchema = z.object({
  expected_symbol: z.string().min(1),
  expected_resolution: z.string().min(1),
  before_time: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
  count: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

async function readVerifiedHistory(args) {
  const attached=await getTargetInfo();
  verifyHistoryResearchTarget(attached,await tabCore.list(),workerStatus());
  return getOhlcvHistory(args);
}

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    history: historySchema.optional().describe('Explicit opt-in to paginated history on a verified non-worker research chart. Leave omitted for the unchanged 500-bar OHLCV behavior. Pass expected_symbol and expected_resolution from chart_get_state; continue with cursor returned by a previous page.'),
  }, async ({ count, summary, history }) => {
    try {
      if (history) {
        if (count !== undefined || summary !== undefined)
          throw new Error('History mode cannot be combined with normal count/summary; set history.count instead.');
        return jsonResult(await readVerifiedHistory(history));
      }
      return jsonResult(await core.getOhlcv({ count, summary }));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_ohlcv_history', 'Read paginated historical candles from the ATTACHED TradingView Desktop chart without changing it. Use chart_get_state for the exact observed symbol/resolution; BATS aliases may differ from the requested exchange. For older data, pass next_cursor back with the same identity. No partial/stale data is returned on failed loading.', {
    expected_symbol: z.string().min(1).describe('Exact chart_get_state symbol, e.g. BATS:NVDA (required, identity checked before and after every history read)'),
    expected_resolution: z.string().min(1).describe('Exact chart_get_state resolution, e.g. 1, 3, 5, 15 (required)'),
    before_time: z.coerce.number().int().optional().describe('UNIX UTC seconds. Return bars strictly earlier than this time; omit for most recent bars. Do not combine with cursor.'),
    cursor: z.string().optional().describe('Opaque next_cursor from previous successful page; do not combine with before_time'),
    count: z.coerce.number().int().min(1).max(1000).optional().describe('Number of bars per page, 1–1000, default 500'),
  }, async (args) => {
    try {
      return jsonResult(await readVerifiedHistory(args));
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

  server.tool('quote_get', 'Get resident TradingView quote state for the active symbol, including last/bid/ask, timestamps, session and realtime/delay status when exposed. Source age is measured when DTV reads the quote; gateway/tool turnaround is not included. A differing symbol still uses active-chart switch + restore; use realtime_snapshot for other resident panes.', {
    symbol: z.string().optional().describe('Symbol/expression to quote. Blank reads active resident state; a differing non-blank value uses chart switch + restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
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
