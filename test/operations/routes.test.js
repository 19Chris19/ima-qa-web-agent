'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerAdminRoutes}=require('../../src/admin-routes');const {operationsFixture}=require('../../test-support/operations-fixture');
test('actual admin overview is authenticated, memory-only and consistent with current account slots',async t=>{
  const f=operationsFixture(),app=express();let reads=0,writes=0,events=0;
  const directory={persistenceReady:true,queue:[],listAccounts(options){reads++;if(options?.includeEvents)events++;return f.management.accounts;},getPoolAccounts:()=>[]};
  const pool={accounts:f.management.accounts,stats:()=>f.management.pool,elastic:{snapshot:a=>f.limits.find(x=>x.id===a.id)},syncAccounts(){writes++;}};
  registerAdminRoutes(app,{accountDirectory:directory,imaWebAgentClient:pool,webReadiness:{sync(){writes++;},snapshot:()=>f.readiness},askQueue:{stats:()=>f.queue},config:{security:{adminToken:'synthetic-admin'},webAgent:{}}});
  const afterInitialization=writes;const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}/api/admin/overview`;
  assert.equal((await fetch(url)).status,401);
  for(let i=0;i<30;i++){const r=await fetch(url,{headers:{Authorization:'Bearer synthetic-admin'}});const v=await r.json();assert.equal(v.overview.capacity,6);assert.equal(v.overview.rows[2].basis,'operator_trial');assert.match(r.headers.get('cache-control'),/no-store/);}
  assert.equal(writes,afterInitialization);assert.equal(events,0);assert.equal(reads,30);
});
