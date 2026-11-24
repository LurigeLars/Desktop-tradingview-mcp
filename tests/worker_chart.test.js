import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { validateChange, planChange, workerChartControl, jsLiteral } from '../src/core/worker-chart.js';
import { replaceWorkerEntry } from '../src/core/worker.js';

test('validation is a strict allowlist: no formulas, code, URLs, unknown studies or object inputs', () => {
  for (const symbol of ['NASDAQ:QQQ/AMEX:SPY', 'https://evil.example', "X:Y');alert(1)//", 'QQQ'])
    assert.throws(() => validateChange({ symbol }), /exchange-qualified/);
  assert.throws(() => validateChange({ timeframe: '0' }), /Unsupported timeframe/);
  assert.throws(() => validateChange({ add_studies: [{ name: 'My Pine Script' }] }), /allowlist/);
  assert.throws(() => validateChange({ add_studies: [{ name: 'VWAP', inputs: { in_0: { toString: 1 } } }] }), /finite number/);
  assert.throws(() => validateChange({ add_studies: [{ name: 'VWAP', inputs: { 'a-b': 1 } }] }), /invalid key/);
  assert.throws(() => validateChange({ visible_range: { from: 10, to: 5 } }), /visible_range/);
  assert.throws(() => validateChange({ extended_hours: 'false' }), /boolean/);
  assert.throws(() => validateChange({}), /No change/);
  const ok = validateChange({ symbol: 'nasdaq:amd', timeframe: '5m', add_studies: [{ name: 'EMA', inputs: { length: 50 } }] });
  assert.equal(ok.symbol, 'NASDAQ:AMD');
  assert.equal(ok.timeframe, '5');
  assert.equal(ok.add_studies[0].createName, 'Exponential moving average');
});

const ema = (id, length) => ({ id, name: 'Exponential moving average', inputs: { in_0: length, in_1: 'close' } });
const baseEntry = { handle: 'trade-x-1m', symbol: 'NASDAQ:CRWV', timeframe: '1',
  studies: [{ name: 'Exponential moving average', inputs: { length: 20 } }, { name: 'Exponential moving average', inputs: { length: 9 } }],
  groups: ['session:extended', 'watch:active_trades'] };

test('plan regenerates the handle only for instrument changes and keeps groups', () => {
  const live = [ema('a', 20), ema('b', 9)];
  const symbol = planChange(baseEntry, validateChange({ symbol: 'NASDAQ:MU' }), live);
  assert.equal(symbol.instrumentChanged, true);
  assert.equal(symbol.live.session, 'extended');
  assert.deepEqual(symbol.next.groups, ['watch:active_trades', 'session:extended']);
  const off = planChange(baseEntry, validateChange({ extended_hours: false }), live);
  assert.equal(off.instrumentChanged, false);
  assert.equal(off.live.session, 'regular');
  assert.deepEqual(off.next.groups, ['watch:active_trades']);
  const studyOnly = planChange(baseEntry, validateChange({ add_studies: [{ name: 'Keltner Channels' }] }), live);
  assert.equal(studyOnly.live.session, null);
  assert.equal(studyOnly.instrumentChanged, false);
});

test('study targeting must be unique and updates the registry spec it satisfied', () => {
  const live = [ema('a', 20), ema('b', 9)];
  assert.throws(() => planChange(baseEntry, validateChange({ remove_studies: [{ name: 'EMA' }] }), live), /matched 2/);
  const removed = planChange(baseEntry, validateChange({ remove_studies: [{ name: 'EMA', match_inputs: { length: 9 } }] }), live);
  assert.deepEqual(removed.ops.remove_ids, ['b']);
  assert.deepEqual(removed.next.studies, [{ name: 'Exponential moving average', inputs: { length: 20 } }]);
  const configured = planChange(baseEntry, validateChange({ configure_studies: [{ name: 'EMA', match_inputs: { length: 20 }, inputs: { in_0: 50 } }] }), live);
  assert.deepEqual(configured.ops.configure, [{ id: 'a', inputs: { in_0: 50 } }]);
  assert.ok(configured.next.studies.some(s => JSON.stringify(s.inputs) === '{"in_0":50}'));
});

