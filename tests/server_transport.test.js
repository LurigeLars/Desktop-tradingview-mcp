import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CDP_PORT, isTradingViewUrl } from '../src/connection.js';
import {
  resolveHttpConfig,
  startTradingViewHttpServer,
} from '../src/server/http.js';

test('project CDP default is 9222', () => {
  assert.equal(CDP_PORT, 9222);
});

test('TradingView target matching validates the parsed hostname', () => {
  assert.equal(isTradingViewUrl('https://www.tradingview.com/chart/abc'), true);
  assert.equal(isTradingViewUrl('https://tradingview.com/'), true);
  assert.equal(isTradingViewUrl('https://evil.example/tradingview.com/chart/abc'), false);
  assert.equal(isTradingViewUrl('https://tradingview.com.evil.example/chart/abc'), false);
});

test('HTTP transport refuses non-loopback binds', () => {
  assert.throws(
    () => resolveHttpConfig({ host: '0.0.0.0' }),
    /Refusing non-loopback HTTP bind host/
  );
});

test('HTTP transport exposes the same MCP tool surface without touching CDP', async () => {
  const runtime = await startTradingViewHttpServer({
    host: '127.0.0.1',
    port: 0,
    sessionIdleMs: 60_000,
  });

  const client = new Client(
    { name: 'transport-test', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(runtime.url));

  try {
    await client.connect(transport);
    const result = await client.request(
      { method: 'tools/list', params: {} },
      ListToolsResultSchema
    );

    const names = new Set(result.tools.map(tool => tool.name));
    assert.ok(result.tools.length >= 80, `expected >=80 tools, got ${result.tools.length}`);
    assert.ok(names.has('tv_health_check'));
    assert.ok(names.has('chart_get_state'));
    assert.ok(names.has('chart_set_symbol'));
    assert.ok(names.has('pine_set_source'));
    assert.ok(names.has('alert_create'));
    assert.ok(names.has('capture_screenshot'));
  } finally {
    try {
      await client.close();
    } catch {
      // Runtime close below is authoritative cleanup for this test.
    }
    await runtime.close();
  }
});
