import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/worker.js';
// The legacy six-tab dynamic provisioner is intentionally disabled.

import { rotateWorkerSnapshot, recoverRotatingPane } from '../core/rotating-worker.js';
import { topologyMutationLockStatus, withTopologyMutationLock } from '../core/topology-lock.js';
import { workerUsageReport } from '../core/worker-usage.js';

const studySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const entrySchema = z.object({
  handle: z.string().optional().describe('Optional stable logical handle. Omit for a deterministic generated handle.'),
  symbol: z.string().describe('TradingView symbol or expression. Treated as opaque market input.'),
  timeframe: z.string().describe('TradingView timeframe/resolution for this resident entry.'),
  studies: z.array(studySchema).optional().describe('Optional studies. Use a name string or {name, inputs} for parameterized instances.'),
  groups: z.array(z.string()).optional().describe('Optional logical groups/trade contexts containing this entry.'),
});

export function registerWorkerTools(server) {
  server.registerTool('worker_set_universe', {
    description: 'Configure the logical realtime worker universe. Deduplicates equivalent symbol/timeframe/study entries and persists stable handles/groups locally.',
    inputSchema: {
      entries: z.array(entrySchema).describe('Desired logical resident entries.'),
      replace: z.coerce.boolean().optional().describe('Replace the current logical universe (default true). False appends/merges.'),
      capacity: z.coerce.number().int().positive().optional().describe('Connection budget. Defaults to TV_WORKER_MAX_CONNECTIONS or 50.'),
      reserve_slots: z.coerce.number().int().min(0).optional().describe('Keep this many connection slots unused for ad-hoc/event work.'),
      max_charts_per_tab: z.coerce.number().int().min(1).max(8).optional().describe('Maximum resident charts per TradingView tab (default 8).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await withTopologyMutationLock('worker_set_universe', () => core.setUniverse(args))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('worker_rotate_snapshot', {
    description: 'Reversibly sample exactly one missing qualified symbol inside the fifth EXISTING DTV worker tab. No new tabs/windows, no persistent worker universe change. The lower-priority tactical pane is restored before reply. This is never an execution-grade broker quote.',
    inputSchema: {
      symbol: z.string().describe('One verified, exchange-qualified nonresident symbol.'),
      dry_run: z.coerce.boolean().optional().describe('Plan and verify original worker layout without mutation.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async args => {
    try {
      return jsonResult(await withTopologyMutationLock('worker_rotate_snapshot',
        () => rotateWorkerSnapshot(args), { timeoutMs: 60_000 }));
    } catch(err) {
      return jsonResult({success:false,error_code:'ROTATION_REJECTED',
        message:String(err?.message || 'failed').slice(0,240), execution_quote:false},true);
    }
  });

  server.registerTool('worker_rotation_recover', {
    description: 'Verify or restore a journaled in-place worker rotation after interruption. Never opens a tab or changes unrelated panes.',
    inputSchema: { dry_run: z.coerce.boolean().optional() },
    annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, async args => {
    try { return jsonResult(await withTopologyMutationLock('worker_rotation_recover',
      () => recoverRotatingPane(args), { timeoutMs: 60_000 })); }
    catch(err) { return jsonResult({success:false,error_code:'RECOVERY_REJECTED',
      message:String(err?.message || 'failed').slice(0,240)},true); }
  });

  server.registerTool('worker_dynamic_ensure', {
    description: 'Deprecated: opening a sixth TradingView Desktop worker window is disabled. Use worker_rotate_snapshot to temporarily sample an existing pane.',
    inputSchema: {
      symbols: z.array(z.string()).max(12),
      dry_run: z.coerce.boolean().optional(),
      max_panes: z.coerce.number().int().min(1).max(2).optional(),
    },
    annotations: {readOnlyHint: true, destructiveHint: false,
      idempotentHint: true, openWorldHint: false},
  }, async () => jsonResult({success:false,error_code:'SIXTH_TAB_DISABLED',
      message:'No new TradingView Desktop windows allowed; use worker_rotate_snapshot instead.',
      opened_tabs:0,execution_quote:false},true));


  server.registerTool('worker_usage', {
    description: 'Read 14-day bounded evidence of per-handle successful resident pane reads. Consumer names are caller-declared, not authenticated. Zero reads are not evidence of no future need.',
    inputSchema: {},
    annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false},
  }, async () => {
    try { return jsonResult(workerUsageReport()); }
    catch (err) { return jsonResult({success:false,error:err.message},true); }
  });

  server.registerTool('worker_status', {
    description: 'Read the logical realtime worker registry, capacity, groups and current physical-assignment status.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return jsonResult({ ...core.status(), mutation_lock: topologyMutationLockStatus() }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
