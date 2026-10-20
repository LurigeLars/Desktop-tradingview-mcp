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

  server.registerTool('tab_attach', {
    description: 'Attach to an exact live CDP target_id from tab_list (supports duplicate layouts), or to a unique chart_id. Rediscover IDs after TradingView restart. Worker tabs are protected.',
    inputSchema: {
      chart_id: z.string().optional().describe('Unique chart URL token; use target_id instead for duplicate layouts.'),
      target_id: z.string().optional().describe('Exact live CDP target from a fresh tab_list, including duplicate layouts.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chart_id, target_id }) => {
    try {
      return jsonResult(await withTopologyMutationLock('tab_attach', async () => {
        if (Boolean(chart_id) === Boolean(target_id)) {
          throw new Error('Supply exactly one of target_id or chart_id.');
        }
        const live = await core.list();
        const match = target_id
          ? live.tabs.filter(tab => tab.is_chart && tab.id === target_id)
          : live.tabs.filter(tab => tab.is_chart && tab.chart_id === chart_id);
        if (match.length !== 1) {
          throw new Error('No unique open chart matched. Refresh tab_list and use exact target_id.');
        }
        if (isWorkerOwnedTab(match[0], workerStatus())) {
          throw new Error('Refusing to attach interactive commands to a DTV worker-owned layout.');
        }
        return target_id
          ? core.attachChartTarget({ target_id })
          : core.attachChart({ chart_id });
      }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
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
      target_id: z.string().optional().describe('Exact live CDP target ID from tab_list, for uniquely mappable shell tabs.'),
      shell_tab_id: z.string().optional().describe('Physical Desktop shell_tab_id from a fresh tab_list. Supports duplicate layouts.'),
      expected_layout_name: z.string().optional().describe('Expected layout name from shell_tabs to prevent stale-identity mistakes.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ target_id, shell_tab_id, expected_layout_name }) => {
    try {
      return jsonResult(await withTopologyMutationLock('tab_close', async () => {
        if (target_id && shell_tab_id) throw new Error('Use either target_id or shell_tab_id, not both.');
        const tabs = await core.list();
        if (shell_tab_id) {
          const current = tabs.shell_tabs.find(tab => tab.shell_tab_id === shell_tab_id);
          if (!current?.layout_name) throw new Error('Shell tab missing or unidentified; refresh tab_list.');
          const state = workerStatus();
          const workerNames = (state.worker_tabs || []).map(tab => tab.layout_name).filter(Boolean);
          if (workerNames.includes(current.layout_name) || /^DTV (?:Market|Worker)\b/i.test(current.layout_name)) {
            throw new Error('Refusing to close a DTV worker-owned layout.');
          }
          return core.closeShellTabById({
            shell_tab_id, expected_layout_name: expected_layout_name || current.layout_name,
            protected_layout_names: workerNames,
          });
        }
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
    description: 'Switch one physical Desktop tab by shell_tab_id (works with duplicate layouts), or by legacy CDP list index. Refresh tab_list after restart.',
    inputSchema: {
      index: z.coerce.number().optional().describe('Legacy CDP tab index (0-based).'),
      shell_tab_id: z.string().optional().describe('Exact physical Desktop shell_tab_id from tab_list.'),
      expected_layout_name: z.string().optional().describe('Expected layout name for identity validation.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ index, shell_tab_id, expected_layout_name }) => {
    try {
      if (Boolean(shell_tab_id) === (index !== undefined && index !== null)) {
        throw new Error('Supply exactly one of index or shell_tab_id.');
      }
      return jsonResult(await withTopologyMutationLock(
        'tab_switch',
        () => shell_tab_id
          ? core.switchShellTab({shell_tab_id, expected_layout_name})
          : core.switchTab({ index }),
      ));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
