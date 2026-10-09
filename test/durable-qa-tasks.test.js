const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');
const { DurableQATaskStore } = require('../src/durable-qa-store');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { createAskQueue } = require('../src/ask-queue');

const owner = 'synthetic-owner';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(5); }
  assert.fail('condition did not settle');
}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-qa-test-'));
  const conversationStore = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const conversationId = conversationStore.create(owner, { mode: 'knowledge_agent' }).conversationId;
  const calls = [];
  const config = {
    qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
    conversations: { storePath: conversationStore.storePath },
    security: { apiToken: 'synthetic-api', internalServiceToken: 'synthetic-service' },
    concurrency: { maxConcurrentAsk: 1, queueLimit: 10, requestTimeoutMs: 1 },
    limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 },
    ...options.config,
  };
  const app = createApp({ config, conversationStore, webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent' }) },
    imaWebAgentClient: { async *streamAsk(args) {
      calls.push(args);
      args.onDispatch?.();
      if (options.stream) { yield* options.stream(args); return; }
      yield { type: 'process', text: 'Searching' };
      yield { type: 'delta', text: '  Synthetic\n\nanswer  \n' };
      yield { type: 'done' };
    } },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, init = {}, identity = owner, token = 'synthetic-api') => fetch(base + url, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-ima-client-id': identity, ...init.headers },
  });
  const submit = (key = 'synthetic-task', body = {}, route = '/api/tasks', token) => request(route, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ question: '  Synthetic question\n', conversationId, ...body }),
  }, owner, token);
  t.after(async () => {
    await app.locals.durableQATasks?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, app, config, calls, request, submit, conversationId, conversationStore };
}

test('durable API authenticates, isolates owners and validates internal-only fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/tasks', {}, owner, 'wrong')).status, 401);
  assert.equal((await f.request('/internal/provider-a/tasks')).status, 401);
  assert.equal((await f.submit('')).status, 400);
  assert.equal((await f.submit('key', { conversationId: '' })).status, 400);
  assert.equal((await f.submit('key', { question: { text: 'no' } })).status, 400);
  assert.equal((await f.submit('key', { source_intent: 'web_requested' })).status, 400);
  assert.equal((await f.submit('key', { conversationId: crypto.randomUUID() })).status, 404);
  const posted = await (await f.submit()).json();
  assert.equal((await f.request(`/api/tasks/${posted.task.id}`, {}, 'other')).status, 404);
  assert.deepEqual(await (await f.request('/api/tasks', {}, 'other')).json(), { tasks: [] });
  assert.equal((await f.request(`/api/tasks/${posted.task.id}`, { method: 'DELETE' }, 'other')).status, 404);
  assert.equal((await f.request(`/api/tasks/${posted.task.id}/events`, {}, 'other')).status, 404);
});

test('idempotent POST runs once, snapshots/SSE retain whitespace and cursor is strict', async t => {
  const f = await fixture(t);
  const response = await f.submit();
  assert.equal(response.status, 202);
  const { task } = await response.json();
  await until(async () => (await (await f.request(`/api/tasks/${task.id}`)).json()).task.status === 'succeeded');
  const repeated = await (await f.submit()).json();
  assert.equal(repeated.task.id, task.id);
  assert.equal(repeated.task.requestKey, crypto.createHash('sha256').update('synthetic-task').digest('hex'));
  assert.ok(repeated.task.trace.dispatchedAt >= repeated.task.trace.receivedAt);
  assert.ok(repeated.task.trace.lastUpstreamActivityAt >= repeated.task.trace.firstUpstreamEventAt);
  assert.equal((await f.submit('synthetic-task', { question: 'different' })).status, 409);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].question, '  Synthetic question\n');
  assert.deepEqual(f.calls[0].transportTimeouts, { headersMs: 60000, idleMs: 600000 });
  assert.equal(f.calls[0].signal.aborted, false);
  const result = await (await f.request(`/api/tasks/${task.id}`)).json();
  assert.equal(result.snapshot.events.map(e => e.event).includes('process'), true);
  assert.equal(result.snapshot.events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), '  Synthetic\n\nanswer  \n');
  assert.equal(result.snapshot.events.filter(e => e.event === 'done').length, 1);
  assert.deepEqual(result.snapshot.events.map(e => e.id), result.snapshot.events.map((_, i) => i + 1));
  const history = f.conversationStore.getHistory(f.conversationId, owner);
  assert.equal(history.length, 2);
  assert.equal(history[0].content, '  Synthetic question\n');
  assert.equal(history[1].content, '  Synthetic\n\nanswer  \n');
  const last = result.task.lastEventId;
  for (const cursor of ['-1', '1.2', 'abc', '1e2', '01', '1&after=2']) {
    assert.equal((await f.request(`/api/tasks/${task.id}/events?after=${cursor}`)).status, 400);
  }
  assert.equal((await f.request(`/api/tasks/${task.id}/events?after=${last + 1}`)).status, 409);
  const replay = await (await f.request(`/api/tasks/${task.id}/events?after=2`)).text();
  assert.deepEqual([...replay.matchAll(/^id: (\d+)$/gm)].map(m => +m[1]), result.snapshot.events.slice(2).map(e => e.id));
  assert.equal(await (await f.request(`/api/tasks/${task.id}/events?after=${last}`)).text(), '');
  const capacity = await (await f.request('/internal/provider-a/capacity', {}, owner, 'synthetic-service')).json();
  assert.equal(capacity.features.durable_qa_tasks_v1, true);
  assert.deepEqual(await (await f.request('/api/capabilities')).json(), { schemaVersion: 1, features: { durable_qa_tasks_v1: true } });
  assert.equal((await f.request('/api/capabilities', {}, owner, 'wrong')).status, 401);
});

