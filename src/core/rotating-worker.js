/**
 * In-place, reversible one-symbol sampling on an EXISTING DTV worker pane.
 *
 * Does not open/close tabs, change worker registry, save layouts, or touch a
 * personal chart. Every mutation has a durable recovery journal. Read-only
 * realtime_snapshot is serialized via the same topology lock by its tool.
 */
import CDP from 'chrome-remote-interface';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CDP_HOST, CDP_PORT, listTradingViewChartTargets } from '../connection.js';
import { status as workerStatus, normalizeWorkerTimeframe } from './worker.js';
import { readActivePaneStates } from './worker-provision.js';
import { realtimeSnapshot, requiredStudiesPresent } from './realtime.js';
import { matchTradingViewResolvedSymbol } from './watchlist.js';

const ROOT = resolve(process.env.LOCALAPPDATA || process.env.HOME || '.', 'tradingview-mcp');
const JOURNAL = join(ROOT, 'worker-rotation-pending.json');
const QUALIFIED = /^[A-Z0-9_.]+:[A-Z0-9_.!]+$/;
const sleep = ms => new Promise(done => setTimeout(done, ms));

function chartIdFromUrl(url) {
  try { return new URL(url).pathname.match(/^\/chart\/([^/]+)/)?.[1] || null; }
  catch { return null; }
}
function identityMatches(request, live) {
  return !!(live && !live.error && matchTradingViewResolvedSymbol(
    request, live.resolved_symbol, live.symbol_identity || {},
  ).matched);
}
function matchingEntry(entry, pane) {
  if (!identityMatches(entry.symbol, pane)) return false;
  try {
    return normalizeWorkerTimeframe(entry.timeframe)
      === normalizeWorkerTimeframe(pane.resolution)
      && requiredStudiesPresent(entry, pane);
  } catch { return false; }
}
function exactSymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!QUALIFIED.test(s)) throw new Error('Rotation needs one simple exchange-qualified symbol');
  return s;
}
export function selectRotatingPane(state) {
  // One explicitly nominated, lower-priority temporary sample pane.
  // This must remain safe after the resident pool is right-sized: no reliance
  // on the old 40-entry / five-eight-pane topology.
  const entries = state?.entries || [];
  const eligible = entries.filter(e =>
    e.handle === 'qqq-5m'
    && e.symbol === 'NASDAQ:QQQ'
    && normalizeWorkerTimeframe(e.timeframe) === '5'
    && (e.groups || []).includes('watch:tactical_current')
    && (e.groups || []).includes('watch:resident')
    && !(e.groups || []).some(g => [
      'watch:user_retained','watch:core_regime','watch:energy',
      'watch:rates_fx','watch:vol_credit','watch:refiners',
      'watch:ai_semis','watch:gold_macro','research:brent_nq_event',
    ].includes(g))
    && Array.isArray(e.studies) && e.studies.length===0
  );
  if (eligible.length!==1) throw new Error('No safely replaceable pane in registered market workers');
  const entry=eligible[0];
  const slot=entry.assignment?.worker_slot;
  const index=entry.assignment?.pane_index;
  if (!Number.isInteger(slot) || slot<0 || !Number.isInteger(index) || index<0)
    throw new Error('Rotating worker has no exact slot and pane assignment');
  const owner=(state?.worker_tabs||[]).find(t=>Number(t.slot)===slot);
  const topology=(state?.topology_plan?.tabs||[]).find(t=>Number(t.tab_index)===slot);
  const paneCount=Number(owner?.pane_count);
  if (!owner?.persistent_layout || !/^DTV Market \d{2}$/.test(String(owner.layout_name||'')) ||
      !owner.chart_id || !owner.target_id || !topology ||
      !Number.isInteger(paneCount) || paneCount<1 || paneCount>8 ||
      Number(topology.pane_count)!==paneCount || index>=paneCount ||
      String(entry.assignment.chart_id)!==String(owner.chart_id) ||
      String(entry.assignment.target_id)!==String(owner.target_id)) {
    throw new Error('No safely replaceable pane in registered market workers');
  }
  const assigned = entries.filter(e=>Number(e.assignment?.worker_slot)===slot);
  const indices=assigned.map(e=>e.assignment?.pane_index);
  if(assigned.length!==paneCount ||
     new Set(indices).size!==paneCount ||
     indices.some(i=>!Number.isInteger(i)||i<0||i>=paneCount) ||
     assigned.some(e=>String(e.assignment?.chart_id)!==String(owner.chart_id) ||
                      String(e.assignment?.target_id)!==String(owner.target_id))) {
    throw new Error('Rotating market layout has incomplete or conflicting pane registry');
  }
  return {entry,slot,chart_id:String(owner.chart_id),
    target_id:String(owner.target_id),pane_index:index,pane_count:paneCount};
}
function loadJournal() {
  if (!existsSync(JOURNAL)) return null;
  return JSON.parse(readFileSync(JOURNAL, 'utf8'));
}
function writeJournal(data) {
  mkdirSync(ROOT, { recursive: true });
  const tmp = JOURNAL + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data) + '\n', { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, JOURNAL);
}
function clearJournal() { if (existsSync(JOURNAL)) unlinkSync(JOURNAL); }

