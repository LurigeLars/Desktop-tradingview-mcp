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
import { matchTradingViewResolvedSymbol } from './watchlist.js';

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
    cloneTargetAsLayout: overrides?.cloneTargetAsLayout || cloneTargetAsLayout,
    closeTabByOwned: overrides?.closeTabByOwned || closeTabByOwned,
    cleanupOrphanShellTabs: overrides?.cleanupOrphanShellTabs || tabCore.cleanupOrphanShellTabs,
    configureTarget: overrides?.configureTarget || configureTarget,
    inspectTargets: overrides?.inspectTargets || inspectTargetPaneCounts,
    listSavedLayouts: overrides?.listSavedLayouts || listSavedWorkerLayouts,
    wait: overrides?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    now: overrides?.now || (() => Date.now()),
  };
}

function entryMap(state) {
  return new Map((state.entries || []).map(entry => [entry.handle, entry]));
}

function workerTabMap(state) {
  return new Map((state.worker_tabs || []).map(tab => [Number(tab.slot), tab]));
}

function runtimeKeys(value) {
  const keys = [];
  if (value?.target_id) keys.push('target:' + String(value.target_id));
  if (value?.chart_id) keys.push('chart:' + String(value.chart_id));
  return keys;
}

function ownedRuntimeKey(value) {
  return runtimeKeys(value)[0] || null;
}

function countChartIds(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (!item?.chart_id) continue;
    const key = String(item.chart_id);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function stableOwnedRuntimeKeys(workerTabs) {
  const tabs = workerTabs || [];
  const chartCounts = countChartIds(tabs);
  const keys = new Set();
  for (const tab of tabs) {
    if (tab?.target_id) keys.add('target:' + String(tab.target_id));
    if (tab?.chart_id && chartCounts.get(String(tab.chart_id)) === 1) {
      keys.add('chart:' + String(tab.chart_id));
    }
  }
  return keys;
}

function sameNumberMultiset(left, right) {
  const count = values => {
    const out = new Map();
    for (const value of values) {
      const key = Number(value);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  };
  const a = count(left);
  const b = count(right);
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}


export async function listSavedWorkerLayouts(targets, {
  connect = targetId => CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId }),
} = {}) {
  const target = (targets || [])[0];
  if (!target?.id) return [];

  let client = null;
  try {
    client = await connect(target.id);
    await client.Runtime.enable();
    const layouts = await evaluateValue(client, `
      new Promise(function(resolve) {
        var settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        try {
          var api = window.TradingViewApi;
          if (!api || typeof api.getSavedCharts !== 'function') {
            finish({ error: 'getSavedCharts unavailable' });
            return;
          }
          api.getSavedCharts(function(charts) {
            finish((charts || []).map(function(item) {
              return {
                id: item.id || item.chartId || null,
                name: String(item.name || item.title || ''),
                url: item.url || item.image_url || null
              };
            }));
          });
          setTimeout(function() { finish({ error: 'getSavedCharts timed out' }); }, 3000);
        } catch(e) {
          finish({ error: e.message });
        }
      })
    `, { awaitPromise: true });

    if (Array.isArray(layouts)) return layouts;
    throw new Error('Saved-layout lookup failed: ' + (layouts?.error || 'unknown response'));
  } finally {
    try { if (client) await client.close(); } catch { /* best effort */ }
  }
}

export function partialSavedLayoutRecovery(state, inspectedTargets, savedLayouts) {
  const liveByChart = new Map();
  const chartCounts = countChartIds(inspectedTargets || []);
  for (const item of inspectedTargets || []) {
    if (
      item?.chart_id
      && item?.target_id
      && chartCounts.get(String(item.chart_id)) === 1
    ) {
      liveByChart.set(String(item.chart_id), item);
    }
  }

  const savedByName = new Map();
  for (const layout of savedLayouts || []) {
    const name = String(layout?.name || '').trim().toLowerCase();
    const url = String(layout?.url || '').trim();
    if (!name || !url) continue;
    savedByName.set(name, { ...layout, url });
  }

  const bySlot = new Map();
  const targetIds = new Set();

  for (const tab of state?.worker_tabs || []) {
    if (tab?.persistent_layout === true) continue;
    const name = String(tab?.layout_name || '').trim().toLowerCase();
    if (!name) continue;

    const saved = savedByName.get(name);
    if (!saved) continue;

    const live = liveByChart.get(String(saved.url));
    if (!live) continue;
    if (
      Number(tab?.pane_count || 0) > 0
      && Number(live?.pane_count || 0) !== Number(tab.pane_count)
    ) continue;

    const slot = Number(tab.slot);
    bySlot.set(slot, live);
    targetIds.add(String(live.target_id));
  }

  return { bySlot, targetIds };
}

