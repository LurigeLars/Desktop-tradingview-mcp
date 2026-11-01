import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool(
    'news_flow_get',
    'Get the authenticated TradingView News Flow snapshot for one numeric watchlist id. Returns up to 200 latest stories plus freshness coverage and streaming-channel metadata.',
    {
      watchlist_id: z.string().regex(/^[1-9][0-9]*$/)
        .describe('Numeric TradingView watchlist id, e.g. 349099896'),
      since: z.string().optional()
        .describe('Optional ISO-8601 lower freshness boundary. coverage reports whether the 200-item source window reaches it.'),
      cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_+/=-]+$/).optional()
        .describe('Opaque bounded continuation token from pagination_cursor; requires since and never changes the news-mediator host.'),
      limit: z.number().int().min(1).max(200).optional().default(200)
        .describe('Maximum returned stories after freshness filtering; source snapshot remains bounded at 200'),
    },
    async ({ watchlist_id, since, cursor, limit }) => {
      try {
        return jsonResult(await core.getWatchlistNews({ watchlist_id, since, cursor, limit }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
