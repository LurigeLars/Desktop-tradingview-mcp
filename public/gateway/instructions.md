TradingView Desktop MCP. The authenticated connector preserves the full TradingView tool surface while the gateway compacts repeated tool metadata to reduce context use.

- Start with tv_health_check. If TradingView is not running with CDP, use tv_launch.
- Read chart state once with chart_get_state and reuse returned entity IDs.
- For OHLCV, prefer data_get_ohlcv with summary=true unless individual bars are required.
- For custom Pine drawings, use the data_get_pine_* tools with a study filter when known.
- Prefer typed chart, Pine, indicator, pane, alert, watchlist and replay tools over generic UI automation.
- capture_screenshot is preferable when visual context is enough.
- ui_evaluate is a powerful fallback/debug tool; use it only when a typed tool is insufficient.
- tv_update is maintenance functionality and should be used only for explicit update work.
- tv_close exits the whole MCP-managed TradingView Desktop app. tab_close closes only the active tab.