test('hashed BFF request key is returned unchanged and supports owned correlation filters', async t => {
  const f = await fixture(t);
  const key = crypto.createHash('sha256').update('demo:tasks:v1:synthetic-owner:synthetic-request').digest('hex');
  const { task } = await (await f.submit(key)).json();
  assert.equal(task.requestKey, key);
  assert.equal((await (await f.request(`/api/tasks?requestKey=${key}&conversationId=${f.conversationId}`)).json()).tasks[0].id, task.id);
  assert.deepEqual((await (await f.request(`/api/tasks?requestKey=${key}`, {}, 'other')).json()).tasks, []);
  assert.deepEqual((await (await f.request(`/api/tasks?conversationId=${crypto.randomUUID()}`)).json()).tasks, []);
  assert.equal((await f.request('/api/tasks?requestKey=not-a-hash')).status, 400);
});

test('internal native contract is persisted and ordinary token cannot read internal tasks', async t => {
  const f = await fixture(t);
  const body = { retrieval_policy: 'knowledge_agent', knowledge_scope_ref: crypto.createHash('sha256').update('synthetic-kb').digest('hex'), source_intent: 'web_requested' };
  const response = await f.submit('internal-key', body, '/internal/provider-a/tasks', 'synthetic-service');
  assert.equal(response.status, 202);
  const { task } = await response.json();
  await until(() => f.calls.length === 1);
  assert.match(f.calls[0].question, /^  Synthetic question\n\n\n/);
  assert.equal(f.calls[0].mode, 'knowledge_agent');
  assert.equal((await f.request(`/api/tasks/${task.id}`)).status, 404);
  assert.equal((await f.request(`/internal/provider-a/tasks/${task.id}`, {}, owner, 'synthetic-service')).status, 200);
});

