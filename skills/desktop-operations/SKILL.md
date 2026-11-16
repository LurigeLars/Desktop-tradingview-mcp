---
name: desktop-operations
description: Use when managing TradingView Desktop tabs, panes, layouts, chart symbols, or UI state. For market-data work, use realtime-market-data to choose suitable tools without a mandatory order.
---

# DTV desktop operations

Prefer semantic tools over UI automation.

1. Inspect current chart/pane/tab state before changing it when the target is not already explicit.
2. For data requests choose or combine resident snapshots, morning_brief, batch_run and temporary worker sampling according to required evidence, latency and chart impact. No fixed order is required; understand the selected tool's actual contract.
3. Use pane/tab/layout/symbol tools for their named operations. Change only the requested target; never repurpose another consumer's worker or personal chart.
4. Reuse suitable existing layouts/tabs. A batch may use one named task-owned research chart within verified capacity when no suitable research target exists; it does not need a worker or tab per symbol.
5. Record original symbol/timeframe before batch mutation, restore explicitly after completion or failure, and verify by read-back. Do not assume batch_run performs automatic restoration or returns full candle history.
6. Use UI keyboard/actions only as a narrow fallback and verify resulting state afterward.

Keep mutations minimal and reversible where the tool surface allows it.
