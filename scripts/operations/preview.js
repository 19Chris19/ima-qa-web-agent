'use strict';
// Isolated synthetic preview. No production imports, credentials, account store or external fetch.
const express=require('express'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const {operationsFixture}=require('../../test-support/operations-fixture');
const {buildOperationsOverview}=require('../../src/operations-overview');
const {createStatusServer}=require('./status-server');
const {RecentStatus}=require('../../src/operations/recent');
const {composeStatus}=require('../../src/operations/status');
function createPreviewApp(){
  const app=express();app.use(express.json());app.disable('x-powered-by');
  const input=operationsFixture();let enrollment=null,qualification=null,exercise=null;const qualificationReports=[],exerciseReports=[{id:'synthetic-report',profile:'baseline',status:'completed',requestedClients:1,startedAt:Date.now()-60000,finishedAt:Date.now()-30000,clients:[{index:0,label:'合成客户 一',initial:{question:'如何检查训练数据',answer:'这是合成回答，仅供界面检查。',status:'succeeded',sources:[],elapsedMs:1000},followUp:{question:'请继续说明',answer:'这是合成追问回答。',status:'succeeded',sources:[],elapsedMs:800},review:{}}]}];const calls=[];
  const snapshot=()=>{input.now=Date.now();input.maintenance=Boolean(qualification||exercise);return {...buildOperationsOverview(input),accounts:input.management.accounts};};
  app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'"});
    if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.sendStatus(403);return;}
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==`http://${req.headers.host}`){res.sendStatus(403);return;}
    if(req.path.startsWith('/api'))calls.push({method:req.method,path:req.path});if(calls.length>1000)calls.shift();next();});
  // Only the synthetic preview seeds a labelled illustrative 10-minute window.
  const recent=new RecentStatus();const seedAt=Date.now();
  for(let i=119;i>=0;i--){const at=seedAt-i*5000;recent.now=()=>at;recent.record(composeStatus({overview:{...snapshot(),observedAt:new Date(at).toISOString()},checks:{website:{at,ok:true}},now:at}));}
  recent.now=Date.now;let scenario='degraded';
  const statusSnapshot=()=>{const now=Date.now(),o=snapshot();if(scenario==='unknown')o.observedAt=new Date(now-16000).toISOString();const value=composeStatus({overview:o,checks:{website:{at:now,ok:scenario!=='outage'}},now});recent.record(value);return {...value,synthetic:true,recent:recent.snapshot()};};
  app.get('/api/admin/operations/status',(_req,res)=>res.json({success:true,status:statusSnapshot()}));
  app.post('/api/admin/persistence/reconcile',(_req,res)=>res.status(409).json({success:false,code:'account_store_unresolved',error:'合成未知结果保持保护；不会强行清除'}));
  app.get('/api/admin/overview',(_req,res)=>res.json({success:true,overview:snapshot()}));
  const boot=()=>({success:true,provider:'synthetic-preview',operations:{statusPageUrl:'http://127.0.0.1:4611/'},enrollment:{supportsAdminPageQr:true,activeEnrollment:enrollment,timeoutSeconds:300,qualification:{required:true,automatic:true,requestsPerTarget:1}},
    qualification:{totalAccounts:4,targetAccountCount:1,authorizedRequestCount:7,candidateSetDigest:'synthetic-digest',active:qualification},
    exercise:{capacity:6,availableAccountCount:2,accountCount:4,maxClients:30,defaultClientCount:2,profiles:{baseline:2,queue:4},questionBankCount:30,active:exercise}});
  app.get('/api/admin/bootstrap',(_req,res)=>res.json(boot()));
  app.get('/api/admin/accounts',(_req,res)=>res.json({success:true,...input.management,summary:{totalAccounts:input.management.accounts.length},readiness:input.readiness,queue:input.queue}));
  app.get('/api/admin/v2/accounts/eligibility',(_req,res)=>res.json({success:true,active_profile:{name:'ima_agent_auto',ready:false,generation:1},summary:{active_profile_capacity:0,strategies:{knowledge_agent:{capacity:16}}},accounts:[]}));
  app.get('/api/admin/qualifications/bootstrap',(_req,res)=>res.json({qualification:boot().qualification}));
  app.get('/api/admin/qualifications/active',(_req,res)=>res.json({run:qualification}));
  app.get('/api/admin/qualifications/reports',(_req,res)=>res.json({reports:qualificationReports}));
  app.get('/api/admin/qualifications/reports/:id',(req,res)=>res.json({report:qualificationReports.find(r=>r.id===req.params.id)}));
  const qualify=(req,res)=>{if(req.body.confirm!==true||!Number.isSafeInteger(req.body.authorizedRequestCount)||req.body.authorizedRequestCount<1)return res.status(400).json({success:false,error:'qualification_explicit_budget_required'});
    qualification={id:`synthetic-qualification-${qualificationReports.length}`,runId:`synthetic-qualification-${qualificationReports.length}`,status:'running',phase:'smoke',authorizedRequests:req.body.authorizedRequestCount,usedRequests:1,startedAt:Date.now(),targetCount:1};
    res.status(202).json({run:qualification,qualification});
  };
  app.post('/api/admin/qualifications',qualify);app.post('/api/admin/accounts/:id/qualification',qualify);
  app.delete('/api/admin/qualifications/:id',(_req,res)=>{if(qualification)qualificationReports.unshift({...qualification,status:'cancelled',finishedAt:Date.now()});qualification=null;res.json({success:true});});
  app.post('/api/admin/enrollment-preflight',(_req,res)=>res.json({enrollment:{ready:true}}));
  app.post('/api/admin/enrollments',(req,res)=>{enrollment={taskId:'synthetic-enrollment',state:'waiting_for_scan',qrAvailable:false,startedAt:new Date().toISOString(),stageStartedAt:new Date().toISOString(),diagnostic:{code:'synthetic_only',message:'合成演示，不会打开 IMA 或生成真实二维码'},captureMode:'browser'};res.status(201).json({enrollment});});
  app.get('/api/admin/enrollments/:id',(_req,res)=>res.json({enrollment}));
  app.delete('/api/admin/enrollments/:id',(_req,res)=>{enrollment={...enrollment,state:'cancelled'};res.json({enrollment});});
  app.post('/api/admin/accounts/:id/:action',(req,res)=>{const a=input.management.accounts.find(a=>a.id===req.params.id);if(!a)return res.status(404).json({error:'not_found'});
    if(!snapshot().rows.find(r=>r.id===a.id)?.actions.includes(req.params.action))return res.status(409).json({error:'当前状态不允许此操作'});
    if(!['check','refresh','enable','disable'].includes(req.params.action))return res.status(400).json({error:'unsupported_preview_action'});
    if(req.params.action==='disable')a.status='disabled';if(req.params.action==='enable')a.status='active';
    res.json({success:true,operation:{message:'合成操作完成；未访问 IMA'}});});
  app.delete('/api/admin/accounts/:id',(req,res)=>{input.management.accounts=input.management.accounts.filter(a=>a.id!==req.params.id);res.json({success:true});});
  app.get('/api/admin/exercises/templates',(req,res)=>res.json({exercise:boot().exercise,clients:Array.from({length:Math.min(30,Math.max(1,Number(req.query.count)||2))},(_,index)=>({label:`合成客户 ${index+1}`,question:`合成问题 ${index+1}`,followUp:'合成追问：请继续说明'}))}));
  app.get('/api/admin/exercises/active',(_req,res)=>res.json({run:exercise}));
  app.post('/api/admin/exercises',(req,res)=>{if(req.body.confirm!==true)return res.status(400).json({error:'exercise_confirmation_required'});
    exercise={runId:'synthetic-exercise',profile:req.body.profile,requestedClients:req.body.clients?.length||0,startedAt:Date.now(),status:'running',phase:'initial',progress:{submitted:1,processing:1,queued:0,completed:0,failed:0},queue:input.queue};res.status(201).json({run:exercise});});
  app.post('/api/admin/exercises/:id/cancel',(_req,res)=>{exercise=null;res.json({run:null});});
  app.get('/api/admin/exercises/reports',(_req,res)=>res.json({reports:exerciseReports}));
  app.get('/api/admin/exercises/reports/:id', (req,res)=>res.json({report:exerciseReports.find(r=>r.id===req.params.id)}));
  app.get('/api/admin/exercises/reports/:id/export', (req,res)=>res.json(exerciseReports.find(r=>r.id===req.params.id)||{}));
  app.put('/api/admin/exercises/reports/:id/reviews/:index',(req,res)=>{const report=exerciseReports.find(r=>r.id===req.params.id);if(!report)return res.sendStatus(404);const client=report.clients.find(c=>c.index===Number(req.params.index));if(!client)return res.sendStatus(404);client.review=req.body;res.json({report});});
  app.delete('/api/admin/exercises/reports/:id',(req,res)=>{const index=exerciseReports.findIndex(r=>r.id===req.params.id);if(index>=0)exerciseReports.splice(index,1);res.json({success:true});});
  app.get('/api/preview/calls',(_req,res)=>res.json({synthetic:true,calls}));
  app.post('/api/preview/scenario',(req,res)=>{const requested=req.body.scenario;scenario=requested;
    if(['normal','degraded','busy','outage','unknown','reset','storage','qualification'].includes(requested)){Object.assign(input,operationsFixture());qualification=null;exercise=null;}
    if(requested==='normal'){for(const a of input.management.accounts)a.health.session_valid=true;for(const a of input.readiness.accounts){a.state='ready';a.availableSlots=a.maxConcurrent;}input.readiness.capacity=8;input.readiness.schedulable=8;input.queue.maxConcurrent=8;}
    if(requested==='unknown')input.persistence.ready=null;
    if(requested==='qualification'){input.management.accounts[0].health.session_valid=true;input.readiness.accounts[0].state='pending';input.readiness.accounts[0].qualified=false;}
    if(scenario==='storage'){input.persistence.ready=false;input.persistence.canReconcile=true;}
    if(scenario==='busy'){input.queue.activeRequests=6;input.queue.queuedRequests=4;input.readiness.schedulable=0;for(const r of input.readiness.accounts.slice(2)){r.state='busy';r.availableSlots=0;}}
    if(scenario==='reset'){const fresh=operationsFixture();Object.assign(input,fresh);qualification=null;exercise=null;}
    if(scenario==='qualification_commit_failed'&&qualification){qualificationReports.unshift({...qualification,status:'failed',phase:'completed',failureStage:'qualification_commit',failureCategory:'local_persistence_failed',commitApplied:false,finishedAt:Date.now()});qualification=null;}
    res.json({success:true});});
  app.get('/',(_req,res)=>res.redirect('/admin.html'));
  app.use(express.static(path.resolve(__dirname,'../../public')));
  return {app,snapshot,calls,statusSnapshot};
}
async function main(){const {app,snapshot,statusSnapshot}=createPreviewApp();app.listen(4602,'127.0.0.1',()=>console.log('Synthetic admin candidate http://127.0.0.1:4602/ — no production account access'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'provider-status-synthetic-'));
  await createStatusServer({directory,port:4611,synthetic:true,privateEntryUrl:'http://127.0.0.1/synthetic-private-entry',read:async url=>url.includes('/overview')?{overview:snapshot()}:url.includes('/api/qa')?{ready:statusSnapshot().components.website.state==='normal',authenticated:true}:{ready:true}});
  console.log('Synthetic independent status http://127.0.0.1:4611/ — history begins now');
}
if(require.main===module)main().catch(()=>{console.error('Synthetic preview startup failed');process.exitCode=1;});
module.exports={createPreviewApp};
