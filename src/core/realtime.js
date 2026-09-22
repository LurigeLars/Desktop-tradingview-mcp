/**
 * Read-only realtime snapshots from all open TradingView chart targets/panes.
 *
 * This is the low-latency resident read path for the future worker registry.
 * It never switches symbols, tabs or panes and never mutates chart state.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT, listTradingViewChartTargets } from '../connection.js';

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
                try { id = source.id ? source.id() : null; } catch(e) {}
                out.push({ id: id, name: name, values: values });
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
          panes.push({
            pane_index: i,
            success: !!(symbol && currentBar),
            resolved_symbol: symbol,
            resolution: resolution,
            quote: {
              last: currentBar ? currentBar.close : null,
              bid: null,
              ask: null,
              spread: null,
              spread_bps: null,
              source_timestamp: null,
              age_ms: null,
            },
            current_bar: currentBar,
            recent_bars: recentBars,
            studies: readStudies(chart),
            metadata: {
              exchange: info.exchange || info.listed_exchange || null,
              instrument_type: info.type || null,
              market_session: info.session || null,
              timezone: info.timezone || null,
              delay_minutes: delayMinutes,
              realtime_status: delayMinutes === 0 ? 'realtime' : (delayMinutes > 0 ? 'delayed' : 'unknown'),
              bar_time_is_period_start: true,
            },
            retrieved_at_ms: retrievedAtMs,
            error: symbol && currentBar ? null : 'Symbol or current bar unavailable',
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
  mode,
  bars,
  include_studies,
  study_filters,
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
  const filtered = filterSnapshotsBySymbols(allSnapshots, symbols);
  const errors = targetResults
    .filter(target => !target.success)
    .map(target => ({
      target_id: target.target_id,
      target_title: target.target_title,
      error: target.error,
    }));

  const failedSnapshots = filtered.snapshots.filter(snapshot => !snapshot.success).length;

  return {
    success: targets.length > 0
      && filtered.missing.length === 0
      && filtered.snapshots.some(snapshot => snapshot.success),
    mode: options.mode,
    bars_requested: options.bars,
    include_studies: options.includeStudies,
    study_filters: options.studyFilters,
    target_count: targets.length,
    chart_count: allSnapshots.length,
    returned_count: filtered.snapshots.length,
    failed_count: failedSnapshots,
    requested_symbols: Array.isArray(symbols) ? symbols : [],
    missing: filtered.missing,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    snapshots: filtered.snapshots,
    errors,
  };
}
