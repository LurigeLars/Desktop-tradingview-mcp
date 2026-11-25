/**
 * Local, bounded tool metadata only. No request arguments, response text, URLs,
 * session/client identities, symbols, or free-form errors are persisted.
 */
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';

const RETAIN_DAYS=30;
const DAY_MS=86400000;
const DAY_LIMIT=2*1024*1024;
const BUCKETS=[10,25,50,100,200,300,500,750,1000,1500,2000,3000,5000,10000,20000,30000,60000,120000,300000,600000];
const ACTIONS=['find','click','wait','assert'];
const CODES=new Set([
  'UNCLASSIFIED_ERROR','HANDLER_EXCEPTION','HISTORY_OUTPUT_TOO_LARGE','CHART_UNAVAILABLE','CHART_CHANGED',
  'CURSOR_IDENTITY_MISMATCH','TARGET_UNAVAILABLE','CURSOR_TARGET_MISMATCH','TARGET_CHANGED',
  'HISTORY_EMPTY','HISTORY_PAGE_LIMIT','HISTORY_REQUEST_FAILED','HISTORY_STALLED','HISTORY_UNAVAILABLE',
  'HISTORY_CHANGED','HISTORY_INVALID','HISTORY_OUT_OF_RANGE','PROTECTED_WORKER_TAB','TRADE_ALERT_WATCHLIST',
  'RESTORATION_PENDING','ROTATION_REJECTED','RECOVERY_REJECTED','SIXTH_TAB_DISABLED','SEQUENCE_DEADLINE',
  'CHART_IDENTITY_CHANGED','CLICK_MATCH_NOT_UNIQUE','CLICK_CONTROL_NOT_ALLOWED',
  'CLICK_CONTROL_OBSCURED_OR_OFFSCREEN','WAIT_OR_SEQUENCE_TIMEOUT','INVALID_RENDERER_RESPONSE',
  'CLICK_NOT_VERIFIED','CONDITION_NOT_MET','CDP_SEQUENCE_FAILED','DEADLINE','CONTROL_NOT_AVAILABLE',
  'CONTROL_OBSCURED','PICKER_NOT_UNIQUE','LAYOUT_ROW_NOT_UNIQUE','EXISTING_CONFIRMATION',
  'PICKER_NOT_VISIBLE','REMOVE_CONTROL_NOT_UNIQUE','CONFIRMATION_NOT_UNIQUE','CONFIRMATION_NAME_MISMATCH',
  'DELETE_CONTROL_NOT_UNIQUE','CONFIRMATION_TIMEOUT','OTHER_LAYOUTS_CHANGED','DELETION_NOT_VERIFIED',
  'LAYOUT_DELETE_OUTCOME_UNVERIFIED','REMOVE_NOT_VERIFIED','CONFIRMATION_NOT_VERIFIED',
]);
const resultMetadata=new WeakMap();
const validTool=name=>typeof name==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(name);
const dayAt=ms=>new Date(ms).toISOString().slice(0,10);
const smallCount=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max?v:0;
function safeError(...values){
  for(const value of values){
    if(typeof value!=='string')continue;
    const code=value.slice(0,80).split(':',1)[0];
    if(CODES.has(code))return code;
  }
  return 'UNCLASSIFIED_ERROR';
}

/** Attach only sanitized metadata out of band; do not parse large serialized responses. */
export function rememberToolResult(result,obj,isError){
  const failed=Boolean(isError||obj?.success===false);
  const metadata={ok:!failed};
  if(failed)metadata.code=safeError(obj?.error_code,obj?.code,obj?.error);
  if(Array.isArray(obj?.results)&&obj.results.length<=8){
    const completed=obj.results.map(r=>r?.action);
    if(completed.every(a=>ACTIONS.includes(a)))metadata.completed=completed;
  }
  if(ACTIONS.includes(obj?.failed_action))metadata.failed_action=obj.failed_action;
  metadata.retries=smallCount(obj?.retry_count,100);
  resultMetadata.set(result,metadata);
  return result;
}

