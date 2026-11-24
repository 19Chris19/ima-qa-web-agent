'use strict';
// Read-only projection of the same kernel eligibility used by task admission. Never fetch a catalog here.
function operationsReadiness(legacy,pool,kernel){
 if(!legacy||!kernel?.enabled)return legacy;
 const accounts=(legacy.accounts||[]).map(row=>{
  const account=pool?.accounts?.find(a=>a.id===row.id),imapy=account?kernel.accountStatus(account):{enabled:true,ready:false,reason:'account_unavailable',contextReady:false,catalogCurrent:false};
  return {...row,imapy,legacyState:row.state,...(!imapy.ready&&['ready','busy'].includes(row.state)?{state:'kernel_unavailable',availableSlots:0}:{})};
 });
 const eligible=accounts.filter(a=>a.imapy.ready&&['ready','busy'].includes(a.state));
 const sum=key=>eligible.every(a=>Number.isSafeInteger(a[key])&&a[key]>=0)?eligible.reduce((n,a)=>n+a[key],0):null;
 const cap=sum('maxConcurrent'),free=sum('availableSlots');
 return {...legacy,mode:'imapy_chat_v1',accounts,capacity:cap===null?null:Math.min(legacy.capacity??cap,cap),schedulable:free===null?null:Math.min(legacy.schedulable??free,free),legacyCapacity:legacy.capacity};
}
module.exports={operationsReadiness};
