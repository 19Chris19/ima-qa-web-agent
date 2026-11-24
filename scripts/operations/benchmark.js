'use strict';
// Fixed synthetic streams only. No account client, IMA request or production files.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {setTimeout:delay}=require('node:timers/promises');
const {operationsFixture}=require('../../test-support/operations-fixture');
const {buildOperationsOverview}=require('../../src/operations-overview');
const {composeStatus}=require('../../src/operations/status');
const {StatusHistory}=require('../../src/operations/history');
const p95=v=>v.sort((a,b)=>a-b)[Math.ceil(v.length*.95)-1];
async function run({root=path.resolve(__dirname,'../..'),enabled=true,rounds=30,stability=false}={}){
  const {createApp}=require(path.join(root,'src/app'));
  const {buildOperationsOverview:buildOverview}=require(path.join(root,'src/operations-overview'));
  const recentPath=path.join(root,'src/operations/recent.js');
  const recent=enabled&&require('node:fs').existsSync(recentPath)?new (require(recentPath).RecentStatus)({now:()=>clock}):null;
  let recentBytes=0,minuteWrites=0;
  const config={qaProvider:'ima-web-agent',limits:{maxQuestionLength:2000,maxHistoryTurns:6,maxHistoryContentLength:1000,maxSources:6,maxSnippetLength:900},ima:{},mimo:{},webAgent:{},security:{apiToken:'',adminToken:'',allowedOrigins:[],healthDetails:'basic',trustProxy:false},concurrency:{maxConcurrentAsk:6,queueLimit:30,requestTimeoutMs:5000},rateLimit:{windowMs:0,max:0}};
  if(stability)config.conversations={persist:false,maxCount:1,maxTurns:6};
  const pool={stats:()=>({totalAccounts:4}),async *streamAsk(){yield{type:'sources',sourceKind:'knowledge',sources:[{index:1,title:'Synthetic document',snippet:'Synthetic'}]};for(let i=0;i<24;i++){await delay(5);yield{type:'delta',text:'合成流式片段。'};}yield{type:'done'};}};
  const {ConversationStore}=require(path.join(root,'src/conversation-store'));
  const app=createApp({config,imaWebAgentClient:pool,...(stability?{conversationStore:new ConversationStore({persist:false,maxCount:1,maxTurns:6})}:{})});
  const f=operationsFixture(),overview=()=>{f.now=Date.now();return buildOverview({...f,metrics:app.locals.operationsMetrics?.snapshot()});};
  app.get('/api/admin/overview',(_req,res)=>res.json(overview()));
  app.get('/api/admin/operations/status',(_req,res)=>res.json({...composeStatus({overview:overview(),checks:{},now:Date.now()}),recent:recent?.snapshot()}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'operations-bench-'));let clock=Date.now();const history=await new StatusHistory({directory,now:()=>clock}).initialize();
  // Warm module loading, connections and JIT before measurement.
  for(let i=0;i<3;i++)await(await fetch(base+'/api/ask',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({question:'合成问答'})})).text();
  const loop=monitorEventLoopDelay({resolution:1});loop.enable();const cpu=process.cpuUsage(),start=performance.now();let peak=process.memoryUsage().rss;const rss=[],retained=[];const sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},5);
  const first=[],gaps=[],health=[];
  try{
    for(let round=0;round<rounds;round++){
      const at=performance.now();let previous=null,firstAt=null,buffer='';
      const response=await fetch(base+'/api/ask',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({question:'合成问答'})});if(!response.ok)throw Error('synthetic_stream_failed');
      const refresh=enabled?(async()=>{const t=performance.now();await(await fetch(base+'/api/admin/overview')).json();health.push(performance.now()-t);clock+=5000;const before=history.lastMinute;const sample=composeStatus({overview:overview(),checks:{},now:Date.now()});recent?.record(sample);await history.append(sample);if(history.lastMinute!==before)minuteWrites++;if(recent){const response=await fetch(base+'/api/admin/operations/status');const body=await response.text();recentBytes=Math.max(recentBytes,Buffer.byteLength(body));}})():Promise.resolve();
      for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString('utf8');let index;while((index=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,index);buffer=buffer.slice(index+2);if(!event.startsWith('event: delta'))continue;const now=performance.now();firstAt??=now;if(previous!==null)gaps.push(now-previous);previous=now;}}
      if(firstAt===null)throw Error('missing_delta');first.push(firstAt-at);await refresh;rss.push(process.memoryUsage().rss);if(stability && (round+1)%30===0){global.gc?.();retained.push({round:round+1,heapUsedMiB:process.memoryUsage().heapUsed/1024/1024,rssMiB:process.memoryUsage().rss/1024/1024});}
    }
    await history.pending;const usage=process.cpuUsage(cpu),h=await history.summary();
    return {rounds,retained,conversationRetention:stability?'bounded_1_conversation_6_turns':'default',eventsPerRound:24,concurrentOverviewPerRound:enabled?1:0,historyMinuteWrites:minuteWrites,recentPoints:recent?.points.length??0,statusPayloadPeakBytes:recentBytes,firstDeltaP95Ms:p95(first),eventGapP95Ms:p95(gaps),overviewP95Ms:health.length?p95(health):null,cpuMs:(usage.user+usage.system)/1000,elapsedMs:performance.now()-start,eventLoopP95Ms:loop.percentile(95)/1e6,rssPeakMiB:peak/1024/1024,rssFirstMiB:rss[0]/1024/1024,rssLastMiB:rss.at(-1)/1024/1024,historyBytes:h.bytes,productionRequests:0};
  }finally{clearInterval(sampler);loop.disable();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
}
if(require.main===module)run({root:process.argv[2]||undefined,enabled:process.argv[3]!=='baseline',rounds:process.argv.includes('--stability')?300:30,stability:process.argv.includes('--stability')}).then(v=>console.log(JSON.stringify(v,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
