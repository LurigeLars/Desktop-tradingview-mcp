import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CDP_PORT, isTradingViewUrl } from '../src/connection.js';
import {
  DEFAULT_SESSION_IDLE_MS,
  resolveHttpConfig,
  startTradingViewHttpServer,
} from '../src/server/http.js';
import { launchManaged, closeManaged } from '../src/core/managed-lifecycle.js';

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

test('HTTP transport defaults abandoned sessions to a five-minute idle timeout', () => {
  assert.equal(DEFAULT_SESSION_IDLE_MS, 5 * 60 * 1000);
  assert.equal(resolveHttpConfig().sessionIdleMs, 5 * 60 * 1000);
});

async function initializeTestSession(runtime, clientName = 'session-test') {
  const response = await fetch(runtime.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      },
    }),
  });
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: await response.json(),
  };
}

test('HTTP transport rejects new sessions at the configured capacity', async () => {
  const runtime = await startTradingViewHttpServer({
    host: '127.0.0.1',
    port: 0,
    maxSessions: 2,
    sessionIdleMs: 60_000,
  });

  try {
    const first = await initializeTestSession(runtime, 'session-capacity-1');
    const second = await initializeTestSession(runtime, 'session-capacity-2');

    assert.equal(first.status, 200);
    assert.ok(first.sessionId);
    assert.equal(second.status, 200);
    assert.ok(second.sessionId);
    assert.equal(runtime.sessionCount(), 2);

    const blocked = await initializeTestSession(runtime, 'session-capacity-3');
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error?.message, 'Too many active MCP sessions');
  } finally {
    await runtime.close();
  }
});

test('HTTP transport automatically reclaims abandoned sessions after the idle timeout', async () => {
  const runtime = await startTradingViewHttpServer({
    host: '127.0.0.1',
    port: 0,
    maxSessions: 2,
    sessionIdleMs: 40,
  });

  try {
    const created = await initializeTestSession(runtime, 'session-cleanup');
    assert.equal(created.status, 200);
    assert.ok(created.sessionId);
    assert.equal(runtime.sessionCount(), 1);

    await new Promise(resolvePromise => setTimeout(resolvePromise, 160));
    assert.equal(runtime.sessionCount(), 0);

    const recovered = await initializeTestSession(runtime, 'session-recovered');
    assert.equal(recovered.status, 200);
    assert.ok(recovered.sessionId);
  } finally {
    await runtime.close();
  }
});

test('HTTP transport exposes the complete tool surface with explicit safety annotations and no output schemas', async () => {
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

    for (const tool of result.tools) {
      assert.equal(tool.outputSchema, undefined, `${tool.name}: outputSchema should remain absent to avoid tool-definition/result duplication`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name}: missing readOnlyHint`);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name}: missing destructiveHint`);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name}: missing openWorldHint`);
    }

    const byName = new Map(result.tools.map(tool => [tool.name, tool]));
    assert.deepEqual(byName.get('alert_create').annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.deepEqual(byName.get('tv_close').annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(byName.get('tab_list').annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    assert.equal(byName.get('symbol_search').annotations.openWorldHint, false);
    assert.equal(byName.get('indicator_search').annotations.openWorldHint, false);
    assert.equal(byName.get('quote_get').annotations.openWorldHint, false);
    assert.equal(byName.get('batch_run').annotations.openWorldHint, false);
    assert.equal(byName.get('chart_set_symbol').annotations.openWorldHint, false);
    assert.equal(byName.get('pane_set_symbol').annotations.openWorldHint, false);

    assert.equal(byName.get('ui_evaluate').annotations.openWorldHint, true);
    assert.equal(byName.get('tv_update').annotations.openWorldHint, true);
  } finally {
    try {
      await client.close();
    } catch {
      // Runtime close below is authoritative cleanup for this test.
    }
    await runtime.close();
  }
});

test('managed lifecycle persists launch ownership and recovers it for app-level close', async () => {
  let persisted = null;
  let running = true;
  let cdpUp = true;
  const kills = [];
  const binary = 'C:\\TradingView\\TradingView.exe';

  const deps = {
    platform: 'win32',
    launch: async () => ({
      success: true,
      managed_by_mcp: true,
      platform: 'win32',
      binary,
      pid: 4321,
      cdp_port: 9222,
    }),
    close: async () => ({ success: true, closed: false, reason: 'no_mcp_managed_instance' }),
    saveState: (state) => { persisted = { version: 1, ...state }; },
    loadState: () => persisted,
    clearState: () => { persisted = null; },
    processExists: () => running,
    getProcessInfo: () => ({
      pid: 4321,
      executablePath: binary,
      commandLine: `"${binary}" --remote-debugging-port=9222`,
      startedAt: null,
    }),
    execSync: (command) => {
      kills.push(command);
      running = false;
      cdpUp = false;
    },
    processKill: () => { throw new Error('Windows path should use taskkill'); },
    cdpReachable: async () => cdpUp,
    delay: async () => {},
  };

  const launched = await launchManaged({ _deps: deps });
  assert.equal(launched.ownership_persisted, true);
  assert.equal(persisted.pid, 4321);

  const closed = await closeManaged({ force: true, _deps: deps });
  assert.equal(closed.success, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.ownership_recovered, true);
  assert.equal(persisted, null);
  assert.equal(kills.length, 1);
  assert.match(kills[0], /taskkill \/PID 4321 \/T \/F/);
});

test('managed lifecycle fails closed when persisted process identity does not match', async () => {
  let killAttempted = false;
  const persisted = {
    version: 1,
    pid: 4321,
    platform: 'win32',
    binary: 'C:\\TradingView\\TradingView.exe',
    cdpPort: 9222,
    launchedAt: Date.now(),
  };
  const deps = {
    platform: 'win32',
    close: async () => ({ success: true, closed: false, reason: 'no_mcp_managed_instance' }),
    loadState: () => persisted,
    clearState: () => {},
    processExists: () => true,
    getProcessInfo: () => ({
      pid: 4321,
      executablePath: 'C:\\Windows\\System32\\not-tradingview.exe',
      commandLine: 'not-tradingview.exe --remote-debugging-port=9222',
      startedAt: null,
    }),
    execSync: () => { killAttempted = true; },
    processKill: () => { killAttempted = true; },
    cdpReachable: async () => true,
    delay: async () => {},
  };

  const result = await closeManaged({ force: true, _deps: deps });
  assert.equal(result.success, false);
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'managed_instance_identity_mismatch');
  assert.equal(killAttempted, false);
});
