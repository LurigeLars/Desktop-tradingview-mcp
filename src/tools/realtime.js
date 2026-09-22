import { z } from 'zod';
import { jsonResult } from './_format.js';
import { realtimeSnapshot } from '../core/realtime.js';

export function registerRealtimeTools(server) {
  server.registerTool('realtime_snapshot', {
    description: 'Read realtime snapshots from resident TradingView panes without switching symbols. Bare tickers resolve only when unambiguous; formulas/expressions require exact matching.'
    inputSchema: {
      symbols: z.array(z.string()).optional().describe('Optional symbols/expressions. A bare ticker may resolve to one unique exchange-qualified resident symbol; formulas require exact matching. Do not combine with handles/groups.'),
      handles: z.array(z.string()).optional().describe('Optional logical worker handles from worker_status. Do not combine with symbols.'),
      groups: z.array(z.string()).optional().describe('Optional logical worker groups from worker_status. Do not combine with symbols.'),
      mode: z.enum(['fast', 'decision']).optional().describe('fast = compact current state; decision = defaults to more bars and study values.'),
      bars: z.coerce.number().int().min(1).max(100).optional().describe('Recent bars per pane (default 1 in fast, 12 in decision; max 100).'),
      include_studies: z.coerce.boolean().optional().describe('Include visible study data-window values (default false in fast, true in decision).'),
      study_filters: z.array(z.string()).optional().describe('Optional case-insensitive study-name substrings. Empty means all visible studies when include_studies=true.'),
      stale_after_ms: z.coerce.number().min(0).optional().describe('Age threshold for last-trade freshness (default 5000 ms). Bid/ask freshness remains unknown without a source timestamp.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await realtimeSnapshot(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
