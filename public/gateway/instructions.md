TradingView Desktop MCP. The public connector is bounded to the local TradingView Desktop application and the signed-in TradingView account.

Use typed TradingView tools rather than low-level UI actions whenever possible.
- Start with tv_health_check. If TradingView is not running with CDP, use tv_launch.
- tv_close exits the whole MCP-managed TradingView Desktop app. tab_close closes only the active tab.
- For multiple tabs: tab_list, tab_new, tab_switch, tab_close.
- Read chart state once with chart_get_state and reuse returned entity IDs.
- For OHLCV, prefer data_get_ohlcv with summary=true unless individual bars are required.
- For custom Pine drawings, use the data_get_pine_* tools with a study filter when known.
- Prefer high-level chart, indicator, pane, alert, watchlist and replay tools over generic UI clicks/keyboard actions.
- capture_screenshot is preferable when visual context is enough.

The public connector intentionally does not expose arbitrary page JavaScript (ui_evaluate) or repository self-update (tv_update).