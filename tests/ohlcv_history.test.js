/**
 * Unit tests for cursor-based OHLCV history. No TradingView account/CDP required.
 * Fake chart series grows only when requestMoreData is invoked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOhlcvHistory } from '../src/core/history.js';
import { verifyHistoryResearchTarget, registerDataTools } from '../src/tools/data.js';
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
  it('requires registered read-only annotations and excludes market workers',()=>{
    assert.deepEqual(LEGACY_TOOL_ANNOTATIONS.data_get_ohlcv_history,
      LEGACY_TOOL_ANNOTATIONS.data_get_ohlcv);
    const tools=new Map();
    registerDataTools({tool(name,description,schema,handler){tools.set(name,{schema,handler});}});
    const normal=tools.get('data_get_ohlcv').schema;
    assert.equal(normal.history.safeParse({
      expected_symbol:'BATS:NVDA',expected_resolution:'1',count:1000,
    }).success,true);
    assert.equal(normal.history.safeParse({count:1000}).success,false);
    assert.equal(tools.has('data_get_ohlcv_history'),true);
    const tabs={tabs:[
      {id:'qa-target',is_chart:true,chart_id:'qa-chart',title:'DTV OHLCV QA'},
      {id:'worker-target',is_chart:true,chart_id:'worker-chart',title:'BATS:NVDA DTV Worker 06'},
    ]};
    const workerState={worker_tabs:[{target_id:'worker-target',chart_id:'worker-chart'}]};
    assert.equal(verifyHistoryResearchTarget({id:'qa-target'},tabs,workerState).id,'qa-target');
    assert.throws(()=>verifyHistoryResearchTarget({id:'worker-target'},tabs,workerState),/WORKER_TARGET_FORBIDDEN/);
    assert.throws(()=>verifyHistoryResearchTarget({id:'absent'},tabs,workerState),/HISTORY_TARGET_UNVERIFIED/);
    assert.throws(()=>verifyHistoryResearchTarget({id:'worker-target'},tabs,{worker_tabs:[]}),/WORKER_TARGET_FORBIDDEN/);
  });

});
