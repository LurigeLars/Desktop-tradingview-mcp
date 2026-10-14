import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateWorkerSnapshot, recoverRotatingPane, selectRotatingPane } from '../src/core/rotating-worker.js';

function setup() {
  const entries = Array.from({length:40},(_,i)=>({
    handle: 'h'+i, symbol:'NASDAQ:BASE'+i, timeframe:i>=37?'5':'60',
    studies:[], groups:i>=37?['watch:resident','watch:tactical_current']:['watch:resident','morning'],
    assignment:{worker_slot:Math.floor(i/8),pane_index:i%8,chart_id:'chart'+Math.floor(i/8)},
  }));
  const state={entries,topology_plan:{tabs:Array.from({length:5},(_,i)=>({tab_index:i,pane_count:8}))},
    worker_tabs:Array.from({length:5},(_,i)=>({slot:i,chart_id:'chart'+i}))};
  const panes=entries.slice(32).map(e=>({
    resolved_symbol:e.symbol,resolution:e.timeframe,symbol_identity:{},studies:[],
  }));
  let journal=null, calls=[];
  const deps={
    status:()=>state,
    read:async()=>({pane:panes[7],all:panes}),
    set:async(chartId,index,symbol,timeframe)=>{
      calls.push({chartId,index,symbol,timeframe});
      panes[index]={resolved_symbol:symbol,resolution:timeframe,studies:[],symbol_identity:{}};
    },
    wait:async()=>null,
    snapshot:async symbol=>({
      requested_symbols:[symbol],missing:[],ambiguous_symbols:[],
      snapshots:[{chart_id:'chart4',target_id:'runtime4',pane_index:7,
        success:true,resolved_symbol:symbol,quote:{last:100,source_timestamp_ms:1000}}],
    }),
    getJournal:()=>journal,
    putJournal:o=>{journal=o;}, clearJournal:()=>{journal=null;},
  };
  return {state,panes,deps,calls,get journal(){return journal;}};
}

test('one low-priority pane in fifth existing tab, never a sixth',()=>{
  const x=setup(),v=selectRotatingPane(x.state);
  assert.equal(v.slot,4);assert.equal(v.pane_index,7);
  assert.equal(v.chart_id,'chart4');
  x.state.entries[39].groups.push('watch:user_retained');
  assert.equal(selectRotatingPane(x.state).pane_index,6);
});
test('sample and restore original in the same worker tab with no new tabs',async()=>{
  const x=setup();
  const v=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(v.success,true);assert.equal(v.restored,true);assert.equal(v.opened_tabs,0);
  assert.equal(v.snapshot.resolved_symbol,'NASDAQ:ADBE');
  assert.deepEqual(x.calls.map(z=>z.symbol),['NASDAQ:ADBE','NASDAQ:BASE39']);
  assert.equal(x.panes[7].resolved_symbol,'NASDAQ:BASE39');
  assert.equal(x.journal,null);
});
test('missing/suspect quote cannot be returned and original is restored',async()=>{
  const x=setup();
  x.deps.snapshot=async()=>({requested_symbols:['NASDAQ:ADBE'],missing:['NASDAQ:ADBE'],snapshots:[]});
  const r=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(r.success,false);assert.equal(r.restored,true);
  assert.equal(r.error_code,'ROTATION_SAMPLE_FAILED');
  assert.equal(x.panes[7].resolved_symbol,'NASDAQ:BASE39');
  assert.equal(x.journal,null);
});
test('failed restoration leaves durable journal and blocks future rotations',async()=>{
  const x=setup(),original=x.deps.set;
  x.deps.set=async(...a)=>{if(a[2]==='NASDAQ:BASE39')throw Error('blocked restore');return original(...a)};
  const r=await rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps});
  assert.equal(r.success,false);assert.equal(r.error_code,'RESTORATION_PENDING');
  assert.ok(x.journal);assert.equal(x.panes[7].resolved_symbol,'NASDAQ:ADBE');
  const safe=await recoverRotatingPane({dry_run:true,_deps:x.deps});
  assert.equal(safe.can_restore,true);
  x.deps.set=original;
  const restored=await recoverRotatingPane({_deps:x.deps});
  assert.equal(restored.restored,true);assert.equal(x.journal,null);
});
test('unexpected third-party pane change makes rotation recovery fail closed',async()=>{
  const x=setup();
  x.deps.putJournal({chart_id:'chart4',pane_index:7,handle:'h39',
    original:{symbol:'NASDAQ:BASE39',timeframe:'5'},temporary:'NASDAQ:ADBE'});
  x.panes[7]={resolved_symbol:'NASDAQ:UNKNOWN',resolution:'60',studies:[],symbol_identity:{}};
  await assert.rejects(()=>recoverRotatingPane({_deps:x.deps}),/unexpected symbol/);
  assert.equal(x.calls.length,0);assert.ok(x.journal);
});
test('preflight refuses changed resident layouts and already-resident symbols',async()=>{
  const x=setup();
  x.panes[1].resolved_symbol='NASDAQ:WRONG';
  await assert.rejects(()=>rotateWorkerSnapshot({symbol:'NASDAQ:ADBE',_deps:x.deps}),/identities not aligned/);
  assert.equal(x.calls.length,0);
  await assert.rejects(()=>rotateWorkerSnapshot({symbol:'ADBE',_deps:x.deps}),/exchange-qualified/);
  const already=await rotateWorkerSnapshot({symbol:'NASDAQ:BASE2',_deps:x.deps});
  assert.equal(already.error_code,'ALREADY_RESIDENT');
});
