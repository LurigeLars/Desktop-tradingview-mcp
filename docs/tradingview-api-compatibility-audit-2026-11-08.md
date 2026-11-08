# TradingView Desktop JavaScript API compatibility audit — 2026-11-08

Target: isolated research layout `dUXOqLiw` (BATS:NVDA, 1D). This is **not** a complete validation of all API methods. No worker tabs were modified.

## Inventory
Own + up to two prototype levels: chart 197 property names, chart collection 298, TradingViewApi 229. These counts include non-functions, inherited Object methods, and private methods. They are *not* counts of working APIs.

## Verified functional, non-destructive reads
- Chart: `symbol`, `symbolExt`, `resolution`, `chartType`, `getAllStudies`, `getAllShapes`, `getVisibleRange`, `getVisibleBarsRange`, `getVisiblePriceRange`, `getTimeScaleLogicalRange`, `getTimezone`, `getAllPanesHeight`, `getPanes`, `getSeries`, `getTimeScale`, `getPriceToBarRatio`, `isMaximized`, `hasModel`, `loadingScreenActive`, `marketStatus`, `replayStatus`, `getLineToolsState`, `chartTemplate`, `getStudyTemplateSnapshot`.
- Chart collection: `getAll`, `allSymbols`, `chartsSymbols`, `liveChartsCount`, `hasChanges`, `readOnly`, `layoutSizesChanged`.
- TradingViewApi: `chartsCount`, `charts`, `chart`, `activeChart`, `layoutId`, `layoutName`, `getIntervals`, `supportedChartTypes`, `hasChartChanges`, `getSymbolInterval`, `isConnected`, `hasPendingStudiesModuleLoading`, `hasPendingLineToolsModuleLoading`.
- Main series: `bars`, `symbol`, `data`, `firstValue`, `requestMoreDataAvailable`; `bars().size/firstIndex/lastIndex/valueAt` returned 300 bars and valid NVDA OHLCV.

These are successful invocations, not necessarily comprehensive semantic or cross-version compatibility tests.

## Exists but unsupported / throws
- Chart `exportData`: exact runtime implementation `exportData(e){return Promise.reject("Data export is not supported")}`. Rejection independently observed.
- TradingViewApi `getStudiesList`, `getStudyInputs`, `getStudyStyles`: throw `not implemented`.
- TradingViewApi `hasVisibleToasts`: throws `hasVisibleToasts is null`.

## Present, not fully tested
- `setSymbol`, `setResolution`: present and independently used successfully by DTV tools; note `chart_ready:false` may occur immediately after switching.
- `dataReady`, `clientSnapshot`, `getSavedCharts`: returned Promises but were not awaited/validated in this audit.
- All destructive/state-mutating methods (remove, save, draw, load, layout changes, trading/order actions) deliberately not invoked.
- All private methods and remaining enumerated functions not individually behavior-tested.

## Fix
PR #183 replaces batch `exportData` with the existing direct main-series OHLCV reader and validates symbol/resolution. Pending regression and deployment.

## Next validation phases
1. Compare upstream repo version/commit and discover added/removed methods.
2. Add read-only contract tests for documented public methods and known stub functions.
3. Test reversible chart changes on a disposable research layout only, with before/after state and cleanup.
4. Do not call trading, order, account, destructive chart, or worker mutation APIs in an audit.

