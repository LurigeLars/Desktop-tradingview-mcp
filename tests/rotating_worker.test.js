import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateWorkerSnapshot, recoverRotatingPane, selectRotatingPane } from '../src/core/rotating-worker.js';

function setup() {
  const entries = Array.from({length:40},(_,i)=>({
    handle: i === 38 ? 'qqq-5m' : 'h'+i, symbol: i === 38 ? 'NASDAQ:QQQ' : 'NASDAQ:BASE'+i, timeframe:i>=37?'5':'60',
    studies:[], groups:i>=37?['watch:resident','watch:tactical_current']:['watch:resident','morning'],
    assignment:{worker_slot:Math.floor(i/8),pane_index:i%8,chart_id:'chart'+Math.floor(i/8),target_id:'runtime'+Math.floor(i/8)},
  }));
  const state={entries,topology_plan:{tabs:Array.from({length:5},(_,i)=>({tab_index:i,pane_count:8}))},
    worker_tabs:Array.from({length:5},(_,i)=>({slot:i,chart_id:'chart'+i,target_id:'runtime'+i,layout_name:'DTV Market 0'+(i+1),pane_count:8,persistent_layout:true}))};
  const panes=entries.slice(32).map(e=>({
    resolved_symbol:e.symbol,resolution:e.timeframe,symbol_identity:{},studies:[],
  }));
  let journal=null, calls=[];
  const deps={
    status:()=>state,
    read:async()=>({pane:panes[6],all:panes}),
    set:async(chartId,index,symbol,timeframe)=>{
      calls.push({chartId,index,symbol,timeframe});
      panes[index]={resolved_symbol:symbol,resolution:timeframe,studies:[],symbol_identity:{}};
    },
    wait:async()=>null,
    snapshot:async symbol=>({
      requested_symbols:[symbol],missing:[],ambiguous_symbols:[],
      snapshots:[{chart_id:'chart4',target_id:'runtime4',pane_index:6,
        success:true,resolved_symbol:symbol,quote:{last:100,source_timestamp_ms:1000}}],
    }),
    getJournal:()=>journal,
    putJournal:o=>{journal=o;}, clearJournal:()=>{journal=null;},
  };
  return {state,panes,deps,calls,get journal(){return journal;}};
}

test('one low-priority pane in fifth existing tab, never a sixth',()=>{
  const x=setup(),v=selectRotatingPane(x.state);
  assert.equal(v.slot,4);assert.equal(v.pane_index,6);
  assert.equal(v.chart_id,'chart4');
  x.state.entries[38].groups.push('watch:user_retained');
  assert.throws(() => selectRotatingPane(x.state), /No safely replaceable pane/);
});
test('sample and restore original in the same worker tab with no new tabs',async()=>{
  const x=setup();
  const v=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(v.success,true);assert.equal(v.restored,true);assert.equal(v.opened_tabs,0);
  assert.equal(v.snapshot.resolved_symbol,'NASDAQ:ADBE');
  assert.deepEqual(x.calls.map(z=>z.symbol),['NASDAQ:ADBE','NASDAQ:QQQ']);
  assert.equal(x.panes[6].resolved_symbol,'NASDAQ:QQQ');
  assert.equal(x.journal,null);
});
test('missing/suspect quote cannot be returned and original is restored',async()=>{
  const x=setup();
  x.deps.snapshot=async()=>({requested_symbols:['NASDAQ:ADBE'],missing:['NASDAQ:ADBE'],snapshots:[]});
  const r=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(r.success,false);assert.equal(r.restored,true);
  assert.equal(r.error_code,'ROTATION_SAMPLE_FAILED');
  assert.equal(x.panes[6].resolved_symbol,'NASDAQ:QQQ');
  assert.equal(x.journal,null);
});
test('failed restoration leaves durable journal and blocks future rotations',async()=>{
  const x=setup(),original=x.deps.set;
  x.deps.set=async(...a)=>{if(a[2]==='NASDAQ:QQQ')throw Error('blocked restore');return original(...a)};
  const r=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(r.success,false);assert.equal(r.error_code,'RESTORATION_PENDING');
  assert.ok(x.journal);assert.equal(x.panes[6].resolved_symbol,'NASDAQ:ADBE');
  const safe=await recoverRotatingPane({dry_run:true,_deps:x.deps});
  assert.equal(safe.can_restore,true);
  x.deps.set=original;
  const restored=await recoverRotatingPane({_deps:x.deps});
  assert.equal(restored.restored,true);assert.equal(x.journal,null);
});
test('unexpected third-party pane change makes rotation recovery fail closed',async()=>{
  const x=setup();
  x.deps.putJournal({chart_id:'chart4',pane_index:6,handle:'qqq-5m',
    original:{symbol:'NASDAQ:QQQ',timeframe:'5'},temporary:'NASDAQ:ADBE'});
  x.panes[6]={resolved_symbol:'NASDAQ:UNKNOWN',resolution:'60',studies:[],symbol_identity:{}};
  await assert.rejects(()=>recoverRotatingPane({_deps:x.deps}),/unexpected symbol/);
  assert.equal(x.calls.length,0);assert.ok(x.journal);
});
test('preflight refuses changed resident layouts and already-resident symbols',async()=>{
  const x=setup();
  x.panes[1].resolved_symbol='NASDAQ:WRONG';
  await assert.rejects(()=>rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps}),/identities not aligned/);
  assert.equal(x.calls.length,0);
  await assert.rejects(()=>rotateWorkerSnapshot({symbol:'ADBE',_deps:x.deps}),/exchange-qualified/);
  const already=await rotateWorkerSnapshot({symbol:'NASDAQ:QQQ',_deps:x.deps});
  assert.equal(already.error_code,'ALREADY_RESIDENT');
});

