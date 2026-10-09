'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { IMAWebAgentClient } = require('../src/air/ima-web-agent-client');
const { getAirConfig } = require('../src/air/config');
const { createAirRuntime } = require('../src/air/startup');
const { AirPolicyCapacity } = require('../src/air/policy-capacity');
const { AirWebReadiness } = require('../src/air/web-readiness');
const { AirAccountDirectory } = require('../src/air/account-directory');
const { registerAirAdminRoutes } = require('../src/air/admin');
const { createAirEnrollmentHooks } = require('../src/air/enrollment-hooks');
const { knowledgeAgentContractDigest } = require('../src/ima-knowledge-agent-contract');
const { answerProfileContractDigest } = require('../src/ima-answer-profile');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const now = Date.parse('2026-10-09T00:00:00.000Z');
const proof = id => ({ level: 'basic', capabilityDigest: knowledgeAgentContractDigest(),
  requests: 1, terminalCount: 1, passedModes: 1, knowledgeSourceCount: 1, unknownSourceCount: 0,
  verifiedAt: new Date(now - 1000).toISOString(), knowledgeScopeRef: hash('synthetic-kb'), principalFingerprint: hash(id) });
const account = id => ({ id, name: id, knowledgeBaseId: 'synthetic-kb', principalFingerprint: hash(id),
  knowledgeAgentQualification: proof(id), headers: { 'x-ima-cookie': `IMA-UID=${id}; IMA-TOKEN=synthetic-token`, 'x-ima-bkn': '123' },
  modelId: 'official_3', modelType: 3, maxConcurrent: 1, activeRequests: 0, cooldownUntil: 0,
  disabled: false, routingLane: 'flex' });

test('Air configuration is opt-in and validates paired context, external paths and unchanged profiles', () => {
  assert.deepEqual(getAirConfig({}), { enabled: false });
  const env = { IMA_QA_AIR_BOT_EXTENSIONS: 'true', IMA_WEB_AGENT_ANSWER_PROFILE: 'ima_agent_auto' };
  const value = getAirConfig(env);
  assert.equal(value.answerProfile, 'ima_agent_auto');
  assert.equal(value.capabilityDigest, '');
  assert.throws(() => getAirConfig({ ...env, IMA_QA_RECENT_CONTEXT_URL: 'http://127.0.0.1:1' }), /recent_context_config_invalid/);
  assert.throws(() => getAirConfig({ ...env, WECHAT_QA_OBSERVABILITY_ENABLED: 'true' }), /socket_required/);
  assert.throws(() => getAirConfig({ ...env, WECHAT_QA_OBSERVABILITY_SOCKET_PATH: path.join(__dirname, 'observe.sock') }), /external_absolute/);
  assert.throws(() => getAirConfig({ ...env, IMA_QA_RECENT_CONTEXT_URL: 'http://example.com', IMA_QA_RECENT_CONTEXT_TOKEN: 'synthetic' }), /recent_context_config_invalid/);
});

test('actual pool consumes the Air clientFactory in its second argument', () => {
  const runtime = createAirRuntime({ config: { qaProvider: 'ima-web-agent', webAgent: {},
    airBot: getAirConfig({ IMA_QA_AIR_BOT_EXTENSIONS: 'true' }) } });
  const pool = new IMAWebAgentPool({ accounts: [account('one')] }, runtime.poolOptions);
  assert.ok(pool.accounts[0].client instanceof IMAWebAgentClient);
  assert.equal(pool.accounts[0].client.clientContextProvider, runtime.poolOptions.clientContextProvider);
  runtime.attachPool(pool, { getPoolAccounts: () => [account('one')] });
  const snapshot = runtime.appOptions.botCompatibility.snapshot();
  assert.equal(snapshot.policyCapacity.knowledge_agent, 1);
  assert.equal(snapshot.generation, runtime.appOptions.botCompatibility.snapshot().generation);
  assert.equal(runtime.poolOptions.policyEligibility(pool.accounts[0], { retrievalPolicy: 'knowledge_agent' }), true);
  assert.equal(runtime.poolOptions.policyEligibility(pool.accounts[0], { retrievalPolicy: 'web' }), false);
  assert.equal(runtime.poolOptions.policyEligibility(pool.accounts[0], { mode: 'knowledge_agent' }), true);
  const source = fs.readFileSync(path.join(__dirname, '../provider-a-server.js'), 'utf8');
  assert.match(source, /accounts: accountDirectory\.getPoolAccounts\(\),\s*\},\s*\{\s*\.\.\.airRuntime\?\.poolOptions/u);
  assert.ok(source.indexOf('await acquireAccountStoreFence(') < source.indexOf('new AirAccountDirectory('));
});

