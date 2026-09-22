import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkerTimeframe,
  buildWorkerKey,
  normalizeWorkerUniverse,
  setUniverse,
  status,
  resolveWorkerSelection,
  planPaneCounts,
  planWorkerTopology,
} from '../src/core/worker.js';

test('timeframe normalization is generic across seconds, minutes, hours and calendar units', () => {
  assert.equal(normalizeWorkerTimeframe('5m'), '5');
  assert.equal(normalizeWorkerTimeframe('2h'), '120');
  assert.equal(normalizeWorkerTimeframe('30s'), '30S');
  assert.equal(normalizeWorkerTimeframe('1d'), '1D');
  assert.equal(normalizeWorkerTimeframe('W'), '1W');
  assert.equal(normalizeWorkerTimeframe('M'), '1M');
  assert.equal(normalizeWorkerTimeframe('custom-token'), 'custom-token');
});

test('worker keys are stable across case and study ordering', () => {
  const a = buildWorkerKey({
    symbol: 'EX:ABC',
    timeframe: '5m',
    studies: ['Study B', 'Study A'],
  });
  const b = buildWorkerKey({
    symbol: 'ex:abc',
    timeframe: '5',
    studies: ['study a', 'study b'],
  });
  assert.equal(a, b);
});

test('equivalent entries deduplicate and merge groups', () => {
  const normalized = normalizeWorkerUniverse([
    { symbol: 'EX:ABC', timeframe: '5m', studies: ['One'], groups: ['group:a'] },
    { symbol: 'ex:abc', timeframe: '5', studies: ['one'], groups: ['group:b'] },
  ], { capacity: 10, reserveSlots: 2 });

  assert.equal(normalized.entries.length, 1);
  assert.deepEqual(normalized.entries[0].groups, ['group:a', 'group:b']);
  assert.equal(normalized.usable_capacity, 8);
});

test('capacity and reserve slots are enforced against unique entries', () => {
  assert.throws(
    () => normalizeWorkerUniverse([
      { symbol: 'EX:AAA', timeframe: '1' },
      { symbol: 'EX:BBB', timeframe: '1' },
    ], { capacity: 2, reserveSlots: 1 }),
    /only 1 usable slots/,
  );
});

test('generated handles are deterministic for equivalent entries', () => {
  const first = normalizeWorkerUniverse([
    { symbol: 'EX:ABC', timeframe: '15m', studies: ['One'] },
  ], { capacity: 5 });
  const second = normalizeWorkerUniverse([
    { symbol: 'ex:abc', timeframe: '15', studies: ['one'] },
  ], { capacity: 5 });
  assert.equal(first.entries[0].handle, second.entries[0].handle);
});

test('explicit handle collisions across distinct entries fail closed', () => {
  assert.throws(
    () => normalizeWorkerUniverse([
      { handle: 'same', symbol: 'EX:AAA', timeframe: '1' },
      { handle: 'same', symbol: 'EX:BBB', timeframe: '1' },
    ], { capacity: 5 }),
    /used by multiple distinct entries/,
  );
});

test('registry persistence and group/handle selection are independent of physical tabs', () => {
  let stored = null;
  const fake = {
    loadState: () => stored,
    saveState: state => { stored = structuredClone(state); },
    now: () => Date.parse('2026-09-22T20:00:00Z'),
  };

  const configured = setUniverse({
    capacity: 6,
    reserve_slots: 1,
    entries: [
      { handle: 'alpha', symbol: 'EX:AAA', timeframe: '5m', groups: ['group:x'] },
      { handle: 'beta', symbol: 'EX:BBB', timeframe: '5m', groups: ['group:x', 'group:y'] },
    ],
    _deps: fake,
  });

  assert.equal(configured.configured, 2);
  assert.equal(configured.free_slots, 3);
  assert.equal(status({ _deps: fake }).assigned, 0);

  const byGroup = resolveWorkerSelection({ groups: ['group:y'], _deps: fake });
  assert.deepEqual(byGroup.entries.map(entry => entry.handle), ['beta']);

  const byHandle = resolveWorkerSelection({ handles: ['alpha', 'missing'], _deps: fake });
  assert.deepEqual(byHandle.entries.map(entry => entry.handle), ['alpha']);
  assert.deepEqual(byHandle.missing_handles, ['missing']);
});


test('topology planner represents 50 entries exactly without over-allocating panes', () => {
  assert.deepEqual(planPaneCounts(50), [8, 8, 8, 8, 8, 8, 2]);
  assert.equal(planPaneCounts(50).reduce((sum, value) => sum + value, 0), 50);
});

test('topology planner uses only supported pane counts for awkward remainders', () => {
  assert.deepEqual(planPaneCounts(5), [4, 1]);
  assert.deepEqual(planPaneCounts(7), [6, 1]);
  assert.deepEqual(planPaneCounts(13), [8, 4, 1]);
});

test('topology planner respects a lower configured per-tab maximum', () => {
  const plan = planPaneCounts(12, { maxChartsPerTab: 4 });
  assert.deepEqual(plan, [4, 4, 4]);
  assert.ok(plan.every(value => value <= 4));
});

test('topology plan maps generic handles to tabs without market-specific assumptions', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ handle: 'h' + index }));
  const topology = planWorkerTopology(entries);
  assert.equal(topology.tab_count, 2);
  assert.deepEqual(topology.tabs.map(tab => tab.pane_count), [8, 2]);
  assert.deepEqual(topology.tabs[0].handles, ['h0','h1','h2','h3','h4','h5','h6','h7']);
  assert.deepEqual(topology.tabs[1].handles, ['h8','h9']);
});

test('worker status includes an exact topology plan', () => {
  let stored = null;
  const fake = {
    loadState: () => stored,
    saveState: state => { stored = structuredClone(state); },
    now: () => Date.parse('2026-09-22T20:00:00Z'),
  };

  const configured = setUniverse({
    capacity: 50,
    reserve_slots: 2,
    max_charts_per_tab: 8,
    entries: Array.from({ length: 9 }, (_, index) => ({
      symbol: 'EX:S' + index,
      timeframe: '5',
    })),
    _deps: fake,
  });

  assert.equal(configured.max_charts_per_tab, 8);
  assert.equal(configured.topology_plan.tab_count, 2);
  assert.deepEqual(configured.topology_plan.tabs.map(tab => tab.pane_count), [8, 1]);
});

test('per-tab chart limit cannot exceed the configured Premium architecture limit', () => {
  assert.throws(() => planPaneCounts(1, { maxChartsPerTab: 9 }), /from 1 to 8/);
});
