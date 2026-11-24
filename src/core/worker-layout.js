import { withTimeout } from '../connection.js';
import { normalizeWorkerTimeframe, workerRequiresExtendedHours } from './worker.js';
import { matchTradingViewResolvedSymbol } from './watchlist.js';
import { layoutCodeForPaneCount } from './worker-provision.js';

export async function saveWorkerLayout(client, { chartId, entries, panes = [] }) {
  const result = await withTimeout(client.Runtime.evaluate({ returnByValue: true, awaitPromise: true,
    expression: `new Promise((resolve,reject)=>{
      const api=window.TradingViewApi;
      if(api.layoutId()!==${JSON.stringify(chartId)}) throw Error('Worker layout identity changed before save');
      const timer=setTimeout(()=>reject(Error('Worker layout save timed out')),5000);
      api.saveChartToServer(()=>{
        clearTimeout(timer);
        try{
          const state=JSON.parse(api._saveChartService._chartSaver._prevChartState.content);
          resolve({chart_id:api.layoutId(),layout:state.layout,dirty:api.hasChartChanges().value(),
            symbol_sync:!!state.symbolLock,interval_sync:!!state.intervalLock,
            panes:state.charts.map(chart=>{const series=chart.panes.flatMap(p=>p.sources)
              .find(source=>source.type==='MainSeries');
              return {symbol:series?.state.symbol,timeframe:series?.state.interval,chart_session:series?.state.sessionId};})});
        }catch(error){reject(error);}
      },error=>{clearTimeout(timer);reject(Error('Worker layout save failed: '+String(error?.message||error)));});
    })`,
  }), 6000, 'Worker layout save');
  const saved = result.result?.value;
  // After a layout shrinks, TradingView keeps the hidden charts in the saved state; only the
  // first panes of the saved layout code are shown, so verify the code and those panes.
  if (result.exceptionDetails || !saved || saved.chart_id !== chartId || saved.dirty
      || saved.symbol_sync || saved.interval_sync || saved.layout !== layoutCodeForPaneCount(entries.length)
      || saved.panes.length < entries.length
      || entries.some((entry, index) => !(matchTradingViewResolvedSymbol(entry.symbol, saved.panes[index].symbol).matched
          || (saved.panes[index].symbol === panes[index]?.resolved_symbol
            && matchTradingViewResolvedSymbol(entry.symbol, panes[index].resolved_symbol, panes[index].symbol_identity).matched))
        || normalizeWorkerTimeframe(entry.timeframe) !== normalizeWorkerTimeframe(saved.panes[index].timeframe)
        || (workerRequiresExtendedHours(entry) && saved.panes[index].chart_session !== 'extended'))) {
    throw new Error('Saved worker layout does not match the verified registry; no completed assignment recorded');
  }
  return { persisted: true };
}