async function withExactTarget(chartId, fn) {
  const targets = (await listTradingViewChartTargets()).filter(t => chartIdFromUrl(t.url) === chartId);
  if (targets.length !== 1) throw new Error('Target chart identity missing or ambiguous');
  const target = targets[0];
  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  try {
    await c.Runtime.enable();
    return await fn(c, target);
  } finally {
    try { await c.close(); } catch {}
  }
}
async function readPane(chartId, index, paneCount) {
  return withExactTarget(chartId, async c => {
    const panes = await readActivePaneStates(c);
    if (panes.length !== paneCount) throw new Error('Existing worker layout changed pane count');
    return { pane: panes[index], all: panes };
  });
}
async function setPane(chartId, index, symbol, timeframe, paneCount) {
  // Use exact chart ID and existing indexed pane; NEVER target the active user tab.
  return withExactTarget(chartId, async c => {
    const expression = `(async function() {
      var cfg=${JSON.stringify({ index, symbol, timeframe, paneCount })};
      var cwc=window.TradingViewApi&&window.TradingViewApi._chartWidgetCollection;
      var panes=cwc&&cwc.getAll?cwc.getAll():[];
      var count=cwc&&cwc.inlineChartsCount;
      if(count&&typeof count.value==='function') count=count.value();
      if(Number(count)!==cfg.paneCount||panes.length!==cfg.paneCount||!panes[cfg.index]) throw new Error('Worker pane/layout changed');
      var widget=panes[cfg.index];
      if(!widget._mainDiv||typeof widget._mainDiv.click!=='function') throw new Error('Pane cannot be focused safely');
      widget._mainDiv.click();
      await new Promise(r=>setTimeout(r,150));
      var active=window.TradingViewApi._activeChartWidgetWV.value();
      if(!active||active._chartWidget!==widget) throw new Error('Wrong active pane; refusing symbol switch');
      active.setSymbol(cfg.symbol,{});
      active.setResolution(cfg.timeframe,{});
      await new Promise(r=>setTimeout(r,500));
      return {changed:true};
    })()`;
    const evaluated = await Promise.race([
      c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }),
      sleep(5000).then(() => { throw new Error('Pane change timed out'); }),
    ]);
    if (evaluated?.exceptionDetails || !evaluated?.result?.value?.changed)
      throw new Error('TradingView pane symbol change failed');
  });
}
async function waitPane(chartId, index, symbol, timeframe, paneCount) {
  const until = Date.now() + 5500;
  do {
    const p = (await readPane(chartId, index, paneCount)).pane;
    if (identityMatches(symbol, p)
      && normalizeWorkerTimeframe(p.resolution) === normalizeWorkerTimeframe(timeframe)) return p;
    await sleep(350);
  } while (Date.now() < until);
  throw new Error('Updated pane identity/timeframe could not be verified');
}

function deps(overrides) {
  return {
    status: overrides?.status || workerStatus,
    read: overrides?.read || readPane,
    set: overrides?.set || setPane,
    wait: overrides?.wait || waitPane,
    snapshot: overrides?.snapshot || (symbol => realtimeSnapshot({
      symbols: [symbol], mode: 'decision', bars: 30, include_studies: false,
    })),
    getJournal: overrides?.getJournal || loadJournal,
    putJournal: overrides?.putJournal || writeJournal,
    clearJournal: overrides?.clearJournal || clearJournal,
  };
}
function assertBaseline(state, chosen, all) {
  const tab = state.worker_tabs.find(t => Number(t.slot) === chosen.slot);
  if (!tab || String(tab.chart_id) !== chosen.chart_id) throw new Error('Worker chart ID changed');
  const owned = state.entries.filter(e => Number(e.assignment?.worker_slot) === chosen.slot);
  if (owned.length !== chosen.pane_count || !Array.isArray(all) || all.length !== chosen.pane_count)
    throw new Error('Unverified resident worker pane topology');
  for (const e of owned) {
    const pane = all[Number(e.assignment?.pane_index)];
    if (!matchingEntry(e, pane)) throw new Error('Worker pane identities not aligned; no mutation made');
  }
}

