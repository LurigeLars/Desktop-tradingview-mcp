import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {layoutDeleteExpression} from '../src/core/ui.js';

function fixture(){
  let opened=false,removes=0,deletes=0;
  const name='QA Test';
  const el=(attrs={},text='')=>({
    isConnected:true,innerText:text,textContent:text,disabled:false,
    getAttribute:k=>attrs[k]??null,closest:()=>null,contains:()=>false,
    getBoundingClientRect:()=>({left:0,top:0,width:20,height:20}),
  });
  const remove=el({'aria-label':'Remove'});remove.click=()=>{removes++;opened=true};
  const button=el({},'Delete');button.click=()=>{deletes++;opened=false};
  const title=el({},name);
  const row=el({href:'/chart/QA123/'});row.querySelector=()=>title;row.querySelectorAll=()=>[remove];
  const picker=el();picker.querySelectorAll=()=>[row];
  const dialog=el({},'Delete this chart layout?\nDoing this will permanently delete your "QA Test" layout with all drawings.');
  dialog.querySelectorAll=()=>[button];
  const document={querySelectorAll:s=>s.includes('confirm-dialog')?(opened?[dialog]:[]):[picker],
    elementFromPoint:()=>opened?button:remove};
  const ctx={document,location:new URL('https://www.tradingview.com/chart/Host123/'),URL,
    Date:{now:()=>1000},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};
  const run=phase=>runInNewContext(layoutDeleteExpression({chart_id:'QA123',name,origin:ctx.location.origin,
    host_chart_id:'Host123',phase,deadline:2000}),ctx);
  return {run,dialog,ctx,row,open:()=>{opened=true},get removes(){return removes},get deletes(){return deletes}};
}
test('fresh exact deletion dialog confirms only after matching row removal',()=>{
  const f=fixture();
  assert.equal(f.run('remove').clicked,true);
  assert.equal(f.run('confirm').clicked,true);
  assert.equal(f.removes,1);assert.equal(f.deletes,1);
});
test('preexisting dialog, wrong name, changed chart and obscured control fail closed',()=>{
  const f=fixture();f.open();
  assert.equal(f.run('remove').error,'EXISTING_CONFIRMATION');assert.equal(f.removes,0);
  const g=fixture();g.run('remove');g.dialog.innerText='Delete this chart layout? Doing this will permanently delete your "Other" layout';
  assert.equal(g.run('confirm').error,'CONFIRMATION_NAME_MISMATCH');assert.equal(g.deletes,0);
  const h=fixture();h.ctx.location=new URL('https://www.tradingview.com/chart/Another/');
  assert.equal(h.run('remove').error,'CHART_IDENTITY_CHANGED');
  const j=fixture();j.ctx.document.elementFromPoint=()=>null;
  assert.equal(j.run('remove').error,'CONTROL_OBSCURED');assert.equal(j.removes,0);
});
