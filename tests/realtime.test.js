import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshotOptions,
  realtimeStatusFromDelay,
  filterSnapshotsBySymbols,
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
