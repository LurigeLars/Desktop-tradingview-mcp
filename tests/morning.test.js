import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getMorningSession,
  localDateString,
  normalizeMorningRules,
  runMorningBrief,
  saveMorningSession,
  validateSessionDate,
} from '../src/core/morning.js';

test('morning rules require one safe selection mode', () => {
  assert.throws(
    () => normalizeMorningRules({ selection: { symbols: ['AAPL'], groups: ['morning'] } }),
    /symbols or worker handles\/groups/,
  );
  assert.throws(
    () => normalizeMorningRules({ selection: {} }),
    /require at least one/,
  );

  const rules = normalizeMorningRules({
    selection: { handles: ['alpha', 'alpha'], groups: ['morning'] },
    snapshot: { bars: 20, stale_after_ms: 2500, study_filters: ['RSI'] },
    risk_rules: ['Max two positions'],
  });
  assert.deepEqual(rules.selection.handles, ['alpha']);
  assert.deepEqual(rules.selection.groups, ['morning']);
  assert.equal(rules.snapshot.bars, 20);
  assert.equal(rules.snapshot.stale_after_ms, 2500);
});

test('morning brief uses resident decision snapshot and keeps evidence separate from interpretation rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-morning-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'morning-rules.json'), JSON.stringify({
      selection: { groups: ['morning'] },
      snapshot: { bars: 12, study_filters: ['RSI'], stale_after_ms: 5000 },
      bias_criteria: { bullish: ['Price above EMA'] },
      risk_rules: ['No stale evidence'],
      notes: 'Synthetic test rules',
    }), 'utf8');

    let snapshotArgs = null;
    const result = await runMorningBrief({
      _deps: {
        stateRoot: root,
        projectRules: join(root, 'unused-rules.json'),
        now: () => new Date(2026, 8, 26, 9, 30, 0),
        snapshot: async args => {
          snapshotArgs = args;
          return {
            success: true,
            snapshots: [{ worker_handle: 'alpha', resolved_symbol: 'EX:AAA', studies: [] }],
            missing_groups: [],
            unmatched_worker_entries: [],
          };
        },
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.rules_source, 'user_state');
    assert.equal(result.evidence_mode, 'compact');
    assert.equal('rules_loaded_from' in result, false);
    assert.deepEqual(result.selection.groups, ['morning']);
    assert.deepEqual(result.rules.bias_criteria, { bullish: ['Price above EMA'] });
    assert.equal(result.evidence.snapshots[0].resolved_symbol, 'EX:AAA');
    assert.equal('recent_bars' in result.evidence.snapshots[0], false);
    assert.equal(snapshotArgs.mode, 'decision');
    assert.equal(snapshotArgs.include_studies, true);
    assert.equal(snapshotArgs.bars, 12);
    assert.deepEqual(snapshotArgs.groups, ['morning']);
    assert.deepEqual(snapshotArgs.study_filters, ['RSI']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit symbol selection overrides configured worker selection without mutating rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-morning-'));
  try {
    writeFileSync(join(root, 'morning-rules.json'), JSON.stringify({
      selection: { groups: ['morning'] },
    }), 'utf8');

    let snapshotArgs = null;
    const result = await runMorningBrief({
      symbols: ['NASDAQ:AAPL'],
      _deps: {
        stateRoot: root,
        projectRules: join(root, 'unused-rules.json'),
        now: () => new Date(2026, 8, 26, 9, 30, 0),
        snapshot: async args => {
          snapshotArgs = args;
          return { success: true, snapshots: [{ resolved_symbol: 'NASDAQ:AAPL' }] };
        },
      },
    });

    assert.deepEqual(result.selection.symbols, ['NASDAQ:AAPL']);
    assert.deepEqual(result.rules.risk_rules, []);
    assert.deepEqual(snapshotArgs.symbols, ['NASDAQ:AAPL']);
    assert.equal('groups' in snapshotArgs, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session dates reject traversal and invalid calendar values', () => {
  assert.equal(validateSessionDate('2026-09-26'), '2026-09-26');
  assert.throws(() => validateSessionDate('../2026-09-26'), /YYYY-MM-DD/);
  assert.throws(() => validateSessionDate('2026-02-31'), /valid calendar date/);
});

test('session save/get stays inside the fixed state directory and falls back to yesterday', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-morning-'));
  try {
    const now = new Date(2026, 8, 26, 9, 30, 0);
    const yesterday = new Date(2026, 8, 25, 9, 30, 0);
    assert.equal(localDateString(now), '2026-09-26');

    const depsToday = { stateRoot: root, now: () => now };
    const saved = saveMorningSession({
      brief: 'Today brief',
      evidence: { success: true },
      _deps: depsToday,
    });
    assert.deepEqual(saved, { success: true, date: '2026-09-26', overwritten: false });
    const current = getMorningSession({ _deps: depsToday });
    assert.equal(current.success, true);
    assert.equal(current.source, 'today');
    assert.equal(current.brief, 'Today brief');

    rmSync(join(root, 'sessions', '2026-09-26.json'));
    saveMorningSession({
      brief: 'Yesterday brief',
      date: '2026-09-25',
      _deps: { stateRoot: root, now: () => yesterday },
    });
    const fallback = getMorningSession({ _deps: depsToday });
    assert.equal(fallback.success, true);
    assert.equal(fallback.source, 'yesterday');
    assert.equal(fallback.brief, 'Yesterday brief');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('morning brief full evidence mode preserves recent bars', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-morning-'));
  try {
    writeFileSync(join(root, 'morning-rules.json'), JSON.stringify({
      selection: { groups: ['morning'] },
    }), 'utf8');

    const result = await runMorningBrief({
      evidence_mode: 'full',
      _deps: {
        stateRoot: root,
        projectRules: join(root, 'unused-rules.json'),
        now: () => new Date(2026, 8, 26, 9, 30, 0),
        snapshot: async () => ({
          success: true,
          snapshots: [{
            resolved_symbol: 'EX:AAA',
            recent_bars: [
              { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 },
              { time: 2, open: 10, high: 12, low: 10, close: 11, volume: 120 },
            ],
          }],
        }),
      },
    });

    assert.equal(result.evidence_mode, 'full');
    assert.equal(result.evidence.snapshots[0].recent_bars.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('project defaults merge with local morning overrides without losing bias criteria', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dtv-morning-'));
  try {
    const projectRules = join(root, 'rules.json');
    writeFileSync(projectRules, JSON.stringify({
      selection: { groups: ['morning'] },
      snapshot: { bars: 12, stale_after_ms: 5000 },
      bias_criteria: { bullish: ['project bullish rule'], bearish: ['project bearish rule'] },
      risk_rules: ['project risk'],
      notes: 'project note',
    }), 'utf8');
    writeFileSync(join(root, 'morning-rules.json'), JSON.stringify({
      selection: { groups: ['morning'] },
      snapshot: { bars: 20 },
      risk_rules: ['local risk'],
      notes: 'local note',
    }), 'utf8');

    const result = await runMorningBrief({
      _deps: {
        stateRoot: root,
        projectRules,
        now: () => new Date(2026, 8, 27, 9, 0, 0),
        snapshot: async () => ({ success: true, snapshots: [] }),
      },
    });

    assert.equal(result.rules_source, 'project+user_state');
    assert.equal(result.evidence.bars_requested, undefined);
    assert.deepEqual(result.rules.bias_criteria, {
      bullish: ['project bullish rule'],
      bearish: ['project bearish rule'],
    });
    assert.deepEqual(result.rules.risk_rules, ['project risk', 'local risk']);
    assert.equal(result.rules.notes, 'local note');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
