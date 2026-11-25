import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
    allow_trade_alert_watchlist: z.boolean().optional().describe('Set true only when the user explicitly asks to change the watchlist Trade Alert watches.'),
  }, async ({ symbol, allow_trade_alert_watchlist }) => {
    try { return jsonResult(await core.add({ symbol, allow_trade_alert_watchlist })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_add_bulk', 'Add multiple symbols to the TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to add (e.g., ["AAPL", "ES1!", "NYMEX:CL1!"])'),
    allow_trade_alert_watchlist: z.boolean().optional().describe('Set true only when the user explicitly asks to change the watchlist Trade Alert watches.'),
  }, async ({ symbols, allow_trade_alert_watchlist }) => {
    try { return jsonResult(await core.addBulk({ symbols, allow_trade_alert_watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_remove', 'Remove one or more symbols from the active TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to remove — bare (AAPL) or full (NASDAQ:AAPL)'),
    allow_trade_alert_watchlist: z.boolean().optional().describe('Set true only when the user explicitly asks to change the watchlist Trade Alert watches.'),
  }, async ({ symbols, allow_trade_alert_watchlist }) => {
    try { return jsonResult(await core.remove({ symbols, allow_trade_alert_watchlist })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
