'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const {createPreviewApp}=require('../../scripts/operations/preview');
const {overviewFixture}=require('../../test-support/operations-fixture');
const tick=()=>new Promise(r=>setTimeout(r,20));
async function fixture(t){
  const preview=createPreviewApp(),server=preview.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../../public/admin.html'),'utf8'),{url:origin+'/admin.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.AbortController=AbortController;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.confirm=()=>true;
  w.fetch=(url,options={})=>fetch(origin+url,{...options,headers:{...options.headers,origin}});
  w.eval(fs.readFileSync(path.join(__dirname,'../../public/admin-poller.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../../public/admin.js'),'utf8'));
  t.after(async()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  for(let i=0;i<50&&(!w.document.querySelector('#capacityAllocation').textContent.includes('路') || !w.document.querySelector('#exerciseScript textarea'));i++)await tick();
  return {...preview,w,d:w.document};
}
test('new overview is runtime-derived; refresh reads only and leaves filters, drawer and exercise drafts intact',async t=>{
  const {d,w,calls}=await fixture(t);assert.match(d.querySelector('#adminSummary').textContent,/2 \/ 4/);assert.match(d.querySelector('#adminSummary').textContent,/6/);
  assert.ok(calls.every(c=>c.method==='GET'));
  assert.match(d.querySelector('#qualificationCapacityLabel').textContent,/网站当前容量 6 路.*历史资格折算 16 路/);
  d.querySelector('#accountFilter').value='ready';d.querySelector('#accountFilter').dispatchEvent(new w.Event('change'));assert.equal(d.querySelectorAll('#accountList tbody tr').length,2);
  d.querySelector('.account-name-button').click();assert.equal(d.querySelector('#accountDrawer').open,true);assert.match(d.querySelector('#accountDrawerContent').textContent,/试运行|默认限制/);
  const draft=d.querySelector('#exerciseScript textarea');assert.ok(draft);draft.value='keep this exact draft';
  d.querySelector('#reloadButton').click();await tick();await tick();assert.equal(d.querySelector('#accountFilter').value,'ready');assert.equal(d.querySelector('#accountDrawer').open,true);assert.equal(draft.value,'keep this exact draft');assert.ok(calls.every(c=>c.method==='GET'));
});
test('arbitrary existing-account recovery has no name and requires explicit optional single-question consent',async t=>{
  const {d,w,calls}=await fixture(t);d.querySelector('#restoreAnyAccountButton').click();assert.equal(d.querySelector('#enrollmentDialog').open,true);assert.equal(d.querySelector('#enrollmentName').required,false);assert.equal(d.querySelector('#enrollmentName').hidden,true);
  assert.ok(calls.every(c=>c.method==='GET'));d.querySelector('#reactivateMatchedAccount').checked=true;d.querySelector('#enrollmentForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
  assert.equal(calls.filter(c=>c.path==='/api/admin/enrollments'&&c.method==='POST').length,1);
  d.querySelector('#cancelEnrollmentButton').click();await tick();assert.equal(calls.filter(c=>c.path.includes('/enrollments/')&&c.method==='DELETE').length,1);
});
test('qualification budget, stage-specific commit failure and cancel are separate from real upstream success',async t=>{
  const {d,w,calls}=await fixture(t);d.querySelector('#startQualificationButton').click();assert.equal(d.querySelector('#qualificationConfirmDialog').open,true);assert.ok(calls.every(c=>c.method==='GET'));
  d.querySelector('#confirmQualificationButton').click();await tick();assert.equal(calls.filter(c=>c.path==='/api/admin/qualifications'&&c.method==='POST').length,1);
  assert.equal(d.querySelector('#cancelQualificationButton').hidden,false);d.querySelector('#cancelQualificationButton').click();await tick();assert.equal(calls.filter(c=>c.path.startsWith('/api/admin/qualifications/')&&c.method==='DELETE').length,1);
});
test('exercise script editing, confirmation and cancel preserve explicit request boundaries',async t=>{
  const {d,w,calls}=await fixture(t);const text=d.querySelector('#exerciseScript textarea');assert.ok(text);text.value='modified synthetic question';text.dispatchEvent(new w.Event('input'));
  d.querySelector('#startExerciseButton').click();assert.equal(d.querySelector('#exerciseConfirmDialog').open,true);assert.ok(calls.every(c=>c.method==='GET'));
  d.querySelector('#confirmExerciseButton').click();await tick();await tick();assert.equal(calls.filter(c=>c.path==='/api/admin/exercises'&&c.method==='POST').length,1);
  d.querySelector('#cancelExerciseButton').click();await tick();assert.equal(calls.filter(c=>c.path.endsWith('/cancel')&&c.method==='POST').length,1);
});
test('read-only status payload cannot carry full private overview even with extra fields',()=>{
  const {composeStatus}=require('../../src/operations/status');const now=Date.now();const o=overviewFixture(now);o.privateToken='synthetic-token';
  const p=JSON.stringify(composeStatus({overview:o,now}));assert.doesNotMatch(p,/privateToken|synthetic-token|演示账号|synthetic-/);
});
