const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('round robin applications then visitors; no slots reserved for idle tenants', async () => {
  const queue = createAskQueue({ maxConcurrent: 1, queueLimit: 20 });
  const hold = gate();
  const first = queue.run(() => hold.promise, { applicationKey: 'a', visitorKey: 'one' });
  const order = [];
  const jobs = [['a', 'one', 'a1'], ['a', 'one', 'a2'], ['a', 'two', 'a3'],
    ['b', 'one', 'b1'], ['b', 'one', 'b2']].map(([applicationKey, visitorKey, label]) =>
    queue.run(() => order.push(label), { applicationKey, visitorKey }));
  hold.resolve();
  await Promise.all([first, ...jobs]);
  await tick();
  assert.deepEqual(order, ['b1', 'a3', 'b2', 'a1', 'a2']);
  assert.equal(queue.stats().activeRequests, 0);
  queue.updateLimits({ maxConcurrent: 3 });
  const busy = gate();
  const burst = Array.from({ length: 3 }, () => queue.run(() => busy.promise, { applicationKey: 'a' }));
  assert.equal(queue.stats().activeRequests, 3);
  busy.resolve();
  await Promise.all(burst);
});

test('serial lanes skip blocked heads, are scoped by trusted app/visitor, and retain FIFO', async () => {
  const queue = createAskQueue({ maxConcurrent: 2, queueLimit: 2 });
  const hold = gate();
  const lane = { applicationKey: 'a', visitorKey: 'one', laneKey: 'session' };
  const first = queue.run(() => hold.promise, lane);
  const order = [];
  const second = queue.run(() => order.push('second'), lane);
  const third = queue.run(() => order.push('third'), lane);
  const other = queue.run(() => order.push('other'), { ...lane, visitorKey: 'two' });
  await other;
  assert.deepEqual(order, ['other']);
  hold.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['other', 'second', 'third']);
});

test('legacy jobs remain FIFO and dynamic limits pause, resize, and cancel without leaking lanes', async () => {
  const queue = createAskQueue({ maxConcurrent: 0, queueLimit: 3 });
  const order = [];
  const controller = new AbortController();
  const cancelled = queue.run(() => assert.fail('cancelled job dispatched'), { signal: controller.signal, laneKey: 'x' });
  const rejected = assert.rejects(cancelled, { name: 'RequestAbortedError' });
  const a = queue.run(() => order.push('a'), { laneKey: 'x' });
  const b = queue.run(() => order.push('b'));
  await assert.rejects(queue.run(() => {}), { name: 'QueueFullError' });
  controller.abort();
  await rejected;
  queue.updateLimits({ queueLimit: 0 });
  queue.setMaxConcurrent(1);
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  await tick();
  assert.deepEqual(queue.stats(), { activeRequests: 0, queuedRequests: 0, maxConcurrent: 1, queueLimit: 0 });
  const aborted = new AbortController();
  const beforeStart = queue.run(() => assert.fail('aborted before microtask'), { signal: aborted.signal });
  aborted.abort();
  await assert.rejects(beforeStart, { name: 'RequestAbortedError' });
});

test('canAccept is read-only and agrees with run for blocked lanes, pauses and full queues', async () => {
  const queue = createAskQueue({ maxConcurrent: 2, queueLimit: 1 });
  const hold = gate();
  const lane = { applicationKey: 'a', visitorKey: 'one', laneKey: 'session' };
  const first = queue.run(() => hold.promise, lane);
  const second = queue.run(() => {}, lane);
  const before = queue.stats();
  assert.equal(queue.canAccept(lane), false);
  assert.equal(queue.canAccept({ ...lane, laneKey: 'other' }), true);
  assert.deepEqual(queue.stats(), before);
  await assert.rejects(queue.run(() => {}, lane), { name: 'QueueFullError' });
  await queue.run(() => {}, { ...lane, laneKey: 'other' });
  queue.updateLimits({ maxConcurrent: 0 });
  assert.equal(queue.canAccept({ laneKey: 'other' }), false);
  queue.updateLimits({ queueLimit: 2 });
  assert.equal(queue.canAccept(lane), true);
  hold.resolve();
  queue.setMaxConcurrent(1);
  await Promise.all([first, second]);
});

test('account slots serve independent sessions concurrently, retain affinity, and release on cancellation', async () => {
  const releases = new Map();
  const seen = [];
  const pool = new IMAWebAgentPool({ accounts: [
    { id: 'synthetic-a', maxConcurrent: 2 }, { id: 'synthetic-b' },
  ] }, { clientFactory: account => ({
    async *streamAsk(options) {
      seen.push({ account: account.id, ...options });
      options.onSession(options.sessionId);
      const hold = gate();
      releases.set(options.question, hold.resolve);
      const abort = () => hold.resolve();
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        await hold.promise;
        options.signal?.throwIfAborted();
        yield { type: 'done' };
      } finally {
        options.signal?.removeEventListener('abort', abort);
      }
    },
  }) });
  const controller = new AbortController();
  const transportTimeouts = { headersMs: 60_000, idleMs: 600_000 };
  const first = collect(pool.streamAsk({ question: 'one', accountId: 'synthetic-a', sessionId: 's1', transportTimeouts }));
  const second = collect(pool.streamAsk({ question: 'two', accountId: 'synthetic-a', sessionId: 's2', signal: controller.signal }));
  const cancelled = assert.rejects(second, { name: 'AbortError' });
  await tick();
  assert.equal(pool.stats().activeRequests, 2);
  assert.equal(pool.stats().totalSlots, 3);
  assert.equal(pool.stats().capacity, 3);
  assert.equal(pool.stats().availableSlots, 1);
  assert.equal(pool.stats().busyAccounts, 1);
  assert.equal(seen[0].transportTimeouts, transportTimeouts);
  await assert.rejects(pool.checkAccount('synthetic-a'), { code: 'account_operation_in_progress' });
  const third = collect(pool.streamAsk({ question: 'three', accountId: 'synthetic-a', sessionId: 's1' }));
  const other = collect(pool.streamAsk({ question: 'other', sessionId: 's3' }));
  await tick();
  assert.equal(seen.length, 3);
  assert.equal(seen.find(row => row.question === 'other').account, 'synthetic-b');
  controller.abort();
  await cancelled;
  await tick();
  assert.equal(seen.find(row => row.question === 'three').account, 'synthetic-a');
  assert.equal(pool.accounts[0].consecutiveErrors, 0);
  releases.get('one')(); releases.get('three')(); releases.get('other')();
  await Promise.all([first, third, other]);
  assert.equal(pool.stats().activeRequests, 0);
  assert.equal(pool.stats().availableSlots, 3);
});

