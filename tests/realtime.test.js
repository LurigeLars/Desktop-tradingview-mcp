import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshotOptions,
  realtimeStatusFromDelay,
  realtimeStatusFromQuote,
  ageMsFromEpochSeconds,
  freshnessFromAge,
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

test('resident quote realtime status prefers TradingView live mode signals', () => {
  assert.equal(realtimeStatusFromQuote({ is_delay: false }), 'realtime');
  assert.equal(realtimeStatusFromQuote({ update_mode: 'streaming' }), 'realtime');
  assert.equal(realtimeStatusFromQuote({ is_delay: true, update_mode: 'streaming' }), 'delayed');
  assert.equal(realtimeStatusFromQuote({ delay_minutes: 15 }), 'delayed');
  assert.equal(realtimeStatusFromQuote({}), 'unknown');
});

test('quote age converts TradingView epoch seconds to retrieval milliseconds', () => {
  assert.equal(ageMsFromEpochSeconds(1000, 1002500), 2500);
  assert.equal(ageMsFromEpochSeconds(1005, 1002500), 0, 'future timestamps clamp at zero');
  assert.equal(ageMsFromEpochSeconds(null, 1002500), null);
});

test('last-trade freshness is decision-useful and threshold-driven', () => {
  assert.equal(freshnessFromAge(1999, 5000), 'fresh');
  assert.equal(freshnessFromAge(5000, 5000), 'fresh');
  assert.equal(freshnessFromAge(5001, 5000), 'stale');
  assert.equal(freshnessFromAge(null, 5000), 'unknown');
});

test('symbol filtering is exact for expressions and never collapses to a component', () => {
  const snapshots = [
    { resolved_symbol: 'EX1:AAA/EX2:BBB' },
    { resolved_symbol: 'EX2:BBB' },
  ];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['EX1:AAA/EX2:BBB']),
    { snapshots: [snapshots[0]], missing: [], ambiguous: [] },
  );
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['AAA/BBB']),
    { snapshots: [], missing: ['AAA/BBB'], ambiguous: [] },
  );
});

test('qualified symbol filtering accepts only metadata-proven TradingView canonicalization', () => {
  const proven = {
    resolved_symbol: 'BATS:QQQ',
    _symbol_identity: {
      name: 'QQQ',
      pro_name: 'NASDAQ:QQQ',
      listed_exchange: 'NASDAQ',
    },
  };
  const unproven = {
    resolved_symbol: 'BATS:QQQ',
    _symbol_identity: {
      name: 'QQQ',
      listed_exchange: 'NYSE',
    },
  };

  assert.deepEqual(
    filterSnapshotsBySymbols([proven], ['NASDAQ:QQQ']),
    { snapshots: [proven], missing: [], ambiguous: [] },
  );
  assert.deepEqual(
    filterSnapshotsBySymbols([unproven], ['NASDAQ:QQQ']),
    { snapshots: [], missing: ['NASDAQ:QQQ'], ambiguous: [] },
  );
});

test('bare symbol filtering resolves one unique exchange-qualified resident symbol', () => {
  const snapshots = [
    { resolved_symbol: 'EX:AAA', pane_index: 0 },
    { resolved_symbol: 'EX:BBB', pane_index: 1 },
  ];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['AAA']),
    { snapshots: [snapshots[0]], missing: [], ambiguous: [] },
  );
});

test('bare symbol filtering fails closed when multiple exchanges are resident', () => {
  const snapshots = [
    { resolved_symbol: 'EX1:AAA' },
    { resolved_symbol: 'EX2:AAA' },
  ];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['AAA']),
    {
      snapshots: [],
      missing: [],
      ambiguous: [{ requested_symbol: 'AAA', candidates: ['EX1:AAA', 'EX2:AAA'] }],
    },
  );
});

test('exact symbol filtering returns every resident pane for the exact resolved symbol', () => {
  const snapshots = [
    { resolved_symbol: 'EX:AAA', resolution: '1' },
    { resolved_symbol: 'EX:AAA', resolution: '5' },
  ];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots, ['EX:AAA']),
    { snapshots, missing: [], ambiguous: [] },
  );
});

test('omitting symbol filters returns every resident snapshot', () => {
  const snapshots = [{ resolved_symbol: 'EX:AAA' }, { resolved_symbol: 'EX:BBB' }];
  assert.deepEqual(
    filterSnapshotsBySymbols(snapshots),
    { snapshots, missing: [], ambiguous: [] },
  );
});


test('resident worker selection accepts TradingView canonical venue when identity metadata proves it', () => {
  const entry = {
    handle: 'qqq',
    key: 'NASDAQ:QQQ|5',
    symbol: 'NASDAQ:QQQ',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: { target_id: 'worker-target', pane_index: 0 },
  };
  const snapshot = {
    target_id: 'worker-target',
    resolved_symbol: 'BATS:QQQ',
    resolution: '5',
    chart_id: 'shared-chart',
    pane_index: 0,
    studies: [],
    success: true,
    _symbol_identity: {
      name: 'QQQ',
      full_name: 'BATS:QQQ',
      pro_name: 'NASDAQ:QQQ',
      base_name: ['NASDAQ:QQQ'],
      listed_exchange: 'NASDAQ',
      exchange: 'Cboe One',
    },
  };

  const selected = selectSnapshotsForWorkerEntries([entry], [snapshot]);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots.length, 1);
  assert.equal(selected.snapshots[0].resolved_symbol, 'BATS:QQQ');
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

test('worker selection prefers target id when duplicate tabs share one chart id', () => {
  const entry = {
    handle: 'logical-a',
    key: 'EX:AAA|5',
    symbol: 'EX:AAA',
    timeframe: '5',
    studies: [],
    groups: [],
    assignment: { target_id: 'target-2', chart_id: 'shared-chart', pane_index: 0 },
  };
  const snapshots = [
    { target_id: 'target-1', resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'shared-chart', pane_index: 0, studies: [], success: true },
    { target_id: 'target-2', resolved_symbol: 'EX:AAA', resolution: '5', chart_id: 'shared-chart', pane_index: 0, studies: [], success: true },
  ];

  const selected = selectSnapshotsForWorkerEntries([entry], snapshots);
  assert.equal(selected.unmatched.length, 0);
  assert.equal(selected.snapshots[0].target_id, 'target-2');
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
