import test from 'node:test';
import assert from 'node:assert/strict';
import {planPersonalLayoutOpen} from '../src/core/personal-routing.js';
import {recordWorkerUsage,workerUsageReport,usageFromSnapshot} from '../src/core/worker-usage.js';

test('personal chart reuse never opens duplicate and refuses worker/ambiguity',()=>{
 const mk=(id,chart_id)=>({id,chart_id,is_chart:true});
 const worker={worker_tabs:[{chart_id:'worker',target_id:'worker-id'}]};
 const tabState={tabs:[mk('personal1','stocks'),mk('worker-id','worker')]};
 assert.deepEqual(planPersonalLayoutOpen({chartId:'stocks',tabState,workerState:worker}),
   {action:'reuse',target_id:'personal1',matched_count:1});
 assert.deepEqual(planPersonalLayoutOpen({chartId:'stocks',tabState,workerState:worker,forceNew:true}),
   {action:'open',matched_count:1});
 assert.deepEqual(planPersonalLayoutOpen({chartId:'unknown',tabState,workerState:worker}),
   {action:'open',matched_count:0});
 assert.throws(()=>planPersonalLayoutOpen({chartId:'worker',tabState,workerState:worker}),/protected worker/);
 assert.throws(()=>planPersonalLayoutOpen({
   chartId:'stocks',
   tabState:{tabs:[mk('personal1','stocks'),mk('personal2','stocks')]},
   workerState:worker,
 }),/Multiple personal tabs/);
});

test('usage counts only actual matching live worker panes and has no price data',()=>{
 const entries=[
  {handle:'a',assignment:{target_id:'t1',pane_index:0,resolved_symbol:'BATS:QQQ',resolution:'60'}},
  {handle:'b',assignment:{target_id:'t1',pane_index:1,resolved_symbol:'BATS:SPY',resolution:'60'}},
  {handle:'unused',assignment:{target_id:'t2',pane_index:0,resolved_symbol:'TVC:DXY',resolution:'60'}},
 ];
 const response={success:true,mode:'fast',requested_symbols:['NASDAQ:QQQ'],
  snapshots:[
   {target_id:'t1',pane_index:0,resolved_symbol:'BATS:QQQ',resolution:'60',success:true,quote:{last:799.99}},
   {target_id:'t1',pane_index:1,resolved_symbol:'BATS:SPY',resolution:'60',success:false},
   {target_id:'personal',pane_index:0,resolved_symbol:'BATS:QQQ',resolution:'60',success:true},
   {target_id:'t2',pane_index:0,resolved_symbol:'TVC:OTHER',resolution:'60',success:true},
  ]};
 let saved={version:1,days:{}};
 const deps={read:()=>saved,write:v=>{saved=structuredClone(v);}};
 const nowMs=Date.parse('2026-10-21T09:00:00Z');
 const result=recordWorkerUsage({response,workerState:{entries},consumer:'trade_spine',nowMs,_deps:deps});
 assert.deepEqual(result.handles,['a']);
 let report=workerUsageReport({_deps:deps});
 assert.equal(report.days['2026-10-21'].requests,1);
 assert.equal(report.days['2026-10-21'].handles.a.reads,1);
 assert.equal(report.days['2026-10-21'].handles.b,undefined);
 assert.equal(report.days['2026-10-21'].handles.unused,undefined);
 assert.equal(report.days['2026-10-21'].consumers.trade_spine.requests,1);
 assert.equal(JSON.stringify(report).includes('799.99'),false);
 recordWorkerUsage({response,workerState:{entries},consumer:'agent',nowMs,_deps:deps});
 report=workerUsageReport({_deps:deps});
 assert.equal(report.days['2026-10-21'].handles.a.reads,2);
 assert.equal(report.days['2026-10-21'].handles.a.by_consumer.agent,1);
 assert.equal(report.days['2026-10-21'].handles.a.by_consumer.trade_spine,1);
});
test('usage retention and untrusted consumer names are bounded',()=>{
 let saved={version:1,days:{'2026-09-01':{requests:100,handles:{}}}};
 const deps={read:()=>saved,write:v=>{saved=structuredClone(v);}};
 const observation=usageFromSnapshot({
  response:{snapshots:[]},workerState:{entries:[]},
  consumer:'../../name',nowMs:Date.parse('2026-10-21T08:00:00Z')
 });
 assert.equal(observation.consumer,'unattributed');
 recordWorkerUsage({response:{snapshots:[]},workerState:{entries:[]},nowMs:Date.parse('2026-10-21T08:00:00Z'),_deps:deps});
 assert.equal(saved.days['2026-09-01'],undefined);
});
