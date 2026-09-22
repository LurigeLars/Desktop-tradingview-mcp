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

function defaultMaxChartsPerTab() {
  const configured = Number(process.env.TV_WORKER_MAX_CHARTS_PER_TAB || 8);
  return Number.isInteger(configured) && configured >= 1 && configured <= 8 ? configured : 8;
}

const SUPPORTED_PANE_COUNTS = Object.freeze([8, 6, 4, 3, 2, 1]);

export function planPaneCounts(entryCount, { maxChartsPerTab = defaultMaxChartsPerTab() } = {}) {
  const count = Number(entryCount);
  const maxPerTab = Number(maxChartsPerTab);
  if (!Number.isInteger(count) || count < 0) throw new Error('entry_count must be a non-negative integer');
  if (!Number.isInteger(maxPerTab) || maxPerTab < 1 || maxPerTab > 8) {
    throw new Error('max_charts_per_tab must be an integer from 1 to 8');
  }
  if (count === 0) return [];

  const supported = SUPPORTED_PANE_COUNTS.filter(value => value <= maxPerTab);
  const plan = [];
  let remaining = count;
  while (remaining > 0) {
    const paneCount = supported.find(value => value <= remaining);
    if (!paneCount) throw new Error('No supported TradingView pane layout can represent the remaining entries');
    plan.push(paneCount);
    remaining -= paneCount;
  }
  return plan;
}

export function planWorkerTopology(entries, { maxChartsPerTab = defaultMaxChartsPerTab() } = {}) {
  const list = entries || [];
  const paneCounts = planPaneCounts(list.length, { maxChartsPerTab });
  const tabs = [];
  let offset = 0;
  for (let index = 0; index < paneCounts.length; index++) {
    const paneCount = paneCounts[index];
    const tabEntries = list.slice(offset, offset + paneCount);
    tabs.push({
      tab_index: index,
      pane_count: paneCount,
      handles: tabEntries.map(entry => entry.handle),
    });
    offset += paneCount;
  }
  return {
    tab_count: tabs.length,
    max_charts_per_tab: Number(maxChartsPerTab),
    total_entries: list.length,
    tabs,
  };
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function normalizeStudySpecs(studies = []) {
  const byKey = new Map();
  for (const raw of studies || []) {
    let name;
    let inputs;

    if (typeof raw === 'string') {
      name = raw.trim();
      inputs = undefined;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      name = String(raw.name ?? '').trim();
      if (raw.inputs != null) {
        if (!raw.inputs || typeof raw.inputs !== 'object' || Array.isArray(raw.inputs)) {
          throw new Error('study inputs must be an object when provided');
        }
        inputs = stableValue(raw.inputs);
      }
    } else {
      throw new Error('Each study must be a name string or {name, inputs} object');
    }

    if (!name) throw new Error('Each study requires a non-empty name');
    const key = name.toUpperCase() + '|' + stableJson(inputs ?? {});
    if (!byKey.has(key)) {
      byKey.set(key, inputs === undefined ? { name } : { name, inputs });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const ak = a.name.toUpperCase() + '|' + stableJson(a.inputs ?? {});
    const bk = b.name.toUpperCase() + '|' + stableJson(b.inputs ?? {});
    return ak.localeCompare(bk);
  });
}

export function buildWorkerKey({ symbol, timeframe, studies = [] }) {
  const normalizedSymbol = String(symbol ?? '').trim();
  if (!normalizedSymbol) throw new Error('symbol is required');
  const normalizedTimeframe = normalizeWorkerTimeframe(timeframe);
  const normalizedStudies = normalizeStudySpecs(studies).map(study =>
    study.name.toUpperCase() + ':' + stableJson(study.inputs ?? {})
  );
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
  const studies = normalizeStudySpecs(raw?.studies);
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
  const maxChartsPerTab = state.max_charts_per_tab ?? defaultMaxChartsPerTab();
  return {
    success: true,
    configured: entries.length,
    assigned,
    unassigned: entries.length - assigned,
    capacity: state.capacity,
    reserve_slots: state.reserve_slots,
    usable_capacity: state.capacity - state.reserve_slots,
    free_slots: Math.max(0, state.capacity - state.reserve_slots - entries.length),
    max_charts_per_tab: maxChartsPerTab,
    topology_plan: planWorkerTopology(entries, { maxChartsPerTab }),
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
  max_charts_per_tab,
  _deps,
} = {}) {
  const d = deps(_deps);
  const previous = d.loadState();
  const effectiveCapacity = capacity ?? previous?.capacity ?? defaultCapacity();
  const effectiveReserve = reserve_slots ?? previous?.reserve_slots ?? 0;
  const effectiveMaxChartsPerTab = max_charts_per_tab
    ?? previous?.max_charts_per_tab
    ?? defaultMaxChartsPerTab();
  planPaneCounts(0, { maxChartsPerTab: effectiveMaxChartsPerTab });

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
    max_charts_per_tab: effectiveMaxChartsPerTab,
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
    max_charts_per_tab: defaultMaxChartsPerTab(),
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