export function persistentWorkerRecovery(state, topology, byHandle, inspectedTargets) {
  const ownedBySlot = workerTabMap(state);
  const bySlot = new Map();
  const duplicatesBySlot = new Map();
  const targetIds = new Set();
  const pendingSlots = new Set();
  const conflicts = [];

  for (const plan of topology?.tabs || []) {
    const slot = Number(plan.tab_index);
    const owned = ownedBySlot.get(slot);
    if (!owned?.persistent_layout || !owned?.chart_id) continue;

    const candidates = (inspectedTargets || []).filter(item =>
      item?.chart_id && String(item.chart_id) === String(owned.chart_id)
    );
    if (!candidates.length) continue;

    const entries = (plan.handles || []).map(handle => byHandle.get(handle));
    const matching = candidates.filter(item =>
      Number(item?.pane_count || 0) === Number(plan.pane_count)
      && Array.isArray(item?.panes)
      && entries.every((entry, index) => entry && paneMatchesEntry(entry, item.panes[index]))
    ).sort((a, b) => String(a.target_id).localeCompare(String(b.target_id)));

    if (!matching.length) {
      conflicts.push({
        slot,
        chart_id: owned.chart_id,
        candidate_target_ids: candidates.map(item => item.target_id),
      });
      continue;
    }

    const selected = matching[0];
    const duplicates = matching.slice(1);
    bySlot.set(slot, selected);
    targetIds.add(String(selected.target_id));
    for (const item of duplicates) targetIds.add(String(item.target_id));
    if (duplicates.length) duplicatesBySlot.set(slot, duplicates);

    if (
      String(owned.target_id || '') !== String(selected.target_id || '')
      || duplicates.length > 0
    ) {
      pendingSlots.add(slot);
    }
  }

  return { bySlot, duplicatesBySlot, targetIds, pendingSlots, conflicts };
}

export function legacyDirectWorkerRecovery(state, inspectedTargets) {
  const tabs = (state?.worker_tabs || []).filter(tab =>
    tab?.chart_id && tab?.persistent_layout !== true
  );
  const tabGroups = new Map();
  for (const tab of tabs) {
    const chartId = String(tab.chart_id);
    if (!tabGroups.has(chartId)) tabGroups.set(chartId, []);
    tabGroups.get(chartId).push(tab);
  }

  const liveGroups = new Map();
  for (const target of inspectedTargets || []) {
    if (!target?.chart_id || !target?.target_id) continue;
    const chartId = String(target.chart_id);
    if (!liveGroups.has(chartId)) liveGroups.set(chartId, []);
    liveGroups.get(chartId).push(target);
  }

  const bySlot = new Map();
  const targetIds = new Set();
  const groups = [];

  for (const [chartId, recorded] of tabGroups) {
    const live = liveGroups.get(chartId) || [];
    if (live.length !== recorded.length) continue;
    if (!sameNumberMultiset(
      recorded.map(tab => tab.pane_count),
      live.map(target => target.pane_count),
    )) continue;

    const sortedRecorded = [...recorded].sort((a, b) => Number(a.slot) - Number(b.slot));
    const sortedLive = [...live].sort((a, b) =>
      String(a.target_id).localeCompare(String(b.target_id))
    );

    for (let index = 0; index < sortedRecorded.length; index++) {
      const slot = Number(sortedRecorded[index].slot);
      const target = sortedLive[index];
      bySlot.set(slot, target);
      targetIds.add(String(target.target_id));
    }

    groups.push({
      chart_id: chartId,
      slots: sortedRecorded.map(tab => Number(tab.slot)),
      target_count: sortedLive.length,
    });
  }

  return { bySlot, targetIds, groups };
}

