'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { normalizeApplicationScheduling } = require('../src/application-scheduling');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { normalizeElasticScheduling } = require('../src/elastic-account-scheduler');
const { accountDescriptor } = require('../src/elastic-validation');
const { createApplicationIdentity } = require('../src/application-identity');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

test('validation is scoped to principal, model, mode and account; unknown stays at one', async () => {
  const account = { id: 'fixture', principalFingerprint: 'a'.repeat(64), modelId: 'official_3', modelType: 3 };
  const grant = { accountId: account.id, principalFingerprint: account.principalFingerprint, mode: 'classic_knowledge',
    modelId: account.modelId, modelType: account.modelType, initialConcurrent: 3, validatedMaxConcurrent: 5 };
  const pool = new IMAWebAgentPool({ accounts: [account], elasticScheduling: { enabled: true, initialConcurrent: 20, accountLimits: [grant] } }, { clientFactory: () => ({}) });
  assert.equal(pool.accountCapacity(pool.accounts[0]), 3);
  assert.equal(pool.accountCapacity(pool.accounts[0], { mode: 'knowledge_agent', validatedMaxConcurrent: 20 }), 1);
  assert.equal(pool.accountCapacity(pool.accounts[0], { retrievalPolicy: 'web' }), 1);
  assert.equal(accountDescriptor(pool.accounts[0], { modelId: 'forged' }).modelId, 'official_3');
  pool.syncAccounts([{ ...account, modelId: 'other' }]); assert.equal(pool.accountCapacity(pool.accounts[0]), 1);
  pool.syncAccounts([{ ...account, principalFingerprint: 'b'.repeat(64) }]); assert.equal(pool.accountCapacity(pool.accounts[0]), 1);
  const unknown = new IMAWebAgentPool({ accounts: [account], elasticScheduling: { enabled: true, initialConcurrent: 20 } }, { clientFactory: () => ({}) });
  assert.equal(unknown.stats().capacity, 1); pool.closeScheduling(); unknown.closeScheduling();
  for (const invalid of [[{ ...grant, initialConcurrent: 6 }], [grant, grant], [{ ...grant, principalFingerprint: '' }], [{ ...grant, mode: 'unobserved' }]]) {
    assert.throws(() => normalizeElasticScheduling({ accountLimits: invalid }));
  }
});

test('healthy demand cannot increase a mode past its validated ceiling', () => {
  const account = { id: 'fixture', principalFingerprint: 'a'.repeat(64), modelId: 'official_3', modelType: 3 };
  const grant = { accountId: account.id, principalFingerprint: account.principalFingerprint, mode: 'classic_knowledge', modelId: 'official_3', modelType: 3, initialConcurrent: 1, validatedMaxConcurrent: 2 };
  let now = 1;
  const pool = new IMAWebAgentPool({ accounts: [account], elasticScheduling: { enabled: true, successesToGrow: 1, growthIntervalMs: 1, accountLimits: [grant] } }, { now: () => now, clientFactory: () => ({}) });
  const row = pool.accounts[0], descriptor = accountDescriptor(row);
  for (let i = 0; i < 50; i++) { now++; row.activeRequests = pool.accountCapacity(row); pool.elastic.markDemand(row); pool.elastic.success(row, pool.elastic.reserve(row, descriptor)); }
  row.activeRequests = 0; assert.equal(pool.accountCapacity(row), 2); assert.equal(pool.accountCapacity(row, { mode: 'knowledge_agent' }), 1);
  pool.closeScheduling();
});

test('application caps, bounded queue and work-conserving idle borrowing share one global queue', async () => {
  const queue = createAskQueue({ maxConcurrent: 3, queueLimit: 8, applicationScheduling: { enabled: true,
    applications: { 'application:website': { maxConcurrent: 2, queueLimit: 1 }, 'application:agent': { maxConcurrent: 1 } } } });
  const hold = gate(); const starts = [];
  const submit = (app, id) => queue.run(async () => { starts.push(id); await hold.promise; }, { applicationKey: `application:${app}`, visitorKey: id, laneKey: id });
  const jobs = [submit('website', 'w1'), submit('website', 'w2'), submit('website', 'w3'), submit('agent', 'a1')];
  await assert.rejects(submit('website', 'full'), { name: 'QueueFullError' }); await tick();
  assert.equal(queue.applicationStats('application:website').active, 2);
  assert.equal(queue.applicationStats('application:agent').active, 1);
  assert.equal(queue.stats().activeRequests, 3);
  hold.release(); await Promise.all(jobs); await tick(); assert.equal(queue.stats().activeRequests, 0);
  const only = [submit('website', 'borrow1'), submit('website', 'borrow2')];
  await Promise.all(only); await tick();
});

