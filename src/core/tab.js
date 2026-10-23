/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { setSymbol as setChartSymbol } from './chart.js';
import { getClient, getTargetInfo, reconnectTo, CDP_HOST, CDP_PORT, listCdpTargets } from '../connection.js';

const LANDING_PROBE_TIMEOUT_MS = 500;
const SHELL_OPERATION_TIMEOUT_MS = 6000;
const CHART_PROBE_TIMEOUT_MS = 750;
const NEW_TAB_URL_RE = /app\.asar\/app\/new-tab\/index\.html/i;
const SHELL_TITLE_RE = /^tabbed-window$/i;
const SHELL_URL_RE = /\/window\/index\.html/i;

export async function withDeadline(promise, timeoutMs, label = 'Operation') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms < 0) throw new Error('timeoutMs must be a non-negative number');
  if (ms === 0) return promise;

  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * List all open chart tabs (CDP page targets).
 */
export function isChartPageTarget(target) {
  if (!target || target.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    const hostname = url.hostname.toLowerCase();
    const isTradingView = hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com');
    return isTradingView && url.pathname.toLowerCase().startsWith('/chart');
  } catch {
    return false;
  }
}

export function isNewTabPageTarget(target) {
  return target?.type === 'page' && NEW_TAB_URL_RE.test(String(target.url || ''));
}

function isShellTarget(target) {
  if (target?.type !== 'page') return false;
  if (SHELL_TITLE_RE.test(String(target.title || ''))) return true;
  // New-tab and tooltip query strings also identify their tabbed-window owner.
  try { return SHELL_URL_RE.test(new URL(String(target.url || '')).pathname); }
  catch { return false; }
}

