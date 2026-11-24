/** Pure decision for reusing a saved personal chart without touching worker tabs. */
export function planPersonalLayoutOpen({chartId,tabState,workerState,forceNew=false}={}) {
  const wanted=String(chartId||'').trim();
  if(!wanted) throw new Error('Saved chart URL identity is required.');
  const matched=(tabState?.tabs||[]).filter(t=>t.is_chart&&String(t.chart_id)===wanted);
  const workerRegistered=(workerState?.worker_tabs||[]).some(t=>String(t.chart_id)===wanted);
  const workerTargetIds=new Set((workerState?.worker_tabs||[]).map(w=>String(w.target_id)));
  // Workers are ordinary AI charts, but a second copy of a worker layout would split its registered identity.
  if(workerRegistered||matched.some(t=>workerTargetIds.has(String(t.id)))) {
    if(forceNew||!matched.length) throw new Error('Worker layouts are reused, never duplicated; run worker_provision if it is not open.');
    return {action:'reuse',target_id:matched[0].id,matched_count:matched.length};
  }
  // Duplicate personal tabs are interchangeable copies of one saved layout: reuse the first.
  return !forceNew&&matched.length
    ? {action:'reuse',target_id:matched[0].id,matched_count:matched.length}
    : {action:'open',matched_count:matched.length};
}