function validEvent(e){
  return e&&validTool(e.tool)&&Number.isInteger(e.ms)&&e.ms>=0&&e.ms<=86400000&&
    typeof e.ok==='boolean'&&(e.ok?e.code===undefined:CODES.has(e.code))&&
    (e.ui===undefined||(e.tool==='ui_sequence'&&Array.isArray(e.ui.completed)&&
      e.ui.completed.length<=8&&e.ui.completed.every(a=>ACTIONS.includes(a))&&
      (e.ui.failed===undefined||ACTIONS.includes(e.ui.failed))&&Number.isInteger(e.ui.retries)&&
      e.ui.retries>=0&&e.ui.retries<=100));
}
function accumulator(tool){
  return {tool,calls:0,errors:0,sum_ms:0,max_ms:0,buckets:Array(BUCKETS.length+1).fill(0),
    error_codes:Object.create(null),ui_steps:{},ui_retries:0};
}
function addEvent(a,e){
  a.calls++;a.errors+=Number(!e.ok);a.sum_ms+=e.ms;a.max_ms=Math.max(a.max_ms,e.ms);
  const bucket=BUCKETS.findIndex(b=>e.ms<=b);a.buckets[bucket<0?BUCKETS.length:bucket]++;
  if(!e.ok)a.error_codes[e.code]=(a.error_codes[e.code]||0)+1;
  if(e.ui){
    for(const action of e.ui.completed){
      const step=a.ui_steps[action]||={completed:0,failed:0};step.completed++;
    }
    if(e.ui.failed){const step=a.ui_steps[e.ui.failed]||={completed:0,failed:0};step.failed++;}
    a.ui_retries+=e.ui.retries;
  }
}
function percentile(a,p){
  let n=0;const rank=Math.ceil(a.calls*p);
  for(let i=0;i<a.buckets.length;i++){n+=a.buckets[i];if(n>=rank)return Math.min(a.max_ms,BUCKETS[i]??a.max_ms);}
  return null;
}
function summarize(a){
  return {tool:a.tool,calls:a.calls,errors:a.errors,error_rate:Math.round(a.errors/a.calls*10000)/10000,
    mean_ms:Math.round(a.sum_ms/a.calls),p50_upper_ms:percentile(a,.5),p95_upper_ms:percentile(a,.95),
    max_ms:a.max_ms,error_codes:a.error_codes,
    ...(a.tool==='ui_sequence'?{ui_steps:a.ui_steps,ui_retries:a.ui_retries}:{})};
}

/** One append-only file per UTC day, bounded and periodically flushed.
 * Concurrent local processes may append to the same day; malformed/oversize
 * files are explicitly flagged rather than treated as complete evidence.
 */
