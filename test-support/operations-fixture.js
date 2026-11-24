'use strict';
const {buildOperationsOverview}=require('../src/operations-overview');
function operationsFixture(now=Date.now()) {
  const accounts=Array.from({length:4},(_,i)=>({id:`synthetic-${i+1}`,name:['演示账号 一','演示账号 二','演示账号 三','演示账号 四'][i],status:'active',activeRequests:0,
    health:{session_valid:i>=2,knowledge_ready:true,local_schedulable:i>=2,last_check_code:i>=2?'ok':'auth_expired',last_check_at:new Date(now-60000).toISOString()},
    management:{knowledge:{qualified:true,state:i>=2?'ready':'needs_login',verifiedAt:new Date(now-3600000).toISOString()},session:{state:i>=2?'ready':'unavailable'},web:{state:'unknown'},
      maintenance:{state:i>=2?'scheduled':'needs_login',lastCheckAt:new Date(now-60000).toISOString(),nextCheckAt:new Date(now+60000).toISOString(),tokenExpiresAt:new Date(now+(i>=2?3600000:-3600000)).toISOString(),refreshTokenExpiresAt:null,lastSuccessfulRefreshAt:new Date(now-7200000).toISOString()}},events:[]}));
  const readiness={mode:'knowledge_agent',capacity:6,schedulable:6,eligibleAccounts:2,accounts:accounts.map((a,i)=>({id:a.id,state:i>=2?'ready':'needs_login',qualified:true,maxConcurrent:i===2?5:1,availableSlots:i>=2?(i===2?5:1):0}))};
  const queue={maxConcurrent:6,activeRequests:0,queuedRequests:0,queueLimit:30};
  const limits=accounts.map((a,i)=>({id:a.id,effectiveMaxConcurrent:i===2?5:1,limitBasis:i===2?'operator_trial':'default',validatedMaxConcurrent:1}));
  const management={accounts,pool:{totalAccounts:4,elasticScheduling:{maxGlobal:25}}};
  return {management,readiness,queue,limits,persistence:{ready:true,statisticsReady:true,pendingWrites:0},now};
}
function overviewFixture(now=Date.now()){const input=operationsFixture(now);return {...buildOperationsOverview(input),accounts:input.management.accounts};}
module.exports={operationsFixture,overviewFixture};