## Extended audit and upstream comparison
- Compared `src/core/batch.js` with `tradesdontlie/tradingview-mcp`: **identical blob SHA** `11246978cc622b70b33834f76f28da507d27c61a` on both default branches. The unsupported `exportData` usage is inherited upstream, not introduced in this fork.
- Live method inventory: **523 callable method names** (chart 166, collection 184, TradingViewApi 173), excluding common Object prototype helpers. Complete names are in `tradingview-api-method-inventory-2026-11-08.json`. These are *presence observations*, not 523 functional tests.
- Inspected actual function bodies: `chart.exportData(e)` always returns `Promise.reject("Data export is not supported")`; `chart.setVisibleRange(e,t)` always throws `Not implemented`. `chart.ranges()` is conditional on an injected date-range API and cannot be classified as globally unsupported.
- TradingViewApi `getStudiesList()`, `getStudyInputs()`, `getStudyStyles()` each threw `not implemented` on this session. `hasVisibleToasts()` threw `hasVisibleToasts is null`.
- Reversible integration test on research layout: `chart_set_timeframe(W)` changed 1D→1W and `chart_set_timeframe(D)` restored 1D, both returned `chart_ready:true`. `chart_set_symbol(NASDAQ:MSFT)` changed state to BATS:MSFT, direct OHLCV read returned five MSFT bars; switching back restored BATS:NVDA. Symbol setter returned `chart_ready:false` despite the chart subsequently reporting the requested symbol; batch code must verify the *main series*, not just the setter response.
- Read-only Promise probes: `collection.clientSnapshot()` fulfilled with an object; `chart.dataReady()` and `TradingViewApi.getSavedCharts()` remained pending during observation. **Pending is not failure**; do not assume they are unsupported.
- CI on PR commit `40b30068f041ba2b1b1628fe02cd0dc6adb6f918`: Fork CI, CI, Static analysis and CodeQL all succeeded; Fork CI includes a successful unit-test step. Subsequent inventory-only commit does not change runtime behavior.

## Risk and completion boundary
Calling every one of 523 methods would trigger destructive chart, trading, replay, save, deletion, account or UI actions. Those methods are **intentionally not executed**. Full behavior verification requires isolated disposable state, appropriate permissions, explicit test contracts and rollback, not blanket invocation. No broker orders or worker mutations were performed.

## Next operational step
Merge the verified source fix only after final PR checks, update the local Desktop MCP service from the merged commit, and rerun `batch_run` on the research layout. Until local deployment, the connected MCP still uses the old `exportData` implementation.

## Additional non-destructive probes
A second read-only round increased successful method invocations to **81 of 523**. New working chart getters include `getBarsMarksSources`, `getLollipopSourcesApi`, `getTimezoneApi`, `isPriceToBarRatioLocked`, `isSelectBarRequested`, `priceFormatter`, `properties`, `scrollPosition`, `sessions`, `selection`, `symbolResolvingActive`, `getStudyById`, `getStudyTemplateDescString`, and `getEntityValues`. Additional API/collection getters also returned successfully; see per-method JSON.

New unsupported or conditional behavior:
- `TradingViewApi.getFavoriteIntervalsService()` and `getFavoriteChartStylesService()` threw `not implemented`.
- `chart.inactivityGaps()` threw `inactivity_gaps featureset is not enabled` (feature-gated, not necessarily removed).
- `chart.getShapeById(nonexistent)` threw `There is no such shape` (expected negative-path error, not a broken method).
- `chart.chartPainted()` and `TradingViewApi.getChartStorage()` returned Promises not awaited in this audit.

Repeatable presence inventory: `node scripts/audit-live-api.mjs --target <EXPLICIT_CDP_TARGET_ID> --output audit.json`. The script refuses implicit target selection, does not mutate the UI, and writes a new file without overwriting an existing one. It inventories methods and possible stubs; it does not automatically execute dangerous methods.

The 523-method inventory is now fully status-classified, but **428 remain present/not behavior-tested**. Treat them as unknown, not failed or supported.

## Follow-up verification — 2026-11-08
- Reattached to dedicated research target `02AF63D03D43D7ED809684A008714E1A`, chart BATS:NVDA at 1D.
- Re-enumerated chart 166, collection 184, TradingViewApi 173 methods. Zero additions/removals versus the 523-method inventory.
- Re-invoked 14 read-only chart methods successfully (studies, shapes, visible ranges, time scale, market/replay status).
- The remaining untested methods cannot be marked working based solely on presence. Mutating and trading methods require disposable fixtures and appropriate safe test contracts.