test('pool cancellation at route and before acquisition releases every slot', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic' }] }, {
    clientFactory: () => ({ streamAsk() { assert.fail('not dispatched'); } }),
  });
  const stream = pool.streamAsk({ question: 'synthetic' });
  assert.equal((await stream.next()).value.type, 'route');
  await stream.return();
  assert.equal(pool.stats().activeRequests, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collect(pool.streamAsk({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(pool.stats().activeRequests, 0);
});

test('two sessions pinned to one full account wait cancelably even when another account is free', async () => {
  const dispatched = [];
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b' }] }, {
    clientFactory: account => ({ async *streamAsk(options) {
      dispatched.push({ accountId: account.id, sessionId: options.sessionId });
      yield { type: 'done' };
    } }),
  });
  const first = pool.streamAsk({ accountId: 'a', sessionId: 'synthetic-session-one' });
  await first.next();
  const controller = new AbortController();
  const cancelled = collect(pool.streamAsk({ accountId: 'a', sessionId: 'synthetic-session-two', signal: controller.signal }));
  const cancellation = assert.rejects(cancelled, /cancelled|取消|aborted/i);
  assert.equal(pool.stats().waitingPreferredRequests, 1);
  assert.equal(pool.stats().availableSlots, 1);
  await collect(pool.streamAsk({ accountId: 'b', sessionId: 'synthetic-session-other' }));
  controller.abort();
  await cancellation;
  assert.equal(pool.stats().waitingRequests, 0);
  const followup = collect(pool.streamAsk({ accountId: 'a', sessionId: 'synthetic-session-two' }));
  await tick();
  assert.equal(pool.stats().waitingPreferredRequests, 1);
  assert.deepEqual(dispatched, [{ accountId: 'b', sessionId: 'synthetic-session-other' }]);
  await first.return();
  const events = await followup;
  assert.equal(events[0].accountId, 'a');
  assert.deepEqual(dispatched[1], { accountId: 'a', sessionId: 'synthetic-session-two' });
  assert.equal(pool.stats().waitingRequests, 0);
  assert.equal(pool.stats().activeRequests, 0);
});

test('slot limit updates retain active leases, unblock waiters on growth, and exclude maintenance', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic', maxConcurrent: 2 }] }, {
    clientFactory: () => ({ async *streamAsk() { yield { type: 'done' }; } }),
  });
  const first = pool.streamAsk({});
  const second = pool.streamAsk({});
  await first.next(); await second.next();
  pool.syncAccounts([{ id: 'synthetic', maxConcurrent: 1 }]);
  assert.equal(pool.stats().activeRequests, 2);
  assert.equal(pool.stats().availableSlots, 0);
  const third = pool.streamAsk({ accountId: 'synthetic' });
  const waiting = third.next();
  assert.equal(pool.waiters.size, 1);
  pool.syncAccounts([{ id: 'synthetic', maxConcurrent: 3 }]);
  await waiting;
  assert.equal(pool.stats().activeRequests, 3);
  await first.return(); await second.return(); await third.return();
  const maintenance = gate();
  const running = pool.accounts[0].client.runAutoMaintenance(() => maintenance.promise);
  assert.equal(pool.stats().capacity, 0);
  const fourth = pool.streamAsk({});
  const pending = fourth.next();
  maintenance.resolve();
  await running; await pending;
  assert.equal(await pool.accounts[0].client.runAutoMaintenance(() => assert.fail('active maintenance')), false);
  await fourth.return();
  assert.equal(pool.stats().availableSlots, 3);
});

test('unbound native requests select any qualified free slot without pinning to a busy account', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'a' }, { id: 'b', maxConcurrent: 2 }, { id: 'unqualified' }] }, {
    clientFactory: () => ({ async *streamAsk() { yield { type: 'done' }; } }),
  });
  pool.webReadiness = account => account.id !== 'unqualified';
  const first = pool.streamAsk({ accountId: 'a', mode: 'knowledge_agent' });
  const second = pool.streamAsk({ accountId: 'b', mode: 'knowledge_agent' });
  await first.next(); await second.next();
  const third = pool.streamAsk({ mode: 'knowledge_agent' });
  assert.equal((await third.next()).value.accountId, 'b');
  await first.return(); await second.return(); await third.return();
});
