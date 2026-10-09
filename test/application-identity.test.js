const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { createApplicationIdentity, applicationOwnerKey, normalizeApplicationMappings } = require('../src/application-identity');
const { getConfig } = require('../src/config');
const { createApp, getConversationOwnerKey } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');
const { DurableQATaskStore, RETENTION_MS } = require('../src/durable-qa-store');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { createAskQueue } = require('../src/ask-queue');
const { registerDurableQARoutes } = require('../src/durable-qa-routes');

const applications = [
  { id: 'website-a', apiTokens: ['synthetic-a-old', 'synthetic-a-new'], internalServiceTokens: ['synthetic-a-service'] },
  { id: 'website-b', apiTokens: ['synthetic-b'], internalServiceTokens: ['synthetic-b-service'] },
];
const security = { apiToken: 'synthetic-legacy', internalServiceToken: 'synthetic-legacy-service', applications };
const owner = 'synthetic-visitor';
const input = { conversationId: 'synthetic-conversation', question: 'synthetic question' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(fn) {
  for (let n = 0; n < 200; n++) { if (fn()) return; await pause(5); }
  assert.fail('condition did not settle');
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return (route, token, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    ...init, headers: { 'content-type': 'application/json', 'x-ima-client-id': owner,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}
function authenticate(auth, scope, token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  let status;
  let accepted = false;
  auth.middleware(scope)(req, { status(code) { status = code; return this; }, json() {} }, () => { accepted = true; });
  return { req, status, accepted };
}

test('mapping validates strictly without echoing credential values', () => {
  assert.deepEqual(normalizeApplicationMappings(applications, security), applications);
  const invalid = [null, {}, [{}], [{ id: 'UPPER', apiTokens: ['synthetic-secret'] }],
    [{ id: 'a', apiTokens: [''] }], [{ id: 'a', apiTokens: [' token '] }], [{ id: 'a', apiTokens: ['line\nbreak'] }],
    [{ id: 'a', apiTokens: 'synthetic-secret' }], [{ id: 'a', extra: true, apiTokens: ['synthetic-secret'] }],
    [{ id: 'a' }], [{ id: 'a', apiTokens: ['same', 'same'] }],
    [{ id: 'a', apiTokens: ['same'], internalServiceTokens: ['same'] }],
    [{ id: 'a', apiTokens: ['one'] }, { id: 'a', apiTokens: ['two'] }],
    [{ id: 'a', apiTokens: ['same'] }, { id: 'b', internalServiceTokens: ['same'] }],
    [{ id: 'a', apiTokens: ['synthetic-legacy'] }]];
  for (const value of invalid) {
    assert.throws(() => normalizeApplicationMappings(value, security), error => error.message === 'invalid_application_mapping');
  }
  const env = { IMA_OPENAPI_CLIENTID: 'synthetic', IMA_OPENAPI_APIKEY: 'synthetic',
    IMA_SHARED_KNOWLEDGE_BASE_ID: 'synthetic', MIMO_API_KEY: 'synthetic', IMA_QA_APPLICATIONS_JSON: JSON.stringify(applications) };
  assert.deepEqual(getConfig(env).security.applications, applications);
  for (const value of ['{secret', 'null', '{}', '[{"id":"a","apiTokens":["synthetic-private-secret","synthetic-private-secret"]}]']) {
    assert.throws(() => getConfig({ ...env, IMA_QA_APPLICATIONS_JSON: value }), error =>
      error.name === 'ConfigError' && error.message.includes('IMA_QA_APPLICATIONS_JSON') && !error.message.includes('synthetic-private'));
  }
});

test('credential-bound identity survives rotation and cannot be chosen by request header', () => {
  const auth = createApplicationIdentity(security);
  const old = authenticate(auth, 'ordinary', 'synthetic-a-old');
  const next = authenticate(auth, 'ordinary', 'synthetic-a-new');
  const other = authenticate(auth, 'ordinary', 'synthetic-b');
  const internal = authenticate(auth, 'internal', 'synthetic-a-service');
  old.req.headers['x-application-id'] = 'website-b';
  assert.equal(old.req.applicationKey, 'application:website-a');
  assert.equal(applicationOwnerKey(old.req, owner), applicationOwnerKey(next.req, owner));
  assert.equal(applicationOwnerKey(old.req, owner), applicationOwnerKey(internal.req, owner));
  assert.notEqual(applicationOwnerKey(old.req, owner), applicationOwnerKey(other.req, owner));
  assert.equal(authenticate(auth, 'ordinary', 'synthetic-a-service').status, 401);
  assert.equal(authenticate(auth, 'internal', 'synthetic-a-old').status, 401);
  assert.equal(authenticate(auth, 'ordinary', 'synthetic-unknown').status, 401);
  const rotated = createApplicationIdentity({ ...security, applications: [{ ...applications[0], apiTokens: ['synthetic-a-new'] }] });
  assert.equal(authenticate(rotated, 'ordinary', 'synthetic-a-old').status, 401);
  assert.equal(applicationOwnerKey(authenticate(rotated, 'ordinary', 'synthetic-a-new').req, owner), applicationOwnerKey(old.req, owner));
  const builtin = createApplicationIdentity({ applications });
  assert.equal(applicationOwnerKey(authenticate(builtin, 'ordinary').req, owner), owner);
  assert.equal(authenticate(builtin, 'ordinary', 'synthetic-revoked').status, 401);
  assert.equal(authenticate(createApplicationIdentity({}), 'internal').status, 404);
  assert.equal(applicationOwnerKey(authenticate(auth, 'ordinary', 'synthetic-legacy').req, owner), owner);
  const forged = authenticate(auth, 'ordinary', 'synthetic-legacy').req;
  forged.headers['x-ima-client-id'] = applicationOwnerKey(old.req, owner);
  forged.applicationKey = 'application:website-a';
  assert.notEqual(getConversationOwnerKey(forged, { setHeader() {} }), applicationOwnerKey(old.req, owner));
});

test('task receipts include application identity in lookup, ownership, pruning and reload', t => {
  const dir = directory(t);
  let now = 1;
  let store = new DurableQATaskStore({ directory: dir, now: () => now });
  const a = store.create({ ownerKey: owner, scope: 'ordinary', key: 'same', input, applicationKey: 'application:website-a' }).task;
  const b = store.create({ ownerKey: owner, scope: 'ordinary', key: 'same', input, applicationKey: 'application:website-b' }).task;
  assert.notEqual(a.id, b.id);
  assert.equal(store.find(owner, 'ordinary', 'same', input, 'application:website-a').id, a.id);
  assert.throws(() => store.owned(a.id, owner, 'ordinary', 'application:website-b'), { code: 'task_not_found' });
  assert.throws(() => store.owned(a.id, owner, 'ordinary'), { code: 'task_not_found' });
  assert.equal(store.list(owner, 'ordinary', undefined, undefined, 'application:website-b').length, 1);
  store.finish(a.id, 'cancelled', { failureReason: 'task_cancelled' });
  now += RETENTION_MS + 1;
  store.prune();
  store.close();
  store = new DurableQATaskStore({ directory: dir, now: () => now });
  t.after(() => store.close());
  const replay = store.create({ ownerKey: owner, scope: 'ordinary', key: 'same', input, applicationKey: 'application:website-a' });
  assert.equal(replay.isNew, false);
  assert.equal(replay.task.status, 'cancelled');
  assert.equal(replay.task.eventsExpired, true);
});

test('legacy identity migration never replays dispatched or terminal tasks', async t => {
  const dir = directory(t);
  const conversations = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const conversationId = conversations.create(owner).conversationId;
  const taskInput = { ...input, conversationId };
  const ledger = path.join(dir, 'tasks');
  const store = new DurableQATaskStore({ directory: ledger });
  const running = store.create({ ownerKey: owner, scope: 'ordinary', key: 'running', input: taskInput }).task;
  store.running(running.id);
  const terminal = store.create({ ownerKey: owner, scope: 'ordinary', key: 'terminal', input: taskInput }).task;
  store.finish(terminal.id, 'cancelled', { failureReason: 'task_cancelled' });
  for (const task of store.tasks.values()) {
    const legacy = structuredClone(task);
    delete legacy.applicationKey;
    fs.writeFileSync(path.join(ledger, `${task.id}.json`), JSON.stringify(legacy));
  }
  store.close();
  let calls = 0;
  const manager = new DurableQATasks({ directory: ledger, conversations, queue: createAskQueue({}), execute: () => { calls++; } });
  t.after(() => manager.close());
  assert.equal(manager.store.owned(running.id, owner, 'ordinary').status, 'indeterminate');
  assert.equal(manager.store.owned(terminal.id, owner, 'ordinary').status, 'cancelled');
  assert.equal(manager.store.find(owner, 'ordinary', 'running', taskInput).id, running.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ledger, `${running.id}.json`))).applicationKey, 'ordinary');
  assert.equal(calls, 0);
});

