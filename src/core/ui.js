/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient, getTargetInfo, listCdpTargets, isTradingViewUrl } from '../connection.js';
import { protectedChartIds } from './worker.js';
import * as tabCore from './tab.js';

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') { var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco'); isOpen = isOpen && !!monacoEl; }
        if (panel === 'strategy-tester') { var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(stratPanel && stratPanel.offsetParent); }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          bwb.showWidget(widgetName);
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          // Desktop 3.5 has no hideWidget/activateScriptEditorTab; close() minimizes the bottom panel.
          bwb.close();
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  } else {
    // Newer TV builds renamed the right-rail buttons (watchlist is now
    // data-name="base", aria "Watchlist, details, and news"; alerts is
    // data-name="alerts") — keep legacy selectors as fallbacks.
    const selectorMap = {
      'watchlist': { dataNames: ['base-watchlist-widget-button', 'base'], ariaLabels: ['Watchlist', 'Watchlist, details, and news'] },
      'alerts': { dataNames: ['alerts-button', 'alerts'], ariaLabels: ['Alerts'] },
      'trading': { dataNames: ['trading-button'], ariaLabels: ['Trading Panel'] },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataNames = ${JSON.stringify(sel.dataNames)};
        var ariaLabels = ${JSON.stringify(sel.ariaLabels)};
        var action = ${JSON.stringify(action)};
        var btn = null;
        for (var d = 0; d < dataNames.length && !btn; d++) btn = document.querySelector('[data-name="' + dataNames[d] + '"]');
        for (var a = 0; a < ariaLabels.length && !btn; a++) btn = document.querySelector('[aria-label="' + ariaLabels[a] + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList() {
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, chart_id: c.url || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}


/** Fixed layout deletion actions; never accept a pre-existing confirmation. */
export function layoutDeleteExpression({chart_id,name,origin,host_chart_id,phase,deadline}) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(chart_id)||typeof name!=='string'||!name.trim()||
    !['remove','confirm'].includes(phase))throw new Error('Exact chart ID, layout name and action required');
  return '('+function(args){
    const doc=globalThis.document,loc=globalThis.location;
    if(Date.now()>=args.deadline)return {error:'DEADLINE'};
    if(loc.origin!==args.origin||loc.protocol!=='https:'||
       loc.pathname.replace(/\/$/,'')!=='/chart/'+args.host_chart_id)
      return {error:'CHART_IDENTITY_CHANGED'};
    const visible=e=>{
      const r=e.getBoundingClientRect(),c=globalThis.getComputedStyle(e);
      return e.isConnected&&!e.closest('[hidden],[inert],[aria-hidden="true"]')&&r.width>0&&r.height>0&&
        c.visibility==='visible'&&c.display!=='none'&&c.opacity!=='0';
    };
    const clickExact=e=>{
      if(!visible(e)||e.disabled||e.closest('[aria-disabled="true"]'))return {error:'CONTROL_NOT_AVAILABLE'};
      const r=e.getBoundingClientRect(),hit=doc.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      if(!hit||!(hit===e||e.contains(hit)))return {error:'CONTROL_OBSCURED'};
      if(Date.now()>=args.deadline)return {error:'DEADLINE'};
      e.click();return {clicked:true};
    };
    const pickers=Array.from(doc.querySelectorAll('[data-name="load-layout-dialog"]'));
    if(pickers.length!==1)return {error:'PICKER_NOT_UNIQUE'};
    const rows=Array.from(pickers[0].querySelectorAll('[data-name="load-chart-dialog-item"]')).filter(e=>{
      const href=e.getAttribute('href');if(!href)return false;
      let u;try{u=new URL(href,loc.origin)}catch{return false}
      return u.origin===loc.origin&&u.pathname.replace(/\/$/,'')==='/chart/'+args.chart_id&&
        String(e.querySelector('[data-name="list-item-title"]')?.textContent||'').trim()===args.name;
    });
    if(rows.length!==1)return {error:'LAYOUT_ROW_NOT_UNIQUE'};
    const dialogs=Array.from(doc.querySelectorAll('[data-name="confirm-dialog"]')).filter(visible);
    if(args.phase==='remove'){
      if(dialogs.length!==0)return {error:'EXISTING_CONFIRMATION'};
      if(!visible(pickers[0])||!visible(rows[0]))return {error:'PICKER_NOT_VISIBLE'};
      const buttons=Array.from(rows[0].querySelectorAll('[data-name="list-item-remove-button"]'))
        .filter(e=>visible(e)&&e.getAttribute('aria-label')==='Remove');
      if(buttons.length!==1)return {error:'REMOVE_CONTROL_NOT_UNIQUE'};
      return clickExact(buttons[0]);
    }
    if(dialogs.length===0)return {pending:true};
    if(dialogs.length!==1)return {error:'CONFIRMATION_NOT_UNIQUE'};
    const dialog=dialogs[0],body=String(dialog.innerText||'');
    // The observed TradingView confirmation names the layout in double quotes.
    // Reject unknown localization/wording, different names and extra quoted names.
    const names=[...body.matchAll(/"([^"]*)"/g)].map(m=>m[1]);
    if(!body.includes('Delete this chart layout?')||
       !body.includes('permanently delete your "'+args.name+'" layout')||
       names.length!==1||names[0]!==args.name)return {error:'CONFIRMATION_NAME_MISMATCH'};
    const buttons=Array.from(dialog.querySelectorAll('button')).filter(e=>visible(e)&&String(e.innerText||'').trim()==='Delete');
    if(buttons.length!==1)return {error:'DELETE_CONTROL_NOT_UNIQUE'};
    return clickExact(buttons[0]);
  }.toString()+')('+JSON.stringify({chart_id,name,origin,host_chart_id,phase,deadline})+')';
}

function verifiedSavedLayouts(result){
  if(result?.success!==true||result.source!=='internal_api'||result.error||
    !Array.isArray(result.layouts)||result.layout_count!==result.layouts.length||
    result.layouts.some(l=>!l.chart_id||typeof l.name!=='string')||
    new Set(result.layouts.map(l=>l.chart_id)).size!==result.layouts.length)
    throw new Error('Saved-layout readback is incomplete or ambiguous');
  return result.layouts;
}

export async function deleteSavedLayout({chart_id,expected_layout_name,worker_state,_deps}={}) {
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(chart_id)||typeof expected_layout_name!=='string'||
     !expected_layout_name.trim()||expected_layout_name.length>200||expected_layout_name.includes('"'))
    throw new Error('Exact supported layout ID and name required');
  const listLayouts=_deps?.listLayouts||layoutList;
  const listTabs=_deps?.listTabs||tabCore.list;
  const current=_deps?.getTargetInfo||getTargetInfo;
  const listTargets=_deps?.listTargets||listCdpTargets;
  const run=_deps?.withTarget||tabCore.withTarget;
  const wait=_deps?.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now=_deps?.now||Date.now;
  const saved=verifiedSavedLayouts(await listLayouts());
  if(saved.filter(l=>l.chart_id===chart_id&&l.name===expected_layout_name).length!==1||
     saved.filter(l=>l.name===expected_layout_name).length!==1)throw new Error('Saved layout identity is missing or ambiguous');
  const workers=worker_state?.worker_tabs||[],workerNames=workers.map(t=>t.layout_name);
  const isWorker=l=>tabCore.isWorkerShellTab({layout_name:l.name},workerNames)||
    workers.some(t=>String(t.chart_id)===l.chart_id);
  if(isWorker({name:expected_layout_name,chart_id}))throw new Error('Worker layout cannot be deleted');
  const tabs=await listTabs();
  if(tabs.success!==true||tabs.shell_discovery_error||!Array.isArray(tabs.tabs)||!Array.isArray(tabs.shell_tabs))
    throw new Error('Open layout identity unavailable');
  if(tabs.tabs.some(t=>t.chart_id===chart_id)||tabs.shell_tabs.some(t=>t.layout_name===expected_layout_name))
    throw new Error('Close all instances of exact saved layout before deletion');
  const host=await current();
  const candidates=(await listTargets()).filter(t=>t.id===host?.id&&t.type==='page'&&isTradingViewUrl(t.url));
  if(candidates.length!==1)throw new Error('Attach an exact non-worker chart first');
  const url=new URL(candidates[0].url),hostId=url.pathname.match(/^\/chart\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1];
  const hostLayout=saved.find(l=>l.chart_id===hostId);
  if(!hostLayout||isWorker(hostLayout)||protectedChartIds(worker_state).has(hostId))
    throw new Error('Open layout picker on a non-worker chart');
  if(tabs.shell_tabs.filter(t=>t.active&&t.layout_name===hostLayout.name).length!==1||
     tabs.tabs.filter(t=>t.chart_id===hostId&&t.id===host.id).length!==1)
    throw new Error('Layout picker must be on the active verified chart');
  const deadline=now()+5000;
  let removed=false,confirmed=false,unknown=false;
  const fail=error=>({success:false,clicked:removed,confirmed,click_outcome_unknown:unknown,chart_id,error});
  try{
    const actionResult=await run(host.id,async evaluateStep=>{
      const act=async phase=>{
        unknown=true;
        const r=await evaluateStep(layoutDeleteExpression({chart_id,name:expected_layout_name,
          origin:url.origin,host_chart_id:hostId,phase,deadline}));
        if(!r||typeof r!=='object')throw new Error('INVALID_RENDERER_RESPONSE');
        unknown=false;return r;
      };
      const first=await act('remove');
      if(!first.clicked)return fail(first.error||'REMOVE_NOT_VERIFIED');
      removed=true;
      // Only a fresh confirmation resulting from this exact row click may be accepted.
      while(now()<deadline){
        const r=await act('confirm');
        if(r.clicked){confirmed=true;return {success:true};}
        if(!r.pending)return fail(r.error||'CONFIRMATION_NOT_VERIFIED');
        await wait(100);
      }
      return fail('CONFIRMATION_TIMEOUT');
    },6500);
    if(!actionResult.success)return actionResult;
    const expected=saved.filter(l=>l.chart_id!==chart_id).map(l=>JSON.stringify([l.chart_id,l.name])).sort();
    for(let i=0;i<8;i++){
      await wait(200);
      const next=verifiedSavedLayouts(await listLayouts());
      if(!next.some(l=>l.chart_id===chart_id)){
        const actual=next.map(l=>JSON.stringify([l.chart_id,l.name])).sort();
        if(JSON.stringify(actual)!==JSON.stringify(expected))return fail('OTHER_LAYOUTS_CHANGED');
        return {success:true,deleted:true,confirmed:true,chart_id,layout_name:expected_layout_name};
      }
    }
    return fail('DELETION_NOT_VERIFIED');
  }catch{
    return fail('LAYOUT_DELETE_OUTCOME_UNVERIFIED');
  }
}

