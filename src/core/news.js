/**
 * TradingView News Flow access through the authenticated Desktop page context.
 *
 * This deliberately uses TradingView's own news-mediator endpoint discovered
 * from the News Flow application bundle. The endpoint host is fixed and
 * validated; callers only supply a numeric watchlist id and an optional
 * freshness boundary.
 */
import { evaluateAsync } from '../connection.js';

const NEWS_MEDIATOR_HOST = 'news-mediator.tradingview.com';
const MAX_SOURCE_ITEMS = 200;

export function normalizeWatchlistId(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error('watchlist_id must be a positive numeric TradingView watchlist id');
  }
  return text;
}

export function normalizeSince(value) {
  if (value == null || String(value).trim() === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error('since must be an ISO-8601 timestamp');
  return Math.floor(ms / 1000);
}

function isoFromUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString().replace('.000Z', 'Z');
}

function compactItem(item) {
  const provider = item?.provider && typeof item.provider === 'object'
    ? {
        id: item.provider.id ?? null,
        name: item.provider.name ?? null,
      }
    : null;

  const related = Array.isArray(item?.relatedSymbols)
    ? item.relatedSymbols
      .filter(row => row && typeof row === 'object' && typeof row.symbol === 'string')
      .map(row => ({
        symbol: row.symbol,
        logoid: row.logoid ?? row.logo?.logoid ?? null,
      }))
    : [];

  return {
    id: item?.id ?? null,
    title: item?.title ?? null,
    published: Number.isFinite(Number(item?.published)) ? Number(item.published) : null,
    published_at: isoFromUnix(item?.published),
    urgency: item?.urgency ?? null,
    provider,
    related_symbols: related,
    story_path: item?.storyPath ?? null,
    link: item?.link ?? null,
    permission: item?.permission ?? null,
    paywall: item?.paywall ?? null,
  };
}

export function normalizeNewsFlowResponse(raw, { watchlistId, since = null, limit = MAX_SOURCE_ITEMS } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('TradingView News Flow returned no payload');
  if (raw.error) throw new Error(String(raw.error));

  const sourceItems = Array.isArray(raw.items) ? raw.items.map(compactItem) : [];
  const validPublished = sourceItems
    .map(item => item.published)
    .filter(value => Number.isFinite(value));
  const latest = validPublished.length ? Math.max(...validPublished) : null;
  const oldest = validPublished.length ? Math.min(...validPublished) : null;

  const sinceUnix = normalizeSince(since);
  const freshItems = sinceUnix == null
    ? sourceItems
    : sourceItems.filter(item => Number.isFinite(item.published) && item.published >= sinceUnix);

  const boundedLimit = Math.max(1, Math.min(MAX_SOURCE_ITEMS, Number(limit) || MAX_SOURCE_ITEMS));
  const returned = freshItems.slice(0, boundedLimit);

  // News Flow currently returns at most 200 items. If a caller asks for a
  // cursor boundary older than the oldest item while the source page is full,
  // the snapshot cannot prove complete coverage of that interval.
  const boundaryReached = sinceUnix == null
    ? null
    : (sourceItems.length < MAX_SOURCE_ITEMS || oldest == null || oldest <= sinceUnix);

  return {
    success: true,
    watchlist_id: String(watchlistId),
    source_count: sourceItems.length,
    returned_count: returned.length,
    source_latest_at: isoFromUnix(latest),
    source_oldest_at: isoFromUnix(oldest),
    since: sinceUnix == null ? null : isoFromUnix(sinceUnix),
    freshness_boundary_reached: boundaryReached,
    source_window_truncated: sinceUnix != null && boundaryReached === false,
    result_truncated: freshItems.length > boundedLimit,
    pagination_cursor: raw.pagination?.cursor ?? null,
    streaming_channel: raw.streaming?.channel ?? null,
    items: returned,
  };
}

export async function getWatchlistNews({ watchlist_id, since = null, limit = MAX_SOURCE_ITEMS, _deps } = {}) {
  const watchlistId = normalizeWatchlistId(watchlist_id);
  const sinceUnix = normalizeSince(since);
  const boundedLimit = Math.max(1, Math.min(MAX_SOURCE_ITEMS, Number(limit) || MAX_SOURCE_ITEMS));
  const runEvaluateAsync = _deps?.evaluateAsync || evaluateAsync;

  const raw = await runEvaluateAsync(`
    (async function() {
      try {
        var base = String(window.NEWS_MEDIATOR_URL || '');
        var parsed = new URL(base);
        if (parsed.protocol !== 'https:' || parsed.hostname !== ${JSON.stringify(NEWS_MEDIATOR_HOST)}) {
          return { error: 'Unexpected TradingView news mediator host: ' + base };
        }

        var params = new URLSearchParams();
        params.append('filter', 'lang:en');
        params.append('filter', 'watchlist:' + ${JSON.stringify(watchlistId)});
        params.set('client', 'screener');
        params.set('streaming', 'true');
        params.set('user_prostatus', window.user && window.user.is_pro ? 'pro' : 'non_pro');

        var response = await fetch(base.replace(/\\/$/, '') + '/news-flow/v2/news?' + params.toString(), {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        var text = await response.text();
        if (!response.ok) {
          return { error: 'TradingView News Flow HTTP ' + response.status + ': ' + text.slice(0, 300) };
        }
        try { return JSON.parse(text); }
        catch (e) { return { error: 'TradingView News Flow returned invalid JSON' }; }
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    })()
  `);

  return normalizeNewsFlowResponse(raw, {
    watchlistId,
    since: sinceUnix == null ? null : isoFromUnix(sinceUnix),
    limit: boundedLimit,
  });
}