export function rankShellCandidates(targets) {
  return (targets || [])
    .filter(isShellTarget)
    .map((target, index) => {
      const title = String(target.title || '');
      const url = String(target.url || '');
      const score =
        (SHELL_TITLE_RE.test(title) ? 100 : 0)
        + (/tabbed-window/i.test(url) ? 50 : 0)
        + (SHELL_URL_RE.test(url) ? 10 : 0);
      return { target, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.target);
}

export function isReusableWorkerBootstrapTarget(target) {
  if (!target || target.type !== 'page' || isChartPageTarget(target) || isShellTarget(target)) {
    return false;
  }
  if (isNewTabPageTarget(target)) return true;
  try {
    const url = new URL(String(target.url || ''));
    const hostname = url.hostname.toLowerCase();
    const isTradingView = hostname === 'tradingview.com' || hostname.endsWith('.tradingview.com');
    return isTradingView && url.pathname === '/';
  } catch {
    return false;
  }
}

export function rankReusableWorkerBootstrapCandidates(targets) {
  return (targets || [])
    .filter(isReusableWorkerBootstrapTarget)
    .map((target, index) => ({
      target,
      index,
      knownNewTab: isNewTabPageTarget(target),
      homepage: (() => {
        try {
          const url = new URL(String(target.url || ''));
          return url.pathname === '/';
        } catch {
          return false;
        }
      })(),
    }))
    .sort((a, b) =>
      Number(b.knownNewTab) - Number(a.knownNewTab)
      || Number(b.homepage) - Number(a.homepage)
      || a.index - b.index
    )
    .map(item => item.target);
}

export function rankLandingCandidates(targets, beforeIds = []) {
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds);
  return (targets || [])
    .filter(target => target?.type === 'page' && !isChartPageTarget(target) && !isShellTarget(target))
    .map((target, index) => ({
      target,
      index,
      isNew: !before.has(target.id),
      knownNewTab: isNewTabPageTarget(target),
      titleHint: /^new tab$/i.test(String(target.title || '').trim()),
    }))
    .sort((a, b) =>
      Number(b.isNew) - Number(a.isNew)
      || Number(b.knownNewTab) - Number(a.knownNewTab)
      || Number(b.titleHint) - Number(a.titleHint)
      || a.index - b.index
    )
    .map(item => item.target);
}

/** Stable identity is the chart URL token; CDP target IDs rotate on restart. */
export function selectExactChartTarget(targets, chartId) {
  const token = String(chartId || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error('chart_id must be an exact TradingView chart URL token');
  }
  const matching = (targets || []).filter(target =>
    isChartPageTarget(target)
    && target.url.match(/\/chart\/([^/?]+)/i)?.[1] === token
  );
  if (matching.length !== 1) {
    throw new Error(matching.length
      ? 'Multiple CDP targets expose chart ' + token + '; refusing ambiguous attachment.'
      : 'No live CDP target for chart ' + token + '. Open the layout in Desktop first.');
  }
  return matching[0];
}

/** Attach subsequent chart/indicator tools to one exact chart without altering
 * the physical tab bar, layout state, worker panes, or saved changes. */
export async function attachChart({ chart_id, _deps } = {}) {
  const deps = {
    listTargets: _deps?.listTargets || listCdpTargets,
    reconnect: _deps?.reconnect || reconnectTo,
    current: _deps?.current || getTargetInfo,
  };
  const target = selectExactChartTarget(await deps.listTargets(), chart_id);
  await deps.reconnect(target.id);
  const attached = await deps.current();
  if (String(attached?.id || '') !== String(target.id)) {
    throw new Error('CDP attachment verification failed for chart ' + chart_id);
  }
  return {
    success: true,
    action: 'chart_target_attached',
    chart_id: String(chart_id),
    target_id: target.id,
    visually_switched: false,
    verified: true,
  };
}


/** Shell-tab IDs identify physical Desktop tabs, not saved layouts or CDP targets.
 * Rediscover them at every call, especially after a Desktop restart. */
export async function listShellTabs({ _deps } = {}) {
  const shell = _deps?.withShell || withShell;
  const result = await shell(evalIn => evalIn(
    "(function() { return Array.from(document.querySelectorAll('.tabs-container .tab')).map((tab,index) => {" +
    "const k=Object.keys(tab).find(x=>x.indexOf('__reactFiber')===0);let f=k?tab[k]:null;let name=null;" +
    "for(let n=0;f&&n<8;n++,f=f.return){const v=f.stateNode?.state?.title?.name;" +
    "if(typeof v==='string'&&v.trim()){name=v.trim();break;}}" +
    "return {index,shell_tab_id:tab.id||null,layout_name:name,active:tab.classList.contains('active')," +
    "label:String(tab.textContent||'').trim().slice(0,120)};}); })()"
  ));
  if (!Array.isArray(result)) throw new Error('Desktop shell tab listing unavailable.');
  const ids = result.map(x => x.shell_tab_id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new Error('Desktop shell returned missing or duplicated tab identities.');
  }
  return result;
}

function requireShellTab(tabs, shell_tab_id, expected_layout_name) {
  const id = String(shell_tab_id || '').trim();
  if (!id) throw new Error('shell_tab_id required; refresh tab_list.');
  const found = tabs.find(row => row.shell_tab_id === id);
  if (!found) throw new Error('Stale shell_tab_id; refresh tab_list after restart.');
  const tab = {...found};
  const expected = String(expected_layout_name || '').trim();
  if (expected && tab.layout_name !== expected) {
    // TradingView Desktop sometimes omits React layout state on duplicated
    // tabs. The exact shell-tab id is still available; allow an explicit
    // expected layout only if the visible label ends with that full name.
    const normalizedLabel = String(tab.label || '').replace(/\s+/g, ' ').trim();
    const labelMatches = expected === 'New tab'
      ? normalizedLabel === 'New tab'
      : normalizedLabel.endsWith(' ' + expected);
    if (tab.layout_name !== null || !labelMatches) {
      throw new Error('Layout name changed; refresh tab_list.');
    }
    tab.layout_name = expected;
  }
  return tab;
}

export async function switchShellTab({ shell_tab_id, expected_layout_name, _deps } = {}) {
  const shell = _deps?.withShell || withShell;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const tab = requireShellTab(
    await listShellTabs({ _deps: {withShell:shell} }), shell_tab_id, expected_layout_name
  );
  await shell(evalIn => selectShellTab(evalIn, tab.shell_tab_id, wait));
  return {
    success:true, action:'desktop_shell_tab_switched',
    shell_tab_id:tab.shell_tab_id, layout_name:tab.layout_name, visually_switched:true,
    attachment_required:true,
    note:'Use tab_attach with current target_id from tab_list to select a chart for edits.',
  };
}

export async function closeShellTabById({
  shell_tab_id, expected_layout_name, protected_layout_names = [],
  discard_unsaved_changes = false, _deps,
} = {}) {
  const shell = _deps?.withShell || withShell;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const tabs = await listShellTabs({ _deps: {withShell:shell} });
  if (tabs.length <= 1) throw new Error('Cannot close the last Desktop tab.');
  const tab = requireShellTab(tabs, shell_tab_id, expected_layout_name);
  if (!tab.layout_name) throw new Error('Layout identity missing; refusing shell-only close.');
  const owned = new Set(protected_layout_names.map(x => String(x || '').trim()));
  if (owned.has(tab.layout_name) || /^DTV (?:Market|Worker)\b/i.test(tab.layout_name)) {
    throw new Error('Refusing to close a DTV worker-owned layout.');
  }
  return shell(async evalIn => {
    const id = JSON.stringify(tab.shell_tab_id);
    const readName = "()=>{const tab=document.getElementById("+id+");" +
      "if(!tab||!tab.matches('.tabs-container .tab'))return null;" +
      "const k=Object.keys(tab).find(x=>x.indexOf('__reactFiber')===0);" +
      "let f=k?tab[k]:null;for(let n=0;f&&n<8;n++,f=f.return){" +
      "const v=f.stateNode?.state?.title?.name;if(typeof v==='string'&&v.trim())return v.trim();}" +
      "return null;}";
    const fresh = await evalIn("(function(){const tab=document.getElementById("+id+");" +
      "if(!tab||!tab.matches('.tabs-container .tab'))return null;" +
      "return {name:("+readName+")(),label:String(tab.textContent||'').replace(/\\s+/g,' ').trim()};})()");
    if (!fresh || !(fresh.name === tab.layout_name ||
      (fresh.name === null &&
        (fresh.label.endsWith(' ' + tab.layout_name) ||
          (tab.layout_name === 'New tab' && fresh.label === 'New tab'))))) {
      throw new Error('Shell layout identity changed before close.');
    }
    await selectShellTab(evalIn, tab.shell_tab_id, wait);
    const snapshot=_deps?.closeTargetSnapshot
      ? await _deps.closeTargetSnapshot() : _deps?.withShell ? [] : await listCdpTargets();
    const baselineIds=snapshot.map(t=>String(t.id));
    const externalProbe=_deps?.probeExternalDialogs ||
      (_deps?.withShell ? null : probeDesktopCloseDialogs);
    const externalClick=_deps?.clickExternalDialog ||
      (_deps?.withShell ? null : clickDesktopCloseDialog);
    const clicked = await evalIn("(function(){const tab=document.getElementById("+id+");" +
      "if(!tab||!tab.matches('.tabs-container .tab'))return false;" +
      "const close=tab.querySelector('.tab-close-button-container button, [class*=close] button, button[class*=close]');" +
      "if(!close)return false;" +
      "const k=Object.keys(close).find(x=>x.indexOf('__reactProps')===0);" +
      "if(k&&typeof close[k].onClick==='function'){" +
      "close[k].onClick({button:0,preventDefault(){},stopPropagation(){},currentTarget:close,target:close});" +
      "}else close.click();return true;})()");
    if (!clicked) throw new Error('Exact Desktop tab close button not available.');
    let confirmationHandled = false;
    let lastDialogProbe = null;
    for (let n=0;n<30;n++) {
      if (!await evalIn("!!document.getElementById("+id+")")) {
        return {success:true,action:'desktop_shell_tab_closed',
          shell_tab_id:tab.shell_tab_id,layout_name:tab.layout_name,
          discarded_unsaved_changes:confirmationHandled};
      }
      // An explicit opt-in is necessary to discard unsaved chart changes.
      const confirmation = await evalIn(`(function(){
        if(document.querySelector('.tabs-container .tab.active')?.id!==${id})
          return {kind:'active_tab_changed'};
        const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0};
        const dialogs=Array.from(document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="modal"]'
        )).filter(visible);
        // Visible Desktop popovers need not have a dialog/modal class.
        // Verify the exact discard control within a local confirmation ancestor.
        const discard=Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(el=>visible(el)&&String(el.textContent||'').trim()==='Close without saving');
        if(discard.length>1)return {kind:'ambiguous'};
        const hasText=el=>/close tab\\?/i.test(String(el.textContent||'')) &&
          /unsaved changes/i.test(String(el.textContent||''));
        let verified=null;
        if(discard.length===1){
          let ancestor=discard[0].parentElement;
          for(let depth=0;ancestor&&depth<12;depth++,ancestor=ancestor.parentElement){
            const text=String(ancestor.textContent||'');
            if(text.length>3000)break;
            if(hasText(ancestor)){verified=discard[0];break;}
          }
        }
        if(!verified){
          const exactDialogs=dialogs.filter(hasText);
          return {kind:exactDialogs.length>1?'ambiguous':'none',
            visible_discard_button:discard.length===1,
            shell_has_heading:/close tab\\?/i.test(String(document.body?.innerText||'')),
            shell_has_warning:/unsaved changes/i.test(String(document.body?.innerText||''))};
        }
        if(!${discard_unsaved_changes ? 'true' : 'false'})return {kind:'unsaved_confirmation'};
        const button=verified,key=Object.keys(button).find(k=>k.startsWith('__reactProps'));
        if(key&&typeof button[key].onClick==='function'){
          button[key].onClick({button:0,preventDefault(){},stopPropagation(){},
            currentTarget:button,target:button});
        }else button.click();
        return {kind:'discard_clicked'};
      })()`);
      lastDialogProbe = confirmation;
      if(confirmation?.kind==='none' && externalProbe && (n===3 || n===11 || n===21)){
        const external=await externalProbe({baseline_ids:baselineIds});
        lastDialogProbe={...confirmation,external:{
          inspected:external.inspected,matches:external.matches.length,
          desktop_target_count:external.desktop_target_count,
          other_target_types:external.other_target_types}};
        if(external.matches.length>1)
          throw new Error('Multiple Electron confirmation targets; refusing ambiguous close.');
        if(external.matches.length===1){
          const match=external.matches[0];
          if(!match.new_since_close)throw new Error('Stale Desktop dialog target; refusing close.');
          const stillActive=await evalIn(
            "document.querySelector('.tabs-container .tab.active')?.id==="+id+
            " && !!document.getElementById("+id+")");
          if(!stillActive)throw new Error('Physical tab changed during dialog discovery.');
          if(!discard_unsaved_changes)
            throw new Error('Unsaved chart confirmation is in a separate Electron target. Explicit discard required.');
          const acted=await externalClick(match.target_id);
          if(!acted?.matched||!acted?.clicked)
            throw new Error('Desktop dialog changed before the explicit click.');
          confirmationHandled=true;
        }
      }
      if (confirmation?.kind==='active_tab_changed')
        throw new Error('Active Desktop tab changed during close; refusing to proceed.');
      if (confirmation?.kind==='unsaved_confirmation')
        throw new Error('TradingView has unsaved chart changes. Set discard_unsaved_changes=true only to discard the exact tab.');
      if (confirmation?.kind==='ambiguous' ||
          confirmation?.kind==='confirmation_without_exact_button')
        throw new Error('Ambiguous unsaved-changes confirmation; manual close required.');
      if (confirmation?.kind==='discard_clicked') confirmationHandled=true;
      await wait(100);
    }
    throw new Error('Exact Desktop tab remains open after close request; dialog probe: '+JSON.stringify(lastDialogProbe));
  });
}



/**
 * Exact physical shell cleanup for a worker renderer which was already retired.
 * Worker ownership and the retired renderer's original pane symbol must be
 * independently validated by the higher-level worker reconciliation gate.
 * This function NEVER permits a generic worker tab close.
 */
export async function closeRetiredWorkerShell({
  shell_tab_id, live_shell_tab_id, expected_layout_name,
  retired_symbol, retained_symbol, _deps,
} = {}) {
  const shell = _deps?.withShell || withShell;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const list = _deps?.listShellTabs || (()=>listShellTabs({_deps:{withShell:shell}}));
  const name = String(expected_layout_name || '').trim();
  if (!/^DTV (?:Worker|Market) \d{2}$/i.test(name)) {
    throw new Error('Expected a registered worker layout identity.');
  }
  const oldSymbol = String(retired_symbol||'').trim();
  const keepSymbol = String(retained_symbol||'').trim();
  if (!oldSymbol || !keepSymbol || oldSymbol===keepSymbol) {
    throw new Error('Retired and retained symbol witnesses must be distinct.');
  }
  const oldId = String(shell_tab_id||'').trim();
  const keepId = String(live_shell_tab_id||'').trim();
  if (!oldId || !keepId || oldId===keepId) {
    throw new Error('Two distinct exact physical shell IDs required.');
  }
  const tabs = await list();
  const matching = tabs.filter(t=>t.layout_name===name);
  if (matching.length !== 2) {
    throw new Error('Expected exactly two physical tabs for worker layout.');
  }
  const gone = matching.find(t=>t.shell_tab_id===oldId);
  const retained = matching.find(t=>t.shell_tab_id===keepId);
  const begins = (label,symbol)=>{
    const value=String(label||'').trim();
    if (!value.startsWith(symbol)) return false;
    const next=value.slice(symbol.length, symbol.length+1);
    return next===''||next===' '||next==='▲'||next==='▼'||next==='↗'||next==='↘';
  };
  if (!gone || !retained || !begins(gone.label,oldSymbol) ||
      !begins(retained.label,keepSymbol)) {
    throw new Error('Physical worker shell symbol witness changed.');
  }
  if (gone.active) {
    throw new Error('Refusing to close an active worker shell tab.');
  }
  const original = tabs.find(t=>t.active)?.shell_tab_id || null;
  return shell(async evalIn => {
    const id = JSON.stringify(oldId);
    const other = JSON.stringify(keepId);
    const found = await evalIn('(function(){' +
      "const a=document.getElementById("+id+");" +
      "const b=document.getElementById("+other+");" +
      "if(!a||!b||!a.matches('.tabs-container .tab')||!b.matches('.tabs-container .tab'))return null;" +
      "const title=tab=>{const k=Object.keys(tab).find(x=>x.indexOf('__reactFiber')===0);" +
      "let f=k?tab[k]:null;for(let n=0;f&&n<8;n++,f=f.return){" +
      "const x=f.stateNode?.state?.title?.name;if(typeof x==='string'&&x.trim())return x.trim();}" +
      "return null;};" +
      "return {oldLabel:String(a.textContent||'').trim(),liveLabel:String(b.textContent||'').trim()," +
      "oldName:title(a),liveName:title(b),oldActive:a.classList.contains('active')};" +
      '})()');
    if (!found || found.oldName!==name || found.liveName!==name ||
        found.oldActive || !begins(found.oldLabel,oldSymbol) ||
        !begins(found.liveLabel,keepSymbol)) {
      throw new Error('Worker shell proof changed during pre-close revalidation.');
    }
    const clicked = await evalIn('(function(){' +
      "const tab=document.getElementById("+id+");" +
      "if(!tab||tab.classList.contains('active'))return false;" +
      "const close=tab.querySelector('.tab-close-button-container button, [class*=close] button, button[class*=close]');" +
      'if(!close)return false;' +
      "const key=Object.keys(close).find(x=>x.indexOf('__reactProps')===0);" +
      'if(key&&typeof close[key]?.onClick==="function"){' +
      'close[key].onClick({button:0,preventDefault(){},stopPropagation(){},currentTarget:close,target:close});}' +
      'else close.click(); return true;})()');
    if (!clicked) throw new Error('Exact non-active orphan shell close control unavailable.');
    let closed=false;
    for(let i=0;i<20;i++){
      if(!await evalIn("!!document.getElementById("+id+")")){closed=true;break;}
      await wait(100);
    }
    if(!closed)throw new Error('Orphan physical shell tab remained open.');
    const registeredRemains=await evalIn("!!document.getElementById("+other+")");
    if(!registeredRemains)throw new Error('Registered worker physical shell disappeared unexpectedly.');
    if(original && original!==oldId) {
      const sameActive = await evalIn(
        "document.querySelector('.tabs-container .tab.active')?.id === "+
        JSON.stringify(original)
      );
      if(!sameActive && await evalIn("!!document.getElementById("+JSON.stringify(original)+")")) {
        await selectShellTab(evalIn,original,wait);
      }
    }
    return {success:true,action:'retired_worker_shell_closed',shell_tab_id:oldId,
      registered_shell_tab_id:keepId,registered_shell_preserved:true};
  });
}

/**
 * Inspect physical shell-to-CDP relationships without touching chart state.
 * The only UI action is visual tab selection; the original tab is restored.
 * Electron can report unreliable background visibility, so never claim a
 * mapping unless every repeated observation distinguishes exactly one target.
 */
export function rankShellRendererWitnesses(samples, shellIds, targetIds) {
  const observations = new Map();
  for (const shellId of shellIds) {
    const found = samples.filter(sample => sample.shell_tab_id === shellId);
    if (found.length < 2) return {confirmed:false, reason:'insufficient_repeated_samples', by_shell:[]};
    const candidates = targetIds.filter(id => found.every(sample => {
      const state = sample.targets.find(row => row.target_id === id);
      return state?.visibility === 'visible' && state.focused === true;
    }));
    if (candidates.length !== 1) {
      return {confirmed:false,reason:'no_unique_focused_renderer',by_shell:[]};
    }
    observations.set(shellId, candidates[0]);
  }
  if (new Set(observations.values()).size !== shellIds.length) {
    return {confirmed:false,reason:'renderer_not_distinct_per_shell',by_shell:[]};
  }
  // Any renderer claimed by one shell must not also look focused on another.
  for (const [shellId,targetId] of observations) {
    for (const sample of samples) {
      if (sample.shell_tab_id === shellId) continue;
      const other = sample.targets.find(row => row.target_id === targetId);
      if (other?.visibility === 'visible' && other.focused === true) {
        return {confirmed:false,reason:'ambiguous_cross_shell_focus',by_shell:[]};
      }
    }
  }
  return {
    confirmed:true,reason:'repeated_unique_focus_visibility',
    by_shell:[...observations.entries()].map(([shell_tab_id,target_id])=>({shell_tab_id,target_id})),
  };
}

export async function probeShellRendererCorrespondence({
  shell_tab_ids = [], target_ids = [], _deps,
} = {}) {
  const ids = [...new Set(shell_tab_ids.map(String))];
  const targetsWanted = [...new Set(target_ids.map(String))];
  if (ids.length < 2 || ids.length > 4 || targetsWanted.length < 2 || targetsWanted.length > 8) {
    throw new Error('Probe requires 2-4 physical shell IDs and 2-8 renderer IDs.');
  }
  const tabs = await (_deps?.listShellTabs || listShellTabs)();
  const current = await (_deps?.listTargets || listCdpTargets)();
  const active = tabs.find(tab => tab.active)?.shell_tab_id;
  if (!active) throw new Error('No unique active Desktop shell tab to restore.');
  for (const id of ids) {
    if (!tabs.some(tab => tab.shell_tab_id === id)) {
      throw new Error('Unknown shell_tab_id: refresh tab_list.');
    }
  }
  for (const id of targetsWanted) {
    if (!current.some(row => row.id === id && isChartPageTarget(row))) {
      throw new Error('Unknown or stale chart target_id: refresh tab_list.');
    }
  }
  const shell = _deps?.withShell || withShell;
  const probeTarget = _deps?.probeTarget || (id => withTarget(id, evalIn => evalIn(
    "({visibility:document.visibilityState,focused:document.hasFocus()," +
    "title:String(document.title||'').slice(0,100),url:location.href})"
  ), 1500));
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve,ms)));
  const samples = [];
  let restoreError = null;
  try {
    // Two full cycles, verifying repeatability without relying on cached IDs.
    for (let pass=0;pass<2;pass++) {
      for (const id of ids) {
        await shell(evalIn => selectShellTab(evalIn, id, wait));
        await wait(180);
        const targetStates = await Promise.all(targetsWanted.map(async target_id => {
          try { return {target_id,...await probeTarget(target_id)}; }
          catch(error){return {target_id,error:String(error?.message || error).slice(0,100)};}
        }));
        samples.push({pass,shell_tab_id:id,targets:targetStates});
      }
    }
  } finally {
    try { await shell(evalIn => selectShellTab(evalIn, active, wait)); }
    catch(error){restoreError = String(error?.message || error);}
  }
  const witness = restoreError
    ? {confirmed:false,reason:'could_not_restore_active_shell',by_shell:[]}
    : rankShellRendererWitnesses(samples,ids,targetsWanted);
  return {
    success:true,read_only_chart_state:true,
    original_active_shell_tab_id:active,restored:!restoreError,
    restore_error:restoreError,
    witness,samples,
    caution:'A single visibility or title result does not prove identity; never close a worker by guessing.',
  };
}


