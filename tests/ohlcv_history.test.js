/**
 * Unit tests for cursor-based OHLCV history. No TradingView account/CDP required.
 * Fake chart series grows only when requestMoreData is invoked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOhlcvHistory } from '../src/core/history.js';
import { verifyHistoryResearchTarget, registerDataTools, historyResult } from '../src/tools/data.js';
import { LEGACY_TOOL_ANNOTATIONS } from '../src/server/tool-annotations.js';

const ORIGIN = 1700000000;
function createHarness({
  total = 2500, initiallyLoaded = 120, symbol = 'BATS:NVDA', resolution = '1',
  neverGrows = false, breakIdentity = false, breakTarget = false, duplicate = false,
} = {}) {
  const all = Array.from({length:total}, (_, i) => ({
    time:ORIGIN+i*60, open:100+i/10000, high:101+i/10000,
    low:99+i/10000, close:100+i/10000, volume:200+i%100
  }));
  if (duplicate) all[total-2].time = all[total-3].time;
  let earliest = Math.max(0, total-initiallyLoaded), calls = 0, probes = 0, change = false, target = 'unit-test-chart';
  const evaluate = async js => {
    if (js.includes('.requestMoreData(1000)')) {
      calls++;
      if (!neverGrows) earliest = Math.max(0, earliest-1000);
      if (breakIdentity) change=true;
      if (breakTarget) target = 'different-chart';
      return true;
    }
    if (js.includes('rows = []')) {
      const m = js.match(/rows.length < (\d+)/), count = Number(m?.[1]);
      const before = js.match(/v\[0\] < (\d+)/);
      const subset = all.slice(earliest).filter(b=>!before||b.time<Number(before[1]));
      return { symbol:change?'BATS:OTHER':symbol, resolution,
        loaded:all.length-earliest, bars:subset.slice(-count) };
    }
    if (js.includes('eligible = 0')) {
      probes++;
      const before = js.match(/v\[0\] < (\d+)/);
      const subset = all.slice(earliest).filter(b=>!before||b.time<Number(before[1]));
      return {symbol:change?'BATS:OTHER':symbol,resolution,
        loaded:all.length-earliest,eligible:subset.length,
        first_time:all[earliest]?.time??null,
        last_time:all.at(-1)?.time??null,more:earliest>0};
    }
    throw new Error('Unexpected evaluate call: '+js.slice(0,200));
  };
  return { expected_symbol:symbol, expected_resolution:resolution,
    _deps:{evaluate,delay:async()=>{},getTargetInfo:async()=>({id:target})},
    get calls(){return calls;},get probes(){return probes;},all };
}

describe('DTV paginated OHLCV history', () => {
  it('paginates 20k+ unique one-minute bars with monotonic UTC timestamps', async () => {
    const h=createHarness({total:22500,initiallyLoaded:100});
    let cursor, rows=[], pages=0;
    while (true) {
      const page=await getOhlcvHistory({
        expected_symbol:h.expected_symbol, expected_resolution:'1',count:1000,
        ...(cursor?{cursor}:{}),_deps:h._deps
      });
      assert.equal(page.success,true);
      assert.ok(page.bars.length<=1000);
      assert.equal(page.symbol,h.expected_symbol);
      rows=page.bars.concat(rows);
      pages++;
      if(!page.has_more)break;
      assert.ok(page.next_cursor);
      cursor=page.next_cursor;
      assert.ok(pages<30,'infinite cursor loop');
    }
    assert.equal(rows.length,22500);
    assert.equal(new Set(rows.map(x=>x.time)).size,rows.length);
    assert.ok(rows.every((v,i)=>i===0||v.time>rows[i-1].time));
    assert.equal(rows[0].time,ORIGIN);
    assert.ok(h.calls>=21);
  });
  it('returns up to 8000 lossless compact columns and preserves cursor boundaries',async()=>{
    const h=createHarness({total:10000,initiallyLoaded:100});
    const args={expected_symbol:h.expected_symbol,expected_resolution:'1',format:'columns',count:8000,_deps:h._deps};
    const first=await getOhlcvHistory(args);
    assert.equal(first.format,'columns');
    assert.equal(first.returned,8000);
    assert.ok(first.has_more);
    for (const [key,field] of Object.entries({t:'time',o:'open',h:'high',l:'low',c:'close',v:'volume'}))
      assert.deepEqual(first.bars[key],h.all.slice(-8000).map(b=>b[field]));
    const wire=historyResult(first).content[0].text;
    assert.deepEqual(JSON.parse(wire),first);
    assert.ok(Buffer.byteLength(wire)<512*1024);
    assert.ok(!wire.includes('\n'));
    const second=await getOhlcvHistory({...args,cursor:first.next_cursor});
    assert.equal(second.returned,2000);
    assert.deepEqual(second.bars.t,h.all.slice(0,2000).map(b=>b.time));
    assert.ok(second.last_time<first.first_time);
    assert.equal(second.has_more,false);
    await assert.rejects(getOhlcvHistory({...args,count:8001}),/count/);
    await assert.rejects(getOhlcvHistory({...args,format:'rows'}),/count/);
    await assert.rejects(getOhlcvHistory({...args,format:'unknown'}),/format/);
  });
  it('preserves legacy row encoding and rejects oversized compact payloads explicitly',()=>{
    const row={success:true,bars:[{time:ORIGIN,open:1,high:2,low:1,close:2,volume:3}]};
    assert.equal(historyResult(row).content[0].text,JSON.stringify(row,null,2));
    const values=Array(8000).fill(1.2345678901234567e-100);
    assert.throws(()=>historyResult({format:'columns',bars:{t:values,o:values,h:values,l:values,c:values,v:values}}),/HISTORY_OUTPUT_TOO_LARGE/);
  });
  it('rejects invalid candles before column conversion',async()=>{
    const h=createHarness({duplicate:true});
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:120,format:'columns',_deps:h._deps}),/HISTORY_INVALID/);
  });
  it('selects strict before_time and returns stable cursors',async()=>{
    const h=createHarness();
    const before=h.all[1700].time;
    const first=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',before_time:before,count:80,_deps:h._deps});
    assert.equal(first.bars.length,80);
    assert.ok(first.last_time<before);
    const second=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:80,cursor:first.next_cursor,_deps:h._deps});
    assert.equal(second.bars.length,80);
    assert.ok(second.last_time<first.first_time);
  });
  it('does not request older bars when cache already covers page',async()=>{
    const h=createHarness({initiallyLoaded:2000});
    const result=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:500,_deps:h._deps});
    assert.equal(result.returned,500);
    assert.equal(result.pages_loaded,0);
    assert.equal(h.calls,0);
  });
  it('rejects cursor identity mismatch and invalid timestamps',async()=>{
    const h=createHarness();
    const first=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:10,_deps:h._deps});
    await assert.rejects(getOhlcvHistory({expected_symbol:'BATS:TSLA',expected_resolution:'1',cursor:first.next_cursor,_deps:h._deps}),/CURSOR_IDENTITY_MISMATCH/);
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',before_time:1000,_deps:h._deps}),/UNIX timestamp/);
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:1001,_deps:h._deps}),/count/);
  });
  it('fails closed when the attached symbol changes while loading',async()=>{
    const h=createHarness({breakIdentity:true});
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:1000,_deps:h._deps}),/CHART_CHANGED/);
  });
  it('rejects a target switch even when symbol/timeframe are unchanged',async()=>{
    const h=createHarness({breakTarget:true});
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:1000,_deps:h._deps}),/TARGET_CHANGED/);
  });
  it('fails closed on stalled historical loading',async()=>{
    const h=createHarness({neverGrows:true});
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:1000,_deps:h._deps}),/HISTORY_STALLED/);
  });
  it('fails closed when source contains duplicate timestamps',async()=>{
    const h=createHarness({duplicate:true,initiallyLoaded:120});
    await assert.rejects(getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:120,_deps:h._deps}),/HISTORY_INVALID/);
  });
  it('accepts normal UTC seconds across a DST change without local timestamp rewriting',async()=>{
    const h=createHarness({total:700,initiallyLoaded:700});
    const result=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:700,_deps:h._deps});
    assert.equal(result.bars[0].time,h.all[0].time);
    assert.equal(result.bars.at(-1).time,h.all.at(-1).time);
  });

  it('binds pagination cursors to one exact CDP chart target',async()=>{
    const h=createHarness({initiallyLoaded:2000});
    const p=await getOhlcvHistory({expected_symbol:h.expected_symbol,expected_resolution:'1',count:100,_deps:h._deps});
    assert.ok(p.next_cursor);
    await assert.rejects(getOhlcvHistory({
      expected_symbol:h.expected_symbol,expected_resolution:'1',cursor:p.next_cursor,
      count:100,_deps:{...h._deps,getTargetInfo:async()=>({id:'different-nvda-chart'})}
    }),/CURSOR_TARGET_MISMATCH/);
  });
  it('retries transient false history availability after chart loading',async()=>{
    const h=createHarness({initiallyLoaded:100});
    const original=h._deps.evaluate;
    let attempts=0;
    const probe=async js=>{
      const result=await original(js);
      if(js.includes('eligible = 0') && ++attempts===1)
        return {...result,more:false};
      return result;
    };
    const p=await getOhlcvHistory({
      expected_symbol:h.expected_symbol,expected_resolution:'1',count:1000,
      _deps:{...h._deps,evaluate:probe}
    });
    assert.equal(p.returned,1000);
    assert.ok(h.calls>0);
  });
  it('requires registered read-only annotations and a uniquely identified chart',()=>{
    assert.deepEqual(LEGACY_TOOL_ANNOTATIONS.data_get_ohlcv_history,
      LEGACY_TOOL_ANNOTATIONS.data_get_ohlcv);
    const tools=new Map();
    registerDataTools({tool(name,description,schema,handler){tools.set(name,{schema,handler});}});
    const normal=tools.get('data_get_ohlcv').schema;
    assert.equal(normal.history.safeParse({
      expected_symbol:'BATS:NVDA',expected_resolution:'1',count:1000,
    }).success,true);
    assert.equal(normal.history.safeParse({count:1000}).success,false);
    assert.equal(normal.history.safeParse({expected_symbol:'BATS:NVDA',expected_resolution:'1',count:8000,format:'columns'}).success,true);
    assert.equal(normal.history.safeParse({expected_symbol:'BATS:NVDA',expected_resolution:'1',count:8001,format:'columns'}).success,false);
    assert.equal(tools.has('data_get_ohlcv_history'),true);
    const tabs={tabs:[
      {id:'qa-target',is_chart:true,chart_id:'qa-chart',title:'DTV OHLCV QA'},
      {id:'worker-target',is_chart:true,chart_id:'worker-chart',title:'BATS:NVDA DTV Worker 06'},
    ]};
    assert.equal(verifyHistoryResearchTarget({id:'qa-target'},tabs).id,'qa-target');
    // Workers are ordinary AI charts, so history paging may run on them.
    assert.equal(verifyHistoryResearchTarget({id:'worker-target'},tabs).id,'worker-target');
    assert.throws(()=>verifyHistoryResearchTarget({id:'absent'},tabs),/HISTORY_TARGET_UNVERIFIED/);
  });

});
