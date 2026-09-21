import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';
import { update } from '../core/update.js';

export function registerHealthTools(server) {
  server.registerTool('tv_health_check', {
    description: 'Check CDP connection to TradingView and return current chart state.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.registerTool('tv_discover', {
    description: 'Report which known TradingView API paths are available and their methods.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tv_ui_state', {
    description: 'Get current TradingView Desktop UI state: which panels are open and which buttons are visible/enabled/disabled.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tv_launch', {
    description: 'Launch the TradingView Desktop application with Chrome DevTools Protocol enabled. This controls the application process, not chart tabs. Use tab_new/tab_switch/tab_close for multiple tabs. Auto-detects install location on Mac, Windows, and Linux, including Windows MSIX/Store installs.',
    inputSchema: {
      port: z.coerce.number().optional().describe('CDP port (default 9222)'),
      kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView application instances first (default true)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tv_close', {
    description: 'Close the entire verified MCP-managed TradingView Desktop application process tree. This is application-level shutdown, not a chart/tab close. Managed ownership is persisted and revalidated across MCP-server restarts. Never substitute tab_close, window.close(), or other UI actions when the user intends to exit TradingView Desktop. Use tab_close to close individual tabs while keeping the app running.',
    inputSchema: {
      force: z.coerce.boolean().optional().describe('Force-stop the same verified MCP-managed TradingView process tree if graceful shutdown fails (default false)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ force }) => {
    try { return jsonResult(await core.close({ force })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tv_update', {
    description: 'Update this MCP server to the latest version: git fast-forward of origin/main + npm ci when dependencies changed. Refuses non-git installs, dirty working trees, non-main branches, or diverged history. Restart the MCP server after a successful update.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try { return jsonResult(await update({})); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