/** Strictly read-only inspection of Electron shell tab metadata for stale-tab troubleshooting. */
export async function inspectShellTabMetadata({ shell_tab_ids = [], _deps } = {}) {
  const ids = [...new Set((shell_tab_ids || []).map(String))];
  if (!ids.length || ids.length > 4) throw new Error('Choose between 1 and 4 exact shell tab IDs.');
  const shellTabs = await (_deps?.listShellTabs || listShellTabs)();
  if (ids.some(id => !shellTabs.some(t => t.shell_tab_id === id))) {
    throw new Error('Unknown shell tab identity; refresh tab_list.');
  }
  const shell = _deps?.withShell || withShell;
  return shell(evalIn => evalIn('(function(){const wanted=new Set(' + JSON.stringify(ids) + ');' +
    "const tabs=Array.from(document.querySelectorAll('.tabs-container .tab'));" +
    'return tabs.filter(t=>wanted.has(t.id)).map(tab=>{' +
    "const reactPropsKey=Object.keys(tab).find(k=>k.indexOf('__reactProps')===0);" +
    "const props=reactPropsKey?tab[reactPropsKey]||{}:{};" +
    "const fiberKey=Object.keys(tab).find(k=>k.indexOf('__reactFiber')===0);" +
    'let fiber=fiberKey?tab[fiberKey]:null;const ancestors=[];' +
    'const describe=obj=>{if(!obj||typeof obj!=="object")return null;' +
    "const keys=Object.keys(obj).slice(0,65);" +
    'const primitive={};for(const key of keys){' +
    'if(!/^(id|tabId|viewId|webContentsId|name|title|url|label|active|isActive|isReady|isLoading|status|loading|symbol|key|type)$/i.test(key))continue;' +
    'try{const v=obj[key];if(["string","number","boolean"].includes(typeof v))primitive[key]=String(v).slice(0,100);}catch{}}' +
    'return {keys,primitive};};' +
    'for(let i=0;fiber&&i<7;i++,fiber=fiber.return){' +
    'const node=fiber.stateNode;ancestors.push({' +
    'elementType:String(fiber.elementType?.displayName||fiber.elementType?.name||fiber.elementType||"").slice(0,70),' +
    'tag:fiber.tag,props:describe(fiber.memoizedProps),state:describe(node?.state),' +
    'memoizedState:describe(fiber.memoizedState),' +
    'title:describe(node?.state?.title),' +
    'tabStoreKind:Array.isArray(node?.state?.tabs)?"array":typeof node?.state?.tabs,' +
    'tabStoreEntries:Array.isArray(node?.state?.tabs)?node.state.tabs.filter(entry=>' +
    'wanted.has(String(entry?.id||entry?.tabId||entry?.tab_id||""))).slice(0,4).map(entry=>({' +
    'fields:describe(entry),keyFields:describe(entry?.data),' +
    'title:describe(entry?.title),location:describe(entry?.location)' +
    '})):[],' +
    '});}' +
    'return {shell_tab_id:tab.id,label:String(tab.textContent||"").slice(0,100),' +
    'attributes:Array.from(tab.attributes||[]).map(a=>[a.name,String(a.value).slice(0,90)]).slice(0,12),' +
    'dom_props:describe(props),react_ancestors:ancestors};' +
    '});})()'));
}