test('identity migration write faults fail closed without mutating legacy dispatch receipts', t => {
  const dir = directory(t);
  let store = new DurableQATaskStore({ directory: dir });
  const created = store.create({ ownerKey: owner, scope: 'ordinary', key: 'legacy-fault', input }).task;
  store.running(created.id);
  const legacy = structuredClone(store.tasks.get(created.id));
  delete legacy.applicationKey;
  const file = path.join(dir, `${created.id}.json`);
  fs.writeFileSync(file, JSON.stringify(legacy));
  store.close();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' }); };
  try { assert.throws(() => new DurableQATaskStore({ directory: dir }), { code: 'task_store_unavailable' }); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), legacy);
  store = new DurableQATaskStore({ directory: dir });
  t.after(() => store.close());
  const migrated = store.find(owner, 'ordinary', 'legacy-fault', input);
  assert.equal(migrated.id, created.id);
  assert.equal(migrated.status, 'running');
  assert.equal(migrated.applicationKey, 'ordinary');
});

test('mapped ordinary conversations and legacy asks isolate equal browser owner IDs', async t => {
  const config = { qaProvider: 'ima-web-agent', security, mimo: {}, webAgent: {}, limits: { maxQuestionLength: 2000 },
    concurrency: { maxConcurrentAsk: 2, queueLimit: 10 }, rateLimit: { windowMs: 0, max: 0 } };
  const conversations = new ConversationStore({ persist: false });
  const app = createApp({ config, conversationStore: conversations, imaWebAgentClient: { async *streamAsk() {
    yield { type: 'delta', text: 'synthetic answer' }; yield { type: 'done' };
  } } });
  const request = await listen(t, app);
  const created = await (await request('/api/conversations', 'synthetic-a-old', { method: 'POST' })).json();
  const id = created.conversation.conversationId;
  assert.equal((await request(`/api/conversations/${id}`, 'synthetic-a-new')).status, 200);
  for (const token of ['synthetic-b', 'synthetic-legacy']) {
    assert.equal((await request(`/api/conversations/${id}`, token)).status, 404);
    assert.equal((await request(`/api/conversations/${id}`, token, { method: 'DELETE' })).status, 404);
  }
  assert.equal((await (await request('/api/conversations', 'synthetic-b')).json()).conversations.length, 0);
  const original = app.locals.imaQaAskQueue.run.bind(app.locals.imaQaAskQueue);
  let keys;
  app.locals.imaQaAskQueue.run = (work, options) => { keys = options; return original(work, options); };
  const answer = await request('/api/ask', 'synthetic-a-new', { method: 'POST',
    headers: { 'x-application-id': 'website-b', 'x-application-key': 'application:website-b' },
    body: JSON.stringify({ conversationId: id, question: 'synthetic question' }) });
  assert.equal(answer.status, 200);
  assert.equal(keys.applicationKey, 'application:website-a');
  assert.match(keys.visitorKey, /^application\/website-a\//);
  assert.equal(keys.laneKey, id);
  const stolen = await request('/api/ask', 'synthetic-b', { method: 'POST', body: JSON.stringify({ conversationId: id, question: 'synthetic' }) });
  assert.equal(stolen.status, 404);
});

test('task routes forward trusted application key for submit, list, status, events and cancel', async t => {
  const auth = createApplicationIdentity(security);
  const app = express();
  app.use(express.json());
  const seen = [];
  const task = { id: 'synthetic-task', input, events: [] };
  const tasks = { available: true,
    submit(args) { seen.push(['submit', args.applicationKey, args.ownerKey]); return { task, isNew: true }; },
    cancel(...args) { seen.push(['cancel', args.at(-1)]); return task; },
    subscribe(_task, _after, res) { res.end(); },
    store: { list(...args) { seen.push(['list', args.at(-1)]); return []; },
      owned(...args) { seen.push(['owned', args.at(-1)]); return task; }, publicTask: value => value },
  };
  registerDurableQARoutes(app, { tasks, config: { security, limits: { maxQuestionLength: 2000 } }, conversations: {},
    ordinaryAuth: auth.middleware('ordinary'), internalAuth: auth.middleware('internal'),
    getConversationOwnerKey, validateAskRequest: () => ({ ok: true, conversationId: input.conversationId }), admit() {} });
  const request = await listen(t, app);
  assert.equal((await request('/api/tasks', 'synthetic-a-new', { method: 'POST', headers: { 'Idempotency-Key': 'same' }, body: JSON.stringify(input) })).status, 202);
  for (const route of ['/api/tasks', '/api/tasks/synthetic-task', '/api/tasks/synthetic-task/events']) assert.equal((await request(route, 'synthetic-a-new')).status, 200);
  assert.equal((await request('/api/tasks/synthetic-task', 'synthetic-a-new', { method: 'DELETE' })).status, 200);
  assert.equal(seen.length, 5);
  assert.ok(seen.every(call => call[1] === 'application:website-a'));
  assert.match(seen[0][2], /^application\/website-a\//);
});

test('legacy deep-ask idempotency is isolated by trusted application and shared across rotated service tokens', async t => {
  const dir = directory(t);
  const conversations = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  let calls = 0;
  const config = { qaProvider: 'ima-web-agent', mimo: {}, webAgent: {},
    security: { ...security, applications: [{ ...applications[0], internalServiceTokens: ['synthetic-a-service', 'synthetic-a-service-new'] }, applications[1]] },
    conversations: { storePath: conversations.storePath }, limits: { maxQuestionLength: 2000 },
    concurrency: { maxConcurrentAsk: 2, queueLimit: 10 }, rateLimit: { windowMs: 0, max: 0 } };
  const app = createApp({ config, conversationStore: conversations, imaWebAgentClient: { async *streamAsk() {
    calls++;
    yield { type: 'delta', text: 'synthetic answer' }; yield { type: 'done' };
  } } });
  t.after(() => app.locals.durableQATasks.close());
  const request = await listen(t, app);
  const post = { method: 'POST', headers: { 'Idempotency-Key': 'shared-legacy-key' }, body: JSON.stringify({ question: 'synthetic question' }) };
  const a = await request('/internal/provider-a/deep-ask', 'synthetic-a-service', post);
  assert.equal(a.status, 200);
  const first = await a.json();
  const b = await request('/internal/provider-a/deep-ask', 'synthetic-b-service', post);
  assert.equal(b.status, 200);
  const second = await b.json();
  assert.notEqual(first.conversationId, second.conversationId);
  const replay = await request('/internal/provider-a/deep-ask', 'synthetic-a-service-new', post);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).conversationId, first.conversationId);
  assert.equal(calls, 2);
  assert.equal((await request(`/api/conversations/${first.conversationId}`, 'synthetic-a-new')).status, 200);
  assert.equal((await request(`/api/conversations/${first.conversationId}`, 'synthetic-b')).status, 404);
});

