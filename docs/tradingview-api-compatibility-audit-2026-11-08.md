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

## Isolated sandbox created and exercised
- Created a new dedicated Desktop layout `API Audit Sandbox 2026-11-08`, CDP target `6CBB540B104EBB0698D9EE42A6BD5D34`, chart `IN9aj8GI`. This is separate from the existing research tab. User authorized expanding the test environment.
- Successfully exercised reversible chart/UI mutations: scrolling/zoom toggles, chart timezone, bar spacing, drawing creation/removal, all-shapes/all-studies removal, chart type, resolution, symbol, collection layout, UI preferences, and data refresh. No broker orders or server chart deletions.
- Awaited 13 additional chart/collection/lazy-loader promises: all fulfilled except `chart.createStudy('MASimple',...)`, which rejected `unexpected study id:masimple` (invalid study identifier; not proof that study creation is broken).
- **268 methods successfully invoked**, **218 untested**. Final sandbox chart NASDAQ:NVDA 1D, zero shapes and studies. Existing research charts untouched.
- Remaining 218 methods include private callbacks, account/server mutators, replay/trading operations, and methods requiring particular application states. They are not safely callable with arbitrary arguments; use test fixtures and method-specific contracts before marking working.

## Complete method mapping, distinct from full behavioral certification
- The live runtime now has a **523/523 method-level map** in `tradingview-api-method-inventory-2026-11-08.json`. Each entry contains owner (`chart`, `collection`, `api`), name, `Function.length` arity, a short actual runtime function-source excerpt, public/private marker, conservative side-effect risk screen, precise observed test status, and suggested fixture for any follow-up test.
- **312/523 methods have successful invocation evidence.** Remaining **172 are explicitly marked `present_not_behavior_tested`**; the others have specific unresolved, unsupported, or rejected statuses. Method presence/signature mapping is complete; full functional certification is **not** complete.
- Conservative risk triage (name-based, not a security guarantee): 31 potentially account/destructive, 222 state-changing or event subscription, 81 private/internal, 189 read/pure candidates. These categories do not imply that untested methods work.
- New isolated chart tests confirmed multi-point and anchored drawing creation, clone and z-order operations, cleanup, event subscription and UI settings. `api.resetCache` throws `not implemented`. `chart.setInactivityGapsSession` failed on missing session context, not established as a product defect.
- No real orders, account mutation, layout deletion, or broker connection changes were performed. The user authorized creation of test fixtures, but authorization does not make a production brokerage account a safe fixture for order methods.

## Final extended runtime pass
- Runtime inventory/signature map remains **523/523**. Verified successful invocations increased to **399/523** using the isolated chart. **61** are still `present_not_behavior_tested`; another **63** have explicitly recorded unsupported, invalid-argument, unawaited-Promise or context-dependent statuses. Do not confuse signature inspection with successful behavior.
- Confirmed controller callbacks, sync/lock handlers, drawing z-order, chart navigation, and optional UI API stubs. `resetCache`, `setNewsApiPromise`, `setWatchlistApiPromise`, and `setWidgetbarApiPromise` throw `not implemented` in this runtime.
- `createGoProDialog` needs a feature argument. Methods tied to live broker order/position primitives, publishing, account identity, saved server-chart deletion, and destruction of live chart/controller state are **not safe to certify against an authenticated account**. These require mocked brokerage/server fixtures and/or a separate non-authenticated test profile, not merely another tab in the same session.
- Audit sandbox cleanup: temporary drawing objects removed, dialogs closed, fullscreen exited. Final observed chart NASDAQ:NVDA 1D, zero shapes. No real orders or server chart deletions.
- **Conclusion: method mapping complete; behavior certification incomplete**. Follow-up engineering work should build fixture-specific contract tests rather than claiming 523 working methods.

## Final method-by-method disposition (2026-11-08)
- **523/523 methods** have a runtime signature, source excerpt, risk screen, and explicit disposition in the JSON inventory. No `present_not_behavior_tested` statuses remain: the remaining 42 were individually assigned a **fixture requirement**, not falsely counted as working.
- **411** successfully invoked. The other **112** have distinct evidence/fixture states, including 17 requiring a specific widget/UI fixture, 15 requiring isolated brokerage or destructive-state fixtures, 10 requiring disposable server-layout fixtures, 19 requiring valid arguments, 18 pending Promise observation, and 16 confirmed `not implemented` exceptions.
- Verified safe screenshot success. `takeServerScreenshot` rejected because the page was not focused and clipboard write was denied; this is a browser focus precondition, not proof the screenshot code is broken. Study template calls with invalid records were rejected.
- **Definition of complete here:** runtime method discovery and verification triage, not 523 successful production calls. Full behavior certification of broker/account/destructive endpoints would require an independent fake broker/server or non-production TradingView account; a chart tab on the authenticated user session is not that isolation.
- The sandbox chart was cleaned up; no orders, server deletions, or account identity changes were executed. This audit should be considered a complete compatibility *map* with explicitly outstanding contract tests.