/** Exact live CDP target attachment handles duplicate chart/layout IDs. */
export async function attachChartTarget({ target_id, _deps } = {}) {
  const id = String(target_id || '').trim();
  const listTargets = _deps?.listTargets || listCdpTargets;
  const reconnect = _deps?.reconnect || reconnectTo;
  const current = _deps?.current || getTargetInfo;
  const target = (await listTargets()).find(row => String(row.id) === id);
  if (!isChartPageTarget(target)) throw new Error('Stale/non-chart target; refresh tab_list.');
  await reconnect(id);
  if (String((await current())?.id) !== id) {
    throw new Error('CDP target attachment verification failed.');
  }
  return {success:true,action:'chart_target_attached',target_id:id,
    chart_id:target.url.match(/\/chart\/([^/?]+)/i)?.[1] || null,
    visually_switched:false,verified:true};
}

/**
 * List open chart tabs and any currently discoverable layout-picker tab.
 */
export async function list() {
  const targets = await listCdpTargets();
  const candidates = rankLandingCandidates(targets);

  // Never let one stale/non-responsive Electron page target block tab_list.
  // Probe candidates concurrently and fail closed on each bounded probe.
  const probeResults = await Promise.all(
    candidates.map(async candidate => ({
      id: candidate.id,
      isLanding: isNewTabPageTarget(candidate)
        ? true
        : await probeLandingTarget(candidate, LANDING_PROBE_TIMEOUT_MS),
    })),
  );
  const landingIds = new Set(
    probeResults.filter(item => item.isLanding).map(item => item.id),
  );

  const tabs = targets
    .filter(target => isChartPageTarget(target) || landingIds.has(target.id))
    .map((target, i) => ({
      index: i,
      id: target.id,
      title: String(target.title || '').replace(/^Live stock.*charts on /, ''),
      url: target.url,
      chart_id: isChartPageTarget(target) ? target.url.match(/\/chart\/([^/?]+)/)?.[1] || null : null,
      is_chart: isChartPageTarget(target),
    }));

  let shellTabs = [], shellError = null;
  try { shellTabs = await listShellTabs(); }
  catch (error) { shellError = error?.message || String(error); }
  return {
    success: true,
    tab_count: tabs.length,
    tabs,
    shell_tabs: shellTabs,
    shell_tab_count: shellTabs.length,
    shell_identity_note: 'Rediscover shell_tab_id and target_id after restart. chart_id is a shared saved layout.',
    ...(shellError ? {shell_discovery_error:shellError} : {}),
    discovery: {
      candidate_count: candidates.length,
      landing_count: landingIds.size,
      probe_timeout_ms: LANDING_PROBE_TIMEOUT_MS,
    },
  };
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
export async function withShell(fn, { listTargets = listCdpTargets, connectTarget = withTarget } = {}) {
  const targets = await listTargets();
  const candidates = rankShellCandidates(targets);

  const failures = [];
  for (const cand of candidates) {
    let shellVerified = false;
    try {
      const result = await connectTarget(cand.id, async evalIn => {
        const hasTabs = await evalIn(`!!document.querySelector('.tabs-container .tab')`);
        if (!hasTabs) return { matched: false, value: null };
        shellVerified = true;
        return { matched: true, value: await fn(evalIn) };
      }, SHELL_OPERATION_TIMEOUT_MS);
      if (result?.matched) return result.value;
    } catch (error) {
      // Surface the real operation error once the tabbed shell is verified.
      if (shellVerified) throw error;
      failures.push({target_id:cand.id,error:error?.message || String(error)});
    }
  }

  const detail = failures.length
    ? ' Probe failures: ' + JSON.stringify(failures)
    : '';
  throw new Error(
    'TradingView tabbed-window shell target not found within bounded probes. Is this TradingView Desktop with tabs?' +
    detail,
  );
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(targetId) {
  try {
    return await withTarget(
      targetId,
      evalIn => evalIn('document.visibilityState').then(value => value === 'visible'),
      CHART_PROBE_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}

async function probeLandingTarget(target, timeoutMs = LANDING_PROBE_TIMEOUT_MS) {
  if (!target || isChartPageTarget(target) || isShellTarget(target)) return false;
  if (isNewTabPageTarget(target)) return true;
  try {
    return await withTarget(target.id, evalIn => evalIn(`
      (function() {
        return !!(
          document.querySelector('.create-new-layout-button')
          || document.querySelector('.layout-list-item')
          || document.querySelector('.layout-list-expand-button')
          || document.querySelector('[class*="layout-list"]')
        );
      })()
    `), timeoutMs);
  } catch {
    return false;
  }
}

/**
 * Discover a layout-picker target by DOM capability, not by a single title.
 * Newly-created page targets are checked first, then existing candidates.
 */

/** Scan only local TradingView Desktop Electron UI targets. Never inspect
 * arbitrary web pages for a privileged close confirmation. */
export function isDesktopUiTarget(t) {
  if(!t || !['page','other'].includes(t.type))return false;
  try {
    const u=new URL(String(t.url||''));
    return u.protocol==='file:' &&
      /(?:\/app\.asar\/app\/|\/app\/(?:window|dialog|modal|popup)\/)/i.test(u.pathname);
  }catch{return false;}
}
export function closeDialogExpression({click=false}={}) {
  return '(function(){'+
    "const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};"+
    "const buttons=Array.from(document.querySelectorAll('button,[role=\"button\"]'))"+
      ".filter(e=>visible(e)&&String(e.textContent||'').trim()==='Close without saving');"+
    "if(buttons.length!==1)return {matched:false,buttons:buttons.length};"+
    "let p=buttons[0].parentElement,ok=false;"+
    "for(let i=0;p&&i<12;i++,p=p.parentElement){const t=String(p.textContent||'');"+
      "if(t.length>3000)break;"+
      "if(/close tab\\?/i.test(t)&&/unsaved changes/i.test(t)){ok=true;break;}}"+
    "if(!ok)return {matched:false,buttons:1};"+
    (click?
      "const b=buttons[0],k=Object.keys(b).find(x=>x.startsWith('__reactProps'));"+
      "if(k&&typeof b[k].onClick==='function')b[k].onClick({button:0,preventDefault(){},stopPropagation(){},currentTarget:b,target:b});"+
      "else b.click();return {matched:true,clicked:true};":
      "return {matched:true,clicked:false};")+
    '})()';
}
export async function probeDesktopCloseDialogs({baseline_ids=[],include_existing=false,_deps}={}) {
  const list=_deps?.listTargets||listCdpTargets;
  const evaluate=_deps?.evaluateTarget||((id,expr)=>withTarget(id,fn=>fn(expr),900));
  const previous=new Set(baseline_ids.map(String));
  const all=await list();
  const own=all.filter(isDesktopUiTarget);
  const candidates=(include_existing?own:own.filter(t=>!previous.has(String(t.id)))).slice(0,16);
  const inspected=await Promise.all(candidates.map(async t=>{
    try{
      const result=await evaluate(t.id,closeDialogExpression());
      return {target_id:t.id,new_since_close:!previous.has(String(t.id)),
        matched:result?.matched===true,buttons:result?.buttons??null};
    }catch(e){
      return {target_id:t.id,new_since_close:!previous.has(String(t.id)),
        matched:false,error:String(e?.message||e).slice(0,120)};
    }
  }));
  return {desktop_target_count:own.length,inspected:inspected.length,
    matches:inspected.filter(x=>x.matched),candidates:inspected,
    other_target_types:all.filter(t=>!isDesktopUiTarget(t)&&!isChartPageTarget(t))
      .slice(0,15).map(t=>({type:t.type,
        scheme:(()=>{try{return new URL(String(t.url||'')).protocol}catch{return 'unknown'}})()}))};
}
async function clickDesktopCloseDialog(id,{_deps}={}) {
  const evaluate=_deps?.evaluateTarget||((target,expr)=>withTarget(target,fn=>fn(expr),1200));
  return evaluate(id,closeDialogExpression({click:true}));
}


/** Read-only bounded diagnostics for new-layout naming. No form values read. */
export function layoutCreateProbeExpression() {
  return `(function(){
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
    const buttons=Array.from(document.querySelectorAll('button,[role="button"]'));
    const exact=buttons.filter(b=>visible(b)&&
      /^(Create new layout|Create|New layout)$/i.test(String(b.textContent||'').trim()));
    const inputs=Array.from(document.querySelectorAll('input')).map(e=>({
      placeholder:String(e.getAttribute('placeholder')||'').slice(0,80),
      aria_label:String(e.getAttribute('aria-label')||'').slice(0,80),
      visible:visible(e),
      type:String(e.getAttribute('type')||'').slice(0,30),
    }));
    const dialogs=Array.from(document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="modal"]'))
      .filter(visible);
    const text=String(document.body?.innerText||'');
    const b=document.querySelector('.create-new-layout-button');
    return {
      is_landing:!!(b||document.querySelector('.layout-list-item')||
        document.querySelector('.layout-list-expand-button')),
      create_new_layout_selector:!!b,
      create_new_layout_visible:!!(b&&visible(b)),
      exact_create_buttons:exact.map(b=>({
        text:String(b.textContent||'').trim().slice(0,50),
        disabled:!!b.disabled,
      })).slice(0,8),
      inputs:inputs.slice(0,12),
      modal_count:dialogs.length,
      naming_input_visible:Array.from(document.querySelectorAll(
        'input[placeholder="My layout"],input[aria-label="Layout name"]')).some(visible),
      has_create_heading:/create new layout/i.test(text),
      body_has_unsaved_warning:/unsaved changes/i.test(text),
    };
  })()`;
}

export async function probeLayoutCreateUi({_deps}={}) {
  const listTargets=_deps?.listTargets||listCdpTargets;
  const inspect=_deps?.evaluateTarget||((target,expression)=>
    withTarget(target,evalIn=>evalIn(expression),1200));
  const targets=await listTargets();
  const candidates=targets.filter(t=>
    isDesktopUiTarget(t)||isNewTabPageTarget(t)).slice(0,20);
  const inspected=await Promise.all(candidates.map(async t=>{
    try{
      const summary=await inspect(t.id,layoutCreateProbeExpression());
      return {target_id:t.id,
        target_type:isNewTabPageTarget(t)?'new-tab':'desktop-ui',
        ...summary};
    }catch(e){
      return {target_id:t.id,
        target_type:isNewTabPageTarget(t)?'new-tab':'desktop-ui',
        error:String(e?.message||e).slice(0,180)};
    }
  }));
  return {
    success:true,
    desktop_target_count:candidates.length,
    chart_target_count:targets.filter(isChartPageTarget).length,
    create_surface_candidates:inspected.filter(x=>x.create_new_layout_selector||
      x.naming_input_visible||x.exact_create_buttons?.length),
    inspected,
  };
}

async function findLandingTarget({ beforeIds = [], timeoutMs = 1000, requireNew = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  const before = beforeIds instanceof Set ? beforeIds : new Set(beforeIds);
  do {
    const targets = await listCdpTargets();
    const ranked = rankLandingCandidates(targets, before);
    const candidates = requireNew
      ? ranked.filter(candidate => !before.has(candidate.id))
      : ranked;
    const known = candidates.find(isNewTabPageTarget);
    if (known) return known;

    const remainingMs = Math.max(1, deadline - Date.now());
    const perProbeMs = Math.min(LANDING_PROBE_TIMEOUT_MS, remainingMs);

    const matches = await Promise.all(
      candidates.map(candidate => probeLandingTarget(candidate, perProbeMs)),
    );
    const matchIndex = matches.findIndex(Boolean);
    if (matchIndex >= 0) return candidates[matchIndex];

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
  } while (true);
  return null;
}

async function chartTargetReady(targetId) {
  try {
    return await withTarget(targetId, evalIn => evalIn(`
      (function() {
        try {
          var tv = window.TradingViewApi;
          var api = tv && tv._activeChartWidgetWV;
          var chart = api && api.value ? api.value() : null;
          var cwc = tv && tv._chartWidgetCollection;
          var panes = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
          // A newly-created blank layout may not have a symbol yet. For tab
          // discovery we only need a usable chart API; worker provisioning will
          // set the symbol/timeframe immediately afterwards.
          return !!(
            chart
            && typeof chart.setSymbol === 'function'
            && typeof chart.setResolution === 'function'
            && panes.length > 0
          );
        } catch(e) {
          return false;
        }
      })()
    `), CHART_PROBE_TIMEOUT_MS);
  } catch {
    return false;
  }
}

async function waitForChartTarget({ chartIdsBefore, landingId, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const targets = await listCdpTargets();
    const chartTargets = targets.filter(isChartPageTarget);
    const candidates = [
      ...chartTargets.filter(target => !chartIdsBefore.has(target.id)),
      ...chartTargets.filter(target => target.id === landingId),
    ];

    const seen = new Set();
    const unique = candidates.filter(candidate => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    });

    const ready = await Promise.all(unique.map(candidate => chartTargetReady(candidate.id)));
    const readyIndex = ready.findIndex(Boolean);
    if (readyIndex >= 0) return unique[readyIndex];

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 250));
  } while (true);
  return null;
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn, timeoutMs = 2000) {
  const task = (async () => {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      return await fn(async expression => {
        const response = await withDeadline(
          client.Runtime.evaluate({ expression, returnByValue: true }),
          Math.min(Number(timeoutMs) || 2000, 1000),
          'CDP Runtime.evaluate for target ' + targetId,
        );
        if (response.exceptionDetails) {
          const message = response.exceptionDetails.exception?.description
            || response.exceptionDetails.text
            || 'Unknown target evaluation error';
          throw new Error(message);
        }
        return response.result?.value;
      });
    } finally {
      try { if (client) await client.close(); } catch { /* already gone */ }
    }
  })();

  return withDeadline(task, timeoutMs, 'CDP target ' + targetId);
}

export async function createDirectChartTarget(url, {
  createTarget = options => CDP.New(options),
  listTargets = listCdpTargets,
  isReady = chartTargetReady,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 15000,
} = {}) {
  const created = await withDeadline(
    createTarget({ host: CDP_HOST, port: CDP_PORT, url }),
    Math.min(Number(timeoutMs) || 15000, 5000),
    'CDP.New chart target',
  );
  const targetId = created?.id || created?.targetId;
  if (!targetId) {
    throw new Error('CDP.New returned no target id');
  }

  const deadline = Date.now() + Number(timeoutMs);
  do {
    const targets = await listTargets();
    const target = targets.find(item => String(item.id) === String(targetId));
    if (target && isChartPageTarget(target) && await isReady(targetId)) {
      return target;
    }
    if (Date.now() >= deadline) break;
    await wait(250);
  } while (true);

  throw new Error('Direct CDP chart target was created but did not become ready in time');
}

export async function openChartViaRenderer(url, {
  getActiveClient = getClient,
  listTargets = listCdpTargets,
  isReady = chartTargetReady,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 15000,
} = {}) {
  const beforeIds = new Set((await listTargets()).map(target => String(target.id)));
  const wantedChartId = String(url).match(/\/chart\/([^/?]+)/)?.[1] || null;
  if (!wantedChartId || !isChartPageTarget({ type: 'page', url })) {
    throw new Error('Renderer chart open requires an exact TradingView chart URL token');
  }

  const client = await getActiveClient();
  await client.Runtime.enable();

  // Never interpolate the URL into executable JavaScript. Pass it as a CDP
  // argument so even a malformed caller value cannot become page-context code.
  const root = await client.Runtime.evaluate({
    expression: 'window',
    returnByValue: false,
  });
  const objectId = root?.result?.objectId;
  if (!objectId) throw new Error('Renderer window object is unavailable');

  const opened = await client.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function(targetUrl) {
      try {
        this.open(targetUrl, '_blank');
        return true;
      } catch (e) {
        return false;
      }
    }`,
    arguments: [{ value: String(url) }],
    returnByValue: true,
  });
  if (opened?.exceptionDetails || opened?.result?.value !== true) {
    throw new Error('Renderer window.open failed');
  }

  const deadline = Date.now() + Number(timeoutMs);
  do {
    const targets = await listTargets();
    const target = targets.find(item =>
      !beforeIds.has(String(item.id))
      && isChartPageTarget(item)
      && String(item.url.match(/\/chart\/([^/?]+)/)?.[1] || '') === wantedChartId
    );
    if (target && await isReady(target.id)) return target;
    if (Date.now() >= deadline) break;
    await wait(250);
  } while (true);

  throw new Error('Renderer window.open did not produce a ready TradingView chart target in time');
}

async function navigateTarget(targetId, url, timeoutMs = 2500) {
  const task = (async () => {
    let client = null;
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      await client.Page.enable();
      const result = await client.Page.navigate({ url });
      if (result?.errorText) {
        throw new Error('Page.navigate failed: ' + result.errorText);
      }
      return result;
    } finally {
      try { if (client) await client.close(); } catch { /* best effort */ }
    }
  })();

  return withDeadline(task, timeoutMs, 'CDP Page.navigate for target ' + targetId);
}

/** Named new layouts must be created in the layout picker before any symbol changes. */
export function shouldDirectNavigate({layout, symbol, as_chart, chart_id} = {}) {
  if (String(layout || '').trim().toLowerCase() === 'new') return false;
  return Boolean(symbol) || Boolean(as_chart) || Boolean(chart_id);
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({
  layout,
  name,
  symbol,
  chart_id,
  as_chart = false,
  force_new_tab = false,
  landing_timeout_ms = 8000,
  chart_timeout_ms = 15000,
  exact_layout = false,
  _deps,
} = {}) {
  const landingTimeoutMs = Number(landing_timeout_ms);
  const chartTimeoutMs = Number(chart_timeout_ms);
  const exactLayout = Boolean(exact_layout);
  const requestedChartId = chart_id == null ? '' : String(chart_id).trim();
  if (requestedChartId && !/^[A-Za-z0-9_-]+$/.test(requestedChartId)) {
    throw new Error('chart_id must be a TradingView chart URL token');
  }
  const wantsDirectChart = shouldDirectNavigate({layout,symbol,as_chart,chart_id:requestedChartId});
  const forceNewTab = Boolean(force_new_tab);
  if (!Number.isFinite(landingTimeoutMs) || landingTimeoutMs < 0) {
    throw new Error('landing_timeout_ms must be a non-negative number');
  }
  if (!Number.isFinite(chartTimeoutMs) || chartTimeoutMs < 0) {
    throw new Error('chart_timeout_ms must be a non-negative number');
  }

  if (wantsDirectChart && forceNewTab && requestedChartId) {
    const chartUrl = 'https://www.tradingview.com/chart/' + encodeURIComponent(requestedChartId) + '/';
    const listTargets = _deps?.listTargets || listCdpTargets;
    const reconnect = _deps?.reconnectTo || reconnectTo;
    const navigate = _deps?.navigateTarget || navigateTarget;
    const waitForReadyChart = _deps?.waitForChartTarget || waitForChartTarget;
    const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    let currentTargets = await listTargets();
    let existing = currentTargets.find(target =>
      isChartPageTarget(target)
      && String(target.url.match(/\/chart\/([^/?]+)/)?.[1] || '') === requestedChartId
    );

    // TradingView Desktop restores its own tabs asynchronously. When no chart
    // targets are present yet, give that restore a bounded head start before
    // creating or repurposing anything.
    if (!existing && currentTargets.filter(isChartPageTarget).length === 0) {
      const restoreDeadline = Date.now() + 2500;
      do {
        await wait(250);
        currentTargets = await listTargets();
        existing = currentTargets.find(target =>
          isChartPageTarget(target)
          && String(target.url.match(/\/chart\/([^/?]+)/)?.[1] || '') === requestedChartId
        );
        if (existing || Date.now() >= restoreDeadline) break;
      } while (true);
    }

    if (existing) {
      await reconnect(existing.id);
      return {
        success: true,
        action: 'existing_chart_target_reused',
        direct_navigation: true,
        reused_existing_target: true,
        target_id: existing.id,
        chart_id: requestedChartId,
        symbol: null,
        requested_chart_id: requestedChartId,
      };
    }

    // Desktop normally starts with one or more ordinary TradingView tabs.
    // Reuse those visual tabs first so worker bootstrap converges toward five
    // total tabs instead of adding five tabs on every start.
    const reusable = rankReusableWorkerBootstrapCandidates(currentTargets)[0] || null;
    if (reusable) {
      const chartIdsBefore = new Set(
        currentTargets.filter(isChartPageTarget).map(target => target.id)
      );
      await navigate(reusable.id, chartUrl, Math.min(chartTimeoutMs, 2500));
      const chartTarget = await waitForReadyChart({
        chartIdsBefore,
        landingId: reusable.id,
        timeoutMs: chartTimeoutMs,
      });
      if (!chartTarget) {
        throw new Error('Existing TradingView startup tab was navigated but no ready worker chart target became discoverable.');
      }
      await reconnect(chartTarget.id);
      return {
        success: true,
        action: 'startup_tab_reused_for_worker',
        direct_navigation: true,
        reused_existing_tab: true,
        target_id: chartTarget.id,
        chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
        symbol: null,
        requested_chart_id: requestedChartId,
      };
    }

    const createPersistentTarget = _deps?.createDirectChartTarget || createDirectChartTarget;
    const openPersistentViaRenderer = _deps?.openChartViaRenderer || openChartViaRenderer;
    let chartTarget = null;
    let creationVia = 'cdp_new';

    try {
      chartTarget = await createPersistentTarget(chartUrl, {
        timeoutMs: chartTimeoutMs,
      });
    } catch (error) {
      creationVia = 'renderer_window_open';
      chartTarget = await openPersistentViaRenderer(chartUrl, {
        timeoutMs: chartTimeoutMs,
      });
    }

    await reconnect(chartTarget.id);
    return {
      success: true,
      action: 'new_chart_target_opened',
      direct_navigation: true,
      direct_target_creation: true,
      creation_via: creationVia,
      target_id: chartTarget.id,
      chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      symbol: null,
      requested_chart_id: requestedChartId,
    };
  }

  let landing = forceNewTab
    ? null
    : await findLandingTarget({ timeoutMs: Math.min(600, landingTimeoutMs) });
  let shellCounts = null;

  if (!landing) {
    const targetsBefore = await listCdpTargets();
    const targetIdsBefore = new Set(targetsBefore.map(target => target.id));

    const before = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('button.create-new-tab-button')
            || document.querySelector('[class*="create-new-tab"]');
          if (!btn) return { ok: false, reason: 'button_not_found' };
          var key = Object.keys(btn).find(function(k){ return k.indexOf('__reactProps') === 0; });
          if (key && btn[key] && typeof btn[key].onClick === 'function') {
            btn[key].onClick({
              preventDefault: function(){},
              stopPropagation: function(){},
              currentTarget: btn,
              target: btn
            });
            return { ok: true, via: 'react_onclick' };
          }
          btn.click();
          return { ok: true, via: 'dom_click' };
        })()
      `);
      if (!clicked?.ok) throw new Error('New-tab button not found in shell window.');
      return count;
    });

    landing = await findLandingTarget({
      beforeIds: targetIdsBefore,
      timeoutMs: landingTimeoutMs,
      requireNew: true,
    });
    const after = await withShell(evalIn => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
    shellCounts = { before, after };
  }

  if (!landing) {
    throw new Error('New tab opened but its new-tab target was not discoverable by CDP.');
  }

  // Workers and callers that only need a chart target should bypass the
  // layout-picker DOM entirely. TradingView Desktop exposes its new-tab page
  // as app.asar/app/new-tab/index.html; navigate that target directly to a
  // chart and let the normal chart-ready discovery handle renderer reuse.
  if (wantsDirectChart) {
    const chartIdsBefore = new Set(
      (await listCdpTargets())
        .filter(isChartPageTarget)
        .map(target => target.id)
    );
    const chartUrl = requestedChartId
      ? 'https://www.tradingview.com/chart/' + encodeURIComponent(requestedChartId) + '/'
      : symbol
        ? 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(String(symbol))
        : 'https://www.tradingview.com/chart/';

    await navigateTarget(landing.id, chartUrl, Math.min(chartTimeoutMs, 2500));
    const chartTarget = await waitForChartTarget({
      chartIdsBefore,
      landingId: landing.id,
      timeoutMs: chartTimeoutMs,
    });
    if (!chartTarget) {
      throw new Error('New tab target was found and navigated, but no ready chart target became discoverable.');
    }

    await reconnectTo(chartTarget.id);
    return {
      success: true,
      action: 'new_chart_tab_opened',
      direct_navigation: true,
      target_id: chartTarget.id,
      chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      symbol: symbol || null,
      requested_chart_id: requestedChartId || null,
    };
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open it.',
      ...state,
    };
  }

  // Snapshot existing chart targets so we can spot the renderer/target created
  // (or reused) when the landing page navigates into a chart.
  const chartIdsBefore = new Set(
    (await listCdpTargets())
      .filter(isChartPageTarget)
      .map(target => target.id)
  );

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 700));
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await new Promise(r => setTimeout(r, 400));
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var exactOnly = ${exactLayout ? 'true' : 'false'};
        var items = document.querySelectorAll('.layout-list-item');
        var exact = null, contains = null;
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (!t) continue;
          var title = t.textContent.trim();
          var lower = title.toLowerCase();
          if (lower === q && !exact) exact = { item: items[i], title: title };
          else if (lower.indexOf(q) !== -1 && !contains) contains = { item: items[i], title: title };
        }
        var pick = exact || (exactOnly ? null : contains);
        if (!pick) return null;
        pick.item.click();
        return pick.title;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 800));
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  }, 3500);

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // Landing -> chart navigation may create a new renderer target or reuse
  // the landing target. Poll both cases and require the TradingView chart API
  // to be ready before changing the cached client.
  const chartTarget = await waitForChartTarget({
    chartIdsBefore,
    landingId: landing.id,
    timeoutMs: chartTimeoutMs,
  });
  if (!chartTarget) {
    throw new Error(`Picked "${picked}" but no ready chart target became discoverable.`);
  }

  await reconnectTo(chartTarget.id);
  // Apply the requested symbol only AFTER creating and attaching the new layout.
  const symbolResult = wantNew && symbol ? await setChartSymbol({symbol:String(symbol)}) : null;
  if (symbolResult && (!symbolResult.success || !symbolResult.chart_ready))
    throw new Error('New layout created but requested symbol did not become ready; tab left open for inspection.');
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    ...(symbolResult ? {symbol:symbolResult.symbol,chart_ready:true} : {}),
    target_id: chartTarget.id,
    chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Remove stale TradingView Desktop shell tabs while preserving exact live
 * worker renderer targets. This is intentionally separate from CDP target
 * cleanup because Desktop can retain shell-tab UI state after renderer targets
 * have disappeared.
 *
 * Safety:
 * - discovers one shell-tab index for every keep target before deleting;
 * - closes from highest index to lowest so saved indexes do not shift forward;
 * - rechecks target visibility immediately before each close;
 * - skips rather than closes if any keep target is visible after clicking the
 *   candidate shell tab.
 */
