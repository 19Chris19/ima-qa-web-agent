const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('pinned waiters do not take global slots and retain original session/account', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b' }] }, {
    clientFactory: account => ({ async *streamAsk(options) {
      yield { type: 'delta', text: `${account.id}:${options.sessionId}` };
      yield { type: 'done' };
    } }),
  });
  const queue = createAskQueue({ maxConcurrent: 2, queueLimit: 10 });
  const unsubscribe = pool.onAvailability(() => queue.wake());
  const hold = gate();
  const options = accountId => ({
    applicationKey: 'synthetic-app', visitorKey: accountId, laneKey: accountId,
    isRunnable: () => pool.canAcquireSlot({ accountId }),
    tryAcquire: () => pool.tryAcquireSlot({ accountId }),
  });
  const first = queue.run(() => hold.promise, options('a'));
  const seen = [];
  const pinned = queue.run(async lease => {
    for await (const event of pool.streamAsk({ accountId: 'a', sessionId: 'original', accountLease: lease })) {
      if (event.type === 'delta') seen.push(event.text);
    }
  }, { ...options('a'), laneKey: 'second' });
  await tick();
  assert.equal(queue.stats().activeRequests, 1);
  assert.equal(queue.stats().queuedRequests, 1);
  assert.equal(pool.stats().activeRequests, 1);
  await queue.run(async lease => {
    for await (const event of pool.streamAsk({ accountId: 'b', sessionId: 'other', accountLease: lease })) {
      if (event.type === 'delta') seen.push(event.text);
    }
  }, options('b'));
  assert.deepEqual(seen, ['b:other']);
  hold.resolve();
  await Promise.all([first, pinned]);
  await tick();
  assert.deepEqual(seen, ['b:other', 'a:original']);
  assert.equal(pool.stats().activeRequests, 0);
  assert.equal(queue.stats().activeRequests, 0);
  unsubscribe();
});

test('a reserved slot is released if cancellation happens before execution', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }] });
  const queue = createAskQueue({ maxConcurrent: 1, queueLimit: 1 });
  const controller = new AbortController();
  const task = queue.run(() => assert.fail('cancelled execution'), {
    signal: controller.signal, tryAcquire: () => pool.tryAcquireSlot({ accountId: 'a' }),
  });
  assert.equal(pool.stats().activeRequests, 1);
  controller.abort();
  await assert.rejects(task, { name: 'RequestAbortedError' });
  await tick();
  assert.equal(pool.stats().activeRequests, 0);
  assert.equal(queue.stats().activeRequests, 0);
});

test('capacity callbacks during reservation cannot reenter selection or exceed slots', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 4 });
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b' }] }, {
    onAccountStateChange() { queue.updateLimits({ maxConcurrent: 1 }); },
  });
  queue.setMaxConcurrent(0);
  const hold = gate();
  let maxActive = 0;
  let dispatched = 0;
  const jobs = Array.from({ length: 3 }, () => queue.run(async () => {
    dispatched++;
    maxActive = Math.max(maxActive, queue.stats().activeRequests);
    await hold.promise;
  }, { isRunnable: () => pool.canAcquireSlot(), tryAcquire: () => pool.tryAcquireSlot() }));
  queue.setMaxConcurrent(1);
  await tick();
  assert.equal(dispatched, 1);
  assert.equal(queue.stats().activeRequests, 1);
  assert.equal(pool.stats().activeRequests, 1);
  hold.resolve();
  await Promise.all(jobs);
  await tick();
  assert.equal(maxActive, 1);
  assert.equal(pool.stats().activeRequests, 0);
});

test('blocked resource heads preserve lane FIFO while other lanes remain runnable', async () => {
  const queue = createAskQueue({ maxConcurrent: 1, queueLimit: 4 });
  let ready = false;
  const order = [];
  const blocked = { applicationKey: 'a', visitorKey: 'one', laneKey: 'same',
    isRunnable: () => ready, tryAcquire: () => ready ? { value: 'lease', release() {} } : null };
  const first = queue.run(() => order.push('first'), blocked);
  const second = queue.run(() => order.push('second'), { ...blocked, tryAcquire: () => ({ release() {} }) });
  await queue.run(() => order.push('other'), { applicationKey: 'a', visitorKey: 'one', laneKey: 'other' });
  assert.deepEqual(order, ['other']);
  ready = true;
  queue.wake();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['other', 'first', 'second']);
});

test('leases cannot be reused, forged or silently moved to another account', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b' }] }, {
    clientFactory: () => ({ async *streamAsk() { yield { type: 'done' }; } }),
  });
  const reservation = pool.tryAcquireSlot({ accountId: 'a' });
  await assert.rejects(async () => {
    for await (const event of pool.streamAsk({ accountId: 'b', accountLease: reservation.value })) void event;
  }, /lease/i);
  reservation.release();
  reservation.release();
  assert.equal(pool.stats().activeRequests, 0);
  await assert.rejects(async () => {
    for await (const event of pool.streamAsk({ accountLease: {} })) void event;
  }, /lease/i);
});

