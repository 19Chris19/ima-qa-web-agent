'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AdminPoller}=require('../../public/admin-poller');
test('no overlap, hidden pause, bounded backoff and late response after close ignored',async()=>{
  let resolve,visible=true,accepted=0,calls=0;const scheduled=[];const p=new AdminPoller({read:()=>{calls++;return new Promise(r=>resolve=r);},accept:()=>accepted++,visible:()=>visible,schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},cancel:()=>{}});
  const pending=p.refresh();await p.refresh();assert.equal(calls,1);resolve({});await pending;assert.equal(accepted,1);
  visible=false;await p.refresh();assert.equal(calls,1);visible=true;
  const last=p.refresh();p.close();resolve({});await last;assert.equal(accepted,1);
  const errors=[];const failing=new AdminPoller({read:async()=>{throw Error('offline');},accept:()=>{},fail:()=>errors.push(true),visible:()=>true,schedule:(fn,ms)=>{scheduled.push({fn,ms});return 1;},cancel:()=>{}});
  for(let i=0;i<10;i++)await failing.refresh();assert.equal(errors.length,10);assert.equal(scheduled.at(-1).ms,60000);failing.close();
});