test('disconnect does not cancel; DELETE aborts only explicitly and prevents history', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async *stream() { yield { type: 'delta', text: 'partial' }; await gate; yield { type: 'done' }; } });
  const { task } = await (await f.submit()).json();
  await until(() => f.calls.length === 1);
  const stream = await f.request(`/api/tasks/${task.id}/events`);
  await stream.body.cancel();
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal((await f.request(`/api/tasks/${task.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(f.calls[0].signal.aborted, true);
  release();
  await until(() => f.app.locals.imaQaAskQueue.stats().activeRequests === 0);
  const result = await (await f.request(`/api/tasks/${task.id}`)).json();
  assert.equal(result.task.status, 'cancelled');
  assert.equal(result.snapshot.events.filter(e => e.event === 'error').length, 1);
  assert.equal(result.snapshot.events.some(e => e.event === 'done'), false);
  assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 0);
});

test('writer lock, atomic failed writes, private modes, terminal retention and bounded admission', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-store-test-'));
  let now = 1000;
  const store = new DurableQATaskStore({ directory: dir, now: () => now, maxTasks: 1 });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => new DurableQATaskStore({ directory: dir }), /task_store_unavailable/);
  const input = { question: 'synthetic', conversationId: 'synthetic-conversation' };
  const task = store.create({ ownerKey: owner, scope: 'ordinary', key: 'synthetic', input }).task;
  assert.equal(fs.statSync(path.join(dir, `${task.id}.json`)).mode & 0o777, 0o600);
  assert.equal(store.create({ ownerKey: owner, scope: 'ordinary', key: 'synthetic', input }).isNew, false);
  assert.throws(() => store.create({ ownerKey: owner, scope: 'ordinary', key: 'new', input }), /task_capacity/);
  store.finish(task.id, 'failed', { error: 'synthetic failure' });
  now += 24 * 60 * 60 * 1000 + 1;
  store.prune();
  const receipt = store.list(owner, 'ordinary')[0];
  assert.equal(receipt.eventsExpired, true);
  assert.equal(store.tasks.get(task.id).events.length, 0);
  assert.deepEqual(store.tasks.get(task.id).input, { conversationId: input.conversationId });
  assert.equal(store.create({ ownerKey: owner, scope: 'ordinary', key: 'synthetic', input }).isNew, false);
  assert.throws(() => store.create({ ownerKey: owner, scope: 'ordinary', key: 'synthetic', input: { ...input, question: 'changed' } }), /idempotency_conflict/);
});

test('history task receipt survives reload and turn trimming; failed history persistence rolls back memory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-history-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'history.json');
  let now = Date.now();
  const store = new ConversationStore({ storePath, maxTurns: 1, now: () => now });
  const id = store.create(owner).conversationId;
  store.appendTaskTurn(id, 'task-1', '  question\n', ' answer\n', {}, owner);
  now += 72 * 60 * 60 * 1000;
  store.appendTaskTurn(id, 'task-2', 'q2', 'a2', {}, owner);
  const reload = new ConversationStore({ storePath, maxTurns: 1, now: () => now });
  reload.appendTaskTurn(id, 'task-1', '  question\n', ' answer\n', {}, owner);
  assert.deepEqual(reload.getHistory(id, owner), [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
  const write = reload._write;
  reload._write = () => { throw new Error('synthetic disk failure'); };
  assert.throws(() => reload.appendTaskTurn(id, 'task-3', 'q3', 'a3', {}, owner));
  reload._write = write;
  assert.equal(reload.getHistory(id, owner)[0].content, 'q2');
});

test('full queue rejects before persistence; queued cancellation never calls upstream', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { config: { concurrency: { maxConcurrentAsk: 1, queueLimit: 1 } },
    async *stream() { await gate; yield { type: 'delta', text: 'synthetic' }; yield { type: 'done' }; } });
  const secondConversation = f.conversationStore.create(owner, { mode: 'knowledge_agent' }).conversationId;
  const thirdConversation = f.conversationStore.create(owner, { mode: 'knowledge_agent' }).conversationId;
  const first = await (await f.submit()).json();
  const second = await (await f.submit('second', { conversationId: secondConversation })).json();
  const rejected = await f.submit('third', { conversationId: thirdConversation });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).failureReason, 'queue_full');
  assert.equal((await (await f.request('/api/tasks')).json()).tasks.length, 2);
  assert.equal((await f.submit()).status, 200);
  assert.equal((await f.request(`/api/conversations/${f.conversationId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await f.request(`/api/tasks/${second.task.id}`, { method: 'DELETE' })).status, 200);
  release();
  await until(async () => (await (await f.request(`/api/tasks/${first.task.id}`)).json()).task.status === 'succeeded');
  assert.equal(f.calls.length, 1);
  assert.equal(f.conversationStore.getHistory(secondConversation, owner).length, 0);
});

test('heartbeat and rotation release subscribers without cancelling work', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async *stream() { await gate; yield { type: 'delta', text: 'synthetic' }; yield { type: 'done' }; } });
  f.app.locals.durableQATasks.heartbeatMs = 5;
  f.app.locals.durableQATasks.rotationMs = 30;
  const { task } = await (await f.submit()).json();
  const stream = await (await f.request(`/api/tasks/${task.id}/events`)).text();
  assert.match(stream, /: heartbeat/);
  assert.equal(f.calls[0].signal.aborted, false);
  const state = await (await f.request(`/api/tasks/${task.id}`)).json();
  assert.equal(state.task.trace.rotations, 1);
  assert.equal(f.app.locals.durableQATasks.subscribers.size, 0);
  release();
});

test('zero or duplicate success markers never commit a history turn', async t => {
  for (const markers of [0, 2]) {
    const f = await fixture(t, { async *stream() { yield { type: 'delta', text: 'synthetic partial' }; for (let i = 0; i < markers; i++) yield { type: 'done' }; } });
    const { task } = await (await f.submit()).json();
    await until(async () => (await (await f.request(`/api/tasks/${task.id}`)).json()).task.status === 'failed');
    const state = await (await f.request(`/api/tasks/${task.id}`)).json();
    assert.equal(state.snapshot.events.filter(e => e.event === 'error').length, 1);
    assert.equal(state.snapshot.events.some(e => e.event === 'done'), false);
    assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 0);
  }
});

