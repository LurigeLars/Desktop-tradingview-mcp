/**
 * Structured control of one registry-verified worker pane.
 *
 * The worker registry is the contract with resident consumers (Trade Spine,
 * morning brief). Every change here is applied to exactly one verified pane,
 * verified live, saved to the worker-owned layout and only then recorded in the
 * registry, so live pane, saved layout and registry never disagree on success.
 * All caller values are validated data embedded with JSON.stringify; no caller
 * code, URL or path reaches the page.
 */
import {
  status, replaceWorkerEntry, normalizeWorkerTimeframe, normalizeStudySpecs,
  EXTENDED_HOURS_GROUP, workerRequiresExtendedHours,
} from './worker.js';
import { pendingPaneIndexes, paneMatchesEntry } from './worker-provision.js';
import { canonicalStudyName, studyInputsMatch } from './realtime.js';
import { saveWorkerLayout } from './worker-layout.js';
import { registeredWorkerTab, attachWorkerTarget } from './worker-repair.js';

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9_]{0,23}:[A-Z0-9][A-Z0-9_.!-]{0,31}$/i;
export const TIMEFRAME_PATTERN = /^([1-9]\d{0,3}|[1-9]\d?[SDWM])$/;
export const INPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

// Canonical name (realtime.canonicalStudyName) -> createStudy name, which is also
// stored in the registry, so it must canonicalize back to the same key.
export const WORKER_STUDY_ALLOWLIST = Object.freeze({
  EMA: 'Exponential moving average',
  VWAP: 'VWAP',
  VOLUME: 'Volume',
  'KELTNER CHANNELS': 'Keltner Channels',
  'RELATIVE STRENGTH INDEX': 'Relative Strength Index',
  'BOLLINGER BANDS': 'Bollinger Bands',
});

const MAX_STUDIES_PER_PANE = 12;

function allowedStudy(name) {
  const canonical = canonicalStudyName(name);
  const createName = WORKER_STUDY_ALLOWLIST[canonical];
  if (!createName) throw new Error('Study not in worker allowlist: ' + String(name).slice(0, 64));
  return { canonical, createName };
}

function checkInputs(inputs, label) {
  if (inputs == null) return undefined;
  if (typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error(label + ' must be an object');
  const keys = Object.keys(inputs);
  if (keys.length > 16) throw new Error(label + ' allows at most 16 keys');
  for (const key of keys) {
    const value = inputs[key];
    if (!INPUT_KEY_PATTERN.test(key)) throw new Error(label + ' has an invalid key');
    if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 64))) {
      throw new Error(label + '.' + key + ' must be a finite number, boolean or short string');
    }
  }
  return inputs;
}

