import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';
import { auditWorkerTargetCandidates } from '../core/worker-provision.js';
import { isWorkerOwnedTab, status as workerStatus } from '../core/worker.js';
import { withTopologyMutationLock } from '../core/topology-lock.js';

export function registerTabTools(server) {
  server.registerTool('tab_list', {
    description: 'List current chart and shell tabs. Optionally include an all-candidate worker renderer audit and bounded physical-tab focus witness (restores selected tab). Never closes any tab.',
    inputSchema: {
      audit_worker_slot: z.coerce.number().int().min(0).max(49).optional(),
      probe_shell_tab_ids: z.array(z.string()).min(2).max(4).optional(),
      probe_target_ids: z.array(z.string()).min(2).max(8).optional(),
      inspect_shell_tab_ids: z.array(z.string()).min(1).max(4).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({audit_worker_slot,probe_shell_tab_ids,probe_target_ids,inspect_shell_tab_ids} = {}) => {
    try {
      const snapshot = await core.list();
      if (audit_worker_slot !== undefined) {
        snapshot.worker_target_audit = await auditWorkerTargetCandidates({slot:audit_worker_slot});
      }
      if (inspect_shell_tab_ids) {
        snapshot.shell_tab_details = await core.inspectShellTabMetadata({shell_tab_ids:inspect_shell_tab_ids});
      }
      if (probe_shell_tab_ids || probe_target_ids) {
        if (!probe_shell_tab_ids || !probe_target_ids) {
          throw new Error('Both probe_shell_tab_ids and probe_target_ids are required.');
        }
        snapshot.shell_renderer_probe = await withTopologyMutationLock('tab_list_probe',()=> 
          core.probeShellRendererCorrespondence({
            shell_tab_ids:probe_shell_tab_ids,target_ids:probe_target_ids,
          })
        );
      }
      return jsonResult(snapshot);
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('tab_probe_identity', {
    description: 'Read-only chart-state shell/renderer correspondence probe. Visually cycles only explicitly named physical tabs and restores the original active tab. Reports unverified mapping if focus/visibility evidence is ambiguous; never closes tabs.',
    inputSchema: {
      shell_tab_ids: z.array(z.string()).min(2).max(4),
      target_ids: z.array(z.string()).min(2).max(8),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({shell_tab_ids,target_ids}) => {
    try {
      return jsonResult(await withTopologyMutationLock('tab_probe_identity', () =>
        core.probeShellRendererCorrespondence({shell_tab_ids,target_ids})
      ));
    } catch(err){return jsonResult({success:false,error:err.message},true);}
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
    description: 'Open another TradingView Desktop tab. Named saved layouts are resolved through TradingView saved-chart API, not the fragile new-tab picker. Duplicate instances of the same chart_id are supported.',
    inputSchema: {
      layout: z.string().optional().describe('"new" for a blank new layout, or a saved layout name (substring match). Omit to leave the tab on the new-tab page.'),
      name: z.string().optional().describe('Name for the new layout (used with layout: "new"; default "New layout")'),
      symbol: z.string().optional().describe('Optional symbol/expression to load by navigating the new-tab target directly to a chart.'),
      as_chart: z.coerce.boolean().optional().describe('Navigate the new-tab target directly to /chart/ without using the saved-layout picker.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ layout, name, symbol, as_chart }) => {
    try {
      return jsonResult(await withTopologyMutationLock('tab_new', async () => {
        const requested = String(layout || '').trim();
        if (requested && requested.toLowerCase() !== 'new' && !symbol && !as_chart) {
          // The Desktop landing-page layout picker can be blank even when the
          // user's saved charts exist. Resolve the exact saved chart identity
          // *before* creating a new physical Desktop tab, so failures leave
          // no orphan new-tab shell behind.
          const { layoutList, resolveSavedLayout } = await import('../core/ui.js');
          const saved = await layoutList();
          if (saved.error) throw new Error('Saved chart lookup failed: ' + saved.error);
          const selected = resolveSavedLayout(saved.layouts, requested);
          if (!selected.chart_id) throw new Error('Saved layout has no chart URL token: ' + selected.name);
          const opened = await core.newTab({ chart_id: selected.chart_id });
          return {
            ...opened,
            requested_layout: selected.name,
            saved_layout_id: selected.id,
            requested_chart_id: selected.chart_id,
          };
        }
        return core.newTab({ layout, name, symbol, as_chart });
      }));
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
          if (!current) throw new Error('Shell tab missing; refresh tab_list.');
          const expected = expected_layout_name || current.layout_name;
          if (!expected) {
            throw new Error('React layout name is unavailable. Supply expected_layout_name from the visible shell tab label.');
          }
          const state = workerStatus();
          const workerNames = (state.worker_tabs || []).map(tab => tab.layout_name).filter(Boolean);
          if (workerNames.includes(expected) || /^DTV (?:Market|Worker)\b/i.test(expected)) {
            throw new Error('Refusing to close a DTV worker-owned layout.');
          }
          return core.closeShellTabById({
            shell_tab_id, expected_layout_name: expected,
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
