const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');
const { synchronizeProviderAQueueCapacity } = require('../src/provider-a-capacity');

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