/** Validate and normalize a change request. Pure; throws on anything outside the allowlist. */
export function validateChange(change = {}) {
  const out = {};
  if (change.symbol !== undefined) {
    if (typeof change.symbol !== 'string' || !SYMBOL_PATTERN.test(change.symbol.trim()))
      throw new Error('symbol must be one exchange-qualified TradingView symbol such as NASDAQ:QQQ');
    out.symbol = change.symbol.trim().toUpperCase();
  }
  if (change.timeframe !== undefined) {
    const tf = normalizeWorkerTimeframe(change.timeframe);
    if (!TIMEFRAME_PATTERN.test(tf)) throw new Error('Unsupported timeframe: ' + String(change.timeframe).slice(0, 16));
    out.timeframe = tf;
  }
  if (change.extended_hours !== undefined) {
    if (typeof change.extended_hours !== 'boolean') throw new Error('extended_hours must be boolean');
    out.extended_hours = change.extended_hours;
  }
  const list = (value, label) => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 8) throw new Error(label + ' must be an array of at most 8 items');
    return value;
  };
  out.add_studies = list(change.add_studies, 'add_studies').map((s, i) => ({
    ...allowedStudy(s?.name), inputs: checkInputs(s?.inputs, `add_studies[${i}].inputs`),
  }));
  out.remove_studies = list(change.remove_studies, 'remove_studies').map((s, i) => ({
    ...allowedStudy(s?.name), match_inputs: checkInputs(s?.match_inputs, `remove_studies[${i}].match_inputs`),
  }));
  out.configure_studies = list(change.configure_studies, 'configure_studies').map((s, i) => {
    const inputs = checkInputs(s?.inputs, `configure_studies[${i}].inputs`);
    if (!inputs || !Object.keys(inputs).length) throw new Error(`configure_studies[${i}].inputs is required`);
    return { ...allowedStudy(s?.name), match_inputs: checkInputs(s?.match_inputs, `configure_studies[${i}].match_inputs`), inputs };
  });
  if (change.visible_range !== undefined) {
    const { from, to } = change.visible_range || {};
    const max = Math.floor(Date.now() / 1000) + 366 * 86400;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= from || to > max)
      throw new Error('visible_range needs integer unix seconds with 0 < from < to <= one year ahead');
    out.visible_range = { from, to };
  }
  const changes = ['symbol', 'timeframe', 'extended_hours', 'visible_range'].filter(k => out[k] !== undefined).length
    + out.add_studies.length + out.remove_studies.length + out.configure_studies.length;
  if (!changes) throw new Error('No change requested');
  return out;
}

// Validated data -> JS literal; escapes characters that could close a script context.
const UNSAFE_CHARS = { '<': '\\u003C', '>': '\\u003E', [String.fromCharCode(0x2028)]: '\\u2028', [String.fromCharCode(0x2029)]: '\\u2029' };
export function jsLiteral(value) {
  return JSON.stringify(value).replace(/[<>\u{2028}\u{2029}]/gu, c => UNSAFE_CHARS[c]);
}

// Live studies with entity ids. Inputs come back unwrapped; encrypted/meta blobs are dropped.
const LIST_STUDIES = index => `(()=>{const chart=window.TradingViewApi.chart(${Number(index)});
  const skip=/^(text|pineId|pineVersion|pineFeatures|__)/;
  return chart.getAllStudies().map(s=>{const inputs={};
    try{for(const i of chart.getStudyById(s.id).getInputValues()){if(!skip.test(i.id))inputs[i.id]=i.value;}}catch(e){}
    return {id:s.id,name:s.name,inputs};});})()`;

function matchLiveStudy(studies, request, label) {
  const hits = studies.filter(s => canonicalStudyName(s.name) === request.canonical
    && studyInputsMatch(request.match_inputs, s.inputs, request.canonical));
  if (hits.length !== 1) throw new Error(`${label} ${request.canonical} matched ${hits.length} live studies; pass match_inputs to select exactly one`);
  return hits[0];
}

function withoutConflictingAlias(canonical, base, patch) {
  const merged = { ...(base || {}), ...patch };
  // EMA "length" and typed "in_0" are the same input (see realtime.studyInputsMatch).
  if (canonical === 'EMA' && 'in_0' in patch) delete merged.length;
  if (canonical === 'EMA' && 'length' in patch) delete merged.in_0;
  return merged;
}

