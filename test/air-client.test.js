'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAWebAgentClient } = require('../src/air/ima-web-agent-client');

const identity = { 'IMA-GUID': 'synthetic-guid', 'IMA-Q36': 'synthetic-q36',
  'IMA-IUA': 'SyntheticAgent', PLATFORM: 'H5', 'CLIENT-TYPE': '256052', 'WEB-VERSION': '999.999.999' };
const context = { identity, userAgent: 'SyntheticAgent',
  deviceInfo: { uskey: 'synthetic-uskey', uskey_bus_infos_input: 'synthetic-bus' } };
const config = { knowledgeBaseId: 'synthetic-kb', id: 'synthetic-account',
  headers: { 'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token', 'x-ima-bkn': '123' },
  modelId: 'official_3', modelType: 3, clientContextProvider: { get: async () => context } };
const stream = () => new Response('event: MESSAGE\ndata: {"Text":"  synthetic\\nanswer  "}\n\nevent: COMPLETED\ndata: {"Code":0}\n\n');
const collect = async generator => { const rows = []; for await (const row of generator) rows.push(row); return rows; };

test('Air native mode remains native with one dispatch, exact text and recorded session', async () => {
  const requests = [];
  let dispatches = 0;
  const client = new IMAWebAgentClient(config, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers }); return stream();
  });
  const events = await collect(client.streamAsk({ question: 'Synthetic question', sessionId: 'original-session',
    sessionAnswerProfile: 'classic_knowledge', mode: 'knowledge_agent', retrievalPolicy: 'knowledge_agent',
    allowAuthRefresh: false, onDispatch: () => dispatches++ }));
  assert.equal(requests.length, 1);
  assert.equal(dispatches, 1);
  assert.equal(requests[0].body.session_id, 'original-session');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.find(e => e.type === 'delta').text, '  synthetic\nanswer  ');
  assert.equal(events[0].answerProfile, 'classic_knowledge');
  assert.equal(requests[0].body.model_info.model_id, 'official_3');
  assert.equal(requests[0].body.robot_type, 5);
  assert.equal(requests[0].headers.extension_version, '5.11.2');
  assert.match(requests[0].headers['x-ima-cookie'], /WEB-VERSION=5\.11\.2/u);
});

test('Air source policies build their original profile bodies without electing model or a second strategy', async () => {
  for (const policy of ['group_knowledge', 'auto', 'web', 'mixed']) {
    const requests = [];
    const client = new IMAWebAgentClient(config, async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return url.endsWith('/init_session') ? Response.json({ session_id: 'synthetic-session' }) : stream();
    });
    await collect(client.streamAsk({ question: 'Synthetic question', retrievalPolicy: policy, allowAuthRefresh: false }));
    assert.equal(requests.length, 2);
    const qa = requests[1];
    assert.equal(qa.body.robot_type, policy === 'group_knowledge' ? 5 : 10000);
    assert.equal(qa.body.model_info.model_id, config.modelId);
    if (policy === 'mixed') assert.equal(qa.body.command_info.copilot_qa_info.knowledge_info[0].knowledge_base_id, 'synthetic-kb');
    if (policy === 'auto' || policy === 'web') assert.equal(qa.body.command_info, undefined);
    if (policy !== 'group_knowledge') assert.equal(qa.body.device_info.uskey, context.deviceInfo.uskey);
  }
});

test('profile or mode conflicts fail before context lookup or upstream access; no silent reset', async () => {
  let calls = 0;
  const client = new IMAWebAgentClient({ ...config, clientContextProvider: { get() { calls++; } } }, async () => { calls++; });
  await assert.rejects(collect(client.streamAsk({ question: 'Synthetic', sessionId: 'original',
    sessionAnswerProfile: 'classic_knowledge', retrievalPolicy: 'web' })), { code: 'session_profile_conflict' });
  await assert.rejects(collect(client.streamAsk({ question: 'Synthetic', sessionId: 'original',
    mode: 'classic_knowledge', retrievalPolicy: 'knowledge_agent' })), { code: 'retrieval_mode_conflict' });
  assert.equal(calls, 0);
});

test('failed or expired dispatched session never initializes another session or repeats QA', async () => {
  let calls = 0;
  const client = new IMAWebAgentClient(config, async () => { calls++; return new Response('synthetic session expired', { status: 409 }); });
  await assert.rejects(collect(client.streamAsk({ question: 'Synthetic', sessionId: 'original',
    retrievalPolicy: 'web', sessionAnswerProfile: 'ima_agent_auto', allowAuthRefresh: false })), { code: 'upstream_http_failure' });
  assert.equal(calls, 1);
});

test('L0 is augmented once and durable transport callbacks survive the Air extension', async () => {
  let calls = 0, closed = 0, planned;
  const onActivity = () => {};
  const client = new IMAWebAgentClient({ ...config, taskFetchImpl: async (_url, options) => {
    calls++; assert.equal(options.onActivity, onActivity); assert.ok(options.transportTimeouts);
    const body = JSON.parse(options.body);
    assert.equal((body.question.match(/Original question:/gu) || []).length, 1);
    assert.ok(body.question.length > 2000);
    const response = stream(); response.closeTransport = () => closed++; return response;
  } }, () => { throw new Error('legacy transport must not be used'); });
  await collect(client.streamAsk({ question: 'Synthetic original', sessionId: 'original', mode: 'knowledge_agent',
    allowAuthRefresh: false, onActivity, transportTimeouts: { connectMs: 1000, idleMs: 1000, totalMs: 5000 },
    recentContext: { messages: [{ sender_display_name: 'Synthetic', text: 'x'.repeat(3000) }],
      sourceMessageCount: 1, truncationReason: 'none', watermarkCategory: 'watermark_known' },
    onRecentContextPlan: plan => { planned = plan; } }));
  assert.equal(planned.injectedMessageCount, 1);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
});
