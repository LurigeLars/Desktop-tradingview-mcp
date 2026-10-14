/**
 * Direct Windows Scheduled Task entrypoint for TradingView MCP HTTP.
 * Task Scheduler owns this Node process instead of an ephemeral pythonw
 * launcher that leaves a detached child. Stop-ScheduledTask stops the
 * actual listener rather than only the parent launcher.
 * No TradingView Desktop/CDP lifecycle operation occurs here.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMain } from '../../src/server/http.js';

const ALLOWED_CDP_PORTS = new Set([9222, 9333]);

export function parseManagedCdpPort(args) {
  if (!Array.isArray(args) || args.length !== 1) {
    throw new Error('Expected exactly one --cdp-port=9222 or --cdp-port=9333 argument');
  }
  const match = /^--cdp-port=(\d{4})$/.exec(args[0]);
  const port = match ? Number(match[1]) : NaN;
  if (!ALLOWED_CDP_PORTS.has(port)) {
    throw new Error('Unrecognized TradingView CDP port; allowlisted 9222/9333 only');
  }
  return port;
}

export async function runManagedHttp(args) {
  const cdpPort = parseManagedCdpPort(args);
  process.env.TV_CDP_PORT = String(cdpPort);
  process.env.TV_MCP_HTTP_HOST = '127.0.0.1';
  process.env.TV_MCP_HTTP_PORT = '8765';
  await runMain();
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await runManagedHttp(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('[tradingview-mcp:managed-http] startup failure: '
      + (error?.message || 'unknown') + '\n');
    process.exitCode = 1;
  }
}