/** Pure plan: next registry entry and the exact live operations for the pane. */
export function planChange(entry, change, liveStudies) {
  const ops = { remove_ids: [], configure: [], add: [] };
  let studies = [...(entry.studies || [])];
  const touched = new Set();
  const specSatisfiedBy = live => spec => canonicalStudyName(spec.name) === canonicalStudyName(live.name)
    && studyInputsMatch(spec.inputs, live.inputs, canonicalStudyName(live.name));

  for (const request of change.remove_studies) {
    const live = matchLiveStudy(liveStudies, request, 'remove_studies');
    if (touched.has(live.id)) throw new Error('A live study may be targeted only once per call');
    touched.add(live.id);
    ops.remove_ids.push(live.id);
    const i = studies.findIndex(specSatisfiedBy(live));
    if (i >= 0) studies.splice(i, 1);
  }
  for (const request of change.configure_studies) {
    const live = matchLiveStudy(liveStudies, request, 'configure_studies');
    if (touched.has(live.id)) throw new Error('A live study may be targeted only once per call');
    touched.add(live.id);
    ops.configure.push({ id: live.id, inputs: request.inputs });
    const i = studies.findIndex(specSatisfiedBy(live));
    if (i >= 0) studies[i] = { name: studies[i].name, inputs: withoutConflictingAlias(request.canonical, studies[i].inputs, request.inputs) };
  }
  for (const request of change.add_studies) {
    ops.add.push({ name: request.createName, inputs: request.inputs || {} });
    studies.push(request.inputs ? { name: request.createName, inputs: request.inputs } : { name: request.createName });
  }
  if (liveStudies.length - ops.remove_ids.length + ops.add.length > MAX_STUDIES_PER_PANE)
    throw new Error('Worker pane study limit is ' + MAX_STUDIES_PER_PANE);

  const groups = (entry.groups || []).filter(g => g !== EXTENDED_HOURS_GROUP);
  const extended = change.extended_hours ?? workerRequiresExtendedHours(entry);
  if (extended) groups.push(EXTENDED_HOURS_GROUP);
  const next = {
    symbol: change.symbol ?? entry.symbol,
    timeframe: change.timeframe ?? entry.timeframe,
    studies: normalizeStudySpecs(studies),
    groups,
  };
  const instrumentChanged = next.symbol.toUpperCase() !== String(entry.symbol).toUpperCase()
    || normalizeWorkerTimeframe(next.timeframe) !== normalizeWorkerTimeframe(entry.timeframe);
  const wasExtended = workerRequiresExtendedHours(entry);
  // Re-pin extended after any series change; 'regular' only when switching it off,
  // because many non-equity symbols expose no regular subsession at all.
  const session = extended ? (instrumentChanged || !wasExtended ? 'extended' : null)
    : (wasExtended ? 'regular' : null);
  return {
    next, ops, extended, instrumentChanged,
    live: {
      symbol: next.symbol.toUpperCase() !== String(entry.symbol).toUpperCase() ? next.symbol : null,
      timeframe: change.timeframe !== undefined ? next.timeframe : null,
      session,
      ...ops,
      visible_range: change.visible_range || null,
    },
  };
}

function applyExpression(cfg) {
  return `(async()=>{
    const cfg=${jsLiteral(cfg)};
    const api=window.TradingViewApi,c=api._chartWidgetCollection;
    if(api.layoutId()!==cfg.chart_id||api.chartsCount()!==cfg.pane_count) throw Error('Worker layout identity changed before mutation');
    c.symbolSyncEnabled().setValue(false);c.intervalSyncEnabled().setValue(false);
    if(c.symbolSyncEnabled().value()||c.intervalSyncEnabled().value()) throw Error('Worker synchronization still active');
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const chart=api.chart(cfg.index);
    if(cfg.symbol){chart.setSymbol(cfg.symbol,{});await sleep(800);}
    if(cfg.timeframe){chart.setResolution(cfg.timeframe,{});await sleep(800);}
    if(cfg.session){
      const series=chart._chartWidget.model().mainSeries(),info=series.symbolInfo();
      if(!Array.isArray(info&&info.subsessions)||!info.subsessions.some(s=>s.id===cfg.session))
        throw Error(cfg.session+' session is not supported for this symbol');
      series.sessionIdProxyProperty().setValue(cfg.session);
      if(series.sessionId()!==cfg.session) throw Error(cfg.session+' session did not apply');
    }
    const setInputs=(id,inputs)=>{
      const study=chart.getStudyById(id),current=study.getInputValues(),known={};
      current.forEach((item,i)=>{known[item.id]=i;});
      for(const key of Object.keys(inputs)){
        const slot=key in known?known[key]:(key==='length'&&'in_0' in known?known.in_0:undefined);
        if(slot===undefined) throw Error('Unknown study input: '+key);
        current[slot].value=inputs[key];
      }
      study.setInputValues(current);
    };
    for(const id of cfg.remove_ids) chart.removeEntity(id);
    for(const item of cfg.configure) setInputs(item.id,item.inputs);
    const added=[];
    for(const spec of cfg.add){
      const before=chart.getAllStudies().map(s=>s.id);
      let id=null;
      try{id=await chart.createStudy(spec.name,false,false,[]);}catch(e){throw Error('Study was not created: '+spec.name);}
      for(let i=0;!id&&i<10;i++){await sleep(300);const n=chart.getAllStudies().find(s=>before.indexOf(s.id)===-1);if(n)id=n.id;}
      if(!id) throw Error('Study was not created: '+spec.name);
      if(Object.keys(spec.inputs).length) setInputs(id,spec.inputs);
      added.push(id);
    }
    let visible_range=null;
    if(cfg.visible_range){await chart.setVisibleRange(cfg.visible_range);await sleep(300);visible_range=chart.getVisibleRange();}
    return {added_ids:added,visible_range};
  })()`;
}

