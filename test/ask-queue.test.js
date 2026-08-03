const assert = require('node:assert/strict');
const test = require('node:test');
const { createAskQueue } = require('../src/ask-queue');

test('ask queue starts waiting work when account-pool capacity grows', async () => {
  const queue = createAskQueue({ maxConcurrent: 1, queueLimit: 2 });
  let releaseFirst;
  const firstBlocker = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let secondStarted = false;

  const first = queue.run(async () => {
    await firstBlocker;
  });
  const second = queue.run(async () => {
    secondStarted = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(queue.stats().queuedRequests, 1);
  assert.equal(secondStarted, false);

  const stats = queue.setMaxConcurrent(2);
  assert.equal(stats.maxConcurrent, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondStarted, true);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(queue.stats().activeRequests, 0);
});