/** Strict resolver: exact name/id first; reject ambiguous partial names. */
export function resolveSavedLayout(layouts, query) {
  const target = String(query || '').trim();
  if (!target) throw new Error('Saved layout name or ID is required');
  const exact = (layouts || []).filter(x =>
    String(x.id) === target ||
    String(x.chart_id || '') === target ||
    String(x.name || '').toLowerCase() === target.toLowerCase()
  );
  const partial = exact.length ? exact : (layouts || []).filter(x =>
    String(x.name || '').toLowerCase().includes(target.toLowerCase())
  );
  if (partial.length !== 1) throw new Error(partial.length
    ? 'Ambiguous saved layout name; specify exact name, chart token or numeric ID.'
    : 'Saved layout not found: ' + target);
  return partial[0];
}

/** Attach an OPEN saved layout without triggering unsaved-change dialogs or
 * touching a worker pane. Non-open layouts must be opened in Desktop first. */
export async function layoutSwitch({ name, _deps } = {}) {
  const listLayouts = _deps?.listLayouts || layoutList;
  const attach = _deps?.attach || tabCore.attachChart;
  const layouts = await listLayouts();
  if (layouts.error) throw new Error(layouts.error);
  const selected = resolveSavedLayout(layouts.layouts, name);
  if (!selected.chart_id) throw new Error(
    'Saved layout ' + selected.name + ' has no stable chart URL token.'
  );
  const target = await attach({ chart_id: selected.chart_id });
  return {
    success: true,
    action: 'attached_open_layout',
    layout: selected.name,
    layout_id: selected.id,
    chart_id: selected.chart_id,
    target_id: target.target_id,
    visually_switched: false,
    verified: target.verified === true,
    source: 'internal_api',
  };
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

export async function mouseClick({ x, y, button, double_click, _deps }) {
  const c = _deps?.client || await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const buttons = btn === 'left' ? 1 : btn === 'right' ? 2 : 4;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, buttons: 0, clickCount: 1 });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, buttons: 0, clickCount: 2 });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluate(expression);
  return { success: true, result };
}

