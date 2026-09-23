import { z } from 'zod';
import { jsonResult } from './_format.js';
import { provisionWorker } from '../core/worker-provision.js';

export function registerWorkerProvisionTools(server) {
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
    try { return jsonResult(await provisionWorker(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
