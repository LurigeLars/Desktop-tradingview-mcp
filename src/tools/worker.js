import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/worker.js';

const entrySchema = z.object({
  handle: z.string().optional().describe('Optional stable logical handle. Omit for a deterministic generated handle.'),
  symbol: z.string().describe('TradingView symbol or expression. Treated as opaque market input.'),
  timeframe: z.string().describe('TradingView timeframe/resolution for this resident entry.'),
  studies: z.array(z.string()).optional().describe('Optional visible study names required by this entry.'),
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
    try { return jsonResult(core.setUniverse(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('worker_status', {
    description: 'Read the logical realtime worker registry, capacity, groups and current physical-assignment status.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try { return jsonResult(core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
