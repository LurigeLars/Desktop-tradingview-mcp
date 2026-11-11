import CDP from 'chrome-remote-interface';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CDP_HOST, CDP_PORT, listTradingViewChartTargets, withTimeout } from '../connection.js';
import { status } from './worker.js';
import { pendingPaneIndexes, readActivePaneStates } from './worker-provision.js';
import { requiredStudiesPresent } from './realtime.js';

export async function repairWorker({ slot, max_panes = 1, dry_run = true, _deps = {} } = {}) {
  const state = (_deps.status || status)();
  const owner = state.worker_tabs.find(tab => tab.slot === slot);
  const plan = state.topology_plan.tabs.find(tab => tab.tab_index === slot);
  const entries = (plan?.handles || []).map(handle => state.entries.find(entry => entry.handle === handle));
  if (!Number.isInteger(slot) || !owner?.persistent_layout || !owner.chart_id || !plan
      || entries.length !== owner.pane_count || entries.some((entry, index) => !entry
        || entry.assignment?.worker_slot !== slot || entry.assignment?.pane_index !== index
        || entry.assignment?.chart_id !== owner.chart_id)
      || state.worker_tabs.filter(tab => tab.chart_id === owner.chart_id).length !== 1) {
    throw new Error('Repair requires one uniquely registered persistent worker layout');
  }
  if (!Number.isInteger(max_panes) || max_panes < 1 || max_panes > 8)
    throw new Error('max_panes must be from 1 to 8');
  const targets = (await (_deps.listTargets || listTradingViewChartTargets)()).filter(target => {
    try { return new URL(target.url).pathname === '/chart/' + owner.chart_id + '/'; }
    catch { return false; }
  });
  if (targets.length !== 1) throw new Error('Worker repair target missing or ambiguous');
  const client = await withTimeout((_deps.connect || (target => CDP({
    host: CDP_HOST, port: CDP_PORT, target: target.id,
  })))(targets[0]), 5000, 'Worker repair attach');
  const read = () => withTimeout((_deps.read || readActivePaneStates)(client), 8000, 'Worker repair read');
  const evaluate = async expression => {
    const result = await withTimeout(client.Runtime.evaluate({
      expression, returnByValue: true, awaitPromise: true,
    }), 8000, 'Worker repair evaluation');
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Worker repair failed');
    return result.result?.value;
  };
  try {
    const before = await read();
    if (before.length !== owner.pane_count || entries.some((entry, index) =>
      !requiredStudiesPresent(entry, before[index]))) {
      throw new Error('Worker pane count or required indicators changed; repair refuses to remove/recreate studies');
    }
    const sync = await evaluate(`(()=>{const c=window.TradingViewApi._chartWidgetCollection;
      return {symbol:c.symbolSyncEnabled().value(),interval:c.intervalSyncEnabled().value()};})()`);
    if (typeof sync?.symbol !== 'boolean' || typeof sync?.interval !== 'boolean')
      throw new Error('Worker synchronization state unverifiable');
    const pending = pendingPaneIndexes(entries, before);
    const report = { success: true, dry_run, slot, chart_id: owner.chart_id,
      pending_panes: pending, synchronization: sync, complete: pending.length === 0,
      opened_tabs: 0, indicators_preserved: true };
    if (dry_run) return report;
    const selected = pending.slice(0, max_panes);
    const backup = { chart_id: owner.chart_id, target_id: targets[0].id, sync, panes: before };
    if (_deps.backup) _deps.backup(backup);
    else {
      const root = resolve(process.env.LOCALAPPDATA || process.env.HOME || '.', 'tradingview-mcp');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'worker-repair-' + Date.now() + '.json'), JSON.stringify(backup), { flag: 'wx' });
    }
    await evaluate(`(async()=>{
      const api=window.TradingViewApi,c=api._chartWidgetCollection;
      if(api.layoutId()!==${JSON.stringify(owner.chart_id)}||api.chartsCount()!==${owner.pane_count})
        throw Error('Worker layout changed before repair');
      c.symbolSyncEnabled().setValue(false);c.intervalSyncEnabled().setValue(false);
      if(c.symbolSyncEnabled().value()||c.intervalSyncEnabled().value()) throw Error('Worker synchronization still active');
      for(const item of ${JSON.stringify(selected.map(index => ({ index, symbol: entries[index].symbol, timeframe: entries[index].timeframe })))}){
        const chart=api.chart(item.index);
        chart.setSymbol(item.symbol,{});
        await new Promise(resolve=>setTimeout(resolve,350));
        chart.setResolution(item.timeframe,{});
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      return true;
    })()`);
    let after;
    for (let attempt = 0; attempt < 16; attempt++) {
      after = await read();
      if (selected.every(index => !pendingPaneIndexes([entries[index]], [after[index]]).length)) break;
      await (_deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))))(250);
    }
    for (let index = 0; index < before.length; index++) {
      if (JSON.stringify(before[index].studies) !== JSON.stringify(after[index]?.studies)
          || (!selected.includes(index) && (before[index].resolved_symbol !== after[index]?.resolved_symbol
            || before[index].resolution !== after[index]?.resolution))) {
        throw new Error('Worker repair changed unrelated pane or indicators; inspect saved backup');
      }
    }
    const remaining = pendingPaneIndexes(entries, after);
    if (selected.some(index => remaining.includes(index))) throw new Error('Worker repair identity/timeframe verification failed');
    return { ...report, changed: true, configured_panes: selected,
      pending_panes: remaining, complete: remaining.length === 0, synchronization: { symbol: false, interval: false } };
  } finally {
    await withTimeout(client.close(), 1000, 'Worker repair close').catch(() => {});
  }
}
