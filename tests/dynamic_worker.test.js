import test from 'node:test';
import assert from 'node:assert/strict';
import { planDynamicSymbols, ensureDynamicSymbols } from '../src/core/dynamic-worker.js';
import { provisionWorker } from '../src/core/worker-provision.js';

function baseline() {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    handle: 'base-' + i, symbol: 'NASDAQ:BASE' + i, timeframe: '60',
    studies: [], groups: ['watch:resident'],
    assignment: { worker_slot: Math.floor(i / 8), pane_index: i % 8 },
  }));
  return {
    entries, configured: entries.length, capacity: 50, reserve_slots: 6,
    usable_capacity: 44, max_charts_per_tab: 8,
    worker_tabs: Array.from({ length: 5 }, (_, i) => ({
      slot: i, pane_count: 8, persistent_layout: true,
      chart_id: 'chart-' + i, target_id: 'target-' + i,
    })),
  };
}

test('isolated dynamic suffix preserves all 40 current worker entries', () => {
  const st = baseline();
  const p = planDynamicSymbols(st, ['NASDAQ:ADBE', 'NASDAQ:GOOGL']);
  assert.equal(p.dynamic_slot, 5);
  assert.equal(p.pool_capacity, 4);
  assert.equal(p.entries.length, 42);
  assert.deepEqual(p.entries.slice(0, 40).map(x => x.handle),
    st.entries.map(x => x.handle));
  assert.deepEqual(p.selected, ['NASDAQ:ADBE', 'NASDAQ:GOOGL']);
  assert.equal(p.changed, true);
});

test('dynamic pool fails closed for unqualified IDs and mixed layouts', () => {
  assert.throws(() => planDynamicSymbols(baseline(), ['ADBE']), /exchange-qualified/);
  assert.throws(() => planDynamicSymbols(baseline(), new Array(13).fill('NASDAQ:A')),
    /at most 12/);
  const st = baseline();
  st.entries[4].groups = ['watch:dynamic'];
  assert.throws(() => planDynamicSymbols(st, ['NASDAQ:ADBE']), /separated suffix/);
});

test('dynamic workers retain handles and replace at most one cold unused slot', () => {
  const st = baseline();
  for (let i = 0; i < 4; i++) st.entries.push({
    handle: 'dynamic-' + i, symbol: 'NASDAQ:DYN' + i, timeframe: '60',
    groups: ['watch:dynamic'], studies: [],
    assignment: { worker_slot: 5, pane_index: i, provisioned_at: '2026-01-01T00:00:00Z' },
  });
  const plan = planDynamicSymbols(st, ['NASDAQ:ADBE', 'NASDAQ:MU'], { now: Date.parse('2026-10-14T18:00:00Z') });
  assert.equal(plan.entries.length, 44);
  assert.equal(plan.selected.filter(x => ['NASDAQ:ADBE', 'NASDAQ:MU'].includes(x)).length, 1);
  assert.equal(plan.blocked.length, 1);
  assert.deepEqual(plan.entries.slice(0, 40).map(x => x.symbol),
    st.entries.slice(0, 40).map(x => x.symbol));
  st.entries[40].assignment.provisioned_at = '2026-10-14T17:59:00Z';
  st.entries[41].assignment.provisioned_at = '2026-10-14T17:59:00Z';
  st.entries[42].assignment.provisioned_at = '2026-10-14T17:59:00Z';
  st.entries[43].assignment.provisioned_at = '2026-10-14T17:59:00Z';
  const tooSoon = planDynamicSymbols(st, ['NASDAQ:ADBE'], { now: Date.parse('2026-10-14T18:00:00Z') });
  assert.equal(tooSoon.changed, false);
  assert.equal(tooSoon.blocked.length, 1);
});

test('dynamic ensure scopes mutation solely to suffix chart tab', async () => {
  const state = baseline();
  let save, called;
  const result = await ensureDynamicSymbols({
    symbols: ['NASDAQ:ADBE', 'NASDAQ:GOOGL'], max_panes: 2,
    _deps: {
      status: () => state,
      setUniverse: value => { save = value; },
      provision: async value => {
        called = value;
        return { complete: false, remaining_tabs: [5],
          results: [{ stage: 'tab_ready', pending_panes: [0, 1] }] };
      },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.provisioned, false);
  assert.deepEqual(called.only_slots, [5]);
  assert.equal(called.max_tabs, 1);
  assert.equal(called.max_panes, 2);
  assert.equal(save.entries.length, 42);
  assert.equal(save.entries[0].symbol, 'NASDAQ:BASE0');
});

test('scoped worker provisioning planning never schedules a baseline tab', async () => {
  const old = baseline();
  old.entries.push({
    handle: 'dynamic-0', symbol: 'NASDAQ:ADBE', timeframe: '60',
    groups: ['watch:dynamic'], studies: [], assignment: null,
  });
  const { planWorkerTopology } = await import('../src/core/worker.js');
  old.configured = old.entries.length;
  old.topology_plan = planWorkerTopology(old.entries, { maxChartsPerTab: 8 });
  const res = await provisionWorker({
    dry_run: true, only_slots: [5], _deps: {
      status: () => old,
      listTargets: async () => [],
      inspectTargets: async () => [],
      listSavedLayouts: async () => [],
    },
  });
  assert.deepEqual(res.pending_tabs, [5]);
  assert.equal(res.capacity_projection.worker_connections, 41);
  await assert.rejects(() => provisionWorker({
    dry_run: true, only_slots: [0], _deps: {
      status: () => old, listTargets: async () => [], inspectTargets: async () => [],
    },
  }), /cannot mutate baseline/);
});
