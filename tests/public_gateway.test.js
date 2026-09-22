import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  isAllowedPath,
  buildUpstreamHeaders,
} from '../public/gateway/gateway.mjs';
import {
  parseAllowedTools,
  checkRequest,
  compactToolDefinition,
  rewriteResponse,
} from '../public/gateway/policy.mjs';

const baseEnv = {
  ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  ACCESS_AUD: 'audience-id',
  ACCESS_ALLOWED_EMAILS: 'owner@example.com',
  UPSTREAM_HOST: 'host.docker.internal',
  UPSTREAM_PORT: '8765',
  UPSTREAM_PATH: '/mcp',
  UPSTREAM_HOST_HEADER: 'localhost',
};

describe('public gateway configuration', () => {
  it('requires Cloudflare Access configuration and an explicit email allowlist', () => {
    assert.throws(() => loadConfig({ ...baseEnv, ACCESS_AUD: '' }), /ACCESS_AUD is required/);
    assert.throws(() => loadConfig({ ...baseEnv, ACCESS_ALLOWED_EMAILS: '' }), /ACCESS_ALLOWED_EMAILS/);
  });

  it('accepts only the MCP path', () => {
    assert.equal(isAllowedPath('/mcp'), true);
    assert.equal(isAllowedPath('/mcp?x=1'), true);
    assert.equal(isAllowedPath('/'), false);
    assert.equal(isAllowedPath('/healthz'), false);
    assert.equal(isAllowedPath('/mcp/extra'), false);
  });

  it('connects through host.docker.internal while preserving a loopback Host header upstream', () => {
    const config = loadConfig(baseEnv);
    const headers = buildUpstreamHeaders({
      host: 'public.example.com',
      authorization: 'Bearer secret',
      cookie: 'secret=1',
      'cf-access-jwt-assertion': 'jwt',
      'cf-connecting-ip': '203.0.113.1',
      'mcp-session-id': 'session-1',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }, config, 12);

    assert.equal(config.upstreamHost, 'host.docker.internal');
    assert.equal(headers.host, 'localhost:8765');
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['cf-access-jwt-assertion'], undefined);
    assert.equal(headers['cf-connecting-ip'], undefined);
    assert.equal(headers['mcp-session-id'], 'session-1');
    assert.equal(headers['content-length'], '12');
  });

  it('preserves the full 86-tool TradingView surface by default', () => {
    const allowed = parseAllowedTools();
    assert.equal(allowed.size, 86);
    assert.equal(allowed.has('chart_get_state'), true);
    assert.equal(allowed.has('pine_set_source'), true);
    assert.equal(allowed.has('replay_start'), true);
    assert.equal(allowed.has('draw_shape'), true);
    assert.equal(allowed.has('ui_evaluate'), true);
    assert.equal(allowed.has('tv_update'), true);
    assert.equal(allowed.has('realtime_snapshot'), true);
  });

  it('supports an explicit operator-controlled core profile', () => {
    const allowed = parseAllowedTools('core');
    assert.equal(allowed.size, 44);
    assert.equal(allowed.has('chart_get_state'), true);
    assert.equal(allowed.has('data_get_ohlcv'), true);
    assert.equal(allowed.has('pine_set_source'), false);
    assert.equal(allowed.has('replay_start'), false);
    assert.match(
      checkRequest({ method: 'tools/call', params: { name: 'ui_evaluate' } }, allowed).error,
      /not available/
    );
  });

  it('supports an explicit full profile', () => {
    const allowed = parseAllowedTools('full');
    assert.equal(allowed.size, 86);
    assert.equal(allowed.has('ui_evaluate'), true);
    assert.equal(allowed.has('tv_update'), true);
  });

  it('still supports a stricter ALLOWED_TOOLS override', () => {
    const allowed = parseAllowedTools('chart_get_state,tab_list');
    assert.equal(allowed.size, 2);
    assert.match(
      checkRequest({ method: 'tools/call', params: { name: 'ui_evaluate' } }, allowed).error,
      /not available/
    );
  });

  it('compacts tool descriptors without changing the callable schema shape', () => {
    const raw = {
      name: 'chart_set_symbol',
      description: 'Change the current chart symbol to a TradingView symbol. This second sentence is intentionally redundant and should not be needed in the model context.',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'TradingView symbol including exchange prefix, for example NASDAQ:NVDA. Extra prose follows only to increase descriptor size.',
          },
        },
        required: ['symbol'],
      },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: false, openWorldHint: false },
    };

    const compact = compactToolDefinition(raw);
    assert.equal(compact.name, raw.name);
    assert.equal(compact.inputSchema.type, 'object');
    assert.deepEqual(compact.inputSchema.required, ['symbol']);
    assert.equal(compact.inputSchema.$schema, undefined);
    assert.equal(compact.outputSchema, undefined);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(raw).length);
  });

  it('compacts the full listed surface and replaces initialize instructions like firecrawl-local', () => {
    const allowed = parseAllowedTools();
    const response = rewriteResponse({
      result: {
        serverInfo: { name: 'tradingview', version: '2.0.0' },
        instructions: 'very long upstream instructions',
        tools: [
          {
            name: 'chart_get_state',
            description: 'Read the current chart state. Additional redundant sentence.',
            inputSchema: { type: 'object', properties: {} },
          },
          { name: 'ui_evaluate', inputSchema: { type: 'object' } },
          { name: 'tv_update', inputSchema: { type: 'object' } },
        ],
      },
    }, { allowedTools: allowed });

    assert.deepEqual(
      response.result.tools.map(tool => tool.name),
      ['chart_get_state', 'ui_evaluate', 'tv_update']
    );
    assert.match(response.result.instructions, /TradingView Desktop MCP/);
  });
});
