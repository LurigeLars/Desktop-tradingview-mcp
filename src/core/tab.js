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

const LANDING_PROBE_TIMEOUT_MS = 500;
const SHELL_OPERATION_TIMEOUT_MS = 6000;
const CHART_PROBE_TIMEOUT_MS = 750;
const NEW_TAB_URL_RE = /app\.asar\/app\/new-tab\/index\.html/i;
const SHELL_TITLE_RE = /tabbed-window/i;
const SHELL_URL_RE = /\/window\/index\.html/i;

export async function withDeadline(promise, timeoutMs, label = 'Operation') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms < 0) throw new Error('timeoutMs must be a non-negative number');
  if (ms === 0) return promise;

  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

export function isNewTabPageTarget(target) {
  return target?.type === 'page' && NEW_TAB_URL_RE.test(String(target.url || ''));
}

function isShellTarget(target) {
  return target?.type === 'page' && (
    SHELL_TITLE_RE.test(String(target.title || ''))
    || SHELL_TITLE_RE.test(String(target.url || ''))
    || SHELL_URL_RE.test(String(target.url || ''))
  );
}

export function rankShellCandidates(targets) {
  return (targets || [])
    .filter(isShellTarget)
    .map((target, index) => {
      const title = String(target.title || '');
      const url = String(target.url || '');
      const score =
        (SHELL_TITLE_RE.test(title) ? 100 : 0)
        + (SHELL_TITLE_RE.test(url) ? 50 : 0)
        + (SHELL_URL_RE.test(url) ? 10 : 0);
      return { target, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.target);
}

export function isReusableWorkerBootstrapTarget(target) {
  if (!target || target.type !== 'page' || isChartPageTarget(target) || isShellTarget(target)) {
    return false;
  }
  if (isNewTabPageTarget(target)) return true;
  try {
    const url = new URL(String(target.url || ''));
    const hostname = url.hostname.toLowerCase();
    const isTradingView = hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com');
    return isTradingView && url.pathname === '/';
  } catch {
    return false;
  }
}

export function rankReusableWorkerBootstrapCandidates(targets) {
  return (targets || [])
    .filter(isReusableWorkerBootstrapTarget)
    .map((target, index) => ({
      target,
      index,
      knownNewTab: isNewTabPageTarget(target),
      homepage: (() => {
        try {
          const url = new URL(String(target.url || ''));
          return url.pathname === '/';
        } catch {
          return false;
        }
      })(),
    }))
    .sort((a, b) =>
      Number(b.knownNewTab) - Number(a.knownNewTab)
      || Number(b.homepage) - Number(a.homepage)
      || a.index - b.index
    )
    .map(item => item.target);
}

export function rankLandingCandidates(targets, beforeIds = []) {
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds);
  return (targets || [])
    .filter(target => target?.type === 'page' && !isChartPageTarget(target) && !isShellTarget(target))
    .map((target, index) => ({
      target,
      index,
      isNew: !before.has(target.id),
      knownNewTab: isNewTabPageTarget(target),
      titleHint: /^new tab$/i.test(String(target.title || '').trim()),
    }))
    .sort((a, b) =>
      Number(b.isNew) - Number(a.isNew)
      || Number(b.knownNewTab) - Number(a.knownNewTab)
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
  const candidates = rankLandingCandidates(targets);

  // Never let one stale/non-responsive Electron page target block tab_list.
  // Probe candidates concurrently and fail closed on each bounded probe.
  const probeResults = await Promise.all(
    candidates.map(async candidate => ({
      id: candidate.id,
      isLanding: isNewTabPageTarget(candidate)
        ? true
        : await probeLandingTarget(candidate, LANDING_PROBE_TIMEOUT_MS),
    })),
  );
  const landingIds = new Set(
    probeResults.filter(item => item.isLanding).map(item => item.id),
  );

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

  return {
    success: true,
    tab_count: tabs.length,
    tabs,
    discovery: {
      candidate_count: candidates.length,
      landing_count: landingIds.size,
      probe_timeout_ms: LANDING_PROBE_TIMEOUT_MS,
    },
  };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const targets = await listCdpTargets();
  const candidates = rankShellCandidates(targets);

  const failures = [];
  for (const cand of candidates) {
    try {
      const result = await withTarget(cand.id, async evalIn => {
        const hasTabs = await evalIn(`!!document.querySelector('.tabs-container .tab')`);
        if (!hasTabs) return { matched: false, value: null };
        return { matched: true, value: await fn(evalIn) };
      }, SHELL_OPERATION_TIMEOUT_MS);

      if (result?.matched) return result.value;
    } catch (error) {
      failures.push({
        target_id: cand.id,
        error: error?.message || String(error),
      });
    }
  }

  const detail = failures.length
    ? ' Probe failures: ' + JSON.stringify(failures)
    : '';
  throw new Error(
    'TradingView tabbed-window shell target not found within bounded probes. Is this TradingView Desktop with tabs?' +
    detail,
  );
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(targetId) {
  try {
    return await withTarget(
      targetId,
      evalIn => evalIn('document.visibilityState').then(value => value === 'visible'),
      CHART_PROBE_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}

async function probeLandingTarget(target, timeoutMs = LANDING_PROBE_TIMEOUT_MS) {
  if (!target || isChartPageTarget(target) || isShellTarget(target)) return false;
  if (isNewTabPageTarget(target)) return true;
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
    `), timeoutMs);
  } catch {
    return false;
  }
}

/**
 * Discover a layout-picker target by DOM capability, not by a single title.
 * Newly-created page targets are checked first, then existing candidates.
 */
async function findLandingTarget({ beforeIds = [], timeoutMs = 1000, requireNew = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds);
  do {
    const targets = await listCdpTargets();
    const ranked = rankLandingCandidates(targets, before);
    const candidates = requireNew
      ? ranked.filter(candidate => !before.has(candidate.id))
      : ranked;
    const known = candidates.find(isNewTabPageTarget);
    if (known) return known;

    const remainingMs = Math.max(1, deadline - Date.now());
    const perProbeMs = Math.min(LANDING_PROBE_TIMEOUT_MS, remainingMs);

    const matches = await Promise.all(
      candidates.map(candidate => probeLandingTarget(candidate, perProbeMs)),
    );
    const matchIndex = matches.findIndex(Boolean);
    if (matchIndex >= 0) return candidates[matchIndex];

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
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
    `), CHART_PROBE_TIMEOUT_MS);
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
    const unique = candidates.filter(candidate => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    });

    const ready = await Promise.all(unique.map(candidate => chartTargetReady(candidate.id)));
    const readyIndex = ready.findIndex(Boolean);
    if (readyIndex >= 0) return unique[readyIndex];

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 250));
  } while (true);
  return null;
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn, timeoutMs = 2000) {
  const task = (async () => {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      return await fn(async expression => {
        const response = await withDeadline(
          client.Runtime.evaluate({ expression, returnByValue: true }),
          Math.min(Number(timeoutMs) || 2000, 1000),
          'CDP Runtime.evaluate for target ' + targetId,
        );
        if (response.exceptionDetails) {
          const message = response.exceptionDetails.exception?.description
            || response.exceptionDetails.text
            || 'Unknown target evaluation error';
          throw new Error(message);
        }
        return response.result?.value;
      });
    } finally {
      try { if (client) await client.close(); } catch { /* already gone */ }
    }
  })();

  return withDeadline(task, timeoutMs, 'CDP target ' + targetId);
}

