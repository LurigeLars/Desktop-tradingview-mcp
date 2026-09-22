import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshotOptions,
  realtimeStatusFromDelay,
  filterSnapshotsBySymbols,
  selectSnapshotsForWorkerEntries,
} from '../src/core/realtime.js';

test('snapshot options use compact fast defaults', () => {
  assert.deepEqual(normalizeSnapshotOptions({}), {
    mode: 'fast',
    bars: 1,
    includeStudies: false,
    studyFilters: [],
  });
});

test('decision mode enables recent bars and study values by default', () => {
  assert.deepEqual(normalizeSnapshotOptions({ mode: 'decision' }), {
    mode: 'decision',
    bars: 12,
    includeStudies: true,
    studyFilters: [],
  });
});

test('snapshot options validate bar bounds and mode', () => {
  assert.throws(() => normalizeSnapshotOptions({ bars: 0 }), /bars must be/);
  assert.throws(() => normalizeSnapshotOptions({ bars: 101 }), /bars must be/);
  assert.throws(() => normalizeSnapshotOptions({ mode: 'other' }), /mode must be/);
});

test('realtime status is only inferred when TradingView exposes numeric delay', () => {
  assert.equal(realtimeStatusFromDelay(0), 'realtime');
  assert.equal(realtimeStatusFromDelay(15), 'delayed');
  assert.equal(realtimeStatusFromDelay(null), 'unknown');
  assert.equal(realtimeStatusFromDelay(undefined), 'unknown');
});

test('symbol filtering is exact and never collapses expressions', () => {
  const snapshots = [
    { resolved_symbol: 'EX1:AAA/EX2:BBB' },
    { resolved_symbol: 'EX2:BBB' },
  ];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['EX1:AAA/EX2:BBB']),
    { snapshots: [snapshots[0]], missing: [] },
  );
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['AAA/BBB']),
    { snapshots: [], missing: ['AAA/BBB'] },
  );
});

test('omitting symbol filters returns every resident snapshot', () => {
  const snapshots = [{ resolved_symbol: 'EX:AAA' }, { resolved_symbol: 'EX:BBB' }];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots),
    { snapshots, missing: [] },
  );
});


test('worker selection matches exact symbol and normalized timeframe without exposing pane layout', () => {
  const entry = {
    handle: 'logical-a',
    key: 'EX:AAA|5',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [],
    groups: ['group:a'],
    assignment: null,
  };
  const snapshot = {
    resolved_symbol: 'EX:AAA',
    resolution: '5m',
    chart_id: 'chart-1',
    pane_index: 3,
    studies: [],
    success: true,
  };

  const selected = selectSnapshotsForWorkerEntries([entry], [snapshot]);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots.length, 1);
  assert.equal(selected.snapshots[0].worker_handle, 'logical-a');
  assert.deepEqual(selected.snapshots[0].worker_groups, ['group:a']);
});

test('worker selection prefers persisted chart/pane assignment over duplicate symbol matches', () => {
  const entry = {
    handle: 'logical-a',
    key: 'EX:AAA|5',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: { chart_id: 'chart-2', pane_index: 1 },
  };
  const snapshots = [
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-1', pane_index: 0, studies: [], success: true },
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-2', pane_index: 1, studies: [], success: true },
  ];

  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].chart_id, 'chart-2');
  assert.equal(selected.snapshots[0].pane_index, 1);
});

test('worker selection fails closed when resident symbol/timeframe match is ambiguous', () => {
  const entry = {
    handle: 'logical-a',
    key: 'EX:AAA|5',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: null,
  };
  const snapshots = [
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-1', pane_index: 0, studies: [], success: true },
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-2', pane_index: 0, studies: [], success: true },
  ];

  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.snapshots.length, 0);
  assert.equal(selected.unmatched[0].reason, 'ambiguous_resident_match');
});

test('worker selection never collapses a requested expression to a component', () => {
  const entry = {
    handle: 'expr',
    key: 'EX1:AAA/EX2:BBB|5',
    symbol: 'EX1:AAA/EX2:BBB',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: null,
  };
  const selected = selectSnapshotsForWorkerEntries([entry], [
    { resolved_symbol: 'EX2:BBB', resolution: '5', chart_id: 'chart-1', pane_index: 0, studies: [], success: true },
  ]);
  assert.equal(selected.snapshots.length, 0);
  assert.equal(selected.unmatched[0].reason, 'not_resident');
});

test('required studies can disambiguate otherwise identical resident charts', () => {
  const entry = {
    handle: 'study-specific',
    key: 'EX:AAA|5|ALPHA',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: ['Alpha'],
    groups: [],
    assignment: null,
  };
  const snapshots = [
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-1', pane_index: 0, studies: [{ name: 'Beta' }], success: true },
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-2', pane_index: 0, studies: [{ name: 'Alpha' }], success: true },
  ];
  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].chart_id, 'chart-2');
});


test('stale persisted assignment is rejected and fallback finds the live matching pane', () => {
  const entry = {
    handle: 'logical-a',
    key: 'EX:AAA|5',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: { chart_id: 'stale-chart', pane_index: 0 },
  };
  const snapshots = [
    { resolved_symbol: 'EX:OTHER', resolution: '5', chart_id: 'stale-chart', pane_index: 0, studies: [], success: true },
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'live-chart', pane_index: 2, studies: [], success: true },
  ];

  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].chart_id, 'live-chart');
});


test('parameterized study inputs disambiguate otherwise identical resident charts', () => {
  const entry = {
    handle: 'parameterized',
    key: 'EX:AAA|5|PARAM',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [{ name: 'Parameter Study', inputs: { length: 20 } }],
    groups: [],
    assignment: null,
  };
  const snapshots = [
    {
      resolved_symbol: 'EX:AAA',
      resolution: '5',
      chart_id: 'chart-1',
      pane_index: 0,
      studies: [{ name: 'Parameter Study', inputs: { length: 9 }, values: {} }],
      success: true,
    },
    {
      resolved_symbol: 'EX:AAA',
      resolution: '5',
      chart_id: 'chart-2',
      pane_index: 0,
      studies: [{ name: 'Parameter Study', inputs: { length: 20 }, values: {} }],
      success: true,
    },
  ];

  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].chart_id, 'chart-2');
});


test('worker selection accepts a uniquely resolved exchange-qualified form for a bare ticker', () => {
  const entry = {
    handle: 'bare',
    key: 'AAA|5',
    symbol: 'AAA',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: null,
  };
  const snapshots = [
    { resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'chart-1', pane_index: 0, studies: [], success: true },
  ];
  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].resolved_symbol, 'EX:AAA');
});
