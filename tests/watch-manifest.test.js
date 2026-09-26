import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyWatchManifest,
  compileWatchManifest,
  normalizeWatchManifest,
} from '../src/core/watch-manifest.js';

const sample = {
  version: 1,
  defaults: {
    themes: ['core', 'rates'],
    capacity: 8,
    reserve_slots: 2,
    max_charts_per_tab: 4,
    layout_prefix: 'DTV Market',
  },
  themes: {
    core: {
      entries: [
        { symbol: 'NASDAQ:QQQ', timeframe: '60', groups: ['morning'] },
        { symbol: 'NASDAQ:QQQ', timeframe: '1D', groups: ['context:daily'] },
      ],
    },
    rates: {
      entries: [
        { symbol: 'TVC:US10Y', timeframe: '60', groups: ['morning'] },
        { symbol: 'NASDAQ:QQQ', timeframe: '60', groups: ['rates-overlap'] },
      ],
    },
  },
};

test('watch manifest normalizes defaults and rejects unknown default themes', () => {
  const normalized = normalizeWatchManifest(sample);
  assert.deepEqual(normalized.defaults.themes, ['core', 'rates']);
  assert.equal(normalized.defaults.reserve_slots, 2);

  assert.throws(
    () => normalizeWatchManifest({
      ...sample,
      defaults: { ...sample.defaults, themes: ['missing'] },
    }),
    /default theme not found/,
  );
});

test('compile deduplicates equivalent workers while retaining all theme groups', () => {
  const compiled = compileWatchManifest({ manifest: sample });
  assert.equal(compiled.unique_entries, 3);
  assert.equal(compiled.free_slots, 3);

  const qqq60 = compiled.entries.find(
    entry => entry.symbol === 'NASDAQ:QQQ' && entry.timeframe === '60',
  );
  assert.ok(qqq60);
  assert.equal(qqq60.groups.includes('morning'), true);
  assert.equal(qqq60.groups.includes('rates-overlap'), true);
  assert.equal(qqq60.groups.includes('watch:core'), true);
  assert.equal(qqq60.groups.includes('watch:rates'), true);
});

test('dynamic entries are tagged and bounded by the same capacity contract', () => {
  const compiled = compileWatchManifest({
    manifest: sample,
    themes: ['core'],
    extra_entries: [
      { symbol: 'NYSE:VLO', timeframe: '5', groups: ['active-trade'] },
    ],
  });
  const dynamic = compiled.entries.find(entry => entry.symbol === 'NYSE:VLO');
  assert.ok(dynamic.groups.includes('watch:dynamic'));
  assert.ok(dynamic.groups.includes('active-trade'));

  assert.throws(
    () => compileWatchManifest({
      manifest: sample,
      extra_entries: Array.from({ length: 13 }, (_, i) => ({
        symbol: `EX:S${i}`,
        timeframe: '5',
      })),
    }),
    /limited to 12/,
  );
});

test('apply supports dry-run without writing worker state', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-watch-manifest-'));
  try {
    writeFileSync(join(root, 'watch-manifest.json'), JSON.stringify(sample), 'utf8');
    let writes = 0;
    const result = applyWatchManifest({
      dry_run: true,
      _deps: {
        stateRoot: root,
        projectFile: join(root, 'unused.json'),
        status: () => ({ entries: [] }),
        setUniverse: () => { writes++; throw new Error('should not write'); },
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.applied, false);
    assert.equal(result.manifest_source, 'user_state');
    assert.equal(writes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply writes compiled defaults through worker_set_universe contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-watch-manifest-'));
  try {
    writeFileSync(join(root, 'watch-manifest.json'), JSON.stringify(sample), 'utf8');
    let received = null;
    const result = applyWatchManifest({
      _deps: {
        stateRoot: root,
        projectFile: join(root, 'unused.json'),
        status: () => ({ entries: [] }),
        setUniverse: args => {
          received = args;
          return {
            configured: 3,
            assigned: 0,
            unassigned: 3,
            capacity: 8,
            reserve_slots: 2,
            free_slots: 3,
            groups: [],
          };
        },
      },
    });
    assert.equal(result.applied, true);
    assert.equal(received.replace, true);
    assert.equal(received.capacity, 8);
    assert.equal(received.reserve_slots, 2);
    assert.equal(received.entries.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('apply canonicalizes worker metadata labels without touching chart state', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-watch-manifest-'));
  try {
    writeFileSync(join(root, 'watch-manifest.json'), JSON.stringify(sample), 'utf8');
    let recorded = null;
    const result = applyWatchManifest({
      _deps: {
        stateRoot: root,
        projectFile: join(root, 'unused.json'),
        status: () => ({
          entries: [],
          worker_tabs: [{ slot: 0, target_id: 'T1', chart_id: 'C1', layout_name: 'DTV Morning 01', pane_count: 3 }],
        }),
        setUniverse: () => ({
          configured: 3,
          assigned: 3,
          unassigned: 0,
          capacity: 8,
          reserve_slots: 2,
          free_slots: 3,
          groups: [],
          worker_tabs: [{ slot: 0, target_id: 'T1', chart_id: 'C1', layout_name: 'DTV Morning 01', pane_count: 3 }],
          entries: [
            {
              handle: 'a',
              assignment: {
                worker_slot: 0,
                target_id: 'T1',
                chart_id: 'C1',
                pane_index: 0,
                layout_name: 'DTV Morning 01',
              },
            },
            {
              handle: 'b',
              assignment: {
                worker_slot: 0,
                target_id: 'T1',
                chart_id: 'C1',
                pane_index: 1,
                layout_name: 'DTV Morning 01',
              },
            },
          ],
        }),
        record: args => {
          recorded = args;
          return {
            configured: 3,
            assigned: 3,
            unassigned: 0,
            capacity: 8,
            reserve_slots: 2,
            free_slots: 3,
            groups: [],
            worker_tabs: args.worker_tabs,
            entries: [
              { handle: 'a', assignment: args.assignments.a },
              { handle: 'b', assignment: args.assignments.b },
            ],
          };
        },
      },
    });
    assert.equal(result.worker_labels_reconciled, true);
    assert.equal(result.worker_tab_labels_reconciled, true);
    assert.equal(result.worker_assignment_labels_reconciled, true);
    assert.equal(result.layout_prefix, 'DTV Market');
    assert.equal(recorded.worker_tabs[0].layout_name, 'DTV Market 01');
    assert.equal(recorded.assignments.a.layout_name, 'DTV Market 01');
    assert.equal(recorded.assignments.b.layout_name, 'DTV Market 01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
