import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerLayoutName,
  layoutCodeForPaneCount,
  provisionWorker,
  recordedTabComplete,
} from '../src/core/worker-provision.js';
import {
  recordWorkerProvision,
  setUniverse,
  status,
} from '../src/core/worker.js';

test('worker pane counts map only to supported TradingView layouts', () => {
  assert.equal(layoutCodeForPaneCount(1), 's');
  assert.equal(layoutCodeForPaneCount(2), '2h');
  assert.equal(layoutCodeForPaneCount(3), '3h');
  assert.equal(layoutCodeForPaneCount(4), '4');
  assert.equal(layoutCodeForPaneCount(6), '6');
  assert.equal(layoutCodeForPaneCount(8), '8');
  assert.throws(() => layoutCodeForPaneCount(5), /Unsupported worker pane count/);
});

test('worker layout names are technical and deterministic', () => {
  assert.equal(buildWorkerLayoutName('Worker', 0), 'Worker 01');
  assert.equal(buildWorkerLayoutName('Worker', 6), 'Worker 07');
});

test('recorded tab completeness requires live ownership and exact pane assignments', () => {
  const plan = { tab_index: 0, pane_count: 2, handles: ['a', 'b'] };
  const state = {
    worker_tabs: [{ slot: 0, chart_id: 'chart-a', layout_name: 'Worker 01', pane_count: 2 }],
    entries: [
      { handle: 'a', assignment: { worker_slot: 0, chart_id: 'chart-a', pane_index: 0 } },
      { handle: 'b', assignment: { worker_slot: 0, chart_id: 'chart-a', pane_index: 1 } },
    ],
  };
  assert.equal(recordedTabComplete(plan, state, new Set(['chart-a'])), true);
  assert.equal(recordedTabComplete(plan, state, new Set()), false);

  state.entries[1].assignment.pane_index = 0;
  assert.equal(recordedTabComplete(plan, state, new Set(['chart-a'])), false);
});

function makeStore() {
  let stored = null;
  const deps = {
    loadState: () => stored,
    saveState: value => { stored = structuredClone(value); },
    now: () => Date.parse('2026-09-22T20:00:00Z'),
  };
  return { deps, get: () => stored };
}

test('recordWorkerProvision persists assignments and DTV-owned tab metadata', () => {
  const store = makeStore();
  setUniverse({
    entries: [
      { handle: 'a', symbol: 'EX:AAA', timeframe: '5' },
      { handle: 'b', symbol: 'EX:BBB', timeframe: '5' },
    ],
    _deps: store.deps,
  });

  const result = recordWorkerProvision({
    assignments: {
      a: { worker_slot: 0, chart_id: 'chart-a', pane_index: 0 },
      b: { worker_slot: 0, chart_id: 'chart-a', pane_index: 1 },
    },
    worker_tabs: [{ slot: 0, chart_id: 'chart-a', layout_name: 'Worker 01', pane_count: 2 }],
    _deps: store.deps,
  });

  assert.equal(result.assigned, 2);
  assert.equal(result.worker_tabs.length, 1);
  assert.equal(status({ _deps: store.deps }).entries[1].assignment.pane_index, 1);
});

test('worker provisioning is resumable one topology tab at a time', async () => {
  const store = makeStore();
  setUniverse({
    capacity: 20,
    entries: Array.from({ length: 10 }, (_, index) => ({
      handle: 'h' + index,
      symbol: 'EX:S' + index,
      timeframe: '5',
    })),
    _deps: store.deps,
  });

  let liveTargets = [];
  let chartCounter = 0;
  const runtime = {
    status: () => status({ _deps: store.deps }),
    record: args => recordWorkerProvision({ ...args, _deps: store.deps }),
    listTargets: async () => liveTargets,
    newTab: async ({ name, layout }) => {
      assert.equal(layout, 'new');
      chartCounter += 1;
      const chartId = 'chart-' + chartCounter;
      liveTargets.push({
        id: 'target-' + chartCounter,
        type: 'page',
        title: name,
        url: 'https://www.tradingview.com/chart/' + chartId + '/',
      });
      return { success: true, layout: name, chart_id: chartId };
    },
    configureTarget: async ({ target, paneCount, entries }) => ({
      success: true,
      layout_code: layoutCodeForPaneCount(paneCount),
      target_id: target.id,
      handles: entries.map(entry => entry.handle),
    }),
    closeTabByChartId: async () => ({ success: true }),
    now: () => Date.parse('2026-09-22T20:00:00Z'),
  };

  const first = await provisionWorker({ max_tabs: 1, layout_prefix: 'Worker', _deps: runtime });
  assert.equal(first.complete, false);
  assert.deepEqual(first.remaining_tabs, [1]);
  assert.equal(first.results[0].pane_count, 8);
  assert.equal(status({ _deps: store.deps }).assigned, 8);

  const second = await provisionWorker({ max_tabs: 1, layout_prefix: 'Worker', _deps: runtime });
  assert.equal(second.complete, true);
  assert.deepEqual(second.remaining_tabs, []);
  assert.equal(second.results[0].pane_count, 2);
  assert.equal(status({ _deps: store.deps }).assigned, 10);
  assert.equal(status({ _deps: store.deps }).worker_tabs.length, 2);
});

test('force provisioning remains resumable and does not report complete early', async () => {
  const store = makeStore();
  setUniverse({
    entries: Array.from({ length: 10 }, (_, index) => ({
      handle: 'h' + index,
      symbol: 'EX:S' + index,
      timeframe: '5',
    })),
    _deps: store.deps,
  });

  const initialAssignments = {};
  for (let index = 0; index < 10; index++) {
    initialAssignments['h' + index] = {
      worker_slot: index < 8 ? 0 : 1,
      chart_id: index < 8 ? 'chart-1' : 'chart-2',
      pane_index: index < 8 ? index : index - 8,
    };
  }
  recordWorkerProvision({
    assignments: initialAssignments,
    worker_tabs: [
      { slot: 0, chart_id: 'chart-1', layout_name: 'Worker 01', pane_count: 8 },
      { slot: 1, chart_id: 'chart-2', layout_name: 'Worker 02', pane_count: 2 },
    ],
    _deps: store.deps,
  });

  const targets = [
    { id: 't1', type: 'page', url: 'https://www.tradingview.com/chart/chart-1/' },
    { id: 't2', type: 'page', url: 'https://www.tradingview.com/chart/chart-2/' },
  ];
  const runtime = {
    status: () => status({ _deps: store.deps }),
    record: args => recordWorkerProvision({ ...args, _deps: store.deps }),
    listTargets: async () => targets,
    newTab: async () => { throw new Error('should reuse live worker tab'); },
    configureTarget: async ({ paneCount }) => ({ success: true, layout_code: layoutCodeForPaneCount(paneCount) }),
    closeTabByChartId: async () => ({ success: true }),
    now: () => Date.parse('2026-09-22T20:00:00Z'),
  };

  const first = await provisionWorker({ force: true, max_tabs: 1, _deps: runtime });
  assert.equal(first.complete, false);
  assert.deepEqual(first.remaining_tabs, [1]);
});
