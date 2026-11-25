import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createToolUsageStore,installToolUsage} from '../src/server/tool-usage.js';
import {jsonResult} from '../src/tools/_format.js';

function fixture(t,opts={}){
  const root=mkdtempSync(join(tmpdir(),'dtv-usage-'));
  const store=createToolUsageStore({root,now:()=>Date.parse('2026-11-25T01:00:00Z'),...opts});
  t.after(()=>{store.flush();rmSync(root,{recursive:true,force:true});});
  return {root,store};
}
test('usage records handler failure even without MCP error and does not persist sensitive values',async t=>{
  const {root,store}=fixture(t);const handlers=new Map();
  const server={registerTool:(name,config,fn)=>handlers.set(name,fn)};
  installToolUsage(server,store);
  server.registerTool('ui_sequence',{},async()=>jsonResult({success:false,error:'CONDITION_NOT_MET',
    failed_action:'wait',retry_count:2,results:[{action:'click',secret:'PRIVATE_RESPONSE'}],target_id:'PRIVATE_TARGET'}));
  server.registerTool('quote_get',{},async()=>jsonResult({success:false,error:'SECRET_TOKEN_123'}));
  server.registerTool('layout_list',{},async()=>jsonResult({success:true,symbol:'PRIVATE_SYMBOL'}));
  server.registerTool('tab_list',{},async()=>{throw new Error('PRIVATE_EXCEPTION')});
  const result=await handlers.get('ui_sequence')({password:'PRIVATE_PARAMETER'});
  assert.match(result.content[0].text,/PRIVATE_RESPONSE/);
  await handlers.get('quote_get')();await handlers.get('layout_list')();
  await assert.rejects(handlers.get('tab_list')(),/PRIVATE_EXCEPTION/);
  const report=store.report();
  assert.equal(report.recorded_calls,4);assert.equal(report.recorded_errors,3);
  const ui=report.tools.find(r=>r.tool==='ui_sequence');
  assert.equal(ui.ui_steps.click.completed,1);assert.equal(ui.ui_steps.wait.failed,1);
  assert.equal(ui.ui_retries,2);assert.equal(ui.error_codes.CONDITION_NOT_MET,1);
  assert.equal(report.tools.find(r=>r.tool==='quote_get').error_codes.UNCLASSIFIED_ERROR,1);
  assert.equal(report.tools.find(r=>r.tool==='tab_list').error_codes.HANDLER_EXCEPTION,1);
  const disk=readFileSync(join(root,'2026-11-25.ndjson'),'utf8');
  assert.doesNotMatch(disk,/PRIVATE_|SECRET_TOKEN/);
  assert.equal(store.report({tool:'quote_get'}).recorded_calls,1);
});
test('bounded report, retention, histogram and coverage diagnostics',t=>{
  const {root,store}=fixture(t);
  writeFileSync(join(root,'2026-10-01.ndjson'),'old');
  writeFileSync(join(root,'unrelated.txt'),'keep');
  for(const ms of [10,20,200,800,900])store.record('quote_get',ms,{ok:true});
  store.record('tab_list',100,{ok:false,code:'NEVER_STORE_ME'});
  store.record('tool_usage',1,{ok:true});
  const report=store.report({limit:1});
  assert.equal(report.recorded_calls,6);assert.equal(report.tool_count,2);assert.equal(report.truncated,true);
  assert.equal(report.tools[0].p50_upper_ms,200);assert.equal(report.tools[0].p95_upper_ms,900);
  assert.equal(report.tools[0].max_ms,900);
  assert.equal(readdirSync(root).includes('2026-10-01.ndjson'),false);
  assert.equal(readdirSync(root).includes('unrelated.txt'),true);
  assert.throws(()=>store.report({days:31}));assert.throws(()=>store.report({tool:'../secret'}));
  writeFileSync(join(root,'2026-11-24.ndjson'),'bad json\n');
  assert.equal(store.report().invalid_records,1);
  assert.deepEqual(store.report().coverage_limited_days,['2026-11-24']);
});
test('capacity exhaustion is visible and cannot enlarge the daily file',t=>{
  const {root,store}=fixture(t,{dayLimit:100});
  for(let i=0;i<20;i++)store.record('quote_get',50,{ok:true});
  const report=store.report();
  assert.deepEqual(report.coverage_limited_days,['2026-11-25']);
  assert.equal(report.recorded_calls,0);
  assert.equal(readdirSync(root).includes('2026-11-25.limited'),true);
});
test('telemetry failure never changes a handler result or thrown error',async()=>{
  let callback;const server={registerTool:(_n,_c,h)=>{callback=h}};
  installToolUsage(server,{record(){throw new Error('disk full')}});
  server.registerTool('quote_get',{},async()=>({content:[]}));
  assert.deepEqual(await callback(),{content:[]});
  server.registerTool('quote_get',{},async()=>{throw new Error('original')});
  await assert.rejects(callback(),/original/);
});