export async function cleanupOrphanShellTabs({
  keep_target_ids = [],
  _deps,
} = {}) {
  const keepIds = [...new Set(
    (keep_target_ids || []).map(value => String(value || '').trim()).filter(Boolean)
  )];
  if (!keepIds.length) {
    throw new Error('cleanupOrphanShellTabs requires at least one keep target id');
  }

  const runWithShell = _deps?.withShell || withShell;
  const targetVisible = _deps?.isTargetVisible || isTargetVisible;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  return runWithShell(async evalIn => {
    const countTabs = () => evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
    const activeIndex = () => evalIn(`
      (function() {
        var tabs = Array.from(document.querySelectorAll('.tabs-container .tab'));
        var active = document.querySelector('.tabs-container .tab.active');
        return active ? tabs.indexOf(active) : -1;
      })()
    `);
    const clickTab = index => evalIn(`
      (function() {
        var tab = document.querySelectorAll('.tabs-container .tab')[${Number(index)}];
        if (!tab) return false;
        tab.click();
        return true;
      })()
    `);
    const closeTabAt = index => evalIn(`
      (function() {
        var tab = document.querySelectorAll('.tabs-container .tab')[${Number(index)}];
        if (!tab) return false;
        var close = tab.querySelector('.tab-close-button-container button')
          || tab.querySelector('[class*="close"] button')
          || tab.querySelector('button[class*="close"]')
          || tab.querySelector('[class*="close"]');
        if (!close) return false;

        var key = Object.keys(close).find(function(k){ return k.indexOf('__reactProps') === 0; });
        if (key && close[key] && typeof close[key].onClick === 'function') {
          close[key].onClick({
            preventDefault: function(){},
            stopPropagation: function(){},
            currentTarget: close,
            target: close
          });
          return true;
        }

        close.click();
        return true;
      })()
    `);

    const before = Number(await countTabs());
    const protectedIndexes = new Set();
    const missingKeepTargets = [];

    for (const targetId of keepIds) {
      let found = false;
      if (await targetVisible(targetId)) {
        const index = Number(await activeIndex());
        if (index >= 0) {
          protectedIndexes.add(index);
          found = true;
        }
      }

      if (!found) {
        const count = Number(await countTabs());
        for (let index = 0; index < count; index++) {
          if (!(await clickTab(index))) continue;
          await wait(180);
          if (!(await targetVisible(targetId))) continue;

          const resolved = Number(await activeIndex());
          if (resolved >= 0) protectedIndexes.add(resolved);
          found = resolved >= 0;
          break;
        }
      }

      if (!found) missingKeepTargets.push(targetId);
    }

    if (missingKeepTargets.length) {
      throw new Error(
        'Refusing shell cleanup because worker targets could not be mapped to shell tabs: ' +
        missingKeepTargets.join(', ')
      );
    }

    const closed = [];
    const skipped = [];
    const startCount = Number(await countTabs());

    for (let index = startCount - 1; index >= 0; index--) {
      if (protectedIndexes.has(index)) continue;

      if (!(await clickTab(index))) {
        skipped.push({ index, reason: 'shell_tab_not_found' });
        continue;
      }
      await wait(180);

      let visibleKeep = null;
      for (const targetId of keepIds) {
        if (await targetVisible(targetId)) {
          visibleKeep = targetId;
          break;
        }
      }
      if (visibleKeep) {
        skipped.push({ index, reason: 'worker_target_visible', target_id: visibleKeep });
        continue;
      }

      const clicked = await closeTabAt(index);
      if (!clicked) {
        skipped.push({ index, reason: 'close_control_not_found' });
        continue;
      }
      await wait(220);
      closed.push(index);
    }

    const after = Number(await countTabs());
    return {
      success: true,
      tabs_before: before,
      tabs_after: after,
      protected_indexes: [...protectedIndexes].sort((a, b) => a - b),
      closed_indexes: closed,
      skipped,
    };
  });
}