test('five existing basic native proofs remain eligible without rewriting proof, probing or electing mode', () => {
  const source = Array.from({ length: 5 }, (_, i) => account(`synthetic-${i}`));
  const before = JSON.stringify(source);
  const store = { generation: 7, settings: { webMode: 'knowledge_agent' } };
  const directory = { wasExisting: true, load: () => store, _writeStore() { throw new Error('unexpected store write'); },
    getPoolAccounts: () => source, getAccount: id => ({ ...source.find(a => a.id === id), runtime: {} }),
    listAccounts: () => source.map(a => ({ id: a.id, health: {} })) };
  const pool = new IMAWebAgentPool({ accounts: source }, { clientFactory: () => ({}) , now: () => now });
  const policies = new AirPolicyCapacity({ directory, pool, now: () => now });
  const readiness = new AirWebReadiness({ directory, pool, policies });
  assert.equal(readiness.mode, 'knowledge_agent');
  assert.equal(readiness.snapshot().knowledgeAgentCapacity, 5);
  assert.equal(readiness.snapshot().capacity, 5);
  assert.equal(readiness.snapshot().pending, 0);
  assert.ok(readiness.snapshot().accounts.every(row => row.state === 'ready' && row.reason === 'ok'));
  pool.accounts[0].activeRequests = 1;
  pool.accounts[1].cooldownUntil = now + 1000;
  pool.accounts[2].maintenanceOperation = 'qualification';
  const occupied = readiness.snapshot();
  assert.equal(occupied.capacity, 3);
  assert.equal(occupied.schedulable, 2);
  assert.equal(occupied.pending, 0);
  assert.deepEqual(occupied.accounts.slice(0, 3).map(row => [row.state, row.qualified]),
    [['busy', true], ['cooling', true], ['pending', true]]);
  pool.accounts[0].activeRequests = 0;
  pool.accounts[1].cooldownUntil = 0;
  pool.accounts[2].maintenanceOperation = '';
  assert.equal(pool.accounts.filter(a => pool.webReadiness(a)).length, 5);
  assert.equal(JSON.stringify(source), before);
  source[0].knowledgeAgentQualification = { ...source[0].knowledgeAgentQualification, principalFingerprint: hash('changed') };
  assert.equal(readiness.snapshot().capacity, 4);
  assert.equal(readiness.snapshot().accounts[0].state, 'pending');
  assert.equal(readiness.snapshot().accounts[0].reason, 'qualification_required');
  source[1].disabled = true;
  pool.syncAccounts(source);
  assert.equal(readiness.snapshot().capacity, 3);
  assert.equal(readiness.snapshot().accounts[1].qualified, true);
  assert.equal(readiness.snapshot().accounts[1].state, 'disabled');
  assert.equal(readiness.snapshot().pending, 1);
});

test('source policies retain proof, lane, active profile and distinct-account pair requirements', () => {
  const accounts = [account('a'), account('b')];
  for (const row of accounts) row.retrievalPolicyQualifications = {
    group_knowledge: { answerBasis: 'knowledge', capabilityDigest: answerProfileContractDigest('classic_knowledge') },
    web: { answerBasis: 'web', capabilityDigest: answerProfileContractDigest('ima_agent_auto') },
  };
  const directory = { getPoolAccounts: () => accounts };
  const pool = { accounts };
  const blocked = new AirPolicyCapacity({ directory, pool, now: () => now });
  assert.equal(blocked.policyCapacitySnapshot().group_knowledge, 2);
  assert.equal(blocked.policyCapacitySnapshot().web, 0);
  const policies = new AirPolicyCapacity({ directory, pool, profile: 'ima_agent_auto',
    capabilityDigest: answerProfileContractDigest('ima_agent_auto'), now: () => now });
  assert.equal(policies.policyCapacitySnapshot().web, 2);
  assert.equal(policies.pairedCapacitySnapshot().knowledge_web_parallel, 1);
  accounts[0].routingLane = 'knowledge';
  assert.equal(policies.policyCapacitySnapshot().web, 1);
  accounts[1].cooldownUntil = now + 1;
  assert.equal(policies.policyCapacitySnapshot().web, 0);
  assert.equal(policies.pairedCapacitySnapshot().knowledge_web_parallel, 0);
});

