#!/usr/bin/env node
/**
 * Read-only TradingView Desktop API inventory. Requires an explicit CDP target ID.
 * Never switches charts, calls trading methods, or modifies the UI.
 *
 * Usage: node scripts/audit-live-api.mjs --target <CDP_TARGET_ID> [--output path.json]
 */
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf(name) + 1];
const target = argv.includes('--target') ? arg('--target') : null;
const output = argv.includes('--output') ? arg('--output') : null;
const port = Number(process.env.TV_CDP_PORT || 9222);
if (!target || !/^[A-F0-9]{32}$/i.test(target)) {
  console.error('Explicit 32-character --target CDP ID required; refusing to auto-select a tab.');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');

const targets = await CDP.List({ host: '127.0.0.1', port });
const tab = targets.find(t => t.id === target && t.type === 'page');
let isTradingView = false;
try {
  const url = new URL(tab?.url || '');
  isTradingView = url.protocol === 'https:' &&
    (url.hostname === 'tradingview.com' || url.hostname.endsWith('.tradingview.com'));
} catch { /* invalid URL */ }
if (!tab || !isTradingView) {
  throw new Error('Target not a verified TradingView page; no action taken.');
}

const client = await CDP({ host: '127.0.0.1', port, target });
try {
  const expression = `(function() {
    var api = window.TradingViewApi;
    if (!api || !api._activeChartWidgetWV || !api._activeChartWidgetWV.value()) {
      return { error: 'No active chart' };
    }
    var roots = {
      chart: api._activeChartWidgetWV.value(),
      collection: api._chartWidgetCollection,
      api: api
    };
    var out = {};
    var excluded = ['constructor', 'hasOwnProperty', 'isPrototypeOf',
      'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf'];
    for (var entry of Object.entries(roots)) {
      var group = entry[0], obj = entry[1], p = obj, depth = 0;
      var names = new Set();
      while (p && depth++ < 3) {
        Object.getOwnPropertyNames(p).forEach(n => names.add(n));
        p = Object.getPrototypeOf(p);
      }
      out[group] = Array.from(names).filter(n => {
        try { return typeof obj[n] === 'function' && !n.startsWith('__')
          && !excluded.includes(n); } catch (e) { return false; }
      }).sort().map(n => {
        var source = String(obj[n]);
        return { name: n, status: 'present_not_behavior_tested',
          potential_stub: /Not implemented|not implemented|Data export is not supported/.test(source) };
      });
    }
    return {
      chart: { symbol: roots.chart.symbol(), resolution: roots.chart.resolution() },
      methods: out
    };
  })()`;
  const response = await client.Runtime.evaluate({
    expression, returnByValue: true, awaitPromise: false,
  });
  if (response.exceptionDetails) throw new Error('CDP evaluation failed');
  const result = response.result?.value;
  if (!result || result.error) throw new Error(result?.error || 'No API result');
  const report = {
    audited_at: new Date().toISOString(),
    target_id: target,
    scope: 'Read-only presence and possible stub inspection; NOT functional verification',
    ...result,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, json, { flag: 'wx' });
  else process.stdout.write(json);
} finally {
  await client.close();
}