/** Map a renderer to a unique Desktop tab without trusting visibilityState. */
async function resolveShellTabId(target, deps = {}) {
  if (isNewTabPageTarget(target)) {
    return JSON.parse(new URL(target.url).searchParams.get('rendererInitialData') || '{}').tabId || null;
  }
  if (!isChartPageTarget(target)) return null;
  const targets = await (deps.listTargets || listCdpTargets)();
  const charts = targets.filter(isChartPageTarget);
  if (charts.length > 64) return null;
  const readName = deps.readLayoutName || (id => withTarget(id, evalIn => evalIn(
    'window.TradingViewApi?._chartWidgetCollection?.metaInfo?.name?.value()'
  )));
  const names = await Promise.all(charts.map(async t => ({ id: t.id, name: await readName(t.id) })));
  if (names.some(t => !t.name)) return null;
  const wanted = names.find(t => t.id === target.id)?.name;
  if (!wanted || names.filter(t => t.name === wanted).length !== 1) return null;
  const shell = deps.withShell || withShell;
  return shell(async evalIn => {
    // shortcut: Desktop's React tab title holds the layout name; fail closed if that structure changes.
    const matches = await evalIn(`Array.from(document.querySelectorAll('.tabs-container .tab')).filter(tab => {
      var fiber = tab[Object.keys(tab).find(k => k.indexOf('__reactFiber') === 0)];
      for (var n = 0; fiber && n < 4; n++, fiber = fiber.return) {
        if (fiber.stateNode?.state?.title?.name === ${JSON.stringify(wanted)}) return true;
      }
      return false;
    }).map(tab => tab.id)`);
    return matches.length === 1 ? matches[0] : null;
  });
}

