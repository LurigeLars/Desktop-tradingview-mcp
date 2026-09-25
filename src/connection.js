import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const requestedHost = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(requestedHost)) throw new Error('TV_CDP_HOST must be loopback');
export const CDP_HOST = '127.0.0.1';
const requestedPort = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT || 9222);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) throw new Error('TV_CDP_PORT must be an integer from 1024 to 65535');
export const CDP_PORT = requestedPort;
const MAX_RETRIES=5,BASE_DELAY=500;
const KNOWN_PATHS={chartApi:'window.TradingViewApi._activeChartWidgetWV.value()',chartWidgetCollection:'window.TradingViewApi._chartWidgetCollection',bottomWidgetBar:'window.TradingView.bottomWidgetBar',replayApi:'window.TradingViewApi._replayApi',alertService:'window.TradingViewApi._alertService',chartApiInstance:'window.ChartApiInstance',mainSeriesBars:'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',strategyStudy:'chart._chartWidget.model().model().dataSources()',layoutManager:'window.TradingViewApi.getSavedCharts',symbolSearchApi:'window.TradingViewApi.searchSymbols',pineFacadeApi:'https://pine-facade.tradingview.com/pine-facade'};
export{KNOWN_PATHS};
export function safeString(str){return JSON.stringify(String(str));}
export function requireFinite(value,name){const n=Number(value);if(!Number.isFinite(n))throw new Error(`${name} must be a finite number`);return n;}
async function invalidateCachedClient(){const stale=client;client=null;targetInfo=null;if(stale){try{await stale.close();}catch{}}}
export async function getClient(){if(client){try{await client.Runtime.evaluate({expression:'1',returnByValue:true});return client;}catch{await invalidateCachedClient();}}return connect();}
export async function connect(targetId=null){let lastError;for(let attempt=0;attempt<MAX_RETRIES;attempt++){try{const target=targetId?await findTargetById(targetId):await findChartTarget();if(!target)throw new Error(targetId?'CDP target not found':'No TradingView chart target found');targetInfo=target;client=await CDP({host:CDP_HOST,port:CDP_PORT,target:target.id});await client.Runtime.enable();await client.Page.enable();await client.DOM.enable();return client;}catch(err){lastError=err;await invalidateCachedClient();await new Promise(r=>setTimeout(r,Math.min(BASE_DELAY*Math.pow(2,attempt),30000)));}}throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);}
export async function reconnectTo(targetId){await invalidateCachedClient();return connect(targetId);}
export function isTradingViewUrl(value){try{const url=new URL(String(value)),hostname=url.hostname.toLowerCase();return url.protocol==='https:'&&(hostname==='tradingview.com'||hostname.endsWith('.tradingview.com'));}catch{return false;}}
export async function listCdpTargets(){const resp=await fetch(new URL('/json/list',`http://127.0.0.1:${CDP_PORT}`),{redirect:'error',signal:AbortSignal.timeout(3000)});if(!resp.ok)throw new Error(`CDP target list failed (HTTP ${resp.status})`);return resp.json();}
export async function listTradingViewChartTargets(){const targets=await listCdpTargets();return targets.filter(t=>{if(t.type!=='page'||!isTradingViewUrl(t.url))return false;try{return new URL(t.url).pathname.toLowerCase().startsWith('/chart');}catch{return false;}});}
async function findChartTarget(){const targets=await listCdpTargets(),pages=targets.filter(t=>t.type==='page'&&isTradingViewUrl(t.url));return pages.find(t=>{try{return new URL(t.url).pathname.toLowerCase().startsWith('/chart');}catch{return false;}})||pages[0]||null;}
async function findTargetById(id){const targets=await listCdpTargets();return targets.find(t=>t.id===id&&t.type==='page'&&isTradingViewUrl(t.url))||null;}
export async function getTargetInfo(){if(!targetInfo)await getClient();return targetInfo;}
export async function evaluate(expression,opts={}){const c=await getClient();let result;try{result=await c.Runtime.evaluate({expression,returnByValue:true,awaitPromise:opts.awaitPromise??false,...opts});}catch(error){await invalidateCachedClient();throw error;}if(result.exceptionDetails){const msg=result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Unknown evaluation error';throw new Error(`JS evaluation error: ${msg}`);}return result.result?.value;}
export async function evaluateAsync(expression){return evaluate(expression,{awaitPromise:true});}
export async function disconnect(){await invalidateCachedClient();}
async function verifyAndReturn(path,name){const exists=await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);if(!exists)throw new Error(`${name} not available`);return path;}
export async function getChartApi(){return verifyAndReturn(KNOWN_PATHS.chartApi,'Chart API');}
export async function getChartCollection(){return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection,'Chart Widget Collection');}
export async function getBottomBar(){return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar,'Bottom Widget Bar');}
export async function getReplayApi(){return verifyAndReturn(KNOWN_PATHS.replayApi,'Replay API');}
export async function getMainSeriesBars(){return verifyAndReturn(KNOWN_PATHS.mainSeriesBars,'Main Series Bars');}
