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
import { getClient, reconnectTo, CDP_HOST, CDP_PORT } from '../connection.js';

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
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

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 */
export async function newTab() {
  const result = await withShell(async (evalIn) => {
    const before = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
    const clicked = await evalIn(`
      (function() {
        var btn = document.querySelector('[class*="create-new-tab"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('New-tab button not found in shell window.');
    await new Promise(r => setTimeout(r, 1500));
    const after = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
    return { before, after };
  });

  const state = await list();
  return {
    success: result.after > result.before,
    action: result.after > result.before ? 'new_tab_opened' : 'new_tab_click_had_no_effect',
    shell_tabs_before: result.before,
    shell_tabs_after: result.after,
    note: 'New tabs open on a landing page; they appear in tab_list once a chart is opened in them.',
    ...state,
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