async function selectShellTab(evalIn, id, wait) {
  const selected = await evalIn(`(function() {
    var tab = document.getElementById(${JSON.stringify(id)});
    if (!tab || !tab.matches('.tabs-container .tab')) return false;
    var key = Object.keys(tab).find(k => k.indexOf('__reactProps') === 0);
    if (key && typeof tab[key].onClick === 'function') {
      tab[key].onClick({ button: 0, preventDefault: function(){}, stopPropagation: function(){}, currentTarget: tab, target: tab });
    } else tab.click();
    return true;
  })()`);
  if (!selected) throw new Error('Exact Desktop shell tab not found.');
  for (let n = 0; n < 20; n++) {
    if (await evalIn(`document.querySelector('.tabs-container .tab.active')?.id === ${JSON.stringify(id)}`)) return;
    await wait(100);
  }
  throw new Error('Exact Desktop tab did not become active.');
}

async function closeShellTarget(target, deps = {}) {
  // Electron visibility is unreliable for background renderers; map identity before clicking.
  const id = await resolveShellTabId(target, deps);
  if (!id) throw new Error('Exact Desktop tab identity unavailable; refusing renderer-only close.');
  const shell = deps.withShell || withShell;
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return shell(async evalIn => {
    await selectShellTab(evalIn, id, wait);
    const clicked = await evalIn(`(function() {
      var tab = document.getElementById(${JSON.stringify(id)});
      if (!tab || !tab.matches('.tabs-container .tab')) return false;
      var close = tab.querySelector('.tab-close-button-container button, [class*="close"] button, button[class*="close"]');
      if (!close) return false;
      var key = Object.keys(close).find(k => k.indexOf('__reactProps') === 0);
      if (key && typeof close[key].onClick === 'function') {
        close[key].onClick({ button: 0, preventDefault: function(){}, stopPropagation: function(){}, currentTarget: close, target: close });
      } else close.click();
      return true;
    })()`);
    if (!clicked) throw new Error('Close button not found for exact Desktop tab.');
    for (let n = 0; n < 15; n++) {
      if (!(await evalIn(`!!document.getElementById(${JSON.stringify(id)})`))) return;
      await wait(100);
    }
    throw new Error('Desktop shell tab remained open; check for unsaved changes before retrying.');
  });
}

