/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { getClient, reconnectTo, CDP_HOST, CDP_PORT, listCdpTargets } from '../connection.js';

/**
 * List all open chart tabs (CDP page targets).
 */
export function isChartPageTarget(target) {
  if (!target || target.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    const hostname = url.hostname.toLowerCase();
    const isTradingView = hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com');
    return isTradingView && url.pathname.toLowerCase().startsWith('/chart');
  } catch {
    return false;
  }
}

function isShellTarget(target) {
  return target?.type === 'page' && /\/window\/index\.html/i.test(target.url || '');
}

export function rankLandingCandidates(targets, beforeIds = []) {
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds);
  return (targets || [])
    .filter(target => target?.type === 'page' && !isChartPageTarget(target) && !isShellTarget(target))
    .map((target, index) => ({
      target,
      index,
      isNew: !before.has(target.id),
      titleHint: /^new tab$/i.test(String(target.title || '').trim()),
    }))
    .sort((a, b) =>
      Number(b.isNew) - Number(a.isNew)
      || Number(b.titleHint) - Number(a.titleHint)
      || a.index - b.index
    )
    .map(item => item.target);
}

/**
 * List open chart tabs and any currently discoverable layout-picker tab.
 */
export async function list() {
  const targets = await listCdpTargets();
  const landingIds = new Set();

  for (const candidate of rankLandingCandidates(targets)) {
    if (await probeLandingTarget(candidate)) landingIds.add(candidate.id);
  }

  const tabs = targets
    .filter(target => isChartPageTarget(target) || landingIds.has(target.id))
    .map((target, i) => ({
      index: i,
      id: target.id,
      title: String(target.title || '').replace(/^Live stock.*charts on /, ''),
      url: target.url,
      chart_id: isChartPageTarget(target) ? target.url.match(/\/chart\/([^/?]+)/)?.[1] || null : null,
      is_chart: isChartPageTarget(target),
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const targets = await listCdpTargets();
  const candidates = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));

  for (const cand of candidates) {
    let c = null;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: cand.id });
      const probe = await c.Runtime.evaluate({
        expression: `!!document.querySelector('.tabs-container .tab')`,
        returnByValue: true,
      });
      if (probe.result?.value) {
        const out = await fn(async (expression) => {
          const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
          return result?.value;
        });
        await c.close();
        return out;
      }
      await c.close();
    } catch {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(targetId) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const { result } = await c.Runtime.evaluate({ expression: 'document.visibilityState', returnByValue: true });
    return result?.value === 'visible';
  } catch {
    return false;
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

async function probeLandingTarget(target) {
  if (!target || isChartPageTarget(target) || isShellTarget(target)) return false;
  try {
    return await withTarget(target.id, evalIn => evalIn(`
      (function() {
        return !!(
          document.querySelector('.create-new-layout-button')
          || document.querySelector('.layout-list-item')
          || document.querySelector('.layout-list-expand-button')
          || document.querySelector('[class*="layout-list"]')
        );
      })()
    `));
  } catch {
    return false;
  }
}

/**
 * Discover a layout-picker target by DOM capability, not by a single title.
 * Newly-created page targets are checked first, then existing candidates.
 */
async function findLandingTarget({ beforeIds = [], timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const targets = await listCdpTargets();
    for (const candidate of rankLandingCandidates(targets, beforeIds)) {
      if (await probeLandingTarget(candidate)) return candidate;
    }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 200));
  } while (true);
  return null;
}

async function chartTargetReady(targetId) {
  try {
    return await withTarget(targetId, evalIn => evalIn(`
      (function() {
        try {
          var tv = window.TradingViewApi;
          var api = tv && tv._activeChartWidgetWV;
          var chart = api && api.value ? api.value() : null;
          var cwc = tv && tv._chartWidgetCollection;
          var panes = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
          // A newly-created blank layout may not have a symbol yet. For tab
          // discovery we only need a usable chart API; worker provisioning will
          // set the symbol/timeframe immediately afterwards.
          return !!(
            chart
            && typeof chart.setSymbol === 'function'
            && typeof chart.setResolution === 'function'
            && panes.length > 0
          );
        } catch(e) {
          return false;
        }
      })()
    `));
  } catch {
    return false;
  }
}