## Additional API read-only probes
- Expanded successful direct invocations to **122 methods** across the three inventoried objects. Presence-only methods now **372**. Status JSON updated individually.
- `TradingViewApi.news`, `watchlist`, `watermark`, `webview`, and `widgetbar` all throw `not implemented` in this runtime; treat them as unsupported entrypoints, not proof the UI feature is absent.
- `collection.state` and `TradingViewApi.chartWidgetCollectionState` require arguments; `chart.whenChartReady` requires callback; `chart.availableZOrderOperations` requires selection/arguments. These are not classified as broken.
- Six newly probed methods returned unresolved Promises; do not classify as success or failure without awaited completion.
- No trading/order methods were invoked, and no charts were modified during these read-only probes.

## Context-safe API verification
- Additional probes confirm that **method invocation must preserve the owning object as `this`**. Calling detached methods such as `const f = chart.chartModel; f()` produces misleading `Cannot read properties of undefined` errors. Calling `chart.chartModel()` succeeds. These are test-harness errors, not TradingView API regressions.
- 149 methods now have successful invocation evidence, 335 remain untested, and 18 Promise-returning methods need awaited validation. Full status in the machine-readable inventory.
- Read-only follow-up confirmed BATS:NVDA 1D, one study, zero shapes, and successful chart, collection and API getters. No order or layout mutation.

## Asynchronous and argument-aware verification
- Retested Promise-returning methods and observed actual fulfillment: `chart.dataReady`, `TradingViewApi.getSavedCharts` (24 saved-chart entries), `collection.clientSnapshot`, `TradingViewApi.alerts`, `currencies` (256), `replayApi`, `units`, `chart.actionsProvider`, and `collection.generalPropertiesDefinitions` (7 entries).
- `chart.chartPainted()` remained pending at observation; do not classify as broken.
- `collection.state({withData:false})` and `chart.whenChartReady(callback)` accepted valid arguments and returned without throwing. Other private methods that require model/selection arguments remain unverified.
- **166** successful method invocations, **324** not behavior-tested. The chart was BATS:XOM 1D when this audit began; this audit did not change its symbol or timeframe.

## Internal accessor verification with real arguments
- Verified 200 successful method invocations; 277 methods remain not behavior-tested. The attached research chart was BATS:XOM 1D (changed externally since prior audit); no symbol/timeframe change was made.
- Confirmed private chart API accessors `_getPaneApi` and `_getStudyApi` work when passed actual chart-model pane and study objects, and `_getChartWidgetApi` works with a real widget. Incorrect/missing arguments previously produced misleading exceptions.
- `getFavoriteCurrencyUnitConversionApi` and `getLinetoolsFavoritesStore` throw `not implemented` in the running client.
- Seven internal methods require model/context arguments; their failure on dummy arguments is not classified as an implementation defect. Promise-returning loader methods remain unawaited.
- Destructive UI, trading, order, and account methods were deliberately not invoked.

## Safety classification and completion boundary
- **209/523** methods successfully invoked; **270** still lack behavior tests. These are not implicitly functional.
- Confirmed private accessors `_getStateForChartImpl`, `_getSubscriptionObjectForChartModel`, `_getCopiedChartStateAsWidgetContent`, `_getVisuallyAdjacentDef`, `_convertPositionPercentToDataSource` with real chart/model arguments.
- Source inspection identifies potentially destructive methods: `chart._destroy`, `collection.destroy`, `api.destroy`, `api.disconnect`, `chart.createOrderLine`, `chart.createPositionLine`, `api.removeChartFromServer`, chart/layout saves, drawing deletion, and trading/broker setup. They MUST NOT be run against a live chart/account solely to improve test counts.
- The attached research tab is a live TradingView layout, not a disposable fixture. A new isolated chart or test harness is required to validate mutators without risking saved layouts. A second test account/sandbox would be required for actual broker/order side effects.
- **Do not describe the audit as fully behavior verified.** Full inventory coverage is achieved; remaining statuses are explicit verification gaps, not established bugs.
