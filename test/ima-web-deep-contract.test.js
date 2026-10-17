'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ima-web-native/deep-thinking.json');
const wire = require('./fixtures/ima-web-native/wire.json');
const { normalizeIMAWebAgentEvent, parseIMAWebAgentStream, describeIMAWebAgentEvent } = require('../src/ima-upstream-protocol');
const { IMAWebProtocolClient, IMA_WEB_PROTOCOL_PATHS: paths } = require('../src/ima-web-protocol-client');
const enabled = { thinkingBlocks: 'phase_only_v1' };
const event = data => ({ eventName: 'STRUCTURED_BLOCK', data });
const answer = 'event: MESSAGE\ndata: {"Text":"Scrubbed answer"}\n\nevent: COMPLETED\ndata: {"Code":0}\n\n';
const thinking = fixture.frames.map(data => `event: STRUCTURED_BLOCK\ndata: ${JSON.stringify(data)}\n\n`).join('');
async function sdkFor(sse) {
  const c = new IMAWebProtocolClient({ headers: { 'x-ima-cookie': 'synthetic-cookie', 'x-ima-bkn': 'synthetic-bkn', extension_version: '5.11.2' },
    deviceInfo: wire.qa.deep.request.device_info, fetchImpl: async (url, options) => {
      const p = new URL(url).pathname, body = JSON.parse(options.body);
      if (p === paths.models) return Response.json(wire.models.response);
      if (p === paths.session) return Response.json({ code: 0, session_id: 'SCRUBBED_SESSION', session_info: { id: 'SCRUBBED_SESSION', knowledge_base_info_with_folder: { knowledge_base_id: body.relatedUrl } } });
      return new Response(sse);
    } });
  const catalog = await c.getModels(), session = await c.createKnowledgeSession({ knowledgeBaseId: 'SCRUBBED_KB', modelRef: catalog.models[0].modelRef, mode: 'deep' });
  return { c, session };
}

test('deep thinking requires explicit admission and never becomes answer text or evidence', () => {
  for (const frame of fixture.frames) {
    assert.throws(() => normalizeIMAWebAgentEvent(event(frame)), { code: 'protocol_variant_unrecognized' });
    const normalized = normalizeIMAWebAgentEvent(event(frame), new Set(), enabled);
    assert.deepEqual(normalized, { type: 'thinking', status: frame.Data.thinking_message.Status === 1 ? 'running' : 'completed' });
    assert.doesNotMatch(JSON.stringify(normalized), /Scrubbed|Tips|Message|SCRUBBED_THINK/);
    assert.equal(describeIMAWebAgentEvent(event(frame), enabled).eventFamily, 'thinking');
  }
});
test('unknown semantic fields, statuses and malformed thinking envelopes still fail closed', () => {
  for (const mutate of [x => x.Data.thinking_message.Status = 3, x => x.Data.thinking_message.Status = '1',
    x => x.Data.thinking_message.Answer = 'Scrubbed answer', x => delete x.Data.thinking_message.Message,
    x => x.Type = 'unprovedThinking', x => x.Data.thinking_message = [], x => x.UpdateType = 'append']) {
    const frame = structuredClone(fixture.frames[0]); mutate(frame);
    assert.throws(() => normalizeIMAWebAgentEvent(event(frame), new Set(), enabled), { code: 'protocol_variant_unrecognized' });
  }
});
test('recorded deep shapes replay through a single terminal, and cannot occur after completion', async () => {
  const events = []; for await (const e of parseIMAWebAgentStream(new Response(thinking + answer), enabled)) events.push(e);
  assert.equal(events.filter(e => e.type === 'thinking').length, 4);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Scrubbed answer');
  await assert.rejects(async () => { for await (const _ of parseIMAWebAgentStream(new Response(answer + thinking), enabled)) {} }, { code: 'upstream_event_after_terminal' });
});
test('SDK coalesces all thought frames into one real answer-running phase, not a premature completion', async () => {
  const { c, session } = await sdkFor(thinking + answer);
  const events = []; for await (const e of c.streamAsk({ session, question: 'Scrubbed question' })) events.push(e);
  assert.deepEqual(events.filter(e => e.type === 'process'), [{ type: 'process', stepId: 'chat:answer', phase: 'answer', status: 'running' }]);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.doesNotMatch(JSON.stringify(events), /fragment|completion tip|thinking_message/);
});
test('SDK delays completion until late metadata is consumed and refuses thought-only answers', async () => {
  const { c, session } = await sdkFor(thinking + answer + 'event: SUGGEST_QUESTION\ndata: ["Scrubbed next"]\n\n');
  const events = []; for await (const e of c.streamAsk({ session, question: 'Scrubbed question' })) events.push(e);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-2).type, 'suggestions');
  const empty = await sdkFor(thinking + 'event: COMPLETED\ndata: {"Code":0}\n\n'), partial = [];
  await assert.rejects(async () => { for await (const e of empty.c.streamAsk({ session: empty.session, question: 'Scrubbed question' })) partial.push(e); }, { code: 'ima_web_answer_missing' });
  assert.equal(partial.filter(e => e.type === 'done').length, 0);
});
test('an invalid frame after upstream completion cannot escape as SDK success', async () => {
  const { c, session } = await sdkFor(answer + 'event: MESSAGE\ndata: {"Text":"Scrubbed late answer"}\n\n'), events = [];
  await assert.rejects(async () => { for await (const e of c.streamAsk({ session, question: 'Scrubbed question' })) events.push(e); }, { code: 'upstream_event_after_terminal' });
  assert.equal(events.filter(e => e.type === 'done').length, 0);
});