test('POST persistence failure never acknowledges, starts work or retains a memory-only task', async t => {
  const f = await fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target.startsWith(f.app.locals.durableQATasks.store.directory)) throw Object.assign(new Error('synthetic'), { code: 'ENOSPC' });
    return rename(source, target);
  };
  try {
    const response = await f.submit();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'task_store_unavailable');
    assert.equal(f.calls.length, 0);
    assert.equal(f.app.locals.durableQATasks.store.tasks.size, 0);
    assert.equal(f.conversationStore.require(f.conversationId, owner).activeRequest, false);
  } finally { fs.renameSync = rename; }
});

test('history fault preserves completion journal and recovery completes exactly once without upstream', async t => {
  const f = await fixture(t);
  const write = f.conversationStore._write;
  f.conversationStore._write = () => { throw new Error('synthetic history disk failure'); };
  const { task } = await (await f.submit()).json();
  await until(() => !f.app.locals.durableQATasks.available);
  const file = path.join(f.app.locals.durableQATasks.store.directory, `${task.id}.json`);
  assert.ok(JSON.parse(fs.readFileSync(file)).completion);
  assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 0);
  f.conversationStore._write = write;
  f.app.locals.durableQATasks.close();
  let executions = 0;
  for (let cycle = 0; cycle < 2; cycle++) {
    const conversations = new ConversationStore({ storePath: f.conversationStore.storePath });
    const recovered = new DurableQATasks({ directory: path.dirname(file), conversations, queue: createAskQueue({}), execute: () => { executions++; } });
    assert.equal(recovered.store.tasks.get(task.id).status, 'succeeded');
    assert.equal(conversations.getHistory(f.conversationId, owner).length, 2);
    recovered.close();
  }
  assert.equal(executions, 0);
  assert.equal(f.calls.length, 1);
});

test('recovery resumes queued work, marks running indeterminate and replays an already-applied journal once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'history.json');
  const directory = path.join(dir, 'tasks');
  const conversations = new ConversationStore({ storePath });
  const store = new DurableQATaskStore({ directory });
  const seed = key => store.create({ ownerKey: owner, scope: 'ordinary', key, input: {
    conversationId: conversations.create(owner).conversationId, question: 'synthetic question',
  } }).task;
  const queued = seed('queued');
  const running = seed('running');
  store.running(running.id);
  const complete = seed('complete');
  store.running(complete.id);
  const completion = { question: 'synthetic question', answer: 'synthetic answer', metadata: {}, upstream: {}, done: { conversationId: complete.input.conversationId } };
  store.journal(complete.id, completion);
  conversations.appendTaskTurn(complete.input.conversationId, complete.id, completion.question, completion.answer, {}, owner);
  store.close();
  const executions = [];
  const manager = new DurableQATasks({ directory, conversations: new ConversationStore({ storePath }), queue: createAskQueue({ queueLimit: 10 }),
    async execute({ task, conversationStore, res, onDispatch }) {
      executions.push(task.id);
      onDispatch();
      conversationStore.appendTurn(task.input.conversationId, task.input.question, 'synthetic resumed answer', {});
      res.write('event: done\ndata: {}\n\n');
      res.end();
    },
  });
  t.after(() => manager.close());
  await until(() => manager.store.tasks.get(queued.id).status === 'succeeded');
  assert.deepEqual(executions, [queued.id]);
  const interrupted = manager.store.tasks.get(running.id);
  assert.equal(interrupted.status, 'indeterminate');
  assert.equal(interrupted.events.filter(e => e.event === 'error').length, 1);
  assert.equal(manager.store.tasks.get(complete.id).status, 'succeeded');
  assert.equal(manager.conversations.getHistory(complete.input.conversationId, owner).length, 2);
});