test('replaceWorkerEntry keeps order and other assignments and refuses merges', () => {
  let saved = null;
  const state = { version: 1, capacity: 10, reserve_slots: 0, worker_tabs: [], entries: [
    { handle: 'a', key: 'X:A|1', symbol: 'X:A', timeframe: '1', studies: [], groups: [], assignment: { pane_index: 0 } },
    { handle: 'b', key: 'X:B|1', symbol: 'X:B', timeframe: '1', studies: [], groups: [], assignment: { pane_index: 1 } },
  ] };
  const d = { loadState: () => structuredClone(state), saveState: s => { saved = s; }, now: () => 0 };
  assert.throws(() => replaceWorkerEntry({ handle: 'a', entry: { symbol: 'X:B', timeframe: '1' }, assignment: {}, _deps: d }), /merge/);
  const next = replaceWorkerEntry({ handle: 'a', entry: { symbol: 'X:C', timeframe: '1', groups: ['g'] }, assignment: { pane_index: 0 }, _deps: d });
  assert.match(next.handle, /^w_/);
  assert.deepEqual(saved.entries.map(e => e.handle), [next.handle, 'b']);
  assert.deepEqual(saved.entries[1].assignment, { pane_index: 1 });
});

function fakeDesktop({ drift = false, sabotage = null } = {}) {
  const panes = [
    { symbol: 'NASDAQ:CRWV', interval: '1', session: 'extended', subsessions: ['regular', 'extended'], studies: [ema('a', 20), ema('b', 9)], range: { from: 1, to: 2 } },
    { symbol: drift ? 'NYSE:WRONG' : 'NYSE:ORCL', interval: '1', session: 'extended', subsessions: ['regular', 'extended'], studies: [], range: { from: 1, to: 2 } },
  ];
  let seq = 0;
  const times = [1_699_000_000, 1_700_000_000, 1_700_043_200, 1_700_086_400, 1_700_200_000];
  const chartApi = i => {
    const p = panes[i];
    return {
      setSymbol: s => { p.symbol = s; if (sabotage === 'other-pane') panes[1].interval = '5'; },
      setResolution: r => { p.interval = r; },
      _chartWidget: { model: () => ({ mainSeries: () => ({
        symbolInfo: () => ({ subsessions: p.subsessions.map(id => ({ id })) }),
        sessionIdProxyProperty: () => ({ setValue: v => { p.session = v; } }),
        sessionId: () => p.session,
        bars: () => ({ firstIndex: () => 0, lastIndex: () => times.length - 1, valueAt: i => [times[i]] }),
      }), timeScale: () => ({ zoomToBarsRange: (a, b) => { p.range = { from: times[a], to: times[b] }; } }) }) },
      getAllStudies: () => p.studies.map(s => ({ id: s.id, name: s.name })),
      getStudyById: id => { const s = p.studies.find(x => x.id === id); return {
        getInputValues: () => Object.entries(s.inputs).map(([id, value]) => ({ id, value })),
        setInputValues: list => { s.inputs = Object.fromEntries(list.map(x => [x.id, x.value])); },
      }; },
      removeEntity: id => { p.studies = p.studies.filter(s => s.id !== id); },
      createStudy: async name => { const id = 'n' + (++seq); p.studies.push({ id, name, inputs: { in_0: 10 } }); return id; },
      setVisibleRange: async () => { throw new Error('Not implemented'); },
      getVisibleRange: () => p.range,
    };
  };
  const sync = { symbol: true, interval: true };
  const api = { layoutId: () => 'owned', chartsCount: () => 2, chart: chartApi,
    _chartWidgetCollection: { symbolSyncEnabled: () => ({ value: () => sync.symbol, setValue: v => { sync.symbol = v; } }),
      intervalSyncEnabled: () => ({ value: () => sync.interval, setValue: v => { sync.interval = v; } }) },
    hasChartChanges: () => ({ value: () => false }), _saveChartService: { _chartSaver: {} },
    saveChartToServer: done => { api._saveChartService._chartSaver._prevChartState = { content: JSON.stringify({
      symbolLock: sync.symbol, intervalLock: sync.interval,
      charts: panes.map(p => ({ panes: [{ sources: [{ type: 'MainSeries', state: { symbol: p.symbol, interval: p.interval, sessionId: p.session } }] }] })) }) }; done(); } };
  const client = { Runtime: { evaluate: async ({ expression }) => {
    try {
      const value = await runInNewContext(expression, { window: { TradingViewApi: api },
        setTimeout: (fn, ms) => ms === 5000 ? 1 : fn(), clearTimeout: () => {} });
      return { result: { value } };
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  } }, close: async () => {} };
  const entries = [
    { ...baseEntry, assignment: { worker_slot: 0, pane_index: 0, chart_id: 'owned' } },
    { handle: 'orcl', symbol: 'NYSE:ORCL', timeframe: '1', studies: [], groups: ['session:extended'],
      assignment: { worker_slot: 0, pane_index: 1, chart_id: 'owned' } },
  ];
  const state = { worker_tabs: [{ slot: 0, persistent_layout: true, chart_id: 'owned', pane_count: 2 }],
    topology_plan: { tabs: [{ tab_index: 0, handles: ['trade-x-1m', 'orcl'] }] }, entries };
  const recorded = [];
  const deps = { status: () => state, listTargets: async () => [{ id: 't1', url: 'https://www.tradingview.com/chart/owned/' }],
    connect: async () => client, wait: async () => {},
    read: async () => panes.map(p => ({ resolved_symbol: p.symbol, resolution: p.interval, chart_session: p.session,
      studies: p.studies.map(s => ({ name: s.name, inputs: s.inputs })) })),
    replaceEntry: args => { if (args._deps) return { handle: args.handle }; recorded.push(args); return { handle: args.keepHandle ? args.handle : 'w_new' }; } };
  return { panes, deps, recorded };
}

const target = { handle: 'trade-x-1m', slot: 0, pane_index: 0 };

test('identity must match the registry before any attach', async () => {
  const { deps } = fakeDesktop();
  let attached = false;
  deps.connect = async () => { attached = true; };
  await assert.rejects(workerChartControl({ ...target, pane_index: 1, operation: 'read', _deps: deps }), /same registered worker pane/);
  await assert.rejects(workerChartControl({ ...target, handle: 'orcl', operation: 'read', _deps: deps }), /same registered worker pane/);
  assert.equal(attached, false);
});

test('read reports registry, live pane and studies without mutation', async () => {
  const { deps, panes } = fakeDesktop();
  const result = await workerChartControl({ ...target, operation: 'read', _deps: deps });
  assert.equal(result.matches_registry, true);
  assert.deepEqual(result.live.studies.map(s => s.id), ['a', 'b']);
  assert.equal(panes[0].symbol, 'NASDAQ:CRWV');
});

test('update applies one verified change, preserves untouched studies and panes, saves then records', async () => {
  const { deps, panes, recorded } = fakeDesktop();
  const result = await workerChartControl({ ...target, operation: 'update', _deps: deps, symbol: 'NASDAQ:MU',
    remove_studies: [{ name: 'EMA', match_inputs: { length: 9 } }], add_studies: [{ name: 'Keltner Channels' }],
    visible_range: { from: 1_700_000_000, to: 1_700_086_400 } });
  assert.equal(result.persisted, true);
  assert.equal(result.handle_after, 'w_new');
  assert.equal(panes[0].symbol, 'NASDAQ:MU');
  assert.equal(panes[0].session, 'extended');
  assert.deepEqual(panes[0].studies.map(s => s.id), ['a', 'n1']);
  assert.equal(JSON.stringify(panes[0].range), '{"from":1700000000,"to":1700086400}');
  assert.equal(panes[1].symbol, 'NYSE:ORCL');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].keepHandle, false);
  assert.equal(recorded[0].entry.symbol, 'NASDAQ:MU');
});

