const assert = require('node:assert/strict');
const test = require('node:test');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

test('session profile reaches the binding callback before any upstream body event', async () => {
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic' }] }, {
    clientFactory: () => ({ async *streamAsk(options) {
      options.onSession('synthetic-session', { answerProfile: 'ima_agent_auto' });
      throw new Error('synthetic stream interrupted');
    } }),
  });
  let binding;
  await assert.rejects(async () => {
    for await (const event of pool.streamAsk({ onSession(id, metadata) { binding = { id, ...metadata }; } })) void event;
  }, /interrupted/);
  assert.deepEqual(binding, { id: 'synthetic-session', answerProfile: 'ima_agent_auto' });
});

test('local eligibility change after reservation does not penalize the account', async () => {
  let eligible = true;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic' }] }, {
    policyEligibility: () => eligible,
    clientFactory: () => ({ async *streamAsk() { assert.fail('revoked policy dispatched'); } }),
  });
  const stream = pool.streamAsk({ retrievalPolicy: 'web' });
  assert.equal((await stream.next()).value.type, 'route');
  eligible = false;
  await assert.rejects(stream.next(), { name: 'NoAvailableWebAgentAccountError' });
  assert.equal(pool.accounts[0].consecutiveErrors, 0);
  assert.equal(pool.stats().activeRequests, 0);
});
