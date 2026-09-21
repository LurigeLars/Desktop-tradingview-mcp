/**
 * Persistent application-level lifecycle wrapper for TradingView Desktop.
 *
 * core/health.js owns launch mechanics. This module persists only enough
 * process metadata to safely re-identify the same launched application after
 * the MCP server itself restarts. Recovery is fail-closed: a PID is never
 * terminated unless the executable/command-line identity still matches.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { basename, dirname, join } from 'path';
import * as health from './health.js';

const STATE_VERSION = 1;
const STATE_FILE = join(
  process.env.LOCALAPPDATA || process.env.HOME || '.',
  'tradingview-mcp',
  'managed-launch.json'
);
const START_TIME_TOLERANCE_MS = 120_000;

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2), 'utf8');
  renameSync(tmp, STATE_FILE);
}

function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return state?.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

function clearState() {
  try { unlinkSync(STATE_FILE); } catch { /* already absent */ }
}

function processExists(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function getProcessInfo(pid, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue`,
        'if ($null -ne $p) {',
        '  [PSCustomObject]@{',
        '    ProcessId = [int]$p.ProcessId',
        '    ExecutablePath = [string]$p.ExecutablePath',
        '    CommandLine = [string]$p.CommandLine',
        '    CreationDate = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString("o") } else { $null }',
        '  } | ConvertTo-Json -Compress',
        '}',
      ].join('; ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      if (!out) return null;
      const parsed = JSON.parse(out);
      return {
        pid: Number(parsed.ProcessId),
        executablePath: parsed.ExecutablePath || '',
        commandLine: parsed.CommandLine || '',
        startedAt: parsed.CreationDate ? Date.parse(parsed.CreationDate) : null,
      };
    }

    const commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 3000,
      encoding: 'utf8',
    }).trim();
    return commandLine ? { pid: Number(pid), executablePath: '', commandLine, startedAt: null } : null;
  } catch {
    return null;
  }
}

function normalizePath(value, platform) {
  const normalized = String(value || '').replace(/\\/g, '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function verifyOwnership(state, info, platform) {
  if (!state || !info || Number(state.pid) !== Number(info.pid)) return false;
  if (state.platform !== platform) return false;

  const expected = normalizePath(state.binary, platform);
  const actual = normalizePath(info.executablePath, platform);
  const commandLine = String(info.commandLine || '');
  const base = basename(String(state.binary || '')).toLowerCase();
  const binaryMatches = actual ? actual === expected : (base && commandLine.toLowerCase().includes(base));
  if (!binaryMatches) return false;
  if (!commandLine.includes(`--remote-debugging-port=${Number(state.cdpPort)}`)) return false;

  if (Number.isFinite(info.startedAt) && Number.isFinite(Number(state.launchedAt))) {
    if (Math.abs(info.startedAt - Number(state.launchedAt)) > START_TIME_TOLERANCE_MS) return false;
  }
  return true;
}

async function cdpReachable(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function defaultDeps(overrides) {
  return {
    platform: overrides?.platform || process.platform,
    launch: overrides?.launch || health.launch,
    close: overrides?.close || health.close,
    saveState: overrides?.saveState || saveState,
    loadState: overrides?.loadState || loadState,
    clearState: overrides?.clearState || clearState,
    processExists: overrides?.processExists || processExists,
    getProcessInfo: overrides?.getProcessInfo || getProcessInfo,
    execSync: overrides?.execSync || execSync,
    processKill: overrides?.processKill || process.kill.bind(process),
    cdpReachable: overrides?.cdpReachable || cdpReachable,
    delay: overrides?.delay || ((ms) => new Promise(resolve => setTimeout(resolve, ms))),
  };
}

export async function launchManaged({ port, kill_existing, _deps } = {}) {
  const deps = defaultDeps(_deps);
  const result = await deps.launch({ port, kill_existing });
  if (result?.success && result?.managed_by_mcp && result?.pid) {
    const state = {
      pid: Number(result.pid),
      platform: result.platform || deps.platform,
      binary: result.binary,
      cdpPort: Number(result.cdp_port || port || 9222),
      launchedAt: Date.now(),
    };
    try {
      deps.saveState(state);
      return { ...result, ownership_persisted: true };
    } catch {
      return { ...result, ownership_persisted: false };
    }
  }
  return result;
}

export async function closeManaged({ force = false, _deps } = {}) {
  const deps = defaultDeps(_deps);
  const persisted = deps.loadState();

  // Let the in-process owner take the normal path first when available.
  let direct = null;
  try { direct = await deps.close({ force }); } catch { /* recovery path below */ }

  if (!persisted) {
    if (direct?.closed) return direct;
    return direct || {
      success: true,
      closed: false,
      reason: 'no_mcp_managed_instance',
      hint: 'tv_close only performs application-level shutdown of a verified MCP-managed TradingView process tree. Do not substitute tab_close, window.close(), or other UI actions when the intent is to exit TradingView Desktop.',
    };
  }

  const pid = Number(persisted.pid);
  let alive = !!deps.processExists(pid);
  if (!alive) {
    deps.clearState();
    return { success: true, closed: true, already_stopped: true, pid, cdp_port: Number(persisted.cdpPort), ownership_recovered: true };
  }

  const info = deps.getProcessInfo(pid, persisted.platform);
  if (!verifyOwnership(persisted, info, deps.platform)) {
    return {
      success: false,
      closed: false,
      reason: 'managed_instance_identity_mismatch',
      hint: 'Persisted TradingView ownership could not be safely revalidated, so no process was terminated.',
    };
  }

  // The normal close may already have worked. Verify the whole app process,
  // not merely the chart/CDP target, before declaring success.
  alive = !!deps.processExists(pid);
  let cdpUp = await deps.cdpReachable(persisted.cdpPort);
  if (!alive && !cdpUp) {
    deps.clearState();
    return { success: true, closed: true, pid, cdp_port: Number(persisted.cdpPort), force, ownership_recovered: true };
  }

  let terminationError = null;
  try {
    if (persisted.platform === 'win32') {
      const forceArg = force ? ' /F' : '';
      deps.execSync(`taskkill /PID ${pid} /T${forceArg}`, { timeout: 5000, stdio: 'ignore' });
    } else {
      deps.processKill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (err) {
    terminationError = err;
  }

  for (let i = 0; i < 10; i++) {
    await deps.delay(500);
    alive = !!deps.processExists(pid);
    cdpUp = await deps.cdpReachable(persisted.cdpPort);
    if (!alive && !cdpUp) break;
  }

  if (!alive && !cdpUp) {
    deps.clearState();
    return { success: true, closed: true, pid, cdp_port: Number(persisted.cdpPort), force, ownership_recovered: true };
  }

  return {
    success: false,
    closed: false,
    pid,
    cdp_port: Number(persisted.cdpPort),
    process_alive: alive,
    cdp_reachable: cdpUp,
    error: terminationError?.message || 'TradingView is still running after the application-level shutdown request.',
    ...(!force && { hint: 'Retry tv_close with force=true to force-stop the same verified MCP-managed TradingView process tree.' }),
  };
}