export async function closeTabByTargetId({ target_id, _deps } = {}) {
  const targetId = String(target_id || '').trim();
  if (!targetId) throw new Error('target_id is required');

  const listTargets = _deps?.listTargets || listCdpTargets;
  const listTabs = _deps?.listTabs || list;
  const closeTarget = _deps?.closeTarget
    || (id => closeShellTarget(beforeTargets.find(tab => String(tab.id) === id), _deps));
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = Number(_deps?.timeoutMs || 3000);

  const tabs = await listTabs();
  if (Number(tabs?.tab_count || 0) <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const target = (tabs?.tabs || []).find(tab => String(tab.id) === targetId);
  if (!target) {
    throw new Error('TradingView tab target ' + targetId + ' is not an open chart/new-tab target.');
  }

  const beforeTargets = await listTargets();
  if (!beforeTargets.some(item => String(item.id) === targetId)) {
    throw new Error('TradingView tab target ' + targetId + ' disappeared before close.');
  }

  await closeTarget(targetId);

  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = await listTargets();
    if (!remaining.some(item => String(item.id) === targetId)) {
      try { await getClient(); } catch { /* next tool call will reconnect */ }
      return {
        success: true,
        action: 'tab_closed',
        target_id: targetId,
        chart_id: target.chart_id || null,
      };
    }
    if (Date.now() >= deadline) break;
    await wait(100);
  } while (true);

  throw new Error('TradingView tab target ' + targetId + ' remained present after close request.');
}

export async function closeTab() {
  const before = await withShell((evalIn) => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
  if (before <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const result = await withShell(async (evalIn) => {
    const clicked = await evalIn(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active') || document.querySelectorAll('.tabs-container .tab')[0];
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await new Promise(r => setTimeout(r, 1000));
    return evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
  });

  // Our cached CDP client may have been attached to the closed tab — re-resolve.
  try { await getClient(); } catch { /* next tool call will reconnect */ }

  return { success: result < before, action: 'tab_closed', tabs_before: before, tabs_after: result };
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 */
export async function switchTab({ index, _deps }) {
  const listTabs = _deps?.listTabs || list;
  const shell = _deps?.withShell || withShell;
  const attach = _deps?.attachChart || attachChart;
  const wait = _deps?.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const tabs = await listTabs();
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }
  const target = { ...tabs.tabs[idx], type: 'page' };
  const id = await resolveShellTabId(target, _deps);
  if (!id) {
    if (!target.is_chart) throw new Error('New-tab target has no matching visible Desktop tab.');
    const attachment = await attach({ chart_id: target.chart_id });
    return { ...attachment, index: idx, tab_id: target.id, action: 'attached_without_visual_switch', visually_switched: false };
  }
  await shell(evalIn => selectShellTab(evalIn, id, wait));
  const attachment = target.is_chart ? await attach({ chart_id: target.chart_id }) : { success: true, chart_id: null };
  return { ...attachment, action: 'switched', index: idx, tab_id: target.id, visually_switched: true };
}