test('event write failure is not published and restart does not repeat dispatched work', async t => {
  const f = await fixture(t, { async *stream() {
    yield { type: 'delta', text: 'durable-prefix' };
    const store = f.app.locals.durableQATasks.store;
    const previous = store.directory;
    store.directory = path.join(previous, 'missing-parent');
    yield { type: 'delta', text: 'must-not-publish' };
  } });
  const { task } = await (await f.submit()).json();
  await until(() => !f.app.locals.durableQATasks.available);
  const directory = `${f.conversationStore.storePath}.tasks`;
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, `${task.id}.json`)));
  assert.equal(JSON.stringify(persisted.events).includes('must-not-publish'), false);
  f.app.locals.durableQATasks.close();
  const recovered = new DurableQATasks({ directory, conversations: f.conversationStore, queue: createAskQueue({}), execute: () => assert.fail('must not retry') });
  assert.equal(recovered.store.tasks.get(task.id).status, 'indeterminate');
  assert.equal(f.calls.length, 1);
  recovered.close();
});

test('retained receipts survive restart and expired events return history pointer without re-ask', async t => {
  const f = await fixture(t);
  const { task } = await (await f.submit()).json();
  await until(async () => (await (await f.request(`/api/tasks/${task.id}`)).json()).task.status === 'succeeded');
  const store = f.app.locals.durableQATasks.store;
  const lastEventId = store.tasks.get(task.id).events.length;
  store.now = () => Date.now() + 25 * 60 * 60 * 1000;
  store.prune();
  const status = await (await f.request(`/api/tasks/${task.id}`)).json();
  assert.equal(status.task.lastEventId, lastEventId);
  assert.equal(status.snapshot.eventsExpired, true);
  assert.equal(status.snapshot.history.taskId, task.id);
  assert.deepEqual(status.snapshot.events, []);
  assert.equal((await f.request(`/api/tasks/${task.id}/events?after=0`)).status, 410);
  assert.equal((await f.request(`/api/tasks/${task.id}/events?after=${lastEventId + 1}`)).status, 409);
  assert.equal((await f.submit()).status, 200);
  assert.equal(f.calls.length, 1);
  f.app.locals.durableQATasks.close();
  const reloaded = new DurableQATaskStore({ directory: store.directory });
  const previous = reloaded.tasks.get(task.id);
  assert.equal(reloaded.find(owner, 'ordinary', 'synthetic-task', { question: '  Synthetic question\n', conversationId: f.conversationId,
    retrieval_policy: '', knowledge_scope_ref: '', source_intent: '' }).id, previous.id);
  assert.equal(previous.eventsExpired, true);
  assert.equal(f.conversationStore.getDetail(f.conversationId, owner).messages[1].taskId, task.id);
  reloaded.close();
});

test('malformed bodies are safe and capability fails closed on unavailable storage', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/tasks', { method: 'POST', body: '{"question":"synthetic-private-content"' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_task_request' });
  f.app.locals.durableQATasks.store.unavailable();
  const capacity = await (await f.request('/api/capabilities')).json();
  assert.equal(capacity.features.durable_qa_tasks_v1, false);
  assert.equal((await f.submit()).status, 503);
});

test('same-conversation tasks queue serially; cancelling queued work cannot release active lane',
  { skip: typeof createAskQueue({}).canAccept !== 'function' }, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { config: { concurrency: { maxConcurrentAsk: 2, queueLimit: 1 } },
      async *stream() { await gate; yield { type: 'delta', text: 'synthetic answer' }; yield { type: 'done' }; } });
    const first = await (await f.submit('first')).json();
    const secondResponse = await f.submit('second');
    assert.equal(secondResponse.status, 202);
    const second = await secondResponse.json();
    assert.equal(second.task.status, 'queued');
    assert.equal(f.calls.length, 1);
    const third = await f.submit('third');
    assert.equal(third.status, 429);
    assert.equal((await third.json()).failureReason, 'queue_full');
    assert.equal((await f.request(`/api/tasks/${second.task.id}`, { method: 'DELETE' })).status, 200);
    await pause(10);
    assert.equal(f.conversationStore.require(f.conversationId, owner).activeRequest, true);
    const next = await f.submit('next');
    assert.equal(next.status, 202);
    release();
    const nextTask = (await next.json()).task;
    await until(async () => (await (await f.request(`/api/tasks/${nextTask.id}`)).json()).task.status === 'succeeded');
    assert.equal((await (await f.request(`/api/tasks/${first.task.id}`)).json()).task.status, 'succeeded');
    assert.equal(f.calls.length, 2);
    assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 4);
  });

test('resource exhaustion emits a durable failure without unbounded pending whitespace', async t => {
  const f = await fixture(t, { async *stream() { yield { type: 'delta', text: ' '.repeat(2048) }; yield { type: 'done' }; } });
  f.app.locals.durableQATasks.store.maxTaskBytes = 1800;
  const { task } = await (await f.submit()).json();
  await until(async () => (await (await f.request(`/api/tasks/${task.id}`)).json()).task.status === 'failed');
  assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 0);
});