## Extended test closure — evidence ledger
- All **523** method names, live function arities, source excerpts and risk classes are recorded in the machine-readable inventory. Every method has a specific observed outcome or a named fixture requirement; none is silently assumed to work.
- Latest reconciliation: **442 successful live invocations**, **24 isolated mock-contract verifications**, **57 remaining unresolved/unsupported/context-dependent methods**. Mock contracts are explicitly not live integration tests.
- The isolated fake-receiver tests exercised chart destruction cleanup, trading primitive *delegation only*, save/remove/publish backend delegation, broker session disconnect and identity handling (recompiled exact runtime body against fake globals), chart layout swap, save/load layout delegation, and chart metrics. No real order, publication, account identity change or server deletion was performed.
- Real chart fixture tests additionally verified `createStudy('Moving Average')`, `waitForStudyCreated` with an actual returned study ID, `createStudyTemplate` → `applyStudyTemplate` round trip, drawing creation → `_getLineDataSourceApi`, and `changeSymbol` with a valid interval. Test study and drawing were removed.
- New `tests/api_inventory.test.js` checks exact 523-method completeness, per-method source/arity/status consistency, risk categories, and reconciled status totals. `scripts/test-api-mock-contracts.mjs` provides a repeatable CDP test against explicit TradingView target using fake receivers only. It must run on the local Desktop host; hosted CI cannot reach the user's laptop.
- **Hard limit:** at least 17 APIs throw `not implemented` in the installed TradingView runtime; some others require unavailable broker/feature/server context. These cannot be legitimately certified as working without replacing/upgrading the underlying proprietary TradingView implementation. The compatibility map is complete; full positive certification of 523 is not achievable by test-environment expansion alone.
- CI/CodeQL checks and protected-branch merge are independent completion gates; do not bypass branch rules.

## Verified end-state and repeatable checks
- Final audited inventory: **523/523 classified**, **446 live-invoked successfully**, **27 exact-runtime mock contracts verified**, **50 with non-successful or unavailable-context dispositions**. The 27 mocked contracts are *not* proof of backend or broker integration.
- The live research sandbox is isolated from the user's ordinary layouts. Latest cleanup removed all temporary shapes and moving-average studies; only the default Volume study remained.
- Run the invariant suite with `npm test` (also `npm run test:unit` or `npm run test:all`). It validates exact inventory coverage, source metadata, status consistency, and no fabricated successful statuses. These commands syntax-check the CDP mock runner as well.
- Run the 12-contract smoke test on the laptop with `node scripts/test-api-mock-contracts.mjs --target <SANDBOX_CDP_TARGET_ID>`, using a fresh ID from `tv tab list`. It checks mock receiver behavior only; it never touches a real broker/server endpoint.
- Known hard blockers include **17 methods throwing `not implemented`** in the installed proprietary TradingView API, one `exportData` unsupported stub, and context-dependent feature/clipboard/paint events. The current implementation cannot be made to return successful results for all 523 by adding test fixtures. Distinguish unsupported upstream APIs from faults in the DTV MCP bridge.
- A protected PR merge must wait for CI and CodeQL success; never disable branch protection merely to merge audit documentation.

## Follow-up: remaining context-dependent API contracts
- New verification pass: **448 live successful**, **31 isolated mock contracts**, **44 unresolved or upstream unsupported** (523 total). These are method-level dispositions, not 479 proven end-to-end integrations.
- Live tests: `chart.applyStudyTemplateByRecord(null)` resolves without action, as specified by its implementation; `collection._applySharedLineToolsDto(chartWidget, new Map())` completes the empty sharing-group path.
- Fake-widget tests: `collection._setInitialSizes`, `collection._updateLayoutPartial`, `collection._subscribeToEventsForDateRangeSync`, and `collection._unsubscribeFromEventsForDateRangeSync` execute against disposable model/geometry/event fixtures. This tests the actual runtime prototype functions without altering the authenticated layout.
- Remaining `chart.setVisibleRange` explicitly throws `Not implemented`. Calling it again cannot turn it into a supported method. `chart.exportData` is a separate unsupported runtime stub; `chart.inactivityGaps` requires a feature-enabled environment. TradingView proprietary API methods throwing `not implemented` are classified as upstream unsupported, not fixed by this bridge.
- **Safety:** live account, broker, saved-layout deletion, and publishing calls must remain outside the test scope unless replaced by a genuinely isolated backend. No such live mutations were performed.