test('rotating sampler remains operational after shrinking to one three-pane market worker',async()=>{
 const initial=setup();
 const subset=initial.state.entries.slice(37);
 const entries=subset.map((entry,index)=>({...entry,assignment:{
  worker_slot:0,pane_index:index,chart_id:'compact',target_id:'live-compact'
 }}));
 const state={entries,topology_plan:{tabs:[{tab_index:0,pane_count:3}]},
  worker_tabs:[{slot:0,chart_id:'compact',target_id:'live-compact',
    layout_name:'DTV Market 01',pane_count:3,persistent_layout:true}]};
 const chosen=selectRotatingPane(state);
 assert.equal(chosen.pane_count,3);
 assert.equal(chosen.slot,0);
 assert.equal(chosen.pane_index,1);
 const panes=entries.map(e=>({resolved_symbol:e.symbol,resolution:e.timeframe,symbol_identity:{},studies:[]}));
 let journal=null,seenCounts=[],mutated=[];
 const overrides={
  status:()=>state,
  read:async(_chart,index,count)=>{seenCounts.push(count);return {pane:panes[index],all:panes};},
  set:async(_chart,index,symbol,tf,count)=>{seenCounts.push(count);mutated.push(symbol);
    panes[index]={resolved_symbol:symbol,resolution:tf,symbol_identity:{},studies:[]};},
  wait:async()=>null,
  snapshot:async symbol=>({requested_symbols:[symbol],missing:[],ambiguous_symbols:[],
    snapshots:[{chart_id:'compact',target_id:'live-compact',pane_index:1,
      success:true,resolved_symbol:symbol,quote:{source_timestamp_ms:1000}}]}),
  getJournal:()=>journal,putJournal:v=>{journal=v;},clearJournal:()=>{journal=null;},
 };
 const result=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:overrides});
 assert.equal(result.success,true);
 assert.equal(result.restored,true);
 assert.equal(result.opened_tabs,0);
 assert.deepEqual(mutated,['NASDAQ:ADBE','NASDAQ:QQQ']);
 assert.equal(journal,null);
 assert.equal(panes[1].resolved_symbol,'NASDAQ:QQQ');
 assert.ok(seenCounts.every(x=>x===3));
});
test('rotation refuses missing pane witnesses, non-market workers and protected handles',()=>{
 const initial=setup(), state=initial.state;
 state.worker_tabs[4].layout_name='DTV Worker 06';
 assert.throws(()=>selectRotatingPane(state),/No safely replaceable pane/);
 state.worker_tabs[4].layout_name='DTV Market 05';
 state.entries[38].assignment.target_id='wrong';
 assert.throws(()=>selectRotatingPane(state),/No safely replaceable pane/);
});
