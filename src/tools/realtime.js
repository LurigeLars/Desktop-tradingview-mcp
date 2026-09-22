import { z } from 'zod';
import { jsonResult } from './_format.js';
import { realtimeSnapshot } from '../core/realtime.js';

export function registerRealtimeTools(server) {
  server.registerTool('realtime_snapshot', {
    description: 'Read realtime snapshots from all currently open TradingView chart panes without switching visible symbols. Optionally filter by exact resolved symbols/expressions.',
    inputSchema: {
      symbols: z.array(z.string()).optional().describe('Optional exact resolved TradingView symbols/expressions to return. Omit to read all open chart panes.'),
      mode: z.enum(['fast', 'decision']).optional().describe('fast = compact current state; decision = defaults to more bars and study values.'),
      bars: z.coerce.number().int().min(1).max(100).optional().describe('Recent bars per pane (default 1 in fast, 12 in decision; max 100).'),
      include_studies: z.coerce.boolean().optional().describe('Include visible study data-window values (default false in fast, true in decision).'),
      study_filters: z.array(z.string()).optional().describe('Optional case-insensitive study-name substrings. Empty means all visible studies when include_studies=true.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await realtimeSnapshot(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
