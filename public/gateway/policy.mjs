// Public ChatGPT policy for the TradingView Desktop MCP server.
//
// The public connector is intentionally bounded to the TradingView Desktop
// application/account surface. Maintenance tv_update and arbitrary
// page-context JavaScript ui_evaluate remain available locally but are not
// exposed through Cloudflare.
export const DEFAULT_ALLOWED_TOOLS = [
  'tv_health_check', 'tv_discover', 'tv_ui_state', 'tv_launch', 'tv_close',
  'chart_get_state', 'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type',
  'chart_manage_indicator', 'chart_get_visible_range', 'chart_set_visible_range',
  'chart_scroll_to_date', 'symbol_info', 'symbol_search',
  'pine_get_source', 'pine_set_source', 'pine_compile', 'pine_get_errors', 'pine_save',
  'pine_get_console', 'pine_smart_compile', 'pine_new', 'pine_open', 'pine_list_scripts',
  'pine_analyze', 'pine_check',
  'data_get_ohlcv', 'data_get_indicator', 'data_get_strategy_results', 'data_get_trades',
  'data_get_equity', 'quote_get', 'depth_get', 'data_get_pine_lines', 'data_get_pine_labels',
  'data_get_pine_tables', 'data_get_pine_boxes', 'data_get_study_values',
  'capture_screenshot',
  'draw_shape', 'draw_list', 'draw_clear', 'draw_remove_one', 'draw_get_properties',
  'alert_create', 'alert_list', 'alert_delete',
  'batch_run',
  'replay_start', 'replay_step', 'replay_autoplay', 'replay_stop', 'replay_trade', 'replay_status',
  'indicator_set_inputs', 'indicator_toggle_visibility', 'indicator_search', 'indicator_add',
  'watchlist_get', 'watchlist_add', 'watchlist_add_bulk', 'watchlist_remove',
  'ui_click', 'ui_open_panel', 'ui_fullscreen', 'layout_list', 'layout_switch',
  'ui_keyboard', 'ui_type_text', 'ui_hover', 'ui_scroll', 'ui_mouse_click', 'ui_find_element',
  'pane_list', 'pane_set_layout', 'pane_focus', 'pane_set_symbol',
  'tab_list', 'tab_new', 'layout_new', 'tab_close', 'tab_switch',
].join(',');

export function parseAllowedTools(value) {
  return new Set((value || DEFAULT_ALLOWED_TOOLS).split(',').map(s => s.trim()).filter(Boolean));
}

export function rewriteResponse(message, { allowedTools }) {
  if (message?.result?.tools) {
    message.result.tools = message.result.tools.filter(tool => allowedTools.has(tool.name));
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
