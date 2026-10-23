/** Pure decision for reusing a saved personal chart without touching worker tabs. */
export function planPersonalLayoutOpen({chartId,tabState,workerState,forceNew=false}={}) {
  const wanted=String(chartId||'').trim();
  if(!wanted) throw new Error('Saved chart URL identity is required.');
  const matched=(tabState?.tabs||[]).filter(t=>t.is_chart&&String(t.chart_id)===wanted);
  const workerRegistered=(workerState?.worker_tabs||[]).some(t=>String(t.chart_id)===wanted);
  const workerTargetIds=new Set((workerState?.worker_tabs||[]).map(w=>String(w.target_id)));
  if(workerRegistered||matched.some(t=>workerTargetIds.has(String(t.id)))) {
    throw new Error('Cannot open or reuse a protected worker layout using interactive tab_new.');
  }
  if(!forceNew&&matched.length>1) {
    throw new Error('Multiple personal tabs for this saved layout already exist; tab_attach by exact target_id and close duplicates explicitly.');
  }
  return !forceNew&&matched.length===1
    ? {action:'reuse',target_id:matched[0].id,matched_count:1}
    : {action:'open',matched_count:matched.length};
}