test('reservation persistence failure rolls back occupancy and release failure does not strand the queue', async () => {
  let fail = false;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }] }, {
    onAccountStateChange() { if (fail) throw new Error('synthetic persistence failure'); },
  });
  fail = true;
  assert.throws(() => pool.tryAcquireSlot(), /persistence/);
  assert.equal(pool.stats().activeRequests, 0);
  fail = false;
  const queue = createAskQueue({ maxConcurrent: 1, queueLimit: 2 });
  const hold = gate();
  const first = queue.run(() => hold.promise, { tryAcquire: () => ({ release() { throw new Error('synthetic cleanup'); } }) });
  const second = queue.run(() => 'next');
  hold.resolve();
  assert.equal(await second, 'next');
  await first; await tick();
  assert.equal(queue.stats().queuedRequests, 0);
  assert.equal(queue.stats().activeRequests, 0);
  assert.equal(queue.stats().resourceReleaseErrors, 1);
});

test('a rejected head immediately unblocks the next entry in its lane', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 3 });
  const options = { applicationKey: 'a', visitorKey: 'v', laneKey: 'session' };
  const first = queue.run(() => assert.fail('invalid account dispatch'), {
    ...options, tryAcquire() { throw new Error('synthetic invalid account'); },
  });
  const rejected = assert.rejects(first, /invalid account/);
  const second = queue.run(() => 'next', options);
  queue.setMaxConcurrent(1);
  assert.equal(await second, 'next');
  await rejected;
});

test('a synchronous wake during a failed acquisition is replayed after selection', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 3 });
  let ready = false;
  const first = queue.run(() => 'awakened', { isRunnable: () => ready, applicationKey: 'a' });
  const controller = new AbortController();
  let notified = false;
  const second = queue.run(() => assert.fail('unavailable'), { signal: controller.signal, applicationKey: 'b', tryAcquire() {
    if (!notified) { notified = true; ready = true; queue.wake(); }
    return null;
  } });
  const cancelled = assert.rejects(second, { name: 'RequestAbortedError' });
  queue.setMaxConcurrent(1);
  assert.equal(await first, 'awakened');
  controller.abort(); await cancelled;
});

test('maintenance is temporary and account state changes wake selection', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }] });
  const account = pool.accounts[0];
  pool.webReadiness = item => !item.maintenanceOperation;
  account.maintenanceOperation = 'refresh';
  assert.equal(pool.canAcquireSlot({ accountId: 'a', mode: 'knowledge_agent' }), false);
  assert.equal(pool.canAcquireSlot({ mode: 'knowledge_agent' }), false);
  account.maintenanceOperation = '';
  let notifications = 0;
  pool.onAvailability(() => { notifications++; });
  pool.setAccountDisabled('a', true);
  pool.setAccountDisabled('a', false);
  assert.equal(notifications, 2);
  assert.equal(pool.canAcquireSlot({ accountId: 'a', mode: 'knowledge_agent' }), true);
});

test('durable HTTP tasks keep a blocked pinned follow-up queued while another account answers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnable-task-api-'));
  const history = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const owner = 'synthetic-owner';
  const conversations = ['first', 'pinned', 'other'].map(() => history.create(owner, { mode: 'knowledge_agent' }).conversationId);
  history.setUpstream(conversations[0], { accountId: 'a', sessionId: 'original-one' }, owner);
  history.setUpstream(conversations[1], { accountId: 'a', sessionId: 'original-two' }, owner);
  const hold = gate();
  const seen = [];
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b' }] }, {
    clientFactory: account => ({ async *streamAsk(options) {
      options.onDispatch();
      assert.equal(options.mode, 'knowledge_agent');
      seen.push({ account: account.id, session: options.sessionId, question: options.question });
      if (options.question === 'first') await hold.promise;
      yield { type: 'delta', text: `  ${options.question}\n` };
      yield { type: 'done' };
    } }),
  });
  pool.webReadiness = () => true;
  const app = createApp({ config: {
    qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
    conversations: { storePath: history.storePath }, concurrency: { maxConcurrentAsk: 2, queueLimit: 10 },
    security: { apiToken: 'synthetic-api' }, limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 },
  }, conversationStore: history, imaWebAgentClient: pool, webReadiness: { mode: 'knowledge_agent' } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    hold.resolve(); app.locals.durableQATasks.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  const submit = async (question, conversationId) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer synthetic-api',
        'x-ima-client-id': owner, 'Idempotency-Key': question }, body: JSON.stringify({ question, conversationId }),
    });
    assert.equal(response.status, 202); return (await response.json()).task.id;
  };
  const first = await submit('first', conversations[0]);
  const pinned = await submit('pinned', conversations[1]);
  assert.equal(app.locals.durableQATasks.store.tasks.get(pinned).status, 'queued');
  assert.equal(app.locals.imaQaAskQueue.stats().activeRequests, 1);
  const other = await submit('other', conversations[2]);
  for (let i = 0; i < 100 && app.locals.durableQATasks.store.tasks.get(other).status !== 'succeeded'; i++) await tick();
  assert.equal(app.locals.durableQATasks.store.tasks.get(other).status, 'succeeded');
  assert.equal(seen.find(row => row.question === 'other').account, 'b');
  assert.equal(app.locals.durableQATasks.store.tasks.get(pinned).status, 'queued');
  hold.resolve();
  for (let i = 0; i < 100 && app.locals.durableQATasks.store.tasks.get(pinned).status !== 'succeeded'; i++) await tick();
  assert.equal(app.locals.durableQATasks.store.tasks.get(first).status, 'succeeded');
  assert.equal(app.locals.durableQATasks.store.tasks.get(pinned).status, 'succeeded');
  assert.deepEqual(seen.find(row => row.question === 'pinned'), { account: 'a', session: 'original-two', question: 'pinned' });
  assert.equal(history.getHistory(conversations[1], owner)[1].content, '  pinned\n');
});
