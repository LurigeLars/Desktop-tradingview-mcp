/**
 * Read-only, cursor-based historical candles from the ATTACHED DTV chart.
 * Does not switch symbols, navigate charts, edit studies, or change layout.
 * Private TradingView series API: fail closed if its shape/behaviour changes.
 */
import { evaluate, KNOWN_PATHS } from '../connection.js';

const API = KNOWN_PATHS.chartApi;
const BARS = KNOWN_PATHS.mainSeriesBars;
const MAX_ROWS = 1000;
const MAX_LOADS = 30;
const LOAD_ROWS = 1000;
const POLL_ROUNDS = 12;
const POLL_DELAY_MS = 250;

let sequence = Promise.resolve();

function parseSeconds(value, name) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 100000000 || n > 9999999999) {
    throw new Error(name + ' must be a UNIX timestamp in seconds');
  }
  return n;
}
function requireId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required; use chart_get_state first');
  return value.trim();
}
function encodeCursor(symbol, resolution, before) {
  return Buffer.from(JSON.stringify({ v: 1, symbol, resolution, before }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('Invalid cursor');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid cursor'); }
  if (!parsed || parsed.v !== 1 || typeof parsed.symbol !== 'string' || typeof parsed.resolution !== 'string') {
    throw new Error('Invalid cursor version or identity');
  }
  parsed.before = parseSeconds(parsed.before, 'cursor.before');
  if (parsed.before === null) throw new Error('Invalid cursor timestamp');
  return parsed;
}

function validateIdentity(snapshot, symbol, resolution) {
  if (!snapshot || snapshot.error) throw new Error('CHART_UNAVAILABLE: ' + (snapshot?.error || 'missing chart state'));
  if (snapshot.symbol !== symbol || String(snapshot.resolution) !== resolution) {
    throw new Error('CHART_CHANGED: expected ' + symbol + '/' + resolution + ', got ' + snapshot.symbol + '/' + snapshot.resolution);
  }
  if (!Number.isInteger(snapshot.loaded) || snapshot.loaded < 0) throw new Error('CHART_UNAVAILABLE: invalid bars collection');
}
function makeProbe(before) {
  return `(function() {
    try {
      var api = ${API}, ms = api._chartWidget.model().mainSeries(), b = ms.bars();
      var first = b.firstIndex(), last = b.lastIndex(), eligible = 0;
      for (var i = first; i <= last; i++) {
        var v = b.valueAt(i);
        if (v && (${before === null ? 'true' : 'v[0] < ' + before})) eligible++;
      }
      var fv = b.valueAt(first), lv = b.valueAt(last), more = false;
      try { more = ms.requestMoreDataAvailable() === true; } catch (e) {}
      return { symbol: api.symbol(), resolution: String(api.resolution()),
        loaded: b.size(), eligible: eligible, first_time: fv ? fv[0] : null,
        last_time: lv ? lv[0] : null, more: more };
    } catch (e) { return {error: String(e.message || e)}; }
  })()`;
}
function makeRead(before, count) {
  return `(function() {
    try {
      var api = ${API}, b = ${BARS}, rows = [], first = b.firstIndex(), last = b.lastIndex();
      for (var i = last; i >= first && rows.length < ${count}; i--) {
        var v = b.valueAt(i);
        if (v && (${before === null ? 'true' : 'v[0] < ' + before})) {
          rows.push({time:v[0], open:v[1], high:v[2], low:v[3], close:v[4], volume:v[5] || 0});
        }
      }
      rows.reverse();
      return {symbol:api.symbol(), resolution:String(api.resolution()), loaded:b.size(), bars:rows};
    } catch (e) { return {error:String(e.message || e)}; }
  })()`;
}

/** Serialized against other history reads; detects chart switching by any other tool. */
async function fetchHistory({ count = 500, before_time, cursor, expected_symbol, expected_resolution, _deps } = {}) {
  const run = _deps?.evaluate || evaluate;
  const delay = _deps?.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const symbol = requireId(expected_symbol, 'expected_symbol');
  const resolution = requireId(expected_resolution, 'expected_resolution');
  const rows = Number(count);
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) throw new Error('count must be an integer from 1 to ' + MAX_ROWS);
  if (cursor !== undefined && cursor !== null && before_time !== undefined && before_time !== null) {
    throw new Error('Specify cursor OR before_time, not both');
  }
  let before = parseSeconds(before_time, 'before_time');
  if (cursor !== undefined && cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (decoded.symbol !== symbol || decoded.resolution !== resolution) throw new Error('CURSOR_IDENTITY_MISMATCH');
    before = decoded.before;
  }

  let state = await run(makeProbe(before));
  validateIdentity(state, symbol, resolution);
  if (state.loaded === 0) throw new Error('HISTORY_EMPTY: chart has no loaded bars');
  let loads = 0;
  while (state.eligible < rows && state.more) {
    if (loads >= MAX_LOADS) throw new Error('HISTORY_PAGE_LIMIT: unable to load enough candles within guard');
    const prev = state;
    const answer = await run(`(function() {
      try { ${API}._chartWidget.model().mainSeries().requestMoreData(${LOAD_ROWS}); return true; }
      catch (e) { return {error:String(e.message || e)}; }
    })()`);
    if (answer && answer.error) throw new Error('HISTORY_REQUEST_FAILED: ' + answer.error);
    loads++;
    let advanced = false;
    for (let poll = 0; poll < POLL_ROUNDS; poll++) {
      await delay(POLL_DELAY_MS);
      state = await run(makeProbe(before));
      validateIdentity(state, symbol, resolution);
      if (state.first_time !== prev.first_time || state.loaded > prev.loaded || state.eligible > prev.eligible) {
        advanced = true;
        break;
      }
      if (!state.more) break;
    }
    if (!advanced && state.eligible < rows) {
      // A provider can exhaust its feed without growing; incomplete pages are not silently trusted.
      if (state.more) throw new Error('HISTORY_STALLED: TradingView returned no older bars');
      break;
    }
  }

  const final = await run(makeRead(before, rows));
  validateIdentity(final, symbol, resolution);
  if (!Array.isArray(final.bars)) throw new Error('HISTORY_UNAVAILABLE: missing bar rows');
  if (final.bars.length !== Math.min(rows, state.eligible)) {
    throw new Error('HISTORY_CHANGED: bar count changed during read');
  }
  for (let i = 0; i < final.bars.length; i++) {
    const bar = final.bars[i];
    if (!Number.isSafeInteger(bar.time) || !['open','high','low','close','volume'].every(k => Number.isFinite(bar[k]))
      || bar.high < bar.low || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || (i > 0 && bar.time <= final.bars[i - 1].time)) {
      throw new Error('HISTORY_INVALID: non-finite, duplicate, unordered, or inconsistent OHLCV');
    }
  }
  const firstTime = final.bars[0]?.time ?? null;
  const lastTime = final.bars.at(-1)?.time ?? null;
  // If the cache contains additional eligible bars we know an older page exists.
  // Otherwise the feed's availability indication is conservative, not a guarantee.
  const hasMore = final.bars.length > 0 && (state.eligible > final.bars.length || state.more);
  return {
    success:true, source:'tradingview_desktop_chart_series', symbol, resolution,
    requested:rows, returned:final.bars.length, first_time:firstTime, last_time:lastTime,
    total_loaded:final.loaded, pages_loaded:loads,
    has_more:hasMore, next_cursor:hasMore ? encodeCursor(symbol, resolution, firstTime) : null,
    feed_may_have_more:state.more, bars:final.bars
  };
}

export function getOhlcvHistory(options) {
  const attempt = sequence.then(() => fetchHistory(options));
  sequence = attempt.catch(() => {});
  return attempt;
}