export async function createDirectChartTarget(url, {
  createTarget = options => CDP.New(options),
  listTargets = listCdpTargets,
  isReady = chartTargetReady,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 15000,
} = {}) {
  const created = await withDeadline(
    createTarget({ host: CDP_HOST, port: CDP_PORT, url }),
    Math.min(Number(timeoutMs) || 15000, 5000),
    'CDP.New chart target',
  );
  const targetId = created?.id || created?.targetId;
  if (!targetId) {
    throw new Error('CDP.New returned no target id');
  }

  const deadline = Date.now() + Number(timeoutMs);
  do {
    const targets = await listTargets();
    const target = targets.find(item => String(item.id) === String(targetId));
    if (target && isChartPageTarget(target) && await isReady(targetId)) {
      return target;
    }
    if (Date.now() >= deadline) break;
    await wait(250);
  } while (true);

  throw new Error('Direct CDP chart target was created but did not become ready in time');
}

async function navigateTarget(targetId, url, timeoutMs = 2500) {
  const task = (async () => {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      await client.Page.enable();
      const result = await client.Page.navigate({ url });
      if (result?.errorText) {
        throw new Error('Page.navigate failed: ' + result.errorText);
      }
      return result;
    } finally {
      try { if (client) await client.close(); } catch { /* best effort */ }
    }
  })();

  return withDeadline(task, timeoutMs, 'CDP Page.navigate for target ' + targetId);
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
  symbol,
  chart_id,
  as_chart = false,
  force_new_tab = false,
  landing_timeout_ms = 8000,
  chart_timeout_ms = 15000,
  exact_layout = false,
  _deps,
} = {}) {
  const landingTimeoutMs = Number(landing_timeout_ms);
  const chartTimeoutMs = Number(chart_timeout_ms);
  const exactLayout = Boolean(exact_layout);
  const requestedChartId = chart_id == null ? '' : String(chart_id).trim();
  if (requestedChartId && !/^[A-Za-z0-9_-]+$/.test(requestedChartId)) {
    throw new Error('chart_id must be a TradingView chart URL token');
  }
  const wantsDirectChart = Boolean(symbol) || Boolean(as_chart) || Boolean(requestedChartId);
  const forceNewTab = Boolean(force_new_tab);
  if (!Number.isFinite(landingTimeoutMs) || landingTimeoutMs < 0) {
    throw new Error('landing_timeout_ms must be a non-negative number');
  }
  if (!Number.isFinite(chartTimeoutMs) || chartTimeoutMs < 0) {
    throw new Error('chart_timeout_ms must be a non-negative number');
  }

  if (wantsDirectChart && forceNewTab && requestedChartId) {
    const chartUrl = 'https://www.tradingview.com/chart/' + encodeURIComponent(requestedChartId) + '/';
    const listTargets = _deps?.listTargets || listCdpTargets;
    const reconnect = _deps?.reconnectTo || reconnectTo;
    const navigate = _deps?.navigateTarget || navigateTarget;
    const waitForReadyChart = _deps?.waitForChartTarget || waitForChartTarget;
    const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    let currentTargets = await listTargets();
    let existing = currentTargets.find(target =>
      isChartPageTarget(target)
      && String(target.url.match(/\/chart\/([^/?]+)/)?.[1] || '') === requestedChartId
    );

    // TradingView Desktop restores its own tabs asynchronously. When no chart
    // targets are present yet, give that restore a bounded head start before
    // creating or repurposing anything.
    if (!existing && currentTargets.filter(isChartPageTarget).length === 0) {
      const restoreDeadline = Date.now() + 2500;
      do {
        await wait(250);
        currentTargets = await listTargets();
        existing = currentTargets.find(target =>
          isChartPageTarget(target)
          && String(target.url.match(/\/chart\/([^/?]+)/)?.[1] || '') === requestedChartId
        );
        if (existing || Date.now() >= restoreDeadline) break;
      } while (true);
    }

    if (existing) {
      await reconnect(existing.id);
      return {
        success: true,
        action: 'existing_chart_target_reused',
        direct_navigation: true,
        reused_existing_target: true,
        target_id: existing.id,
        chart_id: requestedChartId,
        symbol: null,
        requested_chart_id: requestedChartId,
      };
    }

    // Desktop normally starts with one or more ordinary TradingView tabs.
    // Reuse those visual tabs first so worker bootstrap converges toward five
    // total tabs instead of adding five tabs on every start.
    const reusable = rankReusableWorkerBootstrapCandidates(currentTargets)[0] || null;
    if (reusable) {
      const chartIdsBefore = new Set(
        currentTargets.filter(isChartPageTarget).map(target => target.id)
      );
      await navigate(reusable.id, chartUrl, Math.min(chartTimeoutMs, 2500));
      const chartTarget = await waitForReadyChart({
        chartIdsBefore,
        landingId: reusable.id,
        timeoutMs: chartTimeoutMs,
      });
      if (!chartTarget) {
        throw new Error('Existing TradingView startup tab was navigated but no ready worker chart target became discoverable.');
      }
      await reconnect(chartTarget.id);
      return {
        success: true,
        action: 'startup_tab_reused_for_worker',
        direct_navigation: true,
        reused_existing_tab: true,
        target_id: chartTarget.id,
        chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
        symbol: null,
        requested_chart_id: requestedChartId,
      };
    }

    const createPersistentTarget = _deps?.createDirectChartTarget || createDirectChartTarget;
    const chartTarget = await createPersistentTarget(chartUrl, {
      timeoutMs: chartTimeoutMs,
    });
    await reconnect(chartTarget.id);
    return {
      success: true,
      action: 'new_chart_target_opened',
      direct_navigation: true,
      direct_target_creation: true,
      target_id: chartTarget.id,
      chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      symbol: null,
      requested_chart_id: requestedChartId,
    };
  }

  let landing = forceNewTab
    ? null
    : await findLandingTarget({ timeoutMs: Math.min(600, landingTimeoutMs) });
  let shellCounts = null;

  if (!landing) {
    const targetsBefore = await listCdpTargets();
    const targetIdsBefore = new Set(targetsBefore.map(target => target.id));

    const before = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('button.create-new-tab-button')
            || document.querySelector('[class*="create-new-tab"]');
          if (!btn) return { ok: false, reason: 'button_not_found' };
          var key = Object.keys(btn).find(function(k){ return k.indexOf('__reactProps') === 0; });
          if (key && btn[key] && typeof btn[key].onClick === 'function') {
            btn[key].onClick({
              preventDefault: function(){},
              stopPropagation: function(){},
              currentTarget: btn,
              target: btn
            });
            return { ok: true, via: 'react_onclick' };
          }
          btn.click();
          return { ok: true, via: 'dom_click' };
        })()
      `);
      if (!clicked?.ok) throw new Error('New-tab button not found in shell window.');
      return count;
    });

    landing = await findLandingTarget({
      beforeIds: targetIdsBefore,
      timeoutMs: landingTimeoutMs,
      requireNew: true,
    });
    const after = await withShell(evalIn => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
    shellCounts = { before, after };
  }

  if (!landing) {
    throw new Error('New tab opened but its new-tab target was not discoverable by CDP.');
  }

  // Workers and callers that only need a chart target should bypass the
  // layout-picker DOM entirely. TradingView Desktop exposes its new-tab page
  // as app.asar/app/new-tab/index.html; navigate that target directly to a
  // chart and let the normal chart-ready discovery handle renderer reuse.
  if (wantsDirectChart) {
    const chartIdsBefore = new Set(
      (await listCdpTargets())
        .filter(isChartPageTarget)
        .map(target => target.id)
    );
    const chartUrl = requestedChartId
      ? 'https://www.tradingview.com/chart/' + encodeURIComponent(requestedChartId) + '/'
      : symbol
        ? 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(String(symbol))
        : 'https://www.tradingview.com/chart/';

    await navigateTarget(landing.id, chartUrl, Math.min(chartTimeoutMs, 2500));
    const chartTarget = await waitForChartTarget({
      chartIdsBefore,
      landingId: landing.id,
      timeoutMs: chartTimeoutMs,
    });
    if (!chartTarget) {
      throw new Error('New tab target was found and navigated, but no ready chart target became discoverable.');
    }

    await reconnectTo(chartTarget.id);
    return {
      success: true,
      action: 'new_chart_tab_opened',
      direct_navigation: true,
      target_id: chartTarget.id,
      chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      symbol: symbol || null,
      requested_chart_id: requestedChartId || null,
    };
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open it.',
      ...state,
    };
  }

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
  }, 3500);

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
 * Remove stale TradingView Desktop shell tabs while preserving exact live
 * worker renderer targets. This is intentionally separate from CDP target
 * cleanup because Desktop can retain shell-tab UI state after renderer targets
 * have disappeared.
 *
 * Safety:
 * - discovers one shell-tab index for every keep target before deleting;
 * - closes from highest index to lowest so saved indexes do not shift forward;
 * - rechecks target visibility immediately before each close;
 * - skips rather than closes if any keep target is visible after clicking the
 *   candidate shell tab.
 */
export async function cleanupOrphanShellTabs({
  keep_target_ids = [],
  _deps,
} = {}) {
  const keepIds = [...new Set(
    (keep_target_ids || []).map(value => String(value || '').trim()).filter(Boolean)
  )];
  if (!keepIds.length) {
    throw new Error('cleanupOrphanShellTabs requires at least one keep target id');
  }

  const runWithShell = _deps?.withShell || withShell;
  const targetVisible = _deps?.isTargetVisible || isTargetVisible;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  return runWithShell(async evalIn => {
    const countTabs = () => evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
    const activeIndex = () => evalIn(`
      (function() {
        var tabs = Array.from(document.querySelectorAll('.tabs-container .tab'));
        var active = document.querySelector('.tabs-container .tab.active');
        return active ? tabs.indexOf(active) : -1;
      })()
    `);
    const clickTab = index => evalIn(`
      (function() {
        var tab = document.querySelectorAll('.tabs-container .tab')[${Number(index)}];
        if (!tab) return false;
        tab.click();
        return true;
      })()
    `);
    const closeTabAt = index => evalIn(`
      (function() {
        var tab = document.querySelectorAll('.tabs-container .tab')[${Number(index)}];
        if (!tab) return false;
        var close = tab.querySelector('.tab-close-button-container button')
          || tab.querySelector('[class*="close"] button')
          || tab.querySelector('button[class*="close"]')
          || tab.querySelector('[class*="close"]');
        if (!close) return false;

        var key = Object.keys(close).find(function(k){ return k.indexOf('__reactProps') === 0; });
        if (key && close[key] && typeof close[key].onClick === 'function') {
          close[key].onClick({
            preventDefault: function(){},
            stopPropagation: function(){},
            currentTarget: close,
            target: close
          });
          return true;
        }

        close.click();
        return true;
      })()
    `);

    const before = Number(await countTabs());
    const protectedIndexes = new Set();
    const missingKeepTargets = [];

    for (const targetId of keepIds) {
      let found = false;
      if (await targetVisible(targetId)) {
        const index = Number(await activeIndex());
        if (index >= 0) {
          protectedIndexes.add(index);
          found = true;
        }
      }

      if (!found) {
        const count = Number(await countTabs());
        for (let index = 0; index < count; index++) {
          if (!(await clickTab(index))) continue;
          await wait(180);
          if (!(await targetVisible(targetId))) continue;

          const resolved = Number(await activeIndex());
          if (resolved >= 0) protectedIndexes.add(resolved);
          found = resolved >= 0;
          break;
        }
      }

      if (!found) missingKeepTargets.push(targetId);
    }

    if (missingKeepTargets.length) {
      throw new Error(
        'Refusing shell cleanup because worker targets could not be mapped to shell tabs: ' +
        missingKeepTargets.join(', ')
      );
    }

    const closed = [];
    const skipped = [];
    const startCount = Number(await countTabs());

    for (let index = startCount - 1; index >= 0; index--) {
      if (protectedIndexes.has(index)) continue;

      if (!(await clickTab(index))) {
        skipped.push({ index, reason: 'shell_tab_not_found' });
        continue;
      }
      await wait(180);

      let visibleKeep = null;
      for (const targetId of keepIds) {
        if (await targetVisible(targetId)) {
          visibleKeep = targetId;
          break;
        }
      }
      if (visibleKeep) {
        skipped.push({ index, reason: 'worker_target_visible', target_id: visibleKeep });
        continue;
      }

      const clicked = await closeTabAt(index);
      if (!clicked) {
        skipped.push({ index, reason: 'close_control_not_found' });
        continue;
      }
      await wait(220);
      closed.push(index);
    }

    const after = Number(await countTabs());
    return {
      success: true,
      tabs_before: before,
      tabs_after: after,
      protected_indexes: [...protectedIndexes].sort((a, b) => a - b),
      closed_indexes: closed,
      skipped,
    };
  });
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTabByTargetId({ target_id, _deps } = {}) {
  const targetId = String(target_id || '').trim();
  if (!targetId) throw new Error('target_id is required');

  const listTargets = _deps?.listTargets || listCdpTargets;
  const listTabs = _deps?.listTabs || list;
  const closeTarget = _deps?.closeTarget
    || (id => CDP.Close({ host: CDP_HOST, port: CDP_PORT, id }));
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = Number(_deps?.timeoutMs || 3000);

  const tabs = await listTabs();
  if (Number(tabs?.tab_count || 0) <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const target = (tabs?.tabs || []).find(tab => String(tab.id) === targetId);
  if (!target) {
    throw new Error('TradingView tab target ' + targetId + ' is not an open chart/new-tab target.');
  }

  const beforeTargets = await listTargets();
  if (!beforeTargets.some(item => String(item.id) === targetId)) {
    throw new Error('TradingView tab target ' + targetId + ' disappeared before close.');
  }

  await closeTarget(targetId);

  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = await listTargets();
    if (!remaining.some(item => String(item.id) === targetId)) {
      try { await getClient(); } catch { /* next tool call will reconnect */ }
      return {
        success: true,
        action: 'tab_closed',
        target_id: targetId,
        chart_id: target.chart_id || null,
      };
    }
    if (Date.now() >= deadline) break;
    await wait(100);
  } while (true);

  throw new Error('TradingView tab target ' + targetId + ' remained present after close request.');
}

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