export function createToolUsageStore({root,now=Date.now,dayLimit=DAY_LIMIT,flushMs=5000,enabled=true}={}){
  let queue=[],timer=null,lastPrune=null,recordingErrors=0;
  const limited=new Set();
  const directory=root||resolve(process.env.LOCALAPPDATA||process.env.HOME||'.','tradingview-mcp','tool-usage');
  function prune(day){
    if(lastPrune===day)return;
    const first=dayAt(now()-(RETAIN_DAYS-1)*DAY_MS);
    mkdirSync(directory,{recursive:true,mode:0o700});
    for(const file of readdirSync(directory)){
      const m=/^(\d{4}-\d{2}-\d{2})\.(?:ndjson|limited)$/.exec(file);
      if(m&&m[1]<first)unlinkSync(join(directory,file));
    }
    for(const d of limited)if(d<first)limited.delete(d);
    lastPrune=day;
  }
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(!enabled)return;
    const batch=queue;queue=[];
    try{
      prune(dayAt(now()));
      const days=new Map();
      for(const {day,line} of batch){
        const lines=days.get(day)||[];lines.push(line);days.set(day,lines);
      }
      for(const [day,lines] of days){
        try{
          if(day<dayAt(now()-(RETAIN_DAYS-1)*DAY_MS))continue;
          const file=join(directory,day+'.ndjson'),mark=join(directory,day+'.limited');
          if(limited.has(day)||existsSync(mark)){limited.add(day);continue;}
          const payload=lines.join('');
          const bytes=existsSync(file)?statSync(file).size:0;
          if(bytes+Buffer.byteLength(payload)>dayLimit){
            limited.add(day);writeFileSync(mark,'capacity reached\n',{mode:0o600});continue;
          }
          appendFileSync(file,payload,{encoding:'utf8',mode:0o600});
        }catch{recordingErrors+=lines.length;limited.add(day);}
      }
    }catch{recordingErrors+=Math.max(1,batch.length);for(const {day} of batch)limited.add(day);}
  }
  function record(tool,ms,meta={}){
    if(!enabled||tool==='tool_usage'||!validTool(tool)||!Number.isFinite(ms)||ms<0)return;
    const event={tool,ms:Math.min(86400000,Math.round(ms)),ok:meta.ok!==false};
    if(!event.ok)event.code=safeError(meta.code);
    if(tool==='ui_sequence'){
      const completed=Array.isArray(meta.completed)?meta.completed.slice(0,8).filter(a=>ACTIONS.includes(a)):[];
      event.ui={completed,retries:smallCount(meta.retries,100)};
      if(ACTIONS.includes(meta.failed_action))event.ui.failed=meta.failed_action;
    }
    queue.push({day:dayAt(now()),line:JSON.stringify(event)+'\n'});
    if(queue.length>=128)flush();
    else if(!timer){timer=setTimeout(flush,flushMs);timer.unref();}
  }
  function report({days=7,limit=50,tool}={}){
    if(!Number.isInteger(days)||days<1||days>RETAIN_DAYS||!Number.isInteger(limit)||limit<1||limit>100||
      (tool!==undefined&&!validTool(tool)))throw new Error('Invalid usage report bounds');
    flush();
    const totals=new Map(),sampleDays=[],limitedDays=[];
    let invalidRecords=0;
    const today=dayAt(now()),first=dayAt(now()-(days-1)*DAY_MS);
    for(let i=days-1;i>=0;i--){
      const day=dayAt(now()-i*DAY_MS),file=join(directory,day+'.ndjson');
      let incomplete=limited.has(day)||existsSync(join(directory,day+'.limited'));
      try{
        if(existsSync(file)){
          if(statSync(file).size>dayLimit){incomplete=true;}
          else{
            const raw=readFileSync(file,'utf8');
            if(Buffer.byteLength(raw)>dayLimit)incomplete=true;
            else{
              let sampled=false;
              for(const line of raw.split('\n')){
                if(!line)continue;
                let event;
                try{event=JSON.parse(line);}catch{invalidRecords++;incomplete=true;continue;}
                if(!validEvent(event)){invalidRecords++;incomplete=true;continue;}
                if(tool&&event.tool!==tool)continue;
                sampled=true;
                const a=totals.get(event.tool)||accumulator(event.tool);addEvent(a,event);totals.set(event.tool,a);
              }
              if(sampled)sampleDays.push(day);
            }
          }
        }
      }catch{incomplete=true;}
      if(incomplete)limitedDays.push(day);
    }
    const rows=[...totals.values()].map(summarize).sort((a,b)=>b.calls-a.calls||a.tool.localeCompare(b.tool));
    return {success:true,enabled,from_utc_day:first,to_utc_day:today,retention_days:RETAIN_DAYS,
      measurement_scope:'Validated MCP handler duration including internal waits; excludes network/gateway and SDK rejections. A non-error response does not certify data completeness or trading outcome.',
      percentile_method:'Histogram bucket upper bounds; rounded milliseconds.',
      recorded_calls:rows.reduce((n,r)=>n+r.calls,0),recorded_errors:rows.reduce((n,r)=>n+r.errors,0),
      tool_count:rows.length,returned_count:Math.min(limit,rows.length),truncated:rows.length>limit,
      days_with_samples:sampleDays,coverage_limited_days:limitedDays,invalid_records:invalidRecords,
      recording_errors_since_start:recordingErrors,tools:rows.slice(0,limit)};
  }
  return {record,report,flush};
}

let defaultStore;
export function getToolUsageStore(){
  if(!defaultStore){
    defaultStore=createToolUsageStore({enabled:!process.env.NODE_TEST_CONTEXT&&process.env.TV_MCP_TOOL_USAGE!=='off'});
    process.once('exit',()=>defaultStore.flush());
  }
  return defaultStore;
}

/** Covers native registerTool and the legacy adapter that delegates to it. */
export function installToolUsage(server,store=getToolUsageStore()){
  const register=server.registerTool.bind(server);
  server.registerTool=(name,config,handler)=>register(name,config,async function(...args){
    const start=performance.now();
    let meta={ok:false,code:'HANDLER_EXCEPTION'};
    try{
      const result=await handler.apply(this,args);
      meta=resultMetadata.get(result)||{ok:!result?.isError,code:result?.isError?'UNCLASSIFIED_ERROR':undefined};
      return result;
    }finally{
      try{store.record(name,performance.now()-start,meta);}catch{/* telemetry never changes a tool result */}
    }
  });
}
