/**
 * Logical resident-worker registry.
 *
 * Stores user-configured realtime entries independently of the physical
 * TradingView tab/pane layout.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;
const STATE_FILE = join(
  process.env.LOCALAPPDATA || process.env.HOME || '.',
  'tradingview-mcp',
  'worker-state.json',
);

function defaultCapacity() {
  const configured = Number(process.env.TV_WORKER_MAX_CONNECTIONS || 50);
  return Number.isInteger(configured) && configured > 0 ? configured : 50;
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, STATE_FILE);
}

function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return state?.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

function deps(overrides) {
  return {
    loadState: overrides?.loadState || loadState,
    saveState: overrides?.saveState || saveState,
    now: overrides?.now || (() => Date.now()),
  };
}

export function normalizeWorkerTimeframe(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('timeframe is required');

  if (/^\d+$/.test(raw)) return String(Number(raw));

  let match = raw.match(/^(\d+)s$/i);
  if (match) return String(Number(match[1])) + 'S';

  match = raw.match(/^(\d+)(?:m|min)$/i);
  if (match) return String(Number(match[1]));

  match = raw.match(/^(\d+)h$/i);
  if (match) return String(Number(match[1]) * 60);

  match = raw.match(/^(\d+)d$/i);
  if (match) return String(Number(match[1])) + 'D';

  match = raw.match(/^(\d+)w$/i);
  if (match) return String(Number(match[1])) + 'W';

  match = raw.match(/^(\d+)(?:mo|month)$/i);
  if (match) return String(Number(match[1])) + 'M';

  if (/^\d+M$/.test(raw)) return raw;
  if (/^D$/i.test(raw)) return '1D';
  if (/^W$/i.test(raw)) return '1W';
  if (raw === 'M') return '1M';

  // Preserve unknown non-empty tokens: TradingView supports additional
  // resolutions across products/builds.
  return raw;
}

function uniqueStrings(values, { sort = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const key = text.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return sort ? out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) : out;
}

export function buildWorkerKey({ symbol, timeframe, studies = [] }) {
  const normalizedSymbol = String(symbol ?? '').trim();
  if (!normalizedSymbol) throw new Error('symbol is required');
  const normalizedTimeframe = normalizeWorkerTimeframe(timeframe);
  const normalizedStudies = uniqueStrings(studies).map(value => value.toUpperCase());
  return [
    normalizedSymbol.toUpperCase(),
    normalizedTimeframe.toUpperCase(),
    ...normalizedStudies,
  ].join('|');
}

function generatedHandle(key) {
  return 'w_' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function normalizeEntry(raw, previousByKey) {
  const symbol = String(raw?.symbol ?? '').trim();
  if (!symbol) throw new Error('Each worker entry requires symbol');

  const timeframe = normalizeWorkerTimeframe(raw?.timeframe);
  const studies = uniqueStrings(raw?.studies);
  const groups = uniqueStrings(raw?.groups);
  const key = buildWorkerKey({ symbol, timeframe, studies });
  const previous = previousByKey?.get(key) || null;

  const requestedHandle = String(raw?.handle ?? '').trim();
  const handle = requestedHandle || previous?.handle || generatedHandle(key);

  return {
    handle,
    key,
    symbol,
    timeframe,
    studies,
    groups,
    assignment: previous?.assignment || null,
  };
}

export function normalizeWorkerUniverse(entries, {
  capacity = defaultCapacity(),
  reserveSlots = 0,
  previousEntries = [],
} = {}) {
  const cap = Number(capacity);
  const reserve = Number(reserveSlots);
  if (!Number.isInteger(cap) || cap < 1) throw new Error('capacity must be a positive integer');
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= cap) {
    throw new Error('reserve_slots must be an integer from 0 up to capacity - 1');
  }

  const previousByKey = new Map((previousEntries || []).map(entry => [entry.key, entry]));
  const byKey = new Map();
  const handleToKey = new Map();

  for (const raw of entries || []) {
    const entry = normalizeEntry(raw, previousByKey);
    const existing = byKey.get(entry.key);

    if (existing) {
      if (raw?.handle && existing.handle !== entry.handle) {
        throw new Error('Equivalent worker entry already uses handle "' + existing.handle + '"');
      }
      existing.groups = uniqueStrings([...existing.groups, ...entry.groups]);
      continue;
    }

    const priorKeyForHandle = handleToKey.get(entry.handle);
    if (priorKeyForHandle && priorKeyForHandle !== entry.key) {
      throw new Error('Worker handle "' + entry.handle + '" is used by multiple distinct entries');
    }

    handleToKey.set(entry.handle, entry.key);
    byKey.set(entry.key, entry);
  }

  const normalized = [...byKey.values()];
  const usableCapacity = cap - reserve;
  if (normalized.length > usableCapacity) {
    throw new Error(
      'Worker universe has ' + normalized.length + ' unique entries but only ' +
      usableCapacity + ' usable slots (capacity ' + cap + ', reserve ' + reserve + ')',
    );
  }

  return {
    capacity: cap,
    reserve_slots: reserve,
    usable_capacity: usableCapacity,
    entries: normalized,
  };
}

function buildGroupSummary(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    for (const group of entry.groups || []) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry.handle);
    }
  }
  return [...groups.entries()]
    .map(([name, handles]) => ({ name, handles, count: handles.length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function stateSummary(state) {
  const entries = state?.entries || [];
  const assigned = entries.filter(entry => entry.assignment).length;
  return {
    success: true,
    configured: entries.length,
    assigned,
    unassigned: entries.length - assigned,
    capacity: state.capacity,
    reserve_slots: state.reserve_slots,
    usable_capacity: state.capacity - state.reserve_slots,
    free_slots: Math.max(0, state.capacity - state.reserve_slots - entries.length),
    groups: buildGroupSummary(entries),
    updated_at: state.updated_at || null,
    entries,
  };
}

export function setUniverse({
  entries = [],
  replace = true,
  capacity,
  reserve_slots,
  _deps,
} = {}) {
  const d = deps(_deps);
  const previous = d.loadState();
  const effectiveCapacity = capacity ?? previous?.capacity ?? defaultCapacity();
  const effectiveReserve = reserve_slots ?? previous?.reserve_slots ?? 0;

  const combined = replace
    ? entries
    : [
        ...(previous?.entries || []).map(entry => ({
          handle: entry.handle,
          symbol: entry.symbol,
          timeframe: entry.timeframe,
          studies: entry.studies,
          groups: entry.groups,
        })),
        ...entries,
      ];

  const normalized = normalizeWorkerUniverse(combined, {
    capacity: effectiveCapacity,
    reserveSlots: effectiveReserve,
    previousEntries: previous?.entries || [],
  });

  const state = {
    version: STATE_VERSION,
    capacity: normalized.capacity,
    reserve_slots: normalized.reserve_slots,
    updated_at: new Date(d.now()).toISOString(),
    entries: normalized.entries,
  };
  d.saveState(state);
  return stateSummary(state);
}

export function status({ _deps } = {}) {
  const d = deps(_deps);
  const state = d.loadState() || {
    version: STATE_VERSION,
    capacity: defaultCapacity(),
    reserve_slots: 0,
    updated_at: null,
    entries: [],
  };
  return stateSummary(state);
}

export function resolveWorkerSelection({ handles = [], groups = [], _deps } = {}) {
  const state = status({ _deps });
  const requestedHandles = uniqueStrings(handles, { sort: false });
  const requestedGroups = uniqueStrings(groups, { sort: false });

  if (!requestedHandles.length && !requestedGroups.length) {
    return { entries: state.entries, missing_handles: [], missing_groups: [] };
  }

  const byHandle = new Map(state.entries.map(entry => [entry.handle, entry]));
  const groupNames = new Set(state.groups.map(group => group.name));
  const selected = new Map();
  const missingHandles = [];
  const missingGroups = [];

  for (const handle of requestedHandles) {
    const entry = byHandle.get(handle);
    if (entry) selected.set(entry.key, entry);
    else missingHandles.push(handle);
  }

  for (const group of requestedGroups) {
    if (!groupNames.has(group)) {
      missingGroups.push(group);
      continue;
    }
    for (const entry of state.entries) {
      if ((entry.groups || []).includes(group)) selected.set(entry.key, entry);
    }
  }

  return {
    entries: [...selected.values()],
    missing_handles: missingHandles,
    missing_groups: missingGroups,
  };
}
