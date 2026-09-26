/**
 * Canonical market-watch manifest -> logical resident worker universe.
 *
 * The manifest is loaded only from fixed project/user-state locations. Callers
 * may choose named themes and add bounded dynamic entries, but cannot provide an
 * arbitrary filesystem path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWorkerUniverse,
  setUniverse,
  status as workerStatus,
} from './worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const DEFAULT_STATE_ROOT = resolve(
  process.env.LOCALAPPDATA || process.env.HOME || homedir(),
  'tradingview-mcp',
);
const STATE_FILENAME = 'watch-manifest.json';
const PROJECT_FILE = join(PROJECT_ROOT, 'watch-manifest.json');
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DYNAMIC_ENTRIES = 12;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values, field) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function readJson(path) {
  const content = readFileSync(path, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`watch manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('watch manifest is not valid JSON');
  }
}

function normalizeEntry(raw, field) {
  if (!plainObject(raw)) throw new Error(`${field} must be an object`);
  const symbol = String(raw.symbol ?? '').trim();
  const timeframe = String(raw.timeframe ?? '').trim();
  if (!symbol) throw new Error(`${field}.symbol is required`);
  if (!timeframe) throw new Error(`${field}.timeframe is required`);
  const entry = {
    symbol,
    timeframe,
    groups: uniqueStrings(raw.groups, `${field}.groups`),
  };
  const handle = String(raw.handle ?? '').trim();
  if (handle) entry.handle = handle;
  if (raw.studies != null) {
    if (!Array.isArray(raw.studies)) throw new Error(`${field}.studies must be an array`);
    entry.studies = raw.studies;
  }
  return entry;
}

export function normalizeWatchManifest(raw) {
  if (!plainObject(raw)) throw new Error('watch manifest must be a JSON object');
  if (Number(raw.version) !== 1) throw new Error('watch manifest version must be 1');
  if (!plainObject(raw.defaults)) throw new Error('watch manifest defaults are required');
  if (!plainObject(raw.themes)) throw new Error('watch manifest themes are required');

  const defaults = {
    themes: uniqueStrings(raw.defaults.themes, 'defaults.themes'),
    capacity: Number(raw.defaults.capacity ?? 50),
    reserve_slots: Number(raw.defaults.reserve_slots ?? 0),
    max_charts_per_tab: Number(raw.defaults.max_charts_per_tab ?? 8),
  };
  if (!defaults.themes.length) throw new Error('defaults.themes must contain at least one theme');
  if (!Number.isInteger(defaults.capacity) || defaults.capacity < 1) {
    throw new Error('defaults.capacity must be a positive integer');
  }
  if (!Number.isInteger(defaults.reserve_slots) || defaults.reserve_slots < 0 || defaults.reserve_slots >= defaults.capacity) {
    throw new Error('defaults.reserve_slots must be from 0 to capacity - 1');
  }
  if (!Number.isInteger(defaults.max_charts_per_tab) || defaults.max_charts_per_tab < 1 || defaults.max_charts_per_tab > 8) {
    throw new Error('defaults.max_charts_per_tab must be from 1 to 8');
  }

  const themes = {};
  for (const [name, value] of Object.entries(raw.themes)) {
    const key = String(name).trim();
    if (!key || !plainObject(value)) throw new Error('each theme must be a named object');
    if (!Array.isArray(value.entries) || !value.entries.length) {
      throw new Error(`theme ${key} requires entries`);
    }
    themes[key] = {
      description: value.description == null ? null : String(value.description),
      entries: value.entries.map((entry, index) => normalizeEntry(entry, `themes.${key}.entries[${index}]`)),
    };
  }

  for (const theme of defaults.themes) {
    if (!themes[theme]) throw new Error(`default theme not found: ${theme}`);
  }

  return { version: 1, defaults, themes };
}

function deps(overrides) {
  return {
    stateRoot: resolve(overrides?.stateRoot || DEFAULT_STATE_ROOT),
    projectFile: resolve(overrides?.projectFile || PROJECT_FILE),
    status: overrides?.status || workerStatus,
    setUniverse: overrides?.setUniverse || setUniverse,
  };
}

export function loadWatchManifest({ _deps } = {}) {
  const d = deps(_deps);
  const stateFile = join(d.stateRoot, STATE_FILENAME);
  const candidates = [
    { path: stateFile, source: 'user_state' },
    { path: d.projectFile, source: 'project' },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    return {
      source: candidate.source,
      manifest: normalizeWatchManifest(readJson(candidate.path)),
    };
  }
  throw new Error('No watch manifest found in user state or project root');
}

export function compileWatchManifest({
  themes,
  extra_entries,
  manifest,
  previous_entries = [],
} = {}) {
  const config = normalizeWatchManifest(manifest);
  const selectedThemes = themes == null
    ? config.defaults.themes
    : uniqueStrings(themes, 'themes');

  if (!selectedThemes.length) throw new Error('At least one watch theme is required');

  const rawEntries = [];
  const themeSummary = [];
  for (const name of selectedThemes) {
    const theme = config.themes[name];
    if (!theme) throw new Error(`Unknown watch theme: ${name}`);
    for (const entry of theme.entries) {
      rawEntries.push({
        ...entry,
        groups: [...(entry.groups || []), `watch:${name}`],
      });
    }
    themeSummary.push({
      name,
      description: theme.description,
      configured_entries: theme.entries.length,
    });
  }

  const extras = extra_entries == null ? [] : extra_entries;
  if (!Array.isArray(extras)) throw new Error('extra_entries must be an array');
  if (extras.length > MAX_DYNAMIC_ENTRIES) {
    throw new Error(`extra_entries is limited to ${MAX_DYNAMIC_ENTRIES} entries`);
  }
  for (let index = 0; index < extras.length; index++) {
    const entry = normalizeEntry(extras[index], `extra_entries[${index}]`);
    rawEntries.push({
      ...entry,
      groups: [...(entry.groups || []), 'watch:dynamic'],
    });
  }

  const normalized = normalizeWorkerUniverse(rawEntries, {
    capacity: config.defaults.capacity,
    reserveSlots: config.defaults.reserve_slots,
    previousEntries: previous_entries,
  });

  return {
    selected_themes: selectedThemes,
    theme_summary: themeSummary,
    dynamic_entries: extras.length,
    capacity: normalized.capacity,
    reserve_slots: normalized.reserve_slots,
    usable_capacity: normalized.usable_capacity,
    unique_entries: normalized.entries.length,
    free_slots: normalized.usable_capacity - normalized.entries.length,
    max_charts_per_tab: config.defaults.max_charts_per_tab,
    entries: normalized.entries.map(entry => ({
      handle: entry.handle,
      symbol: entry.symbol,
      timeframe: entry.timeframe,
      studies: entry.studies,
      groups: entry.groups,
    })),
  };
}

export function applyWatchManifest({ themes, extra_entries, dry_run = false, _deps } = {}) {
  const d = deps(_deps);
  const loaded = loadWatchManifest({ _deps: d });
  const current = d.status();
  const compiled = compileWatchManifest({
    themes,
    extra_entries,
    manifest: loaded.manifest,
    previous_entries: current.entries || [],
  });

  if (dry_run) {
    return {
      success: true,
      applied: false,
      manifest_source: loaded.source,
      ...compiled,
    };
  }

  const state = d.setUniverse({
    entries: compiled.entries,
    replace: true,
    capacity: compiled.capacity,
    reserve_slots: compiled.reserve_slots,
    max_charts_per_tab: compiled.max_charts_per_tab,
  });

  return {
    success: true,
    applied: true,
    manifest_source: loaded.source,
    selected_themes: compiled.selected_themes,
    theme_summary: compiled.theme_summary,
    dynamic_entries: compiled.dynamic_entries,
    configured: state.configured,
    assigned: state.assigned,
    unassigned: state.unassigned,
    capacity: state.capacity,
    reserve_slots: state.reserve_slots,
    free_slots: state.free_slots,
    groups: state.groups,
  };
}
