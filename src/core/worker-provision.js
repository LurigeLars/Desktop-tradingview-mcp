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
    closeTabByOwned: overrides?.closeTabByOwned || closeTabByOwned,
    configureTarget: overrides?.configureTarget || configureTarget,
    inspectTargets: overrides?.inspectTargets || inspectTargetPaneCounts,
    now: overrides?.now || (() => Date.now()),
  };
}

function entryMap(state) {
  return new Map((state.entries || []).map(entry => [entry.handle, entry]));
}

function workerTabMap(state) {
  return new Map((state.worker_tabs || []).map(tab => [Number(tab.slot), tab]));
}

function ownedRuntimeKey(value) {
  if (value?.target_id) return 'target:' + String(value.target_id);
  if (value?.chart_id) return 'chart:' + String(value.chart_id);
  return null;
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
  const ownedKey = ownedRuntimeKey(owned);
  if (!ownedKey || !liveRuntimeKeys.has(ownedKey)) return false;

  const live = liveByRuntimeKey?.get?.(ownedKey) || null;

  return plan.handles.every((handle, paneIndex) => {
    const entry = entries.get(handle);
    const assignment = entry?.assignment;
    const assignmentKey = ownedRuntimeKey(assignment);
    const assignmentMatches = assignment
      && Number(assignment.worker_slot) === Number(plan.tab_index)
      && assignmentKey === ownedKey
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
      return out;
    })()
  `;
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
    const panes = await evaluateValue(client, readPaneStatesExpression());
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
    let live = await evaluateValue(client, readPaneStatesExpression());

    // Never reset an already-correct multi-pane layout on every resumable call.
    // Change layout only when the pane count itself is wrong.
    if (!Array.isArray(live) || live.length !== Number(paneCount)) {
      await evaluateValue(
        client,
        'window.TradingViewApi._chartWidgetCollection.setLayout(' + JSON.stringify(layoutCode) + ')',
        { awaitPromise: true },
      );
      await waitForPaneCount(client, paneCount, 5000);
      live = await evaluateValue(client, readPaneStatesExpression());
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

    const verified = await evaluateValue(client, readPaneStatesExpression());
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
    return available.find(target => String(chartIdFromTarget(target)) === String(owned.chart_id)) || null;
  }
  return null;
}

export async function inspectTargetPaneCounts(targets) {
  const results = [];
  for (const target of targets || []) {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      await client.Runtime.enable();
      const panes = await evaluateValue(client, readPaneStatesExpression());
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
}) {
  const newTabOptions = {
    landing_timeout_ms: 4000,
    chart_timeout_ms: 8000,
  };

  if (owned?.target_id || owned?.chart_id) {
    const live = await findTargetForOwned(owned, liveTargets);
    if (live) {
      return {
        target: live,
        layoutName: owned.layout_name,
        reused: true,
        openedThisCall: false,
        directChart: true,
      };
    }
  }

  const desiredName = owned?.layout_name || buildWorkerLayoutName(layoutPrefix, plan.tab_index);

  // Worker provisioning only needs a dedicated chart target. Do not depend on
  // TradingView's saved-layout picker UI; open a new Desktop tab and navigate
  // its known new-tab target directly to /chart/.
  let created;
  try {
    created = await deps.newTab({
      as_chart: true,
      force_new_tab: true,
      ...newTabOptions,
    });
  } catch (error) {
    throw new Error(
      'Worker direct chart-tab create failed for "' + desiredName + '": ' +
      (error?.message || String(error)),
    );
  }

  const target = await findTargetForOwned(
    { target_id: created.target_id, chart_id: created.chart_id },
    null,
    deps.listTargets,
  );
  if (!target) throw new Error('New worker chart target was not discoverable after direct navigation');

  return {
    target,
    layoutName: desiredName,
    reused: false,
    openedThisCall: true,
    directChart: true,
  };
}

async function closeTabByOwned(owned) {
  const state = await tabCore.list();
  const found = state.tabs.find(tab =>
    tab.is_chart && (
      (owned?.target_id && String(tab.id) === String(owned.target_id))
      || (owned?.chart_id && String(tab.chart_id) === String(owned.chart_id))
    )
  );
  if (!found) return { success: true, closed: false, reason: 'already_absent' };
  await tabCore.switchTab({ index: found.index });
  return tabCore.closeTab();
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
  const liveTargets = await deps.listTargets();
  const inspectedTargets = await deps.inspectTargets(liveTargets);
  const ownedRuntimeKeys = new Set(
    (state.worker_tabs || []).map(ownedRuntimeKey).filter(Boolean),
  );

  let externalTargets = inspectedTargets.filter(item => {
    const targetKey = item.target_id ? 'target:' + String(item.target_id) : null;
    const chartKey = item.chart_id ? 'chart:' + String(item.chart_id) : null;
    return !(
      (targetKey && ownedRuntimeKeys.has(targetKey))
      || (chartKey && ownedRuntimeKeys.has(chartKey))
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
    if (item.chart_id) {
      const key = 'chart:' + String(item.chart_id);
      liveRuntimeKeys.add(key);
      if (!liveByRuntimeKey.has(key)) liveByRuntimeKey.set(key, item);
    }
  }
  const ownedBySlot = workerTabMap(state);

  const pending = topology.tabs.filter(plan =>
    force || !recordedTabComplete(plan, state, liveRuntimeKeys, liveByRuntimeKey)
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
      // TradingView. The technical name is metadata only; worker creation no
      // longer depends on a saved TradingView layout.
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

      const opened = await openOrCreateWorkerTab({
        plan,
        owned,
        layoutPrefix,
        deps,
        liveTargets: await deps.listTargets(),
      });

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
  for (const item of afterInspected) {
    if (item.target_id) {
      const key = 'target:' + String(item.target_id);
      afterRuntimeKeys.add(key);
      afterByRuntimeKey.set(key, item);
    }
    if (item.chart_id) {
      const key = 'chart:' + String(item.chart_id);
      afterRuntimeKeys.add(key);
      if (!afterByRuntimeKey.has(key)) afterByRuntimeKey.set(key, item);
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

  const cleanupComplete = cleanup.every(item => item.success);

  return {
    success: results.every(result => result.success) && cleanupComplete,
    complete: remaining.length === 0 && cleanupComplete,
    processed_tabs: results.length,
    remaining_tabs: remaining.map(plan => plan.tab_index),
    results,
    cleanup,
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
