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