test('weighted fair scheduling serves every busy application and does not reserve idle capacity', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 100, applicationScheduling: { enabled: true,
    applications: { 'application:website': { weight: 3 }, 'application:agent': { weight: 1 } } } });
  const order = [];
  const jobs = [];
  for (let i = 0; i < 24; i++) for (const app of ['website', 'agent']) jobs.push(queue.run(() => order.push(app), { applicationKey: `application:${app}`, laneKey: `${app}-${i}` }));
  queue.setMaxConcurrent(1); await Promise.all(jobs);
  assert.equal(order.slice(0, 16).filter(app => app === 'website').length, 12);
  assert.equal(order.slice(0, 16).filter(app => app === 'agent').length, 4);
  assert.equal(order.length, 48);
});

test('waiting deadlines and cancellation release application quota without dispatch', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 10, applicationScheduling: { enabled: true, default: { maxWaitMs: 10 } } });
  let calls = 0;
  const expired = assert.rejects(queue.run(() => calls++), { code: 'queue_wait_timeout' });
  const aborter = new AbortController();
  const cancelled = assert.rejects(queue.run(() => calls++, { signal: aborter.signal }), { name: 'RequestAbortedError' });
  aborter.abort(); await Promise.all([expired, cancelled]); assert.equal(calls, 0); assert.equal(queue.stats().queuedRequests, 0);
});

test('credential-bound roles share named quota and cannot select another quota using headers', () => {
  const auth = createApplicationIdentity({ applications: [{ id: 'website', apiTokens: ['synthetic-public'], internalServiceTokens: ['synthetic-internal'] }] });
  for (const [scope, token] of [['ordinary', 'synthetic-public'], ['internal', 'synthetic-internal']]) {
    const req = { headers: { authorization: `Bearer ${token}`, 'x-application-id': 'agent' } }; let accepted = false;
    auth.middleware(scope)(req, {}, () => { accepted = true; }); assert.equal(accepted, true); assert.equal(req.applicationKey, 'application:website');
  }
  for (const config of [{ applications: { forged: {} } }, { default: { maxConcurrent: 101 } }, { applications: { internal: { weight: 0 } } }, { default: { queueLimit: -1 } }]) assert.throws(() => normalizeApplicationScheduling(config));
});

test('durable HTTP records a waiting deadline as one failed task without asking upstream', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { once } = require('node:events');
  const { createApp } = require('../src/app');
  const { ConversationStore } = require('../src/conversation-store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-app-deadline-'));
  const storePath = path.join(directory, 'history.json');
  let calls = 0;
  const app = createApp({ config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: {},
    conversations: { storePath }, security: { apiToken: 'synthetic-api' }, limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 },
    concurrency: { maxConcurrentAsk: 1, queueLimit: 2, applicationScheduling: { enabled: true, default: { maxConcurrent: 0, queueLimit: 1, maxWaitMs: 20 } } } },
    conversationStore: new ConversationStore({ storePath }),
    imaWebAgentClient: { async *streamAsk() { calls++; throw new Error('must not dispatch'); } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await app.locals.durableQATasks.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer synthetic-api', 'X-IMA-Client-Id': 'fixture', 'Content-Type': 'application/json' };
  const conversationId = (await (await fetch(`${base}/api/conversations`, { method: 'POST', headers })).json()).conversation.conversationId;
  const post = { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'same-fixture-key' }, body: JSON.stringify({ conversationId, question: 'synthetic question' }) };
  const submitted = await fetch(`${base}/api/tasks`, post); assert.equal(submitted.status, 202);
  const { task } = await submitted.json();
  for (let i = 0; i < 100 && app.locals.durableQATasks.store.tasks.get(task.id).status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const recorded = app.locals.durableQATasks.store.tasks.get(task.id);
  assert.equal(recorded.status, 'failed'); assert.equal(recorded.trace.terminalReason, 'queue_wait_timeout');
  const repeated = await (await fetch(`${base}/api/tasks`, post)).json(); assert.equal(repeated.task.id, task.id);
  assert.equal(calls, 0); assert.equal(app.locals.durableQATasks.store.tasks.size, 1);
});

test('restored waiting work retains its original deadline, including when a slot is free', async () => {
  let now = 1000, timer;
  const options = { now: () => now, queueLimit: 1,
    applicationScheduling: { enabled: true, default: { maxWaitMs: 100 } },
    setTimeout: (fn, delay) => { timer = { fn, delay }; return 1; }, clearTimeout() {} };
  const queue = createAskQueue({ ...options, maxConcurrent: 0 });
  let calls = 0;
  const expired = assert.rejects(queue.run(() => calls++, { enqueuedAt: 950 }), { code: 'queue_wait_timeout' });
  assert.equal(timer.delay, 50); now = 1050; timer.fn(); await expired;
  const free = createAskQueue({ ...options, maxConcurrent: 1 });
  await assert.rejects(free.run(() => calls++, { enqueuedAt: 950 }), { code: 'queue_wait_timeout' });
  assert.equal(calls, 0); assert.equal(free.stats().activeRequests, 0);
});
