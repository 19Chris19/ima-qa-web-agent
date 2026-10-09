const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const initialCapacity of [0, 1]) {
  test(`synchronous cancellation during slot acquisition releases once (${initialCapacity})`, async () => {
    const queue = createAskQueue({ maxConcurrent: initialCapacity, queueLimit: 3 });
    const controller = new AbortController();
    let releases = 0;
    const cancelled = queue.run(() => assert.fail('cancelled task started'), {
      signal: controller.signal,
      applicationKey: 'synthetic-one',
      tryAcquire() {
        controller.abort();
        return { release() { releases++; } };
      },
    });
    const rejected = assert.rejects(cancelled, { name: 'RequestAbortedError' });
    const next = queue.run(() => 'next', { applicationKey: 'synthetic-two' });
    queue.setMaxConcurrent(1);
    await rejected;
    assert.equal(await next, 'next');
    await tick();
    assert.equal(releases, 1);
    assert.equal(queue.stats().activeRequests, 0);
    assert.equal(queue.stats().queuedRequests, 0);
  });
}

test('a failing availability observer does not block later observers or release', () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic' }] });
  let notifications = 0;
  pool.onAvailability(() => { throw new Error('synthetic observer failure'); });
  pool.onAvailability(() => { notifications++; });
  const lease = pool.tryAcquireSlot();
  assert.doesNotThrow(() => lease.release());
  assert.equal(notifications, 1);
  assert.equal(pool.availabilityObserverErrors, 1);
  assert.equal(pool.stats().activeRequests, 0);
});

test('legacy reservation failure rejects its waiter and still notifies observers', async () => {
  let fail = false;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic' }] }, {
    onAccountStateChange(account) { if (fail && account.activeRequests > 0) throw new Error('synthetic disk failure'); },
  });
  const lease = pool.tryAcquireSlot();
  const waiting = pool._waitForPreferredAccount('synthetic');
  const rejected = assert.rejects(waiting, /synthetic disk failure/);
  let notifications = 0;
  pool.onAvailability(() => { notifications++; });
  fail = true;
  assert.doesNotThrow(() => lease.release());
  await rejected;
  assert.equal(pool.waiters.size, 0);
  assert.equal(notifications, 1);
  assert.equal(pool.stats().activeRequests, 0);
});
