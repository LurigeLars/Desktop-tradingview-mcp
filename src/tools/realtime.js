import { z } from 'zod';
import { jsonResult } from './_format.js';
import { realtimeSnapshot } from '../core/realtime.js';

export function registerRealtimeTools(server) {
  server.registerTool('realtime_snapshot', {
    description: 'Read resident TradingView snapshots without symbol switching. Quote age/freshness is measured at DTV retrieval; gateway/tool turnaround after that point is not included.',
    inputSchema: {
      symbols: z.array(z.string()).optional().describe('Optional symbols/expressions. A bare ticker may resolve to one unique exchange-qualified resident symbol; formulas require exact matching. Do not combine with handles/groups.'),
      handles: z.array(z.string()).optional().describe('Optional logical worker handles from worker_status. Do not combine with symbols.'),
      groups: z.array(z.string()).optional().describe('Optional logical worker groups from worker_status. Do not combine with symbols.'),
      mode: z.enum(['fast', 'decision']).optional().describe('fast = compact current state; decision = defaults to more bars and study values.'),
      bars: z.coerce.number().int().min(1).max(100).optional().describe('Recent bars per pane (default 1 in fast, 12 in decision; max 100).'),
      include_studies: z.coerce.boolean().optional().describe('Include visible study data-window values (default false in fast, true in decision).'),
      study_filters: z.array(z.string()).optional().describe('Optional case-insensitive study-name substrings. Empty means all visible studies when include_studies=true.'),
      stale_after_ms: z.coerce.number().min(0).optional().describe('Threshold for last-trade freshness at DTV retrieval (default 5000 ms). This is not end-to-end age at ChatGPT receipt. Bid/ask freshness remains unknown without a source timestamp.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await realtimeSnapshot(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
