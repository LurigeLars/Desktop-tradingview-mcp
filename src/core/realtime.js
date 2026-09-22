/**
 * Read-only realtime snapshots from all open TradingView chart targets/panes.
 *
 * This is the low-latency resident read path for the future worker registry.
 * It never switches symbols, tabs or panes and never mutates chart state.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT, listTradingViewChartTargets } from '../connection.js';
import { normalizeWorkerTimeframe, resolveWorkerSelection } from './worker.js';
import { matchWatchlistSymbol } from './watchlist.js';

const MAX_BARS = 100;
const TARGET_CONCURRENCY = 8;
const TARGET_TIMEOUT_MS = 5000;

export function normalizeSnapshotOptions({
  mode = 'fast',
  bars,
  include_studies,
  study_filters,
} = {}) {
  const normalizedMode = String(mode || 'fast').toLowerCase();
  if (!['fast', 'decision'].includes(normalizedMode)) {
    throw new Error('mode must be "fast" or "decision"');
  }

  const defaultBars = normalizedMode === 'decision' ? 12 : 1;
  const requestedBars = bars == null ? defaultBars : Number(bars);
  if (!Number.isInteger(requestedBars) || requestedBars < 1 || requestedBars > MAX_BARS) {
    throw new Error(`bars must be an integer between 1 and ${MAX_BARS}`);
  }

  const includeStudies = include_studies == null
    ? normalizedMode === 'decision'
    : Boolean(include_studies);

  const filters = Array.isArray(study_filters)
    ? study_filters.map(value => String(value).trim()).filter(Boolean)
    : [];

  return {
    mode: normalizedMode,
    bars: requestedBars,
    includeStudies,
    studyFilters: filters,
  };
}

export function realtimeStatusFromDelay(delayMinutes) {
  if (delayMinutes === 0) return 'realtime';
  if (Number.isFinite(delayMinutes) && delayMinutes > 0) return 'delayed';
  return 'unknown';
}

export function realtimeStatusFromQuote({ is_delay, update_mode, delay_minutes } = {}) {
  if (is_delay === true) return 'delayed';
  if (is_delay === false) return 'realtime';
  if (String(update_mode || '').toLowerCase() === 'streaming') return 'realtime';
  return realtimeStatusFromDelay(delay_minutes);
}

export function ageMsFromEpochSeconds(timestamp, retrievedAtMs) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(retrievedAtMs)) return null;
  return Math.max(0, Math.round(retrievedAtMs - timestamp * 1000));
}

export function filterSnapshotsBySymbols(snapshots, requestedSymbols) {
  const requested = Array.isArray(requestedSymbols)
    ? requestedSymbols.map(value => String(value).trim()).filter(Boolean)
    : [];
  if (requested.length === 0) {
    return { snapshots, missing: [] };
  }

  const wanted = new Set(requested.map(value => value.toUpperCase()));
  const matched = snapshots.filter(item => wanted.has(String(item.resolved_symbol || '').toUpperCase()));
  const found = new Set(matched.map(item => String(item.resolved_symbol || '').toUpperCase()));
  const missing = requested.filter(value => !found.has(value.toUpperCase()));
  return { snapshots: matched, missing };
}

function normalizedResolution(value) {
  try { return normalizeWorkerTimeframe(value); }
  catch { return String(value ?? '').trim(); }
}

function studySpecName(value) {
  return typeof value === 'string'
    ? value.trim()
    : String(value?.name ?? '').trim();
}

function studyInputsMatch(requiredInputs, actualInputs) {
  if (!requiredInputs || Object.keys(requiredInputs).length === 0) return true;
  if (!actualInputs || typeof actualInputs !== 'object') return false;
  return Object.entries(requiredInputs).every(([key, value]) =>
    JSON.stringify(actualInputs[key]) === JSON.stringify(value)
  );
}

export function requiredStudiesPresent(entry, snapshot) {
  const required = (entry?.studies || []).filter(Boolean);
  if (!required.length) return true;
  const present = snapshot?.studies || [];
  if (!present.length) return false;

  return required.every(spec => {
    const name = studySpecName(spec).toUpperCase();
    if (!name) return false;
    const inputs = typeof spec === 'object' && spec ? spec.inputs : undefined;
    return present.some(study =>
      String(study?.name || '').trim().toUpperCase() === name
      && studyInputsMatch(inputs, study?.inputs)
    );
  });
}

export function selectSnapshotsForWorkerEntries(entries, snapshots) {
  const available = (snapshots || []).map((snapshot, index) => ({ snapshot, index }));
  const claimed = new Set();
  const selected = [];
  const unmatched = [];

  for (const entry of entries || []) {
    let candidates = [];

    const wantedTimeframe = normalizedResolution(entry?.timeframe);
    const contentMatches = snapshot =>
      !!matchWatchlistSymbol(entry?.symbol, [snapshot.resolved_symbol]).matched
      && normalizedResolution(snapshot.resolution) === wantedTimeframe;

    if (entry?.assignment?.chart_id != null && entry?.assignment?.pane_index != null) {
      candidates = available.filter(({ snapshot, index }) =>
        !claimed.has(index)
        && String(snapshot.chart_id || '') === String(entry.assignment.chart_id)
        && Number(snapshot.pane_index) === Number(entry.assignment.pane_index)
        && contentMatches(snapshot)
      );
    }

    if (!candidates.length) {
      candidates = available.filter(({ snapshot, index }) =>
        !claimed.has(index) && contentMatches(snapshot)
      );
    }

    if (candidates.length > 1 && (entry?.studies || []).length) {
      const withStudies = candidates.filter(({ snapshot }) => requiredStudiesPresent(entry, snapshot));
      if (withStudies.length) candidates = withStudies;
    }

    if (candidates.length !== 1) {
      unmatched.push({
        handle: entry?.handle || null,
        requested_symbol: entry?.symbol || null,
        timeframe: entry?.timeframe || null,
        reason: candidates.length === 0 ? 'not_resident' : 'ambiguous_resident_match',
        candidate_count: candidates.length,
      });
      continue;
    }

    const chosen = candidates[0];
    claimed.add(chosen.index);
    selected.push({
      ...chosen.snapshot,
      worker_handle: entry.handle,
      worker_key: entry.key,
      worker_groups: entry.groups || [],
      requested_symbol: entry.symbol,
      requested_timeframe: entry.timeframe,
      required_studies: entry.studies || [],
    });
  }

  return { snapshots: selected, unmatched };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  if (items.length === 0) return results;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function buildTargetExpression({ bars, includeStudies, studyFilters }) {
  const config = JSON.stringify({ bars, includeStudies, studyFilters: studyFilters.map(value => value.toLowerCase()) });
  return `
    (function() {
      var config = ${config};
      var retrievedAtMs = Date.now();
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      if (!cwc || typeof cwc.getAll !== 'function') {
        return { retrieved_at_ms: retrievedAtMs, panes: [], error: 'Chart widget collection unavailable' };
      }

      var charts = cwc.getAll() || [];
      var panes = [];

      function finiteOrNull(value) {
        return typeof value === 'number' && isFinite(value) ? value : null;
      }

      function readStudies(chart) {
        if (!config.includeStudies) return [];
        var out = [];
        try {
          var model = chart.model();
          var sources = model && model.model ? model.model().dataSources() : [];
          for (var si = 0; si < sources.length; si++) {
            var source = sources[si];
            if (!source || !source.metaInfo) continue;
            try {
              var meta = source.metaInfo() || {};
              var name = meta.description || meta.shortDescription || '';
              if (!name) continue;
              if (config.studyFilters.length && !config.studyFilters.some(function(filter) {
                return name.toLowerCase().indexOf(filter) !== -1;
              })) continue;

              var values = {};
              try {
                var view = source.dataWindowView ? source.dataWindowView() : null;
                var items = view && view.items ? view.items() : [];
                for (var vi = 0; vi < items.length; vi++) {
                  var item = items[vi];
                  if (item && item._title && item._value != null && item._value !== '∅') {
                    values[item._title] = item._value;
                  }
                }
              } catch(e) {}

              if (Object.keys(values).length) {
                var id = null;
                var inputs = null;
                try { id = source.id ? source.id() : null; } catch(e) {}
                try {
                  inputs = source.inputs ? source.inputs() : null;
                  if (!inputs || typeof inputs !== 'object') inputs = null;
                } catch(e) { inputs = null; }
                out.push({ id: id, name: name, inputs: inputs, values: values });
              }
            } catch(e) {}
          }
        } catch(e) {}
        return out;
      }

      for (var i = 0; i < charts.length; i++) {
        try {
          var chart = charts[i];
          var model = chart && chart.model ? chart.model() : null;
          var series = model && model.mainSeries ? model.mainSeries() : null;
          if (!series) {
            panes.push({ pane_index: i, success: false, error: 'Main series unavailable' });
            continue;
          }

          var symbol = null;
          var resolution = null;
          try { symbol = series.symbol ? series.symbol() : null; } catch(e) {}
          try { resolution = series.interval ? series.interval() : null; } catch(e) {}

          var info = {};
          try {
            info = series.symbolInfo ? series.symbolInfo() : {};
            if (info && typeof info.value === 'function') info = info.value();
            if (!info || typeof info !== 'object') info = {};
          } catch(e) { info = {}; }

          var delayMinutes = finiteOrNull(info.delay);
          var barsObj = null;
          try { barsObj = series.bars ? series.bars() : null; } catch(e) {}

          var recentBars = [];
          if (barsObj && typeof barsObj.lastIndex === 'function' && typeof barsObj.valueAt === 'function') {
            var end = barsObj.lastIndex();
            var first = typeof barsObj.firstIndex === 'function' ? barsObj.firstIndex() : end;
            var start = Math.max(first, end - config.bars + 1);
            for (var bi = start; bi <= end; bi++) {
              var value = barsObj.valueAt(bi);
              if (!value) continue;
              recentBars.push({
                time: value[0],
                open: value[1],
                high: value[2],
                low: value[3],
                close: value[4],
                volume: value[5] == null ? null : value[5],
              });
            }
          }

          var currentBar = recentBars.length ? recentBars[recentBars.length - 1] : null;

          // Read TradingView's already-resident watched quote state. This does
          // not create a quote session and does not switch any symbol/pane.
          var live = {};
          try {
            var provider = series.quotesProvider ? series.quotesProvider() : null;
            var watched = provider && provider.quotes ? provider.quotes() : null;
            live = watched && typeof watched.value === 'function' ? watched.value() : {};
          } catch(e) {}
          if (!live || typeof live !== 'object' || Object.keys(live).length === 0) {
            try { live = series.quotes ? series.quotes() : {}; } catch(e) { live = {}; }
          }
          if (!live || typeof live !== 'object') live = {};

          var last = finiteOrNull(live.last_price);
          if (last == null) last = finiteOrNull(live.lp);
          if (last == null && currentBar) last = finiteOrNull(currentBar.close);

          var bid = finiteOrNull(live.bid);
          var ask = finiteOrNull(live.ask);
          var bidSize = finiteOrNull(live.bid_size);
          var askSize = finiteOrNull(live.ask_size);
          var spread = bid != null && ask != null ? ask - bid : null;
          var mid = bid != null && ask != null ? (bid + ask) / 2 : null;
          var spreadBps = spread != null && mid ? spread / mid * 10000 : null;

          var lpTime = finiteOrNull(live.lp_time);
          var rtcTime = finiteOrNull(live.rtc_time);
          var isDelay = null;
          try {
            var updateModel = series.dataUpdatedModeModel ? series.dataUpdatedModeModel() : null;
            if (updateModel && typeof updateModel.isDelay === 'function') isDelay = !!updateModel.isDelay();
          } catch(e) {}

          var updateMode = live.update_mode == null ? null : String(live.update_mode);
          var currentSession = live.current_session == null ? null : String(live.current_session);
          if (!currentSession) {
            try { currentSession = series.currentSession ? series.currentSession() : null; } catch(e) {}
          }

          var realtimeStatus = 'unknown';
          if (isDelay === true) realtimeStatus = 'delayed';
          else if (isDelay === false) realtimeStatus = 'realtime';
          else if (String(updateMode || '').toLowerCase() === 'streaming') realtimeStatus = 'realtime';
          else if (delayMinutes === 0) realtimeStatus = 'realtime';
          else if (delayMinutes > 0) realtimeStatus = 'delayed';

          var quote = {
            last: last,
            bid: bid,
            ask: ask,
            bid_size: bidSize,
            ask_size: askSize,
            spread: spread,
            spread_bps: spreadBps,
            change: finiteOrNull(live.change),
            change_percent: finiteOrNull(live.change_percent),
            volume: finiteOrNull(live.volume),
            source_timestamp: lpTime,
            source_timestamp_ms: lpTime == null ? null : lpTime * 1000,
            age_ms: lpTime == null ? null : Math.max(0, retrievedAtMs - lpTime * 1000),
            rtc: finiteOrNull(live.rtc),
            rtc_timestamp: rtcTime,
            rtc_timestamp_ms: rtcTime == null ? null : rtcTime * 1000,
            rtc_age_ms: rtcTime == null ? null : Math.max(0, retrievedAtMs - rtcTime * 1000),
            update_mode: updateMode,
            current_session: currentSession,
            is_delay: isDelay,
            source: Object.keys(live).length ? 'resident_quote_state' : 'current_bar_fallback',
          };

          var hasMarketData = quote.last != null || !!currentBar;
          panes.push({
            pane_index: i,
            success: !!(symbol && hasMarketData),
            resolved_symbol: symbol,
            resolution: resolution,
            quote: quote,
            current_bar: currentBar,
            recent_bars: recentBars,
            studies: readStudies(chart),
            metadata: {
              exchange: info.exchange || info.listed_exchange || null,
              instrument_type: info.type || null,
              market_session: currentSession || info.session || null,
              timezone: info.timezone || null,
              delay_minutes: delayMinutes,
              realtime_status: realtimeStatus,
              bar_time_is_period_start: true,
            },
            retrieved_at_ms: retrievedAtMs,
            error: symbol && hasMarketData ? null : 'Symbol and quote/current bar unavailable',
          });
        } catch(e) {
          panes.push({ pane_index: i, success: false, error: e && e.message ? e.message : String(e) });
        }
      }

      return { retrieved_at_ms: retrievedAtMs, panes: panes };
    })()
  `;
}

async function readTarget(target, options) {
  const started = Date.now();
  let client = null;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Runtime.enable();

    const result = await withTimeout(
      client.Runtime.evaluate({
        expression: buildTargetExpression(options),
        returnByValue: true,
        awaitPromise: false,
      }),
      TARGET_TIMEOUT_MS,
      `CDP target ${target.id}`,
    );

    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Unknown evaluation error';
      throw new Error(message);
    }

    const payload = result.result?.value || {};
    if (payload.error) throw new Error(payload.error);
    const chartId = (() => {
      try { return new URL(target.url).pathname.match(/^\/chart\/([^/]+)/i)?.[1] || null; }
      catch { return null; }
    })();

    return {
      success: true,
      target_id: target.id,
      chart_id: chartId,
      target_title: target.title || null,
      duration_ms: Date.now() - started,
      retrieved_at_ms: payload.retrieved_at_ms || Date.now(),
      panes: (payload.panes || []).map(pane => ({
        ...pane,
        target_id: target.id,
        chart_id: chartId,
      })),
    };
  } catch (error) {
    return {
      success: false,
      target_id: target.id,
      target_title: target.title || null,
      duration_ms: Date.now() - started,
      error: error?.message || String(error),
      panes: [],
    };
  } finally {
    try { if (client) await client.close(); } catch { /* best effort */ }
  }
}

