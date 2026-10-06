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