const UI_SEQUENCE_MAX_STEPS = 8;
const UI_SEQUENCE_BUDGET_MS = 8000;
const UI_SEQUENCE_WAIT_MS = 2500;
const UI_SEQUENCE_ACTIONS = new Set(['find','click','wait','assert']);
const UI_SEQUENCE_SELECTORS = new Set(['aria-label','data-name','text']);

/** All caller inputs are data; no caller-supplied JS, CSS, URLs, attributes or function paths. */
export function validateUiSequence({target_id,chart_id,steps}={}) {
  if(typeof target_id!=='string'||!target_id.trim()||target_id.length>128||
     typeof chart_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(chart_id))
    throw new Error('Exact target_id and chart_id required');
  if(!Array.isArray(steps)||steps.length<1||steps.length>UI_SEQUENCE_MAX_STEPS)
    throw new Error('Sequence requires 1-8 steps');
  for(let i=0;i<steps.length;i++){
    const s=steps[i];
    if(!s||!UI_SEQUENCE_ACTIONS.has(s.action)||!UI_SEQUENCE_SELECTORS.has(s.by)||
       typeof s.value!=='string'||!s.value.trim()||s.value.length>160||
       Object.keys(s).some(k=>!['action','by','value','state'].includes(k)))
      throw new Error('Invalid UI sequence step '+(i+1));
    if(s.state!==undefined&&(!['wait','assert'].includes(s.action)||!['present','absent'].includes(s.state)))
      throw new Error('Invalid UI sequence state at step '+(i+1));
    if(s.action==='click'&&!['wait','assert'].includes(steps[i+1]?.action))
      throw new Error('Each click must be immediately followed by a wait or assert');
  }
}

