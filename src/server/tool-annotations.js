const CLOSED_READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const CLOSED_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const CLOSED_SET = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const CLOSED_DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
const CLOSED_DESTRUCTIVE_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
const OPEN_READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const OPEN_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
const OPEN_SET = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const OPEN_DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

/**
 * Safety annotations for tools still registered through the SDK's legacy
 * server.tool(name, description, inputSchema, handler) helper.
 *
 * Every entry is explicit because MCP defaults are intentionally pessimistic
 * (write/destructive/open-world). A missing entry is a registration error so a
 * new tool cannot silently inherit misleading safety labels in ChatGPT.
 */
export const LEGACY_TOOL_ANNOTATIONS = Object.freeze({
  batch_run: OPEN_WRITE,
  capture_screenshot: CLOSED_WRITE,

  chart_get_state: CLOSED_READ,
  chart_set_symbol: OPEN_SET,
  chart_set_timeframe: CLOSED_SET,
  chart_set_type: CLOSED_SET,
  chart_manage_indicator: CLOSED_DESTRUCTIVE,
  chart_get_visible_range: CLOSED_READ,
  chart_set_visible_range: CLOSED_SET,
  chart_scroll_to_date: CLOSED_SET,
  symbol_info: CLOSED_READ,
  symbol_search: OPEN_READ,

  data_get_ohlcv: CLOSED_READ,
  data_get_indicator: CLOSED_READ,
  data_get_strategy_results: CLOSED_WRITE,
  data_get_trades: CLOSED_WRITE,
  data_get_equity: CLOSED_READ,
  quote_get: OPEN_READ,
  depth_get: CLOSED_READ,
  data_get_pine_lines: CLOSED_READ,
  data_get_pine_labels: CLOSED_READ,
  data_get_pine_tables: CLOSED_READ,
  data_get_pine_boxes: CLOSED_READ,
  data_get_study_values: CLOSED_READ,

  draw_shape: CLOSED_WRITE,
  draw_list: CLOSED_READ,
  draw_clear: CLOSED_DESTRUCTIVE_IDEMPOTENT,
  draw_remove_one: CLOSED_DESTRUCTIVE_IDEMPOTENT,
  draw_get_properties: CLOSED_READ,

  indicator_set_inputs: CLOSED_DESTRUCTIVE_IDEMPOTENT,
  indicator_toggle_visibility: CLOSED_SET,
  indicator_search: OPEN_READ,
  indicator_add: OPEN_WRITE,

  pane_list: CLOSED_READ,
  pane_set_layout: CLOSED_DESTRUCTIVE_IDEMPOTENT,
  pane_focus: CLOSED_SET,
  pane_set_symbol: OPEN_SET,

  pine_get_source: CLOSED_READ,
  pine_set_source: CLOSED_DESTRUCTIVE,
  pine_compile: CLOSED_WRITE,
  pine_get_errors: CLOSED_READ,
  pine_save: CLOSED_DESTRUCTIVE_IDEMPOTENT,
  pine_get_console: CLOSED_READ,
  pine_smart_compile: CLOSED_WRITE,
  pine_new: CLOSED_WRITE,
  pine_open: CLOSED_DESTRUCTIVE,
  pine_list_scripts: CLOSED_READ,
  pine_analyze: CLOSED_READ,
  pine_check: CLOSED_READ,

  replay_start: CLOSED_WRITE,
  replay_step: CLOSED_WRITE,
  replay_autoplay: CLOSED_WRITE,
  replay_stop: CLOSED_SET,
  replay_trade: CLOSED_WRITE,
  replay_status: CLOSED_READ,

  ui_click: CLOSED_DESTRUCTIVE,
  ui_open_panel: CLOSED_WRITE,
  ui_fullscreen: CLOSED_WRITE,
  layout_list: CLOSED_READ,
  layout_switch: CLOSED_SET,
  ui_keyboard: CLOSED_DESTRUCTIVE,
  ui_type_text: CLOSED_DESTRUCTIVE,
  ui_hover: CLOSED_WRITE,
  ui_scroll: CLOSED_WRITE,
  ui_mouse_click: CLOSED_DESTRUCTIVE,
  ui_find_element: CLOSED_READ,
  ui_evaluate: OPEN_DESTRUCTIVE,

  watchlist_get: CLOSED_READ,
  watchlist_add: OPEN_WRITE,
  watchlist_add_bulk: OPEN_WRITE,
  watchlist_remove: CLOSED_DESTRUCTIVE_IDEMPOTENT,
});

export function installLegacyToolAnnotationAdapter(server) {
  server.tool = (name, description, inputSchema, handler) => {
    const toolAnnotations = LEGACY_TOOL_ANNOTATIONS[name];
    if (!toolAnnotations) {
      throw new Error(`Missing explicit ToolAnnotations for legacy MCP tool: ${name}`);
    }
    return server.registerTool(name, {
      description,
      inputSchema,
      annotations: toolAnnotations,
    }, handler);
  };
}
