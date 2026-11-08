/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { setSymbol, setTimeframe, getState } from './chart.js';
import { getOhlcv } from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        await setSymbol({ symbol });

        if (tf) {
          await setTimeframe({ timeframe: tf });
        }

        await new Promise(r => setTimeout(r, delay));
        const state = await getState();
        const actualTicker = String(state.symbol || '').split(':').pop().toUpperCase();
        const requestedTicker = String(symbol).split(':').pop().toUpperCase();
        const actualTf = String(state.resolution || '').replace(/^1D$/, 'D').replace(/^1W$/, 'W');
        const requestedTf = tf ? String(tf).replace(/^1D$/, 'D').replace(/^1W$/, 'W') : null;
        if (actualTicker !== requestedTicker || (requestedTf && actualTf !== requestedTf)) {
          throw new Error(`Chart mismatch: requested ${symbol}/${tf || 'current'}, got ${state.symbol}/${state.resolution}`);
        }

        let actionResult;
        if (action === 'screenshot') {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          // Use the same direct chart-series reader as data_get_ohlcv.
          // exportData() is not supported on all Desktop chart builds.
          const limit = Math.min(Math.max(1, Math.floor(Number(ohlcv_count) || 100)), 500);
          const data = await getOhlcv({ count: limit });
          if (!data.success || !data.bars?.length) throw new Error('No OHLCV bars returned');
          if (String(data.symbol || '').split(':').pop().toUpperCase() !== requestedTicker) {
            throw new Error('OHLCV symbol mismatch: ' + data.symbol);
          }
          actionResult = {
            symbol: data.symbol, resolution: data.resolution,
            bar_count: data.bar_count, total_available: data.total_available,
            truncated: data.truncated, last_bar: data.bars.at(-1),
          };
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        } else {
          actionResult = { error: 'Unknown action or API not available: ' + action };
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return { success: true, total_iterations: results.length, successful: successCount, failed: results.length - successCount, results };
}
