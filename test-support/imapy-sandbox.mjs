import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {makeUpstream,wire,kb,sse} from './imapy-upstream.mjs';
const require=createRequire(import.meta.url);const {IMAWebAgentPool}=require('../src/ima-web-agent-pool');const {IMAWebAgentClient}=require('../src/air/ima-web-agent-client');const {ConversationStore}=require('../src/conversation-store');const {createApp}=require('../src/app');
export async function sandbox({port=0,slow=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'imapy-synthetic-'));fs.chmodSync(dir,0o700);
 const upstream=makeUpstream({editModels:value=>value.models.forEach((m,i)=>m.model_name='演示模型 '+String.fromCharCode(65+i)+'（合成）'),reply:({record,session,body})=>{
  record.answer=`这是本地合成回答，仅用于检验模型选择、流式输出和恢复，不会访问真实 IMA。\n\n本轮请求模型标识：\`${body.model_info.model_id}\`，模式类型：${body.model_info.model_type}。\n\n${body.question}\n\n| 检查项 | 结果 |\n| --- | --- |\n| 会话延续 | 保持原会话 |\n| 联网请求 | ${body.model_info.enable_enhancement?'已请求；无实际网页证据':'关闭'} |`;
  session.records.push(record);const pieces=record.answer.match(/[\s\S]{1,24}/g)||[];let i=0;
  return new Response(new ReadableStream({async pull(c){if(slow)await new Promise(r=>setTimeout(r,45));if(i<pieces.length)c.enqueue(new TextEncoder().encode(sse([['MESSAGE',{Text:pieces[i++]}]])));else{c.enqueue(new TextEncoder().encode(sse([['SUGGEST_QUESTION',[{Text:'比较快速和深度模式'},{Text:'继续说明上下文恢复'},{Text:'展示一个表格'}]],['COMPLETED',{Code:0}]])));c.close();}}}));
 }});
 const pool=new IMAWebAgentPool({accounts:[{id:'synthetic-account',name:'本地合成账号',principalFingerprint:'a'.repeat(64),knowledgeBaseId:kb,modelId:'official_3',modelType:3,maxConcurrent:2,headers:{'x-ima-cookie':'IMA-TOKEN=SYNTHETIC_COOKIE','x-ima-bkn':'SYNTHETIC_BKN'}}]},
 {clientFactory:config=>{const c=new IMAWebAgentClient({...config,allowAuthRefresh:false});c._fetch=upstream.fetch;c.deviceInfo=wire.qa.quick.request.device_info;return c;}});
 const store=new ConversationStore({persist:true,storePath:path.join(dir,'conversations.json')});
 const config={qaProvider:'ima-web-agent',mimo:{},webAgent:{mode:'knowledge_agent',sharedKnowledgeBaseId:kb},imapy:{enabled:true,policyPath:path.join(dir,'policy.json')},conversations:{storePath:store.storePath},security:{internalServiceToken:'synthetic-service'},concurrency:{maxConcurrentAsk:2,queueLimit:10},limits:{maxQuestionLength:2000},rateLimit:{windowMs:0,max:0}};
 const readiness={mode:'knowledge_agent',snapshot:()=>({mode:'knowledge_agent',knowledgeAgentCapacity:2,capacity:2,schedulable:2,totalAccounts:1,eligibleAccounts:1,schedulableAccounts:1})};
 const app=createApp({config,imaWebAgentClient:pool,conversationStore:store,webReadiness:readiness});
 await app.locals.imapyKernel.capabilities();const models=app.locals.imapyKernel.catalogs.get('synthetic-account').catalog.models;
 app.locals.imapyKernel.setPolicy({defaultModelRef:models[0].modelRef,allowedModelRefs:models.map(m=>m.modelRef)});
 const server=app.listen(port,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});
 return{app,pool,store,models,upstream,dir,kb,server,url:`http://127.0.0.1:${server.address().port}`,
  async close(){await app.locals.durableQATasks.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}};
}
