/** Minimal durable, price-free evidence of actual resident pane reads.
 * A configured/visible pane is not counted until a snapshot contains it.
 * Consumer strings are self-declared routing hints, never authenticated identities.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.env.LOCALAPPDATA || process.env.HOME || '.', 'tradingview-mcp');
const FILE = join(ROOT, 'worker-usage.json');
const VERSION = 1;
const RETAIN_DAYS = 14;

function read() {
  try {
    const value = JSON.parse(readFileSync(FILE, 'utf8'));
    return value?.version === VERSION && value.days && typeof value.days === 'object'
      ? value : {version: VERSION, days: {}};
  } catch { return {version: VERSION, days: {}}; }
}
function write(value) {
  mkdirSync(ROOT, {recursive:true});
  const tmp = join(ROOT, 'worker-usage.' + process.pid + '.tmp');
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, FILE);
}
function safeConsumer(value) {
  const raw = String(value || 'unattributed').toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(raw) ? raw : 'unattributed';
}
function pairKey(entry) {
  const a = entry?.assignment;
  return a?.target_id && Number.isInteger(a.pane_index)
    ? String(a.target_id) + '|' + a.pane_index : null;
}
export function usageFromSnapshot({response, workerState, consumer, nowMs = Date.now()} = {}) {
  const byPair = new Map();
  for (const entry of workerState?.entries || []) {
    const key = pairKey(entry);
    if (key && !byPair.has(key)) byPair.set(key, entry);
  }
  const seen = new Map();
  for (const row of response?.snapshots || []) {
    const key = row?.target_id != null && Number.isInteger(row.pane_index)
      ? String(row.target_id) + '|' + row.pane_index : null;
    const entry = key ? byPair.get(key) : null;
    if (!entry) continue;
    if (entry.assignment?.resolved_symbol !== row.resolved_symbol ||
        String(entry.assignment?.resolution) !== String(row.resolution)) continue;
    if (row.success) seen.set(entry.handle, entry);
  }
  return {
    day: new Date(nowMs).toISOString().slice(0,10),
    timestamp: new Date(nowMs).toISOString(),
    consumer: safeConsumer(consumer),
    mode: String(response?.mode || 'unknown').slice(0,20),
    handles: [...seen.keys()].sort(),
    requested: (response?.requested_handles || []).length ||
      (response?.requested_groups || []).length ||
      (response?.requested_symbols || []).length,
    success: response?.success === true,
    returned: (response?.snapshots || []).length,
  };
}
export function recordWorkerUsage({response, workerState, consumer, nowMs = Date.now(), _deps} = {}) {
  const io = {read:_deps?.read || read, write:_deps?.write || write};
  const observed = usageFromSnapshot({response,workerState,consumer,nowMs});
  const data = io.read();
  const daily = data.days[observed.day] || {requests:0, consumers:{}, handles:{}};
  daily.requests += 1;
  const source = daily.consumers[observed.consumer] ||
    {requests:0,successes:0,returned_snapshots:0,last_at:null};
  source.requests += 1;
  source.successes += Number(observed.success);
  source.returned_snapshots += observed.returned;
  source.last_at = observed.timestamp;
  daily.consumers[observed.consumer] = source;
  for (const handle of observed.handles) {
    const row = daily.handles[handle] || {reads:0,by_consumer:{},last_at:null};
    row.reads += 1;
    row.by_consumer[observed.consumer] = (row.by_consumer[observed.consumer] || 0)+1;
    row.last_at = observed.timestamp;
    daily.handles[handle] = row;
  }
  data.days[observed.day] = daily;
  const cutoff = new Date(nowMs - RETAIN_DAYS*86400000).toISOString().slice(0,10);
  for (const day of Object.keys(data.days)) if(day < cutoff) delete data.days[day];
  io.write(data);
  return observed;
}
export function workerUsageReport({_deps} = {}) {
  const data = (_deps?.read || read)();
  return {success:true,source:'DTV_LOCAL_WORKER_READS',retention_days:RETAIN_DAYS,
    attribution:'self_declared_consumer_not_authenticated',
    measurement:'verified_successful_snapshot_per_live_target_and_pane',
    days:data.days,notice:'Zero reads mean unobserved during this measurement window, not proof of zero consumers.'};
}