export async function realtimeSnapshot({
  symbols,
  handles,
  groups,
  mode,
  bars,
  include_studies,
  study_filters,
  _worker_deps,
} = {}) {
  const options = normalizeSnapshotOptions({ mode, bars, include_studies, study_filters });
  const startedAt = Date.now();
  const targets = await listTradingViewChartTargets();

  const targetResults = await mapLimit(
    targets,
    TARGET_CONCURRENCY,
    target => readTarget(target, options),
  );

  const allSnapshots = targetResults.flatMap(target => target.panes || []);
  const hasWorkerSelector = (Array.isArray(handles) && handles.length > 0)
    || (Array.isArray(groups) && groups.length > 0);
  const hasSymbolSelector = Array.isArray(symbols) && symbols.length > 0;
  if (hasWorkerSelector && hasSymbolSelector) {
    throw new Error('Use either symbols or worker handles/groups in one realtime_snapshot call, not both');
  }

  let filtered;
  let workerSelection = null;
  let unmatchedWorkerEntries = [];
  if (hasWorkerSelector) {
    workerSelection = resolveWorkerSelection({ handles, groups, _deps: _worker_deps });
    const selected = selectSnapshotsForWorkerEntries(workerSelection.entries, allSnapshots);
    filtered = { snapshots: selected.snapshots, missing: [] };
    unmatchedWorkerEntries = selected.unmatched;
  } else {
    filtered = filterSnapshotsBySymbols(allSnapshots, symbols);
  }

  const errors = targetResults
    .filter(target => !target.success)
    .map(target => ({
      target_id: target.target_id,
      target_title: target.target_title,
      error: target.error,
    }));

  const failedSnapshots = filtered.snapshots.filter(snapshot => !snapshot.success).length;

  const missingHandles = workerSelection?.missing_handles || [];
  const missingGroups = workerSelection?.missing_groups || [];
  const workerSelectionComplete = !hasWorkerSelector
    || (missingHandles.length === 0
      && missingGroups.length === 0
      && unmatchedWorkerEntries.length === 0
      && filtered.snapshots.length === workerSelection.entries.length);

  return {
    success: targets.length > 0
      && filtered.missing.length === 0
      && workerSelectionComplete
      && filtered.snapshots.length > 0
      && filtered.snapshots.every(snapshot => snapshot.success),
    mode: options.mode,
    bars_requested: options.bars,
    include_studies: options.includeStudies,
    study_filters: options.studyFilters,
    target_count: targets.length,
    chart_count: allSnapshots.length,
    returned_count: filtered.snapshots.length,
    failed_count: failedSnapshots,
    requested_symbols: Array.isArray(symbols) ? symbols : [],
    requested_handles: Array.isArray(handles) ? handles : [],
    requested_groups: Array.isArray(groups) ? groups : [],
    missing: filtered.missing,
    missing_handles: missingHandles,
    missing_groups: missingGroups,
    unmatched_worker_entries: unmatchedWorkerEntries,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    snapshots: filtered.snapshots,
    errors,
  };
}
