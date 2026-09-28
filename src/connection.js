import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
const requestedHost = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(requestedHost)) throw new Error('TV_CDP_HOST must be loopback');
export const CDP_HOST = '127.0.0.1';
const requestedPort = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT || 9222);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) throw new Error('TV_CDP_PORT must be an integer from 1024 to 65535');
export const CDP_PORT = requestedPort;
const MAX_RETRIES = 3;
const BASE_DELAY = 500;
const EVAL_TIMEOUT = 15000;
const CONNECT_TIMEOUT = 5000;
const PROBE_TIMEOUT = 2500;

// Concurrent first-use calls share one attach instead of opening duplicate
// CDP sessions and racing over the module-level client/targetInfo cache.
const _connecting = new Map();

export function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} timed out after ${ms}ms — TradingView is not responding. `
      + 'Its renderer may have crashed or stalled; restart TradingView Desktop and retry.'
    )), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export function safeString(str) { return JSON.stringify(String(str)); }

export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

async function invalidateCachedClient() {
  const stale = client;
  client = null;
  targetInfo = null;
  if (stale) { try { await stale.close(); } catch { /* transport already gone */ } }
}

export async function getClient() {
  if (client) {
    try {
      await withTimeout(
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        PROBE_TIMEOUT,
        'CDP liveness check'
      );
      return client;
    } catch {
      await invalidateCachedClient();
    }
  }
  return connect();
}

export async function connect(targetId = null) {
  const key = targetId || '';
  if (_connecting.has(key)) return _connecting.get(key);

  const promise = _doConnect(targetId).finally(() => _connecting.delete(key));
  _connecting.set(key, promise);
  return promise;
}

async function _doConnect(targetId) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const candidates = targetId
        ? [await findTargetById(targetId)].filter(Boolean)
        : await findChartTargets();

      if (candidates.length === 0) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }

      for (const target of candidates) {
        let newClient = null;
        try {
          newClient = await withTimeout(
            CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id }),
            CONNECT_TIMEOUT,
            'CDP attach'
          );
          await withTimeout(
            newClient.Runtime.evaluate({ expression: '1', returnByValue: true }),
            PROBE_TIMEOUT,
            'Renderer probe'
          );
          await withTimeout(
            Promise.all([
              newClient.Runtime.enable(),
              newClient.Page.enable(),
              newClient.DOM.enable(),
            ]),
            CONNECT_TIMEOUT,
            'CDP domain enable'
          );

          targetInfo = target;
          client = newClient;
          return newClient;
        } catch (err) {
          lastError = err;
          if (newClient) { try { await newClient.close(); } catch { /* already gone */ } }
        }
      }

      throw new Error(
        `Found ${candidates.length} TradingView target(s) but none responded: ${lastError?.message || 'unknown renderer failure'}`
      );
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

export async function reconnectTo(targetId) {
  await invalidateCachedClient();
  return connect(targetId);
}

export function isTradingViewUrl(value) {
  try {
    const url = new URL(String(value));
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com'));
  } catch { return false; }
}

export async function listCdpTargets() {
  const resp = await fetch(new URL('/json/list', `http://127.0.0.1:${CDP_PORT}`), {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`CDP target list failed (HTTP ${resp.status})`);
  return resp.json();
}

export async function listTradingViewChartTargets() {
  const targets = await listCdpTargets();
  return targets.filter(t => {
    if (t.type !== 'page' || !isTradingViewUrl(t.url)) return false;
    try { return new URL(t.url).pathname.toLowerCase().startsWith('/chart'); }
    catch { return false; }
  });
}

async function findChartTargets() {
  const targets = await listCdpTargets();
  const pages = targets.filter(t => t.type === 'page' && isTradingViewUrl(t.url));
  const chartPages = pages.filter(t => {
    try { return new URL(t.url).pathname.toLowerCase().startsWith('/chart'); }
    catch { return false; }
  });
  const chartIds = new Set(chartPages.map(t => t.id));
  return [...chartPages, ...pages.filter(t => !chartIds.has(t.id))];
}

async function findTargetById(id) {
  const targets = await listCdpTargets();
  return targets.find(t => t.id === id && t.type === 'page' && isTradingViewUrl(t.url)) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) await getClient();
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const { timeoutMs, ...cdpOpts } = opts;
  let result;
  try {
    result = await withTimeout(
      c.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: cdpOpts.awaitPromise ?? false,
        ...cdpOpts,
      }),
      timeoutMs ?? EVAL_TIMEOUT,
      'Runtime.evaluate'
    );
  } catch (error) {
    await invalidateCachedClient();
    throw error;
  }
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) { return evaluate(expression, { awaitPromise: true }); }
export async function disconnect() { await invalidateCachedClient(); }

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) throw new Error(`${name} not available at ${path}`);
  return path;
}

export async function getChartApi() { return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API'); }
export async function getChartCollection() { return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection'); }
export async function getBottomBar() { return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar'); }
export async function getReplayApi() { return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API'); }
export async function getMainSeriesBars() { return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars'); }
