---
name: desktop-operations
description: Use when managing TradingView Desktop tabs, panes, layouts, chart symbols, or UI state. For market-data work, use realtime-market-data to choose suitable tools without a mandatory order.
---

# DTV desktop operations

Prefer semantic tools over UI automation.

1. Inspect current chart/pane/tab state before changing it when the target is not already explicit.
2. For ad hoc data use the standard chart tools on an attached task-owned layout whenever that meets the request. Choose resident reads or temporary sampling when their coverage and latency help. Direct chart reads require no worker lookup or registration.
3. Use pane/tab/layout/symbol tools for their named operations. Workers and personal charts are AI charts and may be changed; run `worker_provision` afterwards when the registered worker setup should come back. Never close or duplicate a worker tab.
4. Reuse suitable existing layouts/tabs. Open a known task-owned research layout by name or create a named test layout within verified capacity. For a known saved layout, verify the returned chart ID and exact target, then read chart state before any mutation. One research chart can serve the whole batch.
5. Record original symbol, resolution and visible range before research chart mutation, restore after completion or failure, and verify by read-back. Do not assume batch_run performs automatic restoration or returns full candle history.
6. Use UI keyboard/actions only as a narrow fallback and verify resulting state afterward.

Keep mutations minimal and reversible where the tool surface allows it.

For multiple chart UI checks or clicks, use `ui_sequence` with exact target_id + chart_id from tab_list. Up to 8 steps; exact visible aria-label, data-name or text; a click must be followed by wait/assert. Inspect partial results before retrying. No arbitrary JavaScript or Desktop targets. Use `tab_confirm_close` and `layout_delete` for their named operations; never use generic UI to bypass their protection or execute trades.