test('dry run and drifted tabs never mutate; unrelated pane damage is never recorded', async () => {
  let f = fakeDesktop();
  await workerChartControl({ ...target, operation: 'update', dry_run: true, symbol: 'NASDAQ:MU', _deps: f.deps });
  assert.equal(f.panes[0].symbol, 'NASDAQ:CRWV');
  f = fakeDesktop({ drift: true });
  await assert.rejects(workerChartControl({ ...target, operation: 'update', symbol: 'NASDAQ:MU', _deps: f.deps }), /drifted/);
  assert.equal(f.panes[0].symbol, 'NASDAQ:CRWV');
  f = fakeDesktop({ sabotage: 'other-pane' });
  await assert.rejects(workerChartControl({ ...target, operation: 'update', symbol: 'NASDAQ:MU', _deps: f.deps }), /Unrelated pane 1 changed.*Registry unchanged/);
  assert.equal(f.recorded.length, 0);
});

test('unknown study inputs fail before the registry is written', async () => {
  const f = fakeDesktop();
  await assert.rejects(workerChartControl({ ...target, operation: 'update', _deps: f.deps,
    configure_studies: [{ name: 'EMA', match_inputs: { length: 20 }, inputs: { nope: 1 } }] }), /Unknown study input/);
  assert.equal(f.recorded.length, 0);
});

test('embedded literals cannot close a script context and round-trip exactly', () => {
  const ls = String.fromCharCode(0x2028);
  const value = { a: '</script><x>' + ls, b: 'quote" back' + String.fromCharCode(92) };
  const literal = jsLiteral(value);
  assert.equal(/[<>]/.test(literal) || literal.includes(ls), false);
  assert.equal(JSON.stringify(runInNewContext('(' + literal + ')')), JSON.stringify(value));
});
