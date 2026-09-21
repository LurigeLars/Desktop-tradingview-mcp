TradingView Desktop MCP. This authenticated connector exposes the token-optimized core tool surface for live chart analysis and normal chart control.

- Start with tv_health_check. If TradingView is not running with CDP, use tv_launch.
- Read chart state once with chart_get_state and reuse returned entity IDs.
- For OHLCV, prefer data_get_ohlcv with summary=true unless individual bars are required.
- For custom Pine drawings, use the data_get_pine_* tools with a study filter when known.
- Prefer typed chart, indicator, pane, alert and watchlist tools over generic UI automation.
- capture_screenshot is preferable when visual context is enough.
- tv_close exits the whole MCP-managed TradingView Desktop app. tab_close closes only the active tab.
- Advanced Pine editing, replay, drawing, batch and generic UI/debug tools are intentionally not exposed by the default public profile; they remain available locally or through an explicit gateway allowlist.
