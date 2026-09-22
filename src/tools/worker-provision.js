import { z } from 'zod';
import { jsonResult } from './_format.js';
import { provisionWorker } from '../core/worker-provision.js';

export function registerWorkerProvisionTools(server) {
  server.registerTool('worker_provision', {
    description: 'Reconcile logical worker entries into DTV-owned TradingView tabs/panes. Resumable: provisions one tab per call by default.',
    inputSchema: {
      max_tabs: z.coerce.number().int().min(1).max(8).optional().describe('Maximum worker tabs to provision in this call (default 1).'),
      dry_run: z.coerce.boolean().optional().describe('Return pending topology without changing TradingView or worker assignments.'),
      force: z.coerce.boolean().optional().describe('Reconfigure worker-owned tabs even when recorded assignments look complete.'),
      layout_prefix: z.string().optional().describe('Optional technical name prefix for DTV-owned saved layouts.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await provisionWorker(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