test('mapped durable HTTP isolation, rotation and scheduler identity with companion executor',
  { skip: process.env.PROVIDER_IDENTITY_INTEGRATION !== '1' }, async t => {
    const dir = directory(t);
    const conversations = new ConversationStore({ storePath: path.join(dir, 'history.json') });
    let calls = 0;
    const config = { qaProvider: 'ima-web-agent', security, mimo: {}, webAgent: {},
      conversations: { storePath: conversations.storePath }, limits: { maxQuestionLength: 2000 },
      concurrency: { maxConcurrentAsk: 2, queueLimit: 10 }, rateLimit: { windowMs: 0, max: 0 } };
    const app = createApp({ config, conversationStore: conversations, imaWebAgentClient: { async *streamAsk(args) {
      calls++;
      args.onDispatch();
      yield { type: 'delta', text: 'synthetic answer' }; yield { type: 'done' };
    } } });
    t.after(() => app.locals.durableQATasks.close());
    const request = await listen(t, app);
    const manager = app.locals.durableQATasks;
    const schedulerKeys = [];
    const original = app.locals.imaQaAskQueue.run.bind(app.locals.imaQaAskQueue);
    app.locals.imaQaAskQueue.run = (work, keys) => { schedulerKeys.push(keys); return original(work, keys); };
    const create = async token => (await (await request('/api/conversations', token, { method: 'POST' })).json()).conversation.conversationId;
    const conversationA = await create('synthetic-a-old');
    const conversationB = await create('synthetic-b');
    const post = id => ({ method: 'POST', headers: { 'Idempotency-Key': 'identical-client-request', 'x-application-id': 'website-b' },
      body: JSON.stringify({ question: 'synthetic question', conversationId: id, applicationKey: 'application:website-b' }) });
    const a = await (await request('/api/tasks', 'synthetic-a-old', post(conversationA))).json();
    const b = await (await request('/api/tasks', 'synthetic-b', post(conversationB))).json();
    await settled(() => app.locals.imaQaAskQueue.stats().activeRequests === 0);
    assert.notEqual(a.task.id, b.task.id);
    assert.equal(manager.store.tasks.get(a.task.id).applicationKey, 'application:website-a');
    assert.equal(manager.store.tasks.get(b.task.id).applicationKey, 'application:website-b');
    assert.deepEqual(schedulerKeys.map(keys => keys.applicationKey), ['application:website-a', 'application:website-b']);
    const replay = await request('/api/tasks', 'synthetic-a-new', post(conversationA));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).task.id, a.task.id);
    assert.equal(calls, 2);
    for (const [url, method] of [[`/api/tasks/${a.task.id}`, 'GET'], [`/api/tasks/${a.task.id}`, 'DELETE'],
      [`/api/tasks/${a.task.id}/events`, 'GET']]) {
      assert.equal((await request(url, 'synthetic-b', { method })).status, 404);
    }
    assert.equal((await request('/api/tasks', 'synthetic-b', post(conversationA))).status, 409);
    assert.equal((await request('/api/tasks', 'synthetic-b', { ...post(conversationA), headers: { 'Idempotency-Key': 'different-key' } })).status, 404);
    assert.equal((await (await request('/api/tasks', 'synthetic-a-new')).json()).tasks.length, 1);
    assert.equal((await request(`/api/tasks/${a.task.id}/events`, 'synthetic-a-new')).status, 200);
    const internal = await request('/internal/provider-a/tasks', 'synthetic-a-service', { ...post(conversationA), headers: { 'Idempotency-Key': 'internal-key' } });
    assert.equal(internal.status, 202);
    const internalTask = (await internal.json()).task;
    await settled(() => app.locals.imaQaAskQueue.stats().activeRequests === 0);
    assert.equal((await request(`/internal/provider-a/tasks/${internalTask.id}`, 'synthetic-b-service')).status, 404);
    assert.equal((await request(`/api/tasks/${internalTask.id}`, 'synthetic-a-new')).status, 404);
    assert.equal((await request(`/internal/provider-a/tasks/${internalTask.id}`, 'synthetic-a-service', { method: 'DELETE' })).status, 200);
    assert.equal(calls, 3);
    assert.equal(schedulerKeys[2].applicationKey, 'application:website-a');
  });
