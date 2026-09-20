import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createTradingViewServer, writeStartupNotice } from './create-server.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_HTTP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toPositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function normalizeLoopbackHost(host) {
  const value = String(host || DEFAULT_HTTP_HOST).trim().toLowerCase();
  if (value === '127.0.0.1' || value === 'localhost') return '127.0.0.1';
  if (value === '::1' || value === '[::1]') return '::1';
  throw new Error(`Refusing non-loopback HTTP bind host: ${host}`);
}

function requestHostname(hostHeader) {
  if (!hostHeader) return null;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedHostHeader(hostHeader) {
  const hostname = requestHostname(hostHeader);
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1';
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, 'Request body too large');
  }

  const chunks = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }

  if (bytes === 0) {
    throw new HttpError(400, 'Missing JSON request body');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON request body');
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendProtocolError(res, status, message) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: {
      code: status === 404 ? -32001 : -32000,
      message,
    },
    id: null,
  });
}

export function resolveHttpConfig(overrides = {}) {
  const host = normalizeLoopbackHost(
    overrides.host ?? process.env.TV_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST
  );
  const port = overrides.port === 0
    ? 0
    : toPositiveInt(
        overrides.port ?? process.env.TV_MCP_HTTP_PORT,
        DEFAULT_HTTP_PORT,
        'TV_MCP_HTTP_PORT'
      );
  if (port > 65535) {
    throw new Error('TV_MCP_HTTP_PORT must be <= 65535');
  }

  const path = overrides.path ?? process.env.TV_MCP_HTTP_PATH ?? DEFAULT_HTTP_PATH;
  if (!String(path).startsWith('/')) {
    throw new Error('TV_MCP_HTTP_PATH must start with /');
  }

  return {
    host,
    port,
    path,
    maxBodyBytes: toPositiveInt(
      overrides.maxBodyBytes ?? process.env.TV_MCP_HTTP_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      'TV_MCP_HTTP_MAX_BODY_BYTES'
    ),
    maxSessions: toPositiveInt(
      overrides.maxSessions ?? process.env.TV_MCP_HTTP_MAX_SESSIONS,
      DEFAULT_MAX_SESSIONS,
      'TV_MCP_HTTP_MAX_SESSIONS'
    ),
    sessionIdleMs: toPositiveInt(
      overrides.sessionIdleMs ?? process.env.TV_MCP_HTTP_SESSION_IDLE_MS,
      DEFAULT_SESSION_IDLE_MS,
      'TV_MCP_HTTP_SESSION_IDLE_MS'
    ),
  };
}

export async function startTradingViewHttpServer(overrides = {}) {
  const config = resolveHttpConfig(overrides);
  const sessions = new Map();

  async function closeSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    try {
      await entry.transport.close();
    } catch {
      // Best effort during cleanup.
    }
  }

  async function purgeIdleSessions(now = Date.now()) {
    const expired = [];
    for (const [sessionId, entry] of sessions.entries()) {
      if (now - entry.lastSeen > config.sessionIdleMs) {
        expired.push(sessionId);
      }
    }
    await Promise.all(expired.map(closeSession));
  }

  const httpServer = createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host)) {
        sendProtocolError(res, 403, 'Forbidden host header');
        return;
      }

      const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      if (requestUrl.pathname !== config.path) {
        sendProtocolError(res, 404, 'Not Found');
        return;
      }

      await purgeIdleSessions();

      const sessionId = typeof req.headers['mcp-session-id'] === 'string'
        ? req.headers['mcp-session-id']
        : undefined;

      if (req.method === 'POST') {
        const body = await readJsonBody(req, config.maxBodyBytes);

        if (sessionId) {
          const entry = sessions.get(sessionId);
          if (!entry) {
            sendProtocolError(res, 404, 'Session not found');
            return;
          }
          entry.lastSeen = Date.now();
          await entry.transport.handleRequest(req, res, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          sendProtocolError(res, 400, 'Missing session ID for non-initialize request');
          return;
        }

        if (sessions.size >= config.maxSessions) {
          sendProtocolError(res, 503, 'Too many active MCP sessions');
          return;
        }

        const server = createTradingViewServer();
        let transport;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: id => {
            sessions.set(id, {
              server,
              transport,
              lastSeen: Date.now(),
            });
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId) {
          sendProtocolError(res, 400, 'Missing MCP session ID');
          return;
        }
        const entry = sessions.get(sessionId);
        if (!entry) {
          sendProtocolError(res, 404, 'Session not found');
          return;
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      res.setHeader('allow', 'GET, POST, DELETE');
      sendProtocolError(res, 405, 'Method Not Allowed');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Internal server error';
      if (status >= 500) {
        process.stderr.write(`[tradingview-mcp:http] ${error?.stack || error}\n`);
      }
      sendProtocolError(res, status, message);
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = error => {
      httpServer.off('listening', onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolvePromise();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(config.port, config.host);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  async function close() {
    await Promise.all([...sessions.keys()].map(closeSession));
    if (!httpServer.listening) return;
    await new Promise((resolvePromise, rejectPromise) => {
      httpServer.close(error => error ? rejectPromise(error) : resolvePromise());
    });
  }

  return {
    host: config.host,
    port,
    path: config.path,
    url: `http://${config.host === '::1' ? '[::1]' : config.host}:${port}${config.path}`,
    sessionCount: () => sessions.size,
    close,
  };
}

async function runMain() {
  writeStartupNotice();
  const runtime = await startTradingViewHttpServer();
  process.stderr.write(`[tradingview-mcp:http] listening on ${runtime.url}\n`);

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[tradingview-mcp:http] ${signal} received, shutting down\n`);
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`[tradingview-mcp:http] shutdown failed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  await runMain();
}