test('Air directory persists validated basic evidence with CAS and no fabricated public proof', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-directory-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const directory = new AirAccountDirectory({ storePath: path.join(tmp, 'accounts.json'),
    keyPath: path.join(tmp, 'key'), keyMaterial: 'synthetic-test-material', now: () => new Date(now).toISOString() });
  directory.upsertCapturedAccount({ ...account('a'), requireQualification: true });
  const stored = directory.getAccount('a');
  const evidence = { ...proof('a'), principalFingerprint: stored.principalFingerprint };
  const expected = { accountId: 'a', account: stored, events: stored.events, disabled: true,
    activateEnrollment: true, digest: hash(JSON.stringify(stored)) };
  directory.applyKnowledgeAgentQualification('a', evidence, expected);
  assert.equal(directory.getAccount('a').runtime.disabled, false);
  assert.equal(directory.getAccount('a').runtime.webQualification, null);
  directory.reload();
  assert.deepEqual(directory.getPoolAccounts()[0].knowledgeAgentQualification, evidence);
  assert.throws(() => directory.applyKnowledgeAgentQualification('a', evidence, expected), /binding_changed/);
});

test('Air enrollment follows runId, preserves commit receipt and cancels the exact pending run', async () => {
  let finish;
  const cancelled = [];
  const hooks = createAirEnrollmentHooks({
    async startForAccount(id, input) { assert.equal(input.authorizedRequestCount, 1); input.onStarted({ id: 'synthetic-run' }); return { runId: 'synthetic-run' }; },
    waitFor(id) { assert.equal(id, 'synthetic-run'); return new Promise(resolve => { finish = resolve; }); },
    cancel: id => cancelled.push(id),
  });
  const pending = hooks.onEnrolled('synthetic-account');
  await Promise.resolve();
  hooks.onCancelVerification('different');
  hooks.onCancelVerification('synthetic-account');
  assert.deepEqual(cancelled, ['synthetic-run']);
  finish({ status: 'succeeded', commitApplied: true, warnings: ['pool_sync_failed'] });
  assert.deepEqual(await pending, { success: true, commitApplied: true, warning: 'pool_sync_failed', code: 'ok' });
});

test('Air admin routes retain auth, exact run budget, eligibility and sanitized errors', async t => {
  const app = express(); app.use(express.json());
  let starts = 0;
  registerAirAdminRoutes(app, { config: { security: { adminToken: 'synthetic-admin-token' } },
    accountDirectory: { getAccount: () => null, listAccounts: () => [] }, policies: { eligibilitySnapshot: () => ({ accounts: [] }) },
    manager: { getBootstrap: () => ({ authorizedRequestCount: 7 }), getActive: () => null,
      listReports: () => [], getReport() { throw new Error('synthetic-private-upstream-text'); },
      async start(input) { starts++; assert.equal(input.confirm, true); return { runId: 'synthetic' }; } } });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/admin/qualifications` , { method: 'POST' })).status, 401);
  const headers = { Authorization: 'Bearer synthetic-admin-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/admin/qualifications`, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) })).status, 201);
  assert.equal(starts, 1);
  assert.deepEqual((await (await fetch(`${base}/api/admin/v2/accounts/eligibility`, { headers })).json()).accounts, []);
  const error = await (await fetch(`${base}/api/admin/qualifications/reports/missing`, { headers })).text();
  assert.doesNotMatch(error, /private-upstream/);
});
