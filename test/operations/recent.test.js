'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RecentStatus}=require('../../src/operations/recent');
const {accountActions,recommendedAction}=require('../../src/operations/actions');
const {createStatusReader,STATUS_URL}=require('../../src/operations/status-proxy');
const status=state=>({components:Object.fromEntries(['provider','website','capacity','persistence'].map(k=>[k,{state}]))});
test('ten-minute memory ring: 120 bounded points, 60 fixed ten-second buckets, no invented restart history',()=>{
 let now=1200000;const ring=new RecentStatus({now:()=>now});let view=ring.snapshot();assert.equal(view.points,0);assert.equal(view.components.provider.length,60);assert.ok(view.components.provider.every(b=>b.state==='unknown'&&b.samples===0));
 for(let i=0;i<400;i++){now+=5000;ring.record(status('normal'));}view=ring.snapshot();assert.equal(view.points,120);assert.ok(ring.points.length<=120);assert.equal(view.components.provider.length,60);assert.ok(view.components.provider.slice(1,-1).every(b=>b.samples===2&&b.coverage===1));
 now+=600001;assert.equal(ring.snapshot().points,0);assert.equal(new RecentStatus({now:()=>now}).snapshot().points,0);
});
test('sample gaps are partial, repeated samples merge worst state, and grid does not slide at 5 seconds',()=>{
 let now=1200000;const ring=new RecentStatus({now:()=>now});ring.record(status('normal'));ring.record(status('outage'));const from=ring.snapshot().from;now+=5000;assert.equal(ring.snapshot().from,from);now+=5000;ring.record(status('normal'));
 const b=ring.snapshot().components.provider.at(-2);assert.equal(b.samples,1);assert.equal(b.coverage,.5);assert.equal(b.state,'outage');
});
test('optional private entry failure does not turn the core service outage',()=>{
 const {composeStatus}=require('../../src/operations/status');const {overviewFixture}=require('../../test-support/operations-fixture');const now=Date.now();const v=composeStatus({overview:overviewFixture(now),checks:{website:{at:now,ok:true},private_entry:{at:now,ok:false}},now});assert.equal(v.state,'degraded');assert.equal(v.components.private_entry.state,'outage');
});
test('fault-specific action hints cannot bypass saving, identity or pending qualification protection',()=>{
 const a={activeRequests:0,status:'disabled',runtime:{disabledReason:'pending_enrollment_qualification'},health:{refreshable:true}};const row={login:'valid',qualified:true,state:'disabled'};
 assert.deepEqual(accountActions(a,row,{storageReady:false}),['inspect']);assert.ok(!accountActions(a,row,{storageReady:true}).includes('enable'));
 assert.equal(recommendedAction({...row,qualified:false},['inspect','verify']),'verify');
 a.runtime={};assert.ok(accountActions(a,row,{storageReady:true}).includes('enable'));a.identityDuplicate=true;assert.deepEqual(accountActions(a,row,{storageReady:true}),['inspect']);
 a.identityDuplicate=false;a.activeRequests=1;assert.deepEqual(accountActions(a,row,{storageReady:true}),['inspect']);a.activeRequests=0;row.login='expired';assert.equal(recommendedAction(row,accountActions(a,row,{storageReady:true})),'refresh');
});
test('fixed status proxy merges in-flight reads, caches briefly, and refuses oversized or malformed monitor output',async()=>{
 let count=0,now=1000;const read=async(url,options)=>{count++;assert.equal(url,STATUS_URL);assert.equal(options.redirect,'error');await new Promise(r=>setImmediate(r));return new Response(JSON.stringify({schema:'provider_status_v1',state:'normal',observedAt:now,privateToken:'never forwarded'}));};const get=createStatusReader({read,now:()=>now});const both=await Promise.all([get(),get()]);assert.equal(count,1);assert.ok(!JSON.stringify(both).includes('privateToken'));await get();assert.equal(count,1);now+=1001;await get();assert.equal(count,2);
 await assert.rejects(createStatusReader({read:async()=>new Response('x'.repeat(131073))})(),/too_large/);await assert.rejects(createStatusReader({read:async()=>new Response('{}')})(),/invalid/);
});
test('status proxy nested allowlist strips unknown component and bucket metadata',async()=>{
 const now=Date.now(),recent=new RecentStatus({now:()=>now});recent.record(status('normal'));const value={schema:'provider_status_v1',observedAt:now,state:'normal',components:{provider:{state:'normal',token:'synthetic-secret'}},recent:recent.snapshot()};value.recent.components.provider[0].privateUrl='https://synthetic.invalid/private';const result=await createStatusReader({read:async()=>new Response(JSON.stringify(value))})();assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|privateUrl|synthetic.invalid/);assert.equal(result.recent.components.provider.length,60);
});
test('monitor reader timeout rejects without forwarding a stale cached result',async()=>{
 const get=createStatusReader({read:async(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),now:Date.now});
 // Keep the synthetic runner alive; AbortSignal timers themselves are unref'd.
 const keep=setTimeout(()=>{},2500);try{await assert.rejects(get(),error=>error.name==='TimeoutError');}finally{clearTimeout(keep);}
});