export function uiSequenceStepExpression({origin,chart_id,step,deadline}) {
  // Exact comparisons avoid constructing selectors from caller text. All code is server-owned.
  return '('+function(args){
    if(Date.now()>=args.deadline)return {error:'SEQUENCE_DEADLINE'};
    if(globalThis.location.origin!==args.origin||globalThis.location.protocol!=='https:'||
       globalThis.location.pathname.replace(/\/$/,'')!=='/chart/'+args.chart_id)
      return {error:'CHART_IDENTITY_CHANGED'};
    const s=args.step;
    const visible=e=>{
      if(!e.isConnected||e.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
      const r=e.getBoundingClientRect(),c=globalThis.getComputedStyle(e);
      return r.width>0&&r.height>0&&c.visibility==='visible'&&c.display!=='none'&&c.opacity!=='0';
    };
    const controls='button,[role="button"],[role="menuitem"],[role="tab"],[role="option"]';
    const selector=s.by==='text'?(s.action==='click'?controls:controls+',label,span,div,h1,h2,h3,h4'):'['+s.by+']';
    const matches=[];
    for(const e of globalThis.document.querySelectorAll(selector)){
      if(!visible(e))continue;
      const value=s.by==='text'?String(e.innerText||'').trim():e.getAttribute(s.by);
      if(value===s.value)matches.push(e);
      if(matches.length>=6)break;
    }
    const count=matches.length;
    if(s.action==='find')return {count,count_capped:count>=6,items:matches.slice(0,5).map(e=>({
      tag:e.tagName.toLowerCase(),text:String(e.innerText||'').trim().slice(0,120),
      aria_label:(e.getAttribute('aria-label')||'').slice(0,160),
      data_name:(e.getAttribute('data-name')||'').slice(0,160),
      disabled:!!e.disabled||e.getAttribute('aria-disabled')==='true'
    }))};
    if(s.action==='wait'||s.action==='assert'){
      const state=s.state||'present';
      return {count,count_capped:count>=6,condition_met:state==='absent'?count===0:count===1,state};
    }
    if(s.action!=='click')return {error:'INVALID_ACTION'};
    if(count!==1)return {error:'CLICK_MATCH_NOT_UNIQUE',count};
    const e=matches[0];
    // Don't extend existing UI clicking to arbitrary DOM nodes, form submits, or links.
    if(!e.matches(controls)||e.closest('a,[contenteditable="true"],form')||
       e.disabled||e.closest('[aria-disabled="true"]')||
       typeof e.click!=='function')return {error:'CLICK_CONTROL_NOT_ALLOWED'};
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    const hit=globalThis.document.elementFromPoint(x,y);
    if(!hit||!(hit===e||e.contains(hit)))return {error:'CLICK_CONTROL_OBSCURED_OR_OFFSCREEN'};
    if(Date.now()>=args.deadline)return {error:'SEQUENCE_DEADLINE'};
    e.click();
    return {clicked:true};
  }.toString()+')('+JSON.stringify({origin,chart_id,step,deadline})+')';
}

export async function uiSequence({target_id,chart_id,steps,_deps}={}) {
  validateUiSequence({target_id,chart_id,steps});
  const list=_deps?.listTargets||listCdpTargets;
  const protectedIds=_deps?.protectedIds||protectedChartIds;
  const run=_deps?.withTarget||tabCore.withTarget;
  const now=_deps?.now||Date.now;
  const wait=_deps?.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const candidates=(await list()).filter(t=>t.id===target_id&&t.type==='page'&&isTradingViewUrl(t.url));
  if(candidates.length!==1)throw new Error('Target is not one verified HTTPS TradingView chart; refresh tab_list');
  const url=new URL(candidates[0].url);
  if(url.pathname.replace(/\/$/,'')!=='/chart/'+chart_id)throw new Error('Chart identity mismatch');
  if(protectedIds().has(chart_id))throw new Error('PROTECTED_WORKER_TAB: use the existing protected worker workflow');
  const deadline=now()+UI_SEQUENCE_BUDGET_MS;
  const completed=[];
  let attempted=0,clickOutcomeUnknown=false,retryCount=0;
  const fail=error=>({success:false,target_id,chart_id,completed_steps:completed.length,failed_step:attempted,
    results:completed,error,click_outcome_unknown:clickOutcomeUnknown,retry_count:retryCount,failed_action:steps[attempted-1]?.action,
    note:'Completed clicks are not rolled back; verify current UI before retrying.'});
  try{
    return await run(target_id,async evaluateStep=>{
      for(let i=0;i<steps.length;i++){
        attempted=i+1;
        const step=steps[i];
        const stepDeadline=Math.min(deadline,now()+(['wait','click'].includes(step.action)?UI_SEQUENCE_WAIT_MS:UI_SEQUENCE_BUDGET_MS));
        let result;
        do{
          if(now()>=stepDeadline)return fail('WAIT_OR_SEQUENCE_TIMEOUT');
          clickOutcomeUnknown=step.action==='click';
          result=await evaluateStep(uiSequenceStepExpression({origin:url.origin,chart_id,step,deadline:stepDeadline}));
          if(!result||typeof result!=='object')return fail('INVALID_RENDERER_RESPONSE');
          clickOutcomeUnknown=false;
          // Only retry an explicit pre-click obstruction, never an uncertain or completed click.
          if(step.action==='click'&&result.error==='CLICK_CONTROL_OBSCURED_OR_OFFSCREEN'&&now()+100<stepDeadline){
            retryCount++;await wait(100);continue;
          }
          if(result.error)return fail(result.error);
          if(step.action==='click'&&result.clicked!==true)return fail('CLICK_NOT_VERIFIED');
          if(step.action!=='wait'||result.condition_met===true)break;
          await wait(100);
        }while(now()<stepDeadline);
        if(step.action==='click'&&result?.clicked!==true)return fail(result?.error||'CLICK_NOT_VERIFIED');
        if(['wait','assert'].includes(step.action)&&result.condition_met!==true)return fail('CONDITION_NOT_MET');
        completed.push({step:attempted,action:step.action,...result});
      }
      return {success:true,target_id,chart_id,completed_steps:completed.length,results:completed,retry_count:retryCount};
    },UI_SEQUENCE_BUDGET_MS+2000);
  }catch{
    // Do not retry an uncertain mutation or leak renderer error internals.
    return fail('CDP_SEQUENCE_FAILED');
  }
}
