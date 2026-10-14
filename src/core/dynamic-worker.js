/**
 * Bounded on-demand TradingView workers. The existing resident layouts are
 * immutable: only a dedicated suffix tab may be provisioned/reconfigured.
 * One request = at most one physical tab and two pane mutations, no loops.
 */
import { setUniverse, status as workerStatus } from './worker.js';
import { provisionWorker } from './worker-provision.js';

const SYMBOL_RE = /^[A-Za-z0-9_]+:[A-Za-z0-9_!./+\-]+$/;
const DYNAMIC_GROUP = 'watch:dynamic';
const LIMIT = 4;
const MIN_DWELL_MS = 15 * 60 * 1000;

function dynamic(entry) {
  return (entry.groups || []).includes(DYNAMIC_GROUP);
}

export function planDynamicSymbols(state, symbols, { now = Date.now() } = {}) {
  if (!Array.isArray(symbols) || symbols.length > 12)
    throw new Error('dynamic symbols must contain at most 12 qualified entries');
  const wanted = [...new Set(symbols.map(x => String(x).trim().toUpperCase()))];
  if (wanted.some(s => !SYMBOL_RE.test(s)))
    throw new Error('dynamic symbols must be explicit exchange-qualified TradingView identities');
  const entries = state.entries || [];
  const staticEntries = entries.filter(e => !dynamic(e));
  const existing = entries.filter(dynamic);
  if (staticEntries.length < 8 || staticEntries.length % 8 !== 0
      || entries.some((e, i) => dynamic(e) !== (i >= staticEntries.length))
      || existing.length > LIMIT) {
    throw new Error('dynamic pool requires a separated suffix after complete baseline eight-pane tabs');
  }
  if ((state.worker_tabs || []).some(tab => Number(tab.slot) > staticEntries.length / 8))
    throw new Error('unexpected worker slot after dynamic pool; do not change external layouts');
  const free = state.usable_capacity - staticEntries.length;
  if (free < 1) throw new Error('no reserved worker capacity for an isolated dynamic pool');
  const poolLimit = Math.min(free, LIMIT);
  if (existing.length > poolLimit) throw new Error('dynamic worker pool exceeds reserved capacity');

  const resident = new Set(staticEntries.map(e => e.symbol.toUpperCase()));
  const candidates = wanted.filter(s => !resident.has(s));
  const next = existing.map(e => ({
    handle: e.handle, symbol: e.symbol, timeframe: e.timeframe,
    studies: e.studies || [], groups: e.groups || [DYNAMIC_GROUP],
    assignment: e.assignment,
  }));
  let changed = false;
  // Fill free slots before evicting any already-assigned dynamic chart.
  for (const symbol of candidates) {
    if (next.some(e => e.symbol.toUpperCase() === symbol)) continue;
    if (next.length >= poolLimit) break;
    next.push({
      handle: 'dynamic-' + next.length, symbol,
      timeframe: '60', studies: [], groups: [DYNAMIC_GROUP],
      assignment: null,
    });
    changed = true;
  }
  // If full, rotate only ONE stale unused slot in a request; avoid churn.
  if (!changed && next.length === poolLimit) {
    const needed = candidates.find(s => !next.some(e => e.symbol.toUpperCase() === s));
    const candidatesToEvict = next
      .map((e, index) => ({ e, index, last: Date.parse(e.assignment?.provisioned_at || '') || 0 }))
      .filter(({ e }) => !wanted.includes(e.symbol.toUpperCase()))
      .sort((a, b) => a.last - b.last);
    const victim = candidatesToEvict[0];
    if (needed && victim && now - victim.last >= MIN_DWELL_MS) {
      next[victim.index] = {
        ...next[victim.index], symbol: needed, timeframe: '60',
        studies: [], groups: [DYNAMIC_GROUP], assignment: null,
      };
      changed = true;
    }
  }

  const selected = next.map(e => e.symbol);
  const blocked = candidates.filter(s => !selected.includes(s));
  const config = [
    ...staticEntries.map(e => ({
      handle: e.handle, symbol: e.symbol, timeframe: e.timeframe,
      studies: e.studies || [], groups: e.groups || [],
    })),
    ...next.map(({ assignment, ...e }) => e),
  ];
  return {
    success: true, base_entries: staticEntries.length,
    dynamic_slot: staticEntries.length / 8,
    pool_capacity: poolLimit, selected, blocked,
    requested: wanted, changed,
    entries: config,
    planned_panes: next.length,
  };
}

export async function ensureDynamicSymbols({
  symbols, dry_run = false, max_panes = 2, _deps,
} = {}) {
  const d = {
    status: _deps?.status || workerStatus,
    setUniverse: _deps?.setUniverse || setUniverse,
    provision: _deps?.provision || provisionWorker,
    now: _deps?.now || (() => Date.now()),
  };
  const before = d.status();
  const plan = planDynamicSymbols(before, symbols || [], { now: d.now() });
  const safe = {
    success: true, dry_run: !!dry_run,
    requested: plan.requested, dynamic_slot: plan.dynamic_slot,
    pool_capacity: plan.pool_capacity, selected: plan.selected,
    blocked: plan.blocked, configuration_changed: plan.changed,
    baseline_preserved: true,
  };
  if (dry_run || !plan.selected.length) return { ...safe, provisioned: false };
  if (plan.changed) {
    d.setUniverse({
      entries: plan.entries, replace: true,
      capacity: before.capacity, reserve_slots: before.reserve_slots,
      max_charts_per_tab: before.max_charts_per_tab,
    });
  }
  const bounded = Math.max(1, Math.min(2, Number(max_panes) || 1));
  const operation = await d.provision({
    only_slots: [plan.dynamic_slot], max_tabs: 1, max_panes: bounded,
  });
  return {
    ...safe, provisioned: operation.complete === true,
    stage: operation.results?.[0]?.stage || 'already_assigned',
    configured_panes: operation.results?.[0]?.configured_panes || [],
    pending_tabs: operation.remaining_tabs || [],
    capacity_projection: operation.capacity_projection,
    // Tool never implies fresh quotes. Call realtime_snapshot afterwards.
    snapshots_fetched: false, execution_quote: false,
  };
}
