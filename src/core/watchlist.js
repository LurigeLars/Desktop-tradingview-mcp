/**
 * Core watchlist logic.
 * Reads via DOM rows (panel auto-opened when needed). Removal uses
 * TradingView's symbols_list REST API from the page context (cookie auth),
 * mirroring the proven alerts REST pattern. Add drives the Add-symbol
 * search UI so bare tickers resolve the same way they do for a human.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

const SIMPLE_BARE_SYMBOL_RE = /^[A-Z0-9_.!]+$/i;

export function isBareSymbolRequest(symbol) {
  const value = String(symbol ?? '').trim();
  return value.length > 0 && SIMPLE_BARE_SYMBOL_RE.test(value);
}

export function matchWatchlistSymbol(requestedSymbol, candidates) {
  const requested = String(requestedSymbol ?? '').trim();
  if (!requested) return { matched: null, verification: 'empty_request' };

  const normalized = requested.toUpperCase();
  const symbols = (candidates || []).filter(Boolean).map(String);
  const exact = symbols.find(symbol => symbol.toUpperCase() === normalized);
  if (exact) return { matched: exact, verification: 'exact' };

  // Only unqualified, simple ticker requests may fall back to matching the
  // ticker suffix. Expressions/formulas and exchange-qualified symbols must
  // verify exactly; otherwise a component of an expression could be reported
  // as a false success (for example, a ratio being mistaken for one leg).
  if (!isBareSymbolRequest(requested)) {
    return { matched: null, verification: 'exact_required' };
  }

  const suffixMatches = symbols.filter(symbol => {
    const suffix = symbol.split(':').pop();
    return suffix && suffix.toUpperCase() === normalized;
  });
  if (suffixMatches.length === 1) {
    return { matched: suffixMatches[0], verification: 'unique_bare_ticker' };
  }
  return {
    matched: null,
    verification: suffixMatches.length > 1 ? 'ambiguous_bare_ticker' : 'not_found',
  };
}

// TV renamed the right-rail button: current builds use data-name="base" with
// aria-label "Watchlist, details, and news"; older builds used
// data-name="base-watchlist-widget-button" / aria-label "Watchlist".
const WL_BUTTON_JS = `(document.querySelector('[data-name="base-watchlist-widget-button"]')
  || document.querySelector('[aria-label="Watchlist, details, and news"]')
  || document.querySelector('[aria-label^="Watchlist"]'))`;

// The watchlist widget lazy-loads after the panel opens; a fixed 500ms wait
// raced it (issue #164). Poll until its Add-symbol button or rows exist.
async function ensureWatchlistOpen(maxWaitMs = 5000) {
  const state = await evaluate(`
    (function() {
      var btn = ${WL_BUTTON_JS};
      if (!btn) return { error: 'Watchlist button not found' };
      var pressed = btn.getAttribute('aria-pressed') === 'true';
      var widgetReady = !!(document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'));
      if (!pressed || !widgetReady) { if (!pressed) btn.click(); return { opened: !pressed }; }
      return { opened: false, ready: true };
    })()
  `);
  if (state?.error) throw new Error(state.error);
  if (state?.ready) return { opened: false };

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(`
      !!(document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'))
    `);
    if (ready) return { opened: !!state?.opened };
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Watchlist panel did not become ready. Is a watchlist widget configured in the right panel?');
}

// Active watchlist metadata (id, name, symbols) read from the React fiber
// tree — needed for the REST endpoints. Approach from PR #65.
async function getActiveListInfo() {
  return evaluate(`
    (function() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      if (!panel) return null;
      var rows = panel.querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var row = rows[0];
      var reactKey = Object.keys(row).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!reactKey) return null;
      var fiber = row[reactKey];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current && fiber.memoizedProps.current.id) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols || [] };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);
}

export async function get() {
  await ensureWatchlistOpen();

  // Positional cell mapping (name, last, change, change%, volume) with
  // Unicode-minus normalization. The old regex classifier dropped every
  // negative value (TV renders U+2212, not ASCII '-') and all tick-notation
  // prices like 106'28'7 — issue #111.
  const data = await evaluate(`
    (function() {
      function norm(t) { return t.replace(/\\u2212/g, '-').trim(); }
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };
      var results = [];
      var seen = {};
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var texts = [];
        for (var j = 0; j < cells.length; j++) texts.push(norm(cells[j].textContent));
        results.push({
          symbol: sym,
          last: texts[1] || null,
          change: texts[2] || null,
          change_percent: texts[3] || null,
          volume: texts[4] || null,
        });
      }
      return { symbols: results, source: results.length ? 'dom_rows' : 'empty' };
    })()
  `);

  const listInfo = await getActiveListInfo();
  return {
    success: true,
    count: data?.symbols?.length || 0,
    source: data?.source || 'unknown',
    ...(listInfo && { list_id: listInfo.id, list_name: listInfo.name }),
    symbols: data?.symbols || [],
  };
}

async function readVisibleWatchlistSymbols() {
  return evaluate(`
    (function() {
      var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
      var symbols = [];
      for (var i = 0; i < rows.length; i++) {
        var value = rows[i].getAttribute('data-symbol-full');
        if (value) symbols.push(value);
      }
      return symbols;
    })()
  `);
}

async function dismissSymbolSearch(client) {
  try {
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  } catch {
    // Best effort. A failed CDP transport is invalidated by connection.js so
    // the next unrelated tool call can rediscover a healthy target.
  }
}

export async function add({ symbol }) {
  const requested = String(symbol ?? '').trim();
  if (!requested) throw new Error('Symbol must not be empty');

  await ensureWatchlistOpen();

  const before = await readVisibleWatchlistSymbols();
  const existing = matchWatchlistSymbol(requested, before);
  if (existing.matched) {
    return {
      success: true,
      symbol: requested,
      added_as: existing.matched,
      action: 'already_present',
      verification: existing.verification,
    };
  }

  const c = await getClient();
  try {
    const addClicked = await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="add-symbol-button"]')
          || document.querySelector('[aria-label="Add symbol"]')
          || document.querySelector('[aria-label*="Add symbol"]');
        if (!btn || btn.offsetParent === null) return { found: false };
        btn.click();
        return { found: true };
      })()
    `);
    if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
    await new Promise(r => setTimeout(r, 400));

    // Preserve the request exactly. TradingView owns parsing/resolution of
    // formulas, spreads and other supported symbol expressions.
    await c.Input.insertText({ text: requested });
    await new Promise(r => setTimeout(r, 700));
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
    await new Promise(r => setTimeout(r, 400));
  } finally {
    await dismissSymbolSearch(c);
  }

  await new Promise(r => setTimeout(r, 400));

  // Verify against TradingView's actual watchlist state. Exchange-qualified
  // symbols and formulas/expressions require an exact match. Only an
  // unqualified simple ticker may use a unique exchange-suffix fallback.
  const after = await readVisibleWatchlistSymbols();
  const verified = matchWatchlistSymbol(requested, after);

  return {
    success: !!verified.matched,
    symbol: requested,
    added_as: verified.matched,
    action: verified.matched ? 'added' : 'not_verified',
    verification: verified.verification,
  };
}

export async function addBulk({ symbols }) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const r = await add({ symbol });
      results.push({
        symbol,
        success: r.success,
        added_as: r.added_as,
        action: r.action,
        verification: r.verification,
      });
    } catch (err) {
      results.push({ symbol, success: false, action: 'failed', error: err.message });
    }
  }
  const added = results.filter(r => r.action === 'added').length;
  const alreadyPresent = results.filter(r => r.action === 'already_present').length;
  const failed = results.length - added - alreadyPresent;
  return {
    success: failed === 0,
    added,
    already_present: alreadyPresent,
    failed,
    results,
  };
}

export async function remove({ symbols }) {
  await ensureWatchlistOpen();
  const listInfo = await getActiveListInfo();
  if (!listInfo) throw new Error('Cannot read active watchlist metadata (React fiber probe failed)');

  // Match requested symbols (bare or EXCHANGE:SYMBOL) against the list.
  const toRemove = [];
  const skipped = [];
  for (const sym of symbols) {
    if (sym.includes(':')) {
      if (listInfo.symbols.includes(sym)) toRemove.push(sym);
      else skipped.push(sym);
    } else {
      const match = listInfo.symbols.find(s => s.split(':').pop().toUpperCase() === sym.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }
  if (!toRemove.length) {
    return { success: false, removed: [], skipped, error: 'No matching symbols in the active watchlist' };
  }

  // Page-context fetch — browser attaches session cookies automatically.
  const resp = await evaluateAsync(`
    fetch('https://www.tradingview.com/api/v1/symbols_list/custom/' + ${JSON.stringify(listInfo.id)} + '/remove/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(${JSON.stringify(toRemove)}),
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, ok: r.ok, body: t.substring(0, 300) }; }); })
      .catch(function(e) { return { status: 0, ok: false, body: String(e) }; })
  `);

  if (!resp?.ok) {
    throw new Error(`Watchlist remove REST call failed (HTTP ${resp?.status}): ${resp?.body}`);
  }

  // The desktop widget doesn't live-sync API removals — remount it by
  // toggling the panel, then verify the rows are actually gone.
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);
  await new Promise(r => setTimeout(r, 400));
  await evaluate(`(function() { var btn = ${WL_BUTTON_JS}; if (btn) btn.click(); })()`);

  let stillPresent = toRemove;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    stillPresent = await evaluate(`
      (function() {
        var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
        var present = {};
        for (var i = 0; i < rows.length; i++) present[rows[i].getAttribute('data-symbol-full')] = true;
        return ${JSON.stringify(toRemove)}.filter(function(s) { return present[s]; });
      })()
    `) || [];
    if (stillPresent.length === 0) break;
  }

  return {
    success: true, removed: toRemove, skipped,
    verified: stillPresent.length === 0,
    list_id: listInfo.id, list_name: listInfo.name, api: 'rest',
  };
}
