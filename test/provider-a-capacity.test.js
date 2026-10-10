const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { synchronizeProviderAQueueCapacity } = require('../src/provider-a-capacity');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

test('fallback capacity excludes cooling and maintenance but includes eligible busy accounts', () => {
  const pool = new IMAWebAgentPool({ accounts: ['idle', 'busy', 'cooling', 'maintenance', 'disabled']
    .map(id => ({ id })) }, { now: () => 1000, clientFactory: () => ({}) });
  pool.accounts[1].activeRequests = 1;
  pool.accounts[2].cooldownUntil = 2000;
  pool.accounts[3].maintenanceOperation = 'check';
  pool.accounts[4].disabled = true;
  const askQueue = createAskQueue({ maxConcurrent: 1, queueLimit: 30 });
  synchronizeProviderAQueueCapacity({ askQueue, pool, config: { concurrency: { autoScaleWithAccounts: true } } });
  assert.equal(askQueue.stats().maxConcurrent, 2);
  assert.equal(pool.stats().availableAccounts, 1);
});

test('Provider A automatic capacity follows enabled pool accounts', () => {
  const askQueue = createAskQueue({ maxConcurrent: 1, queueLimit: 30 });
  const config = { concurrency: { autoScaleWithAccounts: true } };
  const pool = {
    stats() {
      return { totalAccounts: 4, unavailableAccounts: 1 };
    },
  };

  synchronizeProviderAQueueCapacity({ askQueue, config, pool });
  assert.equal(askQueue.stats().maxConcurrent, 3);

  synchronizeProviderAQueueCapacity({
    askQueue,
    config: { concurrency: { autoScaleWithAccounts: false } },
    pool: { stats: () => ({ totalAccounts: 8, unavailableAccounts: 0 }) },
  });
  assert.equal(askQueue.stats().maxConcurrent, 3);
});

test('slot capacity includes occupied eligible slots and zero pauses without inventing an account', () => {
  let observed;
  const askQueue = { setMaxConcurrent: n => { observed = n; return n; } };
  const config = { concurrency: { autoScaleWithAccounts: true } };
  synchronizeProviderAQueueCapacity({ askQueue, config, pool: { stats: () => ({ totalAccounts: 2, capacity: 7, availableSlots: 1 }) } });
  assert.equal(observed, 7);
  synchronizeProviderAQueueCapacity({ askQueue, config, pool: { stats: () => ({ totalAccounts: 2, capacity: 0, availableSlots: 0 }) } });
  assert.equal(observed, 0);
});

test('readiness reports slot and account metrics independently for a partially busy account', () => {
  const { WebReadiness } = require('../src/web-readiness');
  const readiness = Object.create(WebReadiness.prototype);
  readiness.directory = { load: () => ({ settings: { webMode: 'classic_knowledge' } }),
    listAccounts: () => [{ id: 'synthetic-a', health: {} }, { id: 'synthetic-b', health: {} }] };
  readiness.pool = { now: () => 1000, accounts: [
    { id: 'synthetic-a', maxConcurrent: 3, activeRequests: 2, cooldownUntil: 0 },
    { id: 'synthetic-b', maxConcurrent: 4, activeRequests: 0, cooldownUntil: 0 },
  ] };
  readiness.jobs = new Map();
  const snapshot = readiness.snapshot();
  assert.equal(snapshot.capacity, 7);
  assert.equal(snapshot.totalSlots, 7);
  assert.equal(snapshot.schedulable, 5);
  assert.equal(snapshot.eligibleAccounts, 2);
  assert.equal(snapshot.schedulableAccounts, 2);
});