test('archive export redacts task receipts and IDs without changing native answer whitespace', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const identity = '11111111-1111-4111-8111-111111111111';
  const id = store.create(identity).conversationId;
  store.appendTaskTurn(id, 'synthetic-task-id', '  question\n', '  answer\n', {}, identity);
  const raw = JSON.parse(fs.readFileSync(store.storePath, 'utf8'));
  const { exportHistory } = require('../src/account-transfer');
  const archive = exportHistory(raw);
  assert.equal(archive.conversations[0].turns[0].answer, '  answer\n');
  assert.doesNotMatch(JSON.stringify(archive), /synthetic-task-id|taskId|completedTasks/);
});

test('failed first task durably binds upstream affinity for the next question and process restart', async t => {
  let count = 0;
  const f = await fixture(t, { async *stream(args) {
    count++;
    if (count === 1) {
      yield { type: 'route', accountId: 'synthetic-account-a' };
      args.onSession('synthetic-session-a');
      yield { type: 'delta', text: 'partial' };
      throw new Error('synthetic upstream failure');
    }
    assert.equal(args.accountId, 'synthetic-account-a');
    assert.equal(args.sessionId, 'synthetic-session-a');
    yield { type: 'delta', text: 'follow-up' };
    yield { type: 'done' };
  } });
  const first = (await (await f.submit('first')).json()).task;
  await until(async () => (await (await f.request(`/api/tasks/${first.id}`)).json()).task.status === 'failed');
  const reload = new ConversationStore({ storePath: f.conversationStore.storePath });
  assert.equal(reload.getUpstream(f.conversationId, owner).sessionId, 'synthetic-session-a');
  const second = (await (await f.submit('second')).json()).task;
  await until(async () => (await (await f.request(`/api/tasks/${second.id}`)).json()).task.status === 'succeeded');
  assert.equal(count, 2);
  assert.equal(f.conversationStore.getHistory(f.conversationId, owner).length, 2);
});

test('account slot settings survive encrypted directory reload, replacement and startup seed', t => {
  const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
  const { seedAccountDirectory } = require('../provider-a-server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-account-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { storePath: path.join(dir, 'accounts.json'), keyPath: path.join(dir, 'accounts.key') };
  const directory = new WebAgentAccountDirectory(options);
  const account = { id: 'synthetic-account', name: 'synthetic-account', knowledgeBaseId: 'synthetic-kb',
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic' }, maxConcurrent: 3 };
  seedAccountDirectory(directory, [account]);
  const reload = new WebAgentAccountDirectory(options);
  assert.equal(reload.getPoolAccounts()[0].maxConcurrent, 3);
  reload.upsertCapturedAccount({ ...account, maxConcurrent: undefined, replace: true });
  assert.equal(reload.getPoolAccounts()[0].maxConcurrent, 3);
  seedAccountDirectory(reload, [{ ...account, maxConcurrent: 5 }]);
  assert.equal(new WebAgentAccountDirectory(options).getPoolAccounts()[0].maxConcurrent, 5);
  assert.throws(() => reload.setMaxConcurrent(account.id, 0));
});

test('binding journal repairs history after a binding write fault without repeating upstream', async t => {
  const f = await fixture(t, { async *stream(args) {
    yield { type: 'route', accountId: 'synthetic-bound-account' };
    args.onSession('synthetic-bound-session');
    yield { type: 'done' };
  } });
  const original = f.conversationStore.bindTaskUpstream;
  f.conversationStore.bindTaskUpstream = () => { throw new Error('synthetic disk failure'); };
  const { task } = await (await f.submit()).json();
  await until(() => !f.app.locals.durableQATasks.available);
  const directory = f.app.locals.durableQATasks.store.directory;
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, `${task.id}.json`))).bindingPending, true);
  f.app.locals.durableQATasks.close();
  f.conversationStore.bindTaskUpstream = original;
  const conversations = new ConversationStore({ storePath: f.conversationStore.storePath });
  const recovered = new DurableQATasks({ directory, conversations, queue: createAskQueue({}), execute: () => assert.fail('must not retry dispatched task') });
  assert.equal(recovered.store.tasks.get(task.id).status, 'indeterminate');
  assert.equal(conversations.getUpstream(f.conversationId, owner).accountId, 'synthetic-bound-account');
  assert.equal(conversations.getHistory(f.conversationId, owner).length, 0);
  recovered.close();
});
