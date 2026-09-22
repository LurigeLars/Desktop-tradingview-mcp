/**
 * Physical provisioning for the logical realtime worker registry.
 *
 * Provisioning is deliberately resumable: by default one worker tab is
 * reconciled per call so the remote MCP request stays bounded.
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT, listTradingViewChartTargets } from '../connection.js';
import * as tabCore from './tab.js';
import {
  normalizeWorkerTimeframe,
  recordWorkerProvision,
  status as workerStatus,
} from './worker.js';
import { requiredStudiesPresent } from './realtime.js';
import { matchWatchlistSymbol } from './watchlist.js';

const PANE_LAYOUT_CODES = Object.freeze({
  1: 's',
  2: '2h',
  3: '3h',
  4: '4',
  6: '6',
  8: '8',
});

export function layoutCodeForPaneCount(paneCount) {
  const code = PANE_LAYOUT_CODES[Number(paneCount)];
  if (!code) throw new Error('Unsupported worker pane count: ' + paneCount);
  return code;
}

export function buildWorkerLayoutName(prefix, slot) {
  const base = String(prefix || 'DTV Worker').trim() || 'DTV Worker';
  return base + ' ' + String(Number(slot) + 1).padStart(2, '0');
}

function chartIdFromTarget(target) {
  try {
    return new URL(target.url).pathname.match(/^\/chart\/([^/]+)/i)?.[1] || null;
  } catch {
    return null;
  }
}

function resolveDeps(overrides) {
  return {
    status: overrides?.status || workerStatus,
    record: overrides?.record || recordWorkerProvision,
    listTargets: overrides?.listTargets || listTradingViewChartTargets,
    newTab: overrides?.newTab || tabCore.newTab,
    closeTabByChartId: overrides?.closeTabByChartId || closeTabByChartId,
    configureTarget: overrides?.configureTarget || configureTarget,
    now: overrides?.now || (() => Date.now()),
  };
}

function entryMap(state) {
  return new Map((state.entries || []).map(entry => [entry.handle, entry]));
}

function workerTabMap(state) {
  return new Map((state.worker_tabs || []).map(tab => [Number(tab.slot), tab]));
}

export function recordedTabComplete(plan, state, liveChartIds = new Set()) {
  const tabs = workerTabMap(state);
  const entries = entryMap(state);
  const owned = tabs.get(Number(plan.tab_index));
  if (!owned?.chart_id || !liveChartIds.has(String(owned.chart_id))) return false;

  return plan.handles.every((handle, paneIndex) => {
    const assignment = entries.get(handle)?.assignment;
    return assignment
      && Number(assignment.worker_slot) === Number(plan.tab_index)
      && String(assignment.chart_id || '') === String(owned.chart_id)
      && Number(assignment.pane_index) === paneIndex;
  });
}

async function evaluateValue(client, expression, { awaitPromise = false } = {}) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown TradingView evaluation error';
    throw new Error(message);
  }
  return result.result?.value;
}

async function waitForPaneCount(client, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const count = await evaluateValue(
      client,
      'window.TradingViewApi._chartWidgetCollection.getAll().length',
    );
    if (Number(count) === Number(expected)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (true);
  throw new Error('TradingView pane layout did not reach ' + expected + ' charts');
}

function configurePaneExpression(index, entry) {
  const config = JSON.stringify({
    index,
    symbol: entry.symbol,
    timeframe: entry.timeframe,
    studies: entry.studies || [],
  });

  return `
    (async function() {
      var cfg = ${config};
      var sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      if (!cwc || typeof cwc.getAll !== 'function') throw new Error('Chart collection unavailable');
      var panes = cwc.getAll();
      var pane = panes[cfg.index];
      if (!pane) throw new Error('Pane ' + cfg.index + ' unavailable');

      if (pane._mainDiv && typeof pane._mainDiv.click === 'function') pane._mainDiv.click();
      await sleep(120);

      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      if (!chart) throw new Error('Active chart unavailable after focusing pane ' + cfg.index);

      // Worker-owned layouts are dedicated. Re-provisioning starts from a
      // clean study surface so stale indicator instances cannot survive.
      try {
        var existing = chart.getAllStudies ? chart.getAllStudies() : [];
        for (var ei = 0; ei < existing.length; ei++) {
          try { chart.removeEntity(existing[ei].id); } catch(e) {}
        }
      } catch(e) {}

      chart.setSymbol(cfg.symbol, {});
      await sleep(600);
      chart.setResolution(cfg.timeframe, {});
      await sleep(600);

      var studyResults = [];
      for (var si = 0; si < cfg.studies.length; si++) {
        var spec = cfg.studies[si];
        var before = chart.getAllStudies ? chart.getAllStudies().map(function(s) { return s.id; }) : [];

        chart.createStudy(spec.name, false, false, []);
        await sleep(1200);

        var after = chart.getAllStudies ? chart.getAllStudies() : [];
        var created = null;
        for (var ai = 0; ai < after.length; ai++) {
          if (before.indexOf(after[ai].id) === -1) { created = after[ai]; break; }
        }
        if (!created) {
          studyResults.push({ name: spec.name, success: false, error: 'Study was not created' });
          continue;
        }

        var applied = {};
        var unknown = [];
        if (spec.inputs && Object.keys(spec.inputs).length) {
          try {
            var study = chart.getStudyById(created.id);
            var current = study.getInputValues();
            var known = {};
            for (var ci = 0; ci < current.length; ci++) known[current[ci].id] = ci;
            for (var key in spec.inputs) {
              if (Object.prototype.hasOwnProperty.call(known, key)) {
                current[known[key]].value = spec.inputs[key];
                applied[key] = spec.inputs[key];
              } else {
                unknown.push(key);
              }
            }
            study.setInputValues(current);
          } catch(e) {
            studyResults.push({ name: spec.name, success: false, entity_id: created.id, error: e.message });
            continue;
          }
        }

        studyResults.push({
          name: spec.name,
          success: unknown.length === 0,
          entity_id: created.id,
          applied_inputs: applied,
          unknown_inputs: unknown,
        });
      }

      return { success: studyResults.every(function(item) { return item.success; }), studies: studyResults };
    })()
  `;
}

function readPaneStatesExpression() {
  return `
    (function() {
      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var panes = cwc && cwc.getAll ? cwc.getAll() : [];
      var out = [];

      for (var i = 0; i < panes.length; i++) {
        try {
          var pane = panes[i];
          var model = pane.model ? pane.model() : null;
          var series = model && model.mainSeries ? model.mainSeries() : null;
          var symbol = series && series.symbol ? series.symbol() : null;
          var resolution = series && series.interval ? series.interval() : null;
          var studies = [];

          var sources = model && model.model ? model.model().dataSources() : [];
          for (var si = 0; si < sources.length; si++) {
            var source = sources[si];
            if (!source || !source.metaInfo) continue;
            try {
              var meta = source.metaInfo() || {};
              var name = meta.description || meta.shortDescription || '';
              if (!name) continue;
              var inputs = null;
              try {
                inputs = source.inputs ? source.inputs() : null;
                if (!inputs || typeof inputs !== 'object') inputs = null;
              } catch(e) { inputs = null; }
              studies.push({ name: name, inputs: inputs });
            } catch(e) {}
          }

          out.push({
            pane_index: i,
            resolved_symbol: symbol,
            resolution: resolution,
            studies: studies,
          });
        } catch(e) {
          out.push({ pane_index: i, error: e.message });
        }
      }
      return out;
    })()
  `;
}

function paneMatchesEntry(entry, pane) {
  if (!pane || pane.error) return false;
  const symbolMatch = matchWatchlistSymbol(entry.symbol, [pane.resolved_symbol]);
  if (!symbolMatch.matched) return false;
  try {
    if (normalizeWorkerTimeframe(pane.resolution) !== normalizeWorkerTimeframe(entry.timeframe)) return false;
  } catch {
    return false;
  }
  return requiredStudiesPresent(entry, pane);
}

async function verifyConfiguredTarget(client, entries, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  do {
    last = await evaluateValue(client, readPaneStatesExpression());
    const complete = entries.every((entry, index) => paneMatchesEntry(entry, last[index]));
    if (complete) return last;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (true);

  const mismatches = entries.map((entry, index) => ({
    handle: entry.handle,
    pane_index: index,
    requested_symbol: entry.symbol,
    requested_timeframe: entry.timeframe,
    observed: last[index] || null,
  })).filter((item, index) => !paneMatchesEntry(entries[index], last[index]));

  throw new Error('Worker pane verification failed: ' + JSON.stringify(mismatches));
}

export async function configureTarget({ target, paneCount, entries }) {
  if (!target?.id) throw new Error('CDP target id is required for worker provisioning');
  if (entries.length !== paneCount) {
    throw new Error('Worker tab entry count does not match requested pane count');
  }

  let client = null;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Runtime.enable();

    const layoutCode = layoutCodeForPaneCount(paneCount);
    await evaluateValue(
      client,
      'window.TradingViewApi._chartWidgetCollection.setLayout(' + JSON.stringify(layoutCode) + ')',
      { awaitPromise: true },
    );
    await waitForPaneCount(client, paneCount);

    const paneResults = [];
    for (let index = 0; index < entries.length; index++) {
      const result = await evaluateValue(
        client,
        configurePaneExpression(index, entries[index]),
        { awaitPromise: true },
      );
      paneResults.push(result);
      if (!result?.success) {
        throw new Error(
          'Worker pane ' + index + ' study configuration failed: ' + JSON.stringify(result?.studies || []),
        );
      }
    }

    const verified = await verifyConfiguredTarget(client, entries);
    return { success: true, layout_code: layoutCode, pane_results: paneResults, verified };
  } finally {
    try { if (client) await client.close(); } catch { /* best effort */ }
  }
}

