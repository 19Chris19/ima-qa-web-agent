const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationStore,
  DEFAULT_CONVERSATION_TTL_MS,
  MAX_PERSISTED_SOURCES,
} = require('../src/conversation-store');

test('ConversationStore persists bounded turns and keeps them owned by one client', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-conversation-'));
  const storePath = path.join(tempDir, 'conversations.json');
  const store = new ConversationStore({ storePath, ttlMs: 60_000, maxTurns: 2, maxCount: 10 });
  const conversation = store.create('customer-user-a');

  store.setUpstream(conversation.conversationId, {
    accountId: 'account-a',
    sessionId: 'ima-session-a',
  }, 'customer-user-a');
  store.appendTurn(conversation.conversationId, '第一问', '第一答', 'customer-user-a');
  store.appendTurn(conversation.conversationId, '第二问', '第二答', 'customer-user-a');

  assert.deepEqual(store.getUpstream(conversation.conversationId, 'customer-user-a'), {
    accountId: 'account-a',
    sessionId: 'ima-session-a',
  });
  assert.deepEqual(store.getHistory(conversation.conversationId, 'customer-user-a'), [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' },
  ]);
  assert.throws(
    () => store.getHistory(conversation.conversationId, 'customer-user-b'),
    ConversationNotFoundError,
  );

  const restored = new ConversationStore({ storePath, ttlMs: 60_000, maxTurns: 2, maxCount: 10 });
  assert.deepEqual(restored.getUpstream(conversation.conversationId, 'customer-user-a'), {
    accountId: 'account-a',
    sessionId: 'ima-session-a',
  });
  assert.equal(restored.stats().storedConversations, 1);
});

test('ConversationStore rejects simultaneous messages for the same conversation', () => {
  const store = new ConversationStore({ persist: false });
  const conversation = store.create('customer-user-a');

  store.beginRequest(conversation.conversationId, 'customer-user-a');
  assert.throws(
    () => store.beginRequest(conversation.conversationId, 'customer-user-a'),
    ConversationBusyError,
  );
  assert.equal(store.endRequest(conversation.conversationId, 'customer-user-a'), true);
  assert.doesNotThrow(() => store.beginRequest(conversation.conversationId, 'customer-user-a'));
});

test('ConversationStore defaults to seven-day retention and returns owned conversations newest first', () => {
  let now = Date.UTC(2026, 7, 3, 9, 0, 0);
  const store = new ConversationStore({ persist: false, now: () => now });
  const oldest = store.create('customer-user-a');
  store.appendTurn(oldest.conversationId, '最早的问题', '最早的回答', 'customer-user-a');
  now += 1000;
  const newest = store.create('customer-user-a');
  store.appendTurn(newest.conversationId, '最新的问题', '最新的回答', 'customer-user-a');
  store.create('customer-user-b');

  const list = store.list('customer-user-a', { limit: 999 });
  assert.equal(store.stats().ttlSeconds, DEFAULT_CONVERSATION_TTL_MS / 1000);
  assert.deepEqual(
    list.map((conversation) => conversation.conversationId),
    [newest.conversationId, oldest.conversationId],
  );
  assert.equal(list[0].title, '最新的问题');
  assert.equal(JSON.stringify(list).includes('accountId'), false);
  assert.equal(JSON.stringify(list).includes('sessionId'), false);
});

test('ConversationStore caps public source history and keeps legacy turns readable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-conversation-'));
  const storePath = path.join(tempDir, 'conversations.json');
  const now = Date.UTC(2026, 7, 3, 9, 0, 0);
  const legacyId = 'legacy-conversation';
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      conversations: [
        {
          id: legacyId,
          ownerKey: 'customer-user-a',
          createdAt: now,
          updatedAt: now,
          expiresAt: now + DEFAULT_CONVERSATION_TTL_MS,
          turns: [{ question: '旧问题', answer: '旧回答', createdAt: now }],
          upstream: { accountId: 'private-account', sessionId: 'private-session' },
        },
      ],
    }),
  );
  const store = new ConversationStore({ storePath, now: () => now });
  const legacyDetail = store.getDetail(legacyId, 'customer-user-a');
  assert.deepEqual(legacyDetail.messages, [
    { role: 'user', content: '旧问题', createdAt: new Date(now).toISOString() },
    { role: 'assistant', content: '旧回答', createdAt: new Date(now).toISOString() },
  ]);

  const conversation = store.create('customer-user-a');
  store.appendTurn(
    conversation.conversationId,
    '带来源的问题',
    '带来源的回答 [13]',
    {
      searchSummary: '检索到很多资料',
      sources: Array.from({ length: MAX_PERSISTED_SOURCES + 3 }, (_value, index) => ({
        index: index + 1,
        title: `资料 ${index + 1}`,
        snippet: `摘要 ${index + 1}`,
        mediaId: `internal-${index + 1}`,
        accountId: 'private-account',
      })),
    },
    'customer-user-a',
  );

  const detail = store.getDetail(conversation.conversationId, 'customer-user-a');
  const assistant = detail.messages[1];
  assert.equal(assistant.sources.length, MAX_PERSISTED_SOURCES);
  assert.equal(assistant.sources[0].index, 13);
  assert.equal(assistant.searchSummary, '检索到很多资料');
  assert.equal(JSON.stringify(detail).includes('mediaId'), false);
  assert.equal(JSON.stringify(detail).includes('private-account'), false);
  assert.throws(
    () => store.getDetail(conversation.conversationId, 'customer-user-b'),
    ConversationNotFoundError,
  );
});

test('ConversationStore limits owner conversation lists to fifty and deletes only owned records', () => {
  let now = Date.UTC(2026, 7, 3, 9, 0, 0);
  const store = new ConversationStore({ persist: false, now: () => now, maxCount: 100 });
  const ids = [];
  for (let index = 0; index < 55; index += 1) {
    const conversation = store.create('customer-user-a');
    store.appendTurn(conversation.conversationId, `问题 ${index}`, `回答 ${index}`, 'customer-user-a');
    ids.push(conversation.conversationId);
    now += 1;
  }

  assert.equal(store.list('customer-user-a').length, 50);
  assert.equal(store.delete(ids[0], 'customer-user-b'), false);
  assert.equal(store.delete(ids[0], 'customer-user-a'), true);
  assert.throws(() => store.getDetail(ids[0], 'customer-user-a'), ConversationNotFoundError);
});