export async function recoverRotatingPane({ dry_run = false, _deps } = {}) {
  const d = deps(_deps), journal = d.getJournal();
  if (!journal) return { success:true, pending:false, restored:true };
  if (!journal.chart_id || !Number.isInteger(journal.pane_index)
    || !journal.original?.symbol || !journal.temporary)
    throw new Error('Invalid rotation journal; refusing any mutation');
  const state = d.status();
  const chosen = selectRotatingPane(state);
  if (chosen.chart_id !== journal.chart_id || chosen.pane_index !== journal.pane_index
    || chosen.entry.handle !== journal.handle || chosen.entry.symbol !== journal.original.symbol)
    throw new Error('Worker ownership changed; rotation recovery blocked');
  const now = (await d.read(chosen.chart_id, chosen.pane_index, chosen.pane_count)).pane;
  if (matchingEntry(chosen.entry, now)) {
    if (!dry_run) d.clearJournal();
    return {success:true,pending:true,restored:true,was_already_original:true};
  }
  if (!identityMatches(journal.temporary, now))
    throw new Error('Rotated pane now holds an unexpected symbol; manual recovery required');
  if (dry_run) return {success:true,pending:true,restored:false,can_restore:true};
  await d.set(chosen.chart_id, chosen.pane_index, chosen.entry.symbol, chosen.entry.timeframe, chosen.pane_count);
  await d.wait(chosen.chart_id, chosen.pane_index, chosen.entry.symbol, chosen.entry.timeframe, chosen.pane_count);
  const restored = (await d.read(chosen.chart_id,chosen.pane_index, chosen.pane_count)).pane;
  if (!matchingEntry(chosen.entry,restored)) throw new Error('Could not verify original worker restoration');
  d.clearJournal();
  return {success:true,pending:true,restored:true};
}
export async function rotateWorkerSnapshot({ symbol, dry_run = false, _deps } = {}) {
  const requested = exactSymbol(symbol), d = deps(_deps);
  if (d.getJournal()) {
    const recovery = await recoverRotatingPane({dry_run,_deps});
    if (!recovery.restored) return {success:false,error_code:'RESTORATION_PENDING',recovery};
  }
  const state = d.status(), chosen = selectRotatingPane(state);
  if (chosen.entry.symbol.toUpperCase()===requested)
    return {success:false,error_code:'ALREADY_RESIDENT',requested};
  const original = await d.read(chosen.chart_id,chosen.pane_index, chosen.pane_count);
  assertBaseline(state,chosen,original.all);
  const safe = {requested,slot:chosen.slot,pane_index:chosen.pane_index,
    displaced_handle:chosen.entry.handle,displaced_symbol:chosen.entry.symbol,
    baseline_preserved:true,opened_tabs:0,execution_quote:false};
  if (dry_run) return {success:true,dry_run:true,...safe,restored:true,sampled:false};
  const pending = {version:1,chart_id:chosen.chart_id,pane_index:chosen.pane_index,
    handle:chosen.entry.handle,original:{symbol:chosen.entry.symbol,timeframe:chosen.entry.timeframe},
    temporary:requested,created_at:new Date().toISOString()};
  d.putJournal(pending); // Durable before any CDP mutation.
  let result, failure;
  try {
    await d.set(chosen.chart_id,chosen.pane_index,requested,'60',chosen.pane_count);
    await d.wait(chosen.chart_id,chosen.pane_index,requested,'60',chosen.pane_count);
    const snap = await d.snapshot(requested);
    // realtimeSnapshot already verified the qualified identity against
    // TradingView's internal instrument metadata before stripping that private
    // identity from the public payload. Do not re-match alias BATS/NYSE here.
    const matching = (snap.snapshots || []).filter(x=>x.target_id
      && String(x.chart_id)===chosen.chart_id
      && Number(x.pane_index)===chosen.pane_index);
    if (!(snap.requested_symbols || []).includes(requested)
        || (snap.missing || []).includes(requested)
        || (snap.ambiguous_symbols || []).length) {
      throw new Error('Snapshot provider did not verify requested qualified symbol');
    }
    if (matching.length !== 1 || matching[0].success !== true)
      throw new Error('Rotated quote identity not independently verified');
    result = {success:true,...safe,restored:false,sampled:true,
      qualified_identity_verified:true, verified_requested_symbol:requested,
      snapshot:matching[0],source_timestamp_ms:matching[0].quote?.source_timestamp_ms??null};
  } catch(e) {failure = e;}
  try {
    // No matter why sampling failed, attempt to restore only this pane.
    const current = (await d.read(chosen.chart_id,chosen.pane_index, chosen.pane_count)).pane;
    if (!matchingEntry(chosen.entry,current)) {
      if (!identityMatches(requested,current))
        throw new Error('Pane changed unexpectedly; cannot safely restore');
      await d.set(chosen.chart_id,chosen.pane_index,chosen.entry.symbol,chosen.entry.timeframe,chosen.pane_count);
      await d.wait(chosen.chart_id,chosen.pane_index,chosen.entry.symbol,chosen.entry.timeframe,chosen.pane_count);
    }
    const final = (await d.read(chosen.chart_id,chosen.pane_index, chosen.pane_count)).pane;
    if (!matchingEntry(chosen.entry,final)) throw new Error('Original pane restoration unverifiable');
    d.clearJournal();
  } catch(restore) {
    return {success:false,error_code:'RESTORATION_PENDING',
      message:restore.message,original_error:failure?.message||null,
      restored:false,opened_tabs:0,execution_quote:false};
  }
  if (failure) return {success:false,error_code:'ROTATION_SAMPLE_FAILED',
    message:failure.message,restored:true,opened_tabs:0,execution_quote:false};
  return {...result,restored:true};
}