export function recordedTabComplete(
  plan,
  state,
  liveRuntimeKeys = new Set(),
  liveByRuntimeKey = null,
) {
  const tabs = workerTabMap(state);
  const entries = entryMap(state);
  const owned = tabs.get(Number(plan.tab_index));
  const ownedKey = runtimeKeys(owned).find(key => liveRuntimeKeys.has(key)) || null;
  if (!ownedKey) return false;

  const live = liveByRuntimeKey?.get?.(ownedKey) || null;

  return plan.handles.every((handle, paneIndex) => {
    const entry = entries.get(handle);
    const assignment = entry?.assignment;
    const assignmentMatches = assignment
      && Number(assignment.worker_slot) === Number(plan.tab_index)
      && runtimeKeys(assignment).includes(ownedKey)
      && Number(assignment.pane_index) === paneIndex;

    if (!assignmentMatches) return false;

    // When live pane inspection is available, persisted assignment metadata is
    // not enough: verify the chart still contains the requested market state.
    if (Array.isArray(live?.panes)) {
      return paneMatchesEntry(entry, live.panes[paneIndex]);
    }
    return true;
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
    const panes = await readActivePaneStates(client);
    if (panes.length === Number(expected)) return;
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
      var inlineCount = cwc ? cwc.inlineChartsCount : null;
      if (inlineCount && typeof inlineCount.value === 'function') inlineCount = inlineCount.value();
      inlineCount = Number(inlineCount);
      if (!Number.isInteger(inlineCount) || inlineCount < 1) inlineCount = null;
      var out = [];

      for (var i = 0; i < panes.length; i++) {
        try {
          var pane = panes[i];
          var model = pane.model ? pane.model() : null;
          var series = model && model.mainSeries ? model.mainSeries() : null;
          var symbol = series && series.symbol ? series.symbol() : null;
          var resolution = series && series.interval ? series.interval() : null;
          var symbolIdentity = {};
          try {
            var info = series && series.symbolInfo ? series.symbolInfo() : {};
            if (info && typeof info.value === 'function') info = info.value();
            if (!info || typeof info !== 'object') info = {};
            symbolIdentity = {
              name: info.name || null,
              ticker: info.ticker || null,
              full_name: info.full_name || null,
              pro_name: info.pro_name || null,
              base_name: Array.isArray(info.base_name)
                ? info.base_name.slice(0, 8)
                : (info.base_name ? [info.base_name] : []),
              exchange: info.exchange || null,
              listed_exchange: info.listed_exchange || null,
              type: info.type || null,
            };
          } catch(e) {}
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
            symbol_identity: symbolIdentity,
            studies: studies,
          });
        } catch(e) {
          out.push({ pane_index: i, error: e.message });
        }
      }
      return { inline_count: inlineCount, panes: out };
    })()
  `;
}

export function activePaneStates(runtime) {
  const panes = Array.isArray(runtime)
    ? runtime
    : (Array.isArray(runtime?.panes) ? runtime.panes : []);
  const inlineCount = Number(runtime?.inline_count);
  if (!Number.isInteger(inlineCount) || inlineCount < 1) return panes;
  return panes.slice(0, Math.min(inlineCount, panes.length));
}

async function readActivePaneStates(client) {
  const runtime = await evaluateValue(client, readPaneStatesExpression());
  return activePaneStates(runtime);
}

function paneMatchesEntry(entry, pane) {
  if (!pane || pane.error) return false;
  const symbolMatch = matchTradingViewResolvedSymbol(
    entry.symbol,
    pane.resolved_symbol,
    pane.symbol_identity || {},
  );
  if (!symbolMatch.matched) return false;
  try {
    if (normalizeWorkerTimeframe(pane.resolution) !== normalizeWorkerTimeframe(entry.timeframe)) return false;
  } catch {
    return false;
  }
  return requiredStudiesPresent(entry, pane);
}

export function pendingPaneIndexes(entries, panes) {
  const live = Array.isArray(panes) ? panes : [];
  const pending = [];
  for (let index = 0; index < (entries || []).length; index++) {
    if (!paneMatchesEntry(entries[index], live[index])) pending.push(index);
  }
  return pending;
}

async function waitForPaneMatch(client, entry, index, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    const panes = await readActivePaneStates(client);
    last = Array.isArray(panes) ? panes[index] : null;
    if (paneMatchesEntry(entry, last)) return last;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);

  throw new Error(
    'Worker pane verification failed: ' + JSON.stringify({
      handle: entry.handle,
      pane_index: index,
      requested_symbol: entry.symbol,
      requested_timeframe: entry.timeframe,
      observed: last,
    }),
  );
}

export async function configureTarget({ target, paneCount, entries, maxPanes = 1 }) {
  if (!target?.id) throw new Error('CDP target id is required for worker provisioning');
  if (entries.length !== paneCount) {
    throw new Error('Worker tab entry count does not match requested pane count');
  }
  const paneBudget = Number(maxPanes);
  if (!Number.isInteger(paneBudget) || paneBudget < 1 || paneBudget > 8) {
    throw new Error('maxPanes must be an integer from 1 to 8');
  }

  let client = null;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Runtime.enable();

    const layoutCode = layoutCodeForPaneCount(paneCount);
    let live = await readActivePaneStates(client);

    // Never reset an already-correct multi-pane layout on every resumable call.
    // Change layout only when the pane count itself is wrong.
    if (!Array.isArray(live) || live.length !== Number(paneCount)) {
      await evaluateValue(
        client,
        'window.TradingViewApi._chartWidgetCollection.setLayout(' + JSON.stringify(layoutCode) + ')',
        { awaitPromise: true },
      );
      await waitForPaneCount(client, paneCount, 5000);
      live = await readActivePaneStates(client);
    }

    const pendingBefore = pendingPaneIndexes(entries, live);
    const selected = pendingBefore.slice(0, paneBudget);
    const paneResults = [];

    for (const index of selected) {
      const result = await evaluateValue(
        client,
        configurePaneExpression(index, entries[index]),
        { awaitPromise: true },
      );
      if (!result?.success) {
        throw new Error(
          'Worker pane ' + index + ' study configuration failed: ' + JSON.stringify(result?.studies || []),
        );
      }

      const verifiedPane = await waitForPaneMatch(client, entries[index], index);
      paneResults.push({
        pane_index: index,
        ...result,
        verified: verifiedPane,
      });
    }

    const verified = await readActivePaneStates(client);
    const pending = pendingPaneIndexes(entries, verified);

    return {
      success: true,
      complete: pending.length === 0,
      layout_code: layoutCode,
      configured_panes: selected,
      pending_panes: pending,
      pane_results: paneResults,
      verified,
    };
  } finally {
    try { if (client) await client.close(); } catch { /* best effort */ }
  }
}

async function findTargetForOwned(owned, targets = null, listTargets = listTradingViewChartTargets) {
  const available = targets || await listTargets();
  if (owned?.target_id) {
    const byTarget = available.find(target => String(target.id) === String(owned.target_id));
    if (byTarget) return byTarget;
  }
  if (owned?.chart_id) {
    const byChart = available.filter(
      target => String(chartIdFromTarget(target)) === String(owned.chart_id)
    );
    if (byChart.length === 1) return byChart[0];
  }
  return null;
}

export async function cloneTargetAsLayout(target, name, {
  connect = targetId => CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId }),
  listTargets = listTradingViewChartTargets,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 8000,
  findSavedLayout,
} = {}) {
  if (!target?.id) throw new Error('CDP target id is required to clone a worker layout');
  const desiredName = String(name || '').trim();
  if (!desiredName) throw new Error('Worker layout name is required');
  const desiredLiteral = JSON.stringify(desiredName);

  let client = null;
  let dialogOpened = false;

  const readSavedLayout = findSavedLayout || (async (activeClient, layoutName) => {
    const literal = JSON.stringify(String(layoutName));
    return evaluateValue(activeClient, `
      new Promise(function(resolve) {
        var settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }
        try {
          var api = window.TradingViewApi;
          if (!api || typeof api.getSavedCharts !== 'function') {
            finish({ error: 'getSavedCharts unavailable' });
            return;
          }
          api.getSavedCharts(function(charts) {
            var wanted = ${literal}.toLowerCase();
            var match = null;
            for (var i = 0; i < (charts || []).length; i++) {
              var item = charts[i] || {};
              var itemName = String(item.name || item.title || '');
              if (itemName.toLowerCase() === wanted) {
                match = {
                  id: item.id || item.chartId || null,
                  name: itemName,
                  url: item.url || item.image_url || null
                };
                break;
              }
            }
            finish(match);
          });
          setTimeout(function() { finish({ error: 'getSavedCharts timed out' }); }, 3000);
        } catch(e) {
          finish({ error: e.message });
        }
      })
    `, { awaitPromise: true });
  });

  const findLiveSavedTarget = async saved => {
    if (!saved?.url) return null;
    const targets = await listTargets();
    return targets.find(item => String(chartIdFromTarget(item)) === String(saved.url)) || null;
  };

  try {
    client = await connect(target.id);
    await client.Runtime.enable();

    // Retry/resume path: Save As may already have completed on a previous
    // attempt even if the caller timed out before ownership was journaled.
    let saved = await readSavedLayout(client, desiredName);
    if (saved?.error) throw new Error('Saved-layout lookup failed: ' + saved.error);
    if (saved?.url) {
      const existingTarget = await findLiveSavedTarget(saved);
      if (existingTarget) return existingTarget;
    }

    const opened = await evaluateValue(client, `
      (function() {
        var api = window.TradingViewApi;
        if (!api || typeof api.showSaveAsChartDialog !== 'function') {
          return { success: false, error: 'showSaveAsChartDialog unavailable' };
        }
        api.showSaveAsChartDialog();
        return { success: true };
      })()
    `);
    if (!opened?.success) throw new Error(opened?.error || 'Could not open Save As dialog');
    dialogOpened = true;

    const deadline = Date.now() + Number(timeoutMs);
    let filled = false;
    do {
      filled = await evaluateValue(client, `
        (function() {
          var desired = ${desiredLiteral};
          var dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="popupDialog"]'));
          for (var di = dialogs.length - 1; di >= 0; di--) {
            var dialog = dialogs[di];
            var buttons = Array.from(dialog.querySelectorAll('button'));
            var copy = buttons.find(function(button) {
              return (button.textContent || '').trim().toLowerCase() === 'make copy';
            });
            var input = dialog.querySelector('input[type="text"], input:not([type])');
            if (!copy || !input) continue;

            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, desired);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        })()
      `);
      if (filled) break;
      if (Date.now() >= deadline) break;
      await wait(100);
    } while (true);
    if (!filled) throw new Error('TradingView Save As dialog did not expose its layout-name input');

    const clicked = await evaluateValue(client, `
      (function() {
        var dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="popupDialog"]'));
        for (var di = dialogs.length - 1; di >= 0; di--) {
          var dialog = dialogs[di];
          var copy = Array.from(dialog.querySelectorAll('button')).find(function(button) {
            return (button.textContent || '').trim().toLowerCase() === 'make copy';
          });
          if (copy && !copy.disabled) {
            copy.click();
            return true;
          }
        }
        return false;
      })()
    `);
    if (!clicked) throw new Error('TradingView Make copy button was not available');
    dialogOpened = false;

    // Desktop 3.4.x keeps the source tab on the old layout and opens the
    // newly-saved copy as a distinct chart target. Verify the saved layout via
    // getSavedCharts and discover that new target by the layout's URL token.
    let lastSaved = null;
    do {
      await wait(150);
      lastSaved = await readSavedLayout(client, desiredName);
      if (lastSaved?.error) throw new Error('Saved-layout lookup failed: ' + lastSaved.error);
      if (lastSaved?.url) {
        const savedTarget = await findLiveSavedTarget(lastSaved);
        if (savedTarget) return savedTarget;
      }
      if (Date.now() >= deadline) break;
    } while (true);

    throw new Error(
      'TradingView saved layout was not discoverable as a chart target: ' +
      JSON.stringify({ desired_name: desiredName, saved_layout: lastSaved }),
    );
  } catch (error) {
    if (client && dialogOpened) {
      try {
        await evaluateValue(client, `
          (function() {
            var dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="popupDialog"]'));
            for (var di = dialogs.length - 1; di >= 0; di--) {
              var dialog = dialogs[di];
              var cancel = Array.from(dialog.querySelectorAll('button')).find(function(button) {
                var text = (button.textContent || '').trim().toLowerCase();
                return text === 'cancel' || text === 'close';
              });
              if (cancel) { cancel.click(); return true; }
            }
            return false;
          })()
        `);
      } catch { /* best effort */ }
    }
    throw error;
  } finally {
    try { if (client) await client.close(); } catch { /* best effort */ }
  }
}

export async function inspectTargetPaneCounts(targets) {
  const results = [];
  for (const target of targets || []) {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      await client.Runtime.enable();
      const panes = await readActivePaneStates(client);
      const paneCount = Array.isArray(panes) ? panes.length : 0;
      if (!Number.isInteger(Number(paneCount)) || Number(paneCount) < 1) {
        throw new Error('Chart target has no active panes');
      }
      results.push({
        target_id: target.id,
        chart_id: chartIdFromTarget(target),
        pane_count: Number(paneCount),
        panes,
      });
    } finally {
      try { if (client) await client.close(); } catch { /* best effort */ }
    }
  }
  return results;
}

async function openOrCreateWorkerTab({
  plan,
  owned,
  layoutPrefix,
  deps,
  liveTargets,
  legacyTarget = null,
  preferredTarget = null,
}) {
  const newTabOptions = {
    landing_timeout_ms: 4000,
    chart_timeout_ms: 8000,
  };
  const desiredName = owned?.layout_name || buildWorkerLayoutName(layoutPrefix, plan.tab_index);

  if (legacyTarget) {
    const liveLegacy = (liveTargets || []).find(
      target => String(target.id) === String(legacyTarget.target_id)
    );
    if (!liveLegacy) {
      throw new Error(
        'Legacy worker target ' + String(legacyTarget.target_id || '') +
        ' was not discoverable for in-place layout cloning'
      );
    }
    const cloned = await deps.cloneTargetAsLayout(liveLegacy, desiredName);
    return {
      target: cloned,
      layoutName: desiredName,
      reused: false,
      openedThisCall: true,
      directChart: false,
      persistentLayout: true,
    };
  }

  if (preferredTarget?.target_id) {
    const livePreferred = (liveTargets || []).find(
      target => String(target.id) === String(preferredTarget.target_id)
    );
    if (livePreferred) {
      return {
        target: livePreferred,
        layoutName: desiredName,
        reused: true,
        openedThisCall: false,
        directChart: false,
        persistentLayout: true,
      };
    }
  }

  if (owned?.target_id || owned?.chart_id) {
    const live = await findTargetForOwned(owned, liveTargets);
    if (live) {
      return {
        target: live,
        layoutName: desiredName,
        reused: true,
        openedThisCall: false,
        directChart: owned?.persistent_layout !== true,
        persistentLayout: owned?.persistent_layout === true,
      };
    }
  }

  if (owned?.persistent_layout === true && desiredName) {
    // Registry chart_id is the canonical persistent worker identity. Prefer it
    // directly so cold-start recovery does not depend on getSavedCharts being
    // available from an already-open chart target.
    let savedChartId = owned?.chart_id ? String(owned.chart_id).trim() : '';

    if (!savedChartId) {
      const savedLayouts = await deps.listSavedLayouts(liveTargets);
      const exact = (savedLayouts || []).filter(layout =>
        String(layout?.name || '').trim().toLowerCase() === desiredName.toLowerCase()
        && String(layout?.url || '').trim()
      );

      if (exact.length === 1) {
        savedChartId = String(exact[0].url);
      } else if (exact.length > 1) {
        throw new Error(
          'Worker saved-layout reopen is ambiguous for "' + desiredName + '": ' +
          exact.map(layout => String(layout.url)).join(', ')
        );
      }
    }

    if (savedChartId) {
      try {
        const reopened = await deps.newTab({
          as_chart: true,
          chart_id: savedChartId,
          force_new_tab: true,
          ...newTabOptions,
        });
        if (String(reopened.chart_id || '') !== savedChartId) {
          throw new Error(
            'Exact saved-layout navigation returned chart ' + String(reopened.chart_id || '') +
            ' instead of ' + savedChartId
          );
        }
        const target = await findTargetForOwned(
          { target_id: reopened.target_id, chart_id: reopened.chart_id },
          null,
          deps.listTargets,
        );
        if (!target) throw new Error('Reopened worker saved-layout target was not discoverable');
        return {
          target,
          layoutName: desiredName,
          reused: reopened.reused_existing_target === true || reopened.reused_existing_tab === true,
          openedThisCall: reopened.reused_existing_target !== true,
          directChart: false,
          persistentLayout: true,
        };
      } catch (error) {
        throw new Error(
          'Worker saved-layout direct reopen failed for "' + desiredName + '": ' +
          (error?.message || String(error)),
        );
      }
    }
  }

  let created = null;
  try {
    created = await deps.newTab({
      as_chart: true,
      force_new_tab: owned?.persistent_layout !== true,
      ...newTabOptions,
    });
  } catch (error) {
    throw new Error(
      'Worker direct chart-tab create failed for "' + desiredName + '": ' +
      (error?.message || String(error)),
    );
  }

  const directTarget = await findTargetForOwned(
    { target_id: created.target_id, chart_id: created.chart_id },
    null,
    deps.listTargets,
  );
  if (!directTarget) throw new Error('New worker chart target was not discoverable after direct navigation');

  try {
    const cloned = await deps.cloneTargetAsLayout(directTarget, desiredName);
    return {
      target: cloned,
      layoutName: desiredName,
      reused: false,
      openedThisCall: true,
      directChart: false,
      persistentLayout: true,
    };
  } catch (error) {
    try {
      await deps.closeTabByOwned({
        target_id: directTarget.id,
        chart_id: chartIdFromTarget(directTarget),
      });
    } catch { /* best effort: close only the DTV-created direct chart */ }
    throw new Error(
      'Worker chart persistence failed for "' + desiredName + '": ' +
      (error?.message || String(error)),
    );
  }
}

export async function closeTabByOwned(owned, {
  listTargets = listTradingViewChartTargets,
  closeTarget = targetId => CDP.Close({ host: CDP_HOST, port: CDP_PORT, id: targetId }),
  listTabs = tabCore.list,
  switchTab = tabCore.switchTab,
  closeTab = tabCore.closeTab,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 3000,
} = {}) {
  const targetId = owned?.target_id ? String(owned.target_id) : null;

  if (targetId) {
    const before = await listTargets();
    if (!before.some(target => String(target.id) === targetId)) {
      return { success: true, closed: false, reason: 'already_absent', target_id: targetId };
    }

    await closeTarget(targetId);

    const deadline = Date.now() + Number(timeoutMs);
    do {
      const remaining = await listTargets();
      if (!remaining.some(target => String(target.id) === targetId)) {
        return { success: true, closed: true, via: 'target_id', target_id: targetId };
      }
      if (Date.now() >= deadline) break;
      await wait(100);
    } while (true);

    throw new Error('Worker target ' + targetId + ' remained present after close request.');
  }

  const chartId = owned?.chart_id ? String(owned.chart_id) : null;
  if (!chartId) {
    return { success: true, closed: false, reason: 'missing_runtime_identity' };
  }

  const state = await listTabs();
  const matches = state.tabs.filter(tab =>
    tab.is_chart && String(tab.chart_id) === chartId
  );
  if (matches.length === 0) {
    return { success: true, closed: false, reason: 'already_absent', chart_id: chartId };
  }
  if (matches.length !== 1) {
    throw new Error(
      'Cannot safely close worker chart ' + chartId +
      ' without target_id because ' + matches.length + ' matching tabs are open.'
    );
  }

  await switchTab({ index: matches[0].index });
  return closeTab();
}

export async function settlePersistentWorkerRestore(state, initialTargets, {
  listTargets,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 6000,
  pollMs = 250,
} = {}) {
  const persistent = (state?.worker_tabs || []).filter(tab =>
    tab?.persistent_layout === true && tab?.chart_id
  );
  if (!persistent.length || typeof listTargets !== 'function') return initialTargets || [];

  const initial = initialTargets || [];
  const liveTargetIds = new Set(initial.map(target => String(target.id || '')));
  const recordedTargetIds = persistent
    .map(tab => String(tab.target_id || ''))
    .filter(Boolean);

  // If at least one recorded target is still alive, this is an ordinary
  // reconciliation inside the same Desktop session, not a restart restore.
  if (recordedTargetIds.some(id => liveTargetIds.has(id))) return initial;

  const wantedChartIds = new Set(persistent.map(tab => String(tab.chart_id)));
  const presentCount = targets => {
    const seen = new Set(
      (targets || [])
        .map(chartIdFromTarget)
        .filter(chartId => chartId && wantedChartIds.has(String(chartId)))
        .map(String)
    );
    return seen.size;
  };

  let latest = initial;
  if (presentCount(latest) >= wantedChartIds.size) return latest;

  const deadline = now() + Number(timeoutMs);
  while (now() < deadline) {
    await wait(Math.min(Number(pollMs), Math.max(1, deadline - now())));
    latest = await listTargets();
    if (presentCount(latest) >= wantedChartIds.size) break;
  }
  return latest;
}

export async function provisionWorker({
  max_tabs = 1,
  max_panes = 1,
  dry_run = false,
  force = false,
  adopt_single_existing = false,
  layout_prefix,
  _deps,
} = {}) {
  const deps = resolveDeps(_deps);
  const maxTabs = Number(max_tabs);
  if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > 8) {
    throw new Error('max_tabs must be an integer from 1 to 8');
  }
  const maxPanes = Number(max_panes);
  if (!Number.isInteger(maxPanes) || maxPanes < 1 || maxPanes > 8) {
    throw new Error('max_panes must be an integer from 1 to 8');
  }

  let state = deps.status();
  const topology = state.topology_plan;
  const byHandle = entryMap(state);
  let liveTargets = await deps.listTargets();
  liveTargets = await settlePersistentWorkerRestore(state, liveTargets, {
    listTargets: deps.listTargets,
    wait: deps.wait,
    now: deps.now,
  });
  const inspectedTargets = await deps.inspectTargets(liveTargets);
  const liveChartCounts = countChartIds(inspectedTargets);
  const ownedRuntimeKeys = stableOwnedRuntimeKeys(state.worker_tabs || []);
  const legacyRecovery = legacyDirectWorkerRecovery(state, inspectedTargets);
  const persistentRecovery = persistentWorkerRecovery(
    state,
    topology,
    byHandle,
    inspectedTargets,
  );
  let partialSavedRecovery = { bySlot: new Map(), targetIds: new Set() };

  if (legacyRecovery.bySlot.size > 0) {
    const savedLayouts = await deps.listSavedLayouts(liveTargets);
    partialSavedRecovery = partialSavedLayoutRecovery(
      state,
      inspectedTargets,
      savedLayouts,
    );
  }

  let externalTargets = inspectedTargets.filter(item => {
    const targetKey = item.target_id ? 'target:' + String(item.target_id) : null;
    const chartKey = item.chart_id ? 'chart:' + String(item.chart_id) : null;
    return !(
      (targetKey && ownedRuntimeKeys.has(targetKey))
      || (
        chartKey
        && ownedRuntimeKeys.has(chartKey)
        && liveChartCounts.get(String(item.chart_id)) === 1
      )
      || (item.target_id && persistentRecovery.targetIds.has(String(item.target_id)))
      || (item.target_id && legacyRecovery.targetIds.has(String(item.target_id)))
      || (item.target_id && partialSavedRecovery.targetIds.has(String(item.target_id)))
    );
  });
  let adoptionCandidate = null;

  if (adopt_single_existing && topology.tabs.length > 0 && (state.worker_tabs || []).length === 0) {
    if (externalTargets.length !== 1) {
      throw new Error(
        'adopt_single_existing requires exactly one non-worker TradingView chart target; found ' +
        externalTargets.length,
      );
    }
    adoptionCandidate = externalTargets[0];
    externalTargets = [];
  }

  const externalConnections = externalTargets.reduce((sum, item) => sum + Number(item.pane_count || 0), 0);
  const usableCapacity = Number(state.usable_capacity);
  const projectedConnections = externalConnections + Number(state.configured || 0);
  if (projectedConnections > usableCapacity) {
    throw new Error(
      'Worker capacity exceeded: ' + projectedConnections + ' projected chart connections (' +
      externalConnections + ' external + ' + state.configured + ' worker) exceed ' +
      usableCapacity + ' usable slots',
    );
  }

  if (adoptionCandidate && !dry_run) {
    const adoptedTabs = [{
      slot: 0,
      target_id: adoptionCandidate.target_id || null,
      chart_id: adoptionCandidate.chart_id || null,
      layout_name: null,
      pane_count: adoptionCandidate.pane_count,
      adopted: true,
    }];
    state = deps.record({ worker_tabs: adoptedTabs });
  }

  const liveRuntimeKeys = new Set();
  const liveByRuntimeKey = new Map();
  for (const item of inspectedTargets) {
    if (item.target_id) {
      const key = 'target:' + String(item.target_id);
      liveRuntimeKeys.add(key);
      liveByRuntimeKey.set(key, item);
    }
    if (item.chart_id && liveChartCounts.get(String(item.chart_id)) === 1) {
      const key = 'chart:' + String(item.chart_id);
      liveRuntimeKeys.add(key);
      liveByRuntimeKey.set(key, item);
    }
  }

  for (const [slot, item] of persistentRecovery.bySlot) {
    const owned = (state.worker_tabs || []).find(tab => Number(tab.slot) === Number(slot));
    if (!owned?.chart_id) continue;
    const key = 'chart:' + String(owned.chart_id);
    liveRuntimeKeys.add(key);
    liveByRuntimeKey.set(key, item);
  }

  const ownedBySlot = workerTabMap(state);

  const pending = topology.tabs.filter(plan =>
    force
    || persistentRecovery.pendingSlots.has(Number(plan.tab_index))
    || !recordedTabComplete(plan, state, liveRuntimeKeys, liveByRuntimeKey)
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
      capacity_projection: {
        capacity: state.capacity,
        reserve_slots: state.reserve_slots,
        usable_capacity: usableCapacity,
        external_connections: externalConnections,
        worker_connections: state.configured,
        projected_connections: projectedConnections,
      },
      adoption_candidate: adoptionCandidate,
      legacy_direct_recovery: {
        groups: legacyRecovery.groups,
        slots: [...legacyRecovery.bySlot.keys()].sort((a, b) => a - b),
      },
      partial_saved_layout_recovery: {
        slots: [...partialSavedRecovery.bySlot.keys()].sort((a, b) => a - b),
        target_ids: [...partialSavedRecovery.targetIds],
      },
      persistent_layout_recovery: {
        slots: [...persistentRecovery.bySlot.keys()].sort((a, b) => a - b),
        pending_slots: [...persistentRecovery.pendingSlots].sort((a, b) => a - b),
        duplicate_target_ids: [...persistentRecovery.duplicatesBySlot.values()]
          .flat()
          .map(item => item.target_id),
        conflicts: persistentRecovery.conflicts,
      },
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

    const started = Date.now();
    let stage = 'open_or_create';
    try {
      const slot = Number(plan.tab_index);
      const layoutPrefix = layout_prefix || process.env.TV_WORKER_LAYOUT_PREFIX || 'DTV Worker';
      let owned = ownedBySlot.get(slot) || null;
      // Journal deterministic worker ownership intent before opening
      // TradingView. The technical name is also the saved-layout identity for
      // restart-stable worker tabs.
      if (!owned) {
        owned = {
          slot,
          target_id: null,
          chart_id: null,
          layout_name: buildWorkerLayoutName(layoutPrefix, slot),
          pane_count: plan.pane_count,
          provisioning_state: 'intent',
          intent_at: new Date(deps.now()).toISOString(),
        };
        const intentTabs = [
          ...(state.worker_tabs || []).filter(tab => Number(tab.slot) !== slot),
          owned,
        ].sort((a, b) => Number(a.slot) - Number(b.slot));
        state = deps.record({ worker_tabs: intentTabs });
      }

      const legacyTarget = legacyRecovery.bySlot.get(slot) || null;
      if (legacyTarget) stage = 'clone_legacy_layout';

      const opened = await openOrCreateWorkerTab({
        plan,
        owned,
        layoutPrefix,
        deps,
        liveTargets: await deps.listTargets(),
        legacyTarget,
        preferredTarget: persistentRecovery.bySlot.get(slot) || null,
      });

      const duplicateTargets = persistentRecovery.duplicatesBySlot.get(slot) || [];
      for (const duplicate of duplicateTargets) {
        if (String(duplicate.target_id) === String(opened.target.id)) continue;
        stage = 'dedupe_persistent_targets';
        await deps.closeTabByOwned({
          target_id: duplicate.target_id,
          chart_id: duplicate.chart_id,
        });
      }

      if (
        legacyTarget?.target_id
        && String(opened.target.id) !== String(legacyTarget.target_id)
      ) {
        stage = 'retire_legacy_direct_tab';
        await deps.closeTabByOwned({
          target_id: legacyTarget.target_id,
          chart_id: legacyTarget.chart_id,
        });
      }

      const openDurationMs = Date.now() - started;
      const chartId = chartIdFromTarget(opened.target);

      const tabs = [
        ...(state.worker_tabs || []).filter(tab => Number(tab.slot) !== Number(plan.tab_index)),
        {
          slot: Number(plan.tab_index),
          target_id: opened.target.id,
          chart_id: chartId,
          layout_name: opened.layoutName,
          pane_count: plan.pane_count,
          persistent_layout: opened.persistentLayout === true,
        },
      ].sort((a, b) => Number(a.slot) - Number(b.slot));

      // Persist ownership immediately and clear stale assignments for this
      // topology slot. The next MCP call can safely resume against the same
      // DTV-owned chart even if the current request ends here.
      const clearedAssignments = Object.fromEntries(
        entries.map(entry => [entry.handle, null]),
      );
      state = deps.record({ assignments: clearedAssignments, worker_tabs: tabs });

      // Opening/creating a TradingView tab is already a bounded mutation phase.
      // Do not combine it with pane configuration in the same remote MCP call.
      if (opened.openedThisCall) {
        results.push({
          tab_index: plan.tab_index,
          success: true,
          complete: false,
          stage: 'tab_ready',
          target_id: opened.target.id,
          chart_id: chartId,
          layout_name: opened.layoutName,
          pane_count: plan.pane_count,
          reused: opened.reused,
          direct_chart: !!opened.directChart,
          persistent_layout: opened.persistentLayout === true,
          legacy_replaced: !!legacyTarget,
          pending_panes: entries.map((_, index) => index),
          open_duration_ms: openDurationMs,
          duration_ms: Date.now() - started,
        });
        break;
      }

      stage = 'configure_panes';
      const configureStarted = Date.now();
      const configured = await deps.configureTarget({
        target: opened.target,
        paneCount: plan.pane_count,
        entries,
        maxPanes,
      });

      if (configured.complete === false) {
        results.push({
          tab_index: plan.tab_index,
          success: true,
          complete: false,
          stage,
          target_id: opened.target.id,
          chart_id: chartId,
          layout_name: opened.layoutName,
          pane_count: plan.pane_count,
          reused: opened.reused,
          layout_code: configured.layout_code,
          configured_panes: configured.configured_panes || [],
          pending_panes: configured.pending_panes || [],
          open_duration_ms: openDurationMs,
          configure_duration_ms: Date.now() - configureStarted,
          duration_ms: Date.now() - started,
        });
        break;
      }

      const assignments = {};
      for (let index = 0; index < entries.length; index++) {
        assignments[entries[index].handle] = {
          worker_slot: Number(plan.tab_index),
          target_id: opened.target.id,
          chart_id: chartId,
          pane_index: index,
          layout_name: opened.layoutName,
          resolved_symbol: configured.verified?.[index]?.resolved_symbol || null,
          resolution: configured.verified?.[index]?.resolution || null,
          provisioned_at: new Date(deps.now()).toISOString(),
        };
      }

      state = deps.record({ assignments, worker_tabs: tabs });
      results.push({
        tab_index: plan.tab_index,
        success: true,
        complete: true,
        stage: 'complete',
        target_id: opened.target.id,
        chart_id: chartId,
        layout_name: opened.layoutName,
        pane_count: plan.pane_count,
        reused: opened.reused,
        direct_chart: !!opened.directChart,
        layout_code: configured.layout_code,
        configured_panes: configured.configured_panes || [],
        pending_panes: [],
        open_duration_ms: openDurationMs,
        configure_duration_ms: Date.now() - configureStarted,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      results.push({
        tab_index: plan.tab_index,
        success: false,
        stage,
        duration_ms: Date.now() - started,
        error: error?.message || String(error),
      });
      break;
    }
  }

  // Only clean obsolete worker-owned tabs after every desired tab has a
  // recorded assignment. Never close unrelated TradingView tabs.
  const afterTargets = await deps.listTargets();
  const afterInspected = await deps.inspectTargets(afterTargets);
  const afterRuntimeKeys = new Set();
  const afterByRuntimeKey = new Map();
  const afterChartCounts = countChartIds(afterInspected);
  for (const item of afterInspected) {
    if (item.target_id) {
      const key = 'target:' + String(item.target_id);
      afterRuntimeKeys.add(key);
      afterByRuntimeKey.set(key, item);
    }
    if (item.chart_id && afterChartCounts.get(String(item.chart_id)) === 1) {
      const key = 'chart:' + String(item.chart_id);
      afterRuntimeKeys.add(key);
      afterByRuntimeKey.set(key, item);
    }
  }
  const recordedRemaining = state.topology_plan.tabs.filter(plan =>
    !recordedTabComplete(plan, state, afterRuntimeKeys, afterByRuntimeKey)
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
        const result = await deps.closeTabByOwned(owned);
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

  let shell_cleanup = null;
  if (
    force
    && remaining.length === 0
    && cleanup.every(item => item.success)
    && externalConnections === 0
  ) {
    try {
      shell_cleanup = await deps.cleanupOrphanShellTabs({
        keep_target_ids: (state.worker_tabs || [])
          .filter(tab => Number(tab.slot) < Number(state.topology_plan.tab_count))
          .map(tab => tab.target_id)
          .filter(Boolean),
      });
    } catch (error) {
      shell_cleanup = {
        success: false,
        error: error?.message || String(error),
      };
    }
  }

  const cleanupComplete = cleanup.every(item => item.success)
    && (shell_cleanup == null || shell_cleanup.success === true);

  return {
    success: results.every(result => result.success) && cleanupComplete,
    complete: remaining.length === 0 && cleanupComplete,
    processed_tabs: results.length,
    remaining_tabs: remaining.map(plan => plan.tab_index),
    results,
    cleanup,
    shell_cleanup,
    capacity_projection: {
      capacity: state.capacity,
      reserve_slots: state.reserve_slots,
      usable_capacity: usableCapacity,
      external_connections: externalConnections,
      worker_connections: state.configured,
      projected_connections: projectedConnections,
    },
    adopted_existing: adoptionCandidate
      ? {
          target_id: adoptionCandidate.target_id || null,
          chart_id: adoptionCandidate.chart_id || null,
          pane_count: adoptionCandidate.pane_count,
        }
      : null,
    status: state,
  };
}
