const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { createAskQueue } = require('../src/ask-queue');

function fixture() {
  const dispatched = [];
  const allowed = { knowledge: true, web: true };
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'knowledge' }, { id: 'web' }] }, {
    policyEligibility(account, options) {
      return allowed[account.id] && account.id === (options.retrievalPolicy === 'web' ? 'web' : 'knowledge');
    },
    clientFactory: account => ({ async *streamAsk() {
      dispatched.push(account.id); yield { type: 'delta', text: account.id }; yield { type: 'done' };
    } }),
  });
  return { pool, allowed, dispatched };
}

test('resource selection honors policy without silently moving pinned context', async () => {
  const { pool, dispatched } = fixture();
  const options = { retrievalPolicy: 'web' };
  const lease = pool.tryAcquireSlot(options);
  for await (const event of pool.streamAsk({ ...options, accountLease: lease.value })) void event;
  lease.release();
  assert.deepEqual(dispatched, ['web']);
  assert.throws(() => pool.tryAcquireSlot({ accountId: 'knowledge', retrievalPolicy: 'web' }), /账号/);
  assert.equal(pool.stats().activeRequests, 0);
});

test('legacy waiters apply policy selection too, not merely the advertised capacity', async () => {
  const { pool, dispatched } = fixture();
  for await (const event of pool.streamAsk({ retrievalPolicy: 'web' })) void event;
  assert.deepEqual(dispatched, ['web']);
  assert.equal(pool.stats().activeRequests, 0);
});

test('policy revocation after reservation cannot dispatch and does not leak occupancy', async () => {
  const { pool, allowed, dispatched } = fixture();
  const queue = createAskQueue({ maxConcurrent: 2, queueLimit: 2 });
  const options = { retrievalPolicy: 'web' };
  const task = queue.run(async lease => {
    for await (const event of pool.streamAsk({ ...options, accountLease: lease })) void event;
  }, { tryAcquire: () => pool.tryAcquireSlot(options) });
  allowed.web = false;
  await assert.rejects(task);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dispatched, []);
  assert.equal(pool.stats().activeRequests, 0);
});

test('native mode and policy predicates both constrain the account', async () => {
  const { pool } = fixture();
  pool.webReadiness = account => account.id === 'knowledge';
  assert.throws(() => pool.tryAcquireSlot({ mode: 'knowledge_agent', retrievalPolicy: 'web' }), /账号/);
  const lease = pool.tryAcquireSlot({ mode: 'knowledge_agent', retrievalPolicy: 'knowledge_agent' });
  lease.release();
  assert.equal(pool.stats().activeRequests, 0);
});
