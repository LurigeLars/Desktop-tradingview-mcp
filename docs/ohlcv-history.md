# DTV paginated OHLCV history

Read historical candles from the **currently attached** TradingView Desktop chart using `data_get_ohlcv_history`. This is a separate read-only tool; the existing `data_get_ohlcv` calls without an explicit `history` object retain their original 500-bar contract. Some ChatGPT clients cap the number of exposed MCP tools; in those clients use `data_get_ohlcv({"history":{"expected_symbol":"BATS:NVDA","expected_resolution":"1","count":1000}})` to access the identical guarded history path through the already-exposed tool.

## Procedure

1. Attach to a **dedicated non-worker research chart** with `tab_attach`, then verify `chart_get_state`. Worker chart targets are now rejected by code, not just guidance. Never use a portfolio worker or another user's active trading layout for research.
2. Set the desired symbol and resolution with the existing chart tools **before** starting the history read.
3. Use the **exact returned symbol** and resolution in each history request. For example, a requested NASDAQ:NVDA may resolve to BATS:NVDA, with feed-dependent prices/volumes.
4. First request (example):

```json
{"expected_symbol":"BATS:NVDA","expected_resolution":"1","count":1000}
```

5. For the next, older page, pass `next_cursor` **verbatim** with the same `expected_symbol`, `expected_resolution`, **and the exact CDP chart target**. A cursor is invalid after switching to another chart or restarting Desktop; restart pagination there. Alternatively pass a Unix UTC `before_time` (seconds), strictly earlier than that timestamp, but never pass both.
6. Continue while `has_more` is true. Check `first_time` / `last_time` (UTC seconds), `returned`, `pages_loaded`, `total_loaded`, `target_id` and `source`. Deduplicate by symbol/resolution/time when aggregating.

The tool caches no history locally and never edits chart studies, Pine scripts, orders or saved layouts. It requests older history through the attached chart's existing `requestMoreData(1000)` API. The whole function is serialized with other history reads, and validates CDP target, symbol, and resolution before and after each page of lazy loading.

## Limits and failure modes

* Up to 1,000 bars per response; request 20+ pages to retrieve 20,000 bars. Larger **account-side** history limits do not automatically mean the feed offers this much history.
* Each request may initiate at most 30 provider history loads; retry with explicit `before_time` or another valid cursor only after investigating a `HISTORY_PAGE_LIMIT` failure.
* A halted feed returns `HISTORY_STALLED`, an empty/out-of-range page returns `HISTORY_OUT_OF_RANGE`, and switched target/symbol returns `TARGET_CHANGED` / `CHART_CHANGED` (no partial-success data).
* Bar data are from the TradingView **chart's selected feed**, not a consolidated trade tape. BATS feeds may have materially different intraday volume than NASDAQ/CTA full-market data.
* No claim of production-ready multi-month 1m history until tested against a live Premium session on an isolated chart and verified for reproducible timestamps, DST/session boundaries and continuous date coverage.

## Tests

`npm test` includes `tests/ohlcv_history.test.js`. The mocked suite covers 22,500 unique 1m bars, cursor paging, strict time boundaries, zero-fetch when cache is sufficient, source switching, target switching, stalled loading, invalid/duplicate bars and UTC identity. These are **unit tests**, not a live Premium entitlement test.

## Live smoke evidence, 2026-10-23

On a newly created isolated `DTV OHLCV QA 20261023` TradingView Desktop layout, 1-minute `BATS:NVDA` bars loaded from 300 to 1,300 and then to 2,300 through two successive `requestMoreData(1000)` calls. A bounded QA scan found 2,300 strictly increasing unique UTC timestamps; no user/worker chart was used. This **verifies the underlying provider paging mechanism**, not the merged MCP history endpoint or a 20,000-bar production run. The new endpoint remains a draft until protected client registration, CI and live multi-page testing are completed.
