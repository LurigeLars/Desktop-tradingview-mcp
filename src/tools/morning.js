import { z } from 'zod';
import { jsonResult } from './_format.js';
import {
  getMorningSession,
  runMorningBrief,
  saveMorningSession,
} from '../core/morning.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export function registerMorningTools(server) {
  server.registerTool('morning_brief', {
    description: 'Collect a read-only morning-session evidence pack from already resident TradingView worker charts and configured morning rules. Does not switch symbols or mutate chart state.',
    inputSchema: {
      symbols: z.array(z.string()).optional().describe('Optional resident symbols/expressions overriding the configured selection. Do not combine with handles/groups.'),
      handles: z.array(z.string()).optional().describe('Optional resident worker handles overriding the configured selection. May be combined with groups, not symbols.'),
      groups: z.array(z.string()).optional().describe('Optional resident worker groups overriding the configured selection. May be combined with handles, not symbols.'),
      bars: z.coerce.number().int().min(1).max(100).optional().describe('Recent bars per resident chart. Defaults to morning-rules.json snapshot.bars.'),
      study_filters: z.array(z.string()).optional().describe('Optional study-name filters overriding morning-rules.json.'),
      stale_after_ms: z.coerce.number().min(0).optional().describe('Last-trade freshness threshold. Defaults to morning-rules.json.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(await runMorningBrief(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('session_save', {
    description: 'Save a completed morning brief locally for later comparison. This is a separate explicit write; morning_brief itself remains read-only.',
    inputSchema: {
      brief: z.string().min(1).max(100000).describe('The completed human-readable morning brief to save.'),
      evidence: z.record(z.string(), z.unknown()).optional().describe('Optional structured evidence, typically the morning_brief result or a compact subset of it.'),
      date: dateSchema.describe('Optional local session date YYYY-MM-DD. Defaults to today.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(saveMorningSession(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('session_get', {
    description: 'Read a saved morning brief. Without a date, returns today when available, otherwise yesterday.',
    inputSchema: {
      date: dateSchema.describe('Optional local session date YYYY-MM-DD.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return jsonResult(getMorningSession(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