## Second targeted fixture pass
- **448 live calls**, **46 isolated mock-contract tests**, **29 unresolved or explicitly unsupported** methods (523 total). These categories are not interchangeable: a mock is not an end-to-end broker integration.
- Newly isolated: chart z-order insertion (`insertBefore`, `insertAfter`), study insertion metadata, inactivity-gap session forwarding, model-event wiring, date-range completion subscriptions, replay-selection watcher, broker-login event bus, dummy broker controller, trading readiness, toast status, feature paywall, support and publication popup delegation.
- Notable finding: `_someOfWidgetsAreInSelectingReplayPointMode` fails with `Cannot access 'a' before initialization` when an already-loaded chart widget is passed, due to a callback referencing `const a` before initialization. A not-yet-loaded widget fixture takes a different successful path. This should be treated as a **real upstream runtime defect candidate**, not blindly marked fully working.
- Do not claim the remaining 29 are fixable through test environments alone: at least 18 are direct `not implemented` methods, plus unsupported/disabled features, UI focus and unresolved integration contexts.

## Third targeted fixture pass
- **448 live invocations + 51 isolated mock contracts + 24 non-positive outcomes = 523 inventoried methods**. This does not mean 499 end-to-end tested features: mock results prove isolated delegation only.
- Added mock coverage for `chart.chartPainted`, `chart.inactivityGaps`, `collection._createSeriesControlWidget` (early-destroy path), `collection.takeServerScreenshot` (stubbed snapshot/clipboard service), and `collection.trackChangeSymbol` (analytics delegation). Browser-focus and network screenshot integration remain unverified.
- Remaining 24 include 18 explicit `not implemented` methods, one unsupported export stub, plus chart-widget creation, theme, layout loading and restore-paywall contexts. Their absence is **not** a test pass. The inventory records each explicitly.

## Fourth fixture pass — evidence corrections
- **448 live invocations, 52 mock contracts, 23 non-positive/partial methods = 523**. Mock coverage is not end-to-end verification.
- Added repeatable isolated contract checks for `collection._addNewChartWidget` and `collection.applyTheme` (no-undo theme restoration on a fake chart model) to the CDP mock runner, increasing its expected assertions from 12 to 14. These exact prototype methods also passed interactive fake-receiver calls.
- **Corrected overclaim:** `_someOfWidgetsAreInSelectingReplayPointMode` previously counted as a mock success despite an observed temporal-dead-zone exception on the loaded-widget path (`Cannot access 'a' before initialization`). It is now classified as **partial**; only the unloaded-widget path was observed to complete.
- Remaining 23: 18 explicitly not implemented, one unsupported export stub, two chart-widget construction contexts, one server layout loading context, and the partial replay watcher. No authenticated account, server layout, or broker destructive operations were used.

## Fifth fixture pass — supported conditional paths
- **448 live invocations, 58 isolated mock contracts, 17 unresolved/unsupported/partial methods**. These categories are invocation evidence, not proof of full functional integration.
- Four favorite-service getters (`getFavoriteChartStylesService`, `getFavoriteCurrencyUnitConversionApi`, `getFavoriteIntervalsService`, `getLinetoolsFavoritesStore`) return the expected service when a valid `_favoriteServices` object is injected. In the observed installed runtime, this object was not initialized and these getters otherwise throw through `Wt()`. Their mock result does **not** establish that favorites work in the user's current TradingView session.
- Reproduced `collection.loadContent(null, false)` empty-layout lifecycle using the exact runtime body and isolated module dependencies. Verified initialization, muted linking during `setLayout('s')`, unmute, and `_loadingContent=false`. This is not a saved-server-layout integration test.
- Reproduced `_openRestoreLayoutPaywall` arrow closure with an isolated layout count and fake paywall/analytics services. Verified `restoreLayout` tracking and forwarded paywall limit; no actual paywall was opened.
- CDP mock runner now contains **21 assertions** including these six new contracts and a source-level replay callback-order regression guard. The replay watcher remains **partial** because its loaded-widget path can throw a temporal-dead-zone error.
- Remaining 17: 13 direct `Wt()` failures, `chart.setVisibleRange` throwing `Not implemented`, `chart.exportData` rejecting `Data export is not supported`, one chart-widget constructor fixture, and one partial replay watcher. The 15 direct stubs cannot be made functional by simply changing MCP test fixtures.