async function findTargetForChartId(chartId, targets = null, listTargets = listTradingViewChartTargets) {
  const available = targets || await listTargets();
  return available.find(target => String(chartIdFromTarget(target)) === String(chartId)) || null;
}

async function openOrCreateWorkerTab({ plan, owned, layoutPrefix, deps, liveTargets }) {
  if (owned?.chart_id) {
    const live = await findTargetForChartId(owned.chart_id, liveTargets);
    if (live) return { target: live, layoutName: owned.layout_name, reused: true };

    if (owned.layout_name) {
      try {
        const opened = await deps.newTab({ layout: owned.layout_name });
        const target = await findTargetForChartId(opened.chart_id, null, deps.listTargets);
        if (target) {
          return {
            target,
            layoutName: owned.layout_name,
            reused: true,
          };
        }
      } catch {
        // Saved layout may have been deleted/renamed; create a replacement.
      }
    }
  }

  const desiredName = owned?.layout_name || buildWorkerLayoutName(layoutPrefix, plan.tab_index);
  let created;
  try {
    created = await deps.newTab({ layout: 'new', name: desiredName });
  } catch (error) {
    const fallbackName = desiredName + '-' + deps.now().toString(36);
    created = await deps.newTab({ layout: 'new', name: fallbackName });
  }
  const target = await findTargetForChartId(created.chart_id, null, deps.listTargets);
  if (!target) throw new Error('New worker chart target was not discoverable after creation');

  return {
    target,
    layoutName: created.layout || desiredName,
    reused: false,
  };
}

