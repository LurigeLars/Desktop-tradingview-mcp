import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.registerTool('alert_create', {
    description: 'Create a price alert in the connected user\'s TradingView account for the current chart symbol via TradingView\'s alert API.',
    inputSchema: {
      condition: z.string().describe('Alert condition: "crossing", "greater_than", or "less_than"'),
      price: z.coerce.number().describe('Price level for the alert'),
      message: z.string().optional().describe('Alert message'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('alert_list', {
    description: 'List active alerts in the connected user\'s TradingView account.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.registerTool('alert_delete', {
    description: 'Delete a specific TradingView alert by id, or delete all active alerts in the connected user\'s account.',
    inputSchema: {
      alert_id: z.coerce.number().optional().describe('Alert id to delete (from alert_list)'),
      delete_all: z.coerce.boolean().optional().describe('Delete all active alerts'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
