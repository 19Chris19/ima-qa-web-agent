const test = require('node:test');
const assert = require('node:assert/strict');

test('bot adapter isolates users and reuses a receipt without redispatch', async () => {
  const { BotAdapter } = await import('../examples/bot-adapter/adapter.mjs');
  const calls = [];
  const adapter = new BotAdapter({ capacity: async () => ({ maxConcurrent: 2 }), ask: async request => {
    calls.push(request);
    return { success: true, answer: 'Synthetic', conversationId: request.conversationId || request.owner };
  } });
  const first = { user: 'synthetic-1', messageId: '1', question: 'Synthetic' };
  await Promise.all([adapter.receive(first), adapter.receive(first), adapter.receive({ ...first, user: 'synthetic-2' })]);
  await adapter.receive({ ...first, messageId: '2' });
  assert.equal(calls.length, 3);
  assert.notEqual(calls[0].owner, calls[1].owner);
  assert.equal(calls[2].conversationId, calls[0].owner);
  assert.throws(() => adapter.receive({ ...first, question: 'Different' }), /idempotency_conflict/);
});
