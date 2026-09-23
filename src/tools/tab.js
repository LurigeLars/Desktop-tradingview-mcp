import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.registerTool('tab_list', {
    description: 'List all open TradingView Desktop chart tabs. This does not close or exit the TradingView application.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_new', {
    description: 'Open another TradingView Desktop tab. Optionally navigate the new-tab target directly to a chart, or use the saved-layout picker workflow.',
    inputSchema: {
      layout: z.string().optional().describe('"new" for a blank new layout, or a saved layout name (substring match). Omit to leave the tab on the new-tab page.'),
      name: z.string().optional().describe('Name for the new layout (used with layout: "new"; default "New layout")'),
      symbol: z.string().optional().describe('Optional symbol/expression to load by navigating the new-tab target directly to a chart.'),
      as_chart: z.coerce.boolean().optional().describe('Navigate the new-tab target directly to /chart/ without using the saved-layout picker.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ layout, name, symbol, as_chart }) => {
    try { return jsonResult(await core.newTab({ layout, name, symbol, as_chart })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('layout_new', {
    description: 'Create a new named blank chart layout in a new TradingView Desktop tab.',
    inputSchema: {
      name: z.string().optional().describe('Layout name (default "New layout")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name }) => {
    try { return jsonResult(await core.newTab({ layout: 'new', name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_close', {
    description: 'Close only the currently active TradingView Desktop chart tab while leaving the application running. To close a specific tab, use tab_list/tab_switch first, then tab_close. This is not an application shutdown; use tv_close to exit TradingView Desktop.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await core.closeTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_switch', {
    description: 'Switch the active TradingView Desktop chart tab by index without closing any tabs.',
    inputSchema: {
      index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
