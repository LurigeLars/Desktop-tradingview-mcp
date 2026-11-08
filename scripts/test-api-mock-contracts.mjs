#!/usr/bin/env node
/**
 * Mock-contract smoke test for the live TradingView Desktop API implementation.
 * Uses the page's actual prototype methods with FAKE receivers; does not mutate
 * the real chart, saved layouts, user identity, broker, or remote storage.
 * Tests delegation and lifecycle contracts, NOT server/broker integration.
 *
 * Usage: node scripts/test-api-mock-contracts.mjs --target <CDP_TARGET_ID>
 */
import CDP from 'chrome-remote-interface';
import assert from 'node:assert/strict';

const argv = process.argv.slice(2);
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : null;
const port = Number(process.env.TV_CDP_PORT || 9222);
if (!target || !/^[0-9a-f]{32}$/i.test(target)) throw new Error('Explicit CDP target ID required');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
const tabs = await CDP.List({ host: '127.0.0.1', port });
const tab = tabs.find(t => t.id === target && t.type === 'page');
if (!tab || !/^https:\/\/([a-z0-9-]+\.)*tradingview\.com\//i.test(tab.url)) {
  throw new Error('Target must be a verified TradingView page');
}
const client = await CDP({ host: '127.0.0.1', port, target });
try {
  const expression = `(async function () {
    const api = window.TradingViewApi;
    if (!api?._activeChartWidgetWV?.value()) throw Error('TradingView API unavailable');
    const chart = api._activeChartWidgetWV.value();
    const collection = api._chartWidgetCollection;
    const passed = [];
    const check = (condition, name) => { if (!condition) throw Error('Mock contract failed: ' + name); passed.push(name); };
    const calls = [];
    const fakeApi = Object.create(Object.getPrototypeOf(api));
    fakeApi._saveLoad = { backend: { removeChart: async id => calls.push(['remove', id]) } };
    await fakeApi.removeChartFromServer('MOCK_ID', () => calls.push(['removed_callback']));
    check(calls.some(x => x[0] === 'remove' && x[1] === 'MOCK_ID') && calls.some(x => x[0] === 'removed_callback'), 'removeChartFromServer');

    fakeApi._saveChartService = {
      saveChartSilently: (...args) => calls.push(['save', ...args]),
      saveChartOrShowTitleDialog: (...args) => { calls.push(['saveDialog']); args[1]?.(); },
    };
    fakeApi.saveChartToServer('MOCK_ID');
    check(calls.some(x => x[0] === 'save'), 'saveChartToServer');
    fakeApi.saveChartOrShowTitleDialog(() => {}, () => {});
    check(calls.some(x => x[0] === 'saveDialog'), 'saveChartOrShowTitleDialog');

    fakeApi._communityServices = { publishChart: value => ({ received: value }) };
    check(fakeApi.publishChart('MOCK')?.received === 'MOCK', 'publishChart');
    fakeApi._loadChartService = {
      loadChart: async (...args) => calls.push(['load', ...args]),
      loadChartByUrl: async (...args) => calls.push(['loadUrl', ...args]),
    };
    await fakeApi.loadChartFromServer('MOCK_ID');
    await fakeApi.loadLayoutFromServerByLayoutId('MOCK_ID', false, null);
    check(calls.some(x => x[0] === 'load'), 'loadChartFromServer');
    check(calls.some(x => x[0] === 'loadUrl'), 'loadLayoutFromServerByLayoutId');

    const fakeChart = Object.create(Object.getPrototypeOf(chart));
    fakeChart._createTradingPrimitive = kind => Promise.resolve({ kind });
    for (const [method, kind] of [
      ['createExecutionShape', 'LineToolExecution'],
      ['createOrderLine', 'LineToolOrder'],
      ['createPositionLine', 'LineToolPosition'],
    ]) {
      check((await fakeChart[method]()).kind === kind, method + ' delegation');
    }
    fakeChart._zoomUndoStackIsNotEmpty = { destroy: () => calls.push(['zoomDestroyed']) };
    fakeChart._chartWidget = {
      hasModel: () => false,
      modelCreated: () => ({ unsubscribeAll: () => calls.push(['modelUnsubscribed']) }),
    };
    fakeChart._widgetLinkingGroupIndex = { destroy: () => calls.push(['linkDestroyed']) };
    fakeChart._destroy();
    check(calls.some(x => x[0] === 'linkDestroyed'), 'chart._destroy');

    const fakeCollection = Object.create(Object.getPrototypeOf(collection));
    fakeCollection._chartWidgetsDefs = [{ chartWidget: { id: () => 1 } }, { chartWidget: { id: () => 2 } }];
    fakeCollection._activeIndex = 0;
    fakeCollection._updateLayout = () => {};
    fakeCollection._chartsSwappedDelegate = { fire: () => {} };
    fakeCollection._swapCharts(fakeCollection._chartWidgetsDefs[0].chartWidget, fakeCollection._chartWidgetsDefs[1].chartWidget);
    check(fakeCollection._activeIndex === 1 && fakeCollection._chartWidgetsDefs[0].chartWidget.id() === 2, 'collection._swapCharts');

    fakeCollection._saveChartService = { saveChartOrShowTitleDialog: (cancel, resolve) => resolve('MOCK_SAVED') };
    check((await fakeCollection.saveLayoutState()) === 'MOCK_SAVED', 'collection.saveLayoutState');


    const newWidget = { modelCreated: () => ({ subscribe: () => calls.push(['newWidgetSubscribed']) }) };
    const fakeAdd = Object.create(Object.getPrototypeOf(collection));
    fakeAdd._savedChartWidgetOptions = [];
    fakeAdd._getCopiedChartStateAsWidgetContent = () => ({ content: { chartId: 'MOCK' } });
    fakeAdd._widgetOptions = {};
    fakeAdd._symbolLock = { value: () => false };
    fakeAdd._createChartWidget = options => {
      calls.push(['createdWidget', options.content.chartId]);
      return { chartWidget: newWidget };
    };
    check(fakeAdd._addNewChartWidget(0).chartWidget === newWidget &&
      calls.some(x => x[0] === 'createdWidget' && x[1] === 'MOCK') &&
      calls.some(x => x[0] === 'newWidgetSubscribed'), 'collection._addNewChartWidget');

    const themeModel = {
      restoreTheme: () => calls.push(['restoredTheme']),
      colorStudiesPropertiesReady: () => Promise.resolve(),
    };
    const themeWidget = { model: () => ({ model: () => themeModel }) };
    const fakeTheme = Object.create(Object.getPrototypeOf(collection));
    fakeTheme._hasChartsAbovePlanLimit = () => false;
    fakeTheme._savedChartWidgetOptions = [];
    fakeTheme._chartWidgetsDefs = [{ chartWidget: themeWidget }];
    fakeTheme.activeChartWidget = { value: () => themeWidget };
    fakeTheme._returnChartsToContent = async () => {};
    await fakeTheme.applyTheme({ theme: { mock: true }, onlyActiveChart: true, noUndo: true });
    check(calls.some(x => x[0] === 'restoredTheme'), 'collection.applyTheme');

    return { count: passed.length, passed, isolation: 'fake receivers, no real server/broker mutation' };
  })()`;
  const response = await client.Runtime.evaluate({
    expression, awaitPromise: true, returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'CDP runtime exception');
  }
  const value = response.result?.value;
  assert.equal(value?.count, 14);
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
} finally {
  await client.close();
}
