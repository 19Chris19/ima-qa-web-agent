'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {operationsFixture}=require('../../test-support/operations-fixture');
const {buildOperationsOverview,publicOperations}=require('../../src/operations-overview');
const {OperationsMetrics}=require('../../src/operations-metrics');
const {composeStatus}=require('../../src/operations/status');
for(const scenario of ['normal','storage','missing','busy','disabled','cooldown','maintenance','unknown_login','trial_mismatch','stale_qualification'])test(`canonical overview: ${scenario}`,()=>{
  const f=operationsFixture();
  if(scenario==='storage')f.persistence.ready=false;
  if(scenario==='missing')delete f.queue.queuedRequests;
  if(scenario==='busy'){f.queue.activeRequests=6;f.queue.queuedRequests=2;f.readiness.schedulable=0;for(const r of f.readiness.accounts.slice(2)){r.state='busy';r.availableSlots=0;}}
  if(scenario==='disabled')f.management.accounts[2].status='disabled';
  if(scenario==='cooldown')f.readiness.accounts[2].state='cooling';
  if(scenario==='maintenance')f.maintenance=true;
  if(scenario==='unknown_login')delete f.management.accounts[2].health.session_valid;
  if(scenario==='trial_mismatch')f.limits[2].effectiveMaxConcurrent=4;
  if(scenario==='stale_qualification')f.management.accounts[2].health.session_valid=false;
  const result=buildOperationsOverview(f);
  assert.equal(result.onlineUsers,null);
  if(scenario==='normal'){assert.equal(result.capacity,6);assert.equal(result.ready,2);assert.equal(result.rows[2].basis,'operator_trial');}
  if(scenario==='storage'){assert.equal(result.capacity,0);assert.equal(result.free,0);assert.equal(result.state,'outage');}
  if(scenario==='missing'){assert.equal(result.queued,null);assert.equal(result.state,'unknown');}
  if(scenario==='busy'){assert.equal(result.ready,2);assert.equal(result.capacity,6);assert.equal(result.free,0);assert.equal(result.state,'busy');}
  if(['disabled','cooldown','unknown_login','stale_qualification'].includes(scenario))assert.equal(result.capacity,1);
  if(scenario==='maintenance'){assert.equal(result.free,0);assert.equal(result.state,'maintenance');}
  if(scenario==='trial_mismatch')assert.equal(result.rows[2].basis,'unverified');
});
test('status projection explicitly excludes account names, identities, health details and arbitrary secrets',()=>{
  const f=operationsFixture(),o=buildOperationsOverview(f);o.secret='synthetic-sensitive';o.metrics=null;
  const p=JSON.stringify(publicOperations(o));assert.doesNotMatch(p,/synthetic-|演示账号|token|secret|lastCheckAt/);
});
test('runtime expires at 15 seconds, network checks at 90; optional cover is not core outage',()=>{
  const f=operationsFixture(100000),o=buildOperationsOverview(f);o.sourcePreviewState='degraded';const checks={website:{at:100000,ok:true},private_entry:{at:100000,ok:true}};
  assert.equal(composeStatus({overview:o,checks,now:115000}).components.provider.state,'degraded');
  assert.equal(composeStatus({overview:o,checks,now:115001}).components.provider.state,'unknown');
  assert.equal(composeStatus({overview:o,checks,now:190001}).components.website.state,'unknown');
  assert.equal(composeStatus({overview:o,checks,now:100000}).components.source_preview.state,'degraded');
});
test('passive metrics exactly one terminal, no content, bounded storage and no invented success rate',()=>{
  let now=1000;const m=new OperationsMetrics(()=>now);assert.equal(m.snapshot().successRate,null);
  const context={question:'never stored'};m.observe(context,'admitted','started');now+=20;m.observe(context,'first_delta','observed');now+=80;
  m.observe(context,'complete','success');m.observe(context,'upstream_stream','failure');assert.equal(m.snapshot().samples,1);assert.equal(m.snapshot().firstDeltaP95Ms,20);
  for(let i=0;i<1000;i++){const c={};m.observe(c,'admitted','started');m.observe(c,'upstream_stream','failure');}
  assert.equal(m.samples.length,512);assert.doesNotMatch(JSON.stringify(m.snapshot()),/never stored/);
  now+=3600001;assert.equal(m.snapshot().samples,0);assert.equal(m.snapshot().successRate,null);
});

test('missing persistence readiness is unknown rather than fabricated healthy or zero capacity',()=>{
  const f=operationsFixture();f.persistence={};const o=buildOperationsOverview(f);assert.equal(o.state,'unknown');assert.equal(o.capacity,null);assert.equal(o.free,null);
  const s=composeStatus({overview:o,now:f.now});assert.equal(s.components.persistence.state,'unknown');
});
