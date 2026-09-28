import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';
import { isWorkerOwnedTab, status as workerStatus } from '../core/worker.js';
import { withTopologyMutationLock } from '../core/topology-lock.js';

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
    try {
      return jsonResult(await withTopologyMutationLock(
        'tab_new',
        () => core.newTab({ layout, name, symbol, as_chart }),
      ));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('layout_new', {
    description: 'Create a new named blank chart layout in a new TradingView Desktop tab.',
    inputSchema: {
      name: z.string().optional().describe('Layout name (default "New layout")'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name }) => {
    try {
      return jsonResult(await withTopologyMutationLock(
        'layout_new',
        () => core.newTab({ layout: 'new', name }),
      ));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_close', {
    description: 'Close one non-worker TradingView Desktop tab. In multi-tab runtimes target_id is required so concurrent MCP clients cannot close whichever tab happens to be active. DTV-owned worker tabs are protected; worker lifecycle changes must go through worker_provision.',
    inputSchema: {
      target_id: z.string().optional().describe('Exact CDP target ID from tab_list. Required when more than one tab is open.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ target_id }) => {
    try {
      return jsonResult(await withTopologyMutationLock('tab_close', async () => {
        const tabs = await core.list();
        let target = null;

        if (target_id) {
          target = tabs.tabs.find(tab => String(tab.id) === String(target_id)) || null;
          if (!target) throw new Error('tab_close target_id is not present in tab_list.');
        } else {
          if (tabs.tab_count !== 1) {
            throw new Error(
              'tab_close requires target_id when multiple TradingView Desktop tabs are open. ' +
              'Use tab_list and pass the exact target_id; do not rely on shared active-tab state.'
            );
          }
          target = tabs.tabs[0] || null;
        }

        if (isWorkerOwnedTab(target, workerStatus())) {
          throw new Error(
            'Refusing to close a DTV-owned worker tab through tab_close. ' +
            'Worker tabs are server-owned; use worker_provision/reconciliation instead.'
          );
        }

        return core.closeTabByTargetId({ target_id: target.id });
      }));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_switch', {
    description: 'Switch the active TradingView Desktop chart tab by index without closing any tabs.',
    inputSchema: {
      index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ index }) => {
    try {
      return jsonResult(await withTopologyMutationLock(
        'tab_switch',
        () => core.switchTab({ index }),
      ));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
