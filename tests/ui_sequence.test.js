import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {uiSequence,uiSequenceStepExpression,validateUiSequence} from '../src/core/ui.js';

const chart={id:'t1',type:'page',url:'https://www.tradingview.com/chart/QA123/'};
const args={target_id:'t1',chart_id:'QA123'};
const find={action:'find',by:'aria-label',value:'Indicators'};
const click={...find,action:'click'};
const assertion={action:'assert',by:'data-name',value:'dialog'};
const waitStep={...assertion,action:'wait'};

function fixture(){
  let clicks=0,opened=false,clock=1000,covered=false;
  function el(attrs,text,tag='BUTTON'){
    return {tagName:tag,innerText:text,disabled:false,isConnected:true,
      getAttribute:k=>attrs[k]??null,closest:()=>null,
      getBoundingClientRect:()=>({width:20,height:20,left:1,top:1}),
      matches:()=>tag==='BUTTON',contains:e=>e===button,click(){clicks++;opened=true;}};
  }
  const button=el({'aria-label':'Indicators'},'Indicators');
  const dialog=el({'data-name':'dialog'},'Open dialog','DIV');
  const location=new URL(chart.url);
  const document={querySelectorAll:sel=>sel==='[data-name]'?(opened?[dialog]:[]):[button],
    elementFromPoint:()=>covered?null:button};
  const ctx={location,document,Date:{now:()=>clock},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};
  const deps={listTargets:async()=>[chart],protectedIds:()=>new Set(),now:()=>clock,
    wait:async ms=>{clock+=ms},withTarget:async(id,fn)=>fn(async expr=>runInNewContext(expr,ctx))};
  return {ctx,deps,button,dialog,get clicks(){return clicks},cover(){covered=true},uncover(){covered=false},open(){opened=true}};
}
test('sequence reads, clicks exact visible control and verifies result on same target',async()=>{
  const f=fixture();
  const r=await uiSequence({...args,steps:[find,click,waitStep],_deps:f.deps});
  assert.equal(r.success,true);assert.equal(r.completed_steps,3);assert.equal(f.clicks,1);
  assert.equal(r.results[0].items[0].text,'Indicators');assert.equal(r.results[2].condition_met,true);
});
test('rejects arbitrary code, oversized sequences, unsupported fields and unverified clicks before action',()=>{
  for(const steps of [[{...find,action:'evaluate'}],[{...find,by:'css'}],[{...find,expression:'1'}],[click],Array(9).fill(find),[{...find,state:'absent'}]]){
    assert.throws(()=>validateUiSequence({...args,steps}));
  }
});
test('target identity, protected worker, native Desktop and wrong chart fail before connecting',async()=>{
  const f=fixture();const withTarget=async()=>assert.fail('must not attach');
  await assert.rejects(uiSequence({...args,steps:[find],_deps:{...f.deps,withTarget,protectedIds:()=>new Set(['QA123'])}}),/PROTECTED/);
  await assert.rejects(uiSequence({...args,steps:[find],_deps:{...f.deps,withTarget,listTargets:async()=>[{...chart,url:'file:///app.asar/app/window/index.html'}]}}),/HTTPS/);
  await assert.rejects(uiSequence({...args,chart_id:'Wrong',steps:[find],_deps:{...f.deps,withTarget}}),/identity mismatch/);
});
test('ambiguous or obscured click, changed location, timeout and literal input stop safely',async()=>{
  const f=fixture();f.cover();
  let r=await uiSequence({...args,steps:[click,assertion,find],_deps:f.deps});
  assert.equal(r.success,false);assert.equal(r.error,'CLICK_CONTROL_OBSCURED_OR_OFFSCREEN');assert.equal(f.clicks,0);assert.equal(r.completed_steps,0);
  const g=fixture();g.ctx.document.querySelectorAll=()=>[g.button,g.button];
  r=await uiSequence({...args,steps:[click,assertion],_deps:g.deps});assert.equal(r.error,'CLICK_MATCH_NOT_UNIQUE');assert.equal(g.clicks,0);
  const h=fixture();h.ctx.location=new URL('https://www.tradingview.com/chart/Other/');
  r=await uiSequence({...args,steps:[click,assertion],_deps:h.deps});assert.equal(r.error,'CHART_IDENTITY_CHANGED');assert.equal(h.clicks,0);
  const j=fixture();
  r=await uiSequence({...args,steps:[waitStep,click,assertion],_deps:j.deps});assert.equal(r.success,false);assert.equal(j.clicks,0);
  const k=fixture();const value='");globalThis.injected=true;//';
  const result=runInNewContext(uiSequenceStepExpression({origin:chart.url.split('/chart')[0],chart_id:'QA123',step:{...find,value},deadline:2000}),k.ctx);
  assert.equal(result.count,0);assert.equal(k.ctx.injected,undefined);
});
test('transport failure after click is never retried; outcome marked unknown',async()=>{
  const f=fixture();let calls=0;
  const r=await uiSequence({...args,steps:[click,assertion],_deps:{...f.deps,withTarget:async(id,fn)=>fn(async()=>{calls++;throw Error('lost CDP')})}});
  assert.equal(r.success,false);assert.equal(r.click_outcome_unknown,true);assert.equal(calls,1);
});

test('text click searches only interactive controls, not nested spans',async()=>{
  const f=fixture();
  const original=f.ctx.document.querySelectorAll;
  f.ctx.document.querySelectorAll=sel=>{
    if(sel.startsWith('button')){
      assert.equal(sel.includes(',span'),false);
      return [f.button];
    }
    return original(sel);
  };
  const r=await uiSequence({...args,steps:[{action:'click',by:'text',value:'Indicators'},assertion],_deps:f.deps});
  assert.equal(r.success,true);assert.equal(f.clicks,1);
});
test('transient obstruction is retried only before any click',async()=>{
  const f=fixture();f.cover();
  const wait=f.deps.wait;
  f.deps.wait=async ms=>{await wait(ms);f.uncover()};
  const r=await uiSequence({...args,steps:[click,assertion],_deps:f.deps});
  assert.equal(r.success,true);assert.equal(f.clicks,1);
});
