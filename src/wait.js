import { evaluate } from './connection.js';
import { matchesRequestedQuoteIdentity } from './core/quote-identity.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

const normalizedInterval = value => String(value ?? '').toUpperCase()
  .replace(/^1([DWM])$/, '$1');

/**
 * A chart's reactive symbol label may update while its loaded main series
 * still refers to the previous instrument. Require source series identity,
 * real loaded bars, and source interval; DOM legend/bar counts are not proof.
 */
export function isChartDataReady(state, expectedSymbol = null, expectedTf = null) {
  if (!state || state.isLoading || !Number.isFinite(state.seriesBarCount)
      || state.seriesBarCount < 1 || !state.seriesSymbol) return false;

  if (expectedSymbol) {
    if (!matchesRequestedQuoteIdentity(expectedSymbol, state.currentSymbol)) return false;
    if (!matchesRequestedQuoteIdentity(expectedSymbol, state.seriesSymbol)) return false;
  } else if (state.currentSymbol &&
      !matchesRequestedQuoteIdentity(state.currentSymbol, state.seriesSymbol)) {
    return false;
  }

  if (expectedTf) {
    const wanted = normalizedInterval(expectedTf);
    if (normalizedInterval(state.resolution) !== wanted
        || normalizedInterval(state.seriesInterval) !== wanted) return false;
  }
  return true;
}

export async function waitForChartReady(expectedSymbol = null, expectedTf = null,
  timeout = DEFAULT_TIMEOUT, _deps = {}) {
  const read = _deps.evaluate || evaluate;
  const sleep = _deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const start = Date.now();
  let lastSignature = '';
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await read(`
      (function() {
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = !!(spinner && spinner.offsetParent !== null);
        var currentSymbol = null, resolution = null, seriesSymbol = null;
        var seriesInterval = null, seriesBarCount = -1;
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          currentSymbol = chart.symbol();
          resolution = chart.resolution();
          var main = chart._chartWidget.model().mainSeries();
          seriesSymbol = main.symbol();
          seriesInterval = main.interval();
          seriesBarCount = main.bars().size();
        } catch (e) {}
        return {
          isLoading: isLoading, currentSymbol: currentSymbol,
          resolution: resolution, seriesSymbol: seriesSymbol,
          seriesInterval: seriesInterval, seriesBarCount: seriesBarCount
        };
      })()
    `);

    if (!isChartDataReady(state, expectedSymbol, expectedTf)) {
      stableCount = 0;
      lastSignature = '';
      await sleep(POLL_INTERVAL);
      continue;
    }
    const signature = [
      state.currentSymbol, state.resolution, state.seriesSymbol,
      state.seriesInterval, state.seriesBarCount,
    ].join('|');
    if (signature === lastSignature) stableCount++;
    else { lastSignature = signature; stableCount = 0; }
    if (stableCount >= 2) return true;
    await sleep(POLL_INTERVAL);
  }
  return false;
}

/**
 * Wait for the chart to finish (re)rendering — used before screenshots so a
 * capture right after chart_set_symbol / chart_set_timeframe doesn't grab a
 * stale frame (issue #144). Waits for any loading spinner to clear, then for
 * the symbol/resolution/canvas signature to hold stable across 3 polls.
 */
export async function waitForChartRender(timeout = 5000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: !!(spinner && spinner.offsetParent !== null),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= 3) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
