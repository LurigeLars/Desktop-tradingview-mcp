import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  isAllowedPath,
  buildUpstreamHeaders,
} from '../public/gateway/gateway.mjs';

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
});
