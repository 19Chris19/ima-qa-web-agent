'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const {createPreviewApp}=require('../../scripts/operations/preview');
const {overviewFixture}=require('../../test-support/operations-fixture');
const tick=()=>new Promise(r=>setTimeout(r,20));
async function waitFor(condition, description){
  const deadline=Date.now()+5000;
  while(!condition()&&Date.now()<deadline)await tick();
  assert.ok(condition(),description);
}
async function fixture(t){
  const preview=createPreviewApp(),server=preview.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../../public/admin.html'),'utf8'),{url:origin+'/admin.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.scrollTo=()=>{};w.AbortController=AbortController;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.confirm=()=>true;
  w.fetch=(url,options={})=>fetch(origin+url,{...options,headers:{...options.headers,origin}});
  w.eval(fs.readFileSync(path.join(__dirname,'../../public/admin-poller.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../../public/operations/recent-status.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../../public/admin.js'),'utf8'));
  t.after(async()=>{w.dispatchEvent(new w.Event('pagehide'));w.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  await waitFor(()=>!w.document.querySelector('#reloadButton').disabled &&
    w.document.querySelector('#capacityAllocation').textContent.includes('路') &&
    w.document.querySelector('#exerciseScript textarea'),'admin data loaded');
  return {...preview,w,d:w.document};
}
test('new overview is runtime-derived; refresh reads only and leaves filters, drawer and exercise drafts intact',async t=>{
  const {d,w,calls}=await fixture(t);assert.match(d.querySelector('#adminSummary').textContent,/2 \/ 4/);assert.match(d.querySelector('#adminSummary').textContent,/6/);
  assert.ok(calls.every(c=>c.method==='GET'));
  assert.match(d.querySelector('#qualificationCapacityLabel').textContent,/网站当前容量 6 路.*历史资格折算 16 路/);
  d.querySelector('#accountFilter').value='ready';d.querySelector('#accountFilter').dispatchEvent(new w.Event('change'));assert.equal(d.querySelectorAll('#accountList tbody tr').length,2);
  d.querySelector('.account-name-button').click();assert.equal(d.querySelector('#accountDrawer').open,true);assert.match(d.querySelector('#accountDrawerContent').textContent,/试运行|默认限制/);
  const draft=d.querySelector('#exerciseScript textarea');assert.ok(draft);draft.value='keep this exact draft';
  d.querySelector('#reloadButton').click();
  await waitFor(()=>!d.querySelector('#reloadButton').disabled,'admin refresh finished');
  assert.equal(d.querySelector('#accountFilter').value,'ready');assert.equal(d.querySelector('#accountDrawer').open,true);assert.equal(draft.value,'keep this exact draft');assert.ok(calls.every(c=>c.method==='GET'));
});
test('arbitrary existing-account recovery has no name and requires explicit optional single-question consent',async t=>{
  const {d,w,calls}=await fixture(t);d.querySelector('#restoreAnyAccountButton').click();assert.equal(d.querySelector('#enrollmentDialog').open,true);assert.equal(d.querySelector('#enrollmentName').required,false);assert.equal(d.querySelector('#enrollmentName').hidden,true);
  assert.ok(calls.every(c=>c.method==='GET'));d.querySelector('#reactivateMatchedAccount').checked=true;d.querySelector('#enrollmentForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>d.querySelector('#enrollmentForm').hidden && !d.querySelector('#cancelEnrollmentButton').hidden,'enrollment can be cancelled');
  assert.equal(calls.filter(c=>c.path==='/api/admin/enrollments'&&c.method==='POST').length,1);
  d.querySelector('#cancelEnrollmentButton').click();
  await waitFor(()=>d.querySelector('#cancelEnrollmentButton').hidden && !d.querySelector('#cancelEnrollmentButton').disabled,'enrollment cancellation finished');
  assert.equal(calls.filter(c=>c.path.includes('/enrollments/')&&c.method==='DELETE').length,1);
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

test('new home order, advanced disclosure, shared recent chart and theme keep refresh read-only',async t=>{
 const {d,w,calls}=await fixture(t);await tick();assert.equal(d.querySelector('.advanced-navigation').open,false);assert.equal(d.querySelectorAll('#recentStatus .recent-row').length,4);assert.equal(d.querySelectorAll('#recentStatus .recent-bars span').length,240);assert.equal(d.querySelector('#attentionCount').textContent,'2');assert.match(d.querySelector('#serviceHeadline').textContent,/部分账号/);assert.equal(d.querySelectorAll('#attentionAccounts .target-action').length,2);d.querySelector('#themeButton').click();assert.ok(['dark','light'].includes(d.documentElement.dataset.theme));
 const range=d.querySelector('.recent-selector');range.value='45';range.focus();range.dispatchEvent(new w.Event('input'));const before=range.getAttribute('aria-valuetext');d.querySelector('#reloadButton').click();
 await waitFor(()=>!d.querySelector('#reloadButton').disabled,'admin refresh finished');
 assert.equal(range.value,'45');assert.equal(range.getAttribute('aria-valuetext'),before);assert.ok(calls.every(c=>c.method==='GET'));
});
test('cancel targeted account check sends nothing and double confirmed action stays single',async t=>{
 const {d,w,calls}=await fixture(t);
 d.querySelector('#adminNavigation a[data-view="accounts"]').click();
 const menu=d.querySelectorAll('#accountList .admin-more')[2];
 const rowId=menu.closest('tr').dataset.accountId;
 const checkButton=()=>[...d.querySelectorAll('#accountList tr[data-account-id]')]
   .find(row=>row.dataset.accountId===rowId)?.querySelector('.admin-more button');
 menu.open=true;
 const check=checkButton();
 assert.equal(check?.textContent,'检查登录状态');
 w.confirm=()=>false;
 check.click();
 assert.ok(!calls.some(c=>c.method==='POST'));
 w.confirm=()=>true;
 check.click();
 check.click();
 // The form is rendered again after the confirmed request and its state refresh.
 for(let i=0;i<100&&checkButton()?.disabled!==false;i++)await tick();
 assert.equal(checkButton()?.disabled,false);
 assert.equal(calls.filter(c=>c.path.endsWith('/check')&&c.method==='POST').length,1);
});
test('single-account qualification presents exact budget, cancel leaves no maintenance mutation',async t=>{
 const {d,w,calls}=await fixture(t);const select=d.querySelector('#previewScenario');select.value='qualification';select.dispatchEvent(new w.Event('change'));for(let i=0;i<30&&!d.querySelector('#attentionAccounts').textContent.includes('验证此账号');i++)await tick();const button=[...d.querySelectorAll('#attentionAccounts button')].find(b=>b.textContent==='验证此账号');assert.ok(button);button.click();assert.equal(d.querySelector('#qualificationConfirmDialog').open,true);assert.match(d.querySelector('#qualificationConfirmText').textContent,/最多 1 次/);const before=calls.filter(c=>c.method==='POST').length;d.querySelector('#cancelQualificationConfirmButton').click();await tick();assert.equal(calls.filter(c=>c.method==='POST').length,before);
});
test('uncertain save reconciliation needs confirmation, remains protected on inconclusive result',async t=>{
 const {d,w,calls}=await fixture(t);const select=d.querySelector('#previewScenario');select.value='storage';select.dispatchEvent(new w.Event('change'));for(let i=0;i<30&&d.querySelector('#reconcileButton').hidden;i++)await tick();assert.equal(d.querySelector('#reconcileButton').hidden,false);assert.equal(d.querySelector('#addAccountButton').disabled,true);w.confirm=()=>false;d.querySelector('#reconcileButton').click();await tick();assert.equal(calls.filter(c=>c.path.endsWith('/persistence/reconcile')).length,0);w.confirm=()=>true;d.querySelector('#reconcileButton').click();d.querySelector('#reconcileButton').click();await tick();await tick();assert.equal(calls.filter(c=>c.path.endsWith('/persistence/reconcile')).length,1);assert.match(d.querySelector('#reconcileFeedback').textContent,/保护保持不变/);assert.equal(d.querySelector('#addAccountButton').disabled,true);
});
test('expired runtime view becomes unknown, does not leave green account chips or actionable maintenance',async t=>{
 const {d,w}=await fixture(t);const now=Date.now();w.Date.now=()=>now+16001;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(d.querySelector('#serviceHero').dataset.state,'unknown');assert.ok([...d.querySelectorAll('#accountList .status-chip')].every(chip=>chip.dataset.state==='unknown'));assert.match(d.querySelector('#adminSummaryNote').textContent,/快照已过期/);assert.ok([...d.querySelectorAll('#accountList .account-row-actions button')].every(b=>b.disabled));w.Date.now=Date.now;d.querySelector('#reloadButton').click();for(let i=0;i<30&&d.querySelector('#reloadButton').disabled;i++)await tick();assert.ok([...d.querySelectorAll('#accountList .status-chip')].some(chip=>chip.dataset.state==='normal'));assert.equal(d.querySelector('#addAccountButton').disabled,false);
});
