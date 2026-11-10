// One synthetic runtime shared by task dispatch, encrypted directory, admin and monitor.
import '../test-support/block-real-ima.cjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {makeUpstream,wire,kb,sse} from './imapy-upstream.mjs';
const require=createRequire(import.meta.url);
const {AsyncAccountDirectory}=require('../src/async-account-directory');const {WebReadiness}=require('../src/web-readiness');const {IMAWebAgentPool}=require('../src/ima-web-agent-pool');const {IMAWebAgentClient}=require('../src/air/ima-web-agent-client');const {ConversationStore}=require('../src/conversation-store');const {createApp}=require('../src/app');const {registerAdminRoutes}=require('../src/admin-routes');const {knowledgeAgentContractDigest}=require('../src/ima-knowledge-agent-contract');const {createStatusServer}=require('../scripts/operations/status-server');const {createStatusReader}=require('../src/operations/status-proxy');
export async function pairedSandbox({port=0,monitorPort=0,websiteUrl=null,slow=false,publicAccess=false,monitoring=true,delayMs=slow?45:0,directoryPath=null,mockUpstream=null}={}){
 const dir=directoryPath||fs.mkdtempSync(path.join(os.tmpdir(),'provider-paired-synthetic-'));fs.chmodSync(dir,0o700);
 const directory=await new AsyncAccountDirectory({storePath:path.join(dir,'accounts.json'),keyPath:path.join(dir,'key'),keyMaterial:'synthetic-only-paired-key'}).initialize();
 if(!directoryPath) await directory.initializeWebMode('knowledge_agent');
 for(const [id,name] of (directoryPath?[]:[['synthetic-account','合成账号 一'],['synthetic-no-device','合成账号 二']])){
  await directory.addCapturedAccount({id,name,knowledgeBaseId:kb,headers:{'x-ima-cookie':`IMA-UID=${id}; IMA-TOKEN=SYNTHETIC; IMA-REFRESH-TOKEN=SYNTHETIC`,'x-ima-bkn':'SYNTHETIC'},maxConcurrent:2,requireQualification:true});
  const account=directory.getAccount(id);await directory.commitWebQualification(id,{principalFingerprint:account.principalFingerprint,scope:createHash('sha256').update(kb).digest('hex'),contract:knowledgeAgentContractDigest(),requests:1,terminals:1,verifiedAt:Date.now()},directory.webQualificationBinding(id));
 }
 const upstream=mockUpstream||makeUpstream({editModels:v=>v.models.forEach((m,i)=>m.model_name=`演示模型 ${String.fromCharCode(65+i)}（合成）`),reply:({record,session,body})=>{
  record.answer=`这是本地合成回答 不会访问 IMA\n\n本轮模式 ${body.model_info.model_type} 同一会话已保留 ${session.records.length} 轮\n\n${body.question}`;
  const web=body.model_info.enable_enhancement===true;if(web)record.answer+='\n\n合成网页依据 [7](@index-ref?id=91)';session.records.push(record);
  const frames=[];for(const text of record.answer.match(/[\s\S]{1,18}/g)||[])frames.push(['MESSAGE',{Text:text}]);
  if(web)frames.push(['STRUCTURED_BLOCK',{Id:'synthetic-source',Type:'referenceIndexes',Data:{reference_indexes:{indexes:{'91':{type:1,jumpUrl:'https://example.org/synthetic-source',title:'合成网页资料',content:'仅用于引用关联验收'}}}}}]);
  frames.push(['SUGGEST_QUESTION',[{Text:'继续比较两种模式'},{Text:'说明上下文恢复'},{Text:'核对本轮引用'}]],['COMPLETED',{Code:0}]);let i=0;
  return new Response(new ReadableStream({async pull(controller){if(delayMs)await new Promise(r=>setTimeout(r,delayMs));if(i<frames.length)controller.enqueue(new TextEncoder().encode(sse([frames[i++]])));else controller.close();}}));
 }});
 let readiness;
 const pool=new IMAWebAgentPool({accounts:directory.getPoolAccounts()}, {managedPersistence:true,persistenceReady:()=>directory.persistenceReady,onAccountStateChange:s=>directory.recordRuntimeState(s),onAccountCredentialsChange:(id,s)=>directory.updateCredentialsFromClient(id,s),clientFactory:config=>{const c=new IMAWebAgentClient({...config,allowAuthRefresh:false});c._fetch=upstream.fetch;if(config.id==='synthetic-account')c.deviceInfo=wire.qa.quick.request.device_info;return c;}});
 readiness=new WebReadiness({directory,pool,mode:'knowledge_agent'});
 const store=new ConversationStore({persist:true,storePath:path.join(dir,'conversations.json')});
 const config={qaProvider:'ima-web-agent',mimo:{},webAgent:{webMode:'knowledge_agent',sharedKnowledgeBaseId:kb},imapy:{enabled:true,policyPath:path.join(dir,'policy.json')},conversations:{storePath:store.storePath},security:{apiToken:publicAccess?'':'synthetic-api',internalServiceToken:'synthetic-service',adminToken:''},concurrency:{maxConcurrentAsk:4,queueLimit:10},limits:{maxQuestionLength:2000},rateLimit:{windowMs:0,max:0}};
 const app=createApp({config,imaWebAgentClient:pool,conversationStore:store,webReadiness:readiness});
 await app.locals.imapyKernel.capabilities();const models=app.locals.imapyKernel.catalogs.get('synthetic-account').catalog.models;
 if(!directoryPath) app.locals.imapyKernel.setPolicy({defaultModelRef:models[0].modelRef,allowedModelRefs:models.map(m=>m.modelRef)});
 let monitor;const reader=createStatusReader({expectedSynthetic:true,read:(_ignored,options)=>fetch(`http://127.0.0.1:${monitor.server.address().port}/api/status?view=recent`,options)});
 const adminOptions={config,synthetic:true,accountDirectory:directory,imaWebAgentClient:pool,webReadiness:readiness,askQueue:app.locals.imaQaAskQueue,operationsStatusReader:reader};registerAdminRoutes(app,adminOptions);
 const server=app.listen(port,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});const url=`http://127.0.0.1:${server.address().port}`;
 monitor=await createStatusServer({directory:path.join(dir,'monitor'),port:monitorPort,overviewUrl:url+'/api/admin/overview',websiteUrl:websiteUrl||url+'/healthz',synthetic:true,poll:monitoring,read:async address=>{const v=await(await fetch(address)).json();return address.endsWith('/overview')?v:websiteUrl?v:{ready:v.ok===true,authenticated:v.ok===true};}});
 adminOptions.operationsStatusPageUrl=`http://127.0.0.1:${monitor.server.address().port}/`;
 return {app,pool,store,models,upstream,dir,kb,server,url,directory,readiness,monitor,config,async close({preserve=false}={}){await monitor.close();await app.locals.durableQATasks.close();server.closeAllConnections();await new Promise(r=>server.close(r));await directory.close();if(!preserve)fs.rmSync(dir,{recursive:true,force:true});}};
}