async function closeTabByChartId(chartId) {
  const state = await tabCore.list();
  const found = state.tabs.find(tab => tab.is_chart && String(tab.chart_id) === String(chartId));
  if (!found) return { success: true, closed: false, reason: 'already_absent' };
  await tabCore.switchTab({ index: found.index });
  return tabCore.closeTab();
}

export async function provisionWorker({
  max_tabs = 1,
  dry_run = false,
  force = false,
  layout_prefix,
  _deps,
} = {}) {
  const deps = resolveDeps(_deps);
  const maxTabs = Number(max_tabs);
  if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > 8) {
    throw new Error('max_tabs must be an integer from 1 to 8');
  }

  let state = deps.status();
  const topology = state.topology_plan;
  const byHandle = entryMap(state);
  const liveTargets = await deps.listTargets();
  const liveChartIds = new Set(liveTargets.map(chartIdFromTarget).filter(Boolean).map(String));
  const ownedBySlot = workerTabMap(state);

  const pending = topology.tabs.filter(plan =>
    force || !recordedTabComplete(plan, state, liveChartIds)
  );

  const staleOwned = (state.worker_tabs || []).filter(tab =>
    Number(tab.slot) >= topology.tab_count
  );

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      topology,
      pending_tabs: pending.map(plan => plan.tab_index),
      stale_worker_tabs: staleOwned,
    };
  }

  const selected = pending.slice(0, maxTabs);
  const results = [];

  for (const plan of selected) {
    const entries = plan.handles.map(handle => {
      const entry = byHandle.get(handle);
      if (!entry) throw new Error('Worker topology references unknown handle: ' + handle);
      return entry;
    });

    try {
      const opened = await openOrCreateWorkerTab({
        plan,
        owned: ownedBySlot.get(Number(plan.tab_index)),
        layoutPrefix: layout_prefix || process.env.TV_WORKER_LAYOUT_PREFIX || 'DTV Worker',
        deps,
        liveTargets: await deps.listTargets(),
      });

      const chartId = chartIdFromTarget(opened.target);
      if (!chartId) throw new Error('Worker target has no stable TradingView chart id');

      const tabs = [
        ...(state.worker_tabs || []).filter(tab => Number(tab.slot) !== Number(plan.tab_index)),
        {
          slot: Number(plan.tab_index),
          chart_id: chartId,
          layout_name: opened.layoutName,
          pane_count: plan.pane_count,
        },
      ].sort((a, b) => Number(a.slot) - Number(b.slot));

      // Persist ownership before mutating the chart. If configuration fails,
      // the next provisioning call can safely reuse/repair this DTV-owned tab
      // instead of leaking an untracked connection.
      state = deps.record({ worker_tabs: tabs });

      const configured = await deps.configureTarget({
        target: opened.target,
        paneCount: plan.pane_count,
        entries,
      });

      const assignments = {};
      for (let index = 0; index < entries.length; index++) {
        assignments[entries[index].handle] = {
          worker_slot: Number(plan.tab_index),
          chart_id: chartId,
          pane_index: index,
          layout_name: opened.layoutName,
          provisioned_at: new Date(deps.now()).toISOString(),
        };
      }

      state = deps.record({ assignments, worker_tabs: tabs });
      results.push({
        tab_index: plan.tab_index,
        success: true,
        chart_id: chartId,
        layout_name: opened.layoutName,
        pane_count: plan.pane_count,
        reused: opened.reused,
        layout_code: configured.layout_code,
      });
    } catch (error) {
      results.push({
        tab_index: plan.tab_index,
        success: false,
        error: error?.message || String(error),
      });
      break;
    }
  }

  // Only clean obsolete worker-owned tabs after every desired tab has a
  // recorded assignment. Never close unrelated TradingView tabs.
  const afterTargets = await deps.listTargets();
  const afterIds = new Set(afterTargets.map(chartIdFromTarget).filter(Boolean).map(String));
  const recordedRemaining = state.topology_plan.tabs.filter(plan =>
    !recordedTabComplete(plan, state, afterIds)
  );
  const processedSlots = new Set(results.filter(result => result.success).map(result => Number(result.tab_index)));
  const forcedRemaining = force
    ? pending.filter(plan => !processedSlots.has(Number(plan.tab_index)))
    : [];
  const remainingBySlot = new Map(
    [...recordedRemaining, ...forcedRemaining].map(plan => [Number(plan.tab_index), plan]),
  );
  const remaining = [...remainingBySlot.values()].sort((a, b) => Number(a.tab_index) - Number(b.tab_index));

  const cleanup = [];
  if (remaining.length === 0) {
    const desiredSlots = new Set(state.topology_plan.tabs.map(plan => Number(plan.tab_index)));
    const keepTabs = [];
    for (const owned of state.worker_tabs || []) {
      if (desiredSlots.has(Number(owned.slot))) {
        keepTabs.push(owned);
        continue;
      }

      try {
        const result = await deps.closeTabByChartId(owned.chart_id);
        cleanup.push({ ...owned, success: true, result });
      } catch (error) {
        keepTabs.push(owned);
        cleanup.push({ ...owned, success: false, error: error?.message || String(error) });
      }
    }

    if (keepTabs.length !== (state.worker_tabs || []).length) {
      state = deps.record({ worker_tabs: keepTabs });
    }
  }

  const cleanupComplete = cleanup.every(item => item.success);

  return {
    success: results.every(result => result.success) && remaining.length === 0 && cleanupComplete,
    complete: remaining.length === 0 && cleanupComplete,
    processed_tabs: results.length,
    remaining_tabs: remaining.map(plan => plan.tab_index),
    results,
    cleanup,
    status: state,
  };
}