async function waitForChartTarget({ chartIdsBefore, landingId, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const targets = await listCdpTargets();
    const chartTargets = targets.filter(isChartPageTarget);
    const candidates = [
      ...chartTargets.filter(target => !chartIdsBefore.has(target.id)),
      ...chartTargets.filter(target => target.id === landingId),
    ];

    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      if (await chartTargetReady(candidate.id)) return candidate;
    }

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 250));
  } while (true);
  return null;
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    return await fn(async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({
  layout,
  name,
  landing_timeout_ms = 8000,
  chart_timeout_ms = 15000,
  exact_layout = false,
} = {}) {
  const landingTimeoutMs = Number(landing_timeout_ms);
  const chartTimeoutMs = Number(chart_timeout_ms);
  const exactLayout = Boolean(exact_layout);
  if (!Number.isFinite(landingTimeoutMs) || landingTimeoutMs < 0) {
    throw new Error('landing_timeout_ms must be a non-negative number');
  }
  if (!Number.isFinite(chartTimeoutMs) || chartTimeoutMs < 0) {
    throw new Error('chart_timeout_ms must be a non-negative number');
  }

  let landing = await findLandingTarget({ timeoutMs: Math.min(600, landingTimeoutMs) });
  let shellCounts = null;

  if (!landing) {
    const targetsBefore = await listCdpTargets();
    const targetIdsBefore = new Set(targetsBefore.map(target => target.id));

    const before = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      return count;
    });

    landing = await findLandingTarget({ beforeIds: targetIdsBefore, timeoutMs: landingTimeoutMs });
    const after = await withShell(evalIn => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
    shellCounts = { before, after };
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its layout-picker target was not discoverable by CDP.');

  // Snapshot existing chart targets so we can spot the renderer/target created
  // (or reused) when the landing page navigates into a chart.
  const chartIdsBefore = new Set(
    (await listCdpTargets())
      .filter(isChartPageTarget)
      .map(target => target.id)
  );

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 700));
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await new Promise(r => setTimeout(r, 400));
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var exactOnly = ${exactLayout ? 'true' : 'false'};
        var items = document.querySelectorAll('.layout-list-item');
        var exact = null, contains = null;
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (!t) continue;
          var title = t.textContent.trim();
          var lower = title.toLowerCase();
          if (lower === q && !exact) exact = { item: items[i], title: title };
          else if (lower.indexOf(q) !== -1 && !contains) contains = { item: items[i], title: title };
        }
        var pick = exact || (exactOnly ? null : contains);
        if (!pick) return null;
        pick.item.click();
        return pick.title;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 800));
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // Landing -> chart navigation may create a new renderer target or reuse
  // the landing target. Poll both cases and require the TradingView chart API
  // to be ready before changing the cached client.
  const chartTarget = await waitForChartTarget({
    chartIdsBefore,
    landingId: landing.id,
    timeoutMs: chartTimeoutMs,
  });
  if (!chartTarget) {
    throw new Error(`Picked "${picked}" but no ready chart target became discoverable.`);
  }

  await reconnectTo(chartTarget.id);
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    target_id: chartTarget.id,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTab() {
  const before = await withShell((evalIn) => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
  if (before <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const result = await withShell(async (evalIn) => {
    const clicked = await evalIn(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active') || document.querySelectorAll('.tabs-container .tab')[0];
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await new Promise(r => setTimeout(r, 1000));
    return evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
  });

  // Our cached CDP client may have been attached to the closed tab — re-resolve.
  try { await getClient(); } catch { /* next tool call will reconnect */ }

  return { success: result < before, action: 'tab_closed', tabs_before: before, tabs_after: result };
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  if (!(await isTargetVisible(target.id))) {
    const clicked = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      // Try the same ordinal first (shell order usually matches), then the rest.
      const order = [...new Set([Math.min(idx, count - 1), ...Array.from({ length: count }, (_, k) => k)])];
      for (const k of order) {
        await evalIn(`document.querySelectorAll('.tabs-container .tab')[${k}].click()`);
        await new Promise(r => setTimeout(r, 400));
        if (await isTargetVisible(target.id)) return k;
      }
      return null;
    });
    if (clicked === null) {
      throw new Error(`Clicked through all shell tabs but chart ${target.chart_id} never became visible.`);
    }
  }

  // Re-attach the cached CDP client so subsequent reads follow the switch.
  try {
    await reconnectTo(target.id);
  } catch (e) {
    throw new Error(`Tab is visible but failed to re-attach CDP to it: ${e.message}`);
  }

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id, visually_switched: true };
}
