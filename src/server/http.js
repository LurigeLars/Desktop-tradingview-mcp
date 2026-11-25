import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { createTradingViewServer, writeStartupNotice } from './create-server.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_HTTP_PATH = '/mcp';
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_SESSION_IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_PRESSURE_IDLE_MS = 30 * 1000;

export const HTTP_TOKEN_FILE = resolve(
  process.env.LOCALAPPDATA || process.env.HOME || '.', 'tradingview-mcp', 'http-token'
);

// Loopback is not private: every Docker container reaches it via host.docker.internal,
// so each local client must send this shared secret as a bearer token.
export function readHttpToken({ create = false } = {}) {
  const fromEnv = process.env.TV_MCP_HTTP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(HTTP_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
  }
  mkdirSync(dirname(HTTP_TOKEN_FILE), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(HTTP_TOKEN_FILE, token, { flag: 'wx', mode: 0o600 });
  return token;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function hasBearerToken(authorization, expectedDigest) {
  const match = /^Bearer (\S+)$/i.exec(String(authorization || ''));
  // Hashing first makes the compare constant-time regardless of length.
  return Boolean(match) && timingSafeEqual(digest(match[1]), expectedDigest);
}

export function isSessionReclaimable(entry, now, idleMs) {
  return (entry.activeRequests ?? 0) === 0 && now - entry.lastSeen > idleMs;
}

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
    sessionPressureIdleMs: toPositiveInt(
      overrides.sessionPressureIdleMs ?? process.env.TV_MCP_HTTP_SESSION_PRESSURE_IDLE_MS,
      DEFAULT_SESSION_PRESSURE_IDLE_MS,
      'TV_MCP_HTTP_SESSION_PRESSURE_IDLE_MS'
    ),
  };
}

export async function startTradingViewHttpServer(overrides = {}) {
  const config = resolveHttpConfig(overrides);
  const token = overrides.token ?? readHttpToken({ create: true });
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('TradingView MCP HTTP token must be at least 32 characters');
  }
  const tokenDigest = digest(token);
  const sessions = new Map();
  const modern = createMcpHandler(() => createTradingViewServer({ modern: true }), {
    legacy: 'reject',
    maxRequestBodySize: config.maxBodyBytes,
  });
  const handleModern = toNodeHandler(modern, { maxRequestBodySize: config.maxBodyBytes });
  let modernInFlight = 0;

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

  async function purgeIdleSessions(now = Date.now(), idleMs = config.sessionIdleMs) {
    const expired = [];
    for (const [sessionId, entry] of sessions.entries()) {
      if (isSessionReclaimable(entry, now, idleMs)) {
        expired.push(sessionId);
      }
    }
    await Promise.all(expired.map(closeSession));
  }

  async function handleSessionRequest(entry, handler) {
    entry.activeRequests += 1;
    entry.lastSeen = Date.now();
    try {
      return await handler();
    } finally {
      entry.activeRequests = Math.max(0, entry.activeRequests - 1);
      entry.lastSeen = Date.now();
    }
  }

  const sessionSweepMs = Math.max(
    10,
    Math.min(60_000, Math.floor(config.sessionIdleMs / 2))
  );
  let sweepPromise = Promise.resolve();
  const sweepTimer = setInterval(() => {
    sweepPromise = sweepPromise
      .then(() => purgeIdleSessions())
      .catch(error => {
        process.stderr.write(`[tradingview-mcp:http] session cleanup failed: ${error?.stack || error}\n`);
      });
  }, sessionSweepMs);
  sweepTimer.unref();

  const httpServer = createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host)) {
        sendProtocolError(res, 403, 'Forbidden host header');
        return;
      }
      if (!hasBearerToken(req.headers.authorization, tokenDigest)) {
        res.setHeader('www-authenticate', 'Bearer');
        sendProtocolError(res, 401, 'Unauthorized');
        return;
      }

      const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      if (requestUrl.pathname !== config.path) {
        sendProtocolError(res, 404, 'Not Found');
        return;
      }

      const sessionId = typeof req.headers['mcp-session-id'] === 'string'
        ? req.headers['mcp-session-id']
        : undefined;

      if (req.method === 'POST') {
        const body = await readJsonBody(req, config.maxBodyBytes);

        // Authentication, host/path validation and body limits are already
        // applied. Let the v2 SDK classify the envelope, including malformed
        // modern claims; never fall back to legacy on a modern protocol error.
        if (!(await isLegacyRequest(await toWebRequest(req, body), body, { maxRequestBodySize: config.maxBodyBytes }))) {
          if (modernInFlight >= config.maxSessions) {
            sendProtocolError(res, 503, 'Too many active MCP requests');
            return;
          }
          modernInFlight += 1;
          try {
            await handleModern(req, res, body);
          } finally {
            modernInFlight -= 1;
          }
          return;
        }

        await purgeIdleSessions();
        if (sessionId) {
          const entry = sessions.get(sessionId);
          if (!entry) {
            sendProtocolError(res, 404, 'Session not found');
            return;
          }
          await handleSessionRequest(
            entry,
            () => entry.transport.handleRequest(req, res, body)
          );
          return;
        }

        if (!isInitializeRequest(body)) {
          sendProtocolError(res, 400, 'Missing session ID for non-initialize request');
          return;
        }

        if (sessions.size >= config.maxSessions) {
          await purgeIdleSessions(Date.now(), config.sessionPressureIdleMs);
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
              activeRequests: 1,
            });
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };

        await server.connect(transport);
        try {
          await transport.handleRequest(req, res, body);
        } finally {
          const initializedId = transport.sessionId;
          const entry = initializedId ? sessions.get(initializedId) : null;
          if (entry) {
            entry.activeRequests = Math.max(0, entry.activeRequests - 1);
            entry.lastSeen = Date.now();
          }
        }
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        await purgeIdleSessions();
        if (!sessionId) {
          sendProtocolError(res, 400, 'Missing MCP session ID');
          return;
        }
        const entry = sessions.get(sessionId);
        if (!entry) {
          sendProtocolError(res, 404, 'Session not found');
          return;
        }
        await handleSessionRequest(
          entry,
          () => entry.transport.handleRequest(req, res)
        );
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
    clearInterval(sweepTimer);
    await sweepPromise;
    await Promise.all([...sessions.keys()].map(closeSession));
    await modern.close();
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

export async function runMain() {
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
