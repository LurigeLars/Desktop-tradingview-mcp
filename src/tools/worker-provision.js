import { z } from 'zod';
import { jsonResult } from './_format.js';
import { provisionWorker, rebindPersistentWorkers, auditWorkerTargetCandidates } from '../core/worker-provision.js';
import { withTopologyMutationLock } from '../core/topology-lock.js';

export function registerWorkerProvisionTools(server) {
  server.registerTool('worker_target_audit', {
    description: 'Read-only audit of all chart renderer candidates for one registered worker slot, including mismatch/orphan candidates by identical chart ID. Never closes a chart.',
    inputSchema: {
      slot: z.coerce.number().int().min(0).max(49).describe('Registered worker slot, zero based.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({slot}) => {
    try {return jsonResult(await auditWorkerTargetCandidates({slot}));}
    catch(err){return jsonResult({success:false,error:err.message},true);}
  });

  server.registerTool('worker_rebind', {
    description: 'Verify all five persisted worker layouts by exact chart IDs and live pane signatures, then refresh rotated CDP IDs WITHOUT opening, closing, saving or changing any chart. Dry-run by default.',
    inputSchema: {
      dry_run: z.coerce.boolean().optional().describe('Default true. Set false to atomically refresh verified worker target IDs in local state.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dry_run } = {}) => {
    try {
      if (dry_run !== false) return jsonResult(await rebindPersistentWorkers({ dry_run: true }));
      return jsonResult(await withTopologyMutationLock('worker_rebind', () =>
        rebindPersistentWorkers({ dry_run: false })
      ));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('worker_provision', {
    description: 'Reconcile logical worker entries into DTV-owned TradingView tabs/panes using bounded resumable phases. A call may open/recover a worker tab or configure a limited number of panes; repeat until complete=true.',
    inputSchema: {
      max_tabs: z.coerce.number().int().min(1).max(8).optional().describe('Maximum topology tabs considered in this call (default 1). Incomplete tab work stops the call for remote-safety.'),
      max_panes: z.coerce.number().int().min(1).max(8).optional().describe('Maximum mismatching panes to configure in one call (default 1). Increase only after latency is validated.'),
      dry_run: z.coerce.boolean().optional().describe('Return pending topology without changing TradingView or worker assignments.'),
      force: z.coerce.boolean().optional().describe('Reconfigure worker-owned tabs even when recorded assignments look complete.'),
      adopt_single_existing: z.coerce.boolean().optional().describe('Explicitly adopt the sole existing non-worker TradingView chart as worker slot 0. Useful when consuming the full connection budget.'),
      layout_prefix: z.string().optional().describe('Optional technical name prefix for DTV-owned saved layouts.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      if (args?.dry_run) return jsonResult(await provisionWorker(args));
      return jsonResult(await withTopologyMutationLock('worker_provision', () => provisionWorker(args)));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
