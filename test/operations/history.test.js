'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {StatusHistory}=require('../../src/operations/history');
const {createStatusServer}=require('../../scripts/operations/status-server');
const {overviewFixture}=require('../../test-support/operations-fixture');
async function fixture(t,options={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'operations-history-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return new StatusHistory({directory,...options}).initialize();}
const snapshot=state=>({components:{provider:{state}},capacity:6,active:0,queued:0,qa:null,secret:'must not persist'});
test('one sample per minute, transitions distinct, restart gap remains unknown and no private fields written',async t=>{
  let now=Date.parse('2026-11-10T10:00:00Z');let h=await fixture(t,{now:()=>now});
  await h.append(snapshot('normal'));await h.append(snapshot('normal'));now+=5000;await h.append(snapshot('degraded'));now+=55000;await h.append(snapshot('degraded'));
  let s=await h.summary();assert.equal(s.days.at(-1).samples,2);assert.equal(s.timeline.length,1);assert.equal(s.days[0].samples,0);
  const file=path.join(h.directory,(await h.files())[0]);assert.doesNotMatch(await fs.readFile(file,'utf8'),/secret|must not/);assert.equal((await fs.stat(file)).mode&0o777,0o600);
  now+=5*60000;h=new StatusHistory({directory:h.directory,now:()=>now});await h.initialize();await h.append(snapshot('normal'));s=await h.summary();assert.equal(s.days.at(-1).observedMinutes,3);
});
test('30 day retention, disk cap, corrupt line tolerated, insecure directories rejected',async t=>{
  let now=Date.parse('2026-11-10T10:00:00Z');const h=await fixture(t,{now:()=>now,maxBytes:1500});for(let i=0;i<20;i++){now+=86400000;await h.append(snapshot('normal'));}assert.ok(h.bytes<=1500);
  now+=31*86400000;await h.prune();assert.equal((await h.files()).length,0);
  await fs.writeFile(path.join(h.directory,'2026-12-31.jsonl'),'bad line\n',{mode:0o600});await h.summary();
  await fs.chmod(h.directory,0o755);await assert.rejects(new StatusHistory({directory:h.directory}).initialize(),/not_private/);
});
test('independent server retains history while Provider down, rejects writes and does not expose admin routes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'operations-server-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let now=100000,up=true,calls=[];
  const process=await createStatusServer({directory,port:0,poll:false,now:()=>now,read:async url=>{calls.push(url);if(!up&&url.includes('/overview'))throw Error('down');return url.includes('/overview')?{overview:overviewFixture(now)}:url.includes('/api/qa')?{ready:true,authenticated:true}:{ok:true};}});
  t.after(()=>process.close());await process.tick();const base=`http://127.0.0.1:${process.server.address().port}`;let s=await(await fetch(base+'/api/status')).json();assert.equal(s.capacity,6);assert.doesNotMatch(JSON.stringify(s),/演示账号|synthetic-/);
  up=false;now+=16000;await process.tick();s=await(await fetch(base+'/api/status')).json();assert.equal(s.components.provider.state,'unknown');assert.equal(s.capacity,null);assert.ok(s.history.firstObservedAt!==null);
  assert.equal((await fetch(base+'/api/status',{method:'POST'})).status,405);assert.equal((await fetch(base+'/api/admin/accounts')).status,404);
  assert.ok(calls.every(url=>url.startsWith('http://127.0.0.1:')));assert.ok(calls.every(url=>!url.includes('refresh')&&!url.includes('enrollment')));
});

test('same-minute restart does not manufacture a second observed minute',async t=>{
  let now=Date.parse('2026-11-10T12:00:00Z');let h=await fixture(t,{now:()=>now});await h.append(snapshot('normal'));
  h=await new StatusHistory({directory:h.directory,now:()=>now+1000}).initialize();await h.append(snapshot('degraded'));
  const result=await h.summary();assert.equal(result.days.at(-1).observedMinutes,1);assert.equal(result.days.at(-1).states.provider.normal,0);assert.equal(result.days.at(-1).states.provider.degraded,1);
});
