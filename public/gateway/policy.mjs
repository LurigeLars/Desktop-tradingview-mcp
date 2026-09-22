// Public ChatGPT policy for the TradingView Desktop MCP server.
//
// Patterned after firecrawl-local's gateway policy: the gateway is a small
// policy/compaction layer in front of the full local MCP server.
// The full capability surface stays available by default; token savings come
// from descriptor/schema compaction. A deliberately narrower profile remains
// available as an operator-controlled opt-in.
import fs from 'node:fs';

export const FULL_ALLOWED_TOOLS = [
  'tv_health_check', 'tv_discover', 'tv_ui_state', 'tv_launch', 'tv_close', 'tv_update',
  'chart_get_state', 'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type',
  'chart_manage_indicator', 'chart_get_visible_range', 'chart_set_visible_range',
  'chart_scroll_to_date', 'symbol_info', 'symbol_search',
  'pine_get_source', 'pine_set_source', 'pine_compile', 'pine_get_errors', 'pine_save',
  'pine_get_console', 'pine_smart_compile', 'pine_new', 'pine_open', 'pine_list_scripts',
  'pine_analyze', 'pine_check',
  'data_get_ohlcv', 'data_get_indicator', 'data_get_strategy_results', 'data_get_trades',
  'data_get_equity', 'quote_get', 'depth_get', 'data_get_pine_lines', 'data_get_pine_labels',
  'data_get_pine_tables', 'data_get_pine_boxes', 'data_get_study_values', 'realtime_snapshot',
  'worker_set_universe', 'worker_status', 'worker_provision',
  'capture_screenshot',
  'draw_shape', 'draw_list', 'draw_clear', 'draw_remove_one', 'draw_get_properties',
  'alert_create', 'alert_list', 'alert_delete',
  'batch_run',
  'replay_start', 'replay_step', 'replay_autoplay', 'replay_stop', 'replay_trade', 'replay_status',
  'indicator_set_inputs', 'indicator_toggle_visibility', 'indicator_search', 'indicator_add',
  'watchlist_get', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove',
  'ui_click', 'ui_open_panel', 'ui_fullscreen', 'layout_list', 'layout_switch',
  'ui_keyboard', 'ui_type_text', 'ui_hover', 'ui_scroll', 'ui_mouse_click', 'ui_find_element',
  'ui_evaluate',
  'pane_list', 'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'tab_list', 'tab_new', 'layout_new', 'tab_close', 'tab_switch',
].join(',');

// Optional operator-controlled reduced profile. It is never selected implicitly.
export const CORE_ALLOWED_TOOLS = [
  'tv_health_check', 'tv_launch', 'tv_close',
  'chart_get_state', 'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type',
  'chart_manage_indicator', 'chart_scroll_to_date',
  'symbol_info', 'symbol_search',
  'data_get_ohlcv', 'data_get_indicator', 'data_get_strategy_results',
  'quote_get', 'depth_get', 'data_get_pine_lines', 'data_get_pine_labels',
  'data_get_pine_tables', 'data_get_pine_boxes', 'data_get_study_values', 'realtime_snapshot',
  'worker_set_universe', 'worker_status', 'worker_provision',
  'capture_screenshot',
  'alert_create', 'alert_list', 'alert_delete',
  'indicator_set_inputs', 'indicator_toggle_visibility', 'indicator_search', 'indicator_add',
  'watchlist_get', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove',
  'layout_list', 'layout_switch',
  'pane_list', 'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'tab_list', 'tab_new', 'tab_close', 'tab_switch',
].join(',');

export const DEFAULT_ALLOWED_TOOLS = FULL_ALLOWED_TOOLS;

export function parseAllowedTools(value) {
  const configured = String(value ?? '').trim();
  if (!configured || configured.toLowerCase() === 'full') {
    return new Set(FULL_ALLOWED_TOOLS.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (configured.toLowerCase() === 'core') {
    return new Set(CORE_ALLOWED_TOOLS.split(',').map(s => s.trim()).filter(Boolean));
  }
  return new Set(configured.split(',').map(s => s.trim()).filter(Boolean));
}

// Public server instructions are intentionally much shorter than the full local
// server instructions. Read on initialize so edits apply after a connector refresh
// without changing the upstream MCP implementation.
export function loadInstructions() {
  try {
    return fs.readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function compactText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
  return text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

// Keep the actual JSON-schema shape and enums/defaults, but trim prose that is
// expensive to repeat in the model tool context. This does not change upstream
// validation because calls still go to the original MCP server.
export function compactSchema(value) {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$schema' || key === 'title' || key === 'examples') continue;
    if (key === 'description') {
      out[key] = compactText(item, 96);
      continue;
    }
    out[key] = compactSchema(item);
  }
  return out;
}

export function compactToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const out = { ...tool };
  if (out.description) out.description = compactText(out.description, 180);
  if (out.inputSchema) out.inputSchema = compactSchema(out.inputSchema);

  // Same token-saving principle as DriveMCP: avoid advertising redundant output
  // schemas when the MCP result is already delivered through the normal content path.
  delete out.outputSchema;
  return out;
}

export function rewriteResponse(message, { allowedTools }) {
  if (!message || typeof message !== 'object') return message;

  if (message.result?.tools) {
    message.result.tools = message.result.tools
      .filter(tool => allowedTools.has(tool.name))
      .map(compactToolDefinition);
  }

  if (message.result?.serverInfo) {
    const instructions = loadInstructions();
    if (instructions) message.result.instructions = instructions;
  }

  return message;
}

export function checkRequest(message, allowedTools) {
  if (message?.method !== 'tools/call') return {};
  if (!allowedTools.has(message.params?.name)) {
    return { error: `Tool not available on the public TradingView connector: ${message.params?.name}` };
  }
  return {};
}

export const rpcError = (id, message) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code: -32601, message },
});