const samePane = (a, b) => JSON.stringify([a?.resolved_symbol, a?.resolution, a?.chart_session, a?.studies])
  === JSON.stringify([b?.resolved_symbol, b?.resolution, b?.chart_session, b?.studies]);

function compactPane(pane) {
  return pane && { resolved_symbol: pane.resolved_symbol, resolution: pane.resolution,
    chart_session: pane.chart_session ?? null, error: pane.error || undefined };
}

/**
 * operation=read: verified identity, registry entry, live pane, studies and visible range.
 * operation=update: one verified change to one pane, then verify, save, record.
 */
export async function workerChartControl({ operation = 'read', handle, slot, pane_index, dry_run = false, _deps = {}, ...change } = {}) {
  const state = (_deps.status || status)();
  const entry = state.entries.find(e => e.handle === handle);
  if (!entry || entry.assignment?.worker_slot !== slot || entry.assignment?.pane_index !== pane_index)
    throw new Error('handle, slot and pane_index must name the same registered worker pane (see worker_status)');
  const { owner, entries } = registeredWorkerTab(state, slot);
  if (entries[pane_index]?.handle !== handle) throw new Error('Worker topology does not place this handle at pane_index');
  if (operation !== 'read' && operation !== 'update') throw new Error('operation must be read or update');
  const validated = operation === 'update' ? validateChange(change) : null;
  const replaceEntry = _deps.replaceEntry || replaceWorkerEntry;

  const { target, client, read, evaluate } = await attachWorkerTarget(owner, _deps, 'Worker chart');
  try {
    const identity = await evaluate(`(()=>{const api=window.TradingViewApi;return {chart_id:api.layoutId(),pane_count:api.chartsCount()};})()`);
    if (identity?.chart_id !== owner.chart_id || identity?.pane_count !== owner.pane_count)
      throw new Error('Live worker layout identity does not match the registry');
    const before = await read();
    const studiesBefore = await evaluate(LIST_STUDIES(pane_index));
    const pending = pendingPaneIndexes(entries, before);
    const base = { success: true, operation, handle, slot, pane_index, chart_id: owner.chart_id,
      target_id: target.id, layout_name: owner.layout_name || null };

    if (operation === 'read') {
      const visible = await evaluate(`window.TradingViewApi.chart(${Number(pane_index)}).getVisibleRange()`);
      return { ...base, registry: { symbol: entry.symbol, timeframe: entry.timeframe, studies: entry.studies,
        groups: entry.groups, extended_hours: workerRequiresExtendedHours(entry) },
      live: { ...compactPane(before[pane_index]), studies: studiesBefore, visible_range: visible },
      matches_registry: paneMatchesEntry(entry, before[pane_index]), tab_pending_panes: pending };
    }

    if (pending.length) throw new Error('Worker tab has drifted panes ' + JSON.stringify(pending)
      + '; reconcile with worker_provision before changing it');
    const plan = planChange(entry, validated, studiesBefore);
    // Prove the registry accepts the change (no merge/handle clash) before touching the pane.
    replaceEntry({ handle, entry: plan.next, keepHandle: !plan.instrumentChanged,
      assignment: entry.assignment, _deps: { saveState() {} } });
    const report = { ...base, dry_run, handle_after: plan.instrumentChanged ? 'regenerated' : handle,
      groups: plan.next.groups, registry_after: plan.next, live_operations: plan.live };
    if (dry_run) return report;

    const before_state = JSON.stringify({ chart_id: owner.chart_id, pane_index, pane: compactPane(before[pane_index]), studies: studiesBefore });
    const fail = message => new Error(message + '. Registry unchanged; worker_provision restores the registered pane. Before: ' + before_state);
    const applied = await evaluate(applyExpression({ chart_id: owner.chart_id, pane_count: owner.pane_count,
      index: pane_index, ...plan.live }), 30_000).catch(error => { throw fail('Mutation failed: ' + error.message); });

    const nextEntry = { ...entry, ...plan.next };
    let after;
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await read();
      if (paneMatchesEntry(nextEntry, after[pane_index])) break;
      await (_deps.wait || (ms => new Promise(r => setTimeout(r, ms))))(250);
    }
    if (!paneMatchesEntry(nextEntry, after[pane_index])
        || (!plan.extended && after[pane_index]?.chart_session === 'extended'))
      throw fail('Pane verification failed: ' + JSON.stringify(compactPane(after[pane_index])));
    for (let i = 0; i < before.length; i++) {
      if (i !== pane_index && !samePane(before[i], after[i])) throw fail('Unrelated pane ' + i + ' changed');
    }
    const studiesAfter = await evaluate(LIST_STUDIES(pane_index));
    const byId = new Map(studiesAfter.map(s => [s.id, s]));
    const configured = new Set(plan.ops.configure.map(c => c.id));
    for (const s of studiesBefore) {
      const now = byId.get(s.id);
      if (plan.ops.remove_ids.includes(s.id)) { if (now) throw fail('Study ' + s.id + ' was not removed'); continue; }
      if (!now) throw fail('Untouched study ' + s.id + ' disappeared');
      if (!configured.has(s.id) && JSON.stringify(now.inputs) !== JSON.stringify(s.inputs)) throw fail('Untouched study ' + s.id + ' changed');
    }
    if (studiesAfter.length !== studiesBefore.length - plan.ops.remove_ids.length + plan.ops.add.length)
      throw fail('Unexpected study count after change');

    const tabEntries = entries.map((e, i) => i === pane_index ? nextEntry : e);
    await saveWorkerLayout(client, { chartId: owner.chart_id, entries: tabEntries, panes: after })
      .catch(error => { throw fail('Layout save failed: ' + error.message); });
    const recorded = replaceEntry({ handle, entry: plan.next, keepHandle: !plan.instrumentChanged,
      assignment: { ...entry.assignment, resolved_symbol: after[pane_index].resolved_symbol,
        resolution: after[pane_index].resolution, provisioned_at: new Date().toISOString() } });
    return { ...report, changed: true, persisted: true, handle_after: recorded.handle,
      live: { ...compactPane(after[pane_index]), studies: studiesAfter, visible_range: applied?.visible_range ?? null },
      note: recorded.handle !== handle
        ? 'Symbol/timeframe changed: consumers that pinned the old handle now get it as missing (fail closed), never another instrument.'
        : undefined };
  } finally {
    await client.close().catch(() => {});
  }
}
