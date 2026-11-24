# DTV paginated OHLCV history

Read historical candles from the **currently attached** TradingView Desktop chart using `data_get_ohlcv_history`. This is a separate read-only tool; the existing `data_get_ohlcv` calls without an explicit `history` object retain their original 500-bar contract. Some ChatGPT clients expose a subset of the MCP tools; in those clients use `data_get_ohlcv({"history":{"expected_symbol":"BATS:NVDA","expected_resolution":"1","count":1000}})` to access the identical guarded history path through the already-exposed tool.

## Procedure

1. Attach to a chart with `tab_attach` (workers are AI charts and are fine), then verify `chart_get_state`.
2. Set the desired symbol and resolution with the existing chart tools **before** starting the history read.
3. Use the **exact returned symbol** and resolution in each history request. For example, a requested NASDAQ:NVDA may resolve to BATS:NVDA, with feed-dependent prices/volumes.
4. First request (example):

```json
{"expected_symbol":"BATS:NVDA","expected_resolution":"1","count":1000}
```

5. For the next, older page, pass `next_cursor` **verbatim** with the same `expected_symbol`, `expected_resolution`, **and the exact CDP chart target**. A cursor is invalid after switching to another chart or restarting Desktop; restart pagination there. Alternatively pass a Unix UTC `before_time` (seconds), strictly earlier than that timestamp, but never pass both. The prior page's `first_time` is the exclusive boundary for the next page.
6. Continue while `has_more` is true. Check `first_time` / `last_time` (UTC seconds), `returned`, `pages_loaded`, `total_loaded`, `target_id` and `source`. Deduplicate by symbol/resolution/time. Verify the feed, chart session, timezone, session-aligned gaps, and that the final candle is closed before calling the requested interval complete.

Normally neither scrolling nor zooming is needed. If pagination stops short, use `chart_set_visible_range` or `chart_scroll_to_date` near the missing date, then retry the same exclusive boundary once. *Allow extended zoom out* affects chart display and does not guarantee extra history. When changing a reused research chart, capture and restore its symbol, resolution and visible range even after failure. A disposable chart can be closed without saving.

The tool caches no history locally and never edits chart studies, Pine scripts, orders or saved layouts. It requests older history through the attached chart's existing `requestMoreData(1000)` API. The whole function is serialized with other history reads, and validates CDP target, symbol, and resolution before and after each page of lazy loading.

## Limits and failure modes

* Default row format retains the 1,000-bar maximum (500 default). Opt in with `history:{expected_symbol:"BATS:NVDA",expected_resolution:"1",count:8000,format:"columns"}` (or the same fields directly on the standalone history tool). `bars` then contains equal-length arrays `t,o,h,l,c,v` in ascending timestamp order; the cursor and all other metadata have the same meaning. Values are not rounded or interpolated. Larger **account-side** history limits do not automatically mean the feed offers this much history.
* Compact column responses have a conservative 512 KiB UTF-8 JSON payload limit; if `HISTORY_OUTPUT_TOO_LARGE` is returned, retry the same cursor or exclusive boundary with a smaller count. This is a DTV output guard, not a verified ChatGPT transport limit. No silent clipping. For large datasets use a local consumer rather than sending every candle into model context.
* Each request may initiate at most 30 provider history loads; retry with explicit `before_time` or another valid cursor only after investigating a `HISTORY_PAGE_LIMIT` failure.
* A halted feed returns `HISTORY_STALLED`, an empty/out-of-range page returns `HISTORY_OUT_OF_RANGE`, and switched target/symbol returns `TARGET_CHANGED` / `CHART_CHANGED` (no partial-success data).
* Bar data are from the TradingView **chart's selected feed**, not a consolidated trade tape. BATS feeds may have materially different intraday volume than NASDAQ/CTA full-market data.
* No claim of production-ready multi-month 1m history until tested against a live Premium session on an isolated chart and verified for reproducible timestamps, DST/session boundaries and continuous date coverage.

## Tests

`npm test` includes `tests/ohlcv_history.test.js`. The mocked suite covers 22,500 unique 1m bars, cursor paging, strict time boundaries, zero-fetch when cache is sufficient, source switching, target switching, stalled loading, invalid/duplicate bars and UTC identity. The column-format tests cover 8,000-bar lossless conversion, cursor continuation, count validation and an explicit payload-size rejection. These are **unit tests**, not a live Premium entitlement or ChatGPT transport test.

## Live smoke evidence, 2026-10-23

On a newly created isolated `DTV OHLCV QA 20261023` TradingView Desktop layout, 1-minute `BATS:NVDA` bars loaded from 300 to 1,300 and then to 2,300 through two successive `requestMoreData(1000)` calls. A bounded QA scan found 2,300 strictly increasing unique UTC timestamps; no user/worker chart was used. This **verifies the underlying provider paging mechanism**, not the merged MCP history endpoint or a 20,000-bar production run. The later live MCP test below exercised the guarded endpoint.


## Live MCP verification, 2026-11-20

On the dedicated OHLCV QA layout, the deployed Desktop bridge returned 8,300 unique closed 1m bars for `BATS:AMD` across nine pages. The initial `has_more=false` stopped inside the requested 30-calendar-day interval. After one targeted `chart_set_visible_range`, the same exclusive `before_time` returned 1,000 earlier bars with no extra provider history load in that call. The page boundary matched to the minute. A subsequent run reached the requested interval with 9,000 unique closed bars, including 390 regular-session minutes on each of the 22 trading dates in range. Results are feed- and session-specific; verify coverage for each request.
