import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { personalChartExpression } from '../src/connection.js';
import { repairWorker } from '../src/core/worker-repair.js';

test('interactive writes reject workers by stable chart ID after restart, before executing code', () => {
  const expression = personalChartExpression('changed=true; 42', {
    worker_tabs: [{ chart_id: 'owned', target_id: 'old' }],
  });
  const owned = { location: { pathname: '/chart/owned/' }, changed: false };
  assert.throws(() => runInNewContext(expression, owned), /WORKER_TARGET_FORBIDDEN/);
  assert.equal(owned.changed, false);
  const personal = { location: { pathname: '/chart/personal/' }, changed: false };
  assert.equal(runInNewContext(expression, personal), 42);
  assert.equal(personal.changed, true);
});

function fixture() {
  const panes = [
    { resolved_symbol: 'NYSE:WRONG', resolution: '1D', studies: [{ name: 'Volume', inputs: { length: 20 } }] },
    { resolved_symbol: 'NYSE:SECOND', resolution: '1', studies: [] },
  ];
  const state = { worker_tabs: [{ slot: 0, persistent_layout: true, chart_id: 'owned', pane_count: 2 }],
    topology_plan: { tabs: [{ tab_index: 0, handles: ['first', 'second'] }] },
    entries: ['first', 'second'].map((handle, i) => ({ handle, symbol: i ? 'NYSE:SECOND' : 'NYSE:FIRST',
      timeframe: '1', studies: i ? [] : [{ name: 'Volume' }],
      assignment: { worker_slot: 0, pane_index: i, chart_id: 'owned' } })) };
  const sync = { symbol: true, interval: true };
  const calls = [];
  let backups = 0, closes = 0;
  const client = { Runtime: { evaluate: async ({ expression }) => {
    try {
      const collection = { symbolSyncEnabled: () => ({ value: () => sync.symbol,
        setValue: v => { calls.push('symbolSync'); sync.symbol = v; } }),
      intervalSyncEnabled: () => ({ value: () => sync.interval,
        setValue: v => { calls.push('intervalSync'); sync.interval = v; } }) };
      const api = { _chartWidgetCollection: collection, layoutId: () => 'owned', chartsCount: () => 2,
        chart: index => ({ setSymbol: value => {
          assert.equal(sync.symbol, false); assert.equal(sync.interval, false);
          calls.push('symbol:' + index); panes[index].resolved_symbol = value;
        }, setResolution: value => { calls.push('interval:' + index); panes[index].resolution = value; } }) };
      const value = await runInNewContext(expression, { window: { TradingViewApi: api },
        setTimeout: resolve => resolve() });
      return { result: { value } };
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  } }, close: async () => { closes++; } };
  const deps = { status: () => state, listTargets: async () => [{ id: 'new', url: 'https://www.tradingview.com/chart/owned/' }],
    connect: async () => client, read: async () => structuredClone(panes),
    backup: () => { assert.equal(calls.length, 0); backups++; }, wait: async () => {} };
  return { panes, state, deps, calls, get backups() { return backups; }, get closes() { return closes; } };
}

test('repair defaults to preview; applying disables sync before changing only the mismatched pane', async () => {
  const f = fixture(), originalStudies = structuredClone(f.panes[0].studies);
  const preview = await repairWorker({ slot: 0, _deps: f.deps });
  assert.deepEqual(preview.pending_panes, [0]);
  assert.equal(f.backups, 0); assert.equal(f.calls.length, 0);
  const result = await repairWorker({ slot: 0, dry_run: false, _deps: f.deps });
  assert.equal(result.complete, true); assert.equal(result.opened_tabs, 0);
  assert.deepEqual(f.calls, ['symbolSync', 'intervalSync', 'symbol:0', 'interval:0']);
  assert.equal(f.backups, 1); assert.equal(f.closes, 2);
  assert.deepEqual(f.panes[0].studies, originalStudies);
  assert.equal(f.panes[1].resolved_symbol, 'NYSE:SECOND');
});

test('repair rejects ambiguous targets, missing studies and invalid ownership before mutation', async () => {
  for (const fault of ['duplicate', 'studies', 'assignment']) {
    const f = fixture();
    if (fault === 'duplicate') f.deps.listTargets = async () => [1, 2].map(id => ({ id,
      url: 'https://www.tradingview.com/chart/owned/' }));
    if (fault === 'studies') f.panes[0].studies = [];
    if (fault === 'assignment') f.state.entries[0].assignment.pane_index = 1;
    await assert.rejects(() => repairWorker({ slot: 0, dry_run: false, _deps: f.deps }));
    assert.equal(f.calls.length, 0); assert.equal(f.backups, 0);
  }
});

test('failed pane verification retains backup and does not report repair success', async () => {
  const f = fixture();
  const before = structuredClone(f.panes);
  f.deps.read = async () => structuredClone(before);
  await assert.rejects(() => repairWorker({ slot: 0, dry_run: false, _deps: f.deps }), /verification failed/);
  assert.equal(f.backups, 1); assert.equal(f.closes, 1);
});
