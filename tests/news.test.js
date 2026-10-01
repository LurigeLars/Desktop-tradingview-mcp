import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWatchlistNews,
  normalizeNewsFlowResponse,
  normalizeWatchlistId,
} from '../src/core/news.js';

test('watchlist ids are numeric and cannot inject a URL/query', () => {
  assert.equal(normalizeWatchlistId('349099896'), '349099896');
  assert.throws(() => normalizeWatchlistId('349099896&filter=symbol:NASDAQ:NVDA'), /positive numeric/);
  assert.throws(() => normalizeWatchlistId('https://evil.example'), /positive numeric/);
});

test('news flow applies since boundary and reports when the 200-item source window is insufficient', () => {
  const newest = 1_790_818_000;
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `story-${i}`,
    title: `Story ${i}`,
    published: newest - i * 60,
    provider: { id: 'wire', name: 'Wire' },
    relatedSymbols: [{ symbol: 'NASDAQ:NVDA', logoid: 'nvidia' }],
  }));

  const result = normalizeNewsFlowResponse(
    { items, streaming: { channel: 'abc' }, pagination: { cursor: 'cursor-1' } },
    {
      watchlistId: '349099896',
      since: new Date((newest - 300) * 1000).toISOString(),
      limit: 200,
    },
  );

  assert.equal(result.source_count, 200);
  assert.equal(result.returned_count, 6);
  assert.equal(result.freshness_boundary_reached, true);
  assert.equal(result.source_window_truncated, false);
  assert.equal(result.streaming_channel, 'abc');
  assert.equal(result.pagination_cursor, 'cursor-1');
  assert.deepEqual(result.items[0].related_symbols, [{ symbol: 'NASDAQ:NVDA', logoid: 'nvidia' }]);

  const tooOld = normalizeNewsFlowResponse(
    { items },
    {
      watchlistId: '349099896',
      since: new Date((newest - 24 * 3600) * 1000).toISOString(),
      limit: 200,
    },
  );
  assert.equal(tooOld.freshness_boundary_reached, false);
  assert.equal(tooOld.source_window_truncated, true);
});

test('news flow page-context request is fixed to TradingView mediator and authenticated watchlist filter', async () => {
  let expression = null;
  const raw = {
    items: [{
      id: 'story-1',
      title: 'Example',
      published: 1_790_818_000,
      urgency: 2,
      provider: { id: 'reuters', name: 'Reuters' },
      relatedSymbols: [{ symbol: 'NASDAQ:NVDA', logoid: 'nvidia' }],
      storyPath: '/news/story-1/',
      paywall: false,
    }],
    streaming: { channel: 'stream-1' },
    pagination: { cursor: 'cursor-1' },
  };

  const result = await getWatchlistNews({
    watchlist_id: '349099896',
    since: '2026-09-30T23:00:00Z',
    limit: 50,
    _deps: {
      evaluateAsync: async value => {
        expression = value;
        return raw;
      },
    },
  });

  assert.ok(expression.includes('news-mediator.tradingview.com'));
  assert.match(expression, /watchlist:/);
  assert.match(expression, /349099896/);
  assert.match(expression, /credentials: 'include'/);
  assert.equal(result.success, true);
  assert.equal(result.watchlist_id, '349099896');
  assert.equal(result.streaming_channel, 'stream-1');
  assert.equal(result.items[0].provider.name, 'Reuters');
});
