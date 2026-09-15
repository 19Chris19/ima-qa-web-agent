const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAWebAgentClient } = require('../src/ima-web-agent-client');
const { ConversationStore } = require('../src/conversation-store');

test('native client uses one bound session and one ask with proved sources', async () => {
  const requests = [];
  const client = new IMAWebAgentClient({ knowledgeBaseId: 'synthetic-kb', modelId: 'official_3', modelType: 3,
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic; WEB-VERSION=5.11.2', 'x-ima-bkn': '123' } },
  async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/init_session')) return Response.json({ session_id: 'synthetic-session' });
    return new Response([
      'event: SEARCH_MEDIAS\ndata: {"medias":[{"id":"synthetic","title":"Synthetic","sourceType":1,"knowledgeBaseId":"synthetic-kb"}]}',
      'event: MESSAGE\ndata: {"Text":"Synthetic answer"}',
      'event: COMPLETED\ndata: {"Code":0}', '',
    ].join('\n\n'));
  });
  const events = [];
  let dispatched = 0;
  for await (const event of client.streamAsk({ question: 'Synthetic question', mode: 'knowledge_agent', allowAuthRefresh: false, onDispatch: () => dispatched++ })) events.push(event);
  assert.equal(dispatched, 1);
  assert.equal(requests.length, 2);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.deepEqual(events.find(e => e.type === 'sources').sourceKinds, ['knowledge']);
  assert.equal(requests[1].options.headers.extension_version, '5.11.2');
});

test('existing conversations retain classic mode while newly created ones use native mode', () => {
  const store = new ConversationStore({ persist: false });
  const classic = store.create('synthetic-owner');
  const native = store.create('synthetic-owner', { mode: 'knowledge_agent' });
  assert.equal(store.getUpstream(classic.conversationId, 'synthetic-owner').mode, undefined);
  assert.equal(store.getUpstream(native.conversationId, 'synthetic-owner').mode, 'knowledge_agent');
  store.setUpstream(native.conversationId, { accountId: 'synthetic-account', sessionId: 'synthetic-session' }, 'synthetic-owner');
  assert.equal(store.getUpstream(native.conversationId, 'synthetic-owner').mode, 'knowledge_agent');
});
