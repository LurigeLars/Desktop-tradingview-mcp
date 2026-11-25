#!/usr/bin/env node
// Benchmarks the legacy sessionful (2025) and modern stateless (2026-07-28) HTTP transports.
// Isolated: each mode runs in a fresh child on an ephemeral loopback port with a synthetic
// token, a temporary LOCALAPPDATA and tool-usage telemetry off. Only pine_analyze (offline,
// no CDP/chart/account) is called. Usage: node scripts/bench-mcp-transport.mjs [--runs 3]
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'b'.repeat(64);
const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const SOURCE = '//@version=6\nindicator("Synthetic benchmark")\nplot(ta.sma(close, 14))';
const CLIENTS = 64;
const CALLS_PER_CLIENT = 20;

if (process.argv[2] === '--serve') {
  const { startTradingViewHttpServer } = await import('../src/server/http.js');
  const runtime = await startTradingViewHttpServer({ port: 0, token: TOKEN, maxSessions: CLIENTS });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 10);
  process.on('message', async message => {
    if (message === 'mem') {
      const sampled = peak;
      global.gc();
      const { rss, heapUsed } = process.memoryUsage();
      peak = rss;
      process.send({ rss, heapUsed, peakRss: Math.max(sampled, rss), sessions: runtime.sessionCount() });
    } else if (message === 'exit') {
      clearInterval(sampler);
      await runtime.close();
      process.exit(0);
    }
  });
  process.send({ url: runtime.url });
} else {
  const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const mode of ['legacy', 'modern']) results.push({ run, mode, ...await bench(mode) });
  }
  console.log(JSON.stringify(results, null, 2));
}

async function bench(mode) {
  const home = mkdtempSync(join(tmpdir(), 'tv-mcp-bench-'));
  const child = fork(fileURLToPath(import.meta.url), ['--serve'], {
    execArgv: ['--expose-gc'],
    env: { ...process.env, LOCALAPPDATA: home, HOME: home, TV_MCP_TOOL_USAGE: 'off', TV_MCP_HTTP_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const next = () => new Promise(resolve => child.once('message', resolve));
  const mem = () => { const reply = next(); child.send('mem'); return reply; };
  try {
    const { url } = await next();
    const client = mode === 'modern' ? modernClient(url) : legacyClient(url);
    const idle = await mem();

    const one = await client.open();
    for (let i = 0; i < 50; i += 1) await one.call();
    const warm = await timed(500, () => one.call());
    await one.close();

    const cold = await timed(200, async () => { const c = await client.open(); await c.call(); await c.close(); });

    await mem();
    const started = performance.now();
    let errors = 0;
    const open = await Promise.all(Array.from({ length: CLIENTS }, () => client.open()));
    await Promise.all(open.map(async c => {
      for (let i = 0; i < CALLS_PER_CLIENT; i += 1) await c.call().catch(() => { errors += 1; });
    }));
    const elapsed = performance.now() - started;
    const loaded = await mem(); // clients still connected: retained per-client state
    await Promise.all(open.map(c => c.close()));
    const released = await mem();

    return {
      idleRssMiB: mib(idle.rss),
      warmCallMs: warm,
      coldClientCallMs: cold,
      load: {
        clients: CLIENTS,
        calls: CLIENTS * CALLS_PER_CLIENT,
        errors,
        callsPerSec: Math.round(CLIENTS * CALLS_PER_CLIENT / (elapsed / 1000)),
        peakRssMiB: mib(loaded.peakRss),
        retainedSessions: loaded.sessions,
        heapWhileConnectedMiB: mib(loaded.heapUsed),
        heapAfterCloseMiB: mib(released.heapUsed),
        rssAfterCloseMiB: mib(released.rss),
      },
    };
  } finally {
    child.send('exit');
    await new Promise(resolve => child.once('exit', resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

function headers(extra) {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra };
}

async function rpc(url, extra, body, method = 'POST') {
  const response = await fetch(url, { method, headers: headers(extra), body: body && JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const parsed = text ? JSON.parse(text) : null;
  if (parsed?.error || parsed?.result?.isError) throw new Error(text.slice(0, 200));
  return { response, parsed };
}

function call(id) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pine_analyze', arguments: { source: SOURCE } } };
}

function legacyClient(url) {
  return {
    async open() {
      const init = await rpc(url, {}, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'bench', version: '1' } },
      });
      const session = { 'mcp-session-id': init.response.headers.get('mcp-session-id'), 'mcp-protocol-version': LEGACY };
      await rpc(url, session, { jsonrpc: '2.0', method: 'notifications/initialized' });
      let id = 1;
      return {
        call: () => rpc(url, session, call(id++)),
        close: () => rpc(url, session, null, 'DELETE'),
      };
    },
  };
}

function modernClient(url) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
  let id = 1;
  return {
    async open() {
      return {
        call: () => {
          const body = call(id++);
          body.params._meta = meta;
          return rpc(url, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'pine_analyze' }, body);
        },
        close: async () => {},
      };
    },
  };
}

async function timed(count, fn) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const pick = p => Number(samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(2));
  return { n: count, p50: pick(0.5), p95: pick(0.95) };
}

function mib(bytes) {
  return Number((bytes / 1048576).toFixed(1));
}
