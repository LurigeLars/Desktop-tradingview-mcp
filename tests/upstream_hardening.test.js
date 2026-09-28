import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { withTimeout } from '../src/connection.js';
import { setInputs } from '../src/core/indicators.js';
import { mouseClick } from '../src/core/ui.js';
import { drawShape } from '../src/core/drawing.js';
import { getOhlcv } from '../src/core/data.js';

test('CDP deadlines reject stalled operations', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 5, 'probe'),
    /probe timed out after 5ms/
  );
});

test('indicator_set_inputs reports verified read-back values', async () => {
  const result = await setInputs({
    entity_id: 'study-1',
    inputs: { length: '50' },
    _deps: {
      evaluate: async () => ({
        before_count: 2,
        after_count: 2,
        actual: { length: 50 },
        unknown_inputs: [],
        restored: false,
      }),
    },
  });
  assert.equal(result.verified, true);
  assert.deepEqual(result.updated_inputs, { length: 50 });
});

test('indicator_set_inputs rejects silent write mismatch', async () => {
  await assert.rejects(
    () => setInputs({
      entity_id: 'study-1',
      inputs: { length: 50 },
      _deps: {
        evaluate: async () => ({
          before_count: 2,
          after_count: 2,
          actual: { length: 20 },
          unknown_inputs: [],
          restored: false,
        }),
      },
    }),
    /did not take effect/
  );
});

test('ui_mouse uses CDP standard button bit masks', async () => {
  const events = [];
  const client = { Input: { dispatchMouseEvent: async event => events.push(event) } };
  await mouseClick({ x: 10, y: 20, button: 'middle', _deps: { client } });
  const pressed = events.find(event => event.type === 'mousePressed');
  const released = events.find(event => event.type === 'mouseReleased');
  assert.equal(pressed.button, 'middle');
  assert.equal(pressed.buttons, 4);
  assert.equal(released.buttons, 0);
});

test('drawShape fails closed when no new entity becomes observable', async () => {
  const result = await drawShape({
    shape: 'horizontal_line',
    point: { time: 1, price: 100 },
    _deps: {
      getChartApi: async () => 'window.__chart',
      evaluate: async expr => expr.includes('getAllShapes') ? ['old'] : null,
      delay: async () => {},
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'shape_not_observed');
  assert.equal(result.entity_id, null);
});

test('drawShape verifies the newly created entity id', async () => {
  let reads = 0;
  const result = await drawShape({
    shape: 'horizontal_line',
    point: { time: 1, price: 100 },
    _deps: {
      getChartApi: async () => 'window.__chart',
      evaluate: async expr => {
        if (!expr.includes('getAllShapes')) return null;
        reads++;
        return reads === 1 ? ['old'] : ['old', 'new-shape'];
      },
      delay: async () => {},
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.entity_id, 'new-shape');
});

test('getOhlcv pages history before reading requested bars', async () => {
  let resident = 2;
  let pageRequests = 0;
  const bars = Array.from({ length: 5 }, (_, i) => ({
    time: i + 1,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10 + i,
  }));

  const result = await getOhlcv({
    count: 5,
    _deps: {
      delay: async () => {},
      evaluate: async expr => {
        if (expr.includes('return {bars: result')) {
          return { bars, total_bars: resident, symbol: 'NASDAQ:TEST', resolution: '60', source: 'direct_bars' };
        }
        if (expr.includes('requestMoreDataAvailable')) return { size: resident, more: true };
        if (expr.includes('requestMoreData(')) { pageRequests++; resident = 5; return true; }
        if (expr.includes('bars().size()')) return resident;
        throw new Error('unexpected expression in OHLCV test');
      },
    },
  });

  assert.equal(pageRequests, 1);
  assert.equal(result.pages_loaded, 1);
  assert.equal(result.requested, 5);
  assert.equal(result.bar_count, 5);
  assert.equal(result.truncated, false);
});

test('ported hardening guards remain present in source', () => {
  const root = new URL('../src/', import.meta.url);
  const connection = readFileSync(new URL('connection.js', root), 'utf8');
  const pine = readFileSync(new URL('core/pine.js', root), 'utf8');
  const watchlist = readFileSync(new URL('core/watchlist.js', root), 'utf8');
  const health = readFileSync(new URL('core/health.js', root), 'utf8');

  assert.match(connection, /const _connecting = new Map\(\)/);
  assert.match(connection, /Runtime\.evaluate/);
  assert.match(pine, /offsetParent !== null/);
  assert.match(pine, /verified: true/);
  assert.match(watchlist, /widgetbar.*data-name="base"/s);
  assert.match(health, /Get-AppxPackage -Name '\*TradingView\*'/);
  assert.match(health, /--no-sandbox/);
});
