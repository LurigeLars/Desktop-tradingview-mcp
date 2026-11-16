---
name: realtime-market-data
description: Use for TradingView Desktop quotes, resident snapshots, morning briefs, multi-symbol or multi-timeframe analysis, top-50/watchlist scans, worker sampling, session/freshness checks, and extended-hours data. Do not use for unrelated desktop cleanup or account tasks.
---

# DTV market-data routing

Choose or combine existing capabilities to fit the task. There is no mandatory tool order or blanket preference for batch, snapshots or workers. Weigh required evidence, freshness, history/studies, coverage, latency, payload size and impact on shared charts. Keep batch visible as an available option rather than prescribing it for every multi-symbol request. Explain a material tradeoff briefly when it affects the result.

## Quote session and freshness — mandatory

`quote_get` may expose two independent price/time streams. Never infer that an extended-hours quote is stale solely because the regular-session `last` or `source_timestamp` is old.

- `last`, `source_timestamp`, `age_at_retrieval_ms`: regular-session quote/age. These can remain unchanged throughout premarket or aftermarket.
- `rtc`, `rtc_timestamp`, `rtc_age_at_retrieval_ms`: extended-hours/current chart price stream when populated. During `current_session="pre_market"` or `"post_market"`, prefer **fresh `rtc`** for the current price. Use its own timestamp and age; do not evaluate its freshness using `source_timestamp`.
- During `current_session="market"`, use the current regular-session price (`last`) when its source timestamp is fresh; check whether other streams disagree before making execution-sensitive claims.
- `bid` and `ask` are separate observations. Validate their spread, sizes, and plausibility against the chosen price; do not treat a quote as an executable Avanza price or assume timestamps are synchronized.
- Check `requested_symbol_matches_source` / `source_symbol_verified`, `current_session`, `realtime_status`, `is_delay`, and the timestamp of the **selected** stream. A BATS-sourced quote may not represent the consolidated US extended-hours market.
- If the appropriate stream is absent or stale, say so. Do not silently substitute the previous regular close. Do not describe regular-session `change_percent` as the extended-hours return: calculate any pre/post-market move explicitly from a verified comparison reference and label it.
- Freshness is relative to the task's horizon: seconds/minutes for live intraday execution, potentially longer for background context. If a quote cannot meet the required freshness, fail closed rather than inventing a price.

Example: `last=162.85`, `source_timestamp` two days old, `rtc=158.09`, `rtc_age_at_retrieval_ms=3840`, `current_session="pre_market"` means a **fresh premarket price of 158.09**, not a stale current quote. `last` is a historical regular-session reference.

## Tool capabilities and judgment

- For resident trading checks, `realtime_snapshot` with exact handles/groups and `mode="fast"` for compact current data or `mode="decision"` for bounded bars/studies. Verify the actual symbol, resolution, studies and freshness; a 60m worker is not evidence of a 5m close.
- For a morning brief, `morning_brief` can collect resident market context and configured rules. Use it, direct snapshots, batch or a combination according to the requested coverage; the workflow name does not mandate one tool.
- For a finite watchlist, "top 50 Nasdaq", comparison or multiple timeframes, `batch_run` is one existing option for supported sequential actions on a research chart. Compare its actual data and mutation contract with resident reads, temporary sampling or other available bounded reads; choose the best fit without a mandatory batch preflight. A missing resident symbol does not mean DTV cannot inspect it. Verify the symbol universe and ranking definition; do not assume "top 50" means Nasdaq-100 or a particular ranking.
- One nonresident qualified symbol: consider `worker_rotate_snapshot` for a verified unprotected pane, then verify restoration. Check returned timeframe, bar count and study coverage; this is not an arbitrary-timeframe/indicator API. Its suitability depends on the evidence needed, not a fixed symbol-count rule.
- `quote_get` reads the attached chart. A different requested symbol can switch and restore that chart: do not describe it as a mutation-free arbitrary-symbol quote service.

## Batch contract and safe use

1. Current supported `batch_run` actions are `get_ohlcv`, `screenshot` and `get_strategy_results`. Choose explicit symbols/timeframes and bounded counts. It visits them sequentially, so results are not simultaneous market snapshots.
2. Use one exact, verified non-worker research chart. Reuse a suitable task-owned chart; if none exists, one named task-owned research chart within verified capacity can serve the whole list. Never repurpose a worker or personal chart. Inspect and record original symbol/timeframe before changing it.
3. Verify the deployed implementation's locking and cleanup. Current batch code does NOT automatically restore the original chart; explicitly restore and read back its symbol/timeframe even after partial failure. Do not promise cross-consumer isolation merely because a loop is called a batch.
4. Current `get_ohlcv` batch output contains identity/counts and `last_bar`, NOT the full fetched candle series. `ohlcv_count` does not change that output contract. Do not calculate RSI, EMA, multi-period returns or other measures from unavailable history. Use bounded existing candle/study reads or a narrowly justified extension when the requested measure needs more data.
5. Use bounded chunks where needed for latency, payload size and other consumers. Check `successful`, `failed`, `partial` and each item; report uncovered symbols instead of silently ranking a partial universe as complete.

## Evidence and persistent workers

- Configure `worker_set_universe` / provision only for an explicitly recurring resident need. Multiple timeframes can justify the same symbol in several workers; registry uniqueness does not prove every permanent pane is necessary.
- Preserve shared consumer charts and protected workers. On `RESTORATION_PENDING`, use `worker_rotation_recover` and fail closed until restoration is verified.
- Treat exact instrument/reference, session, realtime/delay status, quote age and completed-bar timestamps as separate evidence. Retrieval time or tool success alone does not establish fresh, signal-usable data. Require explicit extended-hours coverage for US pre/post-market claims.
- Reuse timestamped evidence and avoid duplicate reads. DTV chart prices are not executable Avanza bid/ask/depth.
- Official TradingView MCP/API/plugin is retired for this workflow; do not use it as a fallback. Diagnose Desktop CDP independently and report missing evidence without inventing bars or weakening freshness gates.
